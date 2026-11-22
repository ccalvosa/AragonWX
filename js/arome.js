/* ==========================================================
   AROME France HD 1,3 km (Météo-France) sobre el mapa.

   Los PNG traen un valor codificado por píxel (escala de grises,
   255 = sin dato) en una rejilla de 0,01° cuyas filas ya están
   reproyectadas a Mercator. No se estiran como imagen: una capa
   propia pinta cada píxel de la pantalla interpolando (bilineal)
   entre los puntos de la rejilla y coloreando con una escala
   continua. Así el campo se ve nítido a cualquier zoom.

   Lo publica scraper/aragonwx/arome.py en la rama «arome».
   ========================================================== */

const Arome = (() => {
  const VARS = {
    pr1:  { label: "Lluvia en 1 hora", unit: "mm", scale: "prec1h", dec: 1, dec0: c => (c / 25) ** 2, min: 0.1 },
    pacc: { label: "Lluvia acumulada desde el inicio", unit: "mm", scale: "prec", dec: 1, dec0: c => (c / 16) ** 2, min: 0.1 },
    gust: { label: "Racha máxima en la hora", unit: "km/h", scale: "wind", dec: 0, dec0: c => c, min: -1 },
    t2m:  { label: "Temperatura a 2 m", unit: "°C", scale: "temp", dec: 1, dec0: c => c / 2.5 - 40, min: -99 },
  };
  const SUB = 8;   // subdivisiones de la tabla de color por cada código (interpolación fina)
  let M = null, v = "pr1", field = null, current = null;
  const cache = new Map();   // "var:h" -> Promise<Uint8Array>
  const LUTS = {};
  const tip = document.createElement("div");
  tip.className = "arome-tip"; tip.hidden = true;
  document.querySelector(".mapapp").appendChild(tip);

  const base = () => (LOCAL ? "out/arome_pub/" : `https://raw.githubusercontent.com/${REPO}/arome/`);
  const mercY = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));

  /* tabla de color continua indexada por código·SUB */
  function lut(key) {
    if (LUTS[key]) return LUTS[key];
    const d = VARS[key], n = 255 * SUB, out = new Uint8ClampedArray((n + 1) * 4);
    for (let i = 0; i <= n; i++) {
      const val = d.dec0(i / SUB);
      if (val < d.min) continue;
      const c = colorCont(d.scale, val);
      if (c) out.set([c[0], c[1], c[2], 255], i * 4);
    }
    return (LUTS[key] = out);
  }

  /* ---------- capa que pinta el campo a resolución de pantalla ---------- */
  const FieldLayer = L.Layer.extend({
    onAdd(map) {
      this._map = map;
      this._cv = L.DomUtil.create("canvas", "arome-canvas leaflet-zoom-hide");
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
    setData(codes, key) { this._codes = codes; this._key = key; this._draw(); },
    _hide() { this._cv.style.visibility = "hidden"; },
    _draw() {
      const map = this._map, cv = this._cv;
      if (!map || !this._codes || !M) return;
      const size = map.getSize(), pad = 0.2;
      const px = Math.round(size.x * pad), py = Math.round(size.y * pad);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = size.x + 2 * px, H = size.y + 2 * py;
      const cw = Math.round(W * dpr), ch = Math.round(H * dpr);
      cv.width = cw; cv.height = ch;
      cv.style.width = W + "px"; cv.style.height = H + "px";
      L.DomUtil.setPosition(cv, map.containerPointToLayerPoint([-px, -py]));

      const [S0, W0, N0, E0] = M.bbox, gw = M.w, gh = M.h;
      const tl = map.containerPointToLatLng([-px, -py]), br = map.containerPointToLatLng([size.x + px, size.y + py]);
      // índices fraccionarios de la rejilla: lineales en x (longitud) y en y (Mercator)
      const fx0 = (tl.lng - W0) / (E0 - W0) * gw - 0.5, fx1 = (br.lng - W0) / (E0 - W0) * gw - 0.5;
      const mN = mercY(N0), mS = mercY(S0);
      const fy0 = (mN - mercY(tl.lat)) / (mN - mS) * gh - 0.5, fy1 = (mN - mercY(br.lat)) / (mN - mS) * gh - 0.5;
      const dfx = (fx1 - fx0) / cw, dfy = (fy1 - fy0) / ch;
      const ctx = cv.getContext("2d");
      const img = ctx.createImageData(cw, ch), out = img.data;
      const codes = this._codes, T = lut(this._key);
      for (let j = 0; j < ch; j++) {
        const fy = fy0 + (j + 0.5) * dfy;
        if (fy < -0.5 || fy > gh - 0.5) continue;
        const y0 = Math.max(0, Math.min(gh - 2, Math.floor(fy))), ty = Math.max(0, Math.min(1, fy - y0));
        const r0 = y0 * gw, r1 = r0 + gw;
        let o = j * cw * 4;
        for (let i = 0; i < cw; i++, o += 4) {
          const fx = fx0 + (i + 0.5) * dfx;
          if (fx < -0.5 || fx > gw - 0.5) continue;
          const x0 = Math.max(0, Math.min(gw - 2, Math.floor(fx))), tx = Math.max(0, Math.min(1, fx - x0));
          const a = codes[r0 + x0], b = codes[r0 + x0 + 1], c = codes[r1 + x0], d = codes[r1 + x0 + 1];
          let code;
          if (a === 255 || b === 255 || c === 255 || d === 255) {   // borde del dominio: vecino más próximo
            code = (ty < 0.5 ? (tx < 0.5 ? a : b) : (tx < 0.5 ? c : d));
            if (code === 255) continue;
          } else {
            code = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
          }
          const k = Math.round(code * SUB) * 4;
          if (!T[k + 3]) continue;
          out[o] = T[k]; out[o + 1] = T[k + 1]; out[o + 2] = T[k + 2]; out[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      cv.style.visibility = "visible";
    },
  });

  /* ---------- fotogramas ---------- */
  function frame(key, h) {
    const k = `${key}:${h}`;
    if (cache.has(k)) return cache.get(k);
    const p = new Promise((res, rej) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const cv = document.createElement("canvas");
        cv.width = img.width; cv.height = img.height;
        const ctx = cv.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
        const codes = new Uint8Array(cv.width * cv.height);
        for (let i = 0, j = 0; i < codes.length; i++, j += 4) codes[i] = px[j];
        res(codes);
      };
      img.onerror = () => rej(new Error("no se pudo cargar " + k));
      img.src = `${base()}${key}_${String(h).padStart(2, "0")}.png?r=${encodeURIComponent(M.run)}`;
    });
    cache.set(k, p);
    p.catch(() => cache.delete(k));
    if (cache.size > 80) cache.delete(cache.keys().next().value);   // límite de memoria
    return p;
  }

  async function start() {
    if (S.anim === "obs10") stopTimebar();
    for (const k of ["radar", "sat", "li"]) if (S.layers[k]) { S.layers[k] = false; $("#lyr-" + k).checked = false; await toggleLayer(k); }
    try { M = await getJSON(base() + "manifest.json" + bust()); }
    catch { S.layers.arome = false; $("#lyr-arome").checked = false; $("#arome-mode").hidden = true; return toast("AROME todavía no está disponible."); }
    cache.clear();
    $("#arome-mode").hidden = false;
    const run = new Date(M.run);
    $("#arome-info").textContent = `Pasada de las ${String(run.getUTCHours()).padStart(2, "0")} UTC (${run.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" })} hora peninsular) del ${run.toLocaleDateString("es-ES", { day: "numeric", month: "short", timeZone: "Europe/Madrid" })} · hasta H+51 · Météo-France`;
    document.body.classList.toggle("hide-stations", $("#arome-hide").checked);
    field ||= new FieldLayer();
    if (!map.hasLayer(field)) field.addTo(map);
    setVar(v, true);
  }

  function setVar(key, first) {
    v = key;
    $$("#arome-mode button").forEach(b => b.classList.toggle("on", b.dataset.av === key));
    if (!M) return;
    const t0 = Date.parse(M.run);
    TB.frames = (M.hours[key] || []).map(h => ({ t: t0 + h * 3600e3, h }));
    S.anim = "arome";
    const r = $("#tb-range");
    r.max = TB.frames.length - 1;
    if (first || TB.i == null) {   // empieza en la hora más cercana a ahora
      let best = 0;
      TB.frames.forEach((f, i) => { if (Math.abs(f.t - Date.now()) < Math.abs(TB.frames[best].t - Date.now())) best = i; });
      TB.i = best;
    }
    TB.i = Math.max(0, Math.min(TB.i, TB.frames.length - 1));
    r.value = TB.i;
    $("#timebar").hidden = false;
    $("#tb-what").textContent = "AROME 1,3 km";
    legend();
    show(TB.i);
  }

  async function show(i) {
    const f = TB.frames[i];
    if (!f || !M) return;
    const when = new Date(f.t).toLocaleString("es-ES", { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" });
    $("#tb-label").textContent = `${when} · H+${String(f.h).padStart(2, "0")}`;
    const key = v;
    let codes;
    try { codes = await frame(key, f.h); } catch (e) { console.warn(e); return; }
    if (S.anim !== "arome" || key !== v || TB.frames[TB.i] !== f) return;
    current = codes;
    field?.setData(codes, key);
    for (const d of [1, 2, 3]) { const n = TB.frames[(i + d) % TB.frames.length]; if (n) frame(key, n.h).catch(() => {}); }
  }

  function stop() {
    if (field && map.hasLayer(field)) map.removeLayer(field);
    current = null; tip.hidden = true;
    $("#arome-mode").hidden = true;
    document.body.classList.remove("hide-stations");
    if (S.anim === "arome") {
      clearInterval(TB.timer); TB.timer = null; $("#tb-play").textContent = "▶";
      S.anim = null; $("#timebar").hidden = true;
      renderLegend(currentDef());
    }
  }

  function legend() {
    const d = VARS[v];
    renderLegend({ label: `AROME 1,3 km · ${d.label}`, unit: d.unit, scale: d.scale, continuous: true });
  }

  /* valor bajo el ratón (bilineal, como el dibujo) */
  function valueAt(lat, lon) {
    if (!M || !current) return null;
    const [S0, W0, N0, E0] = M.bbox, gw = M.w, gh = M.h;
    if (lat < S0 || lat > N0 || lon < W0 || lon > E0) return null;
    const fx = (lon - W0) / (E0 - W0) * gw - 0.5, fy = (mercY(N0) - mercY(lat)) / (mercY(N0) - mercY(S0)) * gh - 0.5;
    const x0 = Math.max(0, Math.min(gw - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(gh - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
    const q = [current[y0 * gw + x0], current[y0 * gw + x0 + 1], current[(y0 + 1) * gw + x0], current[(y0 + 1) * gw + x0 + 1]];
    if (q.some(c => c === 255)) { const c = q[(ty < 0.5 ? 0 : 2) + (tx < 0.5 ? 0 : 1)]; return c === 255 ? null : VARS[v].dec0(c); }
    const vals = q.map(c => VARS[v].dec0(c));
    return (vals[0] + (vals[1] - vals[0]) * tx) * (1 - ty) + (vals[2] + (vals[3] - vals[2]) * tx) * ty;
  }
  map.on("mousemove", e => {
    if (S.anim !== "arome") return;
    const val = valueAt(e.latlng.lat, e.latlng.lng);
    if (val == null) { tip.hidden = true; return; }
    const d = VARS[v];
    tip.textContent = `AROME ${fmt(d.scale === "temp" ? val : Math.max(val, 0), d.dec)} ${d.unit}`;
    tip.style.left = e.containerPoint.x + 14 + "px";
    tip.style.top = e.containerPoint.y - 10 + "px";
    tip.hidden = false;
  });
  map.on("mouseout", () => (tip.hidden = true));
  $("#arome-hide").addEventListener("change", e => document.body.classList.toggle("hide-stations", e.target.checked && S.anim === "arome"));

  return { start, stop, show, setVar, legend, active: () => S.anim === "arome" };
})();
