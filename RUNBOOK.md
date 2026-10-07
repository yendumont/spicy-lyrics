# Runbook: running this fork next to (or instead of) official Spicy Lyrics

This fork adds five lyrics providers (**LRCLIB**, **Unison**, **LRCMux**, **NetEase**, **QQ Music**) plus Genius, an adjustable provider priority list, provider fallback and a
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
   **Lyrics Provider Priority**, **Provider Fallback** and **Prefer Best Sync**.
3. Play a song. The credit under the lyrics reads "Provided by: ..." with the source.

## Provider priority

Settings, Lyrics Display, **Lyrics Provider Priority** lists every source from first asked
to last. The arrows move a provider up or down; its switch turns it off. **Provider
Fallback** decides whether the list is walked or only its first enabled entry is used, and
**Prefer Best Sync** whether the walk continues past a worse-synced result. The default order
is Spicy Lyrics, Unison, LRCLIB, LRCMux, NetEase, QQ Music, Genius; **Reset to default order**
appears once it is changed. If every provider is switched off, Spicy Lyrics is used anyway.

Stored as `lyricsProviderOrder` and `lyricsProvidersDisabled` in `SL:settings`. The older single
`lyricsProvider` choice is only read until a list has been saved, so existing settings carry over.

## LRCMux

[lrcmux.dev](https://lrcmux.dev) combines KuGou, LRCLIB, YouTube Music and Genius and returns the
best sync level it finds; the credit names the service ("LRCMux (KuGou)"). No setup. The code tidies
what it receives before showing it:

- punctuation and brackets sent as separate "words" are joined to their neighbour (`on` `,` is `on,`);
- word times are put in order, overlaps trimmed, zero-length words given a minimum, and each line
  runs from its first to its last word rather than on into the next gap;
- credit lines ("作词 : …", "Lyrics by: …") are dropped;
- KuGou censors profanity; if it does, LRCMux is asked again without KuGou, and the uncensored
  (usually line-synced) text is used, falling back to the censored version if nothing else exists;
- a result for a recording more than 8 s longer or shorter than the playing one is refused.

Timing is whatever the source has. Measured against Spicy's word sync for the same songs, KuGou
ran from about 120 ms early to 270 ms late depending on the song, and LRCLIB lines about 190 ms
early, so no single offset corrects them. Use the global playback offset setting to nudge a song.

## Genius fallback (optional)

Genius is a provider in the **Lyrics Provider Priority** list, last in the default order. With
**Provider Fallback** on it is therefore asked only after every other provider came up
empty (it gives unsynced text, so it is skipped once anything better is found). You can
also choose it as the first provider. It needs the proxy URL below; without one it finds
nothing.

Genius cannot be reached from Spotify directly (no CORS headers, and Spicetify's own
proxy refuses it), so you run a small Cloudflare Worker that fetches Genius for you.
The Worker is in `workers/genius-proxy/worker.js`. It serves only Genius search and
Genius lyrics pages, only to Spotify's page, and holds no secrets.

1. Make a free account at dash.cloudflare.com (no domain needed).
2. **Workers & Pages**, **Create**, **Create Worker**. Name it (for example
   `spicy-genius`) and click **Deploy**.
3. **Edit code**, replace everything with the contents of `workers/genius-proxy/worker.js`,
   click **Deploy**.
4. Copy the address (like `https://spicy-genius.yourname.workers.dev`).
5. In Spotify: Spicy Lyrics, Settings, Lyrics Display, **Genius Proxy URL**, paste it, press
   Enter. Then move **Genius** up under **Lyrics Provider Priority** if you want it earlier.

**Genius Loose Search** (Settings, Lyrics Display, off by default) widens Genius lookups
for leaked or fan-uploaded songs, where Spotify's artist is an uploader and Genius lists
the real artist and a decorated title. Normally a result must match the song title and
artist. With it on, a miss triggers broader searches (title alone with deeper results,
other word orders, with the album). A result is used when:

1. its title is close and its cover art is the same picture as the playing song's, or
2. its title is close and its artist resembles the Spotify artist (or a learned alias), or
3. its title is long and unusual (12+ letters) and it is the only such result, or
4. last resort: its title is exact, Genius has never heard of the Spotify artist (so it is
   probably an uploader), and the result is by the only artist, among those with an exact
   title match, that your library has already resolved behind uploader names in 3+ songs.

It never takes a longer title for a shorter one ("On Me" is not "Easy On Me") and never
prefers a result for being famous, so it will often return nothing rather than guess.

**Learned artists.** When a cover match proves that a Spotify artist is a Genius artist
(for example "Yen" is "jaydes"), the pairing is remembered in `SL:geniusAliases` and used for
that artist's later songs: they are searched for under the real name, which also finds songs
the bare title buries. Separately, `SL:geniusArtists` counts which Genius artists have turned
up behind uploader names (once per song); rule 4 above uses it, and searches for those artists
by name, because Genius's own search buries obscure songs under famous ones of the same title.
Loose search is on by default and does nothing until a proxy URL is set. To forget what it
learned, run `Spicetify.LocalStorage.remove("SL:geniusAliases")` and
`Spicetify.LocalStorage.remove("SL:geniusArtists")` in Spotify's DevTools.

**Updating the Worker.** The Worker now also accepts `per_page` and `page` on `/search`.
Loose search asks for 20 results on the bare-title search; with an older Worker it still
works but sees only the top five. To update, open the Worker in Cloudflare, **Edit code**,
replace everything with `workers/genius-proxy/worker.js`, **Deploy**.

Check the Worker in a browser: `https://<your-worker>/search?q=hello` should return JSON.
If it returns an error such as `genius responded 403`, Genius is blocking Cloudflare's
servers and the fallback will not work; clear the setting.

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
- `src/utils/Lyrics/providers/`: LRCLIB, Unison, LRCMux, NetEase and QQ Music clients (the last two use unofficial endpoints through `Spicetify.CosmosAsync`), LRC parsing, sync ranking.
- `src/utils/Lyrics/providers/ProviderOrder.ts`: the default order, provider labels, and how a saved priority list becomes the providers to ask.
- `src/utils/Lyrics/fetchLyrics.ts`: provider order and fallback around the Spicy API call.
- `src/utils/Lyrics/providers/Genius.ts`, `workers/genius-proxy/worker.js`: the Genius client and the Cloudflare Worker it talks to.
