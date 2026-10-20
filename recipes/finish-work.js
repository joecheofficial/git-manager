"use strict";
const checkin = require("../src/checkin");
module.exports.runRecipe = async function runRecipe(input = {}) {
  try {
    const result = checkin.finish(input.claim, { cwd: input.cwd, push: input.push, testCommand: input.testCommand });
    const reply = result.ok
      ? `${result.merged ? `Merged ${result.claim.branch}: ${result.mergeCommit}` : "No merge needed"}\nWorktree removed: ${result.removedWorktree}\nBranch deleted: ${result.deletedBranch}\nClaim released: ${result.claim.id}${result.warnings.length ? "\n" + result.warnings.map(w => `warn: ${w}`).join("\n") : ""}`
      : result.reasons.map(r => `REFUSED: ${r}`).join("\n");
    return { status: result.ok ? "ok" : "refused", reply, artifacts: [], metadata: result };
  } catch (error) {
    return { status: "error", reply: `Git Manager could not finish work: ${error.message}`, artifacts: [], metadata: { code: "FINISH_FAILED" } };
  }
};
