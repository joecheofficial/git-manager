"use strict";

const { execFileSync, spawnSync } = require("child_process");
const fs = require("./volume-probe").guardFs(require("fs"));
const path = require("path");

const WRITER_PATTERN = /\b(codex|claude|gemini|omx|vitest|playwright|run-book|cover-lab)\b/i;
const COMPUTER_USE_LAUNCHER_PATTERN = /\/unified-computer-use\/[^\s]*\/scripts\/launch\.mjs(?:\s|$)/;
const ACTIVE_GOAL_STATES = new Set(["active", "in_progress", "running", "working"]);

function isComputerUseLauncher(command) {
  return COMPUTER_USE_LAUNCHER_PATTERN.test(command);
}

function isWithin(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function processTable() {
  // 2026-09-26: node's default maxBuffer is 1 MB. This Mac runs ~2,100
  // processes whose command lines are long (bundled Electron helpers), so the
  // real `ps` output is ~1.5 MB and every read failed with ENOBUFS. The
  // active-work preflight then errored on every sweep, which fails closed and
  // so was silent: Tier-2 checkpoints just quietly declined forever. Budget
  // generously; the cost of a large buffer is nothing next to a safety gate
  // that never runs.
  const raw = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return raw.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
  });
}

function ignoredProcessIds(rows, startPid = process.pid) {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const ignored = new Set();
  let current = startPid;
  while (current && !ignored.has(current)) {
    ignored.add(current);
    current = byPid.get(current)?.ppid;
  }
  return ignored;
}

function cwdMapForPids(pids) {
  const result = new Map();
  if (!pids.length) return { result, error: null };
  const scan = spawnSync("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fpn"], {
    encoding: "utf8",
    // 2026-09-29: crowded process tables need more than five seconds for cwd lookup.
    timeout: 20000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const out = scan.stdout || "";
  if (out) {
    let pid = null;
    for (const line of out.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      if (pid && line.startsWith("n")) result.set(pid, line.slice(1));
    }
  }
  if (scan.error || (!out && scan.status !== 0)) {
    return { result, error: "lsof cwd detector failed" };
  }
  return { result, error: null };
}

function findActiveGoals(repo, now = Date.now(), freshMinutes = 60) {
  try {
    const out = execFileSync("find", [
      repo, "-maxdepth", "6",
      "-path", "*/node_modules", "-prune", "-o",
      "-path", "*/.git", "-prune", "-o",
      "-path", "*/.omx/ultragoal/goals.json", "-print",
    ], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "ignore"] });
    const active = [];
    for (const file of out.split("\n").filter(Boolean)) {
      try {
        if ((now - fs.statSync(file).mtimeMs) / 60000 > freshMinutes) continue;
        const payload = JSON.parse(fs.readFileSync(file, "utf8"));
        const goals = Array.isArray(payload) ? payload : payload.goals || [];
        if (goals.some((goal) => ACTIVE_GOAL_STATES.has(String(goal.status || "").toLowerCase()))) {
          active.push(path.relative(repo, file));
        }
      } catch {
        active.push(`${path.relative(repo, file)} (unreadable)`);
      }
    }
    return { active, detectorError: null };
  } catch (error) {
    return { active: [], detectorError: `goal detector failed: ${error.code || error.message}` };
  }
}

function inspectActiveWork(repo, options = {}) {
  const canonicalRepo = fs.realpathSync(repo);
  const recentMinutes = Number(options.recentWriteMinutes ?? 20);
  const reasons = [];
  let detectorError = null;

  try {
    const rows = options.processes || processTable();
    const ignored = ignoredProcessIds(rows, options.currentPid || process.pid);
    const writers = rows.filter((row) => !ignored.has(row.pid)
      && WRITER_PATTERN.test(row.command)
      && !isComputerUseLauncher(row.command));
    const cwdScan = options.cwdForPid ? null : cwdMapForPids(writers.map((row) => row.pid));
    if (cwdScan?.error) detectorError = cwdScan.error;
    for (const row of writers) {
      const cwd = options.cwdForPid ? options.cwdForPid(row.pid) : cwdScan.result.get(row.pid);
      if (!cwd) {
        if (row.command.includes(canonicalRepo)) {
          reasons.push({ type: "unknown-writer", pid: row.pid, command: path.basename(row.command.trim().split(/\s+/)[0]) });
        }
        continue;
      }
      let canonicalCwd;
      try { canonicalCwd = fs.realpathSync(cwd); } catch { continue; }
      if (isWithin(canonicalRepo, canonicalCwd)) {
        reasons.push({
          type: "live-writer",
          pid: row.pid,
          command: path.basename(row.command.trim().split(/\s+/)[0]),
          path: path.relative(canonicalRepo, canonicalCwd) || ".",
        });
      }
    }
  } catch (error) {
    detectorError = `process detector failed: ${error.code || error.message}`;
  }

  const now = options.now ?? Date.now();
  for (const entry of options.entries || []) {
    const target = path.resolve(canonicalRepo, entry.file);
    if (!isWithin(canonicalRepo, target)) {
      reasons.push({ type: "unsafe-path", path: entry.file });
      continue;
    }
    try {
      const ageMinutes = (now - fs.statSync(target).mtimeMs) / 60000;
      if (ageMinutes >= -1 && ageMinutes <= recentMinutes) {
        reasons.push({ type: "recent-write", path: entry.file, ageMinutes: Math.max(0, Math.round(ageMinutes)) });
      }
    } catch {
      if (entry.status.includes("D") || entry.status.includes("R")) {
        reasons.push({ type: "uncertain-change", path: entry.file });
      }
    }
  }

  const goals = options.goals || findActiveGoals(canonicalRepo, now, options.goalFreshMinutes ?? 60);
  if (goals.detectorError) detectorError = detectorError || goals.detectorError;
  for (const file of goals.active) reasons.push({ type: "active-goal", path: file });

  return {
    protected: Boolean(detectorError || reasons.length),
    detectorError,
    reasons,
    observedAt: new Date(now).toISOString(),
  };
}

function gitEntries(repo) {
  const raw = execFileSync("git", ["-C", repo, "status", "--porcelain=v1", "-z"], {
    encoding: "utf8",
    timeout: 20000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const records = raw.split("\0");
  const entries = [];
  for (let index = 0; index < records.length && records[index]; index += 1) {
    const record = records[index];
    const status = record.slice(0, 2);
    entries.push({ status, file: record.slice(3) });
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return entries;
}

function cli() {
  const repoIndex = process.argv.indexOf("--repo");
  const repo = repoIndex >= 0 ? process.argv[repoIndex + 1] : null;
  const quiet = process.argv.includes("--quiet");
  const ignoreRecentWrites = process.argv.includes("--ignore-recent-writes");
  if (!repo) {
    console.error("Usage: active-work.js --repo <path> [--quiet]");
    process.exit(64);
  }
  try {
    const result = inspectActiveWork(repo, { entries: ignoreRecentWrites ? [] : gitEntries(repo) });
    if (!quiet) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.protected ? 75 : 0);
  } catch (error) {
    if (!quiet) process.stdout.write(`${JSON.stringify({ protected: true, detectorError: error.message })}\n`);
    process.exit(75);
  }
}

if (require.main === module) cli();

module.exports = { inspectActiveWork, isComputerUseLauncher, isWithin };
