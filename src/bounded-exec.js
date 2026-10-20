"use strict";
const { execFile } = require("node:child_process");

// execFile's built-in timeout still waits for close. A process in kernel I/O
// may never close, so own the deadline and release its pipe/process handles.
function boundedExecFile(command, args, options = {}, execute = execFile) {
  return new Promise((resolve, reject) => {
    let child, timer, settled = false;
    const finish = (error, stdout = "", stderr = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    };
    timer = setTimeout(() => {
      try { if (child?.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ }
      child?.stdin?.destroy();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      child?.unref?.();
      finish(Object.assign(new Error("child deadline exceeded"), { code: "ETIMEDOUT" }));
    }, options.timeout ?? 15000);
    try {
      child = execute(command, args, { ...options, detached: true }, (error, stdout, stderr) => {
        // Some injected callers use the promisified execFile result shape.
        if (stdout && typeof stdout === "object" && !Buffer.isBuffer(stdout)) ({ stdout, stderr } = stdout);
        finish(error, stdout, stderr);
      });
    } catch (error) { finish(error); }
  });
}
module.exports = { boundedExecFile };
