"use strict";

const fs = require("./volume-probe").guardFs(require("node:fs"));
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const preservation = require("./preservation");
const defaultActiveWork = require("./active-work");

function git(repo, args, options = {}) {
  const buf = execFileSync("git", ["--no-optional-locks", "--literal-pathspecs", "-C", repo, ...args], {
    maxBuffer: 128 * 1024 * 1024,
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...(options.env || {}) },
  });
  return buf.toString("utf8").trim();
}

function optionalGit(repo, args) {
  try {
    return git(repo, args);
  } catch {
    return null;
  }
}

function fileHash(file) {
  if (!fs.existsSync(file)) throw new Error(`Required file is missing: ${file}`);
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    let count;
    while ((count = fs.readSync(fd, chunk, 0, chunk.length, null))) h.update(chunk.subarray(0, count));
    return h.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

function writeAndFsyncJson(filePath, data) {
  const content = JSON.stringify(data, null, 2);
  const fd = fs.openSync(filePath, "w", 0o600);
  try {
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function validateStringList(value, fieldName) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${fieldName} must be an array of non-empty strings`);
  }
  return [...value];
}

function validateProfile(profile, sourceLabel) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error(`Profile at ${sourceLabel} must be a JSON object`);
  }
  if (profile.repositoryRoot !== undefined && (typeof profile.repositoryRoot !== "string" || profile.repositoryRoot.length === 0)) {
    throw new Error(`Profile repositoryRoot at ${sourceLabel} must be a non-empty string`);
  }
  if (profile.branchCleanup !== undefined && (!profile.branchCleanup || typeof profile.branchCleanup !== "object" || Array.isArray(profile.branchCleanup))) {
    throw new Error(`Profile branchCleanup at ${sourceLabel} must be an object`);
  }
  const cleanup = profile.branchCleanup || {};
  validateStringList(cleanup.protectedBranches, "branchCleanup.protectedBranches");
  validateStringList(cleanup.activeBranches, "branchCleanup.activeBranches");
  validateStringList(cleanup.branches, "branchCleanup.branches");
  return profile;
}

function loadProfileDocument(profilePath) {
  let explicitPath = profilePath;

  if (!explicitPath && process.env.GIT_MANAGER_PROFILE) {
    if (!path.isAbsolute(process.env.GIT_MANAGER_PROFILE)) {
      throw new Error("GIT_MANAGER_PROFILE must be an absolute path");
    }
    explicitPath = process.env.GIT_MANAGER_PROFILE;
  }

  if (explicitPath) {
    if (!path.isAbsolute(explicitPath)) {
      throw new Error(`Profile path "${explicitPath}" must be an absolute path`);
    }
    if (!fs.existsSync(explicitPath)) {
      throw new Error(`Profile file not found at ${explicitPath}`);
    }
    try {
      const bytes = fs.readFileSync(explicitPath);
      const parsed = validateProfile(JSON.parse(bytes.toString("utf8")), explicitPath);
      return { profile: parsed, path: fs.realpathSync(explicitPath), sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
    } catch (err) {
      throw new Error(`Profile file at ${explicitPath} is malformed JSON: ${err.message}`);
    }
  }

  const home = process.env.HOME || process.env.USERPROFILE || "";
  const defaultPaths = [];
  if (home) {
    defaultPaths.push(path.join(home, ".config", "allsorted", "git-manager", "profile.json"));
    defaultPaths.push(path.join(home, ".config", "git-manager", "profile.json"));
  }

  for (const p of defaultPaths) {
    if (fs.existsSync(p)) {
      try {
        const bytes = fs.readFileSync(p);
        const parsed = validateProfile(JSON.parse(bytes.toString("utf8")), p);
        return { profile: parsed, path: fs.realpathSync(p), sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
      } catch (err) {
        throw new Error(`Profile file at ${p} is malformed JSON: ${err.message}`);
      }
    }
  }

  return { profile: {}, path: null, sha256: null };
}

function loadProfile(profilePath) {
  return loadProfileDocument(profilePath).profile;
}

function resolveRepoPath(options = {}, profile = {}) {
  const repoInput = options.repo || process.env.REPOSITORY_ROOT || process.env.GIT_MANAGER_REPO || profile.repositoryRoot;
  if (!repoInput || typeof repoInput !== "string") {
    throw new Error("Repository path must be specified via options.repo, GIT_MANAGER_REPO env, or profile.repositoryRoot");
  }
  const repo = path.resolve(repoInput);
  if (!fs.existsSync(repo)) {
    throw new Error(`Repository directory does not exist: ${repo}`);
  }
  return fs.realpathSync(repo);
}

function resolveBaseRef(repo, baseInput) {
  if (!baseInput || typeof baseInput !== "string" || !baseInput.trim()) {
    throw new Error("Explicit base full ref is required (e.g. refs/heads/main)");
  }
  let fullRef = baseInput.trim();
  if (!fullRef.startsWith("refs/")) {
    fullRef = `refs/heads/${fullRef}`;
  }

  try {
    git(repo, ["check-ref-format", fullRef]);
  } catch (err) {
    throw new Error(`Invalid base ref format "${fullRef}": ${err.message}`);
  }

  try {
    git(repo, ["show-ref", "--verify", fullRef]);
  } catch (err) {
    throw new Error(`Base ref "${fullRef}" could not be verified in repository ${repo}`);
  }

  let refType = null;
  try {
    refType = git(repo, ["cat-file", "-t", fullRef]);
  } catch {}
  if (refType !== "commit") {
    throw new Error(`Base ref "${fullRef}" is not a commit object (type: ${refType || "unknown"})`);
  }

  const sha = optionalGit(repo, ["rev-parse", "--verify", fullRef]);
  if (!sha) {
    throw new Error(`Base ref "${fullRef}" SHA could not be resolved`);
  }
  return { fullRef, sha };
}

function isProtected(branchName, protectedPatterns = []) {
  const protectedDefaults = ["main", "master", "develop", "release", "release/*", "recovery", "recovery/*", "*preserve*"];
  const name = branchName.replace(/^refs\/heads\//, "");
  const refFull = branchName.startsWith("refs/heads/") ? branchName : `refs/heads/${branchName}`;

  const allPatterns = [...protectedDefaults, ...protectedPatterns];

  for (const pattern of allPatterns) {
    if (!pattern || typeof pattern !== "string") continue;
    const cleanPattern = pattern.replace(/^refs\/heads\//, "");

    if (cleanPattern === name || pattern === branchName || pattern === refFull) return true;

    if (cleanPattern.includes("*")) {
      const escaped = cleanPattern.replace(/[\-\[\]\/\{\}\(\)\+\?\.\\\^\$\|]/g, "\\$&").replace(/\*/g, ".*");
      const regex = new RegExp("^" + escaped + "$");
      if (regex.test(name) || regex.test(branchName)) return true;
    }
  }
  return false;
}

function getWorktreeInfo(repo) {
  let rawBuf;
  try {
    rawBuf = execFileSync("git", ["--no-optional-locks", "--literal-pathspecs", "-C", repo, "worktree", "list", "--porcelain", "-z"], {
      maxBuffer: 128 * 1024 * 1024,
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
  } catch (err) {
    throw new Error(`Failed to list worktrees in ${repo}: ${err.message}`);
  }

  const worktreeRawBytes = rawBuf.toString("hex");
  const str = rawBuf.toString("utf8");
  const fields = str.split("\0");

  const branches = new Set();
  const roots = [];

  for (const field of fields) {
    if (!field) continue;
    if (field.startsWith("worktree ")) {
      roots.push(path.resolve(field.slice("worktree ".length)));
    } else if (field.startsWith("branch ")) {
      const ref = field.slice("branch ".length).trim();
      branches.add(ref);
      if (ref.startsWith("refs/heads/")) {
        branches.add(ref.slice("refs/heads/".length));
      }
    }
  }

  const curr = optionalGit(repo, ["symbolic-ref", "-q", "HEAD"]);
  if (curr) {
    branches.add(curr);
    if (curr.startsWith("refs/heads/")) {
      branches.add(curr.slice("refs/heads/".length));
    }
  }

  return { worktreeBranches: branches, worktreeRoots: roots, worktreeRawBytes };
}

function reflogLineTimestamp(line) {
  const metadata = line.split("\t", 1)[0];
  const match = metadata.match(/ (\d+) [+-]\d{4}$/);
  return match ? Number(match[1]) * 1000 : null;
}

function latestHeadCheckoutTimestamp(repo, branchName, worktreeRoots) {
  const logFiles = new Set();
  const commonDir = git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  logFiles.add(path.join(commonDir, "logs", "HEAD"));
  for (const root of worktreeRoots) {
    const gitDir = git(root, ["rev-parse", "--absolute-git-dir"]);
    logFiles.add(path.join(gitDir, "logs", "HEAD"));
  }

  let latest = null;
  for (const logFile of logFiles) {
    if (!fs.existsSync(logFile)) continue;
    const lines = fs.readFileSync(logFile, "utf8").split("\n");
    for (const line of lines) {
      const message = line.slice(line.indexOf("\t") + 1);
      const match = message.match(/^checkout: moving from (\S+) to (\S+)$/);
      if (!match || (match[1] !== branchName && match[2] !== branchName)) continue;
      const timestamp = reflogLineTimestamp(line);
      if (timestamp && (!latest || timestamp > latest)) latest = timestamp;
    }
  }
  return latest;
}

function getRefAge(repo, branchRef, now = Date.now(), worktreeRoots = []) {
  const commitTsRaw = git(repo, ["log", "-1", "--format=%ct", branchRef]);
  const commitTs = Number(commitTsRaw) * 1000;
  if (!Number.isFinite(commitTs) || commitTs <= 0) throw new Error(`Could not determine commit age for ${branchRef}`);

  let reflogTs = null;
  let reflogChecked = false;

  const reflogRaw = optionalGit(repo, ["reflog", "show", "-n", "1", "--date=unix", branchRef]);
  if (reflogRaw) {
    reflogChecked = true;
    const match = reflogRaw.match(/@\{(\d+)\}/);
    if (match) {
      const parsed = Number(match[1]);
      if (!isNaN(parsed) && parsed > 0) reflogTs = parsed * 1000;
    }
  }

  const gitDir = git(repo, ["rev-parse", "--absolute-git-dir"]);
  const relPath = branchRef.startsWith("refs/") ? branchRef : `refs/heads/${branchRef}`;
  const reflogFile = path.join(gitDir, "logs", relPath);

  try {
    if (fs.existsSync(reflogFile)) {
      reflogChecked = true;
      if (!reflogTs) {
        const content = fs.readFileSync(reflogFile, "utf8").trim();
        if (content) {
          const lines = content.split("\n");
          const lastLine = lines[lines.length - 1];
          const parts = lastLine.split("\t")[0].split(" ");
          if (parts.length >= 5) {
            const tsStr = parts[parts.length - 2];
            const parsed = Number(tsStr);
            if (!isNaN(parsed) && parsed > 0) reflogTs = parsed * 1000;
          }
        }
      }
    }
  } catch (error) {
    throw new Error(`Failed to read reflog for ${branchRef}: ${error.message}`);
  }

  const branchName = branchRef.replace(/^refs\/heads\//, "");
  const headReflogTs = latestHeadCheckoutTimestamp(repo, branchName, worktreeRoots);

  if (!reflogTs && !reflogChecked) {
    if (!headReflogTs) return { ageDays: null, unknownAge: true, commitTs, reflogTs: null, headReflogTs: null };
  }

  if (reflogChecked && !reflogTs) {
    if (!headReflogTs) return { ageDays: null, unknownAge: true, commitTs, reflogTs: null, headReflogTs: null };
  }

  const latestTs = Math.max(commitTs || 0, reflogTs || 0, headReflogTs || 0);
  const ageDays = (now - latestTs) / (1000 * 60 * 60 * 24);
  return { ageDays, unknownAge: false, commitTs, reflogTs, headReflogTs, latestTs };
}

function isExactAncestor(repo, candidateRef, baseRef) {
  try {
    execFileSync("git", ["--no-optional-locks", "-C", repo, "merge-base", "--is-ancestor", candidateRef, baseRef], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function findProtectedDuplicate(refs, candidate, protectedPatterns = []) {
  return refs.find(ref =>
    ref.refName !== candidate.refName &&
    ref.sha === candidate.sha &&
    isProtected(ref.refName, protectedPatterns)
  ) || null;
}

function assertBackupContainment(backupDir, repo, gitCommonDir, worktreeRoots = []) {
  if (!backupDir || typeof backupDir !== "string" || !path.isAbsolute(backupDir)) {
    throw new Error("--backup-dir must be an absolute path");
  }

  let resolvedBackup;
  try {
    resolvedBackup = fs.realpathSync(backupDir);
  } catch {
    resolvedBackup = path.resolve(backupDir);
    let curr = path.dirname(resolvedBackup);
    while (curr && curr !== path.dirname(curr)) {
      if (fs.existsSync(curr)) {
        const realParent = fs.realpathSync(curr);
        resolvedBackup = path.join(realParent, path.relative(curr, resolvedBackup));
        break;
      }
      curr = path.dirname(curr);
    }
  }

  const checkTargets = [repo];
  if (gitCommonDir) checkTargets.push(gitCommonDir);
  for (const root of worktreeRoots) {
    if (root) checkTargets.push(root);
  }

  for (const target of checkTargets) {
    let resolvedTarget;
    try {
      resolvedTarget = fs.realpathSync(target);
    } catch {
      resolvedTarget = path.resolve(target);
    }

    const rel = path.relative(resolvedTarget, resolvedBackup);
    if (!rel || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      throw new Error(`Backup destination "${backupDir}" is inside forbidden root "${target}" (${resolvedTarget})`);
    }
  }
}

function captureRepoStateSignature(repo) {
  const symbolicHead = optionalGit(repo, ["symbolic-ref", "-q", "HEAD"]);
  const head = symbolicHead || git(repo, ["rev-parse", "--verify", "HEAD"]);
  const branch = git(repo, ["branch", "--show-current"]);
  const gitDir = git(repo, ["rev-parse", "--absolute-git-dir"]);
  const indexPath = path.join(gitDir, "index");
  const indexSha = fileHash(indexPath);
  const status = git(repo, ["status", "--porcelain=v2", "-z"]);
  const refs = git(repo, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)%00"]);

  return { head, branch, indexSha, status, refs };
}

function reportRetirement(options = {}) {
  const profileDocument = loadProfileDocument(options.profilePath);
  const profile = profileDocument.profile;
  const profileConfig = profile.branchCleanup || {};

  const repo = resolveRepoPath(options, profile);

  const baseInput = options.base || profileConfig.baseRef;
  if (!baseInput) {
    throw new Error("Explicit base full ref is required (e.g. refs/heads/main) via options.base or profile");
  }
  const { fullRef: baseRef, sha: baseSha } = resolveBaseRef(repo, baseInput);

  if (options.minAgeDays === null || profileConfig.minAgeDays === null) {
    throw new Error("minAgeDays must not be null");
  }
  const rawMinAge = options.minAgeDays !== undefined ? options.minAgeDays : profileConfig.minAgeDays;
  const minAgeDays = rawMinAge !== undefined ? Number(rawMinAge) : 30;
  if (!Number.isFinite(minAgeDays) || minAgeDays < 0) {
    throw new Error("minAgeDays must be a finite non-negative number");
  }

  const ownershipReviewed = options.ownershipReviewed === true;
  const retireProtectedDuplicates = options.retireProtectedDuplicates === true;

  const optionProtected = validateStringList(options.protectedBranches, "protectedBranches");
  const profileProtected = validateStringList(profileConfig.protectedBranches, "branchCleanup.protectedBranches");
  const protectedConfig = [...optionProtected, ...profileProtected];

  const optionActive = validateStringList(options.activeBranches, "activeBranches");
  const profileActive = validateStringList(profileConfig.activeBranches, "branchCleanup.activeBranches");
  const activeBranchList = [...optionActive, ...profileActive];
  const activeBranches = new Set(activeBranchList.map(b => b.startsWith("refs/heads/") ? b : `refs/heads/${b}`));

  const { worktreeBranches, worktreeRoots, worktreeRawBytes } = getWorktreeInfo(repo);

  const activeDetector = options.inspectActiveWork || (defaultActiveWork.inspectActiveWork ? defaultActiveWork.inspectActiveWork : defaultActiveWork);
  let activeWorkRes = { protected: false, reasons: [] };
  let activeDetectorError = null;

  try {
    activeWorkRes = activeDetector(repo);
  } catch (err) {
    activeDetectorError = err.message;
    activeWorkRes = { protected: true, reasons: [`Detector error: ${err.message}`] };
  }

  const rawRefs = git(repo, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)%00", "refs/heads"]);
  const fields = rawRefs.split("\0");
  const refs = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const refName = fields[index].replace(/^\n+/, "");
    if (!refName) continue;
    refs.push({ refName, sha: fields[index + 1], symref: fields[index + 2] });
  }

  const eligible = [];
  const retained = [];
  const missingEvidence = [];

  if (!ownershipReviewed) {
    missingEvidence.push("Operator ownership review flag ownershipReviewed is false or missing");
  }
  if (activeWorkRes.protected) {
    missingEvidence.push(`Active work or writer detector protection: ${JSON.stringify(activeWorkRes.reasons)}`);
  }
  if (activeDetectorError) {
    missingEvidence.push(`Active detector error details: ${activeDetectorError}`);
  }

  const now = options.now ?? Date.now();

  const hasOptionBranches = Object.prototype.hasOwnProperty.call(options, "branches") && options.branches !== undefined;
  const configuredBranches = hasOptionBranches
    ? validateStringList(options.branches, "branches")
    : (profileConfig.branches === undefined ? null : validateStringList(profileConfig.branches, "branchCleanup.branches"));
  const selectedBranches = configuredBranches === null
    ? null
    : new Set(configuredBranches.map(b => b.startsWith("refs/heads/") ? b : `refs/heads/${b}`));

  for (const ref of refs) {
    const { refName, sha, symref } = ref;

    const branchName = refName.slice("refs/heads/".length);

    if (symref) {
      retained.push({ refName, branchName, sha, reason: "symbolic-ref", symref });
      continue;
    }

    if (refName === baseRef) {
      retained.push({ refName, branchName, sha, reason: "base-ref" });
      continue;
    }

    if (isProtected(refName, protectedConfig)) {
      retained.push({ refName, branchName, sha, reason: "protected" });
      continue;
    }

    if (activeBranches.has(refName) || activeBranches.has(branchName)) {
      retained.push({ refName, branchName, sha, reason: "active-branch" });
      continue;
    }

    if (worktreeBranches.has(refName) || worktreeBranches.has(branchName)) {
      retained.push({ refName, branchName, sha, reason: "worktree-checkedout" });
      continue;
    }

    const protectedDuplicate = retireProtectedDuplicates
      ? findProtectedDuplicate(refs, ref, protectedConfig)
      : null;
    const exactAncestor = isExactAncestor(repo, refName, baseRef);

    if (!exactAncestor && !protectedDuplicate) {
      retained.push({ refName, branchName, sha, reason: "unmerged" });
      continue;
    }

    const ageInfo = getRefAge(repo, refName, now, worktreeRoots);
    if (ageInfo.unknownAge) {
      retained.push({ refName, branchName, sha, reason: "unknown-reflog-age", ageInfo });
      continue;
    }

    if (ageInfo.ageDays < minAgeDays) {
      retained.push({ refName, branchName, sha, reason: "too-recent", ageDays: ageInfo.ageDays, ageInfo });
      continue;
    }

    if (selectedBranches && !selectedBranches.has(refName)) {
      retained.push({ refName, branchName, sha, reason: "not-selected" });
      continue;
    }

    eligible.push({
      refName,
      branchName,
      sha,
      ageDays: ageInfo.ageDays,
      ageInfo,
      retirementReason: exactAncestor ? "exact-ancestor" : "protected-duplicate",
      protectedDuplicateOf: protectedDuplicate ? protectedDuplicate.refName : null,
    });
  }

  const evidence = {
    profilePath: profileDocument.path,
    profileSha256: profileDocument.sha256,
    protectedBranches: protectedConfig,
    activeBranches: activeBranchList,
    selectedBranches: configuredBranches,
    sourceRefs: refs,
    retireProtectedDuplicates,
    eligible: eligible.map(row => ({ refName: row.refName, sha: row.sha, ageInfo: row.ageInfo, retirementReason: row.retirementReason, protectedDuplicateOf: row.protectedDuplicateOf })),
    retained: retained.map(row => ({ refName: row.refName, sha: row.sha, reason: row.reason, symref: row.symref || null, ageInfo: row.ageInfo || null })),
  };
  return {
    taskClass: "maintenance",
    mode: "branch-retirement-report",
    repo,
    base: baseRef,
    baseSha,
    minAgeDays,
    ownershipReviewed,
    retireProtectedDuplicates,
    status: missingEvidence.length ? "blocked" : "ready",
    eligible,
    retained,
    missingEvidence,
    worktreeRawBytes,
    worktreeRoots,
    evidence,
    evidenceSha256: crypto.createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
  };
}

function captureArtifactState(captureResult) {
  if (!captureResult.complete || (captureResult.issues && captureResult.issues.length > 0)) {
    throw new Error(`Backup capture incomplete or encountered issues: ${JSON.stringify(captureResult.issues)}`);
  }
  const metadata = captureResult.metadata;
  if (!metadata || !metadata.archive || !metadata.objectArchive || !metadata.bundle) {
    throw new Error("Backup capture failed to produce metadata archive, object archive and history bundle");
  }
  const manifestPath = path.join(captureResult.directory, "manifest.json");
  let savedManifest;
  try {
    savedManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Saved capture manifest is unreadable: ${error.message}`);
  }
  if (savedManifest.complete !== true || (savedManifest.issues && savedManifest.issues.length > 0)) {
    throw new Error("Saved capture manifest does not certify a complete capture");
  }
  return {
    archive: fileHash(metadata.archive),
    objects: fileHash(metadata.objectArchive),
    bundle: fileHash(metadata.bundle),
    manifest: fileHash(manifestPath),
  };
}

function assertArtifactState(captureResult, expected) {
  const actual = captureArtifactState(captureResult);
  for (const name of ["archive", "objects", "bundle", "manifest"]) {
    if (actual[name] !== expected[name]) throw new Error(`Backup ${name} hash changed before transaction; aborting`);
  }
}

function applyRetirement(options = {}) {
  if (options.ownershipReviewed !== true) {
    throw new Error("ownershipReviewed flag must be true to apply branch retirement");
  }

  const initialProfileDocument = loadProfileDocument(options.profilePath);
  const profile = initialProfileDocument.profile;
  const repo = resolveRepoPath(options, profile);

  const backupDir = options.backupDir;
  if (!backupDir || typeof backupDir !== "string" || !path.isAbsolute(backupDir)) {
    throw new Error("--backup-dir absolute path is required for applyRetirement");
  }

  const gitCommonDir = optionalGit(repo, ["rev-parse", "--git-common-dir"]) || optionalGit(repo, ["rev-parse", "--absolute-git-dir"]);
  const { worktreeRoots: initialWtRoots } = getWorktreeInfo(repo);
  assertBackupContainment(backupDir, repo, gitCommonDir, initialWtRoots);

  const repoInfo = preservation.inspectRepository(repo);
  if (repoInfo.entries.length > 0) {
    throw new Error(`Cannot apply retirement: repository has uncommitted changes (${repoInfo.entries.length} entries)`);
  }
  if (repoInfo.operations.length > 0) {
    throw new Error(`Cannot apply retirement: repository has active operations in progress: ${repoInfo.operations.join(", ")}`);
  }

  const activeDetector = options.inspectActiveWork || (defaultActiveWork.inspectActiveWork ? defaultActiveWork.inspectActiveWork : defaultActiveWork);
  const activeWork = activeDetector(repo);
  if (activeWork.protected) {
    throw new Error(`Cannot apply retirement: active writer or detector protection: ${JSON.stringify(activeWork.reasons)}`);
  }

  const stateSigBefore = captureRepoStateSignature(repo);

  const now = options.now ?? Date.now();
  const report = reportRetirement({ ...options, repo, now });
  if (report.evidence.profilePath !== initialProfileDocument.path || report.evidence.profileSha256 !== initialProfileDocument.sha256) {
    throw new Error("Profile configuration changed while preparing retirement; aborting");
  }

  if (report.missingEvidence.length > 0) {
    throw new Error(`Cannot apply retirement due to missing evidence: ${report.missingEvidence.join("; ")}`);
  }

  if (report.eligible.length === 0) {
    return {
      taskClass: "maintenance",
      mode: "branch-retirement-apply",
      status: "ok",
      repo,
      base: report.base,
      backupDir,
      retired: [],
      message: "No eligible branches for retirement"
    };
  }

  const captureResult = preservation.captureRepository(repo, backupDir);
  const capturedArtifacts = captureArtifactState(captureResult);
  const preTamperManifest = new Map(report.eligible.map(c => [c.refName, c.sha]));
  preTamperManifest.set(report.base, report.baseSha);

  const hooks = options.hooks || {};
  if (hooks.tamperBackup) {
    hooks.tamperBackup(backupDir, captureResult);
  }

  const bundlePath = captureResult.metadata.bundle;
  assertArtifactState(captureResult, capturedArtifacts);

  const bundleHeadsRaw = git(repo, ["bundle", "list-heads", bundlePath]);
  const bundleRefsMap = new Map();
  for (const line of bundleHeadsRaw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      bundleRefsMap.set(parts[1], parts[0]);
    }
  }

  for (const cand of report.eligible) {
    const expectedSha = preTamperManifest.get(cand.refName);
    if (!expectedSha || cand.sha !== expectedSha) {
      throw new Error(`Candidate manifest mismatch for ${cand.refName}`);
    }
    const bundleSha = bundleRefsMap.get(cand.refName);
    if (bundleSha !== cand.sha) {
      throw new Error(`Bundle exact head verification failed for ${cand.refName}: expected ${cand.sha}, got ${bundleSha || "missing"}`);
    }
  }
  if (bundleRefsMap.get(report.base) !== report.baseSha) {
    throw new Error(`Bundle exact base verification failed for ${report.base}`);
  }

  const tmpBareDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-bundle-verify-"));
  let externalVerificationPassed = false;
  try {
    execFileSync("git", ["init", "--bare", tmpBareDir], { stdio: ["ignore", "pipe", "pipe"] });
    const mappings = [
      { refName: report.base, sha: report.baseSha },
      ...report.eligible.map(cand => ({ refName: cand.refName, sha: cand.sha })),
    ];
    const refspecs = mappings.map(({ refName }) => `${refName}:${refName}`);
    execFileSync("git", ["-C", tmpBareDir, "fetch", bundlePath, ...refspecs], { stdio: ["ignore", "pipe", "pipe"] });
    for (const mapping of mappings) {
      const extSha = git(tmpBareDir, ["rev-parse", "--verify", mapping.refName]);
      if (extSha !== mapping.sha) {
        throw new Error(`External bare recovery verification failed for ${mapping.refName}: expected ${mapping.sha}, got ${extSha}`);
      }
    }
    externalVerificationPassed = true;
  } catch (err) {
    throw new Error(`External unbundle recoverability test failed; fixture retained at ${tmpBareDir}: ${err.message}`);
  } finally {
    if (externalVerificationPassed) fs.rmSync(tmpBareDir, { recursive: true, force: true });
  }

  const runId = Date.now() + "-" + crypto.randomBytes(4).toString("hex");

  const journalPath = path.join(backupDir, "retirement-journal.json");
  const pendingJournalData = {
    taskClass: "maintenance",
    mode: "branch-retirement-journal",
    status: "pending",
    timestamp: new Date().toISOString(),
    runId,
    repo,
    base: report.base,
    baseSha: report.baseSha,
    backupDir,
    bundleSha256: capturedArtifacts.bundle,
    objectArchiveSha256: capturedArtifacts.objects,
    candidateBranches: report.eligible.map(b => ({ refName: b.refName, branchName: b.branchName, sha: b.sha })),
  };

  writeAndFsyncJson(journalPath, pendingJournalData);

  if (hooks.beforeTransaction) {
    hooks.beforeTransaction();
  }

  try {
    assertArtifactState(captureResult, capturedArtifacts);

    const freshReport = reportRetirement({ ...options, repo, now });
    if (freshReport.missingEvidence.length > 0) {
      throw new Error(`Missing evidence immediately before transaction: ${freshReport.missingEvidence.join("; ")}`);
    }
    if (freshReport.evidenceSha256 !== report.evidenceSha256) {
      throw new Error("Profile, ownership, active branch, reflog, or source ref evidence changed before transaction; aborting");
    }

    const currentWtInfo = getWorktreeInfo(repo);
    if (currentWtInfo.worktreeRawBytes !== report.worktreeRawBytes) {
      throw new Error("Worktree registrations changed immediately before transaction; aborting");
    }

    const stateSigAfter = captureRepoStateSignature(repo);
    if (stateSigAfter.head !== stateSigBefore.head) {
      throw new Error(`Repo HEAD changed before transaction: was ${stateSigBefore.head}, now ${stateSigAfter.head}`);
    }
    if (stateSigAfter.branch !== stateSigBefore.branch) {
      throw new Error(`Repo branch changed before transaction: was ${stateSigBefore.branch}, now ${stateSigAfter.branch}`);
    }
    if (stateSigAfter.indexSha !== stateSigBefore.indexSha) {
      throw new Error("Repo raw index changed before transaction");
    }
    if (stateSigAfter.status !== stateSigBefore.status) {
      throw new Error("Repo status / staged entries changed before transaction");
    }
    if (stateSigAfter.refs !== stateSigBefore.refs) {
      throw new Error("Source refs or symbolic targets changed before transaction; aborting");
    }

    const freshRepoInfo = preservation.inspectRepository(repo);
    if (freshRepoInfo.entries.length > 0 || freshRepoInfo.operations.length > 0) {
      throw new Error("Repository became dirty or entered an active Git operation before transaction; aborting");
    }

    const currentBaseSha = git(repo, ["rev-parse", "--verify", report.base]);
    if (currentBaseSha !== report.baseSha) {
      throw new Error(`Base ref ${report.base} moved from ${report.baseSha} to ${currentBaseSha} before transaction; aborting`);
    }

    for (const cand of report.eligible) {
      const currentSha = git(repo, ["rev-parse", "--verify", cand.refName]);
      if (currentSha !== cand.sha) {
        throw new Error(`Candidate branch ${cand.refName} moved from ${cand.sha} to ${currentSha} before transaction; aborting`);
      }
      if (cand.retirementReason === "protected-duplicate") {
        const currentRefs = git(repo, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)%00", "refs/heads"])
          .split("\0")
          .reduce((rows, value, index, fields) => {
            if (index % 3 === 0 && value.replace(/^\n+/, "")) rows.push({ refName: value.replace(/^\n+/, ""), sha: fields[index + 1], symref: fields[index + 2] });
            return rows;
          }, []);
        const duplicate = findProtectedDuplicate(currentRefs, cand, report.evidence.protectedBranches);
        if (!duplicate || duplicate.refName !== cand.protectedDuplicateOf) {
          throw new Error(`Candidate branch ${cand.refName} no longer has its exact protected duplicate ${cand.protectedDuplicateOf}; aborting`);
        }
      } else if (!isExactAncestor(repo, cand.refName, report.base)) {
        throw new Error(`Candidate branch ${cand.refName} is no longer an exact ancestor of ${report.base}; aborting`);
      }
    }

    const updateRefLines = ["start", `verify ${report.base} ${report.baseSha}`];
    const recoveryRefsCreated = [];
    const branchesToDelete = [];

    for (const cand of report.eligible) {
      const recoveryRef = `refs/allsorted/recovery/${runId}/${cand.branchName}`;
      updateRefLines.push(`create ${recoveryRef} ${cand.sha}`);
      updateRefLines.push(`delete ${cand.refName} ${cand.sha}`);
      recoveryRefsCreated.push({ refName: recoveryRef, branchName: cand.branchName, sha: cand.sha });
      branchesToDelete.push(cand);
    }
    updateRefLines.push("commit");

    const inputPayload = updateRefLines.join("\n") + "\n";

    execFileSync("git", ["--no-optional-locks", "-C", repo, "update-ref", "--no-deref", "--stdin"], {
      input: inputPayload,
      stdio: ["pipe", "pipe", "pipe"],
    });

    for (const cand of branchesToDelete) {
      const deletedSha = optionalGit(repo, ["rev-parse", "--verify", cand.refName]);
      if (deletedSha) {
        throw new Error(`Readback verification failed: branch ${cand.refName} still exists after transaction!`);
      }
      const recoveryRef = `refs/allsorted/recovery/${runId}/${cand.branchName}`;
      const recSha = git(repo, ["rev-parse", "--verify", recoveryRef]);
      if (recSha !== cand.sha) {
        throw new Error(`Readback verification failed: recovery ref ${recoveryRef} expected ${cand.sha}, got ${recSha}`);
      }
    }

    const completedJournalData = {
      ...pendingJournalData,
      status: "completed",
      completedAt: new Date().toISOString(),
      retiredBranches: branchesToDelete.map(b => ({ refName: b.refName, branchName: b.branchName, sha: b.sha })),
      recoveryRefs: recoveryRefsCreated,
      preservedConfigs: branchesToDelete.map(b => `branch.${b.branchName}`),
    };

    writeAndFsyncJson(journalPath, completedJournalData);

    return {
      taskClass: "maintenance",
      mode: "branch-retirement-apply",
      status: "ok",
      repo,
      base: report.base,
      backupDir,
      retired: branchesToDelete.map(b => b.branchName),
      journal: journalPath,
      report,
    };
  } catch (err) {
    const failedJournalData = {
      ...pendingJournalData,
      status: "failed",
      failedAt: new Date().toISOString(),
      error: err.message,
    };
    try {
      writeAndFsyncJson(journalPath, failedJournalData);
    } catch {}
    throw err;
  }
}

function resolveQueueFile(queueFile) {
  if (queueFile !== undefined) {
    if (typeof queueFile !== "string" || !path.isAbsolute(queueFile)) {
      throw new Error("queueFile must be an absolute path");
    }
    return path.resolve(queueFile);
  }
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) throw new Error("queueFile is required when the home directory is unavailable");
  return path.join(home, ".local", "state", "allsorted", "git-manager", "retirement-plans.json");
}

function readRetirementQueue(queueFile) {
  if (!fs.existsSync(queueFile)) return { version: 1, plans: [] };
  let queue;
  try {
    queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
  } catch (err) {
    throw new Error(`Retirement queue at ${queueFile} is unreadable: ${err.message}`);
  }
  if (!queue || queue.version !== 1 || !Array.isArray(queue.plans)) {
    throw new Error(`Retirement queue at ${queueFile} has an unsupported schema`);
  }
  return queue;
}

function writeRetirementQueue(queueFile, queue) {
  fs.mkdirSync(path.dirname(queueFile), { recursive: true, mode: 0o700 });
  const temp = `${queueFile}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  writeAndFsyncJson(temp, queue);
  fs.renameSync(temp, queueFile);
  const directory = fs.openSync(path.dirname(queueFile), "r");
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

function withRetirementQueueLock(queueFile, callback) {
  fs.mkdirSync(path.dirname(queueFile), { recursive: true, mode: 0o700 });
  const lockFile = `${queueFile}.lock`;
  let lock;
  try {
    lock = fs.openSync(lockFile, "wx", 0o600);
  } catch (err) {
    if (err.code === "EEXIST") throw new Error(`Retirement queue is already in use: ${lockFile}`);
    throw err;
  }
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
    fs.fsyncSync(lock);
    return callback();
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockFile);
  }
}

function assertQueueLocation(queueFile, repo) {
  const gitCommonDir = optionalGit(repo, ["rev-parse", "--git-common-dir"]) || optionalGit(repo, ["rev-parse", "--absolute-git-dir"]);
  const { worktreeRoots } = getWorktreeInfo(repo);
  assertBackupContainment(path.dirname(queueFile), repo, gitCommonDir, worktreeRoots);
}

function validateQueuedPlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("Plan is not an object");
  if (typeof plan.id !== "string" || plan.id.length === 0) throw new Error("Plan id is missing");
  const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const createdAt = Date.parse(plan.createdAt);
  const expiresAt = Date.parse(plan.expiresAt);
  if (!isoTime.test(plan.createdAt) || !isoTime.test(plan.expiresAt) || !Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt) {
    throw new Error("Plan timestamps are invalid");
  }
  for (const field of ["repo", "base", "baseSha", "backupDir"]) {
    if (typeof plan[field] !== "string" || plan[field].length === 0) throw new Error(`Plan ${field} is missing`);
  }
  if (!/^[a-f0-9]{40,64}$/i.test(plan.baseSha) || typeof plan.queuedEvidenceSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(plan.queuedEvidenceSha256)) {
    throw new Error("Plan SHA evidence is invalid");
  }
  if (!path.isAbsolute(plan.repo) || !path.isAbsolute(plan.backupDir)) throw new Error("Plan paths must be absolute");
  if (plan.profilePath !== null && (typeof plan.profilePath !== "string" || !path.isAbsolute(plan.profilePath))) {
    throw new Error("Plan profilePath must be null or an absolute path");
  }
  if (plan.profileSha256 !== null && (typeof plan.profileSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(plan.profileSha256))) {
    throw new Error("Plan profileSha256 is invalid");
  }
  if (plan.ownershipReviewed !== true) throw new Error("Plan lacks recorded ownership review");
  if (!Number.isFinite(plan.minAgeDays) || plan.minAgeDays < 0 || typeof plan.retireProtectedDuplicates !== "boolean") {
    throw new Error("Plan retirement options are invalid");
  }
  if (!Array.isArray(plan.candidates) || plan.candidates.length === 0) throw new Error("Plan has no candidates");
  for (const candidate of plan.candidates) {
    if (!candidate || typeof candidate !== "object" || typeof candidate.refName !== "string" || typeof candidate.branchName !== "string" || !/^[a-f0-9]{40,64}$/i.test(candidate.sha)) {
      throw new Error("Plan candidate evidence is invalid");
    }
  }
}

function queueRetirement(options = {}) {
  if (options.ownershipReviewed !== true) {
    throw new Error("ownershipReviewed flag must be true to queue branch retirement");
  }
  if (!options.backupDir || typeof options.backupDir !== "string" || !path.isAbsolute(options.backupDir)) {
    throw new Error("backupDir must be an absolute path to queue branch retirement");
  }
  const report = reportRetirement(options);
  const queueFile = resolveQueueFile(options.queueFile);
  assertQueueLocation(queueFile, report.repo);
  assertQueueLocation(path.resolve(options.backupDir, "retirement-queue-placeholder.json"), report.repo);
  const nonDeferredEvidence = report.missingEvidence.filter(reason => !reason.startsWith("Active work or writer detector protection:"));
  if (nonDeferredEvidence.length > 0) {
    throw new Error(`Cannot queue branch retirement due to missing evidence: ${nonDeferredEvidence.join("; ")}`);
  }
  if (report.eligible.length === 0) {
    throw new Error("No eligible branches are available to queue");
  }
  const now = options.now ?? Date.now();
  const expiryDays = options.expiryDays === undefined ? 30 : Number(options.expiryDays);
  if (!Number.isFinite(expiryDays) || expiryDays <= 0) throw new Error("expiryDays must be a positive finite number");
  const plan = {
    id: `${now}-${crypto.randomBytes(4).toString("hex")}`,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + expiryDays * 24 * 60 * 60 * 1000).toISOString(),
    status: "queued",
    repo: report.repo,
    base: report.base,
    baseSha: report.baseSha,
    backupDir: path.resolve(options.backupDir),
    profilePath: report.evidence.profilePath,
    profileSha256: report.evidence.profileSha256,
    ownershipReviewed: true,
    minAgeDays: report.minAgeDays,
    retireProtectedDuplicates: report.retireProtectedDuplicates,
    candidates: report.eligible.map(row => ({ refName: row.refName, branchName: row.branchName, sha: row.sha, retirementReason: row.retirementReason })),
    queuedEvidenceSha256: report.evidenceSha256,
    queuedWhileBlocked: report.status === "blocked" ? report.missingEvidence : [],
  };
  return withRetirementQueueLock(queueFile, () => {
    const queue = readRetirementQueue(queueFile);
    queue.plans.push(plan);
    writeRetirementQueue(queueFile, queue);
    return { taskClass: "maintenance", mode: "branch-retirement-queue", status: "queued", queueFile, plan, report };
  });
}

function drainRetirementQueue(options = {}) {
  const queueFile = resolveQueueFile(options.queueFile);
  return withRetirementQueueLock(queueFile, () => {
    const queue = readRetirementQueue(queueFile);
    const now = options.now ?? Date.now();
    const applied = [];
    const blocked = [];

    for (const plan of queue.plans) {
    if (plan.status !== "queued" && plan.status !== "blocked") continue;
    try {
      validateQueuedPlan(plan);
      assertQueueLocation(queueFile, plan.repo);
      if (Date.parse(plan.expiresAt) <= now) {
        plan.status = "expired";
        plan.expiredAt = new Date(now).toISOString();
        blocked.push({ id: plan.id, error: "Plan expired without mutation" });
        continue;
      }
      const profileDocument = loadProfileDocument(plan.profilePath || undefined);
      if (profileDocument.path !== plan.profilePath || profileDocument.sha256 !== plan.profileSha256) {
        throw new Error("Profile evidence changed since the plan was reviewed");
      }
      const currentBaseSha = git(plan.repo, ["rev-parse", "--verify", plan.base]);
      if (currentBaseSha !== plan.baseSha) throw new Error("Base ref changed since the plan was reviewed");
      const branches = plan.candidates.map(candidate => candidate.branchName);
      const fresh = reportRetirement({
        repo: plan.repo,
        base: plan.base,
        profilePath: plan.profilePath || undefined,
        ownershipReviewed: true,
        minAgeDays: plan.minAgeDays,
        retireProtectedDuplicates: plan.retireProtectedDuplicates,
        branches,
        inspectActiveWork: options.inspectActiveWork,
        now,
      });
      if (fresh.missingEvidence.length > 0) throw new Error(fresh.missingEvidence.join("; "));
      const freshCandidates = new Map(fresh.eligible.map(candidate => [candidate.refName, candidate.sha]));
      for (const candidate of plan.candidates) {
        if (freshCandidates.get(candidate.refName) !== candidate.sha) {
          throw new Error(`Candidate ${candidate.refName} is no longer eligible at its reviewed SHA`);
        }
      }
      const result = applyRetirement({
        repo: plan.repo,
        base: plan.base,
        profilePath: plan.profilePath || undefined,
        ownershipReviewed: true,
        minAgeDays: plan.minAgeDays,
        retireProtectedDuplicates: plan.retireProtectedDuplicates,
        branches,
        backupDir: plan.backupDir,
        inspectActiveWork: options.inspectActiveWork,
        now,
      });
      plan.status = "applied";
      plan.appliedAt = new Date(now).toISOString();
      plan.result = { retired: result.retired, journal: result.journal || null };
      delete plan.lastError;
      applied.push({ id: plan.id, ...plan.result });
    } catch (err) {
      plan.status = /Plan |no longer eligible|changed since the plan was reviewed/.test(err.message) ? "rejected" : "blocked";
      plan.lastAttemptAt = new Date(now).toISOString();
      plan.lastError = err.message;
      blocked.push({ id: plan.id, error: err.message });
    }
    }
    writeRetirementQueue(queueFile, queue);
    return { taskClass: "maintenance", mode: "branch-retirement-queue-drain", status: blocked.length ? "blocked" : "ok", queueFile, applied, blocked };
  });
}

module.exports = {
  reportRetirement,
  applyRetirement,
  queueRetirement,
  drainRetirementQueue,
  isProtected,
  getRefAge,
  resolveBaseRef,
  isExactAncestor,
  assertBackupContainment,
  loadProfile,
};
