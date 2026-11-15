/**
 * End-to-end test of the desktop app (desktop/): the real app, in the system's web view, driven
 * through its window (lib/tauri.ts). The journal is kept in a folder: choosing one starts a journal
 * with no password; the files in it are ciphertext; the journal reopens by itself after a restart;
 * a password locks it; sync can be turned on against a server, and a second computer signing in
 * gets the journal into its own folder.
 *
 * Needs the desktop app's debug build (`make desktop`). Opens real windows: on Linux without a
 * display, run it under xvfb-run.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiClient } from './lib/http';
import { signup } from './lib/journal';
import { step, stepsRun } from './lib/runner';
import { repoRoot, type RunningServer, startServer } from './lib/server';
import { appBinary, css, DesktopApp, label, placeholder, role, text, within } from './lib/tauri';

const PASS = 'tq8!Vx2#mP0r$Lk5wZ9n-Hj3';

/** A server address nothing listens on: what the app would talk to before one is chosen. */
const NO_SERVER = 'http://127.0.0.1:9';

/** Every file under `dir`, with its contents. */
async function filesIn(dir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) out.set(join(e.parentPath, e.name).slice(dir.length + 1), await readFile(join(e.parentPath, e.name)));
  }
  return out;
}

/** The entry files in a journal folder. */
async function entryFiles(folder: string): Promise<string[]> {
  return (await readdir(join(folder, 'entries')).catch(() => [])).filter((n) => n.endsWith('.json'));
}

async function setServer(app: DesktopApp, origin: string) {
  await app.click(role('button', 'Change', true));
  await app.fill(label('Sync server'), origin);
  await app.click(role('button', 'Save', true));
  await app.waitFor(text(`Sync server: ${origin}`));
}

async function unlock(app: DesktopApp) {
  await app.fill(placeholder('Passphrase'), PASS, 30_000);
  await app.click(role('button', 'Unlock', true));
}

const entryLink = role('link', /First day in a folder/);

async function main() {
  for (const f of [appBinary, join(repoRoot, 'desktop', 'renderer', 'index.html')]) {
    if (!existsSync(f)) throw new Error(`${f} not found; run "make desktop" first`);
  }
  const server: RunningServer = await startServer({ port: Number(process.env.E2E_PORT ?? 18187) });
  const tmpRoot = join(repoRoot, 'e2e', '.tmp');
  await mkdir(tmpRoot, { recursive: true });
  const tmp = await mkdtemp(join(tmpRoot, 'desktop-'));
  const [dataA, folderA, dataB, folderB] = ['data-a', 'journal-a', 'data-b', 'journal-b'].map((n) => join(tmp, n));
  let app: DesktopApp | undefined;
  let failed = false;
  const errors: string[] = [];
  const apiCalls: string[] = [];
  const open = (data: string, folder: string, srv = NO_SERVER) => {
    app = new DesktopApp({ KAGIMO_USER_DATA: data, KAGIMO_PICK_FOLDER: folder, KAGIMO_SERVER: srv });
    return app;
  };
  const quit = async () => {
    if (!app) return;
    await app.close();
    errors.push(...app.errors);
    apiCalls.push(...app.apiCalls);
    app = undefined;
  };

  try {
    console.log(`journal desktop e2e: sync server ${server.origin}`);
    // The server's first account is its administrator, who must add a second factor before
    // syncing. Take that place, so the journal below gets an ordinary account.
    await signup(new ApiClient(server.baseUrl, server.origin, 'admin'), 'admin', 'An0ther-long-passphrase-for-the-admin', '');

    let a = open(dataA, folderA);

    await step('first run asks for a folder; choosing an empty one starts a journal with no password', async () => {
      await a.waitFor(role('heading', 'Choose a folder for your journal'), 30_000);
      await a.click(role('button', 'Choose folder…'));
      await a.waitFor(role('heading', 'Start your journal'));
      await a.waitFor(text(folderA));
      await a.click(role('link', 'Start writing'));
      await a.waitFor(css('.ProseMirror'), 30_000);
      await a.waitFor(within(role('region', 'No password'), text('anyone using this computer')));
    });

    await step('an entry is saved into the folder, as ciphertext', async () => {
      await a.fill(placeholder('Title'), 'First day in a folder');
      await a.typeInEditor('Kept in files, not in the browser.');
      await a.waitFor(text(/^(Encrypted · saved|Saved)$/), 10_000);
      const files = await filesIn(folderA);
      assert.ok(files.has('kagimo.json'), 'the journal record');
      assert.equal((await entryFiles(folderA)).length, 1, `one entry file, got ${[...files.keys()].join(', ')}`);
      for (const [name, data] of files) {
        for (const plain of ['First day in a folder', 'Kept in files']) assert.ok(!data.includes(plain), `${name} holds plaintext`);
      }
      const vault = JSON.parse(files.get('kagimo.json')!.toString()) as { format: string; vault: { wrappedMkPass: unknown } };
      assert.equal(vault.format, 'kagimo-journal');
      assert.equal(vault.vault.wrappedMkPass, null, 'no password yet');
      // The key of a journal without a password is on the computer, never in the folder.
      assert.equal((await readdir(join(dataA, 'keys'))).length, 1);
    });

    await step('typing right before closing the window is not lost', async () => {
      await a.typeInEditor(' Last words.');
      await quit();
      a = open(dataA, folderA);
      await a.click(entryLink, 30_000);
      await a.waitFor(within(css('.ProseMirror'), text('Last words.')), 10_000);
      assert.equal(await a.count(placeholder('Passphrase')), 0, 'opens by itself');
    });

    await step('a password locks the journal and removes its key from the computer', async () => {
      await a.click(role('button', 'Set a password'));
      await a.fill(label('Password', true), PASS);
      await a.fill(label('Repeat password'), PASS);
      await a.click(text('I understand nobody can reset my password for me.'));
      await a.click(role('button', 'Set password', true));
      await a.waitFor(role('heading', 'Save your recovery key'), 30_000);
      await a.click(text("I've saved my recovery key somewhere safe."));
      await a.click(role('button', /Save locally/));
      await a.waitGone(role('heading', 'Save your recovery key'));
      assert.equal((await readdir(join(dataA, 'keys'))).length, 0);
      await quit();
      a = open(dataA, folderA);
      await unlock(a);
      await a.waitFor(entryLink, 30_000);
    });

    await step('Settings shows the folder', async () => {
      await a.click(role('link', 'Settings'));
      await a.click(role('link', 'Journal folder'));
      await a.waitFor(role('heading', 'Journal folder'));
      await a.waitFor(text(folderA));
      await a.waitFor(text('1 entry'));
    });

    await step('until sync is set up, the app talks to no server', async () => {
      assert.deepEqual([...apiCalls, ...a.apiCalls], []);
    });

    await step('sync can be turned on, against a chosen server', async () => {
      await a.click(role('link', 'Sync', true));
      await setServer(a, server.origin);
      await a.fill(label('Username'), 'folder');
      await a.fill(label('Passphrase'), PASS);
      await a.click(role('button', 'Turn on sync'));
      await a.waitFor(text('Up to date'), 30_000);
      // The entry written before sync was on goes up with the first sync (within a minute by
      // itself; now, when asked).
      await a.click(role('button', 'Sync now'));
      await a.until(`const dt = [...document.querySelectorAll('dt')].find((d) => d.textContent.trim() === 'Last synced'); return !!dt && !/Never/.test(dt.nextElementSibling?.textContent ?? 'Never');`, 'a first sync', 30_000);
      await a.until(`const dt = [...document.querySelectorAll('dt')].find((d) => d.textContent.trim() === 'Waiting to sync'); return !!dt && /Nothing/.test(dt.nextElementSibling?.textContent ?? '');`, 'nothing waiting to sync', 30_000);
      const vault = JSON.parse(await readFile(join(folderA, 'kagimo.json'), 'utf8')) as { vault: { account: { username: string } | null } };
      assert.equal(vault.vault.account?.username, 'folder');
      assert.ok(a.apiCalls.length > 0, 'the page reached the server through the app');
      await quit();
    });

    await step('another computer signs in and gets the journal into its own folder', async () => {
      const b = open(dataB, folderB, server.origin);
      await b.click(role('button', 'Choose folder…'), 30_000);
      await b.click(role('link', 'Sign in to a sync account'));
      await b.waitFor(text(`Sync server: ${server.origin}`));
      await b.fill(label('Username'), 'folder');
      await b.fill(label('Passphrase'), PASS);
      await b.click(role('button', 'Continue', true));
      await b.click(entryLink, 30_000);
      await b.waitFor(within(css('.ProseMirror'), text('Last words.')), 10_000);
      const files = await filesIn(folderB);
      assert.equal((await entryFiles(folderB)).length, 1);
      for (const [name, data] of files) assert.ok(!data.includes('First day in a folder'), `${name} holds plaintext`);
    });

    await step('burning the entry there deletes its file, and the deletion syncs back', async () => {
      const b = app!;
      await b.click(role('button', /Burn/));
      await b.click(role('button', 'Burn it', true));
      await b.waitGone(entryLink, 15_000);
      assert.deepEqual(await entryFiles(folderB), []);
      await quit(); // pushes what's waiting on the way out
      a = open(dataA, folderA);
      await unlock(a);
      await a.waitFor(text('No entries yet'), 30_000);
      assert.deepEqual(await entryFiles(folderA), []);
    });

    await quit();
    assert.deepEqual(errors, [], 'no page errors');
    console.log(`\nAll ${stepsRun()} steps passed.`);
  } catch (e) {
    failed = true;
    console.error(e);
    const shown = await app?.bodyText();
    if (app) errors.push(...app.errors);
    if (errors.length) console.error('page errors:', errors);
    console.error('the window showed:\n' + (shown ?? '(no window)'));
    console.error(server.output().split('\n').slice(-15).join('\n'));
  } finally {
    app?.kill();
    await server.stop();
    await server.cleanup();
    if (!failed) await rm(tmp, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

void main();
