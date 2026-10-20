"use strict";

const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { snapshotRepo } = require("./checkpoint");
const { resolveRepositoryRoot: repoPath } = require("./profile");

function loadBranchRetirement() {
  const candidates = [
    path.join(__dirname, "branch-retirement.js"),
    path.join(__dirname, "src", "branch-retirement.js"),
    path.join(__dirname, "..", "src", "branch-retirement.js"),
    path.join(__dirname, "..", "..", "..", "..", "..", "agents", "git-manager", "src", "branch-retirement.js"),
    path.join(process.cwd(), "agents", "git-manager", "src", "branch-retirement.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return require(c);
    }
  }
  throw new Error("Could not locate branch-retirement.js");
}

const { reportRetirement, applyRetirement, loadProfile } = loadBranchRetirement();

function resolveBackupDir(explicitBackupDir, profilePath, subPrefix, branchName) {
  if (explicitBackupDir && typeof explicitBackupDir === "string" && explicitBackupDir.trim()) {
    return { backupDir: explicitBackupDir.trim() };
  }

  const profile = loadProfile(profilePath);
  const backupRoot = profile && profile.branchCleanup && profile.branchCleanup.backupRoot;

  if (backupRoot && typeof backupRoot === "string" && path.isAbsolute(backupRoot) && fs.existsSync(backupRoot)) {
    try {
      const stat = fs.statSync(backupRoot);
      if (stat.isDirectory()) {
        const timestamp = Date.now();
        const rand = Math.random().toString(36).slice(2);
        const childName = branchName
          ? `${subPrefix}-${branchName}-${timestamp}-${rand}`
          : `${subPrefix}-${timestamp}-${rand}`;
        return { backupDir: path.join(backupRoot, childName) };
      }
    } catch {}
  }

  return {
    error: "Backup directory is required. Specify backupDir option or configure an absolute existing branchCleanup.backupRoot in your private profile."
  };
}

function git(repo, args, { env, timeout = 60000 } = {}) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
    env: env ? { ...process.env, ...env } : process.env,
  }).trim();
}

function gitOrNull(repo, args, opts) {
  try {
    return git(repo, args, opts);
  } catch {
    return null;
  }
}

function currentBranch(root) {
  const repo = repoPath(root);
  const b = gitOrNull(repo, ["branch", "--show-current"]);
  return b || null;
}

function defaultBranch(root) {
  const repo = repoPath(root);
  const symRef = gitOrNull(repo, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symRef) {
    const cleaned = symRef.replace(/^refs\/remotes\/origin\//, "").replace(/^refs\/heads\//, "");
    if (cleaned) return cleaned;
  }
  const hasMain = gitOrNull(repo, ["rev-parse", "--verify", "refs/heads/main"]);
  if (hasMain) return "main";
  const hasMaster = gitOrNull(repo, ["rev-parse", "--verify", "refs/heads/master"]);
  if (hasMaster) return "master";
  return "main";
}

function detectSquashMerged(branch, root) {
  const repo = repoPath(root);
  const defBranch = defaultBranch(repo);
  if (branch === defBranch) return true;

  const defHead = gitOrNull(repo, ["rev-parse", defBranch]);
  const targetHead = gitOrNull(repo, ["rev-parse", branch]);
  if (!defHead || !targetHead) return false;

  const mb = gitOrNull(repo, ["merge-base", defBranch, branch]);
  if (!mb) return false;
  if (mb === targetHead) return true;

  const tree = gitOrNull(repo, ["rev-parse", `${branch}^{tree}`]);
  if (!tree) return false;

  const synthCommit = gitOrNull(repo, ["commit-tree", tree, "-p", mb, "-m", "squash-check"]);
  if (!synthCommit) return false;

  const cherryResult = gitOrNull(repo, ["cherry", defBranch, synthCommit]);
  if (cherryResult && cherryResult.startsWith("-")) {
    return true;
  }
  return false;
}

function listBranches({ includeRemote = true, root } = {}) {
  const repo = repoPath(root);
  const curr = currentBranch(repo);
  const def = defaultBranch(repo);

  const refs = ["refs/heads"];
  if (includeRemote) {
    refs.push("refs/remotes");
  }

  const raw = gitOrNull(repo, [
    "for-each-ref",
    "--format=%(refname:short)|%(upstream:short)|%(committerdate:iso-strict)|%(subject)",
    ...refs
  ]);

  if (!raw) return { branches: [], currentBranch: curr, defaultBranch: def };

  const lines = raw.split("\n").filter(Boolean);
  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const result = [];

  for (const line of lines) {
    const parts = line.split("|");
    const name = parts[0];
    if (!name || name.endsWith("/HEAD")) continue;

    const upstream = parts[1] || null;
    const lastCommitDate = parts[2] || null;
    const lastCommitSubject = parts[3] || "";
    const isCurrent = name === curr;

    let ahead = 0;
    let behind = 0;

    if (upstream) {
      const counts = gitOrNull(repo, ["rev-list", "--left-right", "--count", `${name}...${upstream}`]);
      if (counts) {
        const [a, b] = counts.split(/\s+/).map(Number);
        ahead = a || 0;
        behind = b || 0;
      }
    }

    let isMerged = false;
    if (name === def) {
      isMerged = true;
    } else {
      const ancestor = gitOrNull(repo, ["merge-base", "--is-ancestor", name, def]);
      if (ancestor !== null) {
        isMerged = true;
      } else {
        isMerged = detectSquashMerged(name, repo);
      }
    }

    let isStale = isMerged && name !== def;
    if (!isStale && lastCommitDate && name !== def) {
      const commitTime = new Date(lastCommitDate).getTime();
      if (Number.isFinite(commitTime) && (now - commitTime) > thirtyDaysMs) {
        isStale = true;
      }
    }

    result.push({
      name,
      isCurrent,
      upstream,
      ahead,
      behind,
      lastCommitDate,
      lastCommitSubject,
      isMerged,
      isStale
    });
  }

  return {
    branches: result,
    currentBranch: curr,
    defaultBranch: def
  };
}

function createBranch(name, { root } = {}) {
  const repo = repoPath(root);
  if (!name || typeof name !== "string") {
    throw new Error("Specify a valid name for the new line of work.");
  }
  const cleanName = name.trim();

  const valid = gitOrNull(repo, ["check-ref-format", "--branch", cleanName]);
  if (valid === null) {
    throw new Error(`The name "${cleanName}" is not a valid line of work name.`);
  }

  const existing = gitOrNull(repo, ["rev-parse", "--verify", `refs/heads/${cleanName}`]);
  if (existing) {
    throw new Error(`A line of work named "${cleanName}" already exists.`);
  }

  git(repo, ["checkout", "-b", cleanName]);
  return {
    status: "ok",
    reply: `Created and switched to line of work "${cleanName}".`,
    branch: cleanName
  };
}

function switchBranch(name, { root } = {}) {
  const repo = repoPath(root);
  if (!name || typeof name !== "string") {
    throw new Error("Specify the line of work to switch to.");
  }
  const cleanName = name.trim();
  const curr = currentBranch(repo);
  if (curr === cleanName) {
    return {
      status: "ok",
      reply: `Already on line of work "${cleanName}".`,
      branch: cleanName
    };
  }

  const targetRef = gitOrNull(repo, ["rev-parse", "--verify", cleanName]);
  if (!targetRef) {
    throw new Error(`Line of work "${cleanName}" does not exist.`);
  }

  const snapshot = snapshotRepo(repo, { message: `Pre-switch snapshot to ${cleanName}` });

  try {
    git(repo, ["checkout", cleanName]);
    return {
      status: "ok",
      reply: `Switched to line of work "${cleanName}".`,
      branch: cleanName,
      snapshot
    };
  } catch (err) {
    try {
      git(repo, ["stash", "push", "-m", "all-sorted-auto-stash-before-switch"]);
      git(repo, ["checkout", cleanName]);
      try {
        git(repo, ["stash", "pop"]);
        return {
          status: "ok",
          reply: `Switched to line of work "${cleanName}". Your uncommitted work was carried over safely.`,
          branch: cleanName,
          snapshot
        };
      } catch (stashErr) {
        return {
          status: "warning",
          reply: `Switched to line of work "${cleanName}", but carrying over your uncommitted work caused conflicts. Your changes are saved safely in a stash.`,
          branch: cleanName,
          snapshot
        };
      }
    } catch (stashPushErr) {
      throw new Error(`Could not switch to line of work "${cleanName}": ${err.message}`);
    }
  }
}

function deleteBranch(name, options = {}) {
  const opts = typeof options === "string" ? { confirm: options } : (options || {});
  const repo = repoPath(opts.root);

  if (!name || typeof name !== "string") {
    throw new Error("Specify the line of work to delete.");
  }
  const cleanName = name.trim();

  const base = opts.base || defaultBranch(repo);
  const ownershipReviewed = opts.ownershipReviewed === true;

  const report = reportRetirement({
    repo,
    base,
    minAgeDays: opts.minAgeDays,
    protectedBranches: opts.protectedBranches,
    activeBranches: opts.activeBranches,
    profilePath: opts.profilePath,
    branches: [cleanName],
    ownershipReviewed,
    inspectActiveWork: opts.inspectActiveWork,
    now: opts.now,
  });

  const eligibleEntry = report.eligible.find(b => b.branchName === cleanName || b.refName === cleanName || b.refName === `refs/heads/${cleanName}`);
  const retainedEntry = report.retained.find(b => b.branchName === cleanName || b.refName === cleanName || b.refName === `refs/heads/${cleanName}`);

  if (!eligibleEntry || !ownershipReviewed) {
    const reason = retainedEntry ? retainedEntry.reason : (!ownershipReviewed ? "missing-ownership-review" : "blocked");
    const lastSha = retainedEntry ? retainedEntry.sha : (eligibleEntry ? eligibleEntry.sha : gitOrNull(repo, ["rev-parse", "--verify", `refs/heads/${cleanName}`]));

    return {
      status: "blocked",
      reply: !ownershipReviewed
        ? `Line of work "${cleanName}" requires operator ownership review (ownershipReviewed: true).`
        : `Line of work "${cleanName}" contains unmerged or protected work (retained reason: ${reason}). Unmerged work is retained. Integrate and verify it before deleting its branch.`,
      lastSha,
      isMerged: false,
      reason,
      missingEvidence: report.missingEvidence,
    };
  }

  const lastSha = eligibleEntry.sha;

  if (opts.confirm !== "DELETE") {
    return {
      status: "needs_approval",
      reply: `Preview only. Ready to delete line of work "${cleanName}". Resubmit with confirmation phrase "DELETE" to proceed.`,
      isMerged: true,
      lastSha,
      undoHint: `Undo hint: If deleted, you can restore it using: git branch ${cleanName} ${lastSha}`
    };
  }

  const backupRes = resolveBackupDir(opts.backupDir, opts.profilePath, "delete", cleanName);
  if (backupRes.error) {
    return {
      status: "blocked",
      reply: backupRes.error,
      deletedBranch: null,
      lastSha,
    };
  }

  const backupDir = backupRes.backupDir;
  const parentBackupDir = path.dirname(backupDir);
  if (!fs.existsSync(parentBackupDir)) {
    fs.mkdirSync(parentBackupDir, { recursive: true });
  }

  let applyRes;
  try {
    applyRes = applyRetirement({
      repo,
      base,
      backupDir,
      ownershipReviewed,
      branches: [cleanName],
      minAgeDays: opts.minAgeDays,
      protectedBranches: opts.protectedBranches,
      activeBranches: opts.activeBranches,
      profilePath: opts.profilePath,
      inspectActiveWork: opts.inspectActiveWork,
      now: opts.now,
      hooks: opts.hooks,
    });
  } catch (err) {
    return {
      status: "error",
      reply: `Deletion failed: ${err.message}`,
      deletedBranch: null,
      lastSha,
      backupDir,
      error: err.message,
    };
  }

  const isRetiredInReport = Array.isArray(applyRes.retired) && applyRes.retired.includes(cleanName);
  const refStillExists = gitOrNull(repo, ["rev-parse", "--verify", `refs/heads/${cleanName}`]) !== null;

  if (!isRetiredInReport || refStillExists) {
    return {
      status: "blocked",
      reply: `Line of work "${cleanName}" was retained by the final safety recheck.`,
      deletedBranch: null,
      lastSha,
      backupDir,
      report: applyRes,
    };
  }

  return {
    status: "ok",
    reply: `Deleted line of work "${cleanName}".`,
    deletedBranch: cleanName,
    lastSha,
    backupDir,
    undoHint: `Undo hint: To restore this deleted line of work, run: git branch ${cleanName} ${lastSha}`,
    report: applyRes
  };
}

function mergeBranch(name, { confirm, root } = {}) {
  const repo = repoPath(root);
  if (!name || typeof name !== "string") {
    throw new Error("Specify the line of work to merge.");
  }
  const cleanName = name.trim();
  const curr = currentBranch(repo);

  if (cleanName === curr) {
    throw new Error(`Cannot merge line of work "${cleanName}" into itself.`);
  }

  const exists = gitOrNull(repo, ["rev-parse", "--verify", cleanName]);
  if (!exists) {
    throw new Error(`Line of work "${cleanName}" does not exist.`);
  }

  if (confirm !== "MERGE") {
    return {
      status: "needs_approval",
      reply: `Preview only. Ready to merge line of work "${cleanName}" into current line of work "${curr}". Resubmit with confirmation phrase "MERGE" to proceed.`,
      targetBranch: cleanName,
      currentBranch: curr
    };
  }

  const snapshot = snapshotRepo(repo, { message: `Pre-merge snapshot before merging ${cleanName}` });

  try {
    git(repo, ["merge", "--no-ff", "-m", `Merge line of work '${cleanName}' into ${curr}`, cleanName]);
    const newHead = gitOrNull(repo, ["rev-parse", "HEAD"]);
    return {
      status: "ok",
      reply: `Successfully merged line of work "${cleanName}" into "${curr}".`,
      sha: newHead,
      snapshot
    };
  } catch (err) {
    const statusRaw = gitOrNull(repo, ["status", "--porcelain"]);
    const conflictingFiles = [];
    if (statusRaw) {
      const lines = statusRaw.split("\n");
      for (const line of lines) {
        const code = line.slice(0, 2);
        if (code === "UU" || code === "AA" || code === "UD" || code === "DU" || code === "DD" || code === "AU" || code === "UA") {
          conflictingFiles.push(line.slice(3));
        }
      }
    }

    gitOrNull(repo, ["merge", "--abort"]);

    return {
      status: "conflict",
      reply: `Could not merge line of work "${cleanName}" into "${curr}" due to conflicting changes. The merge was cleanly aborted so your files remain untouched.`,
      conflictingFiles,
      options: [
        "Review and resolve conflicting files on your line of work before merging",
        "Or make sure all files match before attempting the merge again"
      ],
      snapshot
    };
  }
}

function recoverDetachedHead({ root } = {}) {
  const repo = repoPath(root);
  const curr = currentBranch(repo);
  const def = defaultBranch(repo);

  if (curr !== null) {
    return {
      status: "ok",
      reply: `Not in a detached state. Currently on line of work "${curr}".`,
      branch: curr
    };
  }

  const sha = gitOrNull(repo, ["rev-parse", "HEAD"]);
  const snapshot = snapshotRepo(repo, { message: `Pre-recovery snapshot from detached HEAD ${sha}` });

  git(repo, ["checkout", def]);

  return {
    status: "ok",
    reply: `Safely returned to line of work "${def}". Your previous position (${sha ? sha.slice(0, 7) : "unknown"}) has been preserved in a snapshot.`,
    branch: def,
    previousSha: sha,
    snapshot
  };
}

module.exports = {
  listBranches,
  detectSquashMerged,
  createBranch,
  switchBranch,
  deleteBranch,
  mergeBranch,
  currentBranch,
  defaultBranch,
  recoverDetachedHead,
  repoPath
};
