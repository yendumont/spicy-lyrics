import { isDev } from "../../../components/Global/Defaults.ts";
import { SpotifyPlayer } from "../../../components/Global/SpotifyPlayer.ts";
import { GetExpireStore } from "../../../modules/Store.ts";
import Logger from "../../Logger.ts";
import { $lyricsProvider, $lyricsProviderOrder, $lyricsProviderPicks, $lyricsProvidersDisabled } from "../../stores.ts";
import { FetchFromProvider } from "./index.ts";
import { $lookupReport, BeginReport, PayloadFor, RecordOutcome, RecordResult } from "./LookupReport.ts";
import { resolveOrder } from "./ProviderOrder.ts";
import { FetchSpicyFor } from "./SpicyApi.ts";
import type { ExternalProviderId, LyricsProviderId } from "./types.ts";

const logger = new Logger("Lyrics Sources");

/**
 * Lyrics of songs the listener pinned to one source. Its own store, so none of the
 * clear-cache buttons (which empty the main lyrics cache) touch it; only
 * ClearPick does.
 */
export const PickStore = GetExpireStore<any>("SpicyLyrics_PickedLyrics_g1", 1, {
  Unit: "Days",
  Duration: 30,
}, isDev as true);

export const PickKey = (uri: string): string => {
  let h = 5381;
  for (let i = 0; i < uri.length; i++) h = ((h << 5) + h + uri.charCodeAt(i)) | 0;
  return `pick-${(h >>> 0).toString(36)}`;
};

/** The pinned source for a song, if any. */
export function PickFor(uri: string | null | undefined): LyricsProviderId | undefined {
  const id = uri ? $lyricsProviderPicks.get()[uri] : undefined;
  return id as LyricsProviderId | undefined;
}

/** Remember the pin, keeping the list to the most recent 300 songs. */
export function SetPick(uri: string, id: LyricsProviderId): void {
  const next = { ...$lyricsProviderPicks.get() };
  delete next[uri];
  next[uri] = id;
  const keys = Object.keys(next);
  for (const old of keys.slice(0, Math.max(0, keys.length - 300))) delete next[old];
  $lyricsProviderPicks.set(next);
}

export async function RemovePick(uri: string): Promise<void> {
  const next = { ...$lyricsProviderPicks.get() };
  delete next[uri];
  $lyricsProviderPicks.set(next);
  try {
    await PickStore.RemoveItem(PickKey(uri));
  } catch (error) {
    logger.warn("Could not remove the pinned lyrics", error);
  }
}

/** One source's lyrics for the playing song: from this session's lookups if it has them, else asked afresh. */
export async function FetchFromSource(
  uri: string,
  id: LyricsProviderId,
  isStale: () => boolean = () => false,
  fresh = false
): Promise<any | null> {
  const known = fresh ? undefined : PayloadFor(uri, id);
  if (known) return structuredClone(known);
  return id === "spicy" ? FetchSpicyFor(uri, isStale) : FetchFromProvider(id as ExternalProviderId);
}

/** Ask every source that is switched on about the playing song and record each answer. */
export async function CheckAllSources(): Promise<void> {
  const uri = SpotifyPlayer.GetUri();
  if (!uri) return;
  BeginReport(uri);

  const order = resolveOrder($lyricsProviderOrder.get(), $lyricsProvider.get());
  const disabled = $lyricsProvidersDisabled.get();
  const ids = order.filter((id) => !disabled.includes(id));
  const isStale = () => SpotifyPlayer.GetUri() !== uri;

  for (const id of ids) RecordOutcome(uri, id, { state: "searching" });
  await Promise.all(
    ids.map(async (id) => {
      try {
        const lyrics = await FetchFromSource(uri, id, isStale, true);
        RecordResult(uri, id, lyrics);
      } catch (error) {
        logger.warn(`${id} lookup failed`, error);
        RecordOutcome(uri, id, { state: "error" });
      }
    })
  );
}

export { $lookupReport };
