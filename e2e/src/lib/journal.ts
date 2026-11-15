/**
 * Client-side journal operations for the e2e test. All cryptography comes from the
 * real frontend modules (../frontend/src/crypto), so the test exercises exactly the
 * code the browser runs; only the in-memory session store is bypassed.
 */
import * as OTPAuth from 'otpauth';
import { openBytes, openJSON, sealBytes, sealJSON, type Sealed } from '../../../frontend/src/crypto/aead';
import { toBase64, toBase64Url, fromBase64 } from '../../../frontend/src/crypto/encoding';
import { type KdfParams, newKdfParams } from '../../../frontend/src/crypto/kdf';
import {
  aad,
  deriveContentKey,
  derivePassphraseKeys,
  deriveRecoveryKeys,
  generateMasterKey,
  unwrapMasterKey,
  wrapMasterKey,
} from '../../../frontend/src/crypto/keys';
import { generateRecoveryKey, parseRecoveryKey } from '../../../frontend/src/crypto/recovery';
import type { ApiClient, ApiResponse } from './http';

export { toBase64, toBase64Url };

/** Thrown by expectStatus with the server's error code in the message. */
export function expectStatus<T>(res: ApiResponse<T>, status: number, code?: string, what = 'request'): ApiResponse<T> {
  const got = (res.body as { error?: string } | undefined)?.error;
  if (res.status !== status || (code !== undefined && got !== code)) {
    const detail = res.body !== undefined ? JSON.stringify(res.body) : `${res.bytes.length} bytes`;
    throw new Error(`${what}: expected ${status}${code ? ` ${code}` : ''}, got ${res.status} ${detail}`);
  }
  return res;
}

// ---- accounts ---------------------------------------------------------------

export interface Account {
  username: string;
  passphrase: string;
  /** The formatted recovery key, as the user would have written it down. */
  recoveryKey: string;
  /** Raw master key, kept only to assert it never reaches the database. */
  mk: Uint8Array;
  ck: CryptoKey;
  userId?: string;
}

/** Builds the signup request exactly like the SignUp page does (SPEC §3, §5). */
export async function signup(client: ApiClient, username: string, passphrase: string, note: string) {
  const kdf = newKdfParams();
  const pass = await derivePassphraseKeys(passphrase, kdf);
  const recovery = generateRecoveryKey();
  const rec = await deriveRecoveryKeys(recovery.bytes);
  const mk = generateMasterKey();
  const res = await client.post('/api/signup', {
    username,
    note,
    kdf,
    authKey: toBase64(pass.authKey),
    recoveryAuthKey: toBase64(rec.authKey),
    wrappedMkPass: await wrapMasterKey(pass.kek, mk),
    wrappedMkRecovery: await wrapMasterKey(rec.kek, mk),
  });
  expectStatus(res, 200, undefined, `signup ${username}`);
  const account: Account = {
    username,
    passphrase,
    recoveryKey: recovery.formatted,
    mk,
    ck: await deriveContentKey(mk),
    userId: res.body.me.id,
  };
  return { account, me: res.body.me, authKey: toBase64(pass.authKey) };
}

/** prelogin → derive authKey → login. Returns the login response (ok or totp_required). */
export async function passphraseLogin(client: ApiClient, username: string, passphrase: string) {
  const pre = expectStatus(await client.post('/api/auth/prelogin', { username }), 200, undefined, 'prelogin');
  const kdf = pre.body.kdf as KdfParams;
  const { authKey, kek } = await derivePassphraseKeys(passphrase, kdf);
  const res = await client.post('/api/auth/login', { username, authKey: toBase64(authKey) });
  return { res, kdf, kek };
}

/** Unwraps the master key from /api/me like the Unlock page does. */
export async function unlock(client: ApiClient, passphrase: string) {
  const me = expectStatus(await client.get('/api/me'), 200, undefined, 'GET /api/me').body;
  const { kek } = await derivePassphraseKeys(passphrase, me.keys.kdf);
  const mk = await unwrapMasterKey(kek, me.keys.wrappedMkPass);
  return { me, mk, ck: await deriveContentKey(mk) };
}

/** Recovery: verify with the recovery key (and TOTP), then set a new passphrase. */
export async function recover(
  client: ApiClient,
  username: string,
  recoveryKey: string,
  newPassphrase: string,
  totpCode?: string,
) {
  const rec = await deriveRecoveryKeys(parseRecoveryKey(recoveryKey));
  const verify = await client.post('/api/auth/recover/verify', {
    username,
    recoveryAuthKey: toBase64(rec.authKey),
    ...(totpCode ? { totpCode } : {}),
  });
  if (verify.status !== 200) return { verify };
  const mk = await unwrapMasterKey(rec.kek, verify.body.wrappedMkRecovery);
  const kdf = newKdfParams();
  const pass = await derivePassphraseKeys(newPassphrase, kdf);
  const reset = await client.post('/api/auth/recover/reset', {
    token: verify.body.token,
    kdf,
    authKey: toBase64(pass.authKey),
    wrappedMkPass: await wrapMasterKey(pass.kek, mk),
  });
  return { verify, reset, mk, token: verify.body.token as string };
}

// ---- content ------------------------------------------------------------------

export interface EntryHeader {
  v: 1;
  title: string;
  snippet: string;
  createdAt: string;
  tz: string;
  location: { label: string; precision: 'city' | 'neighbourhood' } | null;
  wordCount: number;
  imageCount: number;
}

export interface EntryBody {
  v: 1;
  doc: unknown;
}

export async function sealEntry(ck: CryptoKey, entryId: string, header: EntryHeader, body: EntryBody) {
  return {
    header: await sealJSON(ck, header, aad.entryHeader(entryId)),
    body: await sealJSON(ck, body, aad.entryBody(entryId)),
  };
}

export async function openEntry(ck: CryptoKey, entryId: string, sealed: { header: Sealed; body: Sealed }) {
  return {
    header: await openJSON<EntryHeader>(ck, sealed.header, aad.entryHeader(entryId)),
    body: await openJSON<EntryBody>(ck, sealed.body, aad.entryBody(entryId)),
  };
}

export async function uploadBlob(client: ApiClient, ck: CryptoKey, blobId: string, entryId: string, data: Uint8Array) {
  const { nonce, ct } = await sealBytes(ck, data, aad.blob(blobId));
  const qs = new URLSearchParams({ id: blobId, entryId, nonce: toBase64Url(nonce) });
  const res = await client.request('POST', `/api/blobs?${qs}`, { body: ct });
  return { res, ct };
}

export async function downloadBlob(client: ApiClient, ck: CryptoKey, blobId: string) {
  const res = expectStatus(await client.get(`/api/blobs/${blobId}`), 200, undefined, 'GET blob');
  const nonce = res.headers.get('X-Blob-Nonce');
  if (!nonce) throw new Error('blob response is missing X-Blob-Nonce');
  return { res, plaintext: await openBytes(ck, fromBase64(nonce), res.bytes, aad.blob(blobId)) };
}

// ---- TOTP ---------------------------------------------------------------------

/**
 * An authenticator app. The server rejects reuse of a time step, so each code is for a
 * step later than the last one used. When the current step is already used it takes the
 * next step (inside the server's ±1 skew window) or waits for time to move on.
 */
export class TotpDevice {
  private readonly totp: OTPAuth.TOTP;
  private lastStep = -1;

  constructor(otpauthUrl: string) {
    const parsed = OTPAuth.URI.parse(otpauthUrl);
    if (!(parsed instanceof OTPAuth.TOTP)) throw new Error('otpauth URL is not a TOTP URL');
    if (parsed.digits !== 6 || parsed.period !== 30) throw new Error(`unexpected TOTP params ${parsed.digits}/${parsed.period}`);
    this.totp = parsed;
  }

  get issuer() {
    return this.totp.issuer;
  }

  /** A code for a step the server has not seen yet. */
  async nextCode(): Promise<string> {
    let step = this.lastStep + 1;
    for (;;) {
      const current = Math.floor(Date.now() / 30_000);
      if (step < current) step = current;
      if (step <= current + 1) break;
      await new Promise((r) => setTimeout(r, (current + 1) * 30_000 - Date.now() + 50));
    }
    this.lastStep = step;
    return this.totp.generate({ timestamp: step * 30_000 + 1 });
  }

  /** The most recently issued code again (to test replay rejection). */
  lastCode(): string {
    return this.totp.generate({ timestamp: this.lastStep * 30_000 + 1 });
  }

  /** A code for a step far outside the skew window. */
  staleCode(): string {
    return this.totp.generate({ timestamp: Date.now() - 10 * 30_000 });
  }
}

/** setup → enable with a fresh code. Returns the device for later logins. */
export async function enableTotp(client: ApiClient, issuer: string) {
  const setup = expectStatus(await client.post('/api/totp/setup'), 200, undefined, 'totp setup').body;
  if (typeof setup.secret !== 'string' || !setup.otpauthUrl.startsWith('otpauth://totp/')) {
    throw new Error(`bad totp setup response ${JSON.stringify(setup)}`);
  }
  const device = new TotpDevice(setup.otpauthUrl);
  if (device.issuer !== issuer) throw new Error(`TOTP issuer ${device.issuer}, want ${issuer}`);
  expectStatus(await client.post('/api/totp/enable', { code: await device.nextCode() }), 200, undefined, 'totp enable');
  return device;
}
