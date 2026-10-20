"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const checkin = require("../src/checkin");
const fs = require("node:fs");
const os = require("node:os");
test("check-in exposes the lifecycle contract", () => {
  for (const name of ["start", "finish", "release", "sweepClaims", "unclaimedCommitFindings", "withClaimsLock"]) assert.equal(typeof checkin[name], "function", name);
});

const path = require("node:path");
const { execFileSync, spawnSync, spawn } = require("node:child_process");
// Release fixtures must never select a real operator backup volume. Selector behavior
// has its own backup-storage tests; here exercise the full local preservation path.
test.mock.method(require("../src/backup-storage"), "selectRoot", (_source, fallback) => ({ root: fallback, external: false, reason: "isolated test fixture" }));
const identity = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
Object.assign(process.env, identity);
process.env.GIT_MANAGER_CARRY_BACKUP_DIR = fs.realpathSync(os.tmpdir()) + "/gm-carry-tests-never-real"; // spawned CLIs never touch a real backup directory
const g = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, ...identity }, stdio: ["ignore", "pipe", "pipe"] }).trim();
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gm-checkin-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo"); fs.mkdirSync(repo);
  g(repo, "-c", "init.defaultBranch=main", "init");
  fs.writeFileSync(path.join(repo, "file.txt"), "base\n");
  g(repo, "add", ".");
  execFileSync("git", ["-C", repo, "commit", "-m", "initial"], { env: { ...process.env, ...identity, GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" }, stdio: "pipe" });
  const config = { claimsFile: path.join(root, "claims.json"), worktreeRoot: path.join(root, "trees"), carryBackupDir: path.join(root, "carry"), enforcedRepos: [repo], ownerSessions: [], staleClaimHours: 8, recentCommitHours: 3, unclaimedWindowHours: 2 };
  const opts = { config, env: { ALLSORTED_ACTOR: "joe" }, owner: "codex", session: "test-session", task: "work" };
  const start = (extra = {}) => checkin.start(repo, { ...opts, ...extra });
  return { root, repo, config, opts, start };
}
function commit(repo, subject = "feat: task", file = "file.txt", content = "task\n") {
  fs.writeFileSync(path.join(repo, file), content); g(repo, "add", file); g(repo, "commit", "-m", subject);
}
function refused(result, pattern) { assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.refused, true); assert.match(result.reasons.join("\n"), pattern); }

test("identity precedence and boundary-safe owner paths", () => {
  assert.equal(checkin.actor({ ALLSORTED_ACTOR: "someone" }), "someone");
  assert.equal(checkin.sessionLabel({ session: "explicit" }, { ALLSORTED_SESSION_NAME: "env" }), "explicit");
  assert.equal(checkin.defaultOwnerPrefix({ CLAUDE_CODE_TEST: "1", CODEX_SESSION_ID: "x" }, "joe"), "claude");
  assert.equal(checkin.defaultOwnerPrefix({ CODEX_TEST: "1" }, "joe"), "codex");
  assert.equal(checkin.ownerFor(["/tmp/owner-other"], { ownerSessions: [{ name: "owner", paths: ["/tmp/owner"] }] }), null);
});
test("start creates isolated worktree, exact claim schema and CLI cd line", t => {
  const f = fixture(t), r = f.start(); assert.equal(r.ok, true);
  assert.equal(r.worktree, path.join(f.config.worktreeRoot, "repo", "work"));
  assert.equal(g(r.worktree, "branch", "--show-current"), "codex/work");
  const store = checkin.loadClaims(f.config.claimsFile);
  assert.deepEqual(store.enforcedRepos, [f.repo]); assert.equal(store.schemaVersion, 1); assert.ok(store.updatedAt);
  assert.deepEqual(Object.keys(store.claims[0]).sort(), ["id", "repo", "repoName", "task", "owner", "branch", "base", "baseSha", "targetBranch", "worktree", "paths", "actor", "session", "ownerSession", "status", "createdAt", "updatedAt", "lastActivityAt"].sort());
  const cli = spawnSync(process.execPath, [path.resolve(__dirname, "../bin/git-manager.js"), "start", f.repo, "--task", "cli", "--owner", "codex"], { encoding: "utf8", env: { ...process.env, GIT_MANAGER_CLAIMS_FILE: f.config.claimsFile, GIT_MANAGER_WORKTREE_ROOT: f.config.worktreeRoot, GIT_MANAGER_CONFIG_JSON: JSON.stringify(f.config) } });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.equal(cli.stdout.trim().split("\n").at(-1), `cd ${path.join(f.config.worktreeRoot, "repo", "cli")}`);
});
test("start refuses invalid names, existing branch, occupied path and non-repository", t => {
  const f = fixture(t);
  refused(f.start({ task: "../bad" }), /invalid task/); refused(f.start({ owner: "UPPER" }), /invalid owner/);
  g(f.repo, "branch", "codex/work"); refused(f.start(), /branch codex\/work already exists/);
  const occupied = path.join(f.config.worktreeRoot, "repo", "occupied"); fs.mkdirSync(occupied, { recursive: true });
  refused(f.start({ task: "occupied" }), /worktree path exists/);
  refused(checkin.start(f.root, f.opts), /not a git repository/);
});
test("start rejects competing task and path claims, allows explicit overlap, and reuses own claim", t => {
  const f = fixture(t), r = f.start({ paths: ["src"] }); assert.equal(r.ok, true);
  const before = fs.readFileSync(f.config.claimsFile, "utf8");
  assert.equal(f.start().reused, true); assert.equal(fs.readFileSync(f.config.claimsFile, "utf8"), before);
  refused(f.start({ session: "another" }), /task already claimed/);
  refused(f.start({ task: "other", session: "another", paths: ["src/deep"] }), /path overlap/);
  assert.equal(f.start({ task: "other", session: "another", paths: ["src/deep"], allowOverlap: true }).ok, true);
});
test("start respects owner-session mapping for input and declared areas", t => {
  const f = fixture(t); f.config.allowSafeOwnershipTakeover = false; f.config.ownerSessions = [{ name: "MHQ homepage", paths: [path.join(f.repo, "area")] }];
  fs.mkdirSync(path.join(f.repo, "area"));
  const held = f.start({ paths: ["area/file"] });
  refused(held, /owned by the "MHQ homepage" session/);
  assert.equal(held.continuation.kind, "owner_handoff");
  assert.equal(held.continuation.preserved.existingWorkUntouched, true);
  assert.match(held.continuation.next, /named owner/);
  refused(checkin.start(path.join(f.repo, "area"), f.opts), /MHQ homepage/);
  assert.equal(f.start({ paths: ["area/file"], asOwner: "mhq HOMEPAGE" }).claim.ownerSession, "MHQ homepage");
});
test("reserved owner permits isolated responsibility under the actual identity without touching work", t => {
  const f = fixture(t); f.config.ownerSessions = [{ name: "Reserved", paths: [f.repo] }];
  fs.writeFileSync(path.join(f.repo, "file.txt"), "staged version\n"); g(f.repo, "add", "file.txt");
  fs.writeFileSync(path.join(f.repo, "file.txt"), "working version\n");
  fs.writeFileSync(path.join(f.repo, "untracked.txt"), "untracked version\n");
  const head = g(f.repo, "rev-parse", "HEAD"), index = fs.readFileSync(path.join(f.repo, ".git/index"));
  const r = f.start({ paths: ["file.txt"] }); assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.claim.session, "test-session"); assert.equal(r.claim.actor, "joe");
  assert.equal(r.claim.ownerSession, "Reserved");
  assert.equal(r.claim.ownershipTakeover.reservedOwner, "Reserved");
  assert.equal(r.claim.ownershipTakeover.mode, "isolated-worktree");
  assert.match(r.health.warnings.join("\n"), /taking responsibility.*Reserved/);
  assert.equal(g(f.repo, "rev-parse", "HEAD"), head);
  assert.ok(fs.readFileSync(path.join(f.repo, ".git/index")).equals(index));
  assert.equal(g(f.repo, "show", ":file.txt"), "staged version");
  assert.equal(fs.readFileSync(path.join(f.repo, "file.txt"), "utf8"), "working version\n");
  assert.equal(fs.readFileSync(path.join(f.repo, "untracked.txt"), "utf8"), "untracked version\n");
});
test("takeover cannot bypass overlap and treats unspecified scope as the whole repository", t => {
  for (const existingPaths of [[], ["area"]]) {
    const f = fixture(t); f.config.ownerSessions = [{ name: "Reserved", paths: [f.repo] }];
    assert.equal(f.start({ asOwner: "Reserved", paths: existingPaths }).ok, true);
    refused(f.start({ task: "takeover", session: "other", paths: ["area/file"], allowOverlap: true }), /path overlap/);
    refused(f.start({ task: "unscoped", session: "other" }), /path overlap/);
  }
});
test("takeover dry run is read-only and a disjoint scoped claim can proceed", t => {
  const f = fixture(t); f.config.ownerSessions = [{ name: "Reserved", paths: [f.repo] }];
  const preview = f.start({ dryRun: true, paths: ["area"] }); assert.equal(preview.ok, true);
  assert.equal(fs.existsSync(f.config.claimsFile), false); assert.equal(fs.existsSync(f.config.worktreeRoot), false);
  assert.equal(f.start({ paths: ["area"] }).ok, true);
  assert.equal(f.start({ task: "disjoint", session: "other", paths: ["elsewhere"] }).ok, true);
  refused(f.start({ task: "bypass", session: "third", paths: ["area"], asOwner: "Reserved", allowOverlap: true }), /path overlap/);
});
test("takeover rechecks newly arrived unknown-scope claims under the reservation lock", t => {
  const f = fixture(t); f.config.ownerSessions = [{ name: "Reserved", paths: [f.repo] }]; let injected = false;
  const subject = instrumentedCheckin((cmd, args, opts, run) => {
    const result = run();
    if (!injected && cmd === "git" && args[3] === "log") {
      injected = true;
      fs.writeFileSync(f.config.claimsFile, JSON.stringify({ schemaVersion: 1, released: [], claims: [{ id: "racer", repo: f.repo, task: "racer", actor: "other", session: "other", paths: [], worktree: path.join(f.root, "other"), status: "active" }] }));
    }
    return result;
  });
  refused(subject.start(f.repo, { ...f.opts, paths: ["area"], allowOverlap: true }), /path overlap.*racer/);
  assert.ok(injected); assert.equal(fs.existsSync(f.config.worktreeRoot), false);
});
test("expired takeover cannot reactivate over an unknown-scope active claim", t => {
  const f = fixture(t); f.config.ownerSessions = [{ name: "Reserved", paths: [f.repo] }];
  const r = f.start({ paths: ["area"] }); assert.equal(r.ok, true);
  const store = checkin.loadClaims(f.config.claimsFile); store.claims[0].status = "expired";
  store.claims.push({ ...store.claims[0], id: "other", task: "other", session: "other", paths: [], status: "active", ownershipTakeover: undefined });
  fs.writeFileSync(f.config.claimsFile, JSON.stringify(store));
  refused(f.start({ paths: ["area"], allowOverlap: true }), /reactivation blocked/);
  assert.equal(checkin.loadClaims(f.config.claimsFile).claims[0].status, "expired");
});
test("new reservation policy cannot reuse a legacy claim across an unknown-scope claim", t => {
  for (const state of ["active", "expired"]) {
    const f = fixture(t), r = f.start({ paths: ["area"] });
    f.config.ownerSessions = [{ name: "Reserved", paths: [f.repo] }];
    const store = checkin.loadClaims(f.config.claimsFile); store.claims[0].status = state;
    store.claims.push({ ...store.claims[0], id: "other", task: "other", session: "other", paths: [], status: "active" });
    fs.writeFileSync(f.config.claimsFile, JSON.stringify(store));
    refused(f.start({ paths: ["area"] }), /reactivation blocked/);
    assert.equal(checkin.loadClaims(f.config.claimsFile).claims[0].status, state);
  }
});
test("start warns about dirty primary, index lock and recent commits without refusing", t => {
  const f = fixture(t); commit(f.repo, "feat: recent");
  fs.writeFileSync(path.join(f.repo, "untracked"), "dirty");
  fs.writeFileSync(path.join(f.repo, ".git/index.lock"), "");
  const preview = f.start({ dryRun: true });
  assert.equal(preview.ok, true); assert.ok(preview.health.warnings.some(w => /index.lock/.test(w)));
  fs.unlinkSync(path.join(f.repo, ".git/index.lock"));
  const r = f.start(); assert.equal(r.ok, true); assert.match(r.health.warnings.join("\n"), /uncommitted file/); assert.match(r.collisions.warnings.join("\n"), /commit\(s\) landed/);
  assert.equal(fs.existsSync(path.join(r.worktree, "untracked")), false);
});
test("start refuses a primary with a real merge conflict", t => {
  const f = fixture(t); g(f.repo, "checkout", "-b", "conflict"); commit(f.repo, "side", "file.txt", "side\n"); g(f.repo, "checkout", "main"); commit(f.repo, "main", "file.txt", "main\n");
  assert.throws(() => g(f.repo, "merge", "conflict"));
  refused(f.start(), /mid-MERGE_HEAD/);
});
test("finish creates a two-parent merge and removes branch, worktree and active claim", t => {
  const f = fixture(t), r = f.start(); commit(r.worktree);
  const done = checkin.finish(r.claim.id, f.opts); assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(done.merged, true); assert.equal(done.commits, 1);
  assert.equal(g(f.repo, "show", "-s", "--format=%P", "main").split(" ").length, 2);
  assert.match(g(f.repo, "log", "-1", "--format=%s"), /git-manager finish/);
  assert.match(g(f.repo, "log", "--format=%s"), /feat: task/);
  assert.equal(fs.existsSync(r.worktree), false); assert.throws(() => g(f.repo, "show-ref", "--verify", "refs/heads/codex/work"));
  const store = checkin.loadClaims(f.config.claimsFile); assert.equal(store.claims.length, 0); assert.equal(store.released[0].releaseReason, "finished"); assert.equal(store.released[0].mergeCommit, done.mergeCommit);
});
test("finish preserves dirty work and returns a concrete recovery route", t => {
  const f = fixture(t), r = f.start();
  fs.writeFileSync(path.join(r.worktree, "dirty"), "working version\n");
  const result = checkin.finish(r.claim.id, f.opts);
  refused(result, /uncommitted changes/);
  assert.equal(result.continuation.kind, "uncommitted_work");
  assert.equal(result.continuation.preserved.claimId, r.claim.id);
  assert.equal(result.continuation.preserved.worktree, r.worktree);
  assert.equal(result.continuation.checkpoint.status, "created");
  assert.equal(g(r.worktree, "show", `${result.continuation.checkpoint.sha}:dirty`), "working version");
  assert.equal(fs.readFileSync(path.join(r.worktree, "dirty"), "utf8"), "working version\n");
  assert.equal(checkin.loadClaims(f.config.claimsFile).claims[0].status, "active");
});
test("finish refuses a wip tip", t => { const f = fixture(t), r = f.start(); commit(r.worktree, "wip(test): failing"); refused(checkin.finish(r.claim.id, f.opts), /tests are known failing/); });
test("finish refuses failing tests and retains their output", t => { const f = fixture(t), r = f.start(); refused(checkin.finish(r.claim.id, { ...f.opts, testCommand: "echo failure-evidence; exit 7" }), /failure-evidence/); assert.ok(fs.existsSync(r.worktree)); });
test("finish refuses wrong primary branch", t => { const f = fixture(t), r = f.start(); g(f.repo, "checkout", "-b", "other"); refused(checkin.finish(r.claim.id, f.opts), /primary is on other/); });
test("finish refuses dirty overlap in primary without losing either version", t => {
  const f = fixture(t), r = f.start(); commit(r.worktree); fs.writeFileSync(path.join(f.repo, "file.txt"), "another session\n");
  refused(checkin.finish(r.claim.id, f.opts), /same files.*file.txt/); assert.equal(fs.readFileSync(path.join(f.repo, "file.txt"), "utf8"), "another session\n");
});
function carryFixture(t) {
  const f = fixture(t); commit(f.repo, "lines", "file.txt", "a\nb\nc\nd\ne\n");
  const r = f.start(); commit(r.worktree, "feat: branch edit", "file.txt", "A\nb\nc\nd\ne\n");
  return { ...f, r, file: path.join(f.repo, "file.txt") };
}
test("finish carries another session's non-conflicting uncommitted edits across the merge", t => {
  const f = carryFixture(t); fs.writeFileSync(f.file, "a\nb\nc\nd\nE other session\n");
  const done = checkin.finish(f.r.claim.id, f.opts);
  assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(done.merged, true);
  assert.equal(fs.readFileSync(f.file, "utf8"), "A\nb\nc\nd\nE other session\n");
  assert.equal(g(f.repo, "show", "main:file.txt"), "A\nb\nc\nd\ne");
  assert.equal(g(f.repo, "status", "--porcelain"), "M file.txt");
  assert.equal(done.carriedFiles.length, 1); assert.equal(done.carriedFiles[0].file, "file.txt");
  assert.equal(done.carryBackupDir, path.join(f.config.carryBackupDir, f.r.claim.id.replace(/[^A-Za-z0-9._-]/g, "_")));
  assert.equal(fs.readFileSync(done.carriedFiles[0].backup, "utf8"), "a\nb\nc\nd\nE other session\n");
  assert.equal(g(f.repo, "cat-file", "blob", done.carriedFiles[0].blob), "a\nb\nc\nd\nE other session");
  assert.deepEqual(done.warnings, []);
});
test("finish holds conflicting carried edits with a backup and leaves the working copy byte-identical", t => {
  const f = carryFixture(t), head = g(f.repo, "rev-parse", "main"); fs.writeFileSync(f.file, "Z other\nb\nc\nd\ne\n");
  const before = fs.readFileSync(f.file), result = checkin.finish(f.r.claim.id, f.opts);
  refused(result, /same files in the primary checkout that cannot be carried.*file\.txt \(their edits conflict.*backup .*another session.*only a human/s);
  assert.equal(result.continuation.kind, "uncommitted_work");
  assert.ok(fs.readFileSync(f.file).equals(before)); assert.equal(g(f.repo, "rev-parse", "main"), head);
  assert.ok(fs.readFileSync(path.join(result.carryBackupDir, "file.txt")).equals(before)); assert.ok(fs.existsSync(f.r.worktree));
});
test("finish restores carried working copies when the merge fails after restore", t => {
  const f = carryFixture(t), head = g(f.repo, "rev-parse", "main"); fs.writeFileSync(f.file, "a\nb\nc\nd\nE other session\n");
  const before = fs.readFileSync(f.file); let sawBase = false;
  const subject = instrumentedCheckin((cmd, args, opts, run) => {
    if (cmd === "git" && args[3] === "merge") { sawBase = fs.readFileSync(f.file, "utf8") === "a\nb\nc\nd\ne\n"; const error = new Error("merge failed"); error.stderr = "simulated refusal"; throw error; }
    return run();
  });
  refused(subject.finish(f.r.claim.id, f.opts), /merge refused by git: simulated refusal/);
  assert.ok(sawBase); assert.ok(fs.readFileSync(f.file).equals(before)); assert.equal(g(f.repo, "rev-parse", "main"), head);
});
test("finish leaves a concurrent writer's content in place and warns with the backup", t => {
  const f = carryFixture(t); fs.writeFileSync(f.file, "a\nb\nc\nd\nE other session\n");
  const done = checkin.finish(f.r.claim.id, { ...f.opts, beforeCarryReapply: () => fs.writeFileSync(f.file, "concurrent\n") });
  assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(fs.readFileSync(f.file, "utf8"), "concurrent\n");
  assert.match(done.warnings.join("\n"), /file\.txt changed between the merge and re-applying.*their version is at .*file\.txt/);
  assert.deepEqual(done.carriedFiles, []); assert.equal(done.carrySkipped[0].reason, "changed by another writer");
  assert.equal(fs.readFileSync(done.carrySkipped[0].backup, "utf8"), "a\nb\nc\nd\nE other session\n");
});
function twoFileCarry(t) {
  const f = fixture(t); commit(f.repo, "a", "a.txt", "1\n2\n3\n4\n5\n"); commit(f.repo, "b", "b.txt", "1\n2\n3\n4\n5\n");
  const r = f.start(); commit(r.worktree, "feat: a", "a.txt", "ONE\n2\n3\n4\n5\n"); commit(r.worktree, "feat: b", "b.txt", "ONE\n2\n3\n4\n5\n");
  const a = path.join(f.repo, "a.txt"), b = path.join(f.repo, "b.txt");
  fs.writeFileSync(a, "1\n2\n3\n4\nFIVE a\n"); fs.writeFileSync(b, "1\n2\n3\n4\nFIVE b\n");
  t.after(() => { try { fs.chmodSync(b, 0o644); } catch { /* removed */ } });
  return { ...f, r, a, b, before: [fs.readFileSync(a), fs.readFileSync(b)], head: g(f.repo, "rev-parse", "main") };
}
test("finish pre-checks writability of every carried file before touching any (P1-a)", t => {
  const f = twoFileCarry(t); fs.chmodSync(f.b, 0o444);
  refused(checkin.finish(f.r.claim.id, f.opts), /cannot be carried.*b\.txt \(not writable; backup /s);
  assert.ok(fs.readFileSync(f.a).equals(f.before[0])); assert.ok(fs.readFileSync(f.b).equals(f.before[1])); assert.equal(g(f.repo, "rev-parse", "main"), f.head);
});
test("finish restores every touched file when a carry write throws mid-loop (P1-a)", t => {
  const f = twoFileCarry(t); let calls = 0;
  const subject = instrumentedCheckin((cmd, args, opts, run) => {
    if (cmd === "git" && args[0] === "merge-file" && ++calls === 2) fs.chmodSync(f.b, 0o444);
    return run();
  });
  const result = subject.finish(f.r.claim.id, f.opts);
  refused(result, /carrying the other session's uncommitted edits across the merge failed.*EACCES.*backups of the other session's edits under /s);
  assert.ok(fs.readFileSync(f.a).equals(f.before[0])); assert.ok(fs.readFileSync(f.b).equals(f.before[1])); assert.equal(g(f.repo, "rev-parse", "main"), f.head);
  assert.ok(fs.readFileSync(path.join(result.carryBackupDir, "b.txt")).equals(f.before[1]));
});
test("finish names a failing merge hook instead of reporting conflicts (P3)", t => {
  const f = carryFixture(t); fs.writeFileSync(f.file, "a\nb\nc\nd\nE other session\n"); const before = fs.readFileSync(f.file), head = g(f.repo, "rev-parse", "main");
  const hook = path.join(f.repo, ".git/hooks/pre-merge-commit"); fs.writeFileSync(hook, "#!/bin/sh\necho hook-says-no >&2\nexit 1\n"); fs.chmodSync(hook, 0o755);
  const result = checkin.finish(f.r.claim.id, f.opts);
  refused(result, /no content conflicts \(a hook/); assert.doesNotMatch(result.reasons.join("\n"), /merge conflicts with/);
  assert.ok(fs.readFileSync(f.file).equals(before)); assert.equal(g(f.repo, "rev-parse", "main"), head);
  assert.equal(fs.existsSync(path.join(f.repo, ".git/MERGE_HEAD")), false);
});
test("finish still holds staged and untracked overlaps without touching them", t => {
  const f = carryFixture(t); fs.writeFileSync(f.file, "a\nb\nc\nd\nstaged\n"); g(f.repo, "add", "file.txt");
  refused(checkin.finish(f.r.claim.id, f.opts), /staged changes from another session/);
  assert.equal(g(f.repo, "show", ":file.txt"), "a\nb\nc\nd\nstaged"); assert.equal(fs.readFileSync(f.file, "utf8"), "a\nb\nc\nd\nstaged\n");
  const u = fixture(t), r = u.start(); commit(r.worktree, "feat: new", "new.txt", "branch\n"); fs.writeFileSync(path.join(u.repo, "new.txt"), "untracked other\n");
  refused(checkin.finish(r.claim.id, u.opts), /new\.txt \(untracked; backup /);
  assert.equal(fs.readFileSync(path.join(u.repo, "new.txt"), "utf8"), "untracked other\n");
});
test("finish with dirty but non-overlapping primary files is unchanged", t => {
  const f = carryFixture(t); fs.writeFileSync(path.join(f.repo, "other.txt"), "unrelated\n");
  const done = checkin.finish(f.r.claim.id, f.opts);
  assert.equal(done.ok, true, JSON.stringify(done)); assert.deepEqual(done.carriedFiles, []); assert.equal(done.carryBackupDir, null);
  assert.equal(fs.readFileSync(path.join(f.repo, "other.txt"), "utf8"), "unrelated\n"); assert.equal(fs.existsSync(f.config.carryBackupDir), false);
});
test("finish aborts merge conflicts and retains clean primary, worktree and claim", t => {
  const f = fixture(t), r = f.start(); commit(r.worktree); commit(f.repo, "other session", "file.txt", "primary\n"); const head = g(f.repo, "rev-parse", "HEAD");
  const result = checkin.finish(r.claim.id, f.opts);
  refused(result, /merge conflicts.*file.txt/s);
  assert.equal(result.continuation.kind, "merge_conflict");
  assert.equal(result.continuation.preserved.branch, r.claim.branch);
  assert.match(result.continuation.next, /resolve the named files by intent/);
  assert.equal(g(f.repo, "status", "--porcelain"), ""); assert.equal(fs.existsSync(path.join(f.repo, ".git/MERGE_HEAD")), false); assert.equal(g(f.repo, "rev-parse", "HEAD"), head);
  assert.ok(fs.existsSync(r.worktree)); assert.equal(checkin.loadClaims(f.config.claimsFile).claims[0].status, "active");
});
test("finish empty claim from cwd without generating a merge", t => {
  const f = fixture(t), r = f.start(); const head = g(f.repo, "rev-parse", "HEAD"); const done = checkin.finish(undefined, { ...f.opts, cwd: r.worktree });
  assert.equal(done.ok, true); assert.equal(done.merged, false); assert.equal(done.mergeCommit, null); assert.equal(g(f.repo, "rev-parse", "HEAD"), head);
});
test("release archives unique commits and the archive ref restores them exactly", t => {
  const f = fixture(t), r = f.start(); commit(r.worktree); commit(r.worktree, "feat: second", "two.txt", "2\n");
  const tip = g(r.worktree, "rev-parse", "HEAD"), log = g(f.repo, "log", "--format=%H", r.claim.branch);
  const done = checkin.release(r.claim.id, { ...f.opts, force: true });
  assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(done.deletedBranch, true); assert.equal(fs.existsSync(r.worktree), false);
  assert.equal(done.archives.length, 1); assert.equal(done.archives[0].sha, tip);
  assert.match(done.archives[0].ref, /^refs\/archive\/git-manager\/repo-work-/);
  assert.equal(done.archives[0].restore, `git branch ${r.claim.branch} ${done.archives[0].ref}`);
  assert.throws(() => g(f.repo, "show-ref", "--verify", `refs/heads/${r.claim.branch}`));
  g(f.repo, "branch", "restored", done.archives[0].ref);
  assert.equal(g(f.repo, "log", "--format=%H", "restored"), log);
  assert.deepEqual(checkin.loadClaims(f.config.claimsFile).released[0].archives, done.archives);
  const empty = f.start({ task: "empty" }); const plain = checkin.release(empty.claim.id, f.opts);
  assert.equal(plain.ok, true); assert.equal(plain.claim.releaseReason, "abandoned"); assert.deepEqual(plain.archives, []);
});
test("release snapshots uncommitted worktree changes before removing it", t => {
  const f = fixture(t), r = f.start();
  fs.writeFileSync(path.join(r.worktree, "dirty"), "untracked work\n"); fs.writeFileSync(path.join(r.worktree, "file.txt"), "edited\n");
  const done = checkin.release(r.claim.id, f.opts);
  assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(fs.existsSync(r.worktree), false);
  const wip = done.archives.find(a => a.kind === "wip"); assert.ok(wip, JSON.stringify(done.archives));
  assert.match(wip.ref, /-wip$/);
  assert.equal(g(f.repo, "show", `${wip.ref}:dirty`), "untracked work"); assert.equal(g(f.repo, "show", `${wip.ref}:file.txt`), "edited");
});
test("release keeps an unreadable uncommitted file by moving the worktree aside (P1-b)", t => {
  const f = fixture(t), r = f.start(), locked = path.join(r.worktree, "locked.txt");
  fs.writeFileSync(locked, "secret work\n"); fs.chmodSync(locked, 0o000);
  const res = checkin.release(r.claim.id, f.opts);
  assert.equal(res.ok, true, JSON.stringify(res)); assert.ok(res.movedAside); assert.ok(!fs.existsSync(r.worktree));
  const kept = path.join(res.movedAside, "locked.txt"); t.after(() => { try { fs.chmodSync(kept, 0o644); } catch { /* gone */ } });
  fs.chmodSync(kept, 0o644); assert.equal(fs.readFileSync(kept, "utf8"), "secret work\n");
  assert.ok(res.warnings.some(w => /locked\.txt|snapshot/.test(w)), JSON.stringify(res.warnings));
  assert.equal(g(f.repo, "worktree", "list").includes(r.worktree), false);
});
test("release keeps a nested repository intact by moving the worktree aside (P1-c)", t => {
  const f = fixture(t), r = f.start(), sub = path.join(r.worktree, "sub"); fs.mkdirSync(sub);
  g(sub, "-c", "init.defaultBranch=main", "init"); commit(sub, "nested", "n.txt", "nested\n"); fs.writeFileSync(path.join(sub, "wip.txt"), "uncommitted\n");
  const res = checkin.release(r.claim.id, f.opts);
  assert.equal(res.ok, true, JSON.stringify(res)); assert.ok(res.nested.includes("sub"), JSON.stringify(res.nested));
  const kept = path.join(res.movedAside, "sub");
  assert.equal(g(kept, "log", "-1", "--format=%s"), "nested"); assert.equal(fs.readFileSync(path.join(kept, "wip.txt"), "utf8"), "uncommitted\n");
});
test("release finds a repo nested deep inside an ignored folder in a clean worktree and keeps it", t => {
  const f = fixture(t), r = f.start();
  fs.writeFileSync(path.join(r.worktree, ".gitignore"), "build/\n"); g(r.worktree, "add", ".gitignore"); g(r.worktree, "commit", "-m", "ignore build");
  const deep = path.join(r.worktree, "build", "vendor", "lib"); fs.mkdirSync(deep, { recursive: true });
  g(deep, "-c", "init.defaultBranch=main", "init"); commit(deep, "deep nested", "d.txt", "deep\n");
  const res = checkin.release(r.claim.id, f.opts);
  assert.equal(res.ok, true, JSON.stringify(res)); assert.ok(res.nested.some(n => n.includes(path.join("build", "vendor", "lib"))), JSON.stringify(res.nested));
  assert.equal(g(path.join(res.movedAside, "build", "vendor", "lib"), "log", "-1", "--format=%s"), "deep nested");
  assert.ok(res.archives.some(a => a.kind === "branch"));
});
test("clean release with an unreadable folder moves the worktree aside intact, never half-deletes", t => {
  const f = fixture(t), r = f.start();
  fs.writeFileSync(path.join(r.worktree, ".gitignore"), "locked/\n"); fs.mkdirSync(path.join(r.worktree, "src")); fs.writeFileSync(path.join(r.worktree, "src", "a.txt"), "a\n");
  g(r.worktree, "add", ".gitignore", "src"); g(r.worktree, "commit", "-m", "ignore locked");
  const locked = path.join(r.worktree, "locked"); fs.mkdirSync(locked); fs.writeFileSync(path.join(locked, "secret.txt"), "keep\n");
  const tracked = g(r.worktree, "ls-files").split("\n");
  let lockedNow = locked; fs.chmodSync(locked, 0o311);
  t.after(() => { try { fs.chmodSync(lockedNow, 0o755); } catch { /* already gone */ } });
  if (process.getuid && process.getuid() === 0) return t.skip("root reads every directory");
  const res = checkin.release(r.claim.id, f.opts);
  if (res.movedAside) lockedNow = path.join(res.movedAside, "locked");
  assert.equal(res.ok, true, JSON.stringify(res)); assert.ok(res.movedAside, JSON.stringify(res)); assert.ok(!fs.existsSync(r.worktree));
  assert.match(res.warnings.join("\n"), /unreadable path\(s\).*locked/);
  for (const file of tracked) assert.ok(fs.existsSync(path.join(res.movedAside, file)), `${file} missing after release`);
  assert.equal(fs.readFileSync(path.join(res.movedAside, "src", "a.txt"), "utf8"), "a\n");
  fs.chmodSync(lockedNow, 0o755); assert.equal(fs.readFileSync(path.join(lockedNow, "secret.txt"), "utf8"), "keep\n");
  const store = checkin.loadClaims(f.config.claimsFile);
  assert.ok(!store.claims.some(c => c.id === r.claim.id && ["active", "expired"].includes(c.status)), "claim archived");
});
test("clean release with no nested repos still removes the worktree normally", t => {
  const f = fixture(t), r = f.start(); const res = checkin.release(r.claim.id, f.opts);
  assert.equal(res.ok, true); assert.equal(res.movedAside, null); assert.ok(!fs.existsSync(r.worktree));
});
test("sweep expires idle claims without deleting work, read-only leaves store unchanged", t => {
  const f = fixture(t), r = f.start(), reports = []; const now = Date.now() + 10 * 3600000;
  const before = fs.readFileSync(f.config.claimsFile, "utf8");
  assert.equal(checkin.sweepClaims({ ...f.opts, readOnly: true, now }).expired, 1); assert.equal(fs.readFileSync(f.config.claimsFile, "utf8"), before);
  assert.equal(checkin.sweepClaims({ ...f.opts, now, report: (...a) => reports.push(a) }).expired, 1);
  assert.equal(checkin.loadClaims(f.config.claimsFile).claims[0].status, "expired"); assert.equal(reports[0][0], "claim-stale"); assert.ok(fs.existsSync(r.worktree));
  assert.equal(checkin.finish(r.claim.id, f.opts).ok, true);
});
test("sweep closes externally merged and removed worktrees", t => {
  const f = fixture(t), r = f.start(); commit(r.worktree); g(f.repo, "merge", "--no-ff", "--no-edit", r.claim.branch); g(f.repo, "worktree", "remove", r.worktree);
  const reports = []; assert.equal(checkin.sweepClaims({ ...f.opts, report: (...a) => reports.push(a) }).closed, 1);
  assert.equal(reports[0][0], "claim-closed-outside-finish"); assert.equal(checkin.loadClaims(f.config.claimsFile).released[0].releaseReason, "merged-outside-finish");
});
test("unclaimed findings aggregate direct commits and exclude finish merges and automation", t => {
  const f = fixture(t), reports = []; commit(f.repo, "feat: bypass");
  checkin.unclaimedCommitFindings({ ...f.opts, report: (...a) => reports.push(a) }); assert.equal(reports.length, 1); assert.equal(reports[0][0], "commits-without-claim"); assert.match(reports[0][3], /1 commit.*feat: bypass/);
});
test("finish merge and checkpoint do not generate unclaimed findings", t => {
  const f = fixture(t), r = f.start(); commit(r.worktree); assert.equal(checkin.finish(r.claim.id, f.opts).ok, true); commit(f.repo, "chore: checkpoint", "extra", "x");
  const reports = []; checkin.unclaimedCommitFindings({ ...f.opts, report: (...a) => reports.push(a) }); assert.deepEqual(reports, []);
});
test("unclaimed branches are included once per repo", t => {
  const f = fixture(t); g(f.repo, "checkout", "-b", "unclaimed"); commit(f.repo); g(f.repo, "checkout", "main");
  const reports = []; checkin.unclaimedCommitFindings({ ...f.opts, report: (...a) => reports.push(a) }); assert.equal(reports.length, 1); assert.match(reports[0][3], /1 commit\(s\) on unclaimed branches in the last 2h: unclaimed/);
});
test("claims lock reclaims stale locks, times out on fresh locks and releases on exceptions", t => {
  const f = fixture(t), lock = f.config.claimsFile + ".lock"; fs.writeFileSync(lock, ""); const old = new Date(Date.now() - 31000); fs.utimesSync(lock, old, old);
  assert.equal(checkin.withClaimsLock(f.config.claimsFile, () => 42), 42); assert.equal(fs.existsSync(lock), false);
  fs.writeFileSync(lock, ""); assert.throws(() => checkin.withClaimsLock(f.config.claimsFile, () => assert.fail("must not run"), { timeoutMs: 60, retryMs: 10 }), /claims lock timed out/); assert.ok(fs.existsSync(lock)); fs.unlinkSync(lock);
  assert.throws(() => checkin.withClaimsLock(f.config.claimsFile, () => { throw new Error("callback failed"); }), /callback failed/); assert.equal(fs.existsSync(lock), false);
});
test("corrupt claims store is never overwritten", t => {
  const f = fixture(t); fs.writeFileSync(f.config.claimsFile, "{broken"); assert.throws(() => f.start(), /corrupt claims store/); assert.equal(fs.readFileSync(f.config.claimsFile, "utf8"), "{broken");
});

test("a live lock owner remains protected beyond the stale threshold", t => {
  const f = fixture(t), lock = f.config.claimsFile + ".lock";
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid })); const old = new Date(Date.now() - 31000); fs.utimesSync(lock, old, old);
  assert.throws(() => checkin.withClaimsLock(f.config.claimsFile, () => "stolen", { timeoutMs: 30, retryMs: 10 }), /claims lock timed out/);
});
test("start selects origin/main when local main is only behind without fetching", t => {
  const f = fixture(t); g(f.repo, "checkout", "-b", "remote-tip"); commit(f.repo); const sha = g(f.repo, "rev-parse", "HEAD"); g(f.repo, "checkout", "main"); g(f.repo, "update-ref", "refs/remotes/origin/main", sha);
  const r = f.start(); assert.equal(r.ok, true); assert.equal(r.claim.base, "origin/main"); assert.equal(r.claim.baseSha, sha); assert.match(r.health.warnings.join("\n"), /1 behind origin/);
});
test("dry run and read-only missing-store sweep do not create a store or worktree", t => {
  const f = fixture(t); assert.equal(f.start({ dryRun: true }).ok, true); checkin.sweepClaims({ ...f.opts, readOnly: true });
  assert.equal(fs.existsSync(f.config.claimsFile), false); assert.equal(fs.existsSync(f.config.worktreeRoot), false);
});


test("release preserves detached and wrong-branch worktrees", t => {
  const f = fixture(t), r = f.start(); g(r.worktree, "checkout", "--detach"); commit(r.worktree);
  const head = g(r.worktree, "rev-parse", "HEAD");
  refused(checkin.release(r.claim.id, f.opts), /no longer on claimed branch/);
  assert.equal(g(r.worktree, "rev-parse", "HEAD"), head);
  g(r.worktree, "checkout", "-b", "other");
  refused(checkin.release(r.claim.id, f.opts), /no longer on claimed branch/);
  assert.ok(fs.existsSync(r.worktree));
});
test("finish rechecks the branch after tests", t => {
  const f = fixture(t), r = f.start();
  refused(checkin.finish(r.claim.id, { ...f.opts, testCommand: "git checkout --detach" }), /no longer on claimed branch/);
  assert.ok(fs.existsSync(r.worktree));
});
test("finish retains worktree when a merge hook advances its branch", t => {
  const f = fixture(t), r = f.start(); commit(r.worktree);
  const hook = path.join(f.repo, ".git/hooks/post-merge");
  fs.writeFileSync(hook, `#!/bin/sh
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
git -C '${r.worktree}' commit --allow-empty -m 'late work'
`); fs.chmodSync(hook, 0o755);
  refused(checkin.finish(r.claim.id, f.opts), /changed.*merge|HEAD.*merged/);
  assert.ok(fs.existsSync(r.worktree)); assert.equal(g(r.worktree, "log", "-1", "--format=%s"), "late work");
});
test("start proceeds while another finish runs tests outside the claims lock", async t => {
  const f = fixture(t), r = f.start(), marker = path.join(f.root, "testing");
  const script = `const c = require(${JSON.stringify(require.resolve("../src/checkin"))}); const r = c.finish(${JSON.stringify(r.claim.id)}, ${JSON.stringify({ ...f.opts, testCommand: `touch '${marker}'; sleep 3` })}); process.stdout.write(JSON.stringify(r)); process.exitCode = r.ok ? 0 : 1;`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  const done = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(marker), output);
    assert.equal(f.start({ task: "parallel", timeoutMs: 2000 }).ok, true);
    assert.equal(await done, 0, output);
  } finally { if (child.exitCode === null) child.kill(); await done; }
});
test("claims lock records identity and reclaims dead or hard-expired owners", t => {
  const f = fixture(t), lock = f.config.claimsFile + ".lock";
  checkin.withClaimsLock(f.config.claimsFile, () => {
    const value = JSON.parse(fs.readFileSync(lock, "utf8"));
    assert.equal(value.pid, process.pid); assert.equal(value.host, os.hostname()); assert.ok(Number.isFinite(Date.parse(value.startedAt)));
  });
  const dead = spawnSync(process.execPath, ["-e", "" ]).pid;
  for (const [pid, age] of [[dead, 31000], [process.pid, 20 * 60000 + 1000]]) {
    const old = new Date(Date.now() - age); fs.writeFileSync(lock, JSON.stringify({ pid, startedAt: old.toISOString(), host: os.hostname() })); fs.utimesSync(lock, old, old);
    assert.equal(checkin.withClaimsLock(f.config.claimsFile, () => "reclaimed", { timeoutMs: 60 }), "reclaimed");
  }
});
test("session identity uses stable precedence including Claude Code and terminal ids", () => {
  const keys = ["ALLSORTED_SESSION_NAME", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_CODE_HOST_SESSION_ID", "TMUX_PANE", "TERM_SESSION_ID"];
  const env = Object.fromEntries(keys.map(key => [key, key]));
  assert.equal(checkin.sessionLabel({ session: "explicit" }, env), "explicit");
  for (const key of keys) { assert.equal(checkin.sessionLabel({}, env), key === "TMUX_PANE" ? `tmux-${key}` : key); delete env[key]; }
  assert.match(checkin.sessionLabel({}, env), /^anon-\d+-[a-z0-9]+$/);
});

test("finish preserves detached commits made by a merge hook", t => {
  const f = fixture(t), r = f.start(); commit(r.worktree);
  const hook = path.join(f.repo, ".git/hooks/post-merge");
  fs.writeFileSync(hook, `#!/bin/sh
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
git -C '${r.worktree}' checkout --detach
git -C '${r.worktree}' commit --allow-empty -m 'detached work'
`); fs.chmodSync(hook, 0o755);
  refused(checkin.finish(r.claim.id, f.opts), /HEAD.*merged/);
  assert.equal(g(r.worktree, "log", "-1", "--format=%s"), "detached work");
});
test("finish refuses a claim removed during its tests", t => {
  const f = fixture(t), r = f.start();
  const code = `const fs = require("node:fs"); const p = ${JSON.stringify(f.config.claimsFile)}; const s = JSON.parse(fs.readFileSync(p)); s.claims = []; fs.writeFileSync(p, JSON.stringify(s));`;
  refused(checkin.finish(r.claim.id, { ...f.opts, testCommand: `'${process.execPath}' -e '${code}'` }), /claim changed while tests ran/);
  assert.ok(fs.existsSync(r.worktree));
});
test("young pending reservations refuse reuse and are not swept or released", t => {
  const f = fixture(t), r = f.start(), store = checkin.loadClaims(f.config.claimsFile);
  g(f.repo, "worktree", "remove", r.worktree); store.claims[0].pending = true; fs.writeFileSync(f.config.claimsFile, JSON.stringify(store));
  refused(f.start(), /worktree creation for this task is in progress \(started .*\); retry in a moment/);
  refused(f.start({ session: "other" }), /task already claimed/);
  refused(checkin.release(r.claim.id, f.opts), /pending/);
  refused(checkin.finish(r.claim.id, f.opts), /pending/);
  const reports = [];
  for (const age of [29 * 60000, 30 * 60000]) {
    assert.equal(checkin.sweepClaims({ ...f.opts, now: Date.parse(r.claim.createdAt) + age, report: (...a) => reports.push(a) }).active, 1);
    assert.deepEqual(checkin.loadClaims(f.config.claimsFile).claims, store.claims);
  }
  assert.deepEqual(reports, []);
});
test("sweep finalizes old pending reservations with a real worktree under lock", t => {
  const f = fixture(t), r = f.start(), store = checkin.loadClaims(f.config.claimsFile), reports = [];
  const alias = path.join(f.root, "worktree-link"); fs.symlinkSync(r.worktree, alias);
  Object.assign(store.claims[0], { pending: true, baseSha: null, worktree: alias });
  fs.writeFileSync(f.config.claimsFile, JSON.stringify(store));
  const subject = instrumentedCheckin((cmd, args, opts, run) => {
    if (cmd === "git" && args[2] === alias) assert.ok(fs.existsSync(f.config.claimsFile + ".lock"));
    return run();
  });
  assert.equal(subject.sweepClaims({ ...f.opts, now: Date.parse(r.claim.createdAt) + 31 * 60000, report: (...a) => reports.push(a) }).active, 1);
  const claim = checkin.loadClaims(f.config.claimsFile).claims[0];
  assert.equal(claim.pending, undefined); assert.equal(claim.worktree, fs.realpathSync(r.worktree));
  assert.equal(claim.baseSha, g(r.worktree, "rev-parse", "HEAD"));
  assert.equal(reports[0][0], "claim-pending-finalized"); assert.equal(reports[0][1], "info");
});
test("sweep archives old pending reservations without a worktree and preserves branches", t => {
  const f = fixture(t), r = f.start(), store = checkin.loadClaims(f.config.claimsFile), reports = [];
  commit(r.worktree); const head = g(r.worktree, "rev-parse", "HEAD");
  g(f.repo, "worktree", "remove", r.worktree); store.claims[0].pending = true;
  fs.writeFileSync(f.config.claimsFile, JSON.stringify(store));
  assert.equal(checkin.sweepClaims({ ...f.opts, now: Date.parse(r.claim.createdAt) + 31 * 60000, report: (...a) => reports.push(a) }).closed, 1);
  const after = checkin.loadClaims(f.config.claimsFile);
  assert.equal(after.claims.length, 0); assert.equal(after.released[0].releaseReason, "pending-abandoned");
  assert.equal(after.released[0].status, "released"); assert.equal(g(f.repo, "rev-parse", r.claim.branch), head);
  assert.deepEqual(reports, [["claim-pending-abandoned", "warn", f.repo, `${r.claim.id}: worktree creation never finished`, `check for a partial worktree at ${r.worktree} and branch ${r.claim.branch}; never delete it without checking for commits`]]);
});
test("read-only sweep reports old pending recovery without mutating the store", t => {
  for (const exists of [true, false]) {
    const f = fixture(t), r = f.start(), store = checkin.loadClaims(f.config.claimsFile), reports = [];
    if (!exists) g(f.repo, "worktree", "remove", r.worktree);
    Object.assign(store.claims[0], { pending: true, baseSha: null });
    fs.writeFileSync(f.config.claimsFile, JSON.stringify(store));
    const before = fs.readFileSync(f.config.claimsFile, "utf8");
    checkin.sweepClaims({ ...f.opts, readOnly: true, now: Date.parse(r.claim.createdAt) + 31 * 60000, report: (...a) => reports.push(a) });
    assert.equal(fs.readFileSync(f.config.claimsFile, "utf8"), before);
    assert.equal(fs.existsSync(f.config.claimsFile + ".lock"), false);
    assert.equal(reports[0][0], exists ? "claim-pending-finalized" : "claim-pending-abandoned");
    assert.equal(fs.existsSync(r.worktree), exists);
  }
});
test("sweep abandons old pending claims on wrong branches or partial directories without deleting them", t => {
  for (const partial of [true, false]) {
    const f = fixture(t), r = f.start(), store = checkin.loadClaims(f.config.claimsFile);
    if (partial) { g(f.repo, "worktree", "remove", r.worktree); fs.mkdirSync(r.worktree); fs.writeFileSync(path.join(r.worktree, "partial"), "keep"); }
    else { g(r.worktree, "checkout", "-b", "other"); commit(r.worktree); }
    store.claims[0].pending = true; fs.writeFileSync(f.config.claimsFile, JSON.stringify(store));
    assert.equal(checkin.sweepClaims({ ...f.opts, now: Date.parse(r.claim.createdAt) + 31 * 60000 }).closed, 1);
    assert.equal(checkin.loadClaims(f.config.claimsFile).released[0].releaseReason, "pending-abandoned");
    assert.ok(fs.existsSync(r.worktree)); assert.ok(g(f.repo, "rev-parse", r.claim.branch));
    if (partial) assert.equal(fs.readFileSync(path.join(r.worktree, "partial"), "utf8"), "keep");
    else assert.equal(g(r.worktree, "log", "-1", "--format=%s"), "feat: task");
  }
});
test("failed worktree creation removes its reservation", t => {
  const f = fixture(t); fs.writeFileSync(f.config.worktreeRoot, "not a directory");
  refused(f.start(), /directory/i);
  assert.equal(checkin.loadClaims(f.config.claimsFile).claims.length, 0);
});
test("busy claims sweep is skipped without reporting a failure", t => {
  const f = fixture(t), reports = [];
  fs.writeFileSync(f.config.claimsFile + ".lock", JSON.stringify({ pid: process.pid }));
  assert.deepEqual(checkin.sweepClaims({ ...f.opts, timeoutMs: 30, retryMs: 10, report: (...a) => reports.push(a) }), { skipped: "claims lock busy" });
  assert.deepEqual(reports, []);
});
test("finish identifies staged primary changes without touching them", t => {
  const f = fixture(t), r = f.start(); commit(r.worktree);
  fs.writeFileSync(path.join(f.repo, "staged"), "other session"); g(f.repo, "add", "staged");
  refused(checkin.finish(r.claim.id, f.opts), /primary checkout has staged changes from another session/);
  assert.equal(g(f.repo, "show", ":staged"), "other session"); assert.ok(fs.existsSync(r.worktree));
});
function instrumentedCheckin(intercept) {
  const filename = require.resolve("../src/checkin"), localRequire = require("node:module").createRequire(filename), result = { exports: {} };
  require("node:vm").runInNewContext(fs.readFileSync(filename, "utf8"), {
    module: result, __dirname: path.dirname(filename), process, Buffer,
    require: name => name === "node:child_process" ? { execFileSync: (cmd, args, opts) => intercept(cmd, args, opts, () => execFileSync(cmd, args, opts)) } : localRequire(name),
  }, { filename });
  return result.exports;
}
test("finish distinguishes git refusal without MERGE_HEAD from conflicts", t => {
  const f = fixture(t), r = f.start(); commit(r.worktree);
  const subject = instrumentedCheckin((cmd, args, opts, run) => {
    if (cmd === "git" && args[3] === "merge") { const error = new Error("merge failed"); error.stderr = "local changes would be overwritten"; throw error; }
    return run();
  });
  refused(subject.finish(r.claim.id, f.opts), /merge refused by git: local changes would be overwritten/);
  assert.ok(fs.existsSync(r.worktree));
});
test("slow git mutations get ten minutes while reads retain twenty seconds", t => {
  const f = fixture(t), calls = [];
  const subject = instrumentedCheckin((cmd, args, opts, run) => {
    if (cmd === "git") {
      calls.push({ args: args.slice(3), timeout: opts.timeout });
      if (args[3] === "push") return ""; // Never contact a remote.
    }
    return run();
  });
  const r = subject.start(f.repo, f.opts); commit(r.worktree);
  g(f.repo, "update-ref", "refs/remotes/origin/main", "main");
  assert.equal(subject.finish(r.claim.id, { ...f.opts, push: true }).ok, true);
  for (const command of [["worktree", "add"], ["merge"], ["worktree", "remove"], ["push"]]) {
    const call = calls.find(c => command.every((arg, i) => c.args[i] === arg));
    assert.ok(call, command.join(" ")); assert.equal(call.timeout, 600000);
  }
  assert.equal(calls.find(c => c.args[0] === "rev-parse").timeout, 20000);
});
test("unclaimed branch logs skip tips older than the reporting window", t => {
  const f = fixture(t); g(f.repo, "branch", "old"); g(f.repo, "checkout", "-b", "recent"); commit(f.repo); g(f.repo, "checkout", "main");
  const logged = [], reports = [];
  const subject = instrumentedCheckin((cmd, args, opts, run) => { if (cmd === "git" && args[3] === "log") logged.push(args[4]); return run(); });
  subject.unclaimedCommitFindings({ ...f.opts, report: (...a) => reports.push(a) });
  assert.ok(logged.includes("recent")); assert.equal(logged.includes("old"), false); assert.match(reports[0][3], /^1 commit\(s\) on unclaimed branches/);
});
test("expired claims remain visible and close once worktrees are removed", t => {
  const f = fixture(t), r = f.start(); checkin.sweepClaims({ ...f.opts, now: Date.now() + 10 * 3600000 });
  assert.equal(checkin.listClaims(f.opts)[0].status, "expired");
  g(f.repo, "worktree", "remove", r.worktree);
  assert.equal(checkin.sweepClaims(f.opts).closed, 1);
  assert.equal(checkin.loadClaims(f.config.claimsFile).released[0].releaseReason, "expired-closed");
});
test("expired claims reactivate after new commits or dirty file activity", t => {
  for (const activity of ["commit", "dirty"]) {
    const f = fixture(t), r = f.start({ now: Date.now() - 12 * 3600000 });
    checkin.sweepClaims({ ...f.opts, now: Date.now() - 3600000 });
    if (activity === "commit") commit(r.worktree); else fs.writeFileSync(path.join(r.worktree, "new"), "activity");
    const reports = [], before = fs.readFileSync(f.config.claimsFile, "utf8");
    assert.equal(checkin.sweepClaims({ ...f.opts, readOnly: true }).active, 1); assert.equal(fs.readFileSync(f.config.claimsFile, "utf8"), before);
    assert.equal(checkin.sweepClaims({ ...f.opts, report: (...a) => reports.push(a) }).active, 1);
    assert.equal(checkin.loadClaims(f.config.claimsFile).claims[0].status, "active"); assert.equal(reports[0][0], "claim-reactivated");
  }
});

test("release checks HEAD when checkout changes after the branch check", t => {
  const f = fixture(t), r = f.start(); let changed = false;
  const subject = instrumentedCheckin((cmd, args, opts, run) => {
    if (!changed && cmd === "git" && args[2] === r.worktree && args[3] === "rev-parse" && args[4] === "HEAD") {
      changed = true; g(r.worktree, "checkout", "--detach"); commit(r.worktree);
    }
    return run();
  });
  refused(subject.release(r.claim.id, f.opts), /no longer on claimed branch/);
  assert.ok(changed); assert.ok(fs.existsSync(r.worktree)); assert.equal(g(r.worktree, "log", "-1", "--format=%s"), "feat: task");
});
test("start reserves under lock but checks health and creates the worktree outside it", t => {
  const f = fixture(t); let added = false;
  const subject = instrumentedCheckin((cmd, args, opts, run) => {
    if (cmd === "git" && (["status", "log"].includes(args[3]) || args[3] === "worktree")) assert.equal(fs.existsSync(f.config.claimsFile + ".lock"), false);
    if (cmd === "git" && args[3] === "worktree" && args[4] === "add") {
      const claim = checkin.loadClaims(f.config.claimsFile).claims[0];
      assert.equal(claim.pending, true); assert.equal(claim.status, "active"); added = true;
    }
    return run();
  });
  const result = subject.start(f.repo, f.opts);
  assert.equal(result.ok, true); assert.ok(added); assert.equal(result.claim.pending, undefined);
  assert.equal(result.claim.baseSha, g(result.worktree, "rev-parse", "HEAD"));
});

test("finish refuses a tip committed during its test command", t => {
  const f = fixture(t), r = f.start(), before = g(f.repo, "rev-parse", "main");
  refused(checkin.finish(r.claim.id, { ...f.opts, testCommand: "git commit --allow-empty -m unchecked" }), /worktree HEAD moved since the checks ran/);
  assert.equal(g(f.repo, "rev-parse", "main"), before); assert.ok(fs.existsSync(r.worktree));
});

test("finish archives from a fresh store and releases its lock before branch deletion and push", t => {
  const f = fixture(t), r = f.start(), outsideLocks = []; commit(r.worktree);
  g(f.repo, "update-ref", "refs/remotes/origin/main", "main");
  const subject = instrumentedCheckin((cmd, args, opts, run) => {
    if (cmd === "git" && args[3] === "worktree" && args[4] === "remove") {
      assert.ok(fs.existsSync(f.config.claimsFile + ".lock"));
      const store = checkin.loadClaims(f.config.claimsFile); store.marker = "concurrent reservation";
      store.claims.push({ id: "new reservation", status: "active" }); fs.writeFileSync(f.config.claimsFile, JSON.stringify(store));
    }
    if (cmd === "git" && (args[3] === "push" || args[3] === "branch" && args[4] === "-d")) {
      outsideLocks.push(fs.existsSync(f.config.claimsFile + ".lock"));
      const store = checkin.loadClaims(f.config.claimsFile);
      assert.equal(store.marker, "concurrent reservation"); assert.ok(store.claims.some(c => c.id === "new reservation"));
      assert.equal(store.released[0].id, r.claim.id);
      throw new Error("simulated cleanup failure"); // No network.
    }
    return run();
  });
  const result = subject.finish(r.claim.id, { ...f.opts, push: true });
  assert.equal(result.ok, true); assert.equal(result.warnings.length, 2);
  assert.deepEqual(outsideLocks, [false, false]);
  assert.ok(result.warnings.every(w => w.includes("simulated cleanup failure")));
  assert.equal(checkin.loadClaims(f.config.claimsFile).marker, "concurrent reservation");
});

test("user commands refuse busy locks and start explains pending finalization", t => {
  const f = fixture(t), r = f.start(), lock = f.config.claimsFile + ".lock", startedAt = new Date().toISOString();
  const hold = () => fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt }));
  hold();
  const opts = { ...f.opts, timeoutMs: 0 };
  for (const result of [checkin.start(f.repo, { ...opts, task: "other" }), checkin.finish(r.claim.id, opts), checkin.release(r.claim.id, opts)]) {
    refused(result, /claims store busy/); assert.ok(result.reasons[0].includes(`lock held by pid ${process.pid} since ${startedAt}`));
  }
  fs.unlinkSync(lock);
  const subject = instrumentedCheckin((cmd, args, options, run) => {
    const result = run();
    if (cmd === "git" && args[3] === "worktree" && args[4] === "add") hold();
    return result;
  });
  const pending = subject.start(f.repo, { ...opts, task: "pending" });
  refused(pending, /worktree exists at .* on codex\/pending.*claim is pending.*30 minutes/);
  assert.ok(fs.existsSync(path.join(f.config.worktreeRoot, "repo", "pending")));
  assert.equal(checkin.loadClaims(f.config.claimsFile).claims.find(c => c.task === "pending").pending, true);
});

test("anonymous sessions never reuse an existing task even with an identical label", t => {
  const f = fixture(t), r = f.start({ session: undefined });
  assert.match(r.claim.session, /^anon-/);
  refused(f.start({ session: r.claim.session }), /task already claimed/);
  refused(f.start({ session: undefined }), /task already claimed/);
});

test("start reactivates its own expired claim without recreating the worktree", t => {
  const f = fixture(t), r = f.start(), now = Date.now() + 10 * 3600000;
  checkin.sweepClaims({ ...f.opts, now });
  const result = f.start({ now: now + 1000 });
  assert.equal(result.ok, true); assert.equal(result.reused, true); assert.equal(result.worktree, r.worktree);
  const claim = checkin.loadClaims(f.config.claimsFile).claims[0];
  assert.equal(claim.status, "active"); assert.equal(claim.updatedAt, new Date(now + 1000).toISOString());
});

test("sweep keeps resumed claims expired when active claims hold the task or overlapping paths", t => {
  for (const sameTask of [true, false]) {
    const f = fixture(t), r = f.start({ now: Date.now() - 12 * 3600000, paths: ["src"] });
    checkin.sweepClaims({ ...f.opts, now: Date.now() - 3600000 });
    const store = checkin.loadClaims(f.config.claimsFile);
    store.claims.push({ ...store.claims[0], id: "other", task: sameTask ? "work" : "other", paths: sameTask ? [] : ["src/deep"], session: "other", status: "active", createdAt: new Date().toISOString() });
    fs.writeFileSync(f.config.claimsFile, JSON.stringify(store));
    commit(r.worktree);
    const before = fs.readFileSync(f.config.claimsFile, "utf8");
    for (const readOnly of [true, false]) {
      const reports = [];
      checkin.sweepClaims({ ...f.opts, readOnly, report: (...a) => reports.push(a) });
      assert.equal(checkin.loadClaims(f.config.claimsFile).claims[0].status, "expired");
      assert.deepEqual(reports[0], ["claim-reactivation-blocked", "warn", f.repo, `${r.claim.id}: activity resumed but other now holds the same task/paths`, "finish or release one of them"]);
      if (readOnly) assert.equal(fs.readFileSync(f.config.claimsFile, "utf8"), before);
    }
    refused(f.start(), /reactivation blocked/);
  }
});

test("release reloads the store after removing a worktree", t => {
  const f = fixture(t), r = f.start();
  const subject = instrumentedCheckin((cmd, args, opts, run) => {
    const result = run();
    if (cmd === "git" && args[3] === "worktree" && args[4] === "remove") {
      const store = checkin.loadClaims(f.config.claimsFile); store.marker = "retained";
      fs.writeFileSync(f.config.claimsFile, JSON.stringify(store));
    }
    return result;
  });
  assert.equal(subject.release(r.claim.id, f.opts).ok, true);
  assert.equal(checkin.loadClaims(f.config.claimsFile).marker, "retained");
});

test("finish refuses branch movement after reading the tested worktree HEAD", t => {
  const f = fixture(t), r = f.start(), before = g(f.repo, "rev-parse", "main"); let moved = false;
  const subject = instrumentedCheckin((cmd, args, opts, run) => {
    if (!moved && cmd === "git" && args[2] === f.repo && args[3] === "rev-parse" && args[4] === r.claim.branch && fs.existsSync(f.config.claimsFile + ".lock")) {
      moved = true; g(r.worktree, "commit", "--allow-empty", "-m", "unchecked");
    }
    return run();
  });
  refused(subject.finish(r.claim.id, f.opts), /worktree HEAD moved since the checks ran/);
  assert.equal(moved, true); assert.equal(g(f.repo, "rev-parse", "main"), before); assert.ok(fs.existsSync(r.worktree));
});

test("resolveClaim matches lifecycle selectors without modifying claims", t => {
  const f = fixture(t), started = f.start();
  assert.equal(started.ok, true);
  const before = fs.readFileSync(f.config.claimsFile, "utf8");
  for (const selector of [started.claim.id, started.claim.task, started.claim.branch, started.worktree]) {
    assert.equal(checkin.resolveClaim(selector, f.opts).id, started.claim.id);
  }
  assert.equal(checkin.resolveClaim(undefined, { ...f.opts, cwd: started.worktree }).id, started.claim.id);
  assert.equal(checkin.resolveClaim("unknown", f.opts).refused, true);
  assert.equal(fs.readFileSync(f.config.claimsFile, "utf8"), before);
});

// 2026-10-07: worktrees under another account's home look missing to the account running
// `git worktree prune` (one local account cannot enter another account home), so their admin dirs were deleted mid-task.
test("cross-account worktrees are locked so a prune by the repo owner cannot drop them; finish and release still work", t => {
  const f = fixture(t), r = f.start({ lockWorktree: true }); assert.equal(r.ok, true);
  const listing = () => g(f.repo, "worktree", "list", "--porcelain");
  assert.match(listing(), /\nlocked git-manager claim /);
  const hidden = r.claim.worktree + ".hidden";
  fs.renameSync(r.claim.worktree, hidden);             // what the worktree looks like to the other account
  g(f.repo, "worktree", "prune");
  fs.renameSync(hidden, r.claim.worktree);
  assert.equal(g(r.claim.worktree, "rev-parse", "--abbrev-ref", "HEAD"), r.claim.branch, "worktree still linked after prune");
  commit(r.claim.worktree);
  const done = checkin.finish(r.claim.id, f.opts); assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(fs.existsSync(r.claim.worktree), false);
  const r2 = f.start({ task: "second", lockWorktree: true }); assert.equal(r2.ok, true);
  const rel = checkin.release(r2.claim.id, f.opts); assert.equal(rel.ok, true, JSON.stringify(rel));
  assert.equal(fs.existsSync(r2.claim.worktree), false);
  assert.doesNotMatch(listing(), /second/);
});
test("same-account worktrees are not locked", t => {
  const f = fixture(t), r = f.start(); assert.equal(r.ok, true);
  assert.doesNotMatch(g(f.repo, "worktree", "list", "--porcelain"), /\nlocked/);
});


test("release preserves separate staged working and committed versions after pruning and GC", t => {
  const f=fixture(t),r=f.start();assert.equal(r.ok,true);
  commit(r.worktree,"unique committed history","file.txt","committed contents\n");
  const head=g(r.worktree,"rev-parse","HEAD");
  fs.writeFileSync(path.join(r.worktree,"file.txt"),"staged contents\n");g(r.worktree,"add","file.txt");
  fs.writeFileSync(path.join(r.worktree,"file.txt"),"working contents\n");
  const indexPath=g(r.worktree,"rev-parse","--path-format=absolute","--git-path","index"),index=fs.readFileSync(indexPath);
  const result=checkin.release(r.claim.id,f.opts);assert.equal(result.ok,true,JSON.stringify(result));assert.ok(result.movedAside);
  g(f.repo,"worktree","prune");g(f.repo,"gc","--prune=now");
  assert.equal(g(result.movedAside,"show",":file.txt"),"staged contents");
  assert.deepEqual(fs.readFileSync(g(result.movedAside,"rev-parse","--path-format=absolute","--git-path","index")),index);
  assert.equal(fs.readFileSync(path.join(result.movedAside,"file.txt"),"utf8"),"working contents\n");
  assert.equal(g(result.movedAside,"show",head+":file.txt"),"committed contents");
  const staged=result.archives.find(a=>a.kind==="staged");assert.ok(staged);assert.equal(g(f.repo,"show",staged.ref+":file.txt"),"staged contents");
});


test("release refuses concurrent index changes before relocation and retains every version", t => {
  const f=fixture(t),r=f.start();assert.equal(r.ok,true);
  fs.writeFileSync(path.join(r.worktree,"file.txt"),"staged before\n");g(r.worktree,"add","file.txt");
  fs.writeFileSync(path.join(r.worktree,"file.txt"),"working after\n");
  const storage=require("../src/backup-storage"),original=storage.selectRoot;
  storage.selectRoot=(source,fallback)=>{g(source,"add","file.txt");return original(source,fallback);};
  let result;try {result=checkin.release(r.claim.id,f.opts);} finally {storage.selectRoot=original;}
  refused(result,/index or history changed/);assert.ok(fs.existsSync(r.worktree));
  assert.equal(g(r.worktree,"show",":file.txt"),"working after");
  assert.equal(fs.readFileSync(path.join(r.worktree,"file.txt"),"utf8"),"working after\n");
  const staged=result.archives.find(a=>a.kind==="staged");assert.ok(staged);assert.equal(g(f.repo,"show",staged.ref+":file.txt"),"staged before");
  assert.ok(checkin.loadClaims(f.config.claimsFile).claims.some(c=>c.id===r.claim.id&&c.status==="active"));
});


test("released recovery remains locked against pruning across unreadable folders", t => {
  const f=fixture(t),r=f.start();assert.equal(r.ok,true);
  fs.writeFileSync(path.join(r.worktree,"file.txt"),"staged preserved\n");g(r.worktree,"add","file.txt");
  fs.writeFileSync(path.join(r.worktree,"file.txt"),"working preserved\n");
  const indexPath=g(r.worktree,"rev-parse","--path-format=absolute","--git-path","index"),index=fs.readFileSync(indexPath);
  const result=checkin.release(r.claim.id,f.opts);assert.equal(result.ok,true,JSON.stringify(result));
  const parent=path.dirname(result.movedAside);fs.chmodSync(parent,0o000);
  try {g(f.repo,"worktree","prune","--expire","now");assert.deepEqual(fs.readFileSync(indexPath),index);} finally {fs.chmodSync(parent,0o700);}
  assert.match(g(f.repo,"worktree","list","--porcelain"),/locked/);
  assert.equal(g(result.movedAside,"show",":file.txt"),"staged preserved");
});
