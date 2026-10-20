"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const checkpoint = require("./checkpoint");
const backupStorage = require("./backup-storage");
const recoveryAdvisor = require("./recovery-advisor");
const sparseCheckout = require("./sparse-checkout");
const checkoutEstimate = require("./checkout-estimate");
const { volumeRootOf } = require("./volume-probe");
const AGENT_DIR = path.resolve(__dirname, "..");
const HOUR = 3600000;
const MiB = 1024 ** 2;
// New installs keep check-in worktrees here. Existing installs keep the
// worktreeRoot from their own config/config.json (the installer preserves it), and
// every claim stores its absolute worktree path, so a changed default never
// strands an existing worktree.
const DEFAULT_WORKTREE_ROOT = "~/.config/allsorted/worktrees";
const DEFAULT_FULL_CHECKOUT_CEILING_MIB = 256;
const expand = (p) => p.replace(/^~(?=$|\/)/, os.homedir());
const canonical = (p) => { const abs = path.resolve(expand(p)); try { return fs.realpathSync(abs); } catch { return abs; } };
const within = (p, root) => p === root || p.startsWith(root + path.sep);
const stamp = (opts) => Number(new Date(opts.now ?? Date.now()));
const refusal = (reason, extra = {}) => {
  const reasons = Array.isArray(reason) ? reason : [reason];
  return { ok: false, refused: true, reasons, ...extra, continuation: recoveryAdvisor.advise(reasons, extra) };
};
const errorText = (e) => String(e.stderr || e.message).trim().slice(0, 300);
function git(repo, args, timeout = 20000, maxBuffer = 16 * MiB) {
  return execFileSync("git", ["--no-optional-locks", "-C", repo, ...args], {
    encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"], maxBuffer,
  }).trim();
}
// Whole-tree listings scale with repository size; give them a larger buffer.
const gitTree = (repo, args) => git(repo, args, 600000, 512 * MiB);
function maybeGit(repo, args) { try { return git(repo, args); } catch { return null; } }
function settings(opts = {}) {
  const env = opts.env || process.env;
  const base = require("../config/config.json").checkin || {};
  const supplied = opts.config?.checkin || opts.config || {};
  const cfg = { ...base, ...supplied, ...JSON.parse(env.GIT_MANAGER_CONFIG_JSON || "{}") };
  cfg.claimsFile = path.resolve(AGENT_DIR, expand(env.GIT_MANAGER_CLAIMS_FILE || opts.claimsFile || cfg.claimsFile || "data/claims.json"));
  cfg.worktreeRoot = canonical(env.GIT_MANAGER_WORKTREE_ROOT || opts.worktreeRoot || cfg.worktreeRoot || DEFAULT_WORKTREE_ROOT);
  const ceiling = cfg.fullCheckoutCeilingMiB;
  cfg.fullCheckoutCeilingMiB = typeof ceiling === "number" && Number.isFinite(ceiling) && ceiling >= 0 ? ceiling : DEFAULT_FULL_CHECKOUT_CEILING_MIB;
  cfg.carryBackupDir = path.resolve(expand(env.GIT_MANAGER_CARRY_BACKUP_DIR || opts.carryBackupDir || cfg.carryBackupDir || "~/.config/git-manager/carry-backups"));
  return cfg;
}
function actor(env = process.env) { return env.ALLSORTED_ACTOR || os.userInfo().username; }
function sessionLabel(opts = {}, env = process.env) { return opts.session || env.ALLSORTED_SESSION_NAME || env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || env.CODEX_SESSION_ID || env.CODEX_THREAD_ID || env.CLAUDE_CODE_HOST_SESSION_ID || (env.TMUX_PANE && `tmux-${env.TMUX_PANE}`) || env.TERM_SESSION_ID || `anon-${process.ppid}-${Date.now().toString(36)}`; }
function defaultOwnerPrefix(env = process.env, who = actor(env)) {
  return env.ALLSORTED_BRANCH_PREFIX || (Object.keys(env).some(k => k.startsWith("CLAUDE_CODE_")) ? "claude" : null)
    || (env.CODEX_SESSION_ID || Object.keys(env).some(k => k.startsWith("CODEX_")) ? "codex" : null) || who;
}
function resolveRepo(inputPath = process.cwd()) {
  try {
    const input = fs.realpathSync(expand(inputPath));
    const toplevel = fs.realpathSync(git(input, ["rev-parse", "--show-toplevel"]));
    const gitDir = canonical(path.resolve(toplevel, git(toplevel, ["rev-parse", "--git-common-dir"])));
    const primary = path.basename(gitDir) === ".git" ? path.dirname(gitDir) : toplevel;
    return { input, toplevel, primary, gitDir, name: path.basename(primary) };
  } catch { throw new Error("not a git repository"); }
}
function ownerFor(paths, config = {}) {
  return (config.checkin || config).ownerSessions?.find(owner => owner.paths.some(root => paths.some(p => within(canonical(p), canonical(root))))) || null;
}
function loadClaims(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return { schemaVersion: 1, updatedAt: null, enforcedRepos: [], claims: [], released: [] }; throw e; }
  try {
    const store = JSON.parse(raw);
    if (store.schemaVersion !== 1 || !Array.isArray(store.claims) || !Array.isArray(store.released)) throw new Error("invalid schema");
    return store;
  } catch (e) { throw new Error(`corrupt claims store: ${file}: ${e.message}`); }
}
function withClaimsLock(file, fn, opts = {}) {
  const lock = `${file}.lock`;
  const writableError = () => new Error(`claims store not writable: ${file} (set GIT_MANAGER_CLAIMS_FILE)`);
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { throw writableError(); }
  const started = Date.now();
  let fd;
  while (fd === undefined) {
    try { fd = fs.openSync(lock, "wx"); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), host: os.hostname() })); }
    catch (e) {
      if (e.code !== "EEXIST") throw writableError();
      try {
        const stat = fs.statSync(lock);
        if (Date.now() - stat.mtimeMs > Math.min(opts.staleMs ?? 30000, 20 * 60000)) {
          let live = false;
          try {
            const { pid } = JSON.parse(fs.readFileSync(lock, "utf8"));
            if (Number.isInteger(pid) && pid > 0) {
              try { process.kill(pid, 0); live = true; } catch (err) { live = err.code !== "ESRCH"; }
            }
          } catch { /* legacy or abandoned lock */ }
          // A hard ceiling also recovers locks whose dead owner pid was reused.
          if ((!live || Date.now() - stat.mtimeMs > 20 * 60000) && fs.statSync(lock).ino === stat.ino) { fs.unlinkSync(lock); continue; }
        }
      } catch (err) { if (err.code === "ENOENT") continue; throw err; }
      if (Date.now() - started >= (opts.timeoutMs ?? 120000)) throw new Error(`claims lock timed out: ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, opts.retryMs ?? 50);
    }
  }
  const identity = fs.fstatSync(fd);
  try { return fn(); }
  finally {
    fs.closeSync(fd);
    try { const current = fs.statSync(lock); if (current.ino === identity.ino) fs.unlinkSync(lock); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
}
function commandClaimsLock(file, fn, opts = {}, pending = "") {
  try { return withClaimsLock(file, fn, opts); }
  catch (e) {
    if (!e.message.startsWith("claims lock timed out:")) throw e;
    let owner = {};
    try { owner = JSON.parse(fs.readFileSync(`${file}.lock`, "utf8")); } catch { /* lock may have just cleared */ }
    return refusal(`claims store busy (lock held by pid ${owner.pid ?? "unknown"} since ${owner.startedAt ?? "unknown"}); retry${pending}`);
  }
}
function writeClaims(store, cfg, now) {
  store.updatedAt = new Date(now).toISOString();
  store.enforcedRepos = [...new Set((cfg.enforcedRepos || []).filter(p => fs.existsSync(expand(p))).map(canonical))];
  store.released = store.released.slice(-200);
  const tmp = `${cfg.claimsFile}.tmp-${process.pid}`;
  try { fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n"); fs.renameSync(tmp, cfg.claimsFile); }
  catch (e) { throw new Error(`claims store not writable: ${cfg.claimsFile} (set GIT_MANAGER_CLAIMS_FILE): ${e.message}`); }
}
function defaultBranch(repo) {
  const remote = maybeGit(repo, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (remote) return remote.replace(/^refs\/remotes\/origin\//, "");
  for (const name of ["main", "master"]) if (maybeGit(repo, ["show-ref", "--verify", `refs/heads/${name}`])) return name;
  return git(repo, ["branch", "--show-current"]);
}
// Scope audits must not count files that arrived by merging the target branch into the claim branch:
// those commits are already on the target, so they are neither lost nor leaked. Audit from the merge
// base with the target; fall back to the claim's pinned base when the target cannot be resolved.
// The target resolves only as a local branch (a same-named tag cannot shadow it), and the audit base
// may only move forward from the pinned base: a reset or rewritten target falls back to baseSha.
function scopeAuditBase(repo, worktree, claim, targetBranch) {
  const target = targetBranch || maybeGit(repo, ["branch", "--show-current"]) || defaultBranch(repo);
  const tip = target ? maybeGit(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/heads/${target}^{commit}`]) : null;
  const base = tip ? maybeGit(worktree, ["merge-base", "--end-of-options", tip, "HEAD"]) : null;
  if (!base) return claim.baseSha;
  return maybeGit(worktree, ["merge-base", "--is-ancestor", claim.baseSha, base]) !== null ? base : claim.baseSha;
}
function dirtyPaths(repo) {
  const raw = execFileSync("git", ["--no-optional-locks", "-C", repo, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "utf8", timeout: 20000, maxBuffer: 16 * MiB, stdio: ["ignore", "pipe", "pipe"] });
  const records = raw.split("\0"), entries = [];
  for (let i = 0; i < records.length && records[i]; i++) {
    const status = records[i].slice(0, 2);
    entries.push({ status, file: records[i].slice(3) });
    if (/[RC]/.test(status) && records[i + 1]) entries.push({ status, file: records[++i] });
  }
  return entries;
}
function health(repoInfo, opts = {}) {
  const repo = repoInfo.primary, blockers = [], warnings = [], info = {};
  const operation = checkpoint.inProgressOperation(repo);
  if (operation) blockers.push(`mid-${operation}: finish or abort it first`);
  if (checkpoint.indexLocked(repo)) warnings.push("index.lock present (another git process may be running)");
  const dirty = dirtyPaths(repo);
  info.dirtyCount = dirty.length; info.untrackedCount = dirty.filter(e => e.status === "??").length;
  if (dirty.length) warnings.push(`primary checkout has ${dirty.length} uncommitted file(s); your worktree is isolated from them`);
  info.defaultBranch = defaultBranch(repo);
  info.currentBranch = git(repo, ["branch", "--show-current"]) || "DETACHED";
  if (info.currentBranch !== info.defaultBranch) warnings.push(`primary is on ${info.currentBranch}, not ${info.defaultBranch} (rule 1)`);
  if (opts.fetch) { try { git(repo, ["fetch", "--quiet", "origin", info.defaultBranch]); } catch (e) { warnings.push(`fetch failed: ${errorText(e)}`); } }
  info.base = info.defaultBranch;
  if (maybeGit(repo, ["show-ref", "--verify", `refs/remotes/origin/${info.defaultBranch}`])) {
    [info.ahead, info.behind] = git(repo, ["rev-list", "--left-right", "--count", `${info.defaultBranch}...origin/${info.defaultBranch}`]).split(/\s+/).map(Number);
    if (!info.ahead && info.behind) { info.base = `origin/${info.defaultBranch}`; warnings.push(`local ${info.defaultBranch} is ${info.behind} behind origin; worktree is based on ${info.base}`); }
    else if (info.ahead && info.behind) warnings.push(`local ${info.defaultBranch} and origin diverged (${info.ahead} ahead, ${info.behind} behind)`);
  }
  return { blockers, warnings, info };
}
// Unknown scope means the whole repository whenever either side is a takeover.
// --allow-overlap cannot waive the preservation condition of that policy.
function overlappingPaths(repo, requested, claim, takeover, allowOverlap = false) {
  const strict = Boolean(takeover || claim.ownershipTakeover);
  if (allowOverlap && !strict) return [];
  const wanted = requested.length || !strict ? requested : ["."];
  const held = claim.paths.length || !strict ? claim.paths : ["."];
  return wanted.filter(q => held.some(p => within(path.resolve(repo, p), path.resolve(repo, q)) || within(path.resolve(repo, q), path.resolve(repo, p))));
}
function collisions(repoInfo, store, opts = {}) {
  const repo = repoInfo.primary, blockers = [], warnings = [];
  const claims = store.claims.filter(c => c.repo === repo && c.status === "active");
  const own = claims.find(c => !c.session.startsWith("anon-") && c.task === opts.slug && c.actor === opts.actor && c.session === opts.session);
  const worktrees = git(repo, ["worktree", "list", "--porcelain", "-z"]).split("\0\0").filter(Boolean).map(record => {
    const row = {};
    for (const field of record.split("\0")) {
      const split = field.indexOf(" "); if (split > 0) row[field.slice(0, split)] = field.slice(split + 1);
    }
    row.claimed = claims.some(c => canonical(c.worktree) === canonical(row.worktree || repo));
    return row;
  }).filter(w => w.worktree && canonical(w.worktree) !== repo);
  if (maybeGit(repo, ["show-ref", "--verify", `refs/heads/${opts.branch}`]) && !own) blockers.push(`branch ${opts.branch} already exists`);
  if (opts.worktree && fs.existsSync(opts.worktree)) blockers.push(`worktree path exists: ${opts.worktree}`);
  for (const claim of claims.filter(c => c !== own)) {
    if (claim.task === opts.slug) blockers.push(`task already claimed by ${claim.actor}/${claim.session} at ${claim.worktree} since ${claim.createdAt}`);
    for (const requested of overlappingPaths(repo, opts.paths || [], claim, opts.ownershipTakeover, opts.allowOverlap)) {
      blockers.push(`path overlap with claim ${claim.id} (${claim.actor}/${claim.session}): ${requested}`);
    }
    warnings.push(`active claim: ${claim.actor}/${claim.session}/${claim.task} (${((stamp(opts) - Date.parse(claim.createdAt)) / HOUR).toFixed(1)}h)`);
  }
  const hours = opts.recentHours ?? 3, target = opts.targetBranch || defaultBranch(repo);
  const log = git(repo, ["log", target, `--since=${new Date(stamp(opts) - hours * HOUR).toISOString()}`, "--format=%H%x1f%an%x1f%cI%x1f%s", "-n", "20"]);
  const recentCommits = log ? log.split("\n").map(line => { const [sha, author, date, subject] = line.split("\x1f"); return { sha, author, date, subject }; }) : [];
  if (recentCommits.length) warnings.push(`${recentCommits.length} commit(s) landed on ${target} in the last ${hours}h; newest: ${recentCommits[0].sha.slice(0, 8)} ${recentCommits[0].subject}`);
  return { blockers, warnings, worktrees, recentCommits, claims };
}
function reactivationBlocker(store, claim) {
  return store.claims.find(c => c.id !== claim.id && c.repo === claim.repo && c.status === "active" && (c.task === claim.task || overlappingPaths(claim.repo, claim.paths, c, claim.ownershipTakeover).length > 0));
}
function start(repoPath, opts = {}) {
  let repo;
  try { repo = resolveRepo(repoPath); } catch (e) { return refusal(e.message); }
  const env = opts.env || process.env, who = actor(env), session = sessionLabel(opts, env);
  const owner = opts.owner || defaultOwnerPrefix(env, who), slug = opts.task;
  if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug)) return refusal("invalid task slug");
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(owner)) return refusal("invalid owner prefix");
  const cfg = settings(opts), now = stamp(opts);
  const requestedPaths = (Array.isArray(opts.paths) ? opts.paths : (opts.paths || "").split(",")).filter(Boolean);
  // Reject any parent-directory segment before normalizing: "src/.." would
  // otherwise collapse to "." and claim whole-repository checkout intent.
  if (requestedPaths.some(p => typeof p !== "string" || p.split(/[\\/]/).includes(".."))) return refusal("declared paths must be inside the repository");
  const paths = requestedPaths.map(p => path.relative(repo.primary, path.resolve(repo.primary, p)) || ".");
  if (paths.some(p => p === ".." || p.startsWith(`..${path.sep}`) || path.isAbsolute(p))) return refusal("declared paths must be inside the repository");
  const dependencies = Array.isArray(opts.dependencies) ? opts.dependencies : (typeof opts.dependencies === "string" ? opts.dependencies.split(",").filter(Boolean) : undefined);
  const fullCheckoutRequested = opts.fullCheckout === true || requestedPaths.some(p => p === "." || (path.isAbsolute(p) && path.resolve(p) === repo.primary));
  const owning = ownerFor([repo.input, repo.primary, ...paths.map(p => path.resolve(repo.primary, p))], cfg);
  const ownedPath = owning && [repo.input, repo.primary, ...paths.map(p => path.resolve(repo.primary, p))].find(p => owning.paths.some(root => within(canonical(p), canonical(root))));
  const takingOwnership = owning && String(opts.asOwner || "").toLowerCase() !== owning.name.toLowerCase();
  if (takingOwnership && cfg.allowSafeOwnershipTakeover === false) return refusal(`${ownedPath || repo.input} is owned by the "${owning.name}" session. Hand this work to that session instead of doing it here. (If you ARE that session, re-run with --as-owner "${owning.name}".)`);
  const ownershipTakeover = takingOwnership ? { reservedOwner: owning.name, mode: "isolated-worktree", policy: "safe-ownership-takeover", at: new Date(now).toISOString() } : null;
  const branch = `${owner}/${slug}`, worktree = path.join(cfg.worktreeRoot, repo.name, slug);
  const store = loadClaims(cfg.claimsFile);
  const reuse = (store) => store.claims.find(c => !c.session.startsWith("anon-") && c.repo === repo.primary && c.task === slug && ["active", "expired"].includes(c.status) && c.actor === who && c.session === session);
  const reused = (claim) => claim.pending ? refusal(`worktree creation for this task is in progress (started ${claim.createdAt}); retry in a moment`) : ({ ok: true, reused: true, claim, worktree: claim.worktree, cd: claim.worktree });
  const own = reuse(store);
  if (own && (own.pending || fs.existsSync(own.worktree))) {
    if ((own.status === "active" && (!ownershipTakeover || own.ownershipTakeover)) || own.pending) return reused(own);
    return commandClaimsLock(cfg.claimsFile, () => {
      const store = loadClaims(cfg.claimsFile), claim = reuse(store);
      if (!claim || !fs.existsSync(claim.worktree)) return refusal("claim changed before reactivation; retry");
      if (claim.pending) return reused(claim);
      const other = reactivationBlocker(store, { ...claim, ownershipTakeover: claim.ownershipTakeover || ownershipTakeover });
      if (other) return refusal(`claim reactivation blocked: ${other.id} now holds the same task/paths`);
      if (!opts.dryRun) { if (ownershipTakeover && !claim.ownershipTakeover) { claim.ownershipTakeover = ownershipTakeover; claim.ownerSession = owning.name; } claim.status = "active"; claim.updatedAt = new Date(now).toISOString(); writeClaims(store, cfg, now); }
      return reused(claim);
    }, opts);
  }
  const status = health(repo, opts);
  if (ownershipTakeover) status.warnings.push(`${who}/${session} is taking responsibility for work reserved to "${owning.name}" in an isolated worktree; existing claims and conflict checks remain enforced`);
  const overlap = collisions(repo, store, { ...opts, ownershipTakeover, actor: who, session, slug, branch, paths, worktree, now, targetBranch: status.info.defaultBranch, recentHours: cfg.recentCommitHours });
  const reasons = [...status.blockers, ...overlap.blockers];
  if (reasons.length) return refusal(reasons, { health: status, collisions: overlap });
  // Resolve the base to one commit and plan the checkout from that commit's tree;
  // the worktree is created from this exact commit, never from a moving ref.
  const plan = () => {
    const baseSha = git(repo.primary, ["rev-parse", "--verify", `${status.info.base}^{commit}`]);
    const tree = gitTree(repo.primary, ["ls-tree", "-r", "-l", "-z", baseSha]);
    let sparse = sparseCheckout.resolve({ repo: repo.primary, claimPaths: paths, dependencies, tree, version: git(repo.primary, ["--version"]), worktreeConfig: maybeGit(repo.primary, ["config", "--local", "--bool", "--get", "extensions.worktreeConfig"]) === "true" });
    if (opts.fullCheckout === true && sparse.mode === "sparse") sparse = { mode: "full", reason: "explicit full checkout requested" };
    const estimatedBytes = sparse.mode === "sparse" ? checkoutEstimate.estimateRows(sparse.includedRows) : checkoutEstimate.estimate(tree);
    return { baseSha, sparse, estimatedBytes };
  };
  const fullCheckoutBlocker = (planned) => planned.sparse.mode === "full" && planned.estimatedBytes > cfg.fullCheckoutCeilingMiB * MiB && !fullCheckoutRequested
    ? `estimated full checkout is ${Math.ceil(planned.estimatedBytes / MiB)} MiB, above the ${cfg.fullCheckoutCeilingMiB} MiB implicit full-checkout ceiling${dependencies !== undefined ? ` (scoped checkout unavailable: ${planned.sparse.reason})` : ""}; declare concrete read roots with --dependencies or explicitly request --full-checkout (whole-repository --paths . is also explicit)`
    : null;
  const scopedFallback = (planned) => {
    if (dependencies !== undefined && planned.sparse.mode === "full" && opts.fullCheckout !== true) status.warnings.push(`scoped checkout unavailable, using a full checkout: ${planned.sparse.reason}`);
  };
  if (opts.dryRun) {
    let planned; try { planned = plan(); } catch (e) { return refusal(`checkout plan unavailable: ${errorText(e)}`, { health: status, collisions: overlap }); }
    const largeFull = fullCheckoutBlocker(planned); if (largeFull) return refusal(largeFull, { health: status, collisions: overlap });
    scopedFallback(planned);
    return { ok: true, dryRun: true, plan: { branch, worktree, base: status.info.base, baseSha: planned.baseSha, materialization: planned.sparse.mode, materializationReason: planned.sparse.reason, estimatedBytes: planned.estimatedBytes, dependencyRoots: planned.sparse.roots, includeDirs: planned.sparse.includeDirs, fullCheckoutRequested }, health: status, collisions: overlap };
  }
  const reserved = commandClaimsLock(cfg.claimsFile, () => {
    const store = loadClaims(cfg.claimsFile), own = reuse(store);
    if (own && (own.pending || fs.existsSync(own.worktree))) {
      if (!own.pending && (own.status === "expired" || (ownershipTakeover && !own.ownershipTakeover))) {
        const other = reactivationBlocker(store, { ...own, ownershipTakeover: own.ownershipTakeover || ownershipTakeover });
        if (other) return refusal(`claim reactivation blocked: ${other.id} now holds the same task/paths`);
        if (ownershipTakeover && !own.ownershipTakeover) { own.ownershipTakeover = ownershipTakeover; own.ownerSession = owning.name; }
        own.status = "active"; own.updatedAt = new Date(now).toISOString(); writeClaims(store, cfg, now);
      }
      return reused(own);
    }
    const reasons = [];
    for (const claim of store.claims.filter(c => c.repo === repo.primary && c.status === "active")) {
      if (claim.task === slug) reasons.push(`task already claimed by ${claim.actor}/${claim.session} at ${claim.worktree}`);
      for (const requested of overlappingPaths(repo.primary, paths, claim, ownershipTakeover, opts.allowOverlap)) {
        reasons.push(`path overlap with claim ${claim.id} (${claim.actor}/${claim.session}): ${requested}`);
      }
    }
    if (maybeGit(repo.primary, ["show-ref", "--verify", `refs/heads/${branch}`])) reasons.push(`branch ${branch} already exists`);
    if (fs.existsSync(worktree) || store.claims.some(c => c.status === "active" && canonical(c.worktree) === canonical(worktree))) reasons.push(`worktree path exists or is reserved: ${worktree}`);
    if (reasons.length) return refusal(reasons, { health: status, collisions: overlap });
    let planned; try { planned = plan(); } catch (e) { return refusal(`checkout plan unavailable: ${errorText(e)}`, { health: status, collisions: overlap }); }
    const largeFull = fullCheckoutBlocker(planned); if (largeFull) return refusal(largeFull, { health: status, collisions: overlap });
    scopedFallback(planned);
    const date = new Date(now).toISOString();
    const sparseRecord = planned.sparse.mode === "sparse" ? { mode: "cone", profile: planned.sparse.profile, roots: planned.sparse.roots, includeDirs: planned.sparse.includeDirs, manifestSha256: planned.sparse.manifestSha256, manifest: planned.sparse.manifest, materialized: false } : null;
    const claim = { ...(fullCheckoutRequested ? { fullCheckoutRequested: true } : {}), ...(sparseRecord ? { sparseCheckout: sparseRecord } : {}), id: `${repo.name}:${slug}:${now.toString(36)}`, repo: repo.primary, repoName: repo.name, task: slug, owner, branch, base: status.info.base, baseSha: planned.baseSha, targetBranch: status.info.defaultBranch, worktree, paths, actor: who, session, ownerSession: owning?.name || null, status: "active", pending: true, createdAt: date, updatedAt: date, lastActivityAt: date };
    if (ownershipTakeover) claim.ownershipTakeover = ownershipTakeover;
    store.claims.push(claim); writeClaims(store, cfg, now);
    return { ok: true, claim };
  }, opts);
  if (!reserved.ok || reserved.reused) return reserved;
  const sparse = reserved.claim.sparseCheckout;
  // Sparse settings must land in the new worktree's own config. Evidence that the
  // primary checkout itself became sparse holds the claim for inspection.
  const primarySparseState = () => JSON.stringify([
    maybeGit(repo.primary, ["config", "--local", "--bool", "--get", "core.sparseCheckout"]),
    gitTree(repo.primary, ["ls-files", "-v", "-z"]).split("\0").filter(row => row.startsWith("S ")).length,
  ]);
  let primaryBefore = null;
  try {
    if (sparse) {
      primaryBefore = primarySparseState();
      git(repo.primary, ["worktree", "add", "--no-checkout", "-b", branch, worktree, reserved.claim.baseSha], 600000);
      git(worktree, ["sparse-checkout", "init", "--cone", "--no-sparse-index"]);
      git(worktree, ["sparse-checkout", "set", "--cone", "--end-of-options", ...sparse.includeDirs], 600000);
      git(worktree, ["checkout", branch], 600000);
      if (git(worktree, ["config", "--worktree", "--bool", "--get", "core.sparseCheckout"]) !== "true" || git(worktree, ["config", "--worktree", "--bool", "--get", "core.sparseCheckoutCone"]) !== "true" || maybeGit(worktree, ["config", "--worktree", "--bool", "--get", "index.sparse"]) === "true") throw new Error("sparse checkout configuration did not remain cone-mode with a full index");
      if (JSON.stringify(git(worktree, ["sparse-checkout", "list"]).split("\n").filter(Boolean).sort()) !== JSON.stringify([...sparse.includeDirs].sort())) throw new Error("sparse checkout roots did not verify");
      for (const row of sparseCheckout.treeRows(gitTree(repo.primary, ["ls-tree", "-r", "-l", "-z", reserved.claim.baseSha])).filter(r => r.kind === "blob" && sparseCheckout.coneIncludes(r.path, sparse.includeDirs))) {
        try { fs.lstatSync(path.join(worktree, row.path)); } catch (error) { if (error.code === "ENOENT") throw new Error(`sparse checkout omitted ${row.path}`); throw error; }
      }
    } else git(repo.primary, ["worktree", "add", "-b", branch, worktree, reserved.claim.baseSha], 600000);
  } catch (e) {
    const partialSparse = Boolean(sparse && fs.existsSync(worktree));
    if (!partialSparse) commandClaimsLock(cfg.claimsFile, () => {
      const store = loadClaims(cfg.claimsFile);
      store.claims = store.claims.filter(c => c.id !== reserved.claim.id || !c.pending); writeClaims(store, cfg, now);
    }, opts);
    return refusal(`${errorText(e)}${partialSparse ? `; sparse worktree retained with pending claim at ${worktree}, inspect and recover before retrying` : ""}`, { health: status, collisions: overlap });
  }
  let primaryAfter; try { primaryAfter = sparse ? primarySparseState() : null; } catch (e) { primaryAfter = `unreadable: ${errorText(e)}`; }
  if (sparse && primaryAfter !== primaryBefore) return refusal(`the primary checkout's sparse state changed or could not be re-read during sparse worktree creation; pending claim retained for ${worktree}; inspect the primary (git -C ${JSON.stringify(repo.primary)} config --local --get core.sparseCheckout) before recovery`, { health: status, collisions: overlap });
  // A worktree made by a different account than the repo owner lives where the owner cannot see it
  // (one local account cannot enter another account home), so a `git worktree prune` run as the owner (the sidecar runner
  // does this) deletes its admin dir mid-task (2026-10-07, twice). Lock those; prune skips locked
  // worktrees. Same-account worktrees stay unlocked so manual `git worktree remove` keeps working.
  if (opts.lockWorktree ?? (fs.statSync(repo.primary).uid !== process.getuid?.())) {
    maybeGit(repo.primary, ["worktree", "lock", "--reason", `git-manager claim ${reserved.claim.id}`, worktree]);
  }
  const baseSha = git(worktree, ["rev-parse", "HEAD"]);
  return commandClaimsLock(cfg.claimsFile, () => {
    const store = loadClaims(cfg.claimsFile), claim = store.claims.find(c => c.id === reserved.claim.id && c.pending);
    if (!claim) return refusal(`claim changed during worktree creation; worktree retained at ${worktree}`);
    claim.worktree = fs.realpathSync(worktree); claim.baseSha = baseSha; if (claim.sparseCheckout) claim.sparseCheckout.materialized = true; delete claim.pending;
    writeClaims(store, cfg, now);
    return { ok: true, claim, worktree: claim.worktree, health: status, collisions: overlap, cd: claim.worktree };
  }, opts, `; worktree exists at ${worktree} on ${branch} and the claim is pending; the sweep finalizes it after 30 minutes`);
}
function selectClaim(store, selector, cwd) {
  const candidates = store.claims.filter(c => ["active", "expired"].includes(c.status));
  const found = candidates.filter(c => selector && selector !== "."
    ? [c.id, c.task, c.branch, c.worktree].includes(selector) || canonical(selector) === c.worktree
    : within(canonical(cwd || process.cwd()), canonical(c.worktree)));
  return found.length === 1 ? found[0] : refusal(`${found.length ? "ambiguous claim" : "no matching claim"}; candidates: ${(found.length ? found : candidates).map(c => `${c.id} (${c.worktree})`).join(", ") || "none"}`);
}
// Resolve the same selector as finish/release without inspecting repo health.
function resolveClaim(selector, opts = {}) {
  return selectClaim(loadClaims(settings(opts).claimsFile), selector, opts.cwd);
}
function archiveClaim(store, claim, reason, now, extra = {}) {
  Object.assign(claim, extra, { status: "released", releasedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), releaseReason: reason });
  store.claims = store.claims.filter(c => c !== claim); store.released.push(claim);
}
// 2026-10-04 (product decision): "the whole point of the get manager is to protect from losing work not to
// block me". Carry another session's uncommitted edits across the merge instead of holding.
function readBlob(repo, spec) {
  try { return execFileSync("git", ["--no-optional-locks", "-C", repo, "cat-file", "blob", spec], { timeout: 20000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 }); }
  catch { return null; }
}
function readFileOrNull(file) { try { return fs.readFileSync(file); } catch { return null; } }
function planCarry(repo, claim, target, mergedTree, entries, cfg) {
  const dir = path.join(cfg.carryBackupDir, claim.id.replace(/[^A-Za-z0-9._-]/g, "_"));
  const carry = [], problems = [], tmp = fs.mkdtempSync(path.join(os.tmpdir(), "git-manager-carry-"));
  try {
    for (const { status, file } of entries) {
      const abs = path.join(repo, file), entry = { file, blob: null, backup: null };
      let stat = null; try { stat = fs.lstatSync(abs); } catch { /* deleted in the primary */ }
      if (stat?.isFile()) {
        entry.current = fs.readFileSync(abs);
        entry.blob = execFileSync("git", ["--no-optional-locks", "-C", repo, "hash-object", "-w", "--stdin"], { input: entry.current, encoding: "utf8", timeout: 20000, stdio: ["pipe", "pipe", "pipe"] }).trim();
        entry.backup = path.join(dir, file);
        fs.mkdirSync(path.dirname(entry.backup), { recursive: true }); fs.writeFileSync(entry.backup, entry.current);
      }
      let why = status === "??" ? "untracked" : /D/.test(status) ? "deleted" : /[RC]/.test(status) ? "renamed" : status[0] !== " " ? "staged" : status !== " M" ? `status ${status.trim()}` : !stat?.isFile() ? "not a regular file" : null;
      if (!why) { try { fs.accessSync(abs, fs.constants.R_OK | fs.constants.W_OK); } catch { why = "not writable"; } }
      if (!why) {
        entry.base = readBlob(repo, `${target}:${file}`); entry.other = readBlob(repo, `${mergedTree}:${file}`);
        if (!entry.base) why = "not in the target commit";
        else if (!entry.other) why = "deleted by this branch";
        else if ([entry.current, entry.base, entry.other].some(b => b.subarray(0, 8000).includes(0))) why = "binary";
      }
      if (!why) {
        const files = ["current", "base", "other"].map(k => { const f = path.join(tmp, `${carry.length}-${k}`); fs.writeFileSync(f, entry[k]); return f; });
        try { entry.result = execFileSync("git", ["merge-file", "-p", ...files], { timeout: 20000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 }); }
        catch (e) { why = e.status > 0 ? "their edits conflict with this branch's changes" : `merge-file failed: ${errorText(e)}`; }
      }
      if (why) problems.push(`${file} (${why}${entry.backup ? `; backup ${entry.backup}, blob ${entry.blob}` : ""})`);
      carry.push(entry);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  return { dir, carry, problems };
}
// Scope audit for a sparse claim before finish or release. Returns a hold reason or null.
function sparseScopeBlocker(repo, claim) {
  if (!claim.sparseCheckout) return null;
  const worktree = claim.worktree;
  if (claim.sparseCheckout.materialized !== true) return "sparse worktree setup is incomplete; retain claim and inspect";
  if (typeof claim.baseSha !== "string" || !/^[0-9a-f]{40,64}$/.test(claim.baseSha)) return "sparse claim base commit is not a commit id; retain worktree and inspect";
  try {
    const config = maybeGit(worktree, ["config", "--worktree", "--bool", "--get", "core.sparseCheckout"]);
    const cone = maybeGit(worktree, ["config", "--worktree", "--bool", "--get", "core.sparseCheckoutCone"]);
    const sparseIndex = maybeGit(worktree, ["config", "--worktree", "--bool", "--get", "index.sparse"]);
    const listed = maybeGit(worktree, ["sparse-checkout", "list"]);
    if (config !== "true" || cone !== "true" || sparseIndex === "true" || JSON.stringify((listed || "").split("\n").filter(Boolean).sort()) !== JSON.stringify([...claim.sparseCheckout.includeDirs].sort())) return "sparse checkout roots or worktree configuration changed; retain worktree and inspect";
    if (maybeGit(repo, ["config", "--local", "--bool", "--get", "extensions.worktreeConfig"]) !== "true") return "shared worktree configuration is no longer enabled; retain sparse worktree and inspect";
    if (!sparseCheckout.verifyManifest(gitTree(repo, ["ls-tree", "-r", "-l", "-z", "--end-of-options", claim.baseSha]), claim.sparseCheckout)) return "sparse checkout manifest does not match its pinned base tree; retain worktree and inspect";
    const changed = gitTree(worktree, ["diff", "--no-renames", "--name-only", "-z", "--end-of-options", scopeAuditBase(repo, worktree, claim, claim.targetBranch), "HEAD"]).split("\0").filter(Boolean);
    changed.push(...dirtyPaths(worktree).map(entry => entry.file));
    const ignored = gitTree(worktree, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
    return sparseCheckout.guard(worktree, claim, changed, ignored);
  } catch (error) { return `sparse worktree scope audit failed closed: ${errorText(error)}`; }
}
// Scope or sparse metadata that changed after the checks ran (for example an
// amend-scope from another shell during the test command) invalidates them.
function scopeChanged(current, checked) {
  return JSON.stringify(current.paths) !== JSON.stringify(checked.paths)
    || JSON.stringify(current.sparseCheckout ?? null) !== JSON.stringify(checked.sparseCheckout ?? null);
}
function finish(selector, opts = {}) {
  const cfg = settings(opts), now = stamp(opts);
  const selected = selectClaim(loadClaims(cfg.claimsFile), selector, opts.cwd);
  if (selected.refused) return selected;
  if (selected.pending) return refusal("claim worktree creation is pending", { claim: selected });
  const repo = selected.repo, worktree = selected.worktree, branch = selected.branch, target = selected.targetBranch;
  const hold = (reason, extra = {}) => refusal(reason, { claim: selected, worktreePresent: fs.existsSync(worktree), ...extra });
  const holdDirty = () => {
    let saved;
    try { saved = checkpoint.snapshotRepo(worktree, { message: `git-manager finish held ${selected.id}: preserve working files` }); }
    catch (error) { saved = { status: "skipped", reason: errorText(error) }; }
    return hold("worktree has uncommitted changes: review and commit intended files before integration", { checkpoint: saved });
  };
  let testedTip;
  const precheck = () => {
    const claim = selected;
    if (!fs.existsSync(worktree)) return hold(`worktree missing; inspect claim ${claim.id} before any release`);
    const sparseBlocked = sparseScopeBlocker(repo, claim); if (sparseBlocked) return hold(sparseBlocked);
    if (dirtyPaths(worktree).length) return holdDirty();
    if (git(worktree, ["branch", "--show-current"]) !== branch) return hold(`worktree is no longer on claimed branch ${branch}`);
    if (/^wip[(:!\s]/i.test(git(repo, ["log", "-1", "--format=%s", branch]))) return hold("tests are known failing: the tip commit is marked wip (rule 7)");
    testedTip = git(worktree, ["rev-parse", "HEAD"]);
    if (opts.testCommand) {
      try { execFileSync("/bin/sh", ["-c", opts.testCommand], { cwd: worktree, timeout: 900000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
      catch (e) { return hold(`test command failed:\n${[e.stdout, e.stderr, e.message].filter(Boolean).join("\n").trim().split("\n").slice(-20).join("\n")}`); }
    }
    return null;
  };
  const blocked = precheck(); if (blocked) return blocked;
  const result = commandClaimsLock(cfg.claimsFile, () => {
    const store = loadClaims(cfg.claimsFile), claim = store.claims.find(c => c.id === selected.id && ["active", "expired"].includes(c.status));
    if (!claim || claim.pending || ["repo", "worktree", "branch", "targetBranch"].some(k => claim[k] !== selected[k]) || scopeChanged(claim, selected)) return hold("claim changed while tests ran");
    if (!fs.existsSync(worktree)) return hold(`worktree missing; inspect claim ${claim.id} before any release`);
    const sparseBlocked = sparseScopeBlocker(repo, claim); if (sparseBlocked) return hold(sparseBlocked);
    if (dirtyPaths(worktree).length) return hold("worktree gained uncommitted changes while tests ran; preserve them and retry");
    if (git(worktree, ["branch", "--show-current"]) !== branch) return hold(`worktree is no longer on claimed branch ${branch}`);
    const head = git(worktree, ["rev-parse", "HEAD"]), tip = git(repo, ["rev-parse", branch]);
    if (head !== testedTip || tip !== testedTip) return hold(`worktree HEAD moved since the checks ran (tested ${testedTip.slice(0, 8)}, now ${(head !== testedTip ? head : tip).slice(0, 8)}); finish again`);
    if (/^wip[(:!\s]/i.test(git(repo, ["log", "-1", "--format=%s", branch]))) return hold("tests are known failing: the tip commit is marked wip (rule 7)");
    const current = git(repo, ["branch", "--show-current"]) || "DETACHED";
    if (current !== target) return hold(`primary is on ${current}; switch it back to ${target} first (rule 1)`);
    const operation = checkpoint.inProgressOperation(repo);
    if (operation) return hold(`mid-${operation}: finish or abort it first`);
    if (checkpoint.indexLocked(repo)) return hold("index.lock present (another git process may be running)");
    if (dirtyPaths(worktree).length) return hold("worktree gained uncommitted changes while tests ran; preserve them and retry");
    const mergedTip = testedTip;
    const commits = Number(git(repo, ["rev-list", "--count", `${target}..${branch}`]));
    let mergeCommit = null, carry = [], carryDir = null;
    const carryWarnings = [];
    if (commits) {
      if (maybeGit(repo, ["diff", "--cached", "--quiet"]) === null) return hold("the primary checkout has staged changes from another session; preserve and integrate that work before this merge");
      const files = git(repo, ["diff", "--name-only", "-z", `${target}...${branch}`]).split("\0").filter(Boolean);
      const overlap = dirtyPaths(repo).filter(e => files.some(f => within(e.file, f) || within(f, e.file)));
      if (overlap.length) {
        let mergedTree;
        try { mergedTree = git(repo, ["merge-tree", "--write-tree", "--name-only", target, mergedTip], 600000).split("\n")[0]; }
        catch (e) {
          const out = String(e.stdout || "").trim().split("\n"), end = out.indexOf("");
          if (e.status !== 1) return hold(`another session has uncommitted edits to the same files in the primary checkout and merge-tree failed: ${errorText(e)}`);
          return hold(`merge conflicts with ${target}: in the worktree run \`git merge ${target}\`, resolve by intent, commit, then finish again; ${out.slice(1, end > 0 ? end : undefined).join("\n")}`);
        }
        const planned = planCarry(repo, claim, target, mergedTree, overlap, cfg);
        if (planned.problems.length) return hold(`another session has uncommitted edits to the same files in the primary checkout that cannot be carried across this merge: ${planned.problems.slice(0, 10).join(", ")}; these are uncommitted edits in the primary checkout from another session (not claim ${claim.id}); nothing was changed and backups exist under ${planned.dir}; only a human can choose between two edits`, { carryBackupDir: planned.dir });
        carry = planned.carry; carryDir = planned.dir;
      }
      // Every file touched before the merge commit goes back to the other session's bytes on any failure.
      const restoreCarry = () => carry.map(c => {
        const abs = path.join(repo, c.file), now = readFileOrNull(abs);
        if (now && now.equals(c.current)) return null;
        if (now && now.equals(c.base)) { try { fs.writeFileSync(abs, c.current); return null; } catch (err) { return `${c.file} could not be restored (${errorText(err)}); the other session's version is at ${c.backup} (blob ${c.blob})`; } }
        return `${c.file} changed during the merge attempt and was left as is; the other session's version is at ${c.backup} (blob ${c.blob})`;
      }).filter(Boolean).map(n => `; ${n}`).join("");
      const backupNote = () => carry.length ? `; backups of the other session's edits under ${carryDir}` : "";
      try {
        for (const c of carry) fs.writeFileSync(path.join(repo, c.file), c.base);
        try { git(repo, ["merge", "--no-ff", "--no-edit", "-m", `Merge branch '${branch}' (git-manager finish ${claim.id})`, mergedTip], 600000); }
        catch (e) {
          if (!fs.existsSync(path.join(resolveRepo(repo).gitDir, "MERGE_HEAD"))) return hold(`merge refused by git: ${errorText(e)}${restoreCarry()}${backupNote()}`);
          const conflicted = maybeGit(repo, ["diff", "--name-only", "--diff-filter=U"]) || "";
          let abortError = "";
          if (fs.existsSync(path.join(resolveRepo(repo).gitDir, "MERGE_HEAD"))) { try { git(repo, ["merge", "--abort"], 600000); } catch (err) { abortError = `; merge abort failed: ${errorText(err)}`; } }
          if (!conflicted) return hold(`merge stopped before committing with no content conflicts (a hook such as pre-merge-commit or commit-msg failed); merge aborted; fix the hook failure and finish again: ${errorText(e)}${abortError}${restoreCarry()}${backupNote()}`);
          return hold(`merge conflicts with ${target}: in the worktree run \`git merge ${target}\`, resolve by intent, commit, then finish again; ${conflicted}${abortError}${restoreCarry()}${backupNote()}`);
        }
      } catch (e) { return hold(`carrying the other session's uncommitted edits across the merge failed before the merge commit: ${errorText(e)}${restoreCarry()}${backupNote()}`, { carryBackupDir: carryDir }); }
      mergeCommit = git(repo, ["rev-parse", target]);
      if (carry.length) {
        try { opts.beforeCarryReapply?.(carry.map(c => c.file)); } catch { /* test hook */ }
        for (const c of carry) {
          const abs = path.join(repo, c.file), now = readFileOrNull(abs);
          if (now && now.equals(c.other)) {
            try { fs.writeFileSync(abs, c.result); c.applied = true; }
            catch (err) { c.skipped = `re-apply failed: ${errorText(err)}`; carryWarnings.push(`${c.file}: could not re-apply the other session's edits (${errorText(err)}); their version is at ${c.backup} (blob ${c.blob})`); }
          } else { c.skipped = "changed by another writer"; carryWarnings.push(`${c.file} changed between the merge and re-applying the other session's edits; left the newer content in place; their version is at ${c.backup} (blob ${c.blob})`); }
        }
      }
    }
    if (git(repo, ["rev-parse", branch]) !== mergedTip) return hold("branch changed during merge; worktree and claim retained");
    if (maybeGit(repo, ["merge-base", "--is-ancestor", mergedTip, target]) === null) return hold("branch is not contained in target after merge; worktree and claim retained");
    if (git(worktree, ["branch", "--show-current"]) !== branch || git(worktree, ["rev-parse", "HEAD"]) !== mergedTip || git(repo, ["rev-parse", branch]) !== mergedTip) return hold("worktree HEAD no longer matches the branch tip merged; worktree and claim retained");
    maybeGit(repo, ["worktree", "unlock", worktree]);
    try { git(repo, ["worktree", "remove", worktree], 600000); } catch (e) { maybeGit(repo, ["worktree", "lock", "--reason", `git-manager claim ${selected.id}`, worktree]); return hold(`worktree removal failed; claim kept active: ${errorText(e)}`, { claim, mergeCommit }); }
    const fresh = loadClaims(cfg.claimsFile), finishing = fresh.claims.find(c => c.id === selected.id);
    if (!finishing) return hold("claim changed during merge; worktree removed, inspect claims before retrying");
    archiveClaim(fresh, finishing, "finished", now, { mergeCommit }); writeClaims(fresh, cfg, now);
    return { ok: true, claim: finishing, merged: commits > 0, mergeCommit, commits, removedWorktree: true, deletedBranch: false, pushed: null, carriedFiles: carry.filter(c => c.applied).map(({ file, blob, backup }) => ({ file, blob, backup })), carrySkipped: carry.filter(c => !c.applied).map(({ file, blob, backup, skipped }) => ({ file, blob, backup, reason: skipped })), carryBackupDir: carryDir, warnings: carryWarnings };
  }, opts);
  if (!result.ok) return result;
  if (!opts.keepBranch) { try { git(repo, ["branch", "-d", branch], 600000); result.deletedBranch = true; } catch (e) { result.warnings.push(`branch retained: ${errorText(e)}`); } }
  if (opts.push && maybeGit(repo, ["show-ref", "--verify", `refs/remotes/origin/${target}`])) {
    try { git(repo, ["push", "origin", target], 600000); result.pushed = true; } catch (e) { result.pushed = false; result.warnings.push(`push failed: ${errorText(e)}`); }
  }
  return result;
}
// Nested repositories and submodules hold work an archive commit only records as a gitlink.
function nestedRepos(worktree, unreadable = []) {
  const found = git(worktree, ["ls-files", "-s", "-z"]).split("\0").filter(l => l.startsWith("160000 ")).map(l => l.split("\t")[1]);
  // Walk untracked and ignored directories all the way down: a .git dir or file at any depth is a nested repo.
  const walk = (rel, depth) => {
    if (depth > 64) return;
    let entries; try { entries = fs.readdirSync(path.join(worktree, rel), { withFileTypes: true }); } catch (e) { if (e.code !== "ENOENT") unreadable.push(rel); return; }
    for (const e of entries) {
      if (e.name === ".git") { found.push(rel || "."); continue; }
      if (e.isDirectory() && !e.isSymbolicLink()) walk(path.join(rel, e.name), depth + 1);
    }
  };
  const dirs = [...dirtyPaths(worktree).map(e => e.file).filter(f => f.endsWith("/")),
    ...(maybeGit(worktree, ["ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory"]) || "").split("\0").filter(d => d.endsWith("/"))];
  for (const dir of dirs) walk(dir.replace(/\/$/, ""), 0);
  return [...new Set(found)];
}
// Directories release cannot list: plain `git worktree remove` would delete around them and then fail half-way.
function unreadablePaths(worktree) {
  const bad = [], stack = [""];
  while (stack.length) {
    const rel = stack.pop(); let entries;
    try { entries = fs.readdirSync(path.join(worktree, rel), { withFileTypes: true }); } catch (e) { if (e.code !== "ENOENT") bad.push(rel || "."); continue; }
    for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink() && !(rel === "" && e.name === ".git")) stack.push(path.join(rel, e.name));
  }
  return bad;
}
// Every dirty path still on disk must be in the snapshot tree with identical content.
function unarchivedPaths(worktree, sha) {
  const tree = new Map(git(worktree, ["ls-tree", "-r", "-z", sha]).split("\0").filter(Boolean).map(l => { const tab = l.indexOf("\t"); return [l.slice(tab + 1), l.slice(0, tab).split(" ")[2]]; }));
  const missing = [];
  for (const { file } of dirtyPaths(worktree)) {
    const abs = path.join(worktree, file); let stat;
    try { stat = fs.lstatSync(abs); } catch { continue; } // deleted: nothing on disk to lose
    if (!tree.has(file)) { missing.push(file); continue; }
    if (stat.isFile()) {
      try { if (git(worktree, ["hash-object", "--", file]) !== tree.get(file)) missing.push(`${file} (content differs)`); }
      catch { missing.push(`${file} (unreadable)`); }
    }
  }
  return missing;
}
// Preserve the linked worktree index separately from its working-file snapshot.
function releaseIndexState(worktree, branch) {
  const indexPath = git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  const indexStat = fs.lstatSync(indexPath);
  if (!indexStat.isFile()) throw new Error("worktree index must be a regular file");
  const bytes = fs.readFileSync(indexPath), head = git(worktree, ["rev-parse", "HEAD"]);
  const tip = git(worktree, ["rev-parse", `refs/heads/${branch}`]);
  const unchanged = (location = worktree) => {
    const current = fs.lstatSync(indexPath);
    if (current.dev !== indexStat.dev || current.ino !== indexStat.ino || current.mtimeMs !== indexStat.mtimeMs || current.ctimeMs !== indexStat.ctimeMs || !fs.readFileSync(indexPath).equals(bytes)
      || git(location, ["rev-parse", "HEAD"]) !== head || git(location, ["rev-parse", `refs/heads/${branch}`]) !== tip) {
      throw new Error("worktree index or history changed during release; work retained");
    }
  };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "git-manager-release-index-"));
  let tree;
  try {
    const copy = path.join(scratch, "index"); fs.writeFileSync(copy, bytes, { mode: 0o600 });
    tree = execFileSync("git", ["--no-optional-locks", "-C", worktree, "write-tree"], {
      encoding: "utf8", timeout: 20000, env: { ...process.env, GIT_INDEX_FILE: copy }, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  unchanged();
  return { head, tree, unchanged };
}
function release(selector, opts = {}) {
  const cfg = settings(opts), now = stamp(opts);
  const selected = selectClaim(loadClaims(cfg.claimsFile), selector, opts.cwd);
  if (selected.refused) return selected;
  // 2026-10-04 (product decision): release archives unique commits and uncommitted work under refs/archive instead of refusing.
  const check = (claim) => {
    if (claim.pending) return refusal("claim worktree creation is pending");
    const exists = fs.existsSync(claim.worktree);
    if (exists && claim.sparseCheckout) { const blocked = sparseScopeBlocker(claim.repo, claim); if (blocked) return refusal(blocked, { claim }); }
    if (exists && git(claim.worktree, ["branch", "--show-current"]) !== claim.branch) return refusal(`worktree is no longer on claimed branch ${claim.branch}`);
    const dirty = exists && dirtyPaths(claim.worktree).length > 0;
    const branchExists = maybeGit(claim.repo, ["show-ref", "--verify", `refs/heads/${claim.branch}`]) !== null;
    const branchTip = branchExists ? git(claim.repo, ["rev-parse", `refs/heads/${claim.branch}`]) : null;
    const headTip = exists ? git(claim.worktree, ["rev-parse", "HEAD"]) : null;
    const unique = (sha) => Number(git(claim.repo, ["rev-list", "--count", sha, "--not", `--exclude=${claim.branch}`, "--branches"])) > 0;
    const tips = [];
    if (branchTip && unique(branchTip)) tips.push({ kind: "branch", sha: branchTip });
    if (headTip && headTip !== branchTip && unique(headTip)) tips.push({ kind: "worktree", sha: headTip });
    return { exists, branchExists, dirty, tips };
  };
  const blocked = check(selected); if (blocked.refused) return blocked;
  return commandClaimsLock(cfg.claimsFile, () => {
    const store = loadClaims(cfg.claimsFile), claim = store.claims.find(c => c.id === selected.id && ["active", "expired"].includes(c.status));
    if (!claim) return refusal("claim changed while release checks ran");
    if (scopeChanged(claim, selected)) return refusal("claim scope or sparse metadata changed while release checks ran; retain worktree and inspect");
    const checked = check(claim); if (checked.refused) return checked;
    const { exists, branchExists, dirty, tips } = checked;
    const archiveBase = `refs/archive/git-manager/${claim.id.replace(/[^A-Za-z0-9._-]/g, "-")}`, archives = [];
    const anchor = (ref, sha, kind) => {
      git(claim.repo, ["update-ref", ref, sha]);
      if (maybeGit(claim.repo, ["rev-parse", "--verify", `${ref}^{commit}`]) !== sha) throw new Error(`archive ref ${ref} did not verify`);
      archives.push({ kind, ref, sha, restore: `git branch ${kind === "branch" ? claim.branch : `${claim.branch}-${kind}`} ${ref}` });
    };
    // Nested repos and uncommitted files are never deleted: the worktree is moved aside intact (product decision 2026-10-04: protect work, do not block).
    const unreadable = [];
    const nested = exists ? nestedRepos(claim.worktree, unreadable) : [];
    if (exists) for (const p of unreadablePaths(claim.worktree)) if (!unreadable.includes(p)) unreadable.push(p);
    const warnings = [];
    if (unreadable.length) warnings.push(`unreadable path(s), worktree moved aside intact instead of removed: ${unreadable.slice(0, 10).join(", ")}`);
    let indexState = null;
    try {
      if (exists) {
        indexState = releaseIndexState(claim.worktree, claim.branch);
        if (indexState.tree !== git(claim.worktree, ["rev-parse", "HEAD^{tree}"])) {
          const sha = git(claim.worktree, ["commit-tree", indexState.tree, "-p", indexState.head, "-m", `git-manager release ${claim.id}: preserve staged work`]);
          anchor(`${archiveBase}-staged`, sha, "staged");
        }
      }
      if (dirty) {
        // Best effort: the worktree itself is moved aside intact below, so an incomplete snapshot loses nothing.
        let saved;
        try { saved = checkpoint.snapshotRepo(claim.worktree, { message: `git-manager release ${claim.id}: preserve uncommitted work` }); }
        catch (e) { saved = { status: "failed", reason: errorText(e) }; }
        if (["created", "unchanged"].includes(saved.status) && saved.sha) {
          anchor(`${archiveBase}-wip`, saved.sha, "wip");
          const missing = unarchivedPaths(claim.worktree, saved.sha);
          if (missing.length) warnings.push(`snapshot did not capture: ${missing.slice(0, 10).join(", ")} (kept in the moved-aside worktree)`);
        } else warnings.push(`snapshot ${saved.status}${saved.reason ? `: ${saved.reason}` : ""} (uncommitted work kept in the moved-aside worktree)`);
      }
      for (const tip of tips) anchor(tip.kind === "branch" ? archiveBase : `${archiveBase}-worktree`, tip.sha, tip.kind);
    } catch (e) { return refusal(`archiving before release failed; nothing removed: ${errorText(e)}`, { archives }); }
    let movedAside = null;
    try {
      if (exists && (dirty || nested.length || unreadable.length)) {
        const admin = git(claim.worktree, ["rev-parse", "--absolute-git-dir"]);
        // Recovery may become unreadable to another account. Keep prune away
        // from its exact index both during relocation and afterward.
        if (!fs.existsSync(path.join(admin, "locked"))) {
          git(claim.repo, ["worktree", "lock", "--reason", `git-manager recovery ${claim.id}`, claim.worktree]);
        }
        const storage = backupStorage.selectRoot(claim.worktree, cfg.carryBackupDir);
        if (!storage.external) warnings.push(`backup preserved locally: ${storage.reason}; recovery directory: ${storage.root}`);
        const aside = path.join(storage.root, claim.id.replace(/[^A-Za-z0-9._-]/g, "-"), "released-worktree");
        if (fs.existsSync(aside)) return refusal(`release target already exists: ${aside}; nothing removed`, { archives });
        fs.mkdirSync(path.dirname(aside), { recursive: true });
        indexState.unchanged();
        backupStorage.moveVerified(claim.worktree, aside, storage.rows);
        movedAside = aside;
        // Repair the registration instead of pruning its index and metadata.
        git(claim.repo, ["worktree", "repair", aside], 600000);
        indexState.unchanged(aside);
      } else if (exists) {
        indexState.unchanged(); maybeGit(claim.repo, ["worktree", "unlock", claim.worktree]);
        git(claim.repo, ["worktree", "remove", claim.worktree], 600000);
      }
    } catch (e) {
      if (movedAside && !fs.existsSync(claim.worktree)) { try { fs.renameSync(movedAside, claim.worktree); movedAside = null; maybeGit(claim.repo, ["worktree", "repair", claim.worktree]); } catch { /* left aside, reported below */ } }
      return refusal(`worktree removal failed; claim retained${movedAside ? `; worktree preserved at ${movedAside}` : ""}: ${errorText(e)}`, { archives });
    }
    let deletedBranch = false;
    const branchArchived = archives.some(a => a.kind === "branch");
    if (branchExists) { try { git(claim.repo, ["branch", branchArchived ? "-D" : "-d", claim.branch]); deletedBranch = true; } catch (e) { warnings.push(`branch retained: ${errorText(e)}`); } }
    const fresh = loadClaims(cfg.claimsFile), releasing = fresh.claims.find(c => c.id === selected.id);
    if (!releasing) return refusal("claim changed during release; inspect claims before retrying", { archives });
    archiveClaim(fresh, releasing, "abandoned", now, { ...(archives.length ? { archives } : {}), ...(movedAside ? { movedAside } : {}) }); writeClaims(fresh, cfg, now);
    return { ok: true, claim: releasing, removedWorktree: exists, movedAside, nested, deletedBranch, archives, warnings };
  }, opts);
}
function claimActivity(claim, opts = {}) {
  let latest = Date.parse(claim.createdAt);
  const sha = maybeGit(claim.repo, ["rev-parse", "--verify", `refs/heads/${claim.branch}`]);
  if (sha && sha !== claim.baseSha) latest = Math.max(latest, Number(git(claim.repo, ["show", "-s", "--format=%ct", sha])) * 1000);
  if (fs.existsSync(claim.worktree)) for (const entry of dirtyPaths(claim.worktree)) {
    try { latest = Math.max(latest, fs.statSync(path.join(claim.worktree, entry.file)).mtimeMs); } catch { /* deleted path */ }
  }
  const cfg = settings(opts);
  return { lastActivityAt: new Date(latest).toISOString(), ageHours: (stamp(opts) - latest) / HOUR, stale: stamp(opts) - latest > (cfg.staleClaimHours ?? 8) * HOUR };
}
function listClaims(opts = {}) {
  const cfg = settings(opts), store = loadClaims(cfg.claimsFile);
  return [...store.claims, ...(opts.all ? store.released : [])].filter(c => opts.all || ["active", "expired"].includes(c.status)).map(c => {
    try {
      if (!fs.statSync(c.worktree).isDirectory()) throw new Error("worktree unavailable");
      return { ...c, ...claimActivity(c, opts), activityStatus: "observed" };
    } catch (error) {
      return { ...c, activityStatus: "unknown", lastActivityAt: null, ageHours: null, stale: null,
        activityError: { code: error.code || `GIT_${error.status || "UNKNOWN"}`, message: "Cannot inspect this claim's worktree; inspect as its owner. The reservation remains held." } };
    }
  });
}
function sweepClaims(opts = {}) {
  const cfg = settings(opts), now = stamp(opts), report = opts.report || (() => {});
  const run = () => {
    const store = loadClaims(cfg.claimsFile); let closed = 0, expired = 0, active = 0;
    for (const claim of [...store.claims].filter(c => ["active", "expired"].includes(c.status))) {
      // Permission errors and offline mounts are unknown, never evidence of release.
      let worktreeExists;
      try {
        git(claim.repo, ["rev-parse", "--git-common-dir"]);
        try {
          if (!fs.statSync(claim.worktree).isDirectory()) throw new Error("claimed worktree is not a directory");
          worktreeExists = true;
        }
        catch (error) {
          if (error.code !== "ENOENT") throw error;
          const volume = volumeRootOf(claim.worktree);
          if (volume && (!fs.statSync(volume).isDirectory() || fs.statSync(volume).dev === fs.statSync(path.dirname(volume)).dev)) throw new Error("external worktree volume unavailable");
          // Walk readable ancestors to distinguish a confirmed absence from denied access.
          let parent = path.dirname(claim.worktree);
          while (true) { try { fs.statSync(parent); break; } catch (error) { if (error.code !== "ENOENT") throw error; const next = path.dirname(parent); if (next === parent) throw error; parent = next; } }
          worktreeExists = false;
        }
        if (worktreeExists) {
          fs.readdirSync(claim.worktree);
          // A readable unfinished directory is recoverable pending state, not a Git worktree yet.
          if (!claim.pending) dirtyPaths(claim.worktree);
        }
      } catch {
        report("claim-activity-unknown", "warn", claim.repo, `${claim.id}: worktree activity unavailable; reservation retained`, "inspect under the owning account/session");
        if (claim.status === "expired") expired++; else active++;
        continue;
      }
      if (claim.pending) {
        if (!(now - Date.parse(claim.createdAt) > 30 * 60000)) { active++; continue; }
        if (claim.sparseCheckout && claim.sparseCheckout.materialized !== true) { active++; report("claim-sparse-setup-held", "warn", claim.repo, `${claim.id}: sparse setup is incomplete; pending worktree and reservation retained`, `inspect the sparse worktree at ${claim.worktree} before recovery`); continue; }
        if (worktreeExists && maybeGit(claim.worktree, ["branch", "--show-current"]) === claim.branch) {
          if (!opts.readOnly) {
            claim.worktree = fs.realpathSync(claim.worktree); claim.baseSha = git(claim.worktree, ["rev-parse", "HEAD"]); delete claim.pending;
          }
          report("claim-pending-finalized", "info", claim.repo, `${claim.id}: ${opts.readOnly ? "would finalize" : "finalized"} pending worktree creation`);
          active++;
        } else {
          if (!opts.readOnly) archiveClaim(store, claim, "pending-abandoned", now);
          report("claim-pending-abandoned", "warn", claim.repo, `${claim.id}: worktree creation never finished`, `check for a partial worktree at ${claim.worktree} and branch ${claim.branch}; never delete it without checking for commits`);
          closed++;
        }
        continue;
      }
      if (!worktreeExists) {
        const exists = maybeGit(claim.repo, ["show-ref", "--verify", `refs/heads/${claim.branch}`]);
        const count = exists ? Number(git(claim.repo, ["rev-list", "--count", `${claim.targetBranch}..${claim.branch}`])) : 0;
        if (!count) {
          if (!opts.readOnly) archiveClaim(store, claim, claim.status === "expired" ? "expired-closed" : "merged-outside-finish", now);
          report("claim-closed-outside-finish", "info", claim.repo, `${claim.id}: closed outside finish`); closed++; continue;
        }
        report("claim-worktree-missing", "warn", claim.repo, `${claim.id}: worktree is gone but ${claim.branch} has ${count} unmerged commit(s)`, "merge it or run git-manager release after anchoring it");
      }
      let activity;
      try { activity = claimActivity(claim, { ...opts, config: cfg }); }
      catch { report("claim-activity-unknown", "warn", claim.repo, `${claim.id}: activity changed during scan; reservation retained`); if (claim.status === "expired") expired++; else active++; continue; }
      if (claim.status === "expired") {
        if (Date.parse(activity.lastActivityAt) > Date.parse(claim.updatedAt)) {
          const other = reactivationBlocker(store, claim);
          if (other) {
            report("claim-reactivation-blocked", "warn", claim.repo, `${claim.id}: activity resumed but ${other.id} now holds the same task/paths`, "finish or release one of them");
            expired++; continue;
          }
          if (!opts.readOnly) { claim.status = "active"; claim.updatedAt = new Date(now).toISOString(); claim.lastActivityAt = activity.lastActivityAt; }
          report("claim-reactivated", "info", claim.repo, `${claim.id}: activity resumed after expiry`); active++;
        } else expired++;
        continue;
      }
      if (activity.stale) {
        if (!opts.readOnly) claim.status = "expired";
        expired++;
        report("claim-stale", "warn", claim.repo, `${claim.id} (${claim.actor}/${claim.session}) has had no activity for ${activity.ageHours.toFixed(1)}h; ${opts.readOnly ? "would expire" : "expired"}`, `finish it with git-manager finish ${claim.id}, or release it`);
      } else active++;
      if (!opts.readOnly) { claim.lastActivityAt = activity.lastActivityAt; claim.updatedAt = new Date(now).toISOString(); }
    }
    if (!opts.readOnly) writeClaims(store, cfg, now);
    return { active, expired, closed };
  };
  try { return opts.readOnly ? run() : withClaimsLock(cfg.claimsFile, run, { ...opts, timeoutMs: opts.timeoutMs ?? 10000 }); }
  catch (e) { if (e.message.startsWith("claims lock timed out:")) return { skipped: "claims lock busy" }; throw e; }
}
function unclaimedCommitFindings(opts = {}) {
  try {
    const cfg = settings(opts), store = opts.store || loadClaims(cfg.claimsFile), report = opts.report || (() => {});
    const hours = cfg.unclaimedWindowHours ?? 2, since = `--since=${new Date(stamp(opts) - hours * HOUR).toISOString()}`;
    const automation = (cfg.automationSubjects || []).map(p => new RegExp(p));
    for (const input of cfg.enforcedRepos || []) {
      try {
        const repo = resolveRepo(expand(input)).primary, target = defaultBranch(repo);
        const claims = [...store.claims, ...store.released].filter(c => c.repo === repo);
        const claimedBranches = new Set(claims.map(c => c.branch));
        const unclaimed = git(repo, ["log", target, "--first-parent", since, "--format=%H%x1f%P%x1f%s"]).split("\n").filter(Boolean).map(l => l.split("\x1f")).filter(([sha, parents, subject]) => {
          if (automation.some(re => re.test(subject)) || claims.some(c => c.mergeCommit === sha)) return false;
          // 2026-10-03: only direct non-merge commits are evidence of bypassing check-in.
          return parents.split(" ").filter(Boolean).length < 2;
        });
        const branches = git(repo, ["for-each-ref", "--format=%(refname:short)%1f%(committerdate:unix)", "refs/heads"]).split("\n").map(line => line.split("\x1f")).filter(([b, date]) => b && Number(date) * 1000 >= stamp(opts) - hours * HOUR && b !== target && !claimedBranches.has(b) && !/^(snapshot|rescue)(\/|$)/.test(b)).map(([b]) => b);
        const branchShas = new Set(), branchNames = [];
        for (const branch of branches) {
          const commits = git(repo, ["log", branch, `^${target}`, since, "--format=%H%x1f%s"]).split("\n").filter(Boolean).map(l => l.split("\x1f")).filter(([, subject]) => !automation.some(re => re.test(subject)));
          if (commits.length) { branchNames.push(branch); for (const [sha] of commits) branchShas.add(sha); }
        }
        if (unclaimed.length || branchShas.size) report("commits-without-claim", "info", repo, !unclaimed.length ? `${branchShas.size} commit(s) on unclaimed branches in the last ${hours}h: ${branchNames.join(", ")}` : `${unclaimed.length} commit(s) landed directly on ${target} in the last ${hours}h without a git-manager claim${unclaimed.length ? ` (newest: ${unclaimed[0][0].slice(0, 8)} ${unclaimed[0][2]})` : ""}${branchShas.size ? `; plus ${branchShas.size} on unclaimed branches: ${branchNames.join(", ")}` : ""}`, "start work with git-manager start <repo> --task <slug>; it creates the worktree, branch and claim (POLICY.md rule 10)");
      } catch { /* inaccessible repositories do not fail the sweep */ }
    }
  } catch { /* invalid config/store is handled by the claims sweep */ }
}
// One user-started pass over the claims store and the configured enforced
// repositories: expire idle claims, resolve crashed pending claims, report
// commits made without a claim and stale working copies. Nothing is scheduled;
// run it whenever you want claims tidied (or with readOnly to preview).
function sweep(opts = {}) {
  const cfg = settings(opts), now = stamp(opts), findings = [];
  const report = (code, level, repo, message, fix) => findings.push({ code, level, repo, message, ...(fix ? { fix } : {}) });
  let claims;
  try { claims = sweepClaims({ ...opts, config: cfg, now, report }); }
  catch (error) { claims = null; report("claims-sweep-failed", "warn", cfg.claimsFile, error.message, "check that the claims store is readable JSON"); }
  if (claims?.skipped) report("claims-sweep-skipped", "warn", cfg.claimsFile, `claims sweep skipped: ${claims.skipped}`, "retry in a moment");
  const repos = [];
  for (const input of cfg.enforcedRepos || []) {
    try { repos.push(resolveRepo(expand(input)).primary); }
    catch { report("enforced-repo-unavailable", "warn", input, `${input}: not a readable git repository; skipped`, "fix or remove it from checkin.enforcedRepos"); }
  }
  if (!(cfg.enforcedRepos || []).length) report("no-enforced-repos", "info", null, "checkin.enforcedRepos is empty: claims were swept, no repositories were checked for unclaimed commits");
  unclaimedCommitFindings({ ...opts, config: cfg, now, report });
  try { require("./stale-working-copy").staleWorkingCopyFindings({ repos, report, now }); }
  catch (error) { report("stale-working-copy-failed", "warn", null, error.message); }
  return { ok: true, readOnly: Boolean(opts.readOnly), claims, repos, findings };
}
module.exports = { sweep, resolveClaim, actor, sessionLabel, defaultOwnerPrefix, resolveRepo, ownerFor, loadClaims, withClaimsLock, health, collisions, start, finish, release, listClaims, claimActivity, sweepClaims, unclaimedCommitFindings, scopeAuditBase };
