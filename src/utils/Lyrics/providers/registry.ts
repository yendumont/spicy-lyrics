/**
 * Every lyrics provider, in one place. The priority list, the settings and Lyrics
 * Sources panels, the credit line, the fetch loop (word-sync preference, upgrades),
 * pinning a song to a source, and the lookups for local files and podcast episodes
 * are all built from this, so none of them needs touching when a provider is added.
 *
 * TO ADD A PROVIDER:
 *   1. Write `providers/Foo.ts` exporting `fetchFromFoo(track: TrackInfo)`, which returns
 *      Spicy's lyrics shape (Static / Line / Syllable) with `source: "<creditKey>"`, or null.
 *   2. Add an entry to PROVIDER_META below, and its id to DEFAULT_ORDER.
 *   3. Add its fetcher to `fetchers` in `providers/index.ts`.
 * The compiler refuses to build until all three are done. Nothing else is needed.
 *
 * A fetcher is handed a TrackInfo. For a catalogue song that is the song itself; for a
 * local file or episode it is the song's catalogue entry (with its Spotify id, true title,
 * artists and length) when one was found, else guesses read from the file's title, so a
 * provider written for ordinary songs works unchanged on both.
 */

export type ProviderMeta = {
  /** The name shown in the lists and in the "Provided by" credit. */
  label: string;
  /** What the provider puts in `source` on its lyrics; the credit line is looked up by it. */
  creditKey: string;
  /** The best sync rank it can ever give (1 unsynced, 2 line, 3 word); one that cannot beat what is held is not asked. */
  maxRank?: 1 | 2 | 3;
};

export const PROVIDER_META = {
  lrclib: { label: "LRCLIB", creditKey: "lrclib" },
  unison: { label: "Unison", creditKey: "unison" },
  lrcred: { label: "lrc.red", creditKey: "lrcred" },
  lrcmux: { label: "LRCMux", creditKey: "lrcmux" },
  netease: { label: "NetEase", creditKey: "netease" },
  qqmusic: { label: "QQ Music", creditKey: "qqmusic" },
  kugou: { label: "KuGou", creditKey: "kugou" },
  kuwo: { label: "Kuwo", creditKey: "kuwo" },
  deezer: { label: "Deezer", creditKey: "deezer", maxRank: 2 },
  musixmatch: { label: "Musixmatch", creditKey: "musixmatch" },
  amll: { label: "AMLL TTML DB", creditKey: "amll" },
  binilyrics: { label: "BiniLyrics", creditKey: "binilyrics" },
  ytmusic: { label: "YouTube Music", creditKey: "youtubemusic", maxRank: 1 },
  genius: { label: "Genius", creditKey: "genius", maxRank: 1 },
} as const satisfies Record<string, ProviderMeta>;

export type ExternalProviderId = keyof typeof PROVIDER_META;
export type LyricsProviderId = "spicy" | ExternalProviderId;

/**
 * The built-in priority. Genius is last: it only has unsynced text, so with fallback on
 * it is a last resort. Every provider must be listed (checked below).
 */
const ORDER = [
  "spicy",
  "lrcred",
  "amll",
  "binilyrics",
  "musixmatch",
  "unison",
  "lrclib",
  "lrcmux",
  "netease",
  "qqmusic",
  "kugou",
  "kuwo",
  "deezer",
  "ytmusic",
  "genius",
] as const satisfies readonly LyricsProviderId[];

// A provider added to PROVIDER_META but not to ORDER fails to compile here.
type NotInOrder = Exclude<LyricsProviderId, (typeof ORDER)[number]>;
const _everyProviderIsOrdered: [NotInOrder] extends [never] ? true : never = true;
void _everyProviderIsOrdered;

export const DEFAULT_ORDER: LyricsProviderId[] = [...ORDER];

export const PROVIDER_LABELS: Record<LyricsProviderId, string> = {
  spicy: "Spicy Lyrics",
  ...(Object.fromEntries(
    Object.entries(PROVIDER_META).map(([id, meta]) => [id, meta.label])
  ) as Record<ExternalProviderId, string>),
};

/** The best sync rank a provider can ever return; the default is word sync. */
export const maxRankOf = (id: ExternalProviderId): number =>
  (PROVIDER_META[id] as ProviderMeta).maxRank ?? 3;
