import Logger from "../../Logger.ts";
import { normalizeProxyUrl } from "./Genius.ts";
import { parsePlainToStatic } from "./Lrc.ts";
import { rankCandidates } from "./Match.ts";
import type { TrackInfo } from "./types.ts";

const logger = new Logger("YouTube Music");

// YouTube Music has plain (unsynced) lyrics, licensed from LyricFind. Its API is out of
// reach of Spotify's page (no CORS, and Spicetify's proxy is refused), so it goes through
// the same Cloudflare Worker as Genius (workers/genius-proxy, /ytm/*). Without the
// Worker's address in settings, this provider returns nothing.
const TIMEOUT_MS = 10000;
const MAX_CANDIDATES = 2;

type Song = { videoId: string; title: string; artists: string[]; durationMs: number };

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Proxy responded ${res.status}`);
  return res.json();
}

export async function fetchFromYouTubeMusic(track: TrackInfo, proxyUrl: string): Promise<any | null> {
  const base = normalizeProxyUrl(proxyUrl);
  if (!base) return null;

  const found = await getJson(`${base}/ytm/search?q=${encodeURIComponent(`${track.artist} ${track.name}`)}`);
  const songs: Song[] = Array.isArray(found?.songs) ? found.songs : [];

  const ranked = rankCandidates(
    track,
    songs.map((s) => ({ ...s }))
  ).slice(0, MAX_CANDIDATES);

  for (const song of ranked) {
    try {
      const lyrics = await getJson(`${base}/ytm/lyrics?videoId=${encodeURIComponent(song.videoId)}`);
      const parsed = lyrics?.text ? parsePlainToStatic(lyrics.text) : null;
      if (parsed) {
        return {
          ...parsed,
          source: "youtubemusic",
          ...(lyrics.source ? { sourceDetail: lyrics.source } : {}),
        };
      }
    } catch (error) {
      logger.warn("YouTube Music lyrics lookup failed", error);
    }
  }
  return null;
}
