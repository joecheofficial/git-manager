"use strict";
const checkin = require("../src/checkin");
// Read-only by construction: the recipe never applies the sweep.
module.exports.runRecipe = async function runRecipe() {
  try {
    const result = checkin.sweep({ readOnly: true });
    const c = result.claims;
    const lines = [`Claim sweep preview (nothing changed): ${c && !c.skipped ? `${c.active} active, ${c.expired} expired, ${c.closed} would close` : "claims not swept"}; ${result.repos.length} enforced repo(s) checked`];
    // Findings can quote repository-controlled text (commit subjects): keep it on one quoted, bounded line.
    const quote = text => JSON.stringify(String(text).replace(/\s+/g, " ").slice(0, 300));
    for (const f of result.findings) lines.push(`${f.level}: ${f.code}: ${quote(f.message)}`);
    return { status: "ok", reply: lines.join("\n"), artifacts: [], metadata: { readOnly: result.readOnly, claims: result.claims, repos: result.repos, findingCodes: result.findings.map(f => f.code) } };
  } catch (error) {
    return { status: "error", reply: `Git Manager could not preview the claim sweep: ${error.message}`, artifacts: [], metadata: { code: "SWEEP_FAILED" } };
  }
};
