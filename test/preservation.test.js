"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { inventoryRepositories, inspectRepository, captureRepository, verifyCaptureSource } = require("../src/preservation");
const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "git-preservation-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, "repo"); fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "test"); git(repo, "config", "user.email", "test@local");
  fs.writeFileSync(path.join(repo, "file"), "v1");
  git(repo, "add", "."); git(repo, "commit", "-qm", "initial");
  return { base, repo };
}
test("inventory includes dirty linked worktrees and reports missing roots", (t) => {
  const {base, repo} = fixture(t); const linked = path.join(base, "linked\ncheckout");
  git(repo, "worktree", "add", "-b", "feature", linked);
  fs.writeFileSync(path.join(linked, "new"), "work");
  const result = inventoryRepositories([repo, repo, path.join(base, "missing")]);
  assert.equal(result.repositories.length, 2);
  const row = result.repositories.find(r => r.path === fs.realpathSync(linked));
  assert.equal(row.entries.some(e => e.path === "new"), true);
  assert.equal(result.errors.length, 1);
  assert.equal(result.clean, false);
});
test("capture recovers committed, staged and working versions without source mutations", (t) => {
  const {base, repo} = fixture(t);
  fs.writeFileSync(path.join(repo, "file"), "v2"); git(repo, "add", "file");
  fs.writeFileSync(path.join(repo, "file"), "v3");
  const status = git(repo, "status", "--porcelain");
  const index = fs.readFileSync(path.join(repo, ".git/index"));
  const head = git(repo, "rev-parse", "HEAD");
  const result = captureRepository(repo, path.join(base, "capture"));
  assert.equal(result.complete, true);
  assert.equal(fs.readFileSync(path.join(result.directory, "files/file"), "utf8"), "v3");
  const staged = result.staged.find(e => e.path === "file");
  assert.equal(fs.readFileSync(path.join(result.directory, "staged-blobs", staged.oid), "utf8"), "v2");
  assert.equal(git(repo, "show", "HEAD:file"), "v1");
  assert.equal(git(repo, "rev-parse", "HEAD"), head);
  assert.deepEqual(fs.readFileSync(path.join(repo, ".git/index")), index);
  assert.equal(git(repo, "status", "--porcelain"), status);
});
test("capture preserves hostile names, rename sources, symlinks and large descendants", (t) => {
  const {base, repo} = fixture(t);
  git(repo, "mv", "file", "renamed");
  const name = ":(glob)*\n.txt"; fs.writeFileSync(path.join(repo, name), "literal");
  fs.symlinkSync("renamed", path.join(repo, "link"));
  fs.mkdirSync(path.join(repo, "newdir")); fs.writeFileSync(path.join(repo, "newdir/big"), Buffer.alloc(11 * 1024 * 1024, 7));
  const result = captureRepository(repo, path.join(base, "capture"));
  assert.equal(result.complete, true);
  assert.equal(result.files.some(e => e.path === "file" && e.kind === "missing"), true);
  assert.equal(fs.readFileSync(path.join(result.directory, "files", name), "utf8"), "literal");
  assert.equal(fs.readlinkSync(path.join(result.directory, "files/link")), "renamed");
  assert.equal(fs.statSync(path.join(result.directory, "files/newdir/big")).size, 11 * 1024 * 1024);
});

test("capture refuses to certify concurrent source changes", (t) => {
  const {base, repo} = fixture(t);
  fs.writeFileSync(path.join(repo, "file"), "v2"); git(repo, "add", "file");
  const result = captureRepository(repo, path.join(base, "capture"), {
    beforeVerify() { fs.writeFileSync(path.join(repo, "file"), "v3"); git(repo, "add", "file"); }
  });
  assert.equal(result.complete, false);
  assert.match(result.issues.join("\n"), /changed during capture/);
  assert.equal(fs.readFileSync(path.join(result.directory, "files/file"), "utf8"), "v2");
  assert.equal(git(repo, "show", ":file"), "v3");
});
test("capture rejects source destinations and refuses to overwrite backups", (t) => {
  const {base, repo} = fixture(t);
  assert.throws(() => captureRepository(repo, path.join(repo, "backup")), /outside repository/);
  fs.symlinkSync(repo, path.join(base, "alias"));
  assert.throws(() => captureRepository(repo, path.join(base, "alias/backup")), /outside repository/);
  const destination = path.join(base, "capture");
  const first = captureRepository(repo, destination);
  assert.equal(first.complete, true);
  const saved = fs.readFileSync(path.join(destination, "manifest.json"));
  assert.throws(() => captureRepository(repo, destination), /EEXIST/);
  assert.deepEqual(fs.readFileSync(path.join(destination, "manifest.json")), saved);
});

test("inventory includes dirty submodule even with ignore settings", (t) => {
  const { base, repo } = fixture(t);
  const sub = path.join(repo, "sub");
  fs.mkdirSync(sub);
  git(sub, "init", "-q", "-b", "main");
  git(sub, "config", "user.name", "test");
  git(sub, "config", "user.email", "test@local");
  fs.writeFileSync(path.join(sub, "subfile"), "subv1");
  git(sub, "add", ".");
  git(sub, "commit", "-qm", "sub initial");

  git(repo, "submodule", "add", "./sub", "sub");
  fs.writeFileSync(path.join(repo, ".gitmodules"), '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n\tignore = all\n');
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "add submodule with ignore=all");

  // Make submodule dirty
  fs.writeFileSync(path.join(sub, "subfile"), "subv2");

  const result = inventoryRepositories([repo]);
  const subRow = result.repositories.find(r => r.path === fs.realpathSync(sub));
  assert.ok(subRow, "submodule should be inventoried");
  assert.equal(subRow.entries.some(e => e.path === "subfile"), true, "dirty file in submodule must be enumerated");
  assert.equal(result.clean, false);
});

test("capture refuses to certify when branch or stash changes during capture", (t) => {
  const { base, repo } = fixture(t);
  fs.writeFileSync(path.join(repo, "file"), "v2");
  const result = captureRepository(repo, path.join(base, "capture"), {
    beforeVerify() {
      git(repo, "stash", "push", "-qm", "test stash");
    }
  });
  assert.equal(result.complete, false);
  assert.match(result.issues.join("\n"), /changed during capture/);
});

test("capture source revalidation tolerates unrelated shared-ref maintenance", (t) => {
  const { base, repo } = fixture(t);
  fs.writeFileSync(path.join(repo, "file"), "dirty");
  const capture = captureRepository(repo, path.join(base, "capture"));
  assert.equal(capture.complete, true);
  git(repo, "branch", "maintenance-marker");
  assert.deepEqual(verifyCaptureSource(capture), []);
});

test("shared metadata cache reuses independent bundles and refreshes after a new commit", (t) => {
  const { base, repo } = fixture(t);
  const cache = new Map();
  const dest1 = path.join(base, "capture1");
  const result1 = captureRepository(repo, dest1, { metadataCache: cache });
  assert.equal(result1.complete, true);

  const destSame = path.join(base, "capture-same");
  const resultSame = captureRepository(repo, destSame, { metadataCache: cache });
  assert.equal(resultSame.complete, true);
  assert.equal(resultSame.metadata.archiveDeduplicated, false);
  assert.equal(resultSame.metadata.bundleDeduplicated, true);
  assert.notEqual(
    fs.statSync(result1.metadata.archive).ino,
    fs.statSync(resultSame.metadata.archive).ino,
  );
  assert.notEqual(
    fs.statSync(result1.metadata.bundle).ino,
    fs.statSync(resultSame.metadata.bundle).ino,
  );
  assert.deepEqual(
    fs.readFileSync(result1.metadata.bundle),
    fs.readFileSync(resultSame.metadata.bundle),
  );

  fs.writeFileSync(path.join(repo, "file2"), "new commit file");
  git(repo, "add", "file2");
  git(repo, "commit", "-qm", "second commit");
  const head2 = git(repo, "rev-parse", "HEAD");

  const dest2 = path.join(base, "capture2");
  const result2 = captureRepository(repo, dest2, { metadataCache: cache });
  assert.equal(result2.complete, true);
  assert.equal(result2.metadata.bundleDeduplicated, false);
  assert.equal(result2.metadata.bundle, fs.realpathSync(path.join(dest2, "history.bundle")));

  const bundleHeads = git(repo, "bundle", "list-heads", result2.metadata.bundle);
  assert.match(bundleHeads, new RegExp(head2));
});

test("referenced worktree heads share one verified bundle", (t) => {
  const { base, repo } = fixture(t);
  fs.writeFileSync(path.join(repo, "file2"), "second");
  git(repo, "add", "file2");
  git(repo, "commit", "-qm", "second");
  const linked = path.join(base, "linked");
  git(repo, "worktree", "add", "--detach", linked, "HEAD~1");
  const cache = new Map();
  const first = captureRepository(repo, path.join(base, "main-capture"), {
    metadataCache: cache,
  });
  const second = captureRepository(linked, path.join(base, "linked-capture"), {
    metadataCache: cache,
  });
  assert.equal(first.complete, true);
  assert.equal(second.complete, true);
  assert.equal(second.metadata.bundleDeduplicated, true);
  assert.notEqual(
    fs.statSync(first.metadata.bundle).ino,
    fs.statSync(second.metadata.bundle).ino,
  );
  assert.deepEqual(
    fs.readFileSync(first.metadata.bundle),
    fs.readFileSync(second.metadata.bundle),
  );
  assert.equal(
    git(repo, "cat-file", "-e", `${second.head}^{commit}`),
    "",
  );
});

test("metadata archive is fresh when staged index changes", (t) => {
  const { base, repo } = fixture(t);
  const cache = new Map();
  fs.writeFileSync(path.join(repo, "file"), "staged-a");
  git(repo, "add", "file");
  const first = captureRepository(repo, path.join(base, "capture-a"), {
    metadataCache: cache,
  });
  fs.writeFileSync(path.join(repo, "file"), "staged-b");
  git(repo, "add", "file");
  const second = captureRepository(repo, path.join(base, "capture-b"), {
    metadataCache: cache,
  });
  assert.equal(first.complete, true);
  assert.equal(second.complete, true);
  assert.equal(second.metadata.archiveDeduplicated, false);
  const extracted = path.join(base, "extracted");
  fs.mkdirSync(extracted);
  execFileSync("tar", ["-xf", second.metadata.archive, "-C", extracted]);
  assert.deepEqual(
    fs.readFileSync(path.join(extracted, "index")),
    fs.readFileSync(path.join(second.directory, "index")),
  );
});

test("object archive restores a commit reachable only from reflog", (t) => {
  const { base, repo } = fixture(t);
  fs.writeFileSync(path.join(repo, "lost"), "reflog-only\n");
  git(repo, "add", "lost");
  git(repo, "commit", "-qm", "lost commit");
  const lost = git(repo, "rev-parse", "HEAD");
  git(repo, "reset", "--hard", "HEAD~1");
  fs.writeFileSync(path.join(repo, "file"), "dirty\n");
  const capture = captureRepository(repo, path.join(base, "capture"), {
    metadataCache: new Map(),
  });
  assert.equal(capture.complete, true);
  const restored = path.join(base, "restored.git");
  git(base, "init", "--bare", restored);
  execFileSync("tar", ["-xf", capture.metadata.objectArchive, "-C", restored]);
  assert.equal(git(restored, "cat-file", "-e", `${lost}^{commit}`), "");
  assert.equal(git(restored, "show", `${lost}:lost`), "reflog-only");
});

test("capture rejects non-empty alternate object stores", (t) => {
  const { base, repo } = fixture(t);
  const altDir = path.join(repo, ".git", "objects", "info");
  fs.mkdirSync(altDir, { recursive: true });
  fs.writeFileSync(path.join(altDir, "alternates"), "/tmp/nonexistent-alt-objects\n");

  const result = captureRepository(repo, path.join(base, "capture"));
  assert.equal(result.complete, false);
  assert.match(result.issues.join("\n"), /alternate/i);
});

test("fatal decoding error on invalid UTF-8 git output", (t) => {
  const { base, repo } = fixture(t);
  const refsHeads = path.join(repo, ".git", "refs", "heads");
  const badRefPath = Buffer.concat([Buffer.from(refsHeads + "/bad-"), Buffer.from([0xff, 0xfe])]);
  let created = false;
  try {
    const headCommit = git(repo, "rev-parse", "HEAD");
    fs.writeFileSync(badRefPath, headCommit + "\n");
    created = true;
  } catch {
    return;
  }

  if (created) {
    assert.throws(() => {
      inspectRepository(repo);
    }, (err) => err instanceof TypeError || /utf/i.test(err.message));
  }
});

test("capture rejects symlink targets that cannot be decoded losslessly", (t) => {
  const {base, repo} = fixture(t);
  try { fs.symlinkSync(Buffer.from([0xff]), path.join(repo, "raw-link")); }
  catch (error) { if (["EINVAL", "ENOTSUP", "EILSEQ"].includes(error.code)) return t.skip("filesystem rejects invalid UTF8 targets"); throw error; }
  const result = captureRepository(repo, path.join(base, "capture"));
  assert.equal(result.complete, false);
  assert.match(result.issues.join(" "), /encoded data|encoding|UTF-8/i);
  assert.deepEqual(fs.readlinkSync(path.join(repo, "raw-link"), {encoding:"buffer"}), Buffer.from([0xff]));
});
