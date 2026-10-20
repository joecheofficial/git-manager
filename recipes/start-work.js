"use strict";
const checkin = require("../src/checkin");
module.exports.runRecipe = async function runRecipe(input = {}) {
  try {
    const result = checkin.start(input.repo, { task: input.task, owner: input.owner, paths: input.paths, session: input.session, asOwner: input.asOwner, dependencies: input.dependencies, fullCheckout: input.fullCheckout === true, dryRun: input.dryRun });
    const lines = [...(result.health?.warnings || []), ...(result.collisions?.warnings || [])].map(w => `warn: ${w}`);
    if (!result.ok) lines.push(...result.reasons.map(r => `REFUSED: ${r}`));
    else if (result.dryRun) lines.push(`dry run: ${result.plan.branch} from ${result.plan.base}`, `cd ${result.plan.worktree}`);
    else lines.push(`claim: ${result.claim.id}`, `branch: ${result.claim.branch}`, `cd ${result.worktree}`);
    return { status: result.ok ? "ok" : "refused", reply: lines.join("\n"), artifacts: [], metadata: result };
  } catch (error) {
    return { status: "error", reply: `Git Manager could not start work: ${error.message}`, artifacts: [], metadata: { code: "START_FAILED" } };
  }
};
