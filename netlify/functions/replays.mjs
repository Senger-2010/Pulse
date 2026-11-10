// Pulse! replay storage (Netlify Function v2 + Netlify Blobs)
//
//   POST   /api/replays   { mapId, name, school, score, replay }   keep a player's best replay, top 3 per map
//   GET    /api/replays?map=ID                                       -> { replays: [{ name, school, score }] }
//   GET    /api/replays?map=ID&name=N&school=S                       -> { replay }
//   DELETE /api/replays?map=ID | ?name=N[&school=S] | ?all=1         (header x-admin-key = ADMIN_KEY env var)
//
// Needs the package  @netlify/blobs  (npm install @netlify/blobs).
import { getStore } from '@netlify/blobs';

export const config = { path: '/api/replays' };

const TOP = 3;                    // replays kept per map
const MAX_BYTES = 900_000;        // largest accepted replay (they are normally 2 - 40 KB)

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });

const pkey = (name, school) => (String(name) + '|' + String(school || '')).toLowerCase();
const idxKey = mapId => 'idx/' + encodeURIComponent(mapId);
const repKey = (mapId, name, school) => 'rep/' + encodeURIComponent(mapId) + '/' + encodeURIComponent(pkey(name, school));

const store = () => getStore({ name: 'pulse-replays', consistency: 'strong' });

export default async (req) => {
  const url = new URL(req.url);
  const db = store();

  try {
    if (req.method === 'GET') {
      const map = url.searchParams.get('map');
      if (!map) return json({ error: 'map is required' }, 400);
      const name = url.searchParams.get('name');
      if (name) {
        const rep = await db.get(repKey(map, name, url.searchParams.get('school')), { type: 'json' });
        return rep ? json({ replay: rep }) : json({ error: 'No replay' }, 404);
      }
      const list = (await db.get(idxKey(map), { type: 'json' })) || [];
      return json({ replays: list.map(({ name, school, score }) => ({ name, school, score })) });
    }

    if (req.method === 'POST') {
      const raw = await req.text();
      if (raw.length > MAX_BYTES) return json({ error: 'Replay too large' }, 413);
      let b;
      try { b = JSON.parse(raw); } catch (e) { return json({ error: 'Bad JSON' }, 400); }

      const mapId = String(b.mapId || '').slice(0, 200);
      const name = String(b.name || '').trim().slice(0, 24);
      const school = String(b.school || '').trim().slice(0, 32);
      const score = Math.floor(Number(b.score));
      const r = b.replay;
      if (!mapId || !name || !Number.isFinite(score) || score < 0) return json({ error: 'Invalid entry' }, 400);
      if (!r || typeof r.d !== 'string' || !Number.isInteger(r.M) || !Number.isInteger(r.N) || r.M < 0 || r.N < 0 ||
          r.M > 200000 || r.N > 200000 || r.score !== score) return json({ error: 'Invalid replay' }, 400);

      const clean = {
        v: 1, M: r.M, N: r.N, endT: Math.floor(+r.endT) || 0, win: !!r.win, approach: Math.floor(+r.approach) || 900,
        label: String(r.label || name).slice(0, 80), score, gz: !!r.gz, d: r.d
      };

      const list = (await db.get(idxKey(mapId), { type: 'json' })) || [];
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
      if (!key || req.headers.get('x-admin-key') !== key) return json({ error: 'Not allowed' }, 403);

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
