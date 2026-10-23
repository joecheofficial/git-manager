"use strict";
// Contributor defaults (All Sorted contributor model, 2026-10-23): start fetches
// first, pull-work merges (never rebase, never autostash), and checkin.enforcedRepos
// covers the All Sorted repos a contributor clones under ~/allsorted.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const checkin = require("../src/checkin");
const { pullWork } = require("../github");

const identity = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "contributor-test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "contributor-test@example.invalid", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
Object.assign(process.env, identity);
const g = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, ...identity }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const ROOT = path.resolve(__dirname, "..");

function commit(repo, file, content, subject) {
  fs.writeFileSync(path.join(repo, file), content); g(repo, "add", file); g(repo, "commit", "-q", "-m", subject);
  return g(repo, "rev-parse", "HEAD");
}

// A bare origin with two clones: "mine" (this machine) and "theirs" (another machine).
function shared(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gm-contrib-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin.git");
  g(root, "init", "-q", "--bare", "-b", "main", origin);
  const seed = path.join(root, "seed");
  g(root, "init", "-q", "-b", "main", seed);
  commit(seed, "file.txt", "base\nmiddle\nend\n", "initial");
  g(seed, "remote", "add", "origin", origin);
  g(seed, "push", "-q", "origin", "main");
  const mine = path.join(root, "mine");
  const theirs = path.join(root, "theirs");
  g(root, "clone", "-q", origin, mine);
  g(root, "clone", "-q", origin, theirs);
  return { root, origin, mine, theirs };
}

test("start fetches first by default and bases the task on what was just pushed", t => {
  const s = shared(t);
  const pushed = commit(s.theirs, "other.txt", "theirs\n", "feat: pushed from another machine");
  g(s.theirs, "push", "-q", "origin", "main");
  const config = { claimsFile: path.join(s.root, "claims.json"), worktreeRoot: path.join(s.root, "trees"), enforcedRepos: [], ownerSessions: [] };
  const opts = { config, env: { ALLSORTED_ACTOR: "contributor" }, owner: "contributor", session: "s1" };
  const skipped = checkin.start(s.mine, { ...opts, task: "no-fetch", fetch: false, dryRun: true });
  assert.equal(skipped.ok, true, JSON.stringify(skipped));
  assert.notEqual(skipped.plan.baseSha, pushed);
  const r = checkin.start(s.mine, { ...opts, task: "work" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.claim.base, "origin/main");
  assert.equal(r.claim.baseSha, pushed);
  assert.match(r.health.warnings.join("\n"), /1 behind origin/);
  assert.equal(r.health.info.fetched, true);
});

test("start without an origin remote does not try to fetch", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gm-contrib-local-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  g(root, "init", "-q", "-b", "main", repo);
  commit(repo, "file.txt", "x\n", "initial");
  const r = checkin.start(repo, { config: { claimsFile: path.join(root, "claims.json"), worktreeRoot: path.join(root, "trees"), enforcedRepos: [], ownerSessions: [] }, env: { ALLSORTED_ACTOR: "joe" }, owner: "joe", session: "s", task: "t", dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.doesNotMatch(r.health.warnings.join("\n"), /fetch failed/);
});

test("the CLI refuses --fetch together with --no-fetch before doing anything", () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, "bin/git-manager.js"), "start", os.tmpdir(), "--task", "x", "--fetch", "--no-fetch", "--json"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /--fetch and --no-fetch conflict/);
  assert.match(fs.readFileSync(path.join(ROOT, "bin/git-manager.js"), "utf8"), /\[--no-fetch\]/);
});

test("pull-work fast-forwards when only GitHub has new work", t => {
  const s = shared(t);
  const pushed = commit(s.theirs, "other.txt", "theirs\n", "feat: theirs");
  g(s.theirs, "push", "-q", "origin", "main");
  const result = pullWork({ repositoryRoot: s.mine });
  assert.equal(result.merged, true);
  assert.equal(g(s.mine, "rev-parse", "HEAD"), pushed);
});

test("pull-work merges diverged work with a merge commit and never rewrites local commits", t => {
  const s = shared(t);
  commit(s.theirs, "other.txt", "theirs\n", "feat: theirs");
  g(s.theirs, "push", "-q", "origin", "main");
  const local = commit(s.mine, "mine.txt", "mine\n", "feat: mine");
  const result = pullWork({ repositoryRoot: s.mine });
  assert.equal(result.merged, true);
  const parents = g(s.mine, "rev-list", "--parents", "-n", "1", "HEAD").split(" ");
  assert.equal(parents.length, 3, "a merge commit has two parents");
  assert.equal(parents[1], local, "the local commit is kept as-is, not rebased");
  assert.equal(g(s.mine, "merge-base", "--is-ancestor", "origin/main", "HEAD"), "");
  assert.match(fs.readFileSync(path.join(ROOT, "github.js"), "utf8"), /\["merge", "--no-edit", upstream\]/);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, "github.js"), "utf8"), /--rebase|--autostash/);
});

test("pull-work refuses with uncommitted changes instead of autostashing", t => {
  const s = shared(t);
  commit(s.theirs, "other.txt", "theirs\n", "feat: theirs");
  g(s.theirs, "push", "-q", "origin", "main");
  const head = g(s.mine, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(s.mine, "file.txt"), "edited but not committed\n");
  assert.throws(() => pullWork({ repositoryRoot: s.mine }), /uncommitted changes/);
  assert.equal(g(s.mine, "rev-parse", "HEAD"), head);
  assert.equal(fs.readFileSync(path.join(s.mine, "file.txt"), "utf8"), "edited but not committed\n");
  assert.equal(g(s.mine, "stash", "list"), "");
});

test("pull-work undoes a conflicted merge and leaves the branch exactly as it was", t => {
  const s = shared(t);
  commit(s.theirs, "file.txt", "base\ntheirs\nend\n", "feat: theirs");
  g(s.theirs, "push", "-q", "origin", "main");
  const local = commit(s.mine, "file.txt", "base\nmine\nend\n", "feat: mine");
  assert.throws(() => pullWork({ repositoryRoot: s.mine }), /needs a decision/);
  assert.equal(g(s.mine, "rev-parse", "HEAD"), local);
  assert.equal(g(s.mine, "status", "--porcelain"), "");
  assert.equal(fs.existsSync(path.join(s.mine, ".git", "MERGE_HEAD")), false);
});

test("pull-work on a branch with no upstream explains instead of failing obscurely", t => {
  const s = shared(t);
  g(s.mine, "checkout", "-q", "-b", "local-only");
  assert.throws(() => pullWork({ repositoryRoot: s.mine }), /does not track a GitHub branch/);
});

test("enforcedRepos entries ending in /* cover every git repo in that folder", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gm-enforced-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["allsorted-dist", "example-module"]) g(root, "init", "-q", path.join(root, "allsorted", name));
  fs.mkdirSync(path.join(root, "allsorted", "not-a-repo"));
  fs.writeFileSync(path.join(root, "allsorted", "file.txt"), "x");
  const inputs = checkin.enforcedRepoInputs({ enforcedRepos: [`${root}/allsorted/*`, `${root}/missing/*`, "/explicit/path"] });
  assert.deepEqual(inputs, [path.join(root, "allsorted", "allsorted-dist"), path.join(root, "allsorted", "example-module"), "/explicit/path"]);
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config/config.json"), "utf8"));
  assert.deepEqual(config.checkin.enforcedRepos, ["~/allsorted/*"]);
});

test("sweep checks glob-matched repos and reports when nothing matched on this machine", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gm-sweep-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "allsorted", "allsorted-dist");
  g(root, "init", "-q", "-b", "main", repo);
  commit(repo, "file.txt", "x\n", "direct commit without a claim");
  const base = { claimsFile: path.join(root, "claims.json"), worktreeRoot: path.join(root, "trees"), ownerSessions: [], unclaimedWindowHours: 2 };
  const found = checkin.sweep({ config: { ...base, enforcedRepos: [`${root}/allsorted/*`] }, readOnly: true });
  assert.deepEqual(found.repos, [repo]);
  assert.ok(found.findings.some(f => f.code === "commits-without-claim" && f.repo === repo), JSON.stringify(found.findings));
  const none = checkin.sweep({ config: { ...base, enforcedRepos: [`${root}/nothing-here/*`] }, readOnly: true });
  assert.ok(none.findings.some(f => f.code === "no-enforced-repos" && /no repository matched/.test(f.message)));
  assert.ok(!none.findings.some(f => f.code === "enforced-repo-unavailable"));
});

test("pull-work refuses and leaves an in-progress merge alone", t => {
  const s = shared(t);
  commit(s.theirs, "other.txt", "theirs\n", "feat: theirs");
  g(s.theirs, "push", "-q", "origin", "main");
  g(s.mine, "checkout", "-q", "-b", "side");
  commit(s.mine, "side.txt", "side\n", "feat: side");
  g(s.mine, "checkout", "-q", "main");
  g(s.mine, "merge", "--no-commit", "-s", "ours", "side");
  assert.throws(() => pullWork({ repositoryRoot: s.mine }), /already in progress here \(MERGE_HEAD\)/);
  assert.equal(fs.existsSync(path.join(s.mine, ".git", "MERGE_HEAD")), true, "the user's own merge is untouched");
});

test("a merge blocked by an untracked file is reported as such, not as a conflict, and keeps the file", t => {
  const s = shared(t);
  commit(s.theirs, "new.txt", "from github\n", "feat: add new.txt");
  g(s.theirs, "push", "-q", "origin", "main");
  fs.writeFileSync(path.join(s.mine, "new.txt"), "my untracked notes\n");
  const head = g(s.mine, "rev-parse", "HEAD");
  assert.throws(() => pullWork({ repositoryRoot: s.mine }), error => /branch was not changed/.test(error.message) && !/needs a decision/.test(error.message));
  assert.equal(g(s.mine, "rev-parse", "HEAD"), head);
  assert.equal(fs.readFileSync(path.join(s.mine, "new.txt"), "utf8"), "my untracked notes\n");
});

test("pull-work on a branch that tracks a local branch merges without fetching", t => {
  const s = shared(t);
  const tip = commit(s.mine, "local.txt", "x\n", "feat: on main");
  g(s.mine, "branch", "-q", "--track", "follower", "main");
  g(s.mine, "checkout", "-q", "follower");
  g(s.mine, "reset", "-q", "--hard", "HEAD~1");
  const result = pullWork({ repositoryRoot: s.mine });
  assert.equal(result.upstream, "main");
  assert.equal(g(s.mine, "rev-parse", "HEAD"), tip);
});

test("start with an unreachable origin warns and continues from the last fetched state", t => {
  const s = shared(t);
  g(s.mine, "remote", "set-url", "origin", path.join(s.root, "gone.git"));
  const r = checkin.start(s.mine, { config: { claimsFile: path.join(s.root, "claims.json"), worktreeRoot: path.join(s.root, "trees"), enforcedRepos: [], ownerSessions: [] }, env: { ALLSORTED_ACTOR: "contributor" }, owner: "contributor", session: "s", task: "offline", dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.health.warnings.join("\n"), /fetch failed, working from the last fetched state/);
  assert.match(fs.readFileSync(path.join(ROOT, "src/checkin.js"), "utf8"), /GIT_TERMINAL_PROMPT: "0"/);
});

test("enforcedRepos globs include repos that are symlinked into the folder", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gm-enforced-link-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = path.join(root, "elsewhere", "module-repo");
  g(root, "init", "-q", real);
  fs.mkdirSync(path.join(root, "allsorted"));
  fs.symlinkSync(real, path.join(root, "allsorted", "module-repo"));
  fs.symlinkSync(path.join(root, "missing"), path.join(root, "allsorted", "broken"));
  assert.deepEqual(checkin.enforcedRepoInputs({ enforcedRepos: [`${root}/allsorted/*`] }), [path.join(root, "allsorted", "module-repo")]);
});

test("start's fetch keeps the user's core.sshCommand", t => {
  const s = shared(t);
  const marker = path.join(s.root, "ssh-used");
  const fakeSsh = path.join(s.root, "fake-ssh.sh");
  fs.writeFileSync(fakeSsh, `#!/bin/sh\necho used > "${marker}"\nexit 1\n`, { mode: 0o755 });
  g(s.mine, "remote", "set-url", "origin", "ssh://example.invalid/x.git");
  g(s.mine, "config", "core.sshCommand", fakeSsh);
  const r = checkin.start(s.mine, { config: { claimsFile: path.join(s.root, "claims.json"), worktreeRoot: path.join(s.root, "trees"), enforcedRepos: [], ownerSessions: [] }, env: { ALLSORTED_ACTOR: "contributor" }, owner: "contributor", session: "s", task: "ssh", dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(fs.existsSync(marker), true, "the configured core.sshCommand ran");
});
