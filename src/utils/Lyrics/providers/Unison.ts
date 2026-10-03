import Logger from "../../Logger.ts";
import { parseTTML } from "../ttml/parser.ts";
import { parseLrcToLine, parsePlainToStatic } from "./Lrc.ts";
import type { TrackInfo } from "./types.ts";

const logger = new Logger("Unison");

const BASE = "https://unison.boidu.dev";
const TIMEOUT_MS = 8000;

type UnisonLyrics = {
  lyrics?: string;
  format?: "ttml" | "lrc" | "plain";
  hidden?: boolean;
};

export async function fetchFromUnison(track: TrackInfo): Promise<any | null> {
  const params = new URLSearchParams({ song: track.name, artist: track.artist });
  if (track.album) params.set("album", track.album);
  if (track.durationMs > 0) params.set("duration", String(Math.round(track.durationMs / 1000)));

  const res = await fetch(`${BASE}/lyrics?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Unison responded ${res.status}`);

  const body = (await res.json()) as { success?: boolean; data?: UnisonLyrics };
  const data = body?.data;
  if (!body?.success || !data?.lyrics || data.hidden) return null;

  let parsed: any | null = null;
  switch (data.format) {
    case "ttml":
      parsed = parseTTML(data.lyrics);
      break;
    case "lrc":
      parsed = parseLrcToLine(data.lyrics, track.durationMs / 1000);
      break;
    case "plain":
      parsed = parsePlainToStatic(data.lyrics);
      break;
    default:
      logger.warn("Unknown Unison lyrics format", data.format);
  }

  return parsed ? { ...parsed, source: "unison" } : null;
}
