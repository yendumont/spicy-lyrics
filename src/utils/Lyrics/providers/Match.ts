import type { TrackInfo } from "./types.ts";

// Search-based providers return several versions of a song (live, remix, a
// different edit). Lyrics timed for another edit are worse than none, so a result
// has to agree on title, artist or duration, and on length within a few seconds.
const MAX_DURATION_DIFF_MS = 4000;
const CLOSE_DURATION_DIFF_MS = 1500;

export type Candidate = {
  title: string;
  artists: string[];
  durationMs: number;
};

/** Comparable form of a title or name: no brackets, no " - Remastered" tail, no punctuation. */
export function normalizeName(value: string): string {
  return (
    value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[(\[（【][^)\]）】]*[)\]）】]/g, " ")
      .split(/\s[-–—]\s/)[0]
      .replace(/[^\p{L}\p{N}]+/gu, "")
  );
}

function namesMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return (a.length >= 3 && b.includes(a)) || (b.length >= 3 && a.includes(b));
}

// Brackets are stripped when comparing titles, which would make "Song (Remix)" equal
// "Song". These words in a candidate's title mark a different recording unless the
// playing track says so too. Whole words only: "Deliver" is not "live".
const VERSION_TAG =
  /\b(?:remix(?:ed|es)?|live|instrumental|karaoke|acoustic|cover|demo)\b|\boff vocal\b|伴奏|纯音乐|现场/gi;

// Versions whose lyrics are the same words. Fine for unsynced text, where timing
// does not matter; a synced provider must not use them.
const SAME_LYRICS_TAG = new Set(["remix", "remixed", "remixes", "live", "acoustic", "demo"]);

export type MatchOptions = {
  /** Accept remix, live, acoustic and demo versions: for providers whose lyrics carry no timing. */
  relaxedVersions?: boolean;
  /** Other names the playing track's artist is known to appear under (see GeniusAliases). */
  artistAliases?: string[];
};

function versionTags(title: string): string[] {
  return (title.match(VERSION_TAG) ?? []).map((t) => t.toLowerCase());
}

/** True when the candidate is a different recording than the one playing. */
function wrongVersion(candidateTitle: string, wanted: string[], options: MatchOptions): boolean {
  return versionTags(candidateTitle).some(
    (tag) => !wanted.includes(tag) && !(options.relaxedVersions && SAME_LYRICS_TAG.has(tag))
  );
}

/**
 * Decoration uploaders add to titles: "＊full song＊", "#greed", "prod. someone" and
 * "feat. someone" tails. NFKC has already turned full-width characters into plain ones.
 */
function stripDecoration(value: string): string {
  const stripped = value
    .replace(/([*＊]).*?\1/g, " ")
    .replace(/#\S+/g, " ")
    .replace(/\s+(?:prod\.?|produced by|prod by)\s.*$/i, "")
    .replace(/\s+(?:feat|ft|featuring)\.?\s.*$/i, "");
  // A title that is nothing but decoration ("#WifeBeaterFreestyle") is the title.
  return stripped.trim() ? stripped : value.replace(/[#*＊]/g, "");
}

/** Title without bracketed parts, a " - Remastered" tail, or decoration such as "feat. …" and hashtags. */
export function cleanTitle(value: string): string {
  return stripDecoration(
    value
      .normalize("NFKC")
      .replace(/[(\[（【][^)\]）】]*[)\]）】]/g, " ")
      .split(/\s[-–—]\s/)[0]
  )
    .replace(/\s+/g, " ")
    .trim();
}

// Zero-width and direction marks that Genius titles sometimes start with.
const INVISIBLE = /[​-‏‪-‮⁠﻿]/g;

/**
 * Whether two titles are written exactly alike: same case, same punctuation. A song
 * uploaded as "scars" and a page called "scars" belong together more surely than
 * "Scars", and leaked songs are very often styled in lower case.
 */
export function writtenAlike(a: string, b: string): boolean {
  const tidy = (s: string) => s.normalize("NFKC").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  const left = tidy(a);
  return left !== "" && left === tidy(b);
}

/**
 * Every name a title can be compared as. Uploaders pad titles: "Song - Leak CDQ"
 * is "Song", but "Artist - Song" is "Song" too, so each part of a dash-separated
 * title counts, brackets and "feat." tails aside.
 */
export function titleForms(raw: string): string[] {
  const unbracketed = raw.normalize("NFKC").replace(/[(\[（【][^)\]）】]*[)\]）】]/g, " ");
  const forms = new Set<string>();
  for (const part of unbracketed.split(/\s[-–—]\s/)) {
    const form = normalizeName(cleanTitle(part));
    if (form) forms.add(form);
  }
  return [...forms];
}

// A dash-separated tail that only describes the version, not a second title.
const VERSION_SUFFIX = /remaster|version|edit|mix|live|demo|acoustic|radio|single|album|explicit|mono|stereo|deluxe|bonus|\d{4}/i;

/**
 * The cleaned parts of the PLAYING track's title that can stand for it: "Jaydes - idiot"
 * is "Jaydes" or "idiot", since Spotify uploads are often named "Artist - Song", but
 * "Song - Remastered 2011" is only "Song".
 */
export function searchTitles(raw: string): string[] {
  const unbracketed = raw.normalize("NFKC").replace(/[(\[（【][^)\]）】]*[)\]）】]/g, " ");
  const [first, ...rest] = unbracketed.split(/\s[-–—]\s/).map((part) => cleanTitle(part));
  const parts = [first, ...rest.filter((part) => !VERSION_SUFFIX.test(part))];
  const unique = parts.filter((part, i) => part && parts.indexOf(part) === i);
  return unique.length > 0 ? unique : [raw.trim()];
}

/** The playing track's title in comparable form: one entry per title it could be known by. */
function ownForms(track: TrackInfo): string[] {
  const forms = searchTitles(track.name).map(normalizeName).filter(Boolean);
  return forms.length > 0 ? [...new Set(forms)] : [normalizeName(track.name)];
}

function bigrams(value: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < value.length - 1; i++) {
    const pair = value.slice(i, i + 2);
    out.set(pair, (out.get(pair) ?? 0) + 1);
  }
  return out;
}

/** 0 to 1 closeness of two normalised names: bigram overlap, with containment counting as close. */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const containment = short.length >= 3 && long.includes(short) ? 0.85 : 0;

  return Math.max(containment, dice(a, b));
}

/** Bigram overlap alone: 1 for identical, near 0 for unrelated, and no credit for one name containing the other. */
function dice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return 0;
  const left = bigrams(a);
  const right = bigrams(b);
  let shared = 0;
  for (const [pair, count] of left) shared += Math.min(count, right.get(pair) ?? 0);
  return (2 * shared) / (a.length - 1 + (b.length - 1));
}

/**
 * Title closeness that does not let a longer title stand in for a shorter one:
 * "On Me" is not "Easy On Me", and "Bourbon" is not "Bourbon Street Parade". The one
 * exception is extra text that is only the result's own artist ("yuke ☆☆☆ title").
 */
function titleSimilarity(ours: string, theirs: string, theirArtists: string[]): number {
  if (!ours || !theirs) return 0;
  if (ours === theirs) return 1;
  if (theirs.includes(ours)) {
    const rest = theirs.replace(ours, "");
    if (rest.length >= 3 && theirArtists.some((a) => a.length >= 3 && a.includes(rest))) return 0.95;
    // Genius pages are often named with the whole first lyric line. A title long enough
    // to be distinctive, which that line starts with, is the same song.
    if (ours.length >= PREFIX_MIN_LENGTH && theirs.startsWith(ours)) return PREFIX_SIMILARITY;
  }
  return dice(ours, theirs);
}

const PREFIX_MIN_LENGTH = 8;
const PREFIX_SIMILARITY = 0.9;

/** The closest pairing of any of our title forms with any of the candidate's, and which of ours it was. */
function bestTitleMatch(
  ours: string[],
  theirs: string[],
  theirArtists: string[]
): { score: number; form: string } {
  let best = { score: 0, form: ours[0] ?? "" };
  for (const ourForm of ours) {
    for (const theirForm of theirs) {
      const score = titleSimilarity(ourForm, theirForm, theirArtists);
      if (score > best.score) best = { score, form: ourForm };
    }
  }
  return best;
}

/** True when one of the candidate's artists is a name already learned for the playing track's artist. */
function matchesAlias(candidateArtists: string[], aliases: string[] | undefined): boolean {
  if (!aliases?.length) return false;
  const known = aliases.map(normalizeName).filter(Boolean);
  return candidateArtists.some((artist) => {
    const name = normalizeName(artist);
    return known.some((alias) => namesMatch(alias, name));
  });
}

/** How alike the candidate's artists are to the track's: 1 for a learned alias, else the closest pair. */
function artistSimilarity(track: TrackInfo, candidateArtists: string[], options: MatchOptions): number {
  const ours = (track.artists?.length ? track.artists : [track.artist]).map(normalizeName).filter(Boolean);
  let score = matchesAlias(candidateArtists, options.artistAliases) ? 1 : 0;
  for (const theirs of candidateArtists.map(normalizeName)) {
    for (const mine of ours) score = Math.max(score, similarity(mine, theirs));
  }
  return score;
}

export type LooseCandidate = Candidate & {
  /** How widely known the result is (page views, plays); a tie-breaker only. */
  popularity?: number;
};

// Loose matching thresholds. The title must be close, and the artist must resemble
// ours (or a learned alias of it) unless the title is long and unusual enough to
// stand on its own.
const LOOSE_MIN_TITLE = 0.85;
const LOOSE_MIN_ARTIST = 0.4;
const LOOSE_MIN_SCORE = 0.7;

/** A title long enough that sharing it with another song is unlikely (fewer characters count for CJK). */
function isDistinctive(normalizedTitle: string): boolean {
  const cjk = /[぀-ヿ㐀-鿿가-힯]/.test(normalizedTitle);
  return [...normalizedTitle].length >= (cjk ? 5 : 12);
}

/**
 * Every candidate whose title is close to the playing track's, whatever its artist,
 * closest first. For callers that can tell them apart some other way (cover art).
 */
export function titleCandidates<T extends Candidate>(
  track: TrackInfo,
  candidates: T[],
  options: MatchOptions = {},
  minScore = LOOSE_MIN_TITLE
): T[] {
  const wanted = versionTags(track.name);
  const ours = ownForms(track);

  return candidates
    .filter((c) => !wrongVersion(c.title, wanted, options))
    .map((candidate) => ({
      candidate,
      score: bestTitleMatch(ours, titleForms(candidate.title), candidate.artists.map(normalizeName)).score,
    }))
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.candidate);
}

/** Titles that are the playing track's title once decoration is ignored. */
export const EXACT_TITLE = 0.95;
/** Close enough when the artist is one the listener has named or confirmed: also takes a title that begins a longer one. */
export const TRUSTED_ARTIST_TITLE = 0.9;

/**
 * Best guesses for the playing track when the strict match found nothing, best
 * first. Scores title closeness, closeness to any credited artist, and how
 * popular the result is. A result whose artist resembles none of ours needs a long
 * distinctive title, and is used only if it is the sole one of its kind.
 */
export function rankLoose<T extends LooseCandidate>(
  track: TrackInfo,
  candidates: T[],
  options: MatchOptions = {}
): T[] {
  const wanted = versionTags(track.name);
  const ours = ownForms(track);

  const scored: { candidate: T; score: number }[] = [];
  // Results whose artist shows no resemblance at all. One of them with a distinctive
  // title is a reasonable guess; several means different songs sharing a title.
  const unrelatedArtist: { candidate: T; score: number }[] = [];

  for (const c of candidates) {
    if (wrongVersion(c.title, wanted, options)) continue;

    const match = bestTitleMatch(ours, titleForms(c.title), c.artists.map(normalizeName));
    if (match.score < LOOSE_MIN_TITLE) continue;

    const artistScore = artistSimilarity(track, c.artists, options);
    // Popularity only orders candidates that already qualify.
    const fame = Math.min(1, Math.log10(1 + Math.max(0, c.popularity ?? 0)) / 6);

    const artistOk = artistScore >= LOOSE_MIN_ARTIST;
    // A long, unusual title that the result matches whole is hardly a coincidence.
    if (!artistOk && !isDistinctive(match.form)) continue;

    const score = 0.7 * match.score + 0.3 * artistScore + 0.05 * fame;
    if (artistOk) {
      if (score >= LOOSE_MIN_SCORE) scored.push({ candidate: c, score });
    } else {
      unrelatedArtist.push({ candidate: c, score });
    }
  }

  if (unrelatedArtist.length === 1) scored.push(unrelatedArtist[0]);

  return scored.sort((a, b) => b.score - a.score).map((s) => s.candidate);
}

export type EagerCandidate = LooseCandidate & {
  /** Cover-art difference (0 identical, about 32 unrelated) once measured, or null if it could not be. */
  coverDistance?: number | null;
};

// Eager matching: the last resort when nothing was proven. A title only a little off
// is allowed, a famous song of the same name is not.
const EAGER_MIN_TITLE = 0.78;
const EAGER_MIN_SCORE = 0.5;
const EAGER_MAX_VIEWS = 1_000_000;
const COVER_UNRELATED_DISTANCE = 32;

/**
 * The best-looking candidates when no evidence settled it, best first: a close title
 * written the same way, with a similar artist or a cover somewhat like ours, and an
 * obscure rather than famous page (the real song of an obscure upload is almost never
 * the well-known song of the same name). Only for callers that would rather show
 * something than nothing.
 */
export function rankEager<T extends EagerCandidate>(
  track: TrackInfo,
  candidates: T[],
  options: MatchOptions = {}
): T[] {
  const wanted = versionTags(track.name);
  const ours = ownForms(track);
  const written = [track.name, ...searchTitles(track.name)];

  const scored: { candidate: T; score: number }[] = [];

  for (const c of candidates) {
    if (wrongVersion(c.title, wanted, options)) continue;
    if ((c.popularity ?? 0) > EAGER_MAX_VIEWS) continue;

    const match = bestTitleMatch(ours, titleForms(c.title), c.artists.map(normalizeName));
    if (match.score < EAGER_MIN_TITLE) continue;

    const artist = artistSimilarity(track, c.artists, options);
    const sameWriting = written.some((w) => writtenAlike(w, c.title)) ? 1 : 0;
    const cover = c.coverDistance == null ? 0 : Math.max(0, 1 - c.coverDistance / COVER_UNRELATED_DISTANCE);
    const obscurity = 1 - Math.min(1, Math.log10(1 + Math.max(0, c.popularity ?? 0)) / 6);

    const score = 0.45 * match.score + 0.15 * sameWriting + 0.2 * artist + 0.1 * cover + 0.1 * obscurity;
    if (score >= EAGER_MIN_SCORE) scored.push({ candidate: c, score });
  }

  return scored.sort((a, b) => b.score - a.score).map((s) => s.candidate);
}

/** For diagnosing a miss: how every candidate scores against the playing track, closest title first. */
export function describeCandidates<T extends LooseCandidate>(
  track: TrackInfo,
  candidates: T[],
  options: MatchOptions = {}
): { title: string; artist: string; titleScore: number; artistScore: number; wrongVersion: boolean }[] {
  const wanted = versionTags(track.name);
  const ours = ownForms(track);
  const round = (n: number) => Math.round(n * 100) / 100;

  return candidates
    .map((c) => ({
      title: c.title,
      artist: c.artists[0] ?? "",
      titleScore: round(bestTitleMatch(ours, titleForms(c.title), c.artists.map(normalizeName)).score),
      artistScore: round(artistSimilarity(track, c.artists, options)),
      wrongVersion: wrongVersion(c.title, wanted, options),
    }))
    .sort((a, b) => b.titleScore - a.titleScore);
}

/**
 * Candidates that plausibly are the playing track, best first. Callers try them in
 * order, since the best match is not always the one that has lyrics.
 */
export function rankCandidates<T extends Candidate>(
  track: TrackInfo,
  candidates: T[],
  options: MatchOptions = {}
): T[] {
  const ours = ownForms(track);
  const artist = normalizeName(track.artist);
  const wanted = versionTags(track.name);

  const scored: { candidate: T; score: number }[] = [];

  for (const c of candidates) {
    const known = c.durationMs > 0 && track.durationMs > 0;
    const diff = known ? Math.abs(c.durationMs - track.durationMs) : 0;
    if (diff > MAX_DURATION_DIFF_MS) continue;

    if (wrongVersion(c.title, wanted, options)) continue;

    const forms = titleForms(c.title);
    if (!ours.some((own) => forms.some((form) => namesMatch(own, form)))) continue;

    const artistOk =
      c.artists.some((a) => namesMatch(artist, normalizeName(a))) ||
      matchesAlias(c.artists, options.artistAliases);
    // Artists are often spelled differently (script, aliases); accept a near-exact length instead.
    if (!artistOk && !(known && diff <= CLOSE_DURATION_DIFF_MS)) continue;

    scored.push({
      candidate: c,
      score: (artistOk ? 10 : 0) + (ours.some((own) => forms.includes(own)) ? 5 : 0) - diff / 1000,
    });
  }

  return scored.sort((a, b) => b.score - a.score).map((s) => s.candidate);
}
