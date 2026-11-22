/**
 * Cloudflare Worker «aragonwx-admin»: editor de la red de estaciones.
 *
 * La web (modo edición) habla con este Worker con una contraseña; el Worker guarda
 * el token de GitHub como secreto y es el único que escribe en el repositorio. Solo
 * puede tocar config/stations.csv.
 *
 * Rutas (todas exigen la cabecera X-Admin-Password):
 *   GET  /stations             contenido actual del CSV y su sha
 *   PUT  /stations             {content, sha, message} -> commit en main
 *   GET  /probe?src=WU&id=…    comprueba que la estación responde y trae lo que se pueda
 *                              (nombre, coordenadas, altitud, temperatura, último dato)
 *
 * Despliegue (panel de Cloudflare → Workers & Pages → Create → Worker «aragonwx-admin»):
 *   1. Pegar este fichero y desplegar.
 *   2. Settings → Variables and Secrets:
 *        ADMIN_PASSWORD  (secreto) la contraseña del editor
 *        GITHUB_TOKEN    (secreto) token «fine-grained» de GitHub con acceso solo al repo
 *                        AragonWX y permiso Contents: Read and write
 *        REPO            (texto, opcional) ccalvosa/AragonWX
 */

const FILE = "config/stations.csv";
const HEADER = "id,source,name,prov,lat,lon,alt,link,model,notes,q_tmax,q_tmin,q_prec,q_wind,tz_shift,kind,active";
const ORIGINS = ["https://ccalvosa.github.io", "https://estacioneszgz.meteozgz.eu", "http://localhost:8000", "http://localhost:8765"];
const WU_KEY = "ff90f212a6984a7390f212a698ea73cc";   // la pública de la web de WU (como en el descargador)

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Password",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    if (!env.ADMIN_PASSWORD || !env.GITHUB_TOKEN) return json({ error: "Worker sin configurar (ADMIN_PASSWORD / GITHUB_TOKEN)" }, 500);
    if (!(await same(request.headers.get("X-Admin-Password") || "", env.ADMIN_PASSWORD))) {
      await new Promise(r => setTimeout(r, 600));   // frena los intentos a ciegas
      return json({ error: "contraseña incorrecta" }, 401);
    }

    const url = new URL(request.url);
    const repo = env.REPO || "ccalvosa/AragonWX";
    try {
      if (url.pathname === "/stations" && request.method === "GET") {
        const f = await gh(env, `/repos/${repo}/contents/${FILE}?ref=main`);
        return json({ sha: f.sha, content: b64decode(f.content) });
      }
      if (url.pathname === "/stations" && request.method === "PUT") {
        const body = await request.json();
        const content = String(body.content || "");
        if (content.length > 2_000_000) return json({ error: "fichero demasiado grande" }, 400);
        if (content.split("\n", 1)[0].trim() !== HEADER) return json({ error: "la cabecera del CSV no es la esperada" }, 400);
        const cur = await gh(env, `/repos/${repo}/contents/${FILE}?ref=main`);
        const before = b64decode(cur.content).trim().split("\n").length, after = content.trim().split("\n").length;
        if (after < before - 5) return json({ error: `se borrarían ${before - after} filas; las bajas se hacen desactivando` }, 400);
        if (body.sha !== cur.sha) return json({ error: "el fichero ha cambiado mientras editabas; recarga y vuelve a aplicar", conflict: true }, 409);
        const msg = ("admin: " + String(body.message || "edición de la red").slice(0, 200)).replace(/\s+/g, " ");
        const res = await gh(env, `/repos/${repo}/contents/${FILE}`, {
          method: "PUT",
          body: JSON.stringify({ message: msg, content: b64encode(content), sha: cur.sha, branch: "main",
            committer: { name: "aragonwx-admin", email: "aragonwx-admin@users.noreply.github.com" } }),
        });
        return json({ ok: true, sha: res.content.sha, commit: res.commit.sha });
      }
      if (url.pathname === "/probe" && request.method === "GET") {
        return json(await probe(url.searchParams.get("src") || "", (url.searchParams.get("id") || "").trim()));
      }
      return json({ error: "ruta desconocida" }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 502);
    }
  },
};

/* ---------- GitHub */
async function gh(env, path, init = {}) {
  const r = await fetch("https://api.github.com" + path, {
    ...init,
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json",
      "User-Agent": "aragonwx-admin", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${j.message || ""}`);
  return j;
}
const b64decode = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, "")), c => c.charCodeAt(0)));
const b64encode = s => { const b = new TextEncoder().encode(s); let t = ""; for (let i = 0; i < b.length; i += 0x8000) t += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(t); };

async function same(a, b) {   // comparación en tiempo constante
  const h = async s => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [x, y] = await Promise.all([h(a), h(b)]);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

const unent = s => String(s || "").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;|&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();

/* ---------- comprobación de una estación en su red */
async function probe(src, id) {
  if (!id) return { ok: false, error: "falta el identificador" };
  const UA = { "User-Agent": "Mozilla/5.0 (AragonWX)" };
  if (src === "WU") {
    const r = await fetch(`https://api.weather.com/v2/pws/observations/current?stationId=${encodeURIComponent(id)}&format=json&units=m&numericPrecision=decimal&apiKey=${WU_KEY}`, { headers: UA });
    if (r.status === 204) return { ok: false, error: "la estación existe pero no transmite ahora" };
    if (!r.ok) return { ok: false, error: `Wunderground responde ${r.status}` };
    const o = (await r.json()).observations?.[0] || {};
    return { ok: true, name: o.neighborhood, lat: o.lat, lon: o.lon, alt: o.metric?.elev, ta: o.metric?.temp, t: o.epoch,
      link: `https://www.wunderground.com/dashboard/pws/${id}` };
  }
  if (src === "WC") {
    const r = await fetch(`https://app.weathercloud.net/device/stats?code=${encodeURIComponent(id)}`, { headers: { ...UA, "X-Requested-With": "XMLHttpRequest", Accept: "application/json" } });
    const d = r.ok ? await r.json().catch(() => null) : null;
    if (!d || !d.last_update) return { ok: false, error: "WeatherCloud no devuelve datos de esa estación" };
    const v = x => (Array.isArray(x) ? x[1] : x);
    return { ok: true, ta: v(d.temp_current), t: d.last_update, link: `https://app.weathercloud.net/d${id}#current`,
      note: "WeatherCloud no da coordenadas: sitúala en el mapa" };
  }
  if (src === "MC") {
    const reg = id.slice(0, 5);
    const [x, rss] = await Promise.all([fetch(`https://www.meteoclimatic.net/feed/xml/${reg}`, { headers: UA }), fetch(`https://www.meteoclimatic.net/feed/rss/${reg}`, { headers: UA })]);
    const xt = new TextDecoder("iso-8859-15").decode(await x.arrayBuffer()), rt = new TextDecoder("iso-8859-15").decode(await rss.arrayBuffer());
    const st = xt.split("<station>").find(b => b.includes(`<id>${id}</id>`));
    if (!st) return { ok: false, error: "no aparece en el feed de Meteoclimatic" };
    const item = rt.split("<item>").find(b => b.includes(id)) || "";
    const g = (s, re) => (s.match(re) || [])[1];
    return { ok: true, name: unent(g(st, /<location>([^<]*)/)), lat: +g(item, /<geo:lat>([^<]+)/) || null, lon: +g(item, /<geo:long>([^<]+)/) || null,
      ta: +g(st, /<temperature>[\s\S]*?<now>([^<]+)/), link: `https://www.meteoclimatic.net/perfil/${id}` };
  }
  if (src === "HOLFUY") {
    const d = await (await fetch("https://api.holfuy.com/stations/stations.json", { headers: UA })).json();
    const st = (d.holfuyStationsList || []).find(s => String(s.id) === id);
    if (!st) return { ok: false, error: "no aparece en la lista de Holfuy" };
    return { ok: true, name: st.name, lat: st.location?.latitude, lon: st.location?.longitude, alt: st.location?.altitude,
      link: `https://holfuy.com/es/weather/${id}` };
  }
  if (src === "AVAMET") {
    const r = await fetch(`https://www.avamet.org/mxo_i.php?id=${encodeURIComponent(id)}`, { headers: UA });
    return r.ok ? { ok: true, link: `https://www.avamet.org/mxo_i.php?id=${id}`, note: "AVAMET: completa nombre y coordenadas" }
                : { ok: false, error: `AVAMET responde ${r.status}` };
  }
  return { ok: true, note: "Esta red no se puede comprobar automáticamente: revisa el enlace y las coordenadas" };
}
