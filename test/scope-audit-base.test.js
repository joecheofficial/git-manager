"use strict";
// 5.10.1: finish and release audit sparse scope from the merge base with the claim's target branch.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { scopeAuditBase } = require("../src/checkin");
const identity = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "fixture-author", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "fixture-author", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...identity }, stdio: ["ignore", "pipe", "pipe"] }).trim();

test("scope audit base is the merge base with the target, so files merged in from the target are not counted as outside-scope changes", t => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gm-scope-base-")));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, ["-c", "init.defaultBranch=main", "init", "-q"]);
  fs.mkdirSync(path.join(repo, "claimed")); fs.writeFileSync(path.join(repo, "claimed/a.txt"), "a\n"); fs.writeFileSync(path.join(repo, "root.txt"), "r\n");
  git(repo, ["add", "."]); git(repo, ["commit", "-qm", "base"]);
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["checkout", "-qb", "codex/task"]);
  fs.writeFileSync(path.join(repo, "claimed/a.txt"), "a2\n"); git(repo, ["commit", "-qam", "claimed change"]);
  git(repo, ["checkout", "-q", "main"]);
  fs.writeFileSync(path.join(repo, "outside.txt"), "o\n"); git(repo, ["add", "."]); git(repo, ["commit", "-qm", "main moves on"]);
  git(repo, ["checkout", "-q", "codex/task"]); git(repo, ["merge", "-q", "--no-edit", "main"]);
  const claim = { baseSha, targetBranch: "main" };
  const auditBase = scopeAuditBase(repo, repo, claim, claim.targetBranch);
  assert.equal(auditBase, git(repo, ["merge-base", "main", "HEAD"]));
  const naive = git(repo, ["diff", "--name-only", baseSha, "HEAD"]).split("\n").filter(Boolean);
  const audited = git(repo, ["diff", "--name-only", auditBase, "HEAD"]).split("\n").filter(Boolean);
  assert.ok(naive.includes("outside.txt"), "the old base counted the merged-in file");
  assert.deepEqual(audited, ["claimed/a.txt"], "the merge base counts only the claim's own change");
  assert.equal(scopeAuditBase(repo, repo, { baseSha, targetBranch: "no-such-branch" }, "no-such-branch"), baseSha, "falls back to the pinned base when the target cannot be resolved");
  git(repo, ["tag", "shadow", "codex/task"]); git(repo, ["branch", "shadow", baseSha]);
  assert.equal(scopeAuditBase(repo, repo, { baseSha, targetBranch: "shadow" }, "shadow"), baseSha, "a same-named tag cannot shadow the target branch");
  git(repo, ["checkout", "-q", "--orphan", "rewritten"]); git(repo, ["commit", "-qm", "unrelated history"]); git(repo, ["checkout", "-q", "codex/task"]);
  assert.equal(scopeAuditBase(repo, repo, { baseSha, targetBranch: "rewritten" }, "rewritten"), baseSha, "a rewritten target never moves the audit base off the pinned base");
});
