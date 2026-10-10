import { isDev } from "../../../components/Global/Defaults.ts";
import { GetExpireStore } from "../../../modules/Store.ts";
import Logger from "../../Logger.ts";
import { addExtra, clearExtras, flatten, type AppliedLine } from "./LineElements.ts";

const logger = new Logger("Translation");

// The lyrics go to Google's Gemini API with the listener's own key, and nowhere else.
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const TIMEOUT_MS = 45000;
// A song is one request; a very long one is split so the answer stays reliable.
const CHUNK = 70;

const store = GetExpireStore<string[]>("SpicyLyrics_Translations_g1", 1, { Unit: "Days", Duration: 60 }, isDev as true);

/** Why a translation could not be made, in words for the listener. */
export class TranslationError extends Error {}

const keyOf = (language: string, lines: string[]): string => {
  const text = `${language.toLowerCase()}\n${lines.join("\n")}`;
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `t2-${(h >>> 0).toString(36)}-${lines.length}`;
};

const SAFETY_CATEGORIES = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
];

function promptFor(lines: string[], language: string): string {
  const numbered = lines.map((line, i) => `${i + 1}. ${line}`).join("\n");
  return [
    `You translate song lyrics into ${language}.`,
    `Translate each of the ${lines.length} numbered lines. Keep the meaning, tone and slang; do not censor or soften anything; do not merge or split lines.`,
    `If a line is already in ${language} (even with slang, dialect or odd spelling), or is only sounds (ooh, yeah, la la), return an empty string "" for it. Never reword, correct or paraphrase a line that is already in ${language}.`,
    `Reply with a JSON array of exactly ${lines.length} strings, in the same order, with no numbering.`,
    "",
    numbered,
  ].join("\n");
}

async function translateChunk(lines: string[], language: string, apiKey: string, model: string): Promise<string[]> {
  let response: Response;
  try {
    response = await fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: promptFor(lines, language) }] }],
        generationConfig: {
          temperature: 0.3,
          responseMimeType: "application/json",
          responseSchema: { type: "ARRAY", items: { type: "STRING" } },
        },
        // Lyrics are often explicit; refusing to translate them helps nobody.
        safetySettings: SAFETY_CATEGORIES.map((category) => ({ category, threshold: "BLOCK_NONE" })),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new TranslationError(`Could not reach Gemini (${error instanceof Error ? error.message : error})`);
  }

  const body: any = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body?.error?.message ?? `HTTP ${response.status}`;
    if (response.status === 400 && /api key/i.test(message)) throw new TranslationError("The Gemini API key was not accepted");
    if (response.status === 404) throw new TranslationError(`Gemini has no model called "${model}"`);
    if (response.status === 429) throw new TranslationError("Gemini says you are over your limit; try again in a minute");
    throw new TranslationError(`Gemini: ${String(message).slice(0, 140)}`);
  }

  const candidate = body?.candidates?.[0];
  const text: string | undefined = candidate?.content?.parts?.map((p: any) => p?.text ?? "").join("");
  if (!text) {
    throw new TranslationError(
      body?.promptFeedback?.blockReason
        ? `Gemini declined these lyrics (${body.promptFeedback.blockReason})`
        : `Gemini sent no translation${candidate?.finishReason ? ` (${candidate.finishReason})` : ""}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TranslationError("Gemini's answer could not be read");
  }
  if (!Array.isArray(parsed) || parsed.length !== lines.length || parsed.some((t) => typeof t !== "string")) {
    throw new TranslationError("Gemini's answer did not match the lyrics line for line");
  }
  return parsed as string[];
}

const inFlight = new Map<string, Promise<string[]>>();
/** When a request last failed, by key + model. A wrong key or model fails the same way every time, so it is not retried at once. */
const failedAt = new Map<string, { at: number; error: TranslationError }>();
const RETRY_AFTER_MS = 60_000;

/** `lines` translated into `language`, one string per line, kept for 60 days. */
export function translateLyrics(lines: string[], language: string, apiKey: string, model: string): Promise<string[]> {
  const key = keyOf(language, lines);
  const attempt = `${apiKey}|${model}`;
  const failed = failedAt.get(attempt);
  if (failed && Date.now() - failed.at < RETRY_AFTER_MS) return Promise.reject(failed.error);

  let promise = inFlight.get(key);
  if (!promise) {
    promise = (async () => {
      const cached = await store.GetItem(key).catch(() => undefined);
      if (cached && cached.length === lines.length) return cached;

      const out: string[] = [];
      for (let i = 0; i < lines.length; i += CHUNK) {
        out.push(...(await translateChunk(lines.slice(i, i + CHUNK), language, apiKey, model)));
      }
      await store.SetItem(key, out).catch(() => undefined);
      return out;
    })();
    inFlight.set(key, promise);
    // A failure is not kept: the next song, or the next attempt, tries again.
    promise.catch((error) => {
      logger.warn("Translation failed", error);
      inFlight.delete(key);
      // Only what a retry cannot fix; a dropped connection may be tried again at once.
      if (error instanceof TranslationError && !/Could not reach/.test(error.message)) {
        failedAt.set(attempt, { at: Date.now(), error });
      }
    });
  }
  return promise;
}

/** Whether two lines say the same thing, give or take punctuation, case and a stray word or two. */
function sameLine(a: string, b: string): boolean {
  const x = flatten(a);
  const y = flatten(b);
  if (x === y) return true;
  if (!x || !y || Math.abs(x.length - y.length) > Math.max(x.length, y.length) * 0.2) return false;
  // Levenshtein distance over a rolling row; lines are short.
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[y.length] <= Math.max(x.length, y.length) * 0.15;
}

/** Put each translation under its line. A line the translation leaves (or nearly leaves) as it was gets none. */
export function decorateTranslations(lines: AppliedLine[], translations: string[]): void {
  clearExtras("translation");
  lines.forEach((line, i) => {
    const text = translations[i]?.trim();
    if (!text || sameLine(text, line.text)) return;

    const el = document.createElement("div");
    el.className = "LineTranslation";
    el.textContent = text;
    addExtra("translation", line.el, el);
  });
}

export function removeTranslations(): void {
  clearExtras("translation");
}
