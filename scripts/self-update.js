#!/usr/bin/env node
"use strict";

// All Sorted repo self-update.
//
// One file, Node builtins only, copied verbatim into every public All Sorted
// repo as scripts/self-update.js. It keeps a git clone on the default branch of
// its origin, once a week, without ever touching the files that belong to the
// person who installed it.
//
// What it does when it runs inside a clone:
//   1. Reads <repo>/.allsorted-update.json ({ auto, lastCheck, lastResult }).
//      The file is created with auto: true on first run. ALLSORTED_AUTO_UPDATE=0
//      in the environment, or auto: false, turns the whole thing off.
//   2. Once every 7 days (always with --now) it runs `git fetch origin` with a
//      20 second timeout and compares HEAD with origin/<default branch>.
//   3. If the clone is behind it prints the commits that would come in, refuses
//      when tracked files have local changes (and says how to keep them), backs
//      up the protected files into .allsorted-backup/<timestamp>/, fast-forwards,
//      runs `npm install` only when package.json changed and dependencies exist,
//      runs the repo's self-test, and rolls back to the previous commit with the
//      backup restored when that self-test fails.
//   4. It prints one plain "what's new" block and records it in the state file.
//
// It never touches .env*, config.json, data/, runs/, personal/, brand/, state/,
// library/ or *.local.* files: those are untracked in these repos, git never
// rewrites them, and they are backed up before anything else happens anyway.
//
// Commands:
//   node scripts/self-update.js            weekly check, apply when due
//   node scripts/self-update.js --now      check and apply right now
//   node scripts/self-update.js --check    only say whether an update exists (no changes)
//   node scripts/self-update.js --status   show the setting, last check and last result
//   node scripts/self-update.js --off      turn weekly updates off
//   node scripts/self-update.js --on       turn them back on
//   node scripts/self-update.js --register    install the weekly job (launchd, cron or Task Scheduler)
//   node scripts/self-update.js --unregister  remove that job
//
// Anything that goes wrong prints one line and returns: this is safe to call at
// the start of any other command.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const STATE_FILE = ".allsorted-update.json";
const BACKUP_DIR = ".allsorted-backup";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// A scheduled job that fires a few minutes early must still count as due.
const DUE_AFTER_MS = WEEK_MS - 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20000;
const GIT_TIMEOUT_MS = 15000;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const SELFTEST_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BACKUP_FILE_BYTES = 64 * 1024 * 1024;
const KEEP_BACKUPS = 5;
const PROTECTED_GLOBS = [".env*", "config.json", "data/**", "runs/**", "personal/**", "brand/**", "state/**", "library/**", "*.local.*"];
const SKIP_DIRS = new Set([".git", "node_modules", BACKUP_DIR]);

function nowIso() { return new Date().toISOString(); }

function timestamp(date = new Date()) {
  const pad = value => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function git(repo, args, options = {}) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8", timeout: options.timeout || GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes" },
  });
  const stdout = options.raw ? (result.stdout || "") : (result.stdout || "").trim();
  // One line is enough for a message; git's multi-line advice stays out of it.
  const stderr = (result.stderr || "").trim().split("\n")[0] || "";
  if (result.error && result.error.code === "ETIMEDOUT") return { ok: false, timedOut: true, stdout, stderr: `git ${args[0]} timed out` };
  if (result.error) return { ok: false, stdout, stderr: result.error.message };
  return { ok: result.status === 0, status: result.status, stdout, stderr };
}

function gitOrThrow(repo, args, options) {
  const result = git(repo, args, options);
  if (!result.ok) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  return result.stdout;
}

// The package this script ships with: scripts/self-update.js lives one level
// below the package directory. The git repository root may be higher up (a repo
// that keeps the package in a subfolder), so both are resolved separately.
function packageDir() { return path.resolve(__dirname, ".."); }

function repoRoot(start = packageDir()) {
  const result = git(start, ["rev-parse", "--show-toplevel"]);
  if (result.ok && result.stdout) return fs.realpathSync(result.stdout);
  let current = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// Only a dedicated clone is updated: the package sits at the repo root or one
// folder below it. A package vendored deep inside someone's own repository is
// theirs to update, and fast-forwarding that repository is not this script's job.
function dedicatedClone(repo, pkg = packageDir()) {
  const relative = path.relative(repo, pkg);
  if (!relative) return true;
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  return relative.split(path.sep).length === 1;
}

function statePath(repo) { return path.join(repo, STATE_FILE); }

function readState(repo) {
  const file = statePath(repo);
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${STATE_FILE} is a symbolic link`);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  let value = {};
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); } catch { value = {}; }
  if (!value || typeof value !== "object" || Array.isArray(value)) value = {};
  return {
    auto: typeof value.auto === "boolean" ? value.auto : true,
    lastCheck: typeof value.lastCheck === "string" ? value.lastCheck : null,
    lastResult: typeof value.lastResult === "string" ? value.lastResult : null,
    lastUpdate: typeof value.lastUpdate === "string" ? value.lastUpdate : null,
    whatsNew: typeof value.whatsNew === "string" ? value.whatsNew : null,
  };
}

function writeState(repo, state) {
  const file = statePath(repo);
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${STATE_FILE} is a symbolic link`);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
  excludeLocally(repo);
  return state;
}

// Keep the state file and backups out of `git status` without touching the
// repo's tracked .gitignore: .git/info/exclude is local to this clone.
function excludeLocally(repo) {
  try {
    const exclude = git(repo, ["rev-parse", "--git-path", "info/exclude"]);
    if (!exclude.ok) return;
    const file = path.resolve(repo, exclude.stdout);
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const lines = current.split(/\r?\n/);
    const wanted = [`/${STATE_FILE}`, `/${STATE_FILE}.*.tmp`, `/${BACKUP_DIR}/`].filter(line => !lines.includes(line));
    if (!wanted.length) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}${wanted.join("\n")}\n`);
  } catch { /* A clone without a writable .git still updates; it only shows the state file in git status. */ }
}

function optedOut(state) {
  if (process.env.ALLSORTED_AUTO_UPDATE === "0") return "ALLSORTED_AUTO_UPDATE=0 is set in the environment";
  if (state.auto === false) return `auto is false in ${STATE_FILE} (turn it on with: node scripts/self-update.js --on)`;
  return null;
}

function due(state) {
  if (!state.lastCheck) return true;
  const last = Date.parse(state.lastCheck);
  if (!Number.isFinite(last)) return true;
  return Date.now() - last >= DUE_AFTER_MS;
}

function defaultBranch(repo) {
  const symbolic = git(repo, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
  if (symbolic.ok && symbolic.stdout.startsWith("refs/remotes/origin/")) return symbolic.stdout.slice("refs/remotes/origin/".length);
  for (const candidate of ["main", "master"]) {
    if (git(repo, ["rev-parse", "-q", "--verify", `refs/remotes/origin/${candidate}`]).ok) return candidate;
  }
  return "main";
}

function matchesProtected(relative) {
  const posix = relative.split(path.sep).join("/");
  const segments = posix.split("/");
  const base = segments[segments.length - 1];
  // Shipped templates (.env.example, config.example.json) belong to the project.
  if (/(^|\.)example(\.|$)/.test(base)) return false;
  for (const glob of PROTECTED_GLOBS) {
    if (glob.endsWith("/**")) {
      const dir = glob.slice(0, -3);
      if (segments.slice(0, -1).includes(dir)) return true;
      continue;
    }
    const pattern = new RegExp(`^${glob.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    if (pattern.test(base)) return true;
  }
  return false;
}

function walk(repo, directory, visit) {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(repo, file, visit);
    else if (entry.isFile()) visit(file, path.relative(repo, file));
  }
}

// Protected files are the member's: matching paths that git does not track,
// plus everything else untracked. Tracked files belong to the project and are
// exactly what the update is allowed to change.
function protectedFiles(repo) {
  const files = new Map();
  const listed = git(repo, ["ls-files", "-z"], { raw: true });
  const tracked = new Set(listed.ok ? listed.stdout.split("\0").filter(Boolean) : []);
  walk(repo, repo, (file, relative) => {
    const posix = relative.split(path.sep).join("/");
    if (matchesProtected(relative) && !tracked.has(posix)) files.set(relative, file);
  });
  const untracked = git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (untracked.ok) {
    for (const relative of untracked.stdout.split("\0").filter(Boolean)) {
      const file = path.join(repo, relative);
      const top = relative.split("/")[0];
      if (SKIP_DIRS.has(top) || relative === STATE_FILE || relative.startsWith(`${STATE_FILE}.`)) continue;
      try { if (fs.lstatSync(file).isFile()) files.set(relative, file); } catch { /* vanished */ }
    }
  }
  return files;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function backup(repo) {
  const files = protectedFiles(repo);
  const root = path.join(repo, BACKUP_DIR, timestamp());
  const manifest = { createdAt: nowIso(), files: {}, skipped: [] };
  fs.mkdirSync(root, { recursive: true });
  for (const [relative, file] of files) {
    const size = fs.statSync(file).size;
    if (size > MAX_BACKUP_FILE_BYTES) { manifest.skipped.push({ file: relative, reason: `larger than ${MAX_BACKUP_FILE_BYTES} bytes` }); continue; }
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file, destination);
    manifest.files[relative] = sha256(file);
  }
  fs.writeFileSync(path.join(root, "backup-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  pruneBackups(repo);
  return { root, manifest };
}

function pruneBackups(repo) {
  const base = path.join(repo, BACKUP_DIR);
  let names;
  try { names = fs.readdirSync(base).filter(name => /^\d{8}-\d{6}$/.test(name)).sort(); } catch { return; }
  for (const name of names.slice(0, Math.max(0, names.length - KEEP_BACKUPS))) {
    fs.rmSync(path.join(base, name), { recursive: true, force: true });
  }
}

function restoreBackup(repo, backupRoot) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(backupRoot, "backup-manifest.json"), "utf8")); } catch { return 0; }
  let restored = 0;
  for (const relative of Object.keys(manifest.files || {})) {
    const source = path.join(backupRoot, relative);
    const destination = path.join(repo, relative);
    try {
      if (fs.existsSync(destination) && sha256(destination) === manifest.files[relative]) continue;
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
      restored++;
    } catch { /* keep restoring the rest */ }
  }
  return restored;
}

function dirtyTracked(repo) {
  const status = git(repo, ["status", "--porcelain", "--untracked-files=no", "-z"], { raw: true });
  if (!status.ok) return [];
  // Entries are "XY path"; a rename adds a second NUL-separated original path.
  const entries = status.stdout.split("\0").filter(Boolean);
  const files = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4 || entry[2] !== " ") continue;
    files.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") i++;
  }
  return files;
}

function readPackage(directory) {
  try { return JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")); } catch { return null; }
}

function hasDependencies(pkg) {
  return Boolean(pkg && ((pkg.dependencies && Object.keys(pkg.dependencies).length) || (pkg.optionalDependencies && Object.keys(pkg.optionalDependencies).length)));
}

// The self-test must work without a network: scripts.selftest is taken as
// declared; scripts.test only when it is Node's own test runner (or the package
// says so with "allsortedUpdate": { "offlineTest": true }).
function selfTestCommand(pkg) {
  const scripts = (pkg && pkg.scripts) || {};
  if (typeof scripts.selftest === "string" && scripts.selftest.trim()) return { command: scripts.selftest, name: "selftest" };
  if (typeof scripts.test === "string" && scripts.test.trim()) {
    const offline = /^node\s/.test(scripts.test.trim()) || (pkg.allsortedUpdate && pkg.allsortedUpdate.offlineTest === true);
    if (offline) return { command: scripts.test, name: "test" };
    return { skipped: `scripts.test ("${scripts.test}") is not marked offline-safe, so it was not run` };
  }
  return { skipped: "the package declares no selftest or test script" };
}

function runShell(command, cwd, timeout) {
  const bin = path.dirname(process.execPath);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`, CI: process.env.CI || "1" };
  // A self-test started from inside another `node --test` run must not think
  // it is one of that run's children, or its failures exit 0.
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(command, { cwd, shell: true, encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024, env });
}

function groupSubjects(subjects) {
  const groups = { "New": [], "Fixes": [], "Docs": [], "Changes": [] };
  for (const raw of subjects) {
    const subject = raw.trim();
    if (!subject) continue;
    const match = subject.match(/^(\w+)(\([^)]*\))?!?:\s*(.*)$/);
    const type = match ? match[1].toLowerCase() : "";
    const text = match ? match[3] : subject;
    if (type === "feat" || type === "feature") groups["New"].push(text);
    else if (type === "fix" || type === "hotfix") groups["Fixes"].push(text);
    else if (type === "docs" || type === "doc") groups["Docs"].push(text);
    else groups["Changes"].push(text);
  }
  return groups;
}

function whatsNewBlock(name, fromSha, toSha, subjects) {
  const lines = [`What's new in ${name} (${fromSha.slice(0, 7)} to ${toSha.slice(0, 7)}):`];
  const groups = groupSubjects(subjects);
  for (const [title, items] of Object.entries(groups)) {
    if (!items.length) continue;
    lines.push(`  ${title}:`);
    for (const item of items) lines.push(`    - ${item}`);
  }
  if (lines.length === 1) lines.push("  - Updated to the latest version.");
  return lines.join("\n");
}

function displayName(repo) {
  const pkg = readPackage(packageDir()) || readPackage(repo);
  return (pkg && typeof pkg.name === "string" && pkg.name) || path.basename(repo);
}

// --- the update itself -----------------------------------------------------

function checkRemote(repo) {
  const fetched = git(repo, ["fetch", "--quiet", "origin"], { timeout: FETCH_TIMEOUT_MS });
  if (!fetched.ok) return { error: fetched.timedOut ? "could not reach origin within 20 seconds" : `git fetch failed: ${fetched.stderr || "unknown error"}` };
  const branch = defaultBranch(repo);
  const head = git(repo, ["rev-parse", "HEAD"]);
  const remote = git(repo, ["rev-parse", `refs/remotes/origin/${branch}`]);
  if (!head.ok || !remote.ok) return { error: `origin/${branch} was not found after fetching` };
  if (head.stdout === remote.stdout) return { branch, head: head.stdout, remote: remote.stdout, behind: 0, subjects: [] };
  const ancestor = git(repo, ["merge-base", "--is-ancestor", head.stdout, remote.stdout]);
  const log1 = git(repo, ["log", "--no-merges", "--format=%s", `${head.stdout}..${remote.stdout}`]);
  const subjects = log1.ok ? log1.stdout.split("\n").filter(Boolean) : [];
  return { branch, head: head.stdout, remote: remote.stdout, behind: subjects.length || 1, fastForward: ancestor.ok, subjects };
}

function applyUpdate(repo, check, log) {
  const name = displayName(repo);
  const pkgDir = packageDir();
  const dirty = dirtyTracked(repo);
  if (dirty.length) {
    return {
      result: "refused: local changes",
      message: `${name}: an update is ready but these files have local changes: ${dirty.join(", ")}.\n` +
        `  Keep them and update: git -C "${repo}" stash && node "${path.join(pkgDir, "scripts", "self-update.js")}" --now && git -C "${repo}" stash pop\n` +
        `  Or make them permanent first: git -C "${repo}" commit -am "my changes" (then the update stops, because your copy has its own commits).`,
    };
  }
  if (!check.fastForward) {
    return {
      result: "refused: local commits",
      message: `${name}: your copy has commits that the project does not, so it cannot be fast-forwarded.\n` +
        `  To take the project's version and drop your commits: git -C "${repo}" reset --hard origin/${check.branch}`,
    };
  }
  log(`${name}: ${check.behind} new commit${check.behind === 1 ? "" : "s"} on origin/${check.branch}:`);
  const oneline = git(repo, ["log", "--oneline", "--no-merges", `${check.head}..${check.remote}`]);
  for (const line of (oneline.stdout || "").split("\n").filter(Boolean)) log(`  ${line}`);

  const saved = backup(repo);
  log(`Backed up ${Object.keys(saved.manifest.files).length} protected file(s) to ${path.relative(repo, saved.root)}/`);
  const previous = check.head;

  const rollback = reason => {
    const reset = git(repo, ["reset", "--hard", "--quiet", previous]);
    const restored = restoreBackup(repo, saved.root);
    const where = reset.ok ? `back on ${previous.slice(0, 7)}` : `could not reset (${reset.stderr}); run: git -C "${repo}" reset --hard ${previous}`;
    return { result: `rolled back: ${reason}`, message: `${name}: ${reason}. Rolled back, ${where}, ${restored} protected file(s) restored from ${path.relative(repo, saved.root)}/.` };
  };

  const merged = git(repo, ["merge", "--ff-only", "--quiet", `refs/remotes/origin/${check.branch}`], { timeout: 60000 });
  if (!merged.ok) return rollback(`fast-forward failed (${merged.stderr || "unknown error"})`);
  const current = git(repo, ["rev-parse", "HEAD"]).stdout;

  // Second guard: the protected files are untracked, so git never rewrites
  // them, but prove it byte for byte and put back anything that moved.
  const touched = restoreBackup(repo, saved.root);
  if (touched) log(`Restored ${touched} protected file(s) that the update had changed.`);

  const changedFiles = git(repo, ["diff", "--name-only", previous, current]).stdout.split("\n").filter(Boolean);
  const pkgRelative = path.relative(repo, path.join(pkgDir, "package.json")).split(path.sep).join("/");
  const pkg = readPackage(pkgDir);
  if (changedFiles.includes(pkgRelative) && hasDependencies(pkg)) {
    log("package.json changed and declares dependencies: running npm install --no-audit --no-fund");
    const installed = runShell("npm install --no-audit --no-fund", pkgDir, INSTALL_TIMEOUT_MS);
    if (installed.status !== 0) return rollback(`npm install failed${installed.stderr ? ` (${installed.stderr.trim().split("\n").pop()})` : ""}`);
  }

  const selfTest = selfTestCommand(pkg);
  if (selfTest.skipped) log(`Self-test skipped: ${selfTest.skipped}.`);
  else {
    log(`Running self-test (scripts.${selfTest.name}): ${selfTest.command}`);
    const tested = runShell(selfTest.command, pkgDir, SELFTEST_TIMEOUT_MS);
    if (tested.status !== 0) {
      const tail = `${tested.stdout || ""}\n${tested.stderr || ""}`.trim().split("\n").slice(-8).join("\n    ");
      if (tail) log(`  Self-test output (last lines):\n    ${tail}`);
      return rollback(`self-test failed (exit ${tested.status === null ? "timeout" : tested.status})`);
    }
    log("Self-test passed.");
  }

  const block = whatsNewBlock(name, previous, current, check.subjects);
  return { result: `updated to ${current.slice(0, 7)}`, message: block, whatsNew: block, updated: true, from: previous, to: current };
}

// run(options): the whole weekly flow. Never throws; returns { code, result }.
//   options.now      ignore the 7-day throttle and the auto setting
//   options.checkOnly only report, never change the clone
//   options.log      line printer (defaults to console.log)
function run(options = {}) {
  const log = typeof options.log === "function" ? options.log : line => console.log(line);
  const repo = options.repo ? path.resolve(options.repo) : repoRoot();
  if (!repo) { log("Self-update skipped: this folder is not a git clone."); return { code: 0, result: "skipped: not a git clone" }; }
  if (!dedicatedClone(repo)) {
    log(`Self-update skipped: ${path.basename(packageDir())} sits inside a larger repository (${repo}), which is yours to update.`);
    return { code: 0, result: "skipped: not a dedicated clone" };
  }
  let state;
  try { state = readState(repo); } catch (error) { log(`Self-update skipped: ${error.message}`); return { code: 0, result: "skipped" }; }
  const name = displayName(repo);
  try {
    const off = optedOut(state);
    if (off && !options.now) {
      log(`${name}: weekly updates are off (${off}).`);
      return { code: 0, result: "skipped: off" };
    }
    if (!options.now && !due(state)) return { code: 0, result: "skipped: not due" };
    if (!fs.existsSync(statePath(repo))) writeState(repo, state);
    const check = checkRemote(repo);
    state.lastCheck = nowIso();
    if (check.error) {
      state.lastResult = `check failed: ${check.error}`;
      writeState(repo, state);
      log(`${name}: update check skipped (${check.error}).`);
      return { code: 0, result: state.lastResult };
    }
    if (!check.behind) {
      state.lastResult = `up to date at ${check.head.slice(0, 7)}`;
      writeState(repo, state);
      log(`${name} is up to date (${check.head.slice(0, 7)}).`);
      return { code: 0, result: state.lastResult };
    }
    if (options.checkOnly) {
      state.lastResult = `update available: ${check.behind} commit(s) behind origin/${check.branch}`;
      writeState(repo, state);
      log(`${name}: an update is available (${check.behind} new commit${check.behind === 1 ? "" : "s"}). Apply it with: node "${path.join(packageDir(), "scripts", "self-update.js")}" --now`);
      return { code: 0, result: state.lastResult, behind: check.behind };
    }
    const outcome = applyUpdate(repo, check, log);
    state.lastResult = outcome.result;
    if (outcome.updated) { state.lastUpdate = nowIso(); state.whatsNew = outcome.whatsNew; }
    writeState(repo, state);
    log(outcome.message);
    // 0 updated, 1 rolled back, 2 refused (local changes or local commits).
    const code = outcome.updated ? 0 : outcome.result.startsWith("refused") ? 2 : 1;
    return { code, result: outcome.result, outcome };
  } catch (error) {
    try { state.lastCheck = state.lastCheck || nowIso(); state.lastResult = `error: ${error.message}`; writeState(repo, state); } catch { /* nothing else to do */ }
    log(`${name}: self-update stopped (${error.message}).`);
    return { code: 0, result: `error: ${error.message}` };
  }
}

// startupCheck(): for other commands to call first. No network unless 7 days
// have passed, never applies anything, one line at most, never throws.
function startupCheck(options = {}) {
  try { return run({ ...options, checkOnly: true }); } catch { return { code: 0, result: "skipped" }; }
}

function setAuto(repo, value, log) {
  const state = readState(repo);
  state.auto = value;
  writeState(repo, state);
  log(value
    ? `Weekly updates are on. Check now with: node "${path.join(packageDir(), "scripts", "self-update.js")}" --now`
    : `Weekly updates are off. Turn them back on with: node "${path.join(packageDir(), "scripts", "self-update.js")}" --on`);
  return 0;
}

function status(repo, log) {
  const state = readState(repo);
  const off = optedOut(state);
  const registered = scheduler.isRegistered(repo);
  log(`${displayName(repo)} self-update`);
  log(`  clone:        ${repo}`);
  log(`  weekly:       ${off ? `off (${off})` : "on"}`);
  log(`  scheduled:    ${registered ? `yes (${scheduler.describe(repo)})` : "no (node scripts/self-update.js --register)"}`);
  log(`  last check:   ${state.lastCheck || "never"}`);
  log(`  last result:  ${state.lastResult || "none"}`);
  log(`  last update:  ${state.lastUpdate || "never"}`);
  log(`  next check:   ${off ? "not scheduled" : state.lastCheck && !due(state) ? new Date(Date.parse(state.lastCheck) + WEEK_MS).toISOString() : "on the next run"}`);
  if (state.whatsNew) log(`\n${state.whatsNew}`);
  return 0;
}

// --- scheduling ---------------------------------------------------------------

const scheduler = {
  slug(repo) {
    const base = path.basename(repo).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
    return `${base}-${crypto.createHash("sha256").update(repo).digest("hex").slice(0, 8)}`;
  },
  script() { return path.join(packageDir(), "scripts", "self-update.js"); },
  label(repo) { return `com.allsorted.self-update.${this.slug(repo)}`; },
  launchAgentsDir() { return process.env.ALLSORTED_LAUNCH_AGENTS_DIR || path.join(os.homedir(), "Library", "LaunchAgents"); },
  plistPath(repo) { return path.join(this.launchAgentsDir(), `${this.label(repo)}.plist`); },
  logPath(repo) { return path.join(repo, BACKUP_DIR, "self-update.log"); },
  cronMarker(repo) { return `# allsorted-self-update ${this.slug(repo)}`; },
  taskName(repo) { return `AllSorted Self Update ${this.slug(repo)}`; },
  platform() { return process.env.ALLSORTED_SELF_UPDATE_PLATFORM || process.platform; },
  xml(value) { return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); },
  plist(repo) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${this.xml(this.label(repo))}</string>
<key>ProgramArguments</key><array><string>${this.xml(process.execPath)}</string><string>${this.xml(this.script())}</string></array>
<key>WorkingDirectory</key><string>${this.xml(repo)}</string>
<key>StartCalendarInterval</key><dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer></dict>
<key>RunAtLoad</key><false/>
<key>StandardOutPath</key><string>${this.xml(this.logPath(repo))}</string>
<key>StandardErrorPath</key><string>${this.xml(this.logPath(repo))}</string>
</dict></plist>
`;
  },
  launchctl(args) {
    if (process.env.ALLSORTED_SELF_UPDATE_NO_LAUNCHCTL === "1") return { ok: true };
    const result = spawnSync("launchctl", args, { encoding: "utf8", timeout: 15000 });
    return { ok: result.status === 0, stderr: (result.stderr || "").trim() };
  },
  cronLine(repo) {
    const q = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
    return `30 9 * * 1 cd ${q(repo)} && ${q(process.execPath)} ${q(this.script())} >> ${q(this.logPath(repo))} 2>&1 ${this.cronMarker(repo)}`;
  },
  readCrontab() {
    const result = spawnSync("crontab", ["-l"], { encoding: "utf8", timeout: 15000 });
    if (result.error) throw new Error("crontab is not available on this machine");
    return result.status === 0 ? result.stdout : "";
  },
  writeCrontab(content) {
    const result = spawnSync("crontab", ["-"], { input: content.endsWith("\n") || !content ? content : `${content}\n`, encoding: "utf8", timeout: 15000 });
    if (result.status !== 0) throw new Error((result.stderr || "crontab refused the new table").trim());
  },
  schtasks(args) {
    const result = spawnSync("schtasks", args, { encoding: "utf8", timeout: 30000 });
    if (result.error) throw new Error("schtasks is not available on this machine");
    return { ok: result.status === 0, stderr: (result.stderr || result.stdout || "").trim() };
  },
  describe(repo) {
    const platform = this.platform();
    if (platform === "darwin") return `launchd ${this.label(repo)}, Mondays 09:30`;
    if (platform === "win32") return `Task Scheduler "${this.taskName(repo)}", Mondays 09:30`;
    return "cron, Mondays 09:30";
  },
  isRegistered(repo) {
    try {
      const platform = this.platform();
      if (platform === "darwin") return fs.existsSync(this.plistPath(repo));
      if (platform === "win32") return this.schtasks(["/Query", "/TN", this.taskName(repo)]).ok;
      return this.readCrontab().includes(this.cronMarker(repo));
    } catch { return false; }
  },
  register(repo, log) {
    const platform = this.platform();
    fs.mkdirSync(path.join(repo, BACKUP_DIR), { recursive: true });
    excludeLocally(repo);
    if (platform === "darwin") {
      const file = this.plistPath(repo);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, this.plist(repo), { mode: 0o644 });
      const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : 501}`;
      this.launchctl(["bootout", `${domain}/${this.label(repo)}`]);
      const loaded = this.launchctl(["bootstrap", domain, file]);
      if (!loaded.ok) log(`Note: the job file is in place but launchd did not load it yet (${loaded.stderr}). It loads at your next login.`);
      log(`Weekly update job installed: ${this.describe(repo)}.`);
      log(`  Remove it with: node "${this.script()}" --unregister`);
      return 0;
    }
    if (platform === "win32") {
      const command = `"${process.execPath}" "${this.script()}"`;
      const created = this.schtasks(["/Create", "/F", "/SC", "WEEKLY", "/D", "MON", "/ST", "09:30", "/TN", this.taskName(repo), "/TR", command]);
      if (!created.ok) throw new Error(created.stderr || "schtasks could not create the task");
      log(`Weekly update job installed: ${this.describe(repo)}.`);
      log(`  Remove it with: node "${this.script()}" --unregister`);
      return 0;
    }
    const current = this.readCrontab();
    const kept = current.split("\n").filter(line => line.trim() && !line.includes(this.cronMarker(repo)));
    kept.push(this.cronLine(repo));
    this.writeCrontab(kept.join("\n"));
    log(`Weekly update job installed: ${this.describe(repo)}.`);
    log(`  Remove it with: node "${this.script()}" --unregister`);
    return 0;
  },
  unregister(repo, log) {
    const platform = this.platform();
    if (platform === "darwin") {
      const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : 501}`;
      this.launchctl(["bootout", `${domain}/${this.label(repo)}`]);
      try { fs.unlinkSync(this.plistPath(repo)); } catch (error) { if (error.code !== "ENOENT") throw error; }
      log("Weekly update job removed.");
      return 0;
    }
    if (platform === "win32") {
      this.schtasks(["/Delete", "/F", "/TN", this.taskName(repo)]);
      log("Weekly update job removed.");
      return 0;
    }
    const current = this.readCrontab();
    const kept = current.split("\n").filter(line => line.trim() && !line.includes(this.cronMarker(repo)));
    this.writeCrontab(kept.join("\n"));
    log("Weekly update job removed.");
    return 0;
  },
};

function explain(log) {
  const script = path.join(packageDir(), "scripts", "self-update.js");
  log("Weekly updates: once a week this clone checks its origin and fast-forwards to the latest version.");
  log("It backs up your .env, config and data files first, runs the self-test, and rolls back if that fails.");
  log("Your own files are never overwritten. A plain what's-new note is printed after each update.");
  log(`  Turn off:  node "${script}" --off      Turn on: node "${script}" --on`);
  log(`  Status:    node "${script}" --status   Run now: node "${script}" --now`);
}

// main(argv, io): io.log is an optional line sink so a host CLI can embed this.
function main(argv, io = {}) {
  const log = typeof io.log === "function" ? io.log : line => console.log(line);
  const flags = new Set(argv.filter(arg => arg.startsWith("--")));
  const repo = repoRoot();
  if (flags.has("--help") || flags.has("-h")) { explain(log); return 0; }
  if (!repo) { log("Self-update skipped: this folder is not a git clone."); return 0; }
  if (!dedicatedClone(repo) && !flags.has("--status")) {
    log(`Self-update skipped: ${path.basename(packageDir())} sits inside a larger repository (${repo}), which is yours to update. Nothing was scheduled or changed.`);
    return 0;
  }
  try {
    if (flags.has("--off")) return setAuto(repo, false, log);
    if (flags.has("--on")) return setAuto(repo, true, log);
    if (flags.has("--status")) return status(repo, log);
    if (flags.has("--register")) { explain(log); return scheduler.register(repo, log); }
    if (flags.has("--unregister")) return scheduler.unregister(repo, log);
    if (flags.has("--explain")) { explain(log); return 0; }
  } catch (error) {
    log(`Self-update: ${error.message}`);
    return 1;
  }
  return run({ now: flags.has("--now"), checkOnly: flags.has("--check"), log }).code;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  run, startupCheck, main, readState, writeState, repoRoot, packageDir, dedicatedClone, defaultBranch, matchesProtected, protectedFiles,
  backup, restoreBackup, dirtyTracked, selfTestCommand, groupSubjects, whatsNewBlock, scheduler, due, optedOut,
  PROTECTED_GLOBS, STATE_FILE, BACKUP_DIR, WEEK_MS,
};
