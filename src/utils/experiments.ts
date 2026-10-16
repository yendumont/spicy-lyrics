import { atom, computed, type ReadableAtom } from "nanostores";
import { persistAtom } from "./stores.ts";
import { getRemoteConfig } from "./remoteConfig.ts";
import { EdgeLookup } from "./API/EdgeService.ts";

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
 *     forceState: true,                // optional — see below
 *     hidden: true,                    // optional — see below
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
 * `forceState` locks the experiment: `true` forces it on, `false` forces it off,
 * leaving it out keeps it user-controlled. A forced experiment still shows in the
 * panel, with its toggle locked and a "Forced on/off" tag so people can see why
 * it won't move. The user's own saved choice is left untouched underneath, so
 * removing `forceState` later hands them back whatever they had picked.
 *
 * `hidden` takes the experiment out of the settings panel (and its search) and
 * nothing else: the value still resolves exactly as it would if it were shown.
 *
 * REMOTE OVERRIDES: the edge serves `?lookup=experimentsState`, an array of
 * `{ id, ...fields }`. Any field but `id` is laid over the local entry, so the
 * server can flip a `default`, force a state, hide a row or reword a label without
 * a release. Ids that don't exist locally are ignored — the server can never add
 * an experiment. `null` for a field means "no override". Each successful response
 * replaces the previous one outright, so an entry with only an `id` (or an empty
 * or `null` response) drops whatever was overridden before. Failed fetches keep
 * the last good overrides. Refreshed every `experimentsSync.intervalMs` (remote
 * config, 60 s by default) and whenever the Experiments tab opens.
 *
 * The resolved value is `forceState ?? userChoice ?? default`, where `userChoice`
 * is only set once the user has toggled it themselves — so a remote `default`
 * reaches everyone who never touched the experiment, and no one who did.
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
  /** Lock the experiment on (`true`) or off (`false`); omit to let the user choose. */
  forceState?: boolean;
  /** Leave it out of the settings panel. Never affects the value. */
  hidden?: boolean;
  /** One adjustable number, persisted as `experimentValue:<id>` and shown while the experiment is on. */
  slider?: { label: string; description?: string; min: number; max: number; step: number; default: number; unit?: string };
  /** One extra on/off choice, persisted as `experimentOption:<id>` and shown while the experiment is on. */
  toggle?: { label: string; description?: string; default: boolean };
  /** A panel of its own shown under the switch while the experiment is on (see LocalLyricsTools.tsx). */
  tool?: "embeddedLyrics" | "ttmlToLrc";
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
    id: "lyricsSkeleton",
    label: "Lyrics Loading Skeleton",
    description:
      "Shows placeholder lines and a small \"Loading Lyrics\" label while lyrics fetch and render, instead of the blurred spinner. Disable to bring the spinner back.",
    default: true,
    pageClass: "Exp_LyricsSkeleton",
  },
  {
    id: "canvasImmersive",
    label: "Canvas Stage",
    description:
      "When a song has a Spotify Canvas, it fills the Now Bar side of the screen in place of the album cover, and its colors drive the page background. Only applies with the dynamic background. Disable to keep the cover and the animated cover background.",
    default: true,
  },
  {
    id: "npvCanvasBackground",
    label: "Canvas NPV Background",
    description:
      "When a song has a Spotify Canvas, the Now Playing View's dynamic background is drawn from the Canvas video playing there, frame for frame, instead of the album cover. Disable to keep the cover.",
    default: true,
  },
  {
    id: "popupDock",
    label: "Popup Player Dock",
    description:
      "Popup lyrics fill the whole window, with the player docked along the bottom like the Canvas Stage: title and artist at rest, the timeline and controls rising in when you move the mouse. Disable to bring back the cover header and the controls over the enlarged cover.",
    default: true,
    pageClass: "Exp_PopupDock",
  },
  {
    id: "refinedBackground",
    label: "Refined Background",
    description:
      "Background changes crossfade in place, including switching styles in Settings, and Cover Colors use the cover's deeper tones, changing with the song instead of a second later. Image backgrounds keep their edges instead of being cropped. Disable to bring back the sliding image transition and the brighter Cover Colors.",
    default: true,
    pageClass: "Exp_RefinedBackground",
  },
  {
    id: "refreshedSimpleLyrics",
    label: "Refreshed Simple Lyrics Mode",
    description:
      "In Simple Lyrics Mode, the sung part of a word fades in behind a soft edge, the part still to come stays a little brighter, and the letters of a short held word come up one after another with the fill, growing, lifting and glowing, then settle together once the word is done, stronger the longer the word is held. Lines sit further apart and follow the song in a ripple, each catching up a moment after the one above it. Interlude dots fill in one by one while the group slowly breathes. Its scrolling takes over from Smooth Scrolling while it's on. Disable to bring back the previous Simple Lyrics look.",
    default: false,
    pageClass: "Exp_RefreshedSimpleLyrics",
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
    id: "videoSongs",
    label: "Video Songs",
    description:
      "Lets songs that Spotify plays as a music video get lyrics from every provider, and shows the video itself in Fullscreen and the larger view in place of the still picture. Spotify draws its video in the Now Playing sidebar, so that sidebar must be open and set to video (its Switch to video button) for the video to appear in the cover; the thumbnail shows otherwise. Takes effect from the next song. Disable to bring back the notice that video songs have no lyrics, and the thumbnail.",
    default: true,
  },
  {
    id: "syncedTranslation",
    label: "Word-Synced Translation",
    description:
      "On songs with word-synced lyrics, the translation lights up word by word in time with the singing instead of sitting still under each line. Gemini is asked to line its translation up with the sung words, so each song is translated again once (one more request). Needs Translate Lyrics on. Other songs, and lines it cannot line up, keep the plain translation. Disable to bring back the plain translation.",
    default: false,
  },
  {
    id: "keepVideoAspect",
    label: "Keep Video Aspect Ratio",
    description:
      "Shows the animated covers and the live video background in their own shape instead of cropping them to fill: a background video is not zoomed to fill the window (the normal background shows around it). Disable to crop them to fill.",
    default: false,
    pageClass: "Exp_KeepVideoAspect",
  },
  {
    id: "liveBackground",
    label: "Live Video Background",
    description:
      "Fills the background of Fullscreen and the larger view with the album's animated cover from Apple Music, darkened and blurred behind the lyrics. Songs without one keep the normal background. Works without Animated Album Covers being on. Disable to go back to the normal background.",
    default: false,
    slider: { label: "Background Blur", description: "How much the video is blurred. 0 is sharp.", min: 0, max: 60, step: 1, default: 24, unit: "px" },
    toggle: {
      label: "Video Songs in the Background",
      description:
        "For songs Spotify plays as a music video: put the video itself in the background instead of in the cover. The cover then shows the song's normal cover, or its Apple Music animated cover when it has one. (Spotify's video cannot be copied, so it can only be in one place at a time.) Needs Video Songs on.",
      default: false,
    },
  },
  {
    id: "embeddedLocalLyrics",
    label: "Embedded Lyrics for Local Files",
    description:
      "Shows the lyrics stored inside your local music files (their tags) when you play them, and shows them as synced as they are: word by word for enhanced LRC or TTML, line by line for LRC, or unsynced for plain text. Spotify's page cannot open your files by itself, so choose your music folder once below; the tags are read on your PC and nothing is uploaded. Works for MP3, FLAC, M4A/MP4 and Ogg files. Disable to stop using them.",
    default: false,
    tool: "embeddedLyrics",
  },
  {
    id: "ttmlToLrc",
    label: "TTML to Enhanced LRC Converter",
    description:
      "Turns a TTML lyrics file of your own into LRC text (enhanced LRC when it is word-timed) that you can put in a song's lyrics tag with a tag editor, for use with Embedded Lyrics for Local Files. Everything happens on your PC. Disable to hide the converter.",
    default: false,
    tool: "ttmlToLrc",
  },
] as const satisfies readonly Experiment[];

/** A registry entry, narrowed to its literal `id`. */
export type RegisteredExperiment = (typeof EXPERIMENTS)[number];
export type ExperimentId = RegisteredExperiment["id"];
/** A registry entry with any remote overrides applied — what everything should read. */
export type ResolvedExperiment = Experiment & { id: ExperimentId };

type ExperimentOverride = Partial<Omit<Experiment, "id" | "slider" | "toggle" | "tool">>;

const REGISTRY = EXPERIMENTS as readonly ResolvedExperiment[];

/** The overrides from the last good `experimentsState` response, keyed by id. */
export const $experimentOverrides = atom<Partial<Record<ExperimentId, ExperimentOverride>>>({});

function resolve(
  exp: ResolvedExperiment,
  overrides: Partial<Record<ExperimentId, ExperimentOverride>>
): ResolvedExperiment {
  const override = overrides[exp.id];
  return override ? { ...exp, ...override } : exp;
}

/** One experiment, with remote overrides applied. */
export function getExperiment(id: ExperimentId): ResolvedExperiment {
  const exp = REGISTRY.find((e) => e.id === id);
  if (!exp) throw new Error(`Unknown experiment "${id}"`);
  return resolve(exp, $experimentOverrides.get());
}

/** Every experiment, with remote overrides applied, in registry order. */
export function getExperiments(): ResolvedExperiment[] {
  const overrides = $experimentOverrides.get();
  return REGISTRY.map((exp) => resolve(exp, overrides));
}

/** The ones the settings panel lists: everything not `hidden`. */
export function getVisibleExperiments(): ResolvedExperiment[] {
  return getExperiments().filter((exp) => !exp.hidden);
}

// `undefined` until the user toggles it, so a `default` (local or remote) keeps
// applying to everyone who never made a choice. Kept even while an experiment is
// forced, so lifting the force hands back whatever they had picked.
const userChoices = new Map(
  REGISTRY.map((exp) => [
    exp.id,
    persistAtom<boolean | undefined>(`experiment:${exp.id}`, undefined),
  ])
);

const stores = new Map<ExperimentId, ReadableAtom<boolean>>(
  REGISTRY.map((exp) => [
    exp.id,
    computed([userChoices.get(exp.id)!, $experimentOverrides], (choice, overrides) => {
      const resolved = resolve(exp, overrides);
      return resolved.forceState ?? choice ?? resolved.default;
    }),
  ])
);

const sliders = new Map(
  REGISTRY.flatMap((exp) =>
    exp.slider ? [[exp.id, persistAtom<number>(`experimentValue:${exp.id}`, exp.slider.default)] as const] : []
  )
);

const toggles = new Map(
  REGISTRY.flatMap((exp) =>
    exp.toggle ? [[exp.id, persistAtom<boolean>(`experimentOption:${exp.id}`, exp.toggle.default)] as const] : []
  )
);

/** The persisted on/off choice of an experiment that has a toggle. */
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

/** `true`/`false` while the experiment is locked on/off, `undefined` when the user decides. */
export function forcedExperimentState(id: ExperimentId): boolean | undefined {
  return getExperiment(id).forceState;
}

/** The experiment's resolved value as a store — use in React via `useStore`. */
export function $experiment(id: ExperimentId): ReadableAtom<boolean> {
  const store = stores.get(id);
  if (!store) throw new Error(`Unknown experiment "${id}"`);
  return store;
}

export function isExperimentEnabled(id: ExperimentId): boolean {
  return stores.get(id)?.get() ?? false;
}

export function setExperiment(id: ExperimentId, value: boolean): void {
  if (forcedExperimentState(id) !== undefined) return;
  userChoices.get(id)?.set(value);
}

// Every class an experiment has ever owned here, so one renamed by an override
// doesn't leave its old class stuck on the page.
const knownPageClasses = new Set<string>(
  REGISTRY.flatMap((exp) => (exp.pageClass ? [exp.pageClass] : []))
);

/** Sync every experiment's `pageClass` onto the page root. Safe to call anytime. */
export function ApplyExperimentClasses(el: HTMLElement): void {
  const active = new Set<string>();
  for (const exp of getExperiments()) {
    if (!exp.pageClass) continue;
    knownPageClasses.add(exp.pageClass);
    if (isExperimentEnabled(exp.id)) active.add(exp.pageClass);
  }
  for (const cls of knownPageClasses) el.classList.toggle(cls, active.has(cls));
}

/**
 * Run `cb(experiment)` whenever an experiment's resolved value changes — from the
 * user's toggle or a remote override alike. `.listen` rather than `.subscribe`,
 * so this never fires on module load.
 */
export function onExperimentChange(cb: (experiment: ResolvedExperiment) => void): void {
  for (const exp of REGISTRY) {
    stores.get(exp.id)?.listen(() => cb(getExperiment(exp.id)));
  }
}

/**
 * Run `cb()` whenever the remote overrides change at all. For things that read
 * the definition rather than the value — a `pageClass` renamed while the value
 * stayed put never reaches `onExperimentChange`.
 */
export function onExperimentDefinitionChange(cb: () => void): void {
  $experimentOverrides.listen(() => cb());
}

// ─── Remote overrides ────────────────────────────────────────────────────────

// Timeout and interval come from the remote config's `experimentsSync` group.
// The timeout is also the longest the Experiments panel can stay locked
// waiting on a fetch.

// Every overridable field and the type it has to arrive as. Typed against
// `Experiment`, so adding a field there fails to compile until it's listed here.
const OVERRIDABLE: Record<keyof ExperimentOverride, "string" | "boolean"> = {
  label: "string",
  description: "string",
  default: "boolean",
  pageClass: "string",
  rebuildsNowBar: "boolean",
  forceState: "boolean",
  hidden: "boolean",
};

const KNOWN_IDS = new Set<string>(REGISTRY.map((exp) => exp.id));

function parseOverrides(data: unknown): Partial<Record<ExperimentId, ExperimentOverride>> {
  const result: Partial<Record<ExperimentId, ExperimentOverride>> = {};
  if (!Array.isArray(data)) return result;

  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || !KNOWN_IDS.has(id)) continue;

    const override: Record<string, unknown> = {};
    for (const [key, type] of Object.entries(OVERRIDABLE)) {
      if (!Object.hasOwn(entry, key)) continue;
      const value = (entry as Record<string, unknown>)[key];
      if (typeof value === type) override[key] = value;
    }
    if (Object.keys(override).length) result[id as ExperimentId] = override as ExperimentOverride;
  }
  return result;
}

let inFlight: Promise<void> | null = null;

/** `true` while an `experimentsState` fetch is in flight. The panel locks on it. */
export const $experimentsSyncing = atom(false);

/**
 * Fetch and apply the remote overrides. Concurrent calls share one request. A
 * failure of any kind keeps the overrides already in place.
 */
export function RefreshExperimentOverrides(): Promise<void> {
  inFlight ??= (async () => {
    $experimentsSyncing.set(true);
    try {
      const res = await EdgeLookup("experimentsState", {
        timeoutMs: getRemoteConfig().experimentsSync.timeoutMs,
      });
      if (!res.ok) return;
      const next = parseOverrides(await res.json());
      // The server answers the same thing almost every time; skip the store
      // write so the panel and listeners don't churn on a no-op.
      if (JSON.stringify(next) !== JSON.stringify($experimentOverrides.get())) {
        $experimentOverrides.set(next);
      }
    } catch (error) {
      console.warn("Experiments state refresh failed", error);
    } finally {
      inFlight = null;
      $experimentsSyncing.set(false);
    }
  })();
  return inFlight;
}

let syncStarted = false;

/** Fetch the overrides now, then every `experimentsSync.intervalMs` for the rest of the session. */
export function StartExperimentOverridesSync(): void {
  if (syncStarted) return;
  syncStarted = true;
  const tick = async () => {
    try {
      await RefreshExperimentOverrides();
    } finally {
      setTimeout(tick, getRemoteConfig().experimentsSync.intervalMs);
    }
  };
  void tick();
}
