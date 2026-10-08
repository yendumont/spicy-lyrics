import Logger from "../../Logger.ts";
import { parseTTML } from "../ttml/parser.ts";
import { parseLrcToLine, stripCreditLines, syllablesToLine } from "./Lrc.ts";
import { cleanTitle, rankCandidates, type MatchOptions } from "./Match.ts";
import type { TrackInfo } from "./types.ts";

const logger = new Logger("lrc.red");

// lrc.red (https://lrc.red/docs) is a free public catalogue of lyrics for about 30
// million tracks, keyed by ISRC. Each track has word-timed TTML and line-timed LRC.
// CORS is open and no key is needed. Spotify does not expose a track's ISRC to the
// client, so the track is found through the site's own search, which also reports
// each track's length.
const BASE = "https://lrc.red";
const TIMEOUT_MS = 8000;
const MAX_CANDIDATES = 3;

// Word-timed lyrics are only right for the very same recording, so the title must be the
// same, and a result by a differently named artist (an uploader account, for instance)
// must be within half a second of the playing length. Measured on a 418-track library:
// real matches by the same artist differ by up to about a second, while wrong ones with a
// different artist sat at 1.0 to 1.4 s.
const MATCH: MatchOptions = { exactTitle: true, closeDurationMs: 500 };

type SearchHit = {
  isrc?: string;
  title?: string;
  artist?: string;
  duration?: number;
};

/**
 * The site lists artists as one string, "The Weeknd, ROSALÍA", but some names contain a
 * comma themselves ("Tyler, The Creator"), so the whole string counts as a name too.
 */
function artistsOf(hit: SearchHit): string[] {
  const whole = (hit.artist ?? "").trim();
  return [whole, ...whole.split(/,\s*|\s+&\s+/)].filter((name, i, all) => name && all.indexOf(name) === i);
}

async function get(url: string): Promise<Response> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) return res;
  if (!res.ok) throw new Error(`lrc.red responded ${res.status}`);
  return res;
}

async function search(query: string): Promise<SearchHit[]> {
  const res = await get(`${BASE}/search.json?q=${encodeURIComponent(query)}`);
  if (res.status === 404) return [];
  const body = (await res.json()) as { hits?: SearchHit[] };
  return Array.isArray(body?.hits) ? body.hits : [];
}

export type LrcRedMatch = { isrc: string; title: string; artist: string; durationMs: number };

/** The catalogue entries that look like the playing track, best first. Exported for diagnosing matches. */
export async function findLrcRedMatches(track: TrackInfo): Promise<LrcRedMatch[]> {
  const title = cleanTitle(track.name) || track.name;
  const queries = [`${title} ${track.artist}`, title].filter((q, i, all) => all.indexOf(q) === i);

  for (const query of queries) {
    const hits = (await search(query)).filter((h): h is SearchHit & { isrc: string } => !!h.isrc);
    const ranked = rankCandidates(
      track,
      hits.map((h) => ({
        isrc: h.isrc,
        title: h.title ?? "",
        artists: artistsOf(h),
        artist: h.artist ?? "",
        durationMs: (h.duration ?? 0) * 1000,
      })),
      MATCH
    );
    logger.debug("lrc.red search", query, `${hits.length} hits, ${ranked.length} match`);
    if (ranked.length > 0) {
      return ranked
        .slice(0, MAX_CANDIDATES)
        .map((c) => ({ isrc: c.isrc, title: c.title, artist: c.artist, durationMs: c.durationMs }));
    }
  }
  return [];
}

/** lrc.red marks the timing of its TTML with its own attribute; the shared parser reads iTunes'. */
const asITunesTiming = (ttml: string) => ttml.replace(/\blrc:timing=/, "itunes:timing=");

/** How much of lrc.red's word timing to use: see `$lrcRedWordSync`. */
export type LrcRedWordSync = "hand" | "all" | "off";

const asWordSync = (value: string | undefined): LrcRedWordSync =>
  value === "all" || value === "off" ? value : "hand";

/**
 * Whether lrc.red's own model, rather than a person, timed this song's words. Its
 * song page says so ("Word-synced by lrc.red's in-house model"), and the data behind
 * the page carries it as `byModel`. null when that could not be read.
 */
async function isModelTimed(isrc: string): Promise<boolean | null> {
  try {
    const res = await get(`${BASE}/s/${encodeURIComponent(isrc)}.song.json`);
    if (res.status === 404) return null;
    const song = (await res.json()) as { byModel?: boolean };
    return song?.byModel === true;
  } catch (error) {
    logger.warn("lrc.red could not say how a song was timed", error);
    return null;
  }
}

/** One lrc.red song's lyrics by ISRC, with the word-sync policy applied. Also used by BiniLyrics, which relays lrc.red. */
export async function lyricsFor(isrc: string, track: TrackInfo, wordSync: LrcRedWordSync): Promise<any | null> {
  const ttml = await get(`${BASE}/s/${encodeURIComponent(isrc)}.ttml`);
  if (ttml.status !== 404) {
    let parsed = parseTTML(asITunesTiming(await ttml.text()));

    if (parsed?.Type === "Syllable" && wordSync !== "all") {
      // Keep word timing only for songs a person timed. When that cannot be told, play safe.
      const handTimed = wordSync === "hand" && (await isModelTimed(isrc)) === false;
      if (handTimed) return { ...parsed, sourceDetail: "hand-timed" };
      parsed = syllablesToLine(parsed);
    }
    if (parsed) return parsed;
  }

  // No usable TTML: fall back to the line-timed file.
  const lrc = await get(`${BASE}/s/${encodeURIComponent(isrc)}.lrc`);
  if (lrc.status !== 404) {
    const parsed = parseLrcToLine(stripCreditLines(await lrc.text()), track.durationMs / 1000);
    if (parsed) return parsed;
  }
  return null;
}

export async function fetchFromLrcRed(track: TrackInfo, wordSync?: string): Promise<any | null> {
  const mode = asWordSync(wordSync);

  // The closest match sometimes has no lyrics while another release of the same song
  // does, so try a few in order.
  for (const match of await findLrcRedMatches(track)) {
    const lyrics = await lyricsFor(match.isrc, track, mode);
    if (lyrics) return { ...lyrics, source: "lrcred", sourceId: match.isrc };
  }
  return null;
}
