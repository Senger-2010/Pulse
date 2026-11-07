/* ==========================================================================
   Pulse! WebGL2 playfield renderer
   - Real perspective projection done in the vertex shader (3D tunnel, cubes)
   - Thick anti-aliased lines and quads are drawn as GPU instances
   - Additive blending gives the neon glow without any blur passes
   - Returns null when WebGL2 is unavailable so script.js falls back to canvas 2D
   ========================================================================== */
(function () {
  'use strict';

  const D = 3.4, ZMAX = 46, NOTE = 0.88, CUR = 0.2;
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

  // Growable instance list (a flat Float32Array)
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

  function create(canvas) {
    let gl = null;
    try {
      gl = canvas.getContext('webgl2', {
        alpha: false, antialias: false, depth: false, stencil: false,
        desynchronized: true, powerPreference: 'high-performance', preserveDrawingBuffer: false
      });
    } catch (e) { gl = null; }
    if (!gl) return null;

    let lineP, quadP, bgP;
    try {
      lineP = program(gl, VS_LINE, FS_LINE);
      quadP = program(gl, VS_QUAD, FS_QUAD);
      bgP = program(gl, VS_BG, FS_BG);
    } catch (e) {
      console.warn('WebGL shaders failed, using canvas 2D:', e.message);
      return null;
    }

    // Instance buffers + vertex arrays
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
    gl.bindVertexArray(null);
    const bgVAO = gl.createVertexArray();

    const LA = makeList(15), LB = makeList(15), QB = makeList(9);   // A: tunnel (parallax), B: playfield
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
      gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
      gl.bufferData(gl.ARRAY_BUFFER, L.d.subarray(0, L.n * 15), gl.STREAM_DRAW);
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
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.bufferData(gl.ARRAY_BUFFER, L.d.subarray(0, L.n * 9), gl.STREAM_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, L.n);
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
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
    };

    api.render = function (f) {
      if (api.lost) return;
      const W = f.W, H = f.H, fx = f.fx;
      f.s0 = Math.min(H * 0.17, W * 0.13);
      f.F = f.s0 * D;
      f.dpr = canvas.width / W;
      const vz = ZMAX / f.approach, t = f.t, kick = f.kick || 0, bass = f.bass || 0;
      LA.n = 0; LB.n = 0; QB.n = 0;

      /* ---- tunnel (moves with the parallax camera) ---- */
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
      // Kick rings travel down the tunnel and land on the grid exactly on the beat
      const K = f.kicks;
      if (fx.kickRings && K && K.n) {
        for (let i = K.lo; i < K.n; i++) {
          const dt = K.t[i] - t;
          if (dt > f.approach) break;
          if (dt < -60) continue;
          const z = Math.max(0, dt * vz), s = K.s[i];
          const a = Math.min(1, (1 - z / ZMAX) * (0.35 + 0.5 * s));
          rect(LA, 0, 0, z, R, R, PINK, a, 2 + 2.5 * s * (1 - z / ZMAX));
        }
      }

      /* ---- grid at the hit plane ---- */
      for (let gy = -1; gy <= 1; gy++) for (let gx = -1; gx <= 1; gx++) rect(LB, gx, gy, 0, 0.46, 0.46, GRIDC, 0.17, 1);
      rect(LB, 0, 0, 0, 1.5, 1.5, FRAMEC, Math.min(1, 0.45 + kick * 0.5 + bass * 0.2), 2 + kick * 2);

      /* ---- notes ---- */
      const N = f.notes;
      if (N && N.length) {
        const lo = lowerBound(N, t - 150), hi = Math.min(N.length - 1, lowerBound(N, t + f.approach + 10));
        const h = NOTE / 2;
        for (let i = hi; i >= lo; i--) {
          const n = N[i], dt = n.ms - t, z = dt * vz, st = f.states[i], x = n.x - 1, y = n.y - 1;
          let c = (i & 1) ? CYAN : PINK;
          if (st === 1) {
            const age = t - f.hitAt[i];
            if (age >= 0 && age < 110) {          // same size as the note, fades out fast
              const u = 1 - age / 110;
              quad(QB, x, y, 0, h, h, c, u * 0.35);
              rect(LB, x, y, 0, h, h, c, u, 2.5);
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

      /* ---- cursor ---- */
      if (f.cur) {
        const hc = CUR / 2;
        if (fx.trail && f.trail) {
          for (let i = 0; i < f.trail.length; i++) {
            const u = (i + 1) / f.trail.length, hh = hc * (0.5 + u * 0.5);
            quad(QB, f.trail[i].x, f.trail[i].y, 0, hh, hh, CYAN, u * 0.22);
          }
        }
        if (fx.glow) rect(LB, f.cur.x, f.cur.y, 0, hc, hc, CYAN, 0.25, 7);
        quad(QB, f.cur.x, f.cur.y, 0, hc, hc, [1, 1, 1], 1);
        rect(LB, f.cur.x, f.cur.y, 0, hc, hc, CYAN, 1, 2);
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
    };

    return api;
  }

  window.PulseGL = { create };
})();
