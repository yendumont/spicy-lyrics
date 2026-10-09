/**
 * Genius proxy for the Spicy Lyrics fork. Deploy this as a Cloudflare Worker (see
 * RUNBOOK.md, "Genius fallback") and put its URL in Settings, Lyrics Display.
 *
 * Why it exists: Genius sends no CORS headers, so Spotify's page cannot read it,
 * and Spicetify's built-in proxy refuses Genius. This Worker fetches Genius on the
 * extension's behalf and adds the CORS header.
 *
 * It is not an open proxy. It serves exactly seven things, from genius.com,
 * music.youtube.com and Apple Music (itunes.apple.com, music.apple.com) only:
 *   GET /search?q=<text>        Genius song search (JSON); optional per_page (1-20), page (1-5)
 *   GET /lyrics?path=</x-lyrics>  a Genius lyrics page (HTML)
 *   GET /motion?id=<n>          an album's Apple Music animated cover, by Apple album id: {square, tall} stream URLs (JSON)
 *                               (older form, which searches too: /motion?artist=&album=)
 *   GET /meanings?song_id=<n>   the annotations on a Genius song, trimmed to what is shown (JSON)
 *   GET /referents?song_id=<n>  the same, as Genius sends them (JSON); optional page (1-5)
 *   GET /ytm/search?q=<text>    YouTube Music song search: {songs:[{videoId,title,artists,durationMs}]}
 *   GET /ytm/lyrics?videoId=<id>  a YouTube Music song's lyrics: {text, source}
 * and it only answers requests that come from Spotify's own page. It holds no
 * secrets and needs no environment variables.
 */

const ALLOWED_ORIGIN = "https://xpui.app.spotify.com";
// A lyrics page path looks like /Eminem-without-me-lyrics
const LYRICS_PATH = /^\/[\w\-.~%]{1,200}-lyrics$/;
const MAX_QUERY_LENGTH = 200;
const MAX_PER_PAGE = 20;
const MAX_PAGE = 5;

/** A whole number within [min, max], or null if absent or out of range. */
function boundedInt(value, min, max) {
  if (value === null || !/^\d{1,3}$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}
const CACHE_SECONDS = 60 * 60 * 24;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ── YouTube Music ────────────────────────────────────────────────────────────
// YouTube Music's web client calls this API from music.youtube.com itself. Like Genius
// it is out of reach of Spotify's page (no CORS, and Spicetify's proxy is refused), so
// this Worker makes the calls and sends back the few fields the extension needs.
const YTM_API = "https://music.youtube.com/youtubei/v1";
const YTM_CONTEXT = { client: { clientName: "WEB_REMIX", clientVersion: "1.20250310.01.00", hl: "en", gl: "US" } };
const YTM_SONGS_ONLY = "EgWKAQIIAWoKEAMQBBAJEAoQBQ%3D%3D";
const VIDEO_ID = /^[\w-]{11}$/;

async function ytm(path, body) {
  const res = await fetch(`${YTM_API}/${path}?prettyPrint=false`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
    body: JSON.stringify({ context: YTM_CONTEXT, ...body }),
  });
  if (!res.ok) throw new Error(`youtube music responded ${res.status}`);
  return res.json();
}

/** "3:24" or "1:02:03" in milliseconds. */
function clockToMs(clock) {
  const parts = clock.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((total, n) => total * 60 + n, 0) * 1000;
}

function collectSongs(node, out) {
  if (!node || typeof node !== "object") return;
  const item = node.musicResponsiveListItemRenderer;
  if (item) {
    const columns = (item.flexColumns ?? []).map((c) =>
      (c.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? []).map((r) => r.text).join("")
    );
    const videoId =
      item.playlistItemData?.videoId ??
      item.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint
        ?.watchEndpoint?.videoId;
    // "Artist • Album • 3:24": artists first, the length last.
    const details = (columns[1] ?? "").split("•").map((s) => s.trim());
    if (videoId && columns[0] && details.length >= 2) {
      out.push({
        videoId,
        title: columns[0],
        artists: (details[0] ?? "").split(/\s*(?:&|,)\s*/).filter(Boolean),
        durationMs: clockToMs(details[details.length - 1]),
      });
    }
  }
  for (const value of Object.values(node)) collectSongs(value, out);
}

async function ytmSearch(q) {
  const songs = [];
  collectSongs(await ytm("search", { query: q, params: YTM_SONGS_ONLY }), songs);
  return { songs: songs.slice(0, 10) };
}

async function ytmLyrics(videoId) {
  const next = await ytm("next", { videoId });
  const tabs = next?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs ?? [];
  const tab = tabs.map((t) => t.tabRenderer).find((t) => /lyrics/i.test(t?.title ?? ""));
  const browseId = tab && !tab.unselectable ? tab.endpoint?.browseEndpoint?.browseId : undefined;
  if (!browseId) return { text: null };

  const page = await ytm("browse", { browseId });
  const shelf = page?.contents?.sectionListRenderer?.contents?.[0]?.musicDescriptionShelfRenderer;
  const text = (shelf?.description?.runs ?? []).map((r) => r.text).join("").trim();
  const footer = (shelf?.footer?.runs ?? []).map((r) => r.text).join("").replace(/^Source:\s*/i, "").trim();
  return { text: text || null, source: footer || null };
}

// ── Line meanings ────────────────────────────────────────────────────────────
// Genius's /referents answer is large (about half a megabyte a page, with every author of
// every annotation), and a song takes up to three pages. This fetches the pages at once and
// sends back only what the extension shows, a fraction of the size.
const MEANING_PAGES = 3;

function meaningLevel(referent) {
  const annotation = referent.annotations?.[0];
  if (referent.classification === "verified" || annotation?.verified) return "artist";
  if (referent.classification === "accepted" || annotation?.state === "accepted") return "editor";
  return "community";
}

async function geniusMeanings(songId) {
  const page = async (n) => {
    const res = await fetch(
      `https://genius.com/api/referents?song_id=${songId}&text_format=plain&per_page=50&page=${n}`,
      {
        headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9", Accept: "application/json" },
        cf: { cacheEverything: true, cacheTtl: CACHE_SECONDS },
      }
    );
    if (!res.ok) throw new Error(`genius responded ${res.status}`);
    return (await res.json())?.response?.referents ?? [];
  };

  // Later pages of a song with few annotations are empty and cheap; only the first must succeed.
  const pages = await Promise.all(
    Array.from({ length: MEANING_PAGES }, (_, i) => page(i + 1).catch((error) => (i === 0 ? Promise.reject(error) : [])))
  );

  const meanings = [];
  for (const referent of pages.flat()) {
    if (referent.is_description || referent.is_image) continue;
    const annotation = referent.annotations?.[0];
    const text = annotation?.body?.plain?.trim();
    const fragment = referent.fragment?.trim();
    if (!text || !fragment) continue;
    const level = meaningLevel(referent);
    meanings.push({
      fragment,
      text,
      level,
      votes: annotation?.votes_total ?? 0,
      author:
        level === "artist"
          ? (annotation?.verified_by?.name ?? annotation?.verified_by?.login)
          : (annotation?.authors?.[0]?.user?.name ?? annotation?.authors?.[0]?.user?.login),
      url: annotation?.url ?? referent.url,
    });
  }
  return { meanings };
}

// ── Animated album covers (Apple Music) ──────────────────────────────────────
// Apple's album pages carry each album's animated artwork as an HLS stream. The pages send
// no CORS headers, so the Worker finds the album (iTunes search) and reads the stream's
// address off the page.
const APPLE_PAGE = /^https:\/\/music\.apple\.com\/[a-z]{2}\/album\/[\w\-.~%]+\/\d+$/;

const plain = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/\s-\s.*$/, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "");

/** The stream under `motionDetailSquare` / `motionDetailTall` in an album page. */
function motionUrl(html, key) {
  const at = html.indexOf(key);
  if (at === -1) return null;
  const found = html.slice(at, at + 4000).match(/video\\?":\\?"(https:[^"\\]+?\.m3u8)/);
  return found ? found[1].replace(/\\\//g, "/") : null;
}

/**
 * An album's animated cover by its Apple Music id. The extension finds the id itself (Apple
 * rate-limits searches made from shared Worker addresses, but not from the listener's own),
 * so the Worker only has to read the album page, whatever slug the address has.
 */
async function appleMotionById(id) {
  const res = await fetch(`https://music.apple.com/us/album/x/${id}`, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
    cf: { cacheEverything: true, cacheTtl: CACHE_SECONDS },
  });
  if (!res.ok) throw new Error(`apple music responded ${res.status}`);
  const html = await res.text();
  const square = motionUrl(html, "motionDetailSquare");
  return square ? { id: Number(id), square, tall: motionUrl(html, "motionDetailTall") } : {};
}

async function appleMotion(artist, album) {
  const search = await fetch(
    `https://itunes.apple.com/search?term=${encodeURIComponent(`${artist} ${album}`)}&entity=album&limit=8&country=us`,
    { cf: { cacheEverything: true, cacheTtl: CACHE_SECONDS } }
  );
  if (!search.ok) throw new Error(`itunes responded ${search.status}`);
  const wantArtist = plain(artist);
  const wantAlbum = plain(album);

  const matches = ((await search.json()).results ?? [])
    .filter((r) => {
      const a = plain(r.artistName);
      const c = plain(r.collectionName);
      return (
        a && c && (a.includes(wantArtist) || wantArtist.includes(a)) && (c === wantAlbum || c.includes(wantAlbum) || wantAlbum.includes(c))
      );
    })
    // The album named exactly as asked, then the rest.
    .sort((x, y) => Number(plain(y.collectionName) === wantAlbum) - Number(plain(x.collectionName) === wantAlbum));

  for (const result of matches.slice(0, 2)) {
    const page = (result.collectionViewUrl ?? "").replace(/\?.*$/, "");
    if (!APPLE_PAGE.test(page)) continue;
    const res = await fetch(page, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
      cf: { cacheEverything: true, cacheTtl: CACHE_SECONDS },
    });
    if (!res.ok) continue;
    const html = await res.text();
    const square = motionUrl(html, "motionDetailSquare");
    if (square) return { album: result.collectionName, id: result.collectionId, square, tall: motionUrl(html, "motionDetailTall") };
  }
  return {};
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    Vary: "Origin",
  };
}

function reply(body, status, extra = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json",
      ...extra,
    },
  });
}

export default {
  async fetch(request) {
    // Browsers always send Origin on cross-site requests; refuse anything but Spotify.
    const origin = request.headers.get("Origin");
    if (origin && origin !== ALLOWED_ORIGIN) return reply({ error: "forbidden origin" }, 403);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
    if (request.method !== "GET") return reply({ error: "method not allowed" }, 405);

    const url = new URL(request.url);
    let target;

    if (url.pathname === "/ytm/search" || url.pathname === "/ytm/lyrics") {
      try {
        if (url.pathname === "/ytm/search") {
          const q = (url.searchParams.get("q") ?? "").trim();
          if (!q || q.length > MAX_QUERY_LENGTH) return reply({ error: "bad query" }, 400);
          return reply(await ytmSearch(q), 200, { "Cache-Control": "public, max-age=3600" });
        }
        const videoId = url.searchParams.get("videoId") ?? "";
        if (!VIDEO_ID.test(videoId)) return reply({ error: "bad video id" }, 400);
        return reply(await ytmLyrics(videoId), 200, { "Cache-Control": "public, max-age=3600" });
      } catch (error) {
        return reply({ error: String(error?.message ?? error) }, 502);
      }
    }

    if (url.pathname === "/motion") {
      const id = url.searchParams.get("id") ?? "";
      if (/^\d{5,12}$/.test(id)) {
        try {
          return reply(await appleMotionById(id), 200, { "Cache-Control": "public, max-age=3600" });
        } catch (error) {
          return reply({ error: String(error?.message ?? error) }, 502);
        }
      }
      const artist = (url.searchParams.get("artist") ?? "").trim();
      const album = (url.searchParams.get("album") ?? "").trim();
      if (!artist || !album || artist.length > MAX_QUERY_LENGTH || album.length > MAX_QUERY_LENGTH) {
        return reply({ error: "bad query" }, 400);
      }
      try {
        return reply(await appleMotion(artist, album), 200, { "Cache-Control": "public, max-age=3600" });
      } catch (error) {
        return reply({ error: String(error?.message ?? error) }, 502);
      }
    }

    if (url.pathname === "/meanings") {
      const songId = url.searchParams.get("song_id") ?? "";
      if (!/^\d{1,12}$/.test(songId)) return reply({ error: "bad song id" }, 400);
      try {
        return reply(await geniusMeanings(songId), 200, { "Cache-Control": "public, max-age=3600" });
      } catch (error) {
        return reply({ error: String(error?.message ?? error) }, 502);
      }
    }

    if (url.pathname === "/search") {
      const q = (url.searchParams.get("q") ?? "").trim();
      if (!q || q.length > MAX_QUERY_LENGTH) return reply({ error: "bad query" }, 400);
      // Optional: more results, and later pages, for searches where the right song is
      // buried under better-known ones. Without them: Genius's usual top five.
      const perPage = boundedInt(url.searchParams.get("per_page"), 1, MAX_PER_PAGE);
      const page = boundedInt(url.searchParams.get("page"), 1, MAX_PAGE);
      target =
        perPage || page
          ? `https://genius.com/api/search/song?per_page=${perPage ?? 5}&page=${page ?? 1}&q=${encodeURIComponent(q)}`
          : `https://genius.com/api/search/multi?per_page=5&q=${encodeURIComponent(q)}`;
    } else if (url.pathname === "/referents") {
      // The annotations on a song's lyrics ("line meanings"), 50 to a page.
      const songId = url.searchParams.get("song_id") ?? "";
      if (!/^\d{1,12}$/.test(songId)) return reply({ error: "bad song id" }, 400);
      const page = boundedInt(url.searchParams.get("page"), 1, MAX_PAGE) ?? 1;
      target = `https://genius.com/api/referents?song_id=${songId}&text_format=plain&per_page=50&page=${page}`;
    } else if (url.pathname === "/lyrics") {
      const path = url.searchParams.get("path") ?? "";
      if (!LYRICS_PATH.test(path)) return reply({ error: "bad path" }, 400);
      target = `https://genius.com${path}`;
    } else {
      return reply({ error: "not found" }, 404);
    }

    let upstream;
    try {
      upstream = await fetch(target, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Language": "en-US,en;q=0.9",
          Accept: url.pathname === "/search" || url.pathname === "/referents" ? "application/json" : "text/html",
        },
        // Cloudflare-only: keep Genius's answer for a day so repeat plays do not hit it again.
        cf: { cacheEverything: true, cacheTtl: CACHE_SECONDS },
      });
    } catch {
      return reply({ error: "could not reach genius" }, 502);
    }

    if (!upstream.ok) return reply({ error: `genius responded ${upstream.status}` }, 502);

    return new Response(upstream.body, {
      status: 200,
      headers: {
        ...corsHeaders(),
        "Content-Type": upstream.headers.get("Content-Type") ?? "text/plain",
        "Cache-Control": "public, max-age=3600",
      },
    });
  },
};
