import { cleanTitle } from "./Match.ts";
import type { TrackInfo } from "./types.ts";

/**
 * Lyrics for things Spotify does not catalogue as a song: local files and podcast
 * episodes. They have no usable artist (or a wrong one: a podcast's "artist" is its
 * show), but the title very often carries it ("Artist - Song.mp3", "Song by Artist"),
 * so every plausible reading of the title becomes a candidate, best guess first.
 */

type Raw = {
  name: string;
  /** Artists as the player reports them; may be empty or placeholders. */
  artists: string[];
  album: string;
  /** A podcast's show name. It is not an artist, so it is never offered as one. */
  showName?: string;
  durationMs: number;
};

const PLACEHOLDER_ARTIST = /^(unknown( artist)?|various( artists)?|va|artist|none|n\/a|<unknown>)$/i;
const FILE_EXTENSION = /\.(mp3|m4a|flac|wav|ogg|opus|aac|wma|aiff?|mp4|webm)$/i;
const TRACK_NUMBER = /^\s*(?:disc\s*\d+\s*)?\d{1,3}\s*(?:[.)\]:_-]\s*|\s+-\s+)/;
// "Song by Artist" / "Song - by Artist"
const BY_ARTIST = /^(.+?)\s+(?:-\s*)?by\s+(.+)$/i;
const FEATURING = /\s*(?:\(|\[)?\s*(?:feat\.?|ft\.?|featuring|with)\s+.*$/i;

// Where a title stops being the song and starts crediting people: "ft yen", "(prod. yuke)", "w/ x".
const CREDITS_TAIL = /\s*[(\[]?\s*(?:feat\.?|ft\.?|featuring|prod\.?|produced by|w\/)(?=\s).*$/i;

/** The song's own title, without a trailing "ft …" / "prod …" credit. */
function stripCredits(title: string): string {
  const stripped = title.replace(CREDITS_TAIL, "").replace(/[\s\-–—|]+$/, "").trim();
  return stripped || title;
}

/** The names in a credits tail like " ft yen prod yuke & october", in the order written. */
function creditedNames(tail: string): string[] {
  const names = tail
    .replace(/[()[\]]/g, " ")
    .split(/\b(?:feat\.?|ft\.?|featuring|prod\.?(?:\s+by)?|produced by|w\/)(?=\s)/i)
    .flatMap((part) => part.split(/\s*(?:,|&|\bx\b|\band\b|\+)\s*/i))
    .map((name) => name.replace(/\s+/g, " ").trim())
    .filter((name) => /[\p{L}\p{N}]/u.test(name) && !PLACEHOLDER_ARTIST.test(name));
  return [...new Set(names)];
}

/** The first-named artist of a credit like "A feat. B", "A & B", "A, B", "A x B". */
function leadArtist(value: string): string {
  const first = value.replace(FEATURING, "").split(/\s*(?:,|&|\bx\b|\band\b|\+|\/)\s*/i)[0];
  return first.replace(/\s+/g, " ").trim();
}

/** Every artist in a credit like "A feat. B", "A & B", "A, B", "A and B". */
function allNames(value: string): string[] {
  const names = value
    .replace(FEATURING, "")
    .split(/\s*(?:,|&|\bx\b|\band\b|\+|\/)\s*/i)
    .map((n) => n.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return names.length > 0 ? names : [value.trim()];
}

/** A file name or upload title turned into plain words: no extension, no track number, no underscores. */
function tidy(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(FILE_EXTENSION, "")
    // File names stand in for " - " with a run of underscores: "yen__frankenstein__prod_yuke".
    .replace(/\s*_{2,}\s*/g, " - ")
    .replace(/_/g, " ")
    .replace(TRACK_NUMBER, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every plausible (title, artist) reading of a title string, most likely first. */
function readTitle(raw: string): { title: string; artist: string }[] {
  const text = tidy(raw);
  const readings: { title: string; artist: string }[] = [];

  let dashed = text.split(/\s[-–—|]\s/).map((p) => p.trim()).filter(Boolean);
  // "Artist-Song" with no spaces: one hyphen, nothing else to go on.
  if (dashed.length < 2) {
    const tight = text.split(/[-–—]/).map((p) => p.trim()).filter(Boolean);
    if (tight.length === 2 && !/\s-|-\s/.test(text)) dashed = tight;
  }
  if (dashed.length >= 2) {
    // "Artist - Song" is by far the commonest order; "Song - Artist" the next. Every
    // artist named in the first part is a possibility: "yen and yuke - song".
    const [a, b] = dashed;
    for (const name of allNames(a)) readings.push({ title: b, artist: name });
    readings.push({ title: a, artist: leadArtist(b) });
  }

  const by = BY_ARTIST.exec(text);
  if (by) readings.push({ title: by[1], artist: leadArtist(by[2]) });

  return readings.filter((r) => cleanTitle(r.title) && r.artist);
}

/**
 * Titles the item could be known by with no artist at all: the whole title without
 * credits, and each part of an "A - B". For matching on exact title and length alone.
 */
export function unlistedTitles(raw: Raw): string[] {
  const titles = [stripCredits(tidy(raw.name)), ...readTitle(raw.name).map((r) => stripCredits(r.title))];
  return [...new Set(titles.map((t) => t.trim()).filter((t) => cleanTitle(t).length >= 3))].slice(0, 4);
}

/**
 * The lookups to try for a local file or episode, in order. At most four: each is a
 * full round of provider requests.
 */
export function unlistedCandidates(raw: Raw): TrackInfo[] {
  const out: TrackInfo[] = [];
  const seen = new Set<string>();
  const addOne = (name: string, artist: string, artists?: string[]) => {
    if (!name || !cleanTitle(name) || !artist) return;
    const key = `${cleanTitle(name).toLowerCase()}|${artist.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      name,
      artist,
      artists: artists && artists.length > 0 ? artists : [artist],
      album: raw.album,
      durationMs: raw.durationMs,
    });
  };
  // "song ft x prod y" is the song, then the credits: the song alone is tried first.
  const add = (title: string, artist: string, artists?: string[]) => {
    const name = title.trim();
    addOne(stripCredits(name), artist, artists);
    addOne(name, artist, artists);
  };

  // Taggers join several artists with ";" (or "/").
  const tagged = raw.artists
    .flatMap((a) => a.split(/\s*[;/]\s*/))
    .map((a) => a.trim())
    .filter((a) => a && !PLACEHOLDER_ARTIST.test(a));
  const title = tidy(raw.name);

  // Properly tagged local files are as good as catalogued songs.
  if (tagged.length > 0 && title) {
    // Some taggers still leave the artist in the title as well: "Artist - Song".
    const readings = readTitle(raw.name);
    const echoed = readings.find((r) => tagged.some((t) => t.toLowerCase() === r.artist.toLowerCase()));
    add(echoed ? echoed.title : title, tagged[0], tagged);
  }

  for (const reading of readTitle(raw.name)) add(reading.title, reading.artist);

  // "song ft yen prod yuke & october": the people named after the song are likely its artists.
  const song = stripCredits(title);
  if (song !== title) {
    for (const name of creditedNames(title.slice(song.length))) addOne(song, name);
  }

  return out.slice(0, 6);
}
