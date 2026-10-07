import type { LyricsProviderId } from "./types.ts";

/**
 * The built-in priority. Genius is last: it only has unsynced text, so with fallback
 * on it is a last resort.
 */
export const DEFAULT_ORDER: LyricsProviderId[] = [
  "spicy",
  "unison",
  "lrclib",
  "lrcmux",
  "netease",
  "qqmusic",
  "genius",
];

export const PROVIDER_LABELS: Record<LyricsProviderId, string> = {
  spicy: "Spicy Lyrics",
  unison: "Unison",
  lrclib: "LRCLIB",
  lrcmux: "LRCMux",
  netease: "NetEase",
  qqmusic: "QQ Music",
  genius: "Genius",
};

const isProvider = (id: string): id is LyricsProviderId => (DEFAULT_ORDER as string[]).includes(id);

/**
 * The full priority list, every provider exactly once. `saved` is what the listener
 * arranged; providers it does not mention (added since) slot in before Genius. With
 * nothing saved, the old single "Lyrics Provider" choice goes first.
 */
export function resolveOrder(saved: readonly string[], legacyPrimary?: string): LyricsProviderId[] {
  const order = saved.filter(isProvider).filter((id, i, all) => all.indexOf(id) === i);

  if (order.length === 0) {
    const primary = legacyPrimary && isProvider(legacyPrimary) ? legacyPrimary : undefined;
    return primary ? [primary, ...DEFAULT_ORDER.filter((id) => id !== primary)] : [...DEFAULT_ORDER];
  }

  for (const id of DEFAULT_ORDER) {
    if (order.includes(id)) continue;
    const genius = order.indexOf("genius");
    order.splice(id !== "genius" && genius !== -1 ? genius : order.length, 0, id);
  }
  return order;
}

/**
 * The providers to ask, in order: those the listener has not switched off. With
 * fallback off only the first of them is asked. If every provider is switched off,
 * Spicy Lyrics stays on rather than leaving the page with no source at all.
 */
export function activeProviders(
  order: readonly LyricsProviderId[],
  disabled: readonly string[],
  fallback: boolean
): LyricsProviderId[] {
  const enabled = order.filter((id) => !disabled.includes(id));
  if (enabled.length === 0) return ["spicy"];
  return fallback ? enabled : [enabled[0]];
}
