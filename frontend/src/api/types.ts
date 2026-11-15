import type { Sealed } from '../crypto/aead';
import type { KdfParams } from '../crypto/kdf';

export type { Sealed, KdfParams };

export interface Config {
  rpId: string;
  rpName: string;
  bootstrap: boolean;
  /** Some account has signed in on this browser before (the server saw its device cookie). */
  returning: boolean;
  billing?: PlanInfo;
  /** Desktop app installers this server offers (at `url`, or `/download/<name>`); absent when it has none. */
  downloads?: Download[];
}

export interface Download {
  platform: 'linux' | 'mac' | 'windows';
  name: string;
  size: number;
  /** Where to download it, when that isn't this server (a GitHub release). */
  url?: string;
}

export type Interval = 'month' | 'year';

/** One price of the subscription. `amount` is in the currency's smallest unit (500 = $5). */
export interface Price {
  amount: number;
  currency: string;
  interval: Interval;
}

/** The paid plan, as advertised by /api/config. `paidBytes` is the fair-use cap once subscribed. */
export type PlanInfo =
  | { enabled: false }
  | { enabled: true; freeBytes: number; freeDays: number; paidBytes: number; prices: Price[] };

/** Where the account stands (SPEC §5.6). `unlimited` = billing is off on this server. */
export type PlanKind = 'unlimited' | 'admin' | 'comped' | 'subscribed' | 'free';

export interface Billing {
  enabled: boolean;
  plan: PlanKind;
  /** What the free plan may store on the server (entries, images, settings; as ciphertext). */
  freeBytes: number;
  /** What this account stores on the server now. */
  usedBytes: number;
  /** This account's cap now: freeBytes on the free plan, the fair-use cap once paid, -1 for none. */
  limitBytes: number;
  /** At or over limitBytes: the server takes nothing new (until it subscribes, on the free plan). */
  full: boolean;
  /** Free plan only: when its free sync period ends (or ended), and whether it has. */
  freeUntil: string | null;
  freeOver: boolean;
  /** Stripe subscription status ("active", "past_due", "canceled", …) or "". */
  status: string;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  hasCustomer: boolean;
}

export type UserStatus = 'active' | 'disabled';

export interface Passkey {
  id: string;
  /** base64url WebAuthn credential ID */
  credentialId?: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  prf: boolean;
}

export interface PasskeyWrap {
  /** base64url credential ID */
  credentialId: string;
  wrappedMk: Sealed;
}

export interface Me {
  id: string;
  username: string;
  status: UserStatus;
  isAdmin: boolean;
  totpEnabled: boolean;
  passkeys: Passkey[];
  hasSecondFactor: boolean;
  keys: {
    kdf: KdfParams;
    wrappedMkPass: Sealed;
    passkeyWraps: PasskeyWrap[];
  };
  billing: Billing;
}

/** POST /api/auth/login (SPEC §5.1 "Passphrase sign-in"). A pending response never contains `me`. */
export type LoginResult =
  | { status: 'ok'; me: Me }
  | { status: 'totp_required'; passkeyAllowed?: boolean }
  | { status: 'passkey_required' };

export interface ChallengeOptions {
  challengeId: string;
  /** WebAuthn JSON options as produced by the server library (may be wrapped in {publicKey}). */
  options: unknown;
}

export interface SignupRequest {
  username: string;
  note: string;
  kdf: KdfParams;
  authKey: string;
  recoveryAuthKey: string;
  wrappedMkPass: Sealed;
  wrappedMkRecovery: Sealed;
  /** An admin-minted invite code: the account gets free access. */
  invite?: string;
}

export interface RecoverVerifyResult {
  token: string;
  wrappedMkRecovery: Sealed;
}

export interface TotpSetup {
  secret: string;
  otpauthUrl: string;
}

export interface EntryMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  /** Change-feed seq the write took (SPEC §5.2); absent from servers before it was added. */
  seq?: number;
}

/** Answer to a delete or settings write: the change-feed seq it took. */
export interface WriteAck {
  seq?: number;
}

export interface EntryListItem extends EntryMeta {
  header: Sealed;
}

export interface EntryFull extends EntryListItem {
  body: Sealed;
}

export interface AdminUser {
  id: string;
  username: string;
  note: string;
  status: UserStatus;
  isAdmin: boolean;
  createdAt: string;
  approvedAt: string | null;
  lastActiveAt: string | null;
  storageBytes: number;
  passkeyCount: number;
  totpEnabled: boolean;
  hasSecondFactor: boolean;
  plan: PlanKind;
  freeBytes: number;
}

export interface AdminInvite {
  id: string;
  note: string;
  createdAt: string;
  usedAt: string | null;
  /** Username of the account that used it ('' if unused, or that account was deleted). */
  usedBy: string;
  /** Only in the response that created it: the code is never shown again. */
  code?: string;
}

export interface AdminStats {
  members: number;
  storageBytes: number;
}
