import Logger from "../../Logger.ts";
import { parseTTML } from "../ttml/parser.ts";
import { lyricsFor as lrcRedLyricsFor, type LrcRedWordSync } from "./LrcRed.ts";
import { cleanTitle, rankCandidates, type MatchOptions } from "./Match.ts";
import type { TrackInfo } from "./types.ts";

const logger = new Logger("BiniLyrics");

// BiniLyrics (https://lyrics.binimum.org) is an open lyrics API: no key, open CORS. It
// answers with TTML files, many of which it relays from lrc.red. Those are read through
// the lrc.red provider's own rules, so the "lrc.red Word Sync" setting still applies.
const API = "https://lyrics-api.binimum.org/";
const TIMEOUT_MS = 8000;
const MAX_CANDIDATES = 3;

// The same bar as lrc.red: word-timed lyrics are only right for the very same recording.
const MATCH: MatchOptions = { exactTitle: true, closeDurationMs: 500 };

type BiniResult = {
  track_name?: string;
  artist_name?: string;
  duration?: number;
  isrc?: string;
  timing_type?: string;
  lyricsUrl?: string;
};

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`BiniLyrics responded ${res.status}`);
  return res.json();
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

async function ttmlFrom(url: string): Promise<any | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return null;
  const parsed: any = parseTTML(await res.text());
  return parsed && (parsed.Content?.length > 0 || parsed.Lines?.length > 0) ? parsed : null;
}

export async function fetchFromBiniLyrics(track: TrackInfo, wordSync: LrcRedWordSync = "hand"): Promise<any | null> {
  const params = new URLSearchParams({ track: cleanTitle(track.name) || track.name, artist: track.artist });
  if (track.durationMs > 0) params.set("duration", String(Math.round(track.durationMs / 1000)));
  if (track.album) params.set("album", track.album);

  const body = await getJson(`${API}?${params}`);
  const results: BiniResult[] = Array.isArray(body?.results) ? body.results : [];

  const ranked = rankCandidates(
    track,
    results
      .filter((r) => r.lyricsUrl && r.timing_type !== "none")
      .map((r) => ({
        ...r,
        title: r.track_name ?? "",
        artists: [r.artist_name ?? ""],
        durationMs: (r.duration ?? 0) * 1000,
      })),
    MATCH
  ).slice(0, MAX_CANDIDATES);

  for (const hit of ranked) {
    try {
      const lyrics =
        hostOf(hit.lyricsUrl as string) === "lrc.red" && hit.isrc
          ? await lrcRedLyricsFor(hit.isrc, track, wordSync)
          : await ttmlFrom(hit.lyricsUrl as string);
      if (lyrics) return { ...lyrics, source: "binilyrics", sourceId: hit.isrc };
    } catch (error) {
      logger.warn("BiniLyrics lyrics lookup failed", error);
    }
  }
  return null;
}
