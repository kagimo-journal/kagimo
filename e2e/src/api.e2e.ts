/**
 * API-level end-to-end test (SPEC §1 `e2e/`).
 *
 * Starts a fresh server on 127.0.0.1:18181 (origin http://localhost:18181) with a temporary
 * data directory and walks the main user journeys with the real client crypto: bootstrap
 * admin, TOTP, admin actions, encrypted entries and images, isolation between users, version
 * conflicts and account recovery. Finally it scans the raw SQLite files and asserts that
 * no plaintext ever reached the server.
 *
 * Exits non-zero on the first failure.
 */
import assert from 'node:assert/strict';
import { randomUUID, webcrypto } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openJSON, sealJSON } from '../../frontend/src/crypto/aead';
import { newKdfParams } from '../../frontend/src/crypto/kdf';
import { aad, derivePassphraseKeys, deriveRecoveryKeys, wrapMasterKey } from '../../frontend/src/crypto/keys';
import { generateRecoveryKey } from '../../frontend/src/crypto/recovery';
import { ApiClient } from './lib/http';
import {
  type Account,
  enableTotp,
  type EntryBody,
  type EntryHeader,
  expectStatus,
  openEntry,
  passphraseLogin,
  recover,
  sealEntry,
  signup,
  toBase64,
  unlock,
  uploadBlob,
} from './lib/journal';
import { step, stepsRun } from './lib/runner';
import { type RunningServer, startServer } from './lib/server';

// ---- plaintext the server must never see ------------------------------------------

const ALICE_PASS = 'copper kettle morning tide';
const ALICE_NEW_PASS = 'saffron meadow quietly drifting';
const BOB_PASS = 'violet harbour lantern seventeen';
const BOB_NEW_PASS = 'granite owl whispers north';

const TITLE = 'Lighthouse keeper on a quiet Tuesday';
const BODY_TEXT = 'The fog rolled over Clevedon pier just after seven and swallowed the far lamps';
const BODY_TEXT_V2 = 'Later the tide turned and the gulls argued about the remaining chips';
const LOCATION = 'Clifton, Bristol';
const CAPTION = 'Footbridge photographed moments before dusk';
const SETTINGS_MARKER = 'Secret Orchard Theme';
const IMAGE_MARKER = 'JOURNAL-E2E-IMAGE-PLAINTEXT-MARKER';

/** A fake JPEG: SOI marker, an obvious plaintext marker, some random bytes. */
function fakeImage(): Uint8Array {
  const marker = new TextEncoder().encode(IMAGE_MARKER);
  const noise = webcrypto.getRandomValues(new Uint8Array(48 * 1024));
  const out = new Uint8Array(2 + marker.length + noise.length + 2);
  out.set([0xff, 0xd8], 0);
  out.set(marker, 2);
  out.set(noise, 2 + marker.length);
  out.set([0xff, 0xd9], out.length - 2);
  return out;
}

function header(title: string, text: string, imageCount: number): EntryHeader {
  return {
    v: 1,
    title,
    snippet: text.slice(0, 160),
    createdAt: '2026-11-11T21:40:00+00:00',
    tz: 'Europe/London',
    location: { label: LOCATION, precision: 'neighbourhood' },
    wordCount: text.split(/\s+/).length,
    imageCount,
  };
}

function body(text: string, blobId: string): EntryBody {
  return {
    v: 1,
    doc: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text }] },
        { type: 'encryptedImage', attrs: { blobId, alt: CAPTION, caption: CAPTION, width: 1600, height: 1200 } },
      ],
    },
  };
}

// ---- the test -------------------------------------------------------------------------

async function run(server: RunningServer) {
  const client = (label: string) => new ApiClient(server.baseUrl, server.origin, label);
  const alice = client('alice');
  const bob = client('bob');
  let aliceAcct!: Account;
  let bobAcct!: Account;
  let aliceTotp!: Awaited<ReturnType<typeof enableTotp>>;
  let bobTotp!: Awaited<ReturnType<typeof enableTotp>>;
  let bobId = '';
  let bobAuthKey = '';
  const entryId = randomUUID();
  const blobId = randomUUID();
  const image = fakeImage();

  await step('GET /api/config reports an empty instance', async () => {
    const res = expectStatus(await alice.get('/api/config'), 200);
    assert.deepEqual(res.body, { rpId: 'localhost', rpName: 'Kagimo', bootstrap: true, returning: false, billing: { enabled: false } });
  });

  await step('non-GET requests without X-Journal/Origin are refused (403 csrf)', async () => {
    expectStatus(await alice.request('POST', '/api/signup', { json: {}, noCsrfHeaders: true }), 403, 'csrf');
    const wrongOrigin = await alice.request('POST', '/api/auth/logout', {
      json: {},
      noCsrfHeaders: true,
      headers: { 'X-Journal': '1', Origin: 'http://evil.example' },
    });
    expectStatus(wrongOrigin, 403, 'csrf');
  });

  await step('first signup becomes the active admin', async () => {
    const { account, me } = await signup(alice, 'alice', ALICE_PASS, '');
    aliceAcct = account;
    assert.equal(me.username, 'alice');
    assert.equal(me.status, 'active');
    assert.equal(me.isAdmin, true);
    assert.equal(me.hasSecondFactor, false);
    assert.ok(alice.hasSession, 'signup sets the jsid cookie');
    const cfg = expectStatus(await alice.get('/api/config'), 200).body;
    assert.equal(cfg.bootstrap, false);
  });

  await step('without a second factor the admin only reaches account setup (403 second_factor_required)', async () => {
    expectStatus(await alice.get('/api/entries'), 403, 'second_factor_required');
    expectStatus(await alice.get('/api/admin/users'), 403, 'second_factor_required');
    expectStatus(await alice.get('/api/me'), 200);
  });

  await step('alice enables TOTP', async () => {
    aliceTotp = await enableTotp(alice, 'Kagimo');
    const me = expectStatus(await alice.get('/api/me'), 200).body;
    assert.equal(me.totpEnabled, true);
    assert.equal(me.hasSecondFactor, true);
    expectStatus(await alice.get('/api/entries'), 200);
  });

  await step('logout ends the session', async () => {
    expectStatus(await alice.post('/api/auth/logout'), 200);
    expectStatus(await alice.get('/api/me'), 401, 'unauthenticated');
  });

  await step('prelogin: unknown usernames get a deterministic fake salt with real params', async () => {
    const real = expectStatus(await alice.post('/api/auth/prelogin', { username: 'alice' }), 200).body.kdf;
    const fake1 = expectStatus(await alice.post('/api/auth/prelogin', { username: 'nobody-here' }), 200).body.kdf;
    const fake2 = expectStatus(await alice.post('/api/auth/prelogin', { username: 'nobody-here' }), 200).body.kdf;
    assert.deepEqual(fake1, fake2);
    assert.deepEqual({ ...fake1, salt: '' }, { ...real, salt: '' });
    assert.notEqual(fake1.salt, real.salt);
  });

  await step('login with the wrong passphrase is refused', async () => {
    const { res } = await passphraseLogin(alice, 'alice', 'copper kettle evening tide');
    expectStatus(res, 401, 'invalid_credentials');
  });

  await step('prelogin + login + TOTP (stale and replayed codes refused)', async () => {
    let { res } = await passphraseLogin(alice, 'alice', ALICE_PASS);
    expectStatus(res, 200);
    assert.deepEqual(res.body, { status: 'totp_required' });
    expectStatus(await alice.get('/api/me'), 401, 'unauthenticated', 'mfa_pending session must not reach /api/me');
    expectStatus(await alice.post('/api/auth/login/totp', { code: aliceTotp.staleCode() }), 401, 'invalid_totp');
    // The enable step already used the latest code: replaying it must fail.
    expectStatus(await alice.post('/api/auth/login/totp', { code: aliceTotp.lastCode() }), 401, 'invalid_totp');
    res = expectStatus(await alice.post('/api/auth/login/totp', { code: await aliceTotp.nextCode() }), 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.me.username, 'alice');
  });

  await step('alice unlocks: master key unwraps from /api/me', async () => {
    const { mk } = await unlock(alice, ALICE_PASS);
    assert.deepEqual(mk, aliceAcct.mk);
  });

  await step('second user signs up and is active straight away', async () => {
    const out = await signup(bob, 'bob', BOB_PASS, 'Hi, it is Bob from the book club');
    bobAcct = out.account;
    bobId = out.me.id;
    bobAuthKey = out.authKey;
    assert.equal(out.me.status, 'active');
    assert.equal(out.me.isAdmin, false);
    expectStatus(await bob.get('/api/entries'), 200);
    expectStatus(await bob.get('/api/admin/users'), 403, 'forbidden');
  });

  await step('admin sees the new member', async () => {
    const users = expectStatus(await alice.get('/api/admin/users'), 200).body as any[];
    const b = users.find((u) => u.username === 'bob');
    assert.ok(b, 'bob is listed');
    assert.equal(b.status, 'active');
    assert.equal(b.note, 'Hi, it is Bob from the book club');
    assert.equal(b.hasSecondFactor, false);
  });

  await step('bob enables TOTP', async () => {
    bobTotp = await enableTotp(bob, 'Kagimo');
    const me = expectStatus(await bob.get('/api/me'), 200).body;
    assert.equal(me.status, 'active');
    const stats = expectStatus(await alice.get('/api/admin/stats'), 200).body;
    assert.equal(stats.members, 2);
    assert.equal(stats.pending, undefined);
  });

  await step('the server refuses photo uploads; bob creates an encrypted entry', async () => {
    const up = await uploadBlob(bob, bobAcct.ck, blobId, entryId, image);
    expectStatus(up.res, 410, 'photos_unsupported', 'blob upload');

    const sealed = await sealEntry(bobAcct.ck, entryId, header(TITLE, BODY_TEXT, 1), body(BODY_TEXT, blobId));
    const res = expectStatus(await bob.post('/api/entries', { id: entryId, ...sealed }), 200);
    assert.equal(res.body.id, entryId);
    assert.equal(res.body.version, 1);
    assert.match(res.body.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expectStatus(await bob.post('/api/entries', { id: entryId, ...sealed }), 409, 'entry_exists');
  });

  await step('encrypted settings round-trip', async () => {
    expectStatus(await bob.get('/api/settings'), 204);
    const settings = { v: 1, mode: 'dark', lightTheme: 'paper', darkTheme: 'nord', customThemes: [{ id: 'x', name: SETTINGS_MARKER }] };
    const sealed = await sealJSON(bobAcct.ck, settings, aad.settings(bobId));
    expectStatus(await bob.put('/api/settings', sealed), 200);
    const got = expectStatus(await bob.get('/api/settings'), 200).body;
    assert.deepEqual(await openJSON(bobAcct.ck, got, aad.settings(bobId)), settings);
  });

  await step('fetch + decrypt round-trip matches (list, entry)', async () => {
    const list = expectStatus(await bob.get('/api/entries'), 200).body as any[];
    assert.equal(list.length, 1);
    assert.equal(list[0].id, entryId);
    assert.equal(list[0].body, undefined, 'list carries headers only');
    const full = expectStatus(await bob.get(`/api/entries/${entryId}`), 200).body;
    const plain = await openEntry(bobAcct.ck, entryId, full);
    assert.deepEqual(plain.header, header(TITLE, BODY_TEXT, 1));
    assert.deepEqual(plain.body, body(BODY_TEXT, blobId));
    expectStatus(await bob.get(`/api/blobs/${blobId}`), 404, 'not_found');
  });

  await step('ciphertext is bound to its slot (AAD): header cannot be opened as body', async () => {
    const full = expectStatus(await bob.get(`/api/entries/${entryId}`), 200).body;
    await assert.rejects(openJSON(bobAcct.ck, full.header, aad.entryBody(entryId)));
    await assert.rejects(openJSON(bobAcct.ck, full.header, aad.entryHeader(randomUUID())));
  });

  await step('cross-user access returns 404', async () => {
    expectStatus(await alice.get(`/api/entries/${entryId}`), 404, 'not_found');
    const forged = await sealEntry(aliceAcct.ck, entryId, header('mine now', 'mine', 0), body('mine', blobId));
    expectStatus(await alice.put(`/api/entries/${entryId}`, { ...forged, baseVersion: 1 }), 404, 'not_found');
    expectStatus(await alice.delete(`/api/entries/${entryId}`), 404, 'not_found');
    expectStatus(await alice.get(`/api/blobs/${blobId}`), 404, 'not_found');
    expectStatus(await alice.delete(`/api/blobs/${blobId}`), 404, 'not_found');
    assert.deepEqual(expectStatus(await alice.get('/api/entries'), 200).body, []);
    // ...and bob's data is untouched.
    expectStatus(await bob.get(`/api/entries/${entryId}`), 200);
  });

  await step('stale baseVersion is rejected with 409 version_conflict', async () => {
    const v2 = await sealEntry(bobAcct.ck, entryId, header(TITLE, BODY_TEXT_V2, 1), body(BODY_TEXT_V2, blobId));
    const ok = expectStatus(await bob.put(`/api/entries/${entryId}`, { ...v2, baseVersion: 1 }), 200);
    assert.equal(ok.body.version, 2);
    const stale = await sealEntry(bobAcct.ck, entryId, header(TITLE, 'overwritten by a stale tab', 1), body('x', blobId));
    const conflict = expectStatus(await bob.put(`/api/entries/${entryId}`, { ...stale, baseVersion: 1 }), 409, 'version_conflict');
    assert.equal(conflict.body.currentVersion, 2);
    const full = expectStatus(await bob.get(`/api/entries/${entryId}`), 200).body;
    assert.equal(full.version, 2);
    assert.equal((await openEntry(bobAcct.ck, entryId, full)).header.snippet, BODY_TEXT_V2);
  });

  const rescuer = client('bob-recovery');
  await step('recovery verify: needs the right key and a TOTP code', async () => {
    // The key check comes first, so this code is never evaluated (and no TOTP step is spent).
    const wrongKey = await recover(rescuer, 'bob', generateRecoveryKey().formatted, BOB_NEW_PASS, bobTotp.staleCode());
    expectStatus(wrongKey.verify, 401, 'invalid_credentials');
    const noCode = await recover(rescuer, 'bob', bobAcct.recoveryKey, BOB_NEW_PASS);
    expectStatus(noCode.verify, 401, 'totp_required');
  });

  await step('recovery reset sets a new passphrase and signs out every old session', async () => {
    const out = await recover(rescuer, 'bob', bobAcct.recoveryKey, BOB_NEW_PASS, await bobTotp.nextCode());
    expectStatus(out.verify, 200, undefined, 'recover/verify');
    expectStatus(out.reset!, 200, undefined, 'recover/reset');
    assert.equal(out.reset!.body.me.username, 'bob');
    assert.deepEqual(out.mk, bobAcct.mk, 'recovery key unwraps the same master key');
    expectStatus(await bob.get('/api/me'), 401, 'unauthenticated', 'old session revoked');
    // The token is single use.
    const again = await rescuer.post('/api/auth/recover/reset', {
      token: out.token,
      kdf: { salt: toBase64(new Uint8Array(16)), m: 65536, t: 3, p: 1 },
      authKey: bobAuthKey,
      wrappedMkPass: out.reset!.body.me.keys.wrappedMkPass,
    });
    expectStatus(again, 401, 'invalid_token');
    expectStatus(await rescuer.post('/api/auth/logout'), 200);
  });

  await step('old passphrase no longer works; the new one does (with TOTP)', async () => {
    bob.clearCookies();
    expectStatus((await passphraseLogin(bob, 'bob', BOB_PASS)).res, 401, 'invalid_credentials');
    const { res } = await passphraseLogin(bob, 'bob', BOB_NEW_PASS);
    assert.deepEqual(expectStatus(res, 200).body, { status: 'totp_required' });
    expectStatus(await bob.post('/api/auth/login/totp', { code: await bobTotp.nextCode() }), 200);
  });

  await step('after recovery the old entry still decrypts', async () => {
    const { mk, ck } = await unlock(bob, BOB_NEW_PASS);
    assert.deepEqual(mk, bobAcct.mk);
    const full = expectStatus(await bob.get(`/api/entries/${entryId}`), 200).body;
    const plain = await openEntry(ck, entryId, full);
    assert.equal(plain.header.title, TITLE);
    assert.deepEqual(plain.body, body(BODY_TEXT_V2, blobId));
  });

  await step('alice changes her passphrase (old one stops working)', async () => {
    const me = expectStatus(await alice.get('/api/me'), 200).body;
    const current = await derivePassphraseKeys(ALICE_PASS, me.keys.kdf);
    const kdf = newKdfParams();
    const fresh = await derivePassphraseKeys(ALICE_NEW_PASS, kdf);
    const wrong = await alice.post('/api/account/passphrase', {
      currentAuthKey: toBase64(fresh.authKey),
      kdf,
      authKey: toBase64(fresh.authKey),
      wrappedMkPass: await wrapMasterKey(fresh.kek, aliceAcct.mk),
    });
    expectStatus(wrong, 401, 'invalid_credentials', 'wrong current passphrase');
    const res = await alice.post('/api/account/passphrase', {
      currentAuthKey: toBase64(current.authKey),
      kdf,
      authKey: toBase64(fresh.authKey),
      wrappedMkPass: await wrapMasterKey(fresh.kek, aliceAcct.mk),
    });
    expectStatus(res, 200);
    assert.deepEqual((await unlock(alice, ALICE_NEW_PASS)).mk, aliceAcct.mk);
    const probe = client('alice-probe');
    expectStatus((await passphraseLogin(probe, 'alice', ALICE_PASS)).res, 401, 'invalid_credentials');
  });

  await step('re-authentication: wrong passphrase refused, right one accepted', async () => {
    const me = expectStatus(await alice.get('/api/me'), 200).body;
    const wrong = await derivePassphraseKeys(ALICE_PASS, me.keys.kdf); // the old passphrase
    expectStatus(await alice.post('/api/auth/reauth', { authKey: toBase64(wrong.authKey) }), 401, 'invalid_credentials');
    const right = await derivePassphraseKeys(ALICE_NEW_PASS, me.keys.kdf);
    expectStatus(await alice.post('/api/auth/reauth', { authKey: toBase64(right.authKey) }), 200);
    expectStatus(await client('nobody').post('/api/auth/reauth', { authKey: toBase64(right.authKey) }), 401, 'unauthenticated');
  });

  await step('alice regenerates her recovery key (old one stops working)', async () => {
    const fresh = generateRecoveryKey();
    const rec = await deriveRecoveryKeys(fresh.bytes);
    const res = await alice.post('/api/account/recovery', {
      recoveryAuthKey: toBase64(rec.authKey),
      wrappedMkRecovery: await wrapMasterKey(rec.kek, aliceAcct.mk),
    });
    expectStatus(res, 200);
    const probe = client('alice-probe');
    // The key is checked before TOTP, so a placeholder code is never evaluated.
    const old = await recover(probe, 'alice', aliceAcct.recoveryKey, 'unused passphrase', aliceTotp.staleCode());
    expectStatus(old.verify, 401, 'invalid_credentials');
    aliceAcct.recoveryKey = fresh.formatted;
  });

  await step('admin disable revokes sessions and blocks login; enable restores access', async () => {
    expectStatus(await alice.post(`/api/admin/users/${aliceAcct.userId}/disable`), 400, 'self_action');
    expectStatus(await alice.post(`/api/admin/users/${bobId}/disable`), 200);
    expectStatus(await bob.get('/api/me'), 401, 'unauthenticated', 'disabled user is signed out');
    expectStatus((await passphraseLogin(bob, 'bob', BOB_NEW_PASS)).res, 403, 'account_disabled');
    expectStatus(await alice.post(`/api/admin/users/${bobId}/approve`), 404, 'not_found');
    expectStatus(await alice.post(`/api/admin/users/${bobId}/enable`), 200);
    const users = expectStatus(await alice.get('/api/admin/users'), 200).body as any[];
    assert.equal(users.find((u) => u.id === bobId)?.status, 'active');
  });

  return { aliceAcct, bobAcct, bobAuthKey };
}

// ---- raw database scan -------------------------------------------------------------------

interface Needle {
  what: string;
  bytes: Uint8Array;
}

function textNeedles(what: string, s: string): Needle[] {
  const utf8 = new TextEncoder().encode(s);
  return [
    { what: `${what} (utf-8)`, bytes: utf8 },
    { what: `${what} (utf-16le)`, bytes: new Uint8Array(Buffer.from(s, 'utf16le')) },
    { what: `${what} (base64)`, bytes: new TextEncoder().encode(Buffer.from(s).toString('base64').slice(0, 24)) },
  ];
}

function bytesNeedles(what: string, b: Uint8Array): Needle[] {
  return [
    { what: `${what} (raw)`, bytes: b },
    { what: `${what} (base64)`, bytes: new TextEncoder().encode(Buffer.from(b).toString('base64').slice(0, 24)) },
  ];
}

async function scanDataDir(server: RunningServer, ctx: Awaited<ReturnType<typeof run>>) {
  const files = (await readdir(server.dataDir)).filter((f) => f.startsWith('journal.db'));
  assert.ok(files.includes('journal.db'), `journal.db exists (found ${files.join(', ')})`);
  const blobs = await Promise.all(files.map(async (f) => ({ f, data: await readFile(join(server.dataDir, f)) })));
  const contains = (needle: Uint8Array) => blobs.filter(({ data }) => data.indexOf(needle) !== -1).map(({ f }) => f);

  // Positive controls: the scan must be able to see what the server does store.
  assert.ok(contains(new TextEncoder().encode('Hi, it is Bob from the book club')).length, 'control: signup note is stored');

  const needles: Needle[] = [
    ...textNeedles('entry title', TITLE),
    ...textNeedles('entry body text', BODY_TEXT),
    ...textNeedles('entry body text v2', BODY_TEXT_V2),
    ...textNeedles('location label', LOCATION),
    ...textNeedles('image caption', CAPTION),
    ...textNeedles('settings content', SETTINGS_MARKER),
    ...textNeedles('image bytes marker', IMAGE_MARKER),
    ...textNeedles('alice passphrase', ALICE_PASS),
    ...textNeedles('alice new passphrase', ALICE_NEW_PASS),
    ...textNeedles('alice recovery key', ctx.aliceAcct.recoveryKey),
    ...textNeedles('bob passphrase', BOB_PASS),
    ...textNeedles('bob new passphrase', BOB_NEW_PASS),
    ...textNeedles('bob recovery key', ctx.bobAcct.recoveryKey),
    ...textNeedles('bob authKey', ctx.bobAuthKey),
    ...bytesNeedles('alice master key', ctx.aliceAcct.mk),
    ...bytesNeedles('bob master key', ctx.bobAcct.mk),
  ];
  const leaks = needles.flatMap((n) => contains(n.bytes).map((f) => `${n.what} found in ${f}`));
  assert.deepEqual(leaks, [], `plaintext leaked into the database:\n  ${leaks.join('\n  ')}`);
  return { files, needles: needles.length };
}

// ---- main ----------------------------------------------------------------------------------

async function main() {
  const started = Date.now();
  console.log('journal e2e: starting server…');
  const server = await startServer();
  console.log(`  server ${server.baseUrl} (origin ${server.origin}), data ${server.dataDir}`);
  let failed = false;
  try {
    const ctx = await run(server);
    // Stop first so SQLite closes cleanly, then scan every journal.db* file left behind.
    const live = await step('raw SQLite files (server running) contain no plaintext', () => scanDataDir(server, ctx));
    await server.stop();
    const after = await step('raw SQLite files (after shutdown) contain no plaintext', () => scanDataDir(server, ctx));
    console.log(`  scanned ${live.files.join(', ')} then ${after.files.join(', ')} for ${after.needles} needles`);
  } catch (e) {
    failed = true;
    console.error(`\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    console.error(`\n--- server output ---\n${server.output()}`);
  } finally {
    await server.stop();
    await server.cleanup();
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (failed) {
    console.error(`\njournal e2e: FAILED after ${stepsRun()} steps (${secs}s)`);
    process.exit(1);
  }
  console.log(`\njournal e2e: all ${stepsRun()} steps passed (${secs}s)`);
}

await main();
