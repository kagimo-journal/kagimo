/**
 * Browser end-to-end test of the landing page's "Sign up" dialog: it makes a journal on this device
 * with a password and a sync account in one go, survives the landing page being replaced by the
 * journal, shows the recovery key, and (with a username already taken) keeps the password it set
 * and retries with just a new username. "Write now" and "Sign in" stay as they were.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { type Browser, type Page, chromium } from 'playwright-core';
import { step, stepsRun } from './lib/runner';
import { type RunningServer, startServer } from './lib/server';

const PASS = 'tq8!Vx2#mP0r$Lk5wZ9n-Hj3';

function browserPath(): string | undefined {
  if (process.env.CHROME) return process.env.CHROME;
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
}

async function openSignUp(page: Page, origin: string) {
  await page.goto(`${origin}/welcome`);
  const start = page.locator('#start');
  await start.getByRole('link', { name: 'Write now' }).waitFor();
  await start.getByRole('link', { name: 'Sign in' }).waitFor();
  await start.getByRole('button', { name: 'Sign up' }).click();
  await page.getByRole('heading', { name: 'Sign up' }).waitFor();
}

async function fillForm(page: Page, username: string) {
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(PASS);
  await page.getByLabel('Repeat password').fill(PASS);
  await page.getByText('I understand nobody can reset my password for me.').click();
}

async function saveKey(page: Page) {
  await page.getByRole('heading', { name: 'Save your recovery key' }).waitFor({ timeout: 30_000 });
  await page.getByText('Your journal and sync account are ready.', { exact: false }).waitFor();
  const cont = page.getByRole('button', { name: 'Continue' });
  assert.ok(await cont.isDisabled(), 'waits for the recovery key to be saved');
  await page.getByText("I've saved my recovery key somewhere safe.").click();
  await cont.click();
}

async function main() {
  const server: RunningServer = await startServer({ port: Number(process.env.E2E_PORT ?? 18185) });
  let browser: Browser | undefined;
  let failed = false;
  const errors: string[] = [];
  try {
    browser = await chromium.launch({ executablePath: browserPath(), headless: true });
    console.log(`journal sign-up e2e: ${server.origin} in ${browser.version()}`);

    await step('the first sign-up becomes the admin and is sent to set up a second factor', async () => {
      const ctx = await browser!.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      await openSignUp(page, server.origin);
      await page.getByText('first account on this server', { exact: false }).waitFor();
      await fillForm(page, 'admin');
      await page.getByRole('button', { name: 'Create account' }).click();
      await saveKey(page);
      await page.waitForURL((u) => u.pathname === '/settings/sync', { timeout: 30_000 });
      await ctx.close();
    });

    await step('a taken username keeps the password; a new username finishes into the editor', async () => {
      const ctx = await browser!.newContext({ viewport: { width: 390, height: 800 } });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      await openSignUp(page, server.origin);
      await fillForm(page, 'admin');
      await page.getByRole('button', { name: 'Create account' }).click();
      await page.getByText('That username is taken.').waitFor({ timeout: 30_000 });
      // The journal now exists here with that password: only the username is asked again.
      await page.getByText("Your journal's password is set.", { exact: false }).waitFor();
      assert.equal(await page.getByLabel('Password', { exact: true }).count(), 0);
      await page.getByLabel('Username').fill('alice');
      await page.getByRole('button', { name: 'Create account' }).click();
      await saveKey(page);
      await page.locator('.ProseMirror').waitFor({ timeout: 30_000 });
      assert.equal(await page.getByRole('heading', { name: /Sign up|recovery key/ }).count(), 0, 'dialog closed');
      await ctx.close();
    });

    await step('cancelling after the password is set still shows the recovery key', async () => {
      const ctx = await browser!.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      await openSignUp(page, server.origin);
      await fillForm(page, 'alice');
      await page.getByRole('button', { name: 'Create account' }).click();
      await page.getByText('That username is taken.').waitFor({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('heading', { name: 'Save your recovery key' }).waitFor();
      await page.getByText('Sync isn’t on yet', { exact: false }).waitFor();
      await page.getByText("I've saved my recovery key somewhere safe.").click();
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.locator('.ProseMirror').waitFor({ timeout: 30_000 });
      await ctx.close();
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
    console.error(`\njournal sign-up e2e: FAILED after ${stepsRun()} steps`);
    process.exit(1);
  }
  console.log(`\njournal sign-up e2e: all ${stepsRun()} steps passed`);
}

await main();
