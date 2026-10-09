import Logger from "../Logger.ts";

const logger = new Logger("Animated Cover");

/**
 * Spotify's browser engine cannot decode the H.264 video Apple serves its animated covers
 * in, so each one is converted once, here, to a WebM it can play. That needs ffmpeg, which
 * is not part of this extension: it is fetched the first time an animated cover is wanted,
 * from the npm CDN at exact versions, checked against the SHA-256 of the files known to be
 * good, and kept in the browser cache after that. Nothing is run that does not match.
 */
const CDN = "https://cdn.jsdelivr.net/npm/";
const CACHE = "SpicyLyrics_FFmpeg_g1";

type Part = { url: string; type: string; sha256: string };

const PARTS = {
  ffmpeg: {
    url: `${CDN}@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js`,
    type: "text/javascript",
    sha256: "a4c09a1997ac582a735fc21e20f9913df4af6dde4ebb373f1d714a4b6e7616f1",
  },
  worker: {
    url: `${CDN}@ffmpeg/ffmpeg@0.12.10/dist/umd/814.ffmpeg.js`,
    type: "text/javascript",
    sha256: "c4702e2f749671b2f9cf07e4738abaf4511fc0d89525ad6a93bc3c2a8ad0822a",
  },
  core: {
    url: `${CDN}@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js`,
    type: "text/javascript",
    sha256: "c972f5abeafcd5f3949e54edfbdc74a9badb27025809feb1945d468ffbcfb7f1",
  },
  wasm: {
    url: `${CDN}@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm`,
    type: "application/wasm",
    sha256: "2390efa7fb66e7e42dbae15427571a5ffc96b829480904c30f471f0a78967f61",
  },
} as const satisfies Record<string, Part>;

const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A part's bytes: from the cache if kept, else from the CDN; only ever bytes whose hash matches. */
async function fetchPart(part: Part): Promise<Blob> {
  const cache = await caches.open(CACHE);
  const kept = await cache.match(part.url);
  if (kept) {
    const bytes = await kept.arrayBuffer();
    if (hex(await crypto.subtle.digest("SHA-256", bytes)) === part.sha256) return new Blob([bytes], { type: part.type });
    await cache.delete(part.url);
  }

  const res = await fetch(part.url);
  if (!res.ok) throw new Error(`Could not fetch ${part.url} (${res.status})`);
  const bytes = await res.arrayBuffer();
  if (hex(await crypto.subtle.digest("SHA-256", bytes)) !== part.sha256) {
    throw new Error(`${part.url} is not the file this extension expects; not using it`);
  }
  await cache.put(part.url, new Response(bytes.slice(0), { headers: { "Content-Type": part.type } })).catch(() => undefined);
  return new Blob([bytes], { type: part.type });
}

const blobUrl = async (part: Part) => URL.createObjectURL(await fetchPart(part));

/** Run a script the page does not already have (the UMD builds put a global on the window). */
async function loadScript(part: Part, global: string): Promise<void> {
  if ((window as any)[global]) return;
  const url = await blobUrl(part);
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Could not run ${part.url}`));
    document.head.appendChild(script);
  });
  URL.revokeObjectURL(url);
}

export type FFmpegInstance = {
  writeFile(name: string, data: Uint8Array): Promise<boolean>;
  readFile(name: string): Promise<Uint8Array>;
  exec(args: string[], timeout?: number): Promise<number>;
  terminate(): void;
  on(event: "log", callback: (e: { message: string }) => void): void;
};

/** A ready ffmpeg (single-threaded, in its own worker). Call `terminate()` when done to free its memory. */
export async function loadFFmpeg(): Promise<FFmpegInstance> {
  await loadScript(PARTS.ffmpeg, "FFmpegWASM");
  const ffmpeg: FFmpegInstance = new (window as any).FFmpegWASM.FFmpeg();

  const [classWorkerURL, coreURL, wasmURL] = await Promise.all([
    blobUrl(PARTS.worker),
    blobUrl(PARTS.core),
    blobUrl(PARTS.wasm),
  ]);
  try {
    await (ffmpeg as any).load({ classWorkerURL, coreURL, wasmURL });
  } finally {
    // The worker has fetched what it needs.
    for (const url of [classWorkerURL, coreURL, wasmURL]) URL.revokeObjectURL(url);
  }
  logger.debug("ffmpeg ready");
  return ffmpeg;
}

/** Whether ffmpeg has been downloaded already (so using it costs no network). */
export async function isFFmpegCached(): Promise<boolean> {
  const cache = await caches.open(CACHE);
  return !!(await cache.match(PARTS.wasm.url));
}

/** Delete the downloaded ffmpeg. */
export async function removeFFmpeg(): Promise<void> {
  await caches.delete(CACHE);
}
