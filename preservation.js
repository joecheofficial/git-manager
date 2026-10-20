"use strict";
// Explicit, local preservation. This module never commits, moves source refs,
// resets an index, runs hooks, pushes, sends messages, or prunes objects.
const fs = require("./volume-probe").guardFs(require("node:fs"));
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
function decodeUtf8(buf) {
  if (typeof buf === "string") return buf;
  return utf8Decoder.decode(buf);
}

function git(repo, args) {
  const buf = execFileSync("git", ["--no-optional-locks", "--literal-pathspecs", "-C", repo, ...args], {
    maxBuffer: 128 * 1024 * 1024, timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return decodeUtf8(buf);
}
function optionalGit(repo, args) {
  try { return git(repo, args).trim(); } catch { return null; }
}
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function fileHash(file) {
  const h = crypto.createHash("sha256"); const fd = fs.openSync(file, "r");
  try {
    const chunk = Buffer.alloc(1024 * 1024); let count;
    while ((count = fs.readSync(fd, chunk, 0, chunk.length, null))) h.update(chunk.subarray(0, count));
    return h.digest("hex");
  } finally { fs.closeSync(fd); }
}
function entriesFromStatus(raw) {
  const records = raw.split("\0"); const entries = [];
  for (let i = 0; i < records.length && records[i]; i++) {
    const status = records[i].slice(0, 2); const entry = { status, path: records[i].slice(3) };
    if (/[RC]/.test(status)) entry.originalPath = records[++i];
    entries.push(entry);
  }
  return entries;
}
function inspectRepository(input) {
  const repo = fs.realpathSync(input);
  const root = fs.realpathSync(git(repo, ["rev-parse", "--show-toplevel"]).trim());
  if (repo !== root) throw new Error("Expected a repository root, not a subdirectory");
  const status = git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]);
  const common = git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  const gitDir = git(repo, ["rev-parse", "--absolute-git-dir"]).trim();
  const operations = ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply", "index.lock"]
    .filter(name => fs.existsSync(path.join(gitDir, name)));
  const refs = git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]).trim().split("\n").filter(Boolean);
  return { path: repo, common, gitDir, head: optionalGit(repo, ["rev-parse", "--verify", "HEAD"]),
    branch: optionalGit(repo, ["symbolic-ref", "-q", "HEAD"]), entries: entriesFromStatus(status), operations, refs,
    stash: optionalGit(repo, ["rev-parse", "--verify", "refs/stash"]),
    upstream: optionalGit(repo, ["rev-parse", "--abbrev-ref", "@{upstream}"]), status };
}
function inventoryRepositories(roots) {
  if (!Array.isArray(roots) || !roots.length || roots.some(p => typeof p !== "string" || !p)) throw new Error("Explicit repository roots are required");
  const queue = [...roots]; const seen = new Set(); const commonSeen = new Set(); const repositories = []; const errors = [];
  while (queue.length) {
    const input = queue.shift(); let key;
    try {
      key = fs.realpathSync(input); if (seen.has(key)) continue; seen.add(key);
      const row = inspectRepository(key); repositories.push(row);
      if (!commonSeen.has(row.common)) {
        commonSeen.add(row.common);
        const records = git(key, ["worktree", "list", "--porcelain", "-z"]).split("\0");
        for (const record of records) if (record.startsWith("worktree ")) queue.push(record.slice(9));
      }
      for (const entry of row.entries) {
        const child = path.join(key, entry.path);
        if (fs.existsSync(path.join(child, ".git"))) queue.push(child);
      }
      const stagedIndex = optionalGit(key, ["ls-files", "--stage", "-z"]);
      if (stagedIndex) {
        for (const record of stagedIndex.split("\0")) {
          if (record.startsWith("160000 ")) {
            const tab = record.indexOf("\t");
            if (tab !== -1) {
              const gitlinkPath = record.slice(tab + 1);
              const child = path.join(key, gitlinkPath);
              if (fs.existsSync(path.join(child, ".git"))) queue.push(child);
            }
          }
        }
      }
    } catch (error) { errors.push({ path: input, message: error.message.split("\n")[0] }); }
  }
  return { taskClass: "maintenance", mode: "cleanup-inventory", repositories, errors,
    clean: !errors.length && repositories.every(r => !r.entries.length && !r.operations.length) };
}
function describeFile(root, relative) {
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep)) throw new Error("Path escapes repository");
  let st; try { st = fs.lstatSync(file); } catch (error) {
    if (error.code === "ENOENT") return { path: relative, kind: "missing" };
    throw error;
  }
  const result = { path: relative, mode: st.mode & 0o777, bytes: st.size };
  if (st.isSymbolicLink()) return { ...result, kind: "symlink", target: decodeUtf8(fs.readlinkSync(file, { encoding: "buffer" })) };
  if (st.isDirectory()) return { ...result, kind: "directory", requiresSeparateCapture: true };
  if (!st.isFile()) throw new Error("Unsupported file type: " + relative);
  return { ...result, kind: "file", sha256: fileHash(file) };
}
function getWorktreeHeads(repo) {
  return optionalGit(repo, ["worktree", "list", "--porcelain"]) || "";
}
function getReflogHashes(commonDir) {
  const hashes = [],
    roots = [path.join(commonDir, "logs")];
  const worktreesDir = path.join(commonDir, "worktrees");
  try {
    for (const item of fs.readdirSync(worktreesDir, { withFileTypes: true }))
      if (item.isDirectory()) roots.push(path.join(worktreesDir, item.name, "logs"));
  } catch {}
  const walk = (current) => {
    let items;
    try { items = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      const itemPath = path.join(current, item.name);
      if (item.isDirectory()) walk(itemPath);
      else if (item.isFile())
        hashes.push(`${path.relative(commonDir, itemPath)}:${fileHash(itemPath)}`);
    }
  };
  for (const root of roots) walk(root);
  hashes.sort();
  return hashes;
}
function sourceState(repo) {
  const row = inspectRepository(repo);
  const indexPath = path.join(row.gitDir, "index");
  const index = fs.existsSync(indexPath) ? fs.readFileSync(indexPath) : null;
  const stagedIndex = git(repo, ["ls-files", "--stage", "-z"]);
  const worktreeHeads = getWorktreeHeads(repo);
  const reflogHashes = getReflogHashes(row.common);
  // `token` is intentionally local to this worktree. Shared refs and other
  // worktree reflogs can change during unrelated maintenance; treating that as
  // a source-file race falsely invalidates an otherwise exact capture.
  const token = hash(JSON.stringify([row.head, row.branch, row.status, index && hash(index), stagedIndex]));
  const sharedToken = hash(JSON.stringify([row.refs, worktreeHeads, reflogHashes]));
  return { row, index, stagedIndex, worktreeHeads, reflogHashes, token, sharedToken };
}
function materializeCachedArtifact(cache, key, destination, create, artifactDirectory = null) {
  const cached = cache instanceof Map ? cache.get(key) : null;
  if (cached && fs.existsSync(cached.path)) {
    if (artifactDirectory)
      return { path: cached.path, sha256: cached.sha256, deduplicated: true };
    if (fileHash(cached.path) !== cached.sha256)
      throw new Error("Cached artifact verification mismatch");
    fs.copyFileSync(
      cached.path,
      destination,
      fs.constants.COPYFILE_FICLONE || fs.constants.COPYFILE_EXCL,
    );
    if (fileHash(destination) !== cached.sha256)
      throw new Error("Cached artifact copy verification mismatch");
    fs.chmodSync(destination, 0o400);
    return { path: destination, sha256: cached.sha256, deduplicated: true };
  }
  const target = artifactDirectory
    ? path.join(artifactDirectory, `${hash(key)}-${path.basename(destination)}`)
    : destination;
  create(target);
  const sha256 = fileHash(target);
  fs.chmodSync(target, 0o400);
  if (cache instanceof Map) cache.set(key, { path: target, sha256 });
  return { path: target, sha256, deduplicated: false };
}
function hasAlternates(row) {
  const checkFile = (dir) => {
    if (!dir) return false;
    const altFile = path.join(dir, "objects", "info", "alternates");
    try {
      if (fs.existsSync(altFile)) {
        const content = fs.readFileSync(altFile, "utf8").trim();
        if (content.length > 0) return true;
      }
    } catch {}
    return false;
  };
  if (checkFile(row.gitDir) || checkFile(row.common)) return true;
  if (process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES && process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES.trim().length > 0) return true;
  if (process.env.GIT_OBJECT_DIRECTORY && process.env.GIT_OBJECT_DIRECTORY.trim().length > 0) return true;
  return false;
}
function captureRepository(input, directory, options = {}) {
  const before = sourceState(input); const repo = before.row.path;
  directory = path.resolve(directory);
  // Resolve existing ancestors so symlinked backup destinations cannot lead into the source.
  const parent = fs.realpathSync(path.dirname(directory));
  directory = path.join(parent, path.basename(directory));
  for (const protectedRoot of [repo, before.row.common]) {
    if (directory === protectedRoot || directory.startsWith(protectedRoot + path.sep)) throw new Error("Backup must be outside repository and Git metadata");
  }
  fs.mkdirSync(directory, { mode: 0o700 });
  const result = { taskClass: "maintenance", directory, repo, head: before.row.head, branch: before.row.branch,
    sourceToken: before.token,
    artifactRoot: options.artifactDirectory ? fs.realpathSync(options.artifactDirectory) : null,
    sharedStateToken: before.sharedToken,
    complete: false, files: [], staged: [], issues: [], ignoredFiles: "untouched, outside this changed-file capture" };
  const save = (name, bytes) => fs.writeFileSync(path.join(directory, name), bytes, { mode: 0o600 });
  try {
    if (hasAlternates(before.row)) {
      result.issues.push("Nonempty alternate object stores or environment dependency detected");
    }
    save("status.z", before.row.status); save("index-entries.z", before.stagedIndex);
    save("refs.json", JSON.stringify(before.row.refs));
    if (before.index) save("index", before.index);
    save("staged.patch", git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--cached", "--binary"]));
    save("unstaged.patch", git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--binary"]));
    const paths = new Set();
    for (const entry of before.row.entries) { paths.add(entry.path); if (entry.originalPath) paths.add(entry.originalPath); }
    for (const args of [["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z"], ["diff", "--no-ext-diff", "--no-textconv", "--cached", "--name-only", "-z"]]) {
      for (const name of git(repo, args).split("\0").filter(Boolean)) paths.add(name);
    }
    for (const relative of paths) {
      const info = describeFile(repo, relative); result.files.push(info);
      const destination = path.join(directory, "files", relative);
      if (info.kind === "file" || info.kind === "symlink") {
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        if (info.kind === "symlink") fs.symlinkSync(info.target, destination);
        else { fs.copyFileSync(path.join(repo, relative), destination, fs.constants.COPYFILE_EXCL); fs.chmodSync(destination, info.mode); }
        const copied = describeFile(path.join(directory, "files"), relative);
        if (JSON.stringify(copied) !== JSON.stringify(info)) throw new Error("Backup verification mismatch: " + relative);
      } else if (info.kind === "directory") result.issues.push("Separate repository capture required: " + relative);
    }
    fs.mkdirSync(path.join(directory, "staged-blobs"), { mode: 0o700 });
    for (const record of before.stagedIndex.split("\0").filter(Boolean)) {
      const tab = record.indexOf("\t"); const relative = record.slice(tab + 1);
      if (!paths.has(relative)) continue;
      const [mode, oid, stage] = record.slice(0, tab).split(" ");
      result.staged.push({ path: relative, mode, oid, stage: Number(stage) });
      if (mode === "160000" || /^0+$/.test(oid)) continue;
      const destination = path.join(directory, "staged-blobs", oid);
      if (!fs.existsSync(destination)) {
        const bytes = execFileSync("git", ["-C", repo, "cat-file", "blob", oid], { maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
        fs.writeFileSync(destination, bytes, { mode: 0o600 });
        const actualBuf = execFileSync("git", ["-C", repo, "hash-object", destination], { stdio: ["ignore", "pipe", "pipe"] });
        const actual = decodeUtf8(actualBuf).trim();
        if (actual !== oid) throw new Error("Staged blob verification mismatch");
      }
    }
    const sharedState = hash(JSON.stringify([
      before.row.common,
      before.row.refs,
      before.worktreeHeads,
      before.reflogHashes,
    ]));
    const archiveDestination = path.join(directory, "git-metadata.tar");
    const createMetadataArchive = destination => execFileSync(
        "tar",
        ["--exclude=./objects", "-cf", destination, "-C", before.row.common, "."],
        { timeout: 300000, stdio: ["ignore", "pipe", "pipe"] },
      );
    const archiveArtifact = options.artifactDirectory
      ? materializeCachedArtifact(
          options.metadataCache,
          `metadata:${options.commonSnapshotKey || `${sharedState}:${before.token}`}`,
          archiveDestination,
          createMetadataArchive,
          options.artifactDirectory,
        )
      : (() => {
          createMetadataArchive(archiveDestination);
          const sha256 = fileHash(archiveDestination);
          fs.chmodSync(archiveDestination, 0o400);
          return { path: archiveDestination, sha256, deduplicated: false };
        })();
    const archive = archiveArtifact.path;
    if (!archiveArtifact.deduplicated)
      execFileSync("tar", ["-tf", archive], { timeout: 300000, stdio: "ignore" });
    const metadata = {
      archive,
      sha256: archiveArtifact.sha256,
      archiveDeduplicated: archiveArtifact.deduplicated,
    };
    const objectArchive = path.join(directory, "git-objects.tar");
    const objectArtifact = materializeCachedArtifact(
      options.metadataCache,
      `objects:${sharedState}`,
      objectArchive,
      destination => execFileSync(
        "tar",
        ["-cf", destination, "-C", before.row.common, "objects"],
        { timeout: 300000, stdio: ["ignore", "pipe", "pipe"] },
      ),
      options.artifactDirectory,
    );
    metadata.objectArchive = objectArtifact.path;
    if (!objectArtifact.deduplicated)
      execFileSync("tar", ["-tf", metadata.objectArchive], { timeout: 300000, stdio: "ignore" });
    metadata.objectArchiveSha256 = objectArtifact.sha256;
    metadata.objectArchiveDeduplicated = objectArtifact.deduplicated;
    metadata.objectRecovery = "verified object archive, history bundle and staged-blobs";
    if (before.row.head) {
      const bundle = path.join(directory, "history.bundle");
      const headIsReferenced = Boolean(
        optionalGit(repo, [
          "for-each-ref",
          "--contains",
          before.row.head,
          "--format=%(refname)",
        ]),
      );
      const extraTips = headIsReferenced ? [] : ["HEAD"];
      const bundleArtifact = materializeCachedArtifact(
        options.metadataCache,
        `bundle:${sharedState}:${headIsReferenced ? "all-refs" : before.row.head}`,
        bundle,
        destination => git(repo, ["bundle", "create", destination, "--all", ...extraTips]),
        options.artifactDirectory,
      );
      if (!bundleArtifact.deduplicated)
        git(repo, ["bundle", "verify", bundleArtifact.path]);
      metadata.bundle = bundleArtifact.path;
      metadata.bundleSha256 = bundleArtifact.sha256;
      metadata.bundleDeduplicated = bundleArtifact.deduplicated;
    }
    result.metadata = metadata;
    if (options.beforeVerify) options.beforeVerify();
    const after = sourceState(repo);
    if (after.token !== before.token) result.issues.push("Source HEAD, branch, status or index changed during capture");
    for (const info of result.files) {
      if (JSON.stringify(describeFile(repo, info.path)) !== JSON.stringify(info)) result.issues.push("Source file changed during capture: " + info.path);
    }
    result.complete = result.issues.length === 0;
  } catch (error) { result.issues.push(error.message.split("\n")[0]); }
  save("manifest.json", JSON.stringify(result, null, 2));
  return result;
}
function verifyCaptureArtifacts(capture, verifiedArtifacts = null) {
  const issues = [];
  const verify = (label, file, expected) => {
    try {
      const resolved = fs.realpathSync(file);
      const allowedRoots = [fs.realpathSync(capture.directory)];
      if (capture.artifactRoot) allowedRoots.push(fs.realpathSync(capture.artifactRoot));
      if (!allowedRoots.some(root => resolved.startsWith(root + path.sep)))
        throw new Error("path escapes capture directory");
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error("not a regular file");
      let actual;
      if (verifiedArtifacts instanceof Map && verifiedArtifacts.has(resolved))
        actual = verifiedArtifacts.get(resolved);
      else {
        actual = fileHash(file);
        if (verifiedArtifacts instanceof Map) verifiedArtifacts.set(resolved, actual);
      }
      if (actual !== expected) throw new Error("hash mismatch");
    } catch (error) {
      issues.push(`${label} verification failed: ${error.message}`);
    }
  };
  verify("metadata archive", capture.metadata?.archive, capture.metadata?.sha256);
  verify(
    "Git object archive",
    capture.metadata?.objectArchive,
    capture.metadata?.objectArchiveSha256,
  );
  if (capture.metadata?.bundle)
    verify("history bundle", capture.metadata.bundle, capture.metadata.bundleSha256);
  return issues;
}
function verifyCaptureSource(capture) {
  const issues = [];
  try {
    const current = sourceState(capture.repo);
    if (current.token !== capture.sourceToken)
      issues.push("Source HEAD, branch, status or index changed after capture");
    for (const info of capture.files || [])
      if (JSON.stringify(describeFile(capture.repo, info.path)) !== JSON.stringify(info))
        issues.push(`Source file changed after capture: ${info.path}`);
  } catch (error) {
    issues.push(`Source revalidation failed: ${error.message}`);
  }
  return issues;
}
function sourceFingerprint(repo) {
  return sourceState(repo).token;
}
function sourceBaseline(repo) {
  const state = sourceState(repo);
  return { token: state.token, row: state.row };
}
module.exports = { inventoryRepositories, inspectRepository, captureRepository, verifyCaptureArtifacts, verifyCaptureSource, sourceFingerprint, sourceBaseline, entriesFromStatus };
