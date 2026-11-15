/**
 * Starts a fresh journal server (bin/journal) on its own temporary data directory and
 * stops it again. The temp directory lives inside e2e/.tmp so nothing is written
 * outside the repository.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '../../..');

export interface ServerOptions {
  port?: number;
  /** Path to the journal binary; defaults to $JOURNAL_BIN or <repo>/bin/journal. */
  bin?: string;
  /** Keep the data directory after stop() (for debugging). */
  keepData?: boolean;
}

export interface RunningServer {
  /** Where the test talks to the server (always 127.0.0.1). */
  baseUrl: string;
  /** The configured origin (http://localhost:<port>), sent as the Origin header. */
  origin: string;
  dataDir: string;
  /** Everything the server printed so far (stdout + stderr). */
  output(): string;
  /** Graceful SIGTERM shutdown; waits for the process to exit. Idempotent. */
  stop(): Promise<void>;
  /** Removes the data directory (call after stop()). */
  cleanup(): Promise<void>;
}

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const port = opts.port ?? Number(process.env.E2E_PORT ?? 18181);
  const bin = opts.bin ?? process.env.JOURNAL_BIN ?? join(repoRoot, 'bin', 'journal');
  if (!existsSync(bin)) throw new Error(`journal binary not found at ${bin}; run "make build" first`);

  const tmpRoot = join(repoRoot, 'e2e', '.tmp');
  await mkdir(tmpRoot, { recursive: true });
  const dataDir = await mkdtemp(join(tmpRoot, 'data-'));
  const origin = `http://localhost:${port}`;
  const baseUrl = `http://127.0.0.1:${port}`;

  await assertPortFree(baseUrl);

  let out = '';
  const child: ChildProcess = spawn(
    bin,
    ['-addr', `127.0.0.1:${port}`, '-data', dataDir, '-origin', origin, '-rp-id', 'localhost'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
  );
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (out += d));
  const exited = new Promise<number | null>((res) => child.once('exit', (code) => res(code)));

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(timer);
    }
  };
  const server: RunningServer = {
    baseUrl,
    origin,
    dataDir,
    output: () => out,
    stop,
    cleanup: async () => {
      if (!opts.keepData) await rm(dataDir, { recursive: true, force: true });
    },
  };

  try {
    await waitUntilReady(baseUrl, child, () => out);
  } catch (e) {
    await stop();
    await server.cleanup();
    throw e;
  }
  return server;
}

async function assertPortFree(baseUrl: string) {
  try {
    await fetch(`${baseUrl}/api/config`, { signal: AbortSignal.timeout(1000) });
  } catch {
    return; // nothing listening: good
  }
  throw new Error(`something is already listening on ${baseUrl}; stop it or set E2E_PORT`);
}

async function waitUntilReady(baseUrl: string, child: ChildProcess, output: () => string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode}):\n${output()}`);
    try {
      const res = await fetch(`${baseUrl}/api/config`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not become ready within 15s:\n${output()}`);
}
