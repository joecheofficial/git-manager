"use strict";
// Scope changes are reservations only. They never edit, merge or remove source.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const checkin = require("./checkin");
const programs = require("./program-boundaries");
const refuse = reasons => ({ ok: false, refused: true, reasons: Array.isArray(reasons) ? reasons : [reasons] });
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const within = (file, root) => file === root || file.startsWith(root + path.sep);
function accessMetadata(file) {
  const stat = fs.statSync(file), options = { encoding: "utf8", stdio: "pipe", timeout: 20000 };
  let acl;
  if (process.platform === "darwin") {
    acl = execFileSync("ls", ["-lde", file], options).split("\n").filter(line => /^\s*\d+:/.test(line)).join("\n");
  } else if (process.platform === "win32") {
    acl = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; (Get-Acl -LiteralPath $env:GIT_MANAGER_SCOPE_SOURCE).Sddl"], { ...options, env: { ...process.env, GIT_MANAGER_SCOPE_SOURCE: file } }).trim();
  } else {
    // Refuse if ACL inspection is unavailable rather than guessing shared access.
    acl = execFileSync("getfacl", ["-cp", "--", file], options).trim();
  }
  return { mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid, acl };
}
function git(repo, args) {
  return execFileSync("git", ["--no-optional-locks", "-C", repo, ...args], { encoding: null, stdio: "pipe", timeout: 20000, maxBuffer: 16 * 1024 ** 2 });
}
function ownerIdentity() {
  const user = os.userInfo().username;
  // Host thread ID is stable across Codex sidecars; their worker session ID can differ.
  const session = process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_CODE_HOST_SESSION_ID;
  if (!session || session.startsWith("anon-")) throw Error("scope amendment requires the owning host session identity");
  return { actor: checkin.actor(process.env), session, account: user, uid: process.getuid?.() ?? null };
}
function normalize(repo, input) {
  const values = Array.isArray(input) ? input : typeof input === "string" ? input.split(",") : [];
  if (!values.length || values.some(value => typeof value !== "string" || !value || /[\0*?\n\r]/.test(value))) throw Error("scope amendment requires concrete paths without globs");
  const paths = [...new Set(values.map(value => path.relative(repo, path.resolve(repo, value))))];
  if (paths.some(value => !value || value === ".." || value.startsWith("../") || value === ".git" || value.startsWith(".git/"))) throw Error("scope amendment paths must be concrete and inside the repository");
  return paths;
}
function strictNarrowing(previous, roots) {
  const concrete = values => Array.isArray(values) && values.length > 0 && values.every(value => typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !/[\\\\\0*?\[\]\n\r]/.test(value) && value.split("/").every(part => part && part !== "." && part !== "..") && value !== ".git" && !value.startsWith(".git/"));
  return concrete(previous) && concrete(roots)
    && roots.every(root => previous.some(old => within(root, old)))
    && previous.some(old => !roots.some(root => within(old, root)));
}
function physicalScope(worktree, roots) {
  const realRoot = fs.realpathSync(worktree);
  for (const root of roots) {
    let ancestor = path.join(worktree, root); const suffix = [];
    while (true) {
      try { fs.lstatSync(ancestor); break; }
      catch (error) { if (error.code !== "ENOENT") throw error; suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
    }
    const actual = path.join(fs.realpathSync(ancestor), ...suffix);
    if (!within(actual, realRoot) || path.relative(realRoot, actual) !== root) throw Error(`unsafe symlink or path alias in scope: ${root}`);
  }
}
function snapshot(claim) {
  const repo = claim.worktree;
  if (checkin.resolveRepo(repo).primary !== fs.realpathSync(claim.repo)) throw Error("claimed worktree repository identity changed");
  const text = args => git(repo, args).toString("utf8").trim();
  if (text(["symbolic-ref", "HEAD"]) !== `refs/heads/${claim.branch}`) throw Error("claimed worktree branch changed");
  const head = text(["rev-parse", "HEAD"]), branchHead = text(["rev-parse", `refs/heads/${claim.branch}`]);
  if (head !== branchHead) throw Error("claim branch/head mismatch");
  const admin = text(["rev-parse", "--absolute-git-dir"]);
  for (const name of ["index.lock", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) if (fs.existsSync(path.join(admin, name))) throw Error(`claimed worktree has active ${name}`);
  const index = fs.readFileSync(path.join(admin, "index"));
  const entries = git(repo, ["ls-files", "--stage", "-z"]), status = git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const ignored = git(repo, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]);
  const targetHead = text(["rev-parse", `refs/heads/${claim.targetBranch}^{commit}`]);
  const committed = text(["rev-list", head, "--not", targetHead]).split("\n").filter(Boolean);
  if (committed.length > 1000) throw Error("committed scope inventory exceeds 1000 commits; split the checkpoint");
  // Reserve current claim contribution, independent of a possibly recovered baseSha.
  // Reverted history and merge-parent paths remain audit evidence, not reservations.
  const changed = new Set(git(repo, ["diff", "--no-renames", "--name-only", "-z", `${targetHead}...${head}`]).toString("utf8").split("\0").filter(Boolean));
  const historical = new Set();
  for (const commit of committed) for (const file of git(repo, ["diff-tree", "--no-commit-id", "--root", "-m", "-r", "--no-renames", "--name-only", "-z", commit]).toString("utf8").split("\0").filter(Boolean)) historical.add(file);
  const rows = status.toString("utf8").split("\0"), working = [];
  for (let i = 0; i < rows.length && rows[i]; i++) {
    working.push(rows[i].slice(3));
    if (/[RC]/.test(rows[i].slice(0, 2)) && rows[i + 1]) working.push(rows[++i]);
  }
  let bytes = 0; const files = [];
  for (const file of [...new Set(working)]) {
    changed.add(file); const absolute = path.join(repo, file);
    if (!within(absolute, repo)) throw Error("working path escapes worktree");
    try {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) files.push([file, "symlink", fs.readlinkSync(absolute)]);
      else if (stat.isFile()) {
        bytes += stat.size; if (bytes > 256 * 1024 ** 2) throw Error("working scope inventory exceeds 256MiB");
        files.push([file, stat.mode, hash(fs.readFileSync(absolute))]);
      } else throw Error(`cannot inventory special or nested working path: ${file}`);
    } catch (error) { if (error.code === "ENOENT") files.push([file, "missing"]); else throw error; }
  }
  const indexSha256 = hash(index);
  const evidence = { head, baseSha: claim.baseSha, targetHead, branch: claim.branch, indexSha256, indexEntriesSha256: hash(entries), statusSha256: hash(status), ignoredPathsSha256: hash(ignored), ignoredPathsCount: ignored.toString("utf8").split("\0").filter(Boolean).length, changedPaths: [...changed].sort(), historicalPaths: [...historical].sort(), workingFilesSha256: hash(JSON.stringify(files)), committedCount: committed.length };
  return { ...evidence, token: hash(JSON.stringify(evidence)) };
}
function amendScope(selector, opts = {}) {
  const cfg = programs.loadSettings(opts);
  try {
    const identity = ownerIdentity();
    if (opts.session && opts.session !== identity.session) return refuse("--session does not match actual host session");
    return checkin.withClaimsLock(`${cfg.claimsFile}.program-boundaries`, () => checkin.withClaimsLock(cfg.claimsFile, () => {
      const store = checkin.loadClaims(cfg.claimsFile), claim = store.claims.find(value => value.id === selector);
      if (!claim || !["active", "expired"].includes(claim.status) || claim.pending) return refuse("scope amendment requires an exact active or expired, nonpending claim ID");
      if (claim.actor !== identity.actor || claim.session !== identity.session) return refuse("only the actual host actor and owning session may amend this claim");
      if (identity.uid !== null && fs.statSync(claim.worktree).uid !== identity.uid) return refuse("scope amendment must run under the owning worktree OS account");
      const roots = normalize(claim.repo, opts.paths); physicalScope(claim.worktree, roots);
      const previous = claim.paths || [];
      if (claim.status === "expired" && !strictNarrowing(previous, roots)) return refuse("expired claims may only narrow a known concrete reservation");
      if (claim.status === "expired") {
        for (const other of store.claims.filter(value => value.id !== claim.id && value.repo === claim.repo && value.status === "active")) {
          const held = other.paths?.length ? other.paths : ["."];
          if (roots.some(root => held.some(old => old === "." || within(root, old) || within(old, root)))) return refuse(`expired scope narrowing overlaps active claim ${other.id}`);
        }
      }
      const scope = programs.classifyScope(claim.repo, roots, cfg);
      const previousScope = programs.classifyScope(claim.repo, previous, cfg);
      if (!scope.ok || (scope.governed && (!previousScope.ok || previousScope.program !== scope.program || (opts.program && opts.program !== scope.program)))) return refuse(scope.reasons.length ? scope.reasons : "scope amendment cannot change program lane");
      const added = previous.length ? roots.filter(root => !previous.some(old => old === "." || within(root, old))) : [];
      for (const other of store.claims.filter(value => value.id !== claim.id && value.repo === claim.repo && ["active", "expired"].includes(value.status))) {
        const held = other.paths?.length ? other.paths : ["."];
        if (added.some(root => held.some(old => old === "." || within(root, old) || within(old, root)))) return refuse(`scope expansion overlaps retained claim ${other.id}`);
      }
      const before = snapshot(claim), outside = before.changedPaths.filter(file => !roots.some(root => within(file, root)));
      if (outside.length) return refuse(`scope omits committed, staged or working paths: ${outside.join(", ")}`);
      const after = snapshot(claim);
      if (before.token !== after.token) return refuse("source/index/history changed during scope verification; retry after owner checkpoint");
      if ((claim.scopeAmendments || []).length >= 100) return refuse("scope amendment audit is full; retain and finish this claim");
      const record = { at: new Date().toISOString(), ...identity, previousPaths: previous, paths: roots, evidence: before, ignoredFiles: "reservation change preserves all files; ignored paths are recorded but never adopted or removed" };
      if (opts.dryRun) return { ok: true, dryRun: true, claim, amendment: record };
      // Claims locks exclude other lifecycle writers. No worktree, refs or index mutation.
      claim.paths = roots; if (claim.status !== "expired") claim.updatedAt = record.at; claim.scopeAmendments = [...(claim.scopeAmendments || []), record]; store.updatedAt = record.at;
      const temporaryRoot = fs.mkdtempSync(`${cfg.claimsFile}.scope-`);
      const temporary = path.join(temporaryRoot, "claims.json");
      // Preserve shared store permissions/ACL/owner through the OS metadata copy.
      try {
        const sourceAccess = accessMetadata(cfg.claimsFile);
        if (process.platform === "win32") {
          fs.copyFileSync(cfg.claimsFile, temporary, fs.constants.COPYFILE_EXCL);
          execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; Get-Acl -LiteralPath $env:GIT_MANAGER_SCOPE_SOURCE | Set-Acl -LiteralPath $env:GIT_MANAGER_SCOPE_DEST"], { stdio: "pipe", timeout: 20000, env: { ...process.env, GIT_MANAGER_SCOPE_SOURCE: cfg.claimsFile, GIT_MANAGER_SCOPE_DEST: temporary } });
        } else execFileSync("cp", ["-p", cfg.claimsFile, temporary], { stdio: "pipe", timeout: 20000 });
        fs.writeFileSync(temporary, JSON.stringify(store, null, 2) + "\n");
        if (JSON.stringify(sourceAccess) !== JSON.stringify(accessMetadata(temporary)) || JSON.stringify(sourceAccess) !== JSON.stringify(accessMetadata(cfg.claimsFile))) throw Error("cannot preserve shared claims-store access metadata after writing");
        fs.renameSync(temporary, cfg.claimsFile);
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        fs.rmdirSync(temporaryRoot);
      }
      return { ok: true, claim, amendment: record };
    }, opts), opts);
  } catch (error) { return refuse(`scope amendment held: ${error.message}`); }
}
module.exports = { amendScope };
