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
  /** For a video song, its audio track (whatever its length): what covers and artwork are looked up by. */
  twin?: TrackInfo;
};

/**
 * Local files and podcast episodes: not songs in Spotify's catalogue, so Spicy's own
 * API cannot serve them as they are. Only handled while the experiment is on.
 */
export function IsUnlistedItem(uri: string | undefined): boolean {
  if (!isExperimentEnabled("unlistedLyrics")) return false;
  return !!uri?.startsWith("spotify:local:") || SpotifyPlayer.GetContentType() === "episode";
}

// ── Video songs ──────────────────────────────────────────────────────────────
// A song Spotify plays as a music video is a track of its own (its own id, often a longer
// cut and a title like "Song (feat. X)"), which Spicy Lyrics' API has never heard of. Spotify
// names the ordinary audio track it belongs to in the item's `audio_association`.

/** The audio track a playing video song belongs to, if it names one. */
export function videoTwinUri(): string | undefined {
  if (!isExperimentEnabled("videoSongs") || SpotifyPlayer.GetMediaType() !== "video") return undefined;
  const meta = Spicetify?.Player?.data?.item?.metadata as Record<string, string> | undefined;
  const twin = meta?.audio_association;
  return twin?.startsWith("spotify:track:") && twin !== SpotifyPlayer.GetUri() ? twin : undefined;
}

type Twin = { id: string; info: TrackInfo };
const twins = new Map<string, Promise<Twin | null>>();

async function loadTwin(uri: string): Promise<Twin | null> {
  try {
    const gql = Spicetify.GraphQL;
    const response: any = await gql.Request((gql.Definitions as any).getTrack, { uri });
    const track = response?.data?.trackUnion;
    const artists: string[] = [...(track?.firstArtist?.items ?? []), ...(track?.otherArtists?.items ?? [])]
      .map((a: any) => a?.profile?.name)
      .filter(Boolean);
    if (!track?.id || !track?.name || artists.length === 0) return null;
    const cover: string | undefined = [...(track.albumOfTrack?.coverArt?.sources ?? [])].sort(
      (a: any, b: any) => (b?.width ?? 0) - (a?.width ?? 0)
    )[0]?.url;
    return {
      id: track.id,
      info: {
        name: track.name,
        artist: artists[0],
        artists,
        album: track.albumOfTrack?.name ?? "",
        spotifyId: track.id,
        coverUrl: cover,
        durationMs: track.duration?.totalMilliseconds ?? 0,
      },
    };
  } catch {
    return null;
  }
}

/** The audio track of the playing video song, read once per song. */
export function videoTwin(): Promise<Twin | null> {
  const uri = videoTwinUri();
  if (!uri) return Promise.resolve(null);
  let known = twins.get(uri);
  if (!known) {
    known = loadTwin(uri);
    twins.set(uri, known);
    while (twins.size > MEMORY) twins.delete(twins.keys().next().value as string);
    // A failed lookup says nothing about the song; ask again next time.
    void known.then((twin) => twin || twins.delete(uri));
  }
  return known;
}

/** Spicy's lyrics are timed to the audio track, so they only fit the video if both are about as long. */
const TWIN_MAX_DRIFT_MS = 3500;

/**
 * Which track id Spicy Lyrics' API should be asked about for the playing item: `undefined` for
 * an ordinary song (use its own id), the audio track's id for a video song that matches it in
 * length, and `null` for a video song whose audio track is too different to share its timing.
 */
export async function spicyIdForVideoSong(): Promise<string | null | undefined> {
  if (!videoTwinUri()) return undefined;
  const twin = await videoTwin();
  if (!twin) return undefined;
  const drift = Math.abs(twin.info.durationMs - SpotifyPlayer.GetDuration());
  return drift <= TWIN_MAX_DRIFT_MS ? twin.id : null;
}

const sameSong = (a: TrackInfo, b: TrackInfo): boolean =>
  a.name.trim().toLowerCase() === b.name.trim().toLowerCase() &&
  a.artist.trim().toLowerCase() === b.artist.trim().toLowerCase();

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
    const own: TrackInfo = {
      name,
      artist: artists[0],
      artists,
      album: SpotifyPlayer.GetAlbumName() ?? "",
      spotifyId: SpotifyPlayer.GetId(),
      coverUrl: currentCoverUrl(),
      durationMs,
    };
    // A video song is looked up as itself first (the video can be a different cut, with its own
    // title), then as its audio track, which providers may know it as. Timed lyrics made for
    // the audio track would run early or late against a video of another length, so that second
    // reading is only added when the two are about as long.
    const twin = await videoTwin();
    const fits = !!twin && Math.abs(twin.info.durationMs - durationMs) <= TWIN_MAX_DRIFT_MS;
    return {
      catalogue: null,
      readings: twin && fits && !sameSong(twin.info, own) ? [own, twin.info] : [own],
      twin: twin?.info,
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
