#!/bin/sh
# Git Manager installer. Prints what it does, installs nothing outside this folder.
set -eu
DIR=$(cd "$(dirname "$0")" && pwd)

command -v node >/dev/null 2>&1 || { echo "Node.js is not installed. Install Node 18 or newer, then run this again."; exit 1; }
echo "Git Manager folder: $DIR"
if node -e 'const p=require(process.argv[1]);process.exit(Object.keys(p.dependencies||{}).length?0:1)' "$DIR/package.json"; then
  echo "Installing dependencies (npm install --omit=dev)"
  (cd "$DIR" && npm install --omit=dev)
else
  echo "No dependencies to install."
fi

# Weekly self-update: on by default, one line turns it off. It fast-forwards
# this clone from its origin, backs up your own files first and rolls back if
# the self-test fails.
echo ""
if [ "${GIT_MANAGER_SKIP_UPDATES:-0}" = "1" ]; then
  echo "Weekly updates not scheduled (GIT_MANAGER_SKIP_UPDATES=1). Later: node \"$DIR/scripts/self-update.js\" --register"
else
  node "$DIR/scripts/self-update.js" --register || echo "Weekly updates could not be scheduled. Try later: node \"$DIR/scripts/self-update.js\" --register"
fi
echo ""
echo "Next: node \"$DIR/src/index.js\" demo (offline, changes nothing)"
