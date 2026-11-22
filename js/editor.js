/* ==========================================================
   Editor de la red de estaciones (altas, bajas y calidad).

   Habla con el Worker de Cloudflare «aragonwx-admin» (cloudflare/admin.js),
   que guarda el token de GitHub y hace el commit en config/stations.csv.
   Los cambios se acumulan en el navegador y se guardan juntos en un
   único commit; entran en el mapa en la siguiente vuelta del bucle.
   ========================================================== */

const Editor = (() => {
  const ADMIN_URL = (() => { try { return localStorage.getItem("aragonwx-admin-url"); } catch { return null; } })()
    || "https://aragonwx-admin.ccalvosancho.workers.dev";
  const DISCOVER_URL = LOCAL ? "out/discover.json" : `https://raw.githubusercontent.com/${REPO}/discover/discover.json`;
  const COLS = ["id", "source", "name", "prov", "lat", "lon", "alt", "link", "model", "notes",
                "q_tmax", "q_tmin", "q_prec", "q_wind", "tz_shift", "kind", "active"];
  const NETS = { WU: "Weather Underground", WC: "WeatherCloud", MC: "Meteoclimatic", HOLFUY: "Holfuy",
                 AVAMET: "AVAMET", IBERICAM: "Ibericam", SAIH: "SAIH Ebro", AEMET: "AEMET" };
  const LINKS = { WU: id => `https://www.wunderground.com/dashboard/pws/${id}`, WC: id => `https://app.weathercloud.net/d${id}#current`,
                  MC: id => `https://www.meteoclimatic.net/perfil/${id}`, HOLFUY: id => `https://holfuy.com/es/weather/${id}`,
                  AVAMET: id => `https://www.avamet.org/mxo_i.php?id=${id}` };
  const QOPT = [["", "Sin valorar"], ["Contrastada", "Contrastada"], ["Deficiente", "Deficiente"]];
  const PEND_KEY = "aragonwx-pending";

  let pw = null, csv = null, pending = [], tab = "changes", picking = null, sugg = null, suggLayer = null, pin = null;
  try { pw = sessionStorage.getItem("aragonwx-pw"); pending = JSON.parse(localStorage.getItem(PEND_KEY) || "[]"); } catch {}

  /* ---------- CSV ---------- */
  function parseCSV(text) {
    const rows = []; let row = [], f = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      else if (c === '"') q = true;
      else if (c === ",") { row.push(f); f = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
      else f += c;
    }
    if (f || row.length) { row.push(f); rows.push(row); }
    const head = rows.shift();
    return rows.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
  }
  const cell = v => { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  const toCSV = (rows, eol = "\n") => [COLS.join(","), ...rows.map(r => COLS.map(c => cell(r[c])).join(","))].join(eol) + eol;

  /* ---------- Worker ---------- */
  async function api(path, init = {}) {
    const r = await fetch(ADMIN_URL + path, { ...init, headers: { "Content-Type": "application/json", "X-Admin-Password": pw || "", ...(init.headers || {}) } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || `error ${r.status}`); e.status = r.status; throw e; }
    return j;
  }
  async function loadCSV() {
    const d = await api("/stations");
    csv = { sha: d.sha, rows: parseCSV(d.content), eol: d.content.includes("\r\n") ? "\r\n" : "\n" };
    return csv;
  }

  /* ---------- cambios pendientes ---------- */
  function savePending() { try { localStorage.setItem(PEND_KEY, JSON.stringify(pending)); } catch {} updateBadge(); }
  function addChange(ch) {
    // un único cambio por estación: los campos se acumulan
    const prev = pending.find(p => p.id === ch.id && p.type === ch.type);
    if (prev) Object.assign(prev.fields, ch.fields), prev.label = ch.label;
    else pending.push(ch);
    savePending();
    toast(`Cambio anotado (${pending.length} pendiente${pending.length > 1 ? "s" : ""}). Guárdalos desde el editor.`);
  }
  function applyChanges(rows) {
    const byId = new Map(rows.map(r => [r.id, r]));
    for (const ch of pending) {
      if (ch.type === "add") {
        if (byId.has(ch.id)) throw new Error(`la estación ${ch.id} ya existe`);
        const r = Object.fromEntries(COLS.map(c => [c, ""]));
        Object.assign(r, ch.fields, { id: ch.id });
        rows.push(r); byId.set(ch.id, r);
      } else {
        let r = byId.get(ch.id);
        if (!r) {   // estación AEMET que entra sola desde la API: se crea su fila
          const s = BYID.get(ch.id);
          if (!s) throw new Error(`no encuentro ${ch.id}`);
          r = Object.fromEntries(COLS.map(c => [c, ""]));
          Object.assign(r, { id: s.id, source: s.src, name: s.name, lat: s.lat.toFixed(5), lon: s.lon.toFixed(5), alt: s.alt ?? "", link: s.link || "", active: "1" });
          rows.push(r); byId.set(ch.id, r);
        }
        Object.assign(r, ch.fields);
      }
    }
    return rows;
  }
  async function saveAll() {
    if (!pending.length) return;
    const btn = $("#ed-save"); btn.disabled = true; btn.textContent = "Guardando…";
    try {
      await loadCSV();
      const rows = applyChanges(csv.rows.map(r => ({ ...r })));
      const msg = pending.map(p => p.label).join("; ");
      await api("/stations", { method: "PUT", body: JSON.stringify({ content: toCSV(rows, csv.eol), sha: csv.sha, message: msg }) });
      pending = []; savePending();
      toast("Guardado. Los cambios entran en el mapa en la próxima actualización (≤ 10 min).", 6000);
      render();
    } catch (e) {
      toast("No se ha podido guardar: " + e.message, 6000);
      btn.disabled = false; btn.textContent = "Guardar los cambios";
    }
  }

  /* ---------- acceso ---------- */
  function open(t) {
    tab = t || tab;
    if (!pw) return showLogin();
    render();
  }
  function showLogin(msg) {
    openSide("editor", `<div class="eyebrow">Editor de la red</div><h2 class="st-name">Acceso</h2>
      <p class="st-status">Altas, bajas y calidad de las estaciones. Los cambios se guardan en el repositorio.</p>
      <form id="ed-login" class="ed-form"><label class="field">Contraseña<input type="password" id="ed-pw" autocomplete="current-password" required></label>
      ${msg ? `<p class="bad-txt small">${esc(msg)}</p>` : ""}<button class="btn" type="submit">Entrar</button></form>`);
    $("#ed-pw").focus();
    $("#ed-login").addEventListener("submit", async e => {
      e.preventDefault();
      pw = $("#ed-pw").value;
      try { await loadCSV(); try { sessionStorage.setItem("aragonwx-pw", pw); } catch {} document.body.classList.add("editing"); render(); }
      catch (err) { pw = null; showLogin(err.status === 401 ? "Contraseña incorrecta." : "No se puede conectar con el editor: " + err.message); }
    });
  }
  function logout() {
    pw = null; try { sessionStorage.removeItem("aragonwx-pw"); } catch {}
    document.body.classList.remove("editing"); clearSugg(); closeSide();
  }

  /* ---------- panel del editor ---------- */
  function render() {
    document.body.classList.add("editing");
    openSide("editor", `<div class="eyebrow">Editor de la red <button class="link-btn small" id="ed-out">salir</button></div>
      <h2 class="st-name">Estaciones</h2>
      <div class="seg seg-sm ed-tabs" id="ed-tabs">
        <button data-t="changes">Cambios${pending.length ? ` (${pending.length})` : ""}</button>
        <button data-t="add">Alta</button><button data-t="sugg">Sugerencias</button></div>
      <div id="ed-body"></div>`);
    $("#ed-out").addEventListener("click", logout);
    $$("#ed-tabs button").forEach(b => { b.classList.toggle("on", b.dataset.t === tab); b.addEventListener("click", () => { tab = b.dataset.t; render(); }); });
    if (tab !== "sugg") clearSugg();
    ({ changes: renderChanges, add: () => renderAdd(), sugg: renderSugg })[tab]();
  }

  function renderChanges() {
    $("#ed-body").innerHTML = `
      <p class="hint">Abre cualquier estación para cambiar su calidad, el problema de hora, sus notas o darla de baja.
        Para una estación nueva, usa <b>Alta</b> o haz clic en el mapa y «Añadir una estación aquí».</p>
      ${pending.length ? `<ul class="ed-list">${pending.map((p, i) => `<li><span>${esc(p.label)}</span>
        <button class="link-btn small" data-i="${i}">quitar</button></li>`).join("")}</ul>
        <div class="side-actions"><button class="btn" id="ed-save">Guardar los cambios</button>
        <button class="btn ghost" id="ed-clear">Descartar todo</button></div>`
      : `<p class="st-status">No hay cambios pendientes.</p>`}`;
    $$("#ed-body .ed-list button").forEach(b => b.addEventListener("click", () => { pending.splice(+b.dataset.i, 1); savePending(); render(); }));
    $("#ed-save")?.addEventListener("click", saveAll);
    $("#ed-clear")?.addEventListener("click", () => { if (confirm("¿Descartar todos los cambios pendientes?")) { pending = []; savePending(); render(); } });
  }

  /* ---------- alta ---------- */
  function renderAdd(pre = {}) {
    tab = "add";
    $$("#ed-tabs button").forEach(b => b.classList.toggle("on", b.dataset.t === "add"));
    $("#ed-body").innerHTML = `<form id="ed-add" class="ed-form">
      <div class="ed-row"><label class="field">Red<select id="ea-src">${Object.entries(NETS).filter(([k]) => k !== "AEMET")
        .map(([k, n]) => `<option value="${k}" ${pre.src === k ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        <label class="field">Identificador<input id="ea-id" value="${esc(pre.id || "")}" placeholder="p. ej. IZARAG123" required></label></div>
      <button type="button" class="btn ghost" id="ea-probe">Comprobar en la red</button> <span class="hint" id="ea-status"></span>
      <label class="field">Nombre<input id="ea-name" value="${esc(pre.name || "")}" required></label>
      <div class="ed-row"><label class="field">Latitud<input id="ea-lat" value="${pre.lat ?? ""}" required></label>
        <label class="field">Longitud<input id="ea-lon" value="${pre.lon ?? ""}" required></label>
        <label class="field">Altitud (m)<input id="ea-alt" value="${pre.alt ?? ""}"></label></div>
      <button type="button" class="link-btn small" id="ea-pick">◎ Elegir la posición en el mapa</button>
      <label class="field">Enlace<input id="ea-link" value="${esc(pre.link || "")}"></label>
      <div class="ed-row"><label class="field">Modelo<input id="ea-model" value=""></label>
        <label class="field">Notas<input id="ea-notes" value=""></label></div>
      <label class="check"><input type="checkbox" id="ea-tz"> El contador de lluvia se reinicia a otra hora («problema de hora»)</label>
      <div class="side-actions"><button class="btn" type="submit">Añadir a los cambios</button></div></form>`;
    const set = (id, v) => { if (v != null && v !== "") $(id).value = v; };
    const probe = async () => {
      const src = $("#ea-src").value, id = $("#ea-id").value.trim();
      if (!id) return;
      $("#ea-status").textContent = "Comprobando…";
      try {
        const p = await api(`/probe?src=${src}&id=${encodeURIComponent(id)}`);
        if (!p.ok) { $("#ea-status").innerHTML = `<span class="bad-txt">${esc(p.error)}</span>`; return; }
        set("#ea-name", p.name); set("#ea-lat", p.lat != null ? (+p.lat).toFixed(5) : ""); set("#ea-lon", p.lon != null ? (+p.lon).toFixed(5) : "");
        set("#ea-alt", p.alt != null ? Math.round(p.alt) : ""); set("#ea-link", p.link);
        $("#ea-status").innerHTML = `<span class="ok-txt">✓ responde</span>${p.ta != null ? ` · ${fmt(p.ta)} °C` : ""}${p.t ? ` · ${ago(p.t)}` : ""}${p.note ? ` · ${esc(p.note)}` : ""}`;
        if (!$("#ea-alt").value && $("#ea-lat").value) fillAlt();
        showPin();
      } catch (e) { $("#ea-status").innerHTML = `<span class="bad-txt">${esc(e.message)}</span>`; }
    };
    $("#ea-probe").addEventListener("click", probe);
    $("#ea-src").addEventListener("change", () => { const f = LINKS[$("#ea-src").value], id = $("#ea-id").value.trim(); if (f && id) $("#ea-link").value = f(id); });
    $("#ea-id").addEventListener("change", () => { const f = LINKS[$("#ea-src").value], id = $("#ea-id").value.trim(); if (f && id && !$("#ea-link").value) $("#ea-link").value = f(id); });
    $("#ea-pick").addEventListener("click", () => { picking = ll => { $("#ea-lat").value = ll.lat.toFixed(5); $("#ea-lon").value = ll.lng.toFixed(5); fillAlt(); showPin(); }; toast("Haz clic en el mapa para situar la estación."); });
    for (const k of ["#ea-lat", "#ea-lon"]) $(k).addEventListener("change", showPin);
    $("#ed-add").addEventListener("submit", e => {
      e.preventDefault();
      const src = $("#ea-src").value, id = $("#ea-id").value.trim(), lat = +$("#ea-lat").value, lon = +$("#ea-lon").value;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return toast("Faltan las coordenadas.");
      if (BYID.has(id) || csv?.rows.some(r => r.id === id) || pending.some(p => p.id === id)) return toast(`La estación ${id} ya está en la red.`);
      addChange({ type: "add", id, label: `alta ${NETS[src]} ${id} (${$("#ea-name").value.trim()})`, fields: {
        source: src, name: $("#ea-name").value.trim(), prov: provinceOf(lat, lon), lat: lat.toFixed(5), lon: lon.toFixed(5),
        alt: $("#ea-alt").value.trim(), link: $("#ea-link").value.trim() || (LINKS[src] ? LINKS[src](id) : ""),
        model: $("#ea-model").value.trim(), notes: $("#ea-notes").value.trim(), tz_shift: $("#ea-tz").checked ? "1" : "", active: "1" } });
      tab = "changes"; render();
    });
    if (pre.id && pre.autoprobe) probe();
    else if (pre.lat != null) { showPin(); if (!pre.alt) fillAlt(); }
  }
  async function fillAlt() {
    const lat = +$("#ea-lat")?.value, lon = +$("#ea-lon")?.value;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    try {
      const d = await (await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`)).json();
      if (d.elevation?.[0] != null && $("#ea-alt") && !$("#ea-alt").value) $("#ea-alt").value = Math.round(d.elevation[0]);
    } catch {}
  }
  function showPin() {
    const lat = +$("#ea-lat")?.value, lon = +$("#ea-lon")?.value;
    pin && map.removeLayer(pin);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (!lat && !lon)) return;
    pin = L.marker([lat, lon], { icon: L.divIcon({ className: "pin-icon new", html: "<span></span>", iconSize: [22, 22], iconAnchor: [11, 21] }) }).addTo(map);
    if (!map.getBounds().contains([lat, lon])) map.flyTo([lat, lon], Math.max(map.getZoom(), 11));
  }
  function provinceOf(lat, lon) {
    if (!PROV) return "";
    for (const f of PROV.features) {
      const g = f.geometry;
      for (const poly of (g.type === "MultiPolygon" ? g.coordinates : [g.coordinates])) {
        const ring = poly[0]; let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i], [xj, yj] = ring[j];
          if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) return f.properties.name;
      }
    }
    return "";
  }

  /* ---------- sugerencias ---------- */
  async function renderSugg() {
    $("#ed-body").innerHTML = `<p class="hint">Estaciones de aficionados en Aragón que no están en la red. Se buscan cada día
      en Wunderground, Meteoclimatic y Holfuy (WeatherCloud no publica un listado).</p>
      <div class="ed-row"><select id="es-src"><option value="">Todas las redes</option><option>WU</option><option>MC</option><option>HOLFUY</option></select>
      <label class="check"><input type="checkbox" id="es-dup"> Incluir posibles duplicados</label></div>
      <p class="st-status" id="es-info">Cargando…</p><ul class="ed-sugg" id="es-list"></ul>`;
    try { sugg ||= await getJSON(DISCOVER_URL + bust()); }
    catch { $("#es-info").textContent = "Todavía no hay sugerencias: lanza el workflow discover-stations."; return; }
    const draw = () => {
      const src = $("#es-src").value, dup = $("#es-dup").checked;
      const items = sugg.candidates.filter(c => (!src || c.src === src) && (dup || !c.dup) && !BYID.has(c.id) && !pending.some(p => p.id === c.id));
      $("#es-info").textContent = `${items.length} sugerencias · búsqueda del ${new Date(sugg.generated).toLocaleDateString("es-ES")}`;
      $("#es-list").innerHTML = items.slice(0, 300).map(c => `<li data-id="${esc(c.id)}">
        <div><span class="r-name">${esc(c.name || c.id)}</span>
        <span class="r-meta">${NETS[c.src]} · ${esc(c.id)}${c.last ? ` · ${ago(c.last)}` : ""}${c.near ? ` · a ${fmt(c.near.km, 1)} km de ${esc(c.near.name)}` : ""}</span>
        ${c.dup ? `<span class="badge warn">posible duplicado de ${esc(c.near.name)} (${NETS[c.near.src] || c.near.src})</span>` : ""}</div>
        <div class="ed-btns"><button class="btn ghost sm" data-a="see">Ver</button><button class="btn sm" data-a="add">Añadir</button></div></li>`).join("");
      $$("#es-list li").forEach(li => {
        const c = sugg.candidates.find(x => x.id === li.dataset.id);
        li.querySelector("[data-a=see]").addEventListener("click", () => map.flyTo([c.lat, c.lon], 12));
        li.querySelector("[data-a=add]").addEventListener("click", () => renderAdd({ ...c, autoprobe: c.src !== "HOLFUY" }));
      });
      clearSugg();
      suggLayer = L.layerGroup(items.map(c => L.circleMarker([c.lat, c.lon], { radius: 6, weight: 2, color: c.dup ? "#f08c00" : "#e8590c", fillOpacity: 0.1 })
        .bindTooltip(`${esc(c.name || c.id)} · ${NETS[c.src]} (sugerencia)`).on("click", () => renderAdd({ ...c, autoprobe: c.src !== "HOLFUY" })))).addTo(map);
    };
    $("#es-src").addEventListener("change", draw);
    $("#es-dup").addEventListener("change", draw);
    draw();
  }
  function clearSugg() { suggLayer && map.removeLayer(suggLayer); suggLayer = null; }

  /* ---------- formulario dentro de la ficha de una estación ---------- */
  function stationForm(st) {
    if (!pw) return;
    if (!csv) { loadCSV().then(() => { if (S.sel === st.id) stationForm(st); }).catch(() => {}); return; }
    const row = csv?.rows.find(r => r.id === st.id) || {};
    const pend = pending.find(p => p.id === st.id && p.type === "update")?.fields || {};
    const val = k => pend[k] ?? row[k] ?? "";
    const qsel = (k, label) => `<label class="field">${label}<select data-k="${k}">${QOPT.map(([v, t]) => `<option value="${v}" ${val(k) === v ? "selected" : ""}>${t}</option>`).join("")}</select></label>`;
    const active = (val("active") || "1") === "1";
    const box = document.createElement("section");
    box.className = "ed-box";
    box.innerHTML = `<h3 class="block-title">Editar ${pend && Object.keys(pend).length ? `<span class="badge warn">cambios sin guardar</span>` : ""}</h3>
      <form class="ed-form" id="es-form">
      <label class="field">Nombre<input data-k="name" value="${esc(val("name") || st.name)}"></label>
      <div class="ed-row">${qsel("q_tmax", "Calidad máx.")}${qsel("q_tmin", "Calidad mín.")}</div>
      <div class="ed-row">${qsel("q_prec", "Calidad lluvia")}${qsel("q_wind", "Calidad viento")}</div>
      <label class="check"><input type="checkbox" data-k="tz_shift" ${val("tz_shift") === "1" || (!row.id && st.tzs) ? "checked" : ""}> Problema de hora (contador de lluvia desfasado)</label>
      <div class="ed-row"><label class="field">Modelo<input data-k="model" value="${esc(val("model"))}"></label>
        <label class="field">Notas<input data-k="notes" value="${esc(val("notes"))}"></label></div>
      <div class="ed-row"><label class="field">Latitud<input data-k="lat" value="${esc(val("lat") || st.lat)}"></label>
        <label class="field">Longitud<input data-k="lon" value="${esc(val("lon") || st.lon)}"></label>
        <label class="field">Altitud<input data-k="alt" value="${esc(val("alt") || (st.alt ?? ""))}"></label></div>
      <div class="side-actions"><button class="btn" type="submit">Anotar el cambio</button>
        <button class="btn ghost" type="button" id="es-active">${active ? "Dar de baja" : "Reactivar"}</button></div></form>`;
    $("#side-body").appendChild(box);
    $("#es-form").addEventListener("submit", e => {
      e.preventDefault();
      const fields = {};
      $$("#es-form [data-k]").forEach(el => {
        const k = el.dataset.k, v = el.type === "checkbox" ? (el.checked ? "1" : "") : el.value.trim();
        if (v !== (row[k] ?? "") || !row.id) fields[k] = v;
      });
      if (!Object.keys(fields).length) return toast("No has cambiado nada.");
      addChange({ type: "update", id: st.id, label: `cambio en ${st.name} (${Object.keys(fields).join(", ")})`, fields });
      openStation(st.id, false);
    });
    $("#es-active").addEventListener("click", () => {
      addChange({ type: "update", id: st.id, label: `${active ? "baja" : "reactivación"} de ${st.name}`, fields: { active: active ? "0" : "1" } });
      openStation(st.id, false);
    });
  }

  function pointButton(lat, lon) {
    if (!pw) return "";
    return `<button class="btn ghost" id="ed-here">＋ Añadir una estación aquí</button>`;
  }
  function bindPoint(lat, lon) {
    $("#ed-here")?.addEventListener("click", () => { render(); tab = "add"; renderAdd({ lat: lat.toFixed(5), lon: lon.toFixed(5) }); });
  }

  function updateBadge() {
    const b = $("#btn-editor");
    if (b) b.textContent = pending.length ? `Editar la red (${pending.length})` : "Editar la red";
  }

  // si ya había sesión, se recarga el CSV en segundo plano
  if (pw) loadCSV().then(() => document.body.classList.add("editing")).catch(() => { pw = null; });
  setTimeout(updateBadge, 0);

  return {
    open, stationForm, pointButton, bindPoint,
    get on() { return !!pw; },
    pick(ll) { if (!picking) return false; const f = picking; picking = null; f(ll); return true; },
  };
})();
