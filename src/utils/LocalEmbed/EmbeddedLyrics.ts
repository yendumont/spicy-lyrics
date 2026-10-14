import { HasLyricsText } from "../Lyrics/EmptyLines.ts";
import { parseTTML } from "../Lyrics/ttml/parser.ts";
import { entriesToLine, parseLrcToLine, parsePlainToStatic } from "../Lyrics/providers/Lrc.ts";
import type { FileTags, SyncedEntry } from "./Tags.ts";

/**
 * Lyrics found in a file's tags, turned into the shape the lyrics page shows. What the text
 * is decides how it is shown:
 *
 *   enhanced LRC  ([00:12.00]<00:12.00>Hel<00:12.40>lo <00:12.90>)   word by word ("Syllable")
 *   LRC           ([00:12.00]Hello)                                  line by line ("Line")
 *   anything else                                                    unsynced ("Static")
 */

const LINE_TIME = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const WORD_TIME = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
const HAS_WORD_TIME = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/;
const HAS_LINE_TIME = /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/;

const seconds = (min: string, sec: string, frac?: string) =>
  Number(min) * 60 + Number(sec) + (frac ? Number(`0.${frac}`) : 0);

/** A whole TTML document stored as the lyrics text (what some tools write into a file). */
const looksLikeTtml = (text: string): boolean => /^\s*(?:<\?xml[^>]*>\s*)?<(?:\w+:)?tt[\s>]/i.test(text);

/** How synced a lyrics text is, for choosing between several in one file: 3 word, 2 line, 1 plain. */
export function syncRankOfText(text: string): number {
  if (HAS_WORD_TIME.test(text) && HAS_LINE_TIME.test(text)) return 3;
  if (HAS_LINE_TIME.test(text)) return 2;
  return 1;
}

type Syllable = { Text: string; IsPartOfWord: boolean; StartTime: number; EndTime: number };

/** One line's words, from `<time>text` segments. `lineEnd` is where the line stops if it has no closing tag. */
function syllablesFor(body: string, lineStart: number, lineEnd: number): Syllable[] {
  const pieces = body.split(WORD_TIME);
  // pieces: [text before the first tag, min, sec, frac, text, min, sec, frac, text, …]
  const segments: { time: number; text: string }[] = [];
  const lead = pieces[0];
  if (lead && lead.trim()) segments.push({ time: lineStart, text: lead });
  for (let i = 1; i + 3 < pieces.length + 1; i += 4) {
    segments.push({ time: seconds(pieces[i], pieces[i + 1], pieces[i + 2]), text: pieces[i + 3] ?? "" });
  }

  const out: Syllable[] = [];
  for (let i = 0; i < segments.length; i++) {
    const { time, text } = segments[i];
    if (!text.trim()) continue;

    const next = segments[i + 1];
    const end = next ? Math.max(next.time, time) : Math.max(lineEnd, time);
    const words = text.trim().split(/\s+/);

    // Whether a space (or the end of the line) comes before the next word: text that ends in a
    // space, or an empty or all-space tag in between, or a next word that starts with one.
    let gap = "";
    let followedByWord = false;
    for (let j = i + 1; j < segments.length; j++) {
      const piece = segments[j].text;
      if (piece.trim()) {
        gap += piece.match(/^\s*/)?.[0] ?? "";
        followedByWord = true;
        break;
      }
      gap += piece;
    }
    const continues = followedByWord && !/\s$/.test(text) && !/\s/.test(gap);

    // A segment holding several words shares its time between them, by length.
    const letters = words.reduce((n, w) => n + w.length, 0) || 1;
    let at = time;
    words.forEach((word, w) => {
      const share = ((end - time) * word.length) / letters;
      const last = w === words.length - 1;
      out.push({
        Text: word,
        // Only the last piece of a segment can run on into the next word.
        IsPartOfWord: last ? continues : false,
        StartTime: at,
        EndTime: last ? end : at + share,
      });
      at += share;
    });
  }
  return out;
}

const isBacking = (vocal: any): boolean => {
  const syllables = vocal.Lead.Syllables;
  return syllables.length > 0 && syllables[0].Text.startsWith("(") && syllables[syllables.length - 1].Text.endsWith(")");
};

/** The syllables of a bracketed line without its brackets. */
function unbracket(syllables: Syllable[]): Syllable[] {
  const copy = syllables.map((s) => ({ ...s }));
  copy[0].Text = copy[0].Text.replace(/^\(\s*/, "");
  copy[copy.length - 1].Text = copy[copy.length - 1].Text.replace(/\s*\)$/, "");
  return copy.filter((s) => s.Text.trim() !== "");
}

/**
 * A line wholly in brackets that is sung over (or right beside) another line is that line's backing
 * vocal, so it goes under it, smaller, as in Spicy Lyrics' own lyrics, instead of being a line of
 * its own. One on its own, with no line near it, stays a line.
 */
function attachBackingVocals(content: any[]): any[] {
  const hosts = content.filter((vocal) => !isBacking(vocal));
  const kept: any[] = [];

  for (const vocal of content) {
    if (!isBacking(vocal)) {
      kept.push(vocal);
      continue;
    }

    const { StartTime: start, EndTime: end } = vocal.Lead;
    let host: any | undefined;
    let best = Infinity;
    for (const candidate of hosts) {
      const overlap = Math.min(candidate.Lead.EndTime, end) - Math.max(candidate.Lead.StartTime, start);
      // Time between the two when they do not overlap; 0 or less when they do.
      const gap = overlap > 0 ? -overlap : Math.max(candidate.Lead.StartTime - end, start - candidate.Lead.EndTime);
      if (gap <= 0.75 && gap < best) {
        best = gap;
        host = candidate;
      }
    }

    const syllables = unbracket(vocal.Lead.Syllables);
    if (!host || syllables.length === 0) {
      kept.push(vocal);
      continue;
    }
    (host.Background ??= []).push({ Syllables: syllables, StartTime: start, EndTime: end });
  }
  return kept;
}
function buildSyllableLyrics(text: string, durationSeconds: number): any | null {
  type RawLine = { start: number; body: string };
  const lines: RawLine[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(LINE_TIME)];
    const body = raw.replace(LINE_TIME, "");
    if (!body.trim()) continue;

    let start: number | undefined = stamps[0] ? seconds(stamps[0][1], stamps[0][2], stamps[0][3]) : undefined;
    if (start === undefined) {
      const firstWord = [...body.matchAll(WORD_TIME)][0];
      if (firstWord) start = seconds(firstWord[1], firstWord[2], firstWord[3]);
    }
    if (start === undefined) continue;
    lines.push({ start, body });
  }

  lines.sort((a, b) => a.start - b.start);

  const content: any[] = [];
  lines.forEach((line, i) => {
    const nextStart = lines[i + 1]?.start;
    const hasWordTimes = HAS_WORD_TIME.test(line.body);
    const end = nextStart ?? Math.max(durationSeconds, line.start + 3);

    let syllables: Syllable[];
    if (hasWordTimes) {
      syllables = syllablesFor(line.body, line.start, end);
    } else {
      // A line with no word timing, in a file that has some: its words are spread over the line.
      const plain = line.body.trim();
      if (!HasLyricsText(plain)) return;
      const words = plain.split(/\s+/);
      const letters = words.reduce((n, w) => n + w.length, 0) || 1;
      let at = line.start;
      syllables = words.map((word) => {
        const share = ((end - line.start) * word.length) / letters;
        const syllable = { Text: word, IsPartOfWord: false, StartTime: at, EndTime: at + share };
        at += share;
        return syllable;
      });
    }

    syllables = syllables.filter((s) => HasLyricsText(s.Text));
    if (syllables.length === 0) return;
    const first = syllables[0].StartTime;
    const last = syllables[syllables.length - 1].EndTime;
    content.push({
      Type: "Vocal",
      OppositeAligned: false,
      Lead: { Syllables: syllables, StartTime: first, EndTime: last },
    });
  });

  if (content.length === 0) return null;
  const shown = attachBackingVocals(content);
  return {
    Type: "Syllable",
    StartTime: shown[0].Lead.StartTime,
    EndTime: shown[shown.length - 1].Lead.EndTime,
    Content: shown,
  };
}

/** The lyrics for one lyrics text, shown as synced as the text allows; null if there is nothing to show. */
export function parseEmbeddedText(text: string, durationSeconds: number): any | null {
  if (!text.trim()) return null;
  if (looksLikeTtml(text)) {
    try {
      const parsed = parseTTML(text);
      if (parsed && parsed.Type !== undefined && (parsed as any).Content?.length !== 0) return parsed;
    } catch {
      // Not readable as TTML: fall through and show the text as it is.
    }
  }
  if (syncRankOfText(text) === 3) return buildSyllableLyrics(text, durationSeconds) ?? parseLrcToLine(text, durationSeconds);
  if (syncRankOfText(text) === 2) return parseLrcToLine(text, durationSeconds);
  return parsePlainToStatic(text);
}

/** Synced lines from an ID3 SYLT frame. */
function parseSynced(entries: SyncedEntry[], durationSeconds: number): any | null {
  return entriesToLine(entries, durationSeconds);
}

/**
 * The best lyrics a file's tags hold, ready to show, tagged with where they came from. Prefers the
 * most synced one; a SYLT frame counts as line-synced.
 */
export function embeddedLyricsOf(tags: Pick<FileTags, "lyrics" | "synced">, durationSeconds: number): any | null {
  const candidates: { rank: number; lyrics: any }[] = [];

  for (const text of tags.lyrics) {
    const lyrics = parseEmbeddedText(text, durationSeconds);
    if (lyrics) candidates.push({ rank: lyrics.Type === "Syllable" ? 3 : lyrics.Type === "Line" ? 2 : 1, lyrics });
  }
  if (tags.synced?.length) {
    const lyrics = parseSynced(tags.synced, durationSeconds);
    if (lyrics) candidates.push({ rank: 2, lyrics });
  }

  candidates.sort((a, b) => b.rank - a.rank);
  const best = candidates[0]?.lyrics;
  return best ? { ...best, source: "embedded" } : null;
}
