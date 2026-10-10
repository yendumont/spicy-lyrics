import Logger from "../Logger.ts";
import { loadFFmpeg } from "./FFmpegLoader.ts";

const logger = new Logger("Animated Cover");

// Apple's animated covers are short loops. A size a cover is shown at plus a little, and a
// ceiling on how much is downloaded and how long it plays, keep each conversion small.
const TARGET_SIZE = 540;
const FRAME_RATE = 24;
const MAX_SECONDS = 30;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_SEGMENTS = 60;
const TIMEOUT_MS = 180_000;
// A cover is converted in this many pieces at once, each in its own ffmpeg, then joined: the
// conversion is one core's work, so this is close to that many times faster. A piece is never
// shorter than MIN_PIECE_SECONDS, and some cores are left for Spotify itself.
const MAX_PIECES = 4;
const MIN_PIECE_SECONDS = 4;

type Variant = { uri: string; width: number; bandwidth: number };

const attr = (attrs: string, name: string): string | undefined =>
  new RegExp(`(?:^|,)${name}=("[^"]*"|[^,]*)`).exec(attrs)?.[1]?.replace(/^"|"$/g, "");

/** The H.264 stream closest to the size a cover is shown at, from an HLS master playlist. */
function chooseVariant(master: string, base: string): Variant | null {
  const variants: Variant[] = [];
  const lines = master.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
    const attrs = lines[i].slice("#EXT-X-STREAM-INF:".length);
    const uri = lines[i + 1]?.trim();
    if (!uri || uri.startsWith("#")) continue;
    const codecs = attr(attrs, "CODECS") ?? "";
    // The stream must be plain H.264 in ordinary (not HDR) colour: that is what the converter reads best.
    if (codecs && !/avc1/.test(codecs)) continue;
    const range = attr(attrs, "VIDEO-RANGE");
    if (range && range !== "SDR") continue;
    variants.push({
      uri: new URL(uri, base).href,
      width: Number(/RESOLUTION=(\d+)x/.exec(attrs)?.[1] ?? 0),
      bandwidth: Number(attr(attrs, "BANDWIDTH") ?? 0),
    });
  }
  // At least the target size where there is one, and the smallest of those.
  const enough = variants.filter((v) => v.width >= TARGET_SIZE).sort((a, b) => a.width - b.width || a.bandwidth - b.bandwidth);
  return enough[0] ?? variants.sort((a, b) => b.width - a.width)[0] ?? null;
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.text();
}

/**
 * An HLS media playlist's pieces as one fragmented MP4 file. Apple's covers are one file whose
 * pieces the playlist names by byte range, and that one file, whole, is the video; otherwise
 * each piece is its own file and they are joined in order.
 */
async function downloadStream(playlistUrl: string): Promise<{ bytes: Uint8Array; seconds: number }> {
  const playlist = await getText(playlistUrl);
  const lines = playlist.split(/\r?\n/).map((line) => line.trim());

  const init = /#EXT-X-MAP:.*URI="([^"]+)"/.exec(playlist)?.[1];
  const segments: string[] = [];
  let sawByteRange = false;
  for (const line of lines) {
    if (line.startsWith("#EXT-X-BYTERANGE")) sawByteRange = true;
    if (line && !line.startsWith("#")) segments.push(new URL(line, playlistUrl).href);
  }
  if (segments.length === 0 || segments.length > MAX_SEGMENTS) throw new Error("The stream has an unexpected shape");

  const files = [...new Set([...(init ? [new URL(init, playlistUrl).href] : []), ...segments])];
  if (sawByteRange && files.length > 1) throw new Error("The stream has an unexpected shape");
  const urls = sawByteRange ? files : [...(init ? [new URL(init, playlistUrl).href] : []), ...segments];

  const parts = await Promise.all(
    urls.map(async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url} answered ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    })
  );

  const size = parts.reduce((total, part) => total + part.length, 0);
  if (size > MAX_BYTES) throw new Error("The stream is bigger than expected");
  const joined = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  // The playlist lists how long each piece plays; their sum is how long the cover is.
  const seconds = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].reduce((total, m) => total + Number(m[1]), 0);
  return { bytes: joined, seconds };
}

/**
 * Convert an Apple Music animated cover (an HLS master playlist) into a short silent
 * looping WebM that Spotify can play. One conversion at a time: ffmpeg runs in its own
 * worker and takes about one core for as long as it takes, a few seconds to a minute.
 */
let queue: Promise<unknown> = Promise.resolve();

export function transcodeMotion(masterUrl: string): Promise<Blob> {
  const job = queue.then(() => run(masterUrl));
  queue = job.catch(() => undefined);
  return job;
}

/** One piece of the cover, from `start` for `span` seconds, converted by an ffmpeg of its own. */
async function convertPiece(source: Uint8Array, start: number, span: number | null): Promise<Uint8Array> {
  const ffmpeg = await loadFFmpeg();
  try {
    // writeFile hands the buffer over to ffmpeg's worker, so every piece gets its own copy.
    await ffmpeg.writeFile("in.mp4", source.slice());
    const code = await ffmpeg.exec(
      [
        "-ss", String(start),
        ...(span ? ["-t", String(span)] : []),
        "-i", "in.mp4",
        "-an",
        "-vf", `scale=${TARGET_SIZE}:${TARGET_SIZE},fps=${FRAME_RATE}`,
        "-c:v", "libvpx",
        "-b:v", "1200k",
        "-deadline", "realtime",
        "-cpu-used", "8",
        // The loop is short and plays from the start: no look-ahead needed, and it keeps memory small.
        "-auto-alt-ref", "0",
        "-lag-in-frames", "0",
        "-threads", "1",
        "out.webm",
      ],
      TIMEOUT_MS
    );
    if (code !== 0) throw new Error(`ffmpeg stopped with ${code}`);
    const data = await ffmpeg.readFile("out.webm");
    if (data.length < 1024) throw new Error("ffmpeg made an empty video");
    return data;
  } finally {
    ffmpeg.terminate();
  }
}

/** The pieces' WebM files as one, by copying (not re-encoding) them end to end. */
async function joinPieces(pieces: Uint8Array[]): Promise<Uint8Array> {
  const ffmpeg = await loadFFmpeg();
  try {
    let list = "";
    for (const [i, piece] of pieces.entries()) {
      await ffmpeg.writeFile(`p${i}.webm`, piece);
      list += `file p${i}.webm\n`;
    }
    await ffmpeg.writeFile("list.txt", new TextEncoder().encode(list));
    const code = await ffmpeg.exec(["-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "out.webm"], TIMEOUT_MS);
    if (code !== 0) throw new Error(`ffmpeg stopped joining with ${code}`);
    return await ffmpeg.readFile("out.webm");
  } finally {
    ffmpeg.terminate();
  }
}

/** How many pieces to convert at once: more for a longer cover and a machine with cores to spare. */
function pieceCount(seconds: number): number {
  const cores = navigator.hardwareConcurrency || 4;
  return Math.max(1, Math.min(MAX_PIECES, Math.floor(seconds / MIN_PIECE_SECONDS), cores - 2));
}

async function run(masterUrl: string): Promise<Blob> {
  const variant = chooseVariant(await getText(masterUrl), masterUrl);
  if (!variant) throw new Error("The animated cover has no stream this can read");
  const { bytes: source, seconds } = await downloadStream(variant.uri);
  logger.debug("Converting an animated cover", `${(source.length / 1048576).toFixed(1)} MB, ${seconds.toFixed(1)}s`);

  const started = Date.now();
  const length = Math.min(seconds || MAX_SECONDS, MAX_SECONDS);
  const count = seconds ? pieceCount(length) : 1;

  let data: Uint8Array;
  if (count > 1) {
    const span = length / count;
    try {
      const pieces = await Promise.all(Array.from({ length: count }, (_, i) => convertPiece(source, i * span, span)));
      data = await joinPieces(pieces);
    } catch (error) {
      // Several ffmpegs at once need more memory; where that fails, the slow way still works.
      logger.warn("Converting in pieces failed; converting in one", error);
      data = await convertPiece(source, 0, MAX_SECONDS);
    }
  } else {
    data = await convertPiece(source, 0, MAX_SECONDS);
  }

  logger.debug("Animated cover ready", `${(data.length / 1024).toFixed(0)} KB in ${((Date.now() - started) / 1000).toFixed(1)}s, ${count} piece(s)`);
  return new Blob([data.slice().buffer as ArrayBuffer], { type: "video/webm" });
}