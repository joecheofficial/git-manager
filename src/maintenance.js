"use strict";
/**
 * Pack maintenance.
 *
 * Loose objects are stored uncompressed and undeltified, so a busy repo
 * accumulates hundreds of megabytes of them that `git gc` reclaims for free.
 * Measured across the estate on 2026-07-27: 2.5GB loose, and mission-control
 * alone went 1.5G -> 1.0G with no history change and a clean fsck.
 *
 * This is deliberately the boring, reversible kind of maintenance: packing and
 * pruning unreachable objects older than git's default grace period. It never
 * rewrites history, never touches refs, and never force-pushes — those need a
 * human decision, not an hourly job.
 *
 * Paced on purpose: gc is minutes of CPU, so at most `maxPerSweep` repos are
 * done per run and each repo waits `minDaysBetween` before its next pass.
 */

const { execFileSync } = require("node:child_process");
const fs = require("./volume-probe").guardFs(require("node:fs"));
const path = require("node:path");

const DEFAULTS = { looseMB: 200, minDaysBetween: 7, maxPerSweep: 2 };
const DAY_MS = 86400000;

function looseObjectMB(repo) {
  try {
    const out = execFileSync("git", ["-C", repo, "count-objects", "-v"], { encoding: "utf8", timeout: 30000 });
    const kb = Number((out.match(/^size: (\d+)/m) || [])[1] || 0);
    return kb / 1024;
  } catch { return 0; }
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

/**
 * Decide which repos are due. Pure, so the pacing rules are testable without
 * running gc: over threshold, not done recently, capped per sweep, worst first.
 */
function selectForMaintenance(candidates, state, { now = Date.now(), ...overrides } = {}) {
  // Spreading raw overrides would let an omitted key clobber its default with
  // undefined — which silently removes the per-sweep cap.
  const opts = { ...DEFAULTS };
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined) opts[k] = v;
  return candidates
    .filter((c) => c.looseMB >= opts.looseMB)
    .filter((c) => {
      const last = state[c.repo] ? Date.parse(state[c.repo]) : 0;
      return !last || (now - last) / DAY_MS >= opts.minDaysBetween;
    })
    .sort((a, b) => b.looseMB - a.looseMB)
    .slice(0, opts.maxPerSweep);
}

/** Pack the due repos. Returns one result per repo actually processed. */
function runMaintenance(repos, { stateFile, now = Date.now(), config = {}, exec = execFileSync } = {}) {
  if (config.enabled === false) return [];
  const state = readState(stateFile);
  const candidates = repos
    .filter((r) => fs.existsSync(path.join(r.path, ".git")))
    .map((r) => ({ ...r, looseMB: looseObjectMB(r.path) }));

  const due = selectForMaintenance(candidates, state, { now, ...config });
  const results = [];
  for (const c of due) {
    const before = c.looseMB;
    let ok = true;
    try { exec("git", ["-C", c.path, "gc", "--quiet"], { encoding: "utf8", timeout: 900000 }); }
    catch { ok = false; }
    state[c.repo] = new Date(now).toISOString();
    results.push({ repo: c.repo, ok, looseMBBefore: Math.round(before), looseMBAfter: Math.round(looseObjectMB(c.path)) });
  }
  if (results.length) {
    try { fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); } catch { /* non-fatal */ }
  }
  return results;
}

module.exports = { runMaintenance, selectForMaintenance, looseObjectMB, DEFAULTS };
