import { persistAtom } from "./stores.ts";

/**
 * ─── Experiments ──────────────────────────────────────────────────────────────
 *
 * Opt-in/opt-out feature flags surfaced in Settings → Experiments.
 *
 * TO ADD AN EXPERIMENT: append one entry to the EXPERIMENTS array below. That is
 * the whole registration — the settings UI, the persisted store and (if you set
 * `pageClass`) the CSS hook are all derived from it. Nothing else to wire up.
 *
 *   {
 *     id: "myExperiment",              // stable; persisted as "experiment:myExperiment"
 *     label: "My Experiment",
 *     description: "What it changes, and what turning it off restores.",
 *     default: true,
 *     pageClass: "Exp_MyExperiment",   // optional — toggled on #SpicyLyricsPage
 *     rebuildsNowBar: true,            // optional — see below
 *     slider: { label, min, max, step, default, unit },   // optional — see below
 *     toggle: { label, description, default },            // optional — see below
 *   }
 *
 * `pageClass` is the preferred way to implement one: write the new look under
 * `#SpicyLyricsPage.Exp_Foo` and keep the old one under
 * `#SpicyLyricsPage:not(.Exp_Foo)`, and the toggle costs nothing at runtime.
 *
 * `rebuildsNowBar` is only for experiments whose *markup* differs between states
 * (CSS alone can't get you there). It makes NowBar tear down and rebuild the
 * fullscreen overlay when the flag flips.
 *
 * `slider` gives the experiment one adjustable number, shown under its switch while it is on.
 * Read it with `$experimentSlider(id)` (a persisted store: `.get()` and `.listen()`).
 */

export type Experiment = {
  /** Stable key. Persisted in the settings blob as `experiment:<id>`. */
  id: string;
  label: string;
  description: string;
  default: boolean;
  /** Class toggled on `#SpicyLyricsPage` while the experiment is enabled. */
  pageClass?: string;
  /** Rebuild the fullscreen NowBar overlay when this flag changes. */
  rebuildsNowBar?: boolean;
  /** One adjustable number, persisted as `experimentValue:<id>` and shown while the experiment is on. */
  slider?: { label: string; description?: string; min: number; max: number; step: number; default: number; unit?: string };
  /** One extra on/off choice, persisted as `experimentOption:<id>` and shown while the experiment is on. */
  toggle?: { label: string; description?: string; default: boolean };
};

export const EXPERIMENTS = [
  {
    id: "newProgressBarStyling",
    label: "New SliderBar Styling",
    description:
      "New glass-like style for the SliderBar. Disable to revert back to the original one.",
    default: true,
    pageClass: "Exp_NewProgressBar",
  },
  {
    id: "duetLinePadding",
    label: "Duet Line Padding",
    description:
      "Indents lyrics lines on the side they lean away from when a song has duet lines, so the two voices read as separate columns. Disable to give every line the same slight padding.",
    default: true,
    pageClass: "Exp_DuetLinePadding",
  },
  {
    id: "lyricsSkeleton",
    label: "Lyrics Loading Skeleton",
    description:
      "Shows placeholder lines and a small \"Loading Lyrics\" label while lyrics fetch and render, instead of the blurred spinner. Disable to bring the spinner back.",
    default: true,
    pageClass: "Exp_LyricsSkeleton",
  },
  {
    id: "animatedCover",
    label: "Animated Album Covers",
    description:
      "Plays an album's animated cover from Apple Music (when it has one) over the still cover in Fullscreen and the larger view. Spotify cannot play Apple's video format, so each one is converted once on your PC, taking one CPU core for a few seconds to a minute, and the converter (about 9 MB, kept afterwards) is downloaded the first time. Needs your Worker updated for it. Disable to go back to the still cover.",
    default: false,
  },
  {
    id: "unlistedLyrics",
    label: "Lyrics for Local Files & Podcasts",
    description:
      "Looks up lyrics for songs you play from local files and for audio podcast episodes. They have no real artist on Spotify, so the artist is guessed from the title (\"Artist - Song\", \"Song by Artist\") and the lyrics providers are searched for the closest match, preferring word and line sync. Can occasionally pick the wrong song. Disable to restore the \"not supported\" notice.",
    default: false,
  },
  {
    id: "spotifyCanvas",
    label: "Spotify Canvas as Animated Cover",
    description:
      "Plays a song's Spotify Canvas (the short looping video artists add to their songs) over the still cover in Fullscreen and the larger view. Where a song has both, Apple's album cover stays on the cover and the Canvas goes to the Live Video Background; a song with only a Canvas shows it on the cover. Canvases are tall, so they are cropped to the cover's shape. Like Apple's, each Canvas is converted once on your PC (a few seconds) for Spotify to play it. Disable to stop using Canvas.",
    default: false,
  },
  {
    id: "videoSongs",
    label: "Video Songs",
    description:
      "Lets songs that Spotify plays as a music video get lyrics from every provider, and shows the video itself in Fullscreen and the larger view in place of the still picture. Spotify draws its video in the Now Playing sidebar, so that sidebar must be open and set to video (its Switch to video button) for the video to appear in the cover; the thumbnail shows otherwise. Takes effect from the next song. Disable to bring back the notice that video songs have no lyrics, and the thumbnail.",
    default: true,
  },
  {
    id: "keepVideoAspect",
    label: "Keep Video Aspect Ratio",
    description:
      "Shows the animated covers, Canvases and the live video background in their own shape instead of cropping them to fill: a tall Canvas sits whole in the cover (with the still cover showing at its sides) and a background video is not zoomed to fill the window (the normal background shows around it). Disable to crop them to fill.",
    default: false,
    pageClass: "Exp_KeepVideoAspect",
  },
  {
    id: "liveBackground",
    label: "Live Video Background",
    description:
      "Fills the background of Fullscreen and the larger view with the song's animated video (its Spotify Canvas, or Apple Music's animated cover if it has none), darkened and blurred behind the lyrics. Songs with neither keep the normal background. Works without the two animated cover experiments being on. Disable to go back to the normal background.",
    default: false,
    slider: { label: "Background Blur", description: "How much the video is blurred. 0 is sharp.", min: 0, max: 60, step: 1, default: 24, unit: "px" },
    toggle: {
      label: "Video Songs in the Background",
      description:
        "For songs Spotify plays as a music video: put the video itself in the background instead of in the cover. The cover then shows the song's normal cover, or its animated Canvas or Apple Music cover when it has one. (Spotify's video cannot be copied, so it can only be in one place at a time.) Needs Video Songs on.",
      default: false,
    },
  },
] as const satisfies readonly Experiment[];

/** A registry entry, narrowed to its literal `id` — what the UI iterates over. */
export type RegisteredExperiment = (typeof EXPERIMENTS)[number];
export type ExperimentId = RegisteredExperiment["id"];

const makeStore = (key: string, defaultValue: boolean) => persistAtom<boolean>(key, defaultValue);
type ExperimentStore = ReturnType<typeof makeStore>;

const stores = new Map<string, ExperimentStore>(
  EXPERIMENTS.map((exp) => [exp.id, makeStore(`experiment:${exp.id}`, exp.default)])
);

/** The persisted store for an experiment — use in React via `useStore`. */
export function $experiment(id: ExperimentId): ExperimentStore {
  const store = stores.get(id);
  if (!store) throw new Error(`Unknown experiment "${id}"`);
  return store;
}

const sliders = new Map(
  (EXPERIMENTS as readonly Experiment[]).flatMap((exp) =>
    exp.slider ? [[exp.id, persistAtom<number>(`experimentValue:${exp.id}`, exp.slider.default)] as const] : []
  )
);

const toggles = new Map(
  (EXPERIMENTS as readonly Experiment[]).flatMap((exp) =>
    exp.toggle ? [[exp.id, persistAtom<boolean>(`experimentOption:${exp.id}`, exp.toggle.default)] as const] : []
  )
);

/** The persisted on/off choice of an experiment that has a 	oggle. */
export function $experimentToggle(id: ExperimentId): ReturnType<typeof persistAtom<boolean>> {
  const store = toggles.get(id);
  if (!store) throw new Error(`Experiment "${id}" has no toggle`);
  return store;
}

/** The persisted number of an experiment that has a slider. */
export function $experimentSlider(id: ExperimentId): ReturnType<typeof persistAtom<number>> {
  const store = sliders.get(id);
  if (!store) throw new Error(`Experiment "${id}" has no slider`);
  return store;
}

export function isExperimentEnabled(id: ExperimentId): boolean {
  return stores.get(id)?.get() ?? false;
}

export function setExperiment(id: ExperimentId, value: boolean): void {
  stores.get(id)?.set(value);
}

/** Sync every experiment's `pageClass` onto the page root. Safe to call anytime. */
export function ApplyExperimentClasses(el: HTMLElement): void {
  for (const exp of EXPERIMENTS as readonly Experiment[]) {
    if (!exp.pageClass) continue;
    el.classList.toggle(exp.pageClass, isExperimentEnabled(exp.id as ExperimentId));
  }
}

/**
 * Run `cb(experiment)` whenever any experiment is toggled. `.listen` rather than
 * `.subscribe`, so this never fires on module load.
 */
export function onExperimentChange(cb: (experiment: Experiment) => void): void {
  for (const exp of EXPERIMENTS) {
    stores.get(exp.id)?.listen(() => cb(exp));
  }
}
