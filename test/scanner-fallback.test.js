"use strict";

// support#8 item 2: without gitleaks the built-in scanner is used, and that
// fallback must announce itself (result field, recipe reply, one stderr line).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");

function gitDirectory() {
  for (const candidate of ["/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"]) {
    if (fs.existsSync(path.join(candidate, "git")) && !fs.existsSync(path.join(candidate, "gitleaks"))) return candidate;
  }
  return null;
}

test("without gitleaks the fallback scanner says so once on stderr and in every result and recipe reply", (t) => {
  const gitDir = gitDirectory();
  if (!gitDir) return t.skip("no git outside a directory that also holds gitleaks");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "git manager fallback "));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", repo]);
  fs.writeFileSync(path.join(repo, "notes.txt"), "nothing secret\n");
  execFileSync("git", ["-C", repo, "add", "notes.txt"]);
  const script = `
    const safety = require(${JSON.stringify(path.join(ROOT, "safety.js"))});
    const recipe = require(${JSON.stringify(path.join(ROOT, "recipes", "scan-secrets.js"))});
    const check = require(${JSON.stringify(path.join(ROOT, "recipes", "safety-check.js"))});
    const first = safety.scanForSecrets({ repositoryRoot: process.argv[1], staged: true });
    const reply = recipe.runRecipe({ repositoryRoot: process.argv[1] }).reply;
    const gate = check.runRecipe({ repositoryRoot: process.argv[1] });
    process.stdout.write(JSON.stringify({ first, reply, gate: { reply: gate.reply, notice: gate.scannerNotice, safe: gate.safe } }));
  `;
  const result = spawnSync(process.execPath, ["-e", script, repo], { encoding: "utf8", env: { ...process.env, PATH: gitDir } });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.first.scanner, "builtin-regex");
  assert.equal(out.first.clean, true);
  assert.match(out.first.scannerNotice, /gitleaks is not installed.*brew install gitleaks/);
  assert.match(out.reply, /scanner: builtin-regex.*Note: gitleaks is not installed/);
  assert.equal(out.gate.safe, true);
  assert.match(out.gate.reply, /Note: gitleaks is not installed/);
  assert.equal(out.gate.notice, out.first.scannerNotice);
  const announced = result.stderr.split("\n").filter((line) => line.startsWith("[git-manager] gitleaks"));
  assert.equal(announced.length, 1, "announced once per process");
});
