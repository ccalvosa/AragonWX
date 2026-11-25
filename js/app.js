/* ==========================================================
   Estaciones de Aragón — mapa en directo
   HTML/CSS/JS sin frameworks + Leaflet (+ Plotly bajo demanda).
   Los datos vienen de la rama «data» del repositorio (los publica
   cada 10 minutos el workflow update-data) y el histórico diario
   de history/AAAA-MM.json en main.
   ========================================================== */
"use strict";

const REPO = "ccalvosa/AragonWX";
const QS = new URLSearchParams(location.search);
const LOCAL = QS.get("data") === "local" || ["localhost", "127.0.0.1", ""].includes(location.hostname);
const DATA_URL = LOCAL ? "out/" : `https://raw.githubusercontent.com/${REPO}/data/`;
const HIST_URL = LOCAL ? "history/" : `https://raw.githubusercontent.com/${REPO}/main/history/`;
const REFRESH_MS = 5 * 60 * 1000;
const PLOTLY_SRC = "https://cdn.plot.ly/plotly-2.32.0.min.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? "–" : Number(v).toLocaleString("es-ES", { minimumFractionDigits: d, maximumFractionDigits: d }));
const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/* ---------------------------------------------------------- estado */
const PREF_KEY = "aragonwx-prefs";
const S = {
  mode: "now", v: "ta", hv: "x_max", filter: "all", official: false, doubtful: false, cluster: true,
  netsOff: new Set(), base: "auto", layers: { prov: true, avisos: true }, sat: "ir",
  sel: null, side: null, anim: null, ftab: "obs", wide: false, aemetAr: false, avisosAr: false, rtab: "day",
  hidden: new Set(),   // estaciones ocultadas con Supr (solo en este navegador)
};
try {
  const p = JSON.parse(localStorage.getItem(PREF_KEY) || "{}");
  for (const k of ["v", "hv", "filter", "official", "doubtful", "cluster", "base", "sat", "ftab", "wide", "aemetAr", "avisosAr", "rtab"]) if (p[k] != null) S[k] = p[k];
  if (p.hidden) S.hidden = new Set(p.hidden);
  if (p.netsOff) S.netsOff = new Set(p.netsOff);
  if (p.layers) S.layers = { ...S.layers, ...p.layers, radar: false, sat: false, li: false, interp: false, arome: false };
} catch {}
if (!VARS[S.v]) S.v = "ta";
function savePrefs() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({
      v: S.v, hv: S.hv, filter: S.filter, official: S.official, doubtful: S.doubtful, cluster: S.cluster,
      netsOff: [...S.netsOff], base: S.base, ftab: S.ftab, wide: S.wide, aemetAr: S.aemetAr, avisosAr: S.avisosAr, rtab: S.rtab, hidden: [...S.hidden], layers: { prov: S.layers.prov, cams: S.layers.cams, manual: S.layers.manual, avisos: S.layers.avisos }, sat: S.sat,
    }));
  } catch {}
}

let NOW = null, STATIONS = [], BYID = new Map(), HYDRO = null, OBS10 = null, CAMS = null, RINGS = null, PROV = null;
let HIST = { months: new Map(), result: null };
let OBS10_TS = 0, OBS10_P = null;
async function ensureObs10() {
  if (OBS10 && Date.now() - OBS10_TS < 9 * 60e3) return OBS10;
  OBS10_P ||= getJSON(DATA_URL + "obs10.json" + bust()).then(d => { OBS10 = d; OBS10_TS = Date.now(); return d; })
    .catch(e => { console.warn(e); return OBS10; }).finally(() => { OBS10_P = null; });
  return OBS10_P;
}

/* ---------------------------------------------------------- tema */
function isDark() {
  const t = document.documentElement.dataset.theme;
  if (t) return t === "dark";
  return matchMedia("(prefers-color-scheme: dark)").matches;
}
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

$("#theme-toggle").addEventListener("click", () => {
  const next = isDark() ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch {}
  onTheme();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", onTheme);
function onTheme() { setBase(S.base); if (S.side === "station" && S.sel) openStation(S.sel, false); }

/* ---------------------------------------------------------- mapa */
const map = L.map("map", { zoomControl: false, minZoom: 5, maxZoom: 17, zoomSnap: 0.25, worldCopyJump: false })
  .setView([41.45, -0.85], 8);
L.control.zoom({ position: "bottomright" }).addTo(map);
L.control.scale({ position: "bottomright", imperial: false }).addTo(map);
for (const [name, z] of [["sat", 300], ["interp", 350], ["radar", 420], ["labels", 450], ["prov", 460]]) {
  map.createPane(name);
  map.getPane(name).style.zIndex = z;
  map.getPane(name).style.pointerEvents = "none";
}

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/";
const ATTR_E = 'Mapas &copy; <a href="https://www.esri.com">Esri</a>, HERE, Garmin, &copy; OpenStreetMap';
const esri = (svc, o = {}) => L.tileLayer(ESRI + svc + "/MapServer/tile/{z}/{y}/{x}", { maxNativeZoom: 16, maxZoom: 17, ...o });
const BASES = {
  light: () => [esri("Canvas/World_Light_Gray_Base", { attribution: ATTR_E }),
                esri("Elevation/World_Hillshade", { opacity: 0.18, maxNativeZoom: 15 }),
                esri("Canvas/World_Light_Gray_Reference", { pane: "labels" })],
  dark: () => [esri("Canvas/World_Dark_Gray_Base", { attribution: ATTR_E }),
               esri("Elevation/World_Hillshade", { opacity: 0.12, maxNativeZoom: 15, className: "hs-dark" }),
               esri("Canvas/World_Dark_Gray_Reference", { pane: "labels" })],
  sat: () => [esri("World_Imagery", { attribution: "Esri, Maxar, Earthstar Geographics", maxNativeZoom: 17 }),
              esri("Reference/World_Boundaries_and_Places", { pane: "labels" })],
  topo: () => [esri("World_Topo_Map", { attribution: ATTR_E })],
};
let baseLayers = [];
function setBase(b) {
  S.base = b;
  const kind = b === "auto" ? (isDark() ? "dark" : "light") : b;
  baseLayers.forEach(l => map.removeLayer(l));
  baseLayers = BASES[kind]();
  baseLayers.forEach(l => l.addTo(map));
  document.body.dataset.base = kind;
  $$("#base-seg button").forEach(x => x.classList.toggle("on", x.dataset.base === b));
}

/* ---------------------------------------------------------- utilidades de datos */
async function getJSON(url, { cache = "no-cache" } = {}) {
  const r = await fetch(url, { cache });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
const bust = () => `?t=${Math.floor(Date.now() / 60000)}`;

function ago(ts) {
  if (!ts) return "";
  const m = Math.round((Date.now() / 1000 - ts) / 60);
  if (m < 1) return "ahora mismo";
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `hace ${h} h ${m % 60 ? (m % 60) + " min" : ""}` : `hace ${Math.floor(h / 24)} d`;
}
const hhmm = ts => new Date(ts * 1000).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
const ddmm = d => new Date(d + "T12:00:00").toLocaleDateString("es-ES", { day: "numeric", month: "short" });

function toast(msg, ms = 3500) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

/* ---------------------------------------------------------- carga */
async function loadNow(first) {
  try {
    const doc = await getJSON(DATA_URL + "now.json" + bust());
    NOW = doc;
    STATIONS = doc.rows.map(r => Object.fromEntries(doc.cols.map((c, i) => [c, r[i]])));
    BYID = new Map(STATIONS.map(s => [s.id, s]));
    applyNormals();
    $("#updated").textContent = `Datos de las ${hhmm(doc.ts)}`;
    $("#live-pill").classList.toggle("stale", Date.now() / 1000 - doc.ts > 40 * 60);
    $("#live-pill").title = `Generado ${new Date(doc.ts * 1000).toLocaleString("es-ES")} (${ago(doc.ts)})`;
    renderStats();
    if (first) buildNets();
  } catch (e) {
    console.error(e);
    toast("No se han podido cargar los datos. Se reintentará en unos minutos.");
  }
  try { HYDRO = await getJSON(DATA_URL + "hydro.json" + bust()); } catch (e) { console.warn(e); }
  OBS10_TS = 0;   // la serie de 24 h de AEMET (toda España, ~1 MB) se pide solo cuando hace falta
  render();
  if (typeof Avisos !== "undefined") Avisos.refresh();
  if (S.side === "station" && S.sel) openStation(S.sel, false);
  if (S.side === "rank") openRanking();
}

/* ---------- normales diarias de AEMET (assets/normals.json, scripts/make_normals.py) */
let NORMALS = null;
function normalAt(c, doy) {
  let v = c[0];
  for (let k = 1; k <= 3; k++) { const w = 2 * Math.PI * k * doy / 365.25; v += c[2 * k - 1] * Math.cos(w) + c[2 * k] * Math.sin(w); }
  return Math.round(v * 10) / 10;
}
/* máxima y mínima normales de hoy y anomalías (xa, na) en las estaciones de AEMET que tienen normal */
function applyNormals() {
  if (!NORMALS || !STATIONS || !NOW) return;
  const day = NOW.day || new Date().toISOString().slice(0, 10);
  const doy = Math.round((Date.parse(day) - Date.parse(day.slice(0, 4) + "-01-01")) / 864e5);
  for (const s of STATIONS) {
    const n = s.src === "AEMET" && NORMALS.stations[s.id];
    if (!n) continue;
    if (n.x) { s.xn = normalAt(n.x, doy); s.xnp = n.xp; s.xa = s.tx != null ? Math.round((s.tx - s.xn) * 10) / 10 : null; }
    if (n.n) { s.nn = normalAt(n.n, doy); s.nnp = n.np; s.na = s.tn != null ? Math.round((s.tn - s.nn) * 10) / 10 : null; }
  }
}
const signed = (v, d = 1) => (v == null ? "–" : (v > 0 ? "+" : v < 0 ? "−" : "") + fmt(Math.abs(v), d));

async function loadStatic() {
  getJSON("assets/normals.json", { cache: "default" }).then(d => { NORMALS = d; applyNormals(); render(); }).catch(e => console.warn("normales", e));
  PROV = await getJSON("assets/provincias.geojson", { cache: "default" });
  RINGS = [];
  for (const f of PROV.features) {
    const g = f.geometry;
    for (const poly of (g.type === "MultiPolygon" ? g.coordinates : [g.coordinates])) RINGS.push(poly[0]);
  }
  provLayer = L.geoJSON(PROV, { pane: "prov", interactive: false, style: () => ({ color: cssVar("--prov") || "#555", weight: 1.4, fill: false, opacity: 0.75 }) });
  if (S.layers.prov) provLayer.addTo(map);
}
let provLayer = null;

/* ---------------------------------------------------------- controles */
function buildControls() {
  // variables agrupadas
  const groups = {};
  for (const [k, v] of Object.entries(VARS)) (groups[v.group] ||= []).push([k, v]);
  $("#var-groups").innerHTML = Object.entries(groups).map(([g, items]) => `
    <div class="var-group"><span class="var-g">${g}</span>
      <div class="chips-row">${items.map(([k, v]) => `<button class="chip var-chip" data-v="${k}" title="${esc(v.label)}">${v.short}</button>`).join("")}</div>
    </div>`).join("") + `<button class="link-btn small anim-btn" id="anim-btn" hidden>▶ Animar las últimas 24 h de AEMET</button>`;
  $("#var-groups").addEventListener("click", e => {
    const b = e.target.closest(".var-chip");
    if (b) setVar(b.dataset.v);
  });
  $("#anim-btn").addEventListener("click", () => (S.anim === "obs10" ? stopTimebar() : startObs10Anim()));

  $$("#mode-seg button").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));
  $("#filter").addEventListener("change", e => { S.filter = e.target.value; savePrefs(); render(); });
  $("#only-official").checked = S.official;
  $("#only-official").addEventListener("change", e => { S.official = e.target.checked; savePrefs(); render(); });
  $("#show-doubtful").checked = S.doubtful;
  $("#show-doubtful").addEventListener("change", e => { S.doubtful = e.target.checked; savePrefs(); render(); });
  $("#avisos-ar").checked = S.avisosAr;
  $("#avisos-ar").addEventListener("change", e => { S.avisosAr = e.target.checked; savePrefs(); if (typeof Avisos !== "undefined") Avisos.draw(); });
  $("#aemet-ar").checked = S.aemetAr;
  $("#aemet-ar").addEventListener("change", e => { S.aemetAr = e.target.checked; savePrefs(); render(); });
  $("#cluster").checked = S.cluster;
  $("#cluster").addEventListener("change", e => { S.cluster = e.target.checked; savePrefs(); render(); });
  $("#nets-all").addEventListener("click", () => {
    S.netsOff = S.netsOff.size ? new Set() : new Set(Object.keys(SOURCES).filter(k => k !== "AEMET" && k !== "SAIH"));
    savePrefs(); buildNets(); render();
  });

  for (const [id, key] of [["lyr-interp", "interp"], ["lyr-radar", "radar"], ["lyr-sat", "sat"], ["lyr-li", "li"], ["lyr-arome", "arome"], ["lyr-avisos", "avisos"],
                           ["lyr-cams", "cams"], ["lyr-manual", "manual"], ["lyr-prov", "prov"]]) {
    const el = $("#" + id);
    el.checked = !!S.layers[key];
    el.addEventListener("change", () => { S.layers[key] = el.checked; savePrefs(); toggleLayer(key); });
  }
  initToolMenus();
  $$("#base-seg button").forEach(b => b.addEventListener("click", () => { setBase(b.dataset.base); savePrefs(); }));
  $("#zone").innerHTML = `<option value="">Ir a…</option>` + Object.keys(ZONES).map(z => `<option>${z}</option>`).join("");
  $("#zone").addEventListener("change", e => { if (ZONES[e.target.value]) map.flyToBounds(ZONES[e.target.value], { duration: 0.8 }); e.target.value = ""; });

  // histórico
  const today = new Date(), iso = d => d.toISOString().slice(0, 10);
  const y = new Date(today); y.setDate(y.getDate() - 1);
  $("#h-start").value = iso(new Date(today.getFullYear(), today.getMonth(), 1));
  $("#h-end").value = iso(y);
  $("#h-var").value = S.hv;
  $("#h-var").addEventListener("change", e => { S.hv = e.target.value; savePrefs(); updateFilterOptions(); runHistory(); });
  for (const id of ["h-start", "h-end", "h-incomplete"]) $("#" + id).addEventListener("change", runHistory);
  $("#h-quick").addEventListener("click", e => {
    const q = e.target.dataset.q; if (!q) return;
    const t = new Date(), yd = new Date(t); yd.setDate(t.getDate() - 1);
    let a = yd, b = yd;
    if (q === "7") { a = new Date(yd); a.setDate(yd.getDate() - 6); }
    if (q === "month") a = new Date(t.getFullYear(), t.getMonth(), 1);
    if (q === "prevmonth") { a = new Date(t.getFullYear(), t.getMonth() - 1, 1); b = new Date(t.getFullYear(), t.getMonth(), 0); }
    if (q === "year") a = new Date(t.getFullYear(), 0, 1);
    if (q === "lastyear") { a = new Date(t.getFullYear() - 1, 0, 1); b = new Date(t.getFullYear() - 1, 11, 31); }
    const loc = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    $("#h-start").value = loc(a); $("#h-end").value = loc(b);
    runHistory();
  });

  $("#btn-rank").addEventListener("click", () => (S.side === "rank" ? closeSide() : openRanking()));
  $("#btn-sum").addEventListener("click", () => (S.side === "summary" ? closeSide() : Summary.open()));
  $("#side-close").addEventListener("click", closeSide);
  $("#btn-panel").addEventListener("click", () => document.body.classList.toggle("controls-open"));
  $("#btn-locate").addEventListener("click", () => {
    if (!navigator.geolocation) return toast("Tu navegador no permite la geolocalización.");
    navigator.geolocation.getCurrentPosition(p => map.flyTo([p.coords.latitude, p.coords.longitude], 11),
      () => toast("No se ha podido obtener tu ubicación."));
  });
  updateVarUI();
}

function buildNets() {
  const counts = {};
  for (const s of STATIONS) if (s.st !== "na") {
    const c = (counts[s.src] ||= { n: 0, ok: 0 });
    c.n++; if (s.st === "ok") c.ok++;
  }
  $("#nets").innerHTML = Object.entries(SOURCES).filter(([k]) => counts[k]).map(([k, s]) => `
    <label class="net ${S.netsOff.has(k) ? "" : "on"}" style="--c:${s.color}" title="${counts[k].ok} de ${counts[k].n} con datos ahora">
      <input type="checkbox" value="${k}" ${S.netsOff.has(k) ? "" : "checked"}>
      <span class="net-name">${s.name}</span><span class="net-n">${counts[k].ok}</span>
    </label>`).join("");
  $$("#nets input").forEach(i => i.addEventListener("change", () => {
    i.checked ? S.netsOff.delete(i.value) : S.netsOff.add(i.value);
    i.closest(".net").classList.toggle("on", i.checked);
    savePrefs(); render();
  }));
}

function renderStats() {
  if (!NOW) return;
  const st = NOW.stats || {};
  let ok = 0, n = 0;
  for (const s of Object.values(st)) { ok += s.ok || 0; n += (s.n || 0) - (s.na || 0); }
  $("#stats").innerHTML = `<b>${ok}</b> de ${n} estaciones con datos · ${ago(NOW.ts)}<br>
    <a href="https://github.com/${REPO}" target="_blank" rel="noopener">Código y datos</a> ·
    Radar <a href="https://www.eumetnet.eu/observations/opera/" target="_blank" rel="noopener">EUMETNET OPERA</a> (AEMET) ·
    Satélite <a href="https://view.eumetsat.int" target="_blank" rel="noopener">EUMETSAT</a><br>
    <a href="acerca.html">Acerca de</a> · <a href="estado.html">Estado del sistema</a> · <button class="link-btn small" id="btn-editor">Editar la red</button>`;
  $("#btn-editor").addEventListener("click", () => Editor.open());
}

function setMode(m) {
  S.mode = m;
  $$("#mode-seg button").forEach(b => b.classList.toggle("on", b.dataset.mode === m));
  $("#ctl-vars").hidden = m !== "now";
  $("#ctl-hist").hidden = m !== "hist";
  if (S.anim === "obs10") stopTimebar();
  updateFilterOptions();
  if (m === "hist") runHistory(); else render();
}

function setVar(v) {
  S.v = v;
  if (S.anim === "obs10") stopTimebar();
  savePrefs(); updateVarUI(); render();
  if (S.side === "rank") openRanking();
}

function updateVarUI() {
  $$(".var-chip").forEach(b => b.classList.toggle("on", b.dataset.v === S.v));
  $("#anim-btn").hidden = !["ta", "hr", "gust", "p1"].includes(S.v);
  updateFilterOptions();
}

function currentDef() {
  return S.mode === "hist" ? HVARS[S.hv] : VARS[S.v];
}

function updateFilterOptions() {
  const d = currentDef();
  const key = d.hydro ? null : (d.filter || (d.scale === "temp" ? "temp" : d.scale?.startsWith("prec") ? "prec"
    : d.scale === "wind" ? "wind" : d.scale === "hum" ? "hum" : "days"));
  const opts = key ? FILTERS[key] : [["all", "Todas"]];
  const sel = $("#filter");
  sel.innerHTML = opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join("");
  sel.value = opts.some(o => o[0] === S.filter) ? S.filter : "all";
  S.filter = sel.value;
  sel.disabled = !key;
}

function passFilter(v) {
  if (S.filter === "all" || v == null) return true;
  const [op, th] = S.filter.split("_"); const t = parseFloat(th);
  return op === "gte" ? v >= t : op === "gt" ? v > t : op === "lte" ? v <= t : true;
}

/* ---------------------------------------------------------- capas de estaciones */
let stationsLayer = null, hydroLayer = null, manualLayer = null, camsLayer = null, interpLayer = null;
let markersById = new Map();

function makeCluster(scaleKey) {
  return L.markerClusterGroup({
    // reglas de la web anterior: agrupar etiquetas a menos de 20 px hasta el zoom 15
    maxClusterRadius: 20, disableClusteringAtZoom: 15, showCoverageOnHover: false,
    spiderfyOnMaxZoom: false, chunkedLoading: true, animate: false,
    iconCreateFunction: cl => {
      const vals = cl.getAllChildMarkers().map(m => m.options.v).filter(v => v != null).sort((a, b) => a - b);
      const mid = vals.length >> 1;
      const med = vals.length ? (vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2) : null;
      const c = colorFor(scaleKey, med), d = cl.getAllChildMarkers()[0]?.options.dec ?? 1;
      return L.divIcon({ className: "vm-wrap", iconSize: null,
        html: `<span class="vm cl" title="Mediana de ${cl.getChildCount()} estaciones" style="background:${c};color:${inkFor(c)}">${scaleKey === "anom" ? signed(med, d) : fmt(med, d)}</span>` });
    },
  });
}

function valueOf(s, v) {
  if (s.st !== "ok") return null;
  return s[v];
}

function stationVisible(s, def, val) {
  if (s.st === "na" || S.netsOff.has(s.src) || S.hidden.has(s.id)) return false;
  if (S.aemetAr && s.src === "AEMET" && !inAragon(s)) return false;
  if (S.official && !SOURCES[s.src]?.official) return false;
  if (val == null) return false;
  if (def.q != null && s.q && s.q[def.q] === "D" && !S.doubtful) return false;
  return passFilter(val);
}

/* ---------- estaciones ocultadas a mano (Supr) */
function hideStation(id) {
  const s = BYID.get(id);
  S.hidden.add(id); savePrefs();
  closeSide(); render(); updateHiddenInfo();
  toast(`«${s?.name || id}» oculta en este navegador. Puedes volver a mostrarla en Filtro.`);
}
function updateHiddenInfo() {
  const el = $("#hidden-info");
  if (!S.hidden.size) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `${S.hidden.size} ${S.hidden.size === 1 ? "estación oculta" : "estaciones ocultas"} a mano · <button class="link-btn small" id="unhide">volver a mostrar</button>`;
  $("#unhide").addEventListener("click", () => { S.hidden.clear(); savePrefs(); render(); updateHiddenInfo(); });
}

/* ---------- ¿está la estación dentro de Aragón? (polígono provincial) */
function inAragon(s) {
  if (s._ar != null) return s._ar;
  if (s.prov) return (s._ar = true);   // las del CSV traen provincia
  if (!RINGS) return true;
  let inside = false;
  for (const ring of RINGS) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > s.lat) !== (yj > s.lat) && s.lon < (xj - xi) * (s.lat - yi) / (yj - yi) + xi) inside = !inside;
    }
  }
  return (s._ar = inside);
}

function visibleStations() {
  const def = currentDef();
  const out = [];
  if (S.mode === "hist") {
    const res = HIST.result || {};
    for (const s of STATIONS) {
      const r = res[s.id];
      if (r && stationVisible({ ...s, st: "ok" }, def, r.v)) out.push([s, r.v, r]);
    }
  } else if (!def.hydro) {
    for (const s of STATIONS) {
      const v = valueOf(s, S.v);
      if (stationVisible(s, def, v)) out.push([s, v]);
    }
  }
  return out;
}

function render() {
  if (!NOW) return;
  const def = currentDef();
  if (S.anim === "obs10") { renderLegend(def); showObs10Frame(TB.i); return; }
  stationsLayer && map.removeLayer(stationsLayer);
  hydroLayer && map.removeLayer(hydroLayer);
  stationsLayer = hydroLayer = null;
  markersById = new Map();
  if (def.hydro) {
    renderHydro(def);
  } else {
    stationsLayer = S.cluster ? makeCluster(def.scale) : L.layerGroup();
    const ms = [];
    for (const [s, v, extra] of visibleStations()) {
      const c = colorFor(def.scale, v);
      const cls = ["vm", SOURCES[s.src]?.official ? "official" : "", s.q?.[def.q] === "C" ? "checked" : "",
                   s.q?.[def.q] === "D" ? "doubtful" : "", extra && extra.gaps ? "gappy" : ""].join(" ");
      const m = L.marker([s.lat, s.lon], {
        v, dec: def.dec, keyboard: false, riseOnHover: true,
        zIndexOffset: SOURCES[s.src]?.official ? 1000 : 0,   // AEMET y SAIH por encima si se tocan
        icon: L.divIcon({ className: "vm-wrap", iconSize: null, html: `<span class="${cls}" style="background:${c};color:${inkFor(c)}">${def.signed ? signed(v, def.dec) : fmt(v, def.dec)}</span>` }),
      });
      m.on("click", () => openStation(s.id));
      m.bindTooltip(`${esc(s.name)} · ${SOURCES[s.src]?.name || s.src}`, { direction: "top", offset: [0, -8], opacity: 0.95 });
      ms.push(m); markersById.set(s.id, m);
    }
    if (S.cluster) stationsLayer.addLayers(ms); else ms.forEach(m => stationsLayer.addLayer(m));
    stationsLayer.addTo(map);
  }
  if (S.anim === "arome") Arome.legend(); else renderLegend(def);
  if (S.layers.interp) drawInterp();
  if (S.layers.manual) toggleLayer("manual");
  if (S.side === "rank") openRanking();
}

/* ---------- ríos y embalses */
// aforos con caudal poco fiable que no se pintan (como en la web anterior)
const BAD_FLOW = new Set(["A312"]);   // Bailín (Sabiñánigo)
const RES_COLORS = [[80, "#1864ab"], [60, "#4dabf7"], [40, "#fab005"], [20, "#f08c00"], [-1, "#c92a2a"]];
const resColor = p => (p == null ? "#8a8f98" : RES_COLORS.find(([t]) => p >= t)[1]);
const arrow = tr => (tr === 1 ? "↑" : tr === -1 ? "↓" : tr === 0 ? "→" : "");

function gaugeLevel(g, rec) {
  const h = rec?.h;
  const y = parseFloat(g.warn_yellow), o = parseFloat(g.warn_orange), r = parseFloat(g.warn_red);
  if (h == null) return ["sin dato", "#8a8f98"];
  if (!Number.isNaN(r) && h >= r) return ["Aviso rojo", "#c92a2a"];
  if (!Number.isNaN(o) && h >= o) return ["Aviso naranja", "#f76707"];
  if (!Number.isNaN(y) && h >= y) return ["Aviso amarillo", "#f2c500"];
  return ["Normal", "#2f9e44"];
}

function renderHydro(def) {
  if (!HYDRO) return;
  hydroLayer = L.layerGroup();
  if (def.hydro === "gauges") {
    for (const g of HYDRO.meta.gauges) {
      if (BAD_FLOW.has(g.id)) continue;
      const rec = HYDRO.gauges[g.id];
      if (!rec || rec.q == null && rec.h == null) continue;
      const [lvl, c] = gaugeLevel(g, rec);
      const txt = rec.q != null ? fmt(rec.q, rec.q >= 100 ? 0 : 1) : `${fmt(rec.h, 2)} m`;
      const html = `<span class="vm hydro ${rec.stale ? "stale" : ""}" style="background:${c};color:${inkFor(c)}">${txt}<i>${arrow(rec.tr)}</i></span>`;
      const m = L.marker([+g.lat, +g.lon], { keyboard: false, riseOnHover: true, icon: L.divIcon({ className: "vm-wrap", iconSize: null, html }) });
      m.bindTooltip(`${esc(g.name)} · ${lvl}`, { direction: "top", offset: [0, -8] });
      m.on("click", () => openHydro("gauges", g.id));
      hydroLayer.addLayer(m);
    }
  } else {
    for (const r of HYDRO.meta.reservoirs) {
      const rec = HYDRO.reservoirs[r.id];
      if (!rec) continue;
      const cap = parseFloat(r.capacity_hm3) || 10;
      const c = resColor(rec.pct);
      const rad = Math.max(7, Math.min(30, Math.sqrt(cap) * 1.6));
      L.circleMarker([+r.lat, +r.lon], { radius: rad, color: c, weight: 2, fillColor: c, fillOpacity: 0.18, interactive: false }).addTo(hydroLayer);
      const html = `<span class="vm hydro" style="background:${c};color:${inkFor(c)}">${fmt(rec.pct, 0)}%<i>${arrow(rec.tr)}</i></span>`;
      const m = L.marker([+r.lat, +r.lon], { keyboard: false, riseOnHover: true, icon: L.divIcon({ className: "vm-wrap", iconSize: null, html }) });
      m.bindTooltip(`${esc(r.name)} · ${fmt(rec.vol, 1)} de ${fmt(cap, 1)} hm³`, { direction: "top", offset: [0, -8] });
      m.on("click", () => openHydro("reservoirs", r.id));
      hydroLayer.addLayer(m);
    }
  }
  hydroLayer.addTo(map);
}

/* ---------------------------------------------------------- leyenda */
function renderLegend(def) {
  const el = $("#legend");
  if (def.hydro === "gauges") {
    el.innerHTML = `<div class="lg-title">Caudal (m³/s) · color según el nivel</div><div class="lg-cats">${
      [["#2f9e44", "Normal"], ["#f2c500", "Amarillo"], ["#f76707", "Naranja"], ["#c92a2a", "Rojo"]]
        .map(([c, t]) => `<span><i style="background:${c}"></i>${t}</span>`).join("")}<span>↑↓ tendencia 3 h</span></div>`;
    return;
  }
  if (def.hydro === "reservoirs") {
    el.innerHTML = `<div class="lg-title">Reserva (%) · tamaño según capacidad</div><div class="lg-cats">${
      [["#c92a2a", "< 20"], ["#f08c00", "20–40"], ["#fab005", "40–60"], ["#4dabf7", "60–80"], ["#1864ab", "≥ 80"]]
        .map(([c, t]) => `<span><i style="background:${c}"></i>${t}</span>`).join("")}<span>↑↓ en 24 h</span></div>`;
    return;
  }
  const sc = SCALES[legendScale(def)];
  const stops = sc.stops.slice().reverse();
  if (def.continuous) {   // degradado sin saltos: cada umbral en una posición equiespaciada
    const n = stops.length - 1;
    const grad = stops.map(([, c], i) => `${c} ${(100 * i / n).toFixed(2)}%`).join(", ");
    const every = Math.ceil(stops.length / 10);
    const ticks = stops.map(([t], i) => (n - i) % every ? "" :
      `<span style="left:${(100 * i / n).toFixed(2)}%">${String(t).replace(".", ",")}</span>`).join("");
    el.innerHTML = `<div class="lg-title">${esc(def.label)} <small>${def.unit}</small></div>
      <div class="lg-bar lg-grad" style="background:linear-gradient(to right, ${grad})"></div><div class="lg-ticks abs">${ticks}</div>`;
    return;
  }
  const cells = [`<span class="lg-c" style="background:${sc.below}"></span>`].concat(stops.map(([t, c]) => `<span class="lg-c" style="background:${c}" title="> ${t}"></span>`));
  const every = Math.ceil(stops.length / 11);
  const labels = [`<span></span>`].concat(stops.map(([t], i) => `<span>${(stops.length - 1 - i) % every ? "" : String(t).replace(".", ",")}</span>`));
  el.innerHTML = `<div class="lg-title">${esc(def.label)} <small>${def.unit}</small></div>
    <div class="lg-bar">${cells.join("")}</div><div class="lg-ticks">${labels.join("")}</div>`;
}
const legendScale = def => def.scale;

/* ---------------------------------------------------------- histórico */
async function loadMonth(mon) {
  if (HIST.months.has(mon)) return HIST.months.get(mon);
  const p = getJSON(HIST_URL + mon + ".json" + (mon >= new Date().toISOString().slice(0, 7) ? bust() : ""), { cache: "default" })
    .catch(() => null);
  HIST.months.set(mon, p);
  return p;
}

function monthsBetween(a, b) {
  const out = [];
  let [y, m] = a.split("-").map(Number);
  const [yb, mb] = b.split("-").map(Number);
  while (y < yb || (y === yb && m <= mb)) { out.push(`${y}-${String(m).padStart(2, "0")}`); m++; if (m > 12) { m = 1; y++; } }
  return out;
}

function dayList(a, b) {
  const out = [];
  for (let t = Date.parse(a + "T12:00:00Z"); t <= Date.parse(b + "T12:00:00Z"); t += 864e5) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

async function runHistory() {
  const a = $("#h-start").value, b = $("#h-end").value;
  if (!a || !b || a > b) { $("#h-status").textContent = "Elige un período válido."; return; }
  const def = HVARS[S.hv];
  const token = (runHistory.token = (runHistory.token || 0) + 1);
  $("#h-status").textContent = "Cargando…";
  const days = dayList(a, b), pos = new Map(days.map((d, k) => [d, k])), nDays = days.length;
  const value = (cols, k) => def.f === "m"
    ? (cols.x?.[k] != null && cols.n?.[k] != null ? (cols.x[k] + cols.n[k]) / 2 : null)
    : cols[def.f]?.[k] ?? null;
  // redes de aficionados y SAIH: history/AAAA-MM.json de este repositorio
  const docs = (await Promise.all(monthsBetween(a, b).map(loadMonth))).filter(Boolean);
  const series = new Map();
  for (const doc of docs) {
    doc.days.forEach((d, k) => {
      const i = pos.get(d);
      if (i == null) return;
      for (const [id, cols] of Object.entries(doc.data)) {
        if (BYID.get(id)?.src === "AEMET") continue;   // AEMET sale de aemet-explorer
        const v = value(cols, k);
        if (v == null) continue;
        if (!series.has(id)) series.set(id, new Array(nDays).fill(null));
        series.get(id)[i] = v;
      }
    });
  }
  // AEMET: series oficiales de aemet-explorer
  try {
    const ae = await AemetHist.range(days, (k, n, full) => {
      if (full && token === runHistory.token) $("#h-status").textContent = `Cargando las series de AEMET… ${k}/${n}`;
    });
    for (const [id, cols] of ae) series.set(id, days.map((_, k) => value(cols, k)));
  } catch (e) { console.warn("AEMET histórico", e); }
  if (token !== runHistory.token) return;   // se ha pedido otro período mientras tanto

  const res = {};
  const allowGaps = $("#h-incomplete").checked;
  for (const [id, vals] of series) {
    const ok = vals.filter(v => v != null);
    if (!ok.length) continue;
    const cover = ok.length / nDays;
    if (!allowGaps && cover < 0.9) continue;
    let v;
    switch (def.agg) {
      case "max": v = Math.max(...ok); break;
      case "min": v = Math.min(...ok); break;
      case "mean": v = ok.reduce((t, x) => t + x, 0) / ok.length; break;
      case "sum": v = ok.reduce((t, x) => t + x, 0); break;
      case "count": v = ok.filter(x => x >= def.th).length; break;
      case "below": v = ok.filter(x => x < def.th).length; break;
    }
    res[id] = { v: Math.round(v * 10) / 10, n: ok.length, gaps: cover < 0.999 };
  }
  HIST.result = res;
  HIST.range = [a, b, nDays];
  if (def.f === "p" && def.agg === "sum") def.scale = nDays > 100 ? "precYear" : nDays > 10 ? "precMonth" : "prec";
  const n = Object.keys(res).length;
  $("#h-status").textContent = n
    ? `${n} estaciones · ${nDays} días${allowGaps ? "" : " (solo con ≥ 90 % de días)"}. AEMET: series oficiales de aemet-explorer; Wunderground desde 2024; el resto, desde que se cierra cada día aquí.`
    : "No hay histórico para ese período.";
  render();
}

/* ---------------------------------------------------------- interpolación */
function drawInterp() {
  interpLayer && map.removeLayer(interpLayer);
  interpLayer = null;
  interpNote("");
  const def = currentDef();
  if (!S.layers.interp || def.hydro || !RINGS) return;
  const pts = visibleStations().filter(([s]) => s.ar).map(([s, v]) => ({ lat: s.lat, lon: s.lon, alt: s.alt, v, s }));
  const kind = def.scale === "temp" ? "temp" : def.scale?.startsWith("prec") ? "prec" : def.scale === "wind" ? "wind" : def.scale === "hum" ? "hum" : "days";
  const token = (drawInterp.n = (drawInterp.n || 0) + 1);
  // temperatura: se espera al modelo del terreno (una sola descarga); si falla, krigeado sin altitud
  // lluvia en directo: fuera los pluviómetros que han estado en la nieve (ver snowGauges)
  let snowOut = [];
  const ready = kind === "temp" ? Interp.loadDEM().catch(e => console.warn("DEM", e))
    : kind === "prec" && S.mode !== "hist" ? snowGauges(pts, S.v).then(o => { snowOut = o; }).catch(e => console.warn("cota de nieve", e))
    : Promise.resolve();
  ready.then(() => setTimeout(() => {
    if (token !== drawInterp.n) return;   // ya se pidió otro dibujo
    const t0 = performance.now();
    const mod = Interp.fit(snowOut.length ? pts.filter(p => !snowOut.includes(p)) : pts, { scale: def.scale, kind });
    if (!mod) return toast("No hay estaciones suficientes para interpolar.");
    interpLayer && map.removeLayer(interpLayer);
    interpLayer = new Interp.Layer(mod, RINGS, { opacity: 0.62, unit: def.unit, dec: def.scale === "wind" || def.scale === "hum" ? 0 : 1 }).addTo(map);
    interpNote(mod.trend ? `Krigeado con altitud: ${mod.note}`
      : snowOut.length ? `Krigeado sin ${snowOut.length} ${snowOut.length === 1 ? "pluviómetro" : "pluviómetros"} en la nieve (por encima de la cota de AROME y por debajo de sus vecinas)` : "",
      snowOut.map(p => `${p.s.name} (${Math.round(p.s.alt)} m): ${fmt(p.v, 1)} mm`).join("\n"));
    console.info(`krigeado: ${mod.n} puntos en ${Math.round(performance.now() - t0)} ms${mod.trend ? " · " + mod.note : ""}`);
  }, 30));
}
/* nota bajo la leyenda (gradiente con la altitud ajustado) */
function interpNote(txt, title = "") {
  let el = $("#lg-interp");
  if (!txt) { el?.remove(); return; }
  if (!el) { el = document.createElement("div"); el.id = "lg-interp"; el.className = "lg-note"; $("#legend").appendChild(el); }
  el.textContent = txt;
  el.title = title;
}

/* Pluviómetros en la nieve. Los de aficionado no son calefactados: con nieve marcan poco o nada
   (y más tarde, al fundirse, lluvia que no toca), y el krigeado pinta «huevos fritos» en el Pirineo.
   Una estación se deja fuera si en el periodo de la lluvia ha estado en la nieve —por encima de la
   cota de nieve más baja de AROME en ese punto (con 100 m de margen) o a 1 °C o menos ahora— y además
   ha recogido menos de la mitad que sus vecinas (≤ 30 km) que no estaban en la nieve, o, si no hay
   al menos 2 de esas, que el 75 % de todas sus vecinas. Las que recogen como sus vecinas (calefactadas,
   o lluvia de verdad) se quedan. */
async function snowGauges(pts, v) {
  const now = Date.now(), H = 3600e3;
  const t0 = v === "p1" ? now - H : v === "p24" ? now - 24 * H
    : new Date(new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Madrid" }) + "T00:00:00").getTime();
  const cota = await Arome.cotaMin(pts, t0, now);
  if (!cota) return [];
  const snowy = pts.map((p, i) => (cota[i] != null && p.alt != null && p.alt >= cota[i] - 100) || (p.s.ta != null && p.s.ta <= 1));
  if (!snowy.some(Boolean)) return [];
  const KX = 111.32 * Math.cos(41.4 * Math.PI / 180), KY = 110.57;
  const med = a => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const q75 = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(0.75 * s.length))]; };
  const out = [];
  pts.forEach((p, i) => {
    if (!snowy[i]) return;
    const warm = [], all = [];
    pts.forEach((q, j) => {
      if (i === j || Math.hypot((p.lon - q.lon) * KX, (p.lat - q.lat) * KY) > 30) return;
      all.push(q.v);
      if (!snowy[j]) warm.push(q.v);
    });
    const ref = warm.length >= 2 ? med(warm) : all.length >= 3 ? q75(all) : null;
    if (ref != null && ref >= 1 && p.v < 0.5 * ref) out.push(p);
  });
  return out;
}

/* ---------------------------------------------------------- capas extra */
let satLayer = null, liLayer = null;

async function toggleLayer(key) {
  await toggleLayerInner(key);
  syncTools();
}

async function toggleLayerInner(key) {
  const on = S.layers[key];
  if (key === "prov") { provLayer && (on ? provLayer.addTo(map) : map.removeLayer(provLayer)); return; }
  if (key === "interp") { drawInterp(); return; }
  if (key === "arome") { on ? Arome.start() : Arome.stop(); return; }
  if (key === "avisos") { if (typeof Avisos !== "undefined") Avisos.refresh(); return; }
  if (on && ["radar", "sat", "li"].includes(key) && S.layers.arome) { S.layers.arome = false; $("#lyr-arome").checked = false; Arome.stop(); }
  if (key === "cams") {
    if (!on) { camsLayer && map.removeLayer(camsLayer); return; }
    if (!CAMS) { try { CAMS = await getJSON(DATA_URL + "webcams.json" + bust()); } catch { return toast("No se han podido cargar las webcams."); } }
    camsLayer ||= L.layerGroup(CAMS.cams.map(c => L.marker([c.lat, c.lon], {
      icon: L.divIcon({ className: "cam-icon " + (c.src === "DGT" ? "dgt" : ""), html: "<span></span>", iconSize: [18, 14] }), keyboard: false,
    }).bindPopup(() => camPopup(c), { maxWidth: 360, minWidth: 260 })));
    camsLayer.addTo(map);
    return;
  }
  if (key === "manual") {
    manualLayer && map.removeLayer(manualLayer);
    if (!on) return;
    manualLayer = L.layerGroup(STATIONS.filter(s => s.src === "AEMET" && s.st === "na").map(s =>
      L.circleMarker([s.lat, s.lon], { radius: 3.5, weight: 1, color: "#5f3dc4", fillColor: "#9775fa", fillOpacity: 0.85 })
        .bindTooltip(`${esc(s.name)} · AEMET ${esc((s.notes || "").toLowerCase())} (${s.id})`)));
    manualLayer.addTo(map);
    return;
  }
  if (key === "radar") {
    if (!on) { Radar.stop(); refreshTimebar(); return; }
    try { await Radar.start(); }
    catch { S.layers.radar = false; $("#lyr-radar").checked = false; return toast("El radar no está disponible ahora."); }
    refreshTimebar(true);
    return;
  }
  if (key === "sat" || key === "li") {
    if (key === "sat" && !on) { satLayer && map.removeLayer(satLayer); satLayer = null; }
    if (key === "li" && !on) { liLayer && map.removeLayer(liLayer); liLayer = null; }
    refreshTimebar(true);
  }
}

function camPopup(c) {
  const img = c.img ? `<a href="${esc(c.link)}" target="_blank" rel="noopener"><img class="cam-img" src="${esc(c.link)}?t=${Date.now()}" alt="Imagen de la cámara" loading="lazy"></a>` : "";
  return `<div class="cam-pop"><b>${esc(c.name)}</b>${c.src === "DGT" ? ` <span class="tag">DGT</span>` : ""}
    ${c.notes ? `<div class="muted">${esc(c.notes)}</div>` : ""}${img}
    <a class="btn-link" href="${esc(c.link)}" target="_blank" rel="noopener">${c.img ? "Abrir imagen" : "Ver la cámara"} ↗</a></div>`;
}


/* ---------- menús de la barra superior: radar, satélite y modelos */
function applyHide() {
  document.body.classList.toggle("hide-stations",
    !!((S.layers.arome && $("#arome-hide").checked) || (S.layers.radar && $("#radar-hide").checked)));
}
function setLayer(key, on) {
  if (!!S.layers[key] === on) return Promise.resolve();
  $("#lyr-" + key).checked = on;
  S.layers[key] = on; savePrefs();
  return toggleLayer(key);
}
const CHOOSE = {
  radar: async v => {
    if (v === "off") return setLayer("radar", false);
    Radar.setMode(v);
    if (S.layers.radar) refreshTimebar(true); else await setLayer("radar", true);
  },
  sat: async v => {
    if (v === "off") return setLayer("sat", false);
    const changed = S.sat !== v;
    S.sat = v; savePrefs();
    if (!S.layers.sat) return setLayer("sat", true);
    if (changed) { satLayer && map.removeLayer(satLayer); satLayer = null; await toggleLayer("sat"); }
  },
  model: async v => {
    if (v === "off") return setLayer("arome", false);
    if (!S.layers.arome) await setLayer("arome", true);
    if (S.layers.arome) Arome.setVar(v);
  },
};
function closeMenus() {
  $$(".tool-menu").forEach(m => (m.hidden = true));
  $$(".map-tools [data-menu]").forEach(b => b.setAttribute("aria-expanded", "false"));
}
function initToolMenus() {
  $$(".map-tools [data-menu]").forEach(b => b.addEventListener("click", e => {
    e.stopPropagation();
    const m = $("#" + b.dataset.menu), open = m.hidden;
    closeMenus();
    m.hidden = !open;
    b.setAttribute("aria-expanded", String(open));
  }));
  $$(".tool-menu").forEach(m => m.addEventListener("click", e => e.stopPropagation()));
  document.addEventListener("click", closeMenus);
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeMenus(); });
  for (const [box, kind] of [["#radar-opts", "radar"], ["#radar-acc", "radar"], ["#sat-opts", "sat"], ["#model-opts", "model"]]) {
    $$(box + " button").forEach(b => b.addEventListener("click", async () => { await CHOOSE[kind](b.dataset.v); syncTools(); }));
  }
  $("#radar-hide").addEventListener("change", applyHide);
  $("#radar-gif").addEventListener("click", e => Radar.exportGif(e.currentTarget));
  $$("#radar-win button").forEach(b => b.addEventListener("click", () => {
    Radar.setWin(+b.dataset.w);
    if (S.layers.radar) refreshTimebar(true);
    syncTools();
  }));
  syncTools();
}
const SATNAME = { ir: "Infrarrojo", vis: "Visible", geo: "GeoColor" };
const MODELNAME = { pr1: "lluvia 1 h", pacc: "acumulada", gust: "racha", t2m: "temperatura", snow: "nieve", cota: "cota de nieve" };
function syncTools() {
  if (!$("#btn-radar")) return;
  const rm = S.layers.radar ? Radar.mode() : "off", sm = S.layers.sat ? S.sat : "off", am = S.layers.arome ? Arome.current() : "off";
  const mark = (box, v) => $$(box + " button").forEach(b => b.classList.toggle("on", b.dataset.v === v));
  mark("#radar-opts", rm); mark("#radar-acc", rm);
  const rw = typeof Radar === "undefined" ? 3 : Radar.win();   // syncTools corre antes de cargar radar.js
  $$("#radar-win button").forEach(b => b.classList.toggle("on", +b.dataset.w === rw));
  $("#radar-winbox").hidden = rm.startsWith("a"); mark("#sat-opts", sm); mark("#model-opts", am);
  const state = (btn, on, txt) => { $(btn).classList.toggle("on", on); $(btn + " .tool-state").textContent = txt; };
  state("#btn-radar", rm !== "off", ({ zh: "alta resolución", zl: "baja resolución", v: "velocidad" }[rm] || (rm.startsWith("a") ? `lluvia ${rm.slice(1)} h` : "")));
  state("#btn-sat", sm !== "off" || !!S.layers.li, [sm !== "off" && SATNAME[sm].toLowerCase(), S.layers.li && "rayos"].filter(Boolean).join(" + "));
  state("#btn-model", am !== "off", am !== "off" ? "AROME · " + MODELNAME[am] : "");
  applyHide();
}

/* ---------- barra de tiempo: radar, satélite, rayos y animación AEMET */
const SAT_LAYERS = { ir: "mtg_fd:ir105_hrfi", vis: "mtg_fd:vis06_hrfi", geo: "mtg_fd:rgb_geocolour" };
const EUM_WMS = "https://view.eumetsat.int/geoserver/ows";
let TB = { frames: [], i: 0, timer: null };

function satTimes(n = 18) {   // instantes de 10 min, con ~20 min de retraso de EUMETSAT
  const step = 600e3, last = Math.floor((Date.now() - 20 * 60e3) / step) * step;
  return Array.from({ length: n }, (_, k) => last - (n - 1 - k) * step);
}

function refreshTimebar(goLast) {
  if (S.anim === "obs10" || S.anim === "arome") return;
  const radarOn = S.layers.radar && Radar.ready(), satOn = S.layers.sat || S.layers.li;
  if (!radarOn && !satOn) { stopTimebar(); return; }
  let frames;
  if (radarOn) frames = Radar.frames();
  else frames = satTimes().map(t => ({ t }));
  TB.frames = frames;
  S.anim = "layers";
  const r = $("#tb-range");
  r.max = frames.length - 1;
  if (goLast || TB.i >= frames.length) TB.i = frames.length - 1;
  r.value = TB.i;
  $("#timebar").hidden = false;
  $("#tb-what").textContent = [radarOn && ("Radar · " + Radar.MODES[Radar.mode()].label.toLowerCase()), S.layers.sat && "Satélite", S.layers.li && "Rayos"].filter(Boolean).join(" · ");
  showFrame(TB.i);
}

function showFrame(i) {
  TB.i = +i;
  if (S.anim === "obs10") return showObs10Frame(TB.i);
  if (S.anim === "arome") return Arome.show(TB.i);
  const f = TB.frames[TB.i];
  if (!f) return;
  const long = TB.frames.at(-1).t - TB.frames[0].t > 6 * 3600e3;   // ventanas largas: con el día
  $("#tb-label").textContent = new Date(f.t).toLocaleString("es-ES", long ? { weekday: "short", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" }) + (f.nowcast ? " (previsión)" : "");
  if (S.layers.radar && f.rf) Radar.show(f.rf);
  const satT = new Date(Math.min(f.t, Date.now() - 20 * 60e3) - (Math.min(f.t, Date.now() - 20 * 60e3) % 600e3)).toISOString().slice(0, 19) + "Z";
  if (S.layers.sat) {
    if (!satLayer) satLayer = L.tileLayer.wms(EUM_WMS, { layers: SAT_LAYERS[S.sat], format: "image/jpeg", transparent: false, version: "1.3.0", pane: "sat", opacity: 0.9, attribution: "EUMETSAT", time: satT }).addTo(map);
    else satLayer.setParams({ time: satT });
  }
  if (S.layers.li) {
    if (!liLayer) liLayer = L.tileLayer.wms(EUM_WMS, { layers: "mtg_fd:li_afa", format: "image/png", transparent: true, version: "1.3.0", pane: "radar", opacity: 0.9, attribution: "EUMETSAT", time: satT }).addTo(map);
    else liLayer.setParams({ time: satT });
  }
}

function stopTimebar() {
  clearInterval(TB.timer); TB.timer = null;
  $("#tb-play").textContent = "▶";
  if (S.anim === "obs10") { S.anim = null; $("#anim-btn").textContent = "▶ Animar las últimas 24 h de AEMET"; render(); refreshTimebar(true); return; }
  S.anim = null;
  $("#timebar").hidden = true;
}

map.on("moveend", () => {
  if (S.anim === "obs10") showObs10Frame(TB.i);
  if (S.side === "rank") openRanking();
});
$("#tb-range").addEventListener("input", e => { clearInterval(TB.timer); TB.timer = null; $("#tb-play").textContent = "▶"; showFrame(e.target.value); });
$("#tb-play").addEventListener("click", () => {
  if (TB.timer) { clearInterval(TB.timer); TB.timer = null; $("#tb-play").textContent = "▶"; return; }
  $("#tb-play").textContent = "⏸";
  TB.timer = setInterval(() => {
    const n = TB.frames.length;
    TB.i = (TB.i + 1) % n;
    $("#tb-range").value = TB.i;
    showFrame(TB.i);
  }, S.anim === "obs10" ? 350 : S.anim === "arome" ? 650 : Math.max(150, Math.min(700, 12600 / TB.frames.length)));   // radar: ~13 s la vuelta si hay muchas
});

/* animación de las observaciones diezminutales de AEMET */
async function startObs10Anim() {
  if (S.layers.arome) { S.layers.arome = false; $("#lyr-arome").checked = false; Arome.stop(); }
  $("#anim-btn").textContent = "Cargando…";
  await ensureObs10();
  $("#anim-btn").textContent = "▶ Animar las últimas 24 h de AEMET";
  if (!OBS10) return toast("Las observaciones de AEMET aún no están disponibles.");
  const t0 = Date.parse(OBS10.t0);
  TB.frames = Array.from({ length: OBS10.n }, (_, k) => ({ t: t0 + k * OBS10.step * 1000, k }));
  S.anim = "obs10";
  $("#anim-btn").textContent = "■ Parar la animación";
  const r = $("#tb-range");
  r.max = TB.frames.length - 1; r.value = TB.i = TB.frames.length - 1;
  $("#timebar").hidden = false;
  $("#tb-what").textContent = "AEMET · cada 10 min";
  showObs10Frame(TB.i);
}

function obs10Value(d, v, k) {
  if (v === "ta") return d.ta?.[k];
  if (v === "hr") return d.hr?.[k];
  if (v === "gust") return d.vmax?.[k] != null ? Math.round(d.vmax[k] * 3.6) : null;
  if (v === "p1") {
    const a = d.p10 || []; let s = 0, any = false;
    for (let j = Math.max(0, k - 5); j <= k; j++) if (a[j] != null) { s += a[j]; any = true; }
    return any ? Math.round(s * 10) / 10 : null;
  }
  return null;
}

function showObs10Frame(k) {
  const def = VARS[S.v];
  const f = TB.frames[k];
  $("#tb-label").textContent = new Date(f.t).toLocaleString("es-ES", { weekday: "short", hour: "2-digit", minute: "2-digit" });
  stationsLayer && map.removeLayer(stationsLayer);
  stationsLayer = L.layerGroup();
  const view = map.getBounds().pad(0.15);
  for (const [id, d] of Object.entries(OBS10.data)) {
    const m = OBS10.meta[id]; if (!m || !view.contains([m[1], m[2]]) || S.hidden.has(id)) continue;
    if (S.aemetAr && !inAragon(BYID.get(id) || { lat: m[1], lon: m[2] })) continue;
    const v = obs10Value(d, S.v, k);
    if (v == null || !passFilter(v)) continue;
    const c = colorFor(def.scale, v);
    const mk = L.marker([m[1], m[2]], { keyboard: false, icon: L.divIcon({ className: "vm-wrap", iconSize: null, html: `<span class="vm official" style="background:${c};color:${inkFor(c)}">${fmt(v, def.dec)}</span>` }) });
    mk.on("click", () => openStation(id));
    mk.bindTooltip(esc(BYID.get(id)?.name || m[0]), { direction: "top", offset: [0, -8] });
    stationsLayer.addLayer(mk);
  }
  stationsLayer.addTo(map);
}

/* ---------------------------------------------------------- panel lateral */
function openSide(kind, html) {
  S.side = kind;
  document.body.classList.toggle("side-wide", S.wide && (kind === "station" || kind === "point"));
  $("#side-body").innerHTML = html;
  $("#side").hidden = false;
  document.body.classList.add("side-open");
  $("#btn-rank").classList.toggle("on", kind === "rank");
}
function closeSide() {
  S.side = null; S.sel = null;
  document.body.classList.remove("side-wide");
  $("#side").hidden = true;
  document.body.classList.remove("side-open");
  $("#btn-rank").classList.remove("on");
  selMarker && map.removeLayer(selMarker);
  if (location.hash.includes("/")) history.replaceState(null, "", location.pathname + location.search);
}
let selMarker = null;

function tile(label, val, unit, color, sub) {
  return `<div class="tile" style="--c:${color || "var(--muted)"}"><span class="tl">${label}</span>
    <span class="tv num">${val}<small>${val === "–" ? "" : unit}</small></span>${sub ? `<span class="ts">${sub}</span>` : ""}</div>`;
}

const QTXT = { C: ["Contrastada", "ok"], D: ["Dudosa", "bad"] };

function openStation(id, fly = true) {
  const s = BYID.get(id);
  const o10 = OBS10?.data?.[id];
  if (!s && !o10) return;
  S.sel = id;
  const st = s || { id, src: "AEMET", name: OBS10.meta[id][0], lat: OBS10.meta[id][1], lon: OBS10.meta[id][2], alt: OBS10.meta[id][3], st: "ok", q: "----" };
  selMarker && map.removeLayer(selMarker);
  selMarker = L.circleMarker([st.lat, st.lon], { radius: 16, color: cssVar("--accent") || "#e8590c", weight: 3, fill: false, interactive: false }).addTo(map);
  if (fly && map.getZoom() < 10) map.flyTo([st.lat, st.lon], 10, { duration: 0.6 });
  history.replaceState(null, "", `#${S.v}/${encodeURIComponent(id)}`);

  const src = SOURCES[st.src] || { name: st.src };
  const q = st.q || "----";
  const qbadge = (k, i) => QTXT[q[i]] ? `<span class="badge ${QTXT[q[i]][1]}">${k}: ${QTXT[q[i]][0]}</span>` : "";
  const ok = st.st === "ok";
  const tiles = [
    tile("Actual", fmt(st.ta), "°C", st.ta != null && colorFor("temp", st.ta), st.t ? hhmm(st.t) : ""),
    tile("Máxima", fmt(st.tx), "°C", st.tx != null && colorFor("temp", st.tx), st.xn != null ? `normal ${fmt(st.xn)} · <b>${signed(st.xa)}</b>` : ""),
    tile("Mínima", fmt(st.tn), "°C", st.tn != null && colorFor("temp", st.tn), st.nn != null ? `normal ${fmt(st.nn)} · <b>${signed(st.na)}</b>` : ""),
    tile("Lluvia hoy", fmt(st.pr), "mm", st.pr != null && colorFor("prec", st.pr)),
    tile("Última hora", fmt(st.p1), "mm", st.p1 != null && colorFor("prec1h", st.p1)),
    tile("24 horas", fmt(st.p24), "mm", st.p24 != null && colorFor("prec", st.p24)),
    tile("Racha máx.", fmt(st.gust, 0), "km/h", st.gust != null && colorFor("wind", st.gust)),
    tile("Viento", fmt(st.ws, 0), "km/h", st.ws != null && colorFor("wind", st.ws), st.wg != null ? `racha ${fmt(st.wg, 0)}` : ""),
    tile("Humedad", fmt(st.hr, 0), "%", st.hr != null && colorFor("hum", st.hr)),
  ].join("");
  const status = st.st === "ok" ? `Último dato ${ago(st.t)}` : st.st === "off" ? `<b class="bad-txt">Sin datos recientes</b>${st.t ? ` (último ${ago(st.t)})` : ""}` : "Esta red no se descarga ahora mismo";
  const html = `
    <div class="eyebrow"><span class="src-dot" style="--c:${src.color || "#888"}"></span>${esc(src.name)}${st.prov ? ` · ${({ H: "Huesca", Z: "Zaragoza", T: "Teruel" })[st.prov] || ""}` : ""}</div>
    <h2 class="st-name">${esc(st.name)}</h2>
    <div class="st-meta">${st.alt != null ? `<span class="tag">${st.alt} m</span>` : ""}<span class="tag mono">${esc(st.id)}</span>
      ${st.model ? `<span class="tag">${esc(st.model)}</span>` : ""}</div>
    <p class="st-status">${status}</p>
    ${ok ? `<div class="tiles">${tiles}</div>` : ""}
    <div class="badges">${qbadge("Máx", 0)}${qbadge("Mín", 1)}${qbadge("Lluvia", 2)}${qbadge("Viento", 3)}
      ${st.tzs ? `<span class="badge warn" title="El contador de lluvia de esta estación se reinicia a otra hora; la lluvia de hoy se calcula sumando incrementos">Lluvia recalculada</span>` : ""}</div>
    ${st.qc?.length ? `<div class="qc-box" id="qc-box"></div>` : ""}
    ${st.notes && !/^tag=/.test(st.notes) ? `<p class="note">${esc(st.notes.replace(/\s*tag=\S+/, ""))}</p>` : ""}
    <div id="rec-box"></div>
    ${forecastTabsHTML(true)}
    <div class="chart-block" id="tab-obs"><div class="chart-title" id="chart-title"></div><div class="plot" id="plot-a"></div><div class="plot plot-sm" id="plot-b"></div></div>
    ${forecastBodyHTML(st.alt != null)}
    <div class="side-actions">
      ${st.link ? `<a class="btn" href="${esc(st.link)}" target="_blank" rel="noopener">Ver en ${esc(src.name)} ↗</a>` : ""}
      <button class="btn ghost" id="btn-share">Copiar enlace</button>
      <button class="btn ghost" id="btn-hide" title="Ocultar esta estación del mapa en este navegador (tecla Supr)">Ocultar <kbd>Supr</kbd></button>
    </div>`;
  openSide("station", html);
  $("#btn-share").addEventListener("click", () => {
    navigator.clipboard?.writeText(location.href).then(() => toast("Enlace copiado."));
  });
  $("#btn-hide").addEventListener("click", () => hideStation(id));
  if (st.qc?.length) showQC(id);
  showRecords(st);
  setupForecast({ lat: st.lat, lon: st.lon, alt: st.alt, id, st });
  if (st.src === "AEMET") {
    $("#chart-title").textContent = "Cargando las últimas 24 horas…";
    ensureObs10().then(o => { if (S.sel !== id) return; const d = o?.data?.[id]; d ? plotObs10(id, d) : plotDaily(id); });
  } else plotDaily(id);
  if (typeof Editor !== "undefined" && Editor.on) Editor.stationForm(st);
}

/* ---------- récords de la estación */
let RECS = null, RECS_TS = 0;
async function loadRecords() {
  if (!RECS || Date.now() - RECS_TS > 3600e3) { RECS = await getJSON(DATA_URL + "records.json" + bust()).catch(() => RECS); RECS_TS = Date.now(); }
  return RECS;
}
const RECDEF = [
  ["x_hi", "Máx. más alta", "°C", "temp", "tx", 1], ["x_lo", "Máx. más baja", "°C", "temp", "tx", -1],
  ["n_hi", "Mín. más alta", "°C", "temp", "tn", 1], ["n_lo", "Mín. más baja", "°C", "temp", "tn", -1],
  ["p_hi", "Lluvia en un día", "mm", "prec", "pr", 1], ["w_hi", "Racha máxima", "km/h", "wind", "gust", 1],
];
async function showRecords(st) {
  const id = st.id;
  let all = null;
  if (st.src === "AEMET") all = await AemetHist.records(id).catch(() => null);
  else all = (await loadRecords())?.stations?.[id];
  const box = $("#rec-box");
  if (!all || !box || S.sel !== id) return;
  if (!all.abs) all = { abs: all };   // formato antiguo (solo absolutos)
  const official = st.src === "AEMET";
  const dfmt = (d, y = true) => new Date(d + "T12:00:00").toLocaleDateString("es-ES", y ? { day: "numeric", month: "short", year: "numeric" } : { day: "numeric", month: "long" });
  const now = new Date();
  const monthName = now.toLocaleDateString("es-ES", { month: "long" });
  const TABS = [["day", "Diarios"], ["mon", "Mensuales"], ["abs", "Absolutos"]].filter(([k]) => all[k]);
  if (!TABS.length) return;
  if (!TABS.some(([k]) => k === S.rtab)) S.rtab = TABS[TABS.length - 1][0];
  const draw = () => {
    const sc = S.rtab, r = all[sc];
    const today = st.st === "ok";
    const tiles = RECDEF.filter(([k]) => r[k]).map(([k, label, unit, scale, live, dir]) => {
      const [v, d] = r[k], cur = today ? st[live] : null;
      // «¡Récord hoy!» solo donde el valor del día ya no puede deshacerse: la máxima solo sube,
      // la mínima solo baja, y lluvia y racha solo crecen (máxima más baja o mínima más alta no)
      const beat = cur != null && ["x_hi", "n_lo", "p_hi", "w_hi"].includes(k) && (dir > 0 ? cur > v : cur < v);
      return `<div class="tile rec ${beat ? "beat" : ""}" style="--c:${colorFor(scale, v)}"><span class="tl">${label}</span>
        <span class="tv num">${fmt(v, unit === "km/h" ? 0 : 1)}<small>${unit}</small></span>
        <span class="ts">${beat ? `<b class="rec-new">¡Récord hoy! ${fmt(cur, unit === "km/h" ? 0 : 1)} ${unit}</b>` : sc === "day" ? d.slice(0, 4) : dfmt(d)}</span></div>`;
    }).join("");
    const what = sc === "day" ? `de un ${dfmt(now.toISOString().slice(0, 10), false)} · ${r.n} ${r.n === 1 ? "año" : "años"} con datos`
      : sc === "mon" ? `de ${monthName} · ${r.n.toLocaleString("es-ES")} días` : `desde el ${dfmt(r.from)} · ${r.n.toLocaleString("es-ES")} días`;
    box.innerHTML = `<div class="rec-head"><h3 class="block-title">Récords</h3>
        <div class="seg seg-sm" id="rec-tabs">${TABS.map(([k, l]) => `<button data-k="${k}" class="${k === sc ? "on" : ""}">${l}</button>`).join("")}</div></div>
      <p class="r-meta rec-what">${what}${official ? " · serie oficial de AEMET" : " · según los datos de la estación"}</p>
      <div class="tiles rec-tiles">${tiles || `<p class="st-status">Sin datos.</p>`}</div>`;
    $$("#rec-tabs button").forEach(btn => btn.addEventListener("click", () => { S.rtab = btn.dataset.k; savePrefs(); draw(); }));
  };
  draw();
}

/* ---------- avisos del control de calidad automático */
let QC = null, QC_TS = 0;
async function loadQC() {
  if (!QC || Date.now() - QC_TS > 9 * 60e3) { QC = await getJSON(DATA_URL + "qc.json" + bust()).catch(() => QC); QC_TS = Date.now(); }
  return QC;
}
async function showQC(id) {
  const q = await loadQC(), box = $("#qc-box");
  const e = q?.stations?.[id];
  if (!box || !e || S.sel !== id) return;
  box.innerHTML = e.flags.map(f => `<span class="qc-flag" title="${f.daily ? esc(f.meta) : `Detectado en ${f.today} pasadas hoy · ${f.days} días esta semana`}">⚠ ${esc(f.msg)}</span>`).join("");
}

/* ---------- previsión (Open-Meteo) */
const FDAYS = [[3, "3 días"], [7, "7 días"], [15, "15 días"]];
const FDEF = { det: 3, ens: 15 };
let FC = null;   // {lat, lon, alt, id, st, det, ens, days}

function forecastTabsHTML(withObs) {
  return `<div class="tabs-row">
    <div class="seg seg-sm" id="ftabs">${withObs ? `<button data-t="obs">Observado</button>` : ""}<button data-t="det">Previsión</button><button data-t="ens">Conjunto ENS</button></div>
    <button class="icon-btn sm" id="btn-wide" title="Ampliar o reducir el panel" aria-label="Ampliar el panel"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M9.5 2H14v4.5M6.5 14H2V9.5M14 2L9 7M2 14l5-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button></div>`;
}

function forecastBodyHTML(corrected) {
  return `<div id="tab-fc" hidden>
    <div class="fc-head"><div class="seg seg-sm" id="fdays"></div><span class="hint" id="fc-status"></span></div>
    <div id="fc-plot" class="fc-plot"></div><div id="fc-table"></div><div id="fc-verif"></div>
    <p class="credit">Previsión de <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a> (CC BY 4.0):
      AROME France HD 1,3 km de Météo-France e IFS y ENS de ECMWF, interpolados al punto${corrected ? " y corregidos a la altitud de la estación" : ""}.
      Arrastra para moverte en el tiempo y usa la rueda para acercar.</p></div>`;
}

function setupForecast(ctx) {
  FC = { ...ctx, days: { ...FDEF } };
  const tabs = $$("#ftabs button");
  let tab = S.ftab;
  if (!tabs.some(b => b.dataset.t === tab)) tab = "det";
  tabs.forEach(b => b.addEventListener("click", () => { S.ftab = b.dataset.t; savePrefs(); showTab(b.dataset.t); }));
  $("#btn-wide").addEventListener("click", () => {
    S.wide = !S.wide; savePrefs();
    document.body.classList.toggle("side-wide", S.wide);
    setTimeout(() => $$("#side .js-plotly-plot").forEach(p => window.Plotly?.Plots.resize(p)), 240);
  });
  showTab(tab);
}

function showTab(t) {
  $$("#ftabs button").forEach(b => b.classList.toggle("on", b.dataset.t === t));
  const obs = $("#tab-obs");
  if (obs) obs.hidden = t !== "obs";
  $("#tab-fc").hidden = t === "obs";
  if (t === "obs") {
    setTimeout(() => ["plot-a", "plot-b"].forEach(i => { const p = document.getElementById(i); if (p?.data) window.Plotly?.Plots.resize(p); }), 30);
    return;
  }
  $("#fdays").innerHTML = FDAYS.map(([d, l]) => `<button data-d="${d}" class="${FC.days[t] === d ? "on" : ""}">${l}</button>`).join("");
  $$("#fdays button").forEach(b => b.addEventListener("click", () => {
    FC.days[t] = +b.dataset.d;
    $$("#fdays button").forEach(x => x.classList.toggle("on", x === b));
    const el = $("#fc-plot"), nowMs = Date.now();
    if (el.data) Plotly.relayout(el, { "xaxis.range": [Forecast.madrid(nowMs - (FC.days[t] <= 3 ? 12 : 18) * 3600e3), Forecast.madrid(nowMs + FC.days[t] * 86400e3)] });
  }));
  drawForecast(t);
}

async function drawForecast(t) {
  const ctx = FC, el = $("#fc-plot");
  $("#fc-status").textContent = t === "ens" ? "Cargando los 51 miembros del ENS…" : "Cargando AROME e IFS…";
  $("#fc-table").innerHTML = "";
  if ($("#fc-verif")) $("#fc-verif").innerHTML = "";
  try {
    await plotly();
    const obsP = ctx.st?.src === "AEMET" ? ensureObs10() : Promise.resolve(null);
    const detP = (ctx.det ||= Forecast.deterministic(ctx.lat, ctx.lon, ctx.alt));
    const ensP = t === "ens" ? (ctx.ens ||= Forecast.ensemble(ctx.lat, ctx.lon, ctx.alt)) : null;
    const [o10, det, ens] = await Promise.all([obsP, detP, ensP]);
    if (FC !== ctx || !el.isConnected || $("#tab-fc").hidden) return;
    const obs = Forecast.obsFrom(o10, ctx.id, ctx.st);
    if (ctx.onElevation && det.elevation != null) ctx.onElevation(det.elevation);
    if (t === "ens") Forecast.drawEnsemble(el, $("#fc-table"), ens, obs, ctx.days.ens, det.daily);
    else Forecast.drawDeterministic(el, det, obs, ctx.days.det);
    $("#fc-status").textContent = "";
    if (t === "det" && ctx.st?.id) drawVerification(ctx);
  } catch (e) {
    console.warn(e);
    if (FC === ctx) $("#fc-status").textContent = `No se ha podido cargar la previsión (${e.message || e}). Inténtalo de nuevo en un rato.`;
  }
}

/* ---------- verificación: cómo ha acertado la previsión en esta estación */
const VERIF_DAYS = 14;
/* máxima, mínima y lluvia observadas en `days` ({x, n, p} alineados) o null */
async function obsDaily(st, days) {
  if (st.src === "AEMET") {
    const m = await AemetHist.range(days).catch(() => null);
    if (m?.get(st.id)) return m.get(st.id);
  }
  const months = [...new Set(days.map(d => d.slice(0, 7)))];
  const docs = await Promise.all(months.map(loadMonth));
  const o = { x: [], n: [], p: [] };
  let any = false;
  days.forEach((d, k) => {
    const doc = docs[months.indexOf(d.slice(0, 7))], i = doc?.days?.indexOf(d) ?? -1, s = doc?.data?.[st.id];
    for (const f of ["x", "n", "p"]) { o[f][k] = i >= 0 && s?.[f] ? s[f][i] ?? null : null; if (o[f][k] != null) any = true; }
  });
  return any ? o : null;
}

async function drawVerification(ctx) {
  const box = $("#fc-verif");
  if (!box) return;
  box.innerHTML = `<p class="hint">Calculando cómo ha acertado la previsión aquí…</p>`;
  const today = NOW?.day || new Date().toISOString().slice(0, 10);
  const end = new Date(Date.parse(today + "T12:00:00Z") - 864e5).toISOString().slice(0, 10);
  const days = dayList(new Date(Date.parse(end + "T12:00:00Z") - (VERIF_DAYS - 1) * 864e5).toISOString().slice(0, 10), end);
  let fc, obs;
  try { [fc, obs] = await Promise.all([Forecast.previous(ctx.lat, ctx.lon, ctx.alt), obsDaily(ctx.st, days)]); }
  catch (e) { if (FC === ctx) box.innerHTML = ""; console.warn("verificación", e); return; }
  if (FC !== ctx || !box.isConnected) return;
  if (!obs) { box.innerHTML = `<p class="hint">No hay observaciones diarias guardadas de esta estación para comparar con la previsión.</p>`; return; }
  const q = ctx.st.q || "";
  const rows = [["x", "Máxima", 0], ["n", "Mínima", 1]].map(([f, label, qi]) => {
    if (q[qi] === "D") return "";
    const cells = ["arome", "ifs"].map(m => {
      const d = days.map((day, k) => [fc[m]?.[day]?.[f], obs[f][k]]).filter(([a, b]) => a != null && b != null).map(([a, b]) => a - b);
      if (d.length < 5) return `<td class="muted">—</td>`;
      const bias = d.reduce((s, v) => s + v, 0) / d.length, mae = d.reduce((s, v) => s + Math.abs(v), 0) / d.length;
      return `<td><b class="${Math.abs(bias) >= 2 ? "vf-bad" : Math.abs(bias) >= 1 ? "vf-mid" : "vf-ok"}">${signed(Math.round(bias * 10) / 10)} °C</b>
        <small>error ${fmt(mae)} °C · ${d.length} días</small></td>`;
    });
    return `<tr><th>${label}</th>${cells.join("")}</tr>`;
  });
  let rain = "";
  if (q[2] !== "D") {
    const ok = days.map((day, k) => obs.p[k]).filter(v => v != null);
    const cells = ["arome", "ifs"].map(m => {
      const pairs = days.map((day, k) => [fc[m]?.[day]?.p, obs.p[k]]).filter(([a, b]) => a != null && b != null);
      if (pairs.length < 5) return `<td class="muted">—</td>`;
      const hits = pairs.filter(([a, b]) => (a >= 1) === (b >= 1)).length, tot = pairs.reduce((s, [a]) => s + a, 0);
      return `<td><b>${hits} de ${pairs.length}</b> <small>días bien (llueve ≥ 1 mm o no) · ${fmt(tot)} mm en total</small></td>`;
    });
    if (ok.length >= 5) rain = `<tr><th>Lluvia <small>observada: ${fmt(ok.reduce((s, v) => s + v, 0))} mm</small></th>${cells.join("")}</tr>`;
  }
  if (!rows.join("") && !rain) { box.innerHTML = ""; return; }
  box.innerHTML = `<h3 class="block-title">Cómo ha acertado aquí <small>últimos ${VERIF_DAYS} días · previsión emitida el día anterior</small></h3>
    <table class="verif-t"><thead><tr><th></th><th>AROME 1,3 km</th><th>IFS (ECMWF)</th></tr></thead><tbody>${rows.join("")}${rain}</tbody></table>
    <p class="hint">Sesgo: con + el modelo se pasa y con − se queda corto; el error es la diferencia media sin signo. El modelo da valores
      horarios y la estación mide de continuo, así que en los extremos suele quedarse algo corto; en sitios con mucho relieve,
      un sesgo fijo indica sobre todo que el punto del modelo no representa bien la estación.</p>`;
}

/* ---------- cualquier punto del mapa */
function nearestStations(lat, lon, n = 4) {
  const k = Math.cos(lat * Math.PI / 180);
  return STATIONS.filter(s => s.st === "ok")
    .map(s => [s, Math.hypot((s.lat - lat) * 111.2, (s.lon - lon) * 111.2 * k)])
    .sort((a, b) => a[1] - b[1]).slice(0, n);
}

function openPoint(lat, lon) {
  S.sel = null;
  selMarker && map.removeLayer(selMarker);
  selMarker = L.marker([lat, lon], { interactive: false, keyboard: false,
    icon: L.divIcon({ className: "pin-icon", html: "<span></span>", iconSize: [22, 22], iconAnchor: [11, 21] }) }).addTo(map);
  history.replaceState(null, "", `#${S.v}/@${lat.toFixed(4)},${lon.toFixed(4)}`);
  const vkey = VARS[S.v] && !VARS[S.v].hydro ? S.v : "ta", def = VARS[vkey];
  const near = nearestStations(lat, lon).map(([s, d]) => {
    const v = s[vkey], c = v != null ? colorFor(def.scale, v) : "var(--card-2)";
    return `<li data-id="${esc(s.id)}"><div><span class="r-name">${esc(s.name)}</span>
      <span class="r-meta">${SOURCES[s.src]?.name || s.src} · ${fmt(d, d < 10 ? 1 : 0)} km${s.alt != null ? ` · ${s.alt} m` : ""}</span></div>
      <span class="rv-pill" style="background:${c};color:${v != null ? inkFor(c) : "var(--muted)"}">${fmt(v, def.dec)}</span></li>`;
  }).join("");
  const deg = (v, p, n) => `${fmt(Math.abs(v), 3)}° ${v >= 0 ? p : n}`;
  openSide("point", `
    <div class="eyebrow"><span class="src-dot" style="--c:var(--accent)"></span>Punto del mapa</div>
    <h2 class="st-name">${deg(lat, "N", "S")} · ${deg(lon, "E", "O")}</h2>
    <div class="st-meta"><span class="tag" id="pt-elev">altitud…</span></div>
    <h3 class="block-title">Estaciones más cercanas · ${esc(def.label.toLowerCase())}</h3>
    <ul class="near-list">${near}</ul>
    ${forecastTabsHTML(false)}
    ${forecastBodyHTML(false)}
    <div class="side-actions"><button class="btn ghost" id="btn-share">Copiar enlace</button>${typeof Editor !== "undefined" ? Editor.pointButton(lat, lon) : ""}</div>`);
  $$(".near-list li").forEach(li => li.addEventListener("click", () => {
    const s = BYID.get(li.dataset.id);
    map.flyTo([s.lat, s.lon], Math.max(map.getZoom(), 11));
    openStation(s.id, false);
  }));
  $("#btn-share").addEventListener("click", () => navigator.clipboard?.writeText(location.href).then(() => toast("Enlace copiado.")));
  if (typeof Editor !== "undefined") Editor.bindPoint(lat, lon);
  setupForecast({ lat, lon, alt: null, id: null, st: null,
    onElevation: e => { const el = $("#pt-elev"); if (el) el.textContent = `${Math.round(e)} m`; } });
}

// Clic en el mapa: no abre el panel directamente (se dispararía sin querer al mover el mapa),
// sino un globo con «Ver la previsión aquí». Se ignoran los clics justo después de moverlo.
let lastMove = 0;
map.on("movestart move moveend zoomstart zoomend", () => (lastMove = Date.now()));
map.on("click", e => {
  if (typeof Editor !== "undefined" && Editor.pick(e.latlng)) return;
  if (S.anim === "obs10" || Date.now() - lastMove < 400) return;
  const { lat, lng } = e.latlng;
  const deg = (v, p, n) => `${fmt(Math.abs(v), 2)}° ${v >= 0 ? p : n}`;
  L.popup({ className: "pt-pop", closeButton: true, autoPan: false, offset: [0, -2] })
    .setLatLng(e.latlng)
    .setContent(`<div class="pt-pop-body"><span class="muted small">${deg(lat, "N", "S")} · ${deg(lng, "E", "O")}</span>
      <button class="btn sm" id="pt-go">Ver la previsión aquí</button></div>`)
    .openOn(map);
  $("#pt-go").addEventListener("click", () => {
    map.closePopup();
    openPoint(lat, lng);
    if (innerWidth < 820) document.body.classList.remove("controls-open");
  });
});

/* ---------- gráficos (Plotly bajo demanda) */
let plotlyP = null;
function plotly() {
  if (window.Plotly) return Promise.resolve(window.Plotly);
  return (plotlyP ||= new Promise((res, rej) => {
    const sc = document.createElement("script");
    sc.src = PLOTLY_SRC; sc.onload = () => { Forecast.registerLocale(); res(window.Plotly); }; sc.onerror = rej;
    document.head.appendChild(sc);
  }));
}

function baseLayout(extra = {}) {
  const fg = cssVar("--fg"), muted = cssVar("--muted"), grid = cssVar("--grid");
  return {
    margin: { l: 38, r: 10, t: 8, b: 28 }, paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    font: { family: cssVar("--font"), size: 11, color: fg }, showlegend: true,
    legend: { orientation: "h", y: -0.18, font: { size: 10, color: muted } },
    xaxis: { gridcolor: grid, linecolor: grid, tickfont: { color: muted }, type: "date", tickformat: "%H:%M" },
    yaxis: { gridcolor: grid, zerolinecolor: grid, tickfont: { color: muted } },
    hovermode: "x unified", hoverlabel: { bgcolor: cssVar("--card"), bordercolor: cssVar("--border"), font: { color: fg } },
    ...extra,
  };
}
const PCONF = { displayModeBar: false, responsive: true, locale: "es" };

async function plotObs10(id, d) {
  const P = await plotly().catch(() => null);
  if (!P || S.sel !== id) return;
  $("#chart-title").textContent = "Últimas 24 horas · AEMET cada 10 minutos";
  const t0 = Date.parse(OBS10.t0), h0 = Date.parse(OBS10.h0);
  const x10 = Array.from({ length: OBS10.n }, (_, k) => new Date(t0 + k * OBS10.step * 1000));
  const xh = Array.from({ length: OBS10.nh }, (_, k) => new Date(h0 + k * 3600e3));
  const tmax = cssVar("--tmax"), tmin = cssVar("--tmin"), prec = cssVar("--prec");
  const tr = [
    { x: xh, y: d.tamax, name: "Máx. horaria", mode: "markers", marker: { color: tmax, size: 5, symbol: "triangle-up" }, hovertemplate: "%{y:.1f} °C" },
    { x: xh, y: d.tamin, name: "Mín. horaria", mode: "markers", marker: { color: tmin, size: 5, symbol: "triangle-down" }, hovertemplate: "%{y:.1f} °C" },
    { x: x10, y: d.ta, name: "Temperatura", mode: "lines", line: { color: cssVar("--fg"), width: 2 }, connectgaps: false, hovertemplate: "%{y:.1f} °C" },
  ];
  if (d.p10) tr.push({ x: x10, y: d.p10, name: "Lluvia 10 min", type: "bar", marker: { color: prec }, yaxis: "y2", hovertemplate: "%{y:.1f} mm" });
  P.newPlot("plot-a", tr, baseLayout({ yaxis: { ...baseLayout().yaxis, title: { text: "°C", font: { size: 10 } } },
    yaxis2: { overlaying: "y", side: "right", showgrid: false, rangemode: "tozero", tickfont: { color: prec }, title: { text: "mm", font: { size: 10, color: prec } } },
    margin: { l: 38, r: 34, t: 8, b: 28 }, bargap: 0 }), PCONF);
  const w = [];
  if (d.vv) w.push({ x: x10, y: d.vv.map(v => v == null ? null : v * 3.6), name: "Viento medio", mode: "lines", line: { color: cssVar("--accent"), width: 1.6 }, hovertemplate: "%{y:.0f} km/h" });
  if (d.vmax) w.push({ x: x10, y: d.vmax.map(v => v == null ? null : v * 3.6), name: "Racha", mode: "markers", marker: { color: cssVar("--dtr"), size: 4 }, hovertemplate: "%{y:.0f} km/h" });
  if (d.hr) w.push({ x: x10, y: d.hr, name: "Humedad", mode: "lines", line: { color: tmin, width: 1, dash: "dot" }, yaxis: "y2", hovertemplate: "%{y:.0f} %" });
  if (w.length) P.newPlot("plot-b", w, baseLayout({ yaxis: { ...baseLayout().yaxis, title: { text: "km/h", font: { size: 10 } }, rangemode: "tozero" },
    yaxis2: { overlaying: "y", side: "right", showgrid: false, range: [0, 100], tickfont: { color: tmin } }, margin: { l: 38, r: 34, t: 4, b: 28 } }), PCONF);
}

async function plotDaily(id) {
  const now = new Date(), mons = [];
  for (let k = 1; k >= 0; k--) { const d = new Date(now.getFullYear(), now.getMonth() - k, 1); mons.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); }
  const days = [], x = [], n = [], p = [];
  if (BYID.get(id)?.src === "AEMET") {   // AEMET: de aemet-explorer
    const dl = dayList(new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10), new Date(Date.now() - 864e5).toISOString().slice(0, 10));
    const c = (await AemetHist.range(dl).catch(() => new Map())).get(id);
    if (c) dl.forEach((d, k) => { days.push(d); x.push(c.x[k]); n.push(c.n[k]); p.push(c.p[k]); });
  } else {
    const docs = (await Promise.all(mons.map(loadMonth))).filter(Boolean);
    for (const doc of docs) {
      const c = doc.data[id]; if (!c) continue;
      doc.days.forEach((d, k) => { days.push(d); x.push(c.x?.[k] ?? null); n.push(c.n?.[k] ?? null); p.push(c.p?.[k] ?? null); });
    }
  }
  const s = BYID.get(id);
  const today = NOW?.day;
  if (s && s.st === "ok" && today && !days.includes(today)) { days.push(today); x.push(s.tx ?? null); n.push(s.tn ?? null); p.push(s.pr ?? null); }
  const keep = days.map((d, k) => x[k] != null || n[k] != null || p[k] != null);
  const first = keep.indexOf(true);
  if (first < 0) { $("#chart-title").textContent = "Aún no hay histórico diario de esta estación."; return; }
  const sl = a => a.slice(Math.max(first, a.length - 45));
  const P = await plotly().catch(() => null);
  if (!P || S.sel !== id) return;
  $("#chart-title").textContent = "Últimos días · máxima, mínima y lluvia diarias";
  const xd = sl(days);
  P.newPlot("plot-a", [
    { x: xd, y: sl(x), name: "Máxima", mode: "lines+markers", line: { color: cssVar("--tmax"), width: 1.8 }, marker: { size: 4 }, hovertemplate: "%{y:.1f} °C" },
    { x: xd, y: sl(n), name: "Mínima", mode: "lines+markers", line: { color: cssVar("--tmin"), width: 1.8 }, marker: { size: 4 }, hovertemplate: "%{y:.1f} °C" },
  ], baseLayout({ xaxis: { ...baseLayout().xaxis, tickformat: "%d %b" } }), PCONF);
  P.newPlot("plot-b", [{ x: xd, y: sl(p), name: "Lluvia", type: "bar", marker: { color: cssVar("--prec") }, hovertemplate: "%{y:.1f} mm" }],
    baseLayout({ xaxis: { ...baseLayout().xaxis, tickformat: "%d %b" }, yaxis: { ...baseLayout().yaxis, rangemode: "tozero", title: { text: "mm", font: { size: 10 } } }, showlegend: false, margin: { l: 38, r: 10, t: 4, b: 28 } }), PCONF);
}

function openHydro(kind, id) {
  const cfg = HYDRO.meta[kind].find(x => x.id === id), rec = HYDRO[kind][id];
  if (!cfg || !rec) return;
  S.sel = null;
  selMarker && map.removeLayer(selMarker);
  selMarker = L.circleMarker([+cfg.lat, +cfg.lon], { radius: 18, color: cssVar("--accent"), weight: 3, fill: false, interactive: false }).addTo(map);
  let body;
  if (kind === "gauges") {
    const [lvl, c] = gaugeLevel(cfg, rec);
    body = `<div class="eyebrow"><span class="src-dot" style="--c:#1c7ed6"></span>SAIH Ebro · aforo ${esc(cfg.id)}</div>
      <h2 class="st-name">${esc(cfg.name)}</h2>
      <p class="st-status"><span class="badge" style="background:${c};color:${inkFor(c)}">${lvl}</span> ${rec.t ? `Dato ${ago(rec.t)}` : ""}</p>
      <div class="tiles">
        ${tile("Caudal", fmt(rec.q, 1), "m³/s", c, rec.dv != null ? `${rec.dv > 0 ? "+" : ""}${fmt(rec.dv, 1)} en 3 h` : "")}
        ${tile("Nivel", fmt(rec.h, 2), "m", c)}
        ${tile("Aviso amarillo", fmt(+cfg.warn_yellow, 2), "m", "#f2c500")}
        ${tile("Aviso naranja", fmt(+cfg.warn_orange, 2), "m", "#f76707")}
        ${tile("Aviso rojo", fmt(+cfg.warn_red, 2), "m", "#c92a2a")}
        ${cfg.record_level_m ? tile("Máximo histórico", fmt(+cfg.record_level_m, 2), "m", "var(--hl)", `${esc(cfg.record_date)} · ${fmt(+cfg.record_flow_m3s, 0)} m³/s`) : ""}
      </div>`;
  } else {
    const c = resColor(rec.pct);
    body = `<div class="eyebrow"><span class="src-dot" style="--c:#1c7ed6"></span>SAIH Ebro · embalse ${esc(cfg.id)}</div>
      <h2 class="st-name">${esc(cfg.name)}</h2>
      <p class="st-status">${rec.t ? `Dato ${ago(rec.t)}` : ""}</p>
      <div class="pbar big"><span style="width:${Math.min(100, rec.pct || 0)}%;background:${c}"></span></div>
      <div class="tiles">
        ${tile("Reserva", fmt(rec.pct, 1), "%", c)}
        ${tile("Volumen", fmt(rec.vol, 1), "hm³", c, rec.dv != null ? `${rec.dv > 0 ? "+" : ""}${fmt(rec.dv, 2)} hm³ en 24 h` : "")}
        ${tile("Capacidad", fmt(+cfg.capacity_hm3, 1), "hm³")}
        ${rec.lvl != null ? tile("Cota", fmt(rec.lvl, 2), "m s.n.m.") : ""}
      </div>`;
  }
  openSide("hydro", body + `<div class="chart-block"><div class="chart-title">Últimas 72 horas</div><div class="plot" id="plot-a"></div></div>
    <div class="side-actions">${cfg.link ? `<a class="btn" href="${esc(cfg.link)}" target="_blank" rel="noopener">Ver en el SAIH Ebro ↗</a>` : ""}</div>`);
  plotly().then(P => {
    const s = rec.s || [];
    const x = s.map(p => new Date(p[0] * 1000));
    const tr = kind === "gauges"
      ? [{ x, y: s.map(p => p[1]), name: "Caudal (m³/s)", mode: "lines", line: { color: cssVar("--tmin"), width: 2 }, hovertemplate: "%{y:.1f} m³/s" },
         { x, y: s.map(p => p[2]), name: "Nivel (m)", mode: "lines", yaxis: "y2", line: { color: cssVar("--accent"), width: 1.4, dash: "dot" }, hovertemplate: "%{y:.2f} m" }]
      : [{ x, y: s.map(p => p[1]), name: "Volumen (hm³)", mode: "lines", line: { color: cssVar("--tmin"), width: 2 }, fill: "tozeroy", fillcolor: "rgba(28,126,214,0.08)", hovertemplate: "%{y:.2f} hm³" }];
    P.newPlot("plot-a", tr, baseLayout({ xaxis: { ...baseLayout().xaxis, tickformat: "%d %H:%M" },
      yaxis2: { overlaying: "y", side: "right", showgrid: false, tickfont: { color: cssVar("--accent") } }, margin: { l: 42, r: 36, t: 8, b: 28 } }), PCONF);
  }).catch(() => {});
}

/* ---------- clasificación */
function openRanking() {
  const def = currentDef();
  let items;
  if (def.hydro === "gauges" && HYDRO) items = HYDRO.meta.gauges.filter(g => !BAD_FLOW.has(g.id)).map(g => [g, HYDRO.gauges[g.id]?.q]).filter(x => x[1] != null).map(([g, v]) => ({ id: g.id, name: g.name, v, kind: "gauges" }));
  else if (def.hydro === "reservoirs" && HYDRO) items = HYDRO.meta.reservoirs.map(r => [r, HYDRO.reservoirs[r.id]?.pct]).filter(x => x[1] != null).map(([r, v]) => ({ id: r.id, name: r.name, v, kind: "reservoirs" }));
  else {
    const view = map.getBounds();
    items = visibleStations().filter(([s]) => view.contains([s.lat, s.lon])).map(([s, v]) => ({ id: s.id, name: s.name, v, src: s.src, alt: s.alt }));
  }
  items.sort((a, b) => b.v - a.v);
  const row = (it, i) => `<tr data-id="${esc(it.id)}" data-kind="${it.kind || ""}"><td class="muted num">${i + 1}</td>
    <td><span class="r-name">${esc(it.name)}</span>${it.src ? `<span class="r-meta">${SOURCES[it.src]?.name || it.src}${it.alt != null ? ` · ${it.alt} m` : ""}</span>` : ""}</td>
    <td class="num rv"><span class="rv-pill" style="background:${def.hydro ? "var(--card-2)" : colorFor(def.scale, it.v)};color:${def.hydro ? "var(--fg)" : inkFor(colorFor(def.scale, it.v))}">${fmt(it.v, def.dec)}</span></td></tr>`;
  const top = items.slice(0, 15), low = items.slice(-15).reverse();
  const title = S.mode === "hist" && HIST.range ? `${def.label} · ${ddmm(HIST.range[0])} – ${ddmm(HIST.range[1])}` : def.label;
  openSide("rank", `<div class="eyebrow">Clasificación</div><h2 class="st-name">${esc(title)}</h2>
    <p class="st-status">${items.length} estaciones en la zona visible del mapa con los filtros actuales</p>
    <h3 class="block-title">Valores más altos</h3><table class="rank-table">${top.map(row).join("")}</table>
    ${items.length > 15 ? `<h3 class="block-title">Valores más bajos</h3><table class="rank-table">${low.map(row).join("")}</table>` : ""}`);
  $$("#side-body tr[data-id]").forEach(tr => tr.addEventListener("click", () => {
    const id = tr.dataset.id, k = tr.dataset.kind;
    if (k) { const c = HYDRO.meta[k].find(x => x.id === id); map.flyTo([+c.lat, +c.lon], 11); openHydro(k, id); }
    else { const s = BYID.get(id); map.flyTo([s.lat, s.lon], 12); openStation(id, false); }
  }));
}

/* ---------------------------------------------------------- búsqueda */
function setupSearch() {
  const inp = $("#search"), ul = $("#search-results");
  let sel = -1, items = [];
  const show = () => {
    const q = norm(inp.value.trim());
    if (q.length < 2) { ul.hidden = true; return; }
    const z = Object.keys(ZONES).filter(k => norm(k).includes(q)).map(k => ({ zone: k }));
    const st = STATIONS.filter(s => s.st !== "na" && (norm(s.name).includes(q) || norm(s.id) === q)).slice(0, 12);
    const hy = HYDRO ? [...HYDRO.meta.reservoirs.map(r => ({ ...r, kind: "reservoirs" })), ...HYDRO.meta.gauges.map(g => ({ ...g, kind: "gauges" }))]
      .filter(x => norm(x.name).includes(q)).slice(0, 4) : [];
    items = [...z, ...st, ...hy];
    sel = -1;
    ul.innerHTML = items.map((it, i) => it.zone ? `<li data-i="${i}"><span class="r-name">${esc(it.zone)}</span><span class="r-meta">Zona</span></li>`
      : it.kind ? `<li data-i="${i}"><span class="r-name">${esc(it.name)}</span><span class="r-meta">${it.kind === "gauges" ? "Aforo" : "Embalse"} · SAIH Ebro</span></li>`
      : `<li data-i="${i}"><span class="r-name">${esc(it.name)}</span><span class="r-meta">${SOURCES[it.src]?.name || it.src}${it.alt != null ? ` · ${it.alt} m` : ""}${it.st !== "ok" ? " · sin datos" : ""}</span></li>`).join("")
      || `<li class="empty">Sin resultados</li>`;
    ul.hidden = false;
  };
  const pick = i => {
    const it = items[i]; if (!it) return;
    ul.hidden = true; inp.value = ""; inp.blur();
    if (it.zone) return map.flyToBounds(ZONES[it.zone]);
    if (it.kind) { map.flyTo([+it.lat, +it.lon], 11); return openHydro(it.kind, it.id); }
    map.flyTo([it.lat, it.lon], 12); openStation(it.id, false);
  };
  inp.addEventListener("input", show);
  inp.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      sel = Math.max(0, Math.min(items.length - 1, sel + (e.key === "ArrowDown" ? 1 : -1)));
      $$("li", ul).forEach((li, i) => li.classList.toggle("sel", i === sel));
    } else if (e.key === "Enter") pick(sel < 0 ? 0 : sel);
    else if (e.key === "Escape") { ul.hidden = true; inp.blur(); }
  });
  ul.addEventListener("mousedown", e => { const li = e.target.closest("li[data-i]"); if (li) pick(+li.dataset.i); });
  inp.addEventListener("blur", () => setTimeout(() => (ul.hidden = true), 150));
  document.addEventListener("keydown", e => {
    if (e.key === "/" && document.activeElement !== inp && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); inp.focus(); }
    if (e.key === "Escape" && S.side) closeSide();
    if ((e.key === "Delete" || e.key === "Backspace") && S.side === "station" && S.sel
        && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); hideStation(S.sel); }
  });
}

/* ---------------------------------------------------------- arranque */
// app instalable: service worker (código con red primero; los datos no se guardan)
if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(e => console.warn("SW", e)));

(async function init() {
  if (innerWidth < 820) map.fitBounds(ZONES["Aragón"], { padding: [4, 4] });
  setBase(S.base);
  buildControls();
  setupSearch();
  const h = decodeURIComponent(location.hash.slice(1));
  let startPoint = null;
  if (h) {
    const [v, id] = h.split("/");
    if (VARS[v]) S.v = v;
    if (id && id.startsWith("@")) {
      const [la, lo] = id.slice(1).split(",").map(Number);
      if (Number.isFinite(la) && Number.isFinite(lo)) startPoint = [la, lo];
    } else if (id) S.sel = id;
    updateVarUI();
  }
  await loadStatic().catch(e => console.warn(e));
  await loadNow(true);
  $("#loading").classList.add("done");
  updateHiddenInfo();
  if (S.sel) openStation(S.sel);
  else if (startPoint) { map.setView(startPoint, 10); openPoint(...startPoint); }
  for (const k of ["cams", "manual"]) if (S.layers[k]) toggleLayer(k);
  setInterval(() => { if (!document.hidden) loadNow(false); }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && NOW && Date.now() / 1000 - NOW.ts > 11 * 60) loadNow(false); });
})();
