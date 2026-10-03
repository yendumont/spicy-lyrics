import { useStore } from "@nanostores/react";
import React from "react";
import {
  $lineHoverBackground,
  $lyricsProvider,
  $lyricsProviderFallback,
  $preferBestSync,
  $minimalLyricsMode,
  $simpleLyricsMode,
  $simpleLyricsModeRenderingType
} from "../../../utils/stores.ts";
import { matches, Row, Select, SectionTitle, Toggle } from "./components.tsx";

const SECTION_NAME = "Lyrics Display";
const renderingTypeOptions = ["calculate", "animate"];
const providerOptions = ["spicy", "unison", "lrclib"];
const providerLabels = ["Spicy Lyrics", "Unison", "LRCLIB"];

interface Props {
  query: string;
  sectionFilter: string;
}

export default function LyricsSection({ query, sectionFilter }: Props) {
  const simpleLyricsMode = useStore($simpleLyricsMode);
  const simpleLyricsModeRenderingType = useStore($simpleLyricsModeRenderingType);
  const minimalLyricsMode = useStore($minimalLyricsMode);
  const lineHoverBackground = useStore($lineHoverBackground);
  const lyricsProvider = useStore($lyricsProvider);
  const lyricsProviderFallback = useStore($lyricsProviderFallback);
  const preferBestSync = useStore($preferBestSync);

  if (sectionFilter !== "All" && sectionFilter !== SECTION_NAME) return null;

  const r1 = matches(query, "Simple Lyrics Mode", "Remove extra visual effects from lyrics");
  const r2 = matches(query, "Simple Mode: Text Animation Style", "How lyrics text transitions are rendered in Simple Lyrics Mode.");
  const r3 = matches(query, "Minimal Lyrics Mode", "Hides sung lyrics lines in Fullscreen and Cinema Mode");
  const r4 = matches(query, "Line Hover Background", "Shows a highlight box behind a lyrics line when you hover over it");
  const r5 = matches(query, "Lyrics Provider", "Which service lyrics are fetched from first: Spicy Lyrics, Unison or LRCLIB.");
  const r6 = matches(query, "Provider Fallback", "When the chosen lyrics provider has nothing for a song, try the other providers in turn.");

  const r7 = matches(query, "Prefer Best Sync", "Keep asking providers past a worse-synced result and show the best one: word sync over line sync over unsynced.");

  if (!r1 && !r2 && !r3 && !r4 && !r5 && !r6 && !r7) return null;

  return (
    <>
      <SectionTitle>Lyrics Display</SectionTitle>

      {r5 && (
        <Row
          label="Lyrics Provider"
          description="Which service lyrics are fetched from first. Already-loaded songs stay cached until the cache expires or is cleared."
        >
          <Select
            value={lyricsProvider}
            options={providerOptions}
            labels={providerLabels}
            onChange={(v) => $lyricsProvider.set(v)}
          />
        </Row>
      )}

      {r6 && (
        <Row
          label="Provider Fallback"
          description="When the chosen provider has nothing for a song, try the other providers in turn."
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
