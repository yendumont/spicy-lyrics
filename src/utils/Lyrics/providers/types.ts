export type ExternalProviderId = "lrclib" | "unison" | "netease" | "qqmusic";
export type LyricsProviderId = "spicy" | ExternalProviderId;

/** What the external providers look a track up by. Duration is in milliseconds. */
export type TrackInfo = {
  name: string;
  artist: string;
  album: string;
  durationMs: number;
};
