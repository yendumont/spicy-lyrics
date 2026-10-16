import { useStore } from "@nanostores/react";
import React from "react";
import { SpotifyPlayer } from "../../../components/Global/SpotifyPlayer.ts";
import { $lookupReport } from "../../../utils/Lyrics/providers/LookupReport.ts";
import {
  DEFAULT_ORDER,
  PROVIDER_LABELS,
  resolveOrder,
} from "../../../utils/Lyrics/providers/ProviderOrder.ts";
import { CheckAllSources } from "../../../utils/Lyrics/providers/Sources.ts";
import type { LyricsProviderId } from "../../../utils/Lyrics/providers/types.ts";
import {
  ClearChosenSourceForCurrentSong,
  UseSourceForCurrentSong,
} from "../../../utils/LyricsSourceTools.ts";
import {
  $geminiApiKey,
  $geminiModel,
  $geniusEagerMatch,
  $geniusFavoriteArtists,
  $geniusLooseSearch,
  $geniusProxyUrl,
  $lineMeanings,
  $lineMeaningsFrom,
  $lrcRedWordSync,
  $lyricsProvider,
  $lyricsProviderFallback,
  $lyricsProviderOrder,
  $lyricsProviderPicks,
  $lyricsProvidersDisabled,
  $musixmatchToken,
  $preferBestSync,
  $translateLyrics,
  $translationLanguage,
} from "../../../utils/stores.ts";
import { PriorityList, Row, Select, TextInput, Toggle } from "./components.tsx";
import type { GroupDef } from "./model.ts";

/**
 * The settings this fork adds to the Lyrics tab: where lyrics come from (the provider
 * list, Genius, Musixmatch, lrc.red), line meanings and translation. They live in
 * their own file so upstream's LyricsSection.tsx only needs one line to include them.
 */

const lrcRedWordSyncOptions = ["hand", "all", "off"];
const lrcRedWordSyncLabels = ["Hand-timed only", "All word sync", "No word sync"];
const meaningsFromOptions = ["artist", "editors", "everyone"];
const meaningsFromLabels = ["Artist only", "Artist and editors", "Everyone"];

const PRIORITY_DESCRIPTION =
  "Providers are asked from top to bottom; turn off the ones you do not want. With Provider Fallback off, only the first one that is on is used. Songs already loaded stay cached for 3 days or until the cache is cleared.";

function PriorityRow({ label }: { label: React.ReactNode }) {
  const legacyProvider = useStore($lyricsProvider);
  const savedOrder = useStore($lyricsProviderOrder);
  const disabledProviders = useStore($lyricsProvidersDisabled);
  const providerOrder = resolveOrder(savedOrder, legacyProvider);
  return (
    <Row stacked label={label} description={PRIORITY_DESCRIPTION}>
      <PriorityList
        order={providerOrder}
        disabled={disabledProviders}
        labels={PROVIDER_LABELS}
        onChange={(order, disabled) => {
          $lyricsProviderOrder.set(order);
          $lyricsProvidersDisabled.set(disabled);
        }}
        onReset={
          providerOrder.join() === DEFAULT_ORDER.join() && disabledProviders.length === 0
            ? undefined
            : () => {
                $lyricsProviderOrder.set([...DEFAULT_ORDER]);
                $lyricsProvidersDisabled.set([]);
              }
        }
      />
    </Row>
  );
}

const SOURCES_DESCRIPTION =
  "Which lyrics sources have this song, and a way to pick one for it. Songs are normally looked up in your priority order and stop at the first good result; Check All Sources asks every source.";

function SourcesRow({ label }: { label: React.ReactNode }) {
  const report = useStore($lookupReport);
  const picks = useStore($lyricsProviderPicks);
  const savedOrder = useStore($lyricsProviderOrder);
  const legacy = useStore($lyricsProvider);
  const disabled = useStore($lyricsProvidersDisabled);
  const [checking, setChecking] = React.useState(false);

  const uri = SpotifyPlayer.GetUri();
  const thisSong = uri && report.uri === uri;
  const order = resolveOrder(savedOrder, legacy);
  const pinned = uri ? (picks[uri] as LyricsProviderId | undefined) : undefined;

  const statusOf = (id: LyricsProviderId): { text: string; detail?: string; found: boolean } => {
    if (disabled.includes(id)) return { text: "Switched off", found: false };
    const outcome = thisSong ? report.outcomes[id] : undefined;
    switch (outcome?.state) {
      case "found":
        return { text: "Found", detail: outcome.sync, found: true };
      case "notfound":
        return { text: "Not found", found: false };
      case "error":
        return { text: "Failed", found: false };
      case "searching":
        return { text: "Searching…", found: false };
      default:
        return { text: "Not asked yet", found: false };
    }
  };

  const check = async () => {
    setChecking(true);
    try {
      await CheckAllSources();
    } finally {
      setChecking(false);
    }
  };

  return (
    <Row
      stacked
      label={label}
      description={uri ? SOURCES_DESCRIPTION : "Play a song to see which sources have it."}
    >
      <div className="sl-sp-provider-list">
        {order.map((id) => {
          const status = statusOf(id);
          const off = disabled.includes(id);
          return (
            <div key={id} className={`sl-sp-provider${off ? " sl-sp-provider--off" : ""}`}>
              <span className="sl-sp-provider-name">{PROVIDER_LABELS[id]}</span>
              <span
                className={`sl-sp-source-status${status.found ? " sl-sp-source-status--found" : ""}`}
              >
                {status.text}
                {status.detail && <small>{status.detail}</small>}
              </span>
              {pinned === id ? (
                <span className="sl-sp-source-using">In use</span>
              ) : (
                <button
                  type="button"
                  className="sl-sp-provider-btn"
                  disabled={off || !uri || checking}
                  onClick={() => UseSourceForCurrentSong(id)}
                  title={`Show ${PROVIDER_LABELS[id]}'s lyrics for this song`}
                >
                  Use
                </button>
              )}
            </div>
          );
        })}

        <div className="sl-sp-source-actions">
          <button type="button" className="sl-sp-btn" disabled={!uri || checking} onClick={check}>
            {checking ? "Checking…" : "Check All Sources"}
          </button>
        </div>
      </div>
    </Row>
  );
}

function ClearChosenSourceRow({ label }: { label: React.ReactNode }) {
  const picks = useStore($lyricsProviderPicks);
  const uri = SpotifyPlayer.GetUri();
  const pinned = uri ? (picks[uri] as LyricsProviderId | undefined) : undefined;
  return (
    <Row
      label={label}
      description={
        pinned
          ? `This song is pinned to ${PROVIDER_LABELS[pinned]}. Un-pin it to go back to the automatic order. The clear-cache buttons never change this.`
          : "Nothing is pinned for this song. A pinned source is kept separately from the lyrics cache, so the clear-cache buttons never undo it."
      }
    >
      <button
        type="button"
        className="sl-sp-btn"
        disabled={!pinned}
        onClick={() => ClearChosenSourceForCurrentSong(true)}
      >
        Clear
      </button>
    </Row>
  );
}

const needsFallback = () => (useStore($lyricsProviderFallback) ? false : "Enable Provider Fallback to modify this setting");
const needsLooseSearch = () => (useStore($geniusLooseSearch) ? false : "Enable Genius Loose Search to modify this setting");
const needsLineMeanings = () => (useStore($lineMeanings) ? false : "Enable Line Meanings to modify this setting");

// Built once: the Control components must keep their identity across renders.
export const providerGroups: GroupDef[] = [
  {
    title: "Sources",
    settings: [
      {
        id: "lyricsProviderPriority",
        label: "Lyrics Provider Priority",
        description: PRIORITY_DESCRIPTION,
        keywords: "providers order spicy lyrics unison lrclib lrcmux netease qq genius",
        render: (label) => <PriorityRow label={label} />,
      },
      {
        id: "lyricsProviderFallback",
        label: "Provider Fallback",
        description:
          "When the first provider has nothing for a song, try the others in turn, in the order above.",
        Control: ({ label }) => (
          <Toggle
            label={label}
            checked={useStore($lyricsProviderFallback)}
            onChange={(v) => $lyricsProviderFallback.set(v)}
          />
        ),
      },
      {
        id: "preferBestSync",
        label: "Prefer Best Sync",
        description:
          "Keep asking providers past a worse-synced result and show the best one: word sync over line sync over unsynced. Costs extra requests for songs without word sync.",
        useDisabled: needsFallback,
        Control: ({ label, disabled }) => (
          <Toggle
            label={label}
            checked={useStore($preferBestSync)}
            onChange={(v) => $preferBestSync.set(v)}
            disabled={disabled}
          />
        ),
      },
      {
        id: "lrcRedWordSync",
        label: "lrc.red Word Sync",
        description:
          "How much of lrc.red's word-by-word timing to use. Many of its songs are timed by its own model, not by hand, and the model can be inaccurate (lrc.red says so on those songs' pages). Hand-timed only keeps word sync where a person timed it and uses line sync elsewhere; the other providers can then supply word sync instead.",
        Control: ({ label }) => (
          <Select
            label={label}
            value={useStore($lrcRedWordSync)}
            options={lrcRedWordSyncOptions}
            labels={lrcRedWordSyncLabels}
            onChange={(v) => $lrcRedWordSync.set(v)}
          />
        ),
      },
      {
        id: "musixmatchToken",
        label: "Musixmatch Token",
        description:
          "Needed for the Musixmatch provider: your own Musixmatch user token. Musixmatch gives apps without one a blank token, so with this empty Musixmatch finds nothing. Stored only in this extension's settings and sent only to Musixmatch.",
        Control: () => (
          <TextInput
            value={useStore($musixmatchToken)}
            placeholder="paste your token"
            onCommit={(v) => $musixmatchToken.set(v.trim())}
          />
        ),
      },
    ],
  },
  {
    title: "Sources for This Song",
    settings: [
      {
        id: "sourcesForThisSong",
        label: "Sources for This Song",
        description: SOURCES_DESCRIPTION,
        keywords: "chosen source pin a lyrics source check all sources",
        stacked: true,
        render: (label) => <SourcesRow label={label} />,
      },
      {
        id: "clearChosenSource",
        label: "Clear Chosen Source for Current Song",
        description:
          "Un-pin the lyrics source you picked for this song. The clear-cache buttons never do this.",
        keywords: "pin unpin source",
        render: (label) => <ClearChosenSourceRow label={label} />,
      },
    ],
  },
  {
    title: "Genius",
    settings: [
      {
        id: "geniusProxyUrl",
        label: "Genius Proxy URL",
        description:
          "Needed for the Genius and YouTube Music lyrics providers: the address of your own Cloudflare Worker (see RUNBOOK.md; redeploy it after an update to get YouTube Music). Both give unsynced text only, and are tried last unless you pick them first. Without an address they find nothing.",
        keywords: "worker youtube music",
        Control: () => (
          <TextInput
            secret
            value={useStore($geniusProxyUrl)}
            placeholder="https://your-worker.workers.dev"
            onCommit={(v) => $geniusProxyUrl.set(v)}
          />
        ),
      },
      {
        id: "geniusLooseSearch",
        label: "Genius Loose Search",
        description:
          "Genius only. For leaked and fan-uploaded songs: when the exact song and artist find nothing, search more broadly and use a result with the same cover art, a related artist, or an artist your library has already resolved. Gives up rather than guess a famous song of the same name, but can occasionally pick the wrong one.",
        Control: ({ label }) => (
          <Toggle
            label={label}
            checked={useStore($geniusLooseSearch)}
            onChange={(v) => $geniusLooseSearch.set(v)}
          />
        ),
      },
      {
        id: "geniusEagerMatch",
        label: "Genius Eager Matching",
        description:
          "Genius only. When nothing proves which Genius page is right, show the best-looking one anyway instead of no lyrics: a close title written the same way, by a page that is not famous. Shows more lyrics for leaked and uploaded songs, but can occasionally show another song's. Needs Genius Loose Search.",
        useDisabled: needsLooseSearch,
        Control: ({ label, disabled }) => (
          <Toggle
            label={label}
            checked={useStore($geniusEagerMatch)}
            onChange={(v) => $geniusEagerMatch.set(v)}
            disabled={disabled}
          />
        ),
      },
      {
        id: "geniusFavoriteArtists",
        label: "Genius Favourite Artists",
        description:
          "Genius only. Real artists whose songs you have in your library under someone else's name, separated by commas (for example: jaydes, yuke). When Spotify's artist is an unknown uploader, Genius is searched for these artists too, and their song with the same title is used. It also learns these by itself after a few confirmed matches.",
        Control: () => (
          <TextInput
            value={useStore($geniusFavoriteArtists)}
            placeholder="artist one, artist two"
            onCommit={(v) => $geniusFavoriteArtists.set(v)}
          />
        ),
      },
      {
        id: "lineMeanings",
        label: "Line Meanings",
        description:
          "Shows a small info button on lyrics lines that Genius has an explanation for; press it to read what the line means. Needs the Genius Proxy URL above (your Worker, with the line-meanings update deployed).",
        Control: ({ label }) => (
          <Toggle
            label={label}
            checked={useStore($lineMeanings)}
            onChange={(v) => $lineMeanings.set(v)}
          />
        ),
      },
      {
        id: "lineMeaningsFrom",
        label: "Meanings From",
        description:
          "Whose explanations to show. Artist only: ones the artist wrote or confirmed. Artist and editors: those plus the ones Genius's editors reviewed and approved. Everyone: also community suggestions nobody has reviewed yet, which can be wrong.",
        useDisabled: needsLineMeanings,
        Control: ({ label, disabled }) => (
          <Select
            label={label}
            value={useStore($lineMeaningsFrom)}
            options={meaningsFromOptions}
            labels={meaningsFromLabels}
            onChange={(v) => $lineMeaningsFrom.set(v)}
            disabled={disabled}
          />
        ),
      },
    ],
  },
  {
    title: "Translation",
    settings: [
      {
        id: "translateLyrics",
        label: "Translate Lyrics",
        description:
          "Shows a translation under each lyrics line, made by Google's Gemini with your own API key. The lyrics of each song you play are sent to Google for this (once per song and language; the result is kept for 60 days). Costs whatever your Gemini plan charges per request.",
        keywords: "gemini",
        Control: ({ label }) => (
          <Toggle
            label={label}
            checked={useStore($translateLyrics)}
            onChange={(v) => $translateLyrics.set(v)}
          />
        ),
      },
      {
        id: "geminiApiKey",
        label: "Gemini API Key",
        description:
          "Your own key from Google AI Studio (aistudio.google.com). Stored only in this extension's settings and sent only to Google.",
        Control: () => (
          <TextInput
            secret
            value={useStore($geminiApiKey)}
            placeholder="paste your key"
            onCommit={(v) => $geminiApiKey.set(v)}
          />
        ),
      },
      {
        id: "translationLanguage",
        label: "Translate Into",
        description: "The language to translate to, in plain words (English, Español, 日本語…).",
        Control: () => (
          <TextInput
            value={useStore($translationLanguage)}
            placeholder="English"
            onCommit={(v) => $translationLanguage.set(v || "English")}
          />
        ),
      },
      {
        id: "geminiModel",
        label: "Gemini Model",
        description:
          "The model that translates. The default is the fastest and cheapest one; change it if Google retires it or your key has no access.",
        Control: () => (
          <TextInput
            value={useStore($geminiModel)}
            placeholder="gemini-3.5-flash-lite"
            onCommit={(v) => $geminiModel.set(v || "gemini-3.5-flash-lite")}
          />
        ),
      },
    ],
  },
];
