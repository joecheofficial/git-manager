"use strict";

const { preCommitCheck } = require("../safety");

module.exports.runRecipe = (input = {}) => {
  const result = preCommitCheck(input);
  let reply = "";
  if (result.safe && result.warnings.length === 0) {
    reply = "Safety check passed! No secret credentials or oversized files detected.";
  } else if (!result.safe) {
    reply = `BLOCKED: Pre-commit safety check found ${result.blockers.length} critical issue(s). Resolving required before commit.`;
  } else {
    reply = `WARNING: Pre-commit safety check passed with ${result.warnings.length} warning(s).`;
  }
  if (result.scannerNotice) reply += ` Note: ${result.scannerNotice}`;
  return {
    status: "ok",
    reply,
    ...result,
  };
};
