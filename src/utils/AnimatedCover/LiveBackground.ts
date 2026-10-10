import Global from "../../components/Global/Global.ts";
import { SpotifyPlayer } from "../../components/Global/SpotifyPlayer.ts";
import { PageContainer } from "../../components/Pages/PageView.ts";
import { $experimentSlider, isExperimentEnabled, onExperimentChange } from "../experiments.ts";
import { dropVideo, getMotion, loopVideo } from "./Motion.ts";

/**
 * The live background: the song's moving picture (its Spotify Canvas, else its album's
 * animated cover from Apple Music) filling the background of Fullscreen and the larger view,
 * darkened and blurred behind the lyrics. It is a layer above the normal animated background,
 * which stays underneath, so a song with no video, or a video still being made, looks as it
 * always did. The picture is cropped to fill whatever shape the window has.
 */
const CONTENT = ".ContentBox";

let attached: { signature: string; video: HTMLVideoElement } | null = null;
let generation = 0;

function detach(): void {
  if (!attached) return;
  dropVideo(attached.video);
  attached = null;
}

async function syncLiveBackground(): Promise<void> {
  const mine = ++generation;
  const content = PageContainer?.querySelector<HTMLElement>(CONTENT);

  if (!isExperimentEnabled("liveBackground") || !content?.isConnected) {
    detach();
    return;
  }

  const signature = SpotifyPlayer.GetUri() ?? "";
  if (attached?.signature === signature && attached.video.isConnected && content.contains(attached.video)) return;
  detach();

  // Both sources are tried: the background does not depend on the cover experiments being on.
  const motion = await getMotion({ apple: true, canvas: true }, () => mine === generation);
  if (mine !== generation || !motion) return;
  const live = PageContainer?.querySelector<HTMLElement>(CONTENT);
  if (!live?.isConnected) return;

  const video = loopVideo(live.ownerDocument, "LiveBackgroundVideo", motion);
  live.appendChild(video);
  attached = { signature, video };
}

// The blur goes in a CSS var on the page itself as well as the root, because in a pop-out
// window the page lives in its own document, whose root never sees what is written here.
const applyBlur = (blur: number): void => {
  const value = `${blur}px`;
  document.documentElement.style.setProperty("--LiveBackgroundBlur", value);
  PageContainer?.style.setProperty("--LiveBackgroundBlur", value);
};

let started = false;

export function initLiveBackground(): void {
  if (started) return;
  started = true;

  const blur = $experimentSlider("liveBackground");
  applyBlur(blur.get());
  blur.listen(applyBlur);

  Global.Event.listen("playback:songchange", () => {
    detach();
    void syncLiveBackground();
  });
  for (const event of ["fullscreen:open", "fullscreen:exit", "page:open", "page:destroy"]) {
    Global.Event.listen(event, () => {
      applyBlur(blur.get());
      void syncLiveBackground();
    });
  }
  onExperimentChange((experiment) => {
    if (experiment.id === "liveBackground") void syncLiveBackground();
  });
}
