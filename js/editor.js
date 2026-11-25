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
  const PEND_KEY = "aragonwx-pending", DONE_KEY = "aragonwx-done";
  const QNAME = { q_tmax: "máxima", q_tmin: "mínima", q_prec: "lluvia", q_wind: "viento" };

  let pw = null, csv = null, pending = [], tab = "changes", picking = null, sugg = null, suggLayer = null, pin = null;
  let done = {};   // "id:campo" -> hora en que se guardó (los avisos tardan ≤ 10 min en desaparecer)
  try { pw = sessionStorage.getItem("aragonwx-pw"); pending = JSON.parse(localStorage.getItem(PEND_KEY) || "[]"); } catch {}
  try {
    done = JSON.parse(localStorage.getItem(DONE_KEY) || "{}");
    for (const [k, t] of Object.entries(done)) if (Date.now() - t > 40 * 60e3) delete done[k];
  } catch {}

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
  function addChange(ch, quiet = false) {
    // un único cambio por estación: los campos se acumulan
    const prev = pending.find(p => p.id === ch.id && p.type === ch.type);
    if (prev) Object.assign(prev.fields, ch.fields), prev.label = ch.label;
    else pending.push(ch);
    savePending();
    if (!quiet) toast(`Anotado. Guárdalo con «Guardar», abajo del panel (${pending.length} pendiente${pending.length > 1 ? "s" : ""}).`);
  }
  const rowOf = id => csv?.rows.find(r => r.id === id);
  const ignored = notes => (notes.match(/qc-ignore=([\w,]+)/)?.[1] || "").split(",").filter(Boolean);
  /* quita un campo de un cambio pendiente (y el cambio entero si se queda vacío) */
  function unsetField(id, k) {
    const p = pending.find(x => x.id === id && x.type === "update");
    if (!p) return;
    delete p.fields[k];
    if (!Object.keys(p.fields).length) pending.splice(pending.indexOf(p), 1);
    savePending();
  }
  /* texto de un cambio (lista y mensaje del commit), sacado de los campos para que siga valiendo al deshacer */
  function describe(p) {
    if (p.type !== "update") return p.label;
    const row = rowOf(p.id) || {}, name = BYID.get(p.id)?.name || row.name || p.id;
    const parts = Object.entries(p.fields).map(([k, v]) => {
      if (QNAME[k]) return `${QNAME[k]} ${v === "Deficiente" ? "deficiente" : v === "Contrastada" ? "contrastada" : "sin marca"}`;
      if (k === "active") return v === "0" ? "baja" : "reactivación";
      if (k === "tz_shift") return v === "1" ? "problema de hora" : "sin problema de hora";
      if (k === "notes") {
        const was = ignored(row.notes ?? BYID.get(p.id)?.notes ?? ""), add = ignored(v).filter(x => !was.includes(x));
        return add.length ? `no avisar de ${add.map(x => VNAME[x] || x).join(", ")}` : "notas";
      }
      return { name: "nombre", lat: "latitud", lon: "longitud", alt: "altitud", model: "modelo" }[k] || k;
    });
    return `${name}: ${parts.join(", ")}`;
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
  let saving = false;
  async function saveAll() {
    if (!pending.length || saving) return;
    saving = true; updateBadge();
    try {
      await loadCSV();
      const rows = applyChanges(csv.rows.map(r => ({ ...r })));
      const msg = pending.map(describe).join("; ");
      await api("/stations", { method: "PUT", body: JSON.stringify({ content: toCSV(rows, csv.eol), sha: csv.sha, message: msg }) });
      // se recuerda lo guardado para no volver a proponerlo mientras el bucle no lo recoge
      const t = Date.now();
      for (const p of pending) for (const [k, v] of Object.entries(p.fields)) {
        if (k === "notes") for (const x of ignored(v)) done[`${p.id}:ign:${x}`] = t;
        else done[`${p.id}:${k}`] = t;
      }
      try { localStorage.setItem(DONE_KEY, JSON.stringify(done)); } catch {}
      const n = pending.length;
      pending = []; saving = false; savePending();
      await loadCSV().catch(() => {});
      toast(`Guardado${n > 1 ? ` (${n} estaciones)` : ""}. Entra en el mapa en la próxima actualización (≤ 10 min).`, 6000);
      refreshView();
    } catch (e) {
      saving = false; updateBadge();
      toast("No se ha podido guardar: " + e.message, 6000);
    }
  }
  /* vuelve a pintar lo que esté abierto (el editor o la ficha de una estación) */
  function refreshView() {
    if (S.side === "editor") render();
    else if (S.side === "station" && S.sel) openStation(S.sel, false);
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
      try { await loadCSV(); try { sessionStorage.setItem("aragonwx-pw", pw); } catch {} document.body.classList.add("editing"); updateBadge(); render(); }
      catch (err) { pw = null; showLogin(err.status === 401 ? "Contraseña incorrecta." : "No se puede conectar con el editor: " + err.message); }
    });
  }
  function logout() {
    pw = null; try { sessionStorage.removeItem("aragonwx-pw"); } catch {}
    document.body.classList.remove("editing"); clearSugg(); closeSide(); updateBadge();
  }

  /* ---------- panel del editor ---------- */
  function render() {
    document.body.classList.add("editing");
    openSide("editor", `<div class="eyebrow">Editor de la red <button class="link-btn small" id="ed-out">salir</button></div>
      <h2 class="st-name">Estaciones</h2>
      <div class="seg seg-sm seg-wrap ed-tabs" id="ed-tabs">
        <button data-t="changes">Cambios${pending.length ? ` (${pending.length})` : ""}</button>
        <button data-t="qc">Sospechosas</button><button data-t="rehab">Deficientes</button><button data-t="add">Alta</button><button data-t="sugg">Sugerencias</button></div>
      <div id="ed-body"></div>`);
    $("#ed-out").addEventListener("click", logout);
    $$("#ed-tabs button").forEach(b => { b.classList.toggle("on", b.dataset.t === tab); b.addEventListener("click", () => { tab = b.dataset.t; render(); }); });
    if (tab !== "sugg") clearSugg();
    ({ changes: renderChanges, qc: renderQC, rehab: renderRehab, add: () => renderAdd(), sugg: renderSugg })[tab]();
  }

  function renderChanges() {
    $("#ed-body").innerHTML = `
      <p class="hint">Abre cualquier estación para cambiar su calidad, el problema de hora, sus notas o darla de baja.
        Para una estación nueva, usa <b>Alta</b> o haz clic en el mapa y «Añadir una estación aquí».</p>
      ${pending.length ? `<ul class="ed-list">${pending.map((p, i) => `<li><span>${esc(describe(p))}</span>
        <button class="link-btn small" data-i="${i}">quitar</button></li>`).join("")}</ul>
        <div class="side-actions"><button class="btn ghost" id="ed-clear">Descartar todo</button></div>`
      : `<p class="st-status">No hay cambios pendientes.</p>`}`;
    $$("#ed-body .ed-list button").forEach(b => b.addEventListener("click", () => { pending.splice(+b.dataset.i, 1); savePending(); render(); }));
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

  /* ---------- sospechosas (control de calidad automático) ---------- */
  const VNAME = { ta: "temperatura", tx: "máxima", tn: "mínima", pr: "lluvia", gust: "racha", hr: "humedad" };
  function notesOf(id) {
    const p = pending.find(x => x.id === id && x.type === "update");
    if (p && p.fields.notes != null) return p.fields.notes;
    return csv?.rows.find(r => r.id === id)?.notes ?? (BYID.get(id)?.notes || "");
  }
  function withIgnore(notes, v) {
    const m = notes.match(/qc-ignore=([\w,]+)/);
    const set = new Set(m ? m[1].split(",") : []);
    set.add(v);
    const tok = "qc-ignore=" + [...set].join(",");
    return m ? notes.replace(m[0], tok) : (notes ? notes + " " : "") + tok;
  }
  function withoutIgnore(notes, v) {
    const m = notes.match(/qc-ignore=([\w,]+)/);
    if (!m) return notes;
    const rest = m[1].split(",").filter(x => x && x !== v);
    return (rest.length ? notes.replace(m[0], "qc-ignore=" + rest.join(",")) : notes.replace(m[0], "")).replace(/\s+/g, " ").trim();
  }
  /* estado de un aviso: "bad"/"skip" anotado sin guardar, "saved" ya guardado, o null */
  function flagState(id, f) {
    const p = pending.find(x => x.id === id && x.type === "update")?.fields || {};
    if (f.qcol && p[f.qcol] === "Deficiente") return "bad";
    if (p.notes != null && ignored(p.notes).includes(f.var)) return "skip";
    if ((f.qcol && done[`${id}:${f.qcol}`]) || done[`${id}:ign:${f.var}`]) return "saved";
    return null;
  }
  function undoFlag(id, f, st) {
    if (st === "bad") return unsetField(id, f.qcol);
    const orig = rowOf(id)?.notes ?? (BYID.get(id)?.notes || ""), now = withoutIgnore(notesOf(id), f.var);
    if (now === orig) unsetField(id, "notes");
    else addChange({ type: "update", id, label: "", fields: { notes: now } }, true);
  }
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  let qcData = null;
  async function renderQC(reload = true) {
    if (reload || !qcData) {
      $("#ed-body").innerHTML = `<p class="hint">Estaciones que se apartan de sus vecinas de forma repetida: en directo (al menos
        1 h hoy o varios días esta semana) o siempre hacia el mismo lado en los últimos 14 días cerrados (<b>sesgo</b>).
        <b>Deficiente</b> oculta esa variable en el mapa; <b>Descartar</b> deja de avisar de esa variable en esta estación.
        Ve marcando las que quieras y guárdalas todas juntas con «Guardar», abajo del panel.</p>
        <p class="st-status" id="eq-info">Cargando…</p><ul class="ed-sugg" id="eq-list"></ul>`;
      try { qcData = await getJSON(DATA_URL + "qc.json" + bust()); }
      catch { $("#eq-info").textContent = "Todavía no hay resultados del control de calidad."; return; }
      if (tab !== "qc" || S.side !== "editor") return;
    }
    const q = qcData;
    // los de sesgo (14 días) van primero: son los más sólidos
    const score = e => Math.max(...e.flags.map(f => (f.daily ? 1e4 + f.n : f.days * 100 + f.today)));
    const all = Object.entries(q.stations).sort((a, b) => score(b[1]) - score(a[1]));
    // las que ya se guardaron del todo no se vuelven a proponer (el bucle tarda ≤ 10 min en recogerlo)
    const items = all.filter(([id, e]) => !e.flags.every(f => flagState(id, f) === "saved"));
    const nSaved = all.length - items.length;
    $("#eq-info").textContent = (items.length
      ? `${items.length} estaciones sospechosas · ${new Date(q.generated).toLocaleString("es-ES", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })}`
      : "Ninguna estación sospechosa ahora mismo.") + (nSaved ? ` · ${nSaved} ya resueltas` : "");
    const STXT = { bad: "Deficiente · sin guardar", skip: "Descartado · sin guardar", saved: "Guardado" };
    $("#eq-list").innerHTML = items.map(([id, e]) => {
      const open = e.flags.filter(f => f.qcol && !flagState(id, f));
      return `<li data-id="${esc(id)}" class="eq-item"><div style="flex:1">
        <span class="r-name">${esc(e.name)}</span><span class="r-meta">${NETS[e.src] || e.src} · ${esc(id)}</span>
        ${e.flags.map((f, i) => {
          const st = flagState(id, f);
          return `<div class="eq-flag${st ? " eq-done" : ""}"><span class="small">⚠ ${esc(f.msg)}</span>
          <span class="r-meta">${f.daily ? `<span class="eq-tag">Sesgo</span> ${esc(f.meta)}` : `${f.today} pasadas hoy · ${f.days} ${f.days === 1 ? "día" : "días"} esta semana`}</span>
          <div class="ed-btns">${st
            ? `<span class="badge ${st === "saved" ? "ok" : "warn"}">✓ ${STXT[st]}</span>${st !== "saved" ? `<button class="link-btn small" data-a="undo" data-i="${i}">deshacer</button>` : ""}`
            : `${f.qcol ? `<button class="btn sm" data-a="bad" data-i="${i}">${cap(VNAME[f.var])} deficiente</button>` : ""}
               <button class="btn ghost sm" data-a="skip" data-i="${i}">Descartar</button>`}</div></div>`;
        }).join("")}
        ${open.length > 1 ? `<div class="ed-btns eq-all"><button class="btn ghost sm" data-a="allbad">Todo deficiente (${open.map(f => VNAME[f.var]).join(", ")})</button></div>` : ""}
      </div><button class="btn ghost sm" data-a="see">Ver</button></li>`;
    }).join("");
    const keep = () => { const y = $("#side-body").scrollTop; renderQC(false); $("#side-body").scrollTop = y; };
    $$("#eq-list li").forEach(li => {
      const id = li.dataset.id, e = q.stations[id];
      li.querySelector("[data-a=see]").addEventListener("click", () => {
        const s = BYID.get(id);
        if (s) { map.flyTo([s.lat, s.lon], 12); openStation(id, false); }
      });
      li.querySelectorAll("[data-a=bad]").forEach(b => b.addEventListener("click", () => {
        const f = e.flags[+b.dataset.i];
        addChange({ type: "update", id, label: "", fields: { [f.qcol]: "Deficiente" } }, true);
        keep();
      }));
      li.querySelector("[data-a=allbad]")?.addEventListener("click", () => {
        const fields = {};
        for (const f of e.flags) if (f.qcol && !flagState(id, f)) fields[f.qcol] = "Deficiente";
        addChange({ type: "update", id, label: "", fields }, true);
        keep();
      });
      li.querySelectorAll("[data-a=skip]").forEach(b => b.addEventListener("click", () => {
        const f = e.flags[+b.dataset.i];
        addChange({ type: "update", id, label: "", fields: { notes: withIgnore(notesOf(id), f.var) } }, true);
        keep();
      }));
      li.querySelectorAll("[data-a=undo]").forEach(b => b.addEventListener("click", () => {
        const f = e.flags[+b.dataset.i];
        undoFlag(id, f, flagState(id, f));
        keep();
      }));
    });
  }

  /* ---------- deficientes: ¿vuelven a dar datos buenos? (rehab.json, una vez al día) ---------- */
  const RVAR = { x: ["máxima", "°C"], n: ["mínima", "°C"], p: ["lluvia", "mm"], w: ["racha", "km/h"] };
  const RVERD = {
    ok: ["Parece recuperada", "ok"], mixed: ["Dudosa: unos días bien y otros no", "warn"], bad: ["Sigue mal", "bad"],
    few: ["Pocos días para comparar", ""], nonb: ["Sin vecinas fiables cerca", ""], nodata: ["Sin datos estos días", ""],
  };
  const REST = ["few", "nonb", "nodata"];
  let rehabFilter = "ok";
  async function renderRehab() {
    $("#ed-body").innerHTML = `<p class="hint">Variables marcadas como <b>Deficiente</b>, comparadas día a día con la mediana
      de sus vecinas fiables en los últimos 14 días cerrados. Si una estación se ha arreglado, aquí se ve y puedes quitarle la marca.
      Ojo en invierno con la máxima: un sensor al sol apenas se pasa con el sol bajo.</p>
      <div class="seg seg-sm seg-wrap" id="er-f"><button data-f="ok">Recuperadas</button><button data-f="mixed">Dudosas</button>
        <button data-f="bad">Siguen mal</button><button data-f="rest">Sin comparar</button><button data-f="all">Todas</button></div>
      <p class="st-status" id="er-info">Cargando…</p><ul class="ed-sugg" id="er-list"></ul>`;
    let q;
    try { q = await getJSON(DATA_URL + "rehab.json" + bust()); }
    catch { $("#er-info").textContent = "Todavía no hay revisión de las deficientes (la hace el bucle una vez al día)."; return; }
    const pend = (id, k) => pending.find(p => p.id === id && p.type === "update")?.fields[k] === "";
    const all = Object.entries(q.stations).flatMap(([id, st]) => st.vars.map(e => ({ id, st, e })))
      .filter(({ id, e }) => !done[`${id}:${e.qcol}`]);
    const inF = (f, v) => f === "all" || (f === "rest" ? REST.includes(v) : v === f);
    $$("#er-f button").forEach(b => {
      b.textContent += ` (${all.filter(({ e }) => inF(b.dataset.f, e.verdict)).length})`;
      b.classList.toggle("on", b.dataset.f === rehabFilter);
      b.addEventListener("click", () => { rehabFilter = b.dataset.f; renderRehab(); });
    });
    const order = { ok: 0, mixed: 1, bad: 2, few: 3, nonb: 4, nodata: 5 };
    const share = e => e.good / (e.n || 1);
    const items = all.filter(({ e }) => inF(rehabFilter, e.verdict))
      .sort((a, b) => order[a.e.verdict] - order[b.e.verdict] || share(b.e) - share(a.e) || a.st.name.localeCompare(b.st.name));
    const d = s => new Date(s + "T12:00").toLocaleDateString("es-ES", { day: "numeric", month: "short" });
    $("#er-info").textContent = `${items.length} variables · del ${d(q.days[0])} al ${d(q.days[1])}`;
    const num = (v, dd = 1) => (v == null ? "–" : fmt(v, dd));
    const stats = e => {
      const u = RVAR[e.var][1];
      const b = e.var === "w" ? `racha ×${num(e.bias, 2)} la de sus vecinas`
        : `sesgo ${signed(e.bias)} ${u}${e.mad != null ? ` · error medio ${num(e.mad)} ${u}` : ""}${e.peak != null ? ` · peor día ${signed(e.peak)} ${u}` : ""}`;
      return `${e.good} de ${e.n} días bien · ${b} · ${e.nb} vecinas`;
    };
    const dots = e => (e.series || []).map(s => s
      ? `<span class="er-d ${s[3] ? "ok" : "bad"}" title="${s[0].split("-").reverse().join("/")}: ${num(s[1])} frente a ${num(s[2])} ${RVAR[e.var][1]} de sus vecinas"></span>`
      : `<span class="er-d" title="sin comparar"></span>`).join("");
    $("#er-list").innerHTML = items.slice(0, 400).map(({ id, st, e }, i) => {
      const [txt, cls] = RVERD[e.verdict] || [e.verdict, ""];
      return `<li data-i="${i}" class="eq-item"><div style="flex:1">
        <span class="r-name">${esc(st.name)}</span><span class="r-meta">${NETS[st.src] || st.src} · ${esc(id)} · ${RVAR[e.var][0]} deficiente</span>
        <div class="eq-flag er-${cls || "none"}"><span class="small"><span class="badge ${cls}">${txt}</span>${e.frozen ? " · serie congelada" : ""}</span>
          ${e.n ? `<span class="r-meta">${stats(e)}</span><span class="er-dots">${dots(e)}</span>` : ""}
          <div class="ed-btns">${pend(id, e.qcol)
            ? `<span class="badge warn">✓ Sin «Deficiente» · sin guardar</span><button class="link-btn small" data-a="undo">deshacer</button>`
            : `<button class="btn sm${e.verdict === "ok" ? "" : " ghost"}" data-a="clear">Quitar «Deficiente» de la ${RVAR[e.var][0]}</button>`}</div></div>
      </div><button class="btn ghost sm" data-a="see">Ver</button></li>`;
    }).join("");
    $$("#er-list li").forEach(li => {
      const { id, st, e } = items[+li.dataset.i];
      li.querySelector("[data-a=see]").addEventListener("click", () => {
        const s = BYID.get(id);
        if (s) { map.flyTo([s.lat, s.lon], 12); openStation(id, false); }
      });
      const keep = () => { const y = $("#side-body").scrollTop; renderRehab().then(() => { $("#side-body").scrollTop = y; }); };
      li.querySelector("[data-a=clear]")?.addEventListener("click", () => {
        addChange({ type: "update", id, label: "", fields: { [e.qcol]: "" } }, true);
        keep();
      });
      li.querySelector("[data-a=undo]")?.addEventListener("click", () => { unsetField(id, e.qcol); keep(); });
    });
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
      addChange({ type: "update", id: st.id, label: "", fields });
      openStation(st.id, false);
    });
    $("#es-active").addEventListener("click", () => {
      addChange({ type: "update", id: st.id, label: "", fields: { active: active ? "0" : "1" } });
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

  /* barra fija al pie del panel lateral (editor y fichas): guardar sin cambiar de pestaña */
  function updateBadge() {
    const b = $("#btn-editor");
    if (b) b.textContent = pending.length ? `Editar la red (${pending.length})` : "Editar la red";
    let bar = $("#ed-savebar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "ed-savebar"; bar.className = "ed-savebar";
      $("#side").appendChild(bar);
      bar.addEventListener("click", e => {
        const a = e.target.closest("[data-a]")?.dataset.a;
        if (a === "save") saveAll();
        if (a === "list") { tab = "changes"; render(); }
      });
    }
    bar.hidden = !pw || !pending.length;
    const n = pending.length;
    bar.innerHTML = `<span>${n} ${n === 1 ? "cambio" : "cambios"} sin guardar</span>
      <button class="link-btn small" data-a="list">ver</button>
      <button class="btn sm" data-a="save" ${saving ? "disabled" : ""}>${saving ? "Guardando…" : "Guardar"}</button>`;
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
