/**
 * Browser end-to-end test of PIN unlock (SPEC §3) against the production build in headless Chromium:
 * turn on a PIN in Settings → Security, lock, reopen with the PIN; wrong PINs run out; and once the
 * journal has been inactive past the limit, only the passphrase works.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { type Browser, chromium, type Page } from 'playwright-core';
import { startJournalWithPassword } from './lib/browser';
import { step, stepsRun } from './lib/runner';
import { type RunningServer, startServer } from './lib/server';

const PASS = 'tq8!Vx2#mP0r$Lk5wZ9n-Hj3';
const PIN = '190483';

function browserPath(): string | undefined {
  if (process.env.CHROME) return process.env.CHROME;
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
}

/** Locks with the "Lock journal" button (settings sidebar or entry list); unlocking then returns to the journal. */
async function lockJournal(page: Page) {
  await page.getByRole('button', { name: 'Lock journal' }).first().click();
  await page.waitForURL((u) => u.pathname.startsWith('/unlock'));
}

async function enterPin(page: Page, pin: string) {
  await page.getByPlaceholder('PIN').fill(pin);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
}

async function main() {
  const server: RunningServer = await startServer({ port: Number(process.env.E2E_PORT ?? 18183) });
  let browser: Browser | undefined;
  let failed = false;
  const errors: string[] = [];
  try {
    browser = await chromium.launch({ executablePath: browserPath(), headless: true });
    console.log(`journal PIN e2e: ${server.origin} in ${browser.version()}`);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.clock.install();

    await step('starts a journal without an account', async () => {
      await startJournalWithPassword(page, server.origin, PASS);
    });

    await step('turns on a PIN in Settings → Security (guessable PINs refused)', async () => {
      // Within the app: only a reload keeps the journal open across a page load.
      await page.evaluate((path) => {
        history.pushState({}, '', path);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, '/settings/security/pin');
      await page.getByRole('button', { name: 'Set up a PIN' }).click({ timeout: 30_000 });
      await page.getByLabel('PIN', { exact: true }).fill('123456');
      await page.getByLabel('Repeat PIN').fill('123456');
      await page.getByLabel('Your passphrase').fill(PASS);
      await page.getByRole('button', { name: 'Turn on PIN unlock' }).click();
      await page.getByText("That's a simple sequence.", { exact: false }).waitFor();
      // Setting a PIN takes the passphrase, not just an unlocked journal.
      await page.getByLabel('PIN', { exact: true }).fill(PIN);
      await page.getByLabel('Repeat PIN').fill(PIN);
      await page.getByLabel('Your passphrase').fill('not the passphrase');
      await page.getByRole('button', { name: 'Turn on PIN unlock' }).click();
      await page.getByText("Your passphrase isn't right.").waitFor({ timeout: 30_000 });
      await page.getByLabel('Your passphrase').fill(PASS);
      await page.getByRole('button', { name: 'Turn on PIN unlock' }).click();
      await page.getByText('Ask for the passphrase after 1 hour without activity').waitFor({ timeout: 30_000 });
      // Settings are saved (encrypted) after a short debounce.
      await page.waitForTimeout(1000);
    });

    await step('locks and reopens with the PIN', async () => {
      await lockJournal(page);
      await page.getByText('Enter your PIN to open it again.').waitFor();
      await enterPin(page, '000111');
      await page.getByText("That PIN isn't right. 4 tries left", { exact: false }).waitFor({ timeout: 30_000 });
      await enterPin(page, PIN);
      await page.locator('.ProseMirror').waitFor({ timeout: 30_000 });
    });

    await step('after too many wrong PINs only the passphrase works', async () => {
      await lockJournal(page);
      for (let i = 0; i < 5; i++) {
        await enterPin(page, '000111');
        if (i < 4) await page.getByText(`${4 - i === 1 ? '1 try' : `${4 - i} tries`} left`, { exact: false }).waitFor({ timeout: 30_000 });
      }
      await page.getByText('Too many wrong PINs.', { exact: false }).waitFor({ timeout: 30_000 });
      assert.equal(await page.getByPlaceholder('PIN').count(), 0);
      await page.getByPlaceholder('Passphrase').fill(PASS);
      await page.getByRole('button', { name: 'Unlock', exact: true }).click();
      await page.waitForURL((u) => !u.pathname.startsWith('/unlock'), { timeout: 30_000 });
    });

    await step('the PIN stops working once the journal has been inactive past the limit', async () => {
      await page.locator('.ProseMirror').waitFor({ timeout: 30_000 });
      await lockJournal(page);
      await page.getByPlaceholder('PIN').waitFor();
      await page.clock.fastForward('01:01:00');
      await page.getByText('your PIN no longer unlocks the journal', { exact: false }).waitFor({ timeout: 10_000 });
      assert.equal(await page.getByPlaceholder('PIN').count(), 0);
      await page.getByPlaceholder('Passphrase').fill(PASS);
      await page.getByRole('button', { name: 'Unlock', exact: true }).click();
      await page.waitForURL((u) => !u.pathname.startsWith('/unlock'), { timeout: 30_000 });
    });

    // (That a reload keeps an unlocked journal open is checked in start.e2e.ts and offline.e2e.ts: this
    // test's fake clock also replaces `performance`, which hides that a page load is a reload.)
    await step('reloading while locked needs the passphrase', async () => {
      await lockJournal(page);
      await page.getByPlaceholder('PIN').waitFor();
      await page.reload();
      await page.getByPlaceholder('Passphrase').waitFor({ timeout: 30_000 });
      assert.equal(await page.getByPlaceholder('PIN').count(), 0);
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
    console.error(`\njournal PIN e2e: FAILED after ${stepsRun()} steps`);
    process.exit(1);
  }
  console.log(`\njournal PIN e2e: all ${stepsRun()} steps passed`);
}

await main();
