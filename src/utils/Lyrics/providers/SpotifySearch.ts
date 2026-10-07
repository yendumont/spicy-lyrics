import Logger from "../../Logger.ts";
import { rankCandidates, titleForms } from "./Match.ts";
import type { TrackInfo } from "./types.ts";

const logger = new Logger("Spotify Search");

/** A local file may be a slightly different cut; further apart than this and Spicy's timing would be off. */
const MAX_DURATION_DIFF_MS = 10000;

/** With no artist to vouch for it, a same-titled track must be this close in length. */
const EXACT_LENGTH_DIFF_MS = 2000;

type Found = { uri: string; title: string; artists: string[]; durationMs: number };

/** Spotify's own search (the one behind the desktop search box), so no Web API token or rate limit. */
async function searchTracks(term: string): Promise<Found[]> {
  const gql = Spicetify?.GraphQL;
  const query = (gql?.Definitions as any)?.searchModalResults;
  if (!gql?.Request || !query) return [];

  const response: any = await gql.Request(query, {
    searchTerm: term,
    offset: 0,
    limit: 10,
    numberOfTopResults: 10,
    includeAudiobooks: false,
    includeArtistHasConcertsField: false,
    includePreReleases: false,
    includeAuthors: false,
    includeEpisodeContentRatingsV2: false,
  });

  // Tracks turn up in more than one list of the response; take them wherever they are.
  const found = new Map<string, Found>();
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.__typename === "Track" && typeof node.uri === "string" && node.name) {
      found.set(node.uri, {
        uri: node.uri,
        title: node.name,
        artists: (node.artists?.items ?? []).map((a: any) => a?.profile?.name).filter(Boolean),
        durationMs: 0,
      });
    }
    Object.values(node).forEach(walk);
  };
  walk(response?.data);
  return [...found.values()];
}

async function durationOf(uri: string): Promise<number> {
  const gql = Spicetify.GraphQL;
  const response: any = await gql.Request((gql.Definitions as any).getTrack, { uri });
  return response?.data?.trackUnion?.duration?.totalMilliseconds ?? 0;
}

/**
 * The catalogue track a local file or episode most likely is: the first guess that
 * Spotify has a same-titled, same-artist track for whose length is within a few seconds
 * of the file's. Null when nothing fits, so a different song is never played off as it.
 */
export async function findSpotifyTrackId(
  guesses: TrackInfo[],
  isStale: () => boolean,
  titles: { titles: string[]; durationMs: number } = { titles: [], durationMs: 0 }
): Promise<string | null> {
  const tried = new Set<string>();

  for (const guess of guesses) {
    for (const term of [`${guess.artist} ${guess.name}`, guess.name]) {
      if (isStale()) return null;
      if (tried.has(term.toLowerCase())) continue;
      tried.add(term.toLowerCase());

      let found: Found[];
      try {
        found = await searchTracks(term);
      } catch (error) {
        logger.warn("Spotify search failed", error);
        continue;
      }

      for (const match of rankCandidates(guess, found).slice(0, 3)) {
        try {
          const durationMs = await durationOf(match.uri);
          if (guess.durationMs > 0 && Math.abs(durationMs - guess.durationMs) > MAX_DURATION_DIFF_MS) continue;
          return match.uri.split(":")[2];
        } catch (error) {
          logger.warn("Could not read the track's length", error);
        }
      }
    }
  }

  // No artist could be confirmed (none in the file, or an uploader's). The title alone
  // is enough only with a same-titled track whose length is all but identical.
  if (titles.durationMs > 0) {
    for (const title of titles.titles) {
      if (isStale()) return null;
      let found: Found[];
      try {
        found = await searchTracks(title);
      } catch (error) {
        logger.warn("Spotify search failed", error);
        continue;
      }
      const wanted = new Set(titleForms(title));
      const same = found.filter((f) => titleForms(f.title).some((form) => wanted.has(form))).slice(0, 6);
      let best: { id: string; diff: number } | null = null;
      for (const match of same) {
        try {
          const diff = Math.abs((await durationOf(match.uri)) - titles.durationMs);
          if (diff <= EXACT_LENGTH_DIFF_MS && (!best || diff < best.diff)) {
            best = { id: match.uri.split(":")[2], diff };
          }
        } catch (error) {
          logger.warn("Could not read the track's length", error);
        }
      }
      if (best) return best.id;
    }
  }
  return null;
}
