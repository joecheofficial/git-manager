# Git Manager

Local Git hygiene, two-tier checkpointing, explicit preservation backups, GitHub publishing, line-of-work branch management, and pre-commit safety rails for your repository. Ordinary recipes use the configured repository; explicit cleanup inventories the supplied roots and their registered worktrees and submodules.

## Hard No-Loss Rule

Preservation takes priority over a clean status:

- Never clobber unpreserved work or overwrite backup destinations.
- Never delete history or purge refs to clean up state.
- Explicit cleanup captures preserve committed, staged, and working tree versions into separate verified backups outside the source repository before any maintenance or integration.

## Installation and Configuration

Set `REPOSITORY_ROOT` in your environment to the absolute path of your repository. `node src/index.js demo` is fully offline and makes no changes.

```bash
export REPOSITORY_ROOT="/path/to/your/repo"
```

## Main Commands

### Read-only commands (no confirmation needed)

* `status`: inspect working tree status (`git status --short --branch`)
* `branches`: list local and remote lines of work
* `log [count]`: show recent commit summaries
* `diff-stat`: inspect size of uncommitted changes
* `health`: check working-tree status and `git fsck --no-dangling`
* `backup-status`: check remote synchronization status with GitHub
* `safety-check`: run pre-commit scan for secret credentials and oversized files
* `scan-secrets`: scan staged files for API keys and secret tokens
* `check-large-files`: check staged files against GitHub size limits
* `cleanup`: inventory or capture explicit backups of dirty repositories outside the source root

### Checkpointing and Committing

* `snapshot`: Tier 1. Parks current state on `refs/allsorted/checkpoints/<branch>` through an isolated index. Never touches working tree, index, HEAD, or any branch. Snapshots retain previous parents indefinitely.
* `checkpoint`: Tier 2. Performs a read-only clean check on the repository. If uncommitted work is present, it returns skipped requiring explicit verified preservation rather than performing shared-index autocommits.
* `commit --message "..." [--confirm COMMIT]`: Manual commit with preview-first confirmation and pre-commit safety gating. Requires `GIT_MANAGER_ALLOW_COMMIT=true`.

### Line of Work (Branch) Management

* `create-branch`: create and switch to a new line of work
* `switch-branch`: switch to a line of work, snapshotting uncommitted changes first
* `merge-branch`: merge a line of work into the current branch (gated by confirmation phrase `MERGE`)
* `delete-branch`: delete a line of work (gated by confirmation phrase `DELETE`, `ownershipReviewed: true`, explicit base ref, 30-day default / reflog+HEAD last-use policy, and explicit `backupDir` or configured `branchCleanup.backupRoot` in private profile)
* `cleanup-branches`: identify and remove stale or merged lines of work (gated by confirmation phrase `CLEANUP`, `ownershipReviewed: true`, explicit base ref, 30-day default / reflog+HEAD last-use policy, and explicit `backupDir` or configured `branchCleanup.backupRoot` in private profile)

### Check in before you edit

Run `node bin/git-manager.js start <repo> --task <name>` before the first write. It fetches from GitHub first (so a task never starts from a stale copy; `--no-fetch` skips it), then creates a branch and a separate worktree for that task and records a claim, so two sessions never overwrite each other. When you are done, `finish` merges the branch (merge, never rebase), removes the worktree and releases the claim. `claims` lists open claims and `release` drops one.


A reserved owner session does not block authorized work when Git Manager can isolate it safely. Use your own actor and session label and declare the exact paths with `--paths`; do not borrow the reserved owner's identity. Git Manager records the takeover on the claim and checks active claims under the same lock. Overlapping paths, unknown path scope, unsafe repository state and isolation failures still refuse the start. Set `checkin.allowSafeOwnershipTakeover` to `false` to require the earlier handoff behavior. This setting does not grant permission to work on someone else's repository.

The owning session can narrow its own claim with `amend-scope <claim-id> --paths a,b` (add `--dry-run` to preview). This also works on an expired claim, but only to narrow a known concrete reservation: the new paths must sit inside the old ones, must still cover every changed file, and must not overlap another active claim. Narrowing an expired claim does not reactivate it or refresh its activity time.

Declared `--paths` must stay inside the repository. Any `..` segment is refused before anything else runs, so `src/..` cannot quietly become a whole-repository claim.

Each worktree starts from the exact commit Git Manager resolved when it reserved the claim (recorded as `baseSha`), not from a branch name that might move a moment later. If the claim's paths change while `finish` runs its test command, or while `release` runs its checks (for example an `amend-scope` from another shell), the command holds and keeps the worktree. Run it again.

#### Scoped checkouts

`start <repo> --task <name> --paths src/feature --dependencies lib,config` creates a sparse worktree. It contains only the claimed paths plus the read-only roots the task needs. Git Manager records a manifest of every file it checked out, pinned to the base commit. `finish` and `release` hold when any of the following is true:

* a commit or an uncommitted change touches a tracked file outside `--paths`
* the sparse roots or the manifest drifted
* ignored or stray files sit in the worktree that removing it would delete

The scope check compares your branch with its merge base on the claim's target branch, so files that arrived by merging the target branch into your claim branch do not count as outside your scope. If the target branch cannot be found, it compares with the recorded `baseSha`.

Scoped checkouts need Git 2.34 or newer and `extensions.worktreeConfig` enabled on the repository, so the sparse settings stay in the worktree's own config and never touch your main checkout. Enable it once with `git -C /path/to/repo config extensions.worktreeConfig true`. If your repository config sets `core.bare` or `core.worktree`, move those settings to `config.worktree` first, as the Git documentation describes. When either requirement is missing, Git Manager does not switch it on for you. It uses a full checkout and says why in a warning. `--dry-run` shows the plan, the materialization and the estimated size.

#### Large full checkouts need explicit intent

Git Manager estimates how many bytes a worktree will write. Above `checkin.fullCheckoutCeilingMiB` (default 256 MiB), `start` refuses a full checkout unless you ask for one. You can pass `--full-checkout`, declare the whole repository with `--paths .`, or scope the checkout with `--dependencies`. Reusing an existing claim is not affected. This is a size estimate only. Git Manager does not check free disk space.

#### Never stuck: `unstick`

`git-manager unstick [<repo>] [--dry-run]` clears what keeps a claim stuck:

* It expires claims from sessions that have been idle longer than `checkin.staleClaimHours` (the same expiry a sweep does). Nothing is released or deleted, and a claim whose session comes back is reactivated by the next sweep.
* It removes git lock files (`index.lock`, `HEAD.lock` and similar) that are at least 10 minutes old, and only when no git process is running.
* For every claim still held, it prints the next step: leave it, `finish` it, or `release` it (unmerged work is archived first).

`start` runs this once on its own when another claim is the only thing blocking it, then tries again. An overlapping claim from a session that is still working still holds.

#### Sweeping claims

Claims expire only when a sweep runs, and nothing schedules one for you. Run `git-manager sweep --read-only` to preview, then `git-manager sweep` to apply. A sweep does the following:

* expires claims idle longer than `checkin.staleClaimHours`
* finalizes or archives worktree creations that crashed more than 30 minutes ago (it never deletes them)
* closes claims whose work was merged some other way
* for each repository in `checkin.enforcedRepos`, reports commits made without a claim and working copies that silently revert a newer commit. An entry ending in `/*` covers every git repository directly inside that folder; new installs start with `~/allsorted/*`, where All Sorted contributors clone allsorted-dist and the module repos they own

Add `--json` for machine-readable output. The `sweep-claims` recipe only ever previews.

New installs keep worktrees under `~/.config/allsorted/worktrees`. An upgrade keeps your existing `config/config.json`, including its `worktreeRoot`. Every claim also stores its worktree's absolute path, so existing worktrees keep working wherever they live.

When a released worktree has unfinished or unreadable files, Git Manager preserves it in the configured local recovery directory using a same-filesystem rename. It retains the source and claim if relocation fails. It never infers an external drive or copies and deletes across volumes. The release result names the recovery directory. The recovered directory remains a locked registered Git worktree, keeping its exact index and checked-out branch. Separately staged contents receive their own archive ref. Index or history changes during capture refuse release and retain the claim.

### GitHub Integration

* `connect-github`: check or establish authentication with GitHub CLI (`gh`)
* `publish-repo`: create a new remote repository on GitHub (`public` or `private`) and push initial work (gated by confirmation phrase `PUBLISH`)
* `push-work`: push local work safely to GitHub
* `pull-work`: fetch and merge the latest work from GitHub (merge, never rebase; refuses with uncommitted changes and undoes a conflicted merge)

## Safety Rails

1. **Pre-commit Gating**: Commits are automatically blocked if secret API keys, private keys, or files over 100 MB are staged.
2. **Secret Credential Protection**: Scans staged changes using gitleaks or built-in regex rules. Without gitleaks the built-in scanner says so in its result (`scannerNotice`), in the recipe reply and once on stderr; install it with `brew install gitleaks` for full coverage. Committed secrets must be ROTATED at the provider.
3. **Private Repository Coverage**: Local safety scanning provides vital protection for private repositories where GitHub free push-protection does not apply.
4. **Large File Size Guard**: Prevents committing files exceeding GitHub 100 MB hard limit.

## Hard Refusal Boundary

Git Manager strictly forbids ONLY:
* Force-push in any form (`--force`, `--force-with-lease`)
* `git reset --hard` or `git clean` used to discard uncommitted work
* History rewrite: rebase, filter-branch, commit `--amend` on a shared branch, or reflog expiry

All other operations are supported with safe defaults, automated snapshotting, explicit preservation backups, and explicit confirmation requirements. See `BRAIN.md` for the complete operating policy.


## Explicit lossless cleanup

```sh
npm run cleanup -- --repo /absolute/repository
npm run cleanup -- --repos-file /absolute/roots.json --backup-dir /absolute/external/new-backup
```

The roots file is a JSON array of repository paths. The backup parent must exist and the destination must be new. Inventory does not write files. Capture records working files, staged blobs, indexes and history, verifies readback, and fails closed on concurrent changes or unsupported storage. Ignored runtime files remain untouched and outside the changed-file capture. This command never commits, merges, deletes, pushes or sends notifications. Review and integrate in an isolated worktree with normal hooks after verifying preservation.

Unmerged branches remain protected even if a deletion confirmation is supplied. Branch removal uses Git’s merged-branch check; it never forces deletion of unmerged work.

### Guarded Branch Retirement (report & apply)

* **Base Ref**: Explicit base ref is required (e.g. `refs/heads/main`).
* **Operator Ownership**: `ownershipReviewed: true` is required separately from confirmation phrases.
* **Protected & Active Branches**: `protectedBranches` (e.g., `main`, `master`, `release/*`, `recovery/*`) and active worktree branches are strictly retained.
* **Reflog & HEAD Policy**: Minimum age (default 30 days) is computed against the latest of commit date, branch reflog date, and HEAD checkout reflog date across all worktrees.
* **Lossless Backups**: Backups are written to explicit external destinations or configured `branchCleanup.backupRoot`. Never defaults to `/tmp`.

## Private individual profile

Shared code and policies are generic. Each person owns a private JSON file at `~/.config/allsorted/git-manager/profile.json`, outside the shared repository. Copy `config.example.json` there without overwriting an existing profile, then replace the repository placeholder with an absolute path. Restrict the file to its owner with `chmod 600`. The agent reads this file without modifying it.

Configure `branchCleanup.backupRoot` to specify an absolute existing directory for branch deletion backups:
```json
{
  "branchCleanup": {
    "backupRoot": "/absolute/path/to/private/backups"
  }
}
```

Explicit repository inputs take precedence, followed by `REPOSITORY_ROOT`, then the private profile. `GIT_MANAGER_PROFILE` may select another absolute file path. Missing or invalid settings fail closed. Local `profile.json`, `profile.local.json` and `config.json` files are ignored by Git; only the generic example and reader are in the release allowlist. Never copy an individual profile into a shared package. Profile settings do not grant permission to commit, merge, delete or push.

## Not in this build

Some capabilities of the author's private Git Manager depend on one particular machine, so this customer build leaves them out:

* disk-capacity admission for new worktrees (free-space probing and reserves)
* the preservation budget
* external-drive backup storage selection
* cloud offload, restore and cold preservation of released worktrees
* the habit-council policy layer
* portal-specific program-boundary hooks for editor tools (the generic `--program` start and finish policy remains)
* the hardened sparse-preparation helper
* scheduled fleet sweeps (background scheduling, repository rosters and mirror upkeep). Run `git-manager sweep` yourself instead.
