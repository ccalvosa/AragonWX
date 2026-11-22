/**
 * Cloudflare Worker: proxy mínimo hacia la API pública del SAIH Ebro.
 *
 * saihebro.com no acepta conexiones desde GitHub Actions; este Worker hace la
 * petición desde la red de Cloudflare. Solo reenvía las dos rutas que usa
 * AragonWX y exige un token, para que no sirva como proxy abierto.
 *
 * Despliegue (panel de Cloudflare → Workers & Pages → Create → Worker):
 *   1. Pegar este fichero y desplegar.
 *   2. Settings → Variables and Secrets → añadir el secreto PROXY_TOKEN (una cadena larga aleatoria).
 *   3. Probar:  curl -H "X-Proxy-Token: <token>" "https://<worker>.workers.dev/api/pluviometrias/getTablaPluviometrias"
 */

const UPSTREAM = "https://www.saihebro.com";
const ALLOWED = ["/api/mapa/getDatosMapa", "/api/pluviometrias/getTablaPluviometrias"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
    if (!env.PROXY_TOKEN || request.headers.get("X-Proxy-Token") !== env.PROXY_TOKEN) {
      return new Response("forbidden", { status: 403 });
    }
    if (!ALLOWED.includes(url.pathname)) return new Response("not found", { status: 404 });

    let upstream;
    try {
      upstream = await fetch(UPSTREAM + url.pathname + url.search, {
        headers: { "User-Agent": "AragonWX (+https://github.com/ccalvosa/AragonWX)", Accept: "application/json" },
        cf: { cacheTtl: 60, cacheEverything: true },
      });
    } catch (e) {
      return new Response("upstream error: " + e, { status: 502, headers: { "X-Colo": String(request.cf?.colo || "?") } });
    }
    const headers = new Headers({
      "Content-Type": upstream.headers.get("Content-Type") || "application/json",
      "X-Upstream-Status": String(upstream.status),
      "X-Colo": String(request.cf?.colo || "?"),   // centro de Cloudflare que ha hecho la petición
    });
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
