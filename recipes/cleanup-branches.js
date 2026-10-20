"use strict";
const { repoPath, defaultBranch } = require("../branches");
const fs = require("node:fs");
const path = require("node:path");

function loadBranchRetirement() {
  const candidates = [
    path.join(__dirname, "branch-retirement.js"),
    path.join(__dirname, "..", "branch-retirement.js"),
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

function resolveBackupDir(explicitBackupDir, profilePath, subPrefix) {
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
        return { backupDir: path.join(backupRoot, `${subPrefix}-${timestamp}-${rand}`) };
      }
    } catch {}
  }

  return {
    error: "Backup directory is required. Specify backupDir option or configure an absolute existing branchCleanup.backupRoot in your private profile."
  };
}

module.exports.runRecipe = (input = {}) => {
  const root = input.repositoryRoot || input.root || repoPath();
  const base = input.base || defaultBranch(root);
  const ownershipReviewed = input.ownershipReviewed === true;

  const report = reportRetirement({
    repo: root,
    base,
    ownershipReviewed,
    minAgeDays: input.minAgeDays,
    protectedBranches: input.protectedBranches,
    activeBranches: input.activeBranches,
    profilePath: input.profilePath,
    branches: input.branches,
    inspectActiveWork: input.inspectActiveWork,
    now: input.now,
  });

  const eligible = report.eligible || [];

  if (eligible.length === 0 || !ownershipReviewed) {
    return {
      status: "blocked",
      reply: "No branches are eligible for guarded cleanup. Review retained reasons and missing evidence.",
      staleBranches: [],
      deleted: [],
      retained: report.retained,
      missingEvidence: report.missingEvidence,
    };
  }

  if (input.confirm !== "CLEANUP") {
    return {
      status: "needs_approval",
      reply: `Found ${eligible.length} stale or merged line(s) of work ready for cleanup: ${eligible.map(b => b.branchName).join(", ")}. Resubmit with confirmation phrase "CLEANUP" to delete them safely.`,
      staleBranches: eligible.map(b => ({
        name: b.branchName,
        isMerged: true,
        sha: b.sha
      })),
      retained: report.retained
    };
  }

  const backupRes = resolveBackupDir(input.backupDir, input.profilePath, "cleanup");
  if (backupRes.error) {
    return {
      status: "blocked",
      reply: backupRes.error,
      staleBranches: [],
      deleted: [],
      retained: report.retained,
    };
  }

  const backupDir = backupRes.backupDir;
  const parentBackupDir = path.dirname(backupDir);
  if (!fs.existsSync(parentBackupDir)) {
    fs.mkdirSync(parentBackupDir, { recursive: true });
  }

  try {
    const applyRes = applyRetirement({
      repo: root,
      base,
      backupDir,
      ownershipReviewed,
      minAgeDays: input.minAgeDays,
      protectedBranches: input.protectedBranches,
      activeBranches: input.activeBranches,
      profilePath: input.profilePath,
      branches: input.branches,
      inspectActiveWork: input.inspectActiveWork,
      now: input.now,
      hooks: input.hooks,
    });

    const retiredNames = Array.isArray(applyRes.retired) ? applyRes.retired : [];

    if (retiredNames.length === 0) {
      return {
        status: "blocked",
        reply: "No branches were deleted because the final safety recheck retained every candidate.",
        deleted: [],
        retained: applyRes.report ? applyRes.report.retained : report.retained,
        backupDir,
        report: applyRes,
      };
    }

    return {
      status: "ok",
      reply: `Cleaned up ${retiredNames.length} line(s) of work.`,
      deleted: retiredNames.map(name => ({ name })),
      retained: report.retained,
      backupDir,
      report: applyRes
    };
  } catch (err) {
    return {
      status: "error",
      reply: `Cleanup failed: ${err.message}`,
      error: err.message,
      retained: report.retained
    };
  }
};
