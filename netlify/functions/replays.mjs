// Pulse! replay storage (Netlify Function v2 + Netlify Blobs)
//
//   POST   /api/replays   { mapId, name, school, score, replay }   keep a player's best replay, top 3 per map
//   GET    /api/replays?map=ID                                       -> { replays: [{ name, school, score }] }
//   GET    /api/replays?map=ID&name=N&school=S                       -> { replay }
//   DELETE /api/replays?map=ID | ?name=N[&school=S] | ?all=1         (header x-admin-key = ADMIN_KEY env var)
//
// Needs the package  @netlify/blobs  (npm install @netlify/blobs).
import { createHash, timingSafeEqual } from 'node:crypto';
import { getStore } from '@netlify/blobs';

export const config = { path: '/api/replays' };

const TOP = 3;                    // replays kept per map
const MAX_BYTES = 900_000;        // largest accepted request (replays are normally 2 - 40 KB)
const MAX_NOTES = 200_000;
const MAX_SAMPLES = 200_000;
const MAX_MAPS = 2000;            // stops anyone from filling the storage with made-up map ids
const MAP_RE = /^[\p{L}\p{N} ._\-\/()+&,'!:#]{1,150}$/u;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  });

const clean1 = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
const sameKey = (a, b) => {                                    // constant-time comparison
  const x = createHash('sha256').update(String(a)).digest(), y = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(x, y);
};
const pkey = (name, school) => (String(name) + '|' + String(school || '')).toLowerCase();
const idxKey = mapId => 'idx/' + encodeURIComponent(mapId);
const repKey = (mapId, name, school) => 'rep/' + encodeURIComponent(mapId) + '/' + encodeURIComponent(pkey(name, school));

const store = () => getStore({ name: 'pulse-replays', consistency: 'strong' });

export default async (req) => {
  const url = new URL(req.url);
  const db = store();

  // Writes must come from this site itself (blocks other websites from posting on a visitor's behalf)
  if (req.method !== 'GET') {
    const origin = req.headers.get('origin');
    if (origin) {
      let host = '';
      try { host = new URL(origin).host; } catch (e) { /* stays empty and is refused */ }
      const ok = [url.host, req.headers.get('host'), req.headers.get('x-forwarded-host')].includes(host);
      if (!host || !ok) return json({ error: 'Not allowed' }, 403);
    }
  }

  try {
    if (req.method === 'GET') {
      const map = url.searchParams.get('map');
      if (!map || !MAP_RE.test(map)) return json({ error: 'map is required' }, 400);
      const name = url.searchParams.get('name');
      if (name) {
        const rep = await db.get(repKey(map, name, url.searchParams.get('school')), { type: 'json' });
        return rep ? json({ replay: rep }) : json({ error: 'No replay' }, 404);
      }
      const list = (await db.get(idxKey(map), { type: 'json' })) || [];
      return json({ replays: list.map(({ name, school, score }) => ({ name, school, score })) });
    }

    if (req.method === 'POST') {
      if (!(req.headers.get('content-type') || '').includes('application/json')) return json({ error: 'JSON only' }, 415);
      if (Number(req.headers.get('content-length') || 0) > MAX_BYTES) return json({ error: 'Replay too large' }, 413);
      const raw = await req.text();
      if (raw.length > MAX_BYTES) return json({ error: 'Replay too large' }, 413);
      let b;
      try { b = JSON.parse(raw); } catch (e) { return json({ error: 'Bad JSON' }, 400); }
      if (!b || typeof b !== 'object') return json({ error: 'Invalid entry' }, 400);

      const mapId = typeof b.mapId === 'string' ? b.mapId : '';
      const name = clean1(b.name, 24);
      const school = clean1(b.school, 32);
      const score = Number(b.score);
      const r = b.replay;
      if (!MAP_RE.test(mapId) || !name || !Number.isSafeInteger(score) || score < 0) return json({ error: 'Invalid entry' }, 400);
      if (!r || typeof r !== 'object' || typeof r.d !== 'string' || !Number.isSafeInteger(r.M) || !Number.isSafeInteger(r.N) ||
          r.M < 0 || r.N < 1 || r.M > MAX_SAMPLES || r.N > MAX_NOTES || r.score !== score) return json({ error: 'Invalid replay' }, 400);
      // The data must look like what the game produces: base64, and no bigger than the raw size it claims
      const rawSize = r.M * 4 + r.N;
      if (!B64_RE.test(r.d) || r.d.length > Math.ceil(rawSize * 1.4) + 2000) return json({ error: 'Invalid replay' }, 400);
      if (score > r.N * 800) return json({ error: 'Invalid score' }, 400);       // 800 is the most one note can give
      const endT = Number(r.endT), approach = Number(r.approach);
      if (!Number.isFinite(endT) || endT < 0 || endT > 3_600_000 || !Number.isFinite(approach) || approach < 100 || approach > 5000) return json({ error: 'Invalid replay' }, 400);

      const clean = {
        v: 1, M: r.M, N: r.N, endT: Math.floor(endT), win: r.win === true, approach: Math.floor(approach),
        label: name + (school ? ' (' + school + ')' : ''), score, gz: r.gz === true, d: r.d
      };

      const list = (await db.get(idxKey(mapId), { type: 'json' })) || [];
      if (!list.length) {
        const { blobs } = await db.list({ prefix: 'idx/' });
        if (blobs.length >= MAX_MAPS) return json({ error: 'Too many maps' }, 429);
      }
      const k = pkey(name, school);
      const prev = list.find(e => pkey(e.name, e.school) === k);
      if (prev && prev.score >= score) return json({ stored: false, reason: 'A better replay is already saved' });

      const next = list.filter(e => pkey(e.name, e.school) !== k).concat({ name, school, score, ts: Date.now() });
      next.sort((a, c) => c.score - a.score || a.ts - c.ts);
      const kept = next.slice(0, TOP);
      if (!kept.some(e => pkey(e.name, e.school) === k)) return json({ stored: false, reason: 'Not in the top ' + TOP });

      await db.setJSON(repKey(mapId, name, school), clean);
      for (const gone of next.slice(TOP)) await db.delete(repKey(mapId, gone.name, gone.school));
      await db.setJSON(idxKey(mapId), kept);
      return json({ stored: true, replays: kept.map(({ name, school, score }) => ({ name, school, score })) });
    }

    if (req.method === 'DELETE') {
      const key = process.env.ADMIN_KEY;
      if (!key || !sameKey(req.headers.get('x-admin-key') || '', key)) return json({ error: 'Not allowed' }, 403);

      const map = url.searchParams.get('map');
      const name = url.searchParams.get('name');
      const school = url.searchParams.get('school');
      const all = url.searchParams.get('all');
      let removed = 0;

      const dropMap = async (m, only) => {
        const list = (await db.get(idxKey(m), { type: 'json' })) || [];
        const keep = [];
        for (const e of list) {
          const hit = !only || (only.name.toLowerCase() === e.name.toLowerCase() && (only.school == null || only.school.toLowerCase() === (e.school || '').toLowerCase()));
          if (hit) { await db.delete(repKey(m, e.name, e.school)); removed++; } else keep.push(e);
        }
        if (keep.length) await db.setJSON(idxKey(m), keep); else await db.delete(idxKey(m));
      };

      if (all) {
        const { blobs } = await db.list();
        for (const bl of blobs) { await db.delete(bl.key); removed++; }
      } else if (map) {
        await dropMap(map, name ? { name, school } : null);
      } else if (name) {
        const { blobs } = await db.list({ prefix: 'idx/' });
        for (const bl of blobs) await dropMap(decodeURIComponent(bl.key.slice(4)), { name, school });
      } else return json({ error: 'Nothing to delete' }, 400);
      return json({ ok: true, removed });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return json({ error: 'Server error' }, 500);
  }
};
