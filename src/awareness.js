"use strict";
/**
 * Repo awareness — HARD RULE (product decision, 2026-09-26):
 * "git-manager needs to be aware of all of the repos 100% of the time."
 *
 * The old model had an `ignorePaths` list that removed repos from the scan
 * entirely, so 108 of 141 repos on disk were invisible: ~/seo, agents/mirofish,
 * agents/open-generative-ai, .understand-anything, every worktree. A repo that
 * is ignored cannot be reported as unbacked, so the blind spot hid real risk.
 *
 * The rule now: NOTHING is ignored. Everything is found, then CLASSIFIED.
 * Classification decides how loudly we care, never whether we look.
 */
const { execFile, execFileSync, spawn, spawnSync } = require("child_process");
const { boundedExecFile } = require("./bounded-exec");
const execFileAsync = (cmd, args, options) => boundedExecFile(cmd, args, options, execFile);
const fs = require("./volume-probe").guardFs(require("fs"));
const os = require("os");
const path = require("path");

const { createVolumeProbe, volumeRootOf, probePath } = require("./volume-probe");
const HOME = os.homedir();
/**
 * Where local bare mirrors live. Configurable, because this ships: a hardcoded
 * path is correct on exactly one machine and wrong for every other install.
 * When it is unset AND absent, mirrors simply are not part of this machine's
 * backup strategy, which is a normal configuration, not a fault. Only an
 * explicitly configured root that has gone missing is worth alarming about
 * (that means a backup disk fell off).
 */
const MIRROR_ROOT = process.env.GIT_MANAGER_MIRROR_ROOT
  || "/Volumes/All Sorted External/All Sorted external drive data/git-mirrors";
const MIRROR_ROOT_CONFIGURED = Boolean(process.env.GIT_MANAGER_MIRROR_ROOT);

// Only genuine machine noise is skipped: package caches and OS dirs that
// contain third-party checkouts we neither own nor could act on.
const NOISE = ["node_modules", "/Library/", "/.Trash/", "/.npm/", "/.cargo/", "/.rustup/", "/.bun/", "/.pyenv/"];

function isNoise(p) { return NOISE.some((n) => p.includes(n)); }

function git(repo, args) {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    }).trim();
  } catch { return ""; }
}

// 2026-09-29: synchronous git across hundreds of repos stalled sweeps overnight.
async function gitAsync(repo, args) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repo, ...args], {
      encoding: "utf8", timeout: 15000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return stdout.trim();
  } catch { return ""; }
}

async function readabilityAsync(repo) {
  try {
    await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8", timeout: 15000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return { readable: true };
  } catch (err) {
    return readabilityResult(repo, { status: err.code, stderr: err.stderr });
  }
}

/**
 * Can git read this repo at all?
 *
 * 2026-09-26: another-account/website is owned by another account, so every
 * git command failed with "detected dubious ownership". git() swallowed that
 * as "", backupCoverage() then saw no remote AND a commit count of "0", judged
 * the repo empty, and scored it COVERED. A repo we cannot read was reported as
 * healthy while actually having no remote and no mirror. Unreadable must be
 * loud, never silently fine.
 */
function readability(repo) {
  const r = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8", timeout: 15000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return readabilityResult(repo, r);
}

function readabilityResult(repo, r) {
  if (r.status === 0) return { readable: true };
  const err = (r.stderr || "").trim();
  if (/dubious ownership/i.test(err)) return { readable: false, reason: "dubious ownership (owned by another account)", fix: `git config --global --add safe.directory ${repo}` };
  if (/not a git repository/i.test(err)) return { readable: false, reason: "not a git repository" };
  // A repo with no commits yet is readable, just empty.
  if (/unknown revision|ambiguous argument 'HEAD'|does not have any commits/i.test(err)) return { readable: true, noCommits: true };
  return { readable: false, reason: err.split("\n")[0].slice(0, 120) || `git exited ${r.status}` };
}

/**
 * Every .git on disk. No depth cap, and no repo is ever excluded.
 *
 * PRUNE is not an ignore-list of repos — it is a list of directory trees that
 * cannot contain a first-party repo (package caches, OS dirs). Walking them
 * made an unpruned find exceed 300s and return nothing, which silently emptied
 * the census. Pruning at the find level keeps the scan complete AND fast.
 */
const PRUNE_DIRS = ["node_modules", "Library", ".Trash", ".npm", ".cargo", ".rustup", ".bun", ".pyenv", ".venv", ".gradle", ".m2", "Photos Library.photoslibrary",
  "venv", "site-packages", "DerivedData", ".next", ".cache", "__pycache__", ".turbo", ".pnpm-store", "Pods", "graphify-out", "dist-packages"];

async function findAllRepos(root = HOME, {
  timeoutMs = 240000, command = "find",
  previousCensusPath = path.join(__dirname, "../data/repo-census.json"),
  volumes = createVolumeProbe(), probe = probePath,
} = {}) {
  const started = Date.now();
  const requested = Number(timeoutMs);
  const deadline = Number.isFinite(requested) && requested > 0 ? requested : 240000;
  const prune = PRUNE_DIRS.flatMap((d) => ["-name", d, "-prune", "-o"]);
  const repos = new Set();
  let entries = 0;
  const accept = (line) => {
    if (!line) return;
    entries++;
    const repo = line.replace(/\/\.git$/, "");
    if (repo && !isNoise(repo)) repos.add(repo);
  };
  const result = await new Promise((resolve) => {
    let child, timer, settled = false, pending = "";
    const finish = (error, timedOut = false) => {
      if (settled) return;
      settled = true;
      require("timers").clearTimeout(timer);
      // A timeout can split a path mid-line. Only normal EOF completes it.
      if (!timedOut && pending) accept(pending);
      resolve({ error, timedOut });
    };
    try {
      child = spawn(command, [root, ...prune, "-name", ".git", "-print"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (settled) return;
        pending += chunk;
        let end;
        while ((end = pending.indexOf("\n")) !== -1) {
          accept(pending.slice(0, end));
          pending = pending.slice(end + 1);
        }
      });
      child.once("error", (err) => finish(err.code));
      child.once("close", (code) => finish(code === 0 ? null : code));
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        child.stdout.destroy();
        child.unref();
        // Do not wait for a process stuck in kernel I/O to acknowledge SIGKILL.
        finish("ETIMEDOUT", true);
      }, deadline);
    } catch (err) { finish(err.code || err.message); }
  });
  if (result.timedOut) {
    let previous = [];
    try {
      const saved = JSON.parse(fs.readFileSync(previousCensusPath, "utf8"));
      if (Array.isArray(saved.repos)) previous = saved.repos;
    } catch { /* Missing or invalid census cannot supply recovery paths. */ }
    for (const row of previous) {
      if (typeof row?.path !== "string") continue;
      const repo = row.path.replace(/^~(?=$|\/)/, HOME);
      if (!path.isAbsolute(repo) || isNoise(repo) || repos.has(repo)) continue;
      if (volumeRootOf(repo)) {
        if ((await volumes.check(repo)).state !== "ok") continue;
        // check() already probes this exact path and caches its result.
      } else if (!fs.existsSync(repo)) continue;
      repos.add(repo);
    }
  }
  if (result.error !== null && !repos.size) {
    throw new Error(`repo discovery produced nothing (${result.error}) - census would be falsely empty`);
  }
  return { repos: [...repos].sort(), discoveryPartial: result.timedOut,
    discoveryMs: Date.now() - started, discoveryEntries: entries, discoveryTimeoutMs: deadline };
}

/**
 * Classification decides how loudly we care, never whether we look.
 *
 * Getting this wrong is expensive in both directions: calling generated
 * experiment output "first-party" raised 15 false CRITICALs on web-designer
 * benchmark fixtures, and a false critical trains people to ignore real ones.
 */
function classify(repo, volumes = createVolumeProbe()) {
  if (!volumes.allowed(repo)) return "offline";
  const rel = repo.replace(HOME, "~");
  if (rel.startsWith("~/.config/allsorted/worktrees/") || rel.includes("/.codex-worktrees/")) return "agent-scratch";
  const gitPath = path.join(repo, ".git");
  try { if (fs.statSync(gitPath).isFile()) return "worktree"; } catch { /* missing */ }

  // Agent-generated output: benchmark fixtures, trial runs, capture staging.
  // Reproducible by re-running the agent, so losing them costs nothing.
  if (/\/(agent-benchmark|trials|captures?|preserve-[0-9a-f]{6,})\//.test(rel)) return "agent-scratch";
  if (rel.includes("/.codex/") || rel.startsWith("~/Documents/Codex")) return "agent-scratch";
  if (rel.includes("/atelier-head-start/")) return "agent-scratch";
  if (/\/(writer-worktrees|sidecar|swarms)\//.test(rel)) return "agent-scratch";

  if (rel.includes("/.cache/") || rel.includes("/.tmp/") || /\/tmp\//.test(rel)) return "scratch";
  if (rel.includes("/external-skills/") || rel.includes("/repos-study/")
      || rel.includes("/node_modules/") || rel.includes("/.venv/")) return "vendor";
  if (rel.includes("/vendor/") || rel.includes("/tools/") || rel.includes("/plugins/")
      || rel.includes("/skills/") || rel.includes("/aios-eval/")
      || rel.includes("/marketplaces/") || rel.includes("/vendor_imports/")) return "vendor";
  if (rel.includes("/state/releases/") || /-dist(\/|$)/.test(rel)) return "release-artifact";
  return "first-party";
}

function mirrorNameFor(repo, volumes) {
  if (!volumes.allowed(MIRROR_ROOT)) return null;
  const rel = path.relative(HOME, repo);
  if (repo === path.join(HOME, ".allsorted")) return "allsorted-workspace.git";
  const flat = rel.replace(/\//g, "_");
  for (const cand of [`${flat}.git`, `${path.basename(repo)}.git`]) {
    if (volumes.allowed(path.join(MIRROR_ROOT, cand)) && fs.existsSync(path.join(MIRROR_ROOT, cand))) return cand;
  }
  return null;
}

/** A repo is covered if its history exists somewhere other than this disk. */
function backupCoverage(repo, volumes = createVolumeProbe()) {
  if (!volumes.allowed(repo)) return { offlineVolume: volumeRootOf(repo), covered: false };
  const read = readability(repo);
  if (!read.readable) {
    // Unknown, NOT covered. We cannot prove a backup for a repo we cannot read.
    return { remote: null, mirror: null, empty: false, covered: false, unreadable: read.reason, fix: read.fix || null };
  }
  const remote = git(repo, ["remote", "get-url", "origin"]) || null;
  const mirror = volumes.allowed(MIRROR_ROOT) && fs.existsSync(MIRROR_ROOT) ? mirrorNameFor(repo, volumes) : null;
  const empty = Boolean(read.noCommits)
    && git(repo, ["for-each-ref", "--count=1", "--format=x", "refs/heads", "refs/tags"]) === "";
  return { remote, mirror, empty, covered: Boolean(remote || mirror) || empty, unreadable: null };
}

async function backupCoverageAsync(repo, volumes) {
  const read = await readabilityAsync(repo);
  if (!read.readable) {
    return { remote: null, mirror: null, empty: false, covered: false, unreadable: read.reason, fix: read.fix || null };
  }
  const remote = await gitAsync(repo, ["remote", "get-url", "origin"]) || null;
  const rel = path.relative(HOME, repo).replace(/\//g, "_");
  for (const name of [`${rel}.git`, `${path.basename(repo)}.git`]) {
    await volumes.check(path.join(MIRROR_ROOT, name));
  }
  const mirror = volumes.allowed(MIRROR_ROOT) && fs.existsSync(MIRROR_ROOT) ? mirrorNameFor(repo, volumes) : null;
  const mirrorUrl = await gitAsync(repo, ["remote", "get-url", "mirror"]);
  const mirrorPath = localMirrorPath(repo, mirrorUrl);
  const mirrorVolume = mirrorPath && volumeRootOf(mirrorPath);
  const mirrorVolumeState = mirrorVolume && (await volumes.check(mirrorVolume)).state;
  const mirrorState = mirrorPath && (await volumes.check(mirrorPath)).state;
  const backupUnverifiable = Boolean(mirrorPath &&
    ((mirrorVolume && mirrorVolumeState !== "ok") || mirrorState === "unresponsive"));
  const empty = Boolean(read.noCommits)
    && await gitAsync(repo, ["for-each-ref", "--count=1", "--format=x", "refs/heads", "refs/tags"]) === "";
  return { remote, mirror, mirrorUrl, backupUnverifiable, empty, covered: Boolean(remote || mirror) || empty, unreadable: null };
}

function localMirrorPath(repo, url) {
  if (!url) return null;
  let mirrorPath;
  try {
    if (url.startsWith("file://")) mirrorPath = require("url").fileURLToPath(url);
    else {
      if (url.includes(":")) return null; // network URLs and scp-style remotes
      mirrorPath = path.resolve(repo, url.replace(/^~(?=$|\/)/, HOME));
    }
  } catch { return null; }
  return mirrorPath;
}

// Probe only local mirrors, never contact a remote during the census.
async function localMirrorFresh(repo, volumes) {
  const url = await gitAsync(repo, ["remote", "get-url", "mirror"]);
  if (!url) return null;
  const mirrorPath = localMirrorPath(repo, url);
  if (!mirrorPath || (await volumes.check(mirrorPath)).state !== "ok") return null;
  if (!fs.existsSync(mirrorPath)) return null;
  const heads = (await gitAsync(repo, ["for-each-ref", "--format=%(objectname) %(refname:short)", "refs/heads"]))
    .split("\n").filter(Boolean).map((line) => {
      const [sha, name] = line.split(" ");
      return { sha, name };
    });
  if (!heads.length) return null;
  const present = [], missing = [];
  const verified = new Map();
  for (const head of heads) {
    if (!verified.has(head.sha)) {
      const found = await gitAsync(repo, ["--git-dir", mirrorPath, "rev-parse", "--verify", `${head.sha}^{commit}`]);
      verified.set(head.sha, found === head.sha);
    }
    (verified.get(head.sha) ? present : missing).push(head);
  }
  return { present, missing };
}

async function census({ concurrency, probe, volumes = createVolumeProbe({ probe }), knownPaths = [], discovery = {} } = {}) {
  return volumes.run(() => censusInSession({ concurrency, probe, volumes, knownPaths, discovery }));
}

async function censusInSession({ concurrency, probe, volumes, knownPaths, discovery }) {
  const started = Date.now();
  await volumes.check(MIRROR_ROOT);
  const discovered = (await volumes.check(HOME)).state === "ok"
    ? await findAllRepos(HOME, { ...discovery, volumes, probe })
    : { repos: [], discoveryPartial: false, discoveryMs: 0, discoveryEntries: 0 };
  const repos = [...new Set([...discovered.repos, ...knownPaths.map(p => p.replace(/^~(?=$|\/)/, HOME))
    .filter(p => volumeRootOf(p) || !volumes.allowed(p))])];
  const requested = Number(concurrency ?? process.env.GIT_MANAGER_CENSUS_CONCURRENCY ?? 8);
  const limit = Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : 8;
  const rows = new Array(repos.length);
  let next = 0;
  async function inspectNext() {
    while (next < repos.length) {
      const index = next++;
      const repo = repos[index];
      const start = Date.now();
      if (!await volumes.checkRepo(repo)) {
        if (volumes.offlineVolume(repo)) rows[index] = {
          path: repo.replace(HOME, "~"), kind: "offline", offlineVolume: volumes.offlineVolume(repo), ms: Date.now() - start,
        };
        continue;
      }
      const kind = classify(repo, volumes);
      const cov = kind === "worktree" ? { covered: true, remote: null, mirror: null, empty: false } : await backupCoverageAsync(repo, volumes);
      let linkedWorktree = false, scratchClone = false;
      const rel = repo.replace(HOME, "~");
      const topicClonePath = rel.startsWith("~/.config/allsorted/worktrees/") || rel.includes("/.codex-worktrees/");
      try {
        const gitEntry = fs.statSync(path.join(repo, ".git"));
        linkedWorktree = gitEntry.isFile();
        scratchClone = kind === "agent-scratch" && topicClonePath && gitEntry.isDirectory();
      } catch { /* unavailable */ }
      // Linked worktrees share repository history; never count it again here.
      const count = linkedWorktree || (kind === "agent-scratch" && !scratchClone) ? "" : cov.empty ? "0" : await gitAsync(repo, ["rev-list", "--count", "--branches", "--not", "--remotes"]);
      let localOnly = /^\d+$/.test(count) ? Number(count) : null;
      const branches = (await gitAsync(repo, ["for-each-ref", "--format=x", "refs/heads"]))
        .split("\n").filter(Boolean).length;
      const ownsCommits = kind === "first-party" || kind === "vendor" || scratchClone;
      const mirrorHeads = ownsCommits && localOnly > 0 ? await localMirrorFresh(repo, volumes) : null;
      const mirrorFresh = Boolean(mirrorHeads && !mirrorHeads.missing.length);
      if (mirrorHeads) {
        const uncoveredCount = mirrorFresh ? "0" : await gitAsync(repo, [
          "rev-list", "--count", ...new Set(mirrorHeads.missing.map((head) => head.sha)),
          "--not", "--remotes", ...new Set(mirrorHeads.present.map((head) => head.sha)),
        ]);
        localOnly = /^\d+$/.test(uncoveredCount) ? Number(uncoveredCount) : null;
      }
      rows[index] = {
        path: repo.replace(HOME, "~"), kind,
        branches,
        dirty: (await gitAsync(repo, ["status", "--porcelain"])).split("\n").filter(Boolean).length,
        lastCommit: await gitAsync(repo, ["log", "-1", "--format=%cI"]) || null,
        ...cov,
        localOnly, mirrorFresh, linkedWorktree,
        missingMirrorBranches: mirrorHeads ? mirrorHeads.missing.map((head) => head.name) : [],
        // Retain the old repo-unbacked finding independently of commit coverage.
        configuredCoverage: cov.covered,
        covered: ownsCommits && branches > 0 && localOnly !== null ? localOnly === 0 || mirrorFresh : cov.covered,
        ms: Date.now() - start,
      };
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, repos.length) }, inspectNext));
  return {
    takenAt: new Date().toISOString(),
    discoveryPartial: discovered.discoveryPartial,
    discoveryMs: discovered.discoveryMs,
    discoveryEntries: discovered.discoveryEntries,
    discoveryRepoCount: discovered.repos.length,
    discoveryTimeoutMs: discovered.discoveryTimeoutMs,
    mirrorRootPresent: volumes.allowed(MIRROR_ROOT) && fs.existsSync(MIRROR_ROOT),
    volumes: volumes.snapshot(),
    repos: rows.filter(Boolean),
    durationMs: Date.now() - started,
    slowest: rows.filter(Boolean).map(({ path, ms }) => ({ path, ms })).sort((a, b) => b.ms - a.ms).slice(0, 10),
  };
}

/**
 * Findings. The invariant: every repo on disk is KNOWN (in the census) and every
 * first-party repo is COVERED (remote or mirror). Violations are not hygiene info,
 * they are the failure this agent exists to catch.
 */
function awarenessFindings(snapshot, rosterPaths, add) {
  if (snapshot.discoveryPartial) add("discovery-partial", "warn", "~",
    `repo discovery timed out after ${snapshot.discoveryTimeoutMs / 1000} s; used partial walk + previous census (${snapshot.discoveryRepoCount} repos)`,
    "re-run discovery when host load subsides");
  const known = new Set(rosterPaths);
  const firstParty = snapshot.repos.filter((r) => r.kind === "first-party");

  // Only alarm when a mirror root was explicitly configured and has vanished,
  // or when repos actually depend on it. An install that never used mirrors is
  // not broken.
  const dependsOnMirror = snapshot.repos.some((r) => r.mirror || r.backupUnverifiable);
  const mirrorVolume = snapshot.volumes?.[volumeRootOf(MIRROR_ROOT)];
  for (const [root, result] of Object.entries(snapshot.volumes || {})) {
    if (result.state === "unresponsive") add("volume-unresponsive", "critical", root,
      `mounted but not responding to I/O (${result.ms} ms) \u2014 backups on it are offline; unplug and reconnect the drive`,
      "unplug and reconnect the drive");
  }
  for (const [id, rows] of [
    ["repos-on-offline-volume", snapshot.repos.filter(r => r.offlineVolume)],
    ["backups-unverifiable", snapshot.repos.filter(r => r.backupUnverifiable)],
  ]) {
    if (rows.length) add(id, "warn", "~", `${rows.length} repo(s): ${rows.slice(0, 5).map(r => r.path).join(", ")}`,
      "reconnect the backup drive, then re-run");
  }
  if (!snapshot.mirrorRootPresent && mirrorVolume?.state !== "unresponsive" && (MIRROR_ROOT_CONFIGURED || dependsOnMirror)) {
    add("mirror-root-missing", "critical", "~",
      `configured mirror root is not mounted (${MIRROR_ROOT}) — local-only repos have no second copy`,
      "mount the backup drive, or set GIT_MANAGER_MIRROR_ROOT to where mirrors live, then re-run");
  }

  for (const r of snapshot.repos.filter((x) => x.unreadable)) {
    add("repo-unreadable", "critical", r.path,
      `git cannot read this repo (${r.unreadable}) — its dirty state and backup coverage are UNKNOWN, not fine`,
      r.fix || "fix ownership/permissions so git-manager can inspect it");
  }

  const uncovered = firstParty.filter((r) => !(r.configuredCoverage ?? r.covered) && !r.unreadable && !r.backupUnverifiable);
  for (const r of uncovered) {
    add("repo-unbacked", "critical", r.path,
      `first-party repo has no remote and no mirror — exists only on this disk (${r.branches} branches)`,
      "git remote add mirror <git-mirrors>/<name>.git && git push mirror --all --tags");
  }

  for (const r of snapshot.repos.filter((r) =>
    ["first-party", "vendor", "agent-scratch"].includes(r.kind) && !r.unreadable && !r.backupUnverifiable && r.localOnly > 0 && !r.mirrorFresh)) {
    add("local-commits-unbacked", r.kind === "first-party" && r.localOnly > 20 ? "critical" : "warn", r.path,
      `${r.localOnly} local-only commit(s) are on no remote-tracking ref and not verified in a local mirror`
        + (r.missingMirrorBranches?.length ? `; missing mirror branches: ${r.missingMirrorBranches.slice(0, 5).join(", ")}` : ""),
      "git push mirror --all (or add a mirror remote first)");
  }

  const unknown = firstParty.filter((r) => !known.has(r.path));
  for (const r of unknown) {
    add("repo-unknown-to-roster", unknown.length > 10 ? "warn" : "info", r.path,
      "first-party repo on disk but not in the git-manager roster",
      "auto-adopted into config/roster.generated.json this sweep");
  }

  return {
    total: snapshot.repos.length,
    firstParty: firstParty.length,
    uncovered: uncovered.length,
    unknown: unknown.length,
    byKind: snapshot.repos.reduce((a, r) => ((a[r.kind] = (a[r.kind] || 0) + 1), a), {}),
  };
}

module.exports = { findAllRepos, classify, backupCoverage, census, awarenessFindings, MIRROR_ROOT, MIRROR_ROOT_CONFIGURED };
