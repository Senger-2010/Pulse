(() => {
  'use strict';

  /* ==========================================================================
     Helper utility functions
     ========================================================================== */
  const $ = selector => document.querySelector(selector);
  const lerp = (a, b, u) => a + (b - a) * u;
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const esc = str => String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
  
  const fmt = num => Math.round(num).toLocaleString('en-US');
  const fmtTime = ms => {
    const s = Math.round(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };

  /* ==========================================================================
     Configuration & Constants
     ========================================================================== */
  const MAX_LATE_TIME = 70;
  const KICK_STRENGTH = 0.4;

  const FOLDERS = [
    { key: 'easy', label: 'Easy', color: '#3ddc97' },
    { key: 'hard', label: 'Hard', color: '#ffa53d' },
    { key: 'insane', label: 'Insane', color: '#ff3d71' },
    { key: 'death', label: '助けて', color: '#d9d4ff' }
  ];
  const FOLDER = Object.fromEntries(FOLDERS.map(f => [f.key, f]));

  // Default Game Settings
  const DEF = {
    sens: 1.2,
    approach: 900,
    vol: 0.7,
    sfx: 0.5,
    offset: 0,
    mouse: 'auto',
    quality: 'balanced',
    lowLat: 'off',
    noteStyle: 'solid',        // 'solid' (modern) | 'legacy' (neon wireframe)
    palette: 'neon',
    custom: ['#ff3d71', '#35d6ff', '#ffd23d', '#6dff8c'],
    customN: 2,
    mesh: 'rounded',           // rounded | square | circle
    noteScale: 1,
    noteOpacity: 1,
    noteFill: 1,               // opacity of the inside of a note (the rim stays solid)
    cursorShape: 'circle',     // circle | square | image
    cursorImage: '',           // data URL of the custom cursor image
    cursorColorMode: 'note',   // note (colour of the next note) | custom
    cursorColor: '#ffffff',
    cursorScale: 1,
    cursorSpin: 0,             // degrees per second
    trailOn: true,
    smartTrail: true,          // skip trail points that would sit on top of each other
    trailFade: 'both',         // scale | fade | both
    trailDetail: 16,           // trail points
    trailTime: 0.08,           // seconds
    showFps: false
  };

  /* note color palettes (modern notes cycle through the colors in order) */
  const hueWheel = n => Array.from({ length: n }, (_, i) => hsl2hex(i / n * 360, 0.72, 0.62));
  function hsl2hex(h, s, l) {
    const a = s * Math.min(l, 1 - l), f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return '#' + [f(0), f(8), f(4)].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  }
  const PALETTES = [
    { id: 'neon', name: 'Neon (default)', c: ['#ff3d71', '#35d6ff'] },
    { id: 'cotton', name: 'Cotton Candy', c: ['#00fff0', '#ff93f5'] },
    { id: 'veggie', name: 'Veggie Straws', c: ['#ffcd4f', '#ff7b94', '#e8de83'] },
    { id: 'votes', name: 'Everybody Votes Channel', c: ['#fb94f1', '#9aff93'] },
    { id: 'redblue', name: 'Red & Blue', c: ['#ff4444', '#4455ff'] },
    { id: 'pastel', name: 'Pastel', c: ['#5ecbff', '#f7a9bd', '#ffffff'] },
    { id: 'hue', name: 'Hue Wheel', c: hueWheel(12) },
    { id: 'hueultra', name: 'Hue Wheel Ultra', c: hueWheel(25) },
    { id: 'soul', name: 'SOUL', c: ['#ffffff'] },
    { id: 'purple', name: 'purple!!!', c: ['#9a5cff'] },
    { id: 'vortex', name: 'Vortex', c: ['#0b0612', '#3a1b46'] },
    { id: 'wii', name: 'Wii Players', c: ['#0092ff', '#e6313a', '#13b813', '#ffaa00'] },
    { id: 'custom', name: 'Custom', custom: true }
  ];

  // render scale
  const qCap = () => ({ high: 2, balanced: 1.25, low: 1, potato: 0.6 })[S.quality] || 1.25;
  const lowFxOn = () => S.quality === 'low' || S.quality === 'potato';
  let fxCache = null, fxQ = '';
  const fxFor = () => {                                   // cached: no allocation per frame
    if (fxQ !== S.quality) {
      fxQ = S.quality;
      fxCache = {
        glow: S.quality === 'high' || S.quality === 'balanced',
        rings: S.quality !== 'low' && S.quality !== 'potato',
        kickRings: S.quality !== 'potato',
        kickBg: S.quality !== 'potato',
        trail: S.quality !== 'potato',
        flat: S.quality === 'potato'
      };
    }
    return fxCache;
  };
  // modern note style handed to the renderer
  let styleCache = null;
  const MESH = { rounded: 0.28, square: 0.05, circle: 1 };
  const invalidateStyle = () => { styleCache = null; };
  /* ----- cursor: shape, colour, spin and trail ----- */
  const CPINK = [1.0, 0.24, 0.44], CCYAN = [0.21, 0.84, 1.0];
  const trailBuf = new Float32Array(4 * 64);
  const curOut = { shape: 0, scale: 1, trail: trailBuf, tn: 0, x: 0, y: 0, ang: 0, r: 1, g: 1, b: 1 };
  let spinA = 0, cursorImgOk = false, curRGB = [1, 1, 1], curRGBKey = '';

  function syncCursorImage() {
    cursorImgOk = false;
    if (!GL || !GL.setCursorImage) return;
    if (!S.cursorImage) { GL.setCursorImage(null); return; }
    const im = new Image();
    im.onload = () => { GL.setCursorImage(im); cursorImgOk = true; };
    im.onerror = () => GL.setCursorImage(null);
    im.src = S.cursorImage;
  }

  function hexRGB(h) {
    if (h !== curRGBKey) { const v = parseInt(h.slice(1), 16) || 0; curRGB = [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255]; curRGBKey = h; }
    return curRGB;
  }

  // color of the next note that is still to be hit
  function nextNoteRGB() {
    const i = Math.min(g.lo, Math.max(0, g.N - 1)), st = noteStyle();
    if (st) { const k = (i % st.n) * 3; return [st.colors[k], st.colors[k + 1], st.colors[k + 2]]; }
    return (i & 1) ? CCYAN : CPINK;
  }

  // trail point `age` ms behind the head
  function replayPos(tms, out, o) {
    const R = g.replay, f = Math.max(0, tms) / REC_DT, i = Math.min(R.M - 1, f | 0), j = Math.min(R.M - 1, i + 1), u = Math.min(1, f - i);
    out[o] = lerp(R.x[i], R.x[j], u); out[o + 1] = lerp(R.y[i], R.y[j], u);
  }

  function buildCursor(t, pfNow, dtF, fx) {
    const C = curOut;
    C.shape = S.cursorShape === 'square' ? 1 : (S.cursorShape === 'image' && cursorImgOk ? 2 : 0);
    C.scale = S.cursorScale;
    spinA = (spinA + S.cursorSpin * Math.PI / 180 * dtF / 1000) % (Math.PI * 2);
    C.ang = spinA;
    C.x = g.cur.x; C.y = g.cur.y;
    let rgb;
    if (S.cursorColorMode === 'custom') rgb = hexRGB(S.cursorColor);
    else rgb = C.shape === 2 ? [1, 1, 1] : nextNoteRGB();          // an image keeps its own color
    C.r = rgb[0]; C.g = rgb[1]; C.b = rgb[2];

    let tn = 0;
    if (S.trailOn && fx.trail) {
      const detail = S.trailDetail | 0, T = S.trailTime * 1000, mode = S.trailFade, smart = S.smartTrail;
      let lx = C.x, ly = C.y;
      let j = (g.hI - 1 + HN) % HN, cnt = g.hC;
      const tmp = [0, 0];
      for (let k = 1; k <= detail; k++) {
        const age = T * k / detail;
        let px, py;
        if (g.replay) { replayPos(t - age, tmp, 0); px = tmp[0]; py = tmp[1]; }
        else if (!g.hC) { px = C.x; py = C.y; }
        else {
          const pt = pfNow - age;
          while (cnt > 1 && g.hT[(j - 1 + HN) % HN] > pt) { j = (j - 1 + HN) % HN; cnt--; }
          if (g.hT[j] <= pt || cnt <= 1) { px = g.hX[j]; py = g.hY[j]; }
          else {
            const jp = (j - 1 + HN) % HN, span = g.hT[j] - g.hT[jp], u = span > 0 ? (pt - g.hT[jp]) / span : 1;
            px = lerp(g.hX[jp], g.hX[j], u); py = lerp(g.hY[jp], g.hY[j], u);
          }
        }
        if (smart && (px - lx) * (px - lx) + (py - ly) * (py - ly) < 3e-5) continue;   // would sit under the previous point
        lx = px; ly = py;
        const u = 1 - k / detail;
        const o = tn * 4;
        trailBuf[o] = px; trailBuf[o + 1] = py;
        trailBuf[o + 2] = mode === 'fade' ? 1 : (mode === 'scale' ? 0.25 + 0.75 * u : 0.4 + 0.6 * u);
        trailBuf[o + 3] = mode === 'scale' ? 0.5 : u * 0.55;
        tn++;
      }
      for (let a = 0, b = tn - 1; a < b; a++, b--) {                // oldest first
        for (let q = 0; q < 4; q++) { const v = trailBuf[a * 4 + q]; trailBuf[a * 4 + q] = trailBuf[b * 4 + q]; trailBuf[b * 4 + q] = v; }
      }
    }
    C.tn = tn;
    return C;
  }

  function noteStyle() {
    if (S.noteStyle !== 'solid') return null;
    if (styleCache) return styleCache;
    const pal = PALETTES.find(p => p.id === S.palette) || PALETTES[0];
    let list = pal.custom ? S.custom.slice(0, clamp(S.customN | 0, 1, 4)) : pal.c;
    if (!list.length) list = PALETTES[0].c;
    const colors = new Float32Array(list.length * 3);
    list.forEach((h, i) => {
      const v = parseInt(String(h).replace('#', ''), 16) || 0;
      colors[i * 3] = (v >> 16 & 255) / 255; colors[i * 3 + 1] = (v >> 8 & 255) / 255; colors[i * 3 + 2] = (v & 255) / 255;
    });
    styleCache = { colors, n: list.length, round: MESH[S.mesh] || MESH.rounded, fill: clamp(+S.noteFill, 0, 1), scale: clamp(+S.noteScale || 1, 0.5, 1.5), opacity: clamp(+S.noteOpacity || 1, 0.2, 1) };
    return styleCache;
  }

  // default corver image
  const DEFAULT_COVER = 'https://cdn.discordapp.com/attachments/985414411038642286/1568955605807530025/Untitled332.png?ex=6af1b346&is=6af061c6&hm=86b54c4b05aa39d628c2fdd6fcc5da1a5126c04312d41a5242fa67b774b8ae78&';
  const COVER_PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2c2250"/><stop offset="1" stop-color="#ff3d71"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/><rect x="32" y="32" width="36" height="36" fill="none" stroke="#35d6ff" stroke-width="4"/></svg>');
  const REDUCE = matchMedia('(prefers-reduced-motion: reduce)');
  const S = { ...DEF };

  // load saved settings
  try {
    Object.assign(S, JSON.parse(localStorage.getItem('rw-settings') || '{}'));
  } catch (e) {}

  (function sanitize() {
    const num = (k, lo, hi) => { S[k] = clamp(Number.isFinite(+S[k]) ? +S[k] : DEF[k], lo, hi); };
    const pick = (k, list) => { if (!list.includes(S[k])) S[k] = DEF[k]; };
    const hex = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
    if (S.mesh === 'outline') { S.mesh = 'rounded'; S.noteFill = 0.1; }   // the old Outline mesh is now "inside opacity"
    pick('noteStyle', ['solid', 'legacy']); pick('mesh', ['rounded', 'square', 'circle']);
    pick('palette', PALETTES.map(p => p.id)); pick('lowLat', ['on', 'off']); pick('quality', ['high', 'balanced', 'low', 'potato']);
    pick('cursorShape', ['circle', 'square', 'image']); pick('cursorColorMode', ['note', 'custom']); pick('trailFade', ['scale', 'fade', 'both']);
    if (!Array.isArray(S.custom)) S.custom = DEF.custom.slice();
    S.custom = DEF.custom.map((d, i) => hex(S.custom[i]) ? S.custom[i] : d);
    if (!hex(S.cursorColor)) S.cursorColor = DEF.cursorColor;
    if (typeof S.cursorImage !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(S.cursorImage) || S.cursorImage.length > 900000) S.cursorImage = '';
    num('customN', 1, 4); num('noteScale', 0.5, 1.5); num('noteOpacity', 0.2, 1); num('noteFill', 0, 1);
    num('cursorScale', 0.2, 3); num('cursorSpin', 0, 720); num('trailDetail', 2, 48); num('trailTime', 0.02, 0.5);
    S.trailOn = !!S.trailOn; S.smartTrail = !!S.smartTrail; S.showFps = !!S.showFps;
  })();

  const saveS = () => {
    try {
      localStorage.setItem('rw-settings', JSON.stringify(S));
    } catch (e) {}
  };

  // Playfield Rendering Constants
  const D = 3.4;
  const ZMAX = 46;
  const NOTE = 0.88;
  const CUR = 0.2;
  const CLAMP = 1.45;
  const HPMAX = 5;
  const HP_HIT = 0.35;
  const HP_MISS = 1;
  const LEAD = 2000;
  const COLS = ['255,61,113', '53,214,255'];

  /* ==========================================================================
     Leaderboard
     ========================================================================== */
  let currentPlayer = {
    name: localStorage.getItem('oh-player-name') || '',
    school: localStorage.getItem('oh-player-school') || ''
  };
  
  const REPLAY_TOP = 3;
  const Replays = {
    P: 'rw-replay:',
    IDX: 'rw-replay-idx',
    key(mapId, name, school) { return this.P + mapId + '|' + (String(name) + '|' + String(school)).toLowerCase(); },
    idx() { try { return JSON.parse(localStorage.getItem(this.IDX)) || {}; } catch (e) { return {}; } },
    scoreOf(k) { const v = this.idx()[k]; return v == null ? null : v; },
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    put(k, obj) {
      try {
        localStorage.setItem(k, JSON.stringify(obj));
        const ix = this.idx(); ix[k] = obj.score;
        localStorage.setItem(this.IDX, JSON.stringify(ix));
        return true;
      } catch (e) { return false; }
    },
    // Drop this maps replays of players who are no longer in its top REPLAY_TOP
    prune(mapId, scores) {
      try {
        const keep = new Set(scores.slice(0, REPLAY_TOP).map(s => this.key(mapId, s.name, s.school)));
        const ix = this.idx(), pre = this.P + mapId + '|';
        for (const k of Object.keys(ix)) {
          if (k.startsWith(pre) && !keep.has(k)) { localStorage.removeItem(k); delete ix[k]; }
        }
        localStorage.setItem(this.IDX, JSON.stringify(ix));
      } catch (e) {}
    }
  };

  
  const ReplaysNet = (() => {
    const API = '/api/replays';
    const PENDING = 'rw-replay-pending';
    const mem = new Map();                                 // mapId -> { t, list }
    let flushing = false;
    const rd = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
    const wr = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

    async function call(url, opts = {}) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      try {
        const res = await fetch(url, { ...opts, signal: ctrl.signal });
        let data = null;
        try { data = await res.json(); } catch (e) {}
        if (!res.ok || !data) { const err = new Error((data && data.error) || 'HTTP ' + res.status); err.status = res.status; throw err; }
        return data;
      } finally { clearTimeout(timer); }
    }
    const retryable = err => !err.status || err.status === 404 || err.status >= 500;

    return {
      // [{ name, school, score }] of the replays stored on the server for a map
      async index(mapId, force) {
        const m = mem.get(mapId);
        if (m && !force && Date.now() - m.t < 15000) return m.list;
        try {
          const d = await call(API + '?map=' + encodeURIComponent(mapId));
          mem.set(mapId, { t: Date.now(), list: d.replays || [] });
          this.flush();
          return d.replays || [];
        } catch (e) { return m ? m.list : []; }
      },

      async fetch(ref) {
        const q = '?map=' + encodeURIComponent(ref.mapId) + '&name=' + encodeURIComponent(ref.name) + '&school=' + encodeURIComponent(ref.school || '');
        const d = await call(API + q);
        return d.replay || null;
      },

      async upload(mapId, name, school, replay) {
        const payload = { mapId, name, school, score: replay.score, replay };
        try {
          await call(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
          mem.delete(mapId);
          return true;
        } catch (err) {
          if (retryable(err)) {                            // keep it and try again later
            const q = rd(PENDING, []).filter(p => !(p.mapId === mapId && p.name === name && p.school === school));
            q.push({ mapId, name, school, score: replay.score });
            wr(PENDING, q.slice(-10));
          }
          return false;
        }
      },

      // upload replays that could not be sent earlier
      async flush() {
        if (flushing) return;
        flushing = true;
        try {
          let q = rd(PENDING, []);
          while (q.length) {
            const p = q[0], raw = Replays.get(Replays.key(p.mapId, p.name, p.school));
            if (raw && raw.score === p.score) {
              try { await call(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...p, replay: raw }) }); mem.delete(p.mapId); }
              catch (err) { if (retryable(err)) break; }
            }
            q = q.slice(1);
            wr(PENDING, q);
          }
        } finally { flushing = false; }
      },

      async admin(params) {
        try { return await call(API + '?' + new URLSearchParams(params), { method: 'DELETE', headers: { 'x-admin-key': Leaderboard.adminKey() } }); }
        catch (e) { return null; }
      }
    };
  })();

  const Leaderboard = (() => {
    const API = '/api/scores';
    const CACHE_KEY = 'rw-lb-cache';
    const PENDING_KEY = 'rw-lb-pending';
    const TTL = 15000;
    const mem = new Map(); // mapId -> { t, scores }
    let flushing = false;

    const readLS = (k, d) => {
      try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; }
    };
    const writeLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
    const pkey = e => (e.name + '|' + e.school).toLowerCase();

    const remember = (mapId, scores) => {
      mem.set(mapId, { t: Date.now(), scores });
      const c = readLS(CACHE_KEY, {});
      c[mapId] = scores;
      writeLS(CACHE_KEY, c);
    };

    async function request(url, opts = {}) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(url, { ...opts, signal: ctrl.signal });
        let data = null;
        try { data = await res.json(); } catch (e) {}
        if (!res.ok || !data) {
          const err = new Error((data && data.error) || 'HTTP ' + res.status);
          err.status = res.status;
          throw err;
        }
        return data;
      } finally {
        clearTimeout(timer);
      }
    }

    const post = payload => request(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });

    // Network problems, a missing API (404) and 5xx are worth retrying later
    const retryable = err => !err.status || err.status === 404 || err.status >= 500;

    // merge an entry into a cached list the same way the server does
    function mergeLocal(list, entry) {
      const k = pkey(entry);
      const prev = list.find(e => pkey(e) === k);
      let next = list;
      if (!prev || prev.score < entry.score) {
        next = list.filter(e => pkey(e) !== k).concat(entry);
        next.sort((a, b) => b.score - a.score || b.acc - a.acc);
      }
      return { list: next.slice(0, 50), rank: next.findIndex(e => pkey(e) === k) + 1 };
    }

    return {
      // last known scores for a map or null if never seen any
      peek(mapId) {
        const m = mem.get(mapId);
        if (m) return m.scores;
        return readLS(CACHE_KEY, {})[mapId] || null;
      },

      async get(mapId, force = false) {
        const m = mem.get(mapId);
        if (m && !force && Date.now() - m.t < TTL) return { scores: m.scores, offline: false };
        try {
          const data = await request(API + '?map=' + encodeURIComponent(mapId) + '&limit=10');
          remember(mapId, data.scores || []);
          this.flush();
          return { scores: data.scores || [], offline: false };
        } catch (e) {
          return { scores: this.peek(mapId) || [], offline: true };
        }
      },

      async submit(mapId, entry) {
        const payload = { mapId, ...entry };
        try {
          const data = await post(payload);
          if (data.scores) remember(mapId, data.scores);
          this.flush();
          return data;
        } catch (err) {
          if (!retryable(err)) return { error: err.message };
          const q = readLS(PENDING_KEY, []);
          q.push(payload);
          writeLS(PENDING_KEY, q.slice(-20));
          const local = mergeLocal(this.peek(mapId) || [], { ...entry, ts: Date.now() });
          remember(mapId, local.list);
          return { ranked: true, offline: true, rank: local.rank, scores: local.list };
        }
      },

      // upload scores that were saved while the server was unreachable
      async flush() {
        if (flushing) return;
        flushing = true;
        try {
          let q = readLS(PENDING_KEY, []);
          while (q.length) {
            try {
              await post(q[0]);
            } catch (err) {
              if (retryable(err)) break; // stilll offline, try again later
            }
            q = q.slice(1); // sent or reject for good
            writeLS(PENDING_KEY, q);
          }
        } finally {
          flushing = false;
        }
      },

      adminKey() {
        try { return sessionStorage.getItem('rw-admin-key') || ''; } catch (e) { return ''; }
      },

      async admin(params) {
        const qs = new URLSearchParams(params).toString();
        const data = await request(API + '?' + qs, {
          method: 'DELETE',
          headers: { 'x-admin-key': this.adminKey() }
        });
        mem.clear();
        writeLS(CACHE_KEY, {});
        ReplaysNet.admin(params);                          // the replays of deleted scores gone too
        return data;
      }
    };
  })();

  // Console tools (I know who lookin at ts btw)
  const resolveMapId = x => {
    const lower = String(x).toLowerCase();
    const m = LIB.find(m => m.id === x || m.name.toLowerCase() === lower);
    return m ? m.id : x;
  };
  const adminLog = p => p.then(r => console.log('Done:', r), e => console.warn('Failed:', e.message));

  window.rwLeaderboard = {
    setKey(k) {
      try { sessionStorage.setItem('rw-admin-key', k); } catch (e) {}
      console.log('Admin key saved for this tab.');
    },
    clearMap(map) { return adminLog(Leaderboard.admin({ map: resolveMapId(map) })); },
    deleteName(name, school) {
      const q = { name };
      if (school) q.school = school;
      return adminLog(Leaderboard.admin(q));
    },
    deleteEntry(map, name, school) {
      const q = { map: resolveMapId(map), name };
      if (school) q.school = school;
      return adminLog(Leaderboard.admin(q));
    },
    clearAll() { return adminLog(Leaderboard.admin({ all: 1 })); },
    // kept for backwards compatibility with the old console commands
    clear() { return this.clearAll(); },
    deleteMap(map) { return this.clearMap(map); },
    delete(arg) {
      if (!arg || arg === '--clear') return this.clearAll();
      if (LIB.some(m => m.id === arg || m.name.toLowerCase() === String(arg).toLowerCase())) return this.clearMap(arg);
      return this.deleteName(arg);
    }
  };

  /* ==========================================================================
     Difficulty Overrides Storage
     ========================================================================== */
  const DiffOverrides = {
    getAll() {
      try {
        return JSON.parse(localStorage.getItem('rw-diff-overrides') || '{}');
      } catch (e) {
        return {};
      }
    },
    set(mapId, folder) {
      const store = this.getAll();
      store[mapId] = folder;
      try {
        localStorage.setItem('rw-diff-overrides', JSON.stringify(store));
      } catch (e) {}
    },
    get(mapId) {
      const store = this.getAll();
      return store[mapId] || null;
    }
  };

  /* ==========================================================================
     .sspm v2 Binary Format Parser
     ========================================================================== */
  function parseSSPM(buf) {
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    const td = new TextDecoder();

    if (buf.byteLength < 130 || td.decode(u8.subarray(0, 4)) !== 'SS+m') {
      throw new Error('Not a .sspm file');
    }

    const ver = dv.getUint16(4, true);
    if (ver !== 2) {
      throw new Error('Only .sspm version 2 is supported (this file is version ' + ver + ')');
    }

    const lastMs = dv.getUint32(30, true);
    const diff = dv.getUint8(42);
    const hasAudio = dv.getUint8(45);
    const hasCover = dv.getUint8(46);
    const markerCount = dv.getUint32(38, true);

    const off = [];
    for (let i = 0; i < 10; i++) {
      off.push(Number(dv.getBigUint64(48 + i * 8, true)));
    }

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

    const aOff = off[2];
    const aLen = off[3];
    const dOff = off[6];
    const mOff = off[8];

    // Read marker definitions
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

    // Read map markers/notes
    q = mOff;
    const notes = [];
    for (let i = 0; i < markerCount; i++) {
      const ms = dv.getUint32(q, true);
      q += 4;
      const d = defs[dv.getUint8(q++)];
      if (!d) throw new Error('Corrupt marker data');
      let pos = null;

      for (const ty of d.types) {
        switch (ty) {
          case 1: q += 1; break;
          case 2: q += 2; break;
          case 3: q += 4; break;
          case 4: q += 8; break;
          case 5: q += 4; break;
          case 6: q += 8; break;
          case 7:
            if (dv.getUint8(q++)) {
              pos = [dv.getFloat32(q, true), dv.getFloat32(q + 4, true)];
              q += 8;
            } else {
              pos = [dv.getUint8(q), dv.getUint8(q + 1)];
              q += 2;
            }
            break;
          case 8: case 9: q += 2 + dv.getUint16(q, true); break;
          case 10: case 11: q += 4 + dv.getUint32(q, true); break;
          default: throw new Error('Unknown marker data type ' + ty);
        }
      }
      if (d.nm === 'ssp_note' && pos) {
        notes.push({ ms, x: pos[0], y: pos[1] });
      }
    }

    notes.sort((a, b) => a.ms - b.ms);
    if (!notes.length) throw new Error('This map has no notes');
    if (!hasAudio || !aLen) throw new Error('This map is silent');

    const bytes = u8.subarray(aOff, aOff + aLen);
    const h = td.decode(bytes.subarray(0, 4));
    const mime = h === 'OggS' ? 'audio/ogg' : h === 'RIFF' ? 'audio/wav' : h === 'fLaC' ? 'audio/flac' : 'audio/mpeg';
    const span = Math.max(1, (notes[notes.length - 1].ms - notes[0].ms) / 1000);

    const meta = {
      id: id || name,
      name: name || song || 'Untitled',
      mapper: mappers.join(', ') || 'unknown',
      diff,
      notes: notes.length,
      dur: Math.max(lastMs, notes[notes.length - 1].ms),
      nps: notes.length / span
    };

    // Cover image
    let cover = null;
    const cOff = off[4], cLen = off[5];
    if (hasCover && cLen > 8 && cOff > 0 && cOff + cLen <= buf.byteLength) {
      const cb = u8.subarray(cOff, cOff + cLen);
      const cm = cb[0] === 0x89 && cb[1] === 0x50 ? 'image/png'
        : cb[0] === 0xff && cb[1] === 0xd8 ? 'image/jpeg'
        : cb[0] === 0x52 && cb[1] === 0x49 && cb[8] === 0x57 ? 'image/webp'
        : cb[0] === 0x47 && cb[1] === 0x49 ? 'image/gif' : null;
      if (cm) cover = { bytes: cb, mime: cm };
    }

    return { meta, notes, audio: { bytes, mime }, cover };
  }

  function classify(m) {
    if (m.diff === 1 || m.diff === 2) return m.diff === 1 ? 'easy' : 'hard';
    if (m.diff === 3) return 'hard';
    if (m.diff === 4) return 'insane';
    if (m.diff >= 5) return 'death';
    return m.nps < 3.5 ? 'easy' : m.nps < 6 ? 'hard' : m.nps < 9.5 ? 'insane' : 'death';
  }

  /* ==========================================================================
     Storage Subsystem
     ========================================================================== */
  const Store = (() => {
    let db = null;
    const mem = { meta: new Map(), blob: new Map() };

    const ready = new Promise(res => {
      try {
        const r = indexedDB.open('maps-data', 1);
        r.onupgradeneeded = () => {
          r.result.createObjectStore('meta', { keyPath: 'id' });
          r.result.createObjectStore('blob', { keyPath: 'id' });
        };
        r.onsuccess = () => { db = r.result; res(); };
        r.onerror = r.onblocked = () => res();
      } catch (e) { res(); }
    });

    const tx = (st, mode, fn) => new Promise((res, rej) => {
      if (!db) return rej(new Error('no db'));
      const t = db.transaction(st, mode);
      const rq = fn(t.objectStore(st));
      t.oncomplete = () => res(rq && rq.result);
      t.onerror = t.onabort = () => rej(t.error);
    });

    // a stored blob is valid if no version is requested/stored or the versions match
    const okBlob = (r, ver) => (r && (ver == null || r.ver == null || r.ver === ver)) ? r.data : null;

    return {
      ready,
      async all() {
        await ready;
        let a = [];
        try { a = await tx('meta', 'readonly', s => s.getAll()); } catch (e) {}
        const ids = new Set(a.map(m => m.id));
        for (const m of mem.meta.values()) if (!ids.has(m.id)) a.push(m);
        return a;
      },
      async getBlob(id, ver) {
        await ready;
        const d = okBlob(mem.blob.get(id), ver);
        if (d) return d;
        try {
          return okBlob(await tx('blob', 'readonly', s => s.get(id)), ver);
        } catch (e) { return null; }
      },
      async putBlob(id, data, ver) {
        await ready;
        try {
          await tx('blob', 'readwrite', s => s.put({ id, data, ver }));
          mem.blob.delete(id);
        } catch (e) {
          mem.blob.set(id, { data, ver });
        }
      },
      async put(meta, data) {
        await ready;
        try {
          await tx('blob', 'readwrite', s => s.put({ id: meta.id, data, ver: meta.ver }));
          await tx('meta', 'readwrite', s => s.put(meta));
        } catch (e) {
          mem.meta.set(meta.id, meta);
          mem.blob.set(meta.id, { data, ver: meta.ver });
        }
      },
      async putMeta(meta) {
        await ready;
        if (mem.meta.has(meta.id)) {
          mem.meta.set(meta.id, meta);
          return;
        }
        try { await tx('meta', 'readwrite', s => s.put(meta)); } catch (e) { mem.meta.set(meta.id, meta); }
      },
      async del(id) {
        await ready;
        mem.meta.delete(id);
        mem.blob.delete(id);
        try {
          await tx('meta', 'readwrite', s => s.delete(id));
          await tx('blob', 'readwrite', s => s.delete(id));
        } catch (e) {}
      }
    };
  })();

  let LIB = [];
  async function refreshLib() {
    try { LIB = await Store.all(); } catch (e) { LIB = []; }
    // apply difficulty overrides from local storage
    for (const m of LIB) {
      const savedFolder = DiffOverrides.get(m.id);
      if (savedFolder) m.folder = savedFolder;
    }
    LIB.sort((a, b) => a.name.localeCompare(b.name));
    renderCounts();
    renderLibrary();
  }

  /* ==========================================================================
     Server Maps
     ========================================================================== */
  const mapUrl = en => 'maps/' + en.file.split('/').map(encodeURIComponent).join('/') + (en.ver ? '?v=' + en.ver : '');

  async function fetchManifest() {
    try {
      const res = await fetch('maps-manifest.json', { cache: 'no-cache' });
      if (res.ok) {
        const j = await res.json();
        if (j && Array.isArray(j.maps)) return j.maps;
      }
    } catch (e) {}

    // Fallback for plain dev servers that expose a directory listing at /maps/
    try {
      const res = await fetch('maps/');
      if (!res.ok) return null;
      const text = await res.text();
      const matches = text.match(/href=["']([^"']+\.sspm)["']/gi);
      if (!matches) return null;
      const files = matches.map(m => {
        const raw = m.replace(/href=["']/i, '').replace(/["']$/, '');
        return decodeURIComponent(raw.split('/').pop());
      });
      return [...new Set(files)].map(file => ({ file }));
    } catch (e) {
      return null;
    }
  }

  // url (they include the content hash) that failed to parse
  const BadMaps = {
    key: 'rw-bad-maps',
    list() { try { return JSON.parse(localStorage.getItem(this.key) || '[]'); } catch (e) { return []; } },
    has(url) { return this.list().includes(url); },
    add(url) {
      try { localStorage.setItem(this.key, JSON.stringify([...new Set([...this.list(), url])].slice(-50))); } catch (e) {}
    }
  };

  async function syncServerMaps() {
    const entries = await fetchManifest();
    if (!entries) return;

    const known = new Map(LIB.map(m => [m.id, m]));
    const seen = new Set();
    let changed = false;

    for (const en of entries) {
      if (!en || !en.file) continue;
      const url = mapUrl(en);
      const sig = (en.ver || '') + '|' + (en.folder || '');
      let prev = null;
      try {
        let meta = en.meta ? { ...en.meta, ver: en.ver } : null;

        if (meta) {
          prev = known.get(meta.id) || null;
          if (prev && prev.source === 'server' && prev.sig === sig && prev.remote === url) {
            seen.add(meta.id);
            continue;
          }
        } else {
          // No metadata in the manifest
          prev = LIB.find(m => m.source === 'server' && m.remote === url) || null;
          if (prev) { seen.add(prev.id); continue; }
          if (BadMaps.has(url)) continue;
          const res = await fetch(url);
          if (!res.ok) continue;
          const buf = await res.arrayBuffer();
          try {
            meta = parseSSPM(buf).meta;
          } catch (e) {
            BadMaps.add(url); // dont download a corrupt file
            throw e;
          }
          meta.ver = en.ver;
          await Store.putBlob(meta.id, buf, meta.ver);
          meta.cv = meta.ver;
        }

        meta.source = 'server';
        meta.remote = url;
        meta.sig = sig;
        meta.folder = DiffOverrides.get(meta.id) || en.folder || classify(meta);
        meta.added = prev ? prev.added : Date.now();
        if (prev && prev.ver === meta.ver && prev.cv) meta.cv = prev.cv; // blob already cached

        seen.add(meta.id);
        await Store.putMeta(meta);
        ENT.delete(meta.id);
        changed = true;
      } catch (e) {
        if (prev) seen.add(prev.id); // dont drop a working map because of a transient error
        console.warn('Skipping map ' + en.file + ':', e.message);
      }
    }

    // Maps that were removed from the server folder disappear from the library.
    for (const m of LIB) {
      if (m.source === 'server' && !seen.has(m.id)) {
        await Store.del(m.id);
        ENT.delete(m.id);
        changed = true;
      }
    }

    if (changed) await refreshLib();
  }

  // Download one map (or read it from the cache) concurrent callers share one request
  const FETCHING = new Map();
  function fetchBlob(meta) {
    if (FETCHING.has(meta.id)) return FETCHING.get(meta.id);
    const p = (async () => {
      const cached = await Store.getBlob(meta.id, meta.ver);
      if (cached) return cached;
      if (!meta.remote) return null;
      const res = await fetch(meta.remote);
      if (!res.ok) throw new Error('Could not download map (HTTP ' + res.status + ')');
      const buf = await res.arrayBuffer();
      await Store.putBlob(meta.id, buf, meta.ver);
      meta.cv = meta.ver;
      Store.putMeta(meta);
      return buf;
    })();
    FETCHING.set(meta.id, p);
    p.finally(() => FETCHING.delete(meta.id)).catch(() => {});
    return p;
  }

  // Quietly download every server map in the background so previews start instantly.
  async function prefetchMaps() {
    if (navigator.connection && navigator.connection.saveData) return;
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
    for (const m of LIB.slice()) {
      if (!m.remote || m.cv === m.ver) continue;
      try { await fetchBlob(m); } catch (e) {}
      await new Promise(r => setTimeout(r, 200));
    }
  }

  function renderCounts() {
    for (const f of FOLDERS) {
      const n = LIB.filter(m => m.folder === f.key).length;
      $('#cnt-' + f.key).textContent = n + (n === 1 ? ' map' : ' maps');
    }
  }

  async function addFiles(files) {
    let last = null;
    for (const f of files) {
      if (!/\.sspm$/i.test(f.name)) {
        toast(f.name + ' is not a .sspm file.');
        continue;
      }
      try {
        const buf = await f.arrayBuffer();
        const p = parseSSPM(buf);
        const meta = p.meta;

        const ex = LIB.find(m => m.id === meta.id);
        const savedFolder = DiffOverrides.get(meta.id);
        meta.folder = savedFolder || (ex ? ex.folder : classify(meta));
        meta.added = Date.now();

        await Store.put(meta, buf);
        ENT.delete(meta.id);
        LIB = LIB.filter(m => m.id !== meta.id);
        LIB.push(meta);
        last = meta;

        toast('Added "' + meta.name + '" to ' + (meta.folder === 'death' ? '助けて' : FOLDER[meta.folder].label));
      } catch (e) {
        toast(f.name + ': ' + e.message);
      }
    }
    await refreshLib();
    return last;
  }

  /* ==========================================================================
     Map Cache
     ========================================================================== */
  const ENT = new Map();
  // Object URL of the map's cover image
  function coverUrlOf(e) {
    if (!e || !e.cover) return null;
    if (!e.coverUrl) e.coverUrl = URL.createObjectURL(new Blob([e.cover.bytes], { type: e.cover.mime }));
    return e.coverUrl;
  }

  function setCover(img, e) {
    if (!e) { img.hidden = true; img.removeAttribute('src'); return; }
    const u = coverUrlOf(e) || DEFAULT_COVER;
    if (img.getAttribute('src') !== u) img.src = u;
    if (!img.onerror) img.onerror = () => { if (img.getAttribute('src') !== COVER_PLACEHOLDER) img.src = COVER_PLACEHOLDER; };
    img.hidden = false;
  }

  async function loadEntry(meta) {
    if (ENT.has(meta.id)) {
      const e = ENT.get(meta.id);
      ENT.delete(meta.id);
      ENT.set(meta.id, e);
      return e;
    }

    const buf = await fetchBlob(meta);
    if (!buf) throw new Error('Map data is missing');

    const p = parseSSPM(buf);
    const i = Math.floor(p.notes.length * 0.35);
    const e = {
      meta,
      notes: p.notes,
      audio: p.audio,
      cover: p.cover,
      coverUrl: null,
      url: null,
      decoded: null,
      pStart: Math.max(0, p.notes[i].ms - 1500) / 1000
    };

    ENT.set(meta.id, e);
    while (ENT.size > 3) {
      const k = ENT.keys().next().value;
      const o = ENT.get(k);
      if (o.url) URL.revokeObjectURL(o.url);
      if (o.coverUrl) URL.revokeObjectURL(o.coverUrl);
      ENT.delete(k);
    }
    return e;
  }

  /* ==========================================================================
     Audio Processing Subsystem
     ========================================================================== */
  let AC = null, master, analyser, sfx, previewEl, previewGain, freq = new Uint8Array(512), bass = 0;
  let kickEnv = 0, kickPrev = 0, kickAvg = 0.2, kickLast = 0;
  // what the renderers actually show
  let kickVis = 0, bassVis = 0;
  function stepVis(dt) {
    const kt = kickEnv * KICK_STRENGTH;
    kickVis += (kt - kickVis) * (1 - Math.exp(-dt / (kt > kickVis ? 45 : 170)));
    bassVis += (bass - bassVis) * (1 - Math.exp(-dt / 90));
  }

  function initAudio() {
    if (AC) return;
    AC = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    makeBlips();

    master = AC.createGain();
    master.gain.value = S.vol;

    analyser = AC.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.78;

    master.connect(analyser);
    analyser.connect(AC.destination);

    sfx = AC.createGain();
    sfx.gain.value = S.sfx;
    sfx.connect(AC.destination);

    previewEl = new Audio();
    previewEl.preload = 'auto';

    const node = AC.createMediaElementSource(previewEl);
    previewGain = AC.createGain();
    previewGain.gain.value = 0;
    node.connect(previewGain);
    previewGain.connect(master);
  }

  function sampleAudio() {
    if (!analyser) {
      bass *= 0.9;
      return;
    }
    analyser.getByteFrequencyData(freq);
    let b = 0;
    for (let i = 0; i < 5; i++) b += freq[i];
    bass = lerp(bass, b / 5 / 255, 0.5);

    // Live kick detector: a sudden rise of low-frequency energy above its recent average
    const low = (freq[1] + freq[2] + freq[3]) / 3 / 255;
    const now = performance.now();
    const exact = screen === 'game' && g && g.kicks;       // in a song the exact kick timestamps drive the effect
    if (!exact && low > 0.45 && low - kickPrev > 0.06 && low > kickAvg * 1.25 && now - kickLast > 150) {
      kickEnv = 1;
      kickLast = now;
    }
    kickAvg = lerp(kickAvg, low, 0.04);
    kickPrev = low;
  }

  // Kick detection
  function detectKicks(buf) {
    const sr = buf.sampleRate, c0 = buf.getChannelData(0);
    const c1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : c0;
    const hop = Math.max(1, Math.floor(sr * 0.01));          // 10 ms frames
    const n = Math.floor(buf.length / hop);
    const a = 1 - Math.exp(-2 * Math.PI * 120 / sr);          // ~120 Hz low-pass (two poles)
    let y1 = 0, y2 = 0;
    const env = new Float32Array(n);
    for (let h = 0; h < n; h++) {
      let e = 0;
      for (let i = h * hop, end = i + hop; i < end; i++) {
        y1 += a * ((c0[i] + c1[i]) * 0.5 - y1);
        y2 += a * (y1 - y2);
        e += y2 * y2;
      }
      env[h] = Math.sqrt(e / hop);
    }
    const sorted = Float32Array.from(env).sort();
    const loud = sorted[Math.floor(n * 0.95)] || 0;
    const times = [], str = [];
    let avg = 0, lastH = -100;
    for (let h = 1; h < n - 1; h++) {
      avg += (env[h] - avg) * 0.02;                           // ~0.5 s running mean
      const v = env[h];
      if (v > env[h - 1] && v >= env[h + 1] && v > avg * 1.5 && v > loud * 0.22 && h - lastH >= 16) {
        times.push(h * 10);
        str.push(clamp((v / Math.max(avg, 1e-6) - 1) / 2.5, 0.35, 1));
        lastH = h;
      }
    }
    return { t: Float32Array.from(times), s: Float32Array.from(str), n: times.length, lo: 0 };
  }

  // Hit / miss sounds
  const BLIPS = {};
  function makeBlips() {
    const mk = (type, f0, f1, dur, vol) => {
      const n = Math.round(AC.sampleRate * dur), buf = AC.createBuffer(1, n, AC.sampleRate), d = buf.getChannelData(0);
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const u = i / n, f = f0 * Math.pow(f1 / f0, Math.min(1, u * dur / (type === 'tri' ? 0.05 : 0.14)));
        ph += f / AC.sampleRate;
        const w = type === 'tri' ? 2 * Math.abs(2 * (ph % 1) - 1) - 1 : 2 * (ph % 1) - 1;
        d[i] = w * vol * Math.pow(0.001 / vol, u);
      }
      return buf;
    };
    BLIPS.hit = mk('tri', 1500, 700, 0.08, 0.5);
    BLIPS.miss = mk('saw', 150, 70, 0.17, 0.35);
  }

  function blip(kind) {
    if (!AC || S.sfx <= 0.001 || !BLIPS.hit) return;
    const s = AC.createBufferSource();
    s.buffer = kind === 'hit' ? BLIPS.hit : BLIPS.miss;
    s.connect(sfx);
    s.start();
  }

  /* ==========================================================================
     Lobby Preview Subsystem
     ========================================================================== */
  let pvEntry = null, pvLast = -1, pvPerf = 0;

  function startPreview(e) {
    if (!AC) return;
    if (!e.url) e.url = URL.createObjectURL(new Blob([e.audio.bytes], { type: e.audio.mime }));

    pvEntry = e;
    pvLast = -1;

    previewEl.onloadedmetadata = () => {
      try { previewEl.currentTime = e.pStart; } catch (_) {}
      previewEl.play().catch(() => {});
      previewGain.gain.cancelScheduledValues(AC.currentTime);
      previewGain.gain.setTargetAtTime(0.9, AC.currentTime, 0.12);
    };
    previewEl.src = e.url;
  }

  function fadePreview() {
    if (!AC) return;
    previewGain.gain.cancelScheduledValues(AC.currentTime);
    previewGain.gain.setTargetAtTime(0, AC.currentTime, 0.07);
    const tok = hovTok;
    setTimeout(() => {
      if (tok === hovTok || !hov) {
        try { previewEl.pause(); } catch (e) {}
      }
    }, 350);
  }

  function previewTime() {
    const now = performance.now();
    const ct = previewEl.currentTime;
    if (ct !== pvLast) {
      pvLast = ct;
      pvPerf = now;
    }
    if (pvEntry && ct > pvEntry.pStart + 20) {
      previewEl.currentTime = pvEntry.pStart;
    }
    return ct * 1000 + Math.min(80, now - pvPerf);
  }

  /* ==========================================================================
     3D Canvas Engine & Scene Renderer
     ========================================================================== */
  const lowerBound = (a, ms) => {
    let l = 0, h = a.length;
    while (l < h) {
      const m = (l + h) >> 1;
      if (a[m].ms < ms) l = m + 1;
      else h = m;
    }
    return l;
  };

  const CSTR = ['rgb(255,61,113)', 'rgb(53,214,255)'];
  const GRAYC = 'rgb(150,150,170)';
  const RAILC = 'rgb(130,100,255)';
  const CYAN = 'rgb(53,214,255)';
  const LAYERS = new WeakMap();

  function layerFor(c, W, H, s0) {
    const cvs = c.canvas;
    const key = cvs.width + 'x' + cvs.height;
    let L = LAYERS.get(cvs);

    if (!L || L.key !== key) {
      const lc = L ? L.cv : document.createElement('canvas');
      lc.width = cvs.width;
      lc.height = cvs.height;

      const x = lc.getContext('2d');
      x.setTransform(cvs.width / W, 0, 0, cvs.height / H, 0, 0);

      const bg = x.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
      bg.addColorStop(0, 'rgb(24,12,52)');
      bg.addColorStop(1, '#06040d');
      x.fillStyle = bg;
      x.fillRect(0, 0, W, H);

      x.strokeStyle = 'rgba(200,180,255,.17)';
      x.lineWidth = 1;
      for (let gy = -1; gy <= 1; gy++) {
        for (let gx = -1; gx <= 1; gx++) {
          x.strokeRect(W / 2 + gx * s0 - 0.46 * s0, H / 2 + gy * s0 - 0.46 * s0, 0.92 * s0, 0.92 * s0);
        }
      }
      L = { cv: lc, key };
      LAYERS.set(cvs, L);
    }
    return L.cv;
  }

  let _px = 0, _py = 0, _s = 1;
  function pr(o, x, y, z) {
    const s = o.F / (z + D);
    const sh = o.s0 - s;
    _s = s;
    _px = o.cx + x * s + o.camX * sh;
    _py = o.cy + y * s + o.camY * sh;
  }

  const RAIL = [
    [-2.7, -2.7], [2.7, -2.7], [2.7, 2.7], [-2.7, 2.7],
    [0, -2.7], [2.7, 0], [0, 2.7], [-2.7, 0]
  ];
  const RZ = [0, 12, 26, ZMAX];

  function drawScene(c, W, H, o) {
    const s0 = Math.min(H * 0.17, W * 0.13);
    o.s0 = s0;
    o.F = s0 * D;
    o.cx = W / 2;
    o.cy = H * 0.5;

    const cm = o.cam || { x: 0, y: 0 };
    const cu = o.cursor || { x: 0, y: 0 };
    const bs = o.bass || 0;
    const t = o.t;
    const vz = ZMAX / o.approach;
    const R = 2.7;

    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(layerFor(c, W, H, s0), 0, 0);
    c.restore();

    if (bs > 0.03) {
      c.globalAlpha = Math.min(0.22, bs * 0.25);
      c.fillStyle = '#6a3df0';
      c.fillRect(0, 0, W, H);
    }

    o.camX = cm.x;
    o.camY = cm.y;
    c.strokeStyle = RAILC;
    c.lineWidth = 1;

    // Draw tunnel rail lines
    for (let k = 0; k < 3; k++) {
      c.globalAlpha = Math.min(1, (k === 0 ? 0.3 : k === 1 ? 0.16 : 0.07) + bs * (k === 0 ? 0.2 : 0.1));
      c.beginPath();
      for (let j = 0; j < 8; j++) {
        const p = RAIL[j];
        pr(o, p[0], p[1], RZ[k]);
        c.moveTo(_px, _py);
        pr(o, p[0], p[1], RZ[k + 1]);
        c.lineTo(_px, _py);
      }
      c.stroke();
    }

    if (!o.lowFx) {
      const sp = 7;
      const ph = ((t / 1000) * (ZMAX / (o.approach / 1000)) * 0.35) % sp;
      for (let k = 0; k < 8; k++) {
        const z = k * sp - ph;
        if (z < 0) continue;
        pr(o, 0, 0, z);
        c.globalAlpha = (1 - z / ZMAX) * (0.28 + bs * 0.3);
        c.strokeRect(_px - R * _s, _py - R * _s, 2 * R * _s, 2 * R * _s);
      }
    }

    c.lineWidth = 2;
    c.strokeStyle = 'rgb(210,190,255)';
    c.globalAlpha = Math.min(1, 0.45 + bs * 0.35);
    c.strokeRect(o.cx - 1.5 * s0, o.cy - 1.5 * s0, 3 * s0, 3 * s0);
    c.globalAlpha = 1;

    o.camX = 0;
    o.camY = 0;

    // Draw Note Blocks
    const N = o.notes;
    if (N && N.length) {
      const lo = lowerBound(N, t - 150);
      const hi = Math.min(N.length - 1, lowerBound(N, t + o.approach + 10));
      c.lineJoin = 'round';

      for (let i = hi; i >= lo; i--) {
        const n = N[i];
        const dt = n.ms - t;
        const z = dt * vz;
        const st = o.states ? o.states[i] : (dt <= 0 ? 1 : 0);
        const x = n.x - 1;
        const y = n.y - 1;
        let cs = CSTR[i & 1];

        if (st === 1) {
          const age = t - (o.hitAt ? o.hitAt[i] : n.ms);
          if (age >= 0 && age < 110) {
            const u = 1 - age / 110;
            pr(o, x, y, 0);
            const hh = NOTE / 2 * _s;
            c.fillStyle = cs;
            c.strokeStyle = cs;
            c.globalAlpha = u * 0.35;
            c.fillRect(_px - hh, _py - hh, 2 * hh, 2 * hh);
            c.globalAlpha = u;
            c.lineWidth = 2.5;
            c.strokeRect(_px - hh, _py - hh, 2 * hh, 2 * hh);
          }
          continue;
        }

        if (z > ZMAX) continue;
        let a = Math.min(1, (ZMAX - z) / 14);

        if (st === 2) {
          a *= Math.max(0, 1 + z / 2.4);
          if (a <= 0.01) continue;
          cs = GRAYC;
        }

        pr(o, x, y, z);
        const fx = _px, fy = _py, fh = NOTE / 2 * _s, fs = _s;
        pr(o, x, y, z + 0.45);
        const bx = _px, by = _py, bh = NOTE / 2 * _s;

        c.strokeStyle = cs;
        c.fillStyle = cs;
        c.lineWidth = 1.2;

        c.globalAlpha = a * 0.35;
        c.strokeRect(bx - bh, by - bh, 2 * bh, 2 * bh);
        c.globalAlpha = a * 0.3;
        c.beginPath();
        c.moveTo(fx - fh, fy - fh); c.lineTo(bx - bh, by - bh);
        c.moveTo(fx + fh, fy - fh); c.lineTo(bx + bh, by - bh);
        c.moveTo(fx + fh, fy + fh); c.lineTo(bx + bh, by + bh);
        c.moveTo(fx - fh, fy + fh); c.lineTo(bx - bh, by + bh);
        c.stroke();

        c.globalAlpha = a * 0.2;
        c.fillRect(fx - fh, fy - fh, 2 * fh, 2 * fh);

        const lw = Math.max(1.5, fs * 0.06);
        if (fs > s0 * 0.25 && !o.lowFx) {
          c.globalAlpha = a * 0.16;
          c.lineWidth = lw * 4;
          c.strokeRect(fx - fh, fy - fh, 2 * fh, 2 * fh);
        }
        c.globalAlpha = a;
        c.lineWidth = lw;
        c.strokeRect(fx - fh, fy - fh, 2 * fh, 2 * fh);
      }
      c.globalAlpha = 1;
    }

    // Draw Cursor & Motion Trail
    if (o.cursor) {
      const tr = o.trail;
      if (tr) {
        c.fillStyle = CYAN;
        for (let i = 0; i < tr.length; i++) {
          const u = (i + 1) / tr.length;
          pr(o, tr[i].x, tr[i].y, 0);
          const hh = CUR / 2 * (0.5 + u * 0.5) * _s;
          c.globalAlpha = u * 0.22;
          c.fillRect(_px - hh, _py - hh, 2 * hh, 2 * hh);
        }
      }
      pr(o, cu.x, cu.y, 0);
      const hh = CUR / 2 * _s;
      c.strokeStyle = CYAN;
      c.lineWidth = 7;
      c.globalAlpha = 0.25;
      c.strokeRect(_px - hh, _py - hh, 2 * hh, 2 * hh);
      c.globalAlpha = 1;
      c.fillStyle = '#fff';
      c.fillRect(_px - hh, _py - hh, 2 * hh, 2 * hh);
      c.lineWidth = 2;
      c.strokeRect(_px - hh, _py - hh, 2 * hh, 2 * hh);
    }
    c.globalAlpha = 1;
  }

  function autoCursor(N, t) {
    const i = lowerBound(N, t + 1);
    if (i >= N.length) return { x: N[N.length - 1].x - 1, y: N[N.length - 1].y - 1 };
    const nx = N[i];
    const pv = i > 0 ? N[i - 1] : { ms: nx.ms - 600, x: 1, y: 1 };
    let u = clamp((t - pv.ms) / Math.max(1, nx.ms - pv.ms) * 1.12, 0, 1);
    u = u * u * (3 - 2 * u);
    return { x: lerp(pv.x - 1, nx.x - 1, u), y: lerp(pv.y - 1, nx.y - 1, u) };
  }

  function fitCanvas(cv, dpr) {
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (!w || !h) return null;
    const W = Math.round(w * dpr);
    const H = Math.round(h * dpr);
    if (cv.width !== W || cv.height !== H) {
      cv.width = W;
      cv.height = H;
    }
    return [w, h];
  }

  /* ==========================================================================
     Lobby Controllers & Card Leaderboard Hover Preview
     ========================================================================== */
  let screen = 'splash', hov = null, hovTok = 0;
  const lastPick = {};
  const bgC = $('#bg'), bgX = bgC.getContext('2d');
  const miniC = $('#mini'), miniX = miniC.getContext('2d');
  const vizC = $('#viz'), vizX = vizC.getContext('2d');

  function renderCard() {
    const f = hov && FOLDER[hov.key];
    $('#stage').style.setProperty('--fc', f ? f.color : 'var(--dim)');
    $('#cardFolder').textContent = f ? (f.key === 'death' ? '助けて maps' : f.label + ' maps') : 'Lobby';
    const chips = $('#cardChips');
    chips.innerHTML = '';
    const lbBox = $('#cardLeaderboard');

    if (!hov) {
      $('#cardTitle').textContent = 'Hover a difficulty';
      $('#cardSub').textContent = LIB.length
        ? 'Each hover picks a map from that difficulty and plays a preview.'
        : 'Library is empty. Drop a .sspm file to add maps.';
      lbBox.innerHTML = '';
    } else if (!hov.meta) {
      $('#cardTitle').textContent = 'No maps here yet';
      $('#cardSub').textContent = 'Drop a .sspm file on the page to populate this category.';
      lbBox.innerHTML = '';
    } else {
      const m = hov.meta;
      $('#cardTitle').textContent = m.name;
      $('#cardSub').textContent = 'Mapped by ' + m.mapper + '.';
      for (const t of [fmtTime(m.dur), fmt(m.notes) + ' notes', m.nps.toFixed(1) + ' notes/s']) {
        chips.insertAdjacentHTML('beforeend', '<li>' + esc(t) + '</li>');
      }

      // Hover leaderboard
      paintCardBoard(Leaderboard.peek(m.id));
      Leaderboard.get(m.id).then(r => {
        if (hov && hov.meta && hov.meta.id === m.id) paintCardBoard(r.scores);
      });
    }
    setCover($('#cardCover'), hov && hov.entry);
    $('#liveTag').textContent = hov && hov.meta ? (hov.entry ? 'PREVIEW' : 'LOADING…') : '';
  }

  function paintCardBoard(scores) {
    const box = $('#cardLeaderboard');
    if (scores == null) {
      box.innerHTML = '<div class="card-lb-title">LOADING SCORES…</div>';
    } else if (!scores.length) {
      box.innerHTML = '<div class="card-lb-title">NO HIGH SCORES YET</div>';
    } else {
      let html = '<div class="card-lb-title">TOP PLAYERS</div><ol class="card-lb-list">';
      for (const s of scores.slice(0, 3)) {
        html += `<li><b>${esc(s.name)}</b> (${esc(s.school)}) - <span>${fmt(s.score)}</span></li>`;
      }
      box.innerHTML = html + '</ol>';
    }
  }

  function hoverFolder(key) {
    const tok = ++hovTok;
    const list = LIB.filter(m => m.folder === key);
    if (!list.length) {
      hov = { key, meta: null, entry: null };
      renderCard();
      if (AC) fadePreview();
      return;
    }
    let pool = list;
    if (list.length > 1 && lastPick[key]) pool = list.filter(m => m.id !== lastPick[key]);
    const meta = pool[Math.random() * pool.length | 0];
    lastPick[key] = meta.id;

    hov = { key, meta, entry: null };
    renderCard();

    loadEntry(meta).then(e => {
      if (tok !== hovTok) return;
      hov.entry = e;
      $('#liveTag').textContent = 'PREVIEW';
      setCover($('#cardCover'), e);
      startPreview(e);
      setTimeout(() => {
        if (tok === hovTok) decode(e).catch(() => {});
      }, 600);
    }).catch(err => toast(err.message));
  }

  function unhover() {
    hovTok++;
    hov = null;
    renderCard();
    fadePreview();
  }

  document.querySelectorAll('.diff').forEach(b => {
    const k = b.dataset.f;
    b.addEventListener('pointerenter', () => hoverFolder(k));
    b.addEventListener('focus', () => { if (!hov || hov.key !== k) hoverFolder(k); });
    b.addEventListener('pointerleave', unhover);
    b.addEventListener('blur', unhover);
    b.addEventListener('click', () => {
      if (!hov || hov.key !== k) hoverFolder(k);
      if (hov && hov.meta) promptPlayerAndStart(hov.meta);
      else toast('No maps with this difficulty yet.');
    });
  });

  function drawViz() {
    const sz = fitCanvas(vizC, Math.min(qCap(), devicePixelRatio || 1));
    if (!sz) return;
    const [w, h] = sz, dpr = vizC.width / w;
    vizX.setTransform(dpr, 0, 0, dpr, 0, 0);
    vizX.clearRect(0, 0, w, h);

    const col = hov ? FOLDER[hov.key].color : '#4a3f7a';
    const n = Math.max(24, Math.min(64, Math.floor(w / 9)));
    const bw = w / n;
    const active = hov && hov.meta && AC;

    for (let i = 0; i < n; i++) {
      const idx = Math.floor(Math.pow(i / n, 1.7) * 230) + 1;
      const v = active ? freq[idx] / 255 : 0;
      const bh = Math.max(2, Math.pow(v, 1.25) * h);
      vizX.fillStyle = col;
      vizX.globalAlpha = active ? 0.35 + v * 0.65 : 0.3;
      vizX.fillRect(i * bw + 1, h - bh, Math.max(1, bw - 2), bh);
    }
    vizX.globalAlpha = 1;
  }

  function drawMini() {
    const sz = fitCanvas(miniC, Math.min(qCap(), devicePixelRatio || 1));
    if (!sz) return;
    const [w, h] = sz, dpr = miniC.width / w;
    miniX.setTransform(dpr, 0, 0, dpr, 0, 0);
    const e = hov && hov.entry;

    if (e && previewEl && !previewEl.paused) {
      const t = previewTime();
      drawScene(miniX, w, h, {
        t,
        notes: e.notes,
        approach: S.approach,
        bass: Math.max(bassVis, kickVis),
        cursor: autoCursor(e.notes, t),
        trail: null,
        lowFx: true
      });
    } else {
      drawScene(miniX, w, h, {
        t: performance.now(),
        notes: null,
        approach: S.approach,
        bass: 0,
        lowFx: true
      });
    }
  }

  function drawBg() {
    const dpr = 0.6, w = innerWidth, h = innerHeight;     // soft background: lower resolution is invisible, and much cheaper
    if (bgC.width !== Math.round(w * dpr) || bgC.height !== Math.round(h * dpr)) {
      bgC.width = Math.round(w * dpr);
      bgC.height = Math.round(h * dpr);
    }
    bgX.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawScene(bgX, w, h, {
      t: performance.now(),
      notes: null,
      approach: 1400,
      bass: Math.max(bassVis, kickVis),
      lowFx: lowFxOn()
    });
  }

  /* ==========================================================================
     Open House Player Modal Prompt
     ========================================================================== */
  let pendingMetaToStart = null;

  function promptPlayerAndStart(meta) {
    pendingMetaToStart = meta;
    $('#pName').value = currentPlayer.name;
    $('#pSchool').value = currentPlayer.school;
    $('#playerModal').hidden = false;
    setTimeout(() => ($('#pName').value ? $('#pSchool') : $('#pName')).focus(), 0);
  }

  for (const sel of ['#pName', '#pSchool']) {
    $(sel).addEventListener('keydown', e => {
      if (e.key === 'Enter') $('#btnStartGame').click();
      else if (e.key === 'Escape') $('#btnCancelPlayer').click();
    });
  }

  $('#btnStartGame').onclick = () => {
    const name = $('#pName').value.trim();
    const school = $('#pSchool').value.trim();
    if (!name || !school) {
      toast('Please enter both Name and School!');
      return;
    }
    currentPlayer.name = name;
    currentPlayer.school = school;
    localStorage.setItem('oh-player-name', name);
    localStorage.setItem('oh-player-school', school);

    $('#playerModal').hidden = true;
    if (pendingMetaToStart) startGame(pendingMetaToStart);
  };

  $('#btnCancelPlayer').onclick = () => {
    $('#playerModal').hidden = true;
    pendingMetaToStart = null;
  };

  /* ==========================================================================
     Main Game Engine & Loop
     ========================================================================== */
  const cv = $('#game');
  const GL = window.PulseGL ? window.PulseGL.create(cv, { desync: S.lowLat === 'on' }) : null;   // null => canvas 2D fallback
  const cx = GL ? null : cv.getContext('2d');
  let hudC = null, hudX = null, hudDpr = 1;
  if (GL) {
    hudC = document.createElement('canvas');
    hudC.id = 'hud';
    hudC.hidden = true;
    hudC.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1';
    cv.after(hudC);
    hudX = hudC.getContext('2d');
  }
  let g = null, gW = 0, gH = 0, gDpr = 1;

  // Adaptive resolution
  const dyn = { s: 1, dts: new Float32Array(180), i: 0, n: 0, lastChange: 0, upWait: 4000, calm: 0 };
  function adaptRes(dt) {
    if (S.quality === 'potato' || !GL) return;
    dyn.dts[dyn.i] = dt; dyn.i = (dyn.i + 1) % 180; if (dyn.n < 180) dyn.n++;
    if (dyn.n < 60 || (dyn.i % 30)) return;
    const a = Array.from(dyn.dts.subarray(0, dyn.n)).sort((x, y) => x - y);
    const ref = clamp(a[Math.floor(a.length * 0.1)], 6.5, 16.9);   // display refresh interval
    let avg = 0; for (let k = 0; k < 60; k++) avg += dyn.dts[(dyn.i - 1 - k + 180) % 180]; avg /= 60;
    const now = performance.now();
    if (avg > ref * 1.35 && dyn.s > 0.55 && now - dyn.lastChange > 1200) {
      if (dyn.lastUp && now - dyn.lastUp < 8000) dyn.upWait = Math.min(60000, dyn.upWait * 2);  // went back up too early
      dyn.s = Math.max(0.55, dyn.s * 0.85); dyn.lastChange = now; dyn.calm = 0; dyn.n = 0;
      sizeGame();
    } else if (avg < ref * 1.12 && dyn.s < 1) {
      dyn.calm += 30;
      if (dyn.calm * 16.7 > dyn.upWait && now - dyn.lastChange > 3000) {
        dyn.s = Math.min(1, dyn.s * 1.1); dyn.lastChange = dyn.lastUp = now; dyn.calm = 0; dyn.n = 0;
        sizeGame();
      }
    } else dyn.calm = 0;
  }

  function sizeGame() {
    gDpr = Math.min(qCap(), devicePixelRatio || 1) * (GL ? dyn.s : 1);
    gW = innerWidth;
    gH = innerHeight;
    if (GL) {
      GL.resize(gW, gH, gDpr);
      hudDpr = Math.min(devicePixelRatio || 1, S.quality === 'potato' ? 1 : 1.5);
      hudC.width = Math.round(gW * hudDpr);
      hudC.height = Math.round(gH * hudDpr);
    } else {
      cv.width = Math.round(gW * gDpr);
      cv.height = Math.round(gH * gDpr);
    }
  }

  addEventListener('resize', () => { if (screen === 'game') sizeGame(); });

  function requestLock() {
    try {
      const r = cv.requestPointerLock({ unadjustedMovement: true });
      if (r && r.catch) r.catch(() => {
        try {
          const r2 = cv.requestPointerLock();
          if (r2 && r2.catch) r2.catch(() => {});
        } catch (e) {}
      });
    } catch (e) {
      try { cv.requestPointerLock(); } catch (e2) {}
    }
  }

  function showScreen(s) {
    screen = s;
    $('#lobby').hidden = s !== 'lobby';
    cv.hidden = s !== 'game';
    if (hudC) hudC.hidden = s !== 'game';
    $('#bg').hidden = s === 'game';
    if (s === 'game') sizeGame();
  }

  async function decode(e) {
    if (!e.decoded) {
      for (const o of ENT.values()) if (o !== e) o.decoded = null;
      e.decoded = AC.decodeAudioData(e.audio.bytes.slice().buffer).then(b => { try { e.kicks = detectKicks(b); } catch (err) { e.kicks = null; } return b; });
      e.decoded.catch(() => { e.decoded = null; });
    }
    return e.decoded;
  }

  function setLoading(on, name) {
    $('#loading').hidden = !on;
    if (on) $('#loadName').textContent = name || '';
  }

  async function startGame(meta, replayId) {
    initAudio();
    const resume = AC.resume();
    clearInterval(backTimer);
    $('#results').hidden = true;
    $('#pause').hidden = true;

    showScreen('game');
    if (cx) {
      cx.setTransform(1, 0, 0, 1, 0, 0);
      cx.fillStyle = '#06040d';
      cx.fillRect(0, 0, cv.width, cv.height);
    }

    $('#leaderboardModal').hidden = true;
    if (S.mouse !== 'free' && !replayId) requestLock();
    hovTok++;
    fadePreview();
    setLoading(true, meta.name);

    try {
      const rp = replayId ? await unpackReplay(replayId) : null;
      const e = await loadEntry(meta);
      const buf = await decode(e);
      await resume;
      beginGame(e, buf, rp);
    } catch (err) {
      toast('Could not load map: ' + err.message);
      toLobby();
    }
    setLoading(false);
  }

  function beginGame(e, buf, rp) {
    dyn.s = 1; dyn.n = 0; dyn.i = 0; dyn.calm = 0; dyn.upWait = 4000; dyn.lastUp = 0;
    const N = e.notes.length;
    g = {
      entry: e,
      meta: e.meta,
      notes: e.notes,
      N,
      states: new Uint8Array(N),
      hitAt: new Float32Array(N),
      lo: 0,
      score: 0,
      combo: 0,
      maxCombo: 0,
      hits: 0,
      misses: 0,
      hp: HPMAX,
      cur: { x: 0, y: 0 },
      trail: [],
      paused: false,
      pausedT: 0,
      over: false,
      events: [],
      lastMiss: -1e9,
      lastHit: -1e9,
      approach: S.approach,                               // replays follow the viewers own settings
      replay: rp || null,
      recC: [], recN: 0,
      buf,
      startCtx: 0,
      src: null,
      gain: null,
      countdown: 0,
      cdStart: 0,
      cam: { x: 0, y: 0 },
      lastF: performance.now(),
      lastMs: e.notes[N - 1].ms,
      auto: !rp && /^#auto(-debug)?$/.test(location.hash),
      hadLock: false,
      s0: 100,
      lockWatch: performance.now(),
      kicks: e.kicks ? { ...e.kicks, lo: 0 } : null,
      hT: new Float64Array(HN), hX: new Float32Array(HN), hY: new Float32Array(HN), hI: 0, hC: 0
    };
    pushHist(performance.now(), 0, 0);
    playFrom(-LEAD);
  }

  function playFrom(tMs) {
    const now = AC.currentTime;
    g.startCtx = now - tMs / 1000;
    const src = AC.createBufferSource();
    src.buffer = g.buf;

    const gn = AC.createGain();
    src.connect(gn);
    gn.connect(master);

    if (tMs < 0) src.start(g.startCtx, 0);
    else src.start(now, tMs / 1000);

    g.src = src;
    g.gain = gn;
  }

  function stopSource(fade) {
    if (!g || !g.src) return;
    const s = g.src, gn = g.gain;
    g.src = null;
    try {
      if (fade) {
        gn.gain.setTargetAtTime(0, AC.currentTime, 0.12);
        s.stop(AC.currentTime + 0.5);
      } else s.stop();
    } catch (e) {}
  }

  function gameTime() {
    if (g.paused) return g.pausedT;
    let ct = AC.currentTime;
    if (AC.getOutputTimestamp) {
      const ts = AC.getOutputTimestamp();
      if (ts && ts.contextTime > 0) {
        const c2 = ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
        if (Math.abs(c2 - ct) < 0.35) ct = c2;
      }
    }
    return (ct - g.startCtx) * 1000 + S.offset;
  }

  function locked() {
    return document.pointerLockElement === cv;
  }

  /* ---- Input ----
     pointerrawupdate arrives straight from the device (not aligned to frames), so the cursor
     is up to a frame fresher than with mousemove. every sample is stored with its own
     timestamp and the judge replays them so hits dont depend on the frame rate. */
  const HN = 2048;
  let rawSeenAt = -1e9;

  function pushHist(ts, x, y) {
    const i = g.hI;
    g.hT[i] = ts; g.hX[i] = x; g.hY[i] = y;
    g.hI = (i + 1) % HN;
    if (g.hC < HN) g.hC++;
  }

  function onMove(e, fromRaw) {
    if (!g || g.over || g.paused || g.auto || g.replay) return;
    const now = performance.now();
    if (fromRaw) rawSeenAt = now;
    else if (now - rawSeenAt < 100) return;          // raw events are already feeding us
    if (locked()) {
      g.hadLock = true;
      const k = 0.005 * S.sens;
      g.cur.x = clamp(g.cur.x + e.movementX * k, -CLAMP, CLAMP);
      g.cur.y = clamp(g.cur.y + e.movementY * k, -CLAMP, CLAMP);
    } else {
      g.cur.x = clamp((e.clientX - gW / 2) / g.s0, -CLAMP, CLAMP);
      g.cur.y = clamp((e.clientY - gH / 2) / g.s0, -CLAMP, CLAMP);
    }
    pushHist(e.timeStamp > 0 && e.timeStamp <= now + 5 ? e.timeStamp : now, g.cur.x, g.cur.y);
  }
  addEventListener('mousemove', e => onMove(e, false));
  addEventListener('pointerrawupdate', e => onMove(e, true));
  if (!('onpointerrawupdate' in window)) {
    // Browsers without raw events
    addEventListener('pointermove', e => {
      if (!g || locked()) return;                         // locked mode keeps using mousemove deltas
      const list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
      if (list && list.length) for (const c of list) onMove(c, true);
      else onMove(e, true);
    });
  }

  document.addEventListener('pointerlockchange', () => {
    if (locked()) {
      if (g) g.hadLock = true;
      return;
    }
    if (g && !g.over && g.hadLock) {
      g.hadLock = false;
      pauseGame(true);
    }
  });

  document.addEventListener('pointerlockerror', () => {});
  
  addEventListener('keydown', e => {
    if (e.key === 'Escape' && g && g.replay && screen === 'game') { exitReplay(); return; }
    if (e.key === 'Escape' && g && !g.over && screen === 'game') {
      if (!g.paused || g.countdown > 0) pauseGame(true);
    }
    if ((e.key === 'Enter') && !$('#results').hidden) $('#btnBack').click();
  });

  document.addEventListener('visibilitychange', () => { if (document.hidden && g && !g.over) pauseGame(true); });
  addEventListener('blur', () => { if (g && !g.over && S.mouse === 'free') pauseGame(true); });

  function pauseGame() {
    if (!g || g.over) return;
    if (!g.paused) {
      g.pausedT = gameTime();
      g.paused = true;
      stopSource();
    }
    g.countdown = 0;
    $('#pause').hidden = false;
    if (document.pointerLockElement) document.exitPointerLock();
  }

  function resumeGame() {
    $('#pause').hidden = true;
    if (S.mouse !== 'free' && !g.replay) requestLock();
    g.countdown = 3000;
    g.cdStart = performance.now();
  }

  // Cursor position at a given performance.now() time from the recorded samples
  function histAt(pt) {
    if (!g.hC) return [g.cur.x, g.cur.y];
    let j = (g.hI - 1 + HN) % HN;
    if (pt >= g.hT[j]) return [g.hX[j], g.hY[j]];
    for (let n = 1; n < g.hC; n++) {
      const k = (j - 1 + HN) % HN;
      if (g.hT[k] <= pt) {
        const span = g.hT[j] - g.hT[k], u = span > 0 ? (pt - g.hT[k]) / span : 0;
        return [lerp(g.hX[k], g.hX[j], u), lerp(g.hY[k], g.hY[j], u)];
      }
      j = k;
    }
    return [g.hX[j], g.hY[j]];
  }

  // Slab test when (0..1) a segment first enters a box, or -1
  function segEnter(x0, y0, x1, y1, bx, by, h) {
    let t0 = 0, t1 = 1;
    for (const [p, q, c] of [[x0, x1, bx], [y0, y1, by]]) {
      const d = q - p, lo = c - h - p, hi = c + h - p;
      if (Math.abs(d) < 1e-9) {
        if (lo > 0 || hi < 0) return -1;
      } else {
        let a = lo / d, b = hi / d;
        if (a > b) { const tmp = a; a = b; b = tmp; }
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, b);
        if (t0 > t1) return -1;
      }
    }
    return t0;
  }

  // First performance.now() time in [perfA, perfB] at which the cursor touches the note box, or -1
  function sweepHit(bx, by, perfA, perfB) {
    const h = (NOTE + CUR) / 2;
    let [px, py] = histAt(perfA);
    if (Math.abs(px - bx) <= h && Math.abs(py - by) <= h) return perfA;
    let pt = perfA;
    const start = (g.hI - g.hC + HN) % HN;
    for (let n = 0; n < g.hC; n++) {
      const j = (start + n) % HN, tj = g.hT[j];
      if (tj <= perfA) continue;
      if (tj > perfB) break;
      const u = segEnter(px, py, g.hX[j], g.hY[j], bx, by, h);
      if (u >= 0) return pt + u * (tj - pt);
      px = g.hX[j]; py = g.hY[j]; pt = tj;
    }
    return -1;
  }

  function applyHit(i, t, hitAt) {
    g.states[i] = 1;
    g.hitAt[i] = hitAt;
    g.hits++;
    g.combo++;
    if (g.combo > g.maxCombo) g.maxCombo = g.combo;

    g.score += 100 * (1 + Math.min(7, Math.floor(g.combo / 15)));
    g.hp = Math.min(HPMAX, g.hp + HP_HIT);
    g.lastHit = t;
    g.events.push({ t: g.notes[i].ms, h: 1 });
    blip('hit');
  }

  function applyMiss(i) {
    g.states[i] = 2;
    g.misses++;
    g.combo = 0;
    g.hp -= HP_MISS;
    g.lastMiss = performance.now();
    g.events.push({ t: g.notes[i].ms, h: 0 });
    blip('miss');
  }

  // Hit Detection & Logic Judge
  function judge(t) {
    const N = g.notes, st = g.states, pf = performance.now();
    for (let i = g.lo; i < g.N; i++) {
      const n = N[i];
      if (st[i] !== 0) continue;
      if (n.ms > t) break;                                  // not at the grid yet

      const end = Math.min(t, n.ms + MAX_LATE_TIME);
      const ph = sweepHit(n.x - 1, n.y - 1, pf - (t - n.ms), pf - (t - end));

      if (ph >= 0) applyHit(i, t, Math.max(n.ms, t - (pf - ph)));
      else if (t > n.ms + MAX_LATE_TIME) applyMiss(i);
    }
    while (g.lo < g.N && st[g.lo] !== 0) g.lo++;
  }

  // Replay
  function replayJudge(t) {
    const R = g.replay, N = g.notes, st = g.states;
    for (let i = g.lo; i < g.N; i++) {
      const n = N[i];
      if (st[i] !== 0) continue;
      if (n.ms > t) break;
      const o = R.o[i];
      if (o <= MAX_LATE_TIME) { if (t >= n.ms + o) applyHit(i, t, n.ms + o); }
      else if (t > n.ms + MAX_LATE_TIME) applyMiss(i);
    }
    while (g.lo < g.N && st[g.lo] !== 0) g.lo++;
  }

  function updateGame(t) {
    if (g.replay) {
      const R = g.replay, f = Math.max(0, t) / REC_DT;
      const i = Math.min(R.M - 1, f | 0), j = Math.min(R.M - 1, i + 1), u = Math.min(1, f - i);
      g.cur = { x: lerp(R.x[i], R.x[j], u), y: lerp(R.y[i], R.y[j], u) };
      replayJudge(t);
      if (g.hp < 0) g.hp = 0;
      g.trail.push({ x: g.cur.x, y: g.cur.y });
      if (g.trail.length > 9) g.trail.shift();
      if (t >= R.endT) endReplay();
      return;
    }
    if (g.auto) {
      // Demo bot
      const pf = performance.now();
      let tk = g.autoT === undefined ? t : g.autoT;
      for (tk += 8; tk <= t; tk += 8) {
        const c = autoCursor(g.notes, tk);
        pushHist(pf - (t - tk), c.x, c.y);
      }
      g.autoT = tk - 8;
      g.cur = autoCursor(g.notes, t);
      pushHist(pf, g.cur.x, g.cur.y);
    }
    judge(t);
    if (!g.auto) {                                          // record the cursor on a fixed grid for the replay
      const pf = performance.now();
      while (g.recN * REC_DT <= t) {
        const [rx, ry] = histAt(pf - (t - g.recN * REC_DT));
        g.recC.push(Math.round(rx * 10000), Math.round(ry * 10000));
        g.recN++;
      }
    }
    g.trail.push({ x: g.cur.x, y: g.cur.y });
    if (g.trail.length > 9) g.trail.shift();

    if (g.hp <= 0) {
      g.hp = 0;
      endGame(false, t);
    } else if (t > g.lastMs + 1500) {
      endGame(true, t);
    }
  }

  function gameFrame() {
    if (g.countdown > 0) {
      if (performance.now() - g.cdStart >= 3000) {
        g.countdown = 0;
        g.paused = false;
        playFrom(g.pausedT);
      }
    }
    const t = gameTime();
    if (!g.paused && !g.over) updateGame(t);

    const idle = (g.paused && g.countdown <= 0) || (g.over && performance.now() - g.overAt > 800);
    if (idle && g.idleDrawn) return;
    g.idleDrawn = idle;

    const nowF = performance.now();
    const dtF = Math.min(100, nowF - g.lastF);
    g.lastF = nowF;

    const still = REDUCE.matches;
    const k = 1 - Math.exp(-dtF / 140);

    g.cam.x += ((still ? 0 : g.cur.x * 0.09) - g.cam.x) * k;
    g.cam.y += ((still ? 0 : g.cur.y * 0.09) - g.cam.y) * k;

    // Kick pulse
    kickEnv *= Math.exp(-dtF / 120);
    stepVis(dtF);
    const K = g.kicks;
    if (K && !g.paused) {
      while (K.lo < K.n && K.t[K.lo] <= t) {
        if (K.t[K.lo] > t - 120) kickEnv = Math.max(kickEnv, K.s[K.lo]);
        K.lo++;
      }
    }

    if (GL) {
      adaptRes(dtF);
      GL.render({
        W: gW, H: gH, t,
        notes: g.notes, states: g.states, hitAt: g.hitAt, approach: g.approach,
        cur: g.cur, trail: g.trail, cam: g.cam, style: noteStyle(), cursor: buildCursor(t, performance.now(), dtF, fxFor()),
        bass: bassVis, kick: kickVis, kicks: K, fx: fxFor()
      });
      g.s0 = Math.min(gH * 0.17, gW * 0.13);
      if (S.quality !== 'potato' || (tick & 1)) {
        hudX.setTransform(hudDpr, 0, 0, hudDpr, 0, 0);
        hudX.clearRect(0, 0, gW, gH);
        drawHUD(hudX, gW, gH, t);
      }
      return;
    }

    cx.setTransform(gDpr, 0, 0, gDpr, 0, 0);
    const o = {
      t,
      notes: g.notes,
      states: g.states,
      hitAt: g.hitAt,
      approach: g.approach,
      bass: Math.max(bassVis, kickVis),
      cursor: g.cur,
      trail: g.trail,
      cam: g.cam,
      lowFx: lowFxOn()
    };

    drawScene(cx, gW, gH, o);
    g.s0 = o.s0;
    drawHUD(cx, gW, gH, t);
  }

  // Draw HUD Overlay Elements
  function drawHUD(c, W, H, t) {
    const pad = Math.max(16, W * 0.025);
    const big = Math.round(clamp(W * 0.032, 20, 38));
    const prog = clamp(t / g.lastMs, 0, 1);

    c.fillStyle = 'rgba(255,255,255,.1)';
    c.fillRect(0, 0, W, 4);
    c.fillStyle = '#35d6ff';
    c.fillRect(0, 0, W * prog, 4);

    const done = g.hits + g.misses;
    const acc = done ? g.hits / done * 100 : 100;

    c.textBaseline = 'alphabetic';
    c.textAlign = 'left';
    c.fillStyle = '#efeaff';
    c.font = `700 ${big}px "JetBrains Mono",monospace`;
    c.fillText(fmt(g.score), pad, pad + big);

    c.font = `500 ${Math.round(big * 0.5)}px "JetBrains Mono",monospace`;
    c.fillStyle = '#9086b8';
    c.fillText(acc.toFixed(2) + '%   x' + (1 + Math.min(7, Math.floor(g.combo / 15))), pad, pad + big + big * 0.7);

    c.textAlign = 'right';
    c.fillText(g.meta.name.length > 44 ? g.meta.name.slice(0, 43) + '…' : g.meta.name, W - pad, pad + big * 0.6);
    c.fillText(g.replay ? 'REPLAY · ' + g.replay.label + ' · ESC to exit' : 'ESC pause', W - pad, pad + big * 1.3);

    // Health Bar
    const bw = Math.min(W * 0.34, 420);
    const bx = (W - bw) / 2;
    const by = H - pad - 10;
    const pct = g.hp / HPMAX;

    c.fillStyle = 'rgba(255,255,255,.1)';
    c.fillRect(bx, by, bw, 8);
    c.fillStyle = pct < 0.34 ? '#ff3d71' : pct < 0.6 ? '#ffa53d' : '#3ddc97';
    c.fillRect(bx, by, bw * pct, 8);

    // Combo Tracker
    if (g.combo > 1) {
      const pop = clamp(1 - (t - g.lastHit) / 120, 0, 1);
      c.textAlign = 'center';
      c.fillStyle = `rgba(239,234,255,${0.55 + pop * 0.4})`;
      c.font = `700 ${Math.round(big * 1.5 * (1 + pop * 0.12))}px "Unbounded",sans-serif`;
      c.fillText(g.combo, W / 2, H - pad - 34);
    }

    // Damage Effect Flash
    const mf = 1 - (performance.now() - g.lastMiss) / 350;
    if (mf > 0) {
      const gr = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
      gr.addColorStop(0, 'rgba(255,40,80,0)');
      gr.addColorStop(1, `rgba(255,40,80,${mf * 0.45})`);
      c.fillStyle = gr;
      c.fillRect(0, 0, W, H);
    }

    // Intro Title Card
    if (t < 0) {
      const a = clamp(1 + t / 600, 0, 1) * clamp((-t) / 400, 0, 1);
      c.textAlign = 'center';
      c.fillStyle = `rgba(239,234,255,${a})`;
      c.font = `700 ${Math.round(big * 0.8)}px "Unbounded",sans-serif`;
      c.fillText(g.meta.name, W / 2, H * 0.2);

      c.fillStyle = `rgba(144,134,184,${a})`;
      c.font = `500 ${Math.round(big * 0.5)}px "Manrope",sans-serif`;
      c.fillText('mapped by ' + g.meta.mapper, W / 2, H * 0.2 + big * 0.9);
    }

    // Countdown Text
    if (g.countdown > 0) {
      const left = 3 - Math.floor((performance.now() - g.cdStart) / 1000);
      c.textAlign = 'center';
      c.fillStyle = '#fff';
      c.font = `900 ${Math.round(big * 3)}px "Unbounded",sans-serif`;
      c.fillText(Math.max(1, left), W / 2, H / 2 + big);
    }
  }

  /* ==========================================================================
     Replays
     ========================================================================== */
  const REC_DT = 16;

  const b64enc = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const b64dec = str => { const s = atob(str), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
  // Runs the bytes through a (de)compression stream; `limit` stops decompression bombs
  const pipeBytes = async (u8, stream, limit = Infinity) => {
    const rd = new Blob([u8]).stream().pipeThrough(stream).getReader(), parts = [];
    let n = 0;
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      n += value.length;
      if (n > limit) { rd.cancel(); throw new Error('Replay is damaged'); }
      parts.push(value);
    }
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };

  async function packReplay(gg, t, win, mapId, scores) {
    // everything is read from gg synchronously before the first await
    const rid = Replays.key(mapId, currentPlayer.name, currentPlayer.school);
    const old = Replays.scoreOf(rid);
    if (old != null && old > gg.score) return;            // keep the players better run
    const M = gg.recC.length / 2, N = gg.N;
    const cur = new Int16Array(M * 2);
    let px = 0, py = 0;
    for (let i = 0; i < M; i++) {
      const x = gg.recC[2 * i], y = gg.recC[2 * i + 1];
      cur[2 * i] = x - px; cur[2 * i + 1] = y - py; px = x; py = y;
    }
    const bytes = new Uint8Array(M * 4 + N);
    bytes.set(new Uint8Array(cur.buffer), 0);
    for (let i = 0; i < N; i++) {
      bytes[M * 4 + i] = gg.states[i] === 1 ? Math.round(clamp(gg.hitAt[i] - gg.notes[i].ms, 0, MAX_LATE_TIME)) : (gg.states[i] === 2 ? 255 : 254);
    }
    const meta = { v: 1, M, N, endT: Math.round(t), win, approach: gg.approach, label: (currentPlayer.name || 'Anonymous') + (currentPlayer.school ? ' (' + currentPlayer.school + ')' : ''), score: gg.score, gz: false };
    try {
      let out = bytes;
      if (typeof CompressionStream !== 'undefined') { out = await pipeBytes(bytes, new CompressionStream('gzip')); meta.gz = true; }
      meta.d = b64enc(out);
      Replays.put(rid, meta);
      if (scores && scores.length) Replays.prune(mapId, scores);
      ReplaysNet.upload(mapId, currentPlayer.name, currentPlayer.school, meta);
    } catch (e) {}
  }

  async function unpackReplay(ref) {
    let raw = Replays.get(Replays.key(ref.mapId, ref.name, ref.school));
    if (!raw || raw.score !== ref.score) {
      try { raw = await ReplaysNet.fetch(ref); } catch (e) { raw = null; }
    }
    if (!raw) throw new Error('Replay data is not available');
    const { M, N } = raw;
    // The data may come from the server
    if (!Number.isInteger(M) || !Number.isInteger(N) || M < 0 || N < 0 || M > 200000 || N > 200000 || typeof raw.d !== 'string' || raw.d.length > 1500000) throw new Error('Replay is damaged');
    const want = M * 4 + N;
    let u8 = b64dec(raw.d);
    if (raw.gz) u8 = await pipeBytes(u8, new DecompressionStream('gzip'), want);
    if (u8.length < want) throw new Error('Replay is damaged');
    const cur = new Int16Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + M * 4));
    const x = new Float32Array(M), y = new Float32Array(M);
    let px = 0, py = 0;
    for (let i = 0; i < M; i++) {
      px += cur[2 * i]; py += cur[2 * i + 1];
      x[i] = px / 10000; y[i] = py / 10000;
    }
    if (!M) { x[0] = 0; y[0] = 0; }
    return { ref, M: Math.max(1, M), x, y, o: u8.slice(M * 4, M * 4 + N), endT: raw.endT, win: raw.win, approach: raw.approach, label: raw.label };
  }

  function openLeaderboardFor(id) { openLeaderboard(id); }

  function endReplay() {
    if (g.over) return;
    g.over = true;
    g.overAt = performance.now();
    stopSource(true);
    const gg = g, id = g.meta.id;
    setTimeout(() => { if (g === gg) { toLobby(); openLeaderboardFor(id); } }, 900);
  }

  function exitReplay() {
    const id = g.meta.id;
    toLobby();
    openLeaderboardFor(id);
  }

  /* ==========================================================================
     Results Screen & Leaderboard Record
     ========================================================================== */
  let backTimer = null;

  function endGame(win, t) {
    if (g.over) return;
    g.over = true;
    g.overAt = performance.now();
    stopSource(true);

    if (!win) blip('miss');
    if (document.pointerLockElement) document.exitPointerLock();

    const gg = g;
    setTimeout(() => {
      if (g === gg) showResults(win, t);
    }, win ? 900 : 700);
  }

  function showResults(win, t) {
    const done = g.hits + g.misses;
    const acc = done ? g.hits / done * 100 : 0;
    const prog = win ? 100 : clamp(t / g.lastMs * 100, 0, 99);

    let grade = 'F', gc = '#ff3d71';
    if (win) {
      if (g.misses === 0) { grade = 'SS'; gc = '#ffd34a'; }
      else if (acc >= 95) { grade = 'S'; gc = '#35d6ff'; }
      else if (acc >= 90) { grade = 'A'; gc = '#3ddc97'; }
      else if (acc >= 80) { grade = 'B'; gc = '#b9ff6a'; }
      else if (acc >= 70) { grade = 'C'; gc = '#ffa53d'; }
      else { grade = 'D'; gc = '#ff7a5a'; }
    }

    $('#resStatus').textContent = win ? 'CLEARED' : 'FAILED';
    $('#resStatus').classList.toggle('fail', !win);
    $('#resTitle').textContent = g.meta.name;
    setCover($('#resCover'), g.entry);
    $('#resMeta').textContent = (g.meta.folder === 'death' ? '助けて' : FOLDER[g.meta.folder]?.label || '') + ' · ' + g.meta.nps.toFixed(1) + ' notes/s';

    const gr = $('#resGrade');
    gr.textContent = grade;
    gr.style.setProperty('--gc', gc);

    $('#rScore').textContent = fmt(g.score);
    $('#rAcc').textContent = acc.toFixed(2) + '%';
    $('#rCombo').textContent = fmt(g.maxCombo);
    $('#rHits').textContent = fmt(g.hits);
    $('#rMiss').textContent = fmt(g.misses);
    $('#rProg').textContent = Math.floor(prog) + '%';

    $('#btnReplay').hidden = win;
    $('#results').hidden = false;

    drawTimeline();
    submitScore(g, win, acc, grade, prog, t);

    let n = 15;
    $('#btnBack').innerHTML = 'Back (<span id="backCount">15</span>)';
    $('#backCount').textContent = n;
    clearInterval(backTimer);
    backTimer = setInterval(() => {
      n--;
      $('#backCount').textContent = Math.max(0, n);
      if (n <= 0) {
        clearInterval(backTimer);
        toLobby();
      }
    }, 1000);
  }

  async function submitScore(gg, win, acc, grade, prog, tEnd) {
    const el = $('#resRank');
    el.hidden = false;
    el.className = 'rank-line';

    if (gg.auto) {
      el.textContent = 'Auto-play run, not submitted.';
      return;
    }
    el.textContent = 'Submitting score…';

    const r = await Leaderboard.submit(gg.meta.id, {
      name: currentPlayer.name,
      school: currentPlayer.school,
      score: gg.score,
      acc: Math.round(acc * 100) / 100,
      maxCombo: gg.maxCombo,
      hits: gg.hits,
      misses: gg.misses,
      grade,
      cleared: win,
      progress: Math.floor(prog)
    });
    if (!r.error && r.ranked !== false && r.rank >= 1 && r.rank <= REPLAY_TOP) {
      packReplay(gg, tEnd, win, gg.meta.id, r.scores);
    }
    if (g !== gg) return; // player already left the results screen

    if (r.error) {
      el.textContent = 'Score not saved: ' + r.error;
      el.classList.add('bad');
    } else if (r.ranked === false) {
      el.textContent = 'Imported maps are not ranked. Only maps on the server have a leaderboard.';
    } else if (r.offline) {
      el.textContent = 'Server unreachable. Score saved and will upload automatically.';
      el.classList.add('warn');
    } else if (!r.rank) {
      el.textContent = 'Not in the top 50 for this map yet.';
    } else if (r.improved) {
      el.textContent = 'Rank #' + r.rank + ' · new personal best!';
      el.classList.add('good');
    } else {
      el.textContent = 'Rank #' + r.rank + (Number.isFinite(+r.best) && r.best != null ? ' · your best here is ' + fmt(+r.best) : '');
    }
  }

  function drawTimeline() {
    const c = $('#resTimeline');
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = c.clientWidth;
    const h = c.clientHeight;

    c.width = w * dpr;
    c.height = h * dpr;
    const x = c.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);

    const bins = Math.max(20, Math.floor(w / 6));
    const H = new Array(bins).fill(0);
    const M = new Array(bins).fill(0);

    for (const ev of g.events) {
      const b = Math.min(bins - 1, Math.floor(ev.t / g.lastMs * bins));
      if (ev.h) H[b]++;
      else M[b]++;
    }

    const mx = Math.max(1, ...H.map((v, i) => v + M[i]));
    const bw = w / bins;

    for (let i = 0; i < bins; i++) {
      const tot = H[i] + M[i];
      if (!tot) continue;
      const bh = Math.max(3, tot / mx * (h - 4));
      const mh = M[i] / tot * bh;

      x.fillStyle = '#35d6ff';
      x.globalAlpha = 0.55;
      x.fillRect(i * bw, h - bh, bw - 1, bh - mh);

      x.globalAlpha = 1;
      x.fillStyle = '#ff3d71';
      x.fillRect(i * bw, h - mh, bw - 1, mh);
    }
  }

  function toLobby() {
    clearInterval(backTimer);
    if (g) {
      stopSource();
      g.over = true;
    }
    g = null;
    if (document.pointerLockElement) document.exitPointerLock();

    $('#results').hidden = true;
    $('#pause').hidden = true;
    setLoading(false);

    showScreen('lobby');
    hov = null;
    hovTok++;
    renderCard();
    if (AC) fadePreview();
    refreshLib();
  }

  // Event Handlers for Nav
  $('#btnBack').onclick = toLobby;
  $('#btnReplay').onclick = () => { const m = g.meta; g.over = true; startGame(m); };
  $('#pResume').onclick = resumeGame;
  $('#pRestart').onclick = () => { const m = g.meta, rid = g.replay && g.replay.ref; stopSource(); g.over = true; startGame(m, rid); };
  $('#pQuit').onclick = toLobby;

  /* ==========================================================================
     Leaderboard Modal Rendering & Controls
     ========================================================================== */
  let lbTok = 0, lbTimer = null;

  function openLeaderboard(mapId) {
    renderLeaderboardModal(mapId);
    $('#leaderboardModal').hidden = false;
    clearInterval(lbTimer);
    // live refresh while the board is on screen (handy on a shared open-house display)
    lbTimer = setInterval(() => {
      if ($('#leaderboardModal').hidden) return clearInterval(lbTimer);
      updateLeaderboardView($('#lbMapSelect').value, true);
    }, 10000);
  }

  function renderLeaderboardModal(selectedMapId = null) {
    const mapSelect = $('#lbMapSelect');
    mapSelect.innerHTML = '';

    if (!LIB.length) {
      mapSelect.innerHTML = '<option value="">No maps available</option>';
      $('#lbList').innerHTML = '<div class="empty">No maps found in library.</div>';
      return;
    }

    for (const f of FOLDERS) {
      const maps = LIB.filter(m => m.folder === f.key);
      if (!maps.length) continue;
      const grp = document.createElement('optgroup');
      grp.label = f.label;
      for (const m of maps) {
        const op = document.createElement('option');
        op.value = m.id;
        op.textContent = m.name;
        grp.appendChild(op);
      }
      mapSelect.appendChild(grp);
    }

    mapSelect.value = selectedMapId && LIB.some(m => m.id === selectedMapId) ? selectedMapId : LIB[0].id;
    updateLeaderboardView(mapSelect.value, true);
  }

  async function updateLeaderboardView(mapId, force) {
    const listEl = $('#lbList');
    if (!mapId) { listEl.innerHTML = ''; return; }

    const tok = ++lbTok;
    const cached = Leaderboard.peek(mapId);
    if (cached == null) listEl.innerHTML = '<div class="empty">Loading scores…</div>';

    const { scores, offline } = await Leaderboard.get(mapId, force);
    if (tok !== lbTok) return; // a newer request replaced this one

    const note = offline ? '<div class="empty">Server unreachable. Showing the last known scores.</div>' : '';
    if (!scores.length) {
      listEl.innerHTML = note + '<div class="empty">No scores recorded for this map yet!</div>';
      return;
    }

    const me = (currentPlayer.name + '|' + currentPlayer.school).toLowerCase();
    let html = note + `<table class="lb-table">
      <thead>
        <tr><th>#</th><th>Player</th><th>School</th><th>Score</th><th>Acc</th><th>Combo</th><th>Grade</th><th>Replay</th></tr>
      </thead>
      <tbody>`;

    if (!offline) Replays.prune(mapId, scores);
    scores.forEach((s, idx) => {
      const mine = (s.name + '|' + s.school).toLowerCase() === me;
      const rkey = Replays.key(mapId, s.name, s.school);
      const rk = idx < REPLAY_TOP
        ? `<span class="rpc" data-n="${esc(s.name)}" data-s="${esc(s.school)}" data-sc="${Number(s.score) || 0}">${Replays.scoreOf(rkey) === s.score ? '<button class="ghost rp">&#9654; Watch</button>' : ''}</span>` : '';
      html += `<tr class="${mine ? 'me' : ''}">
        <td>${idx + 1}</td>
        <td><b>${esc(s.name)}</b></td>
        <td>${esc(s.school)}</td>
        <td>${fmt(s.score)}</td>
        <td>${(Number(s.acc) || 0).toFixed(2)}%</td>
        <td>x${Number(s.maxCombo) || 0}</td>
        <td>${esc(s.grade || '-')}${s.cleared === false ? ' <small>(failed)</small>' : ''}</td>
        <td>${rk}</td>
      </tr>`;
    });

    listEl.dataset.map = String(mapId);
    listEl.innerHTML = html + '</tbody></table>';
    listEl.onclick = ev => {
      const b = ev.target.closest('.rpc button');
      if (!b) return;
      const c = b.parentElement, meta = LIB.find(m => m.id === mapId);
      if (meta) startGame(meta, { mapId, name: c.dataset.n, school: c.dataset.s, score: +c.dataset.sc });
    };
    // Replays other people recorded live
    if (!offline) ReplaysNet.index(mapId).then(list => {
      if (listEl.dataset.map !== String(mapId)) return;
      listEl.querySelectorAll('.rpc').forEach(c => {
        if (c.firstChild) return;
        const ok = list.some(r => r.name === c.dataset.n && (r.school || '') === c.dataset.s && r.score === +c.dataset.sc);
        if (ok) c.innerHTML = '<button class="ghost rp">&#9654; Watch</button>';
      });
    });
  }

  $('#lbMapSelect').onchange = e => updateLeaderboardView(e.target.value, true);
  $('#btnLeaderboard').onclick = () => openLeaderboard(hov && hov.meta ? hov.meta.id : null);
  $('#btnResLeaderboard').onclick = () => {
    // stop the auto-return countdown so the player can read the board in peace
    clearInterval(backTimer);
    $('#btnBack').textContent = 'Back';
    openLeaderboard(g && g.meta ? g.meta.id : null);
  };
  $('#lbClose').onclick = () => { $('#leaderboardModal').hidden = true; clearInterval(lbTimer); };

  /* ==========================================================================
     Library Management & Settings Listeners
     ========================================================================== */
  function renderLibrary() {
    const root = $('#libCols');
    if (!root) return;
    root.innerHTML = '';

    for (const f of FOLDERS) {
      const maps = LIB.filter(m => m.folder === f.key);
      const col = document.createElement('div');
      col.className = 'col';
      col.style.setProperty('--c', f.color);
      col.innerHTML = '<h3>' + (f.key === 'death' ? '助けて' : f.label) + '<span>' + maps.length + '</span></h3>' + (maps.length ? '' : '<div class="empty">Empty</div>');

      for (const m of maps) {
        const r = document.createElement('div');
        r.className = 'row';
        r.innerHTML = '<b>' + esc(m.name) + '</b><small>' + esc(m.mapper) + ' · ' + fmtTime(m.dur) + ' · ' + m.nps.toFixed(1) + '/s' + (m.source === 'server' ? ' · server' : '') + '</small>';

        const d = document.createElement('div');
        d.className = 'row-actions';
        
        const sel = document.createElement('select');
        sel.className = 'lib-select';
        sel.setAttribute('aria-label', 'Move ' + m.name);

        for (const o of FOLDERS) {
          const op = document.createElement('option');
          op.value = o.key;
          op.textContent = o.key === 'death' ? '助けて' : o.label;
          if (o.key === m.folder) op.selected = true;
          sel.appendChild(op);
        }

        sel.onchange = async () => {
          m.folder = sel.value;
          DiffOverrides.set(m.id, sel.value);
          await Store.putMeta(m);
          refreshLib();
        };

        const del = document.createElement('button');
        del.className = 'lib-remove-btn';
        del.textContent = 'Remove';
        del.onclick = async () => {
          await Store.del(m.id);
          ENT.delete(m.id);
          refreshLib();
        };

        if (m.source === 'server') d.append(sel);
        else d.append(sel, del);
        r.appendChild(d);
        col.appendChild(r);
      }
      root.appendChild(col);
    }
  }

  $('#btnImport').onclick = $('#libImport').onclick = () => $('#file').click();
  $('#file').onchange = async e => {
    const fs = [...e.target.files];
    e.target.value = '';
    await addFiles(fs);
  };

  $('#btnLib').onclick = () => { renderLibrary(); $('#library').hidden = false; };
  $('#libClose').onclick = () => $('#library').hidden = true;
  $('#btnSet').onclick = () => $('#settings').hidden = false;
  $('#setClose').onclick = () => $('#settings').hidden = true;

  for (const o of [$('#library'), $('#settings'), $('#leaderboardModal'), $('#playerModal')]) {
    o.addEventListener('pointerdown', e => {
      if (e.target === o && o.id !== 'playerModal') {
        o.hidden = true;
        if (o.id === 'leaderboardModal') clearInterval(lbTimer);
      }
    });
  }

  const SET = [
    ['sSens', 'oSens', 'sens', v => (+v).toFixed(2)],
    ['sApp', 'oApp', 'approach', v => v + ' ms'],
    ['sVol', 'oVol', 'vol', v => Math.round(v * 100) + '%'],
    ['sSfx', 'oSfx', 'sfx', v => Math.round(v * 100) + '%'],
    ['sOff', 'oOff', 'offset', v => (v > 0 ? '+' : '') + v + ' ms']
  ];

  for (const [id, out, key, f] of SET) {
    const el = $('#' + id);
    el.value = S[key];
    $('#' + out).textContent = f(S[key]);
    el.oninput = () => {
      S[key] = +el.value;
      $('#' + out).textContent = f(S[key]);
      saveS();
      if (AC) {
        master.gain.value = S.vol;
        sfx.gain.value = S.sfx;
      }
    };
  }

  $('#sQ').value = S.quality;
  $('#sQ').onchange = e => {
    S.quality = e.target.value;
    saveS();
    if (screen === 'game') sizeGame();
  };

  // Note style, palette, mesh, scale and opacity
  const refreshNoteUi = () => {
    $('#sNote').value = S.noteStyle;
    document.querySelectorAll('#sPalWrap [data-pal]').forEach(b => b.classList.toggle('on', b.dataset.pal === S.palette));
    $('#sCust').hidden = S.palette !== 'custom';
    $('#sNoteOpts').classList.toggle('dim', S.noteStyle !== 'solid');
  };
  const palWrap = $('#sPalWrap');
  for (const p of PALETTES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pal';
    b.dataset.pal = p.id;
    b.title = p.name;
    b.innerHTML = '<span class="pn"></span><span class="sw"></span>';
    b.firstChild.textContent = p.name;
    b.lastChild.dataset.id = p.id;
    palWrap.appendChild(b);
    b.onclick = () => { S.palette = p.id; invalidateStyle(); saveS(); paintPalettes(); refreshNoteUi(); };
  }
  function paintPalettes() {
    palWrap.querySelectorAll('.sw').forEach(sw => {
      const p = PALETTES.find(x => x.id === sw.dataset.id);
      const list = (p.custom ? S.custom.slice(0, clamp(S.customN | 0, 1, 4)) : p.c).filter(c => /^#[0-9a-f]{6}$/i.test(c));
      if (list.length > 6) {                               // wheels: little grid of squares
        const cols = Math.ceil(Math.sqrt(list.length));
        sw.style.display = 'grid';
        sw.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
        sw.innerHTML = list.map(c => '<i style="background:' + c + '"></i>').join('');
      } else {
        sw.style.display = 'flex';
        sw.innerHTML = list.map(c => '<i style="background:' + c + ';flex:1"></i>').join('');
      }
    });
  }
  const custBox = $('#sCust');
  custBox.querySelectorAll('input[type=color]').forEach((inp, i) => {
    inp.value = S.custom[i] || '#ffffff';
    inp.oninput = () => { S.custom[i] = inp.value; invalidateStyle(); saveS(); paintPalettes(); };
  });
  $('#sCustN').value = String(S.customN);
  $('#sCustN').onchange = e => { S.customN = +e.target.value; invalidateStyle(); saveS(); paintPalettes(); };
  $('#sNote').onchange = e => { S.noteStyle = e.target.value; invalidateStyle(); saveS(); refreshNoteUi(); };
  $('#sMesh').value = S.mesh;
  $('#sMesh').onchange = e => { S.mesh = e.target.value; invalidateStyle(); saveS(); };
  const sc = $('#sScale'), op = $('#sOpac');
  sc.value = S.noteScale; $('#oScale').textContent = (+S.noteScale).toFixed(2) + 'x';
  sc.oninput = () => { S.noteScale = +sc.value; $('#oScale').textContent = S.noteScale.toFixed(2) + 'x'; invalidateStyle(); saveS(); };
  op.value = S.noteOpacity; $('#oOpac').textContent = Math.round(S.noteOpacity * 100) + '%';
  op.oninput = () => { S.noteOpacity = +op.value; $('#oOpac').textContent = Math.round(S.noteOpacity * 100) + '%'; invalidateStyle(); saveS(); };
  // Note inside opacity
  const fl = $('#sFill');
  fl.value = S.noteFill; $('#oFill').textContent = Math.round(S.noteFill * 100) + '%';
  fl.oninput = () => { S.noteFill = +fl.value; $('#oFill').textContent = Math.round(S.noteFill * 100) + '%'; invalidateStyle(); saveS(); };

  // Cursor
  const bindRange = (id, out, key, fmtv) => {
    const el = $(id), o = $(out);
    el.value = S[key]; o.textContent = fmtv(+S[key]);
    el.oninput = () => { S[key] = +el.value; o.textContent = fmtv(S[key]); saveS(); };
  };
  bindRange('#sCurScale', '#oCurScale', 'cursorScale', v => v.toFixed(2) + 'x');
  bindRange('#sCurSpin', '#oCurSpin', 'cursorSpin', v => Math.round(v) + ' °/sec');
  bindRange('#sTrailDetail', '#oTrailDetail', 'trailDetail', v => String(Math.round(v)));
  bindRange('#sTrailTime', '#oTrailTime', 'trailTime', v => v.toFixed(2) + ' s');
  const bindSel = (id, key) => { const el = $(id); el.value = S[key]; el.onchange = () => { S[key] = el.value; saveS(); refreshCursorUi(); }; };
  const bindChk = (id, key) => { const el = $(id); el.checked = !!S[key]; el.onchange = () => { S[key] = el.checked; saveS(); refreshCursorUi(); }; };
  bindSel('#sCurShape', 'cursorShape'); bindSel('#sCurMode', 'cursorColorMode'); bindSel('#sTrailFade', 'trailFade');
  bindChk('#sTrail', 'trailOn'); bindChk('#sSmart', 'smartTrail');
  $('#sCurColor').value = S.cursorColor;
  $('#sCurColor').oninput = e => { S.cursorColor = e.target.value; saveS(); };
  function refreshCursorUi() {
    const prev = $('#sCurImgPrev');
    prev.hidden = !S.cursorImage;
    if (S.cursorImage) prev.src = S.cursorImage; else prev.removeAttribute('src');
    $('#sCurImgRow').classList.toggle('off', S.cursorShape !== 'image');
    $('#sCurColor').classList.toggle('off', S.cursorColorMode !== 'custom');
    for (const id of ['#sTrailFade', '#sTrailDetail', '#sTrailTime', '#sSmart']) $(id).classList.toggle('off', !S.trailOn);
  }
  // Custom cursor image: re-encoded as a small PNG, so only a harmless image ever gets stored
  $('#sCurImgBtn').onclick = () => $('#sCurImgFile').click();
  $('#sCurImgReset').onclick = () => { S.cursorImage = ''; if (S.cursorShape === 'image') S.cursorShape = 'circle'; $('#sCurShape').value = S.cursorShape; saveS(); syncCursorImage(); refreshCursorUi(); };
  $('#sCurImgFile').onchange = async e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type) || f.size > 8 * 1024 * 1024) { toast('Choose a PNG, JPEG, WebP or GIF image under 8 MB.'); return; }
    try {
      const bmp = await createImageBitmap(f);
      let side = 192, url = '';
      for (let tries = 0; tries < 3; tries++, side = Math.round(side / 2)) {
        const sc = Math.min(1, side / Math.max(bmp.width, bmp.height));
        const w = Math.max(1, Math.round(bmp.width * sc)), h = Math.max(1, Math.round(bmp.height * sc));
        const cv2 = document.createElement('canvas');
        cv2.width = side; cv2.height = side;                      // square, image centred
        cv2.getContext('2d').drawImage(bmp, (side - w) / 2, (side - h) / 2, w, h);
        url = cv2.toDataURL('image/png');
        if (url.length < 600000) break;
      }
      bmp.close && bmp.close();
      if (url.length >= 900000) throw new Error('too large');
      S.cursorImage = url; S.cursorShape = 'image';
      $('#sCurShape').value = 'image';
      saveS(); syncCursorImage(); refreshCursorUi();
    } catch (err) { toast('Could not use that image.'); }
  };
  syncCursorImage();
  refreshCursorUi();

  $('#sFps').checked = !!S.showFps;
  $('#sFps').onchange = e => { S.showFps = e.target.checked; saveS(); fpsEl.hidden = !S.showFps; };
  paintPalettes();
  refreshNoteUi();

  $('#sLat').value = S.lowLat;
  $('#sLat').onchange = e => {
    S.lowLat = e.target.value;
    saveS();
    toast('Reload the page to apply the display mode.');
  };

  $('#sMouse').value = S.mouse;
  $('#sMouse').onchange = e => {
    S.mouse = e.target.value;
    saveS();
  };

  // Drag and Drop Logic
  let dragN = 0;
  addEventListener('dragenter', e => {
    e.preventDefault();
    dragN++;
    $('#drop').hidden = false;
  });
  addEventListener('dragover', e => e.preventDefault());
  addEventListener('dragleave', e => {
    dragN = Math.max(0, dragN - 1);
    if (!dragN) $('#drop').hidden = true;
  });
  addEventListener('drop', async e => {
    e.preventDefault();
    dragN = 0;
    $('#drop').hidden = true;
    if (e.dataTransfer && e.dataTransfer.files.length) {
      await addFiles([...e.dataTransfer.files]);
    }
  });

  let toastT = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => t.hidden = true, 3600);
  }

  /* ==========================================================================
     Bootstrapper
     ========================================================================== */
  $('#btnStart').onclick = () => {
    initAudio();
    AC.resume();
    $('#splash').hidden = true;
    showScreen('lobby');
    renderCard();
  };

  let tick = 0;
  // FPS counter
  const fpsEl = document.createElement('div');
  fpsEl.id = 'fps';
  fpsEl.hidden = true;
  document.getElementById('app').appendChild(fpsEl);
  let fpsT = 0, fpsN = 0, fpsMin = 1e9, fpsLast = 0, fpsHz = 0;
  function fpsStep(now) {
    if (fpsLast) { const d = now - fpsLast; fpsMin = Math.min(fpsMin, d); fpsN++; }
    fpsLast = now;
    if (!fpsT) fpsT = now;
    if (now - fpsT >= 500) {
      if (S.showFps) {
        fpsEl.hidden = false;
        const fps = Math.round(fpsN * 1000 / (now - fpsT));
        fpsHz = Math.round(1000 / Math.max(2, fpsMin));
        fpsEl.textContent = fps + ' fps · display ' + fpsHz + ' Hz' + (GL ? ' · ' + (S.noteStyle === 'solid' ? 'solid' : 'legacy') + ' notes' + (dyn.s < 1 ? ' · res ' + Math.round(dyn.s * 100) + '%' : '') : ' · canvas 2D');
      } else fpsEl.hidden = true;
      fpsT = now; fpsN = 0; fpsMin = 1e9;
    }
  }

  function loop(now) {
    requestAnimationFrame(loop);
    fpsStep(now || performance.now());
    tick++;
    if (screen === 'game' && g) {
      if (!(tick & 1)) sampleAudio();
      gameFrame();
    } else {
      sampleAudio();
      kickEnv *= 0.9;
      stepVis(16);
      const slow = S.quality === 'potato';
      if (!(tick & (slow ? 3 : 1)) && (slow || (tick & 1) === 0 || kickVis > 0.05)) drawBg();
      if (screen === 'lobby' && (!slow || !(tick & 1))) {
        drawViz();
        drawMini();
      }
    }
  }

  renderCard();
  Store.ready.then(async () => {
    await refreshLib();
    await syncServerMaps();
    Leaderboard.flush();
    prefetchMaps();
  });
  requestAnimationFrame(loop);

  // Debug handle (Holy shi what you lookin at)
  if (location.hash.includes('debug')) window.RW = {
    get g() { return g; },
    get lib() { return LIB; },
    S,
    addFiles,
    parseSSPM,
    MAX_LATE_TIME,
    gl: !!GL
  };
})();
