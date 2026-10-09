// The pure part of the line meanings (no player, no network), so it can be tested on its own.

/** Letters and digits only, lower case: lines compare equal across punctuation and spelling of dashes. */
export const flatten = (value: string): string =>
  value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Line meanings: Genius's annotations, put on the lyrics lines they explain. Genius files
 * each annotation under a quoted passage of the lyrics (a "referent") and sorts it as
 * verified (confirmed by the artist), accepted (reviewed and approved by Genius's
 * editors) or unreviewed (a community suggestion nobody has reviewed yet).
 */
export type MeaningLevel = "artist" | "editor" | "community";

/** Whose meanings to show: see `$lineMeaningsFrom`. */
export type MeaningsFrom = "artist" | "editors" | "everyone";

export type Meaning = {
  /** The lyrics the annotation is about. */
  fragment: string;
  text: string;
  level: MeaningLevel;
  votes: number;
  /** Who verified it (artist level) or wrote most of it. */
  author?: string;
  url?: string;
};

export const asMeaningsFrom = (value: string): MeaningsFrom =>
  value === "artist" || value === "everyone" ? value : "editors";

/** The meanings that pass the listener's choice of whose to show. */
export function filterMeanings(meanings: Meaning[], from: MeaningsFrom): Meaning[] {
  switch (from) {
    case "artist":
      return meanings.filter((m) => m.level === "artist");
    case "everyone":
      return meanings;
    default:
      return meanings.filter((m) => m.level !== "community");
  }
}

export type Referent = {
  fragment?: string;
  url?: string;
  classification?: string;
  is_description?: boolean;
  is_image?: boolean;
  annotations?: {
    url?: string;
    verified?: boolean;
    state?: string;
    votes_total?: number;
    body?: { plain?: string };
    verified_by?: { name?: string; login?: string } | null;
    authors?: { user?: { name?: string; login?: string } }[];
  }[];
};

function levelOf(referent: Referent): MeaningLevel {
  const annotation = referent.annotations?.[0];
  if (referent.classification === "verified" || annotation?.verified) return "artist";
  if (referent.classification === "accepted" || annotation?.state === "accepted") return "editor";
  return "community";
}

/** Genius's annotations as meanings: only the ones with text, about a passage of lyrics. */
export function meaningsFromReferents(referents: Referent[]): Meaning[] {
  const out: Meaning[] = [];
  for (const referent of referents) {
    if (referent.is_description || referent.is_image) continue;
    const annotation = referent.annotations?.[0];
    const text = annotation?.body?.plain?.trim();
    const fragment = referent.fragment?.trim();
    if (!text || !fragment) continue;

    const level = levelOf(referent);
    out.push({
      fragment,
      text,
      level,
      votes: annotation?.votes_total ?? 0,
      author:
        level === "artist"
          ? (annotation?.verified_by?.name ?? annotation?.verified_by?.login)
          : (annotation?.authors?.[0]?.user?.name ?? annotation?.authors?.[0]?.user?.login),
      url: annotation?.url ?? referent.url,
    });
  }
  return out;
}

// A passage shorter than this must be a whole line; longer ones may be found inside lines.
const SHORT_FRAGMENT = 8;
// How much of a passage's beginning is compared when it is not found word for word.
const HEAD_LENGTH = 60;
// How close (0 to 1) a window of lyrics must be to a passage's beginning to count as it. Genius
// writes "pretendin'" where the lyrics say "pretending", so close is as good as equal.
const FUZZY_MIN = 0.8;
// A passage's head must be at least this long to be matched loosely.
const FUZZY_MIN_LENGTH = 22;
// How many lyrics lines a passage may run over.
const MAX_SPAN = 6;

/** A line without what is sung behind it, "(Back to let you know)", and without section labels. */
const withoutBackingVocals = (value: string): string => value.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ");

function bigrams(value: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < value.length - 1; i++) {
    const pair = value.slice(i, i + 2);
    out.set(pair, (out.get(pair) ?? 0) + 1);
  }
  return out;
}

/** 0 to 1 closeness of two strings by their pairs of letters. */
function closeness(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const left = bigrams(a);
  let shared = 0;
  for (const [pair, count] of bigrams(b)) shared += Math.min(count, left.get(pair) ?? 0);
  return (2 * shared) / (a.length + b.length - 2);
}

type Window = { text: string; spans: { line: number; from: number; to: number }[] };

/** The lyrics from line `start` on, joined, for as far as `length` letters need (and at most MAX_SPAN lines). */
function windowFrom(keys: string[], start: number, length: number): Window {
  let text = "";
  const spans: Window["spans"] = [];
  for (let end = start; end < keys.length && end < start + MAX_SPAN; end++) {
    if (!keys[end]) continue;
    spans.push({ line: end, from: text.length, to: text.length + keys[end].length });
    text += keys[end];
    if (text.length >= length) break;
  }
  return { text, spans };
}

/** The lines a stretch of the window's text lies on. */
const linesOf = (window: Window, from: number, to: number): number[] =>
  window.spans.filter((span) => span.to > from && span.from < to).map((span) => span.line);

/**
 * Which lyrics lines each meaning is about. Genius quotes a passage that may start or end
 * inside a line, include ad-libs the lyrics leave out, break its lines elsewhere than the
 * lyrics do ("It's me, hi" and "I'm the problem" may be one lyrics line) and spell a word its
 * own way, so the passage is looked for as running text across a few consecutive lines,
 * word for word first and then by how closely its beginning matches. A passage that is only
 * a section label ("[Bridge]") has nothing to place.
 */
export function alignMeanings(meanings: Meaning[], lines: string[]): Map<number, Meaning[]> {
  const keys = lines.map((line) => flatten(withoutBackingVocals(line)));
  const placed = new Map<number, Meaning[]>();

  const place = (meaning: Meaning, covered: number[]) => {
    for (const index of covered) {
      const list = placed.get(index) ?? [];
      if (!list.includes(meaning)) list.push(meaning);
      placed.set(index, list);
    }
  };

  for (const meaning of meanings) {
    const sung = meaning.fragment
      .split(/\n/)
      .filter((part) => !/^\s*\[[^\]]*\]\s*$/.test(part))
      .join(" ");
    const target = flatten(withoutBackingVocals(sung));
    if (!target) continue;

    // Too short to find inside text with any confidence: only a whole line will do.
    if (target.length < SHORT_FRAGMENT) {
      const at = keys.findIndex((key) => key === target);
      if (at !== -1) place(meaning, [at]);
      continue;
    }

    // Word for word: the passage begins inside a line and runs on over the next ones.
    let found: number[] | null = null;
    for (let start = 0; start < keys.length && !found; start++) {
      if (!keys[start]) continue;
      const window = windowFrom(keys, start, target.length + keys[start].length);
      const at = window.text.indexOf(target);
      if (at !== -1 && at < keys[start].length) found = linesOf(window, at, at + target.length);
    }

    // Close enough: compare the beginning of the passage with each stretch of lyrics.
    if (!found && target.length >= FUZZY_MIN_LENGTH) {
      const head = target.slice(0, HEAD_LENGTH);
      let best = { score: 0, covered: [] as number[] };
      for (let start = 0; start < keys.length; start++) {
        if (!keys[start]) continue;
        const window = windowFrom(keys, start, head.length + 4);
        const score = closeness(head, window.text.slice(0, head.length + 4));
        if (score > best.score) {
          best = { score, covered: linesOf(window, 0, Math.min(window.text.length, target.length)) };
        }
      }
      if (best.score >= FUZZY_MIN) found = best.covered;
    }

    if (found) place(meaning, found);
  }
  return placed;
}