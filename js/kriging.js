/* ==========================================================
   Interpolación por krigeado ordinario (variograma exponencial)
   en su forma dual: se resuelve un único sistema (n+1)×(n+1) y cada
   punto de la rejilla cuesta O(n). Antes se desagrupan las estaciones
   en celdas de ~8 km (mediana) para que las ciudades con decenas de
   estaciones no dominen y el sistema sea pequeño.
   ========================================================== */

const Interp = (() => {
  const LAT0 = 41.4, KX = 111.32 * Math.cos(LAT0 * Math.PI / 180), KY = 110.57;
  const proj = (lat, lon) => [lon * KX, lat * KY];

  function median(a) {
    const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /* desagrupado: mediana por celda */
  function decluster(points, cell) {
    const cells = new Map();
    for (const p of points) {
      const k = Math.floor(p.lat / cell) + ":" + Math.floor(p.lon / cell);
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(p);
    }
    const out = [];
    for (const arr of cells.values()) {
      out.push({ lat: median(arr.map(p => p.lat)), lon: median(arr.map(p => p.lon)), v: median(arr.map(p => p.v)) });
    }
    return out;
  }

  /* quita celdas muy distintas de sus vecinas (estaciones mal situadas o averiadas) */
  function despike(pts, radiusKm, tol) {
    const xy = pts.map(p => proj(p.lat, p.lon));
    return pts.filter((p, i) => {
      const nb = [];
      for (let j = 0; j < pts.length; j++) {
        if (i === j) continue;
        const dx = xy[i][0] - xy[j][0], dy = xy[i][1] - xy[j][1];
        if (dx * dx + dy * dy < radiusKm * radiusKm) nb.push(pts[j].v);
      }
      if (nb.length < 3) return true;
      return Math.abs(p.v - median(nb)) <= tol;
    });
  }

  function solve(A, b) {   // eliminación gaussiana con pivoteo parcial (A se modifica)
    const n = b.length;
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      if (Math.abs(A[p][c]) < 1e-12) return null;
      [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
      for (let r = c + 1; r < n; r++) {
        const f = A[r][c] / A[c][c];
        if (!f) continue;
        for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const x = new Array(n);
    for (let r = n - 1; r >= 0; r--) {
      let s = b[r];
      for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
      x[r] = s / A[r][r];
    }
    return x;
  }

  function train(pts, rangeKm, nuggetFrac) {
    const n = pts.length;
    const xy = pts.map(p => proj(p.lat, p.lon));
    const mean = pts.reduce((s, p) => s + p.v, 0) / n;
    let sill = pts.reduce((s, p) => s + (p.v - mean) ** 2, 0) / n;
    if (sill < 1e-6) sill = 1;
    const nug = nuggetFrac * sill;
    const cov = h => (h === 0 ? sill : (sill - nug) * Math.exp(-3 * h / rangeKm));
    const A = [];
    for (let i = 0; i <= n; i++) A.push(new Float64Array(n + 1));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        A[i][j] = cov(Math.hypot(xy[i][0] - xy[j][0], xy[i][1] - xy[j][1]));
      }
      A[i][n] = 1; A[n][i] = 1;
    }
    A[n][n] = 0;
    const b = pts.map(p => p.v); b.push(0);
    const sol = solve(A.map(r => Array.from(r)), b);
    if (!sol) return null;
    const a = sol.slice(0, n);
    // forma rápida para predecir: coordenadas planas y pesos ya multiplicados por la covarianza
    const X = Float64Array.from(xy, p => p[0]), Y = Float64Array.from(xy, p => p[1]);
    const Wc = Float64Array.from(a, v => v * (sill - nug)), W0 = Float64Array.from(a, v => v * sill);
    return { xy, a, mu: sol[n], cov, X, Y, Wc, W0, k: -3 / rangeKm };
  }

  function predict(m, lat, lon) {
    const x = lon * KX, y = lat * KY, { X, Y, Wc, W0, k } = m, n = X.length;
    let s = m.mu;
    for (let i = 0; i < n; i++) {
      const dx = x - X[i], dy = y - Y[i], d2 = dx * dx + dy * dy;
      s += d2 === 0 ? W0[i] : Wc[i] * Math.exp(k * Math.sqrt(d2));
    }
    return s;
  }


  /** Ajusta el modelo a las estaciones. Devuelve {m, n, kind, scale} o null si hay pocas. */
  function fit(points, opts) {
    const kind = opts.kind || "temp";
    let pts = decluster(points.filter(p => Number.isFinite(p.v)), opts.cell || 0.07);
    if (kind === "temp") pts = despike(pts, 25, 6);
    else if (kind === "wind") pts = despike(pts, 25, 35);
    if (pts.length < 5) return null;
    if (pts.length > 420) {   // límite para que el sistema se resuelva en < 1 s
      pts.sort(() => Math.random() - 0.5);
      pts = pts.slice(0, 420);
    }
    const m = train(pts, opts.rangeKm || (kind === "prec" ? 35 : 60), opts.nugget ?? 0.08);
    return m ? { m, n: pts.length, kind, scale: opts.scale } : null;
  }

  /* Capa que evalúa el krigeado sobre la zona visible en cada zoom o desplazamiento:
     rejilla de pantalla de unos 22 000 nodos como máximo (≥ 6 px; el campo es suave), interpolación bilineal del valor hasta cada
     píxel, color por tramos y recorte exacto con el contorno de Aragón. */
  const MAXNODES = 22000;
  const Layer = L.Layer.extend({
    initialize(model, rings, opts = {}) { this._mod = model; this._rings = rings; this._opacity = opts.opacity ?? 0.62; },
    onAdd(map) {
      this._map = map;
      this._cv = L.DomUtil.create("canvas", "interp-canvas leaflet-zoom-hide");
      this._cv.style.opacity = this._opacity;
      map.getPane("interp").appendChild(this._cv);
      map.on("moveend zoomend resize viewreset", this._draw, this);
      map.on("zoomstart", this._hide, this);
      this._draw();
    },
    onRemove(map) {
      map.off("moveend zoomend resize viewreset", this._draw, this);
      map.off("zoomstart", this._hide, this);
      this._cv.remove();
    },
    _hide() { this._cv.style.visibility = "hidden"; },
    _draw() {
      const map = this._map, cv = this._cv, { m, kind, scale } = this._mod;
      const size = map.getSize(), pad = 0.15;
      const px = Math.round(size.x * pad), py = Math.round(size.y * pad);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = size.x + 2 * px, H = size.y + 2 * py, cw = Math.round(W * dpr), ch = Math.round(H * dpr);
      cv.width = cw; cv.height = ch; cv.style.width = W + "px"; cv.style.height = H + "px";
      const origin = map.containerPointToLayerPoint([-px, -py]);
      L.DomUtil.setPosition(cv, origin);
      // rejilla gruesa (en píxeles de pantalla) sobre la vista ∩ Aragón
      const [[S0, W0], [N0, E0]] = [[39.84, -2.18], [42.94, 0.78]];
      const p0 = map.latLngToContainerPoint([N0, W0]), p1 = map.latLngToContainerPoint([S0, E0]);
      const gx0 = Math.max(-px, Math.floor(p0.x)), gy0 = Math.max(-py, Math.floor(p0.y));
      const gx1 = Math.min(size.x + px, Math.ceil(p1.x)), gy1 = Math.min(size.y + py, Math.ceil(p1.y));
      const ctx = cv.getContext("2d");
      if (gx1 <= gx0 || gy1 <= gy0) { cv.style.visibility = "visible"; return; }
      const CELL = Math.max(6, Math.ceil(Math.sqrt((gx1 - gx0) * (gy1 - gy0) / MAXNODES)));
      const nx = Math.ceil((gx1 - gx0) / CELL) + 1, ny = Math.ceil((gy1 - gy0) / CELL) + 1;
      const G = new Float32Array(nx * ny);
      let vmin = Infinity, vmax = -Infinity;
      for (let j = 0; j < ny; j++) {
        const lat = map.containerPointToLatLng([gx0, gy0 + j * CELL]).lat;
        for (let i = 0; i < nx; i++) {
          const lon = map.containerPointToLatLng([gx0 + i * CELL, gy0 + j * CELL]).lng;
          let v = predict(m, lat, lon);
          if (kind === "prec" || kind === "wind" || kind === "hum") v = Math.max(0, v);
          G[j * nx + i] = v;
          if (v < vmin) vmin = v;
          if (v > vmax) vmax = v;
        }
      }
      // tabla de color por valor (por tramos, como la leyenda)
      const NL = 2048, span = Math.max(vmax - vmin, 1e-6), lut = new Uint8ClampedArray(NL * 4);
      for (let k = 0; k < NL; k++) {
        const v = vmin + span * k / (NL - 1);
        if (kind === "prec" && v < 0.1) continue;
        const h = colorFor(scale, v);
        lut[k * 4] = parseInt(h.slice(1, 3), 16); lut[k * 4 + 1] = parseInt(h.slice(3, 5), 16);
        lut[k * 4 + 2] = parseInt(h.slice(5, 7), 16); lut[k * 4 + 3] = 255;
      }
      const img = ctx.createImageData(cw, ch), out = img.data;
      const X0 = (gx0 + px) * dpr, Y0 = (gy0 + py) * dpr, X1 = (gx1 + px) * dpr, Y1 = (gy1 + py) * dpr, cell = CELL * dpr;
      for (let y = Math.max(0, Math.floor(Y0)); y < Math.min(ch, Math.ceil(Y1)); y++) {
        const fy = (y + 0.5 - Y0) / cell, j0 = Math.min(ny - 2, Math.max(0, Math.floor(fy))), ty = Math.min(1, Math.max(0, fy - j0));
        let o = (y * cw + Math.max(0, Math.floor(X0))) * 4;
        for (let x = Math.max(0, Math.floor(X0)); x < Math.min(cw, Math.ceil(X1)); x++, o += 4) {
          const fx = (x + 0.5 - X0) / cell, i0 = Math.min(nx - 2, Math.max(0, Math.floor(fx))), tx = Math.min(1, Math.max(0, fx - i0));
          const a = G[j0 * nx + i0], b = G[j0 * nx + i0 + 1], c = G[(j0 + 1) * nx + i0], d = G[(j0 + 1) * nx + i0 + 1];
          const v = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
          const k = Math.round((v - vmin) / span * (NL - 1)) * 4;
          if (!lut[k + 3]) continue;
          out[o] = lut[k]; out[o + 1] = lut[k + 1]; out[o + 2] = lut[k + 2]; out[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      // recorte exacto con el contorno de Aragón (en coordenadas de pantalla)
      if (this._rings) {
        ctx.globalCompositeOperation = "destination-in";
        ctx.beginPath();
        for (const ring of this._rings) {
          ring.forEach(([lo, la], k) => {
            const p = map.latLngToContainerPoint([la, lo]);
            const X = (p.x + px) * dpr, Y = (p.y + py) * dpr;
            k ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
          });
          ctx.closePath();
        }
        ctx.fillStyle = "#000";
        ctx.fill();
        ctx.globalCompositeOperation = "source-over";
      }
      cv.style.visibility = "visible";
    },
  });

  return { fit, Layer };
})();
