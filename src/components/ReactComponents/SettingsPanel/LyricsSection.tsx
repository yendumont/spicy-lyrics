import { useStore } from "@nanostores/react";
import React from "react";
import {
  $geniusEagerMatch,
  $geniusFavoriteArtists,
  $geniusLooseSearch,
  $geniusProxyUrl,
  $lineHoverBackground,
  $lrcRedWordSync,
  $lyricsProvider,
  $lyricsProviderFallback,
  $lyricsProviderOrder,
  $lyricsProvidersDisabled,
  $preferBestSync,
  $minimalLyricsMode,
  $simpleLyricsMode,
  $simpleLyricsModeRenderingType
} from "../../../utils/stores.ts";
import { DEFAULT_ORDER, PROVIDER_LABELS, resolveOrder } from "../../../utils/Lyrics/providers/ProviderOrder.ts";
import { matches, PriorityList, Row, Select, SectionTitle, TextInput, Toggle } from "./components.tsx";

const SECTION_NAME = "Lyrics Display";
const renderingTypeOptions = ["calculate", "animate"];
const lrcRedWordSyncOptions = ["hand", "all", "off"];
const lrcRedWordSyncLabels = ["Hand-timed only", "All word sync", "No word sync"];

interface Props {
  query: string;
  sectionFilter: string;
}

export default function LyricsSection({ query, sectionFilter }: Props) {
  const simpleLyricsMode = useStore($simpleLyricsMode);
  const simpleLyricsModeRenderingType = useStore($simpleLyricsModeRenderingType);
  const minimalLyricsMode = useStore($minimalLyricsMode);
  const lineHoverBackground = useStore($lineHoverBackground);
  const legacyProvider = useStore($lyricsProvider);
  const savedOrder = useStore($lyricsProviderOrder);
  const disabledProviders = useStore($lyricsProvidersDisabled);
  const providerOrder = resolveOrder(savedOrder, legacyProvider);
  const lyricsProviderFallback = useStore($lyricsProviderFallback);
  const preferBestSync = useStore($preferBestSync);
  const geniusProxyUrl = useStore($geniusProxyUrl);
  const geniusLooseSearch = useStore($geniusLooseSearch);
  const geniusFavoriteArtists = useStore($geniusFavoriteArtists);
  const geniusEagerMatch = useStore($geniusEagerMatch);
  const lrcRedWordSync = useStore($lrcRedWordSync);

  if (sectionFilter !== "All" && sectionFilter !== SECTION_NAME) return null;

  const r1 = matches(query, "Simple Lyrics Mode", "Remove extra visual effects from lyrics");
  const r2 = matches(query, "Simple Mode: Text Animation Style", "How lyrics text transitions are rendered in Simple Lyrics Mode.");
  const r3 = matches(query, "Minimal Lyrics Mode", "Hides sung lyrics lines in Fullscreen and Cinema Mode");
  const r4 = matches(query, "Line Hover Background", "Shows a highlight box behind a lyrics line when you hover over it");
  const r5 = matches(query, "Lyrics Provider Priority", "The order lyrics providers are asked in, and which are used: Spicy Lyrics, Unison, LRCLIB, LRCMux, NetEase, QQ Music, Genius.");
  const r6 = matches(query, "Provider Fallback", "When the first lyrics provider has nothing for a song, try the others in turn.");

  const r7 = matches(query, "Prefer Best Sync", "Keep asking providers past a worse-synced result and show the best one: word sync over line sync over unsynced.");

  const r8 = matches(query, "Genius Proxy URL", "Address of your own Cloudflare Worker, needed for the Genius lyrics provider.");

  const r9 = matches(query, "Genius Loose Search", "When Genius finds nothing for the exact song and artist, search more broadly and use the closest match.");

  const r10 = matches(query, "Genius Favourite Artists", "Real artists whose songs you have under other people's names, for finding leaked and fan-uploaded songs on Genius.");

  const r11 = matches(query, "Genius Eager Matching", "When nothing proves which Genius page is right, show the best-looking one anyway instead of no lyrics.");

  const r12 = matches(query, "lrc.red Word Sync", "How much of lrc.red's word-by-word timing to use. Many of its songs are timed by its own model, which can be inaccurate.");

  if (!r1 && !r2 && !r3 && !r4 && !r5 && !r6 && !r7 && !r8 && !r9 && !r10 && !r11 && !r12) return null;

  return (
    <>
      <SectionTitle>Lyrics Display</SectionTitle>

      {r5 && (
        <Row
          stacked
          label="Lyrics Provider Priority"
          description="Providers are asked from top to bottom; turn off the ones you do not want. With Provider Fallback off, only the first one that is on is used. Songs already loaded stay cached for 3 days or until the cache is cleared."
        >
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
      )}

      {r6 && (
        <Row
          label="Provider Fallback"
          description="When the first provider has nothing for a song, try the others in turn, in the order above."
        >
          <Toggle
            checked={lyricsProviderFallback}
            onChange={(v) => $lyricsProviderFallback.set(v)}
          />
        </Row>
      )}

      {r7 && (
        <Row
          label="Prefer Best Sync"
          description="Keep asking providers past a worse-synced result and show the best one: word sync over line sync over unsynced. Costs extra requests for songs without word sync."
          disabled={!lyricsProviderFallback}
          disabledReason="Enable Provider Fallback to modify this setting"
        >
          <Toggle checked={preferBestSync} onChange={(v) => $preferBestSync.set(v)} />
        </Row>
      )}

      {r12 && (
        <Row
          label="lrc.red Word Sync"
          description="How much of lrc.red's word-by-word timing to use. Many of its songs are timed by its own model, not by hand, and the model can be inaccurate (lrc.red says so on those songs' pages). Hand-timed only keeps word sync where a person timed it and uses line sync elsewhere; the other providers can then supply word sync instead."
        >
          <Select
            value={lrcRedWordSync}
            options={lrcRedWordSyncOptions}
            labels={lrcRedWordSyncLabels}
            onChange={(v) => $lrcRedWordSync.set(v)}
          />
        </Row>
      )}

      {r8 && (
        <Row
          label="Genius Proxy URL"
          description="Needed for the Genius lyrics provider: the address of your own Cloudflare Worker (see RUNBOOK.md). Genius gives unsynced text only, and is tried last unless you pick it first. Without an address it finds nothing."
        >
          <TextInput
            value={geniusProxyUrl}
            placeholder="https://your-worker.workers.dev"
            onCommit={(v) => $geniusProxyUrl.set(v)}
          />
        </Row>
      )}

      {r9 && (
        <Row
          label="Genius Loose Search"
          description="Genius only. For leaked and fan-uploaded songs: when the exact song and artist find nothing, search more broadly and use a result with the same cover art, a related artist, or an artist your library has already resolved. Gives up rather than guess a famous song of the same name, but can occasionally pick the wrong one."
        >
          <Toggle checked={geniusLooseSearch} onChange={(v) => $geniusLooseSearch.set(v)} />
        </Row>
      )}

      {r11 && (
        <Row
          label="Genius Eager Matching"
          description="Genius only. When nothing proves which Genius page is right, show the best-looking one anyway instead of no lyrics: a close title written the same way, by a page that is not famous. Shows more lyrics for leaked and uploaded songs, but can occasionally show another song's. Needs Genius Loose Search."
          disabled={!geniusLooseSearch}
          disabledReason="Enable Genius Loose Search to modify this setting"
        >
          <Toggle checked={geniusEagerMatch} onChange={(v) => $geniusEagerMatch.set(v)} />
        </Row>
      )}

      {r10 && (
        <Row
          label="Genius Favourite Artists"
          description="Genius only. Real artists whose songs you have in your library under someone else's name, separated by commas (for example: jaydes, yuke). When Spotify's artist is an unknown uploader, Genius is searched for these artists too, and their song with the same title is used. It also learns these by itself after a few confirmed matches."
        >
          <TextInput
            value={geniusFavoriteArtists}
            placeholder="artist one, artist two"
            onCommit={(v) => $geniusFavoriteArtists.set(v)}
          />
        </Row>
      )}

      {r1 && (
        <Row label="Simple Lyrics Mode" description="Remove extra visual effects from lyrics">
          <Toggle checked={simpleLyricsMode} onChange={(v) => $simpleLyricsMode.set(v)} />
        </Row>
      )}

      {r2 && (
        <Row
          label="Simple Mode: Text Animation Style"
          description="How lyrics text transitions are rendered in Simple Lyrics Mode."
          disabled={!simpleLyricsMode}
          disabledReason="Enable Simple Lyrics Mode to modify this setting"
        >
          <Select
            value={simpleLyricsModeRenderingType}
            options={renderingTypeOptions}
            onChange={(v) => $simpleLyricsModeRenderingType.set(v)}
            disabled={!simpleLyricsMode}
          />
        </Row>
      )}

      {r3 && (
        <Row
          label="Minimal Lyrics Mode"
          description="Hides sung lyrics lines in Fullscreen and Cinema Mode"
        >
          <Toggle checked={minimalLyricsMode} onChange={(v) => $minimalLyricsMode.set(v)} />
        </Row>
      )}

      {r4 && (
        <Row
          label="Line Hover Background"
          description="Shows a highlight box behind a lyrics line when you hover over it"
        >
          <Toggle checked={lineHoverBackground} onChange={(v) => $lineHoverBackground.set(v)} />
        </Row>
      )}
 
    </>
  );
}
