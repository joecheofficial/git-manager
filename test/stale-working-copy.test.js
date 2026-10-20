"use strict";
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { staleWorkingCopyFindings } = require("../src/stale-working-copy");
const env = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_AUTHOR_DATE: "2026-10-03T12:00:00Z", GIT_COMMITTER_DATE: "2026-10-03T12:00:00Z" };
function git(repo, args, options = {}) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8", timeout: 20000, stdio: ["pipe", "pipe", "pipe"], env, ...options,
  }).trim();
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-manager-stale-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init", "-q"]);
  const file = "review.sh";
  fs.writeFileSync(path.join(repo, file), "v1\n");
  git(repo, ["add", "--", file]);
  git(repo, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "-qm", "old version"]);
  const old = git(repo, ["rev-parse", "HEAD"]);
  const indexEnv = { ...env, GIT_INDEX_FILE: path.join(root, "isolated-index") };
  const blob = git(repo, ["hash-object", "-w", "--stdin"], { input: "v2\n" });
  git(repo, ["read-tree", "HEAD"], { env: indexEnv });
  git(repo, ["update-index", "--add", "--cacheinfo", "100644", blob, file], { env: indexEnv });
  const tree = git(repo, ["write-tree"], { env: indexEnv });
  const newest = git(repo, ["-c", "commit.gpgSign=false", "commit-tree", tree, "-p", old, "-m", "fix review"]);
  git(repo, ["update-ref", "HEAD", newest]);
  // Publish the committed index too, leaving only the working copy at v1.
  git(repo, ["read-tree", "HEAD"]);
  fs.utimesSync(path.join(repo, file), new Date("2026-05-01"), new Date("2026-05-01"));
  return { repo, file, old, newest };
}
test("detects an isolated-index commit that never reached the working copy", () => {
  const { repo, file, old, newest } = fixture();
  const reports = [];
  const before = git(repo, ["status", "--porcelain"]);
  const findings = staleWorkingCopyFindings({ repos: [repo], report: (...args) => reports.push(args), now: Date.now() });
  assert.equal(findings.length, 1);
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0], ["stale-working-copy", "warn", repo,
    `${file}: the working copy is the older version from ${old.slice(0, 9)}; it silently reverts ${newest.slice(0, 9)} (fix review)`,
    `git restore ${file} (the old content stays in history at ${old.slice(0, 9)})`]);
  assert.equal(fs.readFileSync(path.join(repo, file), "utf8"), "v1\n");
  assert.equal(git(repo, ["status", "--porcelain"]), before);
});
test("ignores genuine in-progress content", () => {
  const { repo, file } = fixture();
  fs.writeFileSync(path.join(repo, file), "uncommitted new work\n");
  fs.utimesSync(path.join(repo, file), new Date("2026-05-01"), new Date("2026-05-01"));
  assert.deepEqual(staleWorkingCopyFindings({ repos: [repo] }), []);
});
test("ignores a deliberate manual revert newer than the commit", () => {
  const { repo, file } = fixture();
  fs.utimesSync(path.join(repo, file), new Date("2026-10-04"), new Date("2026-10-04"));
  assert.deepEqual(staleWorkingCopyFindings({ repos: [repo] }), []);
});
test("ignores untracked and staged files", () => {
  const { repo, file } = fixture();
  git(repo, ["add", "--", file]);
  fs.writeFileSync(path.join(repo, "untracked.sh"), "v1\n");
  assert.deepEqual(staleWorkingCopyFindings({ repos: [repo] }), []);
});
test("silently skips non-repositories and missing paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-manager-not-repo-"));
  assert.deepEqual(staleWorkingCopyFindings({ repos: [root, path.join(root, "missing")] }), []);
});
