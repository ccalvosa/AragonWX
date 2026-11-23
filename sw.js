/* Service worker de Estaciones de Aragón.
   - Código de la web (mismo origen): primero la red, y la copia guardada solo sin conexión,
     así nunca se queda una versión vieja tras publicar cambios.
   - Librerías de CDN con versión fija y tipografías: primero la copia guardada.
   - Datos (rama data, APIs, teselas): siempre de la red, no se guardan. */

const CACHE = "aragonwx-v4";
const SHELL = ["./", "index.html", "estado.html", "acerca.html", "manifest.webmanifest", "css/style.css", "js/scales.js", "js/kriging.js",
  "js/forecast.js", "js/app.js", "js/arome.js", "js/radar.js", "js/aemethist.js", "js/avisos.js", "js/summary.js", "js/editor.js",
  "assets/provincias.geojson", "assets/icons/icon-192.png"];
const CDN = ["unpkg.com", "cdn.plot.ly", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin && !url.pathname.includes("/out/") && !url.pathname.includes("/history/")) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match("index.html"))));
    return;
  }
  if (CDN.includes(url.hostname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    })));
  }
  // el resto (datos, APIs, teselas) sigue su camino normal
});
