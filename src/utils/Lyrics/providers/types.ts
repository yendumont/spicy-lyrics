// The provider ids come from the registry, so a provider added there is known everywhere.
export type { ExternalProviderId, LyricsProviderId } from "./registry.ts";

/**
 * What the external providers look a track up by. Duration is in milliseconds. For a local
 * file or episode this is its catalogue entry when it has one, else a reading of its title.
 */
export type TrackInfo = {
  name: string;
  artist: string;
  /** Every credited artist, `artist` first. Absent when only the first is known. */
  artists?: string[];
  album: string;
  /** The Spotify track id, when the song is in Spotify's catalogue. */
  spotifyId?: string;
  /** https URL of the cover art, when the player has one. */
  coverUrl?: string;
  durationMs: number;
};
