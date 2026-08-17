"use strict";

const { scanForSecrets, secretRemediation } = require("../safety");

module.exports.runRecipe = (input = {}) => {
  const result = scanForSecrets(input);
  const remediations = (result.findings || []).map((f) => secretRemediation(f));
  let reply = "";
  if (result.clean) {
    reply = `No API keys or sensitive credentials found in staged changes (scanner: ${result.scanner}).`;
  } else {
    reply = `WARNING: Found ${result.findings.length} secret credential(s) in staged changes! Commit blocked. Rotation checklist attached.`;
  }
  return {
    status: "ok",
    reply,
    ...result,
    remediations,
  };
};
