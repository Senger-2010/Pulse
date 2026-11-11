/* ==========================================================================
   Render engine
   ========================================================================== */
(function () {
  'use strict';

  const D = 3.4, ZMAX = 46, NOTE = 0.88, CUR = 0.2, HITFADE = 130;
  const PINK = [1.0, 0.24, 0.44], CYAN = [0.21, 0.84, 1.0], GRAY = [0.59, 0.59, 0.67];
  const RAILC = [0.51, 0.39, 1.0], FRAMEC = [0.82, 0.75, 1.0], GRIDC = [0.78, 0.71, 1.0];

  const COMMON = `
precision highp float;
uniform vec2 uRes;      // logical (CSS) size of the canvas
uniform float uF, uD, uS0;
uniform vec2 uCam;      // tunnel parallax (world units); 0 for notes
vec2 proj(vec3 p) {
  float s = uF / (p.z + uD);
  return vec2(p.x * s + uCam.x * (uS0 - s), p.y * s + uCam.y * (uS0 - s));
}
vec4 toClip(vec2 px) { return vec4(px.x / (uRes.x * 0.5), -px.y / (uRes.y * 0.5), 0.0, 1.0); }
`;

  const VS_LINE = `#version 300 es
${COMMON}
layout(location = 0) in vec3 aA;
layout(location = 1) in vec3 aB;
layout(location = 2) in vec4 aCA;
layout(location = 3) in vec4 aCB;
layout(location = 4) in float aW;
out vec4 vC;
out float vSide;
out float vW;
void main() {
  vec2 a = proj(aA), b = proj(aB);
  int id = gl_VertexID;
  float side = ((id & 1) == 0) ? -1.0 : 1.0;
  bool endB = id >= 2;
  vec2 d = b - a;
  float len = length(d);
  d = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-d.y, d.x);
  vec2 p = endB ? b : a;
  p += n * side * aW * 0.5 + d * (endB ? 1.0 : -1.0) * aW * 0.5;
  vC = endB ? aCB : aCA;
  vSide = side;
  vW = aW;
  gl_Position = toClip(p);
}`;

  const FS_LINE = `#version 300 es
precision mediump float;
in vec4 vC;
in float vSide;
in float vW;
uniform float uDpr;
out vec4 o;
void main() {
  float wd = vW * uDpr;
  float cov = clamp(wd * 0.5 * (1.0 - abs(vSide)) + 0.5, 0.0, 1.0);
  o = vec4(vC.rgb * vC.a * cov, 1.0);
}`;

  const VS_QUAD = `#version 300 es
${COMMON}
layout(location = 0) in vec3 aC;
layout(location = 1) in vec2 aH;
layout(location = 2) in vec4 aCol;
out vec4 vC;
void main() {
  int id = gl_VertexID;
  vec2 c = vec2(((id & 1) == 0) ? -1.0 : 1.0, (id >= 2) ? 1.0 : -1.0);
  vC = aCol;
  gl_Position = toClip(proj(vec3(aC.xy + c * aH, aC.z)));
}`;

  const FS_QUAD = `#version 300 es
precision mediump float;
in vec4 vC;
out vec4 o;
void main() { o = vec4(vC.rgb * vC.a, 1.0); }`;

  const VS_NOTE = `#version 300 es
${COMMON}
layout(location = 0) in vec3 aC;
layout(location = 1) in float aH;
layout(location = 2) in vec4 aCol;
layout(location = 3) in vec3 aShape;   // roundness 0..1, fill alpha 0..1, rotation (rad)
uniform mediump float uGlow;
out vec2 vP;
out vec4 vCol;
out vec3 vPar;
void main() {
  int id = gl_VertexID;
  vec2 c = vec2(((id & 1) == 0) ? -1.0 : 1.0, (id >= 2) ? 1.0 : -1.0);
  float s = uF / (aC.z + uD);
  float hpx = aH * s;
  float m = uGlow > 0.5 ? hpx * 0.6 + 8.0 : 1.5;
  vec2 off = c * (hpx + m);
  float cs = cos(aShape.z), sn = sin(aShape.z);
  vec2 pc = proj(aC) + vec2(cs * off.x - sn * off.y, sn * off.x + cs * off.y);
  vP = off;                                   // shape is evaluated in the note's own (unrotated) space
  vCol = aCol;
  vPar = vec3(hpx, aShape.x, aShape.y);
  gl_Position = toClip(pc);
}`;

  const FS_NOTE = `#version 300 es
precision mediump float;
in vec2 vP;
in vec4 vCol;
in vec3 vPar;
uniform mediump float uDpr, uGlow;
out vec4 o;
void main() {
  float hpx = vPar.x;
  float r = clamp(vPar.y, 0.0, 1.0) * hpx;
  vec2 q = abs(vP) - vec2(hpx - r);
  float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;   // signed distance in CSS px
  float cov = clamp(0.5 - sd * uDpr, 0.0, 1.0);
  float bw = max(1.6, hpx * 0.075);
  float rim = clamp((sd + bw) * uDpr + 0.5, 0.0, 1.0) * cov;
  float lit = smoothstep(1.1, -0.2, length(vP) / hpx);
  vec3 body = vCol.rgb * (0.90 + 0.10 * lit);
  vec3 rimC = mix(vCol.rgb, vec3(1.0), 0.45);
  vec3 col = mix(body, rimC, rim * 0.9);
  float fillA = vPar.z;                       // transparency of the inside of the note
  float A = cov * mix(fillA, 1.0, rim) * vCol.a;
  float g = uGlow * exp(-max(sd, 0.0) / (hpx * 0.16 + 2.5)) * 0.30 * (1.0 - cov) * vCol.a;
  o = vec4(col * A + vCol.rgb * g, A);
}`;

  // image cursor
  const VS_IMG = `#version 300 es
${COMMON}
layout(location = 0) in vec2 aP;
layout(location = 1) in vec3 aS;    // half-size (world), alpha, rotation
layout(location = 2) in vec3 aTint;
out vec2 vUV;
out vec4 vC;
void main() {
  int id = gl_VertexID;
  vec2 c = vec2(((id & 1) == 0) ? -1.0 : 1.0, (id >= 2) ? 1.0 : -1.0);
  float s = uF / uD;
  float cs = cos(aS.z), sn = sin(aS.z);
  vec2 off = c * aS.x * s;
  vUV = c * 0.5 + 0.5;
  vC = vec4(aTint, aS.y);
  gl_Position = toClip(proj(vec3(aP, 0.0)) + vec2(cs * off.x - sn * off.y, sn * off.x + cs * off.y));
}`;

  const FS_IMG = `#version 300 es
precision mediump float;
in vec2 vUV;
in vec4 vC;
uniform sampler2D uTex;
out vec4 o;
void main() {
  vec4 t = texture(uTex, vUV);
  float A = t.a * vC.a;
  o = vec4(t.rgb * vC.rgb * A, A);
}`;

  const VS_BG = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  const FS_BG = `#version 300 es
precision mediump float;
uniform vec2 uPix;      // canvas size in device pixels
uniform float uKick, uBass, uFlat;
out vec4 o;
void main() {
  vec2 p = gl_FragCoord.xy / uPix - 0.5;
  p.x *= uPix.x / uPix.y;
  float r = length(p);
  vec3 inner = vec3(0.094, 0.047, 0.204);
  vec3 outer = vec3(0.024, 0.016, 0.051);
  vec3 col = mix(inner, outer, smoothstep(0.0, 0.75, r));
  float pulse = uKick * 0.6 + uBass * 0.25;
  col += vec3(0.30, 0.14, 0.78) * pulse * smoothstep(0.85, 0.0, r) * 0.55;
  col += vec3(0.55, 0.10, 0.30) * uKick * smoothstep(0.55, 0.0, r) * 0.22;
  col = mix(col, outer, uFlat);
  o = vec4(col, 1.0);
}`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader error');
    return s;
  }

  function program(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link error');
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      u[info.name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  }

  // growable instance list
  function makeList(stride) {
    return { d: new Float32Array(stride * 256), n: 0, stride };
  }
  function room(L) {
    if ((L.n + 1) * L.stride > L.d.length) {
      const nd = new Float32Array(L.d.length * 2);
      nd.set(L.d);
      L.d = nd;
    }
  }
  function line(L, ax, ay, az, bx, by, bz, c, a0, a1, w) {
    room(L);
    const d = L.d, o = L.n++ * 15;
    d[o] = ax; d[o + 1] = ay; d[o + 2] = az;
    d[o + 3] = bx; d[o + 4] = by; d[o + 5] = bz;
    d[o + 6] = c[0]; d[o + 7] = c[1]; d[o + 8] = c[2]; d[o + 9] = a0;
    d[o + 10] = c[0]; d[o + 11] = c[1]; d[o + 12] = c[2]; d[o + 13] = a1;
    d[o + 14] = w;
  }
  function rect(L, x, y, z, hx, hy, c, a, w) {
    line(L, x - hx, y - hy, z, x + hx, y - hy, z, c, a, a, w);
    line(L, x + hx, y - hy, z, x + hx, y + hy, z, c, a, a, w);
    line(L, x + hx, y + hy, z, x - hx, y + hy, z, c, a, a, w);
    line(L, x - hx, y + hy, z, x - hx, y - hy, z, c, a, a, w);
  }
  function quad(L, x, y, z, hx, hy, c, a) {
    room(L);
    const d = L.d, o = L.n++ * 9;
    d[o] = x; d[o + 1] = y; d[o + 2] = z;
    d[o + 3] = hx; d[o + 4] = hy;
    d[o + 5] = c[0]; d[o + 6] = c[1]; d[o + 7] = c[2]; d[o + 8] = a;
  }

  // note / circle instance: x y z half-size r g b a roundness fill rotation
  function note(L, x, y, z, h, r, g, b, a, round, fill, rot) {
    room(L);
    const d = L.d, o = L.n++ * 11;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = h;
    d[o + 4] = r; d[o + 5] = g; d[o + 6] = b; d[o + 7] = a;
    d[o + 8] = round; d[o + 9] = fill; d[o + 10] = rot || 0;
  }
  // image cursor instance
  function img(L, x, y, h, a, rot, r, g, b) {
    room(L);
    const d = L.d, o = L.n++ * 8;
    d[o] = x; d[o + 1] = y; d[o + 2] = h; d[o + 3] = a; d[o + 4] = rot; d[o + 5] = r; d[o + 6] = g; d[o + 7] = b;
  }

  function create(canvas, opts) {
    // Compile everything on a throw-away canvas first: a canvas that once gave out a WebGL
    // context can never hand out a 2D context, and the game needs that for its fallback.
    try {
      const probe = document.createElement('canvas').getContext('webgl2');
      if (!probe) return null;
      program(probe, VS_LINE, FS_LINE); program(probe, VS_QUAD, FS_QUAD); program(probe, VS_BG, FS_BG); program(probe, VS_NOTE, FS_NOTE); program(probe, VS_IMG, FS_IMG);
      const lose = probe.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    } catch (e) {
      console.warn('WebGL shaders failed, using canvas 2D:', e.message);
      return null;
    }
    let gl = null;
    try {
      gl = canvas.getContext('webgl2', {
        alpha: false, antialias: false, depth: false, stencil: false,
        desynchronized: !!(opts && opts.desync), powerPreference: 'high-performance', preserveDrawingBuffer: false
      });
    } catch (e) { gl = null; }
    if (!gl) return null;

    let lineP, quadP, bgP, noteP, imgP;
    try {
      lineP = program(gl, VS_LINE, FS_LINE);
      quadP = program(gl, VS_QUAD, FS_QUAD);
      bgP = program(gl, VS_BG, FS_BG);
      noteP = program(gl, VS_NOTE, FS_NOTE);
      imgP = program(gl, VS_IMG, FS_IMG);
    } catch (e) {
      console.warn('WebGL shaders failed, using canvas 2D:', e.message);
      return null;
    }

    // instance buffers + vertex arrays
    const lineVAO = gl.createVertexArray(), lineBuf = gl.createBuffer();
    gl.bindVertexArray(lineVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
    const LS = 15 * 4;
    [[0, 3, 0], [1, 3, 12], [2, 4, 24], [3, 4, 40], [4, 1, 56]].forEach(([loc, size, off]) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, LS, off);
      gl.vertexAttribDivisor(loc, 1);
    });
    const quadVAO = gl.createVertexArray(), quadBuf = gl.createBuffer();
    gl.bindVertexArray(quadVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    const QS = 9 * 4;
    [[0, 3, 0], [1, 2, 12], [2, 4, 20]].forEach(([loc, size, off]) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, QS, off);
      gl.vertexAttribDivisor(loc, 1);
    });
    const noteVAO = gl.createVertexArray(), noteBuf = gl.createBuffer();
    gl.bindVertexArray(noteVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, noteBuf);
    const NS = 11 * 4;
    [[0, 3, 0], [1, 1, 12], [2, 4, 16], [3, 3, 32]].forEach(([loc, size, off]) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, NS, off);
      gl.vertexAttribDivisor(loc, 1);
    });
    const imgVAO = gl.createVertexArray(), imgBuf = gl.createBuffer();
    gl.bindVertexArray(imgVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, imgBuf);
    [[0, 2, 0], [1, 3, 8], [2, 3, 20]].forEach(([loc, size, off]) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 32, off);
      gl.vertexAttribDivisor(loc, 1);
    });
    gl.bindVertexArray(null);
    const bgVAO = gl.createVertexArray();
    const curTex = gl.createTexture();
    let hasImg = false;
    const caps = new Map();      // buffer -> allocated bytes

    function upload(buf, L) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      const bytes = L.n * L.stride * 4;
      let cap = caps.get(buf) || 0;
      if (bytes > cap) {
        cap = Math.max(4096, 1 << Math.ceil(Math.log2(bytes)));
        gl.bufferData(gl.ARRAY_BUFFER, cap, gl.STREAM_DRAW);
        caps.set(buf, cap);
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, L.d, 0, L.n * L.stride);
    }

    const LA = makeList(15), LB = makeList(15), QB = makeList(9);   // A: tunnel (parallax), B: playfield
    const NB = makeList(11), CT = makeList(11), CN = makeList(11), CI = makeList(8); 
    const api = { lost: false, gl };

    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); api.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { api.lost = false; });

    function drawLines(L, f, cam) {
      if (!L.n) return;
      gl.useProgram(lineP.p);
      gl.uniform2f(lineP.u.uRes, f.W, f.H);
      gl.uniform1f(lineP.u.uF, f.F);
      gl.uniform1f(lineP.u.uD, D);
      gl.uniform1f(lineP.u.uS0, f.s0);
      gl.uniform2f(lineP.u.uCam, cam ? f.cam.x : 0, cam ? f.cam.y : 0);
      gl.uniform1f(lineP.u.uDpr, f.dpr);
      gl.bindVertexArray(lineVAO);
      upload(lineBuf, L);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, L.n);
    }
    function drawQuads(L, f) {
      if (!L.n) return;
      gl.useProgram(quadP.p);
      gl.uniform2f(quadP.u.uRes, f.W, f.H);
      gl.uniform1f(quadP.u.uF, f.F);
      gl.uniform1f(quadP.u.uD, D);
      gl.uniform1f(quadP.u.uS0, f.s0);
      gl.uniform2f(quadP.u.uCam, 0, 0);
      gl.bindVertexArray(quadVAO);
      upload(quadBuf, L);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, L.n);
    }

    function drawImg(L, f) {
      if (!L.n || !hasImg) return;
      gl.useProgram(imgP.p);
      gl.uniform2f(imgP.u.uRes, f.W, f.H);
      gl.uniform1f(imgP.u.uF, f.F);
      gl.uniform1f(imgP.u.uD, D);
      gl.uniform1f(imgP.u.uS0, f.s0);
      gl.uniform2f(imgP.u.uCam, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, curTex);
      gl.uniform1i(imgP.u.uTex, 0);
      gl.bindVertexArray(imgVAO);
      upload(imgBuf, L);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, L.n);
      gl.blendFunc(gl.ONE, gl.ONE);
    }

    // cursor image
    api.setCursorImage = function (image) {
      if (!image) { hasImg = false; return; }
      gl.bindTexture(gl.TEXTURE_2D, curTex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      hasImg = true;
    };

    function drawNotes(L, f, glow) {
      if (!L.n) return;
      gl.useProgram(noteP.p);
      gl.uniform2f(noteP.u.uRes, f.W, f.H);
      gl.uniform1f(noteP.u.uF, f.F);
      gl.uniform1f(noteP.u.uD, D);
      gl.uniform1f(noteP.u.uS0, f.s0);
      gl.uniform2f(noteP.u.uCam, 0, 0);
      gl.uniform1f(noteP.u.uDpr, f.dpr);
      gl.uniform1f(noteP.u.uGlow, glow ? 1 : 0);
      gl.bindVertexArray(noteVAO);
      upload(noteBuf, L);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, L.n);
      gl.blendFunc(gl.ONE, gl.ONE);
    }

    function lowerBound(a, ms) {
      let l = 0, h = a.length;
      while (l < h) { const m = (l + h) >> 1; if (a[m].ms < ms) l = m + 1; else h = m; }
      return l;
    }

    /*
      f: { W, H, dpr, t, notes, states, hitAt, approach, cur, trail, cam,
           bass, kick, kicks:{t,s,n}, fx:{glow, rings, kickRings, trail, flat} }
    */
    api.resize = function (W, H, dpr) {
      const w = Math.max(1, Math.round(W * dpr)), h = Math.max(1, Math.round(H * dpr));
      if (canvas.width !== w) canvas.width = w;           // assigning width clears the canvas, so only when it changed
      if (canvas.height !== h) canvas.height = h;
    };

    api.render = function (f) {
      if (api.lost) return;
      const W = f.W, H = f.H, fx = f.fx;
      f.s0 = Math.min(H * 0.17, W * 0.13);
      f.F = f.s0 * D;
      f.dpr = canvas.width / W;
      const vz = ZMAX / f.approach, t = f.t, kick = f.kick || 0, bass = f.bass || 0;
      LA.n = 0; LB.n = 0; QB.n = 0; NB.n = 0; CT.n = 0; CN.n = 0; CI.n = 0;
      const ST = f.style;
      const DRIFT = 1.6, zAt = dt => dt >= 0 ? dt * vz : -DRIFT * (1 - Math.exp(dt * vz / DRIFT));

      const R = 2.7;
      const railA = 0.30 + kick * 0.40 + bass * 0.15;
      for (const [rx, ry] of [[-R, -R], [R, -R], [R, R], [-R, R], [0, -R], [R, 0], [0, R], [-R, 0]]) {
        line(LA, rx, ry, 0, rx, ry, ZMAX, RAILC, Math.min(1, railA), 0, 1.2);
      }
      if (fx.rings) {
        const sp = 7, ph = ((t / 1000) * (ZMAX / (f.approach / 1000)) * 0.35) % sp;
        for (let k = 0; k < 8; k++) {
          const z = k * sp - ph;
          if (z < 0) continue;
          rect(LA, 0, 0, z, R, R, RAILC, (1 - z / ZMAX) * (0.28 + kick * 0.35 + bass * 0.2), 1.2);
        }
      }
      // Kick rings
      const K = f.kicks;
      if (fx.kickRings && K && K.n) {
        for (let i = K.lo; i < K.n; i++) {
          const dt = K.t[i] - t;
          if (dt > f.approach) break;
          if (dt < -60) continue;
          const z = Math.max(0, dt * vz), s = K.s[i];
          const a = Math.min(1, (1 - z / ZMAX) * (0.12 + 0.2 * s));
          rect(LA, 0, 0, z, R, R, PINK, a, 1.5 + 1.2 * s * (1 - z / ZMAX));
        }
      }

      for (let gy = -1; gy <= 1; gy++) for (let gx = -1; gx <= 1; gx++) rect(LB, gx, gy, 0, 0.46, 0.46, GRIDC, 0.17, 1);
      rect(LB, 0, 0, 0, 1.5, 1.5, FRAMEC, Math.min(1, 0.45 + kick * 0.5 + bass * 0.2), 2 + kick * 2);

      /* ---- notes ---- */
      const N = f.notes;
      if (N && N.length) {
        const lo = lowerBound(N, t - 300), hi = Math.min(N.length - 1, lowerBound(N, t + f.approach + 10));
        const h = NOTE / 2;
        if (ST) {
          const hh = h * ST.scale, nc = ST.n, cols = ST.colors;
          for (let i = hi; i >= lo; i--) {
            const n = N[i], z = zAt(n.ms - t), st = f.states[i], x = n.x - 1, y = n.y - 1;
            let k = (i % nc) * 3, r = cols[k], g = cols[k + 1], b = cols[k + 2], a;
            if (st === 1) {
              const age = t - f.hitAt[i];
              if (age < 0 || age >= HITFADE) continue;
              const u = 1 - age / HITFADE;
              a = u * u * ST.opacity;
              note(NB, x, y, z, hh, r, g, b, a, ST.round, ST.fill, 0);
              continue;
            }
            if (z > ZMAX) continue;
            a = Math.min(1, (ZMAX - z) / 14);
            let zn = z;
            if (st === 2) {
              zn = Math.max(-2.39, (n.ms - t) * vz);
              a *= Math.max(0, 1 + zn / 2.4);
              if (a <= 0.01) continue;
              r = 0.55; g = 0.55; b = 0.62;
            }
            note(NB, x, y, zn, hh, r, g, b, a * ST.opacity, ST.round, ST.fill, 0);
          }
        } else
        for (let i = hi; i >= lo; i--) {
          const n = N[i], dt = n.ms - t, z = dt * vz, st = f.states[i], x = n.x - 1, y = n.y - 1;
          let c = (i & 1) ? CYAN : PINK;
          if (st === 1) {
            const age = t - f.hitAt[i];
            if (age >= 0 && age < HITFADE) {
              const u = 1 - age / HITFADE, zh = zAt(dt);
              quad(QB, x, y, zh, h, h, c, u * u * 0.35);
              rect(LB, x, y, zh, h, h, c, u * u, 2.5);
            }
            continue;
          }
          if (z > ZMAX) continue;
          let a = Math.min(1, (ZMAX - z) / 14);
          if (st === 2) {
            a *= Math.max(0, 1 + z / 2.4);
            if (a <= 0.01) continue;
            c = GRAY;
          }
          const s = f.F / (z + D), lw = Math.max(1.5, s * 0.06);
          rect(LB, x, y, z + 0.45, h, h, c, a * 0.35, 1.2);                 // back face
          line(LB, x - h, y - h, z, x - h, y - h, z + 0.45, c, a * 0.3, a * 0.3, 1.2);
          line(LB, x + h, y - h, z, x + h, y - h, z + 0.45, c, a * 0.3, a * 0.3, 1.2);
          line(LB, x + h, y + h, z, x + h, y + h, z + 0.45, c, a * 0.3, a * 0.3, 1.2);
          line(LB, x - h, y + h, z, x - h, y + h, z + 0.45, c, a * 0.3, a * 0.3, 1.2);
          quad(QB, x, y, z, h, h, c, a * 0.2);                              // glass face
          if (fx.glow && s > f.s0 * 0.25) rect(LB, x, y, z, h, h, c, a * 0.16, lw * 4);
          rect(LB, x, y, z, h, h, c, a, lw);                                // front edge
        }
      }

      /* ---- cursor (circle / square / image) ---- */
      const C = f.cursor;
      if (C) {
        const hc = CUR / 2 * C.scale, shape = C.shape === 2 && hasImg ? 2 : (C.shape === 1 ? 1 : 0), rd = shape === 1 ? 0.12 : 1;
        const T = C.trail, tn = C.tn | 0;
        for (let i = 0; i < tn; i++) {
          const px = T[i * 4], py = T[i * 4 + 1], sc = T[i * 4 + 2], al = T[i * 4 + 3];
          if (shape === 2) img(CI, px, py, hc * sc, al, C.ang, C.r, C.g, C.b);
          else note(CT, px, py, 0, hc * sc, C.r, C.g, C.b, al, rd, 1, C.ang);
        }
        if (shape === 2) img(CI, C.x, C.y, hc, 1, C.ang, C.r, C.g, C.b);
        else note(CN, C.x, C.y, 0, hc, C.r, C.g, C.b, 1, rd, 1, C.ang);
      }

      /* ---- draw ---- */
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.disable(gl.BLEND);
      gl.useProgram(bgP.p);
      gl.uniform2f(bgP.u.uPix, canvas.width, canvas.height);
      gl.uniform1f(bgP.u.uKick, fx.kickBg ? kick : 0);
      gl.uniform1f(bgP.u.uBass, fx.kickBg ? bass : 0);
      gl.uniform1f(bgP.u.uFlat, fx.flat ? 1 : 0);
      gl.bindVertexArray(bgVAO);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      drawLines(LA, f, true);
      drawLines(LB, f, false);
      drawQuads(QB, f);
      if (ST) drawNotes(NB, f, fx.glow);
      drawNotes(CT, f, false);
      drawImg(CI, f);
      drawNotes(CN, f, fx.glow);
    };

    return api;
  }

  window.PulseGL = { create };
})();
