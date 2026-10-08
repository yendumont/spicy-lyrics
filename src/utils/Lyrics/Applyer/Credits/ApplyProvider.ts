const ProviderMap = {
    "spt": "Spotify",
    "aml": "Apple Music",
    "spl": "Spicy Lyrics",
    "ldb": "Local DB",
    "lrclib": "LRCLIB",
    "unison": "Unison",
    "netease": "NetEase",
    "qqmusic": "QQ Music",
    "genius": "Genius",
    "lrcmux": "LRCMux",
    "lrcred": "lrc.red",
    "kugou": "KuGou",
    "deezer": "Deezer",
    "musixmatch": "Musixmatch",
} as const;

export function ApplyLyricsProvider(data: any, LyricsContainer: HTMLElement): void {
  if (!data?.source || !LyricsContainer) return;

  const ProviderElement = document.createElement("div");
  ProviderElement.classList.add("LyricsProvider");

  let providerLabel = "Unknown";
  if (typeof data.source === "string") {
    const source = data.source.toLowerCase();
    const match = Object.entries(ProviderMap).find(([key]) => source.includes(key));
    if (match) providerLabel = match[1];
  }

  // An aggregator names the service it got the lyrics from ("LRCMux (KuGou)").
  const detail = typeof data.sourceDetail === "string" && data.sourceDetail ? ` (${data.sourceDetail})` : "";
  ProviderElement.textContent = `Provided by: ${providerLabel}${detail}`;
  LyricsContainer.appendChild(ProviderElement);
}