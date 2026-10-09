import { COVER_PLACEHOLDER_URL, SpotifyPlayer } from "../../../components/Global/SpotifyPlayer.ts";
import { isExperimentEnabled } from "../../experiments.ts";
import { toImageUrl } from "./CoverMatch.ts";
import { findSpotifyTrack, type CatalogueMatch } from "./SpotifySearch.ts";
import type { TrackInfo } from "./types.ts";
import { unlistedCandidates, unlistedTitles } from "./Unlisted.ts";

/**
 * Who the playing item is, worked out once and shared by every lyrics source (Spicy
 * Lyrics' own API included), so each one gets the same help. For a catalogue song that
 * is just the song. A local file or podcast episode is first matched against Spotify's
 * catalogue; when it matches, the first reading is the catalogue entry itself, with its
 * true title, artists, length, cover and Spotify id, which suits every provider far
 * better than a guess made from a file name. The guesses follow, for providers that
 * know the song under another name.
 */
export type ResolvedTrack = {
  /** What to look the item up as, best first. */
  readings: TrackInfo[];
  /** The catalogue entry a local file or episode matched, if any. */
  catalogue: CatalogueMatch | null;
};

/**
 * Local files and podcast episodes: not songs in Spotify's catalogue, so Spicy's own
 * API cannot serve them as they are. Only handled while the experiment is on.
 */
export function IsUnlistedItem(uri: string | undefined): boolean {
  if (!isExperimentEnabled("unlistedLyrics")) return false;
  return !!uri?.startsWith("spotify:local:") || SpotifyPlayer.GetContentType() === "episode";
}

/** The playing item's cover as an https URL, or undefined when it only has the placeholder. */
function currentCoverUrl(): string | undefined {
  const cover = SpotifyPlayer.GetCover("standard");
  return cover && cover !== COVER_PLACEHOLDER_URL ? toImageUrl(cover) : undefined;
}

// The last few songs, so asking again (every provider does) costs nothing.
const MEMORY = 6;
const memory = new Map<string, Promise<ResolvedTrack>>();

async function resolve(uri: string | undefined, isStale: () => boolean): Promise<ResolvedTrack> {
  const name = SpotifyPlayer.GetName();
  if (!name) return { readings: [], catalogue: null };

  const artists = (SpotifyPlayer.GetArtists() ?? []).map((a) => a.name).filter(Boolean);
  const durationMs = SpotifyPlayer.GetDuration();

  if (!IsUnlistedItem(uri)) {
    if (artists.length === 0) return { readings: [], catalogue: null };
    return {
      catalogue: null,
      readings: [
        {
          name,
          artist: artists[0],
          artists,
          album: SpotifyPlayer.GetAlbumName() ?? "",
          spotifyId: SpotifyPlayer.GetId(),
          coverUrl: currentCoverUrl(),
          durationMs,
        },
      ],
    };
  }

  const raw = {
    name,
    artists,
    album: SpotifyPlayer.GetAlbumName() ?? "",
    showName: SpotifyPlayer.GetShowName(),
    durationMs,
  };
  const guesses = unlistedCandidates(raw);
  const catalogue = await findSpotifyTrack(guesses, isStale, {
    titles: unlistedTitles(raw),
    durationMs,
  });

  // A match is the very song, under the names every provider files it by, so it is all
  // they are asked about. Without one, each guess is tried in turn.
  if (catalogue) {
    return {
      catalogue,
      readings: [
        {
          name: catalogue.title,
          artist: catalogue.artists[0] ?? guesses[0]?.artist ?? "",
          artists: catalogue.artists.length > 0 ? catalogue.artists : undefined,
          album: catalogue.album,
          spotifyId: catalogue.id,
          coverUrl: catalogue.coverUrl,
          durationMs: catalogue.durationMs,
        },
      ],
    };
  }
  return { readings: guesses, catalogue: null };
}

/** Resolve the playing item (see ResolvedTrack). Safe to call from every provider. */
export function ResolveTrack(isStale: () => boolean = () => false): Promise<ResolvedTrack> {
  const uri = Spicetify?.Player?.data?.item?.uri as string | undefined;

  // A catalogue song costs nothing to read; only a file's catalogue search is worth remembering.
  if (!IsUnlistedItem(uri)) return resolve(uri, isStale);

  const key = uri ?? "";
  const known = memory.get(key);
  if (known) return known;

  const pending = resolve(uri, isStale);
  memory.set(key, pending);
  while (memory.size > MEMORY) memory.delete(memory.keys().next().value as string);

  // A lookup cut short because the song changed, or that found nothing to go on, says
  // little about the song; do not keep it.
  void pending.then(
    (result) => {
      if (result.readings.length === 0 || (isStale() && !result.catalogue)) memory.delete(key);
    },
    () => memory.delete(key)
  );
  return pending;
}

/** The Spotify id of the playing item: its own, or the catalogue entry a file matched. */
export const spotifyIdOf = (resolved: ResolvedTrack): string | undefined =>
  resolved.readings.find((r) => r.spotifyId)?.spotifyId;
