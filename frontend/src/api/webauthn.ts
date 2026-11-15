/**
 * WebAuthn helpers: JSON <-> ArrayBuffer conversion for the server library's option/response
 * formats, plus the PRF extension used to unlock the journal with a passkey (SPEC §3, §5).
 *
 * PRF outputs are secrets: they are never included in anything sent to the server.
 */
import { type Bytes, fromBase64Url, randomBytes, toBase64Url } from '../crypto/encoding';
import { derivePrfKek, prfSalt, unwrapMasterKey, wrapMasterKey } from '../crypto/keys';
import { auth, passkeys } from './endpoints';
import { desktop } from '../desktop/bridge';
import type { Me, Passkey, PasskeyWrap } from './types';

/** False in the desktop app: a passkey belongs to the website's address, which the app doesn't have. */
export function webauthnSupported(): boolean {
  return !desktop && typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function' && !!navigator.credentials;
}

type Json = Record<string, unknown>;

function unwrapPublicKey(options: unknown): Json {
  const o = (options ?? {}) as Json;
  return ((o.publicKey as Json | undefined) ?? o) as Json;
}

function b64urlToBuf(v: unknown): Bytes {
  if (typeof v !== 'string') throw new Error('Malformed WebAuthn options');
  return fromBase64Url(v);
}

function descriptors(list: unknown): PublicKeyCredentialDescriptor[] | undefined {
  if (!Array.isArray(list)) return undefined;
  return list.map((d: Json) => ({
    type: 'public-key',
    id: b64urlToBuf(d.id),
    ...(Array.isArray(d.transports) ? { transports: d.transports as AuthenticatorTransport[] } : {}),
  }));
}

/** Converts server creation options (JSON, base64url) into the browser's binary form. */
export function toCreationOptions(options: unknown, salt?: Bytes): PublicKeyCredentialCreationOptions {
  const pk = unwrapPublicKey(options);
  const user = pk.user as Json;
  const extensions = { ...((pk.extensions as Json | undefined) ?? {}) } as Json;
  // Ask the authenticator to enable PRF; some also return an evaluation at creation time.
  extensions.prf = salt ? { eval: { first: salt } } : {};
  // The PRF wrap made from this credential unlocks the journal, so the authenticator must verify
  // the user (PIN or biometric), whatever the server asked for (security review L4).
  const selection = { ...((pk.authenticatorSelection as Json | undefined) ?? {}), userVerification: 'required' };
  return {
    ...(pk as object),
    challenge: b64urlToBuf(pk.challenge),
    user: { ...(user as object), id: b64urlToBuf(user.id) } as unknown as PublicKeyCredentialUserEntity,
    excludeCredentials: descriptors(pk.excludeCredentials),
    authenticatorSelection: selection,
    extensions: extensions as AuthenticationExtensionsClientInputs,
  } as unknown as PublicKeyCredentialCreationOptions;
}

/**
 * Converts server request options into the browser form. With a salt, the PRF extension is added
 * so a passkey with a PRF wrap can unlock the journal in the same ceremony.
 */
export function toRequestOptions(options: unknown, salt: Bytes | null): PublicKeyCredentialRequestOptions {
  const pk = unwrapPublicKey(options);
  const extensions = { ...((pk.extensions as Json | undefined) ?? {}) } as Json;
  if (salt) extensions.prf = { eval: { first: salt } };
  const allow = descriptors(pk.allowCredentials);
  return {
    ...(pk as object),
    challenge: b64urlToBuf(pk.challenge),
    ...(allow && allow.length ? { allowCredentials: allow } : { allowCredentials: [] }),
    // Whatever the server's options say: a passkey that signs in or unlocks must verify the person.
    userVerification: 'required',
    extensions: extensions as AuthenticationExtensionsClientInputs,
  } as PublicKeyCredentialRequestOptions;
}

const buf = (b: ArrayBuffer | null | undefined) => (b ? toBase64Url(new Uint8Array(b)) : undefined);

/** Serialises a credential into WebAuthn JSON. Extension results (incl. PRF) are stripped. */
export function credentialToJSON(cred: PublicKeyCredential): Json {
  const r = cred.response;
  const response: Json = { clientDataJSON: buf(r.clientDataJSON) };
  if ('attestationObject' in r) {
    const att = r as AuthenticatorAttestationResponse;
    response.attestationObject = buf(att.attestationObject);
    if (typeof att.getTransports === 'function') response.transports = att.getTransports();
  } else {
    const asr = r as AuthenticatorAssertionResponse;
    response.authenticatorData = buf(asr.authenticatorData);
    response.signature = buf(asr.signature);
    const uh = buf(asr.userHandle);
    if (uh) response.userHandle = uh;
  }
  return {
    id: cred.id,
    rawId: buf(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    response,
    clientExtensionResults: {},
  };
}

/** Returns the PRF output for the constant salt, if the authenticator produced one. */
export function prfOutput(cred: PublicKeyCredential): Bytes | null {
  const ext = cred.getClientExtensionResults() as { prf?: { results?: { first?: BufferSource } } };
  const first = ext.prf?.results?.first;
  if (!first) return null;
  const view = first instanceof ArrayBuffer ? new Uint8Array(first) : new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
  return new Uint8Array(view);
}

export function sameCredentialId(a: string, b: string): boolean {
  try {
    return toBase64Url(fromBase64Url(a)) === toBase64Url(fromBase64Url(b));
  } catch {
    return false;
  }
}

async function unwrapWithPrf(prf: Bytes, credentialId: string, wraps: PasskeyWrap[]): Promise<Bytes | null> {
  const wrap = wraps.find((w) => sameCredentialId(w.credentialId, credentialId));
  if (!wrap) return null;
  try {
    return await unwrapMasterKey(await derivePrfKek(prf), wrap.wrappedMk);
  } finally {
    prf.fill(0);
  }
}

// ---- flows -------------------------------------------------------------------

/** Discoverable passkey sign-in. Returns the MK too when the passkey can unlock the journal. */
export async function signInWithPasskey(signal?: AbortSignal): Promise<{ me: Me; mk: Bytes | null }> {
  const { challengeId, options } = await auth.passkeyBegin();
  const salt = await prfSalt();
  const cred = (await navigator.credentials.get({ publicKey: toRequestOptions(options, salt), signal })) as PublicKeyCredential | null;
  if (!cred) throw new DOMException('No credential', 'NotAllowedError');
  const prf = prfOutput(cred);
  const { me } = await auth.passkeyFinish(challengeId, credentialToJSON(cred));
  let mk: Bytes | null = null;
  if (prf) {
    try {
      mk = await unwrapWithPrf(prf, cred.id, me.keys?.passkeyWraps ?? []);
    } catch {
      mk = null; // fall back to passphrase unlock
    }
  }
  return { me, mk };
}

/**
 * Second sign-in step after the passphrase (`passkey_required`, or `totp_required` with
 * `passkeyAllowed`): an assertion from one of this account's own passkeys, user verification
 * required (SPEC §5.1). The journal is unlocked with the passphrase already typed, so no PRF.
 */
export async function passkeySecondStep(signal?: AbortSignal): Promise<Me> {
  const { challengeId, options } = await auth.loginPasskeyBegin();
  const publicKey = toRequestOptions(options, null);
  publicKey.userVerification = 'required';
  const cred = (await navigator.credentials.get({ publicKey, signal })) as PublicKeyCredential | null;
  if (!cred) throw new DOMException('No credential', 'NotAllowedError');
  const { me } = await auth.loginPasskeyFinish(challengeId, credentialToJSON(cred));
  return me;
}

/**
 * Unlocks with a passkey that has a PRF wrap. This is a local ceremony: only the PRF output
 * is needed, so the challenge is random and nothing is sent to the server.
 */
export async function unlockWithPasskey(wraps: PasskeyWrap[]): Promise<Bytes> {
  if (!wraps.length) throw new Error('None of your passkeys can unlock the journal yet.');
  const salt = await prfSalt();
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      allowCredentials: wraps.map((w) => ({ type: 'public-key' as const, id: fromBase64Url(w.credentialId) })),
      userVerification: 'required',
      timeout: 120_000,
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new DOMException('No credential', 'NotAllowedError');
  const prf = prfOutput(cred);
  if (!prf) throw new Error("This passkey can't unlock the journal on this device. Use your passphrase.");
  const mk = await unwrapWithPrf(prf, cred.id, wraps);
  if (!mk) throw new Error("That passkey isn't set up to unlock the journal. Use your passphrase.");
  return mk;
}

/** Evaluates PRF for one known credential (the follow-up get() after registration). */
async function evaluatePrf(credentialId: Bytes): Promise<Bytes | null> {
  const salt = await prfSalt();
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      allowCredentials: [{ type: 'public-key', id: credentialId }],
      // The PRF output becomes a key that unlocks the journal: insist on user verification (L4).
      userVerification: 'required',
      timeout: 120_000,
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  return cred ? prfOutput(cred) : null;
}

export interface RegisteredPasskey {
  passkey: Passkey;
  /** true when the passkey can now unlock the journal (PRF wrap stored). */
  canUnlock: boolean;
}

/**
 * Registers a new passkey. If `mk` is given (journal unlocked) and the authenticator supports PRF,
 * the MK is wrapped with the PRF-derived key and stored server-side for passkey unlock.
 */
export async function registerPasskey(name: string, mk: Uint8Array | null): Promise<RegisteredPasskey> {
  const { challengeId, options } = await passkeys.registerBegin(name);
  const salt = await prfSalt();
  const cred = (await navigator.credentials.create({ publicKey: toCreationOptions(options, salt) })) as PublicKeyCredential | null;
  if (!cred) throw new DOMException('No credential', 'NotAllowedError');
  const ext = cred.getClientExtensionResults() as { prf?: { enabled?: boolean } };
  let prf = prfOutput(cred);
  const { passkey } = await passkeys.registerFinish(challengeId, name, credentialToJSON(cred));
  if (!mk) return { passkey, canUnlock: false };

  try {
    // create() often reports prf.enabled without results; confirm with a follow-up get().
    if (!prf && ext.prf?.enabled !== false) prf = await evaluatePrf(new Uint8Array(cred.rawId));
    if (!prf) return { passkey, canUnlock: false };
    const wrapped = await wrapMasterKey(await derivePrfKek(prf), mk);
    prf.fill(0);
    await passkeys.setPrf(passkey.id, wrapped);
    return { passkey: { ...passkey, prf: true }, canUnlock: true };
  } catch {
    // The passkey itself was registered; it just can't unlock the journal.
    return { passkey, canUnlock: false };
  }
}

/**
 * Lets an existing passkey unlock the journal: evaluates PRF for that credential and stores the
 * PRF-wrapped MK. Returns false when the authenticator doesn't support PRF.
 */
export async function enablePasskeyUnlock(passkey: Passkey, mk: Uint8Array): Promise<boolean> {
  if (!passkey.credentialId) return false;
  const prf = await evaluatePrf(fromBase64Url(passkey.credentialId));
  if (!prf) return false;
  try {
    await passkeys.setPrf(passkey.id, await wrapMasterKey(await derivePrfKek(prf), mk));
    return true;
  } finally {
    prf.fill(0);
  }
}

/** A friendly default name for a passkey created on this device. */
export function defaultPasskeyName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Linux/.test(ua)) return 'Linux computer';
  return 'This device';
}
