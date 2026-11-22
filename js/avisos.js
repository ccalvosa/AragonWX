/* ==========================================================
   Avisos meteorológicos de AEMET (Meteoalerta, CAP).
   Los descarga el bucle cada 30 min (scraper/aragonwx/sources/avisos.py)
   en avisos.json: solo amarillos, naranjas y rojos no caducados.
   ========================================================== */

const Avisos = (() => {
  const COL = { amarillo: "#f2c500", naranja: "#f76707", rojo: "#c92a2a" };
  const LV = { amarillo: "Amarillo", naranja: "Naranja", rojo: "Rojo" };
  let D = null, ts = 0, layer = null;
  map.createPane("avisos");
  map.getPane("avisos").style.zIndex = 390;

  async function load() {
    if (!D || Date.now() - ts > 9 * 60e3) {
      D = await getJSON(DATA_URL + "avisos.json" + bust()).catch(() => D);
      ts = Date.now();
    }
    return D;
  }
  const nowS = () => Date.now() / 1000;
  const isActive = a => (a.onset || 0) <= nowS() && a.expires > nowS();
  const hm = t => new Date(t * 1000).toLocaleString("es-ES", { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const range = a => `${isActive(a) ? "En vigor" : "Desde " + hm(a.onset)} · hasta ${hm(a.expires)}`;
  const what = a => `${a.phen_name}${a.param ? ` · ${a.param.toLowerCase()}${a.value ? " " + a.value : ""}` : ""}`;

  function zones(list) {
    const z = new Map();
    for (const a of list) {
      if (!z.has(a.zone)) z.set(a.zone, { zone: a.zone, area: a.area, poly: a.poly, ar: a.ar, items: [] });
      z.get(a.zone).items.push(a);
    }
    for (const g of z.values()) {
      g.lv = Math.max(...g.items.map(a => a.lv));
      g.level = g.items.find(a => a.lv === g.lv).level;
      g.active = g.items.some(isActive);
    }
    return [...z.values()];
  }

  function draw() {
    layer && map.removeLayer(layer);
    layer = null;
    if (!S.layers.avisos || !D) return;
    layer = L.layerGroup();
    for (const g of zones(D.avisos).sort((a, b) => a.lv - b.lv)) {
      const c = COL[g.level];
      for (const ring of g.poly) {
        L.polygon(ring, { pane: "avisos", color: c, weight: g.active ? 2 : 1.3, dashArray: g.active ? null : "5 4",
          fillColor: c, fillOpacity: g.active ? 0.28 : 0.1 })
          .bindTooltip(`<b>${esc(g.area)}</b><br>${g.items.map(a => `${LV[a.level]} · ${esc(what(a))}<br><span class="muted">${range(a)}</span>`).join("<br>")}`, { sticky: true })
          .on("click", () => openPanel(g.zone))
          .addTo(layer);
      }
    }
    layer.addTo(map);
  }

  function pill() {
    const b = $("#btn-avisos");
    const ar = (D?.avisos || []).filter(a => a.ar);
    if (!ar.length) { b.hidden = true; return; }
    const top = ar.reduce((m, a) => (a.lv > m.lv ? a : m), ar[0]);
    const zs = new Set(ar.map(a => a.zone)).size;
    b.hidden = false;
    b.style.setProperty("--c", COL[top.level]);
    b.querySelector("span").textContent = `${zs} ${zs === 1 ? "zona" : "zonas"} con aviso en Aragón`;
  }

  async function refresh() {
    await load();
    pill();
    draw();
  }

  function card(a) {
    return `<div class="av-card" style="--c:${COL[a.level]}">
      <div class="av-top"><span class="badge" style="background:${COL[a.level]};color:${inkFor(COL[a.level])}">${LV[a.level]}</span>
        <b>${esc(a.phen_name)}</b>${isActive(a) ? `<span class="live-tag">en vigor</span>` : ""}</div>
      ${a.param ? `<div class="av-param">${esc(a.param)}${a.value ? `: <b>${esc(a.value)}</b>` : ""}${a.prob ? ` <span class="muted">· probabilidad ${esc(a.prob)}</span>` : ""}</div>` : ""}
      <div class="r-meta">${esc(a.area)} · ${range(a)}</div>
      ${a.desc ? `<p class="small">${esc(a.desc)}</p>` : ""}</div>`;
  }

  async function openPanel(zone) {
    await load();
    const list = D?.avisos || [];
    const ar = list.filter(a => a.ar), rest = list.filter(a => !a.ar);
    const sel = zone ? list.filter(a => a.zone === zone) : null;
    openSide("avisos", `<div class="eyebrow"><span class="src-dot" style="--c:#e8590c"></span>AEMET · Meteoalerta</div>
      <h2 class="st-name">Avisos meteorológicos</h2>
      <p class="st-status">Actualizado ${D ? ago(D.ts) : "—"} · solo amarillos, naranjas y rojos</p>
      ${sel ? `<h3 class="block-title">${esc(sel[0].area)}</h3>${sel.map(card).join("")}` : ""}
      <h3 class="block-title">Aragón</h3>
      ${ar.length ? ar.map(card).join("") : `<p class="st-status">Sin avisos en Aragón.</p>`}
      ${rest.length ? `<details class="av-more"><summary>Resto de España (${new Set(rest.map(a => a.zone)).size} zonas)</summary>${rest.map(card).join("")}</details>` : ""}
      <div class="side-actions"><a class="btn ghost" href="https://www.aemet.es/es/eltiempo/prediccion/avisos" target="_blank" rel="noopener">Ver en AEMET ↗</a></div>`);
  }

  $("#btn-avisos").addEventListener("click", () => openPanel());
  return { refresh, draw, openPanel, load, aragon: () => (D?.avisos || []).filter(a => a.ar), isActive, what, range, COL, LV };
})();
