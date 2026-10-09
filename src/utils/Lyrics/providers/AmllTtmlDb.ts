import Logger from "../../Logger.ts";
import { parseTTML } from "../ttml/parser.ts";
import { findSongs } from "./NetEase.ts";
import type { TrackInfo } from "./types.ts";

const logger = new Logger("AMLL TTML DB");

// The AMLL TTML DB is a community-kept repository of word-timed lyrics, filed by the id
// each song has on a streaming service. GitHub serves the files with open CORS.
const BASE = "https://raw.githubusercontent.com/amll-dev/amll-ttml-db/main";
const TIMEOUT_MS = 8000;

async function getTtml(folder: string, id: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/${folder}/${encodeURIComponent(id)}.ttml`, { signal: controller.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`AMLL TTML DB answered ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function parse(ttml: string): any | null {
  const parsed: any = parseTTML(ttml);
  if (!parsed || !(parsed.Content?.length > 0 || parsed.Lines?.length > 0)) return null;
  return { ...parsed, source: "amll" };
}

export async function fetchFromAmllTtmlDb(track: TrackInfo): Promise<any | null> {
  // Songs in Spotify's catalogue are filed by their Spotify id (a local file or episode
  // has one once it has been matched to the catalogue; see Resolve.ts).
  if (track.spotifyId) {
    const ttml = await getTtml("spotify-lyrics", track.spotifyId);
    const lyrics = ttml ? parse(ttml) : null;
    if (lyrics) return lyrics;
  }

  // Not filed under Spotify: the same song is often filed under its NetEase id.
  try {
    for (const song of (await findSongs(track)).slice(0, 2)) {
      const ttml = await getTtml("ncm-lyrics", String(song.id));
      const lyrics = ttml ? parse(ttml) : null;
      if (lyrics) return lyrics;
    }
  } catch (error) {
    logger.debug("NetEase lookup for the AMLL TTML DB failed", error);
  }
  return null;
}
