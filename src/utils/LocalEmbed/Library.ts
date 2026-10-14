import { embeddedLyricsOf } from "./EmbeddedLyrics.ts";
import { readTags, type SyncedEntry } from "./Tags.ts";

/**
 * The lyrics found in the tags of the listener's own music files. Spotify's page cannot open a
 * local file by itself, so the listener picks a folder (or files) once; each file's tags are read
 * there and the lyrics kept in the browser's cache, keyed by artist and title, so a local song
 * playing later is matched by the same two things Spotify shows for it. Nothing is uploaded.
 */

const CACHE = "SpicyLyrics_EmbeddedLyrics_g1";
const SUMMARY = "/summary";
const AUDIO = /\.(mp3|flac|m4a|mp4|aac|ogg|oga|opus)$/i;

/** What the file picker should offer. */
export const AUDIO_ACCEPT = ".mp3,.flac,.m4a,.mp4,.aac,.ogg,.oga,.opus,audio/*";

type Stored = {
  title: string;
  artists: string[];
  album?: string;
  lyrics: string[];
  synced?: SyncedEntry[];
};

export type ScanSummary = {
  at: number;
  scanned: number;
  withLyrics: number;
  kinds: { word: number; line: number; plain: number };
};

const flat = (value: string): string => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Several artists are written many ways ("A, B", "A; B", "A & B", "A feat. B"); each name on its own is also a way in. */
function artistNames(artist: string): string[] {
  const parts = artist
    .split(/\s*(?:;|\/|,|&|\bfeat\.?\b|\bft\.?\b|\bx\b|\band\b)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
  return [...new Set([artist, ...parts])];
}

const withoutBrackets = (title: string) => title.replace(/\s*[([][^)\]]*[)\]]/g, "").trim();

function keyOf(artist: string, title: string): string {
  const text = `${flat(artist)}|${flat(title)}`;
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `/e/${(h >>> 0).toString(36)}-${text.length}`;
}

async function readEntry(cache: Cache, key: string): Promise<Stored[]> {
  const found = await cache.match(key);
  if (!found) return [];
  try {
    const list = await found.json();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function scanSummary(): Promise<ScanSummary | null> {
  try {
    const found = await (await caches.open(CACHE)).match(SUMMARY);
    return found ? await found.json() : null;
  } catch {
    return null;
  }
}

/** Forget everything read from files. */
export async function clearLibrary(): Promise<void> {
  await caches.delete(CACHE);
}

/**
 * Read the tags of `files` and keep the lyrics of those that have any. Files that are not music
 * are skipped. `onProgress` is told how many files have been looked at.
 */
export async function scanFiles(
  files: File[],
  onProgress?: (done: number, total: number) => void
): Promise<ScanSummary> {
  const music = files.filter((file) => AUDIO.test(file.name));
  const cache = await caches.open(CACHE);

  const found = new Map<string, Stored[]>();
  const kinds = { word: 0, line: 0, plain: 0 };
  let withLyrics = 0;
  let done = 0;

  const add = (key: string, item: Stored) => {
    const list = found.get(key) ?? [];
    if (!list.some((x) => flat(x.album ?? "") === flat(item.album ?? "") && flat(x.title) === flat(item.title))) list.push(item);
    found.set(key, list);
  };

  const handle = async (file: File) => {
    const tags = await readTags(file);
    done++;
    onProgress?.(done, music.length);
    if (!tags.title || (tags.lyrics.length === 0 && !tags.synced?.length)) return;

    const item: Stored = { title: tags.title, artists: tags.artists, album: tags.album, lyrics: tags.lyrics, synced: tags.synced };
    const shown = embeddedLyricsOf(item, 0);
    if (!shown) return;

    withLyrics++;
    if (shown.Type === "Syllable") kinds.word++;
    else if (shown.Type === "Line") kinds.line++;
    else kinds.plain++;

    const artists = tags.artists.length ? tags.artists : [""];
    const names = new Set<string>([artists.join(", "), ...artists.flatMap(artistNames)]);
    for (const name of names) add(keyOf(name, tags.title), item);
  };

  // A few at a time: reading tags is mostly waiting on the disk.
  const queue = [...music];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let file = queue.shift(); file; file = queue.shift()) await handle(file);
    })
  );

  for (const [key, items] of found) {
    const existing = await readEntry(cache, key);
    const merged = [...items];
    for (const old of existing) {
      if (!merged.some((x) => flat(x.album ?? "") === flat(old.album ?? "") && flat(x.title) === flat(old.title))) merged.push(old);
    }
    await cache.put(key, new Response(JSON.stringify(merged), { headers: { "Content-Type": "application/json" } }));
  }

  const summary: ScanSummary = { at: Date.now(), scanned: music.length, withLyrics, kinds };
  await cache.put(SUMMARY, new Response(JSON.stringify(summary), { headers: { "Content-Type": "application/json" } }));
  return summary;
}

/** The pieces a local file's uri carries: spotify:local:artist:album:title:seconds (each URL-encoded). */
export function parseLocalUri(uri: string): { artist: string; album: string; title: string; seconds: number } | null {
  const parts = uri.split(":");
  if (parts.length < 6 || parts[0] !== "spotify" || parts[1] !== "local") return null;
  const decode = (text: string) => {
    try {
      return decodeURIComponent(text.replace(/\+/g, " "));
    } catch {
      return text;
    }
  };
  return {
    artist: decode(parts[2]),
    album: decode(parts[3]),
    title: decode(parts.slice(4, -1).join(":")),
    seconds: Number(parts[parts.length - 1]) || 0,
  };
}

/** The lyrics a local file's own tags hold, ready to show, or null when none were read for this song. */
export async function embeddedLyricsForUri(uri: string): Promise<any | null> {
  const local = parseLocalUri(uri);
  if (!local || !local.title) return null;

  try {
    const cache = await caches.open(CACHE);
    const titles = [...new Set([local.title, withoutBrackets(local.title)].filter(Boolean))];

    for (const artist of artistNames(local.artist || "")) {
      for (const title of titles) {
        const items = await readEntry(cache, keyOf(artist, title));
        if (items.length === 0) continue;
        const pick = items.find((x) => flat(x.album ?? "") === flat(local.album)) ?? items[0];
        const lyrics = embeddedLyricsOf(pick, local.seconds);
        if (lyrics) return lyrics;
      }
    }
  } catch {
    return null;
  }
  return null;
}
