"use strict";

// Scoped (sparse cone) checkouts for check-in worktrees.
//
// A claim that declares concrete --paths plus --dependencies (the read-only roots
// the task needs) gets a worktree that materializes only those directories. The
// cone is resolved once against the base commit pinned at reservation and its
// manifest (mode, blob id and path of every materialized file) is recorded on the
// claim, so finish and release can prove the worktree still matches what was
// reserved and that nothing outside the claimed paths changed.
//
// Requirements: Git 2.34 or newer and extensions.worktreeConfig enabled on the
// repository, so the sparse settings live in the worktree's own config and never
// leak into the primary checkout. Anything else falls back to a full checkout with
// a stated reason.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MIN_GIT = [2, 34, 0];

const safeRelative = (value) => typeof value === "string" && value.length > 0 && !value.startsWith("-") && !value.includes("\\")
  && !/[?*[\]]/.test(value) && !value.split("/").some(part => !part || part === "." || part === "..");

function supportedVersion(version) {
  const match = /^git version (\d+)\.(\d+)\.(\d+)/.exec(version || "");
  if (!match) return false;
  const actual = [+match[1], +match[2], +match[3]];
  for (let i = 0; i < MIN_GIT.length; i++) if (actual[i] !== MIN_GIT[i]) return actual[i] > MIN_GIT[i];
  return true;
}

function enableCommand(repo) {
  return `git -C ${JSON.stringify(repo)} config extensions.worktreeConfig true`;
}

// Rows of `git ls-tree -r -l -z <commit>`.
function treeRows(tree) {
  return tree.split("\0").filter(Boolean).map(row => {
    const m = /^(\d+) (blob|commit) ([0-9a-f]+)\s+(\d+|-)\t([\s\S]+)$/.exec(row);
    if (!m) throw new Error("Unknown checkout tree entry");
    return { mode: m[1], kind: m[2], oid: m[3], bytes: m[4] === "-" ? null : Number(m[4]), path: m[5] };
  });
}

// Git cone mode materializes every file in an included directory, plus the files
// directly inside each of its parent directories (and the repository root).
function coneIncludes(file, dirs) {
  if (!file.includes("/")) return true;
  if (dirs.some(dir => file === dir || file.startsWith(`${dir}/`))) return true;
  return dirs.some(dir => {
    const parts = dir.split("/");
    for (let depth = 0; depth < parts.length; depth++) {
      const parent = parts.slice(0, depth).join("/"), prefix = parent ? `${parent}/` : "", rest = file.slice(prefix.length);
      if (file.startsWith(prefix) && !rest.includes("/")) return true;
    }
    return false;
  });
}

function manifestFor(rows, includeDirs) {
  const includedRows = rows.filter(r => r.kind === "blob" && coneIncludes(r.path, includeDirs));
  if (!includedRows.length) throw new Error("sparse checkout roots include no tracked files");
  const manifest = includedRows.map(r => `${r.mode} ${r.oid} ${r.path}`).join("\n") + "\n";
  return { manifest, manifestSha256: crypto.createHash("sha256").update(manifest).digest("hex"), includedRows };
}

function verifyManifest(tree, record) {
  const expected = manifestFor(treeRows(tree), record.includeDirs);
  return expected.manifest === record.manifest && expected.manifestSha256 === record.manifestSha256;
}

// A claimed path that does not exist yet (a new file) is materialized through its
// nearest tracked parent directory.
function trackedParent(root, rows, repo) {
  const parts = root.split("/");
  for (let depth = parts.length - 1; depth > 0; depth--) {
    const candidate = parts.slice(0, depth).join("/");
    if (!rows.some(row => row.path.startsWith(`${candidate}/`))) continue;
    try {
      const stat = fs.lstatSync(path.join(repo, candidate));
      if (stat.isSymbolicLink()) throw new Error(`sparse checkout root traverses symlink: ${root}`);
      if (stat.isDirectory()) return candidate;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return null;
}

// Returns { mode: "sparse", ... } or { mode: "full", reason }. Throws when the
// caller asked for a scoped checkout with roots that cannot be honored safely.
function resolve({ repo, claimPaths, dependencies, tree, version, worktreeConfig }) {
  const fallback = reason => ({ mode: "full", reason });
  if (dependencies === undefined) return fallback("no --dependencies declared, so the read roots are unknown");
  if (!Array.isArray(claimPaths) || !claimPaths.length || claimPaths.some(p => !safeRelative(p) || p === ".")) {
    throw new Error("sparse checkout requires concrete claimed paths (--paths) inside the repository");
  }
  if (!Array.isArray(dependencies) || !dependencies.length || dependencies.some(p => !safeRelative(p))) {
    throw new Error("dependency roots must be concrete repository-relative paths without globs");
  }
  if (!supportedVersion(version)) return fallback(`scoped checkouts need Git ${MIN_GIT.join(".")} or newer (found ${String(version || "unknown").trim()})`);
  if (!worktreeConfig) return fallback(`extensions.worktreeConfig is not enabled on this repository; enable scoped checkouts with: ${enableCommand(repo)}`);
  const roots = dependencies;
  const rows = treeRows(tree), tracked = new Set(rows.map(r => r.path)), dirs = new Set(), dependencyRoots = new Set(roots);
  for (const root of [...claimPaths, ...roots]) {
    if (!safeRelative(root)) throw new Error(`invalid sparse checkout root: ${root}`);
    const resolved = path.resolve(repo, root);
    if (!resolved.startsWith(path.resolve(repo) + path.sep)) throw new Error(`sparse checkout root escapes repository: ${root}`);
    let cursor = path.resolve(repo), treePath = "";
    for (const part of root.split("/")) {
      treePath = treePath ? `${treePath}/${part}` : part;
      if (rows.some(r => r.path === treePath && r.mode === "120000")) throw new Error(`sparse checkout root traverses tracked symlink: ${root}`);
      cursor = path.join(cursor, part);
      try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`sparse checkout root traverses symlink: ${root}`); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    if (tracked.has(root) && rows.some(r => r.path === root && r.kind !== "blob")) dirs.add(root);
    else if (tracked.has(root)) dirs.add(path.posix.dirname(root));
    else if (rows.some(r => r.path.startsWith(`${root}/`))) dirs.add(root);
    else if (!dependencyRoots.has(root)) {
      const parent = trackedParent(root, rows, repo);
      if (parent) dirs.add(parent);
      else return fallback(`new claimed path has no tracked parent directory (${root})`);
    } else throw new Error(`sparse checkout root has no tracked content: ${root}`);
  }
  const includeDirs = [...dirs].sort().filter(dir => ![...dirs].some(parent => parent !== dir && dir.startsWith(`${parent}/`)));
  if (includeDirs.includes(".")) return fallback("cone root would include the entire repository");
  const { manifest, manifestSha256, includedRows } = manifestFor(rows, includeDirs);
  return { mode: "sparse", profile: "explicit", roots: [...new Set(roots)].sort(), includeDirs, manifest, manifestSha256, includedBytes: includedRows.reduce((sum, r) => sum + (r.bytes || 0), 0), includedRows };
}

// Finish/release scope guard for a sparse claim. Returns a hold reason or null.
function guard(worktree, claim, changedPaths = [], ignoredPaths = []) {
  if (!claim.sparseCheckout || claim.sparseCheckout.mode !== "cone") return null;
  const roots = claim.sparseCheckout.includeDirs || [], owned = claim.paths || [];
  const outside = changedPaths.filter(file => !owned.some(root => file === root || file.startsWith(`${root}/`)));
  if (outside.length) return `sparse worktree changed tracked paths outside exclusive claim scope: ${outside.slice(0, 10).join(", ")}`;
  if (typeof claim.sparseCheckout.manifest !== "string" || crypto.createHash("sha256").update(claim.sparseCheckout.manifest).digest("hex") !== claim.sparseCheckout.manifestSha256) {
    return "sparse checkout claim manifest hash mismatch; retain worktree and inspect";
  }
  if (ignoredPaths.length) return `sparse worktree has ignored physical files that must be preserved: ${ignoredPaths.slice(0, 10).join(", ")}`;
  const pending = [];
  const walk = (dir, relative = "") => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!relative && entry.name === ".git") continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name, abs = path.join(dir, entry.name), st = fs.lstatSync(abs);
      if (st.isDirectory() && !st.isSymbolicLink()) walk(abs, rel);
      else if (!coneIncludes(rel, roots)) pending.push(rel);
    }
  };
  walk(worktree);
  if (pending.length) return `sparse worktree has physical files outside dependency includes: ${pending.slice(0, 10).join(", ")}`;
  return null;
}

module.exports = { resolve, treeRows, coneIncludes, manifestFor, verifyManifest, supportedVersion, safeRelative, guard, enableCommand, MIN_GIT };
