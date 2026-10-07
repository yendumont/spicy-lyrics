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

  return entriesToLine(entries, durationSeconds);
}

/**
 * Timed text entries (seconds) into the "Line" shape. An entry's end is the next
 * entry's start, blank entries included, so an instrumental gap closes the line
 * before it; the last line ends at `durationSeconds`.
 */
export function entriesToLine(
  entries: { time: number; text: string }[],
  durationSeconds: number
): any | null {
  if (entries.length === 0) return null;
  entries = [...entries].sort((a, b) => a.time - b.time);

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

/**
 * Word-timed lyrics as line-timed ones: each line's words joined, and timed from its
 * first word to its last. Anything that is not word-timed comes back unchanged.
 */
export function syllablesToLine(parsed: any): any | null {
  if (parsed?.Type !== "Syllable") return parsed;

  const join = (syllables: any[]) =>
    syllables
      .map((s) => s.Text + (s.IsPartOfWord ? "" : " "))
      .join("")
      .trim();

  const content: any[] = [];
  for (const vocal of parsed.Content ?? []) {
    const lead = vocal.Lead;
    if (!lead?.Syllables?.length) continue;

    let text = join(lead.Syllables);
    // Backing vocals keep their place at the end of the line, in brackets.
    const backing = (vocal.Background ?? []).map((b: any) => join(b.Syllables ?? [])).filter(Boolean);
    if (backing.length > 0) text += ` ${backing.map((b: string) => (b.startsWith("(") ? b : `(${b})`)).join(" ")}`;

    content.push({
      Type: "Vocal",
      OppositeAligned: !!vocal.OppositeAligned,
      Text: text,
      StartTime: lead.StartTime,
      EndTime: lead.EndTime,
    });
  }

  if (content.length === 0) return null;
  return {
    ...parsed,
    Type: "Line",
    StartTime: content[0].StartTime,
    EndTime: content[content.length - 1].EndTime,
    Content: content,
  };
}

// Credit lines Chinese services put in the lyric body ("作词 : …", "Lyrics by: …").
const CREDIT_LINE =
  /^(作词|作曲|编曲|制作人?|监制|混音|母带|词|曲|lyrics?|composer|composed|arranger|arranged|producer|produced|written)(\s*by)?\s*[:：]/i;

export function isCreditLine(text: string): boolean {
  return CREDIT_LINE.test(text.trim());
}

/** LRC text without its credit lines. */
export function stripCreditLines(lrc: string): string {
  return lrc
    .split(/\r?\n/)
    .filter((raw) => !isCreditLine(raw.replace(TIMESTAMP, "")))
    .join("\n");
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
