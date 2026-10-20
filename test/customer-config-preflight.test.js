"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { prepareInstall } = require("../src/customer-config-preflight");
const vm = require("node:vm");

test("Windows configuration preservation uses the same separator as installer paths", () => {
  const destination = "C:\\target\\git-manager\\config\\config.json";
  const virtualFs = {
    lstatSync: file => ({ isSymbolicLink: () => false, isDirectory: () => file !== destination, isFile: () => file === destination }),
    readFileSync: () => '{"checkin":{}}',
    readdirSync: directory => directory.endsWith("\\config")
      ? [{ name: "config.json", isDirectory: () => false }]
      : [{ name: "config", isDirectory: () => true }],
  };
  const context = vm.createContext({ module: { exports: {} }, require: id => id === "node:fs" ? virtualFs : path.win32 });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../src/customer-config-preflight.js"), "utf8"), context);
  const preserved = context.module.exports.prepareInstall("C:\\target", { moduleSubdir: "git-manager" }, "C:\\release");
  assert.deepEqual([...preserved], ["config\\config.json"]);
});

function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gm-config-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, "release"), target = path.join(tmp, "target");
  const source = path.join(root, "module/git-manager/config");
  fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, "config.json"), '{"checkin":{"enforcedRepos":[],"ownerSessions":[]}}');
  const destination = path.join(target, "git-manager/config/config.json");
  const run = () => prepareInstall(target, { moduleSubdir: "git-manager" }, root);
  return { tmp, target, destination, run };
}

test("fresh configuration is installed, existing valid team permissions are preserved", t => {
  const f = fixture(t); assert.equal(f.run().size, 0);
  fs.mkdirSync(path.dirname(f.destination), { recursive: true });
  const custom = JSON.stringify({ checkin: { ownerSessions: [{ paths: ["/tmp/example-team-repo"], session: "team" }], enforcedRepos: ["/tmp/example-team-repo"], programBoundaries: [{ repo: "/tmp/example-team-repo", programs: { docs: { roots: ["docs"] } } }] } });
  fs.writeFileSync(f.destination, custom); fs.chmodSync(f.destination, 0o640);
  assert.deepEqual([...f.run()], ["config/config.json"]);
  assert.equal(fs.readFileSync(f.destination, "utf8"), custom);
  assert.equal(fs.statSync(f.destination).mode & 0o777, 0o640);
});

test("malformed permission configuration refuses without modifying it", t => {
  const f = fixture(t); fs.mkdirSync(path.dirname(f.destination), { recursive: true });
  for (const text of ["invalid", "null", '{"checkin":{"ownerSessions":[{}]}}', '{"checkin":{"enforcedRepos":true}}', '{"checkin":{"programBoundaries":[{"repo":"/tmp/x","programs":{"docs":{"roots":false}}}]}}']) {
    fs.writeFileSync(f.destination, text); assert.throws(f.run); assert.equal(fs.readFileSync(f.destination, "utf8"), text);
  }
});

test("configuration file symlinks and directory symlinks refuse before writes", t => {
  const f = fixture(t); fs.mkdirSync(path.dirname(f.destination), { recursive: true });
  fs.symlinkSync(path.join(f.tmp, "missing"), f.destination); assert.throws(f.run); assert.ok(fs.lstatSync(f.destination).isSymbolicLink());
  fs.unlinkSync(f.destination); const directory = path.dirname(f.destination), moved = directory + "-actual";
  fs.renameSync(directory, moved); fs.symlinkSync(moved, directory, "dir"); assert.throws(f.run); assert.ok(fs.lstatSync(directory).isSymbolicLink());
});

test("a symlink outside configuration cannot redirect another installed file", t => {
  const f = fixture(t); const source = path.join(f.tmp, "release/module/git-manager/src");
  fs.mkdirSync(source); fs.writeFileSync(path.join(source, "runtime.js"), "new");
  const outside = path.join(f.tmp, "outside"); fs.mkdirSync(outside);
  fs.mkdirSync(path.join(f.target, "git-manager")); fs.symlinkSync(outside, path.join(f.target, "git-manager/src"), "dir");
  assert.throws(f.run); assert.deepEqual(fs.readdirSync(outside), []);
});
