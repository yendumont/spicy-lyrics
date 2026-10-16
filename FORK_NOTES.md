# Fork notes: handover for a new AI (or human)

Read this first. It is the full context for the user's fork of Spicy Lyrics (`<owner>/spicy-lyrics`,
upstream `Spikerko/spicy-lyrics`). `RUNBOOK.md` covers install/update/troubleshooting for the user;
`CLAUDE.md` covers the experiments contract. This file covers everything else.

## 1. What this is

A **Spicetify extension** that runs inside the Spotify desktop client (CEF Chromium). It depends on
`window.Spicetify.*` at runtime. It is not a web app. Built with bun + `@spicemod/creator`
(`spice.config.ts`), installed as its **own** extension `spicy-lyrics-hype.providers.js` so official Spicy Lyrics
updates can't overwrite it. Never enable it alongside the official `spicy-lyrics.mjs` (same page route,
same `SL:settings` key).

The fork adds, on top of upstream:

- ~15 lyrics providers, a priority list (arrows + drag and drop), fallback, "Prefer Best Sync".
- Show-first-then-upgrade search (the first lyrics found are shown at once, better-synced ones replace them).
- A **Lyrics Sources** settings panel: per-provider status, "Check All Sources", per-song pin, "Clear Chosen Source".
- Experiment **Lyrics for Local Files & Podcasts** (`unlistedLyrics`).
- Experiment **Embedded Lyrics for Local Files** (`embeddedLocalLyrics`): lyrics in a local file's tags (ID3 USLT/SYLT/TXXX, Vorbis comments, MP4 `©lyr`) shown word/line/unsynced by what they hold. The page cannot open files, so the listener picks a folder once (`<input type=file>`); tags are read in the page and kept in Cache Storage `SpicyLyrics_EmbeddedLyrics_g1`, matched by artist+title from the `spotify:local:` uri. Hooked in `fetchLyrics.ts` before the `local-track` bail-out. Code in `utils/LocalEmbed/`. Verified in Spotify with real local FLAC and MP3 files; a local track only starts through `PlayerAPI.play({uri:"spotify:local-files"}, ..., {skipTo})`.
- Experiment **TTML to Enhanced LRC Converter** (`ttmlToLrc`): `utils/LocalEmbed/TtmlToLrc.ts`, panel in `LocalLyricsTools.tsx`.
- Experiment **Word-Synced Translation** (`syncedTranslation`): on word-synced songs the translation is chunked by Gemini against the numbered sung words and lit word by word (`Extras/TranslationSyncDriver.ts`, driven from `Animate()`). Verified on Blinding Lights to Spanish; the same Translation.ts cache holds it (JSON chunk strings, key prefixed with a `§`-tagged word list).
- **Line meanings** from Genius annotations (setting `lineMeaningsFrom`: artist / artist+editors / everyone).
- **Gemini translation** with the user's own key (`geminiApiKey`, `translateLyrics`, `translationLanguage`).
- Experiment **Animated Album Covers** (`animatedCover`): Apple Music motion art -> WebM via ffmpeg.wasm.
- Experiment **Live Video Background** (`liveBackground`, with a blur slider): see "Live background" below. Spotify Canvas is upstream's Canvas Stage.
- A **Cloudflare Worker** (`workers/genius-proxy/worker.js`) for everything the Spotify page can't fetch itself.

## 2. Environment and workflow (Windows)

- Repo: the working folder of the checkout. Shell is PowerShell 5.1 (no `&&`).
- **`git` is not on PATH** in the agent's PowerShell. Use
  `%LOCALAPPDATA%\GitHubDesktop\app-<version>\resources\app\git\cmd\git.exe` (GitHub Desktop's bundled git).
- `node` and `wrangler` are **not installed**. bun is. The user deploys the Worker by pasting `worker.js` into the
  Cloudflare dashboard; you cannot deploy it. After a Worker change, tell them to redeploy, then test the live URL.
- Build + install + restart Spotify: `powershell -ExecutionPolicy Bypass -File scripts\install-spicetify.ps1 -SkipInstall`
  (it runs `spicetify apply`, which restarts Spotify). Lint: `bun run lint`. Types: `bun x tsc --noEmit`.
- macOS/Linux: `scripts/install-spicetify.sh` and `scripts/update-fork.sh` mirror the PowerShell scripts (see RUNBOOK.md, `macOS and Linux`). They were written without access to a Mac or bash and are **untested**; keep them in sync with the `.ps1` versions when either changes. `.gitattributes` forces LF for `*.sh`.
- Remotes: `origin` = user's fork, `upstream` = Spikerko. `scripts\update-fork.ps1` merges upstream.
- **Rules from the user:** commit only when told. **Do not push** (no credentials here). Commit trailer:
  `Co-Authored-By: Claude ... <noreply@anthropic.com>`. No secrets in the repo. Never use or store tokens the user
  pastes in chat (Genius credentials, Musixmatch tokens). Don't circumvent anyone's access controls (Musixmatch
  stays "needs your own token", no impersonating official apps). Leave the user's Spotify settings exactly as found
  after tests.
- Push state: everything is pushed (checked 2026-10-17: `main` equals `origin/main`). Tag `v1.0.4` is the upstream merge `7b4bfd4`; later commits are docs only (the README Updating section).

## 3. Code map (src/)

| Area | Where |
|---|---|
| Provider registry (single source of truth) | `utils/Lyrics/providers/registry.ts` (`PROVIDER_META`, `ORDER`) |
| Fetchers wiring | `providers/index.ts` (`fetchers`, `FetchFromExternalProviders`) |
| Per-provider clients | `providers/{Lrc*,Unison,NetEase,QQMusic,Kugou,Kuwo,Deezer,Musixmatch,AmllTtmlDb,BiniLyrics,YouTubeMusic,Genius}.ts` |
| Matching / ranking helpers | `providers/Match.ts`, `CoverMatch.ts`, `Lrc.ts` (LRC parsing, sync rank 1 unsynced / 2 line / 3 word), `Http.ts` |
| Track lookup for local files / podcasts | `providers/Resolve.ts` (`ResolveTrack`), `Unlisted.ts`, `SpotifySearch.ts` |
| Sources panel data | `providers/Sources.ts`, `LookupReport.ts`, `utils/LyricsSourceTools.ts` |
| Priority list logic | `providers/ProviderOrder.ts` |
| Orchestration around Spicy's API | `utils/Lyrics/fetchLyrics.ts` |
| Genius id aliases | `providers/GeniusAliases.ts` |
| Per-line extras (meanings, translation) | `utils/Lyrics/Extras/` (`index.ts`, `LineElements.ts`, `Meanings*.ts`, `MeaningsUI.ts`, `Translation.ts`, `SyncedWords.ts`, `TranslationSyncDriver.ts`) |
| Animated covers | `utils/AnimatedCover/` (`AnimatedCover.ts`, `FFmpegLoader.ts`, `Transcode.ts`) |
| Experiments registry | `utils/experiments.ts` |
| Settings store / UI | `utils/stores.ts`, `components/ReactComponents/SettingsPanel/LyricsSection.tsx` |
| Lyrics rendering | `utils/Lyrics/Applyer/`, `Animator/`, `LyricsVirtualizer.ts` |

### Adding a provider (compiler-enforced)

1. `providers/Foo.ts` exporting `fetchFromFoo(track: TrackInfo)` returning Spicy's lyrics shape
   (Static / Line / Syllable) with `source: "<creditKey>"`, or null.
2. Add to `PROVIDER_META` and `ORDER` in `registry.ts` (`maxRank` if it can't give word sync).
3. Add the fetcher to `fetchers` in `providers/index.ts`.
Settings list, Sources panel, credit line, pinning and fallback all derive from the registry.

### Adding an experiment

Append to `EXPERIMENTS` in `utils/experiments.ts` (see `CLAUDE.md`). Prefer CSS via `pageClass`.
Current ones: `newProgressBarStyling`, `duetLinePadding`, `lyricsSkeleton` (upstream), `animatedCover` (default off),
`unlistedLyrics` (default off). Experiment ids persist as `experiment:<id>` keys.

### Settings

All settings live in one JSON blob at `Spicetify.LocalStorage` key **`SL:settings`**. Fork keys:
`lyricsProvider`, `lyricsProviderFallback`, `lyricsProviderOrder`, `lyricsProvidersDisabled`, `lyricsProviderPicks`
(per-song pin), `preferBestSync`, `lrcRedWordSync`, `geniusProxyUrl`, `geniusLooseSearch`, `geniusEagerMatch`,
`geniusFavoriteArtists`, `musixmatchToken`, `lineMeaningsFrom`, `translateLyrics`, `translationLanguage`,
`geminiApiKey`, plus the experiment keys. Defaults: Musixmatch and QQ Music are in `lyricsProvidersDisabled`.
Translation default model is `gemini-3.5-flash-lite`; cached under Cache Storage `SpicyLyrics_Translations_g1`.

Gotcha: writing `SL:settings` while the page is live can be overwritten by the in-memory store. To restore,
do a raw `Spicetify.LocalStorage.set(...)` and reload immediately.

## 4. The Worker (`workers/genius-proxy/worker.js`)

Deployed by the user on their own Cloudflare account, at a `https://<name>.workers.dev` address (set as `geniusProxyUrl`). It only answers
requests whose Origin is `https://xpui.app.spotify.com`, holds no secrets, and is not an open proxy. Why it exists:
Spotify's page can't read Genius/YouTube Music/Apple (no CORS) and `Spicetify.CosmosAsync` drops request headers.

Endpoints: `/search?q=` (Genius JSON), `/lyrics?path=&id=` (Genius lyrics HTML), `/meanings?song_id=`,
`/referents?song_id=`, `/ytm/search?q=`, `/ytm/lyrics?videoId=`, `/motion?id=` (Apple album id ->
`{square, tall}` HLS URLs).

Hard-won facts:

- **Genius blocks Cloudflare egress IPs for lyrics HTML pages** (403, earlier a redirect loop), but `genius.com/api/*`
  works. Fix (commit `1a34f22`): when `/lyrics` gets a numeric `id`, fetch
  `https://genius.com/songs/<id>/embed.js`, parse the `JSON.parse('...')` literal, unescape, take `rg_embed_body`, and
  return it wrapped in `<div data-lyrics-container="true">` (what `Genius.ts:extractLyrics` reads). Falls back to the
  page fetch (manual redirects with a cookie jar) when there is no id or embed fails.
- **Apple blocks iTunes search from Cloudflare.** So the extension searches iTunes from the user's PC and sends the
  album id to `/motion`, which only reads the album page.
- Direct page `fetch` is CORS-limited, so anything new that is cross-origin needs a Worker route (and a redeploy).
- Never claim the Worker works end to end from `curl` alone: also confirm inside Spotify.

### Animated covers: how matching and speed work

- Lookup (`AnimatedCover.ts`): Apple's iTunes **album** search often leaves the album out (Blonde, MAYHEM, BRAT, Future Nostalgia
  were missed), so the extension also searches by **song** and keeps editions whose artist/album names match. Up to 5 editions are
  asked about, 3 at a time, because often only one edition (e.g. the standard, not the deluxe) has motion art. Only some albums
  have motion art at all (about 40% of popular ones in a 40-album survey), so a missing cover is often genuine.
- "No animated cover" answers are cached for a week under `/none2/<key>` in Cache Storage `SpicyLyrics_AnimatedCover_g1`
  (`/none/` was the older, unreliable matching; bump the prefix again if matching changes).
- Speed (`Transcode.ts`): conversion was single-threaded (~20 s). It now splits the clip into up to 4 pieces, converts each in its own
  ffmpeg.wasm, and joins them with the concat demuxer (`-c copy`): ~6 s, about 8 s from song start. Falls back to one piece if that fails.
  Timings and findings came from the debug port; the Spotify GraphQL helper only works on a fresh Spotify start (not after a page reload).
### Live background (utils/AnimatedCover/)

Spotify Canvas is upstream's now (Canvas Stage, `components/DynamicBG/CanvasImmersive.ts`); the fork's own Canvas code and the `spotifyCanvas` experiment were removed in the 6.4.0 merge.

- `Motion.ts`: `getMotion({apple}, isCurrent)` finds the album's Apple animated cover; `loopVideo`/`dropVideo`/`pauseOrResumeAll` are shared by the cover and the background.
  `AnimatedCover.ts:memoVideo(key, produce)` is the shared memory+Cache Storage layer (`/video/<key>`, max 40, the Apple hash).
- `index.ts` = the cover (needs `animatedCover`); `LiveBackground.ts` = a `<video class="LiveBackgroundVideo">` appended to `.ContentBox`
  at z-index 1 (above the `.spicy-dynamic-bg` canvas, below lyrics z 4), CSS in `css/Lyrics/Extras.css`, blur via `--LiveBackgroundBlur` (set on the page and root, like the static background blur).
- Experiments can carry one `slider` and one `toggle` (see the header of `utils/experiments.ts`; `$experimentSlider(id)`, `$experimentToggle(id)`, persisted as `experimentValue:<id>` / `experimentOption:<id>`) and a `tool` panel; `ExperimentsPanel.tsx` shows them under the row while the experiment is on.
### Video songs (`videoSongs` experiment, default on)

- Tracks Spotify plays as music videos have `Player.data.item.mediaType === "video"` (still `type: "track"`, normal track URI). `fetchLyrics.ts` used to stop them
  with the "video lyrics" notice; with the experiment on they go through the normal pipeline (verified: "For The Better" got lyrics from NetEase).
  Video podcasts (`mixed`) are still refused.
- `utils/VideoSongs.ts` shows the real video in the Now Bar cover. Spotify's video is a protected (EME, `video.mediaKeys`) MSE `<video>` inside
  `.VideoPlayer__container` in the Now Playing sidebar: `captureStream` is refused and a canvas copy would be black, and a `position:fixed` overlay is
  clipped/offset by transformed `overflow:hidden` ancestors. What works is moving the `<video>` element itself into `.MediaImageContainer` (it keeps playing, in sync).
  Only the `<video>` moves, never `.VideoPlayer__container` (React owns it and would throw on removing a node that moved). A temporary `Node.prototype.removeChild`
  guard makes Spotify's own `container.removeChild(video)` a no-op while the video is held. It goes home on song change, `page:destroy`, sidebar/NowBar changes, and is
  re-held by a 700 ms check (only runs for video songs). The cover box becomes 16:9 via `.HasPlayerVideo` + `--PlayerVideoAspect` (CSS in `Extras.css`).
- **Audio twin.** A video song has its own track id (and often a longer cut and a title like `Song (feat. X)`) that Spicy's API has never heard of; its metadata names the audio
  track in `audio_association`. `Resolve.ts` reads that track with the `getTrack` GraphQL query (`videoTwin`). Spicy is asked about the twin's id (`spicyIdForVideoSong`, used by
  `fetchLyrics.ts` and `SpicyApi.ts`) and every provider also gets the twin as a second reading, **but only when the two lengths are within 3.5 s** (`TWIN_MAX_DRIFT_MS`):
  timed lyrics made for the audio cut would run early/late against a longer video, so otherwise Spicy is skipped (`notfound`) and only the video's own title and length are searched.
  Lyrics are still cached under the video's own id so they never leak into the audio track's cache. Checked on `For The Better` (twin 130.6 s vs video 133 s: Spicy word-synced) and
  `Levitating (feat. DaBaby)` (203.8 s vs 232 s: twin skipped; only LRCLIB and Genius had matching records).
- **Video in the background.** `liveBackground` has a `toggle` (`experimentOption:liveBackground`, see `experiments.ts`): when on, a video song's real `<video>` is moved into `.ContentBox` with the
  `LiveBackgroundVideo` class (same blur/darkening as the Canvas background) instead of the cover. The one element cannot be in two places (EME: no `captureStream`, no canvas copy), so the cover then shows the song's normal cover (`SpotifyPlayer.GetCover` returns the audio track's `audio_association_image*` while `videoSongInBackground()` (`utils/videoSongMode.ts`) is true)
  or its animated Canvas/Apple cover: Canvas is read for the audio twin with `Definitions.canvas` `{trackUri}` (works for any track; `Canvas.ts`) and Apple is looked up by the twin's album too (`Motion.ts`). `VideoSongs.ts` exports `heldMode()`/`onHeldChange` so the animated cover and the Canvas/Apple background step aside only while the real video is actually held.
- LRCLIB''s `/get` often answers 503 while `/search` works; `LrcLib.ts` now falls back to search instead of reporting Failed.
- Spotify only creates the `<video>` when its video mode is really on; after a restart it can be on in settings yet have no element until the sidebar's
  "Switch to audio"/"Switch to video" is toggled (the sidebar must be open). Animated covers/Canvas are skipped for video songs.
## 5. Testing against the real client

Per `CLAUDE.md`, if `127.0.0.1:8088` serves Spotify's debugger, test there automatically. To start one:
quit Spotify, then launch it with `--remote-debugging-port=8088`. Run JS in the page with
`bun scripts/dev/cdp.ts <file.js>` (picks the `xpui.app.spotify.com` target, runs the expression with
`awaitPromise`, prints the value). Typical flow: write a small async IIFE that does
`Spicetify.Platform.History.push("/SpicyLyrics")`, `Spicetify.Player.playUri(...)`, waits, then reads the DOM
(`#SpicyLyricsPage .LyricsContent .line`, `.LineTranslation`, `[data-sonner-toast]`).

Before changing settings in a test, read `SL:settings`, keep a copy **outside the repo** (it contains the user's
Gemini key), and restore it at the end. Reference test songs: Levitating `spotify:track:39LLxExYz6ewLAcYrzQQyP`;
Genius check songs: Levitating, Without Me, Blinding Lights, Faded.
Past verification (all endpoints, providers, meanings, translation incl. Spanish, animated covers, extras cleanup)
passed. The Genius embed fix was verified at the Worker level only; confirm end to end in Spotify.

## 6. Known state and open items

- Genius-only songs: user should confirm lyrics load in Spotify after the embed fix. If they still fail, get the
  Worker's `/lyrics?path=...&id=...` error body, then test in-client via the debug port.
- Musixmatch needs the user's own token and is off by default. QQ Music is off by default.
- Not pushed. The user decides when.
- Unused experiment ideas: none recorded.

## 7. Style

Match surrounding code: comment *why*, not *what*; header comments on modules that explain contracts (see
`registry.ts`, `experiments.ts`, `worker.js`); no unrelated refactors; both states of an experiment must work.

- Settings panel: upstream's tabbed panel is built from SettingDef/SectionDef (SettingsPanel/model.ts). The fork's provider, Genius and translation settings live in SettingsPanel/ProviderSettings.tsx and are appended to the Lyrics tab with one line in LyricsSection.tsx, so upstream changes to that file rarely conflict. Experiment extras (slider, toggle, tool) render in ExperimentsPanel.tsx.
