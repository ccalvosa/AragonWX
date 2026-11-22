/* ==========================================================
   AROME France HD 1,3 km (Météo-France) sobre el mapa.
   Los PNG llevan un valor codificado por píxel (escala de grises,
   255 = sin dato); aquí se colorean con las mismas escalas que las
   estaciones y se guardan para leer el valor bajo el ratón.
   Lo publica scraper/aragonwx/arome.py en la rama «arome».
   ========================================================== */

const Arome = (() => {
  const VARS = {
    pr1:  { label: "Lluvia en 1 hora", unit: "mm", scale: "prec1h", dec: 1, dec0: c => (c / 25) ** 2, min: 0.1 },
    pacc: { label: "Lluvia acumulada desde el inicio", unit: "mm", scale: "prec", dec: 1, dec0: c => (c / 16) ** 2, min: 0.1 },
    gust: { label: "Racha máxima en la hora", unit: "km/h", scale: "wind", dec: 0, dec0: c => c, min: 0 },
    t2m:  { label: "Temperatura a 2 m", unit: "°C", scale: "temp", dec: 1, dec0: c => c / 2.5 - 40, min: -99 },
  };
  let M = null, v = "pr1", overlay = null, hours = [];
  const cache = new Map();   // "var:h" -> Promise<{url, codes}>
  let current = null;        // {codes} del fotograma visible
  const tip = document.createElement("div");
  tip.className = "arome-tip"; tip.hidden = true;
  document.querySelector(".mapapp").appendChild(tip);

  const base = () => (LOCAL ? "out/arome_pub/" : `https://raw.githubusercontent.com/${REPO}/arome/`);

  function lut(key) {
    const d = VARS[key], out = new Uint8ClampedArray(256 * 4);
    for (let c = 0; c < 255; c++) {
      const val = d.dec0(c);
      if (val < d.min) continue;
      const h = colorFor(d.scale, val).slice(1);
      out.set([parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255], c * 4);
    }
    return out;
  }
  const LUTS = {};

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
        const px = ctx.getImageData(0, 0, cv.width, cv.height);
        const codes = new Uint8Array(cv.width * cv.height);
        const L = (LUTS[key] ||= lut(key));
        for (let i = 0, j = 0; i < codes.length; i++, j += 4) {
          const c = px.data[j];
          codes[i] = c;
          px.data[j] = L[c * 4]; px.data[j + 1] = L[c * 4 + 1]; px.data[j + 2] = L[c * 4 + 2]; px.data[j + 3] = L[c * 4 + 3];
        }
        ctx.putImageData(px, 0, 0);
        res({ url: cv.toDataURL("image/png"), codes });
      };
      img.onerror = () => rej(new Error("no se pudo cargar " + k));
      img.src = `${base()}${key}_${String(h).padStart(2, "0")}.png?r=${encodeURIComponent(M.run)}`;
    });
    cache.set(k, p);
    p.catch(() => cache.delete(k));
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
    setVar(v, true);
  }

  function setVar(key, first) {
    v = key;
    $$("#arome-mode button").forEach(b => b.classList.toggle("on", b.dataset.av === key));
    if (!M) return;
    hours = M.hours[key] || [];
    const t0 = Date.parse(M.run);
    TB.frames = hours.map(h => ({ t: t0 + h * 3600e3, h }));
    S.anim = "arome";
    const r = $("#tb-range");
    r.max = TB.frames.length - 1;
    if (first) {   // empieza en la hora más cercana a ahora
      let best = 0;
      TB.frames.forEach((f, i) => { if (Math.abs(f.t - Date.now()) < Math.abs(TB.frames[best].t - Date.now())) best = i; });
      TB.i = best;
    }
    TB.i = Math.min(TB.i, TB.frames.length - 1);
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
    let fr;
    try { fr = await frame(key, f.h); } catch (e) { console.warn(e); return; }
    if (S.anim !== "arome" || key !== v || TB.frames[TB.i] !== f) return;
    current = fr;
    const b = [[M.bbox[0], M.bbox[1]], [M.bbox[2], M.bbox[3]]];
    if (!overlay) overlay = L.imageOverlay(fr.url, b, { pane: "interp", opacity: 0.72, interactive: false, className: "arome-img" }).addTo(map);
    else overlay.setUrl(fr.url);
    // precarga de los dos siguientes
    for (const d of [1, 2]) { const n = TB.frames[(i + d) % TB.frames.length]; if (n) frame(key, n.h).catch(() => {}); }
  }

  function stop() {
    if (overlay) { map.removeLayer(overlay); overlay = null; }
    current = null; tip.hidden = true;
    document.body.classList.remove("hide-stations");
    $("#arome-mode").hidden = true;
    if (S.anim === "arome") {
      clearInterval(TB.timer); TB.timer = null; $("#tb-play").textContent = "▶";
      S.anim = null; $("#timebar").hidden = true;
      renderLegend(currentDef());
    }
  }

  function legend() {
    const d = VARS[v];
    renderLegend({ label: `AROME 1,3 km · ${d.label}`, unit: d.unit, scale: d.scale });
  }

  /* valor bajo el ratón */
  const mercY = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
  function valueAt(lat, lon) {
    if (!M || !current) return null;
    const [S0, W0, N0, E0] = M.bbox;
    if (lat < S0 || lat > N0 || lon < W0 || lon > E0) return null;
    const x = Math.floor((lon - W0) / (E0 - W0) * M.w);
    const y = Math.floor((mercY(N0) - mercY(lat)) / (mercY(N0) - mercY(S0)) * M.h);
    const c = current.codes[y * M.w + x];
    return c === 255 ? null : VARS[v].dec0(c);
  }
  map.on("mousemove", e => {
    if (S.anim !== "arome") return;
    const val = valueAt(e.latlng.lat, e.latlng.lng);
    if (val == null) { tip.hidden = true; return; }
    const d = VARS[v];
    tip.textContent = `AROME ${fmt(Math.max(val, d.scale === "temp" ? -99 : 0), d.dec)} ${d.unit}`;
    tip.style.left = e.containerPoint.x + 14 + "px";
    tip.style.top = e.containerPoint.y - 10 + "px";
    tip.hidden = false;
  });
  map.on("mouseout", () => (tip.hidden = true));

  $("#arome-hide").addEventListener("change", e => document.body.classList.toggle("hide-stations", e.target.checked && S.anim === "arome"));

  return { start, stop, show, setVar, legend, active: () => S.anim === "arome" };
})();
