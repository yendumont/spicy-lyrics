import { parseTTML } from "../Lyrics/ttml/parser.ts";

/**
 * A TTML file turned into LRC text that can be put in a song's tags:
 *
 *   word-timed TTML   enhanced LRC, one line per sung line: [00:12.00]<00:12.00>Hel<00:12.40>lo <00:12.90>
 *   line-timed TTML   LRC: [00:12.00]Hello
 *   untimed TTML      plain lines
 *
 * A backing vocal becomes a line of its own in brackets. Both ends of the conversion are the
 * same two formats the "Embedded Lyrics" experiment reads, so a file converted here and put in a
 * song's lyrics tag shows the same way.
 */

export type LrcPrecision = "centiseconds" | "milliseconds";

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** 12.345 -> "00:12.35" (or "00:12.345" in milliseconds). */
function stamp(seconds: number, precision: LrcPrecision): string {
  const total = Math.max(0, seconds);
  if (precision === "milliseconds") {
    const ms = Math.round(total * 1000);
    return `${pad(Math.floor(ms / 60000), 2)}:${pad(Math.floor((ms % 60000) / 1000), 2)}.${pad(ms % 1000, 3)}`;
  }
  const cs = Math.round(total * 100);
  return `${pad(Math.floor(cs / 6000), 2)}:${pad(Math.floor((cs % 6000) / 100), 2)}.${pad(cs % 100, 2)}`;
}

type Syllable = { Text: string; IsPartOfWord: boolean; StartTime?: number; EndTime?: number };
type Group = { Syllables: Syllable[]; StartTime?: number; EndTime?: number };

/** One line of enhanced LRC for a group of timed syllables, optionally in brackets. */
function enhancedLine(group: Group, precision: LrcPrecision, brackets: boolean): { at: number; text: string } | null {
  const syllables = group.Syllables.filter((s) => s.Text.trim() !== "" && s.StartTime !== undefined);
  if (syllables.length === 0) return null;

  const first = syllables[0].StartTime as number;
  // One step of the time format: a pause shorter than this cannot be written, so is not.
  const unit = precision === "milliseconds" ? 0.001 : 0.01;

  let body = "";
  syllables.forEach((syllable, i) => {
    const open = brackets && i === 0 ? "(" : "";
    const close = brackets && i === syllables.length - 1 ? ")" : "";
    const space = !syllable.IsPartOfWord && i < syllables.length - 1 ? " " : "";
    body += `<${stamp(syllable.StartTime as number, precision)}>${open}${syllable.Text.trim()}${close}${space}`;

    // A word normally ends where the next begins. When there is a pause between them, a tag of its
    // own says where this one ended.
    const next = syllables[i + 1];
    if (next && syllable.EndTime !== undefined && (next.StartTime as number) - syllable.EndTime >= unit) {
      body += `<${stamp(syllable.EndTime, precision)}>`;
    }
  });

  // The closing tag says when the last word ends.
  const last = syllables[syllables.length - 1];
  const end = last.EndTime ?? group.EndTime;
  if (end !== undefined) body += `<${stamp(end, precision)}>`;

  return { at: first, text: `[${stamp(first, precision)}]${body}` };
}

/** Spicy Lyrics' own lyrics shape (what the TTML parser gives) as LRC text; null if there is nothing in it. */
export function lyricsToLrc(lyrics: any, precision: LrcPrecision = "centiseconds"): string | null {
  const lines: { at: number; text: string }[] = [];

  if (lyrics?.Type === "Syllable") {
    for (const vocal of lyrics.Content ?? []) {
      const lead = vocal.Lead ? enhancedLine(vocal.Lead, precision, false) : null;
      if (lead) lines.push(lead);
      for (const background of vocal.Background ?? []) {
        const line = enhancedLine(background, precision, true);
        if (line) lines.push(line);
      }
    }
  } else if (lyrics?.Type === "Line") {
    for (const line of lyrics.Content ?? []) {
      const text = String(line.Text ?? "").trim();
      if (text && typeof line.StartTime === "number") lines.push({ at: line.StartTime, text: `[${stamp(line.StartTime, precision)}]${text}` });
    }
  } else if (lyrics?.Type === "Static") {
    const plain = (lyrics.Lines ?? []).map((l: any) => String(l.Text ?? "").trim()).filter(Boolean);
    return plain.length ? plain.join("\n") : null;
  }

  if (lines.length === 0) return null;
  // Stable, so lines that start together stay in the order they were written.
  return lines
    .map((line, index) => ({ ...line, index }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map((line) => line.text)
    .join("\n");
}

export type Conversion = { ok: true; lrc: string; kind: "word" | "line" | "plain" } | { ok: false; error: string };

/** TTML text to LRC text. Never throws; a TTML it cannot read says so. */
export function convertTtml(ttml: string, precision: LrcPrecision = "centiseconds"): Conversion {
  let lyrics: any;
  try {
    lyrics = parseTTML(ttml);
  } catch {
    lyrics = null;
  }
  if (!lyrics) return { ok: false, error: "This does not look like a lyrics TTML file." };

  const lrc = lyricsToLrc(lyrics, precision);
  if (!lrc) return { ok: false, error: "There were no lyrics in it." };
  return { ok: true, lrc, kind: lyrics.Type === "Syllable" ? "word" : lyrics.Type === "Line" ? "line" : "plain" };
}
