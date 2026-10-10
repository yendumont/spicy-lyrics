import { toast } from "sonner";
import Global from "../../../components/Global/Global.ts";
import { SpotifyPlayer } from "../../../components/Global/SpotifyPlayer.ts";
import {
  $geminiApiKey,
  $geminiModel,
  $geniusProxyUrl,
  $lineMeanings,
  $lineMeaningsFrom,
  $translateLyrics,
  $translationLanguage,
} from "../../stores.ts";
import { $experiment, isExperimentEnabled } from "../../experiments.ts";
import { normalizeProxyUrl } from "../providers/Genius.ts";
import { appliedLines, appliedType } from "./LineElements.ts";
import { alignMeanings, asMeaningsFrom, filterMeanings, getMeanings } from "./Meanings.ts";
import { closeMeaningCard, decorateMeanings, removeMeanings } from "./MeaningsUI.ts";
import { syncWords, type SyncWord } from "./SyncedWords.ts";
import {
  TranslationError,
  decorateSyncedTranslations,
  decorateTranslations,
  removeTranslations,
  translateLyrics,
  translateLyricsSynced,
} from "./Translation.ts";

/**
 * Things added to each lyrics line once the lyrics are on screen: what the line means
 * (Genius's annotations) and what it says in another language (Gemini). Both are looked
 * up in the background and added when they arrive, so the lyrics never wait for them.
 */

/** Bumped whenever the lyrics change, so a late answer for the old lyrics is dropped. */
let generation = 0;
let lastTranslationError = "";

async function refresh(): Promise<void> {
  const mine = ++generation;
  const uri = SpotifyPlayer.GetUri();
  const type = appliedType();
  const lines = appliedLines(type);
  const current = () => mine === generation && SpotifyPlayer.GetUri() === uri;

  if (!uri || !type || lines.length === 0) {
    removeMeanings();
    removeTranslations();
    return;
  }

  // Line meanings
  if ($lineMeanings.get() && normalizeProxyUrl($geniusProxyUrl.get())) {
    void getMeanings(uri, () => !current()).then((meanings) => {
      if (!current()) return;
      const shown = filterMeanings(meanings, asMeaningsFrom($lineMeaningsFrom.get()));
      decorateMeanings(lines, alignMeanings(shown, lines.map((l) => l.text)));
    });
  } else {
    removeMeanings();
  }

  // Translation
  const key = $geminiApiKey.get().trim();
  if ($translateLyrics.get() && key) {
    const language = $translationLanguage.get().trim() || "English";
    const model = $geminiModel.get().trim() || "gemini-3.5-flash-lite";
    const failed = (error: unknown) => {
      if (!current()) return;
      const message = error instanceof TranslationError ? error.message : "Translation failed";
      // One notice per problem, not one per song.
      if (message !== lastTranslationError) toast.error(message);
      lastTranslationError = message;
    };

    // Word-synced lyrics (when the experiment is on) get a translation that follows the singing.
    const words = type === "Syllable" && isExperimentEnabled("syncedTranslation")
      ? lines.map((l) => syncWords(l.el))
      : null;
    if (words && words.every((w): w is SyncWord[] => w !== null)) {
      translateLyricsSynced(
        words.map((line) => line.map((w) => w.text.trim())),
        language,
        key,
        model
      ).then((chunks) => {
        if (current()) decorateSyncedTranslations(lines, words as SyncWord[][], chunks);
      }, failed);
    } else {
      translateLyrics(
        lines.map((l) => l.text),
        language,
        key,
        model
      ).then((translations) => {
        if (current()) decorateTranslations(lines, translations);
      }, failed);
    }
  } else {
    removeTranslations();
  }
}

/**
 * Start looking up a song's meanings as soon as it starts playing, in parallel with the
 * lyrics, so they are usually there by the time the lyrics are. Nothing waits for it.
 */
function prefetch(): void {
  const uri = SpotifyPlayer.GetUri();
  if (!uri || !$lineMeanings.get() || !normalizeProxyUrl($geniusProxyUrl.get())) return;
  void getMeanings(uri, () => SpotifyPlayer.GetUri() !== uri).then(() => {
    // The lyrics may already be up, waiting on nothing but this.
    if (SpotifyPlayer.GetUri() === uri && appliedLines().length > 0) void refresh();
  });
}

let started = false;

/** Start adding meanings and translations to the lyrics. Call once, after the page is set up. */
export function initLineExtras(): void {
  if (started) return;
  started = true;

  Global.Event.listen("lyrics:apply", () => void refresh());
  Global.Event.listen("playback:songchange", () => prefetch());
  Global.Event.listen("lyrics:not-apply", () => {
    generation++;
    closeMeaningCard();
  });

  // Changing a setting changes what is on screen straight away.
  for (const store of [
    $lineMeanings,
    $lineMeaningsFrom,
    $translateLyrics,
    $geminiApiKey,
    $translationLanguage,
    $geminiModel,
    $geniusProxyUrl,
    $experiment("syncedTranslation"),
  ]) {
    store.listen(() => {
      lastTranslationError = "";
      void refresh();
    });
  }
}
