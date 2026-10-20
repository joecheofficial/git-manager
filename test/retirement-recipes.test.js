"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");

// Hermetic: the recipes resolve the repository from REPOSITORY_ROOT or the
// private profile in the home folder. A fresh clone has neither, which failed
// these tests (and so the weekly self-update) on every new machine. Point them
// at a throwaway repository for this file only and restore the variable after.
const hermeticRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gm-retirement-recipes-"));
execFileSync("git", ["init", "-q", hermeticRoot], { stdio: "ignore" });
const savedRepositoryRoot = process.env.REPOSITORY_ROOT;
process.env.REPOSITORY_ROOT = hermeticRoot;
test.after(() => {
  if (savedRepositoryRoot === undefined) delete process.env.REPOSITORY_ROOT;
  else process.env.REPOSITORY_ROOT = savedRepositoryRoot;
  fs.rmSync(hermeticRoot, { recursive: true, force: true });
});

const origExistsSync = fs.existsSync;
const origLoad = Module._load;

function withMockEngine(mockEngine, testFn) {
  try {
    fs.existsSync = function (p) {
      if (typeof p === "string" && p.endsWith("branch-retirement.js")) {
        return true;
      }
      return origExistsSync.apply(this, arguments);
    };
    Module._load = function (request, parent, isMain) {
      if (typeof request === "string" && request.endsWith("branch-retirement.js")) {
        return mockEngine;
      }
      return origLoad.apply(this, arguments);
    };

    delete require.cache[require.resolve("../branches")];
    delete require.cache[require.resolve("../recipes/cleanup-branches")];
    delete require.cache[require.resolve("../recipes/delete-branch")];

    testFn();
  } finally {
    fs.existsSync = origExistsSync;
    Module._load = origLoad;
    delete require.cache[require.resolve("../branches")];
    delete require.cache[require.resolve("../recipes/cleanup-branches")];
    delete require.cache[require.resolve("../recipes/delete-branch")];
  }
}

test("confirmation without ownership stays blocked", () => {
  const mockEngine = {
    reportRetirement: () => ({
      status: "blocked",
      eligible: [{ branchName: "feature-a", refName: "refs/heads/feature-a", sha: "abc1234" }],
      retained: [],
      missingEvidence: ["Operator ownership review flag ownershipReviewed is false or missing"]
    }),
    applyRetirement: () => {
      throw new Error("applyRetirement should not be called without ownership review");
    },
    loadProfile: () => ({})
  };

  withMockEngine(mockEngine, () => {
    const branches = require("../branches");
    const cleanupBranches = require("../recipes/cleanup-branches");

    const deleteRes = branches.deleteBranch("feature-a", { confirm: "DELETE", ownershipReviewed: false });
    assert.strictEqual(deleteRes.status, "blocked");
    assert.strictEqual(deleteRes.deletedBranch, undefined);

    const cleanupRes = cleanupBranches.runRecipe({ confirm: "CLEANUP", ownershipReviewed: false });
    assert.strictEqual(cleanupRes.status, "blocked");
    assert.deepStrictEqual(cleanupRes.deleted, []);
  });
});

test("age undefined preserved", () => {
  let reportOpts = null;

  const mockEngine = {
    reportRetirement: (opts) => {
      reportOpts = opts;
      return {
        status: "ready",
        eligible: [{ branchName: "feature-a", refName: "refs/heads/feature-a", sha: "abc1234" }],
        retained: [],
        missingEvidence: []
      };
    },
    applyRetirement: () => ({ retired: ["feature-a"] }),
    loadProfile: () => ({})
  };

  withMockEngine(mockEngine, () => {
    const branches = require("../branches");

    branches.deleteBranch("feature-a", { ownershipReviewed: true });
    assert.strictEqual(reportOpts.minAgeDays, undefined);

    branches.deleteBranch("feature-a", { ownershipReviewed: true, minAgeDays: 14 });
    assert.strictEqual(reportOpts.minAgeDays, 14);
  });
});

test("no temp backup default", () => {
  const mockEngine = {
    reportRetirement: () => ({
      status: "ready",
      eligible: [{ branchName: "feature-a", refName: "refs/heads/feature-a", sha: "abc1234" }],
      retained: [],
      missingEvidence: []
    }),
    applyRetirement: () => {
      throw new Error("applyRetirement should not be called when backup resolution fails");
    },
    loadProfile: () => ({})
  };

  withMockEngine(mockEngine, () => {
    const branches = require("../branches");
    const cleanupBranches = require("../recipes/cleanup-branches");

    const deleteRes = branches.deleteBranch("feature-a", { confirm: "DELETE", ownershipReviewed: true });
    assert.strictEqual(deleteRes.status, "blocked");
    assert.ok(deleteRes.reply.includes("Backup directory is required"));

    const cleanupRes = cleanupBranches.runRecipe({ confirm: "CLEANUP", ownershipReviewed: true });
    assert.strictEqual(cleanupRes.status, "blocked");
    assert.ok(cleanupRes.reply.includes("Backup directory is required"));
  });
});

test("empty retired result never success", () => {
  const mockEngine = {
    reportRetirement: () => ({
      status: "ready",
      eligible: [{ branchName: "feature-a", refName: "refs/heads/feature-a", sha: "abc1234" }],
      retained: [],
      missingEvidence: []
    }),
    applyRetirement: () => ({ retired: [] }),
    loadProfile: () => ({})
  };

  withMockEngine(mockEngine, () => {
    const branches = require("../branches");
    const cleanupBranches = require("../recipes/cleanup-branches");

    const deleteRes = branches.deleteBranch("feature-a", {
      confirm: "DELETE",
      ownershipReviewed: true,
      backupDir: "/tmp/fake-backup-dir"
    });
    assert.strictEqual(deleteRes.status, "blocked");
    assert.strictEqual(deleteRes.deletedBranch, null);

    const cleanupRes = cleanupBranches.runRecipe({
      confirm: "CLEANUP",
      ownershipReviewed: true,
      backupDir: "/tmp/fake-backup-dir"
    });
    assert.strictEqual(cleanupRes.status, "blocked");
    assert.deepStrictEqual(cleanupRes.deleted, []);
  });
});

test("recipe forwarding includes required options", () => {
  let passedOpts = null;
  const tmpBackup = path.join(os.tmpdir(), "gm-test-backup-" + Date.now(), "b");

  const mockEngine = {
    reportRetirement: (opts) => {
      passedOpts = opts;
      return {
        status: "ready",
        eligible: [{ branchName: "feature-a", refName: "refs/heads/feature-a", sha: "abc1234" }],
        retained: [],
        missingEvidence: []
      };
    },
    applyRetirement: () => ({ retired: ["feature-a"] }),
    loadProfile: () => ({})
  };

  withMockEngine(mockEngine, () => {
    const deleteBranchRecipe = require("../recipes/delete-branch");

    deleteBranchRecipe.runRecipe({
      name: "feature-a",
      confirm: "DELETE",
      root: "/repo/path",
      base: "main",
      profilePath: "/profile.json",
      backupDir: tmpBackup,
      minAgeDays: 14,
      ownershipReviewed: true,
      protectedBranches: ["main"],
      activeBranches: ["feat-active"],
      hooks: { tamperBackup: () => {} },
      inspectActiveWork: () => ({ protected: true })
    });

    assert.strictEqual(passedOpts.repo, "/repo/path");
    assert.strictEqual(passedOpts.base, "main");
    assert.strictEqual(passedOpts.profilePath, "/profile.json");
    assert.strictEqual(passedOpts.minAgeDays, 14);
    assert.strictEqual(passedOpts.ownershipReviewed, true);
    assert.deepStrictEqual(passedOpts.protectedBranches, ["main"]);
    assert.deepStrictEqual(passedOpts.activeBranches, ["feat-active"]);
    assert.strictEqual(passedOpts.hooks, undefined);
    assert.strictEqual(passedOpts.inspectActiveWork, undefined);
  });

  try {
    fs.rmSync(path.dirname(tmpBackup), { recursive: true, force: true });
  } catch {}
});
