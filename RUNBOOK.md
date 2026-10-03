# Runbook: running this fork next to (or instead of) official Spicy Lyrics

This fork adds two lyrics providers (**LRCLIB**, **Unison**), provider fallback and a
"Prefer Best Sync" mode. It installs into Spicetify as its **own extension**,
`spicy-lyrics-providers.js`, so official Spicy Lyrics updates cannot overwrite it.

## Why it is separate

| | Official Spicy Lyrics | This fork |
|---|---|---|
| Spicetify file | `spicy-lyrics.mjs` (a ~100 byte loader) | `spicy-lyrics-providers.js` (full 1.4 MB build) |
| Where the code lives | Downloaded from a CDN on every start, so upstream updates reach you instantly | Inside the file. Changes only when you rebuild |
| Updates | Automatic | Manual: `scripts/update-fork.ps1` |

Settings are stored under the same Spotify key (`SL:settings`), so your existing Spicy
Lyrics settings carry over, and the new ones (`lyricsProvider`, `lyricsProviderFallback`,
`preferBestSync`) are added alongside them.

> **Never enable both.** They register the same `/SpicyLyrics` page, the same styles and
> the same settings key, and will break each other. Keep only one in Spicetify's
> `extensions` list (check with `spicetify config extensions`).

## Prerequisites

- **Spicetify** (CLI on PATH, or at `%LOCALAPPDATA%\spicetify\spicetify.exe`), already
  applied to Spotify at least once (`spicetify backup apply`).
- **Bun** (PATH, or `%USERPROFILE%\.bun\bin\bun.exe`). Install: `irm bun.sh/install.ps1 | iex`
- **Git** (PATH, or the copy bundled with GitHub Desktop is found automatically).
- Remotes: `origin` is your fork, `upstream` is `https://github.com/Spikerko/spicy-lyrics.git`.
  Check with `git remote -v`; add upstream with
  `git remote add upstream https://github.com/Spikerko/spicy-lyrics.git`.

Run all scripts from a PowerShell prompt at the repo root.

## First-time install

1. Remove the official Spicy Lyrics from Spicetify (Marketplace uninstall, or delete the
   `spicy-lyrics.mjs` entry from `extensions`). Skipping this means two copies run.
2. Install this fork:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\install-spicetify.ps1
   ```

   It runs `bun install`, `bun run build`, renames the output to
   `spicy-lyrics-providers.js`, registers it, and runs `spicetify apply`
   (**Spotify restarts**).

Flags: `-SkipInstall` (skip `bun install`), `-NoApply` (do not restart Spotify; run
`spicetify apply` yourself later).

## Updating (pulling in new upstream Spicy Lyrics changes)

Commit your own work first; the script refuses to run on a dirty working tree.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\update-fork.ps1
```

It fetches `upstream/main`, merges it into your current branch, then rebuilds and
reinstalls. Nothing is pushed. Flags: `-Force` (rebuild even if nothing new),
`-NoInstall` (merge only), `-NoApply`, `-Branch <name>`.

To keep your fork on GitHub in sync afterwards: `git push origin main`.

### If the merge conflicts

The script stops before building and lists the conflicted files. The likeliest file is
`src/utils/Lyrics/fetchLyrics.ts` (the provider logic wraps the Spicy API call there).

1. Open the conflicted files, keep both sides' intent, remove the markers.
2. `git add <files>` then `git commit`
3. Rebuild: `scripts\update-fork.ps1 -Force` (or just `scripts\install-spicetify.ps1`).

To give up instead: `git merge --abort`. Your install is untouched until a build succeeds.

## Rebuild without updating (after editing code)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-spicetify.ps1 -SkipInstall
```

For fast iteration, `bun run dev` instead. Stop it before running the install script;
the script refuses to run while a dev watcher is active, and dev mode registers its own
live-reload helper. The install script removes that helper from your config.

## Verify

1. `spicetify config extensions` lists `spicy-lyrics-providers.js` and not
   `spicy-lyrics.mjs`.
2. In Spotify, open Spicy Lyrics, then Settings, Lyrics Display. You should see
   **Lyrics Provider**, **Provider Fallback** and **Prefer Best Sync**.
3. Play a song. The credit under the lyrics reads "Provided by: ..." with the source.

## Rollback / uninstall

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-spicetify.ps1 -Uninstall
```

This removes the extension from the Spicetify config, deletes the file and re-applies.
Then reinstall official Spicy Lyrics through the Marketplace or by putting
`spicy-lyrics.mjs` back into `extensions`, and run `spicetify apply`.

To step back to an earlier version of the fork: `git checkout <commit>`, then run the
install script.

## Troubleshooting

- **Lyrics page is blank / two Spicy Lyrics buttons**: both copies are enabled. Remove
  one from `spicetify config extensions`, then `spicetify apply`.
- **"A 'bun run dev' watcher is running"**: stop it (close its terminal or end the `bun`
  process) and rerun.
- **"Build finished but ... was not updated"**: the build failed quietly; run
  `bun run build` by hand and read its output.
- **A provider is not used after changing the setting**: lyrics are cached per track for 3
  days regardless of provider. Clear the cache in Settings, or play a song you have not
  played.
- **Spotify did not restart / old behaviour persists**: run `spicetify apply` again and
  hard-restart Spotify.
- **Stale files**: `Extensions\app.css` and `Extensions\sc-live-reload-helper.js` are
  leftovers from `bun run dev` and are safe to delete.
- **Debugging in Spotify's DevTools**: launch Spotify with
  `--remote-debugging-port=8088`, or run `spicetify enable-devtools`.

## File map

- `scripts/install-spicetify.ps1`: build, install, register, apply (and `-Uninstall`).
- `scripts/update-fork.ps1`: merge upstream, then call the install script.
- `src/utils/Lyrics/providers/`: LRCLIB and Unison clients, LRC parsing, sync ranking.
- `src/utils/Lyrics/fetchLyrics.ts`: provider order and fallback around the Spicy API call.
