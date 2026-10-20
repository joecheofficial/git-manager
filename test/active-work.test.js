"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { inspectActiveWork, isComputerUseLauncher, isWithin } = require("../src/active-work");

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "git-manager-active-"));
}

test("path containment is boundary-safe", () => {
  assert.equal(isWithin("/tmp/repo", "/tmp/repo/file"), true);
  assert.equal(isWithin("/tmp/repo", "/tmp/repository/file"), false);
});

test("live agent writer protects its repository", () => {
  const repo = fixture();
  const result = inspectActiveWork(repo, {
    processes: [{ pid: 44, ppid: 1, command: "codex exec task" }],
    currentPid: 999,
    cwdForPid: () => repo,
    goals: { active: [], detectorError: null },
  });
  assert.equal(result.protected, true);
  assert.equal(result.reasons[0].type, "live-writer");
});

test("Unified Computer Use launcher is not an authoring writer", () => {
  const repo = fixture();
  // Built from the parts COMPUTER_USE_LAUNCHER_PATTERN actually matches, with
  // no owner-identifying path. A previous fixture hardcoded a real home
  // directory; the All Sorted scrub rewrote it to a generic path that no
  // longer contained "/unified-computer-use/", so the shipped test asserted a
  // falsehood and failed on every customer install. Keep the matched segments
  // literal and the surrounding path generic.
  const command = "/opt/example/bin/node /opt/example/plugins/unified-computer-use/1.2.3/scripts/launch.mjs";
  assert.equal(isComputerUseLauncher(command), true);
  const result = inspectActiveWork(repo, {
    processes: [{ pid: 44, ppid: 1, command }],
    currentPid: 999,
    cwdForPid: () => repo,
    goals: { active: [], detectorError: null },
  });
  assert.equal(result.protected, false);
});

test("unrelated runtime process does not protect repository", () => {
  const repo = fixture();
  const result = inspectActiveWork(repo, {
    processes: [{ pid: 44, ppid: 1, command: "next-server" }],
    currentPid: 999,
    cwdForPid: () => repo,
    goals: { active: [], detectorError: null },
  });
  assert.equal(result.protected, false);
});

test("writer with unreadable cwd fails closed", () => {
  const repo = fixture();
  const result = inspectActiveWork(repo, {
    processes: [{ pid: 44, ppid: 1, command: `claude task ${fs.realpathSync(repo)}` }],
    currentPid: 999,
    cwdForPid: () => null,
    goals: { active: [], detectorError: null },
  });
  assert.equal(result.protected, true);
  assert.equal(result.reasons[0].type, "unknown-writer");
});

test("active goal and recent writes protect repository", () => {
  const repo = fixture();
  const file = path.join(repo, "work.txt");
  fs.writeFileSync(file, "active");
  const result = inspectActiveWork(repo, {
    processes: [],
    entries: [{ file: "work.txt", status: " M" }],
    goals: { active: [".omx/ultragoal/goals.json"], detectorError: null },
    now: Date.now(),
  });
  assert.equal(result.protected, true);
  assert.deepEqual(new Set(result.reasons.map((reason) => reason.type)), new Set(["recent-write", "active-goal"]));
});

test("detector failure fails closed", () => {
  const repo = fixture();
  const result = inspectActiveWork(repo, {
    // 2026-09-29: isolate the goal failure from host process permissions.
    processes: [],
    cwdForPid: () => null,
    goals: { active: [], detectorError: "unavailable" },
  });
  assert.equal(result.protected, true);
  assert.equal(result.detectorError, "unavailable");
});
