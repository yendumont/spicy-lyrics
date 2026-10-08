/**
 * Genius proxy for the Spicy Lyrics fork. Deploy this as a Cloudflare Worker (see
 * RUNBOOK.md, "Genius fallback") and put its URL in Settings, Lyrics Display.
 *
 * Why it exists: Genius sends no CORS headers, so Spotify's page cannot read it,
 * and Spicetify's built-in proxy refuses Genius. This Worker fetches Genius on the
 * extension's behalf and adds the CORS header.
 *
 * It is not an open proxy. It serves exactly four things, from genius.com and
 * music.youtube.com only:
 *   GET /search?q=<text>        Genius song search (JSON); optional per_page (1-20), page (1-5)
 *   GET /lyrics?path=</x-lyrics>  a Genius lyrics page (HTML)
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
          Accept: url.pathname === "/search" ? "application/json" : "text/html",
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
