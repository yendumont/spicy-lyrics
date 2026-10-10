import { LyricsObject } from "../lyrics.ts";

/** A sung word (its syllables joined) and when it is sung, in milliseconds. */
export type SyncWord = { text: string; start: number; end: number };

/**
 * The words of a word-synced line with their timing, read from the lyrics the page is
 * showing. Null when the line has no word timing (line-synced and unsynced lyrics).
 */
export function syncWords(lineEl: HTMLElement): SyncWord[] | null {
  const line = LyricsObject.Types.Syllable.Lines.find((l) => l.HTMLElement === lineEl);
  const lead = line?.Syllables?.Lead;
  if (!lead?.length) return null;

  const words: SyncWord[] = [];
  let word: SyncWord | null = null;
  for (const syllable of lead) {
    if (syllable.Dot || syllable.BGWord) continue;
    const text = syllable.HTMLElement.textContent ?? "";
    if (!text.trim()) continue;
    if (word) {
      word.text += text;
      word.end = syllable.EndTime;
    } else {
      word = { text, start: syllable.StartTime, end: syllable.EndTime };
    }
    if (!syllable.HTMLElement.classList.contains("PartOfWord")) {
      words.push(word);
      word = null;
    }
  }
  if (word) words.push(word);
  return words.length > 0 ? words : null;
}
