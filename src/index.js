#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { snapshotRepo, checkpointRepo } = require("./checkpoint");
const {
  listBranches,
  detectSquashMerged,
  createBranch,
  switchBranch,
  deleteBranch,
  mergeBranch,
  currentBranch,
  defaultBranch,
  recoverDetachedHead,
} = require("./branches");
const {
  ghAvailable,
  ghAuthStatus,
  connectGitHub,
  publishRepo,
  pushWork,
  pullWork,
  remoteStatus,
} = require("./github");
const {
  scanForSecrets,
  secretRemediation,
  checkLargeFiles,
  suggestGitignore,
  writeGitignore,
  preCommitCheck,
} = require("./safety");

function repoPath(value = process.env.REPOSITORY_ROOT) {
  if (!value) throw new Error("Set REPOSITORY_ROOT in your private environment, then rerun the Git Manager command.");
  return path.resolve(value);
}

function git(args, root) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function status(root = repoPath()) { return git(["status", "--short", "--branch"], root); }
function branches(root = repoPath()) { return git(["branch", "--format=%(refname:short)"], root).split("\n").filter(Boolean); }
function logSummary(root = repoPath(), count = 10) { return git(["log", `-${Number(count) || 10}`, "--oneline"], root).split("\n").filter(Boolean); }
function diffStat(root = repoPath()) { return git(["diff", "--stat"], root); }
function repoHealth(root = repoPath()) {
  return {
    insideWorkTree: git(["rev-parse", "--is-inside-work-tree"], root) === "true",
    status: status(root),
    fsck: git(["fsck", "--no-dangling"], root) || "ok",
  };
}

function assertCommitAllowed(root) {
  if (process.env.GIT_MANAGER_ALLOW_COMMIT !== "true") throw new Error("Set GIT_MANAGER_ALLOW_COMMIT=true in your private environment after reviewing staged changes, then rerun commit.");
  const owner = process.env.GIT_REMOTE_OWNER;
  if (owner) {
    const remote = git(["remote", "get-url", "origin"], root);
    if (!remote.includes(`/${owner}/`) && !remote.includes(`:${owner}/`)) throw new Error("The origin remote does not match GIT_REMOTE_OWNER. Set the expected owner, then rerun commit.");
  }
}

/**
 * Manual commit of a human-authored message. Always preview-first: without
 * the exact confirmation phrase this returns a diff --stat preview and never
 * touches the repository.
 *
 * Gated by preCommitCheck: refuses the commit if blockers (secrets or oversized files) exist.
 */
function safeCommit(input = {}, root = repoPath()) {
  const message = String(input.message || "").trim();
  if (!message || message.startsWith("-") || message.includes("\n")) throw new Error("Provide a single-line commit message that does not start with a dash.");
  if (input.confirm !== "COMMIT") {
    return { status: "needs_approval", reply: `Preview only. This would commit the following staged/unstaged diff with message "${message}". Resubmit with confirmation: COMMIT`, metadata: { diffStat: diffStat(root) } };
  }
  const check = preCommitCheck({ repositoryRoot: root });
  if (!check.safe && check.blockers && check.blockers.length > 0) {
    return {
      status: "blocked",
      reply: `Commit refused: pre-commit safety check found ${check.blockers.length} blocker(s) (secret credentials or oversized files).`,
      blockers: check.blockers,
      warnings: check.warnings,
    };
  }
  assertCommitAllowed(root);
  return { status: "ok", sha: git(["commit", "-m", message], root) };
}

/**
 * Tier 1: always-safe autosave. Never gated, because it can only ever add a
 * ref under refs/allsorted/checkpoints/<branch> through an isolated index. It
 * never touches the working tree, the shared index, HEAD, or any branch.
 */
function snapshotWork(input = {}, root = repoPath()) {
  return snapshotRepo(root, { message: input.message });
}

/**
 * Tier 2: an ordinary commit onto the real branch, but only when the repo is
 * provably quiet. Tier 1 runs first unconditionally so the work is held
 * either way. The real commit itself is preview-first: without the exact
 * confirmation phrase this reports readiness and does not write.
 *
 * Gated by preCommitCheck: refuses the checkpoint commit if blockers exist.
 */
function checkpointWork(input = {}, root = repoPath()) {
  const snapshot = snapshotRepo(root, { message: input.snapshotMessage });
  const preview = checkpointRepo(root, { quietMinutes: input.quietMinutes, dryRun: true });
  if (preview.status !== "ready") return { status: "ok", snapshot, checkpoint: preview };
  if (input.confirm !== "CHECKPOINT") {
    return {
      status: "needs_approval",
      reply: `Preview only. Tier 1 snapshot already holds the work. ${preview.paths} path(s) on branch ${preview.branch} are quiet and ready for a real commit. Resubmit with confirmation: CHECKPOINT`,
      metadata: { snapshot, preview },
    };
  }
  const check = preCommitCheck({ repositoryRoot: root });
  if (!check.safe && check.blockers && check.blockers.length > 0) {
    return {
      status: "blocked",
      reply: `Checkpoint refused: pre-commit safety check found ${check.blockers.length} blocker(s) (secret credentials or oversized files).`,
      snapshot,
      checkpoint: { status: "blocked", blockers: check.blockers },
      blockers: check.blockers,
      warnings: check.warnings,
    };
  }
  const committed = checkpointRepo(root, { quietMinutes: input.quietMinutes, message: input.message });
  return { status: "ok", snapshot, checkpoint: committed };
}

async function runRecipe(action, input = {}) {
  const root = repoPath(input.repositoryRoot || input.root);
  const actions = {
    status: () => ({ status: status(root) }),
    "read-status": () => ({ status: status(root) }),
    branches: () => listBranches({ includeRemote: input.includeRemote !== false, root }),
    "list-branches": () => listBranches({ includeRemote: input.includeRemote !== false, root }),
    log: () => ({ commits: logSummary(root, input.count) }),
    "read-log": () => ({ commits: logSummary(root, input.count) }),
    "diff-stat": () => ({ diffStat: diffStat(root) }),
    "diff-summary": () => ({ diffStat: diffStat(root) }),
    health: () => repoHealth(root),
    "read-health": () => repoHealth(root),
    snapshot: () => snapshotWork(input, root),
    "snapshot-checkpoint-ref": () => snapshotWork(input, root),
    checkpoint: () => checkpointWork(input, root),
    "checkpoint-branch": () => checkpointWork(input, root),
    commit: () => safeCommit(input, root),
    "manual-commit": () => safeCommit(input, root),

    // New actions from the 14 new recipes
    "backup-status": () => require("./recipes/backup-status").runRecipe(input),
    "check-large-files": () => require("./recipes/check-large-files").runRecipe(input),
    "cleanup-branches": () => require("./recipes/cleanup-branches").runRecipe(input),
    "connect-github": () => connectGitHub(input),
    "create-branch": () => createBranch(input.name, { root }),
    "delete-branch": () => deleteBranch(input.name, { confirm: input.confirm, root }),
    "merge-branch": () => mergeBranch(input.name, { confirm: input.confirm, root }),
    "publish-repo": () => require("./recipes/publish-repo").runRecipe(input),
    "pull-work": () => pullWork(input, root),
    "push-work": () => pushWork(input, root),
    "safety-check": () => require("./recipes/safety-check").runRecipe(input),
    "scan-secrets": () => require("./recipes/scan-secrets").runRecipe(input),
    "setup-ignore": () => require("./recipes/setup-ignore").runRecipe(input),
    "switch-branch": () => switchBranch(input.name, { root }),
  };
  if (!actions[action]) throw new Error(`Unknown recipe action: ${action}`);
  return actions[action]();
}

function value(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(argv = process.argv.slice(2)) {
  if (["demo", "--demo"].includes(argv[0])) {
    console.log(JSON.stringify({ mode: "demo", provider: "git-manager", network: false, credentialFree: true }));
    return;
  }
  const [command, ...rest] = argv;
  try {
    let result;
    if (command === "status") result = { status: status() };
    else if (command === "branches") result = listBranches();
    else if (command === "log") result = { commits: logSummary(undefined, rest[0]) };
    else if (command === "diff-stat") result = { diffStat: diffStat() };
    else if (command === "health") result = repoHealth();
    else if (command === "snapshot") result = snapshotWork({ message: value(rest, "--message") });
    else if (command === "checkpoint") result = checkpointWork({ confirm: value(rest, "--confirm"), quietMinutes: value(rest, "--quiet-minutes"), message: value(rest, "--message") });
    else if (command === "commit") result = safeCommit({ message: value(rest, "--message") || rest.filter((a) => !a.startsWith("--")).join(" "), confirm: value(rest, "--confirm") });
    else throw new Error("Usage: node src/index.js demo|status|branches|log [count]|diff-stat|health|snapshot [--message m]|checkpoint [--confirm CHECKPOINT]|commit --message m [--confirm COMMIT]");
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  status,
  branches,
  logSummary,
  diffStat,
  repoHealth,
  safeCommit,
  snapshotWork,
  checkpointWork,
  runRecipe,
  repoPath,

  // branches
  listBranches,
  detectSquashMerged,
  createBranch,
  switchBranch,
  deleteBranch,
  mergeBranch,
  currentBranch,
  defaultBranch,
  recoverDetachedHead,

  // github
  ghAvailable,
  ghAuthStatus,
  connectGitHub,
  publishRepo,
  pushWork,
  pullWork,
  remoteStatus,

  // safety
  scanForSecrets,
  secretRemediation,
  checkLargeFiles,
  suggestGitignore,
  writeGitignore,
  preCommitCheck,
};
