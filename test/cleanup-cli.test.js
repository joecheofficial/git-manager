"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { runCleanupCli, parseArgs, waitForQuiescence } = require("../src/cleanup-cli");

function createTempDir(prefix = "git-manager-cli-test-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initGitRepo(repoPath) {
  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@local"], { cwd: repoPath, stdio: "ignore" });
}

test("parseArgs parses --repo, --repos-file, and --backup-dir options", () => {
  const tmpDir = createTempDir();
  const reposFile = path.join(tmpDir, "repos.json");
  fs.writeFileSync(reposFile, JSON.stringify(["/tmp/repo2", "/tmp/repo3"]));

  const args = [
    "--repo", "/tmp/repo1",
    "--repos-file", reposFile,
    "--backup-dir", "/tmp/backup-out"
  ];

  const parsed = parseArgs(args);
  assert.deepEqual(parsed.roots, ["/tmp/repo1", "/tmp/repo2", "/tmp/repo3"]);
  assert.equal(parsed.backupDir, "/tmp/backup-out");
});

test("parseArgs throws on unknown or missing options", () => {
  assert.throws(() => parseArgs(["--repo"]), /Missing value for --repo/);
  assert.throws(() => parseArgs(["--backup-dir"]), /Missing value for --backup-dir/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown argument: --unknown/);
});

test("default inventory mode prints JSON and writes nothing", () => {
  const repoDir = createTempDir("cli-inventory-repo-");
  initGitRepo(repoDir);

  const file = path.join(repoDir, "initial.txt");
  fs.writeFileSync(file, "hello world\n");
  execFileSync("git", ["add", "initial.txt"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: repoDir, stdio: "ignore" });

  const result = runCleanupCli(["--repo", repoDir], { quiet: true });
  assert.equal(result.success, true);
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes('"mode": "cleanup-inventory"'));

  const parsedOut = JSON.parse(result.stdout);
  assert.equal(parsedOut.taskClass, "maintenance");
  assert.equal(parsedOut.mode, "cleanup-inventory");
  assert.equal(parsedOut.repositories.length, 1);
  assert.equal(parsedOut.errors.length, 0);
});

test("--backup-dir mode captures dirty repository and saves report files", () => {
  const repoDir = createTempDir("cli-backup-repo-");
  initGitRepo(repoDir);

  // Commit initial file
  fs.writeFileSync(path.join(repoDir, "committed.txt"), "v1\n");
  execFileSync("git", ["add", "committed.txt"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });

  // Make dirty changes (modified file & untracked file)
  fs.writeFileSync(path.join(repoDir, "committed.txt"), "v2 modified\n");
  fs.writeFileSync(path.join(repoDir, "untracked.txt"), "untracked content\n");

  const parentBackupDir = createTempDir("cli-backup-out-");
  const backupDir = path.join(parentBackupDir, "my-backup");

  const result = runCleanupCli(["--repo", repoDir, "--backup-dir", backupDir], { quiet: true });

  assert.equal(result.success, true, `Expected success but got stderr: ${result.stderr}`);
  assert.equal(result.exitCode, 0);

  // Check backup directory files
  assert.ok(fs.existsSync(path.join(backupDir, "inventory.json")));
  assert.ok(fs.existsSync(path.join(backupDir, "captures.json")));
  assert.ok(fs.existsSync(path.join(backupDir, "report.json")));

  const report = JSON.parse(fs.readFileSync(path.join(backupDir, "report.json"), "utf8"));
  assert.equal(report.taskClass, "maintenance");
  assert.equal(report.mode, "cleanup-capture-report");
  assert.equal(report.complete, true);
  assert.equal(report.captures.length, 1);
  assert.equal(report.captures[0].complete, true);

  // Check files captured in manifest
  const captureDir = report.captures[0].directory;
  assert.ok(fs.existsSync(path.join(captureDir, "manifest.json")));
  assert.ok(fs.existsSync(path.join(captureDir, "unstaged.patch")));
});

test("final verification rejects an artifact changed after capture", () => {
  const repoDir = createTempDir("cli-corrupt-repo-");
  initGitRepo(repoDir);
  fs.writeFileSync(path.join(repoDir, "file"), "committed\n");
  execFileSync("git", ["add", "file"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir, stdio: "ignore" });
  fs.writeFileSync(path.join(repoDir, "file"), "dirty\n");
  const backupDir = path.join(createTempDir("cli-corrupt-out-"), "backup");
  const result = runCleanupCli(
    ["--repo", repoDir, "--backup-dir", backupDir],
    {
      quiet: true,
      beforeFinalVerify(captures) {
        const bundle = captures[0].metadata.bundle;
        fs.chmodSync(bundle, 0o600);
        fs.appendFileSync(bundle, "corruption");
      },
    },
  );
  assert.equal(result.success, false);
  assert.equal(result.report.complete, false);
  assert.match(result.captures[0].issues.join("\n"), /history bundle verification failed: hash mismatch/);
});

test("final verification rejects a source changed after its capture", () => {
  const repoDir = createTempDir("cli-source-race-repo-");
  initGitRepo(repoDir);
  fs.writeFileSync(path.join(repoDir, "file"), "committed\n");
  execFileSync("git", ["add", "file"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir, stdio: "ignore" });
  fs.writeFileSync(path.join(repoDir, "file"), "dirty\n");
  const backupDir = path.join(createTempDir("cli-source-race-out-"), "backup");
  const result = runCleanupCli(
    ["--repo", repoDir, "--backup-dir", backupDir],
    {
      quiet: true,
      beforeFinalVerify() {
        fs.writeFileSync(path.join(repoDir, "late-untracked"), "late\n");
      },
    },
  );
  assert.equal(result.success, false);
  assert.equal(result.report.complete, false);
  assert.match(result.captures[0].issues.join("\n"), /Source HEAD, branch, status or index changed after capture/);
});

test("final verification rejects an initially clean repository that becomes dirty", () => {
  const cleanRepo = createTempDir("cli-clean-race-");
  const dirtyRepo = createTempDir("cli-dirty-race-");
  for (const repo of [cleanRepo, dirtyRepo]) {
    initGitRepo(repo);
    fs.writeFileSync(path.join(repo, "file"), "committed\n");
    execFileSync("git", ["add", "file"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
  }
  fs.writeFileSync(path.join(dirtyRepo, "file"), "dirty\n");
  const backupDir = path.join(createTempDir("cli-clean-race-out-"), "backup");
  const result = runCleanupCli(
    ["--repo", cleanRepo, "--repo", dirtyRepo, "--backup-dir", backupDir],
    {
      quiet: true,
      beforeFinalVerify() {
        fs.writeFileSync(path.join(cleanRepo, "late-work"), "late\n");
      },
    },
  );
  assert.equal(result.success, false);
  assert.equal(result.report.complete, false);
  assert.equal(result.report.inventoryRevalidation[0].path, cleanRepo);
});

test("captures a repository that becomes dirty between inventory and baseline", () => {
  const repoDir = createTempDir("cli-inventory-baseline-race-");
  initGitRepo(repoDir);
  fs.writeFileSync(path.join(repoDir, "file"), "committed\n");
  execFileSync("git", ["add", "file"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir, stdio: "ignore" });

  const real = require("../src/preservation");
  const backupDir = path.join(createTempDir("cli-inventory-baseline-out-"), "backup");
  let firstBaseline = true;
  const result = runCleanupCli(
    ["--repo", repoDir, "--backup-dir", backupDir],
    {
      quiet: true,
      preservation: {
        ...real,
        sourceBaseline(repo) {
          if (firstBaseline) {
            firstBaseline = false;
            fs.writeFileSync(path.join(repo, "late-between"), "late\n");
          }
          return real.sourceBaseline(repo);
        },
      },
    },
  );

  assert.equal(result.success, true);
  assert.equal(result.report.complete, true);
  assert.equal(result.captures.length, 1);
  assert.equal(result.captures[0].complete, true);
  assert.equal(
    fs.readFileSync(path.join(result.captures[0].directory, "files", "late-between"), "utf8"),
    "late\n",
  );
});

test("capture setup failure returns a structured incomplete report", () => {
  const repoDir = createTempDir("cli-capture-failure-");
  initGitRepo(repoDir);
  fs.writeFileSync(path.join(repoDir, "file"), "committed\n");
  execFileSync("git", ["add", "file"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir, stdio: "ignore" });
  fs.writeFileSync(path.join(repoDir, "file"), "dirty\n");
  const real = require("../src/preservation");
  const backupDir = path.join(createTempDir("cli-capture-failure-out-"), "backup");
  const result = runCleanupCli(
    ["--repo", repoDir, "--backup-dir", backupDir],
    {
      quiet: true,
      preservation: {
        ...real,
        captureRepository() {
          throw new Error("simulated capture setup failure");
        },
      },
    },
  );
  assert.equal(result.success, false);
  assert.equal(result.report.complete, false);
  assert.match(result.captures[0].issues.join("\n"), /simulated capture setup failure/);
});

test("existing backup directory fails without modifying", () => {
  const repoDir = createTempDir("cli-existing-repo-");
  initGitRepo(repoDir);
  fs.writeFileSync(path.join(repoDir, "f.txt"), "init\n");
  execFileSync("git", ["add", "f.txt"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });
  fs.writeFileSync(path.join(repoDir, "f.txt"), "dirty\n");

  const existingBackupDir = createTempDir("cli-existing-backup-");
  const canaryFile = path.join(existingBackupDir, "canary.txt");
  fs.writeFileSync(canaryFile, "do not touch\n");

  const result = runCleanupCli(["--repo", repoDir, "--backup-dir", existingBackupDir], { quiet: true });
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 1);
  assert.ok(result.stderr.includes("already exists"));

  // Check that canary file was untouched and no inventory.json was created inside
  assert.equal(fs.readFileSync(canaryFile, "utf8"), "do not touch\n");
  assert.equal(fs.existsSync(path.join(existingBackupDir, "inventory.json")), false);
});

test("destination within any repo or Git metadata fails (including symlink parent alias)", () => {
  const parentTmp = createTempDir("cli-parent-tmp-");
  const repoDir = path.join(parentTmp, "target-repo");
  initGitRepo(repoDir);

  // Attempt 1: destination inside repo root directly
  const insideDir = path.join(repoDir, "backup-inside");
  const res1 = runCleanupCli(["--repo", repoDir, "--backup-dir", insideDir], { quiet: true });
  assert.equal(res1.success, false);
  assert.equal(res1.exitCode, 1);
  assert.ok(res1.stderr.includes("must be outside every inventoried repository"));

  // Attempt 2: destination inside .git folder
  const gitDirSub = path.join(repoDir, ".git", "backup-inside-git");
  const res2 = runCleanupCli(["--repo", repoDir, "--backup-dir", gitDirSub], { quiet: true });
  assert.equal(res2.success, false);
  assert.equal(res2.exitCode, 1);
  assert.ok(res2.stderr.includes("must be outside every inventoried repository"));

  // Attempt 3: symlink parent alias pointing to repo directory
  const symlinkRepoDir = path.join(parentTmp, "symlink-alias");
  fs.symlinkSync(repoDir, symlinkRepoDir);

  const destinationViaSymlink = path.join(symlinkRepoDir, "backup-via-alias");
  const res3 = runCleanupCli(["--repo", repoDir, "--backup-dir", destinationViaSymlink], { quiet: true });
  assert.equal(res3.success, false);
  assert.equal(res3.exitCode, 1);
  assert.ok(res3.stderr.includes("must be outside every inventoried repository"));
});

test("backup parent directory must exist (mkdir nonrecursive)", () => {
  const repoDir = createTempDir("cli-nonrec-repo-");
  initGitRepo(repoDir);

  const missingParent = path.join(os.tmpdir(), `non-existent-parent-${Date.now()}`);
  const nestedBackup = path.join(missingParent, "sub", "backup");

  const result = runCleanupCli(["--repo", repoDir, "--backup-dir", nestedBackup], { quiet: true });
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 1);
  assert.ok(result.stderr.includes("parent directory does not exist"));
});

test("--backup-dir must be an absolute path", () => {
  const repoDir = createTempDir("cli-rel-repo-");
  initGitRepo(repoDir);

  const result = runCleanupCli(["--repo", repoDir, "--backup-dir", "relative/dir"], { quiet: true });
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 1);
  assert.ok(result.stderr.includes("absolute path"));
});

test("fails exit nonzero when inventory contains errors", () => {
  const nonExistentRepo = path.join(os.tmpdir(), "non-existent-repo-1234567890");

  const result = runCleanupCli(["--repo", nonExistentRepo], { quiet: true });
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 1);
});

test("handles multiple repositories and shares metadataCache", () => {
  const repoDir1 = createTempDir("cli-repo1-");
  initGitRepo(repoDir1);
  fs.writeFileSync(path.join(repoDir1, "f1.txt"), "init\n");
  execFileSync("git", ["add", "f1.txt"], { cwd: repoDir1, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir1, stdio: "ignore" });
  fs.writeFileSync(path.join(repoDir1, "f1.txt"), "dirty1\n");

  const repoDir2 = createTempDir("cli-repo2-");
  initGitRepo(repoDir2);
  fs.writeFileSync(path.join(repoDir2, "f2.txt"), "init\n");
  execFileSync("git", ["add", "f2.txt"], { cwd: repoDir2, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir2, stdio: "ignore" });
  // repoDir2 is clean

  const parentBackupDir = createTempDir("cli-multi-backup-out-");
  const backupDir = path.join(parentBackupDir, "multi-backup");

  const result = runCleanupCli(["--repo", repoDir1, "--repo", repoDir2, "--backup-dir", backupDir], { quiet: true });
  assert.equal(result.success, true);
  assert.equal(result.exitCode, 0);

  const report = JSON.parse(fs.readFileSync(path.join(backupDir, "report.json"), "utf8"));
  assert.equal(report.complete, true);
  // Only repoDir1 was dirty so only 1 capture
  assert.equal(report.captures.length, 1);
  assert.equal(report.captures[0].repo, repoDir1);
});

test("accepts an exact clean linked worktree nested below its parent checkout", () => {
  const repoDir = createTempDir("cli-nested-worktree-");
  initGitRepo(repoDir);
  fs.writeFileSync(path.join(repoDir, "file"), "committed\n");
  execFileSync("git", ["add", "file"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir, stdio: "ignore" });
  const nested = path.join(repoDir, ".worktrees", "feature");
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  execFileSync("git", ["worktree", "add", "-b", "feature", nested], { cwd: repoDir, stdio: "ignore" });
  fs.writeFileSync(path.join(repoDir, "file"), "dirty parent\n");

  const backupDir = path.join(createTempDir("cli-nested-worktree-out-"), "backup");
  const result = runCleanupCli(["--repo", repoDir, "--backup-dir", backupDir], { quiet: true });

  assert.equal(result.success, true);
  assert.equal(result.report.complete, true);
  assert.equal(result.captures.length, 1);
  assert.deepEqual(result.captures[0].linkedWorktrees, [{
    path: fs.realpathSync(nested),
    sourceToken: result.captures[0].linkedWorktrees[0].sourceToken,
    dirty: false,
  }]);
});

test("stores one verified artifact set for dirty worktrees sharing a Git store", () => {
  const repoDir = createTempDir("cli-shared-artifacts-");
  initGitRepo(repoDir);
  fs.writeFileSync(path.join(repoDir, "file"), "committed\n");
  execFileSync("git", ["add", "file"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir, stdio: "ignore" });
  const nested = path.join(repoDir, ".worktrees", "feature");
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  execFileSync("git", ["worktree", "add", "-b", "feature", nested], { cwd: repoDir, stdio: "ignore" });
  fs.writeFileSync(path.join(repoDir, "file"), "dirty parent\n");
  fs.writeFileSync(path.join(nested, "file"), "dirty nested\n");

  const backupDir = path.join(createTempDir("cli-shared-artifacts-out-"), "backup");
  const result = runCleanupCli(["--repo", repoDir, "--backup-dir", backupDir], { quiet: true });

  assert.equal(result.success, true);
  assert.equal(result.captures.length, 2);
  assert.equal(new Set(result.captures.map(c => c.metadata.archive)).size, 1);
  assert.equal(new Set(result.captures.map(c => c.metadata.objectArchive)).size, 1);
  assert.equal(new Set(result.captures.map(c => c.metadata.bundle)).size, 1);
  assert.equal(fs.readdirSync(path.join(backupDir, "artifacts")).length, 3);
});

test("executable child process invocation succeeds in default inventory mode", () => {
  const repoDir = createTempDir("cli-proc-repo-");
  initGitRepo(repoDir);
  fs.writeFileSync(path.join(repoDir, "f.txt"), "init\n");
  execFileSync("git", ["add", "f.txt"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });

  const cliPath = path.resolve(__dirname, "../src/cleanup-cli.js");
  const stdout = execFileSync(process.execPath, [cliPath, "--repo", repoDir], { encoding: "utf8" });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.taskClass, "maintenance");
  assert.equal(parsed.mode, "cleanup-inventory");
  assert.equal(parsed.errors.length, 0);
});

test("quiescence preflight refuses capture while any worktree has protected active work", () => {
  const repoDir = createTempDir("cli-quiescence-protected-");
  initGitRepo(repoDir);
  fs.writeFileSync(path.join(repoDir, "file"), "committed\n");
  execFileSync("git", ["add", "file"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir, stdio: "ignore" });
  fs.writeFileSync(path.join(repoDir, "file"), "dirty\n");
  const backupDir = path.join(createTempDir("cli-quiescence-protected-out-"), "backup");

  const result = runCleanupCli(
    ["--repo", repoDir, "--backup-dir", backupDir, "--wait-for-quiescence-ms", "1", "--max-wait-ms", "1"],
    {
      quiet: true,
      activeWork: { inspectActiveWork: () => ({ protected: true, detectorError: null, reasons: [{ type: "live-writer", pid: 1 }] }) },
    },
  );

  assert.equal(result.success, false);
  assert.equal(result.exitCode, 75);
  assert.equal(result.report.mode, "cleanup-quiescence-report");
  assert.equal(result.report.complete, false);
  assert.equal(fs.existsSync(backupDir), false);
});

test("quiescence preflight requires two stable snapshots before capture", () => {
  const repoDir = createTempDir("cli-quiescence-stable-");
  initGitRepo(repoDir);
  fs.writeFileSync(path.join(repoDir, "file"), "committed\n");
  execFileSync("git", ["add", "file"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir, stdio: "ignore" });
  fs.writeFileSync(path.join(repoDir, "file"), "dirty\n");
  const backupDir = path.join(createTempDir("cli-quiescence-stable-out-"), "backup");

  const result = runCleanupCli(
    ["--repo", repoDir, "--backup-dir", backupDir, "--wait-for-quiescence-ms", "1", "--max-wait-ms", "5000"],
    {
      quiet: true,
      activeWork: { inspectActiveWork: () => ({ protected: false, detectorError: null, reasons: [] }) },
    },
  );

  assert.equal(result.success, true);
  assert.equal(result.quiescence.complete, true);
  assert.equal(result.quiescence.attempts, 2);
  assert.equal(result.report.complete, true);
});

test("quiescence preflight rejects a zero observation interval", () => {
  assert.throws(
    () => parseArgs(["--repo", "/tmp/repo", "--wait-for-quiescence-ms", "0", "--max-wait-ms", "0"]),
    /must be a positive integer/,
  );
});

test("quiescence preflight rejects a Git operation that appears between snapshots", () => {
  let inventoryCall = 0;
  const preservation = {
    inventoryRepositories() {
      inventoryCall += 1;
      return {
        repositories: [{ path: "/fixture", entries: [], operations: inventoryCall === 1 ? [] : ["MERGE_HEAD"] }],
        errors: [],
      };
    },
    sourceFingerprint() { return "unchanged"; },
  };
  let clock = 0;
  const result = waitForQuiescence(["/fixture"], 1, 1, {
    preservation,
    activeWork: { inspectActiveWork: () => ({ protected: false, detectorError: null, reasons: [] }) },
    sleep() {},
    now: () => clock++,
  });

  assert.equal(result.complete, false);
  assert.equal(result.lastSnapshot.worktrees[0].operations[0], "MERGE_HEAD");
});

test("quiescence preflight refuses a stable snapshot that completes after its deadline", () => {
  const preservation = {
    inventoryRepositories() { return { repositories: [{ path: "/fixture", entries: [], operations: [] }], errors: [] }; },
    sourceFingerprint() { return "unchanged"; },
  };
  const ticks = [0, 2];
  const result = waitForQuiescence(["/fixture"], 1, 1, {
    preservation,
    activeWork: { inspectActiveWork: () => ({ protected: false, detectorError: null, reasons: [] }) },
    sleep() {},
    now: () => ticks.shift() ?? 2,
  });

  assert.equal(result.complete, false);
  assert.equal(result.elapsedMs, 2);
});
