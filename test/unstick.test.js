"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const checkin = require("../src/checkin");

const identity = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "unstick-test.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "unstick-test.invalid", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
Object.assign(process.env, identity);
const g = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const HOUR = 3600000;

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gm-unstick-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo"); fs.mkdirSync(repo);
  g(repo, "-c", "init.defaultBranch=main", "init");
  fs.writeFileSync(path.join(repo, "file.txt"), "base\n");
  g(repo, "add", "."); g(repo, "commit", "-m", "initial");
  const config = { claimsFile: path.join(root, "claims.json"), worktreeRoot: path.join(root, "trees"), carryBackupDir: path.join(root, "carry"), enforcedRepos: [repo], ownerSessions: [], staleClaimHours: 8, recentCommitHours: 3, unclaimedWindowHours: 2 };
  const base = { config, env: { ALLSORTED_ACTOR: "zac" }, owner: "claude", fetch: false };
  return { root, repo, config, base };
}
// Make a claim look idle: its creation and its worktree's files are older than staleClaimHours.
function age(f, hours) {
  const store = JSON.parse(fs.readFileSync(f.config.claimsFile, "utf8"));
  const then = new Date(Date.now() - hours * HOUR).toISOString();
  for (const c of store.claims) { c.createdAt = then; c.updatedAt = then; c.lastActivityAt = then; }
  fs.writeFileSync(f.config.claimsFile, JSON.stringify(store, null, 2));
}
const cli = (f, ...args) => spawnSync(process.execPath, [path.resolve(__dirname, "../bin/git-manager.js"), ...args], { encoding: "utf8", env: { ...process.env, GIT_MANAGER_CONFIG_JSON: JSON.stringify(f.config), GIT_MANAGER_CLAIMS_FILE: f.config.claimsFile, GIT_MANAGER_WORKTREE_ROOT: f.config.worktreeRoot, ALLSORTED_ACTOR: "zac" } });

test("unstick expires a dead session's claim and names the next step for a live one", t => {
  const f = fixture(t);
  assert.equal(checkin.start(f.repo, { ...f.base, task: "old", session: "dead-session", paths: "file.txt" }).ok, true);
  age(f, 30);
  assert.equal(checkin.start(f.repo, { ...f.base, task: "live", session: "live-session", paths: "other.txt" }).ok, true);
  const preview = checkin.unstick(f.repo, { config: f.config, dryRun: true });
  assert.equal(preview.expired.length, 1);
  assert.equal(checkin.listClaims({ config: f.config }).find(c => c.task === "old").status, "active", "dry run changes nothing");
  const r = checkin.unstick(f.repo, { config: f.config });
  assert.equal(r.ok, true);
  assert.deepEqual(r.expired.map(id => id.split(":")[1]), ["old"]);
  assert.equal(checkin.listClaims({ config: f.config }).find(c => c.task === "old").status, "expired");
  assert.deepEqual(r.held.map(c => c.id.split(":")[1]), ["live"]);
  assert.match(r.held[0].next, /git-manager (finish|release)/);
  assert.ok(fs.existsSync(path.join(f.config.worktreeRoot, "repo", "old")), "expiry never removes the worktree");
});

test("start auto-unsticks once when only a dead session's claim blocks it", t => {
  const f = fixture(t);
  assert.equal(cli(f, "start", f.repo, "--task", "old", "--session", "dead-session", "--paths", "file.txt", "--no-fetch").status, 0);
  age(f, 30);
  const r = cli(f, "start", f.repo, "--task", "new", "--session", "new-session", "--paths", "file.txt", "--no-fetch");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /auto-unstick: expired 1 stale claim/);
  assert.match(r.stdout, /^cd /m);
});

test("start still holds when a live session's claim overlaps", t => {
  const f = fixture(t);
  assert.equal(cli(f, "start", f.repo, "--task", "busy", "--session", "busy-session", "--paths", "file.txt", "--no-fetch").status, 0);
  const r = cli(f, "start", f.repo, "--task", "second", "--session", "second-session", "--paths", "file.txt", "--no-fetch");
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /HELD: path overlap/);
  assert.doesNotMatch(r.stdout, /auto-unstick/);
});

test("orphaned git locks are removed only when no git process runs and the lock is old", t => {
  const f = fixture(t);
  const lock = path.join(f.repo, ".git", "index.lock");
  fs.writeFileSync(lock, "");
  const fresh = checkin.unstick(f.repo, { config: f.config, gitRunning: false });
  assert.deepEqual(fresh.locksRemoved, [], "a new lock may belong to a git command in progress");
  const old = new Date(Date.now() - 20 * 60000); fs.utimesSync(lock, old, old);
  const busy = checkin.unstick(f.repo, { config: f.config, gitRunning: true });
  assert.deepEqual(busy.locksRemoved, []); assert.equal(busy.locksKept[0].reason, "a git process is running");
  const unknown = checkin.unstick(f.repo, { config: f.config, gitRunning: null });
  assert.deepEqual(unknown.locksRemoved, []);
  const clear = checkin.unstick(f.repo, { config: f.config, gitRunning: false });
  assert.deepEqual(clear.locksRemoved, [fs.realpathSync(path.dirname(lock)) + "/index.lock"]);
  assert.equal(fs.existsSync(lock), false);
});

test("unstick CLI prints a summary and accepts --dry-run", t => {
  const f = fixture(t);
  const r = cli(f, "unstick", f.repo, "--dry-run");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /unstick preview \(nothing changed\): 0 stale claim/);
  assert.match(r.stdout, /nothing is holding claims now/);
});

test("a session that just reclaimed its old claim is not expired by another start", t => {
  const f = fixture(t);
  assert.equal(cli(f, "start", f.repo, "--task", "b", "--session", "b-session", "--paths", "file.txt", "--no-fetch").status, 0);
  age(f, 30);
  assert.equal(checkin.unstick(f.repo, { config: f.config }).expired.length, 1, "idle claim expires");
  const back = cli(f, "start", f.repo, "--task", "b", "--session", "b-session", "--paths", "file.txt", "--no-fetch");
  assert.equal(back.status, 0, back.stdout + back.stderr);
  assert.match(back.stdout, /\(reused\)/);
  const other = cli(f, "start", f.repo, "--task", "a", "--session", "a-session", "--paths", "file.txt", "--no-fetch");
  assert.notEqual(other.status, 0, "the returning session's claim still holds");
  assert.match(other.stdout, /HELD: path overlap/);
  assert.doesNotMatch(other.stdout, /auto-unstick/);
  assert.equal(checkin.listClaims({ config: f.config }).find(c => c.task === "b").status, "active");
});

test("claim ids with spaces are reported whole, and unstick only touches the named repo", t => {
  const f = fixture(t);
  const spaced = path.join(f.root, "My Site"); fs.mkdirSync(spaced);
  g(spaced, "-c", "init.defaultBranch=main", "init"); fs.writeFileSync(path.join(spaced, "a.txt"), "a\n"); g(spaced, "add", "."); g(spaced, "commit", "-m", "initial");
  assert.equal(checkin.start(spaced, { ...f.base, task: "s", session: "s-session", paths: "a.txt" }).ok, true);
  assert.equal(checkin.start(f.repo, { ...f.base, task: "o", session: "o-session", paths: "file.txt" }).ok, true);
  age(f, 30);
  const preview = checkin.unstick(spaced, { config: f.config, dryRun: true });
  assert.equal(preview.expired.length, 1);
  assert.match(preview.expired[0], /^My Site:s:/);
  assert.deepEqual(preview.held, [], "a claim that would expire is not also listed as held");
  const r = checkin.unstick(spaced, { config: f.config });
  assert.match(r.expired[0], /^My Site:s:/);
  assert.equal(checkin.listClaims({ config: f.config }).find(c => c.task === "o").status, "active", "the other repo's claim is untouched");
});

test("re-running start on an old but still active claim counts as activity", t => {
  const f = fixture(t);
  assert.equal(cli(f, "start", f.repo, "--task", "b", "--session", "b-session", "--paths", "file.txt", "--no-fetch").status, 0);
  age(f, 30);
  assert.match(cli(f, "start", f.repo, "--task", "b", "--session", "b-session", "--paths", "file.txt", "--no-fetch").stdout, /\(reused\)/);
  const other = cli(f, "start", f.repo, "--task", "a", "--session", "a-session", "--paths", "file.txt", "--no-fetch");
  assert.notEqual(other.status, 0, other.stdout);
  assert.match(other.stdout, /HELD: path overlap/);
});

test("a claim reused just short of stale stays protected an hour later", t => {
  const f = fixture(t);
  assert.equal(cli(f, "start", f.repo, "--task", "b", "--session", "b-session", "--paths", "file.txt", "--no-fetch").status, 0);
  age(f, 7.5);
  assert.match(cli(f, "start", f.repo, "--task", "b", "--session", "b-session", "--paths", "file.txt", "--no-fetch").stdout, /\(reused\)/);
  const later = checkin.unstick(f.repo, { config: f.config, now: Date.now() + HOUR });
  assert.deepEqual(later.expired, []);
});

test("reusing an idle claim still works when the claims store is busy", t => {
  const f = fixture(t);
  assert.equal(checkin.start(f.repo, { ...f.base, task: "b", session: "b-session", paths: "file.txt" }).ok, true);
  age(f, 7.5);
  fs.writeFileSync(f.config.claimsFile + ".lock", JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  t.after(() => fs.rmSync(f.config.claimsFile + ".lock", { force: true }));
  const r = checkin.start(f.repo, { ...f.base, task: "b", session: "b-session", paths: "file.txt" });
  assert.equal(r.ok, true); assert.equal(r.reused, true);
  assert.match(r.warnings.join("\n"), /reclaim not recorded/);
});
