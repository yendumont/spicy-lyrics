import Global from "../../components/Global/Global.ts";
import { SpotifyPlayer } from "../../components/Global/SpotifyPlayer.ts";
import { PageContainer } from "../../components/Pages/PageView.ts";
import { onExperimentChange, isExperimentEnabled } from "../experiments.ts";
import { $isNowBarOpen } from "../uiState.ts";
import { heldMode, onHeldChange } from "../VideoSongs.ts";
import { dropVideo, getMotion, loopVideo, pauseOrResumeAll } from "./Motion.ts";
import { initLiveBackground } from "./LiveBackground.ts";

/**
 * Plays the song's animated cover (its Spotify Canvas, or its album's animated cover from
 * Apple Music) over the still cover in the Now Bar (the cover in Fullscreen and in the larger
 * view). The still cover stays underneath, so nothing changes while the video is made or if
 * the song has none. A Canvas is tall, so the box crops it to the cover's shape.
 */
const CONTAINER = ".ContentBox .NowBar .Header .MediaBox .MediaImageContainer";

let attached: { signature: string; video: HTMLVideoElement } | null = null;
let generation = 0;

function detach(): void {
  if (!attached) return;
  dropVideo(attached.video);
  PageContainer?.querySelector(CONTAINER)?.classList.remove("HasAnimatedCover");
  attached = null;
}

/** Show (or take away) the animated cover for whatever is playing. Cheap to call often. */
export async function syncAnimatedCover(): Promise<void> {
  const mine = ++generation;
  const container = PageContainer?.querySelector<HTMLElement>(CONTAINER);
  const use = { apple: isExperimentEnabled("animatedCover"), canvas: isExperimentEnabled("spotifyCanvas") };

  // A video song shows its own video in the cover instead (see VideoSongs.ts), unless that is sent to the background.
  if ((!use.apple && !use.canvas) || !container?.isConnected || !$isNowBarOpen.get() || heldMode() === "cover") {
    detach();
    return;
  }

  // What is wanted: this song, with these sources. If that is already showing, there is nothing to do.
  const signature = `${SpotifyPlayer.GetUri()}|${use.apple}|${use.canvas}`;
  if (attached?.signature === signature && attached.video.isConnected && container.contains(attached.video)) return;
  detach();

  // The song may change, or the cover be closed, while the video is being made.
  const motion = await getMotion(use, () => mine === generation);
  if (mine !== generation || !motion) return;
  const live = PageContainer?.querySelector<HTMLElement>(CONTAINER);
  if (!live?.isConnected) return;

  const video = loopVideo(live.ownerDocument, "AnimatedCoverVideo", motion);
  live.classList.add("HasAnimatedCover");
  live.appendChild(video);
  attached = { signature, video };
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
  onHeldChange(() => void syncAnimatedCover());
  onExperimentChange((experiment) => {
    if (experiment.id === "animatedCover" || experiment.id === "spotifyCanvas") void syncAnimatedCover();
  });

  Global.Event.listen("playback:playpause", pauseOrResumeAll);
  document.addEventListener("visibilitychange", pauseOrResumeAll);

  initLiveBackground();
}
