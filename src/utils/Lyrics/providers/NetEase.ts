import Logger from "../../Logger.ts";
import { buildUrl, getViaCosmos } from "./Http.ts";
import {
  entriesToLine,
  isCreditLine,
  parseLrcToLine,
  parsePlainToStatic,
  stripCreditLines,
} from "./Lrc.ts";
import { rankCandidates } from "./Match.ts";
import type { TrackInfo } from "./types.ts";

const logger = new Logger("NetEase");

// NetEase Cloud Music has no public API. These are the web client's own endpoints;
// they need no login for search and lyrics.
const BASE = "https://music.163.com/api";

type NetEaseSong = {
  id: number;
  name?: string;
  artists?: { name?: string }[];
  duration?: number;
};

type NetEaseLyric = {
  nolyric?: boolean;
  lrc?: { lyric?: string };
  yrc?: { lyric?: string };
};

const MAX_CANDIDATES = 3;

async function findSongs(track: TrackInfo): Promise<{ id: number; durationMs: number }[]> {
  const res = await getViaCosmos(
    buildUrl(`${BASE}/search/get`, {
      s: `${track.name} ${track.artist}`,
      type: 1,
      limit: 10,
      offset: 0,
    })
  );
  const songs = res?.result?.songs as NetEaseSong[] | undefined;
  if (!Array.isArray(songs) || songs.length === 0) return [];

  return rankCandidates(
    track,
    songs.map((s) => ({
      id: s.id,
      title: s.name ?? "",
      artists: (s.artists ?? []).map((a) => a.name ?? ""),
      durationMs: s.duration ?? 0,
    }))
  )
    .slice(0, MAX_CANDIDATES)
    .map((c) => ({ id: c.id, durationMs: c.durationMs }));
}

/**
 * NetEase's word-timed format, one line per lyric line:
 *   [lineStartMs,lineDurMs](wordStartMs,wordDurMs,0)word(wordStartMs,wordDurMs,0)word…
 * Lines starting with "{" are JSON credit entries and are skipped.
 */
function parseYrc(yrc: string): any | null {
  const content: any[] = [];

  for (const raw of yrc.split(/\r?\n/)) {
    const line = raw.trim();
    const head = /^\[(\d+),(\d+)\]/.exec(line);
    if (!head) continue;

    const body = line.slice(head[0].length);
    // Only a (n,n,n) triple is a timing mark, so brackets inside the lyric survive.
    const marks = [...body.matchAll(/\((\d+),(\d+),-?\d+\)/g)];
    const words = marks
      .map((m, i) => {
        const from = (m.index ?? 0) + m[0].length;
        const to = marks[i + 1]?.index ?? body.length;
        return { text: body.slice(from, to), start: Number(m[1]), duration: Number(m[2]) };
      })
      .filter((w) => w.text.trim() !== "");
    if (words.length === 0) continue;

    if (isCreditLine(words.map((w) => w.text).join(""))) continue;

    const syllables = words.map((w, i) => {
      const next = words[i + 1];
      return {
        Text: w.text.trim(),
        IsPartOfWord: next !== undefined && !/\s$/.test(w.text) && !/^\s/.test(next.text),
        StartTime: w.start / 1000,
        EndTime: (w.start + w.duration) / 1000,
      };
    });

    content.push({
      Type: "Vocal",
      OppositeAligned: false,
      Lead: {
        Syllables: syllables,
        StartTime: syllables[0].StartTime,
        EndTime: syllables[syllables.length - 1].EndTime,
      },
    });
  }

  if (content.length === 0) return null;

  return {
    Type: "Syllable",
    StartTime: content[0].Lead.StartTime,
    EndTime: content[content.length - 1].Lead.EndTime,
    Content: content,
  };
}

/**
 * Some songs carry line timing as one JSON object per line instead of LRC:
 *   {"t":1000,"c":[{"tx":"words"},{"tx":"more words"}]}
 * `t` is the line start in milliseconds, `c` the text pieces.
 */
function parseJsonLines(lyric: string, durationSeconds: number): any | null {
  const entries: { time: number; text: string }[] = [];

  for (const raw of lyric.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line) as { t?: number; c?: { tx?: string }[] };
      if (typeof obj.t !== "number" || !Array.isArray(obj.c)) continue;
      const text = obj.c.map((piece) => piece.tx ?? "").join("").trim();
      if (isCreditLine(text)) continue;
      entries.push({ time: obj.t / 1000, text });
    } catch {
      // not a JSON line
    }
  }

  return entriesToLine(entries, durationSeconds);
}

async function lyricsFor(
  track: TrackInfo,
  song: { id: number; durationMs: number }
): Promise<any | null> {
  const lyric = (await getViaCosmos(
    buildUrl(`${BASE}/song/lyric/v1`, { id: song.id, lv: 1, yv: 1 })
  )) as NetEaseLyric | null;
  if (!lyric || lyric.nolyric) return null;

  const durationS = (song.durationMs || track.durationMs) / 1000;

  // Word-timed first, then line-timed, then plain text.
  if (lyric.yrc?.lyric) {
    const parsed = parseYrc(lyric.yrc.lyric);
    if (parsed) return { ...parsed, source: "netease" };
  }

  const lrc = lyric.lrc?.lyric;
  if (lrc) {
    const parsed =
      parseLrcToLine(stripCreditLines(lrc), durationS) ?? parseJsonLines(lrc, durationS);
    if (parsed) return { ...parsed, source: "netease" };

    const plain = parsePlainToStatic(
      stripCreditLines(lrc)
        .split(/\r?\n/)
        .filter((l) => !l.trimStart().startsWith("{"))
        .join("\n")
    );
    if (plain) return { ...plain, source: "netease" };
  }

  logger.debug("NetEase song had no usable lyrics", song.id);
  return null;
}

export async function fetchFromNetEase(track: TrackInfo): Promise<any | null> {
  // The closest match sometimes has no lyrics while another upload of the same
  // song does, so try a few in order.
  for (const song of await findSongs(track)) {
    const lyrics = await lyricsFor(track, song);
    if (lyrics) return lyrics;
  }
  return null;
}
