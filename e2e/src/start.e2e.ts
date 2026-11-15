/**
 * Browser end-to-end test of starting a journal (SPEC §10): "Start writing", then "Write now", goes straight to the
 * editor with no password; the journal opens by itself after a reload; the banner's "Set a
 * password" dialog protects it, shows the recovery key and offers "Save locally" / "Set up sync";
 * from then on a reload keeps it open but a reload after locking needs the passphrase.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { type Browser, chromium } from 'playwright-core';
import { step, stepsRun } from './lib/runner';
import { type RunningServer, startServer } from './lib/server';

const PASS = 'tq8!Vx2#mP0r$Lk5wZ9n-Hj3';

function browserPath(): string | undefined {
  if (process.env.CHROME) return process.env.CHROME;
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
}

async function main() {
  const server: RunningServer = await startServer({ port: Number(process.env.E2E_PORT ?? 18184) });
  let browser: Browser | undefined;
  let failed = false;
  const errors: string[] = [];
  try {
    browser = await chromium.launch({ executablePath: browserPath(), headless: true });
    console.log(`journal start e2e: ${server.origin} in ${browser.version()}`);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    const banner = page.getByRole('region', { name: 'No password' });

    await step('"Start writing" → "Write now" goes straight to the editor, no password asked', async () => {
      await page.setViewportSize({ width: 390, height: 800 });
      await page.goto(`${server.origin}/welcome`);
      // "Start writing" scrolls to the closing section, where "Write now" makes the journal.
      await page.getByRole('link', { name: 'Start writing' }).first().click();
      await page.getByRole('link', { name: 'Write now' }).click();
      await page.locator('.ProseMirror').waitFor({ timeout: 30_000 });
      assert.equal(await page.getByPlaceholder('Passphrase').count(), 0);
      await banner.getByText('No password yet', { exact: false }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Lock journal' }).count(), 0, 'nothing to lock with');
      await page.setViewportSize({ width: 1280, height: 900 });
    });

    await step('writes, reloads: the journal opens by itself', async () => {
      await page.getByPlaceholder('Title').fill('First day');
      await page.locator('.ProseMirror').click();
      await page.keyboard.type('No password yet.');
      await page.getByText('Encrypted · saved').waitFor({ timeout: 10_000 });
      await page.reload();
      await page.getByRole('link', { name: /First day/ }).first().waitFor({ timeout: 30_000 });
      assert.equal(await page.getByPlaceholder('Passphrase').count(), 0);
    });

    await step('Settings → Sync asks for a password before sync', async () => {
      await page.goto(`${server.origin}/settings/sync`);
      await page.getByText('First, give your journal a password.', { exact: false }).waitFor({ timeout: 30_000 });
      assert.equal(await page.getByLabel('Username').count(), 0);
    });

    await step('the banner sets a password; recovery key, then "Save locally" or "Set up sync"', async () => {
      await page.goto(`${server.origin}/`);
      await banner.getByRole('button', { name: 'Set a password' }).click();
      await page.getByLabel('Password', { exact: true }).fill('short');
      await page.getByLabel('Repeat password').fill('short');
      await page.getByText('I understand nobody can reset my password for me.').click();
      await page.getByRole('button', { name: 'Set password', exact: true }).click();
      await page.locator('.set-password-dialog .error-text').first().waitFor();
      await page.getByLabel('Password', { exact: true }).fill(PASS);
      await page.getByLabel('Repeat password').fill(PASS);
      await page.getByRole('button', { name: 'Set password', exact: true }).click();
      await page.getByRole('heading', { name: 'Save your recovery key' }).waitFor({ timeout: 30_000 });
      assert.ok(await page.getByRole('button', { name: /Save locally/ }).isDisabled(), 'waits for the recovery key to be saved');
      await page.getByText("I've saved my recovery key somewhere safe.").click();
      await page.getByRole('button', { name: /Set up sync/ }).click();
      await page.waitForURL((u) => u.pathname === '/settings/sync');
      await page.getByLabel('Username').waitFor();
      await page.getByRole('button', { name: 'Lock journal' }).waitFor();
      assert.equal(await banner.count(), 0, 'banner gone');
    });

    await step('a reload keeps it open; a reload after locking needs the passphrase', async () => {
      await page.reload();
      await page.getByLabel('Username').waitFor({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Lock journal' }).click();
      await page.waitForURL((u) => u.pathname.startsWith('/unlock'));
      await page.reload();
      await page.getByPlaceholder('Passphrase').fill(PASS);
      await page.getByRole('button', { name: 'Unlock', exact: true }).click();
      await page.locator('.ProseMirror').waitFor({ timeout: 30_000 });
    });

    await step('a new tab needs the passphrase', async () => {
      const other = await ctx.newPage();
      await other.goto(`${server.origin}/`);
      await other.getByPlaceholder('Passphrase').waitFor({ timeout: 30_000 });
      await other.close();
    });

    await step('a closed tab that is reopened needs the passphrase, and its reload copy is deleted', async () => {
      // What "reopen closed tab" and session restore bring back: the tab's sessionStorage as it
      // was when the page unloaded, in a page load that is not a reload.
      const saved = await page.evaluate(() => {
        const rec = JSON.parse(sessionStorage.getItem('kagimo.resume') ?? 'null');
        return rec ? JSON.stringify({ ...rec, lastActivity: Date.now(), unloadedAt: Date.now() }) : null;
      });
      assert.ok(saved, 'an unlocked tab keeps a reload copy');
      await page.close();
      const restored = await ctx.newPage();
      await restored.addInitScript((rec) => {
        if (!sessionStorage.getItem('restored')) {
          sessionStorage.setItem('restored', '1');
          sessionStorage.setItem('kagimo.resume', rec);
        }
      }, saved);
      await restored.goto(`${server.origin}/`);
      await restored.getByPlaceholder('Passphrase').waitFor({ timeout: 30_000 });
      assert.equal(await restored.evaluate(() => sessionStorage.getItem('kagimo.resume')), null, 'the copy is gone from the tab');
      // ...so reloading the restored tab doesn't open it either.
      await restored.reload();
      await restored.getByPlaceholder('Passphrase').waitFor({ timeout: 30_000 });
      const token = (JSON.parse(saved) as { token: string }).token;
      const left = await restored.evaluate(
        (key) =>
          new Promise<boolean>((res, rej) => {
            const open = indexedDB.open('kagimo');
            open.onerror = () => rej(open.error);
            open.onsuccess = () => {
              const r = open.result.transaction('meta').objectStore('meta').get(key);
              r.onsuccess = () => res(r.result !== undefined);
              r.onerror = () => rej(r.error);
            };
          }),
        `resume:${token}`,
      );
      assert.equal(left, false, 'its reload key is gone from IndexedDB');
      await restored.close();
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
    console.error(`\njournal start e2e: FAILED after ${stepsRun()} steps`);
    process.exit(1);
  }
  console.log(`\njournal start e2e: all ${stepsRun()} steps passed`);
}

await main();
