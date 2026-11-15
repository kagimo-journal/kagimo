import { describe, expect, it, vi } from 'vitest';
import { DecryptError, open, openJSON, seal, sealJSON } from './aead';
import { decryptBlob, decryptEntryPart, encryptBlob, encryptEntryPart } from './content';
import { equalBytes, fromBase64, fromHex, randomBytes, toBase64, toBase64Url, toHex, utf8 } from './encoding';
import { argon2Root, checkKdfParams, DEFAULT_KDF, hkdf, hkdfAesKey, KdfParamsError, newKdfParams, sha256 } from './kdf';
import {
  aad,
  AAD_MK,
  deriveContentKey,
  derivePassphraseKeys,
  derivePrfKek,
  deriveRecoveryKeys,
  generateMasterKey,
  prfSalt,
  unwrapMasterKey,
  wrapMasterKey,
} from './keys';
import {
  crockfordDecode,
  crockfordEncode,
  formatRecoveryKey,
  generateRecoveryKey,
  parseRecoveryKey,
  RecoveryKeyFormatError,
} from './recovery';
import { isPinWrap, PIN_ATTEMPTS, pinProblem, unwrapWithPin, wrapWithPin } from './pin';
import * as session from './session';

describe('encoding', () => {
  it('base64 roundtrips and accepts base64url', () => {
    const b = randomBytes(37);
    expect(equalBytes(fromBase64(toBase64(b)), b)).toBe(true);
    expect(equalBytes(fromBase64(toBase64Url(b)), b)).toBe(true);
    expect(toBase64(utf8('hi?>'))).toBe('aGk/Pg==');
    expect(toBase64Url(utf8('hi?>'))).toBe('aGk_Pg');
  });
});

describe('HKDF-SHA256', () => {
  // RFC 5869, test case 1
  it('matches RFC 5869 test case 1', async () => {
    const okm = await hkdf(fromHex('0b'.repeat(22)), fromHex('000102030405060708090a0b0c'), fromHex('f0f1f2f3f4f5f6f7f8f9'), 42);
    expect(toHex(okm)).toBe('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
  });

  // RFC 5869, test case 3 (empty salt and info) — the salt=∅ case used throughout SPEC §3
  it('matches RFC 5869 test case 3 (empty salt)', async () => {
    const okm = await hkdf(fromHex('0b'.repeat(22)), null, new Uint8Array(0), 42);
    expect(toHex(okm)).toBe('8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8');
  });

  it('separates keys by info label', async () => {
    const ikm = randomBytes(32);
    const a = await hkdf(ikm, null, 'journal/auth/v1');
    const b = await hkdf(ikm, null, 'journal/kek/v1');
    expect(equalBytes(a, b)).toBe(false);
  });
});

describe('AES-GCM sealing', () => {
  it('roundtrips with matching AAD', async () => {
    const key = await hkdfAesKey(randomBytes(32), null, 'test');
    const sealed = await seal(key, utf8('hello'), 'entry:1:body');
    expect(fromBase64(sealed.nonce)).toHaveLength(12);
    const pt = await open(key, sealed, 'entry:1:body');
    expect(new TextDecoder().decode(pt)).toBe('hello');
  });

  it('uses a fresh nonce for every ciphertext', async () => {
    const key = await hkdfAesKey(randomBytes(32), null, 'test');
    const a = await seal(key, utf8('same'), 'x');
    const b = await seal(key, utf8('same'), 'x');
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ct).not.toBe(b.ct);
  });

  it('fails when the AAD does not match', async () => {
    const key = await hkdfAesKey(randomBytes(32), null, 'test');
    const sealed = await sealJSON(key, { a: 1 }, 'entry:abc:header');
    await expect(openJSON(key, sealed, 'entry:abc:body')).rejects.toBeInstanceOf(DecryptError);
    await expect(openJSON(key, sealed, 'entry:abd:header')).rejects.toBeInstanceOf(DecryptError);
    await expect(openJSON(key, sealed, 'entry:abc:header')).resolves.toEqual({ a: 1 });
  });

  it('fails with the wrong key or tampered ciphertext', async () => {
    const k1 = await hkdfAesKey(randomBytes(32), null, 'test');
    const k2 = await hkdfAesKey(randomBytes(32), null, 'test');
    const sealed = await seal(k1, utf8('secret'), 'a');
    await expect(open(k2, sealed, 'a')).rejects.toBeInstanceOf(DecryptError);
    const ct = fromBase64(sealed.ct);
    ct[0] ^= 1;
    await expect(open(k1, { nonce: sealed.nonce, ct: toBase64(ct) }, 'a')).rejects.toBeInstanceOf(DecryptError);
  });
});

describe('master key wrapping', () => {
  it('wraps and unwraps MK with a passphrase-derived KEK', async () => {
    const kdf = newKdfParams();
    const mk = generateMasterKey();
    const { kek, authKey } = await derivePassphraseKeys('lantern orchard quietly ninety', kdf);
    expect(authKey).toHaveLength(32);
    const wrapped = await wrapMasterKey(kek, mk);
    const again = await derivePassphraseKeys('lantern orchard quietly ninety', kdf);
    expect(toHex(again.authKey)).toBe(toHex(authKey));
    expect(equalBytes(await unwrapMasterKey(again.kek, wrapped), mk)).toBe(true);
    // also accepts the JSON-string form
    expect(equalBytes(await unwrapMasterKey(again.kek, JSON.stringify(wrapped)), mk)).toBe(true);
  });

  it('rejects the wrong passphrase', async () => {
    const kdf = newKdfParams();
    const { kek } = await derivePassphraseKeys('right passphrase here', kdf);
    const wrapped = await wrapMasterKey(kek, generateMasterKey());
    const wrong = await derivePassphraseKeys('wrong passphrase here', kdf);
    await expect(unwrapMasterKey(wrong.kek, wrapped)).rejects.toBeInstanceOf(DecryptError);
  });

  it('binds the wrapped MK to its AAD', async () => {
    const key = await hkdfAesKey(randomBytes(32), null, 'k');
    const notMk = await seal(key, randomBytes(32), 'journal/other');
    await expect(unwrapMasterKey(key, notMk)).rejects.toBeInstanceOf(DecryptError);
    const ok = await seal(key, randomBytes(32), AAD_MK);
    await expect(unwrapMasterKey(key, ok)).resolves.toHaveLength(32);
  });

  it('wraps MK with the recovery key and a PRF output', async () => {
    const mk = generateMasterKey();
    const rec = generateRecoveryKey();
    const rk = await deriveRecoveryKeys(rec.bytes);
    const wrapped = await wrapMasterKey(rk.kek, mk);
    const rk2 = await deriveRecoveryKeys(parseRecoveryKey(rec.formatted.toLowerCase()));
    expect(toHex(rk2.authKey)).toBe(toHex(rk.authKey));
    expect(equalBytes(await unwrapMasterKey(rk2.kek, wrapped), mk)).toBe(true);

    const prfOut = randomBytes(32);
    const prfWrapped = await wrapMasterKey(await derivePrfKek(prfOut), mk);
    expect(equalBytes(await unwrapMasterKey(await derivePrfKek(prfOut), prfWrapped), mk)).toBe(true);
  });

  it('derives the recovery auth key with the spec salt and info', async () => {
    const bytes = new Uint8Array(20).fill(7);
    const { authKey } = await deriveRecoveryKeys(bytes);
    expect(toHex(authKey)).toBe(toHex(await hkdf(bytes, 'journal/recovery/v1', 'auth')));
  });

  it('uses SHA-256("journal/prf-salt/v1") as the PRF salt', async () => {
    expect(toHex(await prfSalt())).toBe(toHex(await sha256('journal/prf-salt/v1')));
  });
});

describe('argon2id', () => {
  it('produces 32 deterministic bytes with the default parameters', async () => {
    const kdf = { salt: toBase64(new Uint8Array(16).fill(1)), ...DEFAULT_KDF };
    const a = await argon2Root('correct horse battery staple', kdf);
    const b = await argon2Root('correct horse battery staple', kdf);
    expect(a).toHaveLength(32);
    expect(toHex(a)).toBe(toHex(b));
    const c = await argon2Root('correct horse battery stapler', kdf);
    expect(toHex(a)).not.toBe(toHex(c));
  });

  it('refuses server-supplied parameters below the spec floor (downgrade) or absurdly high', async () => {
    const salt = toBase64(new Uint8Array(16).fill(1));
    const bad = [
      { salt, m: 8, t: 1, p: 1 },
      { salt, m: 65536, t: 2, p: 1 },
      { salt, m: 32768, t: 3, p: 1 },
      { salt, m: 65536, t: 3, p: 0 },
      { salt, m: 65536.5, t: 3, p: 1 },
      { salt, m: 1 << 22, t: 3, p: 1 },
      { salt: toBase64(new Uint8Array(8)), m: 65536, t: 3, p: 1 },
      { salt: 'not base64!', m: 65536, t: 3, p: 1 },
    ];
    for (const kdf of bad) {
      expect(() => checkKdfParams(kdf)).toThrow(KdfParamsError);
      await expect(argon2Root('correct horse battery staple', kdf)).rejects.toBeInstanceOf(KdfParamsError);
    }
    expect(checkKdfParams({ salt, ...DEFAULT_KDF })).toHaveLength(16);
  });
});

describe('recovery key encoding', () => {
  it('formats 20 bytes as 8 groups of 4', () => {
    const { formatted } = generateRecoveryKey();
    expect(formatted).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
  });

  it('roundtrips encode/decode', () => {
    for (let i = 0; i < 50; i++) {
      const bytes = randomBytes(20);
      expect(equalBytes(parseRecoveryKey(formatRecoveryKey(bytes)), bytes)).toBe(true);
    }
  });

  it('matches a known vector', () => {
    expect(crockfordEncode(new Uint8Array(20))).toBe('0'.repeat(32));
    expect(crockfordEncode(new Uint8Array(20).fill(0xff))).toBe('Z'.repeat(32));
    expect(crockfordEncode(utf8('f'))).toBe('CR');
    expect(crockfordEncode(utf8('foobar'))).toBe('CSQPYRK1E8');
    expect(new TextDecoder().decode(crockfordDecode('CSQPYRK1E8'))).toBe('foobar');
  });

  it('is forgiving about case, spacing and confusable characters', () => {
    const bytes = randomBytes(20);
    const f = formatRecoveryKey(bytes);
    const messy = ` ${f.toLowerCase().replace(/-/g, ' ')} `.replace(/0/g, 'o').replace(/1/g, 'l');
    expect(equalBytes(parseRecoveryKey(messy), bytes)).toBe(true);
  });

  it('rejects invalid input', () => {
    expect(() => parseRecoveryKey('ABCD')).toThrow(RecoveryKeyFormatError);
    expect(() => parseRecoveryKey('U'.repeat(32))).toThrow(RecoveryKeyFormatError);
  });
});

describe('in-memory session', () => {
  it('encrypts entries only while unlocked and binds them to their slot', async () => {
    const mk = generateMasterKey();
    await session.unlock('user-1', mk);
    expect(session.isUnlocked()).toBe(true);
    const header = { v: 1, title: 'A long walk after the rain' };
    const sealed = await encryptEntryPart('e1', 'header', header);
    await expect(decryptEntryPart('e1', 'header', sealed)).resolves.toEqual(header);
    await expect(decryptEntryPart('e1', 'body', sealed)).rejects.toBeInstanceOf(DecryptError);
    await expect(decryptEntryPart('e2', 'header', sealed)).rejects.toBeInstanceOf(DecryptError);

    const img = randomBytes(1000);
    const blob = await encryptBlob('b1', img);
    expect(equalBytes(await decryptBlob('b1', blob.nonce, blob.ct), img)).toBe(true);
    await expect(decryptBlob('b2', blob.nonce, blob.ct)).rejects.toBeInstanceOf(DecryptError);

    // same MK -> same content key
    const ck = await deriveContentKey(mk);
    const direct = await openJSON(ck, sealed, aad.entryHeader('e1'));
    expect(direct).toEqual(header);

    session.lockNow();
    expect(session.isUnlocked()).toBe(false);
    expect(() => session.contentKey()).toThrow(session.LockedError);
  });
});

describe('PIN unlock', () => {
  const graceMs = 60 * 60_000;

  it('rejects guessable PINs', () => {
    expect(pinProblem('12a4')).not.toBeNull();
    expect(pinProblem('123')).not.toBeNull();
    expect(pinProblem('123456789')).not.toBeNull();
    expect(pinProblem('2580')).not.toBeNull();
    expect(pinProblem('000000')).not.toBeNull();
    expect(pinProblem('345678')).not.toBeNull();
    expect(pinProblem('987654')).not.toBeNull();
    expect(pinProblem('271828')).toBeNull();
    expect(pinProblem('190483')).toBeNull();
  });

  it('wraps the master key under the PIN', async () => {
    const mk = generateMasterKey();
    const wrap = await wrapWithPin('2580', mk);
    expect(isPinWrap(wrap)).toBe(true);
    expect(equalBytes(await unwrapWithPin('2580', wrap), mk)).toBe(true);
    await expect(unwrapWithPin('2581', wrap)).rejects.toBeInstanceOf(DecryptError);
  });

  it('reopens a locked journal with the PIN, within the limits', async () => {
    const mk = generateMasterKey();
    const wrap = await wrapWithPin('2580', mk);
    await session.unlock('user-1', mk);
    session.setPinUnlock({ wrap, graceMs });
    await session.lock();
    expect(session.isUnlocked()).toBe(false);
    expect(session.isPinLocked()).toBe(true);
    expect(() => session.contentKey()).toThrow(session.LockedError);

    await expect(session.unlockWithPin('1111')).resolves.toBe('wrong');
    expect(session.pinAttemptsLeft()).toBe(PIN_ATTEMPTS - 1);
    await expect(session.unlockWithPin('2580')).resolves.toBe('ok');
    expect(session.isUnlocked()).toBe(true);
    expect(session.isPinLocked()).toBe(false);
    expect(equalBytes(session.masterKeyCopy(), mk)).toBe(true);
    session.lockNow();
  });

  it('needs the passphrase after too many wrong PINs', async () => {
    const mk = generateMasterKey();
    await session.unlock('user-1', mk);
    session.setPinUnlock({ wrap: await wrapWithPin('2580', mk), graceMs });
    await session.lock();
    for (let i = 1; i < PIN_ATTEMPTS; i++) await expect(session.unlockWithPin('1111')).resolves.toBe('wrong');
    await expect(session.unlockWithPin('1111')).resolves.toBe('too-many');
    expect(session.isPinLocked()).toBe(false);
    await expect(session.unlockWithPin('2580')).resolves.toBe('expired');
    expect(session.isUnlocked()).toBe(false);
  });

  it('needs the passphrase once the journal has been inactive too long', async () => {
    const mk = generateMasterKey();
    const wrap = await wrapWithPin('2580', mk);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await session.unlock('user-1', mk);
      session.setPinUnlock({ wrap, graceMs });
      await session.lock();
      expect(session.isPinLocked()).toBe(true);
      clock.mockReturnValue(now + graceMs);
      expect(session.isPinLocked()).toBe(false);
      await expect(session.unlockWithPin('2580')).resolves.toBe('expired');

      // Locking after the limit has already passed is a full lock straight away.
      clock.mockReturnValue(now);
      await session.unlock('user-1', mk);
      session.setPinUnlock({ wrap, graceMs });
      clock.mockReturnValue(now + graceMs + 1);
      await session.lock();
      expect(session.isPinLocked()).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it('a full lock, a reload-style lock or no PIN set all need the passphrase', async () => {
    const mk = generateMasterKey();
    const wrap = await wrapWithPin('2580', mk);
    await session.unlock('user-1', mk);
    session.setPinUnlock({ wrap, graceMs });
    await session.lock({ full: true });
    expect(session.isPinLocked()).toBe(false);

    await session.unlock('user-1', mk);
    session.setPinUnlock({ wrap, graceMs });
    await session.lock();
    session.lockNow();
    expect(session.isPinLocked()).toBe(false);

    // The PIN setting belongs to one unlock: it's cleared on lock and re-applied from settings.
    await session.unlock('user-1', mk);
    await session.lock();
    expect(session.isPinLocked()).toBe(false);
  });
});
