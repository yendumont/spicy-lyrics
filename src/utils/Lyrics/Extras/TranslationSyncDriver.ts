/**
 * Moves the lit part of word-synced translations along with the singing. Kept free of
 * imports so the lyrics animator can call it every frame without pulling the translation
 * code (and its settings) into its own import chain.
 */

type TimedChunk = { el: HTMLElement; start: number; end: number };
type Entry = {
  /** The line's span; before it the chunks are all unlit, after it all lit. */
  start: number;
  end: number;
  chunks: TimedChunk[];
  state: "before" | "active" | "after" | null;
};

let entries: Entry[] = [];

/** Replace what is driven. Pass an empty list to stop. */
export function setSyncedTranslations(next: { start: number; end: number; chunks: TimedChunk[] }[]): void {
  entries = next.map((entry) => ({ ...entry, state: null }));
}

const lit = (el: HTMLElement, progress: number) => {
  const value = progress.toFixed(3);
  if (el.dataset.trp !== value) {
    el.dataset.trp = value;
    el.style.setProperty("--TrP", value);
  }
};

/** Called each animation frame with the lyrics position in milliseconds. */
export function driveSyncedTranslations(position: number): void {
  for (const entry of entries) {
    if (position < entry.start) {
      if (entry.state === "before") continue;
      entry.state = "before";
      for (const chunk of entry.chunks) lit(chunk.el, 0);
    } else if (position > entry.end) {
      if (entry.state === "after") continue;
      entry.state = "after";
      for (const chunk of entry.chunks) lit(chunk.el, 1);
    } else {
      entry.state = "active";
      for (const chunk of entry.chunks) {
        const span = chunk.end - chunk.start;
        lit(chunk.el, span <= 0 ? (position >= chunk.start ? 1 : 0) : Math.min(1, Math.max(0, (position - chunk.start) / span)));
      }
    }
  }
}
