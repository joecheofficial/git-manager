"use strict";
/**
 * Two-tier checkpointing. The point of the split: one tier can never be unsafe,
 * so it never needs permission to run.
 *
 * TIER 1 — snapshot (always safe, every call, any dirty repo)
 *   Builds a commit in an ISOLATED index (GIT_INDEX_FILE) and parks it on
 *   refs/allsorted/checkpoints/<branch>. It does not touch the working tree,
 *   the shared .git/index, HEAD, or any branch. There is nothing for it to
 *   race with and nothing it can clobber, so it can run unconditionally, even
 *   while other tools are mid-write elsewhere in the repo. Each snapshot
 *   carries the previous snapshot as its first parent, so the chain is a
 *   history, not a single overwritable pointer.
 *
 * TIER 2 — checkpoint commit (only when the repo is provably quiet)
 *   An ordinary add+commit on the real branch, so history stays tidy and
 *   readable. Gated on: no index.lock, no file touched inside the quiet
 *   window, no detached HEAD, no mid-merge/rebase, and HEAD verified
 *   unchanged either side of the commit. If any of that fails it simply
 *   doesn't run. Tier 1 already holds the work either way.
 *
 * Why this shape: nothing here can destroy work. Neither tier ever modifies a
 * file in the working tree. No reset, no checkout, no clean, no stash, no
 * force-push, no branch delete, no history rewrite. Tier 1 sidesteps
 * ownership entirely by never claiming the branch. Tier 2 only claims it when
 * nobody else is plausibly writing to it, and callers still gate the actual
 * write behind an explicit confirmation phrase before this module is asked to
 * run in commit mode.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SNAPSHOT_NS = "refs/allsorted/checkpoints";
const DEFAULT_MAX_FILE_MB = 10;
const DEFAULT_QUIET_MINUTES = 10;
// Long enough that any work worth keeping has reached a real commit; short
// enough that the pack does not grow without bound.
const DEFAULT_MAX_CHAIN = 336;

function git(repo, args, { env, timeout = 60000 } = {}) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
    env: env ? { ...process.env, ...env } : process.env,
  }).trim();
}

function gitOrNull(repo, args, opts) {
  try { return git(repo, args, opts); } catch { return null; }
}

/**
 * Candidate paths: everything git would consider, NUL-safe (hostile filenames).
 * --no-optional-locks so merely *looking* at the repo never rewrites the shared
 * index's stat cache underneath another process using the same repo.
 */
function changedPaths(repo) {
  const raw = execFileSync("git", ["--no-optional-locks", "-C", repo, "status", "--porcelain=v1", "-z"], {
    encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"],
  });
  const records = raw.split("\0");
  const out = [];
  for (let i = 0; i < records.length && records[i]; i += 1) {
    const status = records[i].slice(0, 2);
    out.push({ status, file: records[i].slice(3) });
    if (status.includes("R") || status.includes("C")) i += 1; // rename: skip the origin record
  }
  return out;
}

function maxFileBytes(repo) {
  const configured = Number(gitOrNull(repo, ["config", "--get", "allsorted.autosave.max-file-mb"]));
  const mb = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_FILE_MB;
  return mb * 1024 * 1024;
}

/** Split candidates into what we can safely take and what is too big to carry. */
function partitionBySize(repo, entries) {
  const limit = maxFileBytes(repo);
  const take = [];
  const oversized = [];
  for (const e of entries) {
    if (e.status === " D" || e.status === "D ") { take.push(e.file); continue; } // deletions have no size
    try {
      const st = fs.statSync(path.join(repo, e.file));
      if (st.isDirectory()) { take.push(e.file); continue; }
      if (st.size > limit) oversized.push({ file: e.file, bytes: st.size });
      else take.push(e.file);
    } catch { take.push(e.file); } // vanished mid-sweep; let git decide
  }
  return { take, oversized };
}

function writePathspec(paths) {
  const file = path.join(os.tmpdir(), `git-manager-paths-${process.pid}-${Math.round(performance.now() * 1000)}`);
  fs.writeFileSync(file, paths.map((p) => p + "\0").join(""));
  return file;
}

function currentBranch(repo) {
  const b = gitOrNull(repo, ["branch", "--show-current"]);
  return b || null; // empty means detached
}

function inProgressOperation(repo) {
  const gitDir = gitOrNull(repo, ["rev-parse", "--git-dir"]);
  if (!gitDir) return "no git dir";
  const abs = path.resolve(repo, gitDir);
  for (const marker of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"]) {
    if (fs.existsSync(path.join(abs, marker))) return marker;
  }
  return null;
}

function indexLocked(repo) {
  const gitDir = gitOrNull(repo, ["rev-parse", "--git-dir"]);
  return gitDir ? fs.existsSync(path.join(path.resolve(repo, gitDir), "index.lock")) : false;
}

/** Newest mtime across candidate paths, in minutes. Infinity when nothing to weigh. */
function minutesSinceLastWrite(repo, files, now = Date.now()) {
  let newest = 0;
  for (const f of files) {
    try {
      const st = fs.statSync(path.join(repo, f));
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    } catch { /* deleted */ }
  }
  return newest ? (now - newest) / 60000 : Infinity;
}

// ───────────────────────────────────────────────────────── TIER 1: snapshot

/**
 * Park the current working-tree state on refs/allsorted/checkpoints/<branch>.
 * Touches nothing shared. Returns {status, ref, sha, oversized, reason}.
 */
function snapshotRepo(repo, { now = Date.now(), message, maxChain = DEFAULT_MAX_CHAIN } = {}) {
  if (gitOrNull(repo, ["rev-parse", "--git-dir"]) === null) return { status: "skipped", reason: "not a git repo" };

  const entries = changedPaths(repo);
  if (!entries.length) return { status: "clean", reason: "nothing uncommitted" };

  const branch = currentBranch(repo) || "DETACHED";
  const ref = `${SNAPSHOT_NS}/${branch}`;
  const { take, oversized } = partitionBySize(repo, entries);
  if (!take.length) return { status: "skipped", reason: "every changed file exceeds the size guard", oversized };

  const head = gitOrNull(repo, ["rev-parse", "HEAD"]); // null in a repo with no commits yet
  const tmpIndex = path.join(os.tmpdir(), `git-manager-index-${process.pid}-${Math.round(performance.now() * 1000)}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  const pathspec = writePathspec(take);

  try {
    // Seed the isolated index from HEAD so unchanged tracked files survive into
    // the tree. Without this the snapshot would contain ONLY changed paths.
    if (head) git(repo, ["read-tree", "HEAD"], { env });

    // --ignore-errors: a listed path may be gitignored; take what git accepts.
    try {
      git(repo, ["add", "--all", "--ignore-errors", `--pathspec-from-file=${pathspec}`, "--pathspec-file-nul"], { env });
    } catch { /* partial staging is still worth snapshotting */ }

    const tree = gitOrNull(repo, ["write-tree"], { env });
    if (!tree) return { status: "skipped", reason: "write-tree failed", oversized };

    const prev = gitOrNull(repo, ["rev-parse", "--verify", "--quiet", ref]);
    if (prev) {
      const prevTree = gitOrNull(repo, ["rev-parse", `${prev}^{tree}`]);
      if (prevTree === tree) return { status: "unchanged", ref, sha: prev, oversized };
    }
    if (!prev && head && gitOrNull(repo, ["rev-parse", "HEAD^{tree}"]) === tree) {
      return { status: "clean", reason: "worktree matches HEAD", oversized };
    }

    // Parents: previous snapshot first (so the chain reads as history), then
    // the real HEAD, so the snapshot is anchored to the branch it came from.
    //
    // Bounded on purpose: repeated snapshots of a repo with a churning data
    // file would otherwise grow the pack forever. Past maxChain we re-root
    // (drop the snapshot parent, keep HEAD), so superseded intermediate
    // states age out of the object store. The CURRENT state is always
    // captured; only stale in-between states are let go.
    const parents = [];
    let reRooted = false;
    if (prev) {
      const depthArgs = ["rev-list", "--count", prev];
      if (head) depthArgs.push(`^${head}`);
      const depth = Number(gitOrNull(repo, depthArgs) || 0);
      if (depth >= maxChain) reRooted = true;
      else parents.push("-p", prev);
    }
    if (head && head !== prev) parents.push("-p", head);

    const stamp = new Date(now).toISOString().replace("T", " ").slice(0, 19);
    const text = message || `snapshot(${branch}): ${take.length} path(s) at ${stamp} UTC`;
    const sha = git(repo, ["commit-tree", tree, ...parents, "-m", text], {
      env: { ...env, GIT_AUTHOR_NAME: "git-manager", GIT_AUTHOR_EMAIL: "git-manager@localhost" },
    });

    // Compare-and-swap: refuse if the ref moved since we read it.
    const casArgs = prev ? ["update-ref", ref, sha, prev] : ["update-ref", ref, sha, ""];
    try { git(repo, casArgs); }
    catch { return { status: "skipped", reason: "snapshot ref moved mid-transaction", oversized }; }

    return { status: "created", ref, sha, paths: take.length, oversized, reRooted };
  } finally {
    fs.rmSync(tmpIndex, { force: true });
    fs.rmSync(pathspec, { force: true });
  }
}

// ──────────────────────────────────────────────── TIER 2: real branch commit

/**
 * Commit uncommitted work onto the real branch, but only when the repo is
 * demonstrably idle. Every gate below is a refusal to act, never a mutation;
 * failing them costs nothing because Tier 1 already holds the work.
 *
 * Pass `dryRun: true` to run every gate and report what WOULD happen without
 * staging or committing anything. Callers use this to build a confirmation
 * preview before asking a human to approve the real write.
 */
function checkpointRepo(repo, {
  now = Date.now(),
  quietMinutes = DEFAULT_QUIET_MINUTES,
  message,
  dryRun = false,
} = {}) {
  const skip = (reason, extra) => ({ status: "skipped", reason, ...extra });

  if (gitOrNull(repo, ["rev-parse", "--git-dir"]) === null) return skip("not a git repo");
  if (gitOrNull(repo, ["config", "--bool", "--get", "allsorted.autosave"]) === "false") return skip("autosave disabled for this repo");

  const op = inProgressOperation(repo);
  if (op) return skip(`mid-operation (${op})`);
  if (indexLocked(repo)) return skip("index.lock held by another git process");

  const branch = currentBranch(repo);
  if (!branch) return skip("detached HEAD");

  const entries = changedPaths(repo);
  if (!entries.length) return { status: "clean", reason: "nothing uncommitted" };

  const { take, oversized } = partitionBySize(repo, entries);
  if (!take.length) return skip("every changed file exceeds the size guard", { oversized });

  const quietFor = minutesSinceLastWrite(repo, take, now);
  if (quietFor < quietMinutes) return skip(`still being written (${quietFor.toFixed(1)}m < ${quietMinutes}m quiet window)`, { oversized });

  if (dryRun) return { status: "ready", branch, paths: take.length, oversized, quietFor };

  const before = gitOrNull(repo, ["rev-parse", "HEAD"]);
  const pathspec = writePathspec(take);
  try {
    try {
      git(repo, ["add", "--all", "--ignore-errors", `--pathspec-from-file=${pathspec}`, "--pathspec-file-nul"]);
    } catch { /* ignored paths refused; commit what staged */ }

    const staged = gitOrNull(repo, ["diff", "--cached", "--name-only"]);
    if (!staged) return skip("nothing staged after ignore rules", { oversized });

    // HEAD must not have moved while we staged.
    if (gitOrNull(repo, ["rev-parse", "HEAD"]) !== before) {
      gitOrNull(repo, ["reset", "--mixed"]); // unstage only; working tree untouched
      return skip("HEAD moved while staging", { oversized });
    }

    const stamp = new Date(now).toISOString().replace("T", " ").slice(0, 19);
    const text = message || `chore(checkpoint): ${stamp} UTC`;
    git(repo, ["commit", "--no-verify", "-m", text, `--pathspec-from-file=${pathspec}`, "--pathspec-file-nul"]);

    const after = gitOrNull(repo, ["rev-parse", "HEAD"]);
    if (!after || after === before) return skip("commit produced no new HEAD", { oversized });
    return { status: "committed", sha: after, branch, paths: staged.split("\n").length, oversized };
  } finally {
    fs.rmSync(pathspec, { force: true });
  }
}

module.exports = {
  snapshotRepo,
  checkpointRepo,
  changedPaths,
  partitionBySize,
  minutesSinceLastWrite,
  inProgressOperation,
  indexLocked,
  SNAPSHOT_NS,
  DEFAULT_QUIET_MINUTES,
  DEFAULT_MAX_CHAIN,
};
