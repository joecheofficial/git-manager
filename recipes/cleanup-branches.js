"use strict";
const { listBranches, deleteBranch, repoPath } = require("../branches");
const { snapshotRepo } = require("../checkpoint");

module.exports.runRecipe = (input = {}) => {
  const root = input.repositoryRoot || input.root || repoPath();
  const branchInfo = listBranches({ includeRemote: false, root });
  const staleBranches = branchInfo.branches.filter(b => b.isStale && !b.isCurrent && b.name !== branchInfo.defaultBranch);

  if (staleBranches.length === 0) {
    return {
      status: "ok",
      reply: "No stale or merged lines of work found to clean up.",
      staleBranches: []
    };
  }

  if (input.confirm !== "CLEANUP") {
    return {
      status: "needs_approval",
      reply: `Found ${staleBranches.length} stale or merged line(s) of work ready for cleanup: ${staleBranches.map(b => b.name).join(", ")}. Resubmit with confirmation phrase "CLEANUP" to delete them safely.`,
      staleBranches: staleBranches.map(b => ({
        name: b.name,
        isMerged: b.isMerged,
        lastCommitDate: b.lastCommitDate,
        lastCommitSubject: b.lastCommitSubject
      }))
    };
  }

  const snapshot = snapshotRepo(root, { message: "Pre-cleanup snapshot before deleting stale branches" });
  const deleted = [];
  const errors = [];

  for (const b of staleBranches) {
    try {
      const result = deleteBranch(b.name, { confirm: b.isMerged ? "DELETE" : "DELETE UNMERGED", root });
      deleted.push({ name: b.name, undoHint: result.undoHint });
    } catch (err) {
      errors.push({ name: b.name, error: err.message });
    }
  }

  return {
    status: "ok",
    reply: `Cleaned up ${deleted.length} line(s) of work.`,
    deleted,
    errors,
    snapshot
  };
};
