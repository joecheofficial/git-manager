"use strict";

// A refusal must explain how to continue without erasing either writer's work.
// This is guidance, not permission to bypass an owner, conflict, or publication gate.
function advise(reasons, { claim = null, health = null, collisions = null, checkpoint = null, worktreePresent = null } = {}) {
  const text = reasons.join("\n");
  let kind = "inspect";
  let next = "Inspect the named repository state and retry after its owner resolves the issue.";

  if (/owned by the .* session|path overlap with claim|task already claimed|claim reactivation blocked/i.test(text)) {
    kind = "owner_handoff";
    next = "Continue with the named owner or active claim. Keep separate work in its own claimed worktree; do not overwrite that owner's files.";
  } else if (/mid-[A-Z_]+|index\.lock present|claims store busy|claims lock timed out/i.test(text)) {
    kind = "active_operation";
    next = "Inspect the active Git operation or lock owner, let it finish, then retry. Do not remove a live lock or abort another session's operation.";
  } else if (/uncommitted changes|staged changes|same files in the primary checkout/i.test(text)) {
    kind = "uncommitted_work";
    next = "Preserve each writer's staged and working versions, commit intended changes with normal hooks in its own worktree, then retry integration. Do not discard or blanket-stash either version.";
  } else if (/merge conflicts/i.test(text)) {
    kind = "merge_conflict";
    next = "Merge the target into the claimed worktree, resolve the named files by intent, run the relevant checks, commit that resolution, then retry finish. Keep both branches until verified.";
  } else if (/primary is on |branch changed|HEAD moved|claim changed/i.test(text)) {
    kind = "state_changed";
    next = "Re-inventory the current branch, HEAD, index and claim before retrying. Preserve any new work in its owner's worktree; do not reset refs.";
  } else if (/test command failed|tests are known failing/i.test(text)) {
    kind = "verification_failed";
    next = "Fix the reported failure on the claimed branch, commit with normal hooks, rerun the check, then retry finish.";
  }

  return {
    kind,
    safeToRetryUnchanged: false,
    preserved: claim ? {
      claimId: claim.id,
      branch: claim.branch,
      worktree: claim.worktree,
      worktreePresent,
      targetBranch: claim.targetBranch,
    } : { existingWorkUntouched: true },
    checkpoint: checkpoint || null,
    activeClaims: (collisions?.claims || []).filter(c => c.status === "active").map(c => ({ id: c.id, worktree: c.worktree, paths: c.paths })),
    health: health ? { blockers: health.blockers, warnings: health.warnings } : null,
    next,
    boundary: "Git Manager can preserve and route repository work. It cannot override external approval controls or decide conflict intent.",
  };
}

module.exports = { advise };
