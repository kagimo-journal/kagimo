/**
 * Browser smoke test: loads /signin, /welcome and /about from the production build (embedded in
 * bin/journal, served with the real CSP) in headless Chromium and fails on any CSP
 * violation, uncaught page error, console error or unexpected failed request.
 *
 * Uses playwright-core only (no browser download): set CHROME to a Chromium/Chrome binary,
 * otherwise /usr/bin/chromium (or Playwright's cached browser) is used.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { type Browser, chromium, type ConsoleMessage, type Page } from 'playwright-core';
import { step, stepsRun } from './lib/runner';
import { type RunningServer, startServer } from './lib/server';

const EXPECTED_TITLES: Record<string, RegExp> = {
  '/signin': /^Sign in to sync$/,
  '/welcome': /^A journal only you can read\.$/,
  '/about': /^How your journal stays private$/,
};

function browserPath(): string | undefined {
  if (process.env.CHROME) return process.env.CHROME;
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
}

/** Collects every kind of problem the page reports. */
function watch(page: Page, origin: string) {
  const problems: string[] = [];
  // The signed-out app probes /api/me and gets a 401: that one is expected.
  const expectedFailure = (url: string, status: number) => status === 401 && url === `${origin}/api/me`;

  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const text = m.text();
    if (/Failed to load resource: the server responded with a status of 401/.test(text) && m.location().url === `${origin}/api/me`) return;
    if (m.type() === 'warning' && !/Content Security Policy|Refused to/i.test(text)) return;
    problems.push(`console ${m.type()}: ${text}`);
  });
  page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
  page.on('response', (r) => {
    if (r.status() >= 400 && !expectedFailure(r.url(), r.status())) problems.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  return problems;
}

async function checkPage(browser: Browser, server: RunningServer, path: string) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Record CSP violations from inside the page (init scripts are not subject to the CSP).
  await context.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI || '(inline)'} at ${e.sourceFile}:${e.lineNumber}`);
    });
  });
  const page = await context.newPage();
  const problems = watch(page, server.origin);
  try {
    const res = await page.goto(server.origin + path, { waitUntil: 'networkidle' });
    assert.ok(res, 'navigation response');
    assert.equal(res.status(), 200);
    const csp = res.headers()['content-security-policy'] ?? '';
    assert.match(csp, /default-src 'self'/, 'HTML is served with the CSP');
    assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);

    const title = (await page.locator('h1').first().textContent({ timeout: 10_000 }))?.trim() ?? '';
    assert.match(title, EXPECTED_TITLES[path], `${path} heading`);

    // Self-hosted fonts must load under the CSP.
    await page.evaluate(() => document.fonts.ready);
    const fonts = await page.evaluate(() =>
      [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '')),
    );
    assert.ok(fonts.length > 0, 'at least one web font loaded');

    const csps = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
    assert.deepEqual([...csps.map((c) => `CSP violation: ${c}`), ...problems], [], `${path} reported problems`);
    return { title, fonts: [...new Set(fonts)] };
  } finally {
    await context.close();
  }
}

async function main() {
  const executablePath = browserPath();
  const server = await startServer();
  let browser: Browser | undefined;
  let failed = false;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    console.log(`journal smoke: ${server.origin} in ${executablePath ?? 'Playwright Chromium'} ${browser.version()}`);
    for (const path of Object.keys(EXPECTED_TITLES)) {
      const r = await step(`${path} loads without CSP violations or console errors`, () => checkPage(browser!, server, path));
      console.log(`         "${r.title}"; fonts: ${r.fonts.join(', ')}`);
    }
  } catch (e) {
    failed = true;
    console.error(`\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    console.error(`\n--- server output ---\n${server.output()}`);
  } finally {
    await browser?.close();
    await server.stop();
    await server.cleanup();
  }
  if (failed) {
    console.error(`\njournal smoke: FAILED after ${stepsRun()} steps`);
    process.exit(1);
  }
  console.log(`\njournal smoke: all ${stepsRun()} steps passed`);
}

await main();
