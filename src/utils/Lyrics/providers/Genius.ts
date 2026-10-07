import Logger from "../../Logger.ts";
import { parsePlainToStatic } from "./Lrc.ts";
import { COVER_SAME_MAX_DISTANCE, coverDistance } from "./CoverMatch.ts";
import { knownAliases, learnAlias, libraryArtists, noteArtist } from "./GeniusAliases.ts";
import {
  EXACT_TITLE,
  cleanTitle,
  normalizeName,
  rankCandidates,
  rankLoose,
  titleCandidates,
  type MatchOptions,
} from "./Match.ts";
import type { TrackInfo } from "./types.ts";

const logger = new Logger("Genius");

const TIMEOUT_MS = 10000;
const MAX_CANDIDATES = 2;
// Cover comparisons download two images each. Checked a few at a time, closest titles first.
const MAX_COVER_CHECKS = 10;
const COVER_CHECK_BATCH = 4;
// The first loose search is the bare title, whose right answer is often buried under
// better-known songs of the same name, so it asks for a deeper page of results.
const DEEP_RESULTS = 20;

// A cover this close is the same picture; this close is certain enough to learn from.
const COVER_LEARN_MAX_DISTANCE = 6;
// Names an uploader is already known to go by are searched for alongside the title.
const MAX_ALIAS_QUERIES = 2;
// A Genius artist seen behind uploader names in this many different songs counts as one
// this listener's library hosts; such an artist is searched for, and trusted as the
// sole exact-title result, when Spotify's own artist name gives no clue.
const MIN_LIBRARY_SONGS = 3;
const MAX_LIBRARY_QUERIES = 3;

const artistsOf = (track: TrackInfo) => (track.artists?.length ? track.artists : [track.artist]);

// Genius text has no timing, so a demo, live or remix upload carries the lyrics of the
// playing song; only instrumentals, karaoke and covers are the wrong thing. Learned
// aliases of the playing track's artist count as the same artist.
const matchOptions = (track: TrackInfo): MatchOptions => ({
  relaxedVersions: true,
  artistAliases: knownAliases(artistsOf(track)),
});

// Genius lyrics are plain text with no timing, and Genius gives no direct access:
// its pages send no CORS headers and Spicetify's proxy refuses it. The user runs
// their own Cloudflare Worker (workers/genius-proxy) and gives its URL in settings.
// Without one, the provider returns nothing.

type GeniusResult = {
  title?: string;
  path?: string;
  lyrics_state?: string;
  artist_names?: string;
  primary_artist?: { name?: string };
  featured_artists?: { name?: string }[];
  stats?: { pageviews?: number };
  song_art_image_url?: string;
};

type Hit = {
  path: string;
  title: string;
  artists: string[];
  popularity: number;
  durationMs: number;
  art?: string;
};

/**
 * A Genius page chosen for the playing track, and why. `learn` marks a match sure
 * enough to remember the artist pairing; `trusted` one that counts as evidence about
 * which artists this listener's library hosts (a guess from that very evidence does not).
 */
export type Pick = {
  path: string;
  title: string;
  artist: string;
  how: string;
  learn?: boolean;
  trusted?: boolean;
};

const toPick = (hit: Hit, how: string, flags: { learn?: boolean; trusted?: boolean } = {}): Pick => ({
  path: hit.path,
  title: hit.title,
  artist: hit.artists[0] ?? "",
  how,
  ...flags,
});

/** Remember what a pick whose lyrics were shown teaches about the playing track's artist. */
function commitPick(track: TrackInfo, pick: Pick): void {
  if (pick.learn) learnAlias(track.artist, pick.artist);
  if (pick.trusted) noteArtist(track.artist, pick.artist, pick.path);
}

/** The Worker's base URL without trailing slashes, or null if it is empty or not http(s). */
export function normalizeProxyUrl(value: string | undefined | null): string | null {
  const trimmed = (value ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? trimmed : null;
  } catch {
    return null;
  }
}

/** Lyrics text from a Genius lyrics page, without section labels or page furniture. */
export function extractLyrics(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const containers = doc.querySelectorAll('[data-lyrics-container="true"]');
  if (containers.length === 0) return null;

  const parts: string[] = [];
  containers.forEach((container) => {
    // The header (contributors, translations) lives inside the first container.
    container
      .querySelectorAll(
        '[data-exclude-from-selection="true"], [class*="LyricsHeader"], [class*="InreadContainer"]'
      )
      .forEach((el) => el.remove());
    container.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    parts.push(container.textContent ?? "");
  });

  const lines = parts
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    // "[Verse 1: Name]" labels, and the promo text Genius drops between lines.
    .filter((line) => line && !/^\[[^\]]*\]$/.test(line) && !/^(you might also like|\d*embed)$/i.test(line));

  return lines.length > 0 ? lines.join("\n") : null;
}

async function get(url: string): Promise<Response> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) return res;
  if (!res.ok) throw new Error(`Genius proxy responded ${res.status}`);
  return res;
}

/**
 * Song results for one search, without lyrics that are missing or still being
 * transcribed. `perPage` asks for more than the usual five; a Worker that predates
 * that option ignores it and answers with five.
 */
async function searchSongs(base: string, query: string, perPage?: number): Promise<Hit[]> {
  const size = perPage ? `&per_page=${perPage}` : "";
  const res = await get(`${base}/search?q=${encodeURIComponent(query)}${size}`);
  if (res.status === 404) return [];

  const body = (await res.json()) as {
    response?: { sections?: { type?: string; hits?: { result?: GeniusResult }[] }[] };
  };
  const sections = body?.response?.sections ?? [];
  const hits = (sections.find((s) => s.type === "song") ?? sections[0])?.hits ?? [];

  return hits
    .map((h) => h.result)
    .filter((r): r is GeniusResult => !!r?.path && r.lyrics_state === "complete")
    .map((r) => ({
      path: r.path as string,
      title: r.title ?? "",
      artists: [
        r.primary_artist?.name ?? "",
        ...(r.featured_artists ?? []).map((a) => a.name ?? ""),
        r.artist_names ?? "",
      ].filter(Boolean),
      popularity: r.stats?.pageviews ?? 0,
      art: r.song_art_image_url,
      // Genius search results carry no duration.
      durationMs: 0,
    }));
}

/** The exact-match query. Spotify titles carry tails ("- Remastered 2011", "(feat. X)") that derail Genius's search. */
const strictQuery = (track: TrackInfo) => `${cleanTitle(track.name) || track.name} ${track.artist}`;

async function strictPicks(base: string, track: TrackInfo): Promise<Pick[]> {
  const options = matchOptions(track);
  const title = cleanTitle(track.name) || track.name;

  // The title with the artist as Spotify names them, then with any names that artist
  // is known to go by on Genius (an uploader's real artist).
  const queries = [
    strictQuery(track),
    ...(options.artistAliases ?? []).slice(0, MAX_ALIAS_QUERIES).map((alias) => `${title} ${alias}`),
  ];

  const hits = new Map<string, Hit>();
  for (const query of queries) {
    const found = await searchSongs(base, query);
    logger.debug("Genius strict search", query, found.map((h) => `${h.title} / ${h.artists[0]}`));
    for (const hit of found) hits.set(hit.path, hit);
    // The first query that yields a usable match is enough.
    if (rankCandidates(track, [...hits.values()], options).length > 0) break;
  }

  return rankCandidates(track, [...hits.values()], options)
    .slice(0, MAX_CANDIDATES)
    .map((hit) => toPick(hit, "strict: title and artist match", { trusted: true }));
}

/**
 * Whether Genius has an artist of this name. A Spotify artist it has never heard of is
 * probably an uploader, not the song's real artist. Unknown when the lookup fails, which
 * counts as "yes": the caller then does not guess.
 */
async function artistOnGenius(base: string, name: string): Promise<boolean> {
  try {
    const wanted = normalizeName(name);
    if (!wanted) return true;

    const res = await get(`${base}/search?q=${encodeURIComponent(name)}`);
    if (res.status === 404) return false;

    const body = (await res.json()) as {
      response?: { sections?: { hits?: { type?: string; result?: { _type?: string; name?: string } }[] }[] };
    };
    return (body?.response?.sections ?? []).some((section) =>
      (section.hits ?? []).some(
        (hit) =>
          (hit.type === "artist" || hit.result?._type === "artist") &&
          normalizeName(hit.result?.name ?? "") === wanted
      )
    );
  } catch {
    return true;
  }
}

/** Artist name with symbols removed, so "$uicideboy$" is searchable as "uicideboy". */
const plainWords = (value: string) => value.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/**
 * Broader searches for when the exact song and artist found nothing: the title
 * alone (deeper results), in other word orders, with the album, and with
 * symbol-free artist names. Results are pooled; those with a close title and the
 * same cover picture come first, then the closest by title, artist and popularity.
 */
async function loosePicks(
  base: string,
  track: TrackInfo,
  skip: Set<string>,
  favorites: string[]
): Promise<Pick[]> {
  const options = matchOptions(track);
  const title = cleanTitle(track.name);
  const artist = plainWords(track.artist);
  const queries = [
    title,
    `${artist} ${title}`,
    track.album ? `${title} ${plainWords(track.album)}` : "",
    `${title} ${artist}`,
  ]
    .map((q) => q.trim())
    .filter((q, i, all) => q && all.indexOf(q) === i)
    // Already asked verbatim by the strict pass.
    .filter((q) => q !== strictQuery(track));

  // Names the artist is known to go by come first: they find songs the bare title buries.
  for (const alias of (options.artistAliases ?? []).slice(0, MAX_ALIAS_QUERIES)) {
    const query = `${title} ${alias}`;
    if (!queries.includes(query)) queries.unshift(query);
  }

  const pool = new Map<string, Hit>();
  const coverDistances = new Map<string, number | null>();

  /**
   * Results with a close title whose art is the same picture as the playing cover:
   * strong evidence even when the artist names share nothing (uploader names,
   * aliases) or several artists have a song of that title.
   */
  const coverConfirmed = async (): Promise<{ hit: Hit; distance: number }[]> => {
    if (!track.coverUrl) return [];

    const candidates = titleCandidates(track, [...pool.values()], options)
      .filter((h) => h.art)
      .slice(0, MAX_COVER_CHECKS);

    for (let i = 0; i < candidates.length; i += COVER_CHECK_BATCH) {
      await Promise.all(
        candidates
          .slice(i, i + COVER_CHECK_BATCH)
          .filter((hit) => !coverDistances.has(hit.path))
          .map(async (hit) => {
            coverDistances.set(hit.path, await coverDistance(track.coverUrl as string, hit.art as string));
          })
      );
    }

    const confirmed: { hit: Hit; distance: number }[] = [];
    for (const hit of candidates) {
      const distance = coverDistances.get(hit.path);
      logger.debug("Genius cover check", hit.path, distance);
      if (distance != null && distance <= COVER_SAME_MAX_DISTANCE) confirmed.push({ hit, distance });
    }
    return confirmed.sort((a, b) => a.distance - b.distance);
  };

  for (const query of queries) {
    // The bare title is the search famous songs of the same name crowd out, so it goes deep.
    const found = await searchSongs(base, query, query === title ? DEEP_RESULTS : undefined);
    logger.debug("Genius loose search", query, found.map((h) => `${h.title} / ${h.artists[0]}`));
    for (const hit of found) {
      // Genius's own Translations / Romanizations accounts re-post the same lyrics.
      if (/^genius\b/i.test(hit.artists[0] ?? "")) continue;
      if (!skip.has(hit.path)) pool.set(hit.path, hit);
    }
    // A cover match, or enough plausible matches to try: stop searching.
    if ((await coverConfirmed()).length > 0) break;
    if (rankLoose(track, [...pool.values()], options).length >= MAX_CANDIDATES) break;
  }

  const confirmed = await coverConfirmed();
  const taken = new Set(confirmed.map((c) => c.hit.path));
  const guessed = rankLoose(track, [...pool.values()], options).filter((h) => !taken.has(h.path));

  const picks = [
    ...confirmed.map((c) =>
      toPick(c.hit, `loose: same cover (distance ${c.distance})`, {
        learn: c.distance <= COVER_LEARN_MAX_DISTANCE,
        trusted: true,
      })
    ),
    ...guessed.map((h) => toPick(h, "loose: closest title and artist", { trusted: true })),
  ];

  // Nothing proved a match. Last: an artist this listener's library already hosts.
  if (picks.length === 0) {
    const fromLibrary = await libraryPick(base, track, pool, title, options, favorites);
    if (fromLibrary) picks.push(fromLibrary);
  }

  return picks.slice(0, MAX_CANDIDATES);
}

/**
 * For an unknown uploader's song with no proof of its real artist: the sole exact-title
 * result by an artist seen behind uploader names in several of this listener's songs.
 * Genius's own search buries obscure songs under famous ones of the same name, so the
 * library's artists are searched for by name alongside the title. Declines when Spotify's
 * artist is itself known to Genius (that song would have matched by name), or when
 * more than one library artist has a song of that title.
 */
async function libraryPick(
  base: string,
  track: TrackInfo,
  pool: Map<string, Hit>,
  title: string,
  options: MatchOptions,
  favorites: string[]
): Promise<Pick | null> {
  // Artists the listener named count as fully established; learned ones need a few songs.
  const named = favorites.map((name) => ({ name, key: normalizeName(name), songs: Number.POSITIVE_INFINITY }));
  const library = [...named, ...libraryArtists(MIN_LIBRARY_SONGS)]
    .filter((artist, i, all) => artist.key && all.findIndex((other) => other.key === artist.key) === i);
  if (library.length === 0) return null;

  for (const artist of library.slice(0, MAX_LIBRARY_QUERIES)) {
    const found = await searchSongs(base, `${title} ${artist.name}`);
    logger.debug("Genius library search", `${title} ${artist.name}`, found.map((h) => `${h.title} / ${h.artists[0]}`));
    for (const hit of found) {
      if (!/^genius\b/i.test(hit.artists[0] ?? "")) pool.set(hit.path, hit);
    }
  }

  const keys = new Set(library.map((a) => a.key));
  const exact = titleCandidates(track, [...pool.values()], options, EXACT_TITLE).filter((hit) =>
    keys.has(normalizeName(hit.artists[0] ?? ""))
  );
  if (new Set(exact.map((hit) => normalizeName(hit.artists[0] ?? ""))).size !== 1) return null;

  if (await artistOnGenius(base, track.artist)) return null;

  const seen = library.find((a) => a.key === normalizeName(exact[0].artists[0] ?? ""));
  return toPick(
    exact[0],
    seen && Number.isFinite(seen.songs)
      ? `loose: ${exact[0].artists[0]}, whom your library has resolved ${seen.songs}x`
      : `loose: ${exact[0].artists[0]}, a favourite artist you listed`
  );
}

async function lyricsAt(base: string, path: string): Promise<any | null> {
  const res = await get(`${base}/lyrics?path=${encodeURIComponent(path)}`);
  if (res.status === 404) return null;

  const text = extractLyrics(await res.text());
  const parsed = text ? parsePlainToStatic(text) : null;
  return parsed ? { ...parsed, source: "genius" } : null;
}

/**
 * Which Genius pages would be used for a track, and why, without fetching any lyrics.
 * For diagnosing matches.
 */
export async function explainGenius(
  track: TrackInfo,
  proxyUrl: string,
  loose = false,
  learn = false,
  favorites: string[] = []
): Promise<{ strict: Pick[]; loose: Pick[] } | null> {
  const base = normalizeProxyUrl(proxyUrl);
  if (!base) return null;

  const strict = await strictPicks(base, track);
  const looser = strict.length === 0 && loose ? await loosePicks(base, track, new Set(), favorites) : [];
  // As in fetchFromGenius, the best pick is the one whose lyrics would be shown.
  const best = strict[0] ?? looser[0];
  if (learn && best) commitPick(track, best);
  return { strict, loose: looser };
}

/**
 * Lyrics from Genius through the user's proxy. The exact song and artist are tried
 * first. With `loose` on, a miss falls through to broader searches that take the
 * closest-looking result instead.
 */
export async function fetchFromGenius(
  track: TrackInfo,
  proxyUrl: string,
  loose = false,
  favorites: string[] = []
): Promise<any | null> {
  const base = normalizeProxyUrl(proxyUrl);
  if (!base) return null;

  const tried = new Set<string>();

  for (const pick of await strictPicks(base, track)) {
    tried.add(pick.path);
    const lyrics = await lyricsAt(base, pick.path);
    if (lyrics) {
      commitPick(track, pick);
      return lyrics;
    }
  }

  if (loose) {
    for (const pick of await loosePicks(base, track, tried, favorites)) {
      const lyrics = await lyricsAt(base, pick.path);
      if (lyrics) {
        logger.debug("Genius loose match used", pick.path, pick.how);
        commitPick(track, pick);
        return lyrics;
      }
    }
  }

  logger.debug("Genius had no usable lyrics", track.name);
  return null;
}
