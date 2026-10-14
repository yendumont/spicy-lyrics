/**
 * Reads what an audio file says about itself, without a library: its title, artists and album,
 * and any lyrics put in its tags. Works on a `Blob` (a `File` from a file picker is one) and
 * only reads the parts of it that hold tags, so a folder of songs is quick to go through.
 *
 *   MP3 (ID3v2.2 / 2.3 / 2.4)    USLT, SYLT and TXXX frames
 *   FLAC, Ogg Vorbis, Ogg Opus   Vorbis comments (LYRICS, UNSYNCEDLYRICS, SYNCEDLYRICS …)
 *   M4A / MP4                    the ©lyr atom
 */

export type SyncedEntry = { time: number; text: string };

export type FileTags = {
  title?: string;
  artists: string[];
  album?: string;
  /** Every lyrics text the tags hold (plain, LRC or enhanced LRC), best guess first. */
  lyrics: string[];
  /** Line-timed lyrics from an ID3 SYLT frame. */
  synced?: SyncedEntry[];
};

const MAX_ID3 = 24 * 1024 * 1024;
const MAX_ATOM = 64 * 1024 * 1024;
const MAX_OGG = 8 * 1024 * 1024;

async function bytes(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(start, Math.max(start, end)).arrayBuffer());
}

const ascii = (buf: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...buf.subarray(start, end));

const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u32le = (b: Uint8Array, o: number) => ((b[o + 3] << 24) | (b[o + 2] << 16) | (b[o + 1] << 8) | b[o]) >>> 0;
const u24be = (b: Uint8Array, o: number) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
const syncsafe = (b: Uint8Array, o: number) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];

const empty = (): FileTags => ({ artists: [], lyrics: [] });

/** Text from a tag without the padding NULs some taggers leave at its end, or a byte order mark at its start. */
function clean(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0) end--;
  const trimmed = text.slice(0, end);
  return trimmed.charCodeAt(0) === 0xfeff ? trimmed.slice(1) : trimmed;
}

// ---- ID3v2 (MP3, and some FLAC / others that carry one up front) -----------------------------

function unsync(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    out[n++] = data[i];
    if (data[i] === 0xff && data[i + 1] === 0x00) i++;
  }
  return out.subarray(0, n);
}

function decodeId3(encoding: number, data: Uint8Array): string {
  if (encoding === 1) {
    const bigEndian = data[0] === 0xfe && data[1] === 0xff;
    const body = data[0] === 0xff || data[0] === 0xfe ? data.subarray(2) : data;
    return clean(new TextDecoder(bigEndian ? "utf-16be" : "utf-16le").decode(body));
  }
  if (encoding === 2) return clean(new TextDecoder("utf-16be").decode(data));
  if (encoding === 3) return clean(new TextDecoder("utf-8").decode(data));
  return clean(new TextDecoder("windows-1252").decode(data));
}

/** The index of the terminator of a string that starts at `from` (and its width), or the end. */
function terminator(encoding: number, data: Uint8Array, from: number): { at: number; width: number } {
  if (encoding === 1 || encoding === 2) {
    for (let i = from; i + 1 < data.length; i += 2) {
      if (data[i] === 0 && data[i + 1] === 0) return { at: i, width: 2 };
    }
    return { at: data.length, width: 0 };
  }
  for (let i = from; i < data.length; i++) if (data[i] === 0) return { at: i, width: 1 };
  return { at: data.length, width: 0 };
}

function id3Text(frame: Uint8Array): string {
  if (frame.length < 2) return "";
  const encoding = frame[0];
  const stop = terminator(encoding, frame, 1);
  return decodeId3(encoding, frame.subarray(1, stop.at));
}

function readUslt(frame: Uint8Array): string {
  if (frame.length < 5) return "";
  const encoding = frame[0];
  const stop = terminator(encoding, frame, 4); // after the 3-letter language
  return decodeId3(encoding, frame.subarray(stop.at + stop.width));
}

function readSylt(frame: Uint8Array): SyncedEntry[] {
  if (frame.length < 7) return [];
  const encoding = frame[0];
  const format = frame[4]; // 1 = MPEG frames, 2 = milliseconds
  if (format !== 2) return [];
  const description = terminator(encoding, frame, 6);
  let pos = description.at + description.width;

  const entries: SyncedEntry[] = [];
  while (pos < frame.length) {
    const stop = terminator(encoding, frame, pos);
    if (stop.width === 0 || stop.at + stop.width + 4 > frame.length) break;
    const text = decodeId3(encoding, frame.subarray(pos, stop.at)).replace(/^\n+/, "");
    const time = u32be(frame, stop.at + stop.width) / 1000;
    pos = stop.at + stop.width + 4;
    entries.push({ time, text: text.replace(/\n+$/, "") });
  }
  return entries;
}

function readTxxx(frame: Uint8Array): { description: string; value: string } {
  if (frame.length < 2) return { description: "", value: "" };
  const encoding = frame[0];
  const stop = terminator(encoding, frame, 1);
  return {
    description: decodeId3(encoding, frame.subarray(1, stop.at)),
    value: decodeId3(encoding, frame.subarray(stop.at + stop.width)),
  };
}

const LYRICS_TXXX = /^(un)?synced\s*lyrics$|^lyrics$|^lyrics[-_ ]|^lrc$/i;

const KNOWN_FRAME = /^(?:T[A-Z0-9]{3}|W[A-Z0-9]{3}|COMM|USLT|SYLT|APIC|PRIV|POPM|UFID|GEOB|COMR|USER|OWNE|PCNT|RVA2|ETCO|MCDI)$/;

/** Whether a frame header, padding, or the end of the tag starts at `at`. */
function endsAtFrame(body: Uint8Array, at: number): boolean {
  if (at === body.length) return true;
  if (at + 10 > body.length) return false;
  if (body[at] === 0) return true;
  for (let i = 0; i < 4; i++) {
    const c = body[at + i];
    if (!((c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39))) return false;
  }
  return true;
}

function parseId3Body(version: number, headerFlags: number, raw: Uint8Array, into: FileTags): void {
  let body = raw;
  if (headerFlags & 0x80 && version < 4) body = unsync(body);

  let pos = 0;
  if (headerFlags & 0x40 && body.length > 4) {
    pos = version === 4 ? syncsafe(body, 0) : 4 + u32be(body, 0);
  }

  const headerLength = version === 2 ? 6 : 10;
  while (pos + headerLength <= body.length) {
    const id = ascii(body, pos, pos + (version === 2 ? 3 : 4));
    if (id.charCodeAt(0) === 0) break;
    let size = version === 2 ? u24be(body, pos + 3) : version === 4 ? syncsafe(body, pos + 4) : u32be(body, pos + 4);
    if (version === 4) {
      // Some taggers write a v2.3-style plain size into a v2.4 tag. If the syncsafe size does not end
      // at another frame (or padding) but the plain one does, the plain one is right.
      const plain = u32be(body, pos + 4);
      if (plain !== size && !endsAtFrame(body, pos + headerLength + size) && endsAtFrame(body, pos + headerLength + plain)) size = plain;
    }
    const flags = version === 2 ? 0 : (body[pos + 8] << 8) | body[pos + 9];
    // A tagger that counted characters instead of bytes leaves a frame's size a few bytes short of
    // where the next frame really starts. If the size does not end at a frame, look just past it.
    if (version >= 3 && size > 0 && !endsAtFrame(body, pos + headerLength + size)) {
      for (let extra = 1; extra <= 64; extra++) {
        const at = pos + headerLength + size + extra;
        if (at + 10 > body.length) break;
        if (KNOWN_FRAME.test(ascii(body, at, at + 4))) {
          size += extra;
          break;
        }
      }
    }
    const start = pos + headerLength;
    pos = start + size;
    if (size <= 0 || pos > body.length) break;

    let frame = body.subarray(start, start + size);
    if (version === 4) {
      if (flags & 0x000c) continue; // compressed or encrypted
      if (flags & 0x0001) frame = frame.subarray(4); // data length indicator
      if (flags & 0x0002) frame = unsync(frame);
    } else if (version === 3) {
      if (flags & 0x00c0) continue;
      if (flags & 0x0020) frame = frame.subarray(1); // grouping
    }

    switch (id) {
      case "TIT2":
      case "TT2":
        into.title ||= id3Text(frame);
        break;
      case "TPE1":
      case "TP1":
        // v2.4 separates several artists with a NUL, older tags with "/" or ";"
        into.artists.push(...id3Text(frame).split("\u0000").filter(Boolean));
        break;
      case "TALB":
      case "TAL":
        into.album ||= id3Text(frame);
        break;
      case "USLT":
      case "ULT": {
        const text = readUslt(frame);
        if (text.trim()) into.lyrics.push(text);
        break;
      }
      case "SYLT":
      case "SLT": {
        const entries = readSylt(frame);
        if (entries.length > (into.synced?.length ?? 0)) into.synced = entries;
        break;
      }
      case "TXXX":
      case "TXX": {
        const { description, value } = readTxxx(frame);
        if (LYRICS_TXXX.test(description.trim()) && value.trim()) into.lyrics.push(value);
        break;
      }
    }
  }
}

/** Parses an ID3v2 tag at the start of the file; returns the offset of whatever follows it. */
async function readId3(file: Blob, into: FileTags): Promise<number> {
  const head = await bytes(file, 0, 10);
  if (ascii(head, 0, 3) !== "ID3") return 0;
  const version = head[3];
  const size = syncsafe(head, 6);
  if ((version !== 2 && version !== 3 && version !== 4) || size > MAX_ID3) return 10 + size;
  const body = await bytes(file, 10, 10 + size);
  try {
    parseId3Body(version, head[5], body, into);
  } catch {
    // a damaged tag still leaves the rest of the file readable
  }
  return 10 + size + (head[5] & 0x10 ? 10 : 0);
}

// ---- Vorbis comments (FLAC, Ogg) ---------------------------------------------------------------

function parseVorbisComment(data: Uint8Array, into: FileTags): void {
  if (data.length < 8) return;
  let pos = 4 + u32le(data, 0); // vendor string
  if (pos + 4 > data.length) return;
  const count = u32le(data, pos);
  pos += 4;

  const decoder = new TextDecoder("utf-8");
  for (let i = 0; i < count && pos + 4 <= data.length; i++) {
    const length = u32le(data, pos);
    pos += 4;
    if (pos + length > data.length) break;
    const entry = decoder.decode(data.subarray(pos, pos + length));
    pos += length;

    const equals = entry.indexOf("=");
    if (equals < 1) continue;
    const key = entry.slice(0, equals).toUpperCase();
    const value = entry.slice(equals + 1);
    if (!value.trim()) continue;

    if (key === "TITLE") into.title ||= value;
    else if (key === "ARTIST") into.artists.push(value);
    else if (key === "ALBUM") into.album ||= value;
    else if (key === "LYRICS" || key === "UNSYNCEDLYRICS" || key === "SYNCEDLYRICS" || key.startsWith("LYRICS-") || key === "LRC") {
      into.lyrics.push(value);
    }
  }
}

async function readFlac(file: Blob, offset: number, into: FileTags): Promise<void> {
  let pos = offset + 4;
  for (let guard = 0; guard < 64; guard++) {
    const head = await bytes(file, pos, pos + 4);
    if (head.length < 4) return;
    const last = head[0] & 0x80;
    const type = head[0] & 0x7f;
    const length = u24be(head, 1);
    if (type === 4 && length < MAX_ID3) {
      parseVorbisComment(await bytes(file, pos + 4, pos + 4 + length), into);
    }
    pos += 4 + length;
    if (last) return;
  }
}

/** The first two packets of an Ogg stream (identification, then comments). */
async function readOgg(file: Blob, into: FileTags): Promise<void> {
  const packets: Uint8Array[] = [];
  let current: Uint8Array[] = [];
  let pos = 0;

  while (packets.length < 2 && pos < MAX_OGG) {
    const head = await bytes(file, pos, pos + 27);
    if (head.length < 27 || ascii(head, 0, 4) !== "OggS") return;
    const segments = head[26];
    const table = await bytes(file, pos + 27, pos + 27 + segments);
    let at = pos + 27 + segments;
    for (const length of table) {
      current.push(await bytes(file, at, at + length));
      at += length;
      if (length < 255) {
        const total = current.reduce((n, part) => n + part.length, 0);
        const packet = new Uint8Array(total);
        let n = 0;
        for (const part of current) {
          packet.set(part, n);
          n += part.length;
        }
        packets.push(packet);
        current = [];
        if (packets.length === 2) break;
      }
    }
    pos = at;
  }

  const comments = packets[1];
  if (!comments) return;
  if (ascii(comments, 0, 8) === "OpusTags") parseVorbisComment(comments.subarray(8), into);
  else if (comments[0] === 3 && ascii(comments, 1, 7) === "vorbis") parseVorbisComment(comments.subarray(7), into);
}

// ---- MP4 / M4A ---------------------------------------------------------------------------------

type Atom = { type: string; start: number; end: number };

function atoms(buf: Uint8Array, start: number, end: number): Atom[] {
  const found: Atom[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = u32be(buf, pos);
    const type = ascii(buf, pos + 4, pos + 8);
    let header = 8;
    if (size === 1) {
      size = u32be(buf, pos + 12); // low half of the 64-bit size is enough here
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) break;
    found.push({ type, start: pos + header, end: pos + size });
    pos += size;
  }
  return found;
}

function mp4Items(moov: Uint8Array, into: FileTags): void {
  const udta = atoms(moov, 0, moov.length).find((a) => a.type === "udta");
  const meta = udta && atoms(moov, udta.start, udta.end).find((a) => a.type === "meta");
  if (!meta) return;
  const ilst = atoms(moov, meta.start + 4, meta.end).find((a) => a.type === "ilst");
  if (!ilst) return;

  const decoder = new TextDecoder("utf-8");
  for (const item of atoms(moov, ilst.start, ilst.end)) {
    const data = atoms(moov, item.start, item.end).find((a) => a.type === "data");
    if (!data) continue;
    const value = decoder.decode(moov.subarray(data.start + 8, data.end)).trim();
    if (!value) continue;
    switch (item.type) {
      case "©nam":
        into.title ||= value;
        break;
      case "©ART":
        into.artists.push(value);
        break;
      case "©alb":
        into.album ||= value;
        break;
      case "©lyr":
        into.lyrics.push(value);
        break;
    }
  }
}

async function readMp4(file: Blob, into: FileTags): Promise<void> {
  let pos = 0;
  for (let guard = 0; guard < 4096 && pos < file.size; guard++) {
    const head = await bytes(file, pos, pos + 16);
    if (head.length < 8) return;
    let size = u32be(head, 0);
    const type = ascii(head, 4, 8);
    let header = 8;
    if (size === 1) {
      size = u32be(head, 12);
      header = 16;
    } else if (size === 0) {
      size = file.size - pos;
    }
    if (size < header) return;
    if (type === "moov" && size < MAX_ATOM) {
      mp4Items(await bytes(file, pos + header, pos + size), into);
      return;
    }
    pos += size;
  }
}

// ---- the front door ------------------------------------------------------------------------------

/** Everything the file's tags say that matters here. Never throws: a file it cannot read gives no tags. */
export async function readTags(file: Blob): Promise<FileTags> {
  const tags = empty();
  try {
    const head = await bytes(file, 0, 12);
    let offset = 0;
    if (ascii(head, 0, 3) === "ID3") offset = await readId3(file, tags);

    const magic = offset ? await bytes(file, offset, offset + 4) : head;
    if (ascii(magic, 0, 4) === "fLaC") await readFlac(file, offset, tags);
    else if (ascii(magic, 0, 4) === "OggS") await readOgg(file, tags);
    else if (ascii(head, 4, 8) === "ftyp") await readMp4(file, tags);
  } catch {
    // unreadable: report what was found so far
  }

  tags.title = tags.title?.trim() || undefined;
  tags.album = tags.album?.trim() || undefined;
  tags.artists = [...new Set(tags.artists.map((a) => a.trim()).filter(Boolean))];
  return tags;
}
