"use strict";

const { suggestGitignore, writeGitignore } = require("../safety");

module.exports.runRecipe = (input = {}) => {
  if (input.confirm === "WRITE") {
    return writeGitignore(input);
  }
  const suggestion = suggestGitignore(input);
  return {
    status: "needs_approval",
    reply: "Preview of suggested .gitignore safety rules. Resubmit with confirm='WRITE' to append these rules to .gitignore.",
    suggestion,
  };
};
