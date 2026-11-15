import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { qrCapacity, qrCode, qrMatrix, qrPath } from './qr';

const utf8 = (s: string) => new TextEncoder().encode(s);

/** The reference: the `qrcode` package, forced into byte mode like ours. Rows of '0'/'1'. */
function reference(bytes: Uint8Array, options: { mask?: number; version?: number } = {}) {
  const qr = QRCode.create([{ data: bytes, mode: 'byte' }], {
    errorCorrectionLevel: 'M',
    maskPattern: options.mask as QRCode.QRCodeMaskPattern | undefined,
    version: options.version,
  });
  const { size } = qr.modules;
  const rows = Array.from({ length: size }, (_, r) => Array.from({ length: size }, (_, c) => qr.modules.get(r, c)).join(''));
  return { version: qr.version, mask: qr.maskPattern, rows };
}

const picture = (modules: boolean[][]) => modules.map((row) => row.map((m) => (m ? 1 : 0)).join(''));

/** Same version, same automatic mask, and the same modules under every forced mask. */
function expectSameAsReference(bytes: Uint8Array) {
  const ours = qrCode(bytes);
  const theirs = reference(bytes);
  expect(ours.version).toBe(theirs.version);
  expect(ours.mask).toBe(theirs.mask);
  expect(picture(ours.modules)).toEqual(theirs.rows);
  for (let mask = 0; mask < 8; mask++) {
    const forced = qrCode(bytes, { mask });
    expect(forced.mask).toBe(mask);
    expect(picture(forced.modules)).toEqual(reference(bytes, { mask }).rows);
  }
  return ours;
}

/** Repeatable filler bytes that cover all values. */
function filler(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

const OTPAUTH = 'otpauth://totp/Kagimo:maren%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Kagimo&algorithm=SHA1&digits=6&period=30';

describe('qrCode against the qrcode package', () => {
  it.each(['', 'a', 'HELLO WORLD', '0123456789', 'https://example.com/', 'The quick brown fox jumps over the lazy dog.'])('short text %j', (text) => {
    expectSameAsReference(utf8(text));
  });

  it.each(['żółć', 'Ünïcödé — “quotes”', '日本語のテキスト', '🔐 journal 📓', 'otpauth://totp/Kagimo:j%C3%BCrgen@example.com?secret=ABCDEFGHIJKLMNOP&issuer=Kagimo'])(
    'non-ASCII text %j',
    (text) => {
      const ours = expectSameAsReference(utf8(text));
      expect(picture(qrMatrix(text))).toEqual(picture(ours.modules));
    },
  );

  it('a realistic otpauth URI', () => {
    const ours = expectSameAsReference(utf8(OTPAUTH));
    expect([utf8(OTPAUTH).length, ours.version, ours.size]).toEqual([129, 8, 49]);
    expect(picture(qrMatrix(OTPAUTH))).toEqual(picture(ours.modules));
  });

  it('otpauth URIs of 70 to 260 bytes (secret and account of varying length)', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    for (let length = 70; length <= 260; length += 5) {
      const head = 'otpauth://totp/Kagimo:someone@example.com?issuer=Kagimo&secret=';
      const secret = Array.from(filler(length - head.length, length), (b) => alphabet[b % 32]).join('');
      expectSameAsReference(utf8(head + secret));
    }
  });

  // The fullest code of each version, and one byte more, which must move to the next version.
  it.each(Array.from({ length: 40 }, (_, i) => i + 1))('version %i at its capacity, and one byte over', (version) => {
    const capacity = qrCapacity(version);
    expect(expectSameAsReference(filler(capacity, version)).version).toBe(version);
    if (version > 1) expect(expectSameAsReference(filler(qrCapacity(version - 1) + 1, version + 100)).version).toBe(version);
    // Mostly padding, and half full.
    expect(picture(qrCode(utf8('x'), { version }).modules)).toEqual(reference(utf8('x'), { version }).rows);
    expectSameAsReference(filler(Math.max(1, capacity >> 1), version + 200));
  });

  it('every length from 0 to 300 bytes picks the same version and mask', () => {
    for (let length = 0; length <= 300; length++) {
      const bytes = filler(length, length + 1000);
      const ours = qrCode(bytes);
      const theirs = reference(bytes);
      expect([length, ours.version, ours.mask]).toEqual([length, theirs.version, theirs.mask]);
      expect(picture(ours.modules)).toEqual(theirs.rows);
    }
  });

  it('uniform data (worst case for the masks)', () => {
    for (const value of [0x00, 0xff, 0x55, 0xaa]) expectSameAsReference(new Uint8Array(100).fill(value));
  });
});

describe('qrCode', () => {
  it('has the published byte capacities at level M', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 30, 40].map(qrCapacity)).toEqual([14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 412, 666, 1370, 2331]);
  });

  it('draws the finder patterns, timing, dark module and format information', () => {
    const { modules, size, version } = qrCode('hello', { mask: 0 });
    expect([version, size]).toEqual([1, 21]);
    const finder = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];
    for (const [row, col] of [[0, 0], [0, 14], [14, 0]]) {
      expect(picture(modules.slice(row, row + 7).map((r) => r.slice(col, col + 7)))).toEqual(finder);
    }
    expect(picture([modules[7].slice(0, 8), modules[6].slice(7, 14)])).toEqual(['00000000', '0101010']);
    expect(modules[13][8]).toBe(true);
    // Level M, mask 0: 101010000010010, most significant bit first, left to right along row 8.
    const format = [0, 1, 2, 3, 4, 5, 7, 13, 14, 15, 16, 17, 18, 19, 20].map((col) => (modules[8][col] ? 1 : 0)).join('');
    expect(format).toBe('101010000010010');
  });

  it('refuses what does not fit, and bad options', () => {
    expect(qrCode(new Uint8Array(2331)).version).toBe(40);
    expect(() => qrCode(new Uint8Array(2332))).toThrow(/too much data/i);
    expect(() => qrCode('fifteen bytes!!', { version: 1 })).toThrow(/too much data/i);
    expect(() => qrCode('a', { mask: 8 })).toThrow(RangeError);
    expect(() => qrCode('a', { version: 41 })).toThrow(RangeError);
  });
});

describe('qrPath', () => {
  it('covers exactly the dark modules, inside the quiet zone', () => {
    const modules = qrMatrix(OTPAUTH);
    const { d, size } = qrPath(modules);
    expect(size).toBe(modules.length + 8);
    expect(d).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/);
    const drawn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    for (const [, x, y, w] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      for (let i = 0; i < Number(w); i++) {
        expect(drawn[Number(y)][Number(x) + i]).toBe(false);
        drawn[Number(y)][Number(x) + i] = true;
      }
    }
    const framed = drawn.slice(4, -4).map((row) => row.slice(4, -4));
    expect(picture(framed)).toEqual(picture(modules));
    expect(drawn.flat().filter(Boolean).length).toBe(modules.flat().filter(Boolean).length);
  });

  it('takes another margin', () => {
    expect(qrPath([[true, false], [true, true]], 1)).toEqual({ d: 'M1 1h1v1h-1zM1 2h2v1h-2z', size: 4 });
  });
});
