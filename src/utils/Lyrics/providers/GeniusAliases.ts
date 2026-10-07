import { normalizeName, similarity } from "./Match.ts";

// Leaked and fan-uploaded songs often sit on Spotify under an uploader's name while
// Genius lists the real artist ("Yen" on Spotify, "jaydes" on Genius). An uploader
// tends to upload many songs by the same artist, so once a song has been matched
// beyond doubt (same cover art), the pairing is remembered. Later songs by that
// uploader are then searched for under the real name and judged as having a related artist.

const STORAGE_KEY = "SL:geniusAliases";
const MAX_UPLOADERS = 500;
const MAX_ALIASES_PER_UPLOADER = 5;
// Names this alike are the same artist already; there is nothing to learn.
const ALREADY_SAME = 0.6;

type Aliases = Record<string, Record<string, { name: string; count: number }>>;

function read(): Aliases {
  try {
    const raw = Spicetify.LocalStorage.get(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function write(aliases: Aliases): void {
  try {
    Spicetify.LocalStorage.set(STORAGE_KEY, JSON.stringify(aliases));
  } catch {
    // Storage full or unavailable: the alias is simply not kept.
  }
}

// The Genius artists seen behind uploader names, with the songs that showed them.
// A song by someone who has turned up this way several times is a likelier match
// than a song by anyone else, when Spotify's own artist name gives no clue.
const ARTISTS_KEY = "SL:geniusArtists";
const MAX_ARTISTS = 300;
const MAX_SONGS_PER_ARTIST = 50;

type SeenArtists = Record<string, { name: string; songs: string[] }>;

function readSeen(): SeenArtists {
  try {
    const raw = Spicetify.LocalStorage.get(ARTISTS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Note that the Genius page `path` showed `geniusArtist` behind the Spotify artist
 * `spotifyArtist`. Counted once per song, so replaying one does not inflate it, and
 * only when the names differ: an artist matched by their own name says nothing about
 * uploaders.
 */
export function noteArtist(spotifyArtist: string, geniusArtist: string, path: string): void {
  const key = normalizeName(geniusArtist);
  if (!key || similarity(normalizeName(spotifyArtist), key) >= ALREADY_SAME) return;

  const seen = readSeen();
  const entry = (seen[key] ??= { name: geniusArtist, songs: [] });
  if (entry.songs.includes(path)) return;
  entry.songs = [...entry.songs, path].slice(-MAX_SONGS_PER_ARTIST);

  const keep = Object.entries(seen)
    .sort((a, b) => b[1].songs.length - a[1].songs.length)
    .slice(0, MAX_ARTISTS);
  try {
    Spicetify.LocalStorage.set(ARTISTS_KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch {
    // Storage full or unavailable: the note is simply not kept.
  }
}

/** Genius artists seen behind at least `minSongs` different songs, most often seen first. */
export function libraryArtists(minSongs: number): { name: string; key: string; songs: number }[] {
  return Object.entries(readSeen())
    .map(([key, entry]) => ({ name: entry.name, key, songs: entry.songs.length }))
    .filter((artist) => artist.songs >= minSongs)
    .sort((a, b) => b.songs - a.songs);
}

/** Names these Spotify artists are known to go by on Genius. */
export function knownAliases(artists: string[]): string[] {
  const aliases = read();
  const names = new Set<string>();
  for (const artist of artists) {
    for (const entry of Object.values(aliases[normalizeName(artist)] ?? {})) names.add(entry.name);
  }
  return [...names];
}

/** Remember that the Spotify artist `spotifyArtist` is `geniusArtist` on Genius. */
export function learnAlias(spotifyArtist: string, geniusArtist: string): void {
  const uploader = normalizeName(spotifyArtist);
  const real = normalizeName(geniusArtist);
  if (!uploader || !real || similarity(uploader, real) >= ALREADY_SAME) return;

  const aliases = read();
  const entries = (aliases[uploader] ??= {});
  const entry = (entries[real] ??= { name: geniusArtist, count: 0 });
  entry.count++;

  // Keep the best-confirmed few for this uploader, and the most recent uploaders overall.
  const best = Object.entries(entries).sort((a, b) => b[1].count - a[1].count);
  for (const [key] of best.slice(MAX_ALIASES_PER_UPLOADER)) delete entries[key];

  delete aliases[uploader];
  aliases[uploader] = entries;
  for (const key of Object.keys(aliases).slice(0, Math.max(0, Object.keys(aliases).length - MAX_UPLOADERS))) {
    delete aliases[key];
  }

  write(aliases);
}
