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
// playing track says so too.
const VERSION_TAG = /remix|live|instrumental|karaoke|acoustic|cover|demo|off vocal|伴奏|纯音乐|现场/gi;

function versionTags(title: string): string[] {
  return (title.match(VERSION_TAG) ?? []).map((t) => t.toLowerCase());
}

/**
 * Candidates that plausibly are the playing track, best first. Callers try them in
 * order, since the best match is not always the one that has lyrics.
 */
export function rankCandidates<T extends Candidate>(track: TrackInfo, candidates: T[]): T[] {
  const title = normalizeName(track.name);
  const artist = normalizeName(track.artist);
  const wanted = versionTags(track.name);

  const scored: { candidate: T; score: number }[] = [];

  for (const c of candidates) {
    const known = c.durationMs > 0 && track.durationMs > 0;
    const diff = known ? Math.abs(c.durationMs - track.durationMs) : 0;
    if (diff > MAX_DURATION_DIFF_MS) continue;

    if (versionTags(c.title).some((tag) => !wanted.includes(tag))) continue;

    const candidateTitle = normalizeName(c.title);
    if (!namesMatch(title, candidateTitle)) continue;

    const artistOk = c.artists.some((a) => namesMatch(artist, normalizeName(a)));
    // Artists are often spelled differently (script, aliases); accept a near-exact length instead.
    if (!artistOk && !(known && diff <= CLOSE_DURATION_DIFF_MS)) continue;

    scored.push({
      candidate: c,
      score: (artistOk ? 10 : 0) + (candidateTitle === title ? 5 : 0) - diff / 1000,
    });
  }

  return scored.sort((a, b) => b.score - a.score).map((s) => s.candidate);
}
