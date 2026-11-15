import { type Bytes, randomBytes } from './encoding';

/** Crockford base32 alphabet (no I, L, O, U). */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_BYTES = 20; // 160 bits -> exactly 32 base32 characters

export class RecoveryKeyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoveryKeyFormatError';
  }
}

export function crockfordEncode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

function charValue(c: string): number {
  // Crockford decoding is forgiving about commonly confused characters.
  const ch = c === 'O' ? '0' : c === 'I' || c === 'L' ? '1' : c;
  const v = ALPHABET.indexOf(ch);
  if (v < 0) throw new RecoveryKeyFormatError(`"${c}" isn't a valid recovery key character`);
  return v;
}

export function crockfordDecode(input: string, expectedBytes?: number): Bytes {
  const clean = input.toUpperCase().replace(/[\s-]/g, '');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const c of clean) {
    buffer = (buffer << 5) | charValue(c);
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    buffer &= (1 << bits) - 1;
  }
  if (buffer !== 0) throw new RecoveryKeyFormatError('Recovery key has trailing bits set');
  if (expectedBytes !== undefined && out.length !== expectedBytes) {
    throw new RecoveryKeyFormatError('Recovery key should be 32 characters');
  }
  return new Uint8Array(out);
}

/** Formats 20 bytes as 8 groups of 4 Crockford base32 characters: `K7QF-2M9D-…`. */
export function formatRecoveryKey(bytes: Uint8Array): string {
  if (bytes.length !== RECOVERY_BYTES) throw new RecoveryKeyFormatError('Recovery key must be 20 bytes');
  return crockfordEncode(bytes).match(/.{4}/g)!.join('-');
}

/** Parses user input (any case, any grouping) into the 20 recovery-key bytes. */
export function parseRecoveryKey(input: string): Bytes {
  const clean = input.toUpperCase().replace(/[\s-]/g, '');
  if (clean.length !== 32) throw new RecoveryKeyFormatError('Recovery key should be 32 characters');
  return crockfordDecode(clean, RECOVERY_BYTES);
}

export function generateRecoveryKey(): { bytes: Bytes; formatted: string } {
  const bytes = randomBytes(RECOVERY_BYTES);
  return { bytes, formatted: formatRecoveryKey(bytes) };
}
