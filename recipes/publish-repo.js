"use strict";

const { publishRepo } = require("../github");

module.exports.runRecipe = (input = {}) => {
  if (input.confirm !== "PUBLISH") {
    return {
      status: "needs_approval",
      reply: `Preview only. Ready to publish repository "${input.name || ''}" (${input.visibility || 'unspecified'}) to GitHub. Resubmit with confirmation phrase "PUBLISH" to create the repository.`
    };
  }
  return publishRepo(input);
};
