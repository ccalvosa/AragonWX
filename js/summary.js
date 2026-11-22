/* ==========================================================
   Resumen del día en Aragón: extremos, ríos, embalses y avisos,
   con descarga como imagen (1080×1350) para redes sociales.
   Excluye estaciones con calidad «Deficiente», ocultas a mano o
   marcadas por el control de calidad en esa variable.
   ========================================================== */

const Summary = (() => {
  let official = false;
  const CATS = [
    { k: "tx", title: "Máxima más alta", unit: "°C", scale: "temp", dir: -1, dec: 1, q: 0 },
    { k: "tn", title: "Mínima más baja", unit: "°C", scale: "temp", dir: 1, dec: 1, q: 1 },
    { k: "pr", title: "Más lluvia hoy", unit: "mm", scale: "prec", dir: -1, dec: 1, q: 2, min: 0.1 },
    { k: "gust", title: "Racha más fuerte", unit: "km/h", scale: "wind", dir: -1, dec: 0, q: 3 },
  ];
  const NOWCATS = [
    { k: "ta", title: "Ahora, la más cálida", unit: "°C", scale: "temp", dir: -1, dec: 1, q: 0 },
    { k: "ta", title: "Ahora, la más fría", unit: "°C", scale: "temp", dir: 1, dec: 1, q: 0 },
  ];

  function pool() {
    return STATIONS.filter(s => s.st === "ok" && !S.hidden.has(s.id) && inAragon(s) && (!official || SOURCES[s.src]?.official));
  }
  function top(c, n = 5) {
    return pool().filter(s => s[c.k] != null && (c.min == null || s[c.k] >= c.min)
        && !(s.q && s.q[c.q] === "D") && !(s.qc || []).some(code => code.startsWith(c.k + "_")))
      .sort((a, b) => (a[c.k] - b[c.k]) * c.dir).slice(0, n);
  }
  function rivers() {
    if (!HYDRO) return [];
    return HYDRO.meta.gauges.filter(g => !BAD_FLOW.has(g.id)).map(g => [g, HYDRO.gauges[g.id], gaugeLevel(g, HYDRO.gauges[g.id])])
      .filter(([, r, [lv]]) => r && !r.stale && /Aviso/.test(lv)).sort((a, b) => (b[1].h ?? 0) - (a[1].h ?? 0));
  }
  function reservoirs() {
    if (!HYDRO) return null;
    let vol = 0, cap = 0, dv = 0;
    for (const r of HYDRO.meta.reservoirs) {
      const x = HYDRO.reservoirs[r.id];
      if (!x || x.vol == null || !+r.capacity_hm3) continue;
      vol += x.vol; cap += +r.capacity_hm3; dv += x.dv || 0;
    }
    return cap ? { pct: vol / cap * 100, vol, cap, dv } : null;
  }
  const dateLong = () => new Date().toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  function row(s, c, i) {
    const col = colorFor(c.scale, s[c.k]);
    return `<tr data-id="${esc(s.id)}"><td class="muted num">${i + 1}</td><td><span class="r-name">${esc(s.name)}</span>
      <span class="r-meta">${SOURCES[s.src]?.name || s.src}${s.alt != null ? ` · ${s.alt} m` : ""}</span></td>
      <td class="num rv"><span class="rv-pill" style="background:${col};color:${inkFor(col)}">${fmt(s[c.k], c.dec)}</span></td></tr>`;
  }

  function open() {
    const rv = rivers(), em = reservoirs(), av = typeof Avisos !== "undefined" ? Avisos.aragon() : [];
    const block = c => {
      const t = top(c);
      return `<h3 class="block-title">${c.title} <small>${c.unit}</small></h3>
        ${t.length ? `<table class="rank-table">${t.map((s, i) => row(s, c, i)).join("")}</table>` : `<p class="st-status">Sin datos.</p>`}`;
    };
    openSide("summary", `<div class="eyebrow">Resumen del día</div>
      <h2 class="st-name">${dateLong().replace(/^./, m => m.toUpperCase())}</h2>
      <p class="st-status">Aragón · datos de las ${hhmm(NOW_TS())}. Sin estaciones dudosas ni ocultas.</p>
      <div class="seg seg-sm sum-seg" id="sum-seg"><button data-o="0" class="${official ? "" : "on"}">Todas las redes</button><button data-o="1" class="${official ? "on" : ""}">Solo AEMET y SAIH</button></div>
      <div class="side-actions"><button class="btn" id="sum-img">Descargar imagen</button>${navigator.share ? `<button class="btn ghost" id="sum-share">Compartir</button>` : ""}</div>
      ${CATS.map(block).join("")}
      ${NOWCATS.map(block).join("")}
      <h3 class="block-title">Ríos en aviso</h3>
      ${rv.length ? `<table class="rank-table">${rv.map(([g, r, [lv, c]]) => `<tr data-g="${g.id}"><td><span class="r-name">${esc(g.name)}</span><span class="r-meta">${fmt(r.q, 1)} m³/s</span></td>
        <td class="num rv"><span class="rv-pill" style="background:${c};color:${inkFor(c)}">${lv.replace("Aviso ", "")} · ${fmt(r.h, 2)} m</span></td></tr>`).join("")}</table>`
        : `<p class="st-status">Ningún aforo por encima de su umbral de aviso.</p>`}
      <h3 class="block-title">Embalses</h3>
      ${em ? `<p class="st-status"><b>${fmt(em.pct, 1)} %</b> de la capacidad (${fmt(em.vol, 0)} de ${fmt(em.cap, 0)} hm³) · ${em.dv >= 0 ? "+" : ""}${fmt(em.dv, 1)} hm³ en 24 h</p>` : `<p class="st-status">Sin datos.</p>`}
      <h3 class="block-title">Avisos de AEMET</h3>
      ${av.length ? av.map(a => `<p class="small"><span class="badge" style="background:${Avisos.COL[a.level]};color:${inkFor(Avisos.COL[a.level])}">${Avisos.LV[a.level]}</span>
        ${esc(a.area)}: ${esc(Avisos.what(a))} <span class="muted">(${Avisos.range(a)})</span></p>`).join("") : `<p class="st-status">Sin avisos en Aragón.</p>`}`);
    $$("#sum-seg button").forEach(b => b.addEventListener("click", () => { official = b.dataset.o === "1"; open(); }));
    $$("#side-body tr[data-id]").forEach(tr => tr.addEventListener("click", () => { const s = BYID.get(tr.dataset.id); map.flyTo([s.lat, s.lon], 12); openStation(s.id, false); }));
    $$("#side-body tr[data-g]").forEach(tr => tr.addEventListener("click", () => { const g = HYDRO.meta.gauges.find(x => x.id === tr.dataset.g); map.flyTo([+g.lat, +g.lon], 11); openHydro("gauges", g.id); }));
    $("#sum-img").addEventListener("click", () => image().then(blob => download(blob)));
    $("#sum-share")?.addEventListener("click", () => image().then(blob => {
      const f = new File([blob], fileName(), { type: "image/png" });
      (navigator.canShare?.({ files: [f] }) ? navigator.share({ files: [f], title: "Resumen del día en Aragón" }) : Promise.reject()).catch(() => download(blob));
    }));
  }
  const NOW_TS = () => NOW?.ts;
  const fileName = () => `resumen-aragon-${new Date().toISOString().slice(0, 10)}.png`;
  function download(blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = fileName(); a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  /* ---------- imagen 1080×1350 ---------- */
  async function image() {
    await document.fonts?.ready;
    const W = 1080, H = 1350, P = 60, cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const x = cv.getContext("2d"), c = n => cssVar(n), F = (w, s) => `${w} ${s}px "Plus Jakarta Sans", system-ui, sans-serif`;
    const round = (X, Y, w, h, r, fill, stroke) => { x.beginPath(); x.roundRect(X, Y, w, h, r); if (fill) { x.fillStyle = fill; x.fill(); } if (stroke) { x.strokeStyle = stroke; x.lineWidth = 2; x.stroke(); } };
    const text = (t, X, Y, font, color, align = "left", maxW) => {
      x.font = font; x.fillStyle = color; x.textAlign = align; x.textBaseline = "alphabetic";
      if (maxW) while (x.measureText(t).width > maxW && t.length > 3) t = t.slice(0, -2) + "…";
      x.fillText(t, X, Y);
    };
    x.fillStyle = c("--bg"); x.fillRect(0, 0, W, H);
    // cabecera
    ["#1c7ed6", "#74c0fc", "#ffd8a8", "#ff8787", "#e03131"].forEach((col, i) => { x.fillStyle = col; x.fillRect(P + i * 11, P, 12, 56); });
    text("ESTACIONES DE ARAGÓN", P + 76, P + 22, F(700, 20), c("--accent"));
    text("Resumen del día", P + 76, P + 58, F(800, 40), c("--fg"));
    text(dateLong().replace(/^./, m => m.toUpperCase()), P, P + 112, F(600, 26), c("--muted"));
    text(`Datos hasta las ${hhmm(NOW_TS())}${official ? " · solo AEMET y SAIH" : ""}`, W - P, P + 112, F(500, 22), c("--muted"), "right");
    // cuatro bloques
    const gw = (W - 2 * P - 24) / 2, gh = 400, y0 = P + 145;
    CATS.forEach((cat, i) => {
      const X = P + (i % 2) * (gw + 24), Y = y0 + Math.floor(i / 2) * (gh + 24);
      round(X, Y, gw, gh, 22, c("--card"), c("--border"));
      const t = top(cat, 4);
      text(cat.title.toUpperCase(), X + 28, Y + 46, F(700, 20), c("--muted"));
      if (!t.length) { text("Sin datos", X + 28, Y + 120, F(700, 36), c("--muted")); return; }
      const s0 = t[0], col = colorFor(cat.scale, s0[cat.k]);
      round(X + 28, Y + 66, gw - 56, 104, 16, col);
      text(`${fmt(s0[cat.k], cat.dec)}`, X + 50, Y + 146, F(800, 64), inkFor(col));
      x.font = F(800, 64);
      text(cat.unit, X + 58 + x.measureText(fmt(s0[cat.k], cat.dec)).width, Y + 146, F(700, 28), inkFor(col));
      text(s0.name, X + 28, Y + 210, F(700, 28), c("--fg"), "left", gw - 56);
      text(`${SOURCES[s0.src]?.name || s0.src}${s0.alt != null ? ` · ${s0.alt} m` : ""}`, X + 28, Y + 242, F(500, 20), c("--muted"), "left", gw - 56);
      t.slice(1).forEach((s, j) => {
        const yy = Y + 300 + j * 34;
        text(`${j + 2}. ${s.name}`, X + 28, yy, F(600, 22), c("--fg"), "left", gw - 160);
        text(`${fmt(s[cat.k], cat.dec)} ${cat.unit}`, X + gw - 28, yy, F(700, 22), c("--fg"), "right");
      });
    });
    // fila inferior: ríos, embalses y avisos
    const Y2 = y0 + 2 * gh + 48, w3 = (W - 2 * P - 48) / 3, h3 = 150;
    const rv = rivers(), em = reservoirs(), av = typeof Avisos !== "undefined" ? Avisos.aragon() : [];
    const tiles = [
      ["RÍOS EN AVISO", rv.length ? String(rv.length) : "Ninguno", rv.length ? rv.slice(0, 2).map(([g]) => g.name).join(", ") : "todos los aforos bajo umbral"],
      ["EMBALSES", em ? `${fmt(em.pct, 0)} %` : "—", em ? `${em.dv >= 0 ? "+" : ""}${fmt(em.dv, 1)} hm³ en 24 h` : ""],
      ["AVISOS AEMET", av.length ? (n => `${n} ${n === 1 ? "zona" : "zonas"}`)(new Set(av.map(a => a.zone)).size) : "Ninguno", av.length ? [...new Set(av.map(a => a.phen_name))].join(", ") : "sin avisos en Aragón"],
    ];
    tiles.forEach(([t, v, sub], i) => {
      const X = P + i * (w3 + 24);
      round(X, Y2, w3, h3, 20, c("--card"), c("--border"));
      text(t, X + 24, Y2 + 40, F(700, 18), c("--muted"));
      text(v, X + 24, Y2 + 92, F(800, 40), c("--fg"), "left", w3 - 48);
      text(sub, X + 24, Y2 + 126, F(500, 18), c("--muted"), "left", w3 - 48);
    });
    // pie
    text("Datos: AEMET · SAIH Ebro · Weather Underground · WeatherCloud · Meteoclimatic · Ibericam · Holfuy · AVAMET", P, H - P - 26, F(500, 17), c("--muted"), "left", W - 2 * P);
    text("estacioneszgz.meteozgz.eu", P, H - P + 8, F(700, 24), c("--accent"));
    return new Promise(res => cv.toBlob(res, "image/png"));
  }

  return { open, image };
})();
