"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const safety = require("../safety");
const branches = require("../branches");
const github = require("../github");

function createTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-mgr-test-"));
  execFileSync("git", ["init", "-b", "main", dir], { stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["-C", dir, "config", "user.name", "Test User"], { stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"], { stdio: ["ignore", "pipe", "pipe"] });

  fs.writeFileSync(path.join(dir, "README.md"), "# Test Repo\n");
  execFileSync("git", ["-C", dir, "add", "README.md"], { stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["-C", dir, "commit", "-m", "Initial commit"], { stdio: ["ignore", "pipe", "pipe"] });

  return dir;
}

function cleanupTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

let passed = 0;
let failed = 0;

function runTest(name, fn) {
  process.stdout.write(`Testing ${name}... `);
  try {
    fn();
    console.log("PASS");
    passed++;
  } catch (err) {
    console.log("FAIL");
    console.error(`  Error: ${err.message}`);
    failed++;
  }
}

runTest("safety.scanForSecrets detects and redacts fake secret key", () => {
  const repo = createTempGitRepo();
  try {
    const secretFile = path.join(repo, "config.js");
    const fakeKey = "sk-proj-123456789012345678901234567890";
    fs.writeFileSync(secretFile, `const apiKey = "${fakeKey}";\n`);
    execFileSync("git", ["-C", repo, "add", "config.js"], { stdio: ["ignore", "pipe", "pipe"] });

    // Masking depends on the scanner. Without gitleaks the built-in scanner
    // keeps the first and last four characters (sk-p...7890). With gitleaks
    // --redact the secret arrives as REDACTED and is marked [REDACTED]. Check
    // the built-in path every time (PATH holding only git hides gitleaks), and
    // the gitleaks path too when gitleaks is installed.
    const masked = `${fakeKey.slice(0, 4)}...${fakeKey.slice(-4)}`;
    const assertMasked = (result) => {
      assert.strictEqual(result.clean, false, `Expected ${result.scanner} scan clean to be false`);
      assert.ok(result.findings.length > 0, `Expected at least one ${result.scanner} secret finding`);
      for (const finding of result.findings) {
        assert.strictEqual(finding.redactedMatch.includes(fakeKey), false, "Redacted match must not contain the original key");
        assert.strictEqual(finding.redactedMatch.includes(fakeKey.slice(4, -4)), false, "Redacted match must not contain the key body");
      }
      const matches = result.findings.map((finding) => finding.redactedMatch);
      if (result.scanner === "gitleaks") assert.ok(matches.some((match) => match.includes("[REDACTED]")), `Expected a [REDACTED] marker, got ${matches.join(", ")}`);
      else assert.ok(matches.includes(masked), `Expected masked form ${masked}, got ${matches.join(", ")}`);
    };

    const gitOnlyBin = fs.mkdtempSync(path.join(os.tmpdir(), "git-mgr-bin-"));
    const originalPath = process.env.PATH;
    try {
      const gitBinary = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
      fs.symlinkSync(path.join(gitBinary, "git"), path.join(gitOnlyBin, "git"));
      process.env.PATH = gitOnlyBin;
      const builtin = safety.scanForSecrets({ repositoryRoot: repo, staged: true });
      assert.strictEqual(builtin.scanner, "builtin-regex", "Expected the built-in scanner when gitleaks is not on PATH");
      assertMasked(builtin);
    } finally {
      process.env.PATH = originalPath;
      cleanupTempDir(gitOnlyBin);
    }

    assertMasked(safety.scanForSecrets({ repositoryRoot: repo, staged: true }));
  } finally {
    cleanupTempDir(repo);
  }
});

runTest("safety.checkLargeFiles flags oversized file", () => {
  const repo = createTempGitRepo();
  try {
    const largeFile = path.join(repo, "large_blob.bin");
    const fd = fs.openSync(largeFile, "w");
    fs.ftruncateSync(fd, 101 * 1024 * 1024);
    fs.closeSync(fd);
    execFileSync("git", ["-C", repo, "add", "large_blob.bin"], { stdio: ["ignore", "pipe", "pipe"] });

    const result = safety.checkLargeFiles({ repositoryRoot: repo });
    assert.strictEqual(result.ok, false, "Expected checkLargeFiles ok to be false");
    assert.ok(result.blockers.length > 0, "Expected at least one blocker for oversized file");
  } finally {
    cleanupTempDir(repo);
  }
});

runTest("branches.deleteBranch refuses without confirmation phrase", () => {
  const repo = createTempGitRepo();
  try {
    execFileSync("git", ["-C", repo, "checkout", "-b", "feature-work"], { stdio: ["ignore", "pipe", "pipe"] });
    fs.writeFileSync(path.join(repo, "feature.txt"), "feature code\n");
    execFileSync("git", ["-C", repo, "add", "feature.txt"], { stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("git", ["-C", repo, "commit", "-m", "Unmerged feature work"], { stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("git", ["-C", repo, "checkout", "main"], { stdio: ["ignore", "pipe", "pipe"] });

    const result = branches.deleteBranch("feature-work", { root: repo });
    assert.strictEqual(result.status, "needs_approval", "Expected status to be needs_approval when confirmation is omitted");

    const deleteRes = branches.deleteBranch("feature-work", { confirm: "DELETE UNMERGED", root: repo });
    assert.strictEqual(deleteRes.status, "ok", "Expected deletion to succeed with DELETE UNMERGED confirmation");
  } finally {
    cleanupTempDir(repo);
  }
});

runTest("github.publishRepo refuses when visibility is missing or invalid", () => {
  const repo = createTempGitRepo();
  try {
    assert.throws(() => {
      github.publishRepo({ name: "test-repo" }, repo);
    }, /Visibility must be explicitly set/);

    assert.throws(() => {
      github.publishRepo({ name: "test-repo", visibility: "internal" }, repo);
    }, /Visibility must be explicitly set/);
  } finally {
    cleanupTempDir(repo);
  }
});

console.log(`\nTest Summary: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
