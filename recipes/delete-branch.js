"use strict";
const { deleteBranch } = require("../branches");

module.exports.runRecipe = (input = {}) => {
  return deleteBranch(input.name, {
    confirm: input.confirm,
    root: input.repositoryRoot || input.root,
    base: input.base,
    profilePath: input.profilePath,
    backupDir: input.backupDir,
    minAgeDays: input.minAgeDays,
    ownershipReviewed: input.ownershipReviewed,
    protectedBranches: input.protectedBranches,
    activeBranches: input.activeBranches,
  });
};
