"use strict";
const fs = require("node:fs");
const path = require("node:path");

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.every(item => typeof item === "string");

function readCustomerConfig(file) {
  let config;
  try { config = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("Customer configuration is unreadable or invalid JSON; installation stopped before writes."); }
  const settings = config?.checkin;
  if (!object(config) || !object(settings)) throw new Error("Customer configuration needs an object with checkin settings; installation stopped before writes.");
  for (const key of ["enforcedRepos", "automationSubjects"]) {
    if (settings[key] !== undefined && !strings(settings[key])) throw new Error(`Customer configuration ${key} must be an array of strings; installation stopped before writes.`);
  }
  if (settings.ownerSessions !== undefined && (!Array.isArray(settings.ownerSessions) || settings.ownerSessions.some(owner => !object(owner) || !strings(owner.paths)))) {
    throw new Error("Customer ownerSessions entries need paths arrays; installation stopped before writes.");
  }
  if (settings.programBoundaries !== undefined && (!Array.isArray(settings.programBoundaries) || settings.programBoundaries.some(policy => !object(policy) || typeof policy.repo !== "string" || !object(policy.programs) || Object.values(policy.programs).some(program => !object(program) || ["roots", "files", "patterns"].some(key => program[key] !== undefined && !strings(program[key])))))) {
    throw new Error("Customer program boundaries have invalid structure; installation stopped before writes.");
  }
  return config;
}

function prepareInstall(target, spec, root) {
  const inspect = file => { try { return fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
  const source = path.join(root, "module", spec.moduleSubdir);
  const check = relative => {
    let current = target;
    const parts = relative.split(path.sep);
    for (let i = 0; i <= parts.length; i++) {
      const stat = inspect(current);
      if (stat && (stat.isSymbolicLink() || (i < parts.length && !stat.isDirectory()) || (i === parts.length && !stat.isFile()))) {
        throw new Error("Installation destination is not a regular file or real directory; stopped before writes.");
      }
      if (i < parts.length) current = path.join(current, parts[i]);
    }
  };
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else check(path.join(spec.moduleSubdir, path.relative(source, file)));
    }
  };
  walk(source);
  const relative = path.join(spec.moduleSubdir, "config/config.json");
  const destination = path.join(target, relative);
  if (!inspect(destination)) return new Set();
  readCustomerConfig(destination);
  return new Set([path.join("config", "config.json")]);
}

module.exports = { readCustomerConfig, prepareInstall };
