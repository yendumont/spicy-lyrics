import { $experimentToggle, isExperimentEnabled } from "./experiments.ts";

/**
 * Whether the playing item is a song Spotify plays as a music video, and whether its video is
 * set to go in the background (see VideoSongs.ts). Kept free of player imports so the cover
 * lookup in SpotifyPlayer can use it.
 */
export const isVideoSongItem = (): boolean =>
  isExperimentEnabled("videoSongs") && Spicetify?.Player?.data?.item?.mediaType === "video";

/** A video song whose video fills the background: the cover is then the song's ordinary one. */
export const videoSongInBackground = (): boolean =>
  isVideoSongItem() && isExperimentEnabled("liveBackground") && $experimentToggle("liveBackground").get();