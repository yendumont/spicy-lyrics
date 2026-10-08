# Runbook: running this fork next to (or instead of) official Spicy Lyrics

This fork adds six lyrics providers (**lrc.red**, **LRCLIB**, **Unison**, **LRCMux**, **NetEase**, **QQ Music**) plus Genius, an adjustable provider priority list, provider fallback and a
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
is Spicy Lyrics, lrc.red, Unison, LRCLIB, LRCMux, NetEase, QQ Music, Genius. A provider added
in a later version appears just above Genius for anyone who has arranged their own list.
**Reset to default order**
appears once it is changed. If every provider is switched off, Spicy Lyrics is used anyway.

Stored as `lyricsProviderOrder` and `lyricsProvidersDisabled` in `SL:settings`. The older single
`lyricsProvider` choice is only read until a list has been saved, so existing settings carry over.

## lrc.red

[lrc.red](https://lrc.red) is a free public catalogue of lyrics for about 30 million tracks, keyed by
ISRC (`lrc.red/s/<ISRC>.ttml`, `.lrc`, `.json`). No setup, no key, CORS open. Credit to its makers
and to binimum and edideaur from Monochrome, as the site asks.

Spotify does not give the client a track's ISRC, so the track is found through the site's own
`search.json`, which also reports each track's length. A result is used only when its title equals
the playing title (brackets, "feat." and similar ignored), and either its artist matches or its
length is within 0.5 s. That tight figure comes from a 418-track test library: real matches by the
same artist differed in length by up to about a second, while wrong same-titled songs by other
artists sat at 1.0 to 1.4 s. Up to three matches are tried in order, since the closest has no
lyrics in some cases; word-timed TTML is preferred, line-timed LRC is the fallback.

**Hand-timed versus model-timed.** Many lrc.red songs have their words timed by the site's own
model, not by a person; its song page says "Word-synced by lrc.red's in-house model — these lyrics
were never timed by hand", and the data behind the page flags it as `byModel` (in
`/s/<ISRC>.song.json`). The model can be inaccurate. **lrc.red Word Sync** (Settings, Lyrics
Display) chooses what to do:

- **Hand-timed only** (default): word sync only where a person timed it; model-timed songs are shown
  line-synced, and with Prefer Best Sync on, other providers get the chance to supply word sync.
  If lrc.red cannot say how a song was timed, it is treated as model-timed.
- **All word sync**: every word timing the file contains.
- **No word sync**: line sync only.

On a 418-track test library, 224 tracks had lyrics, and 145 of those were model-timed (the public
`.ttml` carries word timing for 38 of them and line timing only for the other 107); 3 had hand-timed
word sync, 33 hand-timed line sync, and 43 were unsynced.

Timing was compared against Spicy's own word sync (Apple Music and the Spicy server) for two
hand-timed songs (Blinding Lights, Levitating): word starts median within about 20 ms, 10th to 90th
percentile about ±80 ms, identical line structure, and the site's `lyricOffset` already applied. That
check covers hand-timed songs only; the accuracy of the model-timed word sync was not measured.
The catalogue has gaps (for example Eminem's "Without Me" is not in it).

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

## KuGou, Deezer and Musixmatch

All three are unofficial endpoints and sit just above Genius in the default priority
(Musixmatch above Unison); a saved priority list gets them slotted in automatically.

- **KuGou** (`providers/Kugou.ts`): `lyrics.kugou.com`, no login. Word-timed KRC when it
  has it (base64, XOR with a fixed key, zlib), else line-timed LRC. The song header line
  and credit lines are dropped. Its search is picky about case, so lower-case forms of the
  title are tried too.
- **Deezer** (`providers/Deezer.ts`): public search, then Deezer's own GraphQL (`pipe.deezer.com`)
  with the anonymous token every visitor gets. Line-timed lyrics, or plain text. The token
  is passed as `?access_token=` because Spicetify's proxy drops request headers.
- **Musixmatch** (`providers/Musixmatch.ts`): needs **your own user token**, pasted at
  Settings → Lyrics Display → Musixmatch Token. Without one it does nothing (Musixmatch
  hands anonymous clients a blank token that only matches the wrong songs). With one it
  asks for word-timed richsync, then line-timed subtitles, then plain text, and matches by
  the Spotify track id where the song has one. Not verified against a real token.

## AMLL TTML DB and YouTube Music

- **AMLL TTML DB** (`providers/AmllTtmlDb.ts`): the community database of word-timed lyrics
  (`amll-dev/amll-ttml-db`), read straight from GitHub's raw files (open CORS, no key). Files
  are filed by streaming-service id: the Spotify id first (local files and episodes are
  matched to one the same way as for Spicy Lyrics), then the song's NetEase id. Parsed with
  the same TTML parser as lrc.red, so it is word-synced. Sits right after lrc.red.
- **YouTube Music** (`providers/YouTubeMusic.ts`): unsynced text (LyricFind or Musixmatch,
  named in the credit). YouTube Music cannot be reached from Spotify's page, so it uses the
  **same Cloudflare Worker as Genius**, which now also answers `/ytm/search` and
  `/ytm/lyrics`. **Redeploy the Worker** with `workers/genius-proxy/worker.js` to enable it
  (see the next section); the "Genius Proxy URL" setting is shared. Tested against a local
  copy of the Worker; not yet against Cloudflare itself.
- **Kuwo** (`providers/Kuwo.ts`): Kuwo's website API (`kuwo.cn/openapi/v1/www`), line-synced.
  Kuwo also has word-timed lyrics, but as an encrypted binary that Spicetify's proxy cannot
  carry, so they are not used. The `Title - Artist` header, credit lines, the translation
  licence notice and bare speaker labels ("DaBaby：") are dropped.
- **BiniLyrics** (`providers/BiniLyrics.ts`): `lyrics-api.binimum.org`, open and keyless,
  returns TTML. Many of its answers are lrc.red files, which go through the lrc.red
  provider's rules, so "lrc.red Word Sync" applies. It overlaps heavily with lrc.red; it
  only adds songs in its own library.
- **Not added:** *YouTube transcripts*: YouTube now serves caption files only with a
  proof-of-origin token, so they come back empty without pretending to be another
  YouTube client. *RMM Revival*: it has no public documentation (its domain redirects to a
  Roblox game page) and only relays Spicy Lyrics' own data, which this fork already asks.

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

**Genius Loose Search** (Settings, Lyrics Display, on by default) widens Genius lookups
for leaked or fan-uploaded songs, where Spotify's artist is an uploader and Genius lists
the real artist and a decorated title. Normally a result must match the song title and
artist. With it on, a miss triggers broader searches: every title the song could go by
(Spotify names like "Jaydes - idiot" are searched as "Jaydes" and as "idiot"), asked deep
(20 results), then in other word orders, with the album and with symbol-free artist names.
Decoration is ignored on both sides: brackets, "feat." and "prod." credits, hashtags,
＊asterisk tags＊, zero-width characters. A Spotify title that begins a longer Genius title
(Genius often names a page with its first lyric line) counts when it is 8+ letters long.

The results are taken in this order, stopping at the first that applies:

1. a close title with the same cover art as the playing song;
2. a close title and a related artist (or a learned alias), or a long unusual title (12+ letters)
   that only one result has;
3. an exact-title result by a favourite artist (named in settings, or seen behind uploader
   names in 3+ songs). If several qualify, the one written exactly like the song wins ("scars"
   rather than "Scars"), then the artist your library has resolved most;
4. **Genius Eager Matching** (on by default, needs Loose Search): the best-looking result even
   though nothing proved it. It must have a title within reach, and scores higher for being
   written like the song, a similar artist, a somewhat alike cover and an obscure page. Pages
   with over a million views are never guessed, since the real song of an obscure upload is
   almost never the famous song of the same name. Turn it off if you would rather see nothing
   than risk another song's lyrics.

It never takes a longer title for a shorter one ("On Me" is not "Easy On Me"), and it retries
once when Genius answers with a passing error. On a 208-song test library of leaked and
fan-uploaded songs, the share with lyrics found went from 80% to 96%.

**Learned artists.** When a cover match proves that a Spotify artist is a Genius artist
(for example "Yen" is "jaydes"), the pairing is remembered in `SL:geniusAliases` and used for
that artist's later songs: they are searched for under the real name, which also finds songs
the bare title buries. Separately, `SL:geniusArtists` counts which Genius artists have turned
up behind uploader names (once per song); rule 3 above uses it, and searches for those artists
by name, because Genius's own search buries obscure songs under famous ones of the same title.
Loose search and eager matching do nothing until a proxy URL is set. To forget what it
learned, run `Spicetify.LocalStorage.remove("SL:geniusAliases")` and
`Spicetify.LocalStorage.remove("SL:geniusArtists")` in Spotify's DevTools.

**Updating the Worker.** The Worker now also accepts `per_page` and `page` on `/search`.
Loose search asks for 20 results on the bare-title search; with an older Worker it still
works but sees only the top five. To update, open the Worker in Cloudflare, **Edit code**,
replace everything with `workers/genius-proxy/worker.js`, **Deploy**.

Check the Worker in a browser: `https://<your-worker>/search?q=hello` should return JSON.
If it returns an error such as `genius responded 403`, Genius is blocking Cloudflare's
servers and the fallback will not work; clear the setting.

## Local files and podcasts (experiment)

Settings → Experiments → **Lyrics for Local Files & Podcasts** (off by default). When on,
local files (`spotify:local:`) and audio podcast episodes are looked up like songs, with
every enabled provider asked in your priority order even with Provider Fallback off.

The artist is guessed from the title (`providers/Unlisted.ts`): file tags first (split on
`;` and `/`), then "Artist - Song", "Song - Artist", "Song by Artist", `Artist-Song`, runs
of underscores read as " - ", and the names after `ft`/`prod` as artists, after stripping
extensions, track numbers and credit tails. Up to six guesses are tried per provider; the
first that matches (title, artist, duration) wins, so word- and line-synced providers are
preferred just as for normal songs.

Spicy's own API needs a Spotify track id, so `providers/SpotifySearch.ts` first finds the
catalogue track: it searches Spotify's own search (GraphQL `searchModalResults`, no Web API
rate limit) and accepts a track whose title and artist match and whose length is within 10 s
of the file's. With no artist to vouch for it, an exact title match within 2 s is accepted.
If nothing fits, Spicy is skipped. Files with junk names (`B0CXMH1CMX`, `New_Project`),
unreleased songs and differently cut versions still only get the other providers.

Plain podcast episodes with no song in the title find nothing. Video podcasts remain
unsupported. Takes effect from the next song. Cached under a key made from the whole uri.

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
- `src/utils/Lyrics/providers/`: lrc.red, LRCLIB, Unison, LRCMux, NetEase and QQ Music clients (the last two use unofficial endpoints through `Spicetify.CosmosAsync`), LRC parsing, sync ranking.
- `src/utils/Lyrics/providers/ProviderOrder.ts`: the default order, provider labels, and how a saved priority list becomes the providers to ask.
- `src/utils/Lyrics/fetchLyrics.ts`: provider order and fallback around the Spicy API call.
- `src/utils/Lyrics/providers/Genius.ts`, `workers/genius-proxy/worker.js`: the Genius client and the Cloudflare Worker it talks to.
