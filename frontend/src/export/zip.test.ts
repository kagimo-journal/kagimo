import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, dosDateTime, zip } from './zip';

const utf8 = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

interface Parsed {
  name: string;
  method: number;
  flags: number;
  crc: number;
  packed: number;
  size: number;
  time: number;
  date: number;
  data: Uint8Array;
}

/** Reads an archive back the way an unzip tool does: end record, central directory, local headers. */
function parse(archive: Uint8Array): Parsed[] {
  const v = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const end = archive.length - 22;
  expect(v.getUint32(end, true)).toBe(0x06054b50);
  expect([v.getUint16(end + 4, true), v.getUint16(end + 6, true), v.getUint16(end + 20, true)]).toEqual([0, 0, 0]);
  const count = v.getUint16(end + 10, true);
  expect(v.getUint16(end + 8, true)).toBe(count);
  const directorySize = v.getUint32(end + 12, true);
  const directoryAt = v.getUint32(end + 16, true);
  expect(directoryAt + directorySize).toBe(end);

  const out: Parsed[] = [];
  let p = directoryAt;
  let expectedLocal = 0;
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50);
    const fields = (at: number) => ({
      needed: v.getUint16(at, true),
      flags: v.getUint16(at + 2, true),
      method: v.getUint16(at + 4, true),
      time: v.getUint16(at + 6, true),
      date: v.getUint16(at + 8, true),
      crc: v.getUint32(at + 10, true),
      packed: v.getUint32(at + 14, true),
      size: v.getUint32(at + 18, true),
      nameLength: v.getUint16(at + 22, true),
      extraLength: v.getUint16(at + 24, true),
    });
    const central = fields(p + 6);
    const local = v.getUint32(p + 42, true);
    const nameBytes = archive.subarray(p + 46, p + 46 + central.nameLength);
    // The local header says the same as the directory, and the files follow each other without gaps.
    expect(local).toBe(expectedLocal);
    expect(v.getUint32(local, true)).toBe(0x04034b50);
    expect(fields(local + 4)).toEqual(central);
    expect(archive.subarray(local + 30, local + 30 + central.nameLength)).toEqual(nameBytes);
    expect(central.extraLength).toBe(0);
    expect(central.needed).toBe(central.method === 8 ? 20 : 10);
    const dataAt = local + 30 + central.nameLength;
    out.push({ ...central, name: text(nameBytes), data: archive.subarray(dataAt, dataAt + central.packed) });
    expectedLocal = dataAt + central.packed;
    p += 46 + central.nameLength;
  }
  expect(p).toBe(end);
  expect(expectedLocal).toBe(directoryAt);
  return out;
}

const contents = (e: Parsed) => (e.method === 8 ? new Uint8Array(inflateRawSync(e.data)) : e.data);

const FILES: Record<string, Uint8Array> = {
  'journal-export/2026/2026-03-01-a-walk.md': utf8('---\ntitle: A walk\n---\n\n' + 'The river was higher than expected. '.repeat(40) + '\n'),
  'journal-export/2026/2026-03-02-żółć-日本語-📓.md': utf8('Zażółć gęślą jaźń\n'),
  'journal-export/images/3f2a.bin': Uint8Array.from({ length: 4096 }, (_, i) => (Math.imul(i + 1, 2654435761) >>> 24) ^ (i * 7)), // does not compress
  'journal-export/empty.md': new Uint8Array(0),
  'journal-export/check.txt': utf8('123456789'),
};

describe('crc32', () => {
  it('matches the known check values', () => {
    expect(crc32(utf8('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(utf8('a'))).toBe(0xe8b7be43);
    expect(crc32(utf8('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });
});

describe('dosDateTime', () => {
  it('packs local time with two-second resolution', () => {
    expect(dosDateTime(new Date(2026, 10, 14, 13, 45, 31))).toEqual({ time: (13 << 11) | (45 << 5) | 15, date: (46 << 9) | (11 << 5) | 14 });
  });

  it('clamps years the format cannot hold', () => {
    expect(dosDateTime(new Date(1970, 0, 1))).toEqual({ time: 0, date: (1 << 5) | 1 });
    expect(dosDateTime(new Date(NaN))).toEqual({ time: 0, date: (1 << 5) | 1 });
    expect(dosDateTime(new Date(2200, 0, 1)).date >> 9).toBe(127);
  });
});

describe('zip', () => {
  const when = new Date(2026, 10, 14, 13, 45, 30);

  it('writes local headers, a central directory and an end record that agree', async () => {
    const archive = await zip(FILES, { date: when });
    expect(Array.from(archive.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const entries = parse(archive);
    expect(entries.map((e) => e.name)).toEqual(Object.keys(FILES));
    for (const e of entries) {
      const original = FILES[e.name];
      expect(e.flags).toBe(0x0800); // UTF-8 names
      expect(e.size).toBe(original.length);
      expect(e.crc).toBe(crc32(original));
      expect(e.packed).toBe(e.data.length);
      expect(contents(e)).toEqual(original);
      expect([e.time, e.date]).toEqual([(13 << 11) | (45 << 5) | 15, (46 << 9) | (11 << 5) | 14]);
    }
    expect(entries.find((e) => e.name.endsWith('check.txt'))!.crc).toBe(0xcbf43926);
  });

  it('deflates what gets smaller and stores the rest', async () => {
    const byName = Object.fromEntries(parse(await zip(FILES)).map((e) => [e.name.split('/').pop()!, e]));
    expect(byName['2026-03-01-a-walk.md'].method).toBe(8);
    expect(byName['2026-03-01-a-walk.md'].packed).toBeLessThan(byName['2026-03-01-a-walk.md'].size / 5);
    for (const name of ['3f2a.bin', 'empty.md', 'check.txt']) {
      expect(byName[name].method).toBe(0);
      expect(byName[name].packed).toBe(byName[name].size);
    }
  });

  it('stores everything when asked to, or when the browser cannot deflate', async () => {
    const stored = await zip(FILES, { compress: false, date: when });
    expect(parse(stored).every((e) => e.method === 0 && e.packed === e.size)).toBe(true);
    const total = Object.entries(FILES).reduce((n, [name, data]) => n + 30 + 46 + 2 * utf8(name).length + data.length, 22);
    expect(stored.length).toBe(total);

    const saved = globalThis.CompressionStream;
    try {
      // @ts-expect-error simulating a browser without CompressionStream
      delete globalThis.CompressionStream;
      expect(await zip(FILES, { date: when })).toEqual(stored);
      // A browser that has the class but not the raw format.
      globalThis.CompressionStream = class {
        constructor() {
          throw new TypeError('Unsupported compression format');
        }
      } as unknown as typeof CompressionStream;
      expect(await zip(FILES, { date: when })).toEqual(stored);
    } finally {
      globalThis.CompressionStream = saved;
    }
  });

  it('leaves the input untouched and writes an empty archive for no files', async () => {
    const input = { 'a.txt': utf8('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') };
    await zip(input);
    expect(text(input['a.txt'])).toBe('a'.repeat(48));
    const empty = await zip({});
    expect(empty.length).toBe(22);
    expect(parse(empty)).toEqual([]);
  });

  it.each(['', '/etc/passwd', '../up.md', 'a/../../b.md', 'a//b.md', 'a/./b.md', 'dir/', 'a\\b.md', 'C:/x.md', 'a\0.md'])('refuses the unsafe name %j', async (name) => {
    await expect(zip({ [name]: utf8('x') })).rejects.toThrow(/unsafe file name/i);
  });

  it('refuses what would need ZIP64', async () => {
    const empty = new Uint8Array(0);
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i < 65536; i++) many[`f${i}`] = empty;
    await expect(zip(many)).rejects.toThrow(/too many files/i);
    await expect(zip({ ['n'.repeat(65536)]: empty })).rejects.toThrow(/name too long/i);
    // 4 GiB without allocating it: only the length is looked at before the size check.
    const huge = { length: 2 ** 32 } as Uint8Array;
    await expect(zip({ 'huge.bin': huge })).rejects.toThrow(/too large/i);
    // Small enough for one entry, but not once the headers and the directory are added.
    const nearly = { length: 2 ** 32 - 60 } as Uint8Array;
    await expect(zip({ 'nearly.bin': nearly }, { compress: false })).rejects.toThrow(/larger than 4 GiB/i);
  });

  it('holds 65,535 files', async () => {
    const empty = new Uint8Array(0);
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i < 65535; i++) many[`f${i}`] = empty;
    const archive = await zip(many, { compress: false });
    expect(new DataView(archive.buffer).getUint16(archive.length - 12, true)).toBe(65535);
  });

  // The same archive, checked by tools that were not written here (skipped where they are missing).
  const has = (cmd: string, args: string[]) => {
    try {
      execFileSync(cmd, args, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };

  it.skipIf(!has('unzip', ['-v']))('is accepted by unzip -t', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-zip-'));
    try {
      const file = join(dir, 'export.zip');
      writeFileSync(file, await zip(FILES, { date: when }));
      const report = execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
      expect(report).toMatch(/No errors detected in compressed data/);
      expect(report.match(/\bOK\b/g)?.length).toBe(Object.keys(FILES).length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!has('python3', ['-c', 'import zipfile']))('is read back by python3 zipfile, names and contents', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-zip-'));
    try {
      const file = join(dir, 'export.zip');
      writeFileSync(file, await zip(FILES, { date: when }));
      const script =
        'import sys, json, zipfile, binascii\n' +
        'z = zipfile.ZipFile(sys.argv[1])\n' +
        'assert z.testzip() is None\n' +
        'print(json.dumps([[i.filename, i.file_size, binascii.crc32(z.read(i)), list(i.date_time)] for i in z.infolist()]))\n';
      const listed = JSON.parse(execFileSync('python3', ['-I', '-c', script, file], { encoding: 'utf8' }));
      expect(listed).toEqual(Object.entries(FILES).map(([name, data]) => [name, data.length, crc32(data), [2026, 11, 14, 13, 45, 30]]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
