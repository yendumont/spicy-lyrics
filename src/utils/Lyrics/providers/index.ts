import { COVER_PLACEHOLDER_URL, SpotifyPlayer } from "../../../components/Global/SpotifyPlayer.ts";
import Logger from "../../Logger.ts";
import {
  $geniusEagerMatch,
  $geniusFavoriteArtists,
  $geniusLooseSearch,
  $geniusProxyUrl,
  $lyricsProvider,
  $lyricsProviderFallback,
  $lrcRedWordSync,
  $lyricsProviderOrder,
  $lyricsProvidersDisabled,
} from "../../stores.ts";
import { isExperimentEnabled } from "../../experiments.ts";
import { toImageUrl } from "./CoverMatch.ts";
import { unlistedCandidates, unlistedTitles } from "./Unlisted.ts";
import { RecordOutcome, RecordResult } from "./LookupReport.ts";
import { fetchFromGenius } from "./Genius.ts";
import { fetchFromLrcLib } from "./LrcLib.ts";
import { fetchFromLrcMux } from "./LrcMux.ts";
import { fetchFromLrcRed } from "./LrcRed.ts";
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
  lrcred: (track) => fetchFromLrcRed(track, $lrcRedWordSync.get()),
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
        .filter(Boolean),
      $geniusEagerMatch.get()
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

/**
 * Local files and podcast episodes: not songs in Spotify's catalogue, so Spicy's own
 * API cannot serve them. Only handled while the experiment is on.
 */
export function IsUnlistedItem(uri: string | undefined): boolean {
  if (!isExperimentEnabled("unlistedLyrics")) return false;
  return !!uri?.startsWith("spotify:local:") || SpotifyPlayer.GetContentType() === "episode";
}

/** The readings of the playing local file or episode, for matching it against the catalogue. */
export function GetUnlistedGuesses(): TrackInfo[] {
  return GetCurrentTrackInfos();
}

/** The playing item's possible titles, for a match on title and length alone. */
export function GetUnlistedTitles(): { titles: string[]; durationMs: number } {
  const durationMs = SpotifyPlayer.GetDuration();
  const name = SpotifyPlayer.GetName();
  if (!name) return { titles: [], durationMs };
  return {
    titles: unlistedTitles({
      name,
      artists: [],
      album: "",
      durationMs,
    }),
    durationMs,
  };
}

/** What to look the playing item up as: one reading for a song, several guesses for an unlisted item. */
function GetCurrentTrackInfos(): TrackInfo[] {
  const name = SpotifyPlayer.GetName();
  if (!name) return [];

  const uri = Spicetify?.Player?.data?.item?.uri;
  if (IsUnlistedItem(uri)) {
    return unlistedCandidates({
      name,
      artists: (SpotifyPlayer.GetArtists() ?? []).map((a) => a.name).filter(Boolean),
      album: SpotifyPlayer.GetAlbumName() ?? "",
      showName: SpotifyPlayer.GetShowName(),
      durationMs: SpotifyPlayer.GetDuration(),
    });
  }

  const artist = SpotifyPlayer.GetArtists()?.[0]?.name;
  if (!artist) return [];
  return [
    {
      name,
      artist,
      artists: (SpotifyPlayer.GetArtists() ?? []).map((a) => a.name).filter(Boolean),
      album: SpotifyPlayer.GetAlbumName() ?? "",
      coverUrl: GetCoverUrl(),
      durationMs: SpotifyPlayer.GetDuration(),
    },
  ];
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

/** One provider's best answer for the playing song (its guesses tried in turn), or null. */
export async function FetchFromProvider(id: ExternalProviderId): Promise<any | null> {
  let best: any | null = null;
  for (const track of GetCurrentTrackInfos()) {
    const lyrics = await fetchers[id](track);
    if (SyncRank(lyrics) > SyncRank(best)) best = lyrics;
    if (SyncRank(best) >= BEST_SYNC_RANK) break;
  }
  return best;
}

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

  const tracks = GetCurrentTrackInfos();
  if (tracks.length === 0) return null;

  let best: any | null = null;
  let bestRank = floor;

  const uri = SpotifyPlayer.GetUri();

  for (const id of providers) {
    if (isStale()) return null;
    if ((MAX_RANK[id] ?? BEST_SYNC_RANK) <= bestRank) continue;
    let returned: any | null = null;
    let failed = false;
    // A song has one reading; a local file or episode has several guesses, tried in turn.
    for (const track of tracks) {
      if (isStale()) return null;
      try {
        const lyrics = await fetchers[id](track);
        if (SyncRank(lyrics) > SyncRank(returned)) returned = lyrics;
        if (returned && SyncRank(returned) > bestRank) break;
      } catch (error) {
        failed = true;
        logger.warn(`${PROVIDER_LABELS[id]} lookup failed`, error);
      }
    }
    if (uri) {
      if (returned) RecordResult(uri, id, returned);
      else RecordOutcome(uri, id, { state: failed ? "error" : "notfound" });
    }
    const rank = SyncRank(returned);
    if (rank > bestRank) {
      best = returned;
      bestRank = rank;
      if (!preferBestSync || rank >= BEST_SYNC_RANK) return best;
    }
  }
  return best;
}
