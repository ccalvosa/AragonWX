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
    return { xy, a: sol.slice(0, n), mu: sol[n], cov };
  }

  function predict(m, lat, lon) {
    const [x, y] = proj(lat, lon);
    let s = m.mu;
    for (let i = 0; i < m.a.length; i++) s += m.a[i] * m.cov(Math.hypot(x - m.xy[i][0], y - m.xy[i][1]));
    return s;
  }

  function insidePoly(rings, lat, lon) {
    let inside = false;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  }

  const maskCache = new Map();
  const mercY = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
  const invMercY = y => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;

  /**
   * points: [{lat, lon, v}] · rings: anillos exteriores [[lon,lat],…] para recortar
   * opts: {scale, kind: "temp"|"prec"|"wind"|..., bbox:[[s,w],[n,e]], step}
   * Devuelve {url, bounds, n} o null.
   */
  function surface(points, rings, opts) {
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
    if (!m) return null;
    const [[S, W], [N, E]] = opts.bbox || [[39.84, -2.18], [42.94, 0.78]];
    const step = opts.step || 0.015;
    const cols = Math.round((E - W) / step), y0 = mercY(S), y1 = mercY(N);
    const rows = Math.round((y1 - y0) / (step * Math.PI / 180));
    const cv = document.createElement("canvas");
    cv.width = cols; cv.height = rows;
    const ctx = cv.getContext("2d"), img = ctx.createImageData(cols, rows);
    const mkey = `${cols}x${rows}:${S},${W},${N},${E}`;
    if (!maskCache.has(mkey)) {
      const mask = new Uint8Array(cols * rows);
      for (let r = 0; r < rows; r++) {
        const lat = invMercY(y1 - (r + 0.5) * (y1 - y0) / rows);
        for (let c = 0; c < cols; c++) mask[r * cols + c] = !rings || insidePoly(rings, lat, W + (c + 0.5) * step) ? 1 : 0;
      }
      maskCache.set(mkey, mask);
    }
    const mask = maskCache.get(mkey);
    const cache = new Map();
    const rgb = c => {
      if (!cache.has(c)) { const h = c.slice(1); cache.set(c, [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]); }
      return cache.get(c);
    };
    for (let r = 0; r < rows; r++) {
      const lat = invMercY(y1 - (r + 0.5) * (y1 - y0) / rows);
      for (let c = 0; c < cols; c++) {
        const lon = W + (c + 0.5) * step;
        if (!mask[r * cols + c]) continue;
        let v = predict(m, lat, lon);
        if (kind === "prec" || kind === "wind" || kind === "hum") v = Math.max(0, v);
        if (kind === "prec" && v < 0.1) continue;
        const [R, G, B] = rgb(colorFor(opts.scale, v));
        const k = (r * cols + c) * 4;
        img.data[k] = R; img.data[k + 1] = G; img.data[k + 2] = B; img.data[k + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return { url: cv.toDataURL("image/png"), bounds: [[S, W], [N, E]], n: pts.length };
  }

  return { surface };
})();
