import { PROVIDER_META } from "../../providers/registry.ts";

// What a payload's `source` says, and the name to credit. The built-in sources are
// Spicy's own; every other provider comes from the registry, so a new one is credited
// without being listed here. A source name is matched by what it contains, so the
// longest key goes first: "amll" contains "aml".
const ProviderMap: [string, string][] = (
  [
    ["spt", "Spotify"],
    ["aml", "Apple Music"],
    ["spl", "Spicy Lyrics"],
    ["ldb", "Local DB"],
    ["embedded", "the song's own tags"],
    ...Object.values(PROVIDER_META).map((meta): [string, string] => [meta.creditKey, meta.label]),
  ] as [string, string][]
).sort((a, b) => b[0].length - a[0].length);

export function ApplyLyricsProvider(data: any, LyricsContainer: HTMLElement): void {
  if (!data?.source || !LyricsContainer) return;

  const ProviderElement = document.createElement("div");
  ProviderElement.classList.add("LyricsProvider");

  let providerLabel = "Unknown";
  if (typeof data.source === "string") {
    const source = data.source.toLowerCase();
    const match = ProviderMap.find(([key]) => source.includes(key));
    if (match) providerLabel = match[1];
  }

  // An aggregator names the service it got the lyrics from ("LRCMux (KuGou)").
  const detail = typeof data.sourceDetail === "string" && data.sourceDetail ? ` (${data.sourceDetail})` : "";
  ProviderElement.textContent = `Provided by: ${providerLabel}${detail}`;
  LyricsContainer.appendChild(ProviderElement);
}