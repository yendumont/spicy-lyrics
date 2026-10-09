import { isDev } from "../../../components/Global/Defaults.ts";
import { GetExpireStore } from "../../../modules/Store.ts";
import Logger from "../../Logger.ts";
import { $geniusEagerMatch, $geniusFavoriteArtists, $geniusLooseSearch, $geniusProxyUrl } from "../../stores.ts";
import { normalizeProxyUrl, pickGeniusSong } from "../providers/Genius.ts";
import { ResolveTrack } from "../providers/Resolve.ts";
import { type Meaning, type Referent, meaningsFromReferents } from "./MeaningsCore.ts";

const logger = new Logger("Line Meanings");

export * from "./MeaningsCore.ts";

const MAX_PAGES = 4;
const TIMEOUT_MS = 10000;

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Genius proxy responded ${res.status}`);
  return res.json();
}

const store = GetExpireStore<Meaning[]>("SpicyLyrics_Meanings_g1", 1, { Unit: "Days", Duration: 7 }, isDev as true);

const pending = new Map<string, Promise<Meaning[]>>();

const keyOf = (uri: string): string => {
  let h = 5381;
  for (let i = 0; i < uri.length; i++) h = ((h << 5) + h + uri.charCodeAt(i)) | 0;
  return `m-${(h >>> 0).toString(36)}`;
};

async function load(uri: string, isStale: () => boolean): Promise<Meaning[]> {
  const base = normalizeProxyUrl($geniusProxyUrl.get());
  if (!base) return [];

  const cached = await store.GetItem(keyOf(uri)).catch(() => undefined);
  if (cached) return cached;

  // The song on Genius: the same matching the Genius lyrics provider uses, so a song it
  // can find lyrics for is a song this can find meanings for.
  const reading = (await ResolveTrack(isStale)).readings[0];
  if (!reading) return [];
  const pick = await pickGeniusSong(
    reading,
    $geniusProxyUrl.get(),
    $geniusLooseSearch.get(),
    $geniusFavoriteArtists
      .get()
      .split(/[,\n]/)
      .map((name) => name.trim())
      .filter(Boolean),
    $geniusEagerMatch.get()
  );
  if (!pick?.id) {
    logger.debug("No Genius song for", reading.name);
    return [];
  }

  // The Worker's own trimmed answer when it has one; an older Worker only has Genius's raw
  // pages, which are big, so those are asked for all at once.
  const trimmed = await getJson(`${base}/meanings?song_id=${pick.id}`);
  let meanings: Meaning[];
  if (trimmed) {
    meanings = Array.isArray(trimmed.meanings) ? (trimmed.meanings as Meaning[]) : [];
  } else {
    const bodies = await Promise.all(
      Array.from({ length: MAX_PAGES }, (_, i) =>
        getJson(`${base}/referents?song_id=${pick.id}&page=${i + 1}`).catch(() => null)
      )
    );
    // A Worker with neither endpoint answers 404. That says nothing about the song, so it
    // is not kept: after the Worker is updated the song works.
    if (bodies[0] === null) {
      logger.debug("The Worker has no line-meanings endpoint; redeploy it");
      return [];
    }
    meanings = meaningsFromReferents(bodies.flatMap((body) => (body?.response?.referents ?? []) as Referent[]));
  }
  logger.debug("Genius meanings", pick.path, meanings.length);
  // An empty answer is worth keeping too: a song with no annotations stays that way for a week.
  await store.SetItem(keyOf(uri), meanings).catch(() => undefined);
  return meanings;
}

/** Every meaning Genius has for the song at `uri` (all levels), fetched once and kept. */
export function getMeanings(uri: string, isStale: () => boolean = () => false): Promise<Meaning[]> {
  let promise = pending.get(uri);
  if (!promise) {
    promise = load(uri, isStale).catch((error) => {
      logger.warn("Could not load the line meanings", error);
      pending.delete(uri);
      return [];
    });
    // Nothing found is not kept in memory either, so a fixed Worker is picked up on the next play.
    void promise.then((found) => {
      if (found.length === 0) pending.delete(uri);
    });
    pending.set(uri, promise);
    // A few songs back is plenty; the persistent store holds the rest.
    while (pending.size > 5) pending.delete(pending.keys().next().value as string);
  }
  return promise;
}

