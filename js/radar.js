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
     a1 … a24  lluvia estimada en 1, 3, 6, 12 y 24 h (largo alcance, corregida con pluviómetros)

   «Descargar GIF» graba la animación de la vista actual (mapa base, límites de
   provincia, radar, hora y leyenda) con gifenc, que se carga solo al pulsarlo.

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
  };
  const PERIODS = [1, 3, 6, 12, 24];
  for (const h of PERIODS)   // lluvia: hasta 3 h con la escala horaria, más con la diaria
    MODES["a" + h] = { label: `Lluvia estimada en ${h} ${h === 1 ? "hora" : "horas"}`, unit: "mm", scale: h <= 3 ? "prec1h" : "prec", q: h <= 3 ? "a1" : "a24", acc: h };
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
    if (d.acc) { const file = accOf(d.acc)?.f; return file ? [{ t: Date.parse(M.acc.t), rf: { ...M.acc, z: file, elev: 0.5 } }] : []; }
    return M.frames.filter(f => f.kind === d.kind && (d.q === "z" || f.v)).map(f => ({ t: Date.parse(f.t), rf: f }));
  }
  /* acumulado de h horas: {f, n, e} (los manifiestos antiguos solo traen 1 y 24 h) */
  function accOf(h) {
    const a = M?.acc;
    if (!a) return null;
    if (a.per) return a.per[h] || null;
    return h === 1 ? { f: a.h1, n: a.n1, e: a.e1 } : h === 24 ? { f: a.h24, n: a.n24, e: a.e24 } : null;
  }
  const fileOf = f => (Q() === "v" ? f.v : f.z);
  function preload() { frames().forEach(({ rf }) => png(fileOf(rf)).catch(() => {})); }
  async function show(f) {
    const my = ++token;
    const a = await png(fileOf(f)).catch(() => null);
    if (my !== token || !a) return;
    cur = { f, a, q: Q(), h: MODES[mode].acc };
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

  /* pinta la exploración en out (RGBA, cw×ch). lngOf(x) y latOf(y) dan la longitud de cada columna y la
     latitud de cada fila (Mercator es separable); [xa, xb) × [ya, yb) es la caja que hay que recorrer. */
  function paintPolar(out, cw, f, a, lut, lngOf, latOf, xa, xb, ya, yb) {
    const sinD = new Float64Array(xb), cosD = new Float64Array(xb);
    for (let x = xa; x < xb; x++) {
      const d = (lngOf(x) - M.site.lon) * rad;
      sinD[x] = Math.sin(d); cosD[x] = Math.cos(d);
    }
    for (let y = ya; y < yb; y++) {
      const lat = latOf(y) * rad, sl = Math.sin(lat), cl = Math.cos(lat);
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
  /* caja de píxeles (escala k sobre los puntos del contenedor, desplazados ox, oy) que contiene el alcance */
  function rangeBox(f, k, ox, oy, cw, ch) {
    const rmax = f.rstart + f.nbins * f.rscale;
    const bb = L.latLng(M.site.lat, M.site.lon).toBounds(2 * rmax * 1.02);
    const p0 = map.latLngToContainerPoint(bb.getNorthWest()), p1 = map.latLngToContainerPoint(bb.getSouthEast());
    return [Math.max(0, Math.floor((p0.x + ox) * k)), Math.min(cw, Math.ceil((p1.x + ox) * k)),
            Math.max(0, Math.floor((p0.y + oy) * k)), Math.min(ch, Math.ceil((p1.y + oy) * k))];
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
      const { f, a } = cur;
      const [xa, xb, ya, yb] = rangeBox(f, dpr, px, py, cw, ch);
      if (xb > xa && yb > ya)
        paintPolar(out, cw, f, a, LUT[cur.q], x => map.containerPointToLatLng([(x + 0.5) / dpr - px, 0]).lng,
          y => map.containerPointToLatLng([0, (y + 0.5) / dpr - py]).lat, xa, xb, ya, yb);
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
    tip.textContent = cur.h ? `Radar ${fmt(r.v, r.v < 10 ? 1 : 0)} mm en ${cur.h} h (estimado)`
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
    const p = accOf(d.acc);
    if (!p) return "Este acumulado todavía no está disponible.";
    const h1 = d.acc === 1, n = p.n, e = p.e;
    const t = new Date(a.t).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
    const cov = n >= e ? "" : n >= (h1 ? 4 : 0.8 * e) ? ` (faltan ${e - n} imágenes; se ha completado el hueco)`
      : ` · <b>incompleto: solo ${Math.round(n * 10 / 60 * 10) / 10} h de datos</b>`;
    const bias = a.bias ? `corregida con ${a.pairs} pluviómetros de AEMET (el radar se multiplica por ${a.bias.toFixed(2).replace(".", ",")})`
      : "sin corregir con pluviómetros (pocos con lluvia o faltan datos)";
    return `Hasta las ${t}${cov} · largo alcance (1 km, 250 km) · intensidad con Marshall-Palmer, ${bias}. `
      + `No cuenta ${a.clutter} celdas con ecos fijos del terreno. Es una estimación: el radar ve la lluvia en altura y lejos del radar se queda corto.`;
  }

  /* ---------- GIF de la animación en la vista actual ---------- */
  const GIFENC = "https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js";
  function img(url) {
    return new Promise(res => { const im = new Image(); im.crossOrigin = "anonymous"; im.onload = () => res(im); im.onerror = () => res(null); im.src = url; });
  }
  /* teselas de una capa de Leaflet dibujadas en ctx a la escala k (mismo encuadre que el mapa) */
  async function drawTiles(ctx, lyr, k) {
    const o = lyr.options, zoom = map.getZoom();
    const z = Math.max(o.minZoom || 0, Math.min(Math.round(zoom), o.maxNativeZoom ?? o.maxZoom ?? 18));
    const sc = map.getZoomScale(zoom, z), size = map.getSize();
    const tl = map.project(map.containerPointToLatLng([0, 0]), z), br = map.project(map.containerPointToLatLng([size.x, size.y]), z);
    const T = 256, n = 2 ** z, jobs = [];
    for (let ty = Math.floor(tl.y / T); ty <= Math.floor(br.y / T); ty++) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = Math.floor(tl.x / T); tx <= Math.floor(br.x / T); tx++) {
        const url = L.Util.template(lyr._url, { ...o, x: ((tx % n) + n) % n, y: ty, z, s: "a", r: "" });
        jobs.push(img(url).then(im => im && [im, (tx * T - tl.x) * sc * k, (ty * T - tl.y) * sc * k]));
      }
    }
    ctx.globalAlpha = o.opacity ?? 1;
    for (const t of await Promise.all(jobs)) if (t) ctx.drawImage(t[0], t[1], t[2], T * sc * k + 0.5, T * sc * k + 0.5);
    ctx.globalAlpha = 1;
  }
  async function exportGif(btn) {
    const fr = frames();
    if (!fr.length) return toast("No hay imágenes del radar para grabar.");
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = "Preparando el GIF…";
    try {
      const { GIFEncoder, quantize, applyPalette } = await import(GIFENC);
      const size = map.getSize(), k = Math.min(1, 900 / size.x, 700 / size.y);
      const W = Math.round(size.x * k), H = Math.round(size.y * k), LEG = 34;
      // fondo fijo: mapa base, sombreado y límites de provincia
      const under = document.createElement("canvas"); under.width = W; under.height = H;
      const uc = under.getContext("2d");
      uc.fillStyle = isDark() ? "#1e2124" : "#e9ecef"; uc.fillRect(0, 0, W, H);
      const labels = baseLayers.filter(l => l.options.pane === "labels");
      for (const l of baseLayers) if (!labels.includes(l) && l._url) await drawTiles(uc, l, k);
      const over = document.createElement("canvas"); over.width = W; over.height = H;
      const oc = over.getContext("2d");
      for (const l of labels) if (l._url) await drawTiles(oc, l, k);
      oc.strokeStyle = isDark() ? "rgba(255,255,255,.55)" : "rgba(40,40,40,.65)"; oc.lineWidth = 1.2;
      for (const ring of RINGS || []) {
        oc.beginPath();
        ring.forEach(([lon, lat], i) => { const p = map.latLngToContainerPoint([lat, lon]); oc[i ? "lineTo" : "moveTo"](p.x * k, p.y * k); });
        oc.stroke();
      }
      const site = map.latLngToContainerPoint([M.site.lat, M.site.lon]);
      oc.fillStyle = "#212529"; oc.strokeStyle = "#fff"; oc.lineWidth = 2;
      oc.beginPath(); oc.arc(site.x * k, site.y * k, 4, 0, 7); oc.fill(); oc.stroke();
      // fotograma: fondo + radar + encima + rótulos
      const d = MODES[mode], lut = LUT[d.q], cv = document.createElement("canvas");
      cv.width = W; cv.height = H + LEG;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      const rcv = document.createElement("canvas"); rcv.width = W; rcv.height = H;
      const rctx = rcv.getContext("2d");
      const lngOf = x => map.containerPointToLatLng([(x + 0.5) / k, 0]).lng, latOf = y => map.containerPointToLatLng([0, (y + 0.5) / k]).lat;
      const stops = SCALES[d.scale].stops.slice().reverse();
      const gif = GIFEncoder();
      for (let i = 0; i < fr.length; i++) {
        btn.textContent = `Grabando ${i + 1}/${fr.length}…`;
        const f = fr[i].rf, a = await png(d.acc ? f.z : (d.q === "v" ? f.v : f.z)).catch(() => null);
        if (!a) continue;
        ctx.drawImage(under, 0, 0);
        const im = rctx.createImageData(W, H);
        const [xa, xb, ya, yb] = rangeBox(f, k, 0, 0, W, H);
        if (xb > xa && yb > ya) paintPolar(im.data, W, f, a, lut, lngOf, latOf, xa, xb, ya, yb);
        rctx.putImageData(im, 0, 0);
        ctx.globalAlpha = 0.85; ctx.drawImage(rcv, 0, 0); ctx.globalAlpha = 1;
        ctx.drawImage(over, 0, 0);
        // hora y título
        const t = new Date(fr[i].t).toLocaleString("es-ES", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
        ctx.font = "600 15px system-ui, sans-serif";
        const title = `${d.acc ? "Hasta el " : ""}${t} · ${d.label}`;
        ctx.fillStyle = "rgba(255,255,255,.88)"; ctx.fillRect(8, 8, ctx.measureText(title).width + 16, 26);
        ctx.fillStyle = "#212529"; ctx.fillText(title, 16, 26);
        // leyenda y créditos
        ctx.fillStyle = "#fff"; ctx.fillRect(0, H, W, LEG);
        const bw = Math.min(16, (W * 0.6) / stops.length);
        stops.forEach(([v, c], j) => { ctx.fillStyle = c; ctx.fillRect(8 + j * bw, H + 5, bw, 10); });
        ctx.fillStyle = "#495057"; ctx.font = "10px system-ui, sans-serif";
        const ev = Math.ceil(stops.length / 8);
        stops.forEach(([v], j) => { if (j % ev === 0) ctx.fillText(String(v).replace(".", ","), 8 + j * bw, H + 27); });
        ctx.fillText(d.unit, 12 + stops.length * bw, H + 14);
        ctx.textAlign = "right";
        ctx.fillText(`Radar de ${M.site.name} · AEMET · EUMETNET OPERA · mapa Esri · AragonWX`, W - 8, H + 27);
        ctx.textAlign = "left";
        const px = ctx.getImageData(0, 0, W, H + LEG).data;
        const pal = quantize(px, 256);
        gif.writeFrame(applyPalette(px, pal), W, H + LEG, { palette: pal, delay: i === fr.length - 1 ? 1500 : 450 });
        await new Promise(r => setTimeout(r));   // deja respirar a la página
      }
      gif.finish();
      const blob = new Blob([gif.bytes()], { type: "image/gif" });
      const last = new Date(fr.at(-1).t), pad = n => String(n).padStart(2, "0");
      const name = `radar-${mode}-${last.getFullYear()}${pad(last.getMonth() + 1)}${pad(last.getDate())}-${pad(last.getHours())}${pad(last.getMinutes())}.gif`;
      const aEl = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
      document.body.appendChild(aEl); aEl.click(); aEl.remove();
      setTimeout(() => URL.revokeObjectURL(aEl.href), 10e3);
      toast(`GIF listo: ${fr.length} ${fr.length === 1 ? "imagen" : "imágenes"}, ${Math.round(blob.size / 1024)} KB`);
    } catch (e) {
      console.error(e);
      toast("No se ha podido generar el GIF.");
    } finally {
      btn.disabled = false; btn.textContent = old;
    }
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

  return { start, stop, show, frames, setMode, exportGif, ready: () => !!M, mode: () => mode, MODES };
})();
