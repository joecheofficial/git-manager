"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync, spawnSync } = require("node:child_process");
const { reportRetirement, applyRetirement: applyRetirementRaw, queueRetirement, drainRetirementQueue } = require("../src/branch-retirement");
const { runCli } = require("../src/branch-retirement-cli");

const inactiveDetector = () => ({ protected: false, detectorError: null, reasons: [] });
const applyRetirement = (options) => applyRetirementRaw({ inspectActiveWork: inactiveDetector, ...options });

function sh(cwd, cmd, args, env = {}) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  }).trim();
}

function createTestRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-retire-test-"));
  sh(dir, "git", ["init", "-b", "main"]);
  sh(dir, "git", ["config", "core.logAllRefUpdates", "true"]);
  sh(dir, "git", ["config", "user.name", "Test User"]);
  sh(dir, "git", ["config", "user.email", "git-fixture"]);
  sh(dir, "git", ["config", "commit.gpgsign", "false"]);

  const file = path.join(dir, "README.md");
  fs.writeFileSync(file, "# Test Repo\n");
  sh(dir, "git", ["add", "README.md"]);
  sh(dir, "git", ["commit", "-m", "Initial commit"]);

  return dir;
}

function ageHeadCheckoutActivity(repo, branchName, ageDays) {
  const gitDir = sh(repo, "git", ["rev-parse", "--absolute-git-dir"]);
  const headLog = path.join(gitDir, "logs", "HEAD");
  const oldSeconds = Math.floor((Date.now() - ageDays * 24 * 3600 * 1000) / 1000);
  const content = fs.readFileSync(headLog, "utf8").split("\n").map(line => {
    const message = line.slice(line.indexOf("\t") + 1);
    const match = message.match(/^checkout: moving from (\S+) to (\S+)$/);
    if (!match || (match[1] !== branchName && match[2] !== branchName)) return line;
    return line.replace(/ (\d+) ([+-]\d{4})\t/, ` ${oldSeconds} $2\t`);
  }).join("\n");
  fs.writeFileSync(headLog, content);
}

function createOldMergedBranch(repo, branchName, ageDays = 60) {
  const oldMs = Date.now() - ageDays * 24 * 3600 * 1000;
  const oldDate = new Date(oldMs).toISOString();
  sh(repo, "git", ["checkout", "-b", branchName]);
  fs.writeFileSync(path.join(repo, `${branchName}.txt`), `${branchName}\n`);
  sh(repo, "git", ["add", `${branchName}.txt`]);
  sh(repo, "git", ["commit", "-m", `Create ${branchName}`], {
    GIT_AUTHOR_DATE: oldDate,
    GIT_COMMITTER_DATE: oldDate,
  });
  const sha = sh(repo, "git", ["rev-parse", branchName]);
  sh(repo, "git", ["checkout", "main"]);
  sh(repo, "git", ["merge", "--no-ff", branchName, "-m", `Merge ${branchName}`], {
    GIT_AUTHOR_DATE: oldDate,
    GIT_COMMITTER_DATE: oldDate,
  });
  const gitDir = sh(repo, "git", ["rev-parse", "--absolute-git-dir"]);
  fs.writeFileSync(
    path.join(gitDir, "logs", "refs", "heads", branchName),
    `0000000000000000000000000000000000000000 ${sha} Test User <git-fixture> ${Math.floor(oldMs / 1000)} +0000 commit: Create ${branchName}\n`
  );
  ageHeadCheckoutActivity(repo, branchName, ageDays);
  return sha;
}

test("symbolic alias main remains and symbolic refs are retained", (t) => {
  const repo = createTestRepo();

  sh(repo, "git", ["symbolic-ref", "refs/heads/sym-main", "refs/heads/main"]);

  const report = reportRetirement({
    repo,
    base: "refs/heads/main",
    ownershipReviewed: true,
  });

  assert.ok(report.retained.length > 0, "Expected retained entries");
  const symEntry = report.retained.find(b => b.branchName === "sym-main");
  assert.ok(symEntry, "sym-main symbolic ref must be retained");
  assert.equal(symEntry.reason, "symbolic-ref");

  const symRefCheck = sh(repo, "git", ["symbolic-ref", "-q", "refs/heads/sym-main"]);
  assert.equal(symRefCheck, "refs/heads/main", "Symbolic ref must remain intact in repository");

  fs.rmSync(repo, { recursive: true, force: true });
});

test("rejected unmerged and squash-merged branches", (t) => {
  const repo = createTestRepo();

  // 1. Unmerged branch with unique commit
  sh(repo, "git", ["checkout", "-b", "unmerged-feat"]);
  fs.writeFileSync(path.join(repo, "feat.txt"), "feature work\n");
  sh(repo, "git", ["add", "feat.txt"]);
  sh(repo, "git", ["commit", "-m", "Add feature"]);
  sh(repo, "git", ["checkout", "main"]);

  // 2. Squash-merged branch (commit content integrated via new commit, but branch tip is NOT exact ancestor)
  sh(repo, "git", ["checkout", "-b", "squash-feat"]);
  fs.writeFileSync(path.join(repo, "squash.txt"), "squash work\n");
  sh(repo, "git", ["add", "squash.txt"]);
  sh(repo, "git", ["commit", "-m", "Squash feature"]);
  sh(repo, "git", ["checkout", "main"]);

  fs.writeFileSync(path.join(repo, "squash.txt"), "squash work\n");
  sh(repo, "git", ["add", "squash.txt"]);
  sh(repo, "git", ["commit", "-m", "Squash merge feat"]);

  const report = reportRetirement({
    repo,
    base: "refs/heads/main",
    ownershipReviewed: true,
  });

  const unmergedEntry = report.retained.find(b => b.branchName === "unmerged-feat");
  assert.ok(unmergedEntry, "unmerged-feat should be retained");
  assert.equal(unmergedEntry.reason, "unmerged");

  const squashEntry = report.retained.find(b => b.branchName === "squash-feat");
  assert.ok(squashEntry, "squash-feat should be retained (exact ancestor required)");
  assert.equal(squashEntry.reason, "unmerged");

  fs.rmSync(repo, { recursive: true, force: true });
});

test("explicit protected-duplicate mode retires only an exact alias and retains the protected keeper", (t) => {
  const repo = createTestRepo();
  sh(repo, "git", ["checkout", "-b", "codex/preserve-unique-work"]);
  fs.writeFileSync(path.join(repo, "unique.txt"), "preserved unique work\n");
  sh(repo, "git", ["add", "unique.txt"]);
  sh(repo, "git", ["commit", "-m", "Preserve unique work"]);
  const sha = sh(repo, "git", ["rev-parse", "HEAD"]);
  sh(repo, "git", ["branch", "ordinary-alias", sha]);
  sh(repo, "git", ["checkout", "main"]);

  const ordinaryReport = reportRetirement({ repo, base: "refs/heads/main", ownershipReviewed: true, minAgeDays: 0 });
  assert.equal(ordinaryReport.retained.find(row => row.branchName === "ordinary-alias").reason, "unmerged");

  const backupDir = path.join(os.tmpdir(), `test-backup-protected-duplicate-${Date.now()}`);
  const result = applyRetirement({
    repo,
    base: "refs/heads/main",
    ownershipReviewed: true,
    minAgeDays: 0,
    retireProtectedDuplicates: true,
    branches: ["ordinary-alias"],
    backupDir,
  });
  assert.deepEqual(result.retired, ["ordinary-alias"]);
  assert.equal(sh(repo, "git", ["rev-parse", "--verify", "refs/heads/codex/preserve-unique-work"]), sha);
  assert.throws(() => sh(repo, "git", ["rev-parse", "--verify", "refs/heads/ordinary-alias"]));

  if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("upstream wrong base error and wrong-upstream branch retained", (t) => {
  const repo = createTestRepo();

  // Create alternate base branch
  sh(repo, "git", ["checkout", "-b", "develop"]);
  fs.writeFileSync(path.join(repo, "dev.txt"), "dev work\n");
  sh(repo, "git", ["add", "dev.txt"]);
  sh(repo, "git", ["commit", "-m", "Dev commit"]);

  // Create branch merged into develop but NOT main
  sh(repo, "git", ["checkout", "-b", "dev-feature"]);
  fs.writeFileSync(path.join(repo, "dev-feat.txt"), "dev feat\n");
  sh(repo, "git", ["add", "dev-feat.txt"]);
  sh(repo, "git", ["commit", "-m", "Dev feat commit"]);
  sh(repo, "git", ["checkout", "develop"]);
  sh(repo, "git", ["merge", "--no-ff", "dev-feature", "-m", "Merge dev feat"]);
  sh(repo, "git", ["checkout", "main"]);

  // Test 1: Nonexistent base throws error
  assert.throws(
    () => {
      reportRetirement({
        repo,
        base: "refs/heads/nonexistent-base-branch",
        ownershipReviewed: true,
      });
    },
    /Base ref "refs\/heads\/nonexistent-base-branch" could not be verified/
  );

  // Test 2: Checking against main retains dev-feature because it is not merged into main
  const report = reportRetirement({
    repo,
    base: "refs/heads/main",
    ownershipReviewed: true,
  });

  const devFeatEntry = report.retained.find(b => b.branchName === "dev-feature");
  assert.ok(devFeatEntry, "dev-feature must be retained when evaluating against base refs/heads/main");
  assert.equal(devFeatEntry.reason, "unmerged");

  fs.rmSync(repo, { recursive: true, force: true });
});

test("protected, checkedout, and active branches retained", (t) => {
  const repo = createTestRepo();

  sh(repo, "git", ["checkout", "-b", "release/1.0"]);
  sh(repo, "git", ["checkout", "main"]);

  sh(repo, "git", ["checkout", "-b", "active-dev"]);
  sh(repo, "git", ["checkout", "main"]);

  const wtDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-wt-test-"));
  sh(repo, "git", ["worktree", "add", "-b", "wt-branch", wtDir, "main"]);

  const report = reportRetirement({
    repo,
    base: "refs/heads/main",
    ownershipReviewed: true,
    protectedBranches: ["release/*"],
    activeBranches: ["active-dev"],
  });

  const relEntry = report.retained.find(b => b.branchName === "release/1.0");
  assert.ok(relEntry, "release/1.0 should be protected");
  assert.equal(relEntry.reason, "protected");

  const activeEntry = report.retained.find(b => b.branchName === "active-dev");
  assert.ok(activeEntry, "active-dev should be active-branch");
  assert.equal(activeEntry.reason, "active-branch");

  const wtEntry = report.retained.find(b => b.branchName === "wt-branch");
  assert.ok(wtEntry, "wt-branch should be worktree-checkedout");
  assert.equal(wtEntry.reason, "worktree-checkedout");

  sh(repo, "git", ["worktree", "remove", "--force", wtDir]);
  fs.rmSync(wtDir, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("recently created old commit retained by reflog age", (t) => {
  const repo = createTestRepo();

  const oldDate = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
  fs.writeFileSync(path.join(repo, "old.txt"), "old content\n");
  sh(repo, "git", ["add", "old.txt"]);
  sh(repo, "git", ["commit", "-m", "Old commit"], {
    GIT_AUTHOR_DATE: oldDate,
    GIT_COMMITTER_DATE: oldDate,
  });
  const oldSha = sh(repo, "git", ["rev-parse", "HEAD"]);

  fs.writeFileSync(path.join(repo, "new-main.txt"), "new main content\n");
  sh(repo, "git", ["add", "new-main.txt"]);
  sh(repo, "git", ["commit", "-m", "Newer main commit"]);

  sh(repo, "git", ["branch", "old-commit-branch", oldSha]);

  const report = reportRetirement({
    repo,
    base: "refs/heads/main",
    ownershipReviewed: true,
    minAgeDays: 30,
  });

  const entry = report.retained.find(b => b.branchName === "old-commit-branch");
  assert.ok(entry, "old-commit-branch should be retained because reflog timestamp is recent");
  assert.equal(entry.reason, "too-recent");

  fs.rmSync(repo, { recursive: true, force: true });
});

test("unknown reflog age retained", (t) => {
  const repo = createTestRepo();

  const oldDate = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
  sh(repo, "git", ["checkout", "-b", "no-reflog-branch"]);
  fs.writeFileSync(path.join(repo, "no-reflog.txt"), "no reflog content\n");
  sh(repo, "git", ["add", "no-reflog.txt"]);
  sh(repo, "git", ["commit", "-m", "Commit without reflog"], {
    GIT_AUTHOR_DATE: oldDate,
    GIT_COMMITTER_DATE: oldDate,
  });
  sh(repo, "git", ["checkout", "main"]);
  sh(repo, "git", ["merge", "--no-ff", "no-reflog-branch", "-m", "Merge no reflog branch"]);

  const gitDir = sh(repo, "git", ["rev-parse", "--absolute-git-dir"]);
  const reflogFile = path.join(gitDir, "logs", "refs", "heads", "no-reflog-branch");
  if (fs.existsSync(reflogFile)) {
    fs.rmSync(reflogFile);
  }
  fs.writeFileSync(path.join(gitDir, "logs", "HEAD"), "");

  const report = reportRetirement({
    repo,
    base: "refs/heads/main",
    ownershipReviewed: true,
    minAgeDays: 30,
  });

  const entry = report.retained.find(b => b.branchName === "no-reflog-branch");
  assert.ok(entry, "no-reflog-branch should be retained with unknown-reflog-age");
  assert.equal(entry.reason, "unknown-reflog-age");

  fs.rmSync(repo, { recursive: true, force: true });
});

test("failed/tampered backup refuses apply without ref mutation", (t) => {
  const repo = createTestRepo();

  const oldDate = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
  sh(repo, "git", ["checkout", "-b", "merged-old"]);
  fs.writeFileSync(path.join(repo, "old-merged.txt"), "merged\n");
  sh(repo, "git", ["add", "old-merged.txt"]);
  sh(repo, "git", ["commit", "-m", "Old merged commit"], {
    GIT_AUTHOR_DATE: oldDate,
    GIT_COMMITTER_DATE: oldDate,
  });
  sh(repo, "git", ["checkout", "main"]);
  sh(repo, "git", ["merge", "--no-ff", "merged-old", "-m", "Merge merged-old"], {
    GIT_AUTHOR_DATE: oldDate,
    GIT_COMMITTER_DATE: oldDate,
  });

  const gitDir = sh(repo, "git", ["rev-parse", "--absolute-git-dir"]);
  const reflogFile = path.join(gitDir, "logs", "refs", "heads", "merged-old");
  const oldSecs = Math.floor((Date.now() - 40 * 24 * 3600 * 1000) / 1000);
  const headSha = sh(repo, "git", ["rev-parse", "merged-old"]);
  fs.writeFileSync(reflogFile, `0000000000000000000000000000000000000000 ${headSha} Test User <git-fixture> ${oldSecs} +0000 commit: Old merged commit\n`);
  ageHeadCheckoutActivity(repo, "merged-old", 40);

  const backupDir = path.join(os.tmpdir(), `test-backup-tampered-${Date.now()}`);

  assert.throws(
    () => {
      applyRetirement({
        repo,
        base: "refs/heads/main",
        backupDir,
        ownershipReviewed: true,
        minAgeDays: 30,
        hooks: {
          tamperBackup: (bDir, captureRes) => {
            captureRes.complete = false;
            captureRes.issues.push("Simulated backup failure");
          },
        },
      });
    },
    /Backup capture incomplete/
  );

  const branchExists = sh(repo, "git", ["rev-parse", "--verify", "refs/heads/merged-old"]);
  assert.equal(branchExists, headSha, "Branch ref must remain intact after backup failure");

  if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("candidate/base race aborts transaction", (t) => {
  const repo = createTestRepo();

  const oldDate = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
  sh(repo, "git", ["checkout", "-b", "racy-branch"]);
  fs.writeFileSync(path.join(repo, "race.txt"), "racy\n");
  sh(repo, "git", ["add", "race.txt"]);
  sh(repo, "git", ["commit", "-m", "Racy commit"], {
    GIT_AUTHOR_DATE: oldDate,
    GIT_COMMITTER_DATE: oldDate,
  });
  sh(repo, "git", ["checkout", "main"]);
  sh(repo, "git", ["merge", "--no-ff", "racy-branch", "-m", "Merge racy-branch"], {
    GIT_AUTHOR_DATE: oldDate,
    GIT_COMMITTER_DATE: oldDate,
  });

  const gitDir = sh(repo, "git", ["rev-parse", "--absolute-git-dir"]);
  const reflogFile = path.join(gitDir, "logs", "refs", "heads", "racy-branch");
  const oldSecs = Math.floor((Date.now() - 40 * 24 * 3600 * 1000) / 1000);
  const headSha = sh(repo, "git", ["rev-parse", "racy-branch"]);
  fs.writeFileSync(reflogFile, `0000000000000000000000000000000000000000 ${headSha} Test User <git-fixture> ${oldSecs} +0000 commit: Racy commit\n`);
  ageHeadCheckoutActivity(repo, "racy-branch", 40);

  const backupDir = path.join(os.tmpdir(), `test-backup-race-${Date.now()}`);

  assert.throws(
    () => {
      applyRetirement({
        repo,
        base: "refs/heads/main",
        backupDir,
        ownershipReviewed: true,
        minAgeDays: 30,
        hooks: {
          beforeTransaction: () => {
            fs.writeFileSync(path.join(repo, "new-main.txt"), "new content\n");
            sh(repo, "git", ["add", "new-main.txt"]);
            sh(repo, "git", ["commit", "-m", "Concurrent main commit"]);
          },
        },
      });
    },
    /Worktree registrations changed|Base ref refs\/heads\/main moved|evidence changed/
  );

  const branchExists = sh(repo, "git", ["rev-parse", "--verify", "refs/heads/racy-branch"]);
  assert.ok(branchExists, "Branch ref must remain intact after transaction race abort");

  if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("new worktree attaches candidate after backup blocks transaction", (t) => {
  const repo = createTestRepo();

  const oldDate = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
  sh(repo, "git", ["checkout", "-b", "wt-race-cand"]);
  fs.writeFileSync(path.join(repo, "wt-cand.txt"), "wt content\n");
  sh(repo, "git", ["add", "wt-cand.txt"]);
  sh(repo, "git", ["commit", "-m", "WT cand commit"], {
    GIT_AUTHOR_DATE: oldDate,
    GIT_COMMITTER_DATE: oldDate,
  });
  sh(repo, "git", ["checkout", "main"]);
  sh(repo, "git", ["merge", "--no-ff", "wt-race-cand", "-m", "Merge wt-race-cand"], {
    GIT_AUTHOR_DATE: oldDate,
    GIT_COMMITTER_DATE: oldDate,
  });

  const gitDir = sh(repo, "git", ["rev-parse", "--absolute-git-dir"]);
  const reflogFile = path.join(gitDir, "logs", "refs", "heads", "wt-race-cand");
  const oldSecs = Math.floor((Date.now() - 40 * 24 * 3600 * 1000) / 1000);
  const headSha = sh(repo, "git", ["rev-parse", "wt-race-cand"]);
  fs.writeFileSync(reflogFile, `0000000000000000000000000000000000000000 ${headSha} Test User <git-fixture> ${oldSecs} +0000 commit: WT cand commit\n`);
  ageHeadCheckoutActivity(repo, "wt-race-cand", 40);

  const backupDir = path.join(os.tmpdir(), `test-backup-wtrace-${Date.now()}`);
  const wtDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-wtrace-attached-"));

  assert.throws(
    () => {
      applyRetirement({
        repo,
        base: "refs/heads/main",
        backupDir,
        ownershipReviewed: true,
        minAgeDays: 30,
        hooks: {
          beforeTransaction: () => {
            sh(repo, "git", ["worktree", "add", wtDir, "wt-race-cand"]);
          },
        },
      });
    },
    /Worktree registrations changed|evidence changed/
  );

  const branchExists = sh(repo, "git", ["rev-parse", "--verify", "refs/heads/wt-race-cand"]);
  assert.equal(branchExists, headSha, "Branch ref must remain intact after worktree race abort");

  sh(repo, "git", ["worktree", "remove", "--force", wtDir]);
  fs.rmSync(wtDir, { recursive: true, force: true });
  if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("successful branch retirement, external clone restore exact SHA and bytes unchanged", (t) => {
  const repo = createTestRepo();

  const oldDate = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
  sh(repo, "git", ["checkout", "-b", "retire-me"]);
  const testFile = path.join(repo, "retire.txt");
  const fileContent = "to retire content exact bytes\n";
  fs.writeFileSync(testFile, fileContent);
  sh(repo, "git", ["add", "retire.txt"]);
  sh(repo, "git", ["commit", "-m", "Commit to retire"], {
    GIT_AUTHOR_DATE: oldDate,
    GIT_COMMITTER_DATE: oldDate,
  });
  const branchSha = sh(repo, "git", ["rev-parse", "retire-me"]);

  sh(repo, "git", ["checkout", "main"]);
  sh(repo, "git", ["merge", "--no-ff", "retire-me", "-m", "Merge retire-me"], {
    GIT_AUTHOR_DATE: oldDate,
    GIT_COMMITTER_DATE: oldDate,
  });

  const gitDir = sh(repo, "git", ["rev-parse", "--absolute-git-dir"]);
  const reflogFile = path.join(gitDir, "logs", "refs", "heads", "retire-me");
  const oldSecs = Math.floor((Date.now() - 40 * 24 * 3600 * 1000) / 1000);
  fs.writeFileSync(reflogFile, `0000000000000000000000000000000000000000 ${branchSha} Test User <git-fixture> ${oldSecs} +0000 commit: Commit to retire\n`);
  ageHeadCheckoutActivity(repo, "retire-me", 40);

  const backupDir = path.join(os.tmpdir(), `test-backup-success-${Date.now()}`);

  const res = applyRetirement({
    repo,
    base: "refs/heads/main",
    backupDir,
    ownershipReviewed: true,
    minAgeDays: 30,
  });

  assert.equal(res.status, "ok");
  assert.equal(res.retired.length, 1, "Must retire exactly 1 candidate branch");
  assert.deepEqual(res.retired, ["retire-me"]);

  // 1. Verify branch deleted
  let deletedSha = null;
  try {
    deletedSha = sh(repo, "git", ["rev-parse", "--verify", "refs/heads/retire-me"]);
  } catch {}
  assert.equal(deletedSha, null, "refs/heads/retire-me must be deleted");

  // 2. Verify recovery ref created with unique run namespace
  const journalPath = path.join(backupDir, "retirement-journal.json");
  assert.ok(fs.existsSync(journalPath), "retirement-journal.json must exist");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  assert.equal(journal.status, "completed", "Journal status must be completed");
  assert.ok(journal.recoveryRefs.length > 0, "Recovery refs must be listed in journal");

  const recoveryRefInfo = journal.recoveryRefs[0];
  const recSha = sh(repo, "git", ["rev-parse", "--verify", recoveryRefInfo.refName]);
  assert.equal(recSha, branchSha, "Recovery ref SHA must match original branch SHA");

  // 3. Prove external recoverability: clone/fetch history bundle into NEW empty bare repo
  const bundlePath = path.join(backupDir, "history.bundle");
  assert.ok(fs.existsSync(bundlePath), "history.bundle must exist");

  const extBareDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-ext-restore-test-"));
  sh(extBareDir, "git", ["init", "--bare"]);
  sh(extBareDir, "git", ["fetch", bundlePath, "refs/heads/*:refs/heads/*"]);

  const extBranchSha = sh(extBareDir, "git", ["rev-parse", "--verify", "refs/heads/retire-me"]);
  assert.equal(extBranchSha, branchSha, "External clone from bundle must yield exact original candidate SHA");

  // Verify byte-for-byte file content restored from bundle
  const restoredFileContent = sh(extBareDir, "git", ["show", `${extBranchSha}:retire.txt`]);
  assert.equal(restoredFileContent + "\n", fileContent, "Restored file content from bundle must match original byte-for-byte");

  // 4. Verify source working tree is clean
  const status = sh(repo, "git", ["status", "--porcelain"]);
  assert.equal(status, "", "Source repository working tree must be clean");

  fs.rmSync(extBareDir, { recursive: true, force: true });
  if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("injectable active detector blocks retirement deterministically", (t) => {
  const repo = createTestRepo();

  const report = reportRetirement({
    repo,
    base: "refs/heads/main",
    ownershipReviewed: true,
    inspectActiveWork: () => ({
      protected: true,
      reasons: ["Mock active writer active on repo"],
    }),
  });

  assert.ok(report.missingEvidence.length > 0, "missingEvidence must contain active detector reason");
  assert.ok(
    report.missingEvidence.some(m => m.includes("Mock active writer active on repo")),
    "missingEvidence must describe mock active writer reason"
  );

  fs.rmSync(repo, { recursive: true, force: true });
});

test("selective branch deletion with branches option never deletes unrelated eligible branches", (t) => {
  const repo = createTestRepo();

  const oldDate = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
  const oldSecs = Math.floor((Date.now() - 40 * 24 * 3600 * 1000) / 1000);
  const gitDir = sh(repo, "git", ["rev-parse", "--absolute-git-dir"]);

  // Create candidate b1
  sh(repo, "git", ["checkout", "-b", "b1"]);
  fs.writeFileSync(path.join(repo, "b1.txt"), "b1 content\n");
  sh(repo, "git", ["add", "b1.txt"]);
  sh(repo, "git", ["commit", "-m", "b1 commit"], { GIT_AUTHOR_DATE: oldDate, GIT_COMMITTER_DATE: oldDate });
  const b1Sha = sh(repo, "git", ["rev-parse", "b1"]);
  sh(repo, "git", ["checkout", "main"]);
  sh(repo, "git", ["merge", "--no-ff", "b1", "-m", "Merge b1"], { GIT_AUTHOR_DATE: oldDate, GIT_COMMITTER_DATE: oldDate });
  fs.writeFileSync(path.join(gitDir, "logs", "refs", "heads", "b1"), `0000000000000000000000000000000000000000 ${b1Sha} Test User <git-fixture> ${oldSecs} +0000 commit: b1 commit\n`);
  ageHeadCheckoutActivity(repo, "b1", 40);

  // Create candidate b2
  sh(repo, "git", ["checkout", "-b", "b2"]);
  fs.writeFileSync(path.join(repo, "b2.txt"), "b2 content\n");
  sh(repo, "git", ["add", "b2.txt"]);
  sh(repo, "git", ["commit", "-m", "b2 commit"], { GIT_AUTHOR_DATE: oldDate, GIT_COMMITTER_DATE: oldDate });
  const b2Sha = sh(repo, "git", ["rev-parse", "b2"]);
  sh(repo, "git", ["checkout", "main"]);
  sh(repo, "git", ["merge", "--no-ff", "b2", "-m", "Merge b2"], { GIT_AUTHOR_DATE: oldDate, GIT_COMMITTER_DATE: oldDate });
  fs.writeFileSync(path.join(gitDir, "logs", "refs", "heads", "b2"), `0000000000000000000000000000000000000000 ${b2Sha} Test User <git-fixture> ${oldSecs} +0000 commit: b2 commit\n`);
  ageHeadCheckoutActivity(repo, "b2", 40);

  const backupDir = path.join(os.tmpdir(), `test-backup-selective-${Date.now()}`);

  const applyRes = applyRetirement({
    repo,
    base: "refs/heads/main",
    backupDir,
    ownershipReviewed: true,
    minAgeDays: 30,
    branches: ["b1"],
  });

  assert.equal(applyRes.status, "ok");
  assert.deepEqual(applyRes.retired, ["b1"], "Only b1 should be retired");

  let b1Exists = true;
  try { sh(repo, "git", ["rev-parse", "--verify", "refs/heads/b1"]); } catch { b1Exists = false; }
  assert.equal(b1Exists, false, "b1 must be deleted");

  const b2Exists = sh(repo, "git", ["rev-parse", "--verify", "refs/heads/b2"]);
  assert.equal(b2Exists, b2Sha, "Unselected candidate branch b2 must remain untouched");

  if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("a reviewed deferred plan waits for a writer, then retires only its pinned branch", () => {
  const repo = createTestRepo();
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-retirement-queue-"));
  const queueFile = path.join(queueDir, "retirement-plans.json");
  const backupDir = path.join(queueDir, "backup");
  try {
    const branchSha = createOldMergedBranch(repo, "queued-branch", 60);
    const queue = queueRetirement({
      repo,
      base: "refs/heads/main",
      ownershipReviewed: true,
      minAgeDays: 30,
      queueFile,
      backupDir,
      inspectActiveWork: () => ({ protected: true, reasons: ["writer active"] }),
    });
    assert.equal(queue.status, "queued");
    assert.equal(queue.plan.candidates[0].sha, branchSha);
    assert.equal(sh(repo, "git", ["rev-parse", "--verify", "refs/heads/queued-branch"]), branchSha);

    const blocked = drainRetirementQueue({
      queueFile,
      inspectActiveWork: () => ({ protected: true, reasons: ["writer still active"] }),
    });
    assert.equal(blocked.status, "blocked");
    assert.equal(sh(repo, "git", ["rev-parse", "--verify", "refs/heads/queued-branch"]), branchSha);

    const drained = drainRetirementQueue({ queueFile, inspectActiveWork: inactiveDetector });
    assert.equal(drained.status, "ok");
    assert.deepEqual(drained.applied[0].retired, ["queued-branch"]);
    assert.throws(() => sh(repo, "git", ["rev-parse", "--verify", "refs/heads/queued-branch"]));

    const ledger = JSON.parse(fs.readFileSync(queueFile, "utf8"));
    assert.equal(ledger.plans[0].status, "applied");
    assert.equal(ledger.plans[0].result.retired[0], "queued-branch");
  } finally {
    fs.rmSync(queueDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a deferred plan rejects a moved candidate without deleting it or another eligible branch", () => {
  const repo = createTestRepo();
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-retirement-queue-race-"));
  const queueFile = path.join(queueDir, "retirement-plans.json");
  try {
    const queuedSha = createOldMergedBranch(repo, "queued-race", 60);
    const otherSha = createOldMergedBranch(repo, "other-eligible", 60);
    queueRetirement({
      repo,
      base: "refs/heads/main",
      ownershipReviewed: true,
      minAgeDays: 30,
      branches: ["queued-race"],
      queueFile,
      backupDir: path.join(queueDir, "backup"),
      inspectActiveWork: inactiveDetector,
    });
    sh(repo, "git", ["branch", "-f", "queued-race", "main"]);

    const drained = drainRetirementQueue({ queueFile, inspectActiveWork: inactiveDetector });
    assert.equal(drained.status, "blocked");
    assert.match(drained.blocked[0].error, /no longer eligible|changed since the plan was reviewed/);
    assert.equal(sh(repo, "git", ["rev-parse", "--verify", "refs/heads/queued-race"]), sh(repo, "git", ["rev-parse", "main"]));
    assert.equal(sh(repo, "git", ["rev-parse", "--verify", "refs/heads/other-eligible"]), otherSha);
    assert.notEqual(queuedSha, otherSha);
    assert.equal(JSON.parse(fs.readFileSync(queueFile, "utf8")).plans[0].status, "rejected");
  } finally {
    fs.rmSync(queueDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a deferred plan rejects missing ownership and an in-repository ledger", () => {
  const repo = createTestRepo();
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-retirement-queue-location-"));
  try {
    createOldMergedBranch(repo, "queued-policy", 60);
    const common = { repo, base: "refs/heads/main", minAgeDays: 30, backupDir: path.join(queueDir, "backup"), inspectActiveWork: inactiveDetector };
    assert.throws(() => queueRetirement({ ...common, queueFile: path.join(queueDir, "queue.json") }), /ownershipReviewed/);
    assert.throws(() => queueRetirement({ ...common, ownershipReviewed: true, queueFile: path.join(repo, "queue.json") }), /inside forbidden root/);
    assert.equal(fs.existsSync(path.join(repo, "queue.json")), false);
  } finally {
    fs.rmSync(queueDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("draining rejects malformed timestamps and a ledger located inside its repository", () => {
  const repo = createTestRepo();
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-retirement-queue-validation-"));
  const queueFile = path.join(queueDir, "queue.json");
  const inRepoQueue = path.join(repo, "in-repo-queue.json");
  try {
    const branchSha = createOldMergedBranch(repo, "queued-validation", 60);
    queueRetirement({
      repo, base: "refs/heads/main", ownershipReviewed: true, minAgeDays: 30,
      queueFile, backupDir: path.join(queueDir, "backup"), inspectActiveWork: inactiveDetector,
    });
    const validLedger = JSON.parse(fs.readFileSync(queueFile, "utf8"));
    fs.writeFileSync(inRepoQueue, JSON.stringify(validLedger));
    const inRepo = drainRetirementQueue({ queueFile: inRepoQueue, inspectActiveWork: inactiveDetector });
    assert.equal(inRepo.status, "blocked");
    assert.match(inRepo.blocked[0].error, /inside forbidden root/);
    assert.equal(sh(repo, "git", ["rev-parse", "--verify", "refs/heads/queued-validation"]), branchSha);

    validLedger.plans[0].expiresAt = "invalid";
    fs.writeFileSync(queueFile, JSON.stringify(validLedger));
    const malformed = drainRetirementQueue({ queueFile, inspectActiveWork: inactiveDetector });
    assert.equal(malformed.status, "blocked");
    assert.match(malformed.blocked[0].error, /timestamps are invalid/);
    assert.equal(JSON.parse(fs.readFileSync(queueFile, "utf8")).plans[0].status, "rejected");
    assert.equal(sh(repo, "git", ["rev-parse", "--verify", "refs/heads/queued-validation"]), branchSha);
  } finally {
    fs.rmSync(queueDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("CLI queues and drains a reviewed retirement only after the writer clears", () => {
  const repo = createTestRepo();
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-retirement-cli-queue-"));
  const queueFile = path.join(queueDir, "queue.json");
  try {
    createOldMergedBranch(repo, "cli-queued", 60);
    const queued = runCli([
      "--repo", repo, "--base", "refs/heads/main", "--branch", "cli-queued", "--min-age-days", "30",
      "--ownership-reviewed", "--backup-dir", path.join(queueDir, "backup"), "--defer", "--queue-file", queueFile, "--quiet",
    ], { quiet: true, inspectActiveWork: () => ({ protected: true, reasons: ["writer active"] }) });
    assert.equal(queued.exitCode, 0);
    assert.equal(queued.result.status, "queued");

    const drained = runCli(["--drain-queue", "--queue-file", queueFile, "--quiet"], { quiet: true, inspectActiveWork: inactiveDetector });
    assert.equal(drained.exitCode, 0);
    assert.deepEqual(drained.result.applied[0].retired, ["cli-queued"]);
  } finally {
    fs.rmSync(queueDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("CLI report and apply execution", (t) => {
  const repo = createTestRepo();

  const oldDate = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
  sh(repo, "git", ["checkout", "-b", "cli-branch"]);
  fs.writeFileSync(path.join(repo, "cli.txt"), "cli content\n");
  sh(repo, "git", ["add", "cli.txt"]);
  sh(repo, "git", ["commit", "-m", "CLI commit"], {
    GIT_AUTHOR_DATE: oldDate,
    GIT_COMMITTER_DATE: oldDate,
  });
  const branchSha = sh(repo, "git", ["rev-parse", "cli-branch"]);

  sh(repo, "git", ["checkout", "main"]);
  sh(repo, "git", ["merge", "--no-ff", "cli-branch", "-m", "Merge cli-branch"], {
    GIT_AUTHOR_DATE: oldDate,
    GIT_COMMITTER_DATE: oldDate,
  });

  const gitDir = sh(repo, "git", ["rev-parse", "--absolute-git-dir"]);
  const reflogFile = path.join(gitDir, "logs", "refs", "heads", "cli-branch");
  const oldSecs = Math.floor((Date.now() - 40 * 24 * 3600 * 1000) / 1000);
  fs.writeFileSync(reflogFile, `0000000000000000000000000000000000000000 ${branchSha} Test User <git-fixture> ${oldSecs} +0000 commit: CLI commit\n`);
  ageHeadCheckoutActivity(repo, "cli-branch", 40);

  // Run CLI in report mode
  const reportRes = runCli(["--repo", repo, "--base", "refs/heads/main", "--min-age-days", "30", "--quiet"]);
  assert.equal(reportRes.exitCode, 0);
  assert.ok(reportRes.report);
  assert.equal(reportRes.report.eligible.length, 1);
  assert.equal(reportRes.report.eligible[0].branchName, "cli-branch");

  // Run CLI in apply mode
  const backupDir = path.join(os.tmpdir(), `test-cli-backup-${Date.now()}`);
  const applyRes = runCli([
    "--repo", repo,
    "--base", "refs/heads/main",
    "--backup-dir", backupDir,
    "--apply",
    "--ownership-reviewed",
    "--min-age-days", "30",
    "--quiet"
  ], { quiet: true, inspectActiveWork: inactiveDetector });

  assert.equal(applyRes.exitCode, 0);
  assert.ok(applyRes.result);
  assert.deepEqual(applyRes.result.retired, ["cli-branch"]);

  if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("actual CLI keeps the 30 day default, supports profile policy and validates values", () => {
  const repo = createTestRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "git-retire-home-"));
  const profilePath = path.join(home, "profile.json");
  const cli = path.resolve(__dirname, "../src/branch-retirement-cli.js");
  try {
    createOldMergedBranch(repo, "recent-by-default", 2);
    fs.writeFileSync(profilePath, JSON.stringify({
      repositoryRoot: repo,
      branchCleanup: { baseRef: "refs/heads/main", minAgeDays: 90 },
    }));

    const defaultRun = JSON.parse(execFileSync(process.execPath, [cli, "--repo", repo, "--base", "refs/heads/main"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, GIT_MANAGER_PROFILE: "" },
    }));
    assert.equal(defaultRun.minAgeDays, 30);
    assert.equal(defaultRun.retained.find(row => row.branchName === "recent-by-default").reason, "too-recent");

    const profileRun = JSON.parse(execFileSync(process.execPath, [cli, "--profile", profilePath], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, REPOSITORY_ROOT: "", GIT_MANAGER_REPO: "" },
    }));
    assert.equal(profileRun.minAgeDays, 90);

    for (const args of [["--repo"], ["--base"], ["--profile"], ["--backup-dir"], ["--active-branch"], ["--branch"], ["--min-age-days"], ["--min-age-days", ""]]) {
      const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });
      assert.equal(result.status, 1, `${args.join(" ")} must fail`);
      assert.match(result.stderr, /"success": false|Error:/);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("recent checkout activity in HEAD reflog retains an old merged branch", () => {
  const repo = createTestRepo();
  try {
    createOldMergedBranch(repo, "old-branch", 60);
    sh(repo, "git", ["checkout", "old-branch"]);
    sh(repo, "git", ["checkout", "main"]);
    const report = reportRetirement({ repo, base: "refs/heads/main", ownershipReviewed: true });
    const retained = report.retained.find(row => row.branchName === "old-branch");
    assert.equal(retained.reason, "too-recent");
    assert.ok(retained.ageInfo.headReflogTs);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("profile schema, empty selection, path precedence and exact default names fail safe", () => {
  const repo = createTestRepo();
  const spacedParent = fs.mkdtempSync(path.join(os.tmpdir(), "git manager path "));
  const spacedRepo = path.join(spacedParent, " repo with edge spaces ");
  fs.renameSync(repo, spacedRepo);
  const profilePath = path.join(spacedParent, "profile.json");
  try {
    createOldMergedBranch(spacedRepo, "candidate", 60);
    for (const profile of ["bad", { branchCleanup: "bad" }, { branchCleanup: { protectedBranches: "main" } }, { branchCleanup: { activeBranches: [""] } }]) {
      fs.writeFileSync(profilePath, JSON.stringify(profile));
      assert.throws(() => reportRetirement({ repo: spacedRepo, profilePath, base: "refs/heads/main", ownershipReviewed: true }), /profile|branchCleanup|non-empty strings/i);
    }

    fs.writeFileSync(profilePath, JSON.stringify({ repositoryRoot: "/does/not/exist", branchCleanup: { baseRef: "refs/heads/main" } }));
    const oldRepositoryRoot = process.env.REPOSITORY_ROOT;
    const oldGitManagerRepo = process.env.GIT_MANAGER_REPO;
    process.env.REPOSITORY_ROOT = spacedRepo;
    process.env.GIT_MANAGER_REPO = "/also/missing";
    try {
      const report = reportRetirement({ profilePath, ownershipReviewed: true, branches: [], inspectActiveWork: inactiveDetector });
      assert.equal(report.repo, fs.realpathSync(spacedRepo));
      assert.deepEqual(report.eligible, []);
      assert.equal(report.retained.find(row => row.branchName === "candidate").reason, "not-selected");
      assert.equal(report.status, "ready");
    } finally {
      if (oldRepositoryRoot === undefined) delete process.env.REPOSITORY_ROOT; else process.env.REPOSITORY_ROOT = oldRepositoryRoot;
      if (oldGitManagerRepo === undefined) delete process.env.GIT_MANAGER_REPO; else process.env.GIT_MANAGER_REPO = oldGitManagerRepo;
    }

    for (const name of ["release", "recovery"]) {
      sh(spacedRepo, "git", ["branch", name]);
    }
    const protectedReport = reportRetirement({ repo: spacedRepo, base: "refs/heads/main", ownershipReviewed: true, minAgeDays: 0 });
    assert.equal(protectedReport.retained.find(row => row.branchName === "release").reason, "protected");
    assert.equal(protectedReport.retained.find(row => row.branchName === "recovery").reason, "protected");
  } finally {
    fs.rmSync(spacedParent, { recursive: true, force: true });
  }
});

test("delayed backup corruption and symbolic-ref races abort before mutation", () => {
  for (const mode of ["bundle", "manifest", "archive", "objects", "symref"]) {
    const repo = createTestRepo();
    const branchSha = createOldMergedBranch(repo, `race-${mode}`, 60);
    const baseSha = sh(repo, "git", ["rev-parse", "refs/heads/main"]);
    const backupDir = path.join(os.tmpdir(), `git-retire-race-${mode}-${Date.now()}`);
    try {
      assert.throws(() => applyRetirement({
        repo,
        base: "refs/heads/main",
        backupDir,
        ownershipReviewed: true,
        branches: [`race-${mode}`],
        hooks: {
          beforeTransaction: () => {
            if (mode === "symref") {
              sh(repo, "git", ["symbolic-ref", `refs/heads/race-${mode}`, "refs/heads/main"]);
            } else {
              const file = mode === "bundle"
                ? "history.bundle"
                : mode === "archive"
                  ? "git-metadata.tar"
                  : mode === "objects"
                    ? "git-objects.tar"
                    : "manifest.json";
              const artifact = path.join(backupDir, file);
              fs.chmodSync(artifact, 0o600);
              fs.appendFileSync(artifact, "corruption");
            }
          },
        },
      }), /changed|symbolic|moved|manifest|archive|bundle/i);
      assert.equal(sh(repo, "git", ["rev-parse", "refs/heads/main"]), baseSha);
      if (mode !== "symref") assert.equal(sh(repo, "git", ["rev-parse", `refs/heads/race-${mode}`]), branchSha);
      assert.equal(sh(repo, "git", ["for-each-ref", "--format=%(refname)", "refs/allsorted/recovery/"]), "");
    } finally {
      if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }
});
