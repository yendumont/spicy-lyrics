import { toast } from "sonner";
import { SpotifyPlayer } from "../components/Global/SpotifyPlayer.ts";
import { PROVIDER_LABELS } from "./Lyrics/providers/ProviderOrder.ts";
import { FetchFromSource } from "./Lyrics/providers/Sources.ts";
import type { LyricsProviderId } from "./Lyrics/providers/types.ts";
import { reduceSync, serializeTTML, type ExportSync } from "./Lyrics/ttml/serialize.ts";
import { $currentLyricsData } from "./stores.ts";

/** What to write: the lyrics as they are, or with their sync reduced to lines or to plain text. */
export type ExportFormat = "original" | ExportSync;

export type ExportOptions = {
  /** A lyrics source to export instead of what is showing. */
  source?: LyricsProviderId;
  format?: ExportFormat;
};

const SYNC_NAMES: Record<ExportSync, string> = { Syllable: "word-synced", Line: "line-synced", Static: "unsynced" };

/** What is showing for `uri` right now, or null when it is not loaded (or is the previous song's). */
function showingNow(uri: string): any | null {
  const raw = $currentLyricsData.get();
  if (!raw || raw.startsWith("NO_LYRICS")) return null;
  try {
    const lyrics = JSON.parse(raw);
    return lyrics.uri && lyrics.uri !== uri ? null : lyrics;
  } catch {
    return null;
  }
}

/** The playing song's lyrics saved to a `.ttml` file: what is showing, or one source's. */
export async function ExportCurrentLyricsAsTTML({ source, format = "original" }: ExportOptions = {}): Promise<void> {
  const uri = SpotifyPlayer.GetUri();
  if (!uri) {
    toast.info("Play a song first");
    return;
  }

  let lyrics: any = null;
  try {
    lyrics = source ? await FetchFromSource(uri, source) : showingNow(uri);
  } catch {
    lyrics = null;
  }
  if (SpotifyPlayer.GetUri() !== uri) return;
  if (!lyrics?.Type) {
    toast.info(source ? `${PROVIDER_LABELS[source]} has no lyrics for this song` : "No lyrics are loaded for this song yet");
    return;
  }

  const had: ExportSync = lyrics.Type;
  const out = format === "original" ? lyrics : reduceSync(lyrics, format);
  const ttml = serializeTTML(out);
  if (!ttml) {
    toast.info("These lyrics have no lines to export");
    return;
  }

  const artist = (SpotifyPlayer.GetArtists() ?? []).map((a) => a.name).join(", ");
  const base = [artist, SpotifyPlayer.GetName() ?? SpotifyPlayer.GetId() ?? "lyrics"]
    .filter(Boolean)
    .join(" - ")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .slice(0, 120);
  const tag = source ? ` (${PROVIDER_LABELS[source]})` : "";

  const url = URL.createObjectURL(new Blob([ttml], { type: "application/ttml+xml;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${base}${tag}.ttml`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);

  const wrote = out.Type as ExportSync;
  toast.success(
    wrote === had || format === "original"
      ? `Saved ${base}${tag}.ttml (${SYNC_NAMES[wrote]})`
      : `Saved ${base}${tag}.ttml (${SYNC_NAMES[wrote]}, reduced from ${SYNC_NAMES[had]})`
  );
}
