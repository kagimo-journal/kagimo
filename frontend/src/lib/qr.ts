/**
 * QR code encoder (written for this app; no runtime dependency). Used for the authenticator-app
 * setup code, so it does one thing: bytes in byte mode at error-correction level M, versions 1–40
 * (ISO/IEC 18004). An otpauth:// URI of 80–200 bytes lands in versions 5–10.
 *
 * Steps: pick the smallest version that holds the data; write mode, length, data, terminator and
 * pad bytes; split into blocks and add Reed-Solomon error correction over GF(256); interleave;
 * draw the function patterns (finders, separators, timing, alignment, dark module, format and
 * version information); place the codewords in the zigzag; apply the mask with the lowest penalty.
 *
 * qr.test.ts compares the result module for module with the `qrcode` package (a devDependency),
 * for every version and all eight masks. The penalty scoring follows that package where the
 * standard leaves room (finder-like patterns are only looked for inside the symbol; the dark/light
 * balance is rated with its rounding), so both choose the same mask. Any of the eight masks gives
 * a valid code: the reader learns which one from the format information.
 */

export interface QrOptions {
  /** Force a mask pattern (0–7) instead of choosing the one with the lowest penalty. */
  mask?: number;
  /** Force a version (1–40) instead of the smallest that fits. */
  version?: number;
}

export interface QrCode {
  version: number;
  mask: number;
  /** Modules per side: 17 + 4 × version. */
  size: number;
  /** modules[row][column], true = dark. Without the quiet zone. */
  modules: boolean[][];
}

/** Level M: error-correction codewords per block, and number of blocks, for versions 1–40. */
const ECC_PER_BLOCK = [
  10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
  26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];
const BLOCKS = [
  1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
  17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];
const MAX_VERSION = 40;
const BYTE_MODE = 0b0100;
/** Format information: the two level bits for M are 00. */
const LEVEL_M = 0b00;

/** Modules left for codewords once the function patterns are drawn. */
function rawModules(version: number): number {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (version >= 7) n -= 36;
  }
  return n;
}

function dataCodewords(version: number): number {
  return (rawModules(version) >>> 3) - ECC_PER_BLOCK[version - 1] * BLOCKS[version - 1];
}

/** Bits of the length field in byte mode. */
function lengthBits(version: number): number {
  return version < 10 ? 8 : 16;
}

/** How many bytes fit in a version at level M (byte mode). */
export function qrCapacity(version: number): number {
  return (dataCodewords(version) * 8 - 4 - lengthBits(version)) >>> 3;
}

// --- Reed-Solomon over GF(256), polynomial x^8 + x^4 + x^3 + x^2 + 1 ---

const EXP = new Uint8Array(510);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = EXP[i + 255] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}

function mul(a: number, b: number): number {
  return a && b ? EXP[LOG[a] + LOG[b]] : 0;
}

/** (x - 2^0)(x - 2^1)…(x - 2^(degree-1)), highest power first, without the leading 1. */
function rsGenerator(degree: number): Uint8Array {
  const g = new Uint8Array(degree);
  g[degree - 1] = 1;
  for (let i = 0, root = 1; i < degree; i++, root = mul(root, 2)) {
    for (let j = 0; j < degree; j++) {
      g[j] = mul(g[j], root);
      if (j + 1 < degree) g[j] ^= g[j + 1];
    }
  }
  return g;
}

/** The error-correction codewords of a block: the remainder of data · x^degree by the generator. */
function rsRemainder(data: Uint8Array, generator: Uint8Array): Uint8Array {
  const degree = generator.length;
  const r = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ r[0];
    r.copyWithin(0, 1);
    r[degree - 1] = 0;
    for (let i = 0; i < degree; i++) r[i] ^= mul(generator[i], factor);
  }
  return r;
}

// --- Codewords ---

/** Mode, length, data, terminator, padding: exactly the version's data codewords. */
function encodeData(bytes: Uint8Array, version: number): Uint8Array {
  const out = new Uint8Array(dataCodewords(version));
  const capacity = out.length * 8;
  let n = 0;
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--, n++) out[n >>> 3] |= ((value >>> i) & 1) << (7 - (n & 7));
  };
  put(BYTE_MODE, 4);
  put(bytes.length, lengthBits(version));
  for (const b of bytes) put(b, 8);
  n += Math.min(4, capacity - n); // terminator (the buffer is already zero)
  n = (n + 7) & ~7;
  for (let pad = 0xec; n < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  return out;
}

/** Splits the data into blocks, adds error correction to each and interleaves them. */
function addErrorCorrection(data: Uint8Array, version: number): Uint8Array {
  const blocks = BLOCKS[version - 1];
  const ecc = ECC_PER_BLOCK[version - 1];
  const total = rawModules(version) >>> 3;
  const shortData = Math.floor(total / blocks) - ecc; // the last (total % blocks) blocks hold one more
  const shortBlocks = blocks - (total % blocks);
  const generator = rsGenerator(ecc);
  const dataBlocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];
  for (let b = 0, at = 0; b < blocks; b++) {
    const length = shortData + (b < shortBlocks ? 0 : 1);
    const block = data.subarray(at, at + length);
    at += length;
    dataBlocks.push(block);
    eccBlocks.push(rsRemainder(block, generator));
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (let i = 0; i <= shortData; i++) for (const block of dataBlocks) if (i < block.length) out[p++] = block[i];
  for (let i = 0; i < ecc; i++) for (const block of eccBlocks) out[p++] = block[i];
  return out;
}

// --- The symbol ---

/** Centres of the alignment patterns along one axis. */
function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const out = [6];
  for (let pos = version * 4 + 10; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

/** BCH(15,5) code of the level and mask, XORed with the fixed pattern. */
function formatBits(mask: number): number {
  const data = (LEVEL_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** BCH(18,6) code of the version number (versions 7 and up). */
function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

const MASKS: ((row: number, col: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r * c) % 3) + ((r + c) % 2)) % 2 === 0,
];

class Grid {
  readonly size: number;
  /** 1 = dark; index row × size + column. */
  readonly dark: Uint8Array;
  /** 1 = part of a function pattern: not data, not masked. */
  readonly fixed: Uint8Array;

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.dark = new Uint8Array(this.size * this.size);
    this.fixed = new Uint8Array(this.size * this.size);
  }

  private fix(row: number, col: number, dark: boolean | number): void {
    const i = row * this.size + col;
    this.dark[i] = dark ? 1 : 0;
    this.fixed[i] = 1;
  }

  drawFunctionPatterns(): void {
    const { size, version } = this;
    // Timing patterns; the finders and alignment patterns drawn next overwrite their ends.
    for (let i = 0; i < size; i++) {
      this.fix(6, i, i % 2 === 0);
      this.fix(i, 6, i % 2 === 0);
    }
    // Finder patterns with their light separators (the part that falls inside the symbol).
    for (const [row, col] of [[3, 3], [3, size - 4], [size - 4, 3]]) {
      for (let dr = -4; dr <= 4; dr++) {
        for (let dc = -4; dc <= 4; dc++) {
          const r = row + dr;
          const c = col + dc;
          if (r < 0 || r >= size || c < 0 || c >= size) continue;
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          this.fix(r, c, ring !== 2 && ring !== 4);
        }
      }
    }
    // Alignment patterns, except where the finders are.
    const centres = alignmentPositions(version);
    const last = centres.length - 1;
    centres.forEach((row, i) =>
      centres.forEach((col, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) this.fix(row + dr, col + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
      }),
    );
    this.drawFormat(0); // reserves the modules; the real bits come once the mask is known
    if (version >= 7) {
      const bits = versionBits(version);
      for (let i = 0; i < 18; i++) {
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.fix(a, b, (bits >>> i) & 1);
        this.fix(b, a, (bits >>> i) & 1);
      }
    }
  }

  /** Both copies of the format information, and the dark module. */
  drawFormat(mask: number): void {
    const { size } = this;
    const bits = formatBits(mask);
    const bit = (i: number) => (bits >>> i) & 1;
    // Around the top-left finder.
    for (let i = 0; i <= 5; i++) this.fix(i, 8, bit(i));
    this.fix(7, 8, bit(6));
    this.fix(8, 8, bit(7));
    this.fix(8, 7, bit(8));
    for (let i = 9; i < 15; i++) this.fix(8, 14 - i, bit(i));
    // Split between the top-right and bottom-left finders.
    for (let i = 0; i < 8; i++) this.fix(8, size - 1 - i, bit(i));
    for (let i = 8; i < 15; i++) this.fix(size - 15 + i, 8, bit(i));
    this.fix(size - 8, 8, true);
  }

  /** Places the codeword bits: two-module columns from the right, alternately upwards and downwards. */
  drawCodewords(codewords: Uint8Array): void {
    const { size } = this;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // the vertical timing pattern takes a whole column
      const upward = ((right + 1) & 2) === 0;
      for (let step = 0; step < size; step++) {
        const row = upward ? size - 1 - step : step;
        for (let j = 0; j < 2; j++) {
          const at = row * size + right - j;
          if (this.fixed[at] || i >= codewords.length * 8) continue;
          this.dark[at] = (codewords[i >>> 3] >>> (7 - (i & 7))) & 1;
          i++;
        }
      }
    }
  }

  /** XORs the mask over the data modules. Applying it twice undoes it. */
  applyMask(mask: number): void {
    const { size } = this;
    const on = MASKS[mask];
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        const at = row * size + col;
        if (!this.fixed[at] && on(row, col)) this.dark[at] ^= 1;
      }
    }
  }

  /** How hard the symbol is to read: lower is better (ISO/IEC 18004 §7.8.3). */
  penalty(): number {
    const { size, dark } = this;
    let points = 0;

    // N1: runs of five or more modules of one colour in a row or column: 3, plus 1 per extra module.
    // N3: dark-light-dark-light-dark in 1:1:3:1:1 with four light modules on one side: 40 each.
    for (let a = 0; a < size; a++) {
      for (const stride of [1, size]) {
        const start = stride === 1 ? a * size : a;
        let run = 0;
        let colour = -1;
        let window = 0;
        for (let b = 0; b < size; b++) {
          const m = dark[start + b * stride];
          if (m === colour) run++;
          else {
            if (run >= 5) points += 3 + (run - 5);
            colour = m;
            run = 1;
          }
          window = ((window << 1) & 0x7ff) | m;
          if (b >= 10 && (window === 0b10111010000 || window === 0b00001011101)) points += 40;
        }
        if (run >= 5) points += 3 + (run - 5);
      }
    }

    // N2: 2×2 blocks of one colour: 3 each.
    for (let row = 0; row < size - 1; row++) {
      for (let col = 0; col < size - 1; col++) {
        const at = row * size + col;
        const sum = dark[at] + dark[at + 1] + dark[at + size] + dark[at + size + 1];
        if (sum === 0 || sum === 4) points += 3;
      }
    }

    // N4: 10 for every 5% the share of dark modules is away from 50%.
    let count = 0;
    for (let i = 0; i < dark.length; i++) count += dark[i];
    points += Math.abs(Math.ceil((count * 100) / dark.length / 5) - 10) * 10;

    return points;
  }

  rows(): boolean[][] {
    const { size, dark } = this;
    return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => dark[row * size + col] === 1));
  }
}

/**
 * Encodes text (as UTF-8) or bytes into a QR code at error-correction level M.
 * Throws when the data does not fit (2,331 bytes at most, or less in a forced version).
 */
export function qrCode(data: string | Uint8Array, options: QrOptions = {}): QrCode {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const { mask: forcedMask, version: forcedVersion } = options;
  if (forcedVersion !== undefined && !(Number.isInteger(forcedVersion) && forcedVersion >= 1 && forcedVersion <= MAX_VERSION)) {
    throw new RangeError('QR version must be 1 to 40.');
  }
  if (forcedMask !== undefined && !(Number.isInteger(forcedMask) && forcedMask >= 0 && forcedMask <= 7)) {
    throw new RangeError('QR mask must be 0 to 7.');
  }

  let version = forcedVersion ?? 1;
  if (forcedVersion === undefined) while (version < MAX_VERSION && qrCapacity(version) < bytes.length) version++;
  if (qrCapacity(version) < bytes.length) throw new Error('Too much data for a QR code.');

  const grid = new Grid(version);
  grid.drawFunctionPatterns();
  grid.drawCodewords(addErrorCorrection(encodeData(bytes, version), version));

  let mask = forcedMask ?? 0;
  if (forcedMask === undefined) {
    let best = Infinity;
    for (let m = 0; m < 8; m++) {
      grid.drawFormat(m);
      grid.applyMask(m);
      const penalty = grid.penalty();
      grid.applyMask(m);
      if (penalty < best) {
        best = penalty;
        mask = m;
      }
    }
  }
  grid.drawFormat(mask);
  grid.applyMask(mask);
  return { version, mask, size: grid.size, modules: grid.rows() };
}

/** The modules of the QR code for a text: matrix[row][column], true = dark, no quiet zone. */
export function qrMatrix(text: string, mask?: number): boolean[][] {
  return qrCode(text, { mask }).modules;
}

/**
 * The dark modules as one SVG path, in module units, inside a quiet zone of `margin` modules
 * (the standard asks for 4). Draw it in a `viewBox` of `0 0 size size`, dark on a light background.
 */
export function qrPath(modules: boolean[][], margin = 4): { d: string; size: number } {
  let d = '';
  modules.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      let end = x + 1;
      while (end < row.length && row[end]) end++;
      d += `M${x + margin} ${y + margin}h${end - x}v1h${x - end}z`;
      x = end;
    }
  });
  return { d, size: modules.length + margin * 2 };
}
