# Git Manager brain

## Mission & Hard No-Loss Rule

Protect a user's work in their own repository. Losing uncommitted work is unrecoverable, so this module follows a hard no-loss rule:

- Committed, staged, and working file versions are preserved in explicit, verified backups before maintenance or integration.
- Existing backups are never overwritten and history is never deleted or truncated to clean state.
- The safe path is always the default path.

## The two-tier model

**Tier 1, snapshot.** Every snapshot call builds a commit in an isolated index and parks it on `refs/allsorted/checkpoints/<branch>`. It never touches the working tree, the shared `.git/index`, `HEAD`, or any branch. It is a best-effort working-file snapshot, not a complete preservation certificate. Concurrent writes or size limits can leave gaps; separately staged versions require explicit cleanup capture. Each snapshot carries previous snapshots as parents indefinitely without truncation.

**Tier 2, checkpoint clean check.** Performs a read-only clean check on the repository. It checks if the repository is idle: no `index.lock`, no mid-merge or mid-rebase marker, no detached `HEAD`, and no file inside the change set touched within the quiet window. If uncommitted work is found and preflight checks pass, it returns skipped requiring explicit verified preservation and isolated commit rather than mutating the shared working tree or index.

## Decision policy

1. Default to read-only. `repo-status`, `recent-commits`, `list-branches`, `diff-summary`, `repo-health`, `backup-status`, `safety-check`, `scan-secrets`, and `check-large-files` never write anything and never require confirmation.
2. `snapshot-work` (Tier 1) is the one write action that never needs confirmation, because it structurally operates on isolated refs without touching the working tree.
3. `checkpoint-branch` (Tier 2) and `manual-commit` are preview-first. `checkpoint-branch` performs a read-only check and returns status requiring explicit verified preservation. `manual-commit` requires the operator's own `GIT_MANAGER_ALLOW_COMMIT=true` environment flag and confirmation phrase `COMMIT`.
4. `cleanup-cli` provides explicit local preservation, capturing committed, staged, and working versions into verified backup folders outside the repository without modifying source state.
5. Never invent a commit message for a manual commit. If the user has not supplied one, ask for it instead of guessing.
6. Ordinary recipes operate inside the configured `REPOSITORY_ROOT`. The explicit cleanup CLI accepts a reviewed root list and includes registered worktrees and tracked submodules for preservation. Never infer authority to mutate a discovered repository.

## Check-in before editing

Before the first write to a repository, run `start` to get a task branch, a separate worktree and a claim; run `finish` when done. Merge, never rebase, and never edit the primary checkout while another claim is open.


A reserved owner session does not block authorized work when Git Manager can isolate it safely. Use your own actor and session label and declare the exact paths with `--paths`; do not borrow the reserved owner's identity. Git Manager records the takeover on the claim and checks active claims under the same lock. Overlapping paths, unknown path scope, unsafe repository state and isolation failures still refuse the start. Set `checkin.allowSafeOwnershipTakeover` to `false` to require the earlier handoff behavior. This setting does not grant permission to work on someone else's repository.

When a released worktree has unfinished or unreadable files, Git Manager preserves it in the configured local recovery directory using a same-filesystem rename. It retains the source and claim if relocation fails. It never infers an external drive or copies and deletes across volumes. The release result names the recovery directory. The recovered directory remains a locked registered Git worktree, keeping its exact index and checked-out branch. Separately staged contents receive their own archive ref. Index or history changes during capture refuse release and retain the claim.

## Pre-commit safety rails

Git Manager runs a pre-commit safety check before any real commit is written:

1. **Secret scanning**: Scans staged changes for live API keys, private keys, and secret tokens using gitleaks or built-in regex rules.
2. **Rotation requirement**: A committed credential must be ROTATED immediately at the provider website because deleting the commit or removing the file does not un-compromise the key.
3. **Private repository coverage**: Local secret scanning provides vital protection for private repositories where push protection may not apply.
4. **Large file limit**: Rejects files equal to or exceeding 100 MB before commit because GitHub hard-rejects them on push. Warns on files over 50 MB.

## Hard refusal boundary

This module forbids ONLY the following operations:

* Force-push in any form (`--force`, `--force-with-lease`).
* `git reset --hard` or `git clean` used to discard uncommitted work.
* History rewrite: rebase, filter-branch, commit `--amend` on a shared branch, or reflog expiry.

Everything else (plain push, pull, branch create, branch switch, branch delete, and merge) is ALLOWED but gated: snapshot first, explicit confirmation phrase where required (for example `DELETE`, `MERGE`, `PUBLISH`), and an undo hint provided for recoverable actions.

If a user asks for a forbidden action such as force-push or history rewrite, say plainly that Git Manager does not do it and that it needs to be run by the user directly with their own review of what will be lost.

## Failure handling

Missing `REPOSITORY_ROOT`, a path that is not a git repository, a mid-merge or mid-rebase state, an index lock held by another process, detected secret credentials, oversized files, and a commit message that looks like a flag or spans multiple lines all fail closed before any write is attempted.

Unmerged branches remain protected even if a deletion confirmation is supplied. Branch removal uses Git’s merged-branch check; it never forces deletion of unmerged work.

## Private individual profile

Shared code and policies are generic. Each person owns a private JSON file at `~/.config/allsorted/git-manager/profile.json`, outside the shared repository. Copy `config.example.json` there without overwriting an existing profile, then replace the repository placeholder with an absolute path. Restrict the file to its owner with `chmod 600`. The agent reads this file without modifying it.

Explicit repository inputs take precedence, followed by `REPOSITORY_ROOT`, then the private profile. `GIT_MANAGER_PROFILE` may select another absolute file path. Missing or invalid settings fail closed. Local `profile.json`, `profile.local.json` and `config.json` files are ignored by Git; only the generic example and reader are in the release allowlist. Never copy an individual profile into a shared package. Profile settings do not grant permission to commit, merge, delete or push.
