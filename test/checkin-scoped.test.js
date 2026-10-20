"use strict";
// 5.10: path-traversal guard, pinned base commit, scoped (sparse) checkouts,
// explicit intent for large full checkouts, scope-change holds and the user-run sweep.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const checkin = require("../src/checkin");
const estimate = require("../src/checkout-estimate");
test.mock.method(require("../src/backup-storage"), "selectRoot", (_source, fallback) => ({ root: fallback, external: false, reason: "isolated test fixture" }));
const identity = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "fixture-author", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "fixture-author", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
Object.assign(process.env, identity);
process.env.GIT_MANAGER_CARRY_BACKUP_DIR = fs.realpathSync(os.tmpdir()) + "/gm-carry-tests-never-real";
const CLI = path.resolve(__dirname, "../bin/git-manager.js");
const g = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, ...identity }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const MiB = 1024 ** 2;
function fixture(t, files = []) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gm-scoped-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo"); fs.mkdirSync(repo);
  g(repo, "-c", "init.defaultBranch=main", "init");
  for (const [file, content] of [["file.txt", "base\n"], ...files]) { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), content); }
  g(repo, "add", "."); g(repo, "commit", "-m", "initial");
  const config = { claimsFile: path.join(root, "claims.json"), worktreeRoot: path.join(root, "trees"), carryBackupDir: path.join(root, "carry"), enforcedRepos: [repo], ownerSessions: [], staleClaimHours: 8, recentCommitHours: 3, unclaimedWindowHours: 2 };
  const opts = { config, env: { ALLSORTED_ACTOR: "joe" }, owner: "codex", session: "test-session", task: "work" };
  const start = (extra = {}) => checkin.start(repo, { ...opts, ...extra });
  const cli = (args, extraEnv = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, GIT_MANAGER_CLAIMS_FILE: config.claimsFile, GIT_MANAGER_WORKTREE_ROOT: config.worktreeRoot, GIT_MANAGER_CONFIG_JSON: JSON.stringify(config), ...extraEnv } });
  return { root, repo, config, opts, start, cli };
}
const scopedFiles = [["src/owned.js", "owned"], ["deps/library.js", "dependency"], ["other/file.txt", "omit"], ["unrelated/private.txt", "omit"]];
function scoped(t, files = scopedFiles) { const f = fixture(t, files); g(f.repo, "config", "extensions.worktreeConfig", "true"); return f; }
function refused(result, pattern) { assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.refused, true); assert.match(result.reasons.join("\n"), pattern); }
function commit(repo, subject = "feat: task", file = "file.txt", content = "task\n") { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), content); g(repo, "add", file); g(repo, "commit", "-m", subject); }
function instrumentedCheckin(intercept) {
  const filename = require.resolve("../src/checkin"), localRequire = require("node:module").createRequire(filename), result = { exports: {} };
  require("node:vm").runInNewContext(fs.readFileSync(filename, "utf8"), {
    module: result, __dirname: path.dirname(filename), process, Buffer,
    require: name => name === "node:child_process" ? { execFileSync: (cmd, args, opts) => intercept(cmd, args, opts, () => execFileSync(cmd, args, opts)) } : localRequire(name),
  }, { filename });
  return result.exports;
}
const noClaim = (f) => { assert.equal(checkin.loadClaims(f.config.claimsFile).claims.length, 0); assert.throws(() => g(f.repo, "show-ref", "--verify", "refs/heads/codex/work")); assert.equal(fs.existsSync(path.join(f.config.worktreeRoot, "repo", "work")), false); };

test("parent traversal cannot acquire whole-repository intent and is refused before any planning", t => {
  const f = fixture(t, [["src/a.js", "a"]]); let planned = 0;
  t.mock.method(estimate, "estimate", () => { planned++; return 1; });
  for (const p of ["src/..", "src/../..", "..", "src\\..\\x"]) refused(f.start({ paths: [p] }), /declared paths must be inside the repository/);
  refused(f.start({ paths: [path.dirname(f.repo)] }), /declared paths must be inside the repository/);
  refused(f.start({ paths: "src,../x" }), /declared paths must be inside the repository/);
  assert.equal(planned, 0, "invalid path must be rejected before checkout planning"); noClaim(f);
  const cli = f.cli(["start", f.repo, "--task", "work", "--owner", "codex", "--paths", "src/.."]); assert.equal(cli.status, 2, cli.stdout + cli.stderr); assert.match(cli.stdout, /inside the repository/);
});
test("start inventories large untracked status output without ENOBUFS", t => {
  const f = fixture(t), dir = path.join(f.repo, "bulk-status"); fs.mkdirSync(dir);
  const suffix = "x".repeat(160);
  for (let i = 0; i < 7000; i++) fs.writeFileSync(path.join(dir, `${String(i).padStart(5, "0")}-${suffix}`), "x");
  const r = f.start({ dryRun: true }); assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.health.info.dirtyCount, 7000);
});
test("checkout uses the exact commit resolved at reservation even if the base ref advances", t => {
  const f = fixture(t), before = g(f.repo, "rev-parse", "HEAD");
  commit(f.repo, "later version", "large.txt", "more bytes"); const later = g(f.repo, "rev-parse", "HEAD"); g(f.repo, "reset", "--hard", before);
  const subject = instrumentedCheckin((cmd, args, opts, run) => { if (cmd === "git" && args[3] === "worktree" && args[4] === "add") g(f.repo, "update-ref", "refs/heads/main", later); return run(); });
  const result = subject.start(f.repo, f.opts); assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(g(result.worktree, "rev-parse", "HEAD"), before); assert.equal(result.claim.baseSha, before);
  assert.equal(f.start({ dryRun: true, task: "other" }).plan.baseSha, later);
});
test("eligible scoped claim materializes only declared and resolved dependency cones without touching the primary", t => {
  const f = scoped(t);
  const head = g(f.repo, "rev-parse", "HEAD"), index = fs.readFileSync(path.join(f.repo, ".git", "index")), config = fs.readFileSync(path.join(f.repo, ".git", "config"));
  const result = f.start({ paths: ["src"], dependencies: ["deps"] }); assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.claim.sparseCheckout.mode, "cone"); assert.equal(result.claim.sparseCheckout.profile, "explicit"); assert.equal(result.claim.sparseCheckout.materialized, true); assert.match(result.claim.sparseCheckout.manifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.claim.allocation, undefined, "the customer build records no capacity allocation");
  assert.equal(fs.existsSync(path.join(result.worktree, "src/owned.js")), true); assert.equal(fs.existsSync(path.join(result.worktree, "deps/library.js")), true); assert.equal(fs.existsSync(path.join(result.worktree, "unrelated/private.txt")), false);
  assert.equal(g(f.repo, "rev-parse", "HEAD"), head); assert.ok(fs.readFileSync(path.join(f.repo, ".git", "index")).equals(index)); assert.ok(fs.readFileSync(path.join(f.repo, ".git", "config")).equals(config));
  assert.equal(fs.existsSync(path.join(f.repo, "unrelated/private.txt")), true);
  const cli = f.cli(["start", f.repo, "--task", "cli-sparse", "--owner", "codex", "--paths", "other", "--dependencies", "deps", "--json"]);
  assert.equal(cli.status, 0, cli.stdout + cli.stderr); assert.equal(JSON.parse(cli.stdout).claim.sparseCheckout.profile, "explicit");
  const text = f.cli(["start", f.repo, "--task", "cli-text", "--owner", "codex", "--paths", "unrelated", "--dependencies", "deps"]);
  assert.equal(text.status, 0, text.stdout + text.stderr); assert.match(text.stdout, /materialization: sparse cone, deps, unrelated/);
  const full = f.cli(["start", f.repo, "--task", "cli-full", "--owner", "codex", "--paths", "file.txt", "--full-checkout", "--json"]);
  assert.equal(full.status, 0, full.stdout + full.stderr); assert.equal(JSON.parse(full.stdout).claim.fullCheckoutRequested, true);
  assert.equal(checkin.finish(result.claim.id, f.opts).ok, true);
});
test("scoped request without worktreeConfig falls back to a full checkout with a stated reason", t => {
  const f = fixture(t, scopedFiles);
  const dry = f.start({ paths: ["src"], dependencies: ["deps"], dryRun: true }); assert.equal(dry.ok, true, JSON.stringify(dry));
  assert.equal(dry.plan.materialization, "full"); assert.match(dry.plan.materializationReason, /config extensions\.worktreeConfig true/);
  assert.match(dry.health.warnings.join("\n"), /scoped checkout unavailable, using a full checkout/);
  const r = f.start({ paths: ["src"], dependencies: ["deps"] }); assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.claim.sparseCheckout, undefined); assert.equal(fs.existsSync(path.join(r.worktree, "unrelated/private.txt")), true);
  assert.throws(() => g(f.repo, "config", "--bool", "--get", "extensions.worktreeConfig"), "the fallback never enables repository extensions");
});
test("implicit large full checkout is held before reservation or worktree creation", t => {
  const f = fixture(t, [["src/a.js", "a"]]); t.mock.method(estimate, "estimate", () => 300 * MiB);
  refused(f.start({ paths: ["src"] }), /estimated full checkout is 300 MiB.*256 MiB.*--dependencies.*--full-checkout/i); noClaim(f);
  refused(f.start({ paths: ["src"], dryRun: true }), /implicit full-checkout ceiling/);
  refused(f.start({ paths: ["src"], dependencies: ["src"] }), /scoped checkout unavailable: extensions\.worktreeConfig is not enabled.*config extensions\.worktreeConfig true/); noClaim(f);
});
test("large full checkout proceeds with explicit intent, and the ceiling is configurable", t => {
  t.mock.method(estimate, "estimate", () => 300 * MiB);
  for (const request of [{ paths: ["."] }, { paths: ["src"], fullCheckout: true }]) {
    const f = fixture(t, [["src/a.js", "a"]]); const r = f.start(request);
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.claim.fullCheckoutRequested, true);
  }
  const raised = fixture(t, [["src/a.js", "a"]]); raised.config.fullCheckoutCeilingMiB = 512;
  const r = raised.start({ paths: ["src"] }); assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.claim.fullCheckoutRequested, undefined);
  const lowered = fixture(t, [["src/a.js", "a"]]); lowered.config.fullCheckoutCeilingMiB = 0; t.mock.restoreAll();
  refused(lowered.start({ paths: ["src"] }), /above the 0 MiB/);
});
test("large-checkout admission does not change reuse of an existing claim", t => {
  const f = fixture(t, [["src/a.js", "a"]]); const created = f.start({ paths: ["src"] }); assert.equal(created.ok, true);
  t.mock.method(estimate, "estimate", () => 300 * MiB);
  const reused = f.start({ paths: ["src"] }); assert.equal(reused.ok, true); assert.equal(reused.reused, true);
});
test("explicit sparse dependencies admit a narrow cone despite a large full-tree estimate", t => {
  const f = scoped(t, [["src/owned.js", "owned"], ["deps/library.js", "library"], ["unrelated/bulk.bin", "not included"]]);
  t.mock.method(estimate, "estimate", () => 300 * MiB);
  const result = f.start({ paths: ["src"], dependencies: ["deps"] });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.claim.sparseCheckout.mode, "cone"); assert.equal(fs.existsSync(path.join(result.worktree, "unrelated/bulk.bin")), false);
});
test("sparse finish and release retain ignored files inside cone and refuse out-of-scope commits", t => {
  const f = scoped(t, [["src/owned.js", "owned"], ["deps/library.js", "dependency"], ["other/file.txt", "omit"], [".gitignore", "deps/ignored.tmp\n"]]);
  const result = f.start({ paths: ["src"], dependencies: ["deps"] }); assert.equal(result.ok, true, JSON.stringify(result));
  const ignored = path.join(result.worktree, "deps", "ignored.tmp"); fs.writeFileSync(ignored, "keep me");
  refused(checkin.finish(result.claim.id, f.opts), /ignored physical files/);
  refused(checkin.release(result.claim.id, f.opts), /ignored physical files/); assert.equal(fs.readFileSync(ignored, "utf8"), "keep me");
  fs.unlinkSync(ignored);
  fs.writeFileSync(path.join(result.worktree, "deps/library.js"), "changed outside write scope"); g(result.worktree, "add", "deps/library.js"); g(result.worktree, "commit", "-m", "dependency change");
  refused(checkin.finish(result.claim.id, f.opts), /outside exclusive claim scope/);
  refused(checkin.release(result.claim.id, f.opts), /outside exclusive claim scope/);
  assert.equal(fs.existsSync(result.worktree), true);
});
test("sparse finish and release accept files merged in from the target branch but still refuse the claim's own out-of-scope commits", t => {
  for (const action of ["finish", "release"]) {
    const f = scoped(t, [["src/owned.js", "owned"], ["deps/library.js", "dependency"], ["other/file.txt", "omit"]]);
    const result = f.start({ paths: ["src"], dependencies: ["deps"] }); assert.equal(result.ok, true, JSON.stringify(result));
    fs.writeFileSync(path.join(result.worktree, "src/owned.js"), "claimed change"); g(result.worktree, "commit", "-am", "claimed change");
    commit(f.repo, "main moves on outside the claim", "other/landed.txt", "landed on main\n");
    g(result.worktree, "merge", "--no-edit", "main");
    assert.notEqual(g(result.worktree, "merge-base", "main", "HEAD"), result.claim.baseSha, "the claim branch merged a newer target");
    fs.writeFileSync(path.join(result.worktree, "deps/library.js"), "changed outside write scope"); g(result.worktree, "commit", "-am", "dependency change");
    refused(checkin[action](result.claim.id, f.opts), /outside exclusive claim scope/);
    g(result.worktree, "reset", "--hard", "HEAD~1");
    const done = checkin[action](result.claim.id, f.opts);
    assert.equal(done.ok, true, JSON.stringify(done));
    if (action === "finish") assert.equal(g(f.repo, "show", "main:src/owned.js"), "claimed change");
    else assert.equal(done.claim.status, "released");
  }
});
test("sparse finish and release detect both sides of dependency renames", t => {
  const f = scoped(t, [["src/owned.js", "owned"], ["deps/movable.js", "dependency"]]);
  const result = f.start({ paths: ["src"], dependencies: ["deps"] }); assert.equal(result.ok, true, JSON.stringify(result));
  g(result.worktree, "mv", "deps/movable.js", "src/movable.js"); g(result.worktree, "commit", "-m", "move dependency into owned cone");
  refused(checkin.finish(result.claim.id, f.opts), /outside exclusive claim scope/);
  refused(checkin.release(result.claim.id, f.opts), /outside exclusive claim scope/);
  assert.equal(fs.existsSync(path.join(result.worktree, "src/movable.js")), true);
});
test("sparse finish and release hold on manifest or worktree-config drift", t => {
  for (const drift of ["manifest", "roots", "extension"]) {
    const f = scoped(t, [["src/owned.js", "owned"], ["deps/library.js", "dep"]]);
    const result = f.start({ paths: ["src"], dependencies: ["deps"] }); assert.equal(result.ok, true, JSON.stringify(result));
    if (drift === "manifest") { const store = checkin.loadClaims(f.config.claimsFile), claim = store.claims.find(row => row.id === result.claim.id); claim.sparseCheckout.manifest = "forged"; fs.writeFileSync(f.config.claimsFile, JSON.stringify(store)); }
    else if (drift === "roots") g(result.worktree, "sparse-checkout", "set", "--cone", "src");
    else g(f.repo, "config", "--unset", "extensions.worktreeConfig");
    const pattern = { manifest: /manifest does not match|manifest hash mismatch/, roots: /roots or worktree configuration changed/, extension: /no longer enabled|roots or worktree configuration changed/ }[drift];
    refused(checkin.finish(result.claim.id, f.opts), pattern); refused(checkin.release(result.claim.id, f.opts), pattern);
    assert.equal(fs.existsSync(result.worktree), true);
  }
});
test("partial sparse setup pending claims survive the sweep and the sweep CLI", t => {
  const f = scoped(t, [["src/owned.js", "owned"], ["deps/library.js", "dep"]]);
  const result = f.start({ paths: ["src"], dependencies: ["deps"] }); assert.equal(result.ok, true, JSON.stringify(result));
  const store = checkin.loadClaims(f.config.claimsFile), claim = store.claims.find(row => row.id === result.claim.id);
  claim.pending = true; claim.sparseCheckout.materialized = false; claim.createdAt = new Date(Date.now() - 31 * 60000).toISOString(); fs.writeFileSync(f.config.claimsFile, JSON.stringify(store));
  const swept = f.cli(["sweep", "--json"]); assert.equal(swept.status, 0, swept.stdout + swept.stderr);
  const out = JSON.parse(swept.stdout); assert.equal(out.claims.active, 1); assert.ok(out.findings.some(x => x.code === "claim-sparse-setup-held"));
  const after = checkin.loadClaims(f.config.claimsFile).claims.find(row => row.id === result.claim.id); assert.equal(after.pending, true); assert.equal(after.sparseCheckout.materialized, false); assert.equal(fs.existsSync(result.worktree), true);
});
test("finish and release hold when the claim's paths change while checks run", t => {
  const f = fixture(t, [["src/a.js", "a"], ["src/b.js", "b"]]), r = f.start({ paths: ["src"] }); commit(r.worktree, "feat: a", "src/a.js", "changed");
  const code = `const fs=require("node:fs");const p=${JSON.stringify(f.config.claimsFile)};const s=JSON.parse(fs.readFileSync(p));s.claims[0].paths=["src/a.js"];fs.writeFileSync(p,JSON.stringify(s));`;
  refused(checkin.finish(r.claim.id, { ...f.opts, testCommand: `'${process.execPath}' -e '${code}'` }), /claim changed while tests ran/);
  assert.equal(fs.existsSync(r.worktree), true); assert.equal(checkin.loadClaims(f.config.claimsFile).claims[0].status, "active");
  // Release: change the scope between the unlocked checks and the locked phase.
  let changed = false;
  const subject = instrumentedCheckin((cmd, args, opts, run) => {
    if (!changed && cmd === "git" && args.includes("rev-list") && args.includes("--branches")) {
      changed = true; const s = JSON.parse(fs.readFileSync(f.config.claimsFile)); s.claims[0].paths = ["src"]; fs.writeFileSync(f.config.claimsFile, JSON.stringify(s));
    }
    return run();
  });
  refused(subject.release(r.claim.id, f.opts), /claim scope or sparse metadata changed while release checks ran/);
  assert.equal(fs.existsSync(r.worktree), true);
});
test("an upgrade keeps finishing claims whose worktrees live under the earlier root", t => {
  const f = fixture(t), legacyRoot = path.join(f.root, "legacy-worktree-root");
  const r = f.start({ worktreeRoot: legacyRoot }); assert.equal(r.ok, true, JSON.stringify(r)); assert.ok(r.worktree.startsWith(legacyRoot));
  commit(r.worktree);
  const newRoot = path.join(f.root, "new-default-root"); f.config.worktreeRoot = newRoot;
  assert.equal(checkin.listClaims(f.opts)[0].worktree, r.worktree);
  assert.equal(checkin.sweep({ ...f.opts, readOnly: true }).claims.active, 1);
  const next = f.start({ task: "next" }); assert.equal(next.ok, true); assert.ok(next.worktree.startsWith(newRoot));
  const done = checkin.finish(r.claim.id, f.opts); assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(fs.existsSync(r.worktree), false);
  const shipped = require("../config/config.json").checkin.worktreeRoot; assert.equal(shipped, "~/.config/allsorted/worktrees");
});
test("sweep CLI previews read-only, then expires idle claims; it covers enforced repos and reports misconfiguration", t => {
  const f = fixture(t), r = f.start(); commit(f.repo, "feat: bypass", "direct.txt", "x");
  const old = new Date(Date.now() - 10 * 3600000); fs.utimesSync(f.config.claimsFile, old, old);
  const store = checkin.loadClaims(f.config.claimsFile); store.claims[0].createdAt = old.toISOString(); fs.writeFileSync(f.config.claimsFile, JSON.stringify(store));
  const before = fs.readFileSync(f.config.claimsFile, "utf8");
  const preview = f.cli(["sweep", "--read-only", "--json"]); assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  const p = JSON.parse(preview.stdout); assert.equal(p.readOnly, true); assert.equal(p.claims.expired, 1); assert.deepEqual(p.repos, [f.repo]);
  assert.ok(p.findings.some(x => x.code === "claim-stale" && /would expire/.test(x.message))); assert.ok(p.findings.some(x => x.code === "commits-without-claim"));
  assert.equal(fs.readFileSync(f.config.claimsFile, "utf8"), before, "read-only sweep must not write the claims store");
  const text = f.cli(["sweep", "--read-only"]); assert.match(text.stdout, /sweep preview \(read-only, nothing changed\): 0 active, 1 expired/);
  const applied = f.cli(["sweep"]); assert.equal(applied.status, 0, applied.stdout + applied.stderr); assert.match(applied.stdout, /claim-stale/);
  assert.equal(checkin.loadClaims(f.config.claimsFile).claims[0].status, "expired"); assert.equal(fs.existsSync(r.worktree), true);
  assert.equal(f.cli(["sweep", f.repo]).status, 1);
  f.config.enforcedRepos = [path.join(f.root, "missing")];
  const missing = JSON.parse(f.cli(["sweep", "--read-only", "--json"]).stdout); assert.ok(missing.findings.some(x => x.code === "enforced-repo-unavailable"));
  f.config.enforcedRepos = [];
  const none = JSON.parse(f.cli(["sweep", "--read-only", "--json"]).stdout); assert.ok(none.findings.some(x => x.code === "no-enforced-repos"));
});
test("sweep recipe is read-only by construction", async t => {
  const f = fixture(t); f.start(); const store = checkin.loadClaims(f.config.claimsFile); store.claims[0].createdAt = new Date(Date.now() - 10 * 3600000).toISOString(); fs.writeFileSync(f.config.claimsFile, JSON.stringify(store));
  const before = fs.readFileSync(f.config.claimsFile, "utf8");
  const saved = { ...process.env }; t.after(() => { for (const k of ["GIT_MANAGER_CLAIMS_FILE", "GIT_MANAGER_CONFIG_JSON"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  process.env.GIT_MANAGER_CLAIMS_FILE = f.config.claimsFile; process.env.GIT_MANAGER_CONFIG_JSON = JSON.stringify(f.config);
  const recipe = require("../recipes/sweep-claims.js"), manifest = require("../recipes/sweep-claims.recipe.json");
  const out = await recipe.runRecipe({ readOnly: false });
  assert.equal(out.status, "ok", out.reply); assert.match(out.reply, /nothing changed/); assert.equal(out.metadata.readOnly, true);
  assert.equal(fs.readFileSync(f.config.claimsFile, "utf8"), before);
  assert.ok(manifest.phrases.length >= 5); assert.ok(manifest.phrases.filter(p => !/\bgit-manager\b/i.test(p)).length >= 2); assert.equal(manifest.safety.destructive, false);
});
test("hardening: ceiling config must be numeric, option-looking roots are refused, preview flags are command-specific", t => {
  const f = fixture(t, [["src/a.js", "a"]]); t.mock.method(estimate, "estimate", () => 300 * MiB);
  f.config.fullCheckoutCeilingMiB = null; refused(f.start({ paths: ["src"] }), /above the 256 MiB/);
  const s = scoped(t, [["src/a.js", "a"], ["--no-cone/x.js", "x"]]);
  refused(s.start({ paths: ["src"], dependencies: ["--no-cone"] }), /concrete repository-relative paths/); noClaim(s);
  const rel = f.cli(["release", "anything", "--read-only"]); assert.equal(rel.status, 1); assert.match(rel.stdout, /--read-only applies only to sweep/);
  const fin = f.cli(["finish", "--full-checkout"]); assert.equal(fin.status, 1); assert.match(fin.stdout, /apply only to start/);
});
test("another session staging in the primary does not strand a sparse start", t => {
  const f = scoped(t);
  const subject = instrumentedCheckin((cmd, args, opts, run) => {
    if (cmd === "git" && args.includes("sparse-checkout") && args.includes("set")) { fs.writeFileSync(path.join(f.repo, "other/file.txt"), "staged elsewhere"); g(f.repo, "add", "other/file.txt"); }
    return run();
  });
  const r = subject.start(f.repo, { ...f.opts, paths: ["src"], dependencies: ["deps"] }); assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.claim.sparseCheckout.materialized, true);
});
test("a primary that turns sparse during sparse creation holds the pending claim", t => {
  const f = scoped(t);
  const subject = instrumentedCheckin((cmd, args, opts, run) => {
    if (cmd === "git" && args.includes("sparse-checkout") && args.includes("set")) g(f.repo, "config", "core.sparseCheckout", "true");
    return run();
  });
  refused(subject.start(f.repo, { ...f.opts, paths: ["src"], dependencies: ["deps"] }), /primary checkout's sparse state changed/);
  assert.equal(checkin.loadClaims(f.config.claimsFile).claims[0].pending, true);
});
