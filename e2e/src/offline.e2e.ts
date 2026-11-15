/**
 * Browser end-to-end test of the offline-first journal (SPEC §10) against the production build in
 * headless Chromium:
 *
 *   device A starts a journal with no account, writes, reloads while offline (app shell from the
 *   service worker, journal from IndexedDB) and unlocks; turns on sync; device B signs in and
 *   gets the entry; both devices edit different paragraphs of it at once and end up with both edits.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { TotpDevice } from './lib/journal';
import { startJournalWithPassword } from './lib/browser';
import { step, stepsRun } from './lib/runner';
import { type RunningServer, startServer } from './lib/server';

const PASS = 'tq8!Vx2#mP0r$Lk5wZ9n-Hj3';

function browserPath(): string | undefined {
  if (process.env.CHROME) return process.env.CHROME;
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}

/** Calls the API from inside the page (its session cookie, the CSRF headers). */
async function api(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(path, {
        method,
        headers: { 'X-Journal': '1', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    { method, path, body },
  );
}

async function unlock(page: Page) {
  await page.getByPlaceholder('Passphrase').fill(PASS);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  // Back where it was before locking (the journal, or settings).
  await page.waitForURL((u) => !u.pathname.startsWith('/unlock'), { timeout: 30_000 });
  await page.locator('.ProseMirror, .entry-list, .settings-shell').first().waitFor({ timeout: 30_000 });
}

/** The text of the open entry's body. */
const bodyText = (page: Page) => page.locator('.ProseMirror').innerText();

/** Nudges sync (it also runs on its own after edits and every minute). */
const syncSoon = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('online')));

async function main() {
  const server: RunningServer = await startServer();
  let browser: Browser | undefined;
  let failed = false;
  const errors: string[] = [];
  const track = (ctx: BrowserContext, label: string) =>
    ctx.on('page', (p) => {
      p.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
      if (process.env.TRACE) {
        p.on('request', (r) => /\/api\/(entries|sync)/.test(r.url()) && r.method() !== 'GET' && console.log(`TRACE ${Date.now() % 100000} ${label} ${r.method()} ${r.postData()?.match(/"baseVersion":\d+/)?.[0] ?? ''}`));
        p.on('response', (r) => /\/api\/(entries|sync)/.test(r.url()) && r.request().method() !== 'GET' && console.log(`TRACE ${Date.now() % 100000} ${label} -> ${r.status()}`));
        p.on('requestfailed', (r) => /\/api\//.test(r.url()) && console.log(`TRACE ${Date.now() % 100000} ${label} failed ${r.method()} ${r.url().slice(-30)}`));
        p.on('console', (m) => console.log(`TRACE console ${label} ${m.type()} ${m.text().slice(0, 200)}`));
      }
      p.on('console', (m) => m.type() === 'error' && !/status of 40[19]/.test(m.text()) && console.log(`console ${label}: ${m.text()}`));
    });
  try {
    browser = await chromium.launch({ executablePath: browserPath(), headless: true });
    console.log(`journal offline e2e: ${server.origin} in ${browser.version()}`);
    const a = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    track(a, 'A');
    const pa = await a.newPage();
    let totp!: TotpDevice;

    await step('device A starts a journal without an account', async () => {
      await startJournalWithPassword(pa, server.origin, PASS);
    });

    await step('writes an entry, saved on the device (nothing sent to the server)', async () => {
      await pa.getByPlaceholder('Title').fill('Morning');
      await pa.locator('.ProseMirror').click();
      await pa.keyboard.type('First paragraph.');
      await pa.keyboard.press('Enter');
      await pa.keyboard.type('Second paragraph.');
      await pa.getByText('Encrypted · saved').waitFor({ timeout: 10_000 });
      assert.equal((await api(pa, 'GET', '/api/me')).status, 401, 'no account exists');
    });

    await step('reloads offline: app from the service worker, journal from IndexedDB', async () => {
      await until('service worker in control', () => pa.evaluate(async () => (await navigator.serviceWorker.ready, !!navigator.serviceWorker.controller)));
      await a.setOffline(true);
      await pa.reload();
      // A reload keeps the journal open.
      await pa.locator('.ProseMirror').waitFor({ timeout: 30_000 });
      assert.equal(await pa.getByPlaceholder('Passphrase').count(), 0);
      await pa.getByRole('link', { name: /Morning/ }).first().click();
      assert.match(await bodyText(pa), /Second paragraph\./);
      await a.setOffline(false);
    });

    await step('turns on sync (first account: administrator, approved)', async () => {
      await pa.getByRole('link', { name: /Only on this device/ }).click();
      await pa.getByLabel('Username').fill('alice');
      await pa.getByLabel('Your passphrase').fill(PASS);
      await pa.getByRole('button', { name: 'Turn on sync' }).click();
      await pa.getByText('Sync account created', { exact: true }).waitFor({ timeout: 30_000 });
    });

    await step('adds a second factor; the journal uploads, still encrypted', async () => {
      const setup = await api(pa, 'POST', '/api/totp/setup', {});
      assert.equal(setup.status, 200);
      totp = new TotpDevice(setup.body.otpauthUrl);
      assert.equal((await api(pa, 'POST', '/api/totp/enable', { code: await totp.nextCode() })).status, 200);
      await pa.reload();
      await pa.locator('.settings-shell').waitFor({ timeout: 30_000 });
      await until('the entry on the server', async () => {
        await syncSoon(pa);
        const list = await api(pa, 'GET', '/api/entries');
        return list.status === 200 && list.body.length === 1;
      });
      const raw = JSON.stringify((await api(pa, 'GET', '/api/entries')).body);
      assert.doesNotMatch(raw, /Morning|paragraph/, 'the server only has ciphertext');
    });

    const b = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    track(b, 'B');
    const pb = await b.newPage();

    await step('device B signs in to sync and gets the journal', async () => {
      await pb.goto(`${server.origin}/signin`);
      await pb.getByLabel('Username').fill('alice');
      await pb.getByLabel('Passphrase').fill(PASS);
      await pb.getByRole('button', { name: 'Continue' }).click();
      await pb.getByLabel('Authenticator code').fill(await totp.nextCode());
      await pb.getByRole('button', { name: 'Verify' }).click();
      await pb.getByRole('link', { name: /Morning/ }).first().click({ timeout: 30_000 });
      assert.match(await bodyText(pb), /First paragraph\.[\s\S]*Second paragraph\./);
    });

    await step('device C clicks "Start writing", then signs in to the account instead', async () => {
      const c = await browser!.newContext({ viewport: { width: 1280, height: 900 } });
      track(c, 'C');
      const pc = await c.newPage();
      await pc.goto(`${server.origin}/welcome`);
      // "Start writing" scrolls to the closing section, where "Write now" makes the journal.
      await pc.getByRole('link', { name: 'Start writing' }).first().click();
      await pc.getByRole('link', { name: 'Write now' }).click();
      await pc.getByPlaceholder('Title').fill('Scratch');
      await pc.locator('.ProseMirror').click();
      await pc.keyboard.type('Written before signing in.');
      await pc.getByText('Encrypted · saved').waitFor({ timeout: 10_000 });
      // The side nav offers sign-in (not sign-out) for a journal that's only on this device.
      assert.equal(await pc.getByRole('button', { name: 'Sign out' }).count(), 0);
      await pc.getByRole('link', { name: 'Sign in to an existing account' }).first().waitFor();
      await pc.getByRole('region', { name: 'No password' }).getByRole('link', { name: 'Sign in to an existing account' }).click();
      await pc.getByText('This device has a journal that isn’t synced (1 entry)', { exact: false }).waitFor({ timeout: 20_000 });
      assert.ok(await pc.getByRole('button', { name: 'Continue' }).isDisabled(), 'waits for a yes before replacing it');
      await pc.getByText('Delete the journal on this device and sign in').click();
      await pc.getByLabel('Username').fill('alice');
      await pc.getByLabel('Passphrase').fill(PASS);
      await pc.getByRole('button', { name: 'Continue' }).click();
      await pc.getByLabel('Authenticator code').fill(await totp.nextCode());
      await pc.getByRole('button', { name: 'Verify' }).click();
      await pc.getByRole('link', { name: /Morning/ }).first().waitFor({ timeout: 30_000 });
      assert.equal(await pc.getByRole('link', { name: /Scratch/ }).count(), 0, 'the local journal is gone');
      // ...and signs out again from the bottom of the side nav: the copy here goes, back to sign-in.
      await pc.getByRole('button', { name: 'Sign out' }).click();
      await pc.getByRole('dialog').getByRole('button', { name: 'Sign out' }).click();
      await pc.waitForURL((u) => u.pathname === '/signin', { timeout: 20_000 });
      await pc.goto(`${server.origin}/`);
      await pc.waitForURL((u) => u.pathname === '/signin' || u.pathname === '/signup', { timeout: 20_000 });
      await c.close();
    });

    await step('signed-in devices stay open across a reload', async () => {
      for (const page of [pb, pa]) {
        const url = page.url();
        await page.reload();
        await page.locator('.ProseMirror, .entry-list, .settings-shell').first().waitFor({ timeout: 30_000 });
        assert.equal(new URL(page.url()).pathname, new URL(url).pathname, 'no unlock prompt after reload');
      }
    });

    await step('both devices edit different paragraphs at once; both edits survive', async () => {
      if (await pa.getByRole('link', { name: '← Back to journal' }).isVisible()) await pa.getByRole('link', { name: '← Back to journal' }).click();
      await pa.getByRole('link', { name: /Morning/ }).first().click();
      // A edits the first paragraph, B the second, before either syncs.
      await pa.locator('.ProseMirror p').first().click();
      await pa.keyboard.press('End');
      await pa.keyboard.type(' Edited on A.');
      await pb.locator('.ProseMirror p').nth(1).click();
      await pb.keyboard.press('End');
      await pb.keyboard.type(' Edited on B.');
      const both = /First paragraph\. Edited on A\.[\s\S]*Second paragraph\. Edited on B\./;
      for (const [label, page] of [['A', pa], ['B', pb]] as const) {
        await until(`device ${label} shows both edits`, async () => {
          await syncSoon(pa);
          await syncSoon(pb);
          return both.test(await bodyText(page));
        }, 40_000);
      }
    });

    await step('the same paragraph changed on both: A chooses on the conflict screen', async () => {
      if (process.env.TRACE) console.log('TRACE ---- step 8');
      // Both devices settled (nothing left to push) before the experiment starts.
      for (const page of [pa, pb]) {
        await until('nothing waiting to sync', async () => {
          await syncSoon(page);
          return page.evaluate(
            () =>
              new Promise<boolean>((res) => {
                const r = indexedDB.open('kagimo');
                r.onsuccess = () => {
                  const q = r.result.transaction('entries').objectStore('entries').getAll();
                  q.onsuccess = () => res(q.result.every((x: { dirty: boolean }) => !x.dirty));
                };
              }),
          );
        });
      }
      // A loses its connection (requests through a service worker ignore Playwright's offline
      // switch, so the app's own requests are made to fail) and rewrites the first paragraph;
      // B rewrites it too and syncs.
      await pa.evaluate(() => {
        const w = window as unknown as { __fetch: typeof fetch };
        w.__fetch = window.fetch;
        window.fetch = (input, init) =>
          String(input instanceof Request ? input.url : input).includes('/api/') ? Promise.reject(new TypeError('Failed to fetch')) : w.__fetch(input, init);
      });
      await pa.locator('.ProseMirror p').first().click();
      await pa.keyboard.press('End');
      await pa.keyboard.type(' Offline thought.');
      await pa.getByText('Encrypted · saved').waitFor({ timeout: 10_000 });
      const before = (await api(pb, 'GET', '/api/entries')).body[0].version as number;
      await pb.locator('.ProseMirror p').first().click();
      await pb.keyboard.press('End');
      await pb.keyboard.type(' Phone thought.');
      await until('B pushed its edit', async () => {
        await syncSoon(pb);
        const list = await api(pb, 'GET', '/api/entries');
        return list.status === 200 && list.body[0].version > before;
      });
      await pa.evaluate(() => {
        window.fetch = (window as unknown as { __fetch: typeof fetch }).__fetch;
      });
      await syncSoon(pa);
      await pa.getByText('Needs your attention').waitFor({ timeout: 30_000 });
      await pa.getByText('Keep both, this device’s first').click();
      await pa.getByRole('button', { name: 'Save these choices' }).click();
      const kept = /Offline thought\.[\s\S]*Phone thought\./;
      await until('A shows both versions of the paragraph', async () => kept.test(await bodyText(pa)));
      await until('B gets the settled version', async () => {
        await syncSoon(pa);
        await syncSoon(pb);
        return kept.test(await bodyText(pb));
      }, 40_000);
      assert.match(await bodyText(pb), /Second paragraph\. Edited on B\./, 'the rest of the entry is untouched');
    });

    await step('an account from before journals lived on devices unlocks into one', async () => {
      // B's browser keeps its session but loses the journal on the device (as for every account
      // that existed before this change): unlocking makes a new copy and syncs it down.
      await pb.evaluate(
        () =>
          new Promise<void>((res, rej) => {
            const r = indexedDB.deleteDatabase('kagimo');
            r.onsuccess = () => res();
            r.onerror = () => rej(r.error);
            r.onblocked = () => res();
          }),
      );
      await pb.goto(`${server.origin}/`);
      await pb.getByText('Unlock your journal once to keep an encrypted copy on this device.').waitFor({ timeout: 20_000 });
      await unlock(pb);
      await pb.getByRole('link', { name: /Morning/ }).first().click({ timeout: 30_000 });
      await until('the synced entry on the new copy', async () => /Offline thought\.[\s\S]*Phone thought\./.test(await bodyText(pb)));
    });

    assert.deepEqual(errors, [], 'no uncaught page errors');
  } catch (e) {
    failed = true;
    console.error(`\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    if (errors.length) console.error(`\npage errors:\n${errors.join('\n')}`);
    console.error(`\n--- server output (tail) ---\n${server.output().slice(-4000)}`);
  } finally {
    await browser?.close();
    await server.stop();
    await server.cleanup();
  }
  if (failed) {
    console.error(`\njournal offline e2e: FAILED after ${stepsRun()} steps`);
    process.exit(1);
  }
  console.log(`\njournal offline e2e: all ${stepsRun()} steps passed`);
}

await main();
