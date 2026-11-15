#!/usr/bin/env node
/**
 * Builds the on-device reverse-geocoding dataset in public/places/ from GeoNames
 * (https://www.geonames.org, CC BY 4.0).
 *
 * Downloads cities1000.zip and admin1CodesASCII.txt, then writes one compact JSON file of
 * places binned into 1° lat/lon tiles. The whole dataset is a single file on purpose: the
 * browser fetches it once (lazily, only when location is enabled) and finds the nearest place
 * locally, so the server never learns which tile — and therefore roughly where — you are.
 *
 * Usage: node scripts/build-places.mjs [--cache <dir>] [--out <dir>]
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? resolve(args[i + 1]) : def;
};
const CACHE = opt('--cache', join(here, '..', '.cache', 'geonames'));
const OUT = opt('--out', join(here, '..', 'public', 'places'));
const BASE = 'https://download.geonames.org/export/dump/';

// Populated-place feature codes we keep. Dropped: historical/abandoned/destroyed places.
const KEEP = new Set(['PPL', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLA5', 'PPLC', 'PPLG', 'PPLL', 'PPLF', 'PPLR', 'PPLS', 'PPLX']);

async function download(file) {
  const dest = join(CACHE, file);
  try {
    const s = await stat(dest);
    if (s.size > 0 && Date.now() - s.mtimeMs < 30 * 86400_000) return dest;
  } catch {
    /* not cached */
  }
  await mkdir(CACHE, { recursive: true });
  process.stdout.write(`Downloading ${file}… `);
  const res = await fetch(BASE + file, { headers: { 'User-Agent': 'journal-places-builder' } });
  if (!res.ok || !res.body) throw new Error(`GET ${file}: HTTP ${res.status}`);
  const tmp = dest + '.part';
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  await rename(tmp, dest);
  console.log('done');
  return dest;
}

/** Minimal ZIP reader: returns the named entry (stored or deflated) as a Buffer. */
function unzipEntry(zip, wanted) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const entries = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip directory');
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wanted) {
      const lNameLen = zip.readUInt16LE(local + 26);
      const lExtraLen = zip.readUInt16LE(local + 28);
      const start = local + 30 + lNameLen + lExtraLen;
      const data = zip.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`Unsupported zip compression method ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${wanted} not found in zip`);
}

async function main() {
  const zipPath = await download('cities1000.zip');
  const admin1Path = await download('admin1CodesASCII.txt');

  const admin1Names = new Map();
  for (const line of (await readFile(admin1Path, 'utf8')).split('\n')) {
    const [code, name] = line.split('\t');
    if (code && name) admin1Names.set(code, name);
  }

  const text = unzipEntry(await readFile(zipPath), 'cities1000.txt').toString('utf8');
  const admin1List = [];
  const admin1Index = new Map();
  const internAdmin1 = (name) => {
    if (!name) return -1;
    let i = admin1Index.get(name);
    if (i === undefined) {
      i = admin1List.length;
      admin1List.push(name);
      admin1Index.set(name, i);
    }
    return i;
  };

  const tiles = {};
  let count = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    const f = line.split('\t');
    const code = f[7];
    if (f[6] !== 'P' || !KEEP.has(code)) continue;
    const lat = Number(f[4]);
    const lon = Number(f[5]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const cc = f[8];
    const pop = Number(f[14]) || 0;
    const tlat = Math.floor(lat);
    const tlon = Math.floor(lon);
    const tile = (tiles[`${tlat},${tlon}`] ??= { countries: [], places: [] });
    let ci = tile.countries.indexOf(cc);
    if (ci < 0) ci = tile.countries.push(cc) - 1;
    // Flat 6-tuples: name, lat and lon offset inside the tile (0.001° units ≈ 110 m),
    // population class (-1 = neighbourhood/section of a city, else round(2·log10(pop))),
    // admin1 index (-1 = unknown), country index into this tile's country list.
    tile.places.push(
      f[1],
      Math.min(999, Math.round((lat - tlat) * 1000)),
      Math.min(999, Math.round((lon - tlon) * 1000)),
      code === 'PPLX' ? -1 : pop > 0 ? Math.round(2 * Math.log10(pop)) : 0,
      internAdmin1(admin1Names.get(`${cc}.${f[10]}`)),
      ci,
    );
    count++;
  }

  const out = {
    v: 1,
    source: 'GeoNames cities1000 (https://www.geonames.org), CC BY 4.0',
    built: new Date().toISOString().slice(0, 10),
    tileDegrees: 1,
    format: 'tiles["lat,lon"] = [countries[], name, dLat, dLon, popClass, admin1, countryIdx, ...]',
    admin1: admin1List,
    tiles: Object.fromEntries(Object.entries(tiles).map(([k, t]) => [k, [t.countries, ...t.places]])),
  };
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const json = JSON.stringify(out);
  await writeFile(join(OUT, 'places.v1.json'), json);
  await writeFile(
    join(OUT, 'ATTRIBUTION.txt'),
    'Place names: GeoNames (https://www.geonames.org), licensed under CC BY 4.0\nhttps://creativecommons.org/licenses/by/4.0/\n',
  );
  console.log(`Wrote ${count} places in ${Object.keys(tiles).length} tiles (${(json.length / 1e6).toFixed(1)} MB) to ${OUT}`);
}

main().catch((e) => {
  console.error(`build-places failed: ${e.message}`);
  console.error('The app works without the dataset; entries simply get no location.');
  process.exit(1);
});
