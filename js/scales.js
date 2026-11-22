/* ==========================================================
   Escalas de color y definición de variables.
   Las escalas son las de la web anterior (umbral inferior de cada color,
   de mayor a menor), para que el mapa se siga leyendo igual.
   ========================================================== */

const SCALES = {
  temp: { below: "#96308C", stops: [
    [44, "#8A360F"], [42, "#A1362E"], [40, "#B2334F"], [38, "#D13370"], [36, "#E83391"], [34, "#FF33B2"],
    [32, "#FF0000"], [30, "#FF8000"], [28, "#FF9E00"], [26, "#FFBF00"], [24, "#FFDE00"], [22, "#FFFF00"],
    [20, "#CCFF00"], [18, "#66FF66"], [16, "#21B2AB"], [14, "#14C4BF"], [12, "#0AD9D6"], [10, "#40E0D0"],
    [8, "#1F8FFF"], [6, "#1C70DB"], [4, "#1C54B8"], [2, "#1A3694"], [0, "#1A1A70"], [-2, "#FFFFFF"],
    [-4, "#E0C9F7"], [-6, "#C494F0"], [-8, "#A661E8"], [-10, "#8A2BE3"], [-15, "#D1218F"], [-20, "#B5298C"],
    [-25, "#96308C"]] },
  prec: { below: "#9aa3ad", zero: true, stops: [
    [250, "#DB8D8C"], [120, "#CC5453"], [100, "#FF0000"], [80, "#FF7A08"], [60, "#FFBA0F"], [40, "#FFFF00"],
    [30, "#BFE600"], [20, "#80CC00"], [10, "#009900"], [5, "#00B240"], [2, "#00CC80"], [1, "#33F5DE"],
    [0.5, "#B0E0E6"], [0.1, "#d4eef2"]] },
  prec1h: { below: "#9aa3ad", zero: true, stops: [
    [90, "#FF00FF"], [60, "#800080"], [30, "#FF0000"], [15, "#FFA500"], [7.5, "#FFFF00"], [2, "#008000"],
    [0.5, "#0000FF"], [0.1, "#ADD8E6"]] },
  precYear: { below: "#9aa3ad", stops: [
    [2000, "#DB8D8C"], [1800, "#CC5453"], [1600, "#FF0000"], [1400, "#FF7A08"], [1200, "#FFBA0F"],
    [1000, "#FFFF00"], [900, "#BFE600"], [800, "#80CC00"], [700, "#009900"], [600, "#00B240"],
    [500, "#00CC80"], [400, "#33F5DE"], [300, "#B0E0E6"], [200, "#5f8f99"]] },
  precMonth: { below: "#9aa3ad", zero: true, stops: [
    [400, "#DB8D8C"], [300, "#CC5453"], [250, "#FF0000"], [200, "#FF7A08"], [150, "#FFBA0F"], [120, "#FFFF00"],
    [100, "#BFE600"], [80, "#80CC00"], [60, "#009900"], [40, "#00B240"], [25, "#00CC80"], [10, "#33F5DE"],
    [5, "#B0E0E6"], [0.1, "#d4eef2"]] },
  wind: { below: "#D9F8F8", stops: [
    [140, "#BE003D"], [130, "#AB1A85"], [120, "#9933CC"], [110, "#9966FF"], [100, "#FF78D4"], [90, "#FF5959"],
    [80, "#FF691F"], [70, "#FF8A17"], [60, "#FFC90A"], [50, "#D9F200"], [40, "#A8F500"], [30, "#4FFAB8"],
    [20, "#66F7ED"], [10, "#B0FAF7"]] },
  hum: { below: "#8c510a", stops: [
    [95, "#08306b"], [90, "#08519c"], [80, "#2171b5"], [70, "#4292c6"], [60, "#6baed6"], [50, "#9ecae1"],
    [40, "#c6dbef"], [30, "#f6e8c3"], [20, "#dfc27d"], [10, "#bf812d"]] },
  days: { below: "#d9dde2", zero: true, stops: [
    [60, "#67000d"], [40, "#a50f15"], [30, "#cb181d"], [20, "#ef3b2c"], [15, "#fb6a4a"], [10, "#fc9272"],
    [5, "#fcbba1"], [1, "#fee0d2"]] },
  daysCold: { below: "#d9dde2", zero: true, stops: [
    [60, "#3f007d"], [40, "#54278f"], [30, "#6a51a3"], [20, "#807dba"], [15, "#9e9ac8"], [10, "#bcbddc"],
    [5, "#dadaeb"], [1, "#efedf5"]] },
  daysWet: { below: "#d9dde2", zero: true, stops: [
    [60, "#00441b"], [40, "#006d2c"], [30, "#238b45"], [20, "#41ab5d"], [15, "#74c476"], [10, "#a1d99b"],
    [5, "#c7e9c0"], [1, "#e5f5e0"]] },
};

function colorFor(scale, v) {
  const s = SCALES[scale];
  if (v == null || Number.isNaN(v)) return "#8a8f98";
  if (s.zero && v <= 0) return s.below;
  for (const [th, c] of s.stops) if (v > th || (th === s.stops[s.stops.length - 1][0] && v >= th)) return c;
  return s.below;
}

/* Texto legible sobre un fondo de color */
function inkFor(hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? "#111" : "#fff";
}

/* ----- variables del modo «Ahora» -----
   q: posición de la bandera de calidad (0 máx, 1 mín, 2 lluvia, 3 viento) */
const VARS = {
  ta:   { group: "Temperatura", short: "Actual", label: "Temperatura actual", unit: "°C", scale: "temp", q: 0, dec: 1, filter: "temp" },
  tx:   { group: "Temperatura", short: "Máxima", label: "Máxima de hoy", unit: "°C", scale: "temp", q: 0, dec: 1, filter: "temp" },
  tn:   { group: "Temperatura", short: "Mínima", label: "Mínima de hoy", unit: "°C", scale: "temp", q: 1, dec: 1, filter: "temp" },
  pr:   { group: "Precipitación", short: "Hoy", label: "Lluvia de hoy", unit: "mm", scale: "prec", q: 2, dec: 1, filter: "prec" },
  p1:   { group: "Precipitación", short: "1 h", label: "Lluvia en la última hora", unit: "mm", scale: "prec1h", q: 2, dec: 1, filter: "prec" },
  p24:  { group: "Precipitación", short: "24 h", label: "Lluvia en las últimas 24 h", unit: "mm", scale: "prec", q: 2, dec: 1, filter: "prec" },
  gust: { group: "Viento y humedad", short: "Racha", label: "Racha máxima de hoy", unit: "km/h", scale: "wind", q: 3, dec: 0, filter: "wind" },
  hr:   { group: "Viento y humedad", short: "Humedad", label: "Humedad relativa", unit: "%", scale: "hum", dec: 0, filter: "hum" },
  q:    { group: "Agua", short: "Ríos", label: "Caudal de los ríos", unit: "m³/s", hydro: "gauges", dec: 1 },
  pct:  { group: "Agua", short: "Embalses", label: "Reserva de los embalses", unit: "%", hydro: "reservoirs", dec: 0 },
};

/* ----- variables del modo «Histórico» (clave = campo_agregado) ----- */
const HVARS = {
  x_max:  { f: "x", agg: "max",  label: "Máxima más alta", unit: "°C", scale: "temp", q: 0, dec: 1 },
  x_mean: { f: "x", agg: "mean", label: "Media de las máximas", unit: "°C", scale: "temp", q: 0, dec: 1 },
  n_min:  { f: "n", agg: "min",  label: "Mínima más baja", unit: "°C", scale: "temp", q: 1, dec: 1 },
  n_mean: { f: "n", agg: "mean", label: "Media de las mínimas", unit: "°C", scale: "temp", q: 1, dec: 1 },
  m_mean: { f: "m", agg: "mean", label: "Temperatura media", unit: "°C", scale: "temp", q: 0, dec: 1 },
  p_sum:  { f: "p", agg: "sum",  label: "Lluvia acumulada", unit: "mm", scale: "prec", q: 2, dec: 1 },
  p_max:  { f: "p", agg: "max",  label: "Lluvia máxima en un día", unit: "mm", scale: "prec", q: 2, dec: 1 },
  p_days: { f: "p", agg: "count", th: 1, label: "Días de lluvia (≥ 1 mm)", unit: "días", scale: "daysWet", q: 2, dec: 0 },
  n_frost:{ f: "n", agg: "below", th: 0, label: "Días de helada", unit: "días", scale: "daysCold", q: 1, dec: 0 },
  x_hot:  { f: "x", agg: "count", th: 35, label: "Días de calor (≥ 35 °C)", unit: "días", scale: "days", q: 0, dec: 0 },
  w_max:  { f: "w", agg: "max",  label: "Racha máxima", unit: "km/h", scale: "wind", q: 3, dec: 0 },
};

const FILTERS = {
  temp: [["all", "Todas"], ["lte_-10", "≤ −10 °C"], ["lte_-5", "≤ −5 °C"], ["lte_0", "≤ 0 °C"], ["gte_20", "≥ 20 °C"],
         ["gte_30", "≥ 30 °C"], ["gte_35", "≥ 35 °C"], ["gte_38", "≥ 38 °C"], ["gte_40", "≥ 40 °C"], ["gte_42", "≥ 42 °C"]],
  prec: [["all", "Todas"], ["gt_0", "> 0 mm"], ["gte_1", "≥ 1 mm"], ["gte_5", "≥ 5 mm"], ["gte_10", "≥ 10 mm"],
         ["gte_20", "≥ 20 mm"], ["gte_40", "≥ 40 mm"], ["gte_60", "≥ 60 mm"], ["gte_100", "≥ 100 mm"]],
  wind: [["all", "Todas"], ["gte_50", "≥ 50 km/h"], ["gte_70", "≥ 70 km/h"], ["gte_90", "≥ 90 km/h"], ["gte_110", "≥ 110 km/h"]],
  hum:  [["all", "Todas"], ["lte_20", "≤ 20 %"], ["lte_30", "≤ 30 %"], ["gte_90", "≥ 90 %"]],
  days: [["all", "Todas"], ["gte_1", "≥ 1 día"], ["gte_5", "≥ 5 días"], ["gte_10", "≥ 10 días"], ["gte_20", "≥ 20 días"]],
};

const SOURCES = {
  AEMET:    { name: "AEMET", official: true, color: "#e8590c" },
  SAIH:     { name: "SAIH Ebro", official: true, color: "#1c7ed6" },
  WU:       { name: "Weather Underground", color: "#868e96" },
  WC:       { name: "WeatherCloud", color: "#4dabf7" },
  MC:       { name: "Meteoclimatic", color: "#2b8a3e" },
  IBERICAM: { name: "Ibericam", color: "#9c36b5" },
  HOLFUY:   { name: "Holfuy", color: "#e64980" },
  AVAMET:   { name: "AVAMET", color: "#f08c00" },
  ECOWITT:  { name: "Ecowitt", color: "#495057" },
  SIAR:     { name: "SIAR", color: "#495057" },
  ARANTEC:  { name: "Arantec", color: "#495057" },
};

const ZONES = {
  "Aragón": [[39.8, -2.2], [43.1, 0.8]],
  "Pirineo": [[42.25, -1.1], [42.95, 0.8]],
  "Huesca": [[42.098, -0.4985], [42.175, -0.3562]],
  "Zaragoza": [[41.5708, -1.1385], [41.7777, -0.667]],
  "Teruel": [[40.2852, -1.215], [40.4285, -1.045]],
  "Calatayud": [[41.312, -1.692], [41.3985, -1.575]],
  "Utebo": [[41.699, -1.028], [41.7325, -0.974]],
  "Monzón": [[41.872, 0.135], [41.955, 0.255]],
  "Barbastro": [[42.014, 0.0891], [42.0583, 0.1605]],
  "Ejea de los Caballeros": [[41.995, -1.365], [42.275, -1.055]],
  "Alcañiz": [[40.9755, -0.3763], [41.192, 0.0369]],
  "Fraga": [[41.445, 0.245], [41.615, 0.455]],
  "Valle del Ebro": [[41.2, -1.9], [41.9, 0.3]],
  "Sistema Ibérico": [[40.0, -2.0], [41.4, -0.3]],
};
