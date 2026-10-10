import { useStore } from "@nanostores/react";
import React from "react";
import { SpotifyPlayer } from "../../../components/Global/SpotifyPlayer.ts";
import { ExportCurrentLyricsAsTTML } from "../../../utils/LyricsExport.ts";
import { $lookupReport } from "../../../utils/Lyrics/providers/LookupReport.ts";
import { PROVIDER_LABELS, resolveOrder } from "../../../utils/Lyrics/providers/ProviderOrder.ts";
import { CheckAllSources } from "../../../utils/Lyrics/providers/Sources.ts";
import {
  ClearChosenSourceForCurrentSong,
  UseSourceForCurrentSong,
} from "../../../utils/LyricsSourceTools.ts";
import {
  $lyricsProvider,
  $lyricsProviderOrder,
  $lyricsProviderPicks,
  $lyricsProvidersDisabled,
} from "../../../utils/stores.ts";
import type { LyricsProviderId } from "../../../utils/Lyrics/providers/types.ts";
import { matches, Row, SectionTitle } from "./components.tsx";

const SECTION_NAME = "Lyrics Sources";
const LABEL = "Sources for This Song";
const DESCRIPTION =
  "Which lyrics sources have this song, and a way to pick one for it. Songs are normally looked up in your priority order and stop at the first good result; Check All Sources asks every source.";

const EXPORT_LABEL = "Export Lyrics as TTML";
const EXPORT_DESCRIPTION =
  "Save the lyrics showing for the playing song as a .ttml file, whichever source they came from. Word timing, background vocals and the two singer sides are kept.";

export default function SourcesSection({ query, sectionFilter }: { query: string; sectionFilter: string }) {
  const report = useStore($lookupReport);
  const picks = useStore($lyricsProviderPicks);
  const savedOrder = useStore($lyricsProviderOrder);
  const legacy = useStore($lyricsProvider);
  const disabled = useStore($lyricsProvidersDisabled);
  const [checking, setChecking] = React.useState(false);

  if (sectionFilter !== "All" && sectionFilter !== SECTION_NAME) return null;
  if (
    !matches(query, LABEL, DESCRIPTION) &&
    !matches(query, "Chosen Source", "pin a lyrics source to a song") &&
    !matches(query, EXPORT_LABEL, EXPORT_DESCRIPTION)
  ) {
    return null;
  }

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
    <>
      <SectionTitle>Lyrics Sources</SectionTitle>

      <Row
        stacked
        label={LABEL}
        description={
          uri
            ? DESCRIPTION
            : "Play a song to see which sources have it."
        }
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
            <button className="sl-sp-btn" disabled={!uri || checking} onClick={check}>
              {checking ? "Checking…" : "Check All Sources"}
            </button>
          </div>
        </div>
      </Row>

      <Row
        label="Clear Chosen Source for Current Song"
        description={
          pinned
            ? `This song is pinned to ${PROVIDER_LABELS[pinned]}. Un-pin it to go back to the automatic order. The clear-cache buttons below do not change this.`
            : "Nothing is pinned for this song. A pinned source is kept separately from the lyrics cache, so the clear-cache buttons below never undo it."
        }
      >
        <button
          className="sl-sp-btn"
          disabled={!pinned}
          onClick={() => ClearChosenSourceForCurrentSong(true)}
        >
          Clear
        </button>
      </Row>

      {matches(query, EXPORT_LABEL, EXPORT_DESCRIPTION) && (
        <Row label={EXPORT_LABEL} description={EXPORT_DESCRIPTION}>
          <button className="sl-sp-btn" disabled={!uri} onClick={ExportCurrentLyricsAsTTML}>
            Export
          </button>
        </Row>
      )}
    </>
  );
}
