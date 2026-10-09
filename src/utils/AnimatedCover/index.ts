import Global from "../../components/Global/Global.ts";
import { SpotifyPlayer } from "../../components/Global/SpotifyPlayer.ts";
import { PageContainer } from "../../components/Pages/PageView.ts";
import { onExperimentChange, isExperimentEnabled } from "../experiments.ts";
import { ResolveTrack } from "../Lyrics/providers/Resolve.ts";
import { $isNowBarOpen } from "../uiState.ts";
import { coverKey, getAnimatedCover } from "./AnimatedCover.ts";

/**
 * Plays an album's animated cover over the still cover in the Now Bar (the cover in
 * Fullscreen and in the larger view). The still cover stays underneath, so nothing
 * changes while the video is made or if the album has none.
 */
const CONTAINER = ".ContentBox .NowBar .Header .MediaBox .MediaImageContainer";

let attached: { key: string; video: HTMLVideoElement } | null = null;
let generation = 0;

function detach(): void {
  if (!attached) return;
  attached.video.pause();
  attached.video.removeAttribute("src");
  attached.video.remove();
  PageContainer?.querySelector(CONTAINER)?.classList.remove("HasAnimatedCover");
  attached = null;
}

/** Show (or take away) the animated cover for whatever is playing. Cheap to call often. */
export async function syncAnimatedCover(): Promise<void> {
  const mine = ++generation;
  const container = PageContainer?.querySelector<HTMLElement>(CONTAINER);

  if (!isExperimentEnabled("animatedCover") || !container?.isConnected || !$isNowBarOpen.get()) {
    detach();
    return;
  }

  const reading = (await ResolveTrack()).readings[0];
  if (mine !== generation) return;
  if (!reading?.album || !reading.artist) {
    detach();
    return;
  }

  const key = coverKey(reading.artist, reading.album);
  if (attached?.key === key && attached.video.isConnected && container.contains(attached.video)) return;
  detach();

  const url = await getAnimatedCover(reading.artist, reading.album);
  // The song may have changed, or the cover been closed, while the video was being made.
  if (mine !== generation || !url) return;
  const live = PageContainer?.querySelector<HTMLElement>(CONTAINER);
  if (!live?.isConnected) return;

  const video = document.createElement("video");
  video.className = "AnimatedCoverVideo";
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.disablePictureInPicture = true;
  video.src = url;
  video.addEventListener(
    "canplay",
    () => {
      if (attached?.video !== video) return;
      video.classList.add("Ready");
      if (SpotifyPlayer.IsPlaying && !document.hidden) void video.play().catch(() => undefined);
    },
    { once: true }
  );
  live.classList.add("HasAnimatedCover");
  live.appendChild(video);
  attached = { key, video };
}

let started = false;

export function initAnimatedCover(): void {
  if (started) return;
  started = true;

  // A new song takes the old song's video away at once; the new one follows when it is ready.
  Global.Event.listen("playback:songchange", () => {
    detach();
    void syncAnimatedCover();
  });
  for (const event of ["fullscreen:open", "fullscreen:exit", "page:open", "page:destroy"]) {
    Global.Event.listen(event, () => void syncAnimatedCover());
  }
  $isNowBarOpen.listen(() => void syncAnimatedCover());
  onExperimentChange((experiment) => {
    if (experiment.id === "animatedCover") void syncAnimatedCover();
  });

  // A video that is not being looked at should not be running.
  const pauseOrResume = () => {
    const video = attached?.video;
    if (!video?.classList.contains("Ready")) return;
    if (document.hidden || !Spicetify.Player.isPlaying()) video.pause();
    else void video.play().catch(() => undefined);
  };
  Global.Event.listen("playback:playpause", pauseOrResume);
  document.addEventListener("visibilitychange", pauseOrResume);
}
