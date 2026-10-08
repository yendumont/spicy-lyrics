import Logger from "../../Logger.ts";
import { buildUrl, getViaCosmos } from "./Http.ts";
import { entriesToLine, parsePlainToStatic } from "./Lrc.ts";
import type { TrackInfo } from "./types.ts";

const logger = new Logger("Musixmatch");

// Musixmatch has no public lyrics API for apps like this. This is the desktop
// client's endpoint, which wants a user token. Musixmatch hands out a blank
// token to clients it does not trust, so the listener supplies their own (Settings
// → Lyrics Display → Musixmatch Token); with none set this finds nothing.
const BASE = "https://apic-desktop.musixmatch.com/ws/1.1/macro.subtitles.get";
const APP_ID = "web-desktop-app-v1.0";

/** A blank token (all zeros) is Musixmatch's refusal, not a login. */
const looksReal = (token: string) => token.length > 20 && /[^0]/.test(token);

type RichsyncLine = { ts: number; te: number; l?: { c?: string; o?: number }[]; x?: string };
type MxmSubtitle = { text?: string; time?: { total?: number } };

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/**
 * Richsync: each line has a start `ts`, an end `te` and pieces `l` with offsets
 * `o` from the line's start; whitespace is a piece of its own.
 */
export function parseRichsync(body: RichsyncLine[]): any | null {
  const content: any[] = [];

  for (const line of body) {
    const pieces = line.l ?? [];
    const words: { text: string; start: number; spaceBefore: boolean }[] = [];
    let space = true;
    for (const piece of pieces) {
      const text = piece.c ?? "";
      if (text.trim() === "") {
        space = true;
        continue;
      }
      words.push({ text: text.trim(), start: line.ts + (piece.o ?? 0), spaceBefore: space || /^\s/.test(text) });
      space = /\s$/.test(text);
    }
    if (words.length === 0) continue;

    const syllables = words.map((w, i) => {
      const next = words[i + 1];
      return {
        Text: w.text,
        IsPartOfWord: next !== undefined && !next.spaceBefore,
        StartTime: w.start,
        EndTime: next ? next.start : line.te,
      };
    });

    content.push({
      Type: "Vocal",
      OppositeAligned: false,
      Lead: {
        Syllables: syllables,
        StartTime: syllables[0].StartTime,
        EndTime: Math.max(syllables[syllables.length - 1].EndTime, syllables[syllables.length - 1].StartTime),
      },
    });
  }

  return content.length === 0
    ? null
    : {
        Type: "Syllable",
        StartTime: content[0].Lead.StartTime,
        EndTime: content[content.length - 1].Lead.EndTime,
        Content: content,
      };
}

const FOOTER = /\n?\*{3,}.*$/s;

export async function fetchFromMusixmatch(track: TrackInfo, token: string): Promise<any | null> {
  const userToken = token.trim();
  if (!looksReal(userToken)) return null;

  const res = await getViaCosmos(
    buildUrl(BASE, {
      format: "json",
      namespace: "lyrics_richsynched",
      subtitle_format: "mxm",
      app_id: APP_ID,
      usertoken: userToken,
      optional_calls: "track.richsync",
      q_track: track.name,
      q_artist: track.artist,
      q_album: track.album ?? "",
      q_duration: track.durationMs ? Math.round(track.durationMs / 1000) : "",
      f_subtitle_length: track.durationMs ? Math.round(track.durationMs / 1000) : "",
      // An exact match when the song is in Spotify's catalogue.
      ...(track.spotifyId ? { track_spotify_id: track.spotifyId } : {}),
    }),
    10000,
    { Cookie: "x-mxm-token-guid=" }
  );

  const calls = res?.message?.body?.macro_calls;
  if (!calls) return null;
  if (calls["matcher.track.get"]?.message?.header?.status_code !== 200) return null;

  const durationS = track.durationMs / 1000;

  const richsync = parseJson<RichsyncLine[]>(calls["track.richsync.get"]?.message?.body?.richsync?.richsync_body);
  const words = richsync ? parseRichsync(richsync) : null;
  if (words) return { ...words, source: "musixmatch" };

  const subtitle = parseJson<MxmSubtitle[]>(
    calls["track.subtitles.get"]?.message?.body?.subtitle_list?.[0]?.subtitle?.subtitle_body
  );
  const lines = entriesToLine(
    (subtitle ?? [])
      .filter((s) => typeof s.time?.total === "number")
      .map((s) => ({ time: s.time?.total as number, text: (s.text ?? "").trim() })),
    durationS
  );
  if (lines) return { ...lines, source: "musixmatch" };

  const plain = calls["track.lyrics.get"]?.message?.body?.lyrics?.lyrics_body;
  const parsed = typeof plain === "string" ? parsePlainToStatic(plain.replace(FOOTER, "")) : null;
  if (parsed) return { ...parsed, source: "musixmatch" };

  logger.debug("Musixmatch had no usable lyrics");
  return null;
}
