"use strict";
const { execFile } = require("node:child_process");
const { boundedExecFile } = require("./bounded-exec");
const { createHash } = require("node:crypto");
const fs = require("./volume-probe").guardFs(require("node:fs"));
const path = require("node:path");
const os = require("node:os");
const { createVolumeProbe } = require("./volume-probe");
const execute = (cmd, args, options) => boundedExecFile(cmd, args, options, execFile);
const localPath = value => value.startsWith("/") && !value.includes("://") && !value.split("/")[0].includes(":");

/** Local backup only. Four workers bound all probes and pushes, not just push calls. */
async function syncMirrors({ census = {}, repos = [], stateFile = path.join(__dirname, "../data/mirror-sync-state.json"),
  probe, volumes, config = {}, readOnly = false, report = () => {} } = {}) {
  if (!volumes) volumes = createVolumeProbe({ probe });
  return volumes.run(() => syncMirrorsInSession({ census, repos, stateFile, volumes, config, readOnly, report }));
}

async function syncMirrorsInSession({ census, repos, stateFile, volumes, config, readOnly, report }) {
  const started = Date.now();
  const summary = { repos: 0, pushed: 0, skippedUnchanged: 0, rejected: 0, rootMissing: 0, rootUnresponsive: 0, durationMs: 0 };
  if (readOnly || config.enabled === false) return summary;
  const configuredMirrorRoot = require("./awareness").MIRROR_ROOT;
  if ((await volumes.check(stateFile)).state !== "ok") return summary;
  let state = {};
  try { const saved = JSON.parse(fs.readFileSync(stateFile, "utf8")); if (saved && typeof saved === "object" && !Array.isArray(saved)) state = saved; } catch { /* first run or corrupt cache */ }
  const candidates = [...(census.repos || []).filter(r => ["first-party", "vendor"].includes(r.kind)), ...repos];
  const paths = [...new Set(candidates.map(r => typeof r === "string" ? r : r.path)
    .filter(p => typeof p === "string").map(p => path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()))))];
  const git = async (repo, args, timeout = 20000) => execute("git", ["-C", repo, ...args], {
    encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file", LC_ALL: "C" },
  });
  let next = 0, changed = false;
  async function worker() {
    while (next < paths.length) {
      const repo = paths[next++];
      if (!await volumes.checkRepo(repo)) continue;
      let ref = "mirror", eligible = false;
      const displayRepo = repo === os.homedir() ? "~" : repo.startsWith(os.homedir() + path.sep) ? "~" + repo.slice(os.homedir().length) : repo;
      try {
        // Validate effective push URLs too: pushurl and insteadOf must never escape locally.
        const fetchUrls = (await git(repo, ["remote", "get-url", "--all", "mirror"])).stdout.trim().split("\n");
        const urls = (await git(repo, ["remote", "get-url", "--push", "--all", "mirror"])).stdout.trim().split("\n");
        if (fetchUrls.length !== 1 || urls.length !== 1 || !localPath(fetchUrls[0]) || !localPath(urls[0]) || fetchUrls[0] !== urls[0]) continue;
        const mirror = urls[0];
        summary.repos++;
        const volume = await volumes.check(mirror);
        const mirrorRoot = mirror.startsWith(configuredMirrorRoot + path.sep) ? configuredMirrorRoot : path.dirname(mirror);
        const mirrorRootState = (await volumes.check(mirrorRoot)).state;
        await volumes.check(path.dirname(mirror));
        if (volume.state !== "ok" || mirrorRootState !== "ok") {
          summary.rootMissing++;
          if (volume.state === "unresponsive" || mirrorRootState === "unresponsive") summary.rootUnresponsive++;
          continue;
        }
        if (!fs.existsSync(path.dirname(mirror))) { summary.rootMissing++; continue; }
        if (!fs.existsSync(mirror)) continue;
        if ((await git(repo, ["--git-dir", mirror, "rev-parse", "--is-bare-repository"])).stdout.trim() !== "true") continue;
        eligible = true;
        const refs = (await git(repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags", "refs/allsorted"])).stdout;
        const hash = createHash("sha256").update(refs).digest("hex");
        const identity = fs.statSync(mirror);
        const destination = `${fs.realpathSync(mirror)}:${identity.dev}:${identity.ino}`;
        let fetchSpecs = [];
        try { fetchSpecs = (await git(repo, ["config", "--get-all", "remote.mirror.fetch"])).stdout.trim().split("\n"); }
        catch (error) { if (error.code !== 1) throw error; /* no fetch mapping */ }
        const branches = new Map(refs.trim().split("\n").map(line => line.split(" "))
          .filter(([name]) => name.startsWith("refs/heads/")));
        async function refreshTracking(accepted) {
          for (const name of accepted) {
            const sha = branches.get(name);
            if (!sha) continue;
            const tracking = `refs/remotes/mirror/${name.slice("refs/heads/".length)}`;
            const mapped = fetchSpecs.some(spec => {
              const [source, destination] = spec.replace(/^\+/, "").split(":");
              return (source === "refs/heads/*" && destination === "refs/remotes/mirror/*")
                || (source === name && destination === tracking);
            });
            if (!mapped) continue;
            // Verify locally, including on cache hits. Never claim a rejected or
            // concurrently moved tip is backed up, and never fetch from a network.
            let mirrored;
            try { mirrored = (await git(repo, ["--git-dir", mirror, "rev-parse", "--verify", name])).stdout.trim(); }
            catch { continue; }
            if (mirrored !== sha) continue;
            let current = "";
            try { current = (await git(repo, ["rev-parse", "--verify", tracking])).stdout.trim(); }
            catch { /* tracking ref has not been created yet */ }
            if (current !== sha) {
              try { await git(repo, ["update-ref", "--no-deref", tracking, sha, current || "0".repeat(sha.length)]); }
              catch { /* best effort: tracking contention must not reject a successful backup */ }
            }
          }
        }
        if (state[repo]?.hash === hash && state[repo]?.destination === destination) {
          await refreshTracking(branches.keys());
          summary.skippedUnchanged++;
          continue;
        }
        if ((await git(repo, ["rev-parse", "--is-shallow-repository"])).stdout.trim() === "true") {
          await git(repo, ["--git-dir", mirror, "config", "receive.shallowUpdate", "true"]);
        }
        let failed = false;
        const acceptedBranches = new Set();
        for (const spec of ["--all", "--tags", "refs/allsorted/*:refs/allsorted/*"]) {
          ref = spec;
          let result, pushFailed = false;
          try {
            // Override implicit force/deletion, custom receivers, hooks and followTags.
            result = await git(repo, ["-c", "remote.mirror.mirror=false", "-c", "remote.mirror.receivepack=git-receive-pack",
              "-c", "core.hooksPath=/dev/null", "-c", "push.followTags=false", "push", "--porcelain", "mirror", spec], 120000);
          } catch (error) {
            failed = true;
            pushFailed = true;
            result = error;
          }
          const lines = String(result.stdout || "").split("\n");
          summary.pushed += lines.filter(line => /^[ *+]\t/.test(line)).length;
          if (spec === "--all") {
            for (const line of lines.filter(line => /^[ *=+]\t/.test(line))) {
              acceptedBranches.add(line.split("\t")[1].split(":").pop());
            }
          }
          const rejected = lines.filter(line => line.startsWith("!\t"));
          if (pushFailed && !rejected.length) rejected.push(null);
          for (const line of rejected) {
            const target = line ? line.split("\t")[1].split(":").pop() : spec;
            const reason = line ? line.split("\t").slice(2).join("\t")
              : String(result.stderr || result.message || "push rejected").split(/\r?\n/)[0];
            let preservation = "";
            if (spec === "--all" && target.startsWith("refs/heads/")) {
              const backup = `refs/allsorted/diverged/${target.slice("refs/heads/".length)}`;
              try {
                // Force is restricted to this rolling backup pointer, never the branch.
                const saved = await git(repo, ["-c", "remote.mirror.mirror=false", "-c", "remote.mirror.receivepack=git-receive-pack",
                  "-c", "core.hooksPath=/dev/null", "-c", "push.followTags=false", "push", "--porcelain", "mirror", `+${target}:${backup}`], 120000);
                summary.pushed += String(saved.stdout || "").split("\n").filter(line => /^[ *+]\t/.test(line)).length;
                preservation = `; local tip preserved at ${backup}`;
              } catch (error) {
                const detail = String(error.stdout || "").split("\n").find(line => line.startsWith("!\t"));
                preservation = `; local tip backup at ${backup} failed: ${detail ? detail.split("\t").slice(2).join("\t") : String(error.stderr || error.message).split(/\r?\n/)[0]}`;
              }
            }
            report({ id: "mirror-push-rejected", severity: "warn", repo: displayRepo, ref: target,
              message: `${target}: ${reason}${preservation}`, action: "inspect mirror divergence; never force-push branches" });
          }
        }
        await refreshTracking(acceptedBranches);
        if (failed) summary.rejected++;
        else {
          state[repo] = { hash, destination, syncedAt: new Date().toISOString() };
          changed = true;
        }
      } catch (error) {
        if (!eligible) continue;
        summary.rejected++;
        // Porcelain stdout identifies rejected refs, while stderr retains Git's diagnosis.
        const rejected = String(error.stdout || "").split("\n").filter(line => line.startsWith("!\t"));
        const stderr = String(error.stderr || error.message).split(/\r?\n/)[0];
        for (const line of rejected.length ? rejected : [null]) {
          const target = line ? line.split("\t")[1].split(":").pop() : ref;
          report({ id: "mirror-push-rejected", severity: "warn", repo: displayRepo, ref: target, message: `${target}: ${stderr}`, action: "inspect mirror divergence; never force-push" });
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, paths.length) }, worker));
  if (changed) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const temporary = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n");
    fs.renameSync(temporary, stateFile);
  }
  summary.durationMs = Date.now() - started;
  return summary;
}
module.exports = { syncMirrors };
