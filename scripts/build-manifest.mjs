// Scans public/maps/ (recursively) for .sspm files and writes public/maps-manifest.json.
//
// Why: static hosting (Netlify) can't list a folder, so the game reads this manifest.
// It also contains each map's metadata, so the lobby doesn't have to download
// every song just to show names, note counts and difficulty.
//
// Optional: put maps in a subfolder named easy / hard / insane / death to force
// their difficulty folder, e.g. public/maps/insane/MySong.sspm

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAPS_DIR = path.join(ROOT, 'public', 'maps');
const OUT = path.join(ROOT, 'public', 'maps-manifest.json');
const FOLDERS = new Set(['easy', 'hard', 'insane', 'death']);

/* Same logic as parseSSPM() in script.js, minus the audio extraction. */
export function parseMeta(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const td = new TextDecoder();

  if (buf.byteLength < 130 || td.decode(u8.subarray(0, 4)) !== 'SS+m') throw new Error('Not a .sspm file');
  const ver = dv.getUint16(4, true);
  if (ver !== 2) throw new Error('Only .sspm version 2 is supported (found ' + ver + ')');

  const lastMs = dv.getUint32(30, true);
  const diff = dv.getUint8(42);
  const hasAudio = dv.getUint8(45);
  const markerCount = dv.getUint32(38, true);

  const off = [];
  for (let i = 0; i < 10; i++) off.push(Number(dv.getBigUint64(48 + i * 8, true)));

  let p = 128;
  const str = () => {
    const n = dv.getUint16(p, true);
    const s = td.decode(u8.subarray(p + 2, p + 2 + n));
    p += 2 + n;
    return s;
  };
  const id = str();
  const name = str();
  const song = str();
  const mc = dv.getUint16(p, true);
  p += 2;
  const mappers = [];
  for (let i = 0; i < mc; i++) mappers.push(str());

  const aLen = off[3], dOff = off[6], mOff = off[8];

  let q = dOff;
  const dc = dv.getUint8(q++);
  const defs = [];
  for (let i = 0; i < dc; i++) {
    const n = dv.getUint16(q, true);
    const nm = td.decode(u8.subarray(q + 2, q + 2 + n));
    q += 2 + n;
    const nv = dv.getUint8(q++);
    const types = [];
    for (let k = 0; k < nv; k++) types.push(dv.getUint8(q++));
    q++;
    defs.push({ nm, types });
  }

  q = mOff;
  const times = [];
  for (let i = 0; i < markerCount; i++) {
    const ms = dv.getUint32(q, true);
    q += 4;
    const d = defs[dv.getUint8(q++)];
    if (!d) throw new Error('Corrupt marker data');
    let hasPos = false;
    for (const ty of d.types) {
      switch (ty) {
        case 1: q += 1; break;
        case 2: q += 2; break;
        case 3: q += 4; break;
        case 4: q += 8; break;
        case 5: q += 4; break;
        case 6: q += 8; break;
        case 7:
          hasPos = true;
          if (dv.getUint8(q++)) q += 8; else q += 2;
          break;
        case 8: case 9: q += 2 + dv.getUint16(q, true); break;
        case 10: case 11: q += 4 + dv.getUint32(q, true); break;
        default: throw new Error('Unknown marker data type ' + ty);
      }
    }
    if (d.nm === 'ssp_note' && hasPos) times.push(ms);
  }

  times.sort((a, b) => a - b);
  if (!times.length) throw new Error('This map has no notes');
  if (!hasAudio || !aLen) throw new Error('This map is silent');

  const span = Math.max(1, (times[times.length - 1] - times[0]) / 1000);
  return {
    id: id || name,
    name: name || song || 'Untitled',
    mapper: mappers.join(', ') || 'unknown',
    diff,
    notes: times.length,
    dur: Math.max(lastMs, times[times.length - 1]),
    nps: times.length / span
  };
}

// Same thresholds as classify() in script.js
function classify(m) {
  if (m.diff === 1) return 'easy';
  if (m.diff === 2 || m.diff === 3) return 'hard';
  if (m.diff === 4) return 'insane';
  if (m.diff >= 5) return 'death';
  return m.nps < 3.5 ? 'easy' : m.nps < 6 ? 'hard' : m.nps < 9.5 ? 'insane' : 'death';
}

async function walk(dir, base = '') {
  let out = [];
  let items = [];
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const it of items) {
    const rel = base ? base + '/' + it.name : it.name;
    if (it.isDirectory()) out = out.concat(await walk(path.join(dir, it.name), rel));
    else if (/\.sspm$/i.test(it.name)) out.push(rel);
  }
  return out;
}

async function main() {
  await mkdir(MAPS_DIR, { recursive: true });
  const files = (await walk(MAPS_DIR)).sort((a, b) => a.localeCompare(b));
  const maps = [];
  const seenIds = new Map();

  for (const file of files) {
    const buf = await readFile(path.join(MAPS_DIR, file));
    const ver = createHash('sha1').update(buf).digest('hex').slice(0, 12);
    const entry = { file, ver, size: buf.length };

    try {
      const meta = parseMeta(buf);
      if (seenIds.has(meta.id)) {
        console.warn(`  ! skipped ${file}: same map id as ${seenIds.get(meta.id)}`);
        continue;
      }
      seenIds.set(meta.id, file);
      const first = file.split('/')[0].toLowerCase();
      entry.folder = file.includes('/') && FOLDERS.has(first) ? first : classify(meta);
      entry.meta = meta;
      console.log(`  + ${file}  [${entry.folder}]  ${meta.notes} notes, ${meta.nps.toFixed(1)}/s`);
    } catch (e) {
      // Leave it in the manifest without metadata: the browser will try and report the error.
      console.warn(`  ! could not read ${file}: ${e.message}`);
    }
    maps.push(entry);
  }

  await writeFile(OUT, JSON.stringify({ generated: new Date().toISOString(), maps }, null, 1));
  console.log(`maps-manifest.json written (${maps.length} map${maps.length === 1 ? '' : 's'})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
