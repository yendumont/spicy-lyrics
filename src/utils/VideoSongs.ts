import Global from "../components/Global/Global.ts";
import { PageContainer } from "../components/Pages/PageView.ts";
import { $experimentToggle, onExperimentChange } from "./experiments.ts";
import { isVideoSongItem, videoSongInBackground } from "./videoSongMode.ts";
import { $isNowBarOpen } from "./uiState.ts";

/**
 * Video songs (tracks Spotify plays as a music video).
 *
 * Spotify draws the video itself, inside the Now Playing sidebar. Its pictures are protected,
 * so they cannot be copied onto a canvas or into another video (`captureStream` is refused); the
 * only way to show them elsewhere is to move Spotify's own `<video>` there. That is done here: the
 * video is lifted into the cover box of Fullscreen and the larger view while the song plays, and
 * put back when the song, the page or the sidebar goes away. Only the `<video>` moves: the
 * container around it belongs to Spotify's UI framework, which would fail if its node went missing.
 *
 * Needs Spotify's Now Playing sidebar to be open (that is where Spotify makes the video); when it
 * is not, the cover simply shows the thumbnail as before.
 */
const PLAYER_VIDEO = ".VideoPlayer__container video";
const COVER = ".ContentBox .NowBar .Header .MediaBox .MediaImageContainer";
const CONTENT = ".ContentBox";

/** Where the video is shown: in the cover, or filling the background (blurred), by the Live Video Background setting. */
export type VideoSongMode = "cover" | "background";

type Held = {
  video: HTMLVideoElement;
  /** Where it was, so it can go back. */
  home: HTMLElement;
  next: ChildNode | null;
  style: string | null;
  /** The cover box or the page content, depending on `mode`. */
  target: HTMLElement;
  mode: VideoSongMode;
};

let held: Held | null = null;

/** Where Spotify's video is showing right now (not just where it should), or null. */
export const heldMode = (): VideoSongMode | null => held?.mode ?? null;

const heldListeners = new Set<() => void>();
/** Run `cb` when the video is lifted into the page or sent home, so what else is shown there can step aside. */
export const onHeldChange = (cb: () => void): void => void heldListeners.add(cb);
const heldChanged = (): void => heldListeners.forEach((cb) => cb());

/** True for a song that is playing as a video, when the experiment is on. */
export function isVideoSong(): boolean {
  return isVideoSongItem();
}

/** Where a playing video song's video goes, or null when it is not one. */
export function videoSongMode(): VideoSongMode | null {
  if (!isVideoSong()) return null;
  return videoSongInBackground() ? "background" : "cover";
}

// Spotify's player takes its video away with `container.removeChild(video)` when a song ends. A
// video that has been lifted out is no longer that container's child and the call would throw, so
// for the held video alone it is made a quiet no-op.
const nativeRemoveChild = Node.prototype.removeChild;
function installRemoveGuard(): void {
  Node.prototype.removeChild = function <T extends Node>(this: Node, child: T): T {
    if (held && (child as Node) === held.video && child.parentNode !== this) return child;
    return nativeRemoveChild.call(this, child) as T;
  };
}
function removeRemoveGuard(): void {
  Node.prototype.removeChild = nativeRemoveChild;
}

const resume = (video: HTMLVideoElement): void => {
  // A video taken out of the page is paused by the browser; put back, it should carry on.
  if (video.paused && Spicetify.Player.isPlaying()) void video.play().catch(() => undefined);
};

/** Set the cover box to the video's own shape (16:9 for most), so there are no black bars. */
function shapeCover(): void {
  if (!held || held.mode !== "cover") return;
  const { video, target } = held;
  if (video.videoWidth && video.videoHeight) {
    target.style.setProperty("--PlayerVideoAspect", `${video.videoWidth} / ${video.videoHeight}`);
  }
}

function release(): void {
  if (!held) return;
  const { video, home, next, style, target, mode } = held;
  held = null;
  queueMicrotask(heldChanged);
  removeRemoveGuard();
  video.removeEventListener("resize", shapeCover);
  video.removeEventListener("loadedmetadata", shapeCover);

  if (mode === "cover") {
    target.classList.remove("HasPlayerVideo");
    target.style.removeProperty("--PlayerVideoAspect");
  } else {
    video.classList.remove("LiveBackgroundVideo", "Ready");
  }
  if (style === null) video.removeAttribute("style");
  else video.setAttribute("style", style);

  // Back in its place, unless Spotify has made a new video there meanwhile (then this one is
  // finished with) or the place itself is gone.
  if (home.isConnected && !home.querySelector("video")) {
    home.insertBefore(video, next && next.parentNode === home ? next : null);
    resume(video);
  } else {
    video.pause();
    video.remove();
  }
}

function hold(video: HTMLVideoElement, target: HTMLElement, mode: VideoSongMode): void {
  const home = video.parentElement as HTMLElement;
  held = { video, home, next: video.nextSibling, style: video.getAttribute("style"), target, mode };
  installRemoveGuard();
  if (mode === "cover") {
    video.setAttribute("style", "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;");
    target.classList.add("HasPlayerVideo");
  } else {
    // The same look as the live background's other videos (see LiveBackground.ts), and its blur setting.
    video.removeAttribute("style");
    video.classList.add("LiveBackgroundVideo", "Ready");
  }
  target.appendChild(video);
  heldChanged();
  video.addEventListener("resize", shapeCover);
  video.addEventListener("loadedmetadata", shapeCover);
  shapeCover();
  resume(video);
}

/** Bring the video to the cover, or send it home, as the song and the page now call for. Cheap to call often. */
function sync(): void {
  const mode = videoSongMode();
  const target =
    mode === "background"
      ? PageContainer?.querySelector<HTMLElement>(CONTENT)
      : PageContainer?.querySelector<HTMLElement>(COVER);
  // The cover is only there while the Now Bar is open; the background is there while the page is.
  const wanted = !!mode && !!target?.isConnected && (mode === "background" || $isNowBarOpen.get());

  if (!wanted || !mode || !target) {
    release();
    return;
  }

  if (held) {
    // The target can be rebuilt (a view change), taking the video with it; or the setting changed.
    if (held.mode === mode && held.target === target && target.contains(held.video)) return;
    release();
  }

  const video = document.querySelector<HTMLVideoElement>(PLAYER_VIDEO);
  if (video) hold(video, target, mode);
}

let started = false;

export function initVideoSongs(): void {
  if (started) return;
  started = true;

  // A new song gets a new video from Spotify; the old one must be back where Spotify expects it first.
  Global.Event.listen("playback:songchange", () => {
    release();
    sync();
  });
  // Before the page's elements go, so the video is not taken with them.
  Global.Event.listen("page:destroy", release);
  for (const event of ["fullscreen:open", "fullscreen:exit", "page:open"]) {
    Global.Event.listen(event, sync);
  }
  $isNowBarOpen.listen(sync);
  onExperimentChange((experiment) => {
    if (experiment.id === "videoSongs" || experiment.id === "liveBackground") sync();
  });
  $experimentToggle("liveBackground").listen(sync);

  // Spotify makes the video a moment after the song starts, and a view change can rebuild the
  // cover, so this also looks again now and then. It does nothing unless a video song is playing.
  setInterval(() => {
    if (held || isVideoSong()) sync();
  }, 700);
}
