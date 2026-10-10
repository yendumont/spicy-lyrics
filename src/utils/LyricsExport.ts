import { toast } from "sonner";
import { SpotifyPlayer } from "../components/Global/SpotifyPlayer.ts";
import { serializeTTML } from "./Lyrics/ttml/serialize.ts";
import { $currentLyricsData } from "./stores.ts";

/** The playing song's lyrics (as shown right now) saved to a `.ttml` file. */
export function ExportCurrentLyricsAsTTML(): void {
  const uri = SpotifyPlayer.GetUri();
  const raw = $currentLyricsData.get();
  let lyrics: any = null;
  try {
    lyrics = raw && !raw.startsWith("NO_LYRICS") ? JSON.parse(raw) : null;
  } catch {
    lyrics = null;
  }

  // The store can still hold the previous song for a moment after a skip.
  if (!uri || !lyrics || (lyrics.uri && lyrics.uri !== uri)) {
    toast.info("No lyrics are loaded for this song yet");
    return;
  }

  const ttml = serializeTTML(lyrics);
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

  const url = URL.createObjectURL(new Blob([ttml], { type: "application/ttml+xml;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${base}.ttml`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  toast.success(`Saved ${base}.ttml`);
}
