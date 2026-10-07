import Logger from "../../Logger.ts";
import { HasLyricsText } from "../EmptyLines.ts";
import { isCreditLine, parsePlainToStatic } from "./Lrc.ts";
import type { TrackInfo } from "./types.ts";

const logger = new Logger("LRCMux");

// LRCMux (lrcmux.dev) aggregates lyrics from KuGou, LRCLIB, YouTube Music and Genius
// and answers with the best sync level it found. Public, no key, CORS-enabled.
const BASE = "https://api.lrcmux.dev";
const TIMEOUT_MS = 8000;

// The API names the track from its own catalogue. Timings made for a recording whose
// length differs from the playing one by more than this belong to another edit.
const MAX_DURATION_MISMATCH_S = 8;
// The shortest a word may last on screen; zero-length words flash instead of animating.
const MIN_WORD_S = 0.08;

type MuxWord = { text: string; start: number; end: number };
type MuxLine = { text: string; start?: number; end?: number; words?: MuxWord[] | null };
type MuxResponse = {
  track?: { duration?: number };
  meta?: {
    level?: "word" | "line" | "none";
    instrumental?: boolean;
    source?: { id?: string; name?: string };
  };
  lines?: MuxLine[] | null;
};

const seconds = (ms: number) => ms / 1000;

// A "word" that is only punctuation: it belongs to its neighbour, not on its own.
const OPENING = /^[(\[{“‘¿¡]+$/;
const CLOSING = /^[)\]}”.,!?;:…]+$/;
const STRAIGHT_QUOTE = /^"+$/;

// Providers that censor profanity replace letters with asterisks ("f**k").
const CENSORED = /\p{L}\*+|\*+\p{L}/u;

/**
 * Some providers tokenise lyrics and re-join them with spaces ("up , they like ,
 * " How you do it ? ""). Pull punctuation back against the word it belongs to.
 */
export function tidy(text: string): string {
  let out = text
    .replace(/\s+([,.!?;:)\]}…])/g, "$1")
    .replace(/([(\[{¿¡])\s+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  // Straight quotes only when they pair up; an unmatched one is left alone.
  if ((out.match(/"/g)?.length ?? 0) % 2 === 0) {
    out = out.replace(/"\s*([^"]*?)\s*"/g, '"$1"');
  }
  return out;
}

/**
 * Word timings made safe to animate: in order, no word ends before it starts, none
 * overlaps the next, and none is shorter than a flash. Times in seconds.
 */
export function cleanTimings(words: MuxWord[]): { text: string; start: number; end: number }[] {
  const sorted = words
    .filter((w) => w.text.trim() !== "" && Number.isFinite(w.start) && Number.isFinite(w.end))
    .map((w) => ({ text: w.text, start: Math.max(0, seconds(w.start)), end: seconds(w.end) }))
    .sort((a, b) => a.start - b.start);

  return sorted.map((w, i) => {
    const next = sorted[i + 1];
    let end = Math.max(w.end, w.start);
    if (next && end > next.start) end = next.start; // overlap: the next word takes over
    if (end - w.start < MIN_WORD_S) end = next ? Math.max(end, Math.min(next.start, w.start + MIN_WORD_S)) : w.start + MIN_WORD_S;
    return { ...w, end };
  });
}

type TimedWord = { text: string; start: number; end: number };

/**
 * Brackets, quotes and commas sent as words of their own become part of the word they
 * belong to: closing ones join the word before, opening ones the word after. A token
 * of punctuation is too short to animate and would show as a stray gap.
 */
export function attachPunctuation(words: TimedWord[]): TimedWord[] {
  const out: TimedWord[] = [];
  let opener: { text: string; start: number } | null = null;
  let quotes = 0;

  for (const word of words) {
    const bare = word.text.trim();
    let kind: "open" | "close" | null = null;
    if (OPENING.test(bare)) kind = "open";
    else if (CLOSING.test(bare)) kind = "close";
    else if (STRAIGHT_QUOTE.test(bare)) kind = ++quotes % 2 === 1 ? "open" : "close";

    if (kind === "open") {
      opener = { text: (opener?.text ?? "") + bare, start: Math.min(opener?.start ?? word.start, word.start) };
      continue;
    }

    const previous = out[out.length - 1];
    if (kind === "close" && previous) {
      // Keeps the punctuation's own trailing space, which is what separates the next word.
      previous.text = previous.text.trimEnd() + word.text;
      previous.end = Math.max(previous.end, word.end);
      continue;
    }

    if (opener) {
      out.push({ text: opener.text + word.text.trimStart(), start: Math.min(opener.start, word.start), end: word.end });
      opener = null;
    } else {
      out.push({ ...word });
    }
  }

  // An opener with nothing after it clings to the last word instead.
  if (opener) {
    const last = out[out.length - 1];
    if (last) last.text = last.text.trimEnd() + opener.text;
    else out.push({ text: opener.text, start: opener.start, end: opener.start + MIN_WORD_S });
  }
  return out;
}

/** Per-word timestamps into Spicy Lyrics' "Syllable" shape. */
function toSyllable(lines: MuxLine[]): any | null {
  const content: any[] = [];

  for (const line of lines) {
    if (!HasLyricsText(line.text) || isCreditLine(line.text)) continue;

    const words = attachPunctuation(cleanTimings(line.words ?? []));
    let syllables: any[];

    if (words.length > 0) {
      // Words normally carry their trailing space ("I've "). A provider that sends
      // bare words would otherwise glue the whole line into one word.
      const carriesSpaces = words.some((w) => /\s/.test(w.text));
      const bareWords = !carriesSpaces && /\s/.test(line.text.trim());

      syllables = words
        .map((w, i) => {
          const next = words[i + 1];
          // A word ends where there is a space, or punctuation that closes it.
          const joinsNext =
            next !== undefined &&
            !bareWords &&
            !/\s$/.test(w.text) &&
            !/^\s/.test(next.text) &&
            !/[,.!?;:…)\]}]$/.test(w.text.trim());
          return { Text: tidy(w.text), IsPartOfWord: joinsNext, StartTime: w.start, EndTime: w.end };
        })
        .filter((s) => s.Text !== "");
    } else if (typeof line.start === "number" && typeof line.end === "number" && line.end > line.start) {
      // A line without word data inside a word-synced result: keep it as one chunk.
      syllables = [
        { Text: tidy(line.text), IsPartOfWord: false, StartTime: seconds(line.start), EndTime: seconds(line.end) },
      ];
    } else {
      continue;
    }

    if (syllables.length === 0) continue;
    content.push({
      Type: "Vocal",
      OppositeAligned: false,
      // The line spans its first to last word. Taking the next line's start instead would
      // keep it lit through any instrumental break that follows.
      Lead: {
        Syllables: syllables,
        StartTime: syllables[0].StartTime,
        EndTime: syllables[syllables.length - 1].EndTime,
      },
    });
  }

  if (content.length === 0) return null;
  content.sort((a, b) => a.Lead.StartTime - b.Lead.StartTime);

  return {
    Type: "Syllable",
    StartTime: content[0].Lead.StartTime,
    EndTime: Math.max(...content.map((c) => c.Lead.EndTime)),
    Content: content,
  };
}

/** Per-line timestamps into the "Line" shape. */
function toLine(lines: MuxLine[], durationSeconds: number): any | null {
  const timed = lines
    .filter((l) => HasLyricsText(l.text) && !isCreditLine(l.text) && typeof l.start === "number")
    .sort((a, b) => (a.start as number) - (b.start as number));
  const content: any[] = [];

  timed.forEach((line, i) => {
    const start = seconds(line.start as number);
    const nextStart = typeof timed[i + 1]?.start === "number" ? seconds(timed[i + 1].start as number) : undefined;

    // Use the provider's own end if it is sensible, never past the next line's start;
    // otherwise run to the next line, or for the last line to the end of the song.
    let end = typeof line.end === "number" && line.end > 0 ? seconds(line.end) : Number.NaN;
    if (!(end > start)) end = nextStart ?? Math.max(durationSeconds, start + 3);
    if (nextStart !== undefined && end > nextStart) end = nextStart;

    content.push({
      Type: "Vocal",
      OppositeAligned: false,
      Text: tidy(line.text),
      StartTime: start,
      EndTime: end,
    });
  });

  if (content.length === 0) return null;

  return {
    Type: "Line",
    StartTime: content[0].StartTime,
    EndTime: content[content.length - 1].EndTime,
    Content: content,
  };
}

function parse(body: MuxResponse, durationS: number): any | null {
  const lines = body.lines ?? [];
  if (body.meta?.instrumental || lines.length === 0) return null;

  switch (body.meta?.level) {
    case "word":
      // Falls back to line timing if no line actually carried word data.
      return toSyllable(lines) ?? toLine(lines, durationS);
    case "line":
      return toLine(lines, durationS);
    case "none":
      return parsePlainToStatic(
        lines
          .filter((l) => !isCreditLine(l.text))
          .map((l) => tidy(l.text))
          .join("\n")
      );
    default:
      logger.warn("Unknown LRCMux sync level", body.meta?.level);
      return null;
  }
}

async function request(track: TrackInfo, extra: Record<string, string> = {}): Promise<MuxResponse | null> {
  const params = new URLSearchParams({
    artist: track.artist,
    title: track.name,
    level: "word",
    format: "json",
    ...extra,
  });
  if (track.album) params.set("album", track.album);
  const durationS = Math.round(track.durationMs / 1000);
  if (durationS > 0) params.set("duration", String(durationS));

  // No custom headers: the API sends CORS headers for plain requests, and anything
  // extra would add a preflight round trip.
  const res = await fetch(`${BASE}/get?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (res.status === 429) {
    throw new Error(`LRCMux rate limited, retry after ${res.headers.get("Retry-After") ?? "?"}s`);
  }
  if (!res.ok) throw new Error(`LRCMux responded ${res.status}`);
  return (await res.json()) as MuxResponse;
}

const isCensored = (body: MuxResponse) =>
  (body.lines ?? []).some((l) => CENSORED.test(l.text) || (l.words ?? []).some((w) => CENSORED.test(w.text)));

export async function fetchFromLrcMux(track: TrackInfo): Promise<any | null> {
  const durationS = track.durationMs / 1000;

  let body = await request(track);
  if (!body) return null;

  // KuGou, the usual word-synced source, censors profanity. Another source's uncensored
  // text, even only line-synced, beats asterisks; with none to be had, keep what we have.
  if (body.meta?.source?.id === "kugou" && isCensored(body)) {
    try {
      const uncensored = await request(track, { sources: "!kugou" });
      if (uncensored && !isCensored(uncensored)) body = uncensored;
    } catch (error) {
      logger.warn("LRCMux uncensored lookup failed", error);
    }
  }

  const theirs = body.track?.duration;
  if (theirs && durationS > 0 && Math.abs(theirs - durationS) > MAX_DURATION_MISMATCH_S) {
    logger.debug("LRCMux result is for a different length of recording", theirs, durationS);
    return null;
  }

  const parsed = parse(body, durationS);
  if (!parsed) return null;
  return { ...parsed, source: "lrcmux", sourceDetail: body.meta?.source?.name };
}
