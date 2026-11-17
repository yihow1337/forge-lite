// The wire formats git's smart HTTP carries: pkt-lines, and packfiles in both directions.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, type GitObject, type GitObjectType, type ObjectStore } from './objects.ts';

/** git's LARGE_PACKET_MAX, including the four length bytes. */
export const PKT_LINE_MAX = 65520;
/** The most payload bytes one pkt-line may carry. */
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;
/** The band-1 chunk size a packfile section is framed at (payload, band byte included). */
export const SIDEBAND_CHUNK = 65_515;

/**
 * The most bytes one object a client pushes may inflate or expand to. A packed object declares its
 * own size -- a delta names its target size in a varint, a zlib stream names nothing at all -- so an
 * unbounded reader lets a few hundred bytes on the wire ask for gigabytes of heap. Nothing the suite
 * pushes comes near this; a pack that does is a broken pack, and a broken pack gets an error rather
 * than the process's memory.
 */
export const MAX_OBJECT_BYTES = 64 * 1024 * 1024;

const FLUSH = Buffer.from('0000', 'latin1');
const DELIM = Buffer.from('0001', 'latin1');
/** The one empty payload every control packet shares: decoding a pack must not allocate per flush. */
const NO_PAYLOAD = Buffer.alloc(0);

/** The four hex length bytes of a pkt-line carrying `bytes` payload bytes. */
function pktLength(bytes: number): string {
  const hex = (bytes + 4).toString(16);
  return hex.length === 4 ? hex : `000${hex}`.slice(-4);
}

/**
 * One pkt-line as text. Every answer this forge builds is a handful of short lines, and building
 * them as one string and encoding it once costs one allocation where a Buffer per line costs two
 * apiece plus the concat that joins them.
 */
export function pktText(payload: string): string {
  return pktLength(Buffer.byteLength(payload)) + payload;
}

/** The flush packet, as text. */
export const FLUSH_TEXT = '0000';
/** The delimiter packet, as text. */
export const DELIM_TEXT = '0001';

/**
 * `payload` framed as a single band-1 sideband packet, as text. The caller must have checked that
 * it fits in one packet (SIDEBAND_CHUNK); everything the forge sideband-wraps as text is a
 * report-status of a few short lines.
 */
export function sidebandText(payload: string): string {
  return pktLength(Buffer.byteLength(payload) + 1) + '\u0001' + payload;
}

/** The flush packet. */
export function flushPkt(): Buffer {
  return FLUSH;
}

/** The delimiter packet. */
export function delimPkt(): Buffer {
  return DELIM;
}

/** One pkt-line: four hex length bytes then the payload. */
export function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const out = Buffer.allocUnsafe(data.length + 4);
  out.write(pktLength(data.length), 0, 4, 'latin1');
  data.copy(out, 4);
  return out;
}

/** A band-`band` sideband packet carrying `data`. */
export function sideband(band: number, data: Buffer): Buffer {
  const out = Buffer.allocUnsafe(data.length + 5);
  out.write((data.length + 5).toString(16).padStart(4, '0'), 0, 4, 'latin1');
  out[4] = band;
  data.copy(out, 5);
  return out;
}

/** `data` split into band-1 packets of at most SIDEBAND_CHUNK bytes. */
export function sidebandChunks(data: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += SIDEBAND_CHUNK) {
    parts.push(sideband(1, data.subarray(offset, Math.min(offset + SIDEBAND_CHUNK, data.length))));
  }
  return parts;
}

/** One decoded packet: a payload, or one of the three control packets. */
export interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Decode pkt-lines from `buffer` at `start`, stopping after the first flush unless told otherwise. */
export interface DecodeResult {
  packets: Packet[];
  /** The offset just past the last packet consumed (where a pack's raw bytes begin). */
  offset: number;
}

/** One hex digit's value, or -1. */
function nibble(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 102) return code - 87;
  if (code >= 65 && code <= 70) return code - 55;
  return -1;
}

/**
 * The four hex bytes at `offset` as a number, or -1 when any of them is not a hex digit. Read
 * straight off the buffer: a pack and an upload-pack request are hundreds of pkt-lines, and a
 * string plus a regular expression per line is the single biggest cost of parsing one.
 */
function pktHeader(buffer: Buffer, offset: number): number {
  const a = nibble(buffer[offset] as number);
  const b = nibble(buffer[offset + 1] as number);
  const c = nibble(buffer[offset + 2] as number);
  const d = nibble(buffer[offset + 3] as number);
  if (a < 0 || b < 0 || c < 0 || d < 0) return -1;
  return a * 4096 + b * 256 + c * 16 + d;
}

/** Decode pkt-lines until `stopAtFlush` (default) or the buffer ends. Throws on a malformed header. */
export function decodePktLines(buffer: Buffer, start = 0, stopAtFlush = false): DecodeResult {
  const packets: Packet[] = [];
  let offset = start;
  while (offset + 4 <= buffer.length) {
    const length = pktHeader(buffer, offset);
    if (length < 0) throw new Error(`invalid pkt-line length ${JSON.stringify(buffer.toString('latin1', offset, offset + 4))}`);
    if (length === 0) {
      offset += 4;
      packets.push({ kind: 'flush', payload: NO_PAYLOAD });
      if (stopAtFlush) break;
      continue;
    }
    if (length === 1) {
      offset += 4;
      packets.push({ kind: 'delim', payload: NO_PAYLOAD });
      continue;
    }
    if (length === 2) {
      offset += 4;
      packets.push({ kind: 'response-end', payload: NO_PAYLOAD });
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error(`truncated pkt-line of ${length} bytes`);
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, offset };
}

// ---------------------------------------------------------------- pack writing

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: readonly (GitObjectType | undefined)[] = [undefined, 'commit', 'tree', 'blob', 'tag'];

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let current = (TYPE_CODE[type] << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(current | 0x80);
    current = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(current);
  return Buffer.from(bytes);
}

/** Build a packfile (version 2, no deltas) from `objects`, with its SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'latin1');
  header.writeUInt32BE(2, 4);
  let count = 0;
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length), deflateSync(object.data, { level: 1 }));
    count += 1;
  }
  header.writeUInt32BE(count, 8);
  const body = Buffer.concat([header, ...parts]);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------- pack reading

interface RawEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  oid?: string;
  type?: GitObjectType;
  resolved?: Buffer;
}

/** One options object for every inflate: the hot path must not allocate one per object. */
const INFLATE_OPTIONS = Object.freeze({ info: true, maxOutputLength: MAX_OBJECT_BYTES });

/** What inflateSync answers in `info` mode: the bytes, and how many input bytes it consumed. */
interface InflateInfo {
  buffer: Buffer;
  engine: { bytesWritten: number };
}

function readSizeHeader(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while ((byte & 0x80) !== 0) {
    byte = buffer[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { delta: number; next: number } {
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    byte = buffer[offset] as number;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { delta: value, next: offset };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint();
  const targetSize = readVarint();
  if (!Number.isFinite(targetSize) || targetSize < 0 || targetSize > MAX_OBJECT_BYTES) {
    throw new Error(`a delta asks for ${targetSize} bytes, past the ${MAX_OBJECT_BYTES}-byte object limit`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      delta.copy(out, written, offset, offset + op);
      offset += op;
      written += op;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/**
 * Read a packfile, resolving OFS_DELTA and REF_DELTA entries (a thin pack's base may come from
 * `existing`), and answer every object it carries by id.
 */
export function readPack(pack: Buffer, existing?: ObjectStore): Map<string, GitObject> {
  const objects = new Map<string, GitObject>();
  if (pack.length === 0) return objects;
  if (pack.length < 32) throw new Error(`a pack of ${pack.length} bytes is too short`);
  if (pack[0] !== 0x50 || pack[1] !== 0x41 || pack[2] !== 0x43 || pack[3] !== 0x4b) throw new Error('the pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const body = pack.subarray(0, trailerStart);
  // The header's count is four client-supplied bytes. Every entry costs at least a header byte and a
  // zlib stream, so a count past the body's length describes a pack that cannot exist: refuse it here
  // rather than letting the loop below grow an entry list toward four billion.
  if (count > body.length) throw new Error(`a pack of ${body.length} bytes claims ${count} objects`);

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let deltas = false;
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const header = readSizeHeader(body, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: NO_PAYLOAD };
    if (typeCode === 6) {
      const base = readOfsBase(body, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.delta;
      deltas = true;
    } else if (typeCode === 7) {
      entry.baseOid = body.toString('hex', offset, offset + 20);
      offset += 20;
      deltas = true;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`pack entry ${index} has type code ${typeCode}`);
    }
    const inflated = inflateSync(body.subarray(offset), INFLATE_OPTIONS) as unknown as InflateInfo;
    entry.data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  // A pack with no delta entries -- which is every pack the suite pushes, and every pack git
  // sends with thin-pack off -- needs none of the resolution bookkeeping below: each entry is
  // already its own object, and the only work left is naming it.
  if (!deltas) {
    for (const entry of raw) {
      const type = CODE_TYPE[entry.typeCode] as GitObjectType;
      objects.set(hashObject(type, entry.data), { type, data: entry.data });
    }
    return objects;
  }

  const byOid = new Map<string, RawEntry>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer } => {
    if (entry.resolved !== undefined && entry.type !== undefined) return { type: entry.type, data: entry.resolved };
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new Error('an ofs-delta names a base outside the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const inPack = byOid.get(wanted);
      const base = inPack !== undefined ? resolve(inPack) : existing?.get(wanted);
      if (base === undefined) throw new Error(`a ref-delta names the missing base ${wanted}`);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = CODE_TYPE[entry.typeCode] as GitObjectType;
      data = entry.data;
    }
    entry.type = type;
    entry.resolved = data;
    const oid = hashObject(type, data);
    entry.oid = oid;
    byOid.set(oid, entry);
    return { type, data };
  };

  for (const entry of raw) {
    const resolved = resolve(entry);
    objects.set(entry.oid as string, { type: resolved.type, data: resolved.data });
  }
  return objects;
}
