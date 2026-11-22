/* ==========================================================
   Histórico diario de AEMET leído de aemet-explorer (no se duplica aquí).
     data/index.json              estaciones (se usan las de Aragón)
     data/stations/{id}.json      serie completa de cada estación
     data/recent.json             últimos ~120 días de todas
     obs/daily.json (rama obs)    diarios provisionales de los últimos días
   Para un período se usa lo más reciente disponible: provisional < recent < serie.
   Las series completas solo se descargan si el período es anterior a recent.json.
   ========================================================== */

const AemetHist = (() => {
  const BASE = "https://ccalvosa.github.io/aemet-explorer/data/";
  const DAILY = "https://raw.githubusercontent.com/ccalvosa/aemet-explorer/obs/daily.json";
  const PROV = new Set(["HUESCA", "ZARAGOZA", "TERUEL"]);
  let idx = null, recent = null, daily = null, recentTs = 0;
  const files = new Map();

  const index = () => (idx ||= getJSON(BASE + "index.json", { cache: "default" })
    .then(d => d.stations.filter(s => PROV.has(String(s.province).toUpperCase()))).catch(() => []));
  function loadRecent() {
    if (!recent || Date.now() - recentTs > 3600e3) {
      recentTs = Date.now();
      recent = getJSON(BASE + "recent.json" + bust(), { cache: "default" }).catch(() => null);
      daily = getJSON(DAILY + bust()).catch(() => null);
    }
    return Promise.all([recent, daily]);
  }
  const station = id => {
    if (!files.has(id)) files.set(id, getJSON(BASE + `stations/${id}.json`, { cache: "default" }).catch(() => null));
    return files.get(id);
  };
  const off = (start, d) => Math.round((Date.parse(d + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / 864e5);
  const kmh = v => (v == null ? null : Math.round(v * 3.6));

  /** days: ["AAAA-MM-DD", …] → Map(id → {x, n, p, w}) alineados con days */
  async function range(days, onProgress) {
    const [st, [rec, dl]] = await Promise.all([index(), loadRecent()]);
    const needSeries = !rec || days[0] < rec.start;
    const out = new Map();
    let done = 0;
    await Promise.all(st.map(async s => {
      const f = needSeries ? await station(s.id) : null;
      onProgress?.(++done, st.length, needSeries);
      const r = rec?.stations?.[s.id], dd = dl?.st?.[s.id];
      const o = { x: [], n: [], p: [], w: [] };
      let any = false;
      days.forEach((d, k) => {
        let x = null, n = null, p = null, w = null;
        if (f && f.data && d >= f.start && d <= f.end) {
          const i = off(f.start, d);
          x = f.data.tmax?.[i] ?? null; n = f.data.tmin?.[i] ?? null; p = f.data.prec?.[i] ?? null; w = kmh(f.data.racha?.[i]);
        }
        if (r && d >= rec.start && d <= rec.end) {
          const i = off(rec.start, d);
          x = r.tmax?.[i] ?? x; n = r.tmin?.[i] ?? n; p = r.prec?.[i] ?? p; w = kmh(r.racha?.[i]) ?? w;
        }
        if (dd && dl.days) {   // provisionales: solo rellenan huecos
          const i = dl.days.indexOf(d);
          if (i >= 0) { x ??= dd.tx?.[i] ?? null; n ??= dd.tn?.[i] ?? null; p ??= dd.p?.[i] ?? null; }
        }
        o.x[k] = x; o.n[k] = n; o.p[k] = p; o.w[k] = w;
        if (x != null || n != null || p != null) any = true;
      });
      if (any) out.set(s.id, o);
    }));
    return out;
  }

  /** récords diarios de una estación con su serie completa (o null si no está en aemet-explorer) */
  async function records(id) {
    const f = await station(id);
    if (!f || !f.data) return null;
    const day = i => new Date(Date.parse(f.start + "T12:00:00Z") + i * 864e5).toISOString().slice(0, 10);
    const d = f.data, len = (d.tmax || d.prec || []).length;
    const dates = Array.from({ length: len }, (_, i) => day(i));
    const today = new Date().toISOString().slice(0, 10);
    // absolutos, del mes en curso y de este día del calendario
    const scopes = { abs: () => true, mon: s => s.slice(5, 7) === today.slice(5, 7), day: s => s.slice(5, 10) === today.slice(5, 10) };
    const out = {};
    for (const [sc, keep] of Object.entries(scopes)) {
      const best = (arr, hi, mult = 1) => {
        let bi = -1;
        (arr || []).forEach((v, i) => { if (v != null && keep(dates[i]) && (bi < 0 || (hi ? v > arr[bi] : v < arr[bi]))) bi = i; });
        return bi < 0 ? null : [Math.round(arr[bi] * mult * 10) / 10, dates[bi]];
      };
      let n = 0, first = null;
      dates.forEach((s, i) => { if (keep(s) && ((d.tmax || [])[i] != null || (d.prec || [])[i] != null)) { n++; first ??= s; } });
      if (!n) continue;
      out[sc] = { x_hi: best(d.tmax, true), x_lo: best(d.tmax, false), n_hi: best(d.tmin, true), n_lo: best(d.tmin, false),
                  p_hi: best(d.prec, true), w_hi: best(d.racha, true, 3.6), from: first, n };
    }
    out.official = true;
    return out;
  }

  return { range, index, records };
})();
