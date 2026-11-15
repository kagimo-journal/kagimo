/**
 * Minimal ZIP writer for the Markdown export (written for this app; no runtime dependency).
 *
 * Layout (APPNOTE.TXT): for each file a local header + its data, then the central directory (one
 * record per file) and the end-of-central-directory record. File names are UTF-8 (general-purpose
 * bit 11), times are DOS local time. Each file is deflated with the browser's
 * CompressionStream('deflate-raw') (method 8) when that exists and makes the file smaller, and
 * stored as is (method 0) otherwise, so photos that are already compressed cost nothing extra.
 *
 * No ZIP64, no encryption, no data descriptors, no directory entries (unzip tools create the
 * folders from the file paths). Anything that would need ZIP64 (4 GiB, 65,535 files) is refused
 * with an error rather than written wrong.
 */

export interface ZipOptions {
  /** Modification time stamped on every file (default: now). */
  date?: Date;
  /** false: store everything without compressing. */
  compress?: boolean;
}

const MAX_U32 = 0xffffffff; // also the marker for "see the ZIP64 record", so sizes stay below it
const MAX_U16 = 0xffff;
const UTF8_NAMES = 0x0800; // general-purpose bit 11
const STORED = 0;
const DEFLATED = 8;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE 802.3, as used by ZIP, gzip and PNG). */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS time and date words; years outside 1980–2107 are clamped (the format can't hold them). */
export function dosDateTime(d: Date): { time: number; date: number } {
  let t = d;
  if (Number.isNaN(t.getTime()) || t.getFullYear() < 1980) t = new Date(1980, 0, 1, 0, 0, 0);
  else if (t.getFullYear() > 2107) t = new Date(2107, 11, 31, 23, 59, 58);
  return {
    time: (t.getHours() << 11) | (t.getMinutes() << 5) | (t.getSeconds() >> 1),
    date: ((t.getFullYear() - 1980) << 9) | ((t.getMonth() + 1) << 5) | t.getDate(),
  };
}

/**
 * A name is a relative path with `/` separators. Refuses what could land outside the folder the
 * archive is unpacked into, or be read differently by different tools.
 */
function checkName(name: string): void {
  const bad =
    !name ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    /[\\\0]/.test(name) ||
    /^[A-Za-z]:/.test(name) ||
    name.split('/').some((part) => part === '' || part === '.' || part === '..');
  if (bad) throw new Error(`Unsafe file name for a zip archive: ${JSON.stringify(name)}`);
}

/** Raw deflate via the browser; null when it is not available. */
async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const cs = new CompressionStream('deflate-raw'); // throws where only gzip/deflate are known
    const writer = cs.writable.getWriter();
    // Read while writing: the stream stops accepting input when nobody takes the output.
    const [out] = await Promise.all([
      new Response(cs.readable).arrayBuffer(),
      writer.write(data as Uint8Array<ArrayBuffer>).then(() => writer.close()),
    ]);
    return new Uint8Array(out);
  } catch {
    return null;
  }
}

interface Entry {
  name: Uint8Array;
  /** What goes in the archive: the file itself (stored) or its deflated form. */
  data: Uint8Array;
  method: number;
  crc: number;
  size: number;
  offset: number;
}

const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;

/**
 * Builds a zip archive from `path -> bytes`. The input buffers are not modified or kept; the
 * compressed copies made on the way are zeroed before returning.
 */
export async function zip(files: Record<string, Uint8Array>, options: ZipOptions = {}): Promise<Uint8Array> {
  const names = Object.keys(files);
  if (names.length > MAX_U16) throw new Error(`Too many files for a zip archive (${names.length}; the limit is 65,535).`);
  const { time, date } = dosDateTime(options.date ?? new Date());
  const encoder = new TextEncoder();

  const entries: Entry[] = [];
  let offset = 0;
  let directorySize = 0;
  for (const path of names) {
    checkName(path);
    const raw = files[path];
    const name = encoder.encode(path);
    if (name.length > MAX_U16) throw new Error(`File name too long for a zip archive: ${path.slice(0, 80)}…`);
    if (raw.length >= MAX_U32) throw new Error(`${path} is too large for a zip archive (the limit is 4 GiB).`);
    let data = raw;
    let method = STORED;
    if (options.compress !== false && raw.length > 0) {
      const packed = await deflateRaw(raw);
      if (packed && packed.length < raw.length) {
        data = packed;
        method = DEFLATED;
      } else packed?.fill(0);
    }
    const next = offset + LOCAL_HEADER + name.length + data.length;
    directorySize += CENTRAL_HEADER + name.length;
    if (next + directorySize + END_RECORD >= MAX_U32) throw new Error('The archive would be larger than 4 GiB, which this zip writer does not support.');
    entries.push({ name, data, method, crc: crc32(raw), size: raw.length, offset });
    offset = next;
  }

  const out = new Uint8Array(offset + directorySize + END_RECORD);
  const view = new DataView(out.buffer);
  let p = 0;
  const u16 = (v: number) => {
    view.setUint16(p, v, true);
    p += 2;
  };
  const u32 = (v: number) => {
    view.setUint32(p, v, true);
    p += 4;
  };
  const bytes = (b: Uint8Array) => {
    out.set(b, p);
    p += b.length;
  };
  /** The fields the local and the central header share. */
  const common = (e: Entry) => {
    u16(e.method === DEFLATED ? 20 : 10); // version needed to extract
    u16(UTF8_NAMES);
    u16(e.method);
    u16(time);
    u16(date);
    u32(e.crc);
    u32(e.data.length);
    u32(e.size);
    u16(e.name.length);
    u16(0); // extra field length
  };

  for (const e of entries) {
    u32(0x04034b50);
    common(e);
    bytes(e.name);
    bytes(e.data);
  }
  for (const e of entries) {
    u32(0x02014b50);
    u16(20); // version made by: 2.0, MS-DOS attributes
    common(e);
    u16(0); // comment length
    u16(0); // disk number
    u16(0); // internal attributes
    u32(0); // external attributes
    u32(e.offset);
    bytes(e.name);
  }
  u32(0x06054b50);
  u16(0); // this disk
  u16(0); // disk with the central directory
  u16(entries.length);
  u16(entries.length);
  u32(directorySize);
  u32(offset);
  u16(0); // comment length

  for (const e of entries) if (e.method === DEFLATED) e.data.fill(0);
  return out;
}
