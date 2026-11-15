/// <reference types="vitest/config" />
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const outDir = resolve(__dirname, '../backend/web/dist');
/** `--mode desktop`: the same app, built for the desktop app in ../desktop (see src-tauri/src/lib.rs). */
const desktopOutDir = resolve(__dirname, '../desktop/renderer');

/**
 * emptyOutDir wipes backend/web/dist, including the committed .gitkeep that lets the Go
 * binary (//go:embed all:dist) compile in a fresh checkout. Put it back after each build.
 */
function keepDistPlaceholder(): Plugin {
  return {
    name: 'journal-keep-dist-placeholder',
    apply: 'build',
    closeBundle() {
      writeFileSync(resolve(outDir, '.gitkeep'), '');
    },
  };
}

/**
 * Writes dist/sw.js from src/sw/sw-template.js with the list of files to precache (every built
 * file plus the small public ones) and a version derived from them, so each deploy installs a
 * new service worker and its cache.
 */
function serviceWorker(): Plugin {
  const PUBLIC_SHELL = ['/theme-boot.js', '/site.webmanifest', '/brand/favicon.svg', '/brand/kagimo-mark.svg', '/brand/kagimo-mark-light.svg'];
  let files: string[] = [];
  return {
    name: 'journal-service-worker',
    apply: 'build',
    generateBundle(_opts, bundle) {
      // Fonts: only the Latin subsets up front; other scripts are cached the first time a page
      // needs them (the browser only asks for a subset when the text uses it).
      const font = (f: string) => /\.(woff2?|ttf)$/.test(f);
      files = Object.keys(bundle).filter((f) => !f.endsWith('.map') && f !== 'sw.js' && (!font(f) || /-latin-(ext-)?\d/.test(f)));
    },
    closeBundle() {
      // Only files that were written: one missing URL would make the whole install fail.
      const precache = ['/index.html', ...files.filter((f) => f !== 'index.html').map((f) => `/${f}`), ...PUBLIC_SHELL].filter((f) =>
        existsSync(resolve(outDir, f.slice(1))),
      );
      const hash = createHash('sha256');
      for (const f of precache) {
        hash.update(f);
        hash.update(readFileSync(resolve(outDir, f.slice(1))));
      }
      const template = readFileSync(resolve(__dirname, 'src/sw/sw-template.js'), 'utf8');
      const sw = template
        .replace("const VERSION = '__VERSION__';", `const VERSION = '${hash.digest('hex').slice(0, 16)}';`)
        .replace('const PRECACHE = __PRECACHE__;', `const PRECACHE = ${JSON.stringify(precache, null, 2)};`);
      if (sw.includes("'__VERSION__';") || sw.includes('= __PRECACHE__')) throw new Error('sw-template.js placeholders not found');
      writeFileSync(resolve(outDir, 'sw.js'), sw);
    },
  };
}

export default defineConfig(({ mode }) => ({
  // The desktop app's files are on the computer already: no service worker to keep them there.
  plugins: mode === 'desktop' ? [react()] : [react(), keepDistPlaceholder(), serviceWorker()],
  server: {
    port: 5173,
    proxy: {
      // Override with JOURNAL_API=http://127.0.0.1:9090 when the backend runs elsewhere.
      '/api': { target: process.env.JOURNAL_API ?? 'http://127.0.0.1:8080', changeOrigin: false },
    },
  },
  build: {
    outDir: mode === 'desktop' ? desktopOutDir : outDir,
    emptyOutDir: true,
    target: 'es2022',
    // The scripts are served as readable code: names and layout intact, so anyone can
    // read in the browser exactly what runs (README "Reading the code that runs"). CSS is not
    // code and stays minified.
    minify: false,
    cssMinify: true,
    sourcemap: false,
    chunkSizeWarningLimit: 700,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
  },
}));
