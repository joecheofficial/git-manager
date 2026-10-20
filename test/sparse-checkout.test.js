"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const sparse = require("../src/sparse-checkout");
const tree = "100644 blob aaaa 100\troot.txt\0" + "100644 blob bbbb 200\tapp/src/a.js\0" + "100644 blob cccc 300\tapp/package.json\0" + "100644 blob dddd 400\tlib/shared/a.js\0"
  + "100644 blob 1111 100\tpackages/root.txt\0" + "100644 blob 2222 100\tpackages/tools/root.txt\0" + "100644 blob eeee 500\tpackages/tools/cli/index.js\0" + "100644 blob ffff 600\telsewhere/secret.txt\0";
function resolve(overrides = {}) { return sparse.resolve({ repo: overrides.repo || "/tmp/repo", claimPaths: ["app/src"], dependencies: ["lib/shared", "packages/tools/cli"], tree, version: "git version 2.50.1", worktreeConfig: true, ...overrides }); }

test("declared claim and dependency roots resolve a cone and hash only cone-materialized files", () => {
  const result = resolve(); assert.equal(result.mode, "sparse"); assert.equal(result.profile, "explicit");
  assert.deepEqual(result.includeDirs, ["app/src", "lib/shared", "packages/tools/cli"]);
  assert.ok(result.includedRows.some(r => r.path === "packages/tools/cli/index.js"));
  for (const file of ["root.txt", "packages/root.txt", "packages/tools/root.txt", "app/package.json"]) assert.ok(result.includedRows.some(r => r.path === file), `cone includes intermediate flat file ${file}`);
  assert.ok(!result.includedRows.some(r => r.path === "elsewhere/secret.txt")); assert.match(result.manifestSha256, /^[a-f0-9]{64}$/);
});
test("no built-in dependency profile: without --dependencies the checkout is full and says why", () => {
  const result = resolve({ dependencies: undefined });
  assert.equal(result.mode, "full"); assert.match(result.reason, /--dependencies/);
  assert.equal(sparse.GIT_MANAGER_PROFILE, undefined);
});
test("unsupported Git or disabled worktreeConfig fall back to full with a stated reason and the enable command", () => {
  const old = resolve({ version: "git version 2.33.2" }); assert.equal(old.mode, "full"); assert.match(old.reason, /2\.34\.0 or newer.*2\.33\.2/);
  const off = resolve({ worktreeConfig: false, repo: "/tmp/my repo" }); assert.equal(off.mode, "full");
  assert.match(off.reason, /extensions\.worktreeConfig is not enabled/); assert.ok(off.reason.includes('git -C "/tmp/my repo" config extensions.worktreeConfig true'));
  assert.equal(resolve({ claimPaths: ["root.txt"], dependencies: ["root.txt"] }).mode, "full");
  assert.equal(sparse.supportedVersion("git version 2.39.5 (Apple Git-154)"), true);
});
test("scoped request with unscoped claim paths fails closed", () => {
  for (const claimPaths of [[], ["."], ["../x"]]) assert.throws(() => resolve({ claimPaths }), /concrete claimed paths/);
});
test("explicit roots reject globs, traversal and symlink aliases", () => {
  for (const root of ["../outside", "src/*", "src\\file", "a/./b", "", "--no-cone", "-x"]) assert.throws(() => resolve({ dependencies: [root] }), /concrete|invalid/);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sparse-checkout-")); fs.mkdirSync(path.join(repo, "lib")); fs.symlinkSync(os.tmpdir(), path.join(repo, "lib", "alias"));
  try { assert.throws(() => resolve({ repo, dependencies: ["lib/alias"] }), /symlink/); } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  assert.throws(() => resolve({ dependencies: ["lib/link"], tree: tree + "120000 blob 9999 10\tlib/link\0" }), /tracked symlink/);
});
test("new claim files use a tracked existing parent cone while missing dependencies stay fail-closed", t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sparse-new-claim-")); t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  for (const dir of ["src/generated", "deps"]) fs.mkdirSync(path.join(repo, dir), { recursive: true });
  const explicitTree = "100644 blob aaaa 100\tsrc/generated/old.js\0" + "100644 blob abcd 100\tsrc/owned.js\0" + "100644 blob bbbb 200\tdeps/lib.js\0";
  const explicit = sparse.resolve({ repo, claimPaths: ["src/generated/new-helper.js"], dependencies: ["deps"], tree: explicitTree, version: "git version 2.50.1", worktreeConfig: true });
  assert.equal(explicit.mode, "sparse", explicit.reason); assert.ok(explicit.includeDirs.includes("src/generated"));
  assert.ok(!explicit.includedRows.some(row => row.path === "src/generated/new-helper.js"));
  assert.throws(() => sparse.resolve({ repo, claimPaths: ["src/generated/new-helper.js"], dependencies: ["missing-deps"], tree: explicitTree, version: "git version 2.50.1", worktreeConfig: true }), /no tracked content/);
  const rootFile = sparse.resolve({ repo, claimPaths: ["new-root-file.js"], dependencies: ["deps"], tree: explicitTree, version: "git version 2.50.1", worktreeConfig: true });
  assert.equal(rootFile.mode, "full");
});
test("manifest verification detects a changed pinned tree", () => {
  const result = resolve();
  assert.equal(sparse.verifyManifest(tree, result), true);
  assert.equal(sparse.verifyManifest(tree.replace("bbbb", "bbbc"), result), false);
});
test("sparse guard rejects changed tracked files and physical extras outside allowed roots", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sparse-guard-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "deps")); fs.mkdirSync(path.join(root, "src")); fs.writeFileSync(path.join(root, "deps", "keep.js"), "ok"); fs.writeFileSync(path.join(root, "src", "owned.js"), "ok");
  const manifest = "fixture manifest\n", claim = { paths: ["src"], sparseCheckout: { mode: "cone", includeDirs: ["deps", "src"], manifest, manifestSha256: crypto.createHash("sha256").update(manifest).digest("hex") } };
  assert.match(sparse.guard(root, claim, ["deps/keep.js"]), /outside exclusive claim scope/);
  assert.match(sparse.guard(root, claim, ["src-other/x.js"]), /outside exclusive claim scope/);
  fs.mkdirSync(path.join(root, "other")); fs.writeFileSync(path.join(root, "other", "stray.txt"), "untracked"); assert.match(sparse.guard(root, claim, []), /physical files outside/);
  fs.rmSync(path.join(root, "other"), { recursive: true }); fs.mkdirSync(path.join(root, "other")); fs.symlinkSync(path.join(root, "deps", "keep.js"), path.join(root, "other", "escape")); assert.match(sparse.guard(root, claim, []), /physical files outside/);
  fs.rmSync(path.join(root, "other"), { recursive: true }); assert.equal(sparse.guard(root, claim, ["src/owned.js"]), null);
  assert.match(sparse.guard(root, claim, [], ["deps/ignored.dat"]), /ignored physical files/);
  claim.sparseCheckout.manifest = "changed manifest"; assert.match(sparse.guard(root, claim, []), /manifest hash mismatch/);
});
