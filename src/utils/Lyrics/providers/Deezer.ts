import Logger from "../../Logger.ts";
import { buildUrl, getViaCosmos, postViaCosmos } from "./Http.ts";
import { entriesToLine, parsePlainToStatic } from "./Lrc.ts";
import { rankCandidates } from "./Match.ts";
import type { TrackInfo } from "./types.ts";

const logger = new Logger("Deezer");

// Deezer's public search needs no key. Lyrics are on the GraphQL endpoint its web
// player uses, which takes the anonymous token Deezer hands every visitor.
const API = "https://api.deezer.com";
const AUTH_URL = "https://auth.deezer.com/login/anonymous?jo=p&rto=c";
const PIPE_URL = "https://pipe.deezer.com/api";

const LYRICS_QUERY = `query GetLyrics($trackId: String!) {
  track(trackId: $trackId) {
    lyrics { text synchronizedLines { line milliseconds duration } }
  }
}`;

type DeezerTrack = {
  id: number;
  title?: string;
  title_version?: string;
  duration?: number;
  artist?: { name?: string };
};

const MAX_CANDIDATES = 3;

// The token lasts a few minutes; one is kept until shortly before it runs out.
let token: { jwt: string; expires: number } | null = null;

async function getToken(): Promise<string> {
  if (token && token.expires > Date.now()) return token.jwt;
  const res = await getViaCosmos(AUTH_URL);
  if (typeof res?.jwt !== "string") throw new Error("Deezer gave no token");
  token = { jwt: res.jwt, expires: Date.now() + 4 * 60 * 1000 };
  return res.jwt;
}

async function findTracks(track: TrackInfo): Promise<{ id: number; durationMs: number }[]> {
  const res = await getViaCosmos(
    buildUrl(`${API}/search`, { q: `artist:"${track.artist}" track:"${track.name}"`, limit: 10 })
  );
  let list = res?.data as DeezerTrack[] | undefined;
  if (!Array.isArray(list) || list.length === 0) {
    // The quoted form is strict about spelling; a plain query is not.
    const loose = await getViaCosmos(buildUrl(`${API}/search`, { q: `${track.artist} ${track.name}`, limit: 10 }));
    list = loose?.data as DeezerTrack[] | undefined;
  }
  if (!Array.isArray(list) || list.length === 0) return [];

  return rankCandidates(
    track,
    list.map((t) => ({
      id: t.id,
      title: `${t.title ?? ""}${t.title_version ? ` ${t.title_version}` : ""}`,
      artists: [t.artist?.name ?? ""],
      durationMs: (t.duration ?? 0) * 1000,
    }))
  )
    .slice(0, MAX_CANDIDATES)
    .map((c) => ({ id: c.id, durationMs: c.durationMs }));
}

async function lyricsFor(track: TrackInfo, song: { id: number; durationMs: number }): Promise<any | null> {
  // The token goes in the URL: Spicetify's proxy drops request headers, so the usual
  // Authorization header would never arrive.
  const res = await postViaCosmos(
    buildUrl(PIPE_URL, { access_token: await getToken() }),
    { query: LYRICS_QUERY, variables: { trackId: String(song.id) } }
  );
  const lyrics = res?.data?.track?.lyrics as
    | { text?: string; synchronizedLines?: { line?: string; milliseconds?: number }[] }
    | null
    | undefined;
  if (!lyrics) return null;

  const durationS = (song.durationMs || track.durationMs) / 1000;
  const synced = (lyrics.synchronizedLines ?? [])
    .filter((l) => typeof l.milliseconds === "number")
    .map((l) => ({ time: (l.milliseconds as number) / 1000, text: (l.line ?? "").trim() }));
  const line = entriesToLine(synced, durationS);
  if (line) return { ...line, source: "deezer" };

  const plain = lyrics.text ? parsePlainToStatic(lyrics.text) : null;
  return plain ? { ...plain, source: "deezer" } : null;
}

export async function fetchFromDeezer(track: TrackInfo): Promise<any | null> {
  for (const song of await findTracks(track)) {
    try {
      const lyrics = await lyricsFor(track, song);
      if (lyrics) return lyrics;
    } catch (error) {
      // An expired token or a hiccup on one track must not hide the next.
      token = null;
      logger.warn("Deezer lyrics lookup failed", error);
    }
  }
  return null;
}
