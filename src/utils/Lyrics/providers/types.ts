export type ExternalProviderId =
  | "lrclib"
  | "unison"
  | "netease"
  | "qqmusic"
  | "genius"
  | "lrcmux"
  | "lrcred"
  | "kugou"
  | "deezer"
  | "musixmatch"
  | "amll"
  | "ytmusic"
  | "kuwo"
  | "binilyrics";
export type LyricsProviderId = "spicy" | ExternalProviderId;

/** What the external providers look a track up by. Duration is in milliseconds. */
export type TrackInfo = {
  name: string;
  artist: string;
  /** Every credited artist, `artist` first. Absent when only the first is known. */
  artists?: string[];
  album: string;
  /** The Spotify track id, when the song is in Spotify's catalogue (not local files or episodes). */
  spotifyId?: string;
  /** https URL of the cover art, when the player has one. */
  coverUrl?: string;
  durationMs: number;
};
