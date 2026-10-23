#!/usr/bin/env node
"use strict";


const path = require("node:path");
const os = require("node:os");
const checkin = require("../src/checkin");
const programBoundaries = require("../src/program-boundaries");
const { createVolumeProbe, volumeRootOf } = require("../src/volume-probe");

function printUsage() {
  process.stdout.write(
    [
      "Git Manager",
      "",
      "Usage:",
      "  git-manager start <repo> --task <slug> [--owner <prefix>] [--program <name>] [--paths a,b] [--dependencies root1,root2] [--full-checkout] [--session <label>] [--as-owner <name>] [--allow-overlap] [--no-fetch] [--dry-run] [--json]",
      "  git-manager finish [<claim>] [--push] [--keep-branch] [--test <cmd>] [--json]",
      "  git-manager release <claim> [--json]",
      "  git-manager amend-scope <claim-id> --paths a,b [--session <host-session>] [--dry-run] [--json]",
      "  git-manager claims [--all] [--json]",
      "  git-manager sweep [--read-only] [--json]",
      "",
      "Git Manager checks you in before you edit: a branch and worktree per task, so two sessions never clobber each other. Merge, never rebase.",
      "",
    ].join("\n"),
  );
}

async function withRepoProbe(repoPath, run) {
  repoPath = path.resolve(repoPath.replace(/^~(?=$|\/)/, os.homedir()));
  const root = volumeRootOf(repoPath);
  if (!root) return run();
  const volumes = createVolumeProbe();
  volumes.registerTargets([repoPath, path.dirname(repoPath), root]);
  await volumes.prime();
  if (!await volumes.checkRepo(repoPath)) {
    return { ok: false, refused: true, reasons: [`external volume ${root} is offline or unresponsive; reconnect it and retry`] };
  }
  return volumes.run(run);
}

async function runCheckin(command, args) {
  const opts = {}, positional = [];
  const values = { "--task": "task", "--program": "program", "--owner": "owner", "--paths": "paths", "--dependencies": "dependencies", "--session": "session", "--as-owner": "asOwner", "--test": "testCommand" };
  const flags = { "--allow-overlap": "allowOverlap", "--fetch": "fetch", "--no-fetch": "noFetch", "--dry-run": "dryRun", "--full-checkout": "fullCheckout", "--read-only": "readOnly", "--json": "json", "--push": "push", "--keep-branch": "keepBranch", "--all": "all" };
  try {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (values[arg]) {
        if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`missing value for ${arg}`);
        opts[values[arg]] = args[++i];
      } else if (flags[arg]) opts[flags[arg]] = true;
      else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
      else positional.push(arg);
    }
    if (positional.length > 1) throw new Error("expected at most one repository or claim");
    // start fetches by default; --no-fetch opts out (--fetch is kept as a no-op for old scripts).
    if (opts.noFetch) { if (opts.fetch) throw new Error("--fetch and --no-fetch conflict"); opts.fetch = false; }
    delete opts.noFetch;
    // Command-specific switches are refused elsewhere so a preview flag can never be silently ignored.
    if (opts.readOnly && command !== "sweep") throw new Error("--read-only applies only to sweep");
    if ((opts.fullCheckout || opts.dependencies !== undefined) && command !== "start") throw new Error("--dependencies and --full-checkout apply only to start");
    let result;
    if (command === "start") {
      const repoPath = positional[0] || process.cwd();
      result = await withRepoProbe(repoPath, () => {
        let primary = repoPath;
        try { primary = checkin.resolveRepo(repoPath).primary; } catch { /* underlying lifecycle reports invalid repos */ }
        return programBoundaries.policyFor(primary, programBoundaries.loadSettings(opts))
          ? programBoundaries.guardedStart(repoPath, opts) : checkin.start(repoPath, opts);
      });
    }
    else if (command === "claims") result = { ok: true, claims: checkin.listClaims(opts) };
    else if (command === "sweep") {
      if (positional.length) throw new Error("sweep takes no repository or claim; it covers the claims store and checkin.enforcedRepos");
      result = checkin.sweep(opts);
    }
    else if (command === "amend-scope") {
      const claim = checkin.resolveClaim(positional[0], { ...opts, cwd: process.cwd() });
      result = claim.refused ? claim : await withRepoProbe(claim.repo, () =>
        withRepoProbe(claim.worktree, () => require("../src/claim-scope").amendScope(positional[0], opts)));
    }
    else if (command === "release" && !positional[0]) result = { ok: false, refused: true, reasons: ["release requires a claim selector"] };
    else {
      const commandOpts = { ...opts, cwd: process.cwd() };
      const claim = checkin.resolveClaim(positional[0], commandOpts);
      result = claim.refused ? claim : await withRepoProbe(claim.repo,
        () => command === "finish" && programBoundaries.policyFor(claim.repo, programBoundaries.loadSettings(commandOpts)) ? programBoundaries.guardedFinish(positional[0], commandOpts) : checkin[command](positional[0], commandOpts));
    }
    if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    else {
      const lines = [...(result.health?.warnings || []), ...(result.collisions?.warnings || []), ...(result.warnings || [])].map(w => `warn: ${w}`);
      if (!result.ok) {
        lines.push(...result.reasons.map(r => `HELD: ${r}`));
        if (result.continuation) {
          lines.push(`next (${result.continuation.kind}): ${result.continuation.next}`);
          if (result.continuation.preserved?.worktree) {
            const state = result.continuation.preserved.worktreePresent === true ? "retained" : "claim worktree";
            lines.push(`${state}: ${result.continuation.preserved.worktree} (${result.continuation.preserved.branch})`);
          }
          if (result.continuation.checkpoint?.ref) lines.push(`checkpoint: ${result.continuation.checkpoint.ref} ${result.continuation.checkpoint.sha}`);
          if (result.continuation.checkpoint?.status === "skipped") lines.push(`checkpoint unavailable: ${result.continuation.checkpoint.reason}`);
        }
      }
      else if (command === "start") {
        if (result.dryRun) lines.push(`dry run: ${result.plan.branch} from ${result.plan.base} (${String(result.plan.baseSha).slice(0, 12)})`, `materialization: ${result.plan.materialization}${result.plan.materializationReason ? ` (${result.plan.materializationReason})` : ""}, estimated ${result.plan.estimatedBytes} bytes${result.plan.fullCheckoutRequested ? ", full checkout explicitly requested" : ""}`, `cd ${result.plan.worktree}`);
        else {
          lines.push(`claim: ${result.claim.id}${result.reused ? " (reused)" : ""}`, `branch: ${result.claim.branch}`);
          if (result.claim.sparseCheckout) lines.push(`materialization: sparse cone, ${result.claim.sparseCheckout.includeDirs.join(", ")}`);
          else if (result.claim.fullCheckoutRequested) lines.push("materialization: full checkout explicitly requested");
          lines.push(`cd ${result.worktree}`);
        }
      } else if (command === "sweep") {
        const c = result.claims;
        lines.push(`${result.readOnly ? "sweep preview (read-only, nothing changed)" : "sweep"}: ${c && !c.skipped ? `${c.active} active, ${c.expired} expired, ${c.closed} closed` : "claims not swept"}; ${result.repos.length} enforced repo(s) checked`);
        for (const f of result.findings) lines.push(`${f.level}: ${f.code}: ${f.message}${f.fix ? ` (next: ${f.fix})` : ""}`);
      } else if (command === "claims") lines.push(...result.claims.map(c => `${c.id} ${c.status} ${c.actor}/${c.session} ${Number.isFinite(c.ageHours) ? `${c.ageHours.toFixed(1)}h` : "activity unknown, held"} ${c.worktree}`));
      else if (command === "amend-scope") lines.push(`${result.dryRun ? "preview" : "scope amended"}: ${result.claim.id}`, `paths: ${(result.amendment.paths || []).join(", ")}`);
      else {
        if (command === "finish") lines.push(result.merged ? `merged: ${result.claim.branch} (${result.commits} commits)` : "no merge needed", `merge sha: ${result.mergeCommit || "none"}`);
        if (result.carriedFiles?.length) lines.push(`carried ${result.carriedFiles.length} uncommitted file(s) from another session across the merge; backups: ${result.carryBackupDir}`);
        for (const c of result.carrySkipped || []) lines.push(`NOT carried: ${c.file} (${c.reason}); their version: ${c.backup} (blob ${c.blob})`);
        for (const a of result.archives || []) lines.push(`archived ${a.kind}: ${a.ref} ${a.sha.slice(0, 12)} (restore: ${a.restore})`);
        if (result.movedAside) lines.push(`worktree kept intact (uncommitted files${result.nested?.length ? " and nested repos" : ""}) at: ${result.movedAside}`);
        lines.push(`worktree removed: ${result.removedWorktree}`, `branch deleted: ${result.deletedBranch}`, `claim released: ${result.claim.id}`);
      }
      process.stdout.write(lines.join("\n") + "\n");
    }
    process.exitCode = result.ok ? 0 : result.refused ? 2 : 1;
  } catch (error) {
    const result = { ok: false, error: error.message };
    process.stdout.write(args.includes("--json") ? JSON.stringify(result, null, 2) + "\n" : `error: ${error.message}\n`);
    process.exitCode = 1;
  }
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    printUsage();
    return;
  }
  if (["start", "finish", "release", "claims", "amend-scope", "sweep"].includes(command)) {
    await runCheckin(command, rest);
    return;
  }
  printUsage();
  process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

module.exports = { main };
