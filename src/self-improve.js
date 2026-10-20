"use strict";
/**
 * Self-improving loop (product decision, 2026-09-26: "once it does things, it should learn
 * and upgrade itself too").
 *
 * Follows the All Sorted Self-Fixing Loop convention: bounded observe / grade / fix,
 * binary pass-fail checks, append-only learnings.
 *
 *   OBSERVE  what changed on disk since the last sweep
 *   GRADE    did last sweep's actions actually achieve their intent? (binary)
 *   UPGRADE  adopt new repos, escalate actions that keep failing, write learnings
 *
 * The rule this encodes, from INCIDENTS.md: "a restart is an action, not an
 * outcome." An action that has been taken repeatedly without the outcome ever
 * turning true is not retried a fourth time — it is escalated to a human.
 */
const fs = require("./volume-probe").guardFs(require("fs"));
const path = require("path");

const STATE = path.join(__dirname, "..", "data", "self-improve.json");
const LEARNING = path.join(__dirname, "..", "LEARNING.md");
const GENERATED_ROSTER = path.join(__dirname, "..", "config", "roster.generated.json");
const ESCALATE_AFTER = 3; // same action, same repo, still failing -> stop repeating

function load(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}
function save(p, v) { fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`); }

// ------------------------------------------------------------------ observe
function observe(census, prev) {
  const now = new Map(census.repos.map((r) => [r.path, r]));
  const before = new Map((prev?.repos || []).map((r) => [r.path, r]));
  return {
    appeared: [...now.keys()].filter((p) => !before.has(p)),
    vanished: [...before.keys()].filter((p) => !now.has(p)),
    nowCovered: [...now.values()].filter((r) => r.covered && before.get(r.path)?.covered === false).map((r) => r.path),
    lostCoverage: [...now.values()].filter((r) => !r.covered && before.get(r.path)?.covered === true).map((r) => r.path),
  };
}

// -------------------------------------------------------------------- grade
/**
 * Each finding id gets a binary "is it still true?" check. A finding that is
 * gone after we acted = the action worked. Still present = it did not.
 */
function grade(previousFindings, currentFindings) {
  const stillOpen = new Set(currentFindings.map((f) => `${f.repo}:${f.id}`));
  return (previousFindings || []).map((f) => {
    const key = `${f.repo}:${f.id}`;
    return { key, id: f.id, repo: f.repo, resolved: !stillOpen.has(key) };
  });
}

// ------------------------------------------------------------------ upgrade
function adoptNewRepos(census, rosterPaths) {
  const known = new Set(rosterPaths);
  const adopt = census.repos
    .filter((r) => r.kind === "first-party" && !known.has(r.path))
    .map((r) => ({ path: r.path, adoptedAt: new Date().toISOString(), adoptedBy: "self-improve", localOnly: !r.remote }));
  if (!adopt.length) return { added: [], total: (load(GENERATED_ROSTER, { repos: [] }).repos || []).length };
  const gen = load(GENERATED_ROSTER, { note: "Auto-adopted by src/self-improve.js. Hand-edit config.json instead; this file is regenerated.", repos: [] });
  const have = new Set(gen.repos.map((r) => r.path));
  for (const r of adopt) if (!have.has(r.path)) gen.repos.push(r);
  gen.updatedAt = new Date().toISOString();
  save(GENERATED_ROSTER, gen);
  return { added: adopt.map((r) => r.path), total: gen.repos.length };
}

function trackRepeats(state, graded) {
  const repeats = state.repeats || {};
  const escalate = [];
  for (const g of graded) {
    if (g.resolved) { delete repeats[g.key]; continue; }
    const n = (repeats[g.key]?.count || 0) + 1;
    repeats[g.key] = { count: n, id: g.id, repo: g.repo, lastSeen: new Date().toISOString() };
    if (n >= ESCALATE_AFTER) escalate.push({ ...repeats[g.key], key: g.key });
  }
  state.repeats = repeats;
  return escalate;
}

function appendLearning(lines, { learningPath = LEARNING, learningLimit = 256 * 1024 } = {}) {
  if (!lines.length) return false;
  const stamp = new Date().toISOString().slice(0, 10);
  // 2026-09-29: repeated escalations grew this log to 710 KB.
  if (fs.existsSync(learningPath) && fs.statSync(learningPath).size > learningLimit) {
    const archive = path.join(path.dirname(learningPath), "data", "learning-archive");
    fs.mkdirSync(archive, { recursive: true });
    let destination = path.join(archive, `LEARNING-${stamp}.md`);
    for (let n = 1; fs.existsSync(destination); n++) destination = path.join(archive, `LEARNING-${stamp}-${n}.md`);
    fs.renameSync(learningPath, destination);
    fs.writeFileSync(learningPath, "# Git Manager learnings\n\nOlder entries: data/learning-archive/\n");
  }
  fs.appendFileSync(learningPath, `\n## ${stamp} — self-improve\n${lines.map((l) => `- ${l}`).join("\n")}\n`);
  return true;
}

// -------------------------------------------------------------------- entry
function run({ census, findings, rosterPaths, awareness }, options = {}) {
  const state = load(STATE, { runs: 0, repeats: {} });
  const prevCensus = state.lastCensus || null;
  const delta = observe(census, prevCensus);
  const graded = grade(state.lastFindings, findings);
  const escalate = trackRepeats(state, graded);
  const adopted = adoptNewRepos(census, rosterPaths);

  const learnings = [];
  if (adopted.added.length)
    learnings.push(`Adopted ${adopted.added.length} previously-unknown repo(s) into the roster: ${adopted.added.slice(0, 5).join(", ")}${adopted.added.length > 5 ? " …" : ""}.`);
  if (delta.lostCoverage.length)
    learnings.push(`COVERAGE LOST on ${delta.lostCoverage.join(", ")} — a repo that had a remote or mirror no longer does.`);
  if (delta.nowCovered.length)
    learnings.push(`Coverage restored on ${delta.nowCovered.length} repo(s).`);
  if (delta.vanished.length)
    learnings.push(`${delta.vanished.length} repo(s) disappeared from disk: ${delta.vanished.slice(0, 5).join(", ")}.`);
  for (const e of escalate.filter((entry) => (entry.count - ESCALATE_AFTER) % 168 === 0))
    learnings.push(`ESCALATION: "${e.id}" on ${e.repo} has survived ${e.count} sweeps. The remediation is not working; stop repeating it and fix the cause.`);
  const resolved = graded.filter((g) => g.resolved).length;
  if (resolved) learnings.push(`${resolved} finding(s) from the previous sweep are now resolved.`);

  const wrote = appendLearning(learnings, options);

  state.runs = (state.runs || 0) + 1;
  state.lastRunAt = new Date().toISOString();
  state.lastCensus = { repos: census.repos.map((r) => ({ path: r.path, covered: r.covered, kind: r.kind })) };
  state.lastFindings = findings.map((f) => ({ id: f.id, repo: f.repo }));
  state.lastAwareness = awareness;
  save(STATE, state);

  return { delta, graded: { resolved, open: graded.length - resolved }, escalate, adopted, learningsWritten: wrote ? learnings.length : 0 };
}

module.exports = { run, appendLearning, observe, grade, adoptNewRepos, trackRepeats, ESCALATE_AFTER };
