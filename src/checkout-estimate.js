"use strict";

// Per-worktree byte estimate for a checkout, used to require explicit intent
// before a large full checkout. This is an estimate of what one worktree will
// write, not a disk-capacity admission check: free space is never probed.

const BASE_BYTES = 64 * 1024 ** 2;

function addBlob(total, size) {
  return total + Math.ceil(size / 4096) * 4096 + 8192;
}

function finish(bytes) {
  bytes = Math.ceil(bytes * 1.25);
  if (!Number.isSafeInteger(bytes)) throw new Error("Checkout estimate overflow");
  return bytes;
}

// `tree` is the output of `git ls-tree -r -l -z <commit>`.
function estimate(tree) {
  let bytes = BASE_BYTES;
  for (const entry of tree.split("\0").filter(Boolean)) {
    const m = /^\d+ (blob|commit) [0-9a-f]+\s+(\d+|-)\t/.exec(entry);
    if (!m) throw new Error("Unknown checkout tree entry");
    if (m[1] === "commit") continue;
    const size = Number(m[2]);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Unknown blob size");
    bytes = addBlob(bytes, size);
  }
  return finish(bytes);
}

// `rows` are sparse-checkout treeRows already filtered to the materialized cone.
function estimateRows(rows) {
  let bytes = BASE_BYTES;
  for (const entry of rows) {
    if (!entry || entry.kind !== "blob" || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error("Unknown checkout tree entry");
    bytes = addBlob(bytes, entry.bytes);
  }
  return finish(bytes);
}

module.exports = { estimate, estimateRows };
