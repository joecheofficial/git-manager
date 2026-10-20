"use strict";

const fs = require("./volume-probe").guardFs(require("node:fs"));
const path = require("node:path");

const preservationModule = require("./preservation");
const activeWorkModule = require("./active-work");

function parseArgs(args) {
  const roots = [];
  let backupDir = null;
  let waitForQuiescenceMs = null;
  let maxWaitMs = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--repo") {
      const val = args[++i];
      if (!val) throw new Error("Missing value for --repo");
      roots.push(val);
    } else if (arg.startsWith("--repo=")) {
      roots.push(arg.slice("--repo=".length));
    } else if (arg === "--repos-file") {
      const val = args[++i];
      if (!val) throw new Error("Missing value for --repos-file");
      const content = fs.readFileSync(val, "utf8");
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) {
        throw new Error(`--repos-file content in ${val} must be a JSON array of paths`);
      }
      roots.push(...parsed);
    } else if (arg.startsWith("--repos-file=")) {
      const filePath = arg.slice("--repos-file=".length);
      const content = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) {
        throw new Error(`--repos-file content in ${filePath} must be a JSON array of paths`);
      }
      roots.push(...parsed);
    } else if (arg === "--backup-dir") {
      const val = args[++i];
      if (!val) throw new Error("Missing value for --backup-dir");
      backupDir = val;
    } else if (arg.startsWith("--backup-dir=")) {
      backupDir = arg.slice("--backup-dir=".length);
    } else if (arg === "--wait-for-quiescence-ms") {
      const val = args[++i];
      if (val === undefined) throw new Error("Missing value for --wait-for-quiescence-ms");
      waitForQuiescenceMs = parsePositiveInteger(val, "--wait-for-quiescence-ms");
    } else if (arg.startsWith("--wait-for-quiescence-ms=")) {
      waitForQuiescenceMs = parsePositiveInteger(arg.slice("--wait-for-quiescence-ms=".length), "--wait-for-quiescence-ms");
    } else if (arg === "--max-wait-ms") {
      const val = args[++i];
      if (val === undefined) throw new Error("Missing value for --max-wait-ms");
      maxWaitMs = parseNonnegativeInteger(val, "--max-wait-ms");
    } else if (arg.startsWith("--max-wait-ms=")) {
      maxWaitMs = parseNonnegativeInteger(arg.slice("--max-wait-ms=".length), "--max-wait-ms");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if ((waitForQuiescenceMs === null) !== (maxWaitMs === null)) {
    throw new Error("--wait-for-quiescence-ms and --max-wait-ms must be provided together");
  }
  if (waitForQuiescenceMs !== null && maxWaitMs < waitForQuiescenceMs) {
    throw new Error("--max-wait-ms must be greater than or equal to --wait-for-quiescence-ms");
  }
  return { roots, backupDir, waitForQuiescenceMs, maxWaitMs };
}

function parseNonnegativeInteger(value, option) {
  if (!/^\d+$/.test(value)) throw new Error(`${option} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${option} must be a safe integer`);
  return parsed;
}

function parsePositiveInteger(value, option) {
  const parsed = parseNonnegativeInteger(value, option);
  if (parsed === 0) throw new Error(`${option} must be a positive integer`);
  return parsed;
}

function quiescenceSnapshot(roots, preservation, activeWork, options = {}) {
  const inventory = preservation.inventoryRepositories(roots);
  const rows = inventory.repositories || [];
  const worktrees = [];
  for (const row of rows) {
    let fingerprint = null;
    let active;
    try {
      fingerprint = preservation.sourceFingerprint(row.path);
      active = activeWork.inspectActiveWork(row.path, {
        entries: (row.entries || []).map((entry) => ({ status: entry.status, file: entry.path })),
      });
    } catch (error) {
      active = { protected: true, detectorError: error.message, reasons: [{ type: "quiescence-detector-failed" }] };
    }
    worktrees.push({ path: row.path, fingerprint, operations: row.operations || [], active });
  }
  const blocked = Boolean((inventory.errors || []).length) || worktrees.some((row) => row.active.protected || row.operations.length > 0);
  const fingerprint = JSON.stringify({
    repositories: worktrees.map((row) => ({ path: row.path, fingerprint: row.fingerprint, operations: row.operations })),
    errors: inventory.errors || [],
  });
  return { inventory, worktrees, blocked, fingerprint };
}

function sleep(ms, options = {}) {
  if (!ms) return;
  if (typeof options.sleep === "function") return options.sleep(ms);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForQuiescence(roots, waitForQuiescenceMs, maxWaitMs, options = {}) {
  const preservation = options.preservation || preservationModule;
  const activeWork = options.activeWork || activeWorkModule;
  const now = options.now || Date.now;
  const startedAt = now();
  let attempts = 0;
  let lastSnapshot = null;
  while (true) {
    const first = quiescenceSnapshot(roots, preservation, activeWork, options);
    attempts += 1;
    lastSnapshot = first;
    if (!first.blocked) {
      sleep(waitForQuiescenceMs, options);
      const second = quiescenceSnapshot(roots, preservation, activeWork, options);
      attempts += 1;
      lastSnapshot = second;
      const elapsedAfterSecondMs = now() - startedAt;
      if (!second.blocked && first.fingerprint === second.fingerprint && elapsedAfterSecondMs <= maxWaitMs) {
        return { complete: true, attempts, elapsedMs: elapsedAfterSecondMs, first, second };
      }
      if (elapsedAfterSecondMs >= maxWaitMs) {
        return { complete: false, attempts, elapsedMs: elapsedAfterSecondMs, lastSnapshot };
      }
    }
    const elapsedMs = now() - startedAt;
    if (elapsedMs >= maxWaitMs) {
      return { complete: false, attempts, elapsedMs, lastSnapshot };
    }
    sleep(Math.min(waitForQuiescenceMs || 1, maxWaitMs - elapsedMs), options);
  }
}

function runCleanupCli(args = process.argv.slice(2), options = {}) {
  const preservation = options.preservation || preservationModule;
  let stdoutCaptured = "";
  let stderrCaptured = "";

  const logStdout = (msg) => {
    stdoutCaptured += msg + "\n";
    if (options.stdout && typeof options.stdout.write === "function") {
      options.stdout.write(msg + "\n");
    } else if (!options.quiet && options.stdout !== null) {
      process.stdout.write(msg + "\n");
    }
  };

  const logStderr = (msg) => {
    stderrCaptured += msg + "\n";
    if (options.stderr && typeof options.stderr.write === "function") {
      options.stderr.write(msg + "\n");
    } else if (!options.quiet && options.stderr !== null) {
      process.stderr.write(msg + "\n");
    }
  };

  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    logStderr(`Argument error: ${err.message}`);
    return { success: false, exitCode: 1, error: err, stdout: stdoutCaptured, stderr: stderrCaptured };
  }

  const { roots, backupDir, waitForQuiescenceMs, maxWaitMs } = parsed;

  if (!roots.length) {
    const err = new Error("Explicit repository roots are required");
    logStderr(`Configuration error: ${err.message}`);
    return { success: false, exitCode: 1, error: err, stdout: stdoutCaptured, stderr: stderrCaptured };
  }

  let quiescence = null;
  if (waitForQuiescenceMs !== null) {
    quiescence = waitForQuiescence(roots, waitForQuiescenceMs, maxWaitMs, { ...options, preservation });
    if (!quiescence.complete) {
      const report = {
        taskClass: "maintenance",
        mode: "cleanup-quiescence-report",
        complete: false,
        waitForQuiescenceMs,
        maxWaitMs,
        quiescence,
      };
      logStdout(JSON.stringify(report, null, 2));
      return { success: false, exitCode: 75, report, stdout: stdoutCaptured, stderr: stderrCaptured };
    }
  }

  let inventory;
  try {
    inventory = preservation.inventoryRepositories(roots);
  } catch (err) {
    logStderr(`Inventory error: ${err.message}`);
    return { success: false, exitCode: 1, error: err, stdout: stdoutCaptured, stderr: stderrCaptured };
  }

  const hasInventoryErrors = Array.isArray(inventory.errors) && inventory.errors.length > 0;

  if (!backupDir) {
    // Default inventory mode: prints JSON to stdout and writes nothing
    logStdout(JSON.stringify(inventory, null, 2));

    const success = !hasInventoryErrors;
    return {
      success,
      exitCode: success ? 0 : 1,
      inventory,
      captures: [],
      stdout: stdoutCaptured,
      stderr: stderrCaptured
    };
  }

  // Backup dir validation BEFORE creation
  if (!path.isAbsolute(backupDir)) {
    const err = new Error(`--backup-dir must be an absolute path: ${backupDir}`);
    logStderr(`Configuration error: ${err.message}`);
    return { success: false, exitCode: 1, error: err, stdout: stdoutCaptured, stderr: stderrCaptured };
  }

  // 1. Canonicalize backup parent
  const parentDir = path.dirname(backupDir);
  let canonicalParent;
  try {
    canonicalParent = fs.realpathSync(parentDir);
  } catch (err) {
    const error = new Error(`Backup parent directory does not exist or is invalid: ${parentDir}`);
    logStderr(`Configuration error: ${error.message}`);
    return { success: false, exitCode: 1, error, stdout: stdoutCaptured, stderr: stderrCaptured };
  }

  const canonicalBackupDir = path.join(canonicalParent, path.basename(backupDir));

  // 2. Check destination exists (must be NEW; existing backup must fail without modifying)
  let destExists = false;
  try {
    fs.lstatSync(canonicalBackupDir);
    destExists = true;
  } catch (e) {}

  if (!destExists) {
    try {
      fs.lstatSync(backupDir);
      destExists = true;
    } catch (e) {}
  }

  if (destExists) {
    const err = new Error(`Backup directory already exists: ${backupDir}`);
    logStderr(`Configuration error: ${err.message}`);
    return { success: false, exitCode: 1, error: err, stdout: stdoutCaptured, stderr: stderrCaptured };
  }

  // 3. Validate destination outside every inventoried repository and Git common directory BEFORE creating anything
  const protectedRoots = new Set();
  if (Array.isArray(inventory.repositories)) {
    for (const repoRow of inventory.repositories) {
      const candidates = [repoRow.path, repoRow.common, repoRow.gitDir];
      for (const cand of candidates) {
        if (!cand) continue;
        protectedRoots.add(path.resolve(cand));
        try {
          protectedRoots.add(fs.realpathSync(cand));
        } catch {}
      }
    }
  }

  for (const protectedRoot of protectedRoots) {
    if (
      canonicalBackupDir === protectedRoot ||
      canonicalBackupDir.startsWith(protectedRoot + path.sep) ||
      path.resolve(backupDir) === protectedRoot ||
      path.resolve(backupDir).startsWith(protectedRoot + path.sep)
    ) {
      const err = new Error(`Backup directory must be outside every inventoried repository and Git metadata: ${backupDir}`);
      logStderr(`Configuration error: ${err.message}`);
      return { success: false, exitCode: 1, error: err, stdout: stdoutCaptured, stderr: stderrCaptured };
    }
  }

  // 4. Destination must be NEW and mkdir nonrecursive
  try {
    fs.mkdirSync(canonicalBackupDir, { mode: 0o700 });
  } catch (err) {
    logStderr(`Backup creation error: ${err.message}`);
    return { success: false, exitCode: 1, error: err, stdout: stdoutCaptured, stderr: stderrCaptured };
  }

  // 5. Create captures directory nonrecursively
  const capturesDir = path.join(canonicalBackupDir, "captures");
  try {
    fs.mkdirSync(capturesDir, { mode: 0o700 });
  } catch (err) {
    logStderr(`Captures dir creation error: ${err.message}`);
    return { success: false, exitCode: 1, error: err, stdout: stdoutCaptured, stderr: stderrCaptured };
  }
  const artifactsDir = path.join(canonicalBackupDir, "artifacts");
  try {
    fs.mkdirSync(artifactsDir, { mode: 0o700 });
  } catch (err) {
    logStderr(`Artifacts dir creation error: ${err.message}`);
    return { success: false, exitCode: 1, error: err, stdout: stdoutCaptured, stderr: stderrCaptured };
  }

  // 6. Capture dirty repositories
  const metadataCache = new Map();
  const captures = [];
  let captureError = null;

  const repositories = inventory.repositories || [];
  const inventoryBaselines = new Map();
  for (const repoRow of repositories) {
    try {
      inventoryBaselines.set(repoRow.path, preservation.sourceBaseline(repoRow.path));
    } catch (err) {
      captureError = err;
      inventoryBaselines.set(repoRow.path, null);
    }
  }
  const snapshotTokensByCommon = new Map();
  for (const baseline of inventoryBaselines.values()) {
    if (!baseline) continue;
    const items = snapshotTokensByCommon.get(baseline.row.common) || [];
    items.push(`${baseline.row.path}\0${baseline.token}`);
    snapshotTokensByCommon.set(baseline.row.common, items);
  }
  const sharedSnapshotKeys = new Map();
  for (const [common, items] of snapshotTokensByCommon) {
    sharedSnapshotKeys.set(common, items.sort().join("\0"));
  }
  for (let i = 0; i < repositories.length; i++) {
    const repoRow = repositories[i];
    const baselineRow = inventoryBaselines.get(repoRow.path)?.row || repoRow;
    const isDirty =
      (baselineRow.entries && baselineRow.entries.length > 0) ||
      (baselineRow.operations && baselineRow.operations.length > 0) ||
      Boolean(baselineRow.status && baselineRow.status.trim());

    if (isDirty) {
      const repoName = path.basename(repoRow.path);
      const captureTarget = path.join(capturesDir, `${i}-${repoName}`);
      try {
        const result = preservation.captureRepository(repoRow.path, captureTarget, {
          metadataCache,
          artifactDirectory: artifactsDir,
          commonSnapshotKey: sharedSnapshotKeys.get(baselineRow.common),
        });
        captures.push(result);
      } catch (err) {
        captureError = err;
        captures.push({
          taskClass: "maintenance",
          directory: captureTarget,
          repo: repoRow.path,
          complete: false,
          issues: [err.message]
        });
      }
    }
  }

  // A linked worktree nested below another checkout is reported by Git as an
  // untracked directory in the parent. Resolve that warning only when the
  // directory is an exact, inventoried worktree whose baseline is clean or
  // whose dirty state has its own complete capture.
  const baselinesByRealPath = new Map();
  for (const [repoPath, baseline] of inventoryBaselines) {
    if (!baseline) continue;
    try { baselinesByRealPath.set(fs.realpathSync(repoPath), baseline); } catch {}
  }
  const capturesByRealPath = new Map();
  const verifiedArtifacts = new Map();
  for (const capture of captures) {
    try { capturesByRealPath.set(fs.realpathSync(capture.repo), capture); } catch {}
  }
  for (const capture of captures) {
    const retainedIssues = [];
    const linkedWorktrees = [];
    for (const issue of capture.issues || []) {
      const prefix = "Separate repository capture required: ";
      if (!issue.startsWith(prefix)) {
        retainedIssues.push(issue);
        continue;
      }
      const relative = issue.slice(prefix.length).replace(/\/$/, "");
      let nestedRealPath;
      try { nestedRealPath = fs.realpathSync(path.resolve(capture.repo, relative)); } catch {}
      const baseline = nestedRealPath && baselinesByRealPath.get(nestedRealPath);
      const dirty = baseline && (
        (baseline.row.entries && baseline.row.entries.length > 0) ||
        (baseline.row.operations && baseline.row.operations.length > 0) ||
        Boolean(baseline.row.status && baseline.row.status.trim())
      );
      const nestedCapture = nestedRealPath && capturesByRealPath.get(nestedRealPath);
      if (baseline && (!dirty || (nestedCapture && nestedCapture.complete && !(nestedCapture.issues || []).length))) {
        linkedWorktrees.push({ path: nestedRealPath, sourceToken: baseline.token, dirty: Boolean(dirty) });
      } else {
        retainedIssues.push(issue);
      }
    }
    if (linkedWorktrees.length) capture.linkedWorktrees = linkedWorktrees;
    capture.issues = retainedIssues;
    capture.complete = retainedIssues.length === 0;
    if (fs.existsSync(capture.directory)) {
      fs.writeFileSync(
        path.join(capture.directory, "manifest.json"),
        JSON.stringify(capture, null, 2),
        { mode: 0o600 },
      );
    }
  }

  if (typeof options.beforeFinalVerify === "function") {
    options.beforeFinalVerify(captures);
  }
  for (const capture of captures) {
    if (!capture.complete || !fs.existsSync(capture.directory)) continue;
    const issues = [
      ...preservation.verifyCaptureArtifacts(capture, verifiedArtifacts),
      ...preservation.verifyCaptureSource(capture),
    ];
    if (issues.length) {
      capture.issues.push(...issues);
      capture.complete = false;
      fs.writeFileSync(
        path.join(capture.directory, "manifest.json"),
        JSON.stringify(capture, null, 2),
        { mode: 0o600 },
      );
    }
  }

  const inventoryRevalidation = [];
  for (const repoRow of repositories) {
    try {
      const before = inventoryBaselines.get(repoRow.path)?.token;
      const after = preservation.sourceFingerprint(repoRow.path);
      if (!before || before !== after)
        inventoryRevalidation.push({
          path: repoRow.path,
          issue: "Repository or worktree changed during multi-repository capture",
        });
    } catch (error) {
      inventoryRevalidation.push({
        path: repoRow.path,
        issue: `Final repository revalidation failed: ${error.message}`,
      });
    }
  }

  const hasIncompleteCaptures = captures.some((c) => !c.complete || (c.issues && c.issues.length > 0));

  const report = {
    taskClass: "maintenance",
    mode: "cleanup-capture-report",
    backupDir: canonicalBackupDir,
    inventory,
    captures,
    inventoryRevalidation,
    quiescence,
    complete: !hasInventoryErrors && !hasIncompleteCaptures && !captureError && !inventoryRevalidation.length
  };

  fs.writeFileSync(path.join(canonicalBackupDir, "inventory.json"), JSON.stringify(inventory, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(canonicalBackupDir, "captures.json"), JSON.stringify(captures, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(canonicalBackupDir, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });

  logStdout(JSON.stringify(report, null, 2));

  const success = !hasInventoryErrors && !hasIncompleteCaptures && !captureError && !inventoryRevalidation.length;
  return {
    success,
    exitCode: success ? 0 : 1,
    inventory,
    captures,
    report,
    quiescence,
    stdout: stdoutCaptured,
    stderr: stderrCaptured
  };
}

if (require.main === module) {
  const result = runCleanupCli(process.argv.slice(2));
  if (!result.success) {
    process.exit(result.exitCode || 1);
  }
}

module.exports = { runCleanupCli, parseArgs, waitForQuiescence, quiescenceSnapshot };
