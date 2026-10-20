"use strict";
const { spawn } = require("node:child_process");
const { AsyncLocalStorage } = require("node:async_hooks");
const { fileURLToPath } = require("node:url");
const path = require("node:path");
const fs = require("node:fs");
const sessions = new AsyncLocalStorage();

const resolutionCaches = new WeakMap();

function resolveVolumePath(p, { prefix = process.env.GIT_MANAGER_VOLUMES_PREFIX || "/Volumes",
  cache = resolutionCaches.get(sessions.getStore()) } = {}) {
  if (Buffer.isBuffer(p)) p = p.toString();
  if (p instanceof URL) p = fileURLToPath(p);
  if (typeof p !== "string") return { volumePath: p, root: null };
  const normalize = value => path.resolve(value).replace(/^\/System\/Volumes\/Data\/Volumes(?=\/|$)/i, "/Volumes")
    .replace(/^\/Volumes(?=\/|$)/i, "/Volumes");
  prefix = normalize(prefix);
  const lexical = normalize(p), key = (prefix + "\0" + lexical).toLowerCase();
  if (cache?.has(key)) return cache.get(key);
  const lexicalPrefix = prefix;
  const rootOf = (value, boundary = prefix) => value.toLowerCase().startsWith(boundary.toLowerCase() + path.sep)
    ? path.join(boundary, value.slice(boundary.length + 1).split(path.sep)[0]) : null;
  const walk = input => {
    const fallback = { volumePath: input, root: rootOf(input) || rootOf(input, lexicalPrefix) };
    let candidate = input, hops = 0;
    const seen = new Set();
    walk: while (true) {
      if (seen.has(candidate)) return fallback;
      seen.add(candidate);
      const parts = candidate.slice(path.parse(candidate).root.length).split(path.sep).filter(Boolean);
      let current = path.parse(candidate).root;
      for (let i = 0; i < parts.length; i++) {
        current = path.join(current, parts[i]);
        // Stop at the boundary itself: even the mount entry is never inspected.
        if (current.toLowerCase() === prefix.toLowerCase() || rootOf(current)) {
          const root = rootOf(candidate);
          if (!root) return { volumePath: candidate, root: null };
          const rootKey = "root\0" + root.toLowerCase();
          const canonicalRoot = cache?.get(rootKey)?.volumePath || root;
          cache?.set(rootKey, { volumePath: canonicalRoot, root: canonicalRoot });
          return { volumePath: canonicalRoot + candidate.slice(root.length), root: canonicalRoot };
        }
        try {
          if (fs.lstatSync(current).isSymbolicLink()) {
            if (++hops > 40) return fallback;
            const target = path.resolve(path.dirname(current), fs.readlinkSync(current));
            // Carry a configured boundary through system aliases, e.g. /var.
            if (prefix.startsWith(current + path.sep)) prefix = target + prefix.slice(current.length);
            candidate = normalize(path.resolve(target, ...parts.slice(i + 1)));
            continue walk;
          }
        } catch { return fallback; }
      }
      return { volumePath: candidate, root: null };
    }
  };
  // Normalize boundary ancestors too, so resolved child paths retain their
  // volume identity even when the configured prefix contains a system alias.
  const prefixKey = lexicalPrefix + "\0";
  prefix = cache?.get(prefixKey)?.volumePath || walk(prefix).volumePath;
  cache?.set(prefixKey, { volumePath: prefix, root: null });
  const result = walk(lexical);
  cache?.set(key, result);
  return result;
}

function volumeRootOf(p) { return resolveVolumePath(p).root; }

// No parent stat, and no wait for exit/close after the deadline.
function probePath(p, { timeoutMs = 4000, command = "/bin/sh", args = ["-c",
  'if [ -d "$1" ]; then exec /bin/ls -1A -- "$1"; elif [ -e "$1" ]; then exec /bin/ls -1A -- "${1%/*}"; else exit 2; fi', "probe", p] } = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    let child, timer, settled = false;
    const finish = state => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ state, ms: Date.now() - started });
    };
    try {
      child = spawn(command, args, { detached: true, stdio: "ignore", cwd: "/" });
      child.unref();
      child.once("error", () => finish("unresponsive"));
      child.once("exit", code => finish(code === 0 ? "ok" : code !== null ? "missing" : "unresponsive"));
      timer = setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ }
        finish("unresponsive");
      }, timeoutMs);
    } catch { finish("unresponsive"); }
  });
}

async function readSmallFile(p, { maxBytes = 65536, timeoutMs = 4000, volumes = sessions.getStore() } = {}) {
  const resolved = volumes ? volumes.resolve(p) : resolveVolumePath(p);
  if (!resolved.root) {
    try { return fs.readFileSync(p, "utf8"); } catch { return null; }
  }
  p = resolved.volumePath;
  volumes ||= createVolumeProbe();
  if ((await volumes.check(path.dirname(p))).state !== "ok") return null;
  const started = Date.now();
  return new Promise(resolve => {
    let child, timer, settled = false, size = 0;
    const chunks = [];
    const finish = (value, unresponsive = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.stdout?.destroy();
      child?.unref();
      if (unresponsive) volumes?.markUnresponsive(p, Date.now() - started);
      resolve(value);
    };
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ } };
    try {
      child = spawn("/bin/cat", ["--", p], { detached: true, cwd: "/", stdio: ["ignore", "pipe", "ignore"] });
      child.stdout.on("data", chunk => {
        if (settled) return;
        size += chunk.length;
        if (size > maxBytes) { kill(); finish(null); }
        else chunks.push(chunk);
      });
      child.once("error", () => finish(null, true));
      child.once("close", code => finish(code === 0 ? Buffer.concat(chunks).toString("utf8") : null));
      timer = setTimeout(() => { kill(); finish(null, true); }, timeoutMs);
    } catch { finish(null, true); }
  });
}

function createVolumeProbe({ probe = probePath } = {}) {
  const pending = new Map(), results = new Map(), blockedRepos = new Map();
  const targets = new Set(), targetResults = new Map();
  const resolutionCache = new Map();
  const resolve = p => resolveVolumePath(p, { cache: resolutionCache });
  const rootOf = p => resolve(p).root;
  let priming;
  const queues = new Map();
  const runProbe = async (p, options) => {
    const root = rootOf(p);
    if (!queues.has(root)) queues.set(root, { active: 0, waiting: [] });
    const queue = queues.get(root);
    if (queue.active >= 4) await new Promise(resolve => queue.waiting.push(resolve));
    else queue.active++;
    try {
      if (results.get(root)?.state === "unresponsive") return results.get(root);
      return await probe(p, options);
    } catch { return { state: "unresponsive", ms: 0 }; }
    finally {
      const next = queue.waiting.shift();
      if (next) next();
      else queue.active--;
    }
  };
  const record = (p, result) => {
    const root = rootOf(p);
    targetResults.set(p, result);
    const previous = results.get(root);
    if (previous?.state !== "unresponsive") {
      const state = result.state === "unresponsive" ? "unresponsive"
        : p === root ? result.state : previous?.state || (result.state === "ok" ? "ok" : "missing");
      results.set(root, { state, ms: Math.max(previous?.ms || 0, result.ms || 0) });
    }
    return results.get(root)?.state === "unresponsive" ? results.get(root) : result;
  };
  const session = {
    resolve,
    registerTargets(paths) {
      if (priming || pending.size) throw new Error("register targets before probing");
      for (const p of paths) {
        const root = rootOf(p);
        if (root) { targets.add(root); targets.add(resolve(p).volumePath); }
      }
    },
    prime() {
      if (!priming) priming = Promise.all([...targets].map(p => session.check(p)));
      return priming;
    },
    async check(p) {
      const root = rootOf(p);
      if (!root) return { state: "ok", ms: 0 };
      if (results.has(root) && results.get(root).state !== "ok") return results.get(root);
      const resolved = resolve(p).volumePath;
      if (!pending.has(resolved)) pending.set(resolved, (async () => {
        if (resolved !== root) {
          const rootResult = await session.check(root);
          if (rootResult.state !== "ok") return record(resolved, rootResult);
        }
        let result = await runProbe(resolved);
        if (result.state === "unresponsive") {
          // A busy disk gets a longer confirmation window before the breaker opens.
          const rootResult = await runProbe(root, { timeoutMs: 10000 });
          const retry = resolved === root ? rootResult : await runProbe(resolved, { timeoutMs: 10000 });
          record(root, rootResult);
          result = rootResult.state !== "ok" ? rootResult : retry;
        }
        return record(resolved, result);
      })());
      const result = await pending.get(resolved);
      return results.has(root) && results.get(root).state !== "ok" ? results.get(root) : result;
    },
    markUnresponsive(p, ms = 0) { record(resolve(p).volumePath, { state: "unresponsive", ms }); },
    targetState(p) {
      if (!rootOf(p)) return "ok";
      return targetResults.get(resolve(p).volumePath)?.state || "unknown";
    },
    allowed(p) {
      if (blockedRepos.has(p)) return false;
      const root = rootOf(p);
      return !root || (results.get(root)?.state === "ok" && session.targetState(p) === "ok");
    },
    async checkRepo(repo) {
      const check = async (p, optional = false) => {
        const result = await session.check(p);
        const ok = result.state === "ok" || (optional && result.state === "missing");
        const root = rootOf(p);
        if (!ok && root && (await session.check(root)).state !== "ok") blockedRepos.set(repo, root);
        return ok;
      };
      if (!await check(repo) || !session.allowed(repo)) return false;
      let gitDir = path.join(repo, ".git");
      // Resolve internal links without inspecting entries on the volume.
      if (!await check(gitDir)) return false;
      gitDir = resolve(gitDir).volumePath;
      if (!await check(gitDir)) return false;
      const metadata = await readSmallFile(gitDir, { volumes: session });
      if (!await check(gitDir)) return false;
      const match = metadata && /^gitdir: (.+)\r?$/m.exec(metadata);
      if (match) gitDir = path.resolve(repo, match[1].trim());
      if (!await check(gitDir)) return false;
      const commonPath = path.join(gitDir, "commondir");
      if (!await check(commonPath, true)) return false;
      const common = await readSmallFile(commonPath, { volumes: session });
      if (!await check(commonPath, true)) return false;
      if (common?.trim() && !await check(path.resolve(gitDir, common.trim()))) return false;
      for (const marker of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD",
        "BISECT_LOG", "rebase-merge", "rebase-apply", "index.lock"]) {
        if (!await check(path.join(gitDir, marker), true)) return false;
      }
      return true;
    },
    offlineVolume(repo) { return blockedRepos.get(repo) || null; },
    snapshot() { return Object.fromEntries(results); },
    run(fn) { return sessions.run(session, fn); },
  };
  resolutionCaches.set(session, resolutionCache);
  return session;
}

// All sync filesystem entrypoints share this last-line gate. No ancestor
// approval authorizes a descendant. Standalone sync tools fail closed on
// external paths until a caller supplies a sweep session and exact checks.
function guardFs(rawFs) {
  const guarded = { ...rawFs };
  for (const name of Object.keys(rawFs).filter(name => name.endsWith("Sync"))) {
    const original = rawFs[name];
    if (typeof original !== "function") continue;
    const wrap = fn => (...args) => {
      const indices = ["renameSync", "copyFileSync", "linkSync"].includes(name) ? [0, 1]
        : name === "symlinkSync" ? [1] : [0];
      for (const i of indices) {
        const p = args[i];
        if (volumeRootOf(p) && !sessions.getStore()?.allowed(p)) {
          const session = sessions.getStore();
          const missing = session?.targetState(p) === "missing"
            && session.snapshot()[volumeRootOf(p)]?.state !== "unresponsive";
          if (missing && name === "existsSync") return false;
          throw Object.assign(new Error(`External path requires a positive per-path probe: ${p}`), {
            code: missing ? "ENOENT" : "EVOLUMEUNVERIFIED",
          });
        }
      }
      return fn(...args);
    };
    guarded[name] = wrap(original);
    if (original.native) guarded[name].native = wrap(original.native);
  }
  return guarded;
}
module.exports = { resolveVolumePath, probePath, readSmallFile, volumeRootOf, createVolumeProbe, guardFs };
