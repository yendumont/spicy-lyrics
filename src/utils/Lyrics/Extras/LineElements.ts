import { PageContainer } from "../../../components/Pages/PageView.ts";
import { LyricsObject } from "../lyrics.ts";

/**
 * The lyrics lines on screen, for features that add something to each (line meanings,
 * translations). Everything this adds to a line carries `data-sl-extra`, so a line's
 * own text can still be read back without it.
 */
export type AppliedLine = {
  el: HTMLElement;
  /** The line as sung, without anything added by these features. */
  text: string;
};

export const EXTRA_ATTRIBUTE = "data-sl-extra";

/**
 * The text of a line element, ignoring what the extras added to it. Word-synced lines hold
 * one element per word with no spaces between them, so the words are joined here: a space
 * after each, except after a syllable that is part of a longer word.
 */
export function lineText(el: HTMLElement): string {
  const words = Array.from(el.querySelectorAll<HTMLElement>(".word:not(.dot)")).filter(
    (word) => !word.closest(`[${EXTRA_ATTRIBUTE}]`)
  );
  if (words.length > 0) {
    return words
      .map((word) => (word.textContent ?? "") + (word.classList.contains("PartOfWord") ? "" : " "))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
  }

  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(`[${EXTRA_ATTRIBUTE}]`).forEach((node) => node.remove());
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** The type of the lyrics now applied ("Syllable", "Line" or "Static"), if any. */
export function appliedType(): "Syllable" | "Line" | "Static" | null {
  const type = PageContainer?.querySelector<HTMLElement>(".LyricsContainer [data-lyrics-type]")?.getAttribute(
    "data-lyrics-type"
  );
  return type === "Syllable" || type === "Line" || type === "Static" ? type : null;
}

/** The sung lines, in order: no interlude dots, no backing-vocal lines. */
export function appliedLines(type: "Syllable" | "Line" | "Static" | null = appliedType()): AppliedLine[] {
  if (!type) return [];
  const lines: { HTMLElement: HTMLElement; DotLine?: boolean; BGLine?: boolean }[] =
    LyricsObject.Types[type].Lines;

  return lines
    .filter((line) => line.HTMLElement && !line.DotLine && !line.BGLine)
    .map((line) => ({ el: line.HTMLElement, text: lineText(line.HTMLElement) }))
    .filter((line) => line.text !== "");
}

/**
 * Everything the extras have added, by kind. The list keeps nodes that are not on the page:
 * the lyrics list only keeps the lines in view mounted, so a line scrolled out of view holds
 * its translation or button in a detached element, which a search of the page would miss
 * and which would come back when the line did.
 */
const added = new Map<string, Set<{ node: HTMLElement; line?: HTMLElement }>>();

/** Add `node` to `line` and remember it under `kind`. */
export function addExtra(kind: string, line: HTMLElement, node: HTMLElement): void {
  node.setAttribute(EXTRA_ATTRIBUTE, kind);
  line.appendChild(node);
  const list = added.get(kind) ?? new Set();
  list.add({ node, line });
  added.set(kind, list);
}

/** Take everything an extra added off the lyrics lines, mounted or not. */
export function clearExtras(kind: string, markerClass?: string): void {
  for (const { node, line } of added.get(kind) ?? []) {
    node.remove();
    if (markerClass) line?.classList.remove(markerClass);
  }
  added.delete(kind);
  // Anything from before this list existed (or from another page instance).
  PageContainer?.querySelectorAll(`[${EXTRA_ATTRIBUTE}="${kind}"]`).forEach((node) => node.remove());
}
export { flatten } from "./MeaningsCore.ts";
