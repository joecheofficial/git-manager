"use strict";

// Provider-neutral program reservations wrap the lifecycle without changing its
// preservation, conflict, owner or tested-tip integration checks.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const checkin = require("./checkin");
const AGENT_DIR = path.resolve(__dirname, "..");
const expand = value => value.replace(/^~(?=$|\/)/, os.homedir());
const within = (value, root) => value === root || value.startsWith(root + path.sep);
const refuse = (reasons, extra = {}) => ({ ok: false, refused: true, reasons: Array.isArray(reasons) ? reasons : [reasons], ...extra });
function canonical(value) {
  const absolute = path.resolve(expand(value));
  try { return fs.realpathSync(absolute); } catch { return absolute; }
}
function loadSettings(opts = {}) {
  const env = opts.env || process.env;
  const config = { ...(require("../config/config.json").checkin || {}), ...(opts.config?.checkin || opts.config || {}), ...JSON.parse(env.GIT_MANAGER_CONFIG_JSON || "{}") };
  config.claimsFile = path.resolve(AGENT_DIR, expand(env.GIT_MANAGER_CLAIMS_FILE || opts.claimsFile || config.claimsFile || "data/claims.json"));
  return config;
}
function policyFor(repo, config = {}) {
  const settings = config.checkin || config;
  return (settings.programBoundaries || []).find(policy => canonical(policy.repo) === canonical(repo)) || null;
}
function normalizePaths(repo, paths) {
  const supplied = Array.isArray(paths) ? paths : String(paths || "").split(",");
  return [...new Set(supplied.filter(Boolean).map(value => path.relative(repo, path.resolve(repo, value)) || "."))];
}
function globRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}
function rootsFor(program) { return (program.roots || []).map(root => path.normalize(root).replace(/\/$/, "")); }
function laneFor(file, policy) {
  const matches = Object.entries(policy.programs || {}).filter(([, program]) => rootsFor(program).some(root => within(file, root)) || (program.files || []).includes(file) || (program.patterns || []).some(pattern => globRegex(pattern).test(file)));
  return matches.length > 1 ? null : matches[0]?.[0] || "shared";
}
// Walk an existing ancestor, including symlinks, even when a new leaf does not
// exist yet. Missing leaves do not make an escaping symlink safe.
function physicalPath(absolute) {
  const suffix = [];
  let ancestor = absolute;
  while (!fs.existsSync(ancestor)) {
    try { fs.lstatSync(ancestor); throw new Error(`broken symlink: ${ancestor}`); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(`unresolvable path: ${absolute}`);
    suffix.unshift(path.basename(ancestor)); ancestor = parent;
  }
  return path.join(fs.realpathSync(ancestor), ...suffix);
}
function classifyScope(repo, paths, config = {}) {
  const policy = policyFor(repo, config);
  const normalized = normalizePaths(repo, paths);
  if (!policy) return { ok: true, governed: false, program: null, paths: normalized, reasons: [] };
  const reasons = [], lanes = new Set();
  if (!normalized.length) reasons.push("program scope requires concrete declared paths");
  const realRepo = canonical(repo);
  for (const file of normalized) {
    if (file === "." || file === ".." || /[?*\0]/.test(file) || file.startsWith(`..${path.sep}`) || file.startsWith(`.git${path.sep}`) || file === ".git") {
      reasons.push(`invalid program scope path: ${file}`); continue;
    }
    const lane = laneFor(file, policy);
    if (lane === null) reasons.push(`ambiguous program policy for path: ${file}`);
    else lanes.add(lane);
    for (const [program, entry] of Object.entries(policy.programs || {})) {
      const exclusive = [...rootsFor(entry), ...(entry.files || []), ...(entry.patterns || []).map(pattern => pattern.split(/[?*]/)[0])];
      if (program !== lane && exclusive.some(root => root && within(root, file))) reasons.push(`scope ${file} encompasses exclusive ${program} paths; declare concrete paths`);
    }
    try {
      const actual = physicalPath(path.resolve(repo, file));
      if (!within(actual, realRepo)) reasons.push(`symlink escape outside repository: ${file}`);
      else {
        const physical = path.relative(realRepo, actual), realLane = laneFor(physical, policy);
        if (physical !== file || realLane !== lane) reasons.push(`symlink alias escapes its declared path scope: ${file} -> ${physical}`);
      }
    } catch (error) { reasons.push(`unsafe symlink/path scope: ${file}: ${error.message}`); }
  }
  if (lanes.size > 1) reasons.push(`mixed program lanes are not allowed in one claim: ${[...lanes].join(", ")}`);
  return { ok: !reasons.length, ...(reasons.length ? { refused: true } : {}), governed: true, program: lanes.size === 1 ? [...lanes][0] : null, paths: normalized, reasons };
}
function git(repo, args) {
  return execFileSync("git", ["--no-optional-locks", "-C", repo, ...args], { encoding: "utf8", timeout: 20000, stdio: "pipe", maxBuffer: 16 * 1024 * 1024 }).trim();
}
function validateClaim(claim, opts = {}) {
  const config = loadSettings(opts), scope = classifyScope(claim.repo, claim.paths, config);
  if (!scope.ok || !scope.governed) return { ...scope, claim };
  if (opts.program && opts.program !== scope.program) return refuse(`explicit program ${opts.program} does not match declared ${scope.program} scope`, { claim });
  if (opts.allowOverlap) return refuse("--allow-overlap cannot bypass governed program boundaries", { claim });
  if (fs.existsSync(claim.worktree)) {
    // Keep policy identity tied to the primary repository but inspect physical
    // path resolution inside the actual authoring checkout as well.
    const policy = policyFor(claim.repo, config);
    const worktreeScope = classifyScope(claim.worktree, claim.paths, { ...config, programBoundaries: [{ ...policy, repo: claim.worktree }] });
    if (!worktreeScope.ok) return { ...worktreeScope, claim };
  }
  if (opts.checkDiff) {
    if (!fs.existsSync(claim.worktree)) return refuse("claimed worktree is missing; work retained", { claim });
    let changed;
    try { changed = git(claim.repo, ["diff", "--no-renames", "--name-only", "-z", `${claim.targetBranch}...${claim.branch}`]).split("\0").filter(Boolean); }
    catch (error) { return refuse(`cannot verify claimed branch diff: ${error.message}`, { claim }); }
    const outside = changed.filter(file => !scope.paths.some(root => within(file, root)));
    if (outside.length) return refuse(`finished changes escape declared claim scope: ${outside.join(", ")}; work retained`, { claim, changedPaths: changed });
    if (changed.length) {
      const changedScope = classifyScope(claim.worktree, changed, { ...config, programBoundaries: [{ ...policyFor(claim.repo, config), repo: claim.worktree }] });
      if (!changedScope.ok || changedScope.program !== scope.program) return refuse([...changedScope.reasons, `finished diff must remain in ${scope.program} program lane; work retained`], { claim, changedPaths: changed });
    }
  }
  return { ...scope, claim };
}
function overlaps(requested, held) {
  return requested.some(left => held.some(right => within(left, right) || within(right, left)));
}
function withBoundaryLock(config, action, opts) {
  try { return checkin.withClaimsLock(`${config.claimsFile}.program-boundaries`, action, opts); }
  catch (error) { return refuse(`program boundary reservation failed: ${error.message}`); }
}
function guardedStart(repoPath, opts = {}) {
  let info, config;
  try { info = checkin.resolveRepo(repoPath); config = loadSettings(opts); } catch (error) { return refuse(error.message); }
  if (!policyFor(info.primary, config)) return checkin.start(repoPath, opts);
  return withBoundaryLock(config, () => {
    if (opts.allowOverlap) return refuse("--allow-overlap cannot bypass governed program boundaries");
    const scope = classifyScope(info.primary, opts.paths, config);
    if (!scope.ok) return scope;
    if (opts.program && opts.program !== scope.program) return refuse(`explicit program ${opts.program} does not match declared ${scope.program} scope`);
    const claims = checkin.loadClaims(config.claimsFile).claims.filter(claim => canonical(claim.repo) === info.primary && ["active", "expired"].includes(claim.status));
    const env = opts.env || process.env;
    const own = claims.find(claim => claim.task === opts.task && claim.actor === checkin.actor(env) && claim.session === checkin.sessionLabel(opts, env));
    if (own) {
      const valid = validateClaim(own, opts);
      if (!valid.ok) return valid;
      if (scope.program !== valid.program || !scope.paths.every(file => valid.paths.some(root => within(file, root)))) return refuse("reused claim cannot expand or change its declared program scope", { claim: own });
    }
    for (const other of claims.filter(claim => claim !== own && claim.status === "active")) {
      if (!Array.isArray(other.paths) || !other.paths.length) return refuse(`legacy unscoped claim ${other.id} reserves the whole repository; coordinate with its owner`);
      if (overlaps(scope.paths, normalizePaths(info.primary, other.paths))) return refuse(`program path overlap with active claim ${other.id}`);
    }
    return checkin.start(repoPath, { ...opts, paths: scope.paths });
  }, opts);
}
function finishSnapshot(claim) {
  return Object.fromEntries(["id", "repo", "worktree", "branch", "targetBranch", "paths"].map(key => [key, claim[key]]));
}
function verifyFinish(selector, opts = {}, expected = null) {
  const config = loadSettings(opts);
  const claim = checkin.resolveClaim(selector, { ...opts, config });
  if (claim.refused) return claim;
  if (expected && JSON.stringify(finishSnapshot(claim)) !== JSON.stringify(expected)) return refuse("claim scope changed while finish checks ran; work retained");
  return validateClaim(claim, { ...opts, config, checkDiff: true });
}
function guardedFinish(selector, opts = {}) {
  let config, claim;
  try { config = loadSettings(opts); claim = checkin.resolveClaim(selector, { ...opts, config }); } catch (error) { return refuse(error.message); }
  if (claim.refused) return claim;
  if (!policyFor(claim.repo, config)) return checkin.finish(selector, opts);
  return withBoundaryLock(config, () => {
    const validation = verifyFinish(selector, { ...opts, config });
    if (!validation.ok) return validation;
    const payload = Buffer.from(JSON.stringify({ config, selector: claim.id, expected: finishSnapshot(claim) })).toString("base64");
    const quote = value => `'${String(value).replace(/'/g, "'\\''")}'`;
    const verifyCommand = `${quote(process.execPath)} ${quote(__filename)} verify-finish ${quote(payload)}`;
    // checkin captures testedTip before executing this command and compares it
    // under its integration lock. A test that moves HEAD cannot evade the gate.
    const testCommand = opts.testCommand ? `( ${opts.testCommand} ) && ${verifyCommand}` : verifyCommand;
    return checkin.finish(selector, { ...opts, testCommand });
  }, opts);
}

module.exports = { guardedStart, guardedFinish, classifyScope, validateClaim, verifyFinish, loadSettings, policyFor, normalizePaths };
if (require.main === module) {
  if (process.argv[2] !== "verify-finish" || !process.argv[3]) { process.stderr.write("internal usage: verify-finish <payload>\n"); process.exitCode = 2; }
  else {
    try {
      const payload = JSON.parse(Buffer.from(process.argv[3], "base64").toString("utf8"));
      const result = verifyFinish(payload.selector, { config: payload.config, env: {} }, payload.expected);
      if (!result.ok) { process.stderr.write(result.reasons.join("\n") + "\n"); process.exitCode = 1; }
    } catch (error) { process.stderr.write(error.message + "\n"); process.exitCode = 1; }
  }
}
