#!/usr/bin/env node
"use strict";

/**
 * Git Manager multi-repo checkpoint surface.
 *
 * What it does, in plain English:
 *   1. Looks at your project folder(s) for changes you have not saved yet.
 *   2. Saves them automatically with a timestamped message (a "checkpoint").
 *   3. If the project has a GitHub remote, backs the checkpoint up there too.
 *   4. Tells you plainly if something needs your attention (no remote set up,
 *      a folder that has never been saved at all, work sitting unsaved for
 *      a long time).
 *
 * It never deletes, resets, stashes, or force-pushes anything. It only adds,
 * commits, and pushes. If something looks unsafe, it skips that repo and
 * tells you why instead of guessing.
 *
 * Usage:
 *   git-manager check [path...]   Report status only. Changes nothing.
 *   git-manager save [path...]    Checkpoint + push after explicit invocation.
 *   (no path given -> uses the current directory, or a supported config file)
 *
 * This is the canonical owner of the former Git Guardian check/save logic.
 * The legacy entrypoint delegates here so behavior stays compatible without
 * retaining a second implementation.
 */

const { execFileSync } = require("child_process");
const fs = require("./volume-probe").guardFs(require("fs"));
const os = require("os");
const path = require("path");

const MAX_FILE_MB = 10;
const DIRTY_WARN_DAYS = 3;
const DIRTY_CRITICAL_DAYS = 14;
const CONFIG_FILE = ".git-guardian.json";
const PRIMARY_CONFIG_FILE = ".git-manager.json";

function sh(cmd, args, cwd, timeout = 20000) {
  try {
    return execFileSync(cmd, args, { cwd, timeout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}
function git(repo, args) {
  return sh("git", ["-C", repo, ...args]);
}
function porcelainEntries(repo) {
  try {
    const raw = execFileSync("git", ["-C", repo, "status", "--porcelain"], { timeout: 20000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return raw.split("\n").filter(Boolean).map((l) => ({
      status: l.slice(0, 2),
      file: l.slice(3).replace(/^"(.*)"$/, "$1").split(" -> ").pop(),
    }));
  } catch {
    return null;
  }
}

function resolveTargets(argPaths) {
  if (argPaths.length) return argPaths.map((p) => path.resolve(p));
  // Config can live in the current folder or the home folder (cwd wins).
  for (const dir of [process.cwd(), os.homedir()]) {
    for (const configName of [PRIMARY_CONFIG_FILE, CONFIG_FILE]) {
      const cfgPath = path.join(dir, configName);
      if (!fs.existsSync(cfgPath)) continue;
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        if (Array.isArray(cfg.repos) && cfg.repos.length) {
          return cfg.repos.map((p) => path.resolve(p.replace(/^~(?=$|\/)/, os.homedir())));
        }
      } catch {
        console.error(`Could not read ${cfgPath}, ignoring it.`);
      }
    }
  }
  return [process.cwd()];
}

function isRepoBusy(repo) {
  const gitDir = git(repo, ["rev-parse", "--git-dir"]);
  if (!gitDir) return false;
  const full = path.isAbsolute(gitDir) ? gitDir : path.join(repo, gitDir);
  return ["index.lock", "MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "BISECT_LOG", "rebase-apply", "rebase-merge"]
    .some((f) => fs.existsSync(path.join(full, f)));
}

function hasGitIdentity(repo) {
  return git(repo, ["config", "user.email"]) !== null && git(repo, ["config", "user.name"]) !== null;
}

function inspect(repo) {
  if (!fs.existsSync(repo)) {
    return { repo, ok: false, message: "this folder does not exist" };
  }
  if (git(repo, ["rev-parse", "--git-dir"]) === null) {
    return { repo, ok: false, message: "this is not a Git project yet (no .git folder). Run: git init" };
  }

  const entries = porcelainEntries(repo) || [];
  const hasCommits = Number(git(repo, ["rev-list", "--count", "HEAD"]) || 0) > 0;
  const branch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const remotes = git(repo, ["remote"]) || "";
  const hasRemote = remotes.length > 0;

  let unpushed = 0;
  let hasUpstream = false;
  if (hasRemote && git(repo, ["rev-parse", "--abbrev-ref", "@{u}"]) !== null) {
    hasUpstream = true;
    unpushed = Number(git(repo, ["rev-list", "--count", "@{u}..HEAD"]) || 0);
  }

  let oldestDirtyDays = 0;
  for (const e of entries.slice(0, 500)) {
    try {
      const age = (Date.now() - fs.statSync(path.join(repo, e.file)).mtimeMs) / 86400000;
      if (age > oldestDirtyDays) oldestDirtyDays = age;
    } catch { /* file was deleted after status ran */ }
  }

  const notes = [];
  if (!hasCommits && entries.length > 0) notes.push("has files but has never been saved (no first commit yet)");
  if (!hasRemote) notes.push("no GitHub backup connected yet - if this laptop dies, this work is gone");
  if (hasRemote && !hasUpstream && hasCommits) notes.push("connected to GitHub but has never been pushed");
  if (unpushed > 0) notes.push(`${unpushed} saved checkpoint(s) not backed up to GitHub yet`);
  if (entries.length > 0 && oldestDirtyDays >= DIRTY_CRITICAL_DAYS) {
    notes.push(`unsaved changes sitting for ~${Math.round(oldestDirtyDays)} days`);
  } else if (entries.length > 0 && oldestDirtyDays >= DIRTY_WARN_DAYS) {
    notes.push(`unsaved changes for ~${Math.round(oldestDirtyDays)} days`);
  }
  if (isRepoBusy(repo)) notes.push("mid merge/rebase - needs a human to finish or cancel it before this tool touches it");

  return {
    repo, ok: true, branch, hasCommits, hasRemote, hasUpstream, unpushed,
    changed: entries.length, oldestDirtyDays: Math.round(oldestDirtyDays * 10) / 10, notes,
  };
}

function checkpoint(repo) {
  if (isRepoBusy(repo)) return { action: "skip", reason: "mid merge/rebase" };
  if (!hasGitIdentity(repo)) {
    return {
      action: "skip",
      reason: 'Git needs to know who you are first. Run these two commands once:\n     git config --global user.name "Your Name"\n     git config --global user.email "you@example.com"',
    };
  }

  const entries = porcelainEntries(repo) || [];
  if (entries.length === 0) return { action: "none", reason: "nothing to save" };

  const hadCommits = Number(git(repo, ["rev-list", "--count", "HEAD"]) || 0) > 0;

  sh("git", ["add", "-A"], repo);

  const oversized = [];
  for (const e of entries) {
    const full = path.join(repo, e.file);
    try {
      if (fs.statSync(full).size > MAX_FILE_MB * 1024 * 1024) oversized.push(e.file);
    } catch { /* deleted */ }
  }
  for (const f of oversized) {
    // "git reset HEAD" needs a HEAD to exist; in a never-committed repo the
    // equivalent unstage is "git rm --cached". Without this, the size guard
    // silently fails exactly once - on the first ever commit, the worst time.
    if (hadCommits) sh("git", ["reset", "HEAD", "--", f], repo);
    else sh("git", ["rm", "--cached", "--quiet", "--", f], repo);
  }

  const staged = sh("git", ["diff", "--cached", "--name-only"], repo) || "";
  if (!staged) {
    return { action: "skip", reason: oversized.length ? `only oversized file(s) >${MAX_FILE_MB}MB - add these to .gitignore` : "nothing stageable" };
  }

  const message = hadCommits
    ? `chore: checkpoint ${new Date().toISOString().slice(0, 19).replace("T", " ")}`
    : "chore: initial checkpoint (git-manager)";
  sh("git", ["commit", "-m", message], repo);
  // The short SHA is the audit trail: git-guardian's autosave log and its
  // console output both report which commit a checkpoint actually produced.
  // Dropping it would silently blind the autosave lane's history.
  const headSha = sh("git", ["rev-parse", "--short", "HEAD"], repo);
  const ok = headSha !== null;

  return { action: ok ? "committed" : "failed", sha: headSha || undefined, oversized };
}

function pushIfPossible(repo) {
  const hasRemote = (git(repo, ["remote"]) || "").length > 0;
  if (!hasRemote) return { action: "skip", reason: "no GitHub remote connected" };

  const branch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") return { action: "skip", reason: "detached HEAD, needs a human" };

  const hasUpstream = git(repo, ["rev-parse", "--abbrev-ref", "@{u}"]) !== null;
  const result = sh("git", ["push", ...(hasUpstream ? [] : ["-u", "origin", branch])], repo, 60000);
  const unpushedAfter = git(repo, ["rev-parse", "--abbrev-ref", "@{u}"]) !== null
    ? Number(git(repo, ["rev-list", "--count", "@{u}..HEAD"]) || 0)
    : 0;

  return { action: result !== null && unpushedAfter === 0 ? "pushed" : "failed", branch };
}

function printCheck(targets) {
  let anyIssue = false;
  for (const t of targets) {
    const r = inspect(t);
    if (!r.ok) {
      anyIssue = true;
      console.log(`x ${t}\n   ${r.message}\n`);
      continue;
    }
    if (r.notes.length === 0) {
      console.log(`ok ${t} - all good, nothing to do`);
      continue;
    }
    anyIssue = true;
    console.log(`! ${t}`);
    for (const n of r.notes) console.log(`   - ${n}`);
    console.log("");
  }
  if (anyIssue) {
    console.log("Run: git-manager save    (to fix what it safely can)");
  }
}

function printSave(targets) {
  for (const t of targets) {
    if (!fs.existsSync(t) || git(t, ["rev-parse", "--git-dir"]) === null) {
      console.log(`x ${t} - not a Git project yet, skipping (run: git init)`);
      continue;
    }
    if (isRepoBusy(t)) {
      console.log(`! ${t} - mid merge/rebase, skipping (needs a human)`);
      continue;
    }
    const c = checkpoint(t);
    if (c.action === "committed") {
      console.log(`ok ${t} - saved a new checkpoint${c.oversized?.length ? ` (skipped ${c.oversized.length} file(s) over ${MAX_FILE_MB}MB)` : ""}`);
    } else if (c.action === "none") {
      console.log(`  ${t} - nothing new to save`);
    } else if (c.action === "skip") {
      console.log(`! ${t} - ${c.reason}`);
    } else {
      console.log(`x ${t} - could not save, check for a git problem by hand`);
      continue;
    }

    const p = pushIfPossible(t);
    if (p.action === "pushed") console.log(`  -> backed up to GitHub (${p.branch})`);
    else if (p.action === "skip") console.log(`  -> ${p.reason}`);
    else console.log(`  -> could not back up to GitHub. Check your internet connection or run "git push" by hand to see the error.`);
  }
}

function main() {
  const [, , cmd, ...rest] = process.argv;
  const targets = resolveTargets(rest);

  if (cmd === "save") return printSave(targets);
  if (cmd === "check" || !cmd) return printCheck(targets);

  console.log(`Git Manager - repository health and explicit checkpoint backup.

Usage:
  git-manager check [path...]   Look for problems. Changes nothing.
  git-manager save  [path...]   Save + back up to GitHub after explicit invocation.

With no path, it uses the current folder, .git-manager.json, or the legacy .git-guardian.json file.`);
}

if (require.main === module) {
  main();
}

// ------------------------------------------------- structured (recipe) API
/**
 * Preview-first surface for recipe callers. This lived in git-guardian's
 * src/runtime.js and was the last piece of the checkpoint path duplicated
 * outside this file; it is canonical here so there is exactly one write path.
 * git-guardian re-exports it for backward compatibility.
 */
function resolveInputTargets(input = {}) {
  if (Array.isArray(input.repos) && input.repos.length) {
    return input.repos.map((p) => path.resolve(String(p)));
  }
  if (typeof input.repo === "string" && input.repo.trim()) {
    return [path.resolve(input.repo.trim())];
  }
  const args = Array.isArray(input.args) ? input.args : [];
  return resolveTargets(args.map(String));
}

/** Read-only. The same inspect() the `check` command uses, structured. */
function checkStructured(input = {}) {
  const targets = resolveInputTargets(input);
  const results = targets.map((repo) => inspect(repo));
  const anyIssue = results.some((r) => !r.ok || (r.notes && r.notes.length > 0));
  return { targets, results, anyIssue };
}

/** What `save` would do, without doing it. Reads status only, never writes. */
function previewSave(input = {}) {
  const targets = resolveInputTargets(input);
  const preview = targets.map((repo) => {
    if (!fs.existsSync(repo) || git(repo, ["rev-parse", "--git-dir"]) === null) {
      return { repo, wouldAct: false, wouldCommit: false, wouldPush: false, reason: "not a Git project yet (run: git init)" };
    }
    if (isRepoBusy(repo)) {
      return { repo, wouldAct: false, wouldCommit: false, wouldPush: false, reason: "mid merge/rebase, skipping (needs a human)" };
    }
    const r = inspect(repo);
    const changedFiles = r.ok ? r.changed : 0;
    return {
      repo,
      wouldAct: true,
      changedFiles,
      wouldCommit: changedFiles > 0,
      wouldPush: r.ok ? r.hasRemote : false,
      remoteConfigured: r.ok ? r.hasRemote : false,
      notes: r.ok ? r.notes : [],
    };
  });
  return { targets, preview, anyPush: preview.some((p) => p.wouldPush), anyCommit: preview.some((p) => p.wouldCommit) };
}

/**
 * The write path: checkpoint() then pushIfPossible() per target, with the same
 * order and skip conditions as printSave(). Callers must have shown a preview
 * and gotten confirmation first; this does not itself gate on confirmation.
 */
function runSave(input = {}) {
  const targets = resolveInputTargets(input);
  const results = [];
  for (const repo of targets) {
    if (!fs.existsSync(repo) || git(repo, ["rev-parse", "--git-dir"]) === null) {
      results.push({ repo, action: "skipped", reason: "not a Git project yet (run: git init)" });
      continue;
    }
    if (isRepoBusy(repo)) {
      results.push({ repo, action: "skipped", reason: "mid merge/rebase, skipping (needs a human)" });
      continue;
    }
    const checkpointResult = checkpoint(repo);
    if (!["committed", "none", "skip"].includes(checkpointResult.action)) {
      results.push({ repo, action: "failed", checkpoint: checkpointResult });
      continue;
    }
    const pushResult = pushIfPossible(repo);
    results.push({ repo, action: checkpointResult.action, checkpoint: checkpointResult, push: pushResult });
  }
  return { targets, results };
}

module.exports = {
  MAX_FILE_MB,
  DIRTY_WARN_DAYS,
  DIRTY_CRITICAL_DAYS,
  CONFIG_FILE,
  PRIMARY_CONFIG_FILE,
  sh,
  git,
  porcelainEntries,
  resolveTargets,
  isRepoBusy,
  hasGitIdentity,
  inspect,
  checkpoint,
  pushIfPossible,
  printCheck,
  printSave,
  resolveInputTargets,
  checkStructured,
  previewSave,
  runSave,
  main,
};
