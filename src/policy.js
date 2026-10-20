"use strict";

function isAllowedGitHubRemote(remote, owner) {
  if (!remote || !owner) return false;
  const escapedOwner = owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ssh = new RegExp(`^git@github\\.com:${escapedOwner}/[A-Za-z0-9_.-]+(?:\\.git)?$`);
  if (ssh.test(remote)) return true;
  try {
    const url = new URL(remote);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port ||
        url.username || url.password || url.search || url.hash) return false;
    return new RegExp(`^/${escapedOwner}/[A-Za-z0-9_.-]+(?:\\.git)?$`).test(url.pathname);
  } catch {
    return false;
  }
}

module.exports = { isAllowedGitHubRemote };

