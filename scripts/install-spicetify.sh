#!/usr/bin/env bash
# Builds this fork of Spicy Lyrics and installs it into Spicetify as its own extension,
# "spicy-lyrics-hype.providers.js". macOS and Linux twin of install-spicetify.ps1; see RUNBOOK.md.
#
# Steps: bun install -> bun run build -> rename the output -> register it in Spicetify ->
# spicetify apply (restarts Spotify).
#
# Usage: scripts/install-spicetify.sh [--no-apply] [--skip-install] [--uninstall]
#   --no-apply      build and register, but do not run `spicetify apply`
#   --skip-install  skip `bun install` (dependencies unchanged)
#   --uninstall     remove the extension from Spicetify, delete the file and re-apply

set -euo pipefail

EXT_NAME="spicy-lyrics-hype.providers.js"
# The name the first release used. It is removed on install so it never loads beside this one.
OLD_EXT_NAME="spicy-lyrics-providers.js"
# What spicetify-creator calls the file it builds (from "name" in spice.config.ts).
BUILT_NAME="spicy-lyrics.js"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

NO_APPLY=0
SKIP_INSTALL=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --no-apply) NO_APPLY=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h | --help)
      sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

# Prints the path of a tool: PATH first, then the places its installer puts it.
resolve_tool() {
  local name="$1"
  shift
  if command -v "$name" > /dev/null 2>&1; then
    command -v "$name"
    return 0
  fi
  local candidate
  for candidate in "$@"; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  echo "Could not find '$name'. Install it or add it to PATH (see RUNBOOK.md, Prerequisites)." >&2
  return 1
}

SPICETIFY="$(resolve_tool spicetify "$HOME/.spicetify/spicetify" "$HOME/.local/bin/spicetify" /opt/homebrew/bin/spicetify /usr/local/bin/spicetify)"

USER_DATA="$("$SPICETIFY" path userdata 2> /dev/null | head -n 1 | tr -d '\r' || true)"
if [ -z "$USER_DATA" ] || [ ! -d "$USER_DATA" ]; then
  USER_DATA="${XDG_CONFIG_HOME:-$HOME/.config}/spicetify"
fi
EXT_DIR="$USER_DATA/Extensions"
TARGET="$EXT_DIR/$EXT_NAME"
OLD_TARGET="$EXT_DIR/$OLD_EXT_NAME"

# Spicetify: `config extensions X` adds X, `config extensions X-` removes it.
set_registered() {
  if [ "$2" = "1" ]; then
    "$SPICETIFY" config extensions "$1" > /dev/null
  else
    "$SPICETIFY" config extensions "$1-" > /dev/null
  fi
}

if [ "$UNINSTALL" = "1" ]; then
  echo "Removing $EXT_NAME from Spicetify..."
  set_registered "$EXT_NAME" 0
  rm -f "$TARGET"
  set_registered "$OLD_EXT_NAME" 0
  rm -f "$OLD_TARGET"
  if [ "$NO_APPLY" = "0" ]; then "$SPICETIFY" apply; fi
  echo "Uninstalled."
  exit 0
fi

BUN="$(resolve_tool bun "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun)"

# A running `bun run dev` rewrites the extension folder and registers its own live-reload
# helper; the two would fight over the same files.
if pgrep -f "spicetify-creator dev" > /dev/null 2>&1 || pgrep -f "bun run dev" > /dev/null 2>&1; then
  echo "A 'bun run dev' watcher is running. Stop it first." >&2
  exit 1
fi

cd "$REPO"

if [ "$SKIP_INSTALL" = "0" ]; then
  echo "==> bun install"
  "$BUN" install
fi

echo "==> bun run build"
# Used to tell whether the build really wrote a new file (older ones are not trusted).
STAMP="$(mktemp)"
trap 'rm -f "$STAMP"' EXIT
"$BUN" run build

# spicetify-creator writes straight into the Spicetify Extensions folder.
BUILT="$EXT_DIR/$BUILT_NAME"
if [ ! -f "$BUILT" ] || [ ! "$BUILT" -nt "$STAMP" ]; then
  echo "Build finished but $BUILT was not updated. Check the build output above." >&2
  exit 1
fi

# Give it our own name so it can never collide with an official Spicy Lyrics.
mv -f "$BUILT" "$TARGET"
echo "==> Installed $TARGET ($(($(wc -c < "$TARGET") / 1024)) KB)"

echo "==> Registering in Spicetify"
set_registered "$EXT_NAME" 1
# Leftovers from `bun run dev` / a plain build; this fork loads under its own name.
set_registered "sc-live-reload-helper.js" 0
set_registered "$BUILT_NAME" 0
# Left registered, the first release's file would load beside this one and the two would clash.
set_registered "$OLD_EXT_NAME" 0
rm -f "$OLD_TARGET"

if [ "$NO_APPLY" = "1" ]; then
  echo 'Done. Run `spicetify apply` when you are ready to load it.'
else
  echo "==> spicetify apply (Spotify will restart)"
  "$SPICETIFY" apply
  echo "Done."
fi
