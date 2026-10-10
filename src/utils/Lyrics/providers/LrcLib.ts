import Logger from "../../Logger.ts";
import { parseLrcToLine, parsePlainToStatic } from "./Lrc.ts";
import type { TrackInfo } from "./types.ts";

const logger = new Logger("LRCLIB");

const BASE = "https://lrclib.net/api";
const TIMEOUT_MS = 8000;
// LRCLIB matches /get within ±2s; for /search results we accept a little more.
const SEARCH_DURATION_TOLERANCE_S = 5;

type LrcLibRecord = {
  trackName?: string;
  artistName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
};

async function getJson(url: string, signal?: AbortSignal): Promise<any | null> {
  const res = await fetch(url, {
    signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
    headers: { "Lrclib-Client": "SpicyLyrics" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`LRCLIB responded ${res.status}`);
  return res.json();
}

function qs(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") q.set(k, String(v));
  }
  return q.toString();
}

async function findRecord(track: TrackInfo): Promise<LrcLibRecord | null> {
  const durationS = Math.round(track.durationMs / 1000);

  // LRCLIB's /get is the one that is often overloaded (503) while /search still answers, so a
  // failure here is not the end of the lookup; only if the search fails too is it reported.
  const exact = await getJson(
    `${BASE}/get?${qs({
      track_name: track.name,
      artist_name: track.artist,
      album_name: track.album,
      duration: durationS || undefined,
    })}`
  ).catch((error) => {
    logger.debug("LRCLIB /get failed; trying /search", error);
    return null;
  });
  if (exact) return exact as LrcLibRecord;

  // /get is strict about the album and duration; fall back to a looser search.
  const results = (await getJson(
    `${BASE}/search?${qs({ track_name: track.name, artist_name: track.artist })}`
  )) as LrcLibRecord[] | null;
  if (!Array.isArray(results) || results.length === 0) return null;

  const usable = results.filter(
    (r) =>
      !durationS ||
      typeof r.duration !== "number" ||
      Math.abs(r.duration - durationS) <= SEARCH_DURATION_TOLERANCE_S
  );
  // Prefer a synced match, then the closest duration.
  usable.sort((a, b) => {
    const synced = Number(!!b.syncedLyrics) - Number(!!a.syncedLyrics);
    if (synced !== 0) return synced;
    return Math.abs((a.duration ?? 0) - durationS) - Math.abs((b.duration ?? 0) - durationS);
  });
  return usable[0] ?? null;
}

export async function fetchFromLrcLib(track: TrackInfo): Promise<any | null> {
  const record = await findRecord(track);
  if (!record || record.instrumental) return null;

  const durationS = record.duration ?? track.durationMs / 1000;

  if (record.syncedLyrics) {
    const parsed = parseLrcToLine(record.syncedLyrics, durationS);
    if (parsed) return { ...parsed, source: "lrclib" };
  }
  if (record.plainLyrics) {
    const parsed = parsePlainToStatic(record.plainLyrics);
    if (parsed) return { ...parsed, source: "lrclib" };
  }

  logger.debug("LRCLIB record had no usable lyrics", record.trackName);
  return null;
}
