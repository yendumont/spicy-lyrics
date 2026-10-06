import Logger from "../../Logger.ts";
import { buildUrl, getViaCosmos } from "./Http.ts";
import { parseLrcToLine, parsePlainToStatic, stripCreditLines } from "./Lrc.ts";
import { rankCandidates } from "./Match.ts";
import type { TrackInfo } from "./types.ts";

const logger = new Logger("QQ Music");

// QQ Music has no public API. These are the web player's own endpoints. Lyrics come
// from the musicu gateway: the older lyric endpoint rejects requests without a
// y.qq.com Referer, which a page cannot send.
// Search goes through the same gateway: the older c.y.qq.com search fails when it is
// reached through Spicetify's proxy.
const GATEWAY_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg";

type QQSong = {
  mid?: string;
  title?: string;
  name?: string;
  singer?: { name?: string }[];
  interval?: number;
};

const ENTITIES: Record<string, string> = {
  "&apos;": "'",
  "&#39;": "'",
  "&quot;": '"',
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
};

function decodeLyric(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8")
    .decode(bytes)
    .replace(/&(?:apos|quot|amp|lt|gt|#39);/g, (m) => ENTITIES[m] ?? m);
}

const MAX_CANDIDATES = 3;

async function findSongs(track: TrackInfo): Promise<{ mid: string; durationMs: number }[]> {
  const request = {
    comm: { ct: 19, cv: 1859, uin: 0 },
    req: {
      module: "music.search.SearchCgiService",
      method: "DoSearchForQQMusicDesktop",
      param: { query: `${track.name} ${track.artist}`, num_per_page: 10, page_num: 1, search_type: 0 },
    },
  };
  const res = await getViaCosmos(
    buildUrl(GATEWAY_URL, { format: "json", data: JSON.stringify(request) })
  );
  const list = res?.req?.data?.body?.song?.list as QQSong[] | undefined;
  if (!Array.isArray(list) || list.length === 0) return [];

  return rankCandidates(
    track,
    list
      .filter((s) => s.mid)
      .map((s) => ({
        mid: s.mid as string,
        title: s.title ?? s.name ?? "",
        artists: (s.singer ?? []).map((a) => a.name ?? ""),
        durationMs: (s.interval ?? 0) * 1000,
      }))
  )
    .slice(0, MAX_CANDIDATES)
    .map((c) => ({ mid: c.mid, durationMs: c.durationMs }));
}

async function getLyric(mid: string): Promise<string | null> {
  const request = {
    comm: { ct: 24, cv: 0 },
    req: {
      module: "music.musichallSong.PlayLyricInfo",
      method: "GetPlayLyricInfo",
      param: { songMID: mid, trans: 0, roma: 0 },
    },
  };
  const res = await getViaCosmos(
    buildUrl(GATEWAY_URL, { format: "json", data: JSON.stringify(request) })
  );
  const encoded = res?.req?.data?.lyric;
  return typeof encoded === "string" && encoded !== "" ? decodeLyric(encoded) : null;
}

async function lyricsFor(
  track: TrackInfo,
  song: { mid: string; durationMs: number }
): Promise<any | null> {
  const raw = await getLyric(song.mid);
  if (!raw) return null;

  const lrc = stripCreditLines(raw)
    .split(/\r?\n/)
    // First timed line is usually "Title - Artist"; it is a heading, not a lyric.
    .filter((line, i, all) => {
      const first = all.findIndex((l) => /^\[\d/.test(l));
      return !(i === first && /^\[0?0:0\d[^\]]*\].+ - .+/.test(line));
    })
    .join("\n");

  const durationS = (song.durationMs || track.durationMs) / 1000;

  const parsed = parseLrcToLine(lrc, durationS);
  if (parsed) return { ...parsed, source: "qqmusic" };

  // Untimed text: drop the [ti:]/[ar:] header tags first.
  const plain = parsePlainToStatic(
    lrc
      .split(/\r?\n/)
      .filter((l) => !/^\[[a-z]+:[^\]]*\]\s*$/i.test(l))
      .join("\n")
  );
  if (plain) return { ...plain, source: "qqmusic" };

  logger.debug("QQ Music song had no usable lyrics", song.mid);
  return null;
}

export async function fetchFromQQMusic(track: TrackInfo): Promise<any | null> {
  // The closest match sometimes has no lyrics while another upload of the same
  // song does, so try a few in order.
  for (const song of await findSongs(track)) {
    const lyrics = await lyricsFor(track, song);
    if (lyrics) return lyrics;
  }
  return null;
}
