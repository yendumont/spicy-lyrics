import Logger from "../../Logger.ts";
import { buildUrl, getViaCosmos } from "./Http.ts";
import { isCreditLine, parseLrcToLine, stripCreditLines } from "./Lrc.ts";
import { cleanTitle, rankCandidates } from "./Match.ts";
import type { TrackInfo } from "./types.ts";

const logger = new Logger("KuGou");

// KuGou's lyric service is the one its desktop player talks to: no login, and a
// song needs no KuGou id, only a keyword and the length.
const BASE = "https://lyrics.kugou.com";

type KugouCandidate = {
  id: string;
  accesskey: string;
  singer?: string;
  song?: string;
  duration?: number;
};

const MAX_CANDIDATES = 3;

async function findLyrics(track: TrackInfo): Promise<{ id: string; accesskey: string; durationMs: number }[]> {
  // The search is picky about case ("Drivers License" finds nothing, "drivers license"
  // finds it), so each form is also tried in lower case.
  const title = cleanTitle(track.name);
  const keywords = [
    ...new Set([
      `${track.artist} - ${title}`,
      `${track.artist} - ${title.toLowerCase()}`,
      title,
      title.toLowerCase(),
    ]),
  ];
  const found = new Map<string, KugouCandidate>();

  for (const keyword of keywords) {
    const res = await getViaCosmos(
      buildUrl(`${BASE}/search`, {
        ver: 1,
        man: "yes",
        client: "pc",
        keyword,
        duration: track.durationMs || 0,
      })
    );
    for (const c of (res?.candidates ?? []) as KugouCandidate[]) {
      if (c?.id && c.accesskey) found.set(c.id, c);
    }
    const ranked = rank(track, [...found.values()]);
    if (ranked.length > 0) return ranked;
  }
  return [];
}

function rank(track: TrackInfo, list: KugouCandidate[]) {
  return rankCandidates(
    track,
    list.map((c) => ({
      id: c.id,
      accesskey: c.accesskey,
      title: c.song ?? "",
      // "A、B" and "A&B" credit several singers in one field.
      artists: (c.singer ?? "").split(/[、,&/]/).map((a) => a.trim()).filter(Boolean),
      durationMs: c.duration ?? 0,
    }))
  )
    .slice(0, MAX_CANDIDATES)
    .map((c) => ({ id: c.id, accesskey: c.accesskey, durationMs: c.durationMs }));
}

async function download(id: string, accesskey: string, fmt: "lrc" | "krc"): Promise<string | null> {
  const res = await getViaCosmos(
    buildUrl(`${BASE}/download`, { ver: 1, client: "pc", id, accesskey, fmt, charset: "utf8" })
  );
  return typeof res?.content === "string" && res.content ? res.content : null;
}

// KRC is "krc1" + zlib data XORed with this key, repeating.
const KRC_KEY = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105];

async function decodeKrc(base64: string): Promise<string | null> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  if (bytes.length <= 4) return null;
  const body = bytes.slice(4).map((b, i) => b ^ KRC_KEY[i % KRC_KEY.length]);

  const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new TextDecoder("utf-8").decode(await new Response(stream).arrayBuffer());
}

/**
 * KRC, one line per lyric line, word times relative to the line:
 *   [lineStartMs,lineDurMs]<wordOffsetMs,wordDurMs,0>word<…>word
 */
function parseKrc(krc: string): any | null {
  const content: any[] = [];

  for (const raw of krc.split(/\r?\n/)) {
    const line = raw.trim();
    const head = /^\[(\d+),(\d+)\]/.exec(line);
    if (!head) continue;
    const lineStart = Number(head[1]);

    const body = line.slice(head[0].length);
    const marks = [...body.matchAll(/<(\d+),(\d+),-?\d+>/g)];
    const words = marks
      .map((m, i) => {
        const from = (m.index ?? 0) + m[0].length;
        const to = marks[i + 1]?.index ?? body.length;
        return { text: body.slice(from, to), start: lineStart + Number(m[1]), duration: Number(m[2]) };
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

  return content.length === 0
    ? null
    : {
        Type: "Syllable",
        StartTime: content[0].Lead.StartTime,
        EndTime: content[content.length - 1].Lead.EndTime,
        Content: content,
      };
}

/** KuGou starts most lyrics with a "Title - Artist" line at 0:00; it is not a lyric. */
function isHeaderLine(text: string, track: TrackInfo): boolean {
  // Unlike normalizeName, keeps what follows a " - ": that is where the artist is.
  const flatten = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const flat = flatten(text);
  return flat !== "" && flat.includes(flatten(cleanTitle(track.name))) && flat.includes(flatten(track.artist));
}

function dropHeaderLine<T>(items: T[], textOf: (item: T) => string, startOf: (item: T) => number, track: TrackInfo): T[] {
  const first = items[0];
  return first && startOf(first) < 1 && isHeaderLine(textOf(first), track) ? items.slice(1) : items;
}

async function lyricsFor(
  track: TrackInfo,
  song: { id: string; accesskey: string; durationMs: number }
): Promise<any | null> {
  const durationS = (song.durationMs || track.durationMs) / 1000;

  // Word-timed first, then line-timed.
  try {
    const krc = await download(song.id, song.accesskey, "krc");
    const text = krc ? await decodeKrc(krc) : null;
    const parsed = text ? parseKrc(text) : null;
    if (parsed) {
      parsed.Content = dropHeaderLine(
        parsed.Content,
        (v: any) => v.Lead.Syllables.map((s: any) => s.Text).join(" "),
        (v: any) => v.Lead.StartTime,
        track
      );
      if (parsed.Content.length > 0) {
        parsed.StartTime = parsed.Content[0].Lead.StartTime;
        return { ...parsed, source: "kugou" };
      }
    }
  } catch (error) {
    logger.debug("KuGou word-timed lyrics unavailable", error);
  }

  const lrcBase64 = await download(song.id, song.accesskey, "lrc");
  if (!lrcBase64) return null;
  const lrc = new TextDecoder("utf-8").decode(Uint8Array.from(atob(lrcBase64), (c) => c.charCodeAt(0)));
  const parsed = parseLrcToLine(stripCreditLines(lrc), durationS);
  if (!parsed) return null;

  parsed.Content = dropHeaderLine(parsed.Content, (l: any) => l.Text, (l: any) => l.StartTime, track);
  if (parsed.Content.length === 0) return null;
  parsed.StartTime = parsed.Content[0].StartTime;
  return { ...parsed, source: "kugou" };
}

export async function fetchFromKugou(track: TrackInfo): Promise<any | null> {
  for (const song of await findLyrics(track)) {
    const lyrics = await lyricsFor(track, song);
    if (lyrics) return lyrics;
  }
  return null;
}
