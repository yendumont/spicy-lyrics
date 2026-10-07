// Do two cover images show the same picture? Used to tell apart songs that share a
// title when their artist names give no clue (uploader names, leaks, aliases).
//
// A difference hash: shrink the picture to 9x8 greyscale and record, for each pixel,
// whether it is brighter than its right-hand neighbour. That survives resizing,
// recompression and small colour shifts. Two unrelated pictures differ in about half
// of the 64 bits; copies of one picture differ in a handful.

const TIMEOUT_MS = 8000;
const HASH_COLUMNS = 9;
const HASH_ROWS = 8;

/** Bits that may differ (of 64) for two images still to count as the same picture. */
export const COVER_SAME_MAX_DISTANCE = 10;

/** https URL for a Spotify image reference ("spotify:image:<id>"); other values pass through. */
export function toImageUrl(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  if (ref.startsWith("spotify:image:")) return `https://i.scdn.co/image/${ref.split(":")[2]}`;
  return ref;
}

async function loadBitmap(url: string): Promise<ImageBitmap> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Image responded ${res.status}`);
  return createImageBitmap(await res.blob());
}

function canvasOf(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("No 2d canvas available");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return ctx;
}

const hashes = new Map<string, Promise<bigint>>();

/** 64-bit difference hash of the image at `url`. Remembered, so the playing cover is fetched once per song. */
export function hashImage(url: string): Promise<bigint> {
  let hash = hashes.get(url);
  if (!hash) {
    if (hashes.size >= 100) hashes.delete(hashes.keys().next().value as string);
    hash = computeHash(url);
    hashes.set(url, hash);
    // A failed load must not be remembered as the answer.
    hash.catch(() => hashes.delete(url));
  }
  return hash;
}

async function computeHash(url: string): Promise<bigint> {
  const bitmap = await loadBitmap(url);
  try {
    // Two steps (down to 8x, then to the final size) average the pixels instead of skipping them.
    const mid = canvasOf(HASH_COLUMNS * 8, HASH_ROWS * 8);
    mid.drawImage(bitmap, 0, 0, mid.canvas.width, mid.canvas.height);

    const small = canvasOf(HASH_COLUMNS, HASH_ROWS);
    small.drawImage(mid.canvas, 0, 0, HASH_COLUMNS, HASH_ROWS);
    const { data } = small.getImageData(0, 0, HASH_COLUMNS, HASH_ROWS);

    const grey = (x: number, y: number) => {
      const i = (y * HASH_COLUMNS + x) * 4;
      return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    };

    let hash = 0n;
    for (let y = 0; y < HASH_ROWS; y++) {
      for (let x = 0; x < HASH_COLUMNS - 1; x++) {
        hash = (hash << 1n) | (grey(x, y) > grey(x + 1, y) ? 1n : 0n);
      }
    }
    return hash;
  } finally {
    bitmap.close();
  }
}

/** How many of the 64 bits differ. */
export function hashDistance(a: bigint, b: bigint): number {
  let diff = a ^ b;
  let count = 0;
  while (diff > 0n) {
    count += Number(diff & 1n);
    diff >>= 1n;
  }
  return count;
}

/** Bit distance between two images, or null if either could not be loaded. */
export async function coverDistance(a: string, b: string): Promise<number | null> {
  try {
    const [hashA, hashB] = await Promise.all([hashImage(a), hashImage(b)]);
    return hashDistance(hashA, hashB);
  } catch {
    return null;
  }
}
