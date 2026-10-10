import { SpotifyPlayer } from "../../components/Global/SpotifyPlayer.ts";
import { memoVideo } from "./AnimatedCover.ts";
import { transcodeCanvas } from "./Transcode.ts";

/**
 * Spotify Canvas: the short looping video an artist puts behind a song. The player already
 * knows it: it is in the playing track's metadata (`canvas.url`, an MP4 on Spotify's CDN, which
 * allows a plain fetch). Like Apple's covers, the MP4 is H.264, which Spotify's browser engine
 * cannot play, so it is converted once to a WebM and kept (see Transcode.ts).
 */
export type CanvasInfo = { key: string; url: string };

const hash = (text: string): string => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

/** The Canvas Spotify reports for what is playing, when it is a video. */
function playingCanvas(): CanvasInfo | null {
  const meta = Spicetify.Player.data?.item?.metadata as Record<string, string> | undefined;
  const url = meta?.["canvas.url"];
  if (!url || !/\.mp4(\?|$)/i.test(url)) return null;
  // Canvases can also be still images; only the videos are of use here.
  const type = meta?.["canvas.type"];
  if (type && !type.startsWith("VIDEO")) return null;
  return { key: `canvas-${meta?.["canvas.id"] || meta?.["canvas.fileId"] || hash(url)}`, url };
}

const POLL_MS = 250;
const POLLS = 6;

/**
 * The playing song's Canvas, or null. The player fills its metadata in a moment after the song
 * changes, so a song with none is only given up on after a short wait; a song that changed
 * meanwhile is given up on at once.
 */
export async function findCanvas(uri: string | undefined): Promise<CanvasInfo | null> {
  for (let i = 0; i < POLLS; i++) {
    if (SpotifyPlayer.GetUri() !== uri) return null;
    const found = playingCanvas();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return null;
}

/** A Canvas as a video Spotify can play (an object URL), converted on first use. */
export function getCanvasVideo(canvas: CanvasInfo): Promise<string | null> {
  return memoVideo(canvas.key, () => transcodeCanvas(canvas.url));
}
