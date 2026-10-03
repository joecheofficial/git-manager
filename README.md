# Git Manager

Local Git hygiene, two-tier checkpointing, GitHub publishing, line-of-work branch management, and pre-commit safety rails for your repository. Nothing here reads or writes any repository other than the one you configure.

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

### Checkpointing and Committing

* `snapshot`: Tier 1. Always safe. Parks current state on `refs/allsorted/checkpoints/<branch>` through an isolated index. Never touches working tree, index, HEAD, or any branch.
* `checkpoint [--confirm CHECKPOINT]`: Tier 2. Snapshots first, then commits onto your real branch when the repository has been quiet for the configured window.
* `commit --message "..." [--confirm COMMIT]`: Manual commit with preview-first confirmation and pre-commit safety gating. Requires `GIT_MANAGER_ALLOW_COMMIT=true`.

### Line of Work (Branch) Management

* `create-branch`: create and switch to a new line of work
* `switch-branch`: switch to a line of work, snapshotting uncommitted changes first
* `merge-branch`: merge a line of work into the current branch (gated by confirmation phrase `MERGE`)
* `delete-branch`: delete a line of work (gated by confirmation phrase `DELETE` or `DELETE UNMERGED`)
* `cleanup-branches`: identify and remove stale or merged lines of work (gated by confirmation phrase `CLEANUP`)

### GitHub Integration

* `connect-github`: check or establish authentication with GitHub CLI (`gh`)
* `publish-repo`: create a new remote repository on GitHub (`public` or `private`) and push initial work (gated by confirmation phrase `PUBLISH`)
* `push-work`: push local work safely to GitHub
* `pull-work`: pull latest work from GitHub using rebase and autostash

## Safety Rails

1. **Pre-commit Gating**: Commits are automatically blocked if secret API keys, private keys, or files over 100 MB are staged.
2. **Secret Credential Protection**: Scans staged changes using gitleaks or built-in regex rules. Committed secrets must be ROTATED at the provider.
3. **Private Repository Coverage**: Local safety scanning provides vital protection for private repositories where GitHub free push-protection does not apply.
4. **Large File Size Guard**: Prevents committing files exceeding GitHub 100 MB hard limit.

## Hard Refusal Boundary

Git Manager strictly forbids ONLY:
* Force-push in any form (`--force`, `--force-with-lease`)
* `git reset --hard` or `git clean` used to discard uncommitted work
* History rewrite: rebase, filter-branch, commit `--amend` on a shared branch, or reflog expiry

All other operations are supported with safe defaults, automated snapshotting, and explicit confirmation requirements. See `BRAIN.md` for the complete operating policy.

## Updates

This updates itself every week from this repo. Before it changes anything it backs up your own files, and if the self-test fails after an update it rolls back to the version you had. Your own files (config, notes, brand files, data) are never overwritten.

```
node scripts/self-update.js --status   # see the setting and the last check
node scripts/self-update.js --now      # check and update right now
node scripts/self-update.js --off      # turn weekly updates off
node scripts/self-update.js --on       # turn them back on
```
