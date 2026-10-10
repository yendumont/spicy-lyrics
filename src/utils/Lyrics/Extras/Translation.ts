import { isDev } from "../../../components/Global/Defaults.ts";
import { GetExpireStore } from "../../../modules/Store.ts";
import Logger from "../../Logger.ts";
import { addExtra, clearExtras, flatten, type AppliedLine } from "./LineElements.ts";
import type { SyncWord } from "./SyncedWords.ts";
import { setSyncedTranslations } from "./TranslationSyncDriver.ts";

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

/** One request to Gemini; the answer as parsed JSON. */
async function askGemini(prompt: string, schema: object, apiKey: string, model: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          responseMimeType: "application/json",
          responseSchema: schema,
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
  return parsed;
}

async function translateChunk(lines: string[], language: string, apiKey: string, model: string): Promise<string[]> {
  const parsed = await askGemini(promptFor(lines, language), { type: "ARRAY", items: { type: "STRING" } }, apiKey, model);
  if (!Array.isArray(parsed) || parsed.length !== lines.length || parsed.some((t) => typeof t !== "string")) {
    throw new TranslationError("Gemini's answer did not match the lyrics line for line");
  }
  return parsed as string[];
}

/** A piece of a translated line and the number (from 1) of the sung word it lines up with. */
export type TranslationChunk = { t: string; w: number };

function syncedPromptFor(lines: string[][], language: string): string {
  const numbered = lines
    .map((words, i) => `${i + 1}. ${words.map((word, n) => `${n + 1}:${word}`).join(" ")}`)
    .join("\n");
  return [
    `You translate song lyrics into ${language}, lined up with the words as they are sung.`,
    `Each of the ${lines.length} numbered lines is given as its sung words, each tagged "number:word". Translate each line, keeping the meaning, tone and slang; do not censor or soften anything; do not merge or split lines.`,
    `Give each line's translation as consecutive chunks in reading order (a word or short phrase each). For every chunk, "w" is the number of the sung word it matches best. Within a line "w" never decreases; if the word order differs, pick the nearest sung word that keeps it that way. The chunks joined exactly make the translated line, so keep the spaces inside the chunks (at the end of each chunk but the last).`,
    `If a line is already in ${language} (even with slang, dialect or odd spelling), or is only sounds (ooh, yeah, la la), return an empty array [] for it. Never reword, correct or paraphrase a line that is already in ${language}.`,
    `Reply with a JSON array of exactly ${lines.length} arrays of {"t": chunk, "w": number}, in the same order.`,
    "",
    numbered,
  ].join("\n");
}

const SYNCED_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "ARRAY",
    items: { type: "OBJECT", properties: { t: { type: "STRING" }, w: { type: "INTEGER" } }, required: ["t", "w"] },
  },
};

async function translateSyncedChunk(lines: string[][], language: string, apiKey: string, model: string): Promise<string[]> {
  const parsed = await askGemini(syncedPromptFor(lines, language), SYNCED_SCHEMA, apiKey, model);
  if (!Array.isArray(parsed) || parsed.length !== lines.length || parsed.some((line) => !Array.isArray(line))) {
    throw new TranslationError("Gemini's answer did not match the lyrics line for line");
  }
  // One JSON string per line, so synced and plain translations share the cache.
  return (parsed as any[][]).map((chunks, i) => {
    let last = 1;
    const clean: TranslationChunk[] = [];
    for (const chunk of chunks) {
      if (typeof chunk?.t !== "string" || chunk.t === "") continue;
      const w = Math.min(lines[i].length, Math.max(last, Math.round(Number(chunk.w)) || last));
      clean.push({ t: chunk.t, w });
      last = w;
    }
    return JSON.stringify(clean);
  });
}

const inFlight = new Map<string, Promise<string[]>>();
/** When a request last failed, by key + model. A wrong key or model fails the same way every time, so it is not retried at once. */
const failedAt = new Map<string, { at: number; error: TranslationError }>();
const RETRY_AFTER_MS = 60_000;

/** `lines` translated into `language`, one string per line, kept for 60 days. */
export function translateLyrics(lines: string[], language: string, apiKey: string, model: string): Promise<string[]> {
  return translateAny(lines, false, language, apiKey, model);
}

/**
 * Like `translateLyrics`, but each line is given as its sung words and comes back as JSON
 * chunks (`TranslationChunk[]`) tied to those words, for translations that follow the singing.
 */
export function translateLyricsSynced(
  lines: string[][],
  language: string,
  apiKey: string,
  model: string
): Promise<TranslationChunk[][]> {
  return translateAny(lines, true, language, apiKey, model).then((rows) =>
    rows.map((row) => {
      try {
        const chunks = JSON.parse(row);
        return Array.isArray(chunks) ? (chunks as TranslationChunk[]) : [];
      } catch {
        return [];
      }
    })
  );
}

function translateAny(
  lines: (string | string[])[],
  synced: boolean,
  language: string,
  apiKey: string,
  model: string
): Promise<string[]> {
  const key = keyOf(language, synced ? lines.map((words) => `§${(words as string[]).join("\u0001")}`) : (lines as string[]));
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
        const part = lines.slice(i, i + CHUNK);
        out.push(
          ...(synced
            ? await translateSyncedChunk(part as string[][], language, apiKey, model)
            : await translateChunk(part as string[], language, apiKey, model))
        );
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
  setSyncedTranslations([]);
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

/**
 * Translations under word-synced lines, each in chunks that light up as the sung word they
 * match is sung. A line whose chunks are missing, or only repeat the line, gets none.
 */
export function decorateSyncedTranslations(lines: AppliedLine[], words: SyncWord[][], chunks: TranslationChunk[][]): void {
  clearExtras("translation");
  const driven: Parameters<typeof setSyncedTranslations>[0] = [];

  lines.forEach((line, i) => {
    const parts = chunks[i];
    const sung = words[i];
    if (!parts?.length || !sung?.length) return;
    if (sameLine(parts.map((p) => p.t).join(""), line.text)) return;

    // A chunk lasts from its word to the next chunk's word (or the end of the line); chunks
    // that share a word split its time between them.
    const lineEnd = sung[sung.length - 1].end;
    const startOf = (part: TranslationChunk) => sung[Math.min(sung.length, Math.max(1, part.w)) - 1].start;
    const el = document.createElement("div");
    el.className = "LineTranslation Synced";
    const timed: { el: HTMLElement; start: number; end: number }[] = [];

    let k = 0;
    while (k < parts.length) {
      let m = k;
      while (m + 1 < parts.length && parts[m + 1].w === parts[k].w) m++;
      const from = startOf(parts[k]);
      const to = m + 1 < parts.length ? startOf(parts[m + 1]) : lineEnd;
      const each = (to - from) / (m - k + 1);
      for (let n = k; n <= m; n++) {
        const span = document.createElement("span");
        span.className = "TrWord";
        span.textContent = parts[n].t;
        el.appendChild(span);
        timed.push({ el: span, start: from + each * (n - k), end: from + each * (n - k + 1) });
      }
      k = m + 1;
    }

    addExtra("translation", line.el, el);
    driven.push({ start: sung[0].start, end: lineEnd, chunks: timed });
  });

  setSyncedTranslations(driven);
}

export function removeTranslations(): void {
  setSyncedTranslations([]);
  clearExtras("translation");
}
