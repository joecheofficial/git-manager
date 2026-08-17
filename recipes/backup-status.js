"use strict";

const { remoteStatus, ghAuthStatus } = require("../github");

module.exports.runRecipe = (input = {}) => {
  const status = remoteStatus(input);
  const auth = ghAuthStatus();

  if (!auth.authenticated) {
    return {
      status: "ok",
      reply: "Your work is saved locally, but you are not signed in to GitHub to back it up online.",
      remoteStatus: status,
      auth
    };
  }

  if (!status.hasRemote) {
    return {
      status: "ok",
      reply: "Your work is saved locally, but not yet connected to GitHub for cloud backup.",
      remoteStatus: status,
      auth
    };
  }

  if (status.ahead > 0 && status.behind > 0) {
    return {
      status: "ok",
      reply: `You have ${status.ahead} save${status.ahead === 1 ? "" : "s"} not yet backed up to GitHub, and ${status.behind} new update${status.behind === 1 ? "" : "s"} waiting to be downloaded.`,
      remoteStatus: status,
      auth
    };
  }

  if (status.ahead > 0) {
    return {
      status: "ok",
      reply: `You have ${status.ahead} save${status.ahead === 1 ? "" : "s"} not yet backed up to GitHub.`,
      remoteStatus: status,
      auth
    };
  }

  if (status.behind > 0) {
    return {
      status: "ok",
      reply: `There ${status.behind === 1 ? "is 1 new update" : `are ${status.behind} new updates`} on GitHub waiting to be downloaded.`,
      remoteStatus: status,
      auth
    };
  }

  return {
    status: "ok",
    reply: "Your work is backed up.",
    remoteStatus: status,
    auth
  };
};
