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

/** The Apple Music ids of the albums that are this album by this artist, the exactly-named one first. */
async function findAppleAlbums(artist: string, album: string): Promise<number[]> {
  const res = await fetch(
    `https://itunes.apple.com/search?term=${encodeURIComponent(`${artist} ${album}`)}&entity=album&limit=8&country=us`,
    { signal: AbortSignal.timeout(TIMEOUT_MS) }
  );
  if (!res.ok) throw new Error(`Apple's search answered ${res.status}`);

  const wantArtist = plain(artist);
  const wantAlbum = plain(album);
  const same = (r: AppleAlbum) => {
    const a = plain(r.artistName ?? "");
    const c = plain(r.collectionName ?? "");
    return (
      !!a && !!c && (a.includes(wantArtist) || wantArtist.includes(a)) &&
      (c === wantAlbum || c.includes(wantAlbum) || wantAlbum.includes(c))
    );
  };

  const results = (((await res.json()) as { results?: AppleAlbum[] }).results ?? []).filter(same);
  results.sort(
    (x, y) => Number(plain(y.collectionName ?? "") === wantAlbum) - Number(plain(x.collectionName ?? "") === wantAlbum)
  );
  return results.slice(0, 2).flatMap((r) => (r.collectionId ? [r.collectionId] : []));
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

async function load(key: string, artist: string, album: string): Promise<string | null> {
  const cache = await caches.open(CACHE);

  const kept = await cache.match(`/video/${key}`);
  if (kept) return URL.createObjectURL(await kept.blob());

  const none = await cache.match(`/none/${key}`);
  if (none && Date.now() - Number(none.headers.get("x-saved") ?? 0) < NONE_TTL_MS) return null;

  const base = normalizeProxyUrl($geniusProxyUrl.get());
  if (!base) return null;

  // The album is found from here, with the listener's own address (Apple turns away searches
  // from the shared addresses a Worker runs on); the Worker only reads the album's page.
  const ids = await findAppleAlbums(artist, album);
  if (ids.length === 0) {
    await cache.put(`/none/${key}`, new Response("{}", { headers: { "x-saved": String(Date.now()) } }));
    return null;
  }

  let square: string | undefined;
  for (const id of ids) {
    const res = await fetch(
      `${base}/motion?id=${id}&artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) }
    );
    // A Worker without the animated-cover update answers 404: nothing to remember about the album.
    if (res.status === 404) {
      logger.debug("The Worker has no /motion endpoint; redeploy it for animated covers");
      return null;
    }
    if (!res.ok) throw new Error(`The Worker answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 80)}`);
    square = ((await res.json()) as { square?: string }).square;
    if (square) break;
  }

  if (!square) {
    await cache.put(`/none/${key}`, new Response("{}", { headers: { "x-saved": String(Date.now()) } }));
    return null;
  }

  const video = await transcodeMotion(square);
  await cache.put(`/video/${key}`, new Response(video, { headers: { "Content-Type": "video/webm", "x-saved": String(Date.now()) } }));
  void evictOldest(cache);
  return URL.createObjectURL(video);
}

export function getAnimatedCover(artist: string, album: string): Promise<string | null> {
  const key = coverKey(artist, album);
  if (urls.has(key)) return Promise.resolve(urls.get(key) ?? null);

  let promise = pending.get(key);
  if (!promise) {
    promise = load(key, artist, album)
      .then((url) => {
        urls.set(key, url);
        return url;
      })
      .catch((error) => {
        // Not remembered: a dropped connection or a busy moment should not hide the cover for good.
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
