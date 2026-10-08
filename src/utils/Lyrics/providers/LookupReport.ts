import { atom } from "nanostores";
import type { LyricsProviderId } from "./types.ts";

/** What asking one source about the playing song came to. */
export type Outcome = {
  state: "found" | "notfound" | "error" | "searching";
  /** "word synced" / "line synced" / "unsynced", when found. */
  sync?: string;
};

export type LookupReport = {
  /** The song the outcomes belong to. */
  uri: string | null;
  outcomes: Partial<Record<LyricsProviderId, Outcome>>;
};

export const $lookupReport = atom<LookupReport>({ uri: null, outcomes: {} });

/** The payloads found for the current song, so choosing a source needs no second request. */
const payloads = new Map<string, any>();

export function SyncLabel(lyrics: any): string | undefined {
  switch (lyrics?.Type) {
    case "Syllable":
      return "word synced";
    case "Line":
      return "line synced";
    case "Static":
      return "unsynced";
    default:
      return undefined;
  }
}

/** Start a fresh report when the song changes; the same song keeps what it has. */
export function BeginReport(uri: string): void {
  if ($lookupReport.get().uri === uri) return;
  payloads.clear();
  $lookupReport.set({ uri, outcomes: {} });
}

export function RecordOutcome(uri: string, id: LyricsProviderId, outcome: Outcome, lyrics?: any): void {
  const report = $lookupReport.get();
  if (report.uri !== uri) return;
  if (lyrics && outcome.state === "found") payloads.set(`${uri}|${id}`, structuredClone(lyrics));
  $lookupReport.set({ uri, outcomes: { ...report.outcomes, [id]: outcome } });
}

/** Record what a source returned: found (with its sync), or nothing. */
export function RecordResult(uri: string, id: LyricsProviderId, lyrics: any | null): void {
  const sync = SyncLabel(lyrics);
  RecordOutcome(uri, id, sync ? { state: "found", sync } : { state: "notfound" }, lyrics);
}

export function PayloadFor(uri: string, id: LyricsProviderId): any | undefined {
  return payloads.get(`${uri}|${id}`);
}
