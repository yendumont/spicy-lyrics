import { HasLyricsText } from "../EmptyLines.ts";

const TIMESTAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

function toSeconds(min: string, sec: string, frac?: string): number {
  const fraction = frac ? Number(`0.${frac}`) : 0;
  return Number(min) * 60 + Number(sec) + fraction;
}

/**
 * Parse LRC text into Spicy Lyrics' "Line" shape. Every line's end is the start
 * of the next timestamped entry (blank entries included, so an instrumental gap
 * closes the line before it); the last line ends at `durationSeconds`.
 */
export function parseLrcToLine(lrc: string, durationSeconds: number): any | null {
  const entries: { time: number; text: string }[] = [];

  for (const raw of lrc.split(/\r?\n/)) {
    const times = [...raw.matchAll(TIMESTAMP)];
    if (times.length === 0) continue;
    // Strip the timestamps and any enhanced-LRC word tags (<mm:ss.xx>).
    const text = raw.replace(TIMESTAMP, "").replace(/<\d+:\d+(?:[.:]\d+)?>/g, "").trim();
    for (const t of times) {
      entries.push({ time: toSeconds(t[1], t[2], t[3]), text });
    }
  }

  if (entries.length === 0) return null;
  entries.sort((a, b) => a.time - b.time);

  const content = [];
  for (let i = 0; i < entries.length; i++) {
    const { time, text } = entries[i];
    if (!HasLyricsText(text)) continue;
    const next = entries[i + 1]?.time;
    const end = next ?? Math.max(durationSeconds, time + 3);
    content.push({
      Type: "Vocal",
      OppositeAligned: false,
      Text: text,
      StartTime: time,
      EndTime: end,
    });
  }

  if (content.length === 0) return null;

  return {
    Type: "Line",
    StartTime: content[0].StartTime,
    EndTime: content[content.length - 1].EndTime,
    Content: content,
  };
}

/** Plain, unsynced text into the "Static" shape. */
export function parsePlainToStatic(text: string): any | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => HasLyricsText(line))
    .map((line) => ({ Text: line }));

  if (lines.length === 0) return null;
  return { Type: "Static", Lines: lines };
}
