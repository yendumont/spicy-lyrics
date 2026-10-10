import { toast } from "sonner";
import Logger from "../Logger.ts";
import { normalizeProxyUrl } from "../Lyrics/providers/Genius.ts";
import { $geniusProxyUrl } from "../stores.ts";
import { transcodeMotion } from "./Transcode.ts";

const logger = new Logger("Animated Cover");

/**
 * An album's animated cover as a video Spotify can play, or null when it has none.
 *
 * The Worker finds the album on Apple Music and says where its animated cover (an HLS
 * stream) is; the stream is converted once (see Transcode.ts) and the result kept in the
 * browser cache, so every later play of the album is instant and offline. Albums with no
 * animated cover are remembered for a week so they are not asked about again.
 */
const CACHE = "SpicyLyrics_AnimatedCover_g1";
const MAX_KEPT = 40;
const NONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 12_000;

const plain = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "");

export function coverKey(artist: string, album: string): string {
  const text = `${plain(artist)}|${plain(album)}`;
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const reported = new Set<string>();

/** Object URLs of videos already read this session, so a replay is free. */
const urls = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

type AppleAlbum = { collectionId?: number; collectionName?: string; artistName?: string };

/** How many editions of an album are looked at, and how many are asked about at once. */
const MAX_EDITIONS = 5;
const AT_ONCE = 3;

async function itunes(term: string, entity: "album" | "song"): Promise<AppleAlbum[]> {
  const res = await fetch(
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=${entity}&limit=25&country=us`,
    { signal: AbortSignal.timeout(TIMEOUT_MS) }
  );
  if (!res.ok) throw new Error(`Apple's search answered ${res.status}`);
  return ((await res.json()) as { results?: AppleAlbum[] }).results ?? [];
}

/**
 * The Apple Music ids of the albums that are this album by this artist, best guess first.
 *
 * Apple's album search matches loosely and often leaves the album itself out of its answer
 * (a famous album can lose to singles and karaoke versions), while a search for one of its songs
 * finds it reliably. So both are asked, and an album found by its song counts for more.
 */
async function findAppleAlbums(artist: string, album: string, track: string): Promise<number[]> {
  const [byAlbum, bySong] = await Promise.all([
    itunes(`${artist} ${album}`, "album"),
    // A failed song search must not lose the album search's answer.
    track ? itunes(`${artist} ${track}`, "song").catch(() => [] as AppleAlbum[]) : Promise.resolve([] as AppleAlbum[]),
  ]);

  const wantArtist = plain(artist);
  const wantAlbum = plain(album);
  const same = (r: AppleAlbum) => {
    const a = plain(r.artistName ?? "");
    const c = plain(r.collectionName ?? "");
    return (
      !!r.collectionId && !!a && !!c && (a.includes(wantArtist) || wantArtist.includes(a)) &&
      (c === wantAlbum || c.includes(wantAlbum) || wantAlbum.includes(c))
    );
  };

  const found = new Map<number, { name: string; fromSong: boolean }>();
  for (const [list, fromSong] of [[bySong, true], [byAlbum, false]] as const) {
    for (const r of list.filter(same)) {
      const id = r.collectionId as number;
      const seen = found.get(id);
      found.set(id, { name: plain(r.collectionName ?? ""), fromSong: fromSong || !!seen?.fromSong });
    }
  }

  // The album named exactly as asked first, then the editions of it that the song is on.
  return [...found.entries()]
    .sort(
      ([, x], [, y]) =>
        Number(y.name === wantAlbum) - Number(x.name === wantAlbum) || Number(y.fromSong) - Number(x.fromSong)
    )
    .slice(0, MAX_EDITIONS)
    .map(([id]) => id);
}

/** An edition's animated cover stream, null when it has none; a Worker without the endpoint is `undefined`. */
async function motionOf(base: string, id: number, artist: string, album: string): Promise<string | null | undefined> {
  const res = await fetch(
    `${base}/motion?id=${id}&artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}`,
    { signal: AbortSignal.timeout(TIMEOUT_MS) }
  );
  // A Worker without the animated-cover update answers 404: nothing to remember about the album.
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`The Worker answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 80)}`);
  return ((await res.json()) as { square?: string }).square ?? null;
}

async function evictOldest(cache: Cache): Promise<void> {
  const videos = (await cache.keys()).filter((request) => request.url.includes("/video/"));
  if (videos.length <= MAX_KEPT) return;
  const saved = await Promise.all(
    videos.map(async (request) => ({
      request,
      at: Number((await cache.match(request))?.headers.get("x-saved") ?? 0),
    }))
  );
  saved.sort((a, b) => a.at - b.at);
  for (const old of saved.slice(0, videos.length - MAX_KEPT)) await cache.delete(old.request);
}

/** Remembers that an album has no animated cover, so it is not asked about again for a week. */
async function remember(cache: Cache, key: string): Promise<void> {
  await cache.put(`/none2/${key}`, new Response("{}", { headers: { "x-saved": String(Date.now()) } }));
}

/** The Apple Music cover for an album, converted; null when it has none. */
async function loadApple(cache: Cache, key: string, artist: string, album: string, track: string): Promise<Blob | null> {
  // "none2": answers kept before the song search was added were often wrong, so they are not used.
  const none = await cache.match(`/none2/${key}`);
  if (none && Date.now() - Number(none.headers.get("x-saved") ?? 0) < NONE_TTL_MS) return null;

  const base = normalizeProxyUrl($geniusProxyUrl.get());
  if (!base) return null;

  // The album is found from here, with the listener's own address (Apple turns away searches
  // from the shared addresses a Worker runs on); the Worker only reads the album's page.
  const ids = await findAppleAlbums(artist, album, track);
  if (ids.length === 0) {
    await remember(cache, key);
    return null;
  }

  // An album's editions rarely all have the animated cover (often only one does), so they are
  // asked about a few at a time, and the first in order that has one wins.
  let square: string | null = null;
  let failure: unknown;
  let answered = false;
  for (let i = 0; i < ids.length && !square; i += AT_ONCE) {
    const batch = await Promise.allSettled(ids.slice(i, i + AT_ONCE).map((id) => motionOf(base, id, artist, album)));
    for (const outcome of batch) {
      if (outcome.status === "rejected") {
        failure ??= outcome.reason;
        continue;
      }
      if (outcome.value === undefined) {
        logger.debug("The Worker has no /motion endpoint; redeploy it for animated covers");
        return null;
      }
      answered = true;
      square ??= outcome.value;
    }
  }

  // Only an edition that really had none is remembered as none; if every one failed to answer,
  // the problem is passed on (and not remembered) so a later play tries again.
  if (!square) {
    if (!answered && failure) throw failure;
    await remember(cache, key);
    return null;
  }

  return transcodeMotion(square);
}

/**
 * A converted video by key, from whichever source makes it: kept in memory for this session,
 * else in the browser cache (so every later play is instant and offline), else made by `produce`
 * and kept. Null when there is none; a failure is reported once and not remembered, so a dropped
 * connection or a busy moment does not hide a cover for good.
 */
export function memoVideo(key: string, produce: (cache: Cache) => Promise<Blob | null>): Promise<string | null> {
  if (urls.has(key)) return Promise.resolve(urls.get(key) ?? null);

  let promise = pending.get(key);
  if (!promise) {
    promise = (async () => {
      const cache = await caches.open(CACHE);
      const kept = await cache.match(`/video/${key}`);
      if (kept) return URL.createObjectURL(await kept.blob());

      const video = await produce(cache);
      if (!video) return null;
      await cache.put(`/video/${key}`, new Response(video, { headers: { "Content-Type": "video/webm", "x-saved": String(Date.now()) } }));
      void evictOldest(cache);
      return URL.createObjectURL(video);
    })()
      .then((url) => {
        urls.set(key, url);
        return url;
      })
      .catch((error) => {
        logger.warn("Could not get an animated cover", error);
        // Said once per kind of problem: otherwise the cover is just missing, with no hint why.
        const message = error instanceof Error ? error.message : String(error);
        if (!reported.has(message)) {
          reported.add(message);
          toast.error(`Animated cover unavailable: ${message.slice(0, 120)}`);
        }
        return null;
      })
      .finally(() => pending.delete(key));
    pending.set(key, promise);
  }
  return promise;
}

export function getAnimatedCover(artist: string, album: string, track = ""): Promise<string | null> {
  const key = coverKey(artist, album);
  return memoVideo(key, (cache) => loadApple(cache, key, artist, album, track));
}