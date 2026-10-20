"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const checkin = require("../src/checkin");
test("public CLI amends only its owner scope and isolates unknown activity", t => {
  const f = fixture(t), file = path.join(f.worktree, "a.txt");
  fs.writeFileSync(file, "staged version\n"); g(f.worktree, "add", "a.txt"); fs.writeFileSync(file, "working version\n");
  fs.chmodSync(f.config.claimsFile, 0o664);
  const before = { store: fs.readFileSync(f.config.claimsFile), index: g(f.worktree, "ls-files", "--stage"), file: fs.readFileSync(file) };
  const cli = (...args) => spawnSync(process.execPath, [path.resolve(__dirname, "../bin/git-manager.js"), ...args], { encoding: "utf8", env: { ...process.env, GIT_MANAGER_CONFIG_JSON: JSON.stringify(f.config), GIT_MANAGER_CLAIMS_FILE: f.config.claimsFile } });
  let result = cli("amend-scope", f.claim.id, "--paths", "a.txt", "--dry-run", "--json");
  assert.equal(result.status, 0, result.stderr + result.stdout); assert.equal(JSON.parse(result.stdout).dryRun, true);
  assert.deepEqual(fs.readFileSync(f.config.claimsFile), before.store);
  result = cli("amend-scope", f.claim.id, "--paths", "a.txt", "--json"); assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(fs.statSync(f.config.claimsFile).mode & 0o777, 0o664);
  assert.equal(g(f.worktree, "ls-files", "--stage"), before.index); assert.deepEqual(fs.readFileSync(file), before.file);
  const store = JSON.parse(fs.readFileSync(f.config.claimsFile)); assert.equal(store.claims[0].scopeAmendments.length, 1);
  store.claims.push({ ...f.claim, id: "unknown-checkout", worktree: f.root }); fs.writeFileSync(f.config.claimsFile, JSON.stringify(store));
  result = cli("claims", "--json"); assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).claims.find(c => c.id === "unknown-checkout").activityStatus, "unknown");
  result = cli("claims"); assert.equal(result.status, 0); assert.match(result.stdout, /activity unknown, held/);
});
const g = (repo, ...args) => execFileSync("git", ["--no-optional-locks", "-C", repo, ...args], { encoding: "utf8", stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "claims-test@example.invalid", GIT_COMMITTER_EMAIL: "claims-test@example.invalid" } }).trim();
function fixture(t) {
  const keys = ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_HOST_SESSION_ID", "ALLSORTED_ACTOR"];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.CODEX_THREAD_ID = "scope-fixture-host"; process.env.CODEX_SESSION_ID = "scope-fixture-worker";
  t.after(() => { for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; } });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gm-scope-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo"); fs.mkdirSync(repo);
  g(repo, "init", "-b", "main"); fs.writeFileSync(path.join(repo, "a.txt"), "base\n"); g(repo, "add", "."); g(repo, "commit", "-m", "base");
  const config = { ownerSessions: [], enforcedRepos: [], claimsFile: path.join(root, "claims.json"), worktreeRoot: path.join(root, "trees"), worktreeCapacity: { internalReserveGiB: 0, externalReserveGiB: 0 } };
  const session = process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID;
  const result = checkin.start(repo, { config, task: "owner", session, env: {}, owner: "codex" }); assert.equal(result.ok, true);
  return { root, repo, config, claim: result.claim, worktree: result.worktree, session };
}
function expireReservation(f, paths) {
  const store = JSON.parse(fs.readFileSync(f.config.claimsFile)), claim = store.claims.find(row => row.id === f.claim.id);
  claim.paths = paths; claim.status = "expired"; claim.expiredAt = "2026-10-13T00:00:00.000Z"; claim.lastActivityAt = "2026-10-12T00:00:00.000Z";
  fs.writeFileSync(f.config.claimsFile, JSON.stringify(store)); return claim;
}
test("claims list isolates inaccessible activity and preserves unknown holds", t => {
  const f = fixture(t), store = JSON.parse(fs.readFileSync(f.config.claimsFile));
  store.claims.push({ ...f.claim, id: "inaccessible", worktree: f.root });
  fs.writeFileSync(f.config.claimsFile, JSON.stringify(store));
  const claims = checkin.listClaims({ config: f.config });
  assert.equal(claims.length, 2);
  const unknown = claims.find(c => c.id === "inaccessible");
  assert.equal(unknown.activityStatus, "unknown"); assert.equal(unknown.stale, null); assert.equal(unknown.ageHours, null); assert.equal(unknown.status, "active");
});
test("amendment preserves shared claims-store access mode and actual owner", t => {
  const f = fixture(t), amend = require("../src/claim-scope").amendScope;
  fs.chmodSync(f.config.claimsFile, 0o664); const before = fs.statSync(f.config.claimsFile);
  assert.equal(amend(f.claim.id, { config: f.config, paths: "a.txt" }).ok, true);
  const after = fs.statSync(f.config.claimsFile);
  assert.equal(after.mode & 0o7777, before.mode & 0o7777); assert.equal(after.uid, before.uid); assert.equal(after.gid, before.gid);
});
test("macOS amendment preserves an explicit shared ACL", { skip: process.platform !== "darwin" }, t => {
  const f = fixture(t), amend = require("../src/claim-scope").amendScope;
  execFileSync("chmod", ["+a", "everyone allow read", f.config.claimsFile], { stdio: "pipe" });
  const acl = file => execFileSync("ls", ["-lde", file], { encoding: "utf8" }).split("\n").filter(line => /^\s*\d+:/.test(line));
  const before = acl(f.config.claimsFile); assert.ok(before.length);
  assert.equal(amend(f.claim.id, { config: f.config, paths: "a.txt" }).ok, true);
  assert.deepEqual(acl(f.config.claimsFile), before);
});
test("CLI amendment probes an external worktree even with an internal repository", async () => {
  const file = path.resolve(__dirname, "../bin/git-manager.js"), localRequire = createRequire(file);
  const probes = [], applied = [], claim = { repo: "/tmp/scope-repo", worktree: "/Volumes/ScopeOffline/worktree" };
  let output = "";
  const context = vm.createContext({ module: { exports: {} }, __dirname: path.dirname(file), process: { cwd: () => claim.repo, env: {}, stdout: { write: value => { output += value; } } }, require(id) {
    if (id === "../src/checkin") return { resolveClaim: () => claim };
    if (id === "../src/claim-scope") return { amendScope: (...args) => { applied.push(args); return { ok: true }; } };
    if (id.endsWith("volume-probe")) return { volumeRootOf: value => value.startsWith("/Volumes/ScopeOffline/") ? "/Volumes/ScopeOffline" : null, createVolumeProbe: () => ({ registerTargets: values => probes.push(...values), prime: async () => {}, checkRepo: async () => false, run: fn => fn() }) };
    return localRequire(id);
  } });
  vm.runInContext(fs.readFileSync(file, "utf8"), context);
  await context.module.exports.main(["amend-scope", "fixture", "--paths", "a.txt", "--json"]);
  assert.equal(JSON.parse(output).ok, false); assert.ok(probes.includes(claim.worktree)); assert.equal(applied.length, 0);
});
test("post-write access metadata mismatch refuses atomic replacement", t => {
  const f = fixture(t), amend = require("../src/claim-scope").amendScope;
  const before = fs.readFileSync(f.config.claimsFile), write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (file, ...args) => {
    const result = write(file, ...args);
    if (String(file).startsWith(f.config.claimsFile + ".scope-")) fs.chmodSync(file, 0o600);
    return result;
  });
  fs.chmodSync(f.config.claimsFile, 0o664);
  const result = amend(f.claim.id, { config: f.config, paths: "a.txt" });
  assert.equal(result.ok, false); assert.match(result.reasons.join(" "), /access metadata after writing/);
  assert.deepEqual(fs.readFileSync(f.config.claimsFile), before);
  assert.equal(fs.statSync(f.config.claimsFile).mode & 0o7777, 0o664);
});
test("governed claims keep the original classified program lane", t => {
  const f = fixture(t), amend = require("../src/claim-scope").amendScope;
  f.config.programBoundaries = [{ repo: f.repo, requirePaths: true, programs: { course: { roots: ["course"] } } }];
  const store = JSON.parse(fs.readFileSync(f.config.claimsFile)); store.claims[0].paths = ["course"]; fs.writeFileSync(f.config.claimsFile, JSON.stringify(store));
  assert.equal(amend(f.claim.id, { config: f.config, paths: "course/a.txt" }).ok, true);
  assert.equal(amend(f.claim.id, { config: f.config, paths: "a.txt" }).ok, false);
});
test("merged upstream work is audited without reserving other authors' paths", t => {
  const f = fixture(t), amend = require("../src/claim-scope").amendScope;
  fs.writeFileSync(path.join(f.repo, "upstream.txt"), "other author\n"); g(f.repo, "add", "."); g(f.repo, "commit", "-m", "other owner");
  fs.writeFileSync(path.join(f.worktree, "a.txt"), "claim contribution\n"); g(f.worktree, "add", "."); g(f.worktree, "commit", "-m", "claim contribution");
  g(f.worktree, "merge", "main", "--no-edit");
  assert.equal(amend(f.claim.id, { config: f.config, paths: "a.txt" }).ok, true);
});
test("a recovered baseSha cannot hide current committed claim contributions", t => {
  const f = fixture(t), amend = require("../src/claim-scope").amendScope;
  fs.writeFileSync(path.join(f.worktree, "b.txt"), "committed before recovery\n"); g(f.worktree, "add", "."); g(f.worktree, "commit", "-m", "before pending recovery");
  const store = JSON.parse(fs.readFileSync(f.config.claimsFile)); store.claims[0].baseSha = g(f.worktree, "rev-parse", "HEAD"); fs.writeFileSync(f.config.claimsFile, JSON.stringify(store));
  assert.equal(amend(f.claim.id, { config: f.config, paths: "a.txt" }).ok, false);
});
test("reverted contribution remains auditable without reserving the retired path", t => {
  const f = fixture(t), amend = require("../src/claim-scope").amendScope;
  fs.writeFileSync(path.join(f.worktree, "retired.txt"), "temporary contribution\n");
  g(f.worktree, "add", "."); g(f.worktree, "commit", "-m", "temporary contribution");
  g(f.worktree, "revert", "HEAD", "--no-edit");
  const result = amend(f.claim.id, { config: f.config, paths: "a.txt" });
  assert.equal(result.ok, true);
  assert.ok(result.amendment.evidence.historicalPaths.includes("retired.txt"));
  assert.equal(result.amendment.evidence.changedPaths.includes("retired.txt"), false);
});
test("claims sweep retains a worktree path replaced by a regular file", t => {
  const f = fixture(t), store = JSON.parse(fs.readFileSync(f.config.claimsFile));
  const replacement = path.join(f.root, "replacement"); fs.writeFileSync(replacement, "keep\n");
  store.claims[0].worktree = replacement; fs.writeFileSync(f.config.claimsFile, JSON.stringify(store));
  assert.equal(checkin.sweepClaims({ config: f.config }).closed, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.config.claimsFile)).claims[0].status, "active");
  assert.equal(fs.readFileSync(replacement, "utf8"), "keep\n");
});
test("claims sweep holds absent external worktrees through the physical mount alias", t => {
  const f = fixture(t), store = JSON.parse(fs.readFileSync(f.config.claimsFile)), stat = fs.statSync;
  const alias = "/System/Volumes/Data/Volumes/ScopeOffline/worktree";
  store.claims[0].worktree = alias; fs.writeFileSync(f.config.claimsFile, JSON.stringify(store));
  t.mock.method(fs, "statSync", (file, ...args) => {
    if (String(file) === alias) { const error = Error("missing"); error.code = "ENOENT"; throw error; }
    if (["/Volumes/ScopeOffline", "/Volumes"].includes(String(file))) return { isDirectory: () => true, dev: 100 };
    return stat(file, ...args);
  });
  assert.equal(checkin.sweepClaims({ config: f.config }).closed, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.config.claimsFile)).claims[0].status, "active");
});
test("claims sweep retains an inaccessible worktree with a fully merged branch", t => {
  const f = fixture(t), real = fs.statSync, exists = fs.existsSync;
  t.mock.method(fs, "existsSync", (file, ...args) => String(file) === f.worktree ? false : exists(file, ...args));
  t.mock.method(fs, "statSync", (file, ...args) => { if (String(file) === f.worktree) { const error = new Error("owner access unavailable"); error.code = "EACCES"; throw error; } return real(file, ...args); });
  const result = checkin.sweepClaims({ config: f.config });
  assert.equal(result.closed, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.config.claimsFile)).claims[0].status, "active");
});
test("exact owner can narrow an unknown reservation with dry-run and audit evidence", t => {
  const f = fixture(t), amend = require("../src/claim-scope").amendScope;
  fs.writeFileSync(path.join(f.worktree, "a.txt"), "owner edit\n");
  const before = fs.readFileSync(f.config.claimsFile, "utf8");
  const preview = amend(f.claim.id, { config: f.config, paths: "a.txt", session: f.session, dryRun: true });
  assert.equal(preview.ok, true); assert.equal(fs.readFileSync(f.config.claimsFile, "utf8"), before);
  const done = amend(f.claim.id, { config: f.config, paths: "a.txt", session: f.session });
  assert.equal(done.ok, true); assert.deepEqual(done.claim.paths, ["a.txt"]);
  assert.ok(done.claim.scopeAmendments[0].evidence.indexSha256);
  assert.equal(fs.readFileSync(path.join(f.worktree, "a.txt"), "utf8"), "owner edit\n");
});
test("exact owner can narrow an expired concrete reservation without reactivation", t => {
  const f = fixture(t), amend = require("../src/claim-scope").amendScope;
  const contribution = path.join(f.worktree, "app/tests/cleanup-cli.js");
  fs.mkdirSync(path.dirname(contribution), { recursive: true }); fs.writeFileSync(contribution, "owner cleanup edit\n");
  const store = JSON.parse(fs.readFileSync(f.config.claimsFile));
  const claim = store.claims.find(row => row.id === f.claim.id);
  claim.paths = ["app/tests"];
  claim.status = "expired"; claim.expiredAt = "2026-10-13T00:00:00.000Z"; claim.lastActivityAt = "2026-10-12T00:00:00.000Z";
  const expiryUpdatedAt = claim.updatedAt;
  store.claims.push({ ...claim, id: "other-active", task: "other", status: "active", paths: ["app/tests/other.js"] });
  fs.writeFileSync(f.config.claimsFile, JSON.stringify(store));
  const before = fs.statSync(f.config.claimsFile);
  const result = amend(f.claim.id, { config: f.config, paths: ["app/tests/cleanup-cli.js"], session: f.session });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.claim.paths, ["app/tests/cleanup-cli.js"]);
  assert.equal(result.claim.status, "expired"); assert.equal(result.claim.expiredAt, "2026-10-13T00:00:00.000Z");
  assert.equal(result.claim.updatedAt, expiryUpdatedAt); assert.equal(result.claim.lastActivityAt, "2026-10-12T00:00:00.000Z");
  const after = fs.statSync(f.config.claimsFile);
  assert.equal(after.mode & 0o7777, before.mode & 0o7777); assert.equal(after.uid, before.uid); assert.equal(after.gid, before.gid);
  assert.equal(fs.readFileSync(contribution, "utf8"), "owner cleanup edit\n");
});
test("expired scope narrowing refuses equal, expanded, unknown, non-owner and omitted-contribution scopes", t => {
  const amend = require("../src/claim-scope").amendScope;
  for (const [previous, requested, actor, contribution] of [
    [["app/tests"], ["app/tests"], null, null],
    [["app/tests"], ["app/tests", "outside"], null, null],
    [[], ["app/tests/cleanup-cli.js"], null, null],
    [["."], ["app/tests/cleanup-cli.js"], null, null],
    [["app/tests"], ["app/tests/cleanup-cli.js"], "different-actor", null],
    [["app/tests"], ["app/tests/cleanup-cli.js"], null, "app/tests/other.js"],
  ]) {
    const f = fixture(t), file = path.join(f.worktree, "app/tests/cleanup-cli.js");
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "available\n");
    const claim = expireReservation(f, previous);
    if (actor) { claim.actor = actor; const store = JSON.parse(fs.readFileSync(f.config.claimsFile)); store.claims[0].actor = actor; fs.writeFileSync(f.config.claimsFile, JSON.stringify(store)); }
    if (contribution) { const changed = path.join(f.worktree, contribution); fs.writeFileSync(changed, "outside requested narrow scope\n"); }
    const before = fs.readFileSync(f.config.claimsFile);
    const result = amend(f.claim.id, { config: f.config, paths: requested, session: f.session });
    assert.equal(result.ok, false, JSON.stringify(result)); assert.deepEqual(fs.readFileSync(f.config.claimsFile), before);
  }
});
test("expired scope narrowing still covers staged source changes and refuses a changed branch ref", t => {
  const amend = require("../src/claim-scope").amendScope;
  const f = fixture(t), candidate = path.join(f.worktree, "app/tests/cleanup-cli.js");
  fs.mkdirSync(path.dirname(candidate), { recursive: true }); fs.writeFileSync(candidate, "candidate\n");
  expireReservation(f, ["app/tests"]);
  const staged = path.join(f.worktree, "app/tests/other.js"); fs.writeFileSync(staged, "staged outside candidate\n"); g(f.worktree, "add", staged);
  const before = fs.readFileSync(f.config.claimsFile);
  assert.equal(amend(f.claim.id, { config: f.config, paths: ["app/tests/cleanup-cli.js"], session: f.session }).ok, false);
  assert.deepEqual(fs.readFileSync(f.config.claimsFile), before);

  const second = fixture(t); expireReservation(second, ["app/tests"]);
  g(second.worktree, "checkout", "-b", "codex/changed-ref");
  const unchanged = fs.readFileSync(second.config.claimsFile);
  const result = amend(second.claim.id, { config: second.config, paths: ["app/tests/cleanup-cli.js"], session: second.session });
  assert.equal(result.ok, false); assert.match(result.reasons.join(" "), /scope amendment held/); assert.deepEqual(fs.readFileSync(second.config.claimsFile), unchanged);
});
test("expired narrowing cannot take another active claim path or an unknown active scope", t => {
  const amend = require("../src/claim-scope").amendScope;
  for (const activePaths of [["app/tests/other.js"], []]) {
    const f = fixture(t), requested = path.join(f.worktree, "app/tests/other.js");
    fs.mkdirSync(path.dirname(requested), { recursive: true }); fs.writeFileSync(requested, "other active file\n");
    const claim = expireReservation(f, ["app/tests"]);
    const store = JSON.parse(fs.readFileSync(f.config.claimsFile));
    store.claims.push({ ...claim, id: "active-owner", task: "active", status: "active", paths: activePaths, actor: "someone-else", session: "someone-else" });
    fs.writeFileSync(f.config.claimsFile, JSON.stringify(store));
    const before = fs.readFileSync(f.config.claimsFile);
    const result = amend(f.claim.id, { config: f.config, paths: ["app/tests/other.js"], session: f.session });
    assert.equal(result.ok, false); assert.match(result.reasons.join(" "), /overlaps active claim/);
    assert.deepEqual(fs.readFileSync(f.config.claimsFile), before);
  }
});
test("scope amendment refuses wrong actual owner and caller session", t => {
  const f = fixture(t), amend = require("../src/claim-scope").amendScope;
  const before = fs.readFileSync(f.config.claimsFile, "utf8");
  assert.equal(amend(f.claim.id, { config: f.config, paths: "a.txt", session: "another-session" }).ok, false);
  assert.equal(fs.readFileSync(f.config.claimsFile, "utf8"), before);
  const store = JSON.parse(before); store.claims[0].actor = "another-account"; fs.writeFileSync(f.config.claimsFile, JSON.stringify(store));
  assert.equal(amend(f.claim.id, { config: f.config, paths: "a.txt", env: { ALLSORTED_ACTOR: "another-account" }, session: f.session }).ok, false);
});
test("scope must retain committed changes, staged rename sources and working paths", t => {
  const f = fixture(t), amend = require("../src/claim-scope").amendScope;
  g(f.worktree, "mv", "a.txt", "b.txt");
  assert.equal(amend(f.claim.id, { config: f.config, paths: "b.txt" }).ok, false);
  assert.equal(amend(f.claim.id, { config: f.config, paths: "a.txt,b.txt" }).ok, true);
  g(f.worktree, "commit", "-m", "rename");
  fs.writeFileSync(path.join(f.worktree, "c.txt"), "new\n");
  assert.equal(amend(f.claim.id, { config: f.config, paths: "a.txt,b.txt" }).ok, false);
  assert.equal(amend(f.claim.id, { config: f.config, paths: "a.txt,b.txt,c.txt" }).ok, true);
});
test("scope expansion retains active and expired overlaps and narrowing keeps unknown holds", t => {
  const f = fixture(t), amend = require("../src/claim-scope").amendScope;
  let store = JSON.parse(fs.readFileSync(f.config.claimsFile));
  store.claims.push({ ...f.claim, id: "other", session: "other", paths: [], status: "expired" }); fs.writeFileSync(f.config.claimsFile, JSON.stringify(store));
  assert.equal(amend(f.claim.id, { config: f.config, paths: "a.txt" }).ok, true);
  const before = fs.readFileSync(f.config.claimsFile, "utf8");
  assert.equal(amend(f.claim.id, { config: f.config, paths: "a.txt,b.txt", allowOverlap: true }).ok, false);
  assert.equal(fs.readFileSync(f.config.claimsFile, "utf8"), before);
});
test("scope refuses escaping paths, symlinks, and active operations", t => {
  const f = fixture(t), amend = require("../src/claim-scope").amendScope;
  fs.symlinkSync(f.root, path.join(f.worktree, "escape"));
  for (const paths of ["../outside", ".", "*.txt", ".git", "escape/new.txt"]) assert.equal(amend(f.claim.id, { config: f.config, paths }).ok, false, paths);
  const admin = g(f.worktree, "rev-parse", "--absolute-git-dir"); fs.writeFileSync(path.join(admin, "MERGE_HEAD"), g(f.worktree, "rev-parse", "HEAD"));
  assert.equal(amend(f.claim.id, { config: f.config, paths: "a.txt,escape" }).ok, false);
});
