# Estaciones de Aragón

Mapa en directo de las estaciones meteorológicas de Aragón: AEMET (cada 10 minutos),
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
- **Animación** de las últimas 24 h de AEMET cada 10 minutos.
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
| AEMET | OpenData `diezminutal/todas` + `todas` (24 h cada 10 min, como en aemet-explorer) y paquete *udat* de aemet.es (máx/mín/racha/lluvia oficiales del día) |
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
  `js/kriging.js` (krigeado ordinario): la web, con Leaflet (y Plotly bajo demanda).
- `config/stations.csv`: la red. Columnas `id, source, name, prov, lat, lon, alt, link,
  model, notes, q_tmax, q_tmin, q_prec, q_wind, tz_shift, kind, active`. Para añadir una
  estación basta con una fila nueva. En las del SAIH con temperatura, `notes` lleva
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

## Desarrollo local

```bash
pip install -r scraper/requirements.txt
export AEMET_API_KEY="..."
(cd scraper && python -m aragonwx.build --out ../out --history-dir ../history)
python -m http.server 8000      # → http://localhost:8000 (lee out/ y history/)
```

`--only AEMET,SAIH` limita la pasada a esas fuentes (útil para probar).
