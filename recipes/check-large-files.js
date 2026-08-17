"use strict";

const { checkLargeFiles } = require("../safety");

module.exports.runRecipe = (input = {}) => {
  const result = checkLargeFiles(input);
  let reply = "";
  if (result.ok && result.warnings.length === 0) {
    reply = "All staged files are within safe size limits for GitHub.";
  } else if (!result.ok) {
    reply = `BLOCKED: Found ${result.blockers.length} file(s) exceeding GitHub's 100 MB hard limit.`;
  } else {
    reply = `WARNING: Found ${result.warnings.length} file(s) over 50 MB (GitHub warns above 50 MB).`;
  }
  return {
    status: "ok",
    reply,
    ...result,
  };
};
