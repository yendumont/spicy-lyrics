import { SpotifyPlayer } from "../../components/Global/SpotifyPlayer.ts";
import { videoTwinUri } from "../Lyrics/providers/Resolve.ts";
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

/** The Canvas of any track by its uri, asked of Spotify's own service (the playing item's metadata only has its own). */
async function canvasOfTrack(trackUri: string): Promise<CanvasInfo | null> {
  try {
    const gql = Spicetify.GraphQL;
    const response: any = await gql.Request((gql.Definitions as any).canvas, { trackUri });
    const canvas = response?.data?.trackUnion?.canvas;
    if (!canvas?.url || !/\.mp4(\?|$)/i.test(canvas.url)) return null;
    if (canvas.type && !String(canvas.type).startsWith("VIDEO")) return null;
    return { key: `canvas-${String(canvas.uri ?? "").split(":")[2] || canvas.fileId || hash(canvas.url)}`, url: canvas.url };
  } catch {
    return null;
  }
}

/**
 * The playing song's Canvas, or null. The player fills its metadata in a moment after the song
 * changes, so a song with none is only given up on after a short wait; a song that changed
 * meanwhile is given up on at once.
 */
export async function findCanvas(uri: string | undefined): Promise<CanvasInfo | null> {
  // A video song is a track of its own with no Canvas; the audio track it belongs to may have one.
  const twin = videoTwinUri();
  if (twin) {
    const own = playingCanvas();
    if (own) return own;
    return SpotifyPlayer.GetUri() === uri ? canvasOfTrack(twin) : null;
  }

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
