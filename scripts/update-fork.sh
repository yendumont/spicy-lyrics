#!/usr/bin/env bash
# Pulls the latest Spicy Lyrics changes from upstream into this fork, then rebuilds and
# reinstalls it into Spicetify. macOS and Linux twin of update-fork.ps1; see RUNBOOK.md.
#
# Fetches `upstream` (Spikerko/spicy-lyrics), merges upstream/<branch> into the current
# branch, and runs install-spicetify.sh. Stops without installing if the merge conflicts.
# Does not push anything.
#
# Usage: scripts/update-fork.sh [--branch <name>] [--force] [--no-install] [--no-apply]
#   --branch <name>  upstream branch to merge (default: main)
#   --force          rebuild and reinstall even when there is nothing new upstream
#   --no-install     merge only; skip the build and install
#   --no-apply       passed on to install-spicetify.sh: skip `spicetify apply`

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="main"
FORCE=0
NO_INSTALL=0
NO_APPLY=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --branch)
      BRANCH="${2:?--branch needs a name}"
      shift
      ;;
    --force) FORCE=1 ;;
    --no-install) NO_INSTALL=1 ;;
    --no-apply) NO_APPLY=1 ;;
    -h | --help)
      sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $1 (try --help)" >&2
      exit 2
      ;;
  esac
  shift
done

if ! command -v git > /dev/null 2>&1; then
  echo "Could not find git. Install it (macOS: xcode-select --install) or add it to PATH." >&2
  exit 1
fi
g() { git -C "$REPO" "$@"; }

if ! g remote | grep -qx upstream; then
  echo "No 'upstream' remote. Add it: git remote add upstream https://github.com/Spikerko/spicy-lyrics.git" >&2
  exit 1
fi

if [ -n "$(g status --porcelain)" ]; then
  echo "The working tree has uncommitted changes. Commit or stash them first, then rerun." >&2
  exit 1
fi

echo "==> Fetching upstream/$BRANCH"
g fetch upstream "$BRANCH"

BEHIND="$(g rev-list --count "HEAD..upstream/$BRANCH")"

if [ "$BEHIND" -eq 0 ] && [ "$FORCE" = "0" ]; then
  echo "Already up to date with upstream. Use --force to rebuild and reinstall anyway."
  exit 0
fi

if [ "$BEHIND" -gt 0 ]; then
  echo "==> Merging $BEHIND upstream commit(s)"
  if ! g merge "upstream/$BRANCH" -m "Merge upstream/$BRANCH into fork"; then
    echo
    echo "Merge stopped with conflicts. Nothing was built or installed."
    echo "Conflicted files:"
    g diff --name-only --diff-filter=U | sed 's/^/  /'
    echo
    echo 'Either resolve them, `git commit`, then rerun this script with --force,'
    echo "or back out with:  git merge --abort"
    exit 1
  fi
fi

if [ "$NO_INSTALL" = "1" ]; then
  echo "Merged. Skipping install (--no-install)."
  exit 0
fi

if [ "$NO_APPLY" = "1" ]; then
  "$REPO/scripts/install-spicetify.sh" --no-apply
else
  "$REPO/scripts/install-spicetify.sh"
fi
