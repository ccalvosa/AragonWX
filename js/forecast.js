/* ==========================================================
   Meteogramas con Open-Meteo (https://open-meteo.com, CC BY 4.0):
   - Previsión: AROME France HD 1,3 km (Météo-France, ~2,5 días) + IFS (ECMWF, 15 días)
   - Conjunto: ECMWF ENS 0,25° (51 miembros)
   Se piden desde el navegador al abrir una estación o un punto del mapa.
   ========================================================== */

const Forecast = (() => {
  const TZ = "Europe/Madrid";
  const OM = "https://api.open-meteo.com/v1/forecast";
  const OME = "https://ensemble-api.open-meteo.com/v1/ensemble";
  const AROME = "meteofrance_arome_france_hd", IFS = "ecmwf_ifs";
  const cache = new Map();

  /* ---------- utilidades ---------- */
  const fmtLocal = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const madrid = ms => fmtLocal.format(new Date(ms)).replace(" ", "T");          // "2026-11-22T14:30"
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const rgba = (hex, a) => {
    const h = hex.replace("#", "");
    if (h.length < 6) return hex;
    return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
  };
  const pct = (sorted, p) => {
    if (!sorted.length) return null;
    const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  };

  function get(url, key) {
    const c = cache.get(key);
    if (c && Date.now() - c.t < 15 * 60e3) return c.p;
    const p = fetch(url).then(r => r.ok ? r.json() : r.json().then(j => { throw new Error(j.reason || r.status); }));
    cache.set(key, { t: Date.now(), p });
    p.catch(() => cache.delete(key));
    return p;
  }

  function q(o) { return new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== "")).toString(); }

  async function deterministic(lat, lon, alt) {
    const vars = "temperature_2m,dew_point_2m,precipitation,snowfall,wind_speed_10m,wind_gusts_10m,wind_direction_10m,cloud_cover_low,cloud_cover_mid,cloud_cover_high,pressure_msl";
    const url = OM + "?" + q({ latitude: lat.toFixed(4), longitude: lon.toFixed(4), elevation: alt, timezone: TZ, past_days: 1,
      forecast_days: 16, wind_speed_unit: "kmh", hourly: vars, daily: "sunrise,sunset", models: `${AROME},${IFS}` });
    return get(url, "d:" + url);
  }

  async function ensemble(lat, lon, alt) {
    const url = OME + "?" + q({ latitude: lat.toFixed(4), longitude: lon.toFixed(4), elevation: alt, timezone: TZ, past_days: 1,
      forecast_days: 15, wind_speed_unit: "kmh", hourly: "temperature_2m,precipitation,wind_gusts_10m", models: "ecmwf_ifs025" });
    return get(url, "e:" + url);
  }

  /* ---------- piezas comunes del gráfico ---------- */
  function theme() {
    return { fg: css("--fg"), muted: css("--muted"), grid: css("--grid"), card: css("--card"), border: css("--border"),
      accent: css("--accent"), tmax: css("--tmax"), tmin: css("--tmin"), prec: css("--prec"), dtr: css("--dtr"),
      font: css("--font"), dark: document.documentElement.dataset.theme === "dark" ||
        (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches) };
  }

  function nightShapes(daily, th, x0, x1) {
    const shapes = [];
    const rises = Object.entries(daily).find(([k]) => k.startsWith("sunrise"))?.[1] || [];
    const sets = Object.entries(daily).find(([k]) => k.startsWith("sunset"))?.[1] || [];
    for (let i = 0; i < sets.length; i++) {
      const a = sets[i], b = rises[i + 1] || x1;
      if (!a) continue;
      shapes.push({ type: "rect", xref: "x", yref: "paper", x0: a, x1: b, y0: 0, y1: 1, fillcolor: rgba(th.dark ? "#000000" : "#1f2430", th.dark ? 0.16 : 0.045), line: { width: 0 }, layer: "below" });
    }
    if (rises[0] && x0 < rises[0]) shapes.push({ type: "rect", xref: "x", yref: "paper", x0, x1: rises[0], y0: 0, y1: 1, fillcolor: rgba(th.dark ? "#000000" : "#1f2430", th.dark ? 0.16 : 0.045), line: { width: 0 }, layer: "below" });
    return shapes;
  }

  function nowShape(nowS, th) {
    return { type: "line", xref: "x", yref: "paper", x0: nowS, x1: nowS, y0: 0, y1: 1, line: { color: th.accent, width: 1.5, dash: "dot" } };
  }

  function baseLayout(th, extra) {
    return {
      paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: th.font, size: 11, color: th.fg },
      margin: { l: 44, r: 40, t: 10, b: 30 }, showlegend: true,
      legend: { orientation: "h", x: 0, y: 1.02, yanchor: "bottom", font: { size: 10, color: th.muted }, bgcolor: "rgba(0,0,0,0)" },
      hovermode: "x unified", hoverdistance: 30, spikedistance: -1,
      hoverlabel: { bgcolor: th.card, bordercolor: th.border, font: { color: th.fg, size: 11 } },
      dragmode: "pan",
      ...extra,
    };
  }

  const xaxis = (th, range, extra = {}) => ({
    type: "date", range, gridcolor: th.grid, linecolor: th.grid, tickfont: { color: th.muted, size: 10 },
    tickformat: "%a %d\n%H:%M", hoverformat: "%a %d %b, %H:%M", showspikes: true, spikemode: "across",
    spikecolor: th.muted, spikethickness: 1, spikedash: "dot", ...extra,
  });
  const yax = (th, domain, title, extra = {}) => ({
    domain, gridcolor: th.grid, zerolinecolor: th.grid, tickfont: { color: th.muted, size: 10 }, fixedrange: true,
    title: { text: title, font: { size: 10, color: th.muted }, standoff: 4 }, ...extra,
  });
  const CONF = { displaylogo: false, responsive: true, locale: "es", scrollZoom: true,
    displayModeBar: matchMedia("(hover: hover)").matches ? "hover" : false,
    modeBarButtonsToRemove: ["select2d", "lasso2d", "autoScale2d", "toggleSpikelines", "hoverCompareCartesian", "hoverClosestCartesian"],
    toImageButtonOptions: { format: "png", scale: 2, filename: "meteograma" } };

  function rangeFor(days, nowMs) {
    return [madrid(nowMs - (days <= 2 ? 12 : 18) * 3600e3), madrid(nowMs + days * 86400e3)];
  }

  /* ---------- previsión determinista ---------- */
  function drawDeterministic(el, d, obs, days) {
    const th = theme();
    const h = d.hourly, x = h.time;
    const g = (v, m) => h[`${v}_${m}`] || [];
    const nowMs = Date.now(), nowS = madrid(nowMs);
    const lastArome = (() => { const a = g("temperature_2m", AROME); for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return x[i]; return null; })();

    // lluvia acumulada desde ahora (IFS, y AROME mientras dure)
    const acc = m => { let s = 0; return g("precipitation", m).map((v, i) => { if (x[i] <= nowS) return null; if (v == null) return null; s += v; return Math.round(s * 10) / 10; }); };
    const accI = acc(IFS), accA = acc(AROME);

    const T = [], dir = g("wind_direction_10m", IFS);
    T.push({ x, y: g("temperature_2m", IFS), name: "T · IFS", mode: "lines", line: { color: th.tmax, width: 1.6, dash: "dash" }, yaxis: "y", hovertemplate: "%{y:.1f} °C" });
    T.push({ x, y: g("temperature_2m", AROME), name: "T · AROME 1,3 km", mode: "lines", line: { color: th.tmax, width: 2.6, shape: "spline", smoothing: 0.6 }, yaxis: "y", hovertemplate: "%{y:.1f} °C" });
    T.push({ x, y: g("dew_point_2m", AROME).map((v, i) => v ?? g("dew_point_2m", IFS)[i]), name: "Punto de rocío", mode: "lines", line: { color: th.tmin, width: 1.2, dash: "dot" }, yaxis: "y", hovertemplate: "%{y:.1f} °C" });
    if (obs?.ta?.length) T.push({ x: obs.tx, y: obs.ta, name: "Observada", mode: obs.ta.length > 1 ? "lines+markers" : "markers", line: { color: th.fg, width: 2 }, marker: { size: obs.ta.length > 1 ? 3 : 9, color: th.fg, symbol: obs.ta.length > 1 ? "circle" : "diamond" }, yaxis: "y", hovertemplate: "%{y:.1f} °C obs." });

    T.push({ x, y: g("precipitation", AROME), name: "Lluvia AROME", type: "bar", marker: { color: th.prec }, yaxis: "y2", hovertemplate: "%{y:.1f} mm/h", width: 3600e3 * 0.8 });
    T.push({ x, y: g("precipitation", IFS), name: "Lluvia IFS", type: "bar", marker: { color: rgba(th.prec, 0.35), line: { color: th.prec, width: 0.5 } }, yaxis: "y2", hovertemplate: "%{y:.1f} mm/h", width: 3600e3 * 0.8 });
    if (obs?.p?.length) T.push({ x: obs.px, y: obs.p, name: "Lluvia obs.", type: "bar", marker: { color: th.fg }, yaxis: "y2", hovertemplate: "%{y:.1f} mm obs.", width: 3600e3 * 0.5 });
    T.push({ x, y: accI, name: "Acumulada IFS", mode: "lines", line: { color: th.prec, width: 1.4, dash: "dash" }, yaxis: "y3", hovertemplate: "Σ %{y:.1f} mm" });
    T.push({ x, y: accA, name: "Acumulada AROME", mode: "lines", line: { color: th.prec, width: 2.2 }, yaxis: "y3", hovertemplate: "Σ %{y:.1f} mm" });

    T.push({ x, y: g("wind_speed_10m", AROME).map((v, i) => v ?? g("wind_speed_10m", IFS)[i]), name: "Viento medio", mode: "lines", line: { color: th.tmin, width: 2 }, fill: "tozeroy", fillcolor: rgba(th.tmin, 0.08), yaxis: "y4", hovertemplate: "%{y:.0f} km/h" });
    T.push({ x, y: g("wind_gusts_10m", AROME), name: "Racha AROME", mode: "lines", line: { color: th.dtr, width: 2 }, yaxis: "y4", hovertemplate: "%{y:.0f} km/h" });
    T.push({ x, y: g("wind_gusts_10m", IFS), name: "Racha IFS", mode: "lines", line: { color: th.dtr, width: 1.2, dash: "dash" }, yaxis: "y4", hovertemplate: "%{y:.0f} km/h" });
    if (obs?.g?.length) T.push({ x: obs.gx, y: obs.g, name: "Racha obs.", mode: "markers", marker: { color: th.fg, size: obs.g.length > 1 ? 4 : 9, symbol: obs.g.length > 1 ? "circle" : "diamond" }, yaxis: "y4", hovertemplate: "%{y:.0f} km/h obs." });
    // flechas de dirección (hacia donde sopla) cada 3 h
    const ax = [], ay = [], aa = [], at = [];
    const gmax = Math.max(40, ...g("wind_gusts_10m", IFS).filter(v => v != null));
    x.forEach((t, i) => { if (i % 3 === 0 && dir[i] != null) { ax.push(t); ay.push(gmax * 1.12); aa.push((dir[i] + 180) % 360); at.push(dir[i]); } });
    T.push({ x: ax, y: ay, mode: "markers", name: "Dirección", showlegend: false, yaxis: "y4",
      marker: { symbol: "arrow-wide", angle: aa, size: 9, color: th.muted, line: { width: 0 } }, customdata: at, hovertemplate: "dir. %{customdata:.0f}°" });

    // nubosidad (baja, media, alta)
    const cl = ["cloud_cover_low", "cloud_cover_mid", "cloud_cover_high"].map(v => g(v, AROME).map((a, i) => a ?? g(v, IFS)[i]));
    T.push({ x, y: ["Bajas", "Medias", "Altas"], z: cl, type: "heatmap", yaxis: "y5", showscale: false, zmin: 0, zmax: 100, xgap: 0, ygap: 1,
      colorscale: th.dark ? [[0, "rgba(0,0,0,0)"], [1, "#d0d6de"]] : [[0, "rgba(255,255,255,0)"], [1, "#5b6472"]], name: "Nubes",
      hovertemplate: "%{y}: %{z:.0f} %<extra></extra>" });

    const shapes = nightShapes(d.daily || {}, th, x[0], x[x.length - 1]);
    shapes.push(nowShape(nowS, th));
    if (lastArome) shapes.push({ type: "line", xref: "x", yref: "paper", x0: lastArome, x1: lastArome, y0: 0.36, y1: 1, line: { color: th.muted, width: 1, dash: "dashdot" } });
    const k = (c, txt, dash) => `<span style="color:${c}">${dash ? "┅" : "━"} ${txt}</span>`;
    const title = (y, html) => ({ x: 0, xref: "paper", y, yref: "paper", xanchor: "left", yanchor: "bottom", showarrow: false, align: "left", text: html, font: { size: 10, color: th.muted } });
    const ann = [
      { x: nowS, y: 0.995, xref: "x", yref: "paper", text: "ahora", showarrow: false, yanchor: "top", xanchor: "left", font: { size: 9, color: th.accent } },
      title(1.0, `<b>°C</b>  ${k(th.tmax, "AROME 1,3 km")}  ${k(th.tmax, "IFS", 1)}  ${k(th.tmin, "rocío", 1)}${obs?.ta?.length ? `  ${k(th.fg, "observada")}` : ""}`),
      title(0.605, `<b>Lluvia</b>  <span style="color:${th.prec}">▮ AROME</span>  <span style="color:${rgba(th.prec, 0.5)}">▮ IFS</span>${obs?.p?.length ? `  <span style="color:${th.fg}">▮ obs.</span>` : ""}  ${k(th.prec, "Σ desde ahora")}`),
      title(0.335, `<b>Viento</b>  ${k(th.tmin, "medio")}  ${k(th.dtr, "racha AROME")}  ${k(th.dtr, "racha IFS", 1)}${obs?.g?.length ? `  <span style="color:${th.fg}">● obs.</span>` : ""}`),
      title(0.072, `<b>Nubes</b> bajas · medias · altas`),
    ];
    if (lastArome) ann.push({ x: lastArome, y: 0.98, xref: "x", yref: "paper", text: "fin AROME", showarrow: false, xanchor: "right", font: { size: 9, color: th.muted } });

    el.style.height = "660px";
    Plotly.react(el, T, baseLayout(th, {
      height: 660, bargap: 0, barmode: "overlay", shapes, annotations: ann, showlegend: false, margin: { l: 44, r: 40, t: 22, b: 30 },
      xaxis: xaxis(th, rangeFor(days, nowMs), { anchor: "y5" }),
      yaxis: yax(th, [0.66, 0.985], ""),
      yaxis2: yax(th, [0.38, 0.59], "mm/h", { rangemode: "tozero" }),
      yaxis3: { overlaying: "y2", side: "right", showgrid: false, rangemode: "tozero", fixedrange: true, tickfont: { color: th.prec, size: 10 }, title: { text: "Σ mm", font: { size: 10, color: th.prec } } },
      yaxis4: yax(th, [0.11, 0.32], "km/h", { rangemode: "tozero", range: [0, gmax * 1.22] }),
      yaxis5: { domain: [0, 0.065], fixedrange: true, tickfont: { color: th.muted, size: 9 }, showgrid: false },
    }), CONF);
  }

  /* ---------- conjunto ENS ---------- */
  function members(h, v) {
    return Object.keys(h).filter(k => k === v || k.startsWith(v + "_member")).map(k => h[k]);
  }

  function stats(ms, n) {
    const out = { p10: [], p25: [], p50: [], p75: [], p90: [] };
    for (let i = 0; i < n; i++) {
      const v = ms.map(m => m[i]).filter(x => x != null).sort((a, b) => a - b);
      out.p10.push(pct(v, 0.1)); out.p25.push(pct(v, 0.25)); out.p50.push(pct(v, 0.5)); out.p75.push(pct(v, 0.75)); out.p90.push(pct(v, 0.9));
    }
    return out;
  }

  function plume(T, x, ms, st, color, axis, unit, dec, th, label, ctrl) {
    const show = (y, name, extra) => T.push({ x, y, name, yaxis: axis, mode: "lines", ...extra });
    ms.forEach((m, k) => show(m, k ? "" : "Miembros", { line: { color: rgba(color, 0.16), width: 0.8 }, showlegend: k === 0 && axis === "y", legendgroup: "mem", hoverinfo: "skip" }));
    show(st.p90, "P10–P90", { line: { width: 0 }, hoverinfo: "skip", showlegend: false, legendgroup: "b1" });
    show(st.p10, "P10–P90", { line: { width: 0 }, fill: "tonexty", fillcolor: rgba(color, 0.16), showlegend: axis === "y", legendgroup: "b1", hoverinfo: "skip" });
    show(st.p75, "P25–P75", { line: { width: 0 }, hoverinfo: "skip", showlegend: false, legendgroup: "b2" });
    show(st.p25, "P25–P75", { line: { width: 0 }, fill: "tonexty", fillcolor: rgba(color, 0.3), showlegend: axis === "y", legendgroup: "b2", hoverinfo: "skip" });
    const lo = st.p10.map(v => v == null ? null : v.toFixed(dec)), hi = st.p90.map(v => v == null ? null : v.toFixed(dec));
    show(st.p50, `${label} · mediana`, { line: { color, width: 2.6 }, customdata: lo.map((v, i) => [v, hi[i]]),
      hovertemplate: `%{y:.${dec}f} ${unit} <span style="opacity:.7">(%{customdata[0]}–%{customdata[1]})</span>`, showlegend: false });
    if (ctrl) show(ctrl, "Control", { line: { color: th.fg, width: 1.2, dash: "dot" }, showlegend: axis === "y", legendgroup: "ctrl", hovertemplate: `ctrl %{y:.${dec}f} ${unit}` });
  }

  function drawEnsemble(el, tableEl, d, obs, days, daily) {
    const th = theme();
    const h = d.hourly, x = h.time, n = x.length;
    const nowMs = Date.now(), nowS = madrid(nowMs);
    const tM = members(h, "temperature_2m"), pM = members(h, "precipitation"), gM = members(h, "wind_gusts_10m");
    const pAcc = pM.map(m => { let s = 0; return m.map((v, i) => { if (x[i] <= nowS) return null; s += v || 0; return Math.round(s * 10) / 10; }); });
    const T = [];
    plume(T, x, tM, stats(tM, n), th.tmax, "y", "°C", 1, th, "Temperatura", h.temperature_2m);
    if (obs?.ta?.length) T.push({ x: obs.tx, y: obs.ta, name: "Observada", yaxis: "y", mode: obs.ta.length > 1 ? "lines" : "markers", line: { color: th.fg, width: 2 }, marker: { size: 9, symbol: "diamond", color: th.fg }, hovertemplate: "%{y:.1f} °C obs." });
    plume(T, x, pAcc, stats(pAcc, n), th.prec, "y2", "mm", 1, th, "Lluvia acumulada", pAcc[0]);
    plume(T, x, gM, stats(gM, n), th.dtr, "y3", "km/h", 0, th, "Racha", h.wind_gusts_10m);
    const shapes = nightShapes(daily || {}, th, x[0], x[n - 1]);
    shapes.push(nowShape(nowS, th));
    const label = (t, y) => ({ text: t, x: 0, xref: "paper", y, yref: "paper", xanchor: "left", yanchor: "bottom", showarrow: false, align: "left", font: { size: 10, color: th.muted } });
    const keys = c => `<span style="color:${c}">━ mediana</span>  <span style="color:${rgba(c, 0.6)}">▮ P25–P75</span>  <span style="color:${rgba(c, 0.35)}">▮ P10–P90</span>  <span style="color:${th.fg}">┅ control</span>`;
    el.style.height = "600px";
    Plotly.react(el, T, baseLayout(th, {
      height: 600, shapes, showlegend: false, margin: { l: 44, r: 16, t: 22, b: 30 },
      annotations: [label(`<b>Temperatura °C</b>  ${keys(th.tmax)}`, 0.985), label(`<b>Lluvia acumulada desde ahora, mm</b>  ${keys(th.prec)}`, 0.595), label(`<b>Racha km/h</b>  ${keys(th.dtr)}`, 0.265),
        { x: nowS, y: 0.98, xref: "x", yref: "paper", text: "ahora", showarrow: false, yanchor: "top", xanchor: "left", font: { size: 9, color: th.accent } }],
      xaxis: xaxis(th, rangeFor(days, nowMs), { anchor: "y3" }),
      yaxis: yax(th, [0.66, 0.97], ""),
      yaxis2: yax(th, [0.34, 0.58], "", { rangemode: "tozero" }),
      yaxis3: yax(th, [0, 0.25], "", { rangemode: "tozero" }),
    }), CONF);
    tableEl.innerHTML = probTable(x, tM, pM, gM, nowS);
  }

  /* tabla de probabilidades por día local */
  function probTable(x, tM, pM, gM, nowS) {
    const days = [...new Set(x.map(t => t.slice(0, 10)))].filter(d => d >= nowS.slice(0, 10)).slice(0, 15);
    const rows = [
      { label: "Lluvia ≥ 1 mm", f: (i0, i1, k) => sum(pM[k], i0, i1) >= 1, col: "#2b8a3e" },
      { label: "Lluvia ≥ 10 mm", f: (i0, i1, k) => sum(pM[k], i0, i1) >= 10, col: "#1971c2" },
      { label: "Lluvia ≥ 20 mm", f: (i0, i1, k) => sum(pM[k], i0, i1) >= 20, col: "#7048e8" },
      { label: "Helada (< 0 °C)", f: (i0, i1, k) => min(tM[k], i0, i1) < 0, col: "#4dabf7" },
      { label: "Racha ≥ 70 km/h", f: (i0, i1, k) => max(gM[k], i0, i1) >= 70, col: "#e8590c" },
    ];
    const idx = days.map(d => {
      let i0 = x.findIndex(t => t.startsWith(d)), i1 = x.length;
      for (let i = i0; i < x.length; i++) if (!x[i].startsWith(d)) { i1 = i; break; }
      if (d === nowS.slice(0, 10)) i0 = Math.max(i0, x.findIndex(t => t >= nowS));
      return [i0, i1];
    });
    const nm = tM.length;
    const head = days.map((d, j) => {
      const dt = new Date(d + "T12:00:00");
      return `<th title="${dt.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" })}">${j === 0 ? "Hoy" : dt.toLocaleDateString("es-ES", { weekday: "short" }).slice(0, 2)}<small>${dt.getDate()}</small></th>`;
    }).join("");
    const body = rows.map(r => `<tr><th>${r.label}</th>${idx.map(([i0, i1], j) => {
      let c = 0; for (let k = 0; k < nm; k++) if (r.f(i0, i1, k)) c++;
      const p = Math.round(100 * c / nm);
      const bg = p ? rgba(r.col, 0.12 + 0.85 * p / 100) : "transparent";
      const ink = p > 55 ? "#fff" : "var(--fg)";
      return `<td style="background:${bg};color:${p ? ink : "var(--muted)"}" title="${r.label} · ${days[j]}: ${c} de ${nm} miembros">${p ? p : "·"}</td>`;
    }).join("")}</tr>`).join("");
    return `<div class="prob-title">Probabilidad por día (% de los ${nm} miembros del ENS)</div>
      <div class="prob-wrap"><table class="prob"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }
  const sum = (a, i0, i1) => { let s = 0; for (let i = i0; i < i1; i++) s += a[i] || 0; return s; };
  const min = (a, i0, i1) => { let s = Infinity; for (let i = i0; i < i1; i++) if (a[i] != null && a[i] < s) s = a[i]; return s; };
  const max = (a, i0, i1) => { let s = -Infinity; for (let i = i0; i < i1; i++) if (a[i] != null && a[i] > s) s = a[i]; return s; };

  /* ---------- observaciones de la estación en hora local ---------- */
  function obsFrom(o10, id, st) {
    const d = o10?.data?.[id];
    if (d) {
      const t0 = Date.parse(o10.t0), h0 = Date.parse(o10.h0), step = o10.step * 1000;
      const tx = [], ta = [], gx = [], gg = [], px = [], p = [];
      (d.ta || []).forEach((v, k) => { if (v != null) { tx.push(madrid(t0 + k * step)); ta.push(v); } });
      (d.vmax || []).forEach((v, k) => { if (v != null) { gx.push(madrid(t0 + k * step)); gg.push(Math.round(v * 3.6)); } });
      (d.prec || []).forEach((v, k) => { if (v != null) { px.push(madrid(h0 + k * 3600e3 - 1800e3)); p.push(v); } });
      return { tx, ta, gx, g: gg, px, p };
    }
    if (st && st.st === "ok" && st.t) {
      const t = madrid(st.t * 1000);
      return { tx: st.ta != null ? [t] : [], ta: st.ta != null ? [st.ta] : [], gx: st.wg != null ? [t] : [], g: st.wg != null ? [st.wg] : [] };
    }
    return null;
  }

  /* fechas y números en español sin cargar otro script */
  function registerLocale() {
    if (!window.Plotly || registerLocale.done) return;
    registerLocale.done = true;
    Plotly.register({ moduleType: "locale", name: "es", dictionary: {}, format: {
      days: ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"],
      shortDays: ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"],
      months: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
      shortMonths: ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"],
      date: "%d/%m/%Y", decimal: ",", thousands: ".",
    } });
  }

  return { deterministic, ensemble, drawDeterministic, drawEnsemble, obsFrom, madrid, registerLocale };
})();
