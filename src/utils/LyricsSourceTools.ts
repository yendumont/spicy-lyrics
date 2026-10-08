import { toast } from "sonner";
import { SpotifyPlayer } from "../components/Global/SpotifyPlayer.ts";
import PageView from "../components/Pages/PageView.ts";
import ApplyLyrics from "./Lyrics/Global/Applyer.ts";
import fetchLyrics from "./Lyrics/fetchLyrics.ts";
import { PROVIDER_LABELS } from "./Lyrics/providers/ProviderOrder.ts";
import { PickFor, RemovePick, SetPick } from "./Lyrics/providers/Sources.ts";
import type { LyricsProviderId } from "./Lyrics/providers/types.ts";
import { $currentLyricsData } from "./stores.ts";

function reload(uri: string): void {
  $currentLyricsData.set("");
  if (PageView.IsOpened) fetchLyrics(uri).then(ApplyLyrics);
}

/** Pin the playing song to one lyrics source and show that source's lyrics. */
export async function UseSourceForCurrentSong(id: LyricsProviderId): Promise<void> {
  const uri = SpotifyPlayer.GetUri();
  if (!uri) return;
  // A different source means different lyrics, so what was kept for the old pin goes.
  await RemovePick(uri);
  SetPick(uri, id);
  toast.success(`Showing ${PROVIDER_LABELS[id]} for this song`);
  reload(uri);
}

/**
 * Un-pin the playing song and go back to the automatic order. This is the only thing
 * that touches pinned lyrics: the other clear-cache buttons leave the choice alone.
 */
export async function ClearChosenSourceForCurrentSong(ui = false): Promise<void> {
  const uri = SpotifyPlayer.GetUri();
  if (!uri || !PickFor(uri)) {
    if (ui) toast.info("This song has no chosen source");
    return;
  }
  await RemovePick(uri);
  if (ui) toast.success("Back to the automatic source order for this song");
  reload(uri);
}
