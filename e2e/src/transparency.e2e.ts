/**
 * Browser end-to-end test of the two pages that let a person check what the server holds and
 * what the device sends (SPEC §5.7): "What the server sees" sets the latest entry, decrypted in
 * the browser, beside the ciphertext the server stores for it, and the server's answer never
 * contains the plaintext; "What this device sent" lists the requests with long values cut short.
 * Set SHOTS to a directory to keep screenshots of both pages.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, type Page, chromium } from 'playwright-core';
import { step, stepsRun } from './lib/runner';
import { type RunningServer, startServer } from './lib/server';

const PASS = 'tq8!Vx2#mP0r$Lk5wZ9n-Hj3';
const TITLE = 'A long walk after the rain';
const TEXT = 'The towpath was all puddles and the heron did not move.';

function browserPath(): string | undefined {
  if (process.env.CHROME) return process.env.CHROME;
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
}

async function signUp(page: Page, origin: string, username: string) {
  await page.goto(`${origin}/welcome`);
  await page.locator('#start').getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(PASS);
  await page.getByLabel('Repeat password').fill(PASS);
  await page.getByText('I understand nobody can reset my password for me.').click();
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Save your recovery key' }).waitFor({ timeout: 30_000 });
  await page.getByText("I've saved my recovery key somewhere safe.").click();
  await page.getByRole('button', { name: 'Continue' }).click();
}

async function shot(page: Page, name: string) {
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `${name}.png`), fullPage: true });
}

async function main() {
  const server: RunningServer = await startServer({ port: Number(process.env.E2E_PORT ?? 18186) });
  let browser: Browser | undefined;
  let failed = false;
  const errors: string[] = [];
  try {
    browser = await chromium.launch({ executablePath: browserPath(), headless: true });
    console.log(`journal transparency e2e: ${server.origin} in ${browser.version()}`);

    // The first account is the admin, which can't sync before it has a second factor.
    const adminCtx = await browser.newContext();
    await signUp(await adminCtx.newPage(), server.origin, 'admin');
    await adminCtx.close();

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));

    await step('a member writes an entry and it syncs', async () => {
      await signUp(page, server.origin, 'alice');
      await page.locator('.ProseMirror').waitFor({ timeout: 30_000 });
      await page.getByPlaceholder('Title').fill(TITLE);
      await page.locator('.ProseMirror').click();
      await page.keyboard.type(TEXT);
      const pushed = page.waitForResponse((r) => /\/api\/entries/.test(r.url()) && r.request().method() !== 'GET' && r.ok(), { timeout: 30_000 });
      await pushed;
    });

    await step('"What the server sees" sets the entry beside its ciphertext, and the server\'s answer holds no plaintext', async () => {
      const answer = page.waitForResponse((r) => /\/api\/entries\/[0-9a-f-]{36}$/.test(r.url()) && r.request().method() === 'GET');
      // Moving inside the app: loading the address afresh would lock the journal.
      await page.evaluate(() => {
        history.pushState({}, '', '/settings/sync/server');
        dispatchEvent(new PopStateEvent('popstate'));
      });
      const body = await (await answer).text();
      for (const plain of [TITLE, 'towpath', 'heron']) assert.ok(!body.includes(plain), `server answer contains "${plain}"`);

      await page.getByRole('heading', { name: 'What the server sees' }).waitFor();
      const device = page.locator('section', { has: page.getByRole('heading', { name: 'On this device' }) });
      await device.getByText(TITLE).waitFor({ timeout: 15_000 });
      await device.getByText(TEXT).waitFor();
      const server = page.locator('section', { has: page.getByRole('heading', { name: 'On our server' }) });
      assert.equal(await server.locator('.sbs-ct').count(), 2, 'header and body ciphertext are shown');
      const stored = await server.innerText();
      for (const plain of [TITLE, 'towpath', 'heron']) assert.ok(!stored.includes(plain), `server side shows "${plain}"`);
      const sent = JSON.parse(body) as { header: { ct: string } };
      assert.ok(stored.includes(sent.header.ct), 'the ciphertext shown is the one the server returned');
      await shot(page, 'server-desktop');
    });

    await step('"What this device sent" lists the requests with long values cut short', async () => {
      await page.getByRole('link', { name: 'What this device sent' }).first().click();
      await page.getByRole('heading', { name: 'What this device sent' }).waitFor();
      const put = page.locator('.sent-row', { hasText: /(POST|PUT)\s*\/api\/entries/ }).first();
      await put.waitFor();
      await put.getByText('What was sent').click();
      const sent = await put.locator('.sent-body').innerText();
      assert.match(sent, /"header"/);
      assert.match(sent, /… \(\d+ characters\)/, 'ciphertext is cut short');
      const all = await page.locator('.sent-list').innerText();
      for (const plain of [TITLE, 'towpath', PASS]) assert.ok(!all.includes(plain), `sent log contains "${plain}"`);
      assert.ok(/GET\s+\/api\/entries\/[0-9a-f-]{36}/.test(all), 'the page before this one is in the log');
      await shot(page, 'sent-desktop');
    });

    await step('both pages fit a phone', async () => {
      await page.setViewportSize({ width: 390, height: 800 });
      for (const [path, name] of [['server', 'server-phone'], ['sent', 'sent-phone']] as const) {
        await page.getByRole('link', { name: path === 'server' ? 'What the server sees' : 'What this device sent' }).first().click();
        await page.getByRole('heading', { name: path === 'server' ? 'What the server sees' : 'What this device sent' }).waitFor();
        if (path === 'server') await page.getByText(TITLE).first().waitFor({ timeout: 15_000 });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 0, `${path} page scrolls sideways by ${overflow}px`);
        await shot(page, name);
      }
    });

    await ctx.close();
    assert.deepEqual(errors, [], 'no uncaught page errors');
  } catch (e) {
    failed = true;
    console.error(`\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    if (errors.length) console.error(`\npage errors:\n${errors.join('\n')}`);
    console.error(`\n--- server output (tail) ---\n${server.output().slice(-3000)}`);
  } finally {
    await browser?.close();
    await server.stop();
    await server.cleanup();
  }
  if (failed) {
    console.error(`\njournal transparency e2e: FAILED after ${stepsRun()} steps`);
    process.exit(1);
  }
  console.log(`\njournal transparency e2e: all ${stepsRun()} steps passed`);
}

await main();
