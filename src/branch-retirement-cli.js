"use strict";

const path = require("node:path");
const { reportRetirement, applyRetirement, queueRetirement, drainRetirementQueue } = require("./branch-retirement");

function parseArgs(args) {
  let repo = null;
  let base = null;
  let profilePath = null;
  let backupDir = null;
  let apply = false;
  let defer = false;
  let drainQueue = false;
  let queueFile = null;
  let ownershipReviewed = false;
  let retireProtectedDuplicates = false;
  const activeBranches = [];
  let minAgeDays;
  let quiet = false;
  let help = false;
  const branches = [];

  const valueAfter = (index, option) => {
    const value = args[index + 1];
    if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`${option} requires a value`);
    return value;
  };
  const inlineValue = (arg, prefix) => {
    const value = arg.slice(prefix.length);
    if (value === "") throw new Error(`${prefix.slice(0, -1)} requires a value`);
    return value;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--repo") {
      repo = valueAfter(i++, "--repo");
    } else if (arg.startsWith("--repo=")) {
      repo = inlineValue(arg, "--repo=");
    } else if (arg === "--base") {
      base = valueAfter(i++, "--base");
    } else if (arg.startsWith("--base=")) {
      base = inlineValue(arg, "--base=");
    } else if (arg === "--profile") {
      profilePath = valueAfter(i++, "--profile");
    } else if (arg.startsWith("--profile=")) {
      profilePath = inlineValue(arg, "--profile=");
    } else if (arg === "--backup-dir") {
      backupDir = valueAfter(i++, "--backup-dir");
    } else if (arg.startsWith("--backup-dir=")) {
      backupDir = inlineValue(arg, "--backup-dir=");
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "--defer") {
      defer = true;
    } else if (arg === "--drain-queue") {
      drainQueue = true;
    } else if (arg === "--queue-file") {
      queueFile = valueAfter(i++, "--queue-file");
    } else if (arg.startsWith("--queue-file=")) {
      queueFile = inlineValue(arg, "--queue-file=");
    } else if (arg === "--ownership-reviewed") {
      ownershipReviewed = true;
    } else if (arg === "--retire-protected-duplicates") {
      retireProtectedDuplicates = true;
    } else if (arg === "--active-branch") {
      activeBranches.push(valueAfter(i++, "--active-branch"));
    } else if (arg.startsWith("--active-branch=")) {
      activeBranches.push(inlineValue(arg, "--active-branch="));
    } else if (arg === "--branch") {
      branches.push(valueAfter(i++, "--branch"));
    } else if (arg.startsWith("--branch=")) {
      branches.push(inlineValue(arg, "--branch="));
    } else if (arg === "--min-age-days") {
      const value = valueAfter(i++, "--min-age-days");
      if (!value.trim()) throw new Error("--min-age-days requires a numeric value");
      minAgeDays = Number(value);
    } else if (arg.startsWith("--min-age-days=")) {
      const value = inlineValue(arg, "--min-age-days=");
      if (!value.trim()) throw new Error("--min-age-days requires a numeric value");
      minAgeDays = Number(value);
    } else if (arg === "--quiet") {
      quiet = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (apply && defer) throw new Error("--apply and --defer cannot be used together");
  if (drainQueue && (apply || defer)) throw new Error("--drain-queue cannot be combined with --apply or --defer");
  return { repo, base, profilePath, backupDir, apply, defer, drainQueue, queueFile, ownershipReviewed, retireProtectedDuplicates, activeBranches, branches, minAgeDays, quiet, help };
}

const HELP = `Usage: branch-retirement-cli.js [options]\n\n` +
  `  --repo PATH              repository path\n` +
  `  --base REF               reviewed base ref\n` +
  `  --profile PATH           absolute policy profile path\n` +
  `  --branch NAME            select a candidate, repeatable\n` +
  `  --active-branch NAME     protect a branch, repeatable\n` +
  `  --min-age-days NUMBER    minimum inactivity age, default 30\n` +
  `  --retire-protected-duplicates  retire an exact alias only when a protected ref has the same SHA\n` +
  `  --apply --backup-dir PATH --ownership-reviewed\n` +
  `  --defer [--queue-file PATH] --backup-dir PATH --ownership-reviewed\n` +
  `  --drain-queue [--queue-file PATH]\n` +
  `  --quiet                  suppress process output\n`;

function runCli(args = process.argv.slice(2), options = {}) {
  let stdoutCaptured = "";
  let stderrCaptured = "";

  let quiet = options.quiet === true;
  const logStdout = (msg) => {
    stdoutCaptured += msg + "\n";
    if (options.stdout && typeof options.stdout.write === "function") {
      options.stdout.write(msg + "\n");
    } else if (!quiet && options.stdout !== null) {
      process.stdout.write(msg + "\n");
    }
  };

  const logStderr = (msg) => {
    stderrCaptured += msg + "\n";
    if (options.stderr && typeof options.stderr.write === "function") {
      options.stderr.write(msg + "\n");
    } else if (!quiet && options.stderr !== null) {
      process.stderr.write(msg + "\n");
    }
  };

  try {
    const parsed = parseArgs(args);
    quiet = quiet || parsed.quiet;
    if (parsed.help) {
      logStdout(HELP.trimEnd());
      return { success: true, exitCode: 0, help: HELP, stdout: stdoutCaptured, stderr: stderrCaptured };
    }

    const opts = {
      repo: parsed.repo,
      base: parsed.base,
      profilePath: parsed.profilePath,
      ownershipReviewed: parsed.ownershipReviewed,
      retireProtectedDuplicates: parsed.retireProtectedDuplicates,
      activeBranches: parsed.activeBranches,
      inspectActiveWork: options.inspectActiveWork,
    };
    if (parsed.minAgeDays !== undefined) opts.minAgeDays = parsed.minAgeDays;
    if (parsed.branches.length > 0) opts.branches = parsed.branches;

    if (parsed.drainQueue) {
      const result = drainRetirementQueue({ queueFile: parsed.queueFile, inspectActiveWork: options.inspectActiveWork });
      logStdout(JSON.stringify(result, null, 2));
      return { success: true, exitCode: result.status === "ok" ? 0 : 1, result, stdout: stdoutCaptured, stderr: stderrCaptured };
    } else if (parsed.defer) {
      if (!parsed.backupDir) throw new Error("--backup-dir is required when --defer is specified");
      if (!parsed.ownershipReviewed) throw new Error("--ownership-reviewed is required when --defer is specified");
      opts.backupDir = parsed.backupDir;
      opts.queueFile = parsed.queueFile;
      const result = queueRetirement(opts);
      logStdout(JSON.stringify(result, null, 2));
      return { success: true, exitCode: 0, result, stdout: stdoutCaptured, stderr: stderrCaptured };
    } else if (parsed.apply) {
      if (!parsed.backupDir) {
        throw new Error("--backup-dir is required when --apply is specified");
      }
      if (!parsed.ownershipReviewed) {
        throw new Error("--ownership-reviewed is required when --apply is specified");
      }
      opts.backupDir = parsed.backupDir;
      const result = applyRetirement(opts);
      logStdout(JSON.stringify(result, null, 2));
      return { success: true, exitCode: 0, result, stdout: stdoutCaptured, stderr: stderrCaptured };
    } else {
      const report = reportRetirement(opts);
      logStdout(JSON.stringify(report, null, 2));
      return { success: true, exitCode: 0, report, stdout: stdoutCaptured, stderr: stderrCaptured };
    }
  } catch (err) {
    logStderr(JSON.stringify({ success: false, error: err.message }, null, 2));
    return { success: false, exitCode: 1, error: err, stdout: stdoutCaptured, stderr: stderrCaptured };
  }
}

if (require.main === module) {
  const result = runCli(process.argv.slice(2));
  if (!result.success) {
    process.exit(result.exitCode || 1);
  }
}

module.exports = { runCli, parseArgs };
