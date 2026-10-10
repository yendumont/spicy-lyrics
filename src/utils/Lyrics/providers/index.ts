import { SpotifyPlayer } from "../../../components/Global/SpotifyPlayer.ts";
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
  $musixmatchToken,
} from "../../stores.ts";
import { ResolveTrack } from "./Resolve.ts";
import { RecordOutcome, RecordResult } from "./LookupReport.ts";
import { fetchFromGenius } from "./Genius.ts";
import { fetchFromAmllTtmlDb } from "./AmllTtmlDb.ts";
import { fetchFromBiniLyrics } from "./BiniLyrics.ts";
import { fetchFromKuwo } from "./Kuwo.ts";
import { fetchFromYouTubeMusic } from "./YouTubeMusic.ts";
import { fetchFromDeezer } from "./Deezer.ts";
import { fetchFromKugou } from "./Kugou.ts";
import { fetchFromMusixmatch } from "./Musixmatch.ts";
import { fetchFromLrcLib } from "./LrcLib.ts";
import { fetchFromLrcMux } from "./LrcMux.ts";
import { fetchFromLrcRed } from "./LrcRed.ts";
import { fetchFromNetEase } from "./NetEase.ts";
import { fetchFromQQMusic } from "./QQMusic.ts";
import { fetchFromUnison } from "./Unison.ts";
import { PROVIDER_LABELS, activeProviders, resolveOrder } from "./ProviderOrder.ts";
import { maxRankOf } from "./registry.ts";
import type { ExternalProviderId, LyricsProviderId, TrackInfo } from "./types.ts";

export type { ExternalProviderId, LyricsProviderId } from "./types.ts";
export { DEFAULT_ORDER, PROVIDER_LABELS, activeProviders, resolveOrder } from "./ProviderOrder.ts";
export { IsUnlistedItem, ResolveTrack, spicyIdForVideoSong, spotifyIdOf } from "./Resolve.ts";

const logger = new Logger("Lyrics Providers");

const asWordSync = (value: string): "hand" | "all" | "off" => (value === "all" || value === "off" ? value : "hand");

const fetchers: Record<ExternalProviderId, (track: TrackInfo) => Promise<any | null>> = {
  lrclib: fetchFromLrcLib,
  lrcmux: fetchFromLrcMux,
  lrcred: (track) => fetchFromLrcRed(track, $lrcRedWordSync.get()),
  netease: fetchFromNetEase,
  qqmusic: fetchFromQQMusic,
  kugou: fetchFromKugou,
  deezer: fetchFromDeezer,
  amll: fetchFromAmllTtmlDb,
  kuwo: fetchFromKuwo,
  binilyrics: (track) => fetchFromBiniLyrics(track, asWordSync($lrcRedWordSync.get())),
  // Goes through the listener's own Worker (see YouTubeMusic.ts); with none set it finds nothing.
  ytmusic: (track) => fetchFromYouTubeMusic(track, $geniusProxyUrl.get()),
  // Needs the listener's own token (see Musixmatch.ts); with none it finds nothing.
  musixmatch: (track) => fetchFromMusixmatch(track, $musixmatchToken.get()),
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
  for (const track of (await ResolveTrack()).readings) {
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

  const tracks = (await ResolveTrack(isStale)).readings;
  if (tracks.length === 0) return null;

  let best: any | null = null;
  let bestRank = floor;

  const uri = SpotifyPlayer.GetUri();

  for (const id of providers) {
    if (isStale()) return null;
    if (maxRankOf(id) <= bestRank) continue;
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
