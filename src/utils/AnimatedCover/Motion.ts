import { SpotifyPlayer } from "../../components/Global/SpotifyPlayer.ts";
import { ResolveTrack } from "../Lyrics/providers/Resolve.ts";
import { getAnimatedCover } from "./AnimatedCover.ts";

/**
 * Where the playing song's moving picture comes from, for everything that shows one (the
 * animated cover and the live background): its album's animated cover from Apple Music.
 * Spotify Canvases are not handled here: Spicy Lyrics' own Canvas Stage plays those.
 */
export type MotionUse = { apple: boolean };
export type Motion = { url: string; kind: "apple" };

async function appleMotion(isCurrent: () => boolean): Promise<Motion | null> {
  const resolved = await ResolveTrack();
  if (!isCurrent()) return null;
  // The song as it is, then (for a video song) the audio track it belongs to, whose album is the one Apple has.
  for (const reading of [resolved.readings[0], resolved.twin]) {
    if (!reading?.album || !reading.artist) continue;
    const url = await getAnimatedCover(reading.artist, reading.album, reading.name);
    if (!isCurrent()) return null;
    if (url) return { url, kind: "apple" };
  }
  return null;
}

/** `isCurrent` says whether the answer is still wanted (the song may change while it is made). */
export async function getMotion(use: MotionUse, isCurrent: () => boolean): Promise<Motion | null> {
  if (!use.apple) return null;
  const found = await appleMotion(isCurrent);
  return isCurrent() ? found : null;
}

/** Every video currently on screen, so they can all be paused together. */
const showing = new Set<HTMLVideoElement>();

/**
 * A silent looping video that fades in once it can play. Remove it with `dropVideo`. Where the
 * video and its box differ in shape, `object-fit: cover` in the stylesheet crops it to fill.
 */
export function loopVideo(doc: Document, className: string, motion: Motion): HTMLVideoElement {
  const video = doc.createElement("video");
  video.className = className;
  video.dataset.kind = motion.kind;
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.disablePictureInPicture = true;
  video.src = motion.url;
  video.addEventListener(
    "canplay",
    () => {
      if (!showing.has(video)) return;
      video.classList.add("Ready");
      if (SpotifyPlayer.IsPlaying && !document.hidden) void video.play().catch(() => undefined);
    },
    { once: true }
  );
  showing.add(video);
  return video;
}

export function dropVideo(video: HTMLVideoElement): void {
  showing.delete(video);
  video.pause();
  video.removeAttribute("src");
  video.remove();
}

/** A video that is not being looked at, or that has nothing playing behind it, should not be running. */
export function pauseOrResumeAll(): void {
  const stop = document.hidden || !Spicetify.Player.isPlaying();
  for (const video of showing) {
    if (!video.classList.contains("Ready")) continue;
    if (stop) video.pause();
    else void video.play().catch(() => undefined);
  }
}
