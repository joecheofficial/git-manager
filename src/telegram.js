"use strict";
// Critical-only Telegram path for git-manager.
//
// Why this exists: on 2026-07-25 the autosave net was switched off by policy and
// git-manager noticed within the hour — but telegram.enabled was false, so the
// finding sat in data/last-run.json for 2.5 days waiting for a human to open a
// JSON file. A watchdog that cannot reach the person it protects is decoration.
//
// Noise bar (agents/BOT_ARCHITECTURE.md): an all-ok run is silent. Only critical
// findings send. messageType 'alert' is protected — unsuppressible, no Noise
// button — which is correct for "your safety net is down" and wrong for anything
// softer, so nothing below critical may use this path.

const fs = require("./volume-probe").guardFs(require("node:fs"));
const path = require("node:path");
const crypto = require("node:crypto");

function transportMissing() {
  throw Object.assign(new Error("telegram transport not installed"), { code: "TRANSPORT_MISSING" });
}

// Customer installs do not include the All Sorted shared Telegram transport.
let getReportTelegramTarget = transportMissing;
let sendMessage = transportMissing;
// The shared Telegram transport lives outside this module, so it is never
// required from here: both senders stay transportMissing.

const ALERT_STATE_FILE = path.join(__dirname, "..", "data", "alert-state.json");
// Re-alert an unchanged critical state at most once a day: silence is wrong,
// but an hourly repeat of the same line trains the reader to swipe it away.
const REALERT_HOURS = 24;

function readAlertState() {
  try { return JSON.parse(fs.readFileSync(ALERT_STATE_FILE, "utf8")); }
  catch { return { signature: null, lastSentAt: null }; }
}

function writeAlertState(s) {
  try {
    fs.mkdirSync(path.dirname(ALERT_STATE_FILE), { recursive: true });
    fs.writeFileSync(ALERT_STATE_FILE, JSON.stringify(s, null, 2));
  }
  catch { /* never fail a sweep over its own bookkeeping */ }
}

function signatureOf(criticals) {
  const key = criticals.map((f) => `${f.id}:${f.repo}`).sort().join("|");
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 12);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatAlert(criticals, ranAt) {
  const lines = [`🔴 <b>git-manager</b> — ${criticals.length} critical`, ""];
  for (const f of criticals) {
    lines.push(`<b>${escapeHtml(f.repo)}</b>`);
    lines.push(escapeHtml(f.message));
    if (f.action) lines.push(`→ ${escapeHtml(f.action)}`);
    lines.push("");
  }
  lines.push(`<i>${ranAt} · agents/git-manager</i>`);
  return lines.join("\n");
}

/**
 * Send a Telegram alert for critical findings.
 * Returns {sent, reason} — never throws, never blocks the sweep.
 */
async function notifyCritical(findings, { ranAt, config, now = Date.now(), send = sendMessage, target = getReportTelegramTarget } = {}) {
  if (!config?.telegram?.enabled) return { sent: false, reason: "telegram disabled in config" };

  const criticals = (findings || []).filter((f) => f.severity === "critical");
  if (!criticals.length) return { sent: false, reason: "no critical findings" };

  const signature = signatureOf(criticals);
  const state = readAlertState();
  const ageH = state.lastSentAt ? (now - Date.parse(state.lastSentAt)) / 3600000 : Infinity;
  if (state.signature === signature && ageH < REALERT_HOURS) {
    return { sent: false, reason: `same critical state alerted ${Math.round(ageH)}h ago` };
  }

  let botToken, chatId;
  try { ({ botToken, chatId } = target()); }
  catch (e) {
    return { sent: false, reason: e?.code === "TRANSPORT_MISSING" ? "telegram transport not installed" : "telegram target unresolvable" };
  }
  if (!botToken || !chatId) return { sent: false, reason: "telegram token/chat not configured" };

  try {
    await send(`https://api.telegram.org/bot${botToken}`, chatId, formatAlert(criticals, ranAt), {
      agentId: "git-manager",
      messageType: "alert",
      extraPayload: { parse_mode: "HTML", disable_web_page_preview: true },
    });
  } catch (e) {
    if (e?.code === "TRANSPORT_MISSING") return { sent: false, reason: "telegram transport not installed" };
    return { sent: false, reason: `send failed: ${e.message}` };
  }

  writeAlertState({ signature, lastSentAt: new Date(now).toISOString() });
  return { sent: true, reason: null, signature };
}

module.exports = { notifyCritical, signatureOf, formatAlert, REALERT_HOURS };
