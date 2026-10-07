import { COVER_PLACEHOLDER_URL, SpotifyPlayer } from "../../../components/Global/SpotifyPlayer.ts";
import Logger from "../../Logger.ts";
import {
  $geniusFavoriteArtists,
  $geniusLooseSearch,
  $geniusProxyUrl,
  $lyricsProvider,
  $lyricsProviderFallback,
  $lyricsProviderOrder,
  $lyricsProvidersDisabled,
} from "../../stores.ts";
import { toImageUrl } from "./CoverMatch.ts";
import { fetchFromGenius } from "./Genius.ts";
import { fetchFromLrcLib } from "./LrcLib.ts";
import { fetchFromLrcMux } from "./LrcMux.ts";
import { fetchFromNetEase } from "./NetEase.ts";
import { fetchFromQQMusic } from "./QQMusic.ts";
import { fetchFromUnison } from "./Unison.ts";
import { PROVIDER_LABELS, activeProviders, resolveOrder } from "./ProviderOrder.ts";
import type { ExternalProviderId, LyricsProviderId, TrackInfo } from "./types.ts";

export type { ExternalProviderId, LyricsProviderId } from "./types.ts";
export { DEFAULT_ORDER, PROVIDER_LABELS, activeProviders, resolveOrder } from "./ProviderOrder.ts";

const logger = new Logger("Lyrics Providers");

const fetchers: Record<ExternalProviderId, (track: TrackInfo) => Promise<any | null>> = {
  lrclib: fetchFromLrcLib,
  lrcmux: fetchFromLrcMux,
  netease: fetchFromNetEase,
  qqmusic: fetchFromQQMusic,
  unison: fetchFromUnison,
  // Needs the user's own proxy (see Genius.ts); with none set it returns nothing.
  genius: (track) =>
    fetchFromGenius(
      track,
      $geniusProxyUrl.get(),
      $geniusLooseSearch.get(),
      $geniusFavoriteArtists
        .get()
        .split(/[,\n]/)
        .map((name) => name.trim())
        .filter(Boolean)
    ),
};

/** The best sync rank a provider can ever return. One that cannot beat what is already held is not asked. */
const MAX_RANK: Partial<Record<ExternalProviderId, number>> = {
  genius: 1,
};

/**
 * The providers to try, in the listener's priority order, minus any they switched
 * off. With fallback off only the first is asked. Spicy Lyrics takes part like the
 * others: its place in the list is where the main API call happens.
 */
export function GetProviderOrder(): LyricsProviderId[] {
  return activeProviders(
    resolveOrder($lyricsProviderOrder.get(), $lyricsProvider.get()),
    $lyricsProvidersDisabled.get(),
    $lyricsProviderFallback.get()
  );
}

/** The playing item's cover as an https URL, or undefined when it only has the placeholder. */
function GetCoverUrl(): string | undefined {
  const cover = SpotifyPlayer.GetCover("standard");
  return cover && cover !== COVER_PLACEHOLDER_URL ? toImageUrl(cover) : undefined;
}

function GetCurrentTrackInfo(): TrackInfo | null {
  const name = SpotifyPlayer.GetName();
  const artist = SpotifyPlayer.GetArtists()?.[0]?.name;
  if (!name || !artist) return null;
  return {
    name,
    artist,
    artists: (SpotifyPlayer.GetArtists() ?? []).map((a) => a.name).filter(Boolean),
    album: SpotifyPlayer.GetAlbumName() ?? "",
    coverUrl: GetCoverUrl(),
    durationMs: SpotifyPlayer.GetDuration(),
  };
}

/** How well a payload is synced: word (3) > line (2) > unsynced (1) > nothing (0). */
export function SyncRank(lyrics: any): number {
  switch (lyrics?.Type) {
    case "Syllable":
      return 3;
    case "Line":
      return 2;
    case "Static":
      return 1;
    default:
      return 0;
  }
}

export const BEST_SYNC_RANK = 3;

/**
 * Ask the external providers in turn and return a lyrics payload, or null.
 *
 * Without `preferBestSync` the first hit wins. With it, every provider is asked
 * until one returns word-synced lyrics, and the best payload seen is returned —
 * but only if it ranks strictly above `floor` (the rank of whatever the caller
 * already holds), so ties keep the earlier provider. Failures of one provider
 * never stop the next from being tried.
 */
export async function FetchFromExternalProviders(
  providers: ExternalProviderId[],
  isStale: () => boolean,
  floor = 0,
  preferBestSync = false
): Promise<any | null> {
  if (providers.length === 0) return null;

  const track = GetCurrentTrackInfo();
  if (!track) return null;

  let best: any | null = null;
  let bestRank = floor;

  for (const id of providers) {
    if (isStale()) return null;
    if ((MAX_RANK[id] ?? BEST_SYNC_RANK) <= bestRank) continue;
    try {
      const lyrics = await fetchers[id](track);
      const rank = SyncRank(lyrics);
      if (rank > bestRank) {
        best = lyrics;
        bestRank = rank;
        if (!preferBestSync || rank >= BEST_SYNC_RANK) break;
      }
    } catch (error) {
      logger.warn(`${PROVIDER_LABELS[id]} lookup failed`, error);
    }
  }
  return best;
}
