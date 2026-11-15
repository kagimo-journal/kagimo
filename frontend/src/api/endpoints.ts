/** Typed wrappers for every endpoint in SPEC §5. */
import { fromBase64, toBase64Url } from '../crypto/encoding';
import { getJSON, request, sendJSON } from './client';
import type {
  AdminInvite,
  AdminStats,
  AdminUser,
  Billing,
  ChallengeOptions,
  Config,
  EntryFull,
  EntryListItem,
  EntryMeta,
  WriteAck,
  Interval,
  KdfParams,
  LoginResult,
  Me,
  Passkey,
  RecoverVerifyResult,
  Sealed,
  SignupRequest,
  TotpSetup,
} from './types';

const enc = encodeURIComponent;

// ---- public ---------------------------------------------------------------

export const getConfig = () => getJSON<Config>('/api/config');

export const auth = {
  prelogin: (username: string) => sendJSON<{ kdf: KdfParams }>('POST', '/api/auth/prelogin', { username }, { quiet401: true }),
  login: (username: string, authKey: string) =>
    sendJSON<LoginResult>('POST', '/api/auth/login', { username, authKey }, { quiet401: true }),
  loginTotp: (code: string) => sendJSON<{ status: 'ok'; me: Me }>('POST', '/api/auth/login/totp', { code }, { quiet401: true }),
  /** Second sign-in step by passkey (mfa_pending session): allowCredentials = this user's passkeys. */
  loginPasskeyBegin: () => sendJSON<ChallengeOptions>('POST', '/api/auth/login/passkey/begin', {}, { quiet401: true }),
  loginPasskeyFinish: (challengeId: string, credential: unknown) =>
    sendJSON<{ status: 'ok'; me: Me }>('POST', '/api/auth/login/passkey/finish', { challengeId, credential }, { quiet401: true }),
  passkeyBegin: () => sendJSON<ChallengeOptions>('POST', '/api/auth/passkey/begin', {}, { quiet401: true }),
  passkeyFinish: (challengeId: string, credential: unknown) =>
    sendJSON<{ status: 'ok'; me: Me }>('POST', '/api/auth/passkey/finish', { challengeId, credential }, { quiet401: true }),
  recoverVerify: (username: string, recoveryAuthKey: string, totpCode?: string) =>
    sendJSON<RecoverVerifyResult>(
      'POST',
      '/api/auth/recover/verify',
      { username, recoveryAuthKey, ...(totpCode ? { totpCode } : {}) },
      { quiet401: true },
    ),
  recoverReset: (token: string, kdf: KdfParams, authKey: string, wrappedMkPass: Sealed) =>
    sendJSON<{ status: 'ok'; me: Me }>('POST', '/api/auth/recover/reset', { token, kdf, authKey, wrappedMkPass }, { quiet401: true }),
  logout: () => sendJSON('POST', '/api/auth/logout', {}, { quiet401: true }),
  /** Re-proves the passphrase for the current session (opens the window for security changes). */
  reauth: (authKey: string) => sendJSON('POST', '/api/auth/reauth', { authKey }, { noReauth: true }),
};

export const signup = (req: SignupRequest) => sendJSON<{ me: Me }>('POST', '/api/signup', req, { quiet401: true });

// ---- any authenticated user ------------------------------------------------

export const getMe = () => getJSON<Me>('/api/me', { quiet401: true });

export const passkeys = {
  registerBegin: (name: string) => sendJSON<ChallengeOptions>('POST', '/api/passkeys/register/begin', { name }),
  registerFinish: (challengeId: string, name: string, credential: unknown) =>
    sendJSON<{ passkey: Passkey }>('POST', '/api/passkeys/register/finish', { challengeId, name, credential }),
  setPrf: (id: string, wrappedMk: Sealed) => sendJSON('PUT', `/api/passkeys/${enc(id)}/prf`, { wrappedMk }),
  rename: (id: string, name: string) => sendJSON('PATCH', `/api/passkeys/${enc(id)}`, { name }),
  remove: (id: string) => sendJSON('DELETE', `/api/passkeys/${enc(id)}`),
};

export const totp = {
  setup: () => sendJSON<TotpSetup>('POST', '/api/totp/setup', {}),
  enable: (code: string) => sendJSON('POST', '/api/totp/enable', { code }),
  disable: (code: string) => sendJSON('POST', '/api/totp/disable', { code }),
};

export const account = {
  changePassphrase: (currentAuthKey: string, kdf: KdfParams, authKey: string, wrappedMkPass: Sealed) =>
    sendJSON('POST', '/api/account/passphrase', { currentAuthKey, kdf, authKey, wrappedMkPass }),
  regenerateRecovery: (recoveryAuthKey: string, wrappedMkRecovery: Sealed) =>
    sendJSON('POST', '/api/account/recovery', { recoveryAuthKey, wrappedMkRecovery }),
};

// ---- active users ------------------------------------------------------------

export const entries = {
  list: () => getJSON<EntryListItem[]>('/api/entries'),
  get: (id: string) => getJSON<EntryFull>(`/api/entries/${enc(id)}`),
  create: (id: string, header: Sealed, body: Sealed) =>
    sendJSON<EntryMeta>('POST', '/api/entries', { id, header, body }),
  update: (id: string, header: Sealed, body: Sealed, baseVersion: number) =>
    sendJSON<{ version: number; updatedAt: string; seq?: number }>('PUT', `/api/entries/${enc(id)}`, { header, body, baseVersion }),
  remove: (id: string) => sendJSON<WriteAck>('DELETE', `/api/entries/${enc(id)}`),
};

export const blobs = {
  upload: async (id: string, entryId: string, nonce: Uint8Array, ct: Uint8Array) => {
    const qs = `id=${enc(id)}&entryId=${enc(entryId)}&nonce=${enc(toBase64Url(nonce))}`;
    const res = await request(`/api/blobs?${qs}`, {
      method: 'POST',
      body: new Blob([new Uint8Array(ct)]),
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    return (await res.json()) as { id: string; size: number };
  },
  get: async (id: string): Promise<{ nonce: Uint8Array; ct: Uint8Array }> => {
    const res = await request(`/api/blobs/${enc(id)}`, { headers: { Accept: 'application/octet-stream' } });
    const nonceHeader = res.headers.get('X-Blob-Nonce');
    if (!nonceHeader) throw new Error('Image is missing its nonce');
    return { nonce: fromBase64(nonceHeader), ct: new Uint8Array(await res.arrayBuffer()) };
  },
  remove: (id: string) => sendJSON<WriteAck>('DELETE', `/api/blobs/${enc(id)}`),
};

export const settings = {
  get: async (): Promise<Sealed | null> => {
    const res = await request('/api/settings');
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? (JSON.parse(text) as Sealed) : null;
  },
  put: (sealed: Sealed) => sendJSON<WriteAck>('PUT', '/api/settings', sealed),
};

export interface SyncPage {
  cursor: number;
  more: boolean;
  entries: EntryFull[];
  blobs: { id: string; entryId?: string; size: number }[];
  deleted: { entries: string[]; blobs: string[] };
  settings: Sealed | null;
}

/** One page of the change feed (SPEC §5.2). */
export const syncChanges = (since: number) => getJSON<SyncPage>(`/api/sync?since=${since}`, { quiet401: true });

// ---- billing (SPEC §5.6) ----------------------------------------------------

export const billing = {
  /** A Stripe Checkout URL for the monthly or yearly plan. */
  checkout: (interval: Interval) => sendJSON<{ url: string }>('POST', '/api/billing/checkout', { interval }),
  /** A Stripe customer-portal URL (card, invoices, cancel). */
  portal: () => sendJSON<{ url: string }>('POST', '/api/billing/portal', {}),
  /** Re-reads the subscription from Stripe. */
  sync: () => sendJSON<Billing>('POST', '/api/billing/sync', {}),
};

// ---- admin -----------------------------------------------------------------

export const admin = {
  users: () => getJSON<AdminUser[]>('/api/admin/users'),
  stats: () => getJSON<AdminStats>('/api/admin/stats'),
  disable: (id: string) => sendJSON('POST', `/api/admin/users/${enc(id)}/disable`, {}),
  enable: (id: string) => sendJSON('POST', `/api/admin/users/${enc(id)}/enable`, {}),
  comp: (id: string) => sendJSON('POST', `/api/admin/users/${enc(id)}/comp`, {}),
  uncomp: (id: string) => sendJSON('POST', `/api/admin/users/${enc(id)}/uncomp`, {}),
  remove: (id: string) => sendJSON('DELETE', `/api/admin/users/${enc(id)}`),
  invites: () => getJSON<AdminInvite[]>('/api/admin/invites'),
  createInvite: (note: string) => sendJSON<AdminInvite>('POST', '/api/admin/invites', { note }),
  deleteInvite: (id: string) => sendJSON('DELETE', `/api/admin/invites/${enc(id)}`),
};
