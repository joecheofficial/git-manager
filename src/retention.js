"use strict";
/**
 * Retention policy (product decision, 2026-09-26: "We want to keep them if we're using them,
 * not if we're not").
 *
 * The 2026-09-26 cleanup found the real bloat was never branches — it was
 * WORKTREES. 172 worktrees against ~30 real branches. Every worktree pins its
 * branch, so branches could not be retired until the worktree went first. The
 * mess re-forms unless something expires them, so this makes ephemeral things
 * actually ephemeral: a worktree is a workbench, not an archive.
 *
 * Nothing here deletes. It classifies and reports; retirement stays with
 * branch-retirement.js and its backup + ownership-reviewed gates.
 */
const DAY = 86400000;

const DEFAULTS = {
  worktreeStaleDays: 30,     // clean + untouched this long = the work is over
  scratchStaleDays: 30,      // agent-generated, reproducible by re-running
  vendorStaleDays: 180,      // third-party checkouts, re-clonable
  protectedBranches: [/^main$/, /^master$/, /^develop$/, /^release/, /preserve/, /^recovery/, /^archive\//, /^snapshot\//],
};

function isProtectedBranch(name, cfg = DEFAULTS) {
  return cfg.protectedBranches.some((re) => re.test(name || ""));
}

function ageDays(iso, now = Date.now()) {
  if (!iso) return Infinity;
  const t = Date.parse(String(iso).replace(/Z$/, "+00:00"));
  return Number.isNaN(t) ? Infinity : (now - t) / DAY;
}

/**
 * Verdicts:
 *   keep     - in use, or protected
 *   expire   - stale AND clean: safe to retire, work is finished
 *   review   - stale but DIRTY: someone left something behind, a human looks
 */
function verdictFor(repo, cfg = DEFAULTS, now = Date.now()) {
  if (repo.offlineVolume) return { verdict: "keep", why: "offline volume; retention unverifiable" };
  const path = repo.path || "";
  if (path.includes("/.claude/worktrees/")) return { verdict: "keep", why: "managed by the Claude app" };
  if (path.startsWith("~/.codex/worktrees/")) return { verdict: "keep", why: "managed by the Codex app" };
  if (path.startsWith("~/atelier-head-start/") && !path.startsWith("~/atelier-head-start/preserve-")) {
    return { verdict: "keep", why: "serves the Atelier service" };
  }

  const age = ageDays(repo.lastCommit, now);
  const dirty = Number(repo.dirty || 0) > 0;

  if (repo.kind === "first-party") return { verdict: "keep", why: "first-party repo" };
  if (repo.kind === "release-artifact") return { verdict: "keep", why: "release artifact, immutable by policy" };

  const limit = repo.kind === "worktree" ? cfg.worktreeStaleDays
    : repo.kind === "vendor" ? cfg.vendorStaleDays
      : cfg.scratchStaleDays;

  if (age <= limit) return { verdict: "keep", why: `active (${Math.round(age)}d old, limit ${limit}d)` };
  if (dirty) return { verdict: "review", why: `stale ${Math.round(age)}d but has ${repo.dirty} uncommitted file(s) — preserve before removing` };
  if (["agent-scratch", "vendor"].includes(repo.kind) && !repo.linkedWorktree && repo.localOnly > 0) {
    return { verdict: "review", why: `has ${repo.localOnly} local-only commit(s) \u2014 push or mirror before removing` };
  }
  return { verdict: "expire", why: `${repo.kind} clean and untouched ${Math.round(age)}d (limit ${limit}d)` };
}

function apply(censusSnapshot, cfg = DEFAULTS, now = Date.now()) {
  const rows = censusSnapshot.repos.map((r) => ({ ...r, ...verdictFor(r, cfg, now) }));
  return {
    keep: rows.filter((r) => r.verdict === "keep"),
    expire: rows.filter((r) => r.verdict === "expire"),
    review: rows.filter((r) => r.verdict === "review"),
  };
}

function retentionFindings(censusSnapshot, add, cfg = DEFAULTS, now = Date.now()) {
  const r = apply(censusSnapshot, cfg, now);
  for (const x of r.review) {
    add("stale-worktree-dirty", "warn", x.path,
      `${x.why}`, "commit or snapshot the changes, then remove the worktree");
  }
  if (r.expire.length) {
    add("expired-ephemeral", "info", "~",
      `${r.expire.length} ephemeral checkout(s) past their retention limit (worktrees/scratch/vendor), clean and safe to remove`,
      "node src/branch-retirement-cli.js --apply --backup-dir <dir> --ownership-reviewed, or remove the worktrees");
  }
  return { keep: r.keep.length, expire: r.expire.length, review: r.review.length };
}

module.exports = { DEFAULTS, verdictFor, apply, retentionFindings, isProtectedBranch, ageDays };
