"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { resolveRepositoryRoot: repoPath } = require("./profile");

function redactSecret(str) {
  if (!str || typeof str !== "string") return "[REDACTED]";
  if (str.includes("PRIVATE KEY")) {
    return "-----BEGIN PRIVATE KEY...[REDACTED]-----";
  }
  const trimmed = str.trim();
  if (trimmed.length <= 8) {
    return trimmed.slice(0, 2) + "...[REDACTED]";
  }
  return trimmed.slice(0, 4) + "..." + trimmed.slice(-4);
}

const SECRET_PATTERNS = [
  {
    kind: "OpenAI API Key",
    regex: /\b(sk-[a-zA-Z0-9T3BlbkFJ]{20,}|sk-proj-[a-zA-Z0-9_\-]{20,}|sk-admin-[a-zA-Z0-9_\-]{20,})\b/g,
  },
  {
    kind: "GitHub Token",
    regex: /\b(gho_[a-zA-Z0-9]{36}|ghp_[a-zA-Z0-9]{36}|ghs_[a-zA-Z0-9]{36}|ghr_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59})\b/g,
  },
  {
    kind: "AWS Access Key",
    regex: /\b(AKIA[0-9A-Z]{16})\b/g,
  },
  {
    kind: "Stripe Key",
    regex: /\b(sk_live_[0-9a-zA-Z]{24,}|pk_live_[0-9a-zA-Z]{24,})\b/g,
  },
  {
    kind: "Google API Key",
    regex: /\b(AIza[0-9A-Za-z\-_]{35})\b/g,
  },
  {
    kind: "Slack Token",
    regex: /\b(xox[baprs]-[0-9a-zA-Z]{10,48})\b/g,
  },
  {
    kind: "Private Key (PEM)",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
  },
];

function hasGitleaks() {
  try {
    execFileSync("gitleaks", ["version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

// The built-in scanner is a fallback, never a silent one: every result it
// produces carries scannerNotice, and the first fallback in a process also
// prints one line to stderr (support#8 item 2).
const GITLEAKS_INSTALL = "brew install gitleaks";
let fallbackAnnounced = false;

function fallbackNotice(reason) {
  const notice = reason === "failed"
    ? `gitleaks failed to run, so Git Manager used its built-in pattern scanner, which misses many key formats. Check the gitleaks install (${GITLEAKS_INSTALL}).`
    : `gitleaks is not installed, so Git Manager used its built-in pattern scanner, which misses many key formats. Install gitleaks for full coverage: ${GITLEAKS_INSTALL}`;
  if (!fallbackAnnounced) {
    fallbackAnnounced = true;
    try { process.stderr.write(`[git-manager] ${notice}\n`); } catch {}
  }
  return notice;
}

function scanForSecrets(options = {}) {
  const staged = options.staged !== false;
  const repo = repoPath(options.repositoryRoot || options.root || options.projectRoot);

  let fallbackReason = "missing";
  if (hasGitleaks()) {
    fallbackReason = "failed";
    const reportPath = path.join(os.tmpdir(), `gitleaks-report-${process.pid}-${Date.now()}.json`);
    try {
      const args = ["git", "--no-banner", "--redact", "--report-format", "json", "--report-path", reportPath];
      if (staged) {
        args.push("--staged");
      }
      try {
        execFileSync("gitleaks", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        // Exit code 1 means findings were found; other exit codes signal failure.
        if (err.status !== 1) {
          throw err;
        }
      }

      let rawFindings = [];
      if (fs.existsSync(reportPath)) {
        const content = fs.readFileSync(reportPath, "utf8").trim();
        if (content) {
          rawFindings = JSON.parse(content);
        }
      }

      const findings = rawFindings.map((item) => ({
        file: item.File || item.file || "unknown",
        line: item.StartLine || item.line || 1,
        kind: item.Description || item.RuleID || "Secret Credential",
        redactedMatch: redactSecret(item.Secret || item.Match || ""),
      }));

      return {
        scanner: "gitleaks",
        clean: findings.length === 0,
        findings,
      };
    } catch (err) {
      // Gitleaks failed unexpectedly, fall back to built-in scanner with warning
    } finally {
      try {
        if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
      } catch {}
    }
  }

  // Built-in Regex Scanner
  const scannerNotice = fallbackNotice(fallbackReason);
  const findings = [];
  try {
    const gitArgs = staged ? ["diff", "--cached", "--name-only"] : ["diff", "HEAD", "--name-only"];
    let filesRaw = "";
    try {
      filesRaw = execFileSync("git", ["-C", repo, ...gitArgs], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch (err) {
      return {
        scanner: "builtin-regex",
        scannerNotice,
        clean: false,
        findings: [],
        warning: "Scanning was impossible (git diff failed). Failing closed.",
      };
    }

    const files = filesRaw.split("\n").map((f) => f.trim()).filter(Boolean);

    for (const file of files) {
      const baseName = path.basename(file);
      if (baseName.startsWith(".env")) {
        findings.push({
          file,
          line: 1,
          kind: "Environment File (.env)",
          redactedMatch: `Committed environment file: ${file}`,
        });
      }
    }

    const diffArgs = staged ? ["diff", "--cached", "-U0"] : ["diff", "HEAD", "-U0"];
    let diffText = "";
    try {
      diffText = execFileSync("git", ["-C", repo, ...diffArgs], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch {}

    if (diffText) {
      const diffLines = diffText.split("\n");
      let currentFile = "";
      let currentLine = 1;

      for (const line of diffLines) {
        if (line.startsWith("+++ b/")) {
          currentFile = line.slice(6).trim();
        } else if (line.startsWith("@@ ")) {
          const match = line.match(/\+([0-9]+)/);
          if (match) {
            currentLine = parseInt(match[1], 10);
          }
        } else if (line.startsWith("+") && !line.startsWith("+++")) {
          const addedContent = line.slice(1);
          for (const pattern of SECRET_PATTERNS) {
            pattern.regex.lastIndex = 0;
            let match;
            while ((match = pattern.regex.exec(addedContent)) !== null) {
              findings.push({
                file: currentFile || "staged",
                line: currentLine,
                kind: pattern.kind,
                redactedMatch: redactSecret(match[0]),
              });
            }
          }
          currentLine += 1;
        }
      }
    }

    return {
      scanner: "builtin-regex",
      scannerNotice,
      clean: findings.length === 0,
      findings,
    };
  } catch (err) {
    return {
      scanner: "builtin-regex",
      scannerNotice,
      clean: false,
      findings: [],
      warning: `Scanning failed: ${err.message}. Failing closed for platform safety.`,
    };
  }
}

function secretRemediation(finding = {}) {
  const kindStr = String(finding.kind || "").toLowerCase();
  let revokeUrl = null;

  if (kindStr.includes("openai")) {
    revokeUrl = "https://platform.openai.com/api-keys";
  } else if (kindStr.includes("github")) {
    revokeUrl = "https://github.com/settings/tokens";
  } else if (kindStr.includes("aws")) {
    revokeUrl = "https://console.aws.amazon.com/iam/home#/users";
  } else if (kindStr.includes("stripe")) {
    revokeUrl = "https://dashboard.stripe.com/apikeys";
  } else if (kindStr.includes("google")) {
    revokeUrl = "https://console.cloud.google.com/apis/credentials";
  } else if (kindStr.includes("slack")) {
    revokeUrl = "https://api.slack.com/apps";
  }

  return {
    file: finding.file || "unknown",
    line: finding.line || 1,
    kind: finding.kind || "Secret",
    summary: "ROTATION-FIRST REMEDIATION REQUIRED: A committed key is compromised the moment it is committed. Deleting the commit or removing the file does NOT un-compromise the key.",
    revokeUrl,
    checklist: [
      "1. IMMEDIATELY revoke or rotate this credential at the provider website.",
      revokeUrl ? `   Revoke URL: ${revokeUrl}` : "   Log in to the provider dashboard to deactivate this key.",
      "2. Issue a new API key or token once the compromised key is disabled.",
      "3. Update your local environment variables or secret manager with the new credential.",
      "4. Add .env or the file containing secrets to .gitignore so it is never committed again.",
      "5. Assume any credential committed or pushed has already been indexed by automated scanners.",
    ],
  };
}

function checkLargeFiles(options = {}) {
  const limitMb = Number(options.limitMb) || 50;
  const repo = repoPath(options.repositoryRoot || options.root || options.projectRoot);
  const warnings = [];
  const blockers = [];

  try {
    let files = [];
    try {
      const raw = execFileSync("git", ["-C", repo, "diff", "--cached", "--name-only"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      files = raw.split("\n").map((s) => s.trim()).filter(Boolean);
    } catch {}

    if (files.length === 0) {
      try {
        const rawStatus = execFileSync("git", ["-C", repo, "status", "--porcelain"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
        files = rawStatus.split("\n").filter(Boolean).map((l) => l.slice(3).trim());
      } catch {}
    }

    for (const file of files) {
      const fullPath = path.join(repo, file);
      try {
        const st = fs.statSync(fullPath);
        if (st.isFile()) {
          const sizeMb = st.size / (1024 * 1024);
          const formattedMb = `${sizeMb.toFixed(2)} MB`;

          if (sizeMb >= 100) {
            blockers.push({
              file,
              sizeMb: formattedMb,
              bytes: st.size,
              message: `File '${file}' is ${formattedMb}, exceeding GitHub's 100 MB hard limit. GitHub will block pushes containing this file.`,
            });
          } else if (sizeMb >= limitMb) {
            warnings.push({
              file,
              sizeMb: formattedMb,
              bytes: st.size,
              message: `File '${file}' is ${formattedMb}. GitHub issues a warning for files larger than ${limitMb} MB.`,
            });
          }
        }
      } catch {}
    }

    return {
      ok: blockers.length === 0,
      warnings,
      blockers,
    };
  } catch (err) {
    return {
      ok: false,
      warnings: [],
      blockers: [{ file: "repository", message: `Failed to check file sizes: ${err.message}` }],
    };
  }
}

function suggestGitignore(options = {}) {
  const repo = repoPath(options.projectRoot || options.repositoryRoot || options.root);

  const mandatoryRules = [
    "# Environment variables (contains live API keys)",
    ".env*",
    "",
    "# Dependency folders",
    "node_modules/",
    "",
    "# System metadata files",
    ".DS_Store",
    "Thumbs.db",
    "",
    "# Large media and binary assets (exceeds safe Git sizes)",
    "*.mp4",
    "*.mov",
    "*.psd",
    "*.zip",
    "*.sqlite",
  ];

  let projectType = "generic";
  const extraRules = [];

  try {
    if (fs.existsSync(path.join(repo, "package.json"))) {
      projectType = "Node.js";
      extraRules.push("# Node.js build outputs", "dist/", "build/", ".next/", ".nuxt/", "npm-debug.log*");
    } else if (fs.existsSync(path.join(repo, "requirements.txt")) || fs.existsSync(path.join(repo, "pyproject.toml"))) {
      projectType = "Python";
      extraRules.push("# Python virtual environments and caches", "__pycache__/", "*.pyc", ".venv/", "venv/");
    } else if (fs.existsSync(path.join(repo, "Gemfile"))) {
      projectType = "Ruby";
      extraRules.push("# Ruby vendor and log files", ".bundle/", "vendor/bundle/", "log/*.log");
    }
  } catch {}

  const proposedEntries = [...mandatoryRules];
  if (extraRules.length > 0) {
    proposedEntries.push("", ...extraRules);
  }

  const content = proposedEntries.join("\n") + "\n";

  return {
    projectType,
    proposedEntries,
    content,
  };
}

function writeGitignore(options = {}) {
  const repo = repoPath(options.projectRoot || options.repositoryRoot || options.root);
  const confirm = options.confirm;
  const content = options.content;

  if (confirm !== "WRITE") {
    return {
      status: "needs_approval",
      reply: "Preview only. Resubmit with confirm='WRITE' to append these rules to .gitignore.",
      proposedContent: content,
    };
  }

  if (!content || typeof content !== "string") {
    throw new Error("No .gitignore content provided to write.");
  }

  const gitignorePath = path.join(repo, ".gitignore");
  let existingContent = "";
  if (fs.existsSync(gitignorePath)) {
    existingContent = fs.readFileSync(gitignorePath, "utf8");
  }

  const existingLines = new Set(existingContent.split("\n").map((l) => l.trim()));
  const newLines = content.split("\n");
  const linesToAppend = [];

  for (const line of newLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      linesToAppend.push(line);
    } else if (!existingLines.has(trimmed)) {
      linesToAppend.push(line);
    }
  }

  const appendStr = linesToAppend.join("\n");
  if (appendStr.trim()) {
    const prefix = existingContent && !existingContent.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(gitignorePath, prefix + appendStr, "utf8");
  }

  return {
    status: "ok",
    reply: "Successfully updated .gitignore with safety rules.",
    gitignorePath,
  };
}

function preCommitCheck(options = {}) {
  const secretResults = scanForSecrets(options);
  const largeFileResults = checkLargeFiles(options);

  const blockers = [];
  const warnings = [...largeFileResults.warnings];

  if (!secretResults.clean) {
    for (const finding of secretResults.findings) {
      blockers.push({
        type: "secret",
        file: finding.file,
        line: finding.line,
        kind: finding.kind,
        message: `CRITICAL: Staged secret detected (${finding.kind}) in ${finding.file}:${finding.line || 1}. ${finding.redactedMatch}`,
        remediation: secretRemediation(finding),
      });
    }
  }

  for (const blocker of largeFileResults.blockers) {
    blockers.push({
      type: "large_file",
      file: blocker.file,
      sizeMb: blocker.sizeMb,
      message: blocker.message,
    });
  }

  const safe = blockers.length === 0;

  return {
    safe,
    blockers,
    warnings,
    ...(secretResults.scannerNotice ? { scannerNotice: secretResults.scannerNotice } : {}),
    secretResults,
    largeFileResults,
  };
}

module.exports = {
  scanForSecrets,
  secretRemediation,
  checkLargeFiles,
  suggestGitignore,
  writeGitignore,
  preCommitCheck,
};
