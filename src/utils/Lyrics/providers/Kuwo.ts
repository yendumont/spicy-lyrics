import Logger from "../../Logger.ts";
import { buildUrl, getViaCosmos } from "./Http.ts";
import { entriesToLine, isCreditLine } from "./Lrc.ts";
import { cleanTitle, rankCandidates } from "./Match.ts";
import type { TrackInfo } from "./types.ts";

const logger = new Logger("Kuwo");

// Kuwo is a Chinese music service like NetEase and KuGou. These are the endpoints of its
// website's open API; they send no CORS headers, so they go through Spicetify's proxy,
// which drops request headers, so only the ones that need none are used. Kuwo's
// word-timed lyrics come as an encrypted binary the proxy cannot carry, so this gives
// line sync only.
const BASE = "https://www.kuwo.cn/openapi/v1/www";
const MAX_CANDIDATES = 3;

type KuwoSong = { musicrid?: string; name?: string; artist?: string; duration?: number };

async function findSongs(track: TrackInfo): Promise<{ id: string; durationMs: number }[]> {
  const title = cleanTitle(track.name) || track.name;
  const res = await getViaCosmos(
    buildUrl(`${BASE}/search/searchMusicBykeyWord`, { key: `${title} ${track.artist}`, pn: 1, rn: 20 })
  );
  const list = res?.data?.list as KuwoSong[] | undefined;
  if (!Array.isArray(list) || list.length === 0) return [];

  return rankCandidates(
    track,
    list
      .filter((s) => s.musicrid)
      .map((s) => ({
        id: String(s.musicrid).replace(/^MUSIC_/, ""),
        title: s.name ?? "",
        // Several artists are joined with "&".
        artists: (s.artist ?? "").split("&").map((a) => a.trim()).filter(Boolean),
        durationMs: (s.duration ?? 0) * 1000,
      }))
  )
    .slice(0, MAX_CANDIDATES)
    .map((c) => ({ id: c.id, durationMs: c.durationMs }));
}

// Notices Kuwo puts among the lines: a translation licence, for one.
const NOTICE = /TME享有|版权所有|著作权/;
const SPEAKER_TAG = /^[^:：]{1,40}[:：]$/;

async function lyricsFor(track: TrackInfo, song: { id: string; durationMs: number }): Promise<any | null> {
  const res = await getViaCosmos(buildUrl(`${BASE}/lyric/getlyric`, { musicId: song.id }));
  const lines = res?.data?.lrclist as { lineLyric?: string; time?: string }[] | undefined;
  if (!Array.isArray(lines) || lines.length === 0) return null;

  const seen = new Set<number>();
  const entries = lines
    .map((l) => ({ time: Number(l.time), text: (l.lineLyric ?? "").trim() }))
    .filter(
      (e) =>
        Number.isFinite(e.time) &&
        e.text !== "" &&
        !isCreditLine(e.text) &&
        !NOTICE.test(e.text) &&
        // A bare "DaBaby：" naming who sings the next lines is not a lyric.
        !SPEAKER_TAG.test(e.text)
    )
    // Where a line and its translation share a time, the first is the original.
    .filter((e) => (seen.has(e.time) ? false : (seen.add(e.time), true)));

  // The first line, at 0:00, is "Title - Artist".
  const flatten = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  if (
    entries[0] &&
    entries[0].time < 1 &&
    flatten(entries[0].text).includes(flatten(cleanTitle(track.name))) &&
    flatten(entries[0].text).includes(flatten(track.artist))
  ) {
    entries.shift();
  }

  const parsed = entriesToLine(entries, (song.durationMs || track.durationMs) / 1000);
  return parsed ? { ...parsed, source: "kuwo" } : null;
}

export async function fetchFromKuwo(track: TrackInfo): Promise<any | null> {
  for (const song of await findSongs(track)) {
    try {
      const lyrics = await lyricsFor(track, song);
      if (lyrics) return lyrics;
    } catch (error) {
      logger.warn("Kuwo lyrics lookup failed", error);
    }
  }
  return null;
}
