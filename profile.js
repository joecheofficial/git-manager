"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function resolveRepositoryRoot(value, env = process.env) {
  if (value || env.REPOSITORY_ROOT) return path.resolve(value || env.REPOSITORY_ROOT);
  const file = env.GIT_MANAGER_PROFILE || path.join(os.homedir(), ".config", "allsorted", "git-manager", "profile.json");
  if (!path.isAbsolute(file)) throw new Error("GIT_MANAGER_PROFILE must be an absolute path.");
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT" && !env.GIT_MANAGER_PROFILE) throw new Error("Set REPOSITORY_ROOT or create your private Git Manager profile.json from config.example.json.");
    throw error;
  }
  const profile = JSON.parse(raw);
  if (!profile || typeof profile.repositoryRoot !== "string" || !path.isAbsolute(profile.repositoryRoot)) {
    throw new Error("The private profile repositoryRoot must be an absolute path.");
  }
  return profile.repositoryRoot;
}
module.exports = { resolveRepositoryRoot };
