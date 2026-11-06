// Leaderboard API  ->  /api/scores
//
//   GET    /api/scores?map=<mapId>&limit=10      top scores for a map
//   POST   /api/scores                            submit a score (JSON body)
//   DELETE /api/scores?map=..&name=..&school=..   admin only (x-admin-key header)
//
// Storage: Netlify Blobs (store "pulse-scores"), one JSON array per map.
// One entry per player (name + school) per map: only their best score is kept.

import { createHash, timingSafeEqual } from 'node:crypto';
import { getStore } from '@netlify/blobs';

export const config = { path: '/api/scores' };

const KEEP = 50;            // entries stored per map
const DEFAULT_LIMIT = 10;   // entries returned by default
const GRADES = new Set(['SS', 'S', 'A', 'B', 'C', 'D', 'F']);

/* ---------- helpers ---------- */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });

const store = () => getStore({ name: 'pulse-scores', consistency: 'strong' });
const keyFor = mapId => 'map-' + createHash('sha1').update(mapId).digest('hex');
const playerKey = e => (e.name + '|' + e.school).toLowerCase();

// strip control chars, collapse whitespace, cap length
const cleanStr = (v, max) =>
  String(v ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

// Same scoring as the client: 100 * (1 + min(7, floor(combo / 15))) per hit.
// The best possible score for h hits is a full-combo run of h hits.
function maxScoreFor(hits) {
  let s = 0;
  for (let i = 1; i <= hits; i++) s += 100 * (1 + Math.min(7, Math.floor(i / 15)));
  return s;
}

const safeEqual = (a, b) => {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
};

// The map manifest is used to reject scores for maps that do not exist
// and to sanity-check hits/score against the real note count.
let manifestCache = { t: 0, byId: null };
async function getManifest(req) {
  if (manifestCache.byId && Date.now() - manifestCache.t < 5 * 60 * 1000) return manifestCache.byId;
  try {
    const res = await fetch(new URL('/maps-manifest.json', req.url));
    if (!res.ok) return null;
    const data = await res.json();
    const byId = new Map();
    for (const m of data.maps || []) if (m.meta && m.meta.id) byId.set(m.meta.id, m.meta);
    manifestCache = { t: Date.now(), byId };
    return byId;
  } catch (e) {
    return null; // can't verify -> accept (keeps local dev working)
  }
}

const sortBoard = list => list.sort((a, b) => b.score - a.score || b.acc - a.acc || a.ts - b.ts);

/* ---------- handlers ---------- */

async function handleGet(req) {
  const url = new URL(req.url);
  const mapId = url.searchParams.get('map');
  if (!mapId || mapId.length > 200) return json({ error: 'map is required' }, 400);

  const limit = Math.min(KEEP, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || DEFAULT_LIMIT));
  const list = (await store().get(keyFor(mapId), { type: 'json' })) || [];
  return json({ scores: list.slice(0, limit) });
}

async function handlePost(req) {
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const mapId = typeof body.mapId === 'string' ? body.mapId : '';
  if (!mapId || mapId.length > 200) return json({ error: 'mapId is required' }, 400);

  const name = cleanStr(body.name, 24);
  const school = cleanStr(body.school, 32);
  if (!name || !school) return json({ error: 'name and school are required' }, 400);

  const score = body.score, hits = body.hits, misses = body.misses, maxCombo = body.maxCombo;
  const acc = Number(body.acc);
  const progress = Number(body.progress);
  if (!isInt(score, 0, 100_000_000) || !isInt(hits, 0, 200_000) || !isInt(misses, 0, 200_000) ||
      !isInt(maxCombo, 0, 200_000) || !(acc >= 0 && acc <= 100) || !(progress >= 0 && progress <= 100)) {
    return json({ error: 'Invalid score data' }, 400);
  }
  if (maxCombo > hits) return json({ error: 'Invalid score data' }, 400);
  if (score > maxScoreFor(hits)) return json({ error: 'Score is not possible' }, 400);

  const manifest = await getManifest(req);
  if (manifest) {
    const meta = manifest.get(mapId);
    if (!meta) return json({ ranked: false, reason: 'unknown-map' });
    if (hits + misses > meta.notes) return json({ error: 'Score is not possible' }, 400);
  }

  const entry = {
    name,
    school,
    score,
    acc: Math.round(acc * 100) / 100,
    maxCombo,
    grade: GRADES.has(body.grade) ? body.grade : 'F',
    cleared: body.cleared === true,
    ts: Date.now()
  };

  const s = store();
  const key = keyFor(mapId);
  let list = (await s.get(key, { type: 'json' })) || [];

  const pk = playerKey(entry);
  const prev = list.find(e => playerKey(e) === pk);
  let improved = true;

  if (prev && prev.score >= entry.score) {
    improved = false; // keep their existing best
  } else {
    list = list.filter(e => playerKey(e) !== pk);
    list.push(entry);
    sortBoard(list);
    list = list.slice(0, KEEP);
    await s.setJSON(key, list);
  }

  const idx = list.findIndex(e => playerKey(e) === pk);
  return json({
    ranked: true,
    improved,
    rank: idx >= 0 ? idx + 1 : null,
    best: idx >= 0 ? list[idx].score : entry.score,
    scores: list.slice(0, DEFAULT_LIMIT)
  });
}

// DELETE /api/scores?map=ID                     clear one map
// DELETE /api/scores?name=Alex[&school=X]       remove a player (all maps, or with &map=)
// DELETE /api/scores?all=1                      wipe everything
async function handleDelete(req) {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return json({ error: 'Admin actions are disabled (set ADMIN_KEY)' }, 403);
  if (!safeEqual(req.headers.get('x-admin-key') || '', adminKey)) return json({ error: 'Forbidden' }, 403);

  const url = new URL(req.url);
  const mapId = url.searchParams.get('map');
  const name = cleanStr(url.searchParams.get('name'), 24).toLowerCase();
  const school = cleanStr(url.searchParams.get('school'), 32).toLowerCase();
  const s = store();

  if (url.searchParams.get('all') === '1') {
    const { blobs } = await s.list();
    await Promise.all(blobs.map(b => s.delete(b.key)));
    return json({ deleted: blobs.length });
  }

  if (mapId && !name) {
    await s.delete(keyFor(mapId));
    return json({ deleted: 'map' });
  }

  if (name) {
    const keys = mapId ? [keyFor(mapId)] : (await s.list()).blobs.map(b => b.key);
    let removed = 0;
    for (const key of keys) {
      const list = (await s.get(key, { type: 'json' })) || [];
      const next = list.filter(e => !(e.name.toLowerCase() === name && (!school || e.school.toLowerCase() === school)));
      if (next.length !== list.length) {
        removed += list.length - next.length;
        await s.setJSON(key, next);
      }
    }
    return json({ removed });
  }

  return json({ error: 'Specify map, name or all=1' }, 400);
}

export default async (req) => {
  try {
    if (req.method === 'GET') return await handleGet(req);
    if (req.method === 'POST') return await handlePost(req);
    if (req.method === 'DELETE') return await handleDelete(req);
    return json({ error: 'Method not allowed' }, 405);
  } catch (err) {
    console.error('scores function error:', err);
    return json({ error: 'Server error' }, 500);
  }
};
