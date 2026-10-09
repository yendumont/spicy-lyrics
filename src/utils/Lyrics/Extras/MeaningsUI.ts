import { PageContainer } from "../../../components/Pages/PageView.ts";
import { EXTRA_ATTRIBUTE, clearExtras, type AppliedLine } from "./LineElements.ts";
import type { Meaning } from "./Meanings.ts";

const CARD_ID = "SpicyLyricsMeaningCard";

const BADGES: Record<Meaning["level"], string> = {
  artist: "From the artist",
  editor: "Reviewed by Genius editors",
  community: "Community suggestion, not reviewed",
};

let closeCard: (() => void) | null = null;

export function closeMeaningCard(): void {
  closeCard?.();
  closeCard = null;
}

function paragraphs(text: string): HTMLElement[] {
  return text
    .split(/\n{1,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const p = document.createElement("p");
      p.textContent = part;
      return p;
    });
}

function section(meaning: Meaning): HTMLElement {
  const el = document.createElement("section");
  el.className = `MeaningEntry MeaningEntry--${meaning.level}`;

  const quote = document.createElement("blockquote");
  quote.textContent = meaning.fragment.replace(/\s*\n\s*/g, " / ");
  el.appendChild(quote);

  const badge = document.createElement("div");
  badge.className = "MeaningBadge";
  badge.textContent = BADGES[meaning.level] + (meaning.level === "artist" && meaning.author ? `: ${meaning.author}` : "");
  el.appendChild(badge);

  const body = document.createElement("div");
  body.className = "MeaningBody";
  paragraphs(meaning.text).forEach((p) => body.appendChild(p));
  el.appendChild(body);

  if (meaning.url) {
    const link = document.createElement("a");
    link.className = "MeaningLink";
    link.textContent = meaning.votes > 0 ? `Open on Genius · ${meaning.votes} votes` : "Open on Genius";
    link.href = meaning.url;
    link.addEventListener("click", (e) => {
      e.preventDefault();
      window.open(meaning.url, "_blank");
    });
    el.appendChild(link);
  }
  return el;
}

/** Show the meanings in a card beside the button that was pressed. */
function openMeaningCard(anchor: HTMLElement, meanings: Meaning[]): void {
  closeMeaningCard();

  const card = document.createElement("div");
  card.id = CARD_ID;
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Line meaning");
  meanings.forEach((meaning) => card.appendChild(section(meaning)));
  // On the document, not inside the lyrics: lyrics lines move and clip their children.
  document.body.appendChild(card);

  const place = () => {
    const a = anchor.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    const margin = 12;
    let top = a.bottom + 8;
    if (top + c.height > window.innerHeight - margin) top = Math.max(margin, a.top - c.height - 8);
    let left = a.left + a.width / 2 - c.width / 2;
    left = Math.min(Math.max(margin, left), window.innerWidth - c.width - margin);
    card.style.top = `${top}px`;
    card.style.left = `${left}px`;
  };
  place();

  // The lyrics scroll by themselves as the song plays, so the card follows its line rather
  // than closing on the first scroll. Once the line is off the screen (or unmounted by the
  // list) the card stays where it was, to be read, until it is dismissed or the lyrics change.
  let frame = 0;
  const follow = () => {
    const a = anchor.getBoundingClientRect();
    if (!anchor.isConnected || a.width === 0 || a.bottom < 0 || a.top > window.innerHeight) return;
    place();
    frame = requestAnimationFrame(follow);
  };
  frame = requestAnimationFrame(follow);

  const onPointerDown = (e: PointerEvent) => {
    if (!card.contains(e.target as Node) && !anchor.contains(e.target as Node)) closeMeaningCard();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeMeaningCard();
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKey, true);

  closeCard = () => {
    cancelAnimationFrame(frame);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKey, true);
    card.remove();
  };
}

const INFO_ICON =
  '<svg viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="4.8" r="0.95" fill="currentColor"/><rect x="7.2" y="6.8" width="1.6" height="5" rx="0.8" fill="currentColor"/></svg>';

/** Mark the lines that have meanings, each with a button that opens them. */
export function decorateMeanings(lines: AppliedLine[], byLine: Map<number, Meaning[]>): void {
  // Redecorating replaces every button; a card open on one closes with it (see openMeaningCard).
  clearExtras("meaning");
  PageContainer?.querySelectorAll(".line.HasMeaning").forEach((el) => el.classList.remove("HasMeaning"));

  for (const [index, meanings] of byLine) {
    const line = lines[index];
    if (!line) continue;
    line.el.classList.add("HasMeaning");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "LineMeaningBtn";
    button.setAttribute(EXTRA_ATTRIBUTE, "meaning");
    button.setAttribute("aria-label", "What this line means");
    button.title = "What this line means";
    button.innerHTML = INFO_ICON;
    button.addEventListener("click", (e) => {
      // The line itself seeks to its start when pressed.
      e.stopPropagation();
      e.preventDefault();
      openMeaningCard(button, meanings);
    });
    line.el.appendChild(button);
  }
}

export function removeMeanings(): void {
  closeMeaningCard();
  clearExtras("meaning");
  PageContainer?.querySelectorAll(".line.HasMeaning").forEach((el) => el.classList.remove("HasMeaning"));
}
