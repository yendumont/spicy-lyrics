import React, { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AUDIO_ACCEPT,
  clearLibrary,
  scanFiles,
  scanSummary,
  type ScanSummary,
} from "../../../utils/LocalEmbed/Library.ts";
import { convertTtml, type Conversion, type LrcPrecision } from "../../../utils/LocalEmbed/TtmlToLrc.ts";
import { Row, Select } from "./components.tsx";

/**
 * The two panels the local-file experiments bring (see `tool` in utils/experiments.ts): choosing
 * the music folder whose tags are read, and turning a TTML file into LRC text.
 */

function describe(summary: ScanSummary | null): string {
  if (!summary) {
    return "Nothing read yet. Choose the folder your local music is in (or some files); only their tags are read, on this PC, and the lyrics kept here.";
  }
  const { word, line, plain } = summary.kinds;
  const parts = [word && `${word} word-synced`, line && `${line} line-synced`, plain && `${plain} unsynced`].filter(Boolean);
  const when = new Date(summary.at).toLocaleString();
  return `Last read ${when}: ${summary.scanned} music files, ${
    summary.withLyrics ? `${summary.withLyrics} with lyrics (${parts.join(", ")})` : "none with lyrics in their tags"
  }. Playing a song again picks up new lyrics.`;
}

export function EmbeddedLyricsTool() {
  const [summary, setSummary] = useState<ScanSummary | null>(null);
  const [busy, setBusy] = useState("");
  const folder = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void scanSummary().then(setSummary);
    // Choosing a whole folder needs this attribute, which React does not know about.
    folder.current?.setAttribute("webkitdirectory", "");
  }, []);

  const run = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setBusy("Reading…");
    try {
      const result = await scanFiles(Array.from(list), (done, total) => setBusy(`Reading ${done} of ${total}…`));
      setSummary(result);
      toast.success(
        result.withLyrics ? `Found lyrics in ${result.withLyrics} of ${result.scanned} files` : `Read ${result.scanned} files; none had lyrics in their tags`
      );
    } catch (error) {
      toast.error(`Could not read the files: ${error instanceof Error ? error.message : error}`);
    } finally {
      setBusy("");
    }
  };

  return (
    <Row stacked label="Your music" description={busy || describe(summary)}>
      <div className="sl-sp-source-actions">
        <input ref={folder} type="file" multiple hidden onChange={(e) => void run(e.currentTarget.files).then(() => (e.currentTarget.value = ""))} />
        <input ref={files} type="file" multiple hidden accept={AUDIO_ACCEPT} onChange={(e) => void run(e.currentTarget.files).then(() => (e.currentTarget.value = ""))} />
        <button className="sl-sp-btn" disabled={!!busy} onClick={() => folder.current?.click()}>
          Choose folder…
        </button>
        <button className="sl-sp-btn" disabled={!!busy} onClick={() => files.current?.click()}>
          Choose files…
        </button>
        <button
          className="sl-sp-btn"
          disabled={!!busy || !summary}
          onClick={async () => {
            await clearLibrary();
            setSummary(null);
            toast.success("Forgot the lyrics read from your files");
          }}
        >
          Clear
        </button>
      </div>
    </Row>
  );
}

type Result = { name: string; conversion: Conversion };

const KIND: Record<string, string> = { word: "word-timed (enhanced LRC)", line: "line-timed (LRC)", plain: "untimed (plain lines)" };

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Copied");
  } catch {
    toast.error("Could not copy; use Download instead");
  }
}

export function TtmlToLrcTool() {
  const [precision, setPrecision] = useState<LrcPrecision>("centiseconds");
  const [results, setResults] = useState<Result[]>([]);
  const [pasted, setPasted] = useState("");
  const input = useRef<HTMLInputElement>(null);
  // What was chosen, so changing the precision converts the same files again.
  const sources = useRef<{ name: string; text: string }[]>([]);

  const convertAll = (sourcesNow: { name: string; text: string }[], p: LrcPrecision) =>
    setResults(sourcesNow.map(({ name, text }) => ({ name, conversion: convertTtml(text, p) })));

  const choose = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const read = await Promise.all(Array.from(list).map(async (file) => ({ name: file.name, text: await file.text() })));
    sources.current = read;
    convertAll(read, precision);
  };

  const outputName = (name: string) => name.replace(/\.(ttml|xml)$/i, "") + ".lrc";

  return (
    <Row
      stacked
      label="Convert a TTML"
      description="Choose TTML files, or paste one below. Word-timed ones become enhanced LRC. Put the result in your song's lyrics tag with a tag editor, then read the folder again above."
    >
      <div className="sl-sp-tool">
        <div className="sl-sp-source-actions">
          <input ref={input} type="file" multiple hidden accept=".ttml,.xml,application/ttml+xml,text/xml" onChange={(e) => void choose(e.currentTarget.files).then(() => (e.currentTarget.value = ""))} />
          <button className="sl-sp-btn" onClick={() => input.current?.click()}>
            Choose TTML files…
          </button>
          <Select
            value={precision}
            options={["centiseconds", "milliseconds"]}
            labels={["Centiseconds (most players)", "Milliseconds (more exact)"]}
            onChange={(v) => {
              setPrecision(v as LrcPrecision);
              if (sources.current.length) convertAll(sources.current, v as LrcPrecision);
            }}
          />
        </div>

        <textarea
          className="sl-sp-tool-text"
          placeholder="…or paste the TTML text here"
          spellCheck={false}
          value={pasted}
          onChange={(e) => setPasted(e.currentTarget.value)}
        />
        <div className="sl-sp-source-actions">
          <button
            className="sl-sp-btn"
            disabled={!pasted.trim()}
            onClick={() => {
              sources.current = [{ name: "pasted.ttml", text: pasted }];
              convertAll(sources.current, precision);
            }}
          >
            Convert pasted text
          </button>
        </div>

        {results.map(({ name, conversion }, i) => (
          <div key={`${name}-${i}`} className="sl-sp-tool-result">
            <div className="sl-sp-tool-result-head">
              <span className="sl-sp-tool-name">{name}</span>
              {conversion.ok ? (
                <>
                  <span className="sl-sp-tool-kind">{KIND[conversion.kind]}</span>
                  <button className="sl-sp-btn" onClick={() => download(outputName(name), conversion.lrc)}>
                    Download
                  </button>
                  <button className="sl-sp-btn" onClick={() => void copy(conversion.lrc)}>
                    Copy
                  </button>
                </>
              ) : (
                <span className="sl-sp-tool-error">{"error" in conversion ? conversion.error : ""}</span>
              )}
            </div>
            {conversion.ok && <textarea className="sl-sp-tool-text" readOnly value={conversion.lrc} />}
          </div>
        ))}
      </div>
    </Row>
  );
}
