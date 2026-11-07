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
  // Adjustable timing window limit (in milliseconds) - adjustable only in script.js
  const MAX_LATE_TIME = 70;

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
    quality: 'balanced'
  };

  const qCap = () => S.quality === 'high' ? 2 : S.quality === 'low' ? 1 : 1.25;
  const REDUCE = matchMedia('(prefers-reduced-motion: reduce)');
  const S = { ...DEF };

  // Load Saved Settings from LocalStorage
  try {
    Object.assign(S, JSON.parse(localStorage.getItem('rw-settings') || '{}'));
  } catch (e) {}

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
     Leaderboard (stored on the server via the Netlify Function /api/scores,
     with a local cache + retry queue so the game still works offline)
     ========================================================================== */
  let currentPlayer = {
    name: localStorage.getItem('oh-player-name') || '',
    school: localStorage.getItem('oh-player-school') || ''
  };

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

    // Network problems, a missing API (404) and 5xx are worth retrying later.
    const retryable = err => !err.status || err.status === 404 || err.status >= 500;

    // Merge an entry into a cached list the same way the server does.
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
      // Last known scores for a map, or null if we've never seen any.
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

      // Upload scores that were saved while the server was unreachable.
      async flush() {
        if (flushing) return;
        flushing = true;
        try {
          let q = readLS(PENDING_KEY, []);
          while (q.length) {
            try {
              await post(q[0]);
            } catch (err) {
              if (retryable(err)) break; // still offline, try again later
            }
            q = q.slice(1); // sent, or rejected for good
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
        return data;
      }
    };
  })();

  // Console tools for the organiser:
  //   rwLeaderboard.setKey('your ADMIN_KEY')
  //   rwLeaderboard.clearMap('Map name or id')   rwLeaderboard.deleteName('Alex')
  //   rwLeaderboard.deleteEntry('Map name or id', 'Alex', 'School')   rwLeaderboard.clearAll()
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

    return { meta, notes, audio: { bytes, mime } };
  }

  function classify(m) {
    if (m.diff === 1 || m.diff === 2) return m.diff === 1 ? 'easy' : 'hard';
    if (m.diff === 3) return 'hard';
    if (m.diff === 4) return 'insane';
    if (m.diff >= 5) return 'death';
    return m.nps < 3.5 ? 'easy' : m.nps < 6 ? 'hard' : m.nps < 9.5 ? 'insane' : 'death';
  }

  /* ==========================================================================
     Storage Subsystem (IndexedDB with Memory Fallback)
     Blobs are stored with a version tag so a replaced server map is re-downloaded.
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

    // A stored blob is valid if no version is requested/stored, or the versions match.
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
    // Apply difficulty overrides from local storage
    for (const m of LIB) {
      const savedFolder = DiffOverrides.get(m.id);
      if (savedFolder) m.folder = savedFolder;
    }
    LIB.sort((a, b) => a.name.localeCompare(b.name));
    renderCounts();
    renderLibrary();
  }

  /* ==========================================================================
     Server Maps (public/maps/ -> maps-manifest.json)
     The manifest is generated at build time (scripts/build-manifest.mjs) and carries
     each map's metadata, so the lobby is instant and a song is only downloaded when
     it is first previewed/played (and then cached in IndexedDB).
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

  // URLs (they include the content hash) that failed to parse
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
          // No metadata in the manifest: download + parse once, then remember it.
          prev = LIB.find(m => m.source === 'server' && m.remote === url) || null;
          if (prev) { seen.add(prev.id); continue; }
          if (BadMaps.has(url)) continue;
          const res = await fetch(url);
          if (!res.ok) continue;
          const buf = await res.arrayBuffer();
          try {
            meta = parseSSPM(buf).meta;
          } catch (e) {
            BadMaps.add(url); // don't re-download a corrupt file on every visit
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
        if (prev) seen.add(prev.id); // don't drop a working map because of a transient error
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

  // Download one map (or read it from the cache). Concurrent callers share one request.
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
      url: null,
      decoded: null,
      pStart: Math.max(0, p.notes[i].ms - 1500) / 1000
    };

    ENT.set(meta.id, e);
    while (ENT.size > 3) {
      const k = ENT.keys().next().value;
      const o = ENT.get(k);
      if (o.url) URL.revokeObjectURL(o.url);
      ENT.delete(k);
    }
    return e;
  }

  /* ==========================================================================
     Audio Processing Subsystem (Web Audio API)
     ========================================================================== */
  let AC = null, master, analyser, sfx, previewEl, previewGain, freq = new Uint8Array(512), bass = 0;

  function initAudio() {
    if (AC) return;
    AC = new (window.AudioContext || window.webkitAudioContext)();

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
  }

  function blip(kind) {
    if (!AC || S.sfx <= 0.001) return;
    const o = AC.createOscillator();
    const g = AC.createGain();
    const t = AC.currentTime;

    if (kind === 'hit') {
      o.type = 'triangle';
      o.frequency.setValueAtTime(1500, t);
      o.frequency.exponentialRampToValueAtTime(700, t + 0.05);
      g.gain.setValueAtTime(0.5, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
      o.start(t);
      o.stop(t + 0.08);
    } else {
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(70, t + 0.14);
      g.gain.setValueAtTime(0.35, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      o.start(t);
      o.stop(t + 0.17);
    }
    o.connect(g);
    g.connect(sfx);
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

      // Hover leaderboard: show what we know right away, then refresh from the server
      paintCardBoard(Leaderboard.peek(m.id));
      Leaderboard.get(m.id).then(r => {
        if (hov && hov.meta && hov.meta.id === m.id) paintCardBoard(r.scores);
      });
    }
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
        bass,
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
    const dpr = 1, w = innerWidth, h = innerHeight;
    if (bgC.width !== Math.round(w * dpr) || bgC.height !== Math.round(h * dpr)) {
      bgC.width = Math.round(w * dpr);
      bgC.height = Math.round(h * dpr);
    }
    bgX.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawScene(bgX, w, h, {
      t: performance.now(),
      notes: null,
      approach: 1400,
      bass,
      lowFx: S.quality === 'low'
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
  const cv = $('#game'), cx = cv.getContext('2d');
  let g = null, gW = 0, gH = 0, gDpr = 1;

  function sizeGame() {
    gDpr = Math.min(qCap(), devicePixelRatio || 1);
    gW = innerWidth;
    gH = innerHeight;
    cv.width = Math.round(gW * gDpr);
    cv.height = Math.round(gH * gDpr);
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
    $('#bg').hidden = s === 'game';
    if (s === 'game') sizeGame();
  }

  async function decode(e) {
    if (!e.decoded) {
      for (const o of ENT.values()) if (o !== e) o.decoded = null;
      e.decoded = AC.decodeAudioData(e.audio.bytes.slice().buffer);
      e.decoded.catch(() => { e.decoded = null; });
    }
    return e.decoded;
  }

  function setLoading(on, name) {
    $('#loading').hidden = !on;
    if (on) $('#loadName').textContent = name || '';
  }

  async function startGame(meta) {
    initAudio();
    const resume = AC.resume();
    clearInterval(backTimer);
    $('#results').hidden = true;
    $('#pause').hidden = true;

    showScreen('game');
    cx.setTransform(1, 0, 0, 1, 0, 0);
    cx.fillStyle = '#06040d';
    cx.fillRect(0, 0, cv.width, cv.height);

    if (S.mouse !== 'free') requestLock();
    hovTok++;
    fadePreview();
    setLoading(true, meta.name);

    try {
      const e = await loadEntry(meta);
      const buf = await decode(e);
      await resume;
      beginGame(e, buf);
    } catch (err) {
      toast('Could not load map: ' + err.message);
      toLobby();
    }
    setLoading(false);
  }

  function beginGame(e, buf) {
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
      approach: S.approach,
      buf,
      startCtx: 0,
      src: null,
      gain: null,
      countdown: 0,
      cdStart: 0,
      cam: { x: 0, y: 0 },
      lastF: performance.now(),
      lastMs: e.notes[N - 1].ms,
      auto: location.hash === '#auto',
      hadLock: false,
      s0: 100,
      lockWatch: performance.now()
    };
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

  addEventListener('mousemove', e => {
    if (!g || g.over || g.paused) return;
    if (locked()) {
      g.hadLock = true;
      const k = 0.005 * S.sens;
      g.cur.x = clamp(g.cur.x + e.movementX * k, -CLAMP, CLAMP);
      g.cur.y = clamp(g.cur.y + e.movementY * k, -CLAMP, CLAMP);
    } else {
      g.cur.x = clamp((e.clientX - gW / 2) / g.s0, -CLAMP, CLAMP);
      g.cur.y = clamp((e.clientY - gH / 2) / g.s0, -CLAMP, CLAMP);
    }
  });

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
    if (S.mouse !== 'free') requestLock();
    g.countdown = 3000;
    g.cdStart = performance.now();
  }

  // Hit Detection & Logic Judge
  function judge(t) {
    const N = g.notes, st = g.states;
    for (let i = g.lo; i < g.N; i++) {
      const n = N[i];
      if (st[i] !== 0) continue;

      // Restrict note processing if it exceeds max late time (MAX_LATE_TIME = 70ms)
      if (t > n.ms + MAX_LATE_TIME) {
        st[i] = 2; // Miss
        g.misses++;
        g.combo = 0;
        g.hp -= HP_MISS;
        g.lastMiss = performance.now();
        g.events.push({ t: n.ms, h: 0 });
        blip('miss');
        continue;
      }

      if (n.ms > t + MAX_LATE_TIME) break;

      if (Math.abs(n.x - 1 - g.cur.x) <= (NOTE + CUR) / 2 && Math.abs(n.y - 1 - g.cur.y) <= (NOTE + CUR) / 2) {
        st[i] = 1;
        g.hitAt[i] = t;
        g.hits++;
        g.combo++;
        if (g.combo > g.maxCombo) g.maxCombo = g.combo;

        g.score += 100 * (1 + Math.min(7, Math.floor(g.combo / 15)));
        g.hp = Math.min(HPMAX, g.hp + HP_HIT);
        g.lastHit = t;
        g.events.push({ t: n.ms, h: 1 });
        blip('hit');
      }
    }
    while (g.lo < g.N && st[g.lo] !== 0) g.lo++;
  }

  function updateGame(t) {
    if (g.auto) g.cur = autoCursor(g.notes, t);
    judge(t);
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

    cx.setTransform(gDpr, 0, 0, gDpr, 0, 0);
    const nowF = performance.now();
    const dtF = Math.min(100, nowF - g.lastF);
    g.lastF = nowF;

    const still = REDUCE.matches;
    const k = 1 - Math.exp(-dtF / 140);

    g.cam.x += ((still ? 0 : g.cur.x * 0.09) - g.cam.x) * k;
    g.cam.y += ((still ? 0 : g.cur.y * 0.09) - g.cam.y) * k;

    const o = {
      t,
      notes: g.notes,
      states: g.states,
      hitAt: g.hitAt,
      approach: g.approach,
      bass,
      cursor: g.cur,
      trail: g.trail,
      cam: g.cam,
      lowFx: S.quality === 'low'
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
    c.fillText('ESC pause', W - pad, pad + big * 1.3);

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
    submitScore(g, win, acc, grade, prog);

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

  async function submitScore(gg, win, acc, grade, prog) {
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
      el.textContent = 'Rank #' + r.rank + ' · your best here is ' + fmt(r.best);
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

  // Event Handlers for Navigation Controls
  $('#btnBack').onclick = toLobby;
  $('#btnReplay').onclick = () => { const m = g.meta; g.over = true; startGame(m); };
  $('#pResume').onclick = resumeGame;
  $('#pRestart').onclick = () => { const m = g.meta; stopSource(); g.over = true; startGame(m); };
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
        <tr><th>#</th><th>Player</th><th>School</th><th>Score</th><th>Acc</th><th>Combo</th><th>Grade</th></tr>
      </thead>
      <tbody>`;

    scores.forEach((s, idx) => {
      const mine = (s.name + '|' + s.school).toLowerCase() === me;
      html += `<tr class="${mine ? 'me' : ''}">
        <td>${idx + 1}</td>
        <td><b>${esc(s.name)}</b></td>
        <td>${esc(s.school)}</td>
        <td>${fmt(s.score)}</td>
        <td>${Number(s.acc).toFixed(2)}%</td>
        <td>x${s.maxCombo}</td>
        <td>${esc(s.grade || '-')}${s.cleared === false ? ' <small>(failed)</small>' : ''}</td>
      </tr>`;
    });

    listEl.innerHTML = html + '</tbody></table>';
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
  function loop() {
    requestAnimationFrame(loop);
    tick++;
    if (screen === 'game' && g) {
      if (!(tick & 1)) sampleAudio();
      gameFrame();
    } else {
      sampleAudio();
      if (!(tick & 1)) drawBg();
      if (screen === 'lobby') {
        drawViz();
        drawMini();
      }
    }
  }

  renderCard();
  Store.ready.then(async () => {
    await refreshLib();       // instant: whatever is cached from last visit
    await syncServerMaps();   // then pick up new/changed/removed maps from /maps/
    Leaderboard.flush();      // upload any scores saved while offline
    prefetchMaps();           // warm the cache in the background
  });
  requestAnimationFrame(loop);

  window.RW = {
    get g() { return g; },
    get lib() { return LIB; },
    S,
    addFiles,
    parseSSPM,
    MAX_LATE_TIME
  };
})();
