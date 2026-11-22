# Estaciones de Aragón

Mapa en directo de las estaciones meteorológicas de Aragón y de toda la red automática de
AEMET en España (cada 10 minutos),
SAIH Ebro, Weather Underground, WeatherCloud, Meteoclimatic, Ibericam, Holfuy y AVAMET,
más ríos, embalses, radar, satélite, rayos y webcams.

Es una web estática (GitHub Pages) sin servidor propio. Un workflow de GitHub Actions
descarga los datos cada 10 minutos y los publica en la rama `data`.

## Qué ofrece

- **Ahora**: temperatura actual, máxima y mínima del día; lluvia de hoy, de la última
  hora y de las últimas 24 h; racha máxima; humedad; caudal de los ríos con umbrales de
  aviso y reserva de los embalses (con tendencia).
- **Histórico**: cualquier período (máxima más alta, mínima más baja, medias, lluvia
  acumulada, días de lluvia, helada o calor, racha máxima) a partir del cierre diario.
- **Ficha de estación**: valores del día, calidad del dato, gráfica de las últimas 24 h
  cada 10 minutos (AEMET), de 72 h (ríos y embalses) o de los últimos días (resto).
- **Meteogramas** en cada estación y en cualquier punto del mapa (clic donde no haya
  estación). Los datos vienen de Open-Meteo y se piden desde el navegador:
  - Previsión: AROME France HD 1,3 km e IFS (temperatura, punto de rocío, lluvia,
    viento, racha, dirección y nubosidad), junto a lo observado por la estación.
  - Conjunto ENS: penachos de 51 miembros con percentiles y tabla de probabilidades por
    día (lluvia ≥ 1, 10 y 20 mm; helada; racha ≥ 70 km/h).
- **Animación** de las últimas 24 h de AEMET cada 10 minutos (estaciones de la zona visible).
- **Ranking** de las estaciones de la zona visible del mapa (Aragón, una comarca o toda España).
- **Capas**: interpolación por krigeado recortada a Aragón, radar (RainViewer),
  satélite MTG (infrarrojo, visible, GeoColor) y rayos MTG-LI de EUMETSAT, webcams
  (propias y de la DGT), red manual de AEMET y límites provinciales.
- Filtros por umbral, por red y por calidad; ranking; búsqueda (`/`); tema claro/oscuro;
  enlaces directos a una estación (`#ta/9434`).

## Cómo funciona

```
config/*.csv ──► scraper (GitHub Actions, cada 10 min) ──► rama data: now.json, obs10.json,
                                                                       hydro.json, webcams.json
                                       └── al cambiar de día ──► main: history/AAAA-MM.json
index.html + js/ ◄── lee los JSON de raw.githubusercontent.com
```

| Fuente | Cómo se descarga |
|---|---|
| AEMET | Solo la API OpenData, todas las estaciones de España: `diezminutal/todas` + `todas` (serie de 24 h cada 10 min, como en aemet-explorer). Máxima, mínima, racha y lluvia del día salen de esa serie |
| SAIH Ebro | API JSON de mapas (temperaturas, meteorología, embalses, aforos) y tabla de pluviometrías |
| Weather Underground | API de weather.com (actual en cada pasada, resumen diario cada 30 min) |
| WeatherCloud | `device/stats` (JSON) |
| Holfuy | JSON del widget |
| Meteoclimatic, Ibericam, AVAMET | HTML de la ficha de cada estación |
| DGT | DATEX II de cámaras |

No se usa Selenium: una pasada completa tarda unos 20 segundos.

**Reglas de calidad** (las mismas de antes):
- Sin datos en 6 h, la estación sale como *offline*.
- La temperatura actual se descarta si tiene más de 1 h (90 min en AEMET) o si queda
  fuera de la máxima y la mínima.
- Se descartan los valores imposibles.
- Las columnas `q_*` de `config/stations.csv` (*Contrastada* / *Deficiente*) se ponen a
  mano. Los datos deficientes se ocultan salvo que se active «Mostrar datos de calidad
  dudosa».

**Lluvia**:
- Las estaciones con `tz_shift=1` reinician el contador a otra hora. Para ellas, la lluvia
  del día se calcula sumando incrementos entre pasadas.
- La lluvia de 1 h y de 24 h sale de esos incrementos, salvo en AEMET, donde se usan sus
  datos de 10 minutos y horarios.
- Las fuentes sin máxima ni mínima propias (el SAIH) usan los extremos de nuestras lecturas.

## Estructura

- `index.html`, `css/style.css`, `js/app.js`, `js/scales.js` (escalas y variables),
  `js/kriging.js` (krigeado ordinario, solo con Aragón y su entorno): la web, con Leaflet (y Plotly bajo demanda).
- `config/stations.csv`: la red. Columnas `id, source, name, prov, lat, lon, alt, link,
  model, notes, q_tmax, q_tmin, q_prec, q_wind, tz_shift, kind, active`. Para añadir una
  estación basta con una fila nueva. Las automáticas de AEMET del resto de España no
  necesitan fila: entran solas desde la API. En las del SAIH con temperatura, `notes` lleva
  `tag=<señal>`.
- `config/reservoirs.csv`, `config/gauges.csv` (umbrales de aviso), `config/webcams.csv`.
- `scraper/aragonwx/`: `build.py` (orquestador) y `sources/` (una fuente por fichero).
- `history/AAAA-MM.json`: cierre diario (máxima `x`, mínima `n`, lluvia `p`, racha `w`).
- `scripts/migrate_old.py`: migración única desde el script anterior (`0124_v2.py`).
- `.github/workflows/data.yml`: bucle de descarga y publicación.

## Puesta en marcha

1. **Secrets** (Settings → Secrets and variables → Actions): `AEMET_API_KEY`.
   Opcional: `WU_API_KEY`.
2. **Actions** (Settings → Actions → General → Workflow permissions): *Read and write*.
3. **Pages** (Settings → Pages): *Deploy from a branch* → `main` / `/ (root)`.
4. Lanzar el workflow una vez a mano (Actions → update-data → Run workflow). A partir
   de ahí se relanza solo.
5. **Dominio propio** (opcional): en Settings → Pages → Custom domain, poner
   `estacioneszgz.meteozgz.eu`. En el DNS de meteozgz.eu, crear un `CNAME` de
   `estacioneszgz` a `ccalvosa.github.io`.

## SAIH desde GitHub Actions

saihebro.com no acepta conexiones desde GitHub Actions. El workflow lo intenta
directamente y, si no responde en 6 s, prueba estas alternativas por orden.

**1. Worker de Cloudflare** (`cloudflare/saih-proxy.js`):

1. En el panel de Cloudflare: Workers & Pages → Create → Worker. Pegar el fichero y
   desplegar.
2. En el Worker: Settings → Variables and Secrets → secreto `PROXY_TOKEN` (una cadena
   larga aleatoria).
3. Comprobar que responde:
   `curl -H "X-Proxy-Token: <token>" https://<worker>.workers.dev/api/pluviometrias/getTablaPluviometrias`
4. En GitHub, crear los repository secrets `SAIH_PROXY_URL` (`https://<worker>.workers.dev`)
   y `SAIH_PROXY_TOKEN`. Relanzar el workflow.

**2. Relé** (si el SAIH también bloquea a Cloudflare): datos crudos de la rama `saih`. Esa rama la publica
`aragonwx.saih_relay`, que corre en cualquier máquina que llegue al SAIH y pueda
hacer push al repo:

```bash
git clone git@github.com:ccalvosa/AragonWX.git && cd AragonWX/scraper
pip install -r requirements.txt
# crontab -e
*/10 * * * * cd /ruta/AragonWX/scraper && python3 -m aragonwx.saih_relay --push >> /tmp/saih_relay.log 2>&1
```

Si el relé lleva más de 40 min sin publicar, el SAIH se queda sin datos. Los embalses
y aforos conservan entonces su último valor, marcado como antiguo.

## Desarrollo local

```bash
pip install -r scraper/requirements.txt
export AEMET_API_KEY="..."
(cd scraper && python -m aragonwx.build --out ../out --history-dir ../history)
python -m http.server 8000      # → http://localhost:8000 (lee out/ y history/)
```

`--only AEMET,SAIH` limita la pasada a esas fuentes (útil para probar).
