import { SpotifyPlayer } from "../../../components/Global/SpotifyPlayer.ts";
import Logger from "../../Logger.ts";
import { $lyricsProvider, $lyricsProviderFallback } from "../../stores.ts";
import { fetchFromLrcLib } from "./LrcLib.ts";
import { fetchFromNetEase } from "./NetEase.ts";
import { fetchFromQQMusic } from "./QQMusic.ts";
import { fetchFromUnison } from "./Unison.ts";
import type { ExternalProviderId, LyricsProviderId, TrackInfo } from "./types.ts";

export type { ExternalProviderId, LyricsProviderId } from "./types.ts";

const logger = new Logger("Lyrics Providers");

export const PROVIDER_LABELS: Record<LyricsProviderId, string> = {
  spicy: "Spicy Lyrics",
  unison: "Unison",
  lrclib: "LRCLIB",
  netease: "NetEase",
  qqmusic: "QQ Music",
};

const DEFAULT_ORDER: LyricsProviderId[] = ["spicy", "unison", "lrclib", "netease", "qqmusic"];

const fetchers: Record<ExternalProviderId, (track: TrackInfo) => Promise<any | null>> = {
  lrclib: fetchFromLrcLib,
  netease: fetchFromNetEase,
  qqmusic: fetchFromQQMusic,
  unison: fetchFromUnison,
};

/**
 * The providers to try, in order. The chosen provider comes first; with fallback
 * on, the rest follow in the default order. Spicy Lyrics is always in the list
 * so the main API path keeps its place in the sequence.
 */
export function GetProviderOrder(): LyricsProviderId[] {
  const primary = $lyricsProvider.get() as LyricsProviderId;
  if (!DEFAULT_ORDER.includes(primary)) return DEFAULT_ORDER;
  if (!$lyricsProviderFallback.get()) return [primary];
  return [primary, ...DEFAULT_ORDER.filter((id) => id !== primary)];
}

function GetCurrentTrackInfo(): TrackInfo | null {
  const name = SpotifyPlayer.GetName();
  const artist = SpotifyPlayer.GetArtists()?.[0]?.name;
  if (!name || !artist) return null;
  return {
    name,
    artist,
    album: SpotifyPlayer.GetAlbumName() ?? "",
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
