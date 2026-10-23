"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { resolveRepositoryRoot: repoPath } = require("./profile");

function git(repo, args, { env, timeout = 60000 } = {}) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
    env: env ? { ...process.env, ...env } : process.env,
  }).trim();
}

function gitOrNull(repo, args, opts) {
  try {
    return git(repo, args, opts);
  } catch {
    return null;
  }
}

function ghAvailable() {
  try {
    execFileSync("gh", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

function ghAuthStatus() {
  if (!ghAvailable()) {
    return {
      authenticated: false,
      status: "error",
      message: "GitHub CLI (gh) is not installed on this system. Please install GitHub CLI to connect your account."
    };
  }

  try {
    const raw = execFileSync("gh", ["auth", "status", "--json", "hosts"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.hosts) {
          const hostKeys = Object.keys(parsed.hosts);
          for (const host of hostKeys) {
            const entries = parsed.hosts[host];
            if (Array.isArray(entries)) {
              const active = entries.find(e => e.state === "success" || e.active === true);
              if (active) {
                return {
                  authenticated: true,
                  status: "ok",
                  host,
                  user: active.login || null,
                  message: `Logged in to ${host}${active.login ? ` as ${active.login}` : ""}.`
                };
              }
            }
          }
        }
      } catch {
        // Fallback to plain status check if JSON parsing fails
      }
    }
  } catch {
    // Non-zero exit code or execution error
  }

  try {
    execFileSync("gh", ["auth", "status"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      authenticated: true,
      status: "ok",
      message: "Logged in to GitHub."
    };
  } catch {
    return {
      authenticated: false,
      status: "unauthenticated",
      message: "You are not logged in to GitHub. Please sign in to connect your account."
    };
  }
}

function connectGitHub() {
  if (!ghAvailable()) {
    throw new Error("GitHub CLI (gh) is not installed. Please install GitHub CLI to connect your account.");
  }

  const auth = ghAuthStatus();
  if (auth.authenticated) {
    return {
      status: "ok",
      alreadyConnected: true,
      reply: "You are already connected to GitHub. Web authentication configures Git credentials so your work can be backed up seamlessly."
    };
  }

  try {
    execFileSync("gh", ["auth", "login", "--web", "--git-protocol", "https"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      status: "ok",
      reply: "Successfully connected to GitHub. Web authentication configures Git credentials so your work can be backed up seamlessly."
    };
  } catch (err) {
    throw new Error(`Failed to connect to GitHub: ${err.message}. Please complete web authentication in your browser.`);
  }
}

function publishRepo(input = {}, rootOverride) {
  const root = repoPath(input.repositoryRoot || input.root || rootOverride);

  // The request itself is checked first, so a missing name or visibility is
  // reported the same way on every machine, signed in to GitHub or not.
  const name = String(input.name || "").trim();
  if (!name) {
    throw new Error("Repository name is required.");
  }

  const visibility = input.visibility;
  if (visibility !== "public" && visibility !== "private") {
    throw new Error("Visibility must be explicitly set to either 'public' or 'private' with no default.");
  }

  const isGit = gitOrNull(root, ["rev-parse", "--is-inside-work-tree"]) === "true";
  if (!isGit) {
    throw new Error("This directory is not a Git repository. Please initialize a Git repository before publishing.");
  }

  const existingOrigin = gitOrNull(root, ["remote", "get-url", "origin"]);
  if (existingOrigin) {
    throw new Error("A remote repository named 'origin' already exists. The repository cannot be published twice.");
  }

  const auth = ghAuthStatus();
  if (!auth.authenticated) {
    throw new Error("You are not logged in to GitHub. Please sign in to GitHub first using connect-github.");
  }

  const args = ["repo", "create", name, `--${visibility}`, "--source=.", "--remote=origin", "--push"];
  if (input.description && typeof input.description === "string" && input.description.trim()) {
    args.push("--description", input.description.trim());
  }

  try {
    execFileSync("gh", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const remoteUrl = gitOrNull(root, ["remote", "get-url", "origin"]);
    return {
      status: "ok",
      reply: `Successfully published repository '${name}' (${visibility}) to GitHub and pushed your work.`,
      name,
      visibility,
      remoteUrl
    };
  } catch (err) {
    throw new Error(`Failed to publish repository to GitHub: ${err.message}`);
  }
}

function pushWork(input = {}, rootOverride) {
  const root = repoPath(input.repositoryRoot || input.root || rootOverride);

  const isGit = gitOrNull(root, ["rev-parse", "--is-inside-work-tree"]) === "true";
  if (!isGit) {
    throw new Error("This directory is not a Git repository.");
  }

  const currentBranch = gitOrNull(root, ["branch", "--show-current"]);
  if (!currentBranch) {
    throw new Error("Cannot push: detached HEAD or no active branch found.");
  }

  const upstream = gitOrNull(root, ["rev-parse", "--abbrev-ref", "@{upstream}"]);

  try {
    if (upstream) {
      git(root, ["push"]);
    } else {
      git(root, ["push", "-u", "origin", currentBranch]);
    }
    return {
      status: "ok",
      reply: "Your work has been safely pushed to GitHub.",
      branch: currentBranch
    };
  } catch (err) {
    throw new Error(`Failed to push work to GitHub: ${err.message}`);
  }
}

function pullWork(input = {}, rootOverride) {
  const root = repoPath(input.repositoryRoot || input.root || rootOverride);

  const isGit = gitOrNull(root, ["rev-parse", "--is-inside-work-tree"]) === "true";
  if (!isGit) {
    throw new Error("This directory is not a Git repository.");
  }

  // Merge, never rebase: fetch, then merge the upstream into the current branch
  // (a fast-forward when nothing local is new, otherwise a merge commit). No
  // autostash: uncommitted work is never set aside and replayed behind your back.
  const gitDir = path.resolve(root, git(root, ["rev-parse", "--git-dir"]));
  const operation = ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"].find((marker) => fs.existsSync(path.join(gitDir, marker)));
  if (operation) {
    throw new Error(`A git operation is already in progress here (${operation}). Finish or abort it yourself first; pull-work will not touch it. Nothing was changed.`);
  }
  const upstream = gitOrNull(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const branch = gitOrNull(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const remote = branch ? gitOrNull(root, ["config", "--get", `branch.${branch}.remote`]) : null;
  if (!upstream || !remote) {
    throw new Error("This branch does not track a GitHub branch yet, so there is nothing to pull. Push it first with push-work.");
  }
  if (gitOrNull(root, ["status", "--porcelain", "--untracked-files=no"])) {
    throw new Error("You have uncommitted changes. Save them first (commit, or finish your task with git-manager finish), then pull again. Nothing was changed.");
  }
  if (remote !== ".") {
    try {
      git(root, ["fetch", "--quiet", remote], { env: { GIT_TERMINAL_PROMPT: "0" } });
    } catch (err) {
      throw new Error(`Failed to fetch from GitHub: ${err.message}`);
    }
  }
  const before = git(root, ["rev-parse", "HEAD"]);
  try {
    git(root, ["merge", "--no-edit", upstream], { env: { GIT_MERGE_AUTOEDIT: "no" } });
  } catch (err) {
    // Only a merge this command left half-done is undone (we refused above if
    // one was already in progress). A conflict is never resolved automatically.
    if (fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) {
      gitOrNull(root, ["merge", "--abort"]);
      throw new Error(`Pulling ${upstream} needs a decision: your branch and GitHub both changed the same lines. Nothing was changed. Resolve it by intent with git-manager start/finish (finish merges and stops on the conflict for you to resolve), never by rebase or force. Details: ${err.message}`);
    }
    const unchanged = gitOrNull(root, ["rev-parse", "HEAD"]) === before;
    throw new Error(`Could not merge ${upstream}${unchanged ? "; your branch was not changed" : ""}. Git said: ${String(err.stderr || err.message).trim()}`);
  }
  const after = git(root, ["rev-parse", "HEAD"]);
  return {
    status: "ok",
    reply: before === after ? "Your work is already up to date with GitHub." : `Merged the latest work from ${upstream} (merge, never rebase).`,
    upstream,
    merged: before !== after
  };
}

function remoteStatus(input = {}, rootOverride) {
  const root = repoPath(input.repositoryRoot || input.root || rootOverride);

  const remoteUrl = gitOrNull(root, ["remote", "get-url", "origin"]);
  if (!remoteUrl) {
    return {
      hasRemote: false,
      remoteUrl: null,
      ahead: 0,
      behind: 0,
      upstream: null
    };
  }

  const upstream = gitOrNull(root, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
  if (!upstream) {
    return {
      hasRemote: true,
      remoteUrl,
      ahead: 0,
      behind: 0,
      upstream: null
    };
  }

  const countRaw = gitOrNull(root, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
  let ahead = 0;
  let behind = 0;

  if (countRaw) {
    const parts = countRaw.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      ahead = parseInt(parts[0], 10) || 0;
      behind = parseInt(parts[1], 10) || 0;
    }
  }

  return {
    hasRemote: true,
    remoteUrl,
    ahead,
    behind,
    upstream
  };
}

module.exports = {
  repoPath,
  ghAvailable,
  ghAuthStatus,
  connectGitHub,
  publishRepo,
  pushWork,
  pullWork,
  remoteStatus
};
