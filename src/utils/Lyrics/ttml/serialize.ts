import type { ParsedTTMLLyrics, ParsedVocalGroup } from "./parser.ts";

/**
 * Lyrics as Spicy holds them (Static / Line / Syllable) written back out as TTML, in the
 * Apple Music dialect `parser.ts` reads: word timing in `<span>`s, background vocals in a
 * `ttm:role="x-bg"` span, and a second agent (v2) for the opposite-aligned singer.
 * Round-trips through `parseTTML`, and opens in AMLL tools and other TTML editors.
 */

const esc = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Seconds as TTML clock time, `m:ss.mmm` (or `h:mm:ss.mmm` past an hour). */
function clock(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const frac = String(ms % 1000).padStart(3, "0");
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${frac}`
    : `${m}:${String(s).padStart(2, "0")}.${frac}`;
}

const attrs = (pairs: Record<string, string | undefined>): string =>
  Object.entries(pairs)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => ` ${name}="${esc(value as string)}"`)
    .join("");

/** One vocal's words as timed spans; a space between two spans wherever a word ends. */
function spans(group: ParsedVocalGroup): string {
  const out: string[] = [];
  group.Syllables.forEach((syllable, i) => {
    out.push(
      `<span${attrs({ begin: clock(syllable.StartTime), end: clock(syllable.EndTime) })}>${esc(syllable.Text.trim())}</span>`
    );
    if (!syllable.IsPartOfWord && i < group.Syllables.length - 1) out.push(" ");
  });
  return out.join("");
}

export type TtmlInfo = { songwriters?: string[]; language?: string };

/** TTML text for `lyrics`, or null when there is nothing to write. */
export function serializeTTML(lyrics: ParsedTTMLLyrics, info: TtmlInfo = {}): string | null {
  const rows: string[] = [];
  let last = 0;
  let usesSecondAgent = false;
  const timing = lyrics.Type === "Syllable" ? "Word" : lyrics.Type === "Line" ? "Line" : "None";

  if (lyrics.Type === "Static") {
    lyrics.Lines.forEach((line, i) => {
      if (!line.Text) return;
      rows.push(`<p${attrs({ "ttm:agent": "v1", "itunes:key": `L${i + 1}` })}>${esc(line.Text)}</p>`);
    });
  } else if (lyrics.Type === "Line") {
    lyrics.Content.forEach((line, i) => {
      if (!line.Text) return;
      if (line.OppositeAligned) usesSecondAgent = true;
      last = Math.max(last, line.EndTime ?? 0);
      rows.push(
        `<p${attrs({
          begin: clock(line.StartTime),
          end: clock(line.EndTime),
          "ttm:agent": line.OppositeAligned ? "v2" : "v1",
          "itunes:key": `L${i + 1}`,
        })}>${esc(line.Text)}</p>`
      );
    });
  } else {
    lyrics.Content.forEach((vocal, i) => {
      if (!vocal.Lead.Syllables.length) return;
      if (vocal.OppositeAligned) usesSecondAgent = true;
      last = Math.max(last, vocal.Lead.EndTime ?? 0);
      const background = (vocal.Background ?? [])
        .filter((group) => group.Syllables.length)
        .map((group) => `<span ttm:role="x-bg"${attrs({ begin: clock(group.StartTime), end: clock(group.EndTime) })}>${spans(group)}</span>`)
        .join("");
      rows.push(
        `<p${attrs({
          begin: clock(vocal.Lead.StartTime),
          end: clock(vocal.Lead.EndTime),
          "ttm:agent": vocal.OppositeAligned ? "v2" : "v1",
          "itunes:key": `L${i + 1}`,
        })}>${spans(vocal.Lead)}${background}</p>`
      );
    });
  }

  if (!rows.length) return null;

  const writers = (info.songwriters ?? lyrics.SongWriters ?? []).filter(Boolean);
  const agents = `<ttm:agent type="person" xml:id="v1"/>${usesSecondAgent ? '<ttm:agent type="person" xml:id="v2"/>' : ""}`;
  const meta = writers.length
    ? `<iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal"><songwriters>${writers
        .map((name) => `<songwriter>${esc(name)}</songwriter>`)
        .join("")}</songwriters></iTunesMetadata>`
    : "";
  const divAttrs = timing === "None" ? "" : attrs({ begin: clock(0), end: clock(last) });

  return [
    `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" itunes:timing="${timing}" xml:lang="${esc(info.language ?? "en")}">`,
    `<head><metadata>${agents}${meta}</metadata></head>`,
    `<body${timing === "None" ? "" : attrs({ dur: clock(last) })}><div${divAttrs}>`,
    ...rows,
    "</div></body></tt>",
  ].join("\n");
}
