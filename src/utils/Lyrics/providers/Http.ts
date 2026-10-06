const TIMEOUT_MS = 8000;

export function buildUrl(base: string, params: Record<string, string | number>): string {
  const query = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return `${base}?${query}`;
}

/**
 * GET a JSON endpoint that sends no CORS headers (NetEase, QQ Music). A plain
 * fetch() from Spotify's page is blocked for those hosts, so this goes through
 * Spicetify.CosmosAsync, which Spicetify routes through its own proxy. No Spotify
 * credentials are attached, but the request URL does pass through that proxy.
 */
export async function getViaCosmos(url: string, timeoutMs = TIMEOUT_MS): Promise<any> {
  const cosmos = (Spicetify as any).CosmosAsync;
  if (typeof cosmos?.get !== "function") throw new Error("Spicetify.CosmosAsync is unavailable");

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${new URL(url).host}`)), timeoutMs);
  });

  try {
    const res = await Promise.race([cosmos.get(url), timeout]);
    return typeof res === "string" ? JSON.parse(res) : res;
  } finally {
    clearTimeout(timer);
  }
}
