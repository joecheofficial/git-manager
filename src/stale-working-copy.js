"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function git(repo, args, input) {
  return execFileSync("git", ["--no-optional-locks", "--literal-pathspecs", "-C", repo, ...args], {
    encoding: "utf8", timeout: 20000, maxBuffer: 16 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"], input,
  });
}

// --stdin-paths accepts Git's C quoting, not NUL delimiters. Octal bytes also
// preserve newlines, quotes and non-ASCII filenames without splitting records.
function quotedPath(file) {
  return '"' + [...Buffer.from(file)].map(byte => "\\" + byte.toString(8).padStart(3, "0")).join("") + '"';
}

function staleWorkingCopyFindings({ repos = [], report = () => {}, now, maxFiles = 300, depth = 30 } = {}) {
  const findings = [];
  // now is accepted for the sweep interface; only commit time versus disk mtime
  // determines staleness, never the age of a file relative to this sweep.
  if (!Array.isArray(repos) || !Number.isInteger(maxFiles) || maxFiles < 1 || !Number.isInteger(depth) || depth < 2) return findings;
  for (const repo of repos) {
    try {
      if (typeof repo !== "string" || !path.isAbsolute(repo)) continue;
      const staged = new Set(git(repo, ["diff", "--cached", "--name-only", "-z"]).split("\0"));
      const files = git(repo, ["diff", "--name-only", "-z"]).split("\0")
        .filter(file => file && !staged.has(file)).slice(0, maxFiles);
      const candidates = [];
      for (const file of files) {
        try {
          const stat = fs.lstatSync(path.join(repo, file));
          if (stat.isFile()) candidates.push({ file, mtimeMs: stat.mtimeMs });
        } catch { /* deleted or inaccessible file */ }
      }
      if (!candidates.length) continue;
      const hashes = git(repo, ["hash-object", "--stdin-paths"], candidates.map(({ file }) => quotedPath(file)).join("\n") + "\n").trim().split("\n");
      if (hashes.length !== candidates.length) continue;
      for (const [index, { file, mtimeMs }] of candidates.entries()) {
        try {
          const blob = hashes[index];
          if (blob === git(repo, ["rev-parse", `HEAD:${file}`]).trim()) continue;
          const commits = git(repo, ["log", "-n", String(depth), "--format=%H", "--", file]).trim().split("\n");
          if (commits.length < 2) continue;
          const newest = commits[0];
          const [timestamp, ...subjectLines] = git(repo, ["show", "-s", "--format=%ct%n%s", newest]).trimEnd().split("\n");
          if (!(Number(timestamp) * 1000 > mtimeMs)) continue;
          for (const old of commits.slice(1)) {
            let oldBlob;
            try { oldBlob = git(repo, ["rev-parse", `${old}:${file}`]).trim(); }
            catch { continue; /* path may have been deleted and later recreated */ }
            if (blob !== oldBlob) continue;
            // Do not report from a disk snapshot that changed during inspection.
            if (fs.lstatSync(path.join(repo, file)).mtimeMs !== mtimeMs) break;
            const finding = {
              id: "stale-working-copy", severity: "warn", repo,
              message: `${file}: the working copy is the older version from ${old.slice(0, 9)}; it silently reverts ${newest.slice(0, 9)} (${subjectLines.join("\n")})`,
              action: `git restore ${file} (the old content stays in history at ${old.slice(0, 9)})`,
            };
            findings.push(finding);
            report(finding.id, finding.severity, finding.repo, finding.message, finding.action);
            break;
          }
        } catch { /* a bad path or concurrent Git change must not stop the sweep */ }
      }
    } catch { /* missing, non-repository, inaccessible or timed-out repository */ }
  }
  return findings;
}

module.exports = { staleWorkingCopyFindings };
