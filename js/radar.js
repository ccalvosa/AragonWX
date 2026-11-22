/* ==========================================================
   Radar de Zaragoza (AEMET, Perdiguera) desde EUMETNET OPERA.

   scraper/aragonwx/radar.py publica en la rama «radar» la elevación más
   baja (0,5°) de cada volumen, en coordenadas polares (fila = rayo,
   columna = celda), como PNG en escala de grises:
     reflectividad  dBZ = código/2 − 32      (0 = sin eco)
     velocidad      m/s = (código − 128)/3   (+ se aleja del radar; 0 = sin dato)
   Tres productos, cada uno con su exploración (una imagen cada 10 min):
     zh  reflectividad de alta resolución: exploración Doppler, 150 km, 500 m
     zl  reflectividad de baja resolución: largo alcance, 250 km, 1 km
     v   velocidad radial: exploración Doppler
     a1, a24  lluvia estimada en 1 y 24 h (largo alcance, corregida con pluviómetros)

   La capa pinta cada píxel de la pantalla con la celda del radar que le
   corresponde, sin estirar ni suavizar: se ve la resolución real a cualquier zoom.
   ========================================================== */

const Radar = (() => {
  const base = () => (LOCAL ? "out/radar_pub/" : `https://raw.githubusercontent.com/${REPO}/radar/`);
  const ZMIN = 5;   // dBZ: por debajo, transparente
  const MODES = {
    zh: { label: "Reflectividad · alta resolución", unit: "dBZ", scale: "dbz", kind: "dop", q: "z", what: "exploración Doppler: 500 m hasta 150 km" },
    zl: { label: "Reflectividad · baja resolución", unit: "dBZ", scale: "dbz", kind: "lr", q: "z", what: "largo alcance: 1 km hasta 250 km" },
    v:  { label: "Velocidad radial", unit: "m/s", scale: "vrad", kind: "dop", q: "v", what: "exploración Doppler: 500 m hasta 150 km" },
    a1:  { label: "Lluvia estimada en 1 hora", unit: "mm", scale: "prec1h", q: "a1", acc: "h1" },
    a24: { label: "Lluvia estimada en 24 horas", unit: "mm", scale: "prec", q: "a24", acc: "h24" },
  };
  const Q = () => MODES[mode].q;
  let M = null, mode = "zh", layer = null, cur = null, token = 0, timer = null, marks = null;
  const cache = new Map();   // nombre de PNG -> Promise<Uint8Array>
  const tip = document.createElement("div");
  tip.className = "arome-tip"; tip.hidden = true;
  document.querySelector(".mapapp").appendChild(tip);

  const rgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];
  const LUT = {
    z: (() => { const t = new Uint8ClampedArray(256 * 4); for (let c = 1; c < 256; c++) { const v = c / 2 - 32; if (v >= ZMIN) t.set(rgb(colorFor("dbz", v)), c * 4); } return t; })(),
    v: (() => { const t = new Uint8ClampedArray(256 * 4); for (let c = 1; c < 256; c++) t.set(rgb(colorFor("vrad", (c - 128) / 3)), c * 4); return t; })(),
  };
  for (const [q, sc] of [["a1", "prec1h"], ["a24", "prec"]]) {   // lluvia: código = √mm · 16
    const t = new Uint8ClampedArray(256 * 4);
    for (let c = 1; c < 256; c++) { const mm = (c / 16) ** 2; if (mm >= 0.1) t.set(rgb(colorFor(sc, mm)), c * 4); }
    LUT[q] = t;
  }
  const decode = { z: c => c / 2 - 32, v: c => (c - 128) / 3, a1: c => (c / 16) ** 2, a24: c => (c / 16) ** 2 };

  function png(name) {
    if (!cache.has(name)) {
      cache.set(name, (async () => {
        const blob = await (await fetch(base() + name)).blob();
        const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
        const cv = document.createElement("canvas");
        cv.width = bmp.width; cv.height = bmp.height;
        const ctx = cv.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(bmp, 0, 0);
        const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data, out = new Uint8Array(bmp.width * bmp.height);
        for (let i = 0; i < out.length; i++) out[i] = px[i * 4];
        return out;
      })().catch(e => { cache.delete(name); throw e; }));
    }
    return cache.get(name);
  }

  /* fotogramas para la barra de tiempo (en velocidad, solo los Doppler) */
  function frames() {
    if (!M) return [];
    const d = MODES[mode];
    if (d.acc) return M.acc ? [{ t: Date.parse(M.acc.t), rf: { ...M.acc, z: M.acc[d.acc], elev: 0.5 } }] : [];
    return M.frames.filter(f => f.kind === d.kind && (d.q === "z" || f.v)).map(f => ({ t: Date.parse(f.t), rf: f }));
  }
  const fileOf = f => (Q() === "v" ? f.v : f.z);
  function preload() { frames().forEach(({ rf }) => png(fileOf(rf)).catch(() => {})); }
  async function show(f) {
    const my = ++token;
    const a = await png(fileOf(f)).catch(() => null);
    if (my !== token || !a) return;
    cur = { f, a, q: Q() };
    if (!layer) layer = new PolarLayer().addTo(map); else layer._draw();
    info();
  }

  /* distancia (m) y acimut (°) desde el radar, con trigonometría esférica */
  const R = 6371000, rad = Math.PI / 180;
  function polar(sinLat, cosLat, sinD, cosD) {
    const s = M.site, sl0 = Math.sin(s.lat * rad), cl0 = Math.cos(s.lat * rad);
    const x = cosLat * sinD, y = cl0 * sinLat - sl0 * cosLat * cosD;
    return [R * Math.hypot(x, y), (Math.atan2(x, y) / rad + 360) % 360];
  }
  function cell(fr, arr, dist, az) {
    const bin = Math.floor((dist - fr.rstart) / fr.rscale);
    if (bin < 0 || bin >= fr.nbins) return -1;
    const ray = Math.floor(((az - fr.az0 + 720) % 360) * fr.nrays / 360) % fr.nrays;
    return arr[ray * fr.nbins + bin];
  }

  const PolarLayer = L.Layer.extend({
    onAdd(map) {
      this._map = map;
      this._cv = L.DomUtil.create("canvas", "arome-canvas leaflet-zoom-hide");
      this._cv.style.opacity = 0.85;
      map.getPane("radar").appendChild(this._cv);
      map.on("moveend zoomend resize viewreset", this._draw, this);
      map.on("zoomstart", this._hide, this);
      this._draw();
    },
    onRemove(map) {
      map.off("moveend zoomend resize viewreset", this._draw, this);
      map.off("zoomstart", this._hide, this);
      this._cv.remove();
    },
    getAttribution: () => 'Radar <a href="https://www.eumetnet.eu/observations/opera/" target="_blank" rel="noopener">EUMETNET OPERA</a> · AEMET',
    _hide() { this._cv.style.visibility = "hidden"; },
    _draw() {
      if (!cur) return;
      const map = this._map, cv = this._cv, size = map.getSize();
      const pad = 0.1, px = Math.round(size.x * pad), py = Math.round(size.y * pad);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = size.x + 2 * px, H = size.y + 2 * py, cw = Math.round(W * dpr), ch = Math.round(H * dpr);
      cv.width = cw; cv.height = ch; cv.style.width = W + "px"; cv.style.height = H + "px";
      L.DomUtil.setPosition(cv, map.containerPointToLayerPoint([-px, -py]));
      const ctx = cv.getContext("2d"), img = ctx.createImageData(cw, ch), out = img.data;
      // solo la caja que contiene el alcance máximo
      const { f, a } = cur, rmax = f.rstart + f.nbins * f.rscale;
      const bb = L.latLng(M.site.lat, M.site.lon).toBounds(2 * rmax * 1.02);
      const p0 = map.latLngToContainerPoint(bb.getNorthWest()), p1 = map.latLngToContainerPoint(bb.getSouthEast());
      const xa = Math.max(0, Math.floor((p0.x + px) * dpr)), xb = Math.min(cw, Math.ceil((p1.x + px) * dpr));
      const ya = Math.max(0, Math.floor((p0.y + py) * dpr)), yb = Math.min(ch, Math.ceil((p1.y + py) * dpr));
      if (xb > xa && yb > ya) {
        // la proyección es separable: latitud por fila y longitud por columna
        const sinD = new Float64Array(cw), cosD = new Float64Array(cw);
        for (let x = xa; x < xb; x++) {
          const d = (map.containerPointToLatLng([(x + 0.5) / dpr - px, 0]).lng - M.site.lon) * rad;
          sinD[x] = Math.sin(d); cosD[x] = Math.cos(d);
        }
        const lut = LUT[cur.q];
        for (let y = ya; y < yb; y++) {
          const lat = map.containerPointToLatLng([0, (y + 0.5) / dpr - py]).lat * rad, sl = Math.sin(lat), cl = Math.cos(lat);
          let o = (y * cw + xa) * 4;
          for (let x = xa; x < xb; x++, o += 4) {
            const [dist, az] = polar(sl, cl, sinD[x], cosD[x]);
            const c = cell(f, a, dist, az);
            if (c <= 0) continue;
            const k = c * 4;
            if (!lut[k + 3]) continue;
            out[o] = lut[k]; out[o + 1] = lut[k + 1]; out[o + 2] = lut[k + 2]; out[o + 3] = 255;
          }
        }
      }
      ctx.putImageData(img, 0, 0);
      cv.style.visibility = "visible";
    },
  });

  /* valor bajo el ratón: la misma celda que se dibuja */
  function valueAt(lat, lon) {
    if (!cur || !M) return null;
    const d = (lon - M.site.lon) * rad, l = lat * rad;
    const [dist, az] = polar(Math.sin(l), Math.cos(l), Math.sin(d), Math.cos(d));
    const c = cell(cur.f, cur.a, dist, az);
    if (c <= 0) return null;
    const v = decode[cur.q](c);
    return cur.q === "z" && v < ZMIN ? null : { v, km: dist / 1000 };
  }
  map.on("mousemove", e => {
    if (!layer || !S.layers.radar) { tip.hidden = true; return; }
    const r = valueAt(e.latlng.lat, e.latlng.lng);
    if (!r) { tip.hidden = true; return; }
    tip.textContent = cur.q.startsWith("a") ? `Radar ${fmt(r.v, r.v < 10 ? 1 : 0)} mm en ${cur.q === "a1" ? "1 h" : "24 h"} (estimado)`
      : cur.q === "z" ? `Radar ${Math.round(r.v)} dBZ · a ${Math.round(r.km)} km`
      : `Radar ${r.v > 0 ? "+" : ""}${fmt(r.v, 1)} m/s · ${Math.abs(r.v) < 1 ? "casi nula" : r.v > 0 ? "se aleja" : "se acerca"}`;
    tip.style.left = e.containerPoint.x + 14 + "px";
    tip.style.top = e.containerPoint.y - 10 + "px";
    tip.hidden = false;
  });
  map.on("mouseout", () => (tip.hidden = true));

  /* leyenda y datos de la imagen en el panel */
  function info() {
    const el = $("#radar-info");
    if (!el || !M) return;
    const d = MODES[mode], sc = SCALES[d.scale], stops = sc.stops.slice().reverse();
    const every = Math.ceil(stops.length / 8);
    const f = cur?.f;
    el.innerHTML = `<div class="lg-title">${d.label} <small>${d.unit}</small></div>
      <div class="lg-bar">${stops.map(([t, c]) => `<span class="lg-c" style="background:${c}" title="> ${t}"></span>`).join("")}</div>
      <div class="lg-ticks">${stops.map(([t], i) => `<span>${i % every ? "" : String(t).replace(".", ",")}</span>`).join("")}</div>
      <p class="hint">${d.acc ? accNote(d) : `${esc(M.site.name)} · elevación ${f ? String(f.elev).replace(".", ",") : "0,5"}° · ${d.what} · una imagen cada 10 min
        ${mode === "v" ? "<br>Verde: se acerca al radar · rojo: se aleja. Sin corregir el plegado de velocidades (±40 m/s)." : ""}`}</p>`;
  }
  /* explicación de la lluvia estimada: hasta cuándo, cobertura y corrección con pluviómetros */
  function accNote(d) {
    const a = M.acc;
    if (!a) return "Todavía no hay acumulados.";
    const h1 = d.acc === "h1", n = h1 ? a.n1 : a.n24, e = h1 ? a.e1 : a.e24;
    const t = new Date(a.t).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
    const cov = n >= e ? "" : n >= (h1 ? 4 : 0.8 * e) ? ` (faltan ${e - n} imágenes; se ha completado el hueco)`
      : ` · <b>incompleto: solo ${Math.round(n * 10 / 60 * 10) / 10} h de datos</b>`;
    const bias = a.bias ? `corregida con ${a.pairs} pluviómetros de AEMET (el radar se multiplica por ${a.bias.toFixed(2).replace(".", ",")})`
      : "sin corregir con pluviómetros (pocos con lluvia o faltan datos)";
    return `Hasta las ${t}${cov} · largo alcance (1 km, 250 km) · intensidad con Marshall-Palmer, ${bias}. `
      + `No cuenta ${a.clutter} celdas con ecos fijos del terreno. Es una estimación: el radar ve la lluvia en altura y lejos del radar se queda corto.`;
  }

  async function load() {
    M = await getJSON(base() + "manifest.json" + bust());
    if (!M.frames?.length) throw new Error("sin imágenes");
    return M;
  }

  async function start() {
    await load();
    $("#radar-mode").hidden = false;
    marks ||= L.layerGroup([
      L.circle([M.site.lat, M.site.lon], { radius: 150000, pane: "radar", interactive: false, color: "#868e96", weight: 1, dashArray: "4 4", fill: false, opacity: 0.6 }),
      L.circle([M.site.lat, M.site.lon], { radius: 250000, pane: "radar", interactive: false, color: "#868e96", weight: 1, dashArray: "2 6", fill: false, opacity: 0.5 }),
      L.circleMarker([M.site.lat, M.site.lon], { radius: 4, weight: 2, color: "#fff", fillColor: "#212529", fillOpacity: 1, pane: "radar" })
        .bindTooltip(`Radar de ${M.site.name} · AEMET · ${Math.round(M.site.h)} m`),
    ]);
    marks.addTo(map);
    // precarga para que la animación vaya fluida
    preload();
    clearInterval(timer);
    timer = setInterval(refresh, 120e3);
  }
  async function refresh() {
    if (!S.layers.radar) return;
    const n = M?.frames.at(-1)?.t;
    try { await load(); } catch { return; }
    if (M.frames.at(-1)?.t !== n) {
      const atEnd = TB.i >= TB.frames.length - 1 && !TB.timer;
      refreshTimebar(atEnd);
    }
  }
  function stop() {
    clearInterval(timer); timer = null;
    layer && map.removeLayer(layer); layer = null; cur = null;
    marks && map.removeLayer(marks);
    tip.hidden = true;
    $("#radar-mode").hidden = true;
  }
  function setMode(m) {
    mode = m;
    if (M) preload();
  }

  return { start, stop, show, frames, setMode, ready: () => !!M, mode: () => mode };
})();
