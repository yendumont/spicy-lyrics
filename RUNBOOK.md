# Runbook: running this fork next to (or instead of) official Spicy Lyrics

This fork adds about 15 lyrics providers (lrc.red, LRCLIB, Unison, LRCMux, NetEase, QQ Music, Genius, Musixmatch, AMLL TTML DB, KuGou, Deezer, Kuwo, YouTube Music, BiniLyrics), an adjustable provider priority list,
provider fallback and a "Prefer Best Sync" mode, plus line meanings, Gemini translation, TTML export, animated covers and Canvas, and lyrics for local files and podcasts. Each feature has its own section below. It installs into Spicetify as its **own extension**,
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

## macOS and Linux

Everything except the two PowerShell scripts is platform-neutral, and each script has a
bash twin with the same behaviour. They were written from the PowerShell versions and have
**not been run on a Mac yet**; if one misbehaves, the manual steps below are the fallback.

Prerequisites: [Spicetify](https://spicetify.app) applied to Spotify at least once
(`spicetify backup apply`), [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)
and git (macOS: `xcode-select --install`). Run from the repo root, in Terminal:

```bash
scripts/install-spicetify.sh                 # install, or rebuild after editing code
scripts/install-spicetify.sh --skip-install  # same, without `bun install`
scripts/install-spicetify.sh --no-apply      # do not restart Spotify
scripts/install-spicetify.sh --uninstall     # remove it again
scripts/update-fork.sh                       # merge upstream, then rebuild and reinstall
```

Flags: `update-fork.sh` takes `--branch <name>`, `--force`, `--no-install`, `--no-apply`.
If a script is not executable, run `chmod +x scripts/*.sh` once (or prefix with `bash`).
Everything else in this runbook (provider priority, Worker, merge conflicts) applies
unchanged; read `-Flag` as `--flag`.

By hand, if you prefer:

```bash
bun install && bun run build            # writes spicy-lyrics.js into Spicetify's Extensions folder
EXT="$(spicetify path userdata)/Extensions"
mv "$EXT/spicy-lyrics.js" "$EXT/spicy-lyrics-providers.js"
spicetify config extensions spicy-lyrics-providers.js
spicetify config extensions spicy-lyrics.js-       # drop the plain build, if registered
spicetify apply
```

Testing against the real client: quit Spotify, start it with
`open -a Spotify --args --remote-debugging-port=8088`, then
`bun scripts/dev/cdp.ts <file.js>` (see `FORK_NOTES.md`).
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

## Line meanings and translation

Both add something under or beside each lyrics line once the lyrics are on screen
(`utils/Lyrics/Extras/`), looked up in the background so the lyrics never wait for them.

- **Line meanings** (Settings → Lyrics Display → Line Meanings / Meanings From): Genius's
  annotations. A song's annotations come from the Worker's `/meanings` endpoint (trimmed,
  and fetched in parallel, so it is fast); the **Worker must be redeployed** with the
  current `workers/genius-proxy/worker.js` (an older one with only `/referents` still works,
  more slowly; with neither nothing is shown and nothing is remembered, so it starts working
  once updated). Meanings are looked up the moment a song starts, alongside the lyrics, not
  after them. The Genius song is found with the same matching as the Genius lyrics provider,
  so any song Genius lyrics can find also gets meanings, whichever provider supplied the
  lyrics. Each annotation is placed on the lyrics line(s) that quote it (found as running
  text across a few lines, by closeness when Genius spells a word its own way, so about nine
  in ten place), and a small info button opens it; the card follows its line as the lyrics
  scroll and stays until dismissed. Genius sorts annotations as *verified* (confirmed by the
  artist), *accepted* (approved by its editors) or *unreviewed* (community); "Meanings From"
  is Artist only / Artist and editors / Everyone. Kept 7 days.
- **Translation** (Translate Lyrics, Gemini API Key, Translate Into, Gemini Model): each
  line translated by Google's Gemini with **your own key** (Google AI Studio), shown under
  the original. The lyrics of each song go to Google, once per song and language, and the
  result is kept 60 days. The model defaults to `gemini-3.5-flash-lite`; change it in
  settings if Google retires it. Lyrics are often explicit, so the request turns Gemini's
  safety filters off for them; if Gemini still declines, a message says so. A rejected key
  or model is not retried for a minute.

### Word-synced translation (experiment)

Settings, Experiments, **Word-Synced Translation** (off by default). On songs with word-synced lyrics, the translation under each line lights up chunk by chunk as the matching sung word is sung, instead of sitting still. Gemini is sent each line as its numbered sung words and returns the translation in chunks, each tagged with the sung word it lines up with; each chunk is lit from that word's start to the next chunk's word (chunks sharing a word split its time). It is a separate translation request per song (cached like the plain one, under its own key), so turning it on re-translates songs once. Line-synced and unsynced songs, and any line it cannot line up, keep the plain translation. Code: `utils/Lyrics/Extras/` (`SyncedWords.ts` reads word timing from the shown lyrics, `Translation.ts` asks Gemini and builds the chunks, `TranslationSyncDriver.ts` moves the lit part each frame, called from `LyricsAnimator.ts`); CSS in `css/Lyrics/Extras.css`.

## Animated covers (experiment)

Settings → Experiments → **Animated Album Covers** (off by default). Apple Music's animated
album art plays over the still cover in the Now Bar (the cover in Fullscreen and the larger
view). The still cover stays underneath until the first frame is ready, and for albums with
no animated cover, so nothing changes for them.

- **Where it comes from:** the extension finds the album on Apple Music itself (iTunes search,
  from your own connection: Apple turns that search away from the shared addresses a Worker
  runs on, with a 403), then the Worker's `/motion?id=` reads the album page for its animated
  cover's stream address. **Redeploy the Worker** for it; the Genius Proxy URL setting is
  shared. Many albums have none (Apple only makes them for some), and those are remembered
  for a week. When something does go wrong (Worker not updated, Apple unreachable) a message
  says what, once.
- **Why it is converted:** Spotify's own browser engine decodes only VP9 and AV1, not the
  H.264 Apple serves (`MediaSource` and WebCodecs both report no support), so each cover is
  converted once, on your PC, to a short silent looping WebM (`utils/AnimatedCover/`). That
  uses ffmpeg compiled to WebAssembly, in its own worker, one core for a few seconds to a
  minute per album. The result is kept in the browser cache (the 40 newest albums), so
  every later play is instant and offline; a convert that fails is not remembered.
- **The converter is downloaded, once:** ffmpeg (about 9 MB sent, 32 MB stored) comes from
  the npm CDN (jsdelivr) at exact versions and is only used if each file's SHA-256 matches
  the one in `FFmpegLoader.ts`; it is kept in the browser cache after that. To use other
  versions, replace the URLs and hashes there together.
- It pauses with the music and when Spotify is hidden. Turning the experiment off removes
  the video straight away.

### Spotify Canvas and the live background (two more experiments)

Settings, Experiments (both off by default):

- **Spotify Canvas as Animated Cover.** A song's Canvas (the short looping video artists add)
  plays over the still cover the same way. Spotify already hands the extension its address
  (the playing track's `canvas.url`), and the file can be fetched directly, so **no Worker
  change is needed**. It is H.264 too, so it is converted once like Apple's (a few seconds,
  split over several cores), kept in the same cache, and then instant. A Canvas is tall
  (9:16): it keeps its shape and the cover box crops it to a square. Where a song has both,
  Apple's cover stays on the cover and the Canvas goes to the live background; a song with only
  a Canvas shows it on the cover. Most popular songs have a Canvas, far more than have an Apple cover.
- **Live Video Background.** The same video fills the background of Fullscreen and the
  larger view, darkened and blurred behind the lyrics; the normal animated background stays
  underneath and shows for songs with no video. It tries both sources by itself, so it works
  without the two cover experiments being on. **Background Blur** (0 to 60 px, default 24)
  appears under it while it is on, and changes straight away.
- **Keep Video Aspect Ratio** (a separate experiment, off by default) shows these videos whole
  instead of cropping them to fill: a tall Canvas sits entire in the cover (the still cover shows
  at its sides) and the background video is not zoomed to the window (the normal background
  shows around it).
### Video songs (experiment, on by default)

Settings, Experiments, **Video Songs**. Songs Spotify plays as a music video used to show
"We currently don't have support for video lyrics". They now get lyrics from every provider
like any song, and Spotify's actual video plays in the cover of Fullscreen and the larger
view instead of its thumbnail (the box takes the video's 16:9 shape). Spotify draws that
video in its Now Playing sidebar, so keep the sidebar open and on video (its **Switch to
video** button); it moves into the cover while the song plays and back when the song or page
changes. Video podcasts are still not supported. Turn the experiment off to restore the
old notice and the thumbnail.

A video song is a separate Spotify track from the song's audio. Spicy Lyrics is asked about
the audio track Spotify pairs it with, and the other providers also try that track, but only
when the video is within about 3.5 seconds of the audio's length: a longer music video (an
intro, say) would otherwise get lyrics timed to the shorter song, running early. In that case
Spicy Lyrics is skipped and the providers look for the video's own length (LRCLIB and Genius
often still have it).

With **Live Video Background** on, its extra switch **Video Songs in the Background** puts the
video itself in the blurred background instead of the cover (Spotify's video cannot be in two
places at once). The cover then shows the song's normal album cover, or its animated Canvas or
Apple Music cover if it has one.
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

The item is worked out **once, for every source** (`providers/Resolve.ts`, `ResolveTrack`):

1. The artist is guessed from the title (`providers/Unlisted.ts`): file tags first (split on
   `;` and `/`), then "Artist - Song", "Song - Artist", "Song by Artist", `Artist-Song`, runs
   of underscores read as " - ", and the names after `ft`/`prod` as artists, after stripping
   extensions, track numbers and credit tails.
2. Those guesses are matched against Spotify's catalogue (`providers/SpotifySearch.ts`, via
   Spotify's own search, GraphQL `searchModalResults`, no Web API rate limit). A track is
   accepted when its title and artist match and its length is within 10 s of the file's; with
   no artist to vouch for it, an exact title match within 2 s.
3. On a match, every provider (Spicy Lyrics' API included) is handed the **catalogue entry**:
   its true title and artists, its length, album, cover and Spotify id. That is what lets
   Spotify-id sources (AMLL TTML DB, Musixmatch), cover matching (Genius) and exact-title
   sources work on a file named `03 - dua lipa - levitating.mp3`. Without a match, the guesses
   are tried in turn, up to six, and Spicy Lyrics (which needs a catalogue id) is skipped.

Files with junk names (`B0CXMH1CMX`, `New_Project`), unreleased songs and differently cut
versions get no catalogue match, so only the guesses reach the providers.

### Adding a provider

Everything is built from `providers/registry.ts`, so a new provider works with the priority
list, the Lyrics Sources panel, Check All Sources, pinning, the credit line, the
word-sync-first search, the upgrade-after-first-result search and local files and podcasts
without touching any of them:

1. Write `providers/Foo.ts` exporting `fetchFromFoo(track: TrackInfo)`; it returns lyrics in
   Spicy's shape (`Static` / `Line` / `Syllable`) with `source: "<creditKey>"`, or null.
2. Add it to `PROVIDER_META` (label, credit key, best sync rank) and to `ORDER` in the registry.
3. Add its fetcher to `fetchers` in `providers/index.ts`.

The build fails until all three are done. The provider is handed a `TrackInfo` that is the
song itself, or for a local file the catalogue entry it matched (see above), so it needs no
special handling for either.

Plain podcast episodes with no song in the title find nothing (they match nothing in the
catalogue and give no artist to guess). Video podcasts remain
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
