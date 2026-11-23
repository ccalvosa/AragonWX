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
  - Cómo ha acertado aquí: en cada estación, sesgo y error de la máxima y la mínima de
    AROME e IFS en los últimos 14 días (previsión emitida el día anterior, de la API de
    pasadas anteriores de Open-Meteo) y días de lluvia acertados.
- **AROME 1,3 km sobre el mapa**: lluvia en 1 h, lluvia acumulada, nieve acumulada
  (cm, 10:1), racha y temperatura
  hora a hora hasta H+51, con animación y el valor de AROME bajo el ratón. Datos
  abiertos de Météo-France (Licence Ouverte 2.0) procesados en Actions y publicados
  en la rama `arome`.
- **Avisos de AEMET** (Meteoalerta, toda España, cada 30 min): zonas coloreadas por nivel
  (continuas si el aviso está en vigor, discontinuas si es para más tarde), un botón con
  las zonas en aviso en Aragón y el detalle de cada aviso.
- **Resumen del día** en Aragón: extremos (máxima, mínima, lluvia, racha y temperatura
  ahora), ríos en aviso, reserva de los embalses y avisos. Excluye estaciones dudosas u
  ocultas. Se puede filtrar a solo AEMET y SAIH y descargar como imagen (1080×1350) para
  redes sociales.
- **Anomalías** («Anomalía máx.» y «Anomalía mín.»): máxima y mínima de hoy de AEMET
  respecto a su normal diaria (`assets/normals.json`, de `scripts/make_normals.py`:
  media más tres armónicos anuales sobre 1991–2020 si hay ≥ 20 años; si no, todos los
  años disponibles, mínimo 10). La ficha muestra la normal de hoy y la diferencia.
- **Récords de cada estación** en su ficha: máxima y mínima más altas y más bajas, lluvia
  en un día y racha, con su fecha. Para AEMET, de su serie oficial completa
  (aemet-explorer); para el resto, de `history/` filtrado de errores (`records.py`).
  «¡Récord hoy!» si el valor del día ya lo supera.
- **App instalable** (PWA: `manifest.webmanifest`, `sw.js`): en el móvil, «Añadir a
  pantalla de inicio». El código se pide siempre a la red primero (sin versiones viejas)
  y la web abre sin conexión; los datos nunca se guardan.
- **Animación** de las últimas 24 h de AEMET cada 10 minutos (estaciones de la zona visible).
- **Ranking** de las estaciones de la zona visible del mapa (Aragón, una comarca o toda España).
- **Capas**: interpolación por krigeado recortada a Aragón, radar de Zaragoza,
  satélite MTG (infrarrojo, visible, GeoColor) y rayos MTG-LI de EUMETSAT, webcams
  (propias y de la DGT), red manual de AEMET y límites provinciales.
- **Radar de Zaragoza** (AEMET, Perdiguera) desde EUMETNET OPERA (CC BY 4.0):
  reflectividad de alta resolución (exploración Doppler, 500 m hasta 150 km), de
  baja resolución (largo alcance, 1 km hasta 250 km) y velocidad radial, de la
  elevación más baja; cada producto, una imagen cada 10 min; se guardan 24 h y en la web
  se elige animar las últimas 1, 3, 6, 12 o 24 h. `scraper/aragonwx/radar.py` y el flujo `update-radar`
  (bucle de 1 min) la publican en la rama `radar`; la web pinta cada píxel con su
  celda del radar, sin estirar ni suavizar.
  **Lluvia estimada** de 1, 3, 6, 12 y 24 h con la exploración de largo alcance (24 h guardadas
  en `arch/`): Marshall-Palmer (Z = 200·R^1,6, de 7 a 55 dBZ), sin las celdas de ecos
  fijos (mapa de frecuencia de eco con memoria de ~2 días, `clutter.png`) y corregida
  con un único factor frente a los pluviómetros de AEMET (lluvia de 24 h de `now.json`).
  **Descargar GIF** graba en el navegador la animación de la vista actual (mapa base,
  límites, radar, hora y leyenda) con [gifenc](https://github.com/mattdesl/gifenc).
  Con ventanas largas se queda en 48 imágenes como mucho (una de cada 2, 3…).
- **Krigeado** a resolución de pantalla en cada zoom. En temperatura (actual, máxima
  y mínima) tiene en cuenta la altitud: se ajusta a las estaciones una recta con la
  altitud, o dos tramos si hay inversión (la leyenda muestra el gradiente), se krigean
  los residuos y en cada píxel se suma la tendencia con la altitud del terreno. El
  modelo del terreno (`assets/dem.png`, ~250 m) sale de AWS Terrain Tiles (EU-DEM de
  Copernicus y SRTM) con `scripts/make_dem.py`, una sola vez.
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
4. Lanzar los workflows una vez a mano (Actions → update-data, update-arome y
   discover-stations → Run workflow). Los dos primeros se relanzan solos; el de
   sugerencias corre cada día.
5. **Dominio propio** (opcional): en Settings → Pages → Custom domain, poner
   `estacioneszgz.meteozgz.eu`. En el DNS de meteozgz.eu, crear un `CNAME` de
   `estacioneszgz` a `ccalvosa.github.io`.

## AROME 1,3 km (`scraper/aragonwx/arome.py`)

Los paquetes horarios de Météo-France (`SP1`, `SP2`) cubren toda Francia a 0,01°. No se
descargan enteros: se leen las cabeceras de cada mensaje GRIB con peticiones de 160 bytes
y luego solo se bajan la temperatura, la racha y las tres precipitaciones acumuladas
(unos 16 MB por hora). Se recortan a España dentro del dominio de AROME (37,5–45°N, 10,5°O–5°E: todo salvo el
extremo sur peninsular y Canarias) y se guardan en su rejilla nativa de 0,01°, sin
reproyectar ni interpolar, como PNG de 8 bits con el valor codificado. La web pinta cada
píxel de la pantalla con el valor de la celda nativa que lo contiene, así que al acercar se
ve la resolución real del modelo, con las mismas escalas que las estaciones.

Una pasada se publica cuando tiene las 52 horas o, si se queda atascada o es más corta,
cuando llega al menos a H+23 y lleva una hora sin ficheros nuevos.

Va en su propio workflow, `.github/workflows/arome.yml` (**update-arome**), separado de
las estaciones: un bucle que cada 10 min mira si hay una pasada nueva completa (cada 3 h,
H+00 a H+51), la procesa (unos 3 min, con un máximo de 8 por vuelta) y la publica en la
rama `arome` (~30 MB). Dependencias en `scraper/requirements-arome.txt`.

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

## Editor de la red (altas, bajas y calidad desde la web)

En el pie del panel de control, **Editar la red** pide una contraseña y activa el editor:

- **Ficha de cada estación:** nombre, calidad por variable (*Contrastada* / *Deficiente*),
  problema de hora, modelo, notas, posición y **dar de baja** o reactivar. Las bajas
  desactivan la estación (`active=0`), no la borran, así que su histórico se conserva.
- **Alta:** red e identificador. «Comprobar en la red» verifica que la estación responde y
  rellena nombre, coordenadas, altitud y enlace (WU, Meteoclimatic, Holfuy; en WeatherCloud
  hay que situarla en el mapa). También se puede hacer clic en el mapa → «Añadir una
  estación aquí».
- **Sugerencias:** las estaciones nuevas que encuentra cada día `discover-stations`
  (`scraper/aragonwx/discover.py`) en Wunderground, Meteoclimatic y Holfuy, con la
  distancia a la más cercana de la red y un aviso de posible duplicado (< 300 m).

Los cambios se acumulan en el navegador y **Guardar los cambios** los sube juntos en un
único commit a `config/stations.csv`. Entran en el mapa en la siguiente vuelta del bucle
(≤ 10 min). Quien edita no necesita cuenta de GitHub: escribe el Worker de Cloudflare
`aragonwx-admin` (`cloudflare/admin.js`), que guarda el token.

Puesta en marcha del Worker (panel de Cloudflare → Workers & Pages → Create → Worker
`aragonwx-admin`):

1. Pegar `cloudflare/admin.js` y desplegar.
2. En GitHub → Settings → Developer settings → Fine-grained tokens, crear un token con
   acceso **solo al repositorio AragonWX** y permiso **Contents: Read and write**.
3. En el Worker → Settings → Variables and Secrets: secretos `GITHUB_TOKEN` (el token) y
   `ADMIN_PASSWORD` (la contraseña del editor).

El Worker solo puede tocar `config/stations.csv`. Además comprueba la cabecera, rechaza
borrados masivos y detecta si alguien ha guardado entre medias.

## Histórico diario

- **AEMET:** no se guarda aquí. La web lee las series oficiales de
  [aemet-explorer](https://ccalvosa.github.io/aemet-explorer/) (`js/aemethist.js`):
  - `recent.json` para los últimos ~120 días;
  - `daily.json` (rama `obs`) para los provisionales de los últimos días;
  - para periodos más antiguos, la serie completa de cada estación de Aragón, que solo se
    descarga entonces.
- **Wunderground:** rellenado desde enero de 2024 con `scripts/backfill_wu.py` (resúmenes
  diarios de la API de WU) y, desde entonces, con el cierre de cada día.
- **SAIH, WeatherCloud, Meteoclimatic, Ibericam, Holfuy y AVAMET:** no tienen histórico
  público. Se acumula desde que el bucle cierra cada día (máxima, mínima, lluvia y racha) en
  `history/AAAA-MM.json`.

## Control de calidad automático (`scraper/aragonwx/qc.py`)

En cada pasada se compara cada estación con sus vecinas. No oculta nada por su cuenta:
deja sugerencias en `qc.json`, que aparecen en el editor (pestaña **Sospechosas**) y como
aviso en la ficha de la estación.

- **Temperatura actual, máxima y mínima:** diferencia con la mediana de hasta 12 vecinas a
  menos de 20 km y con altitud parecida (|Δz| < 300 m), sin corregir por altitud. Avisa si
  supera max(4 °C, 3·σ robusta de las vecinas); 4,5 °C en la mínima.
- **Temperatura congelada:** el mismo valor durante más de 6 h mientras las vecinas cambian.
- **Lluvia:**
  - marca lluvia y ninguna vecina recoge;
  - 0 mm con las vecinas mojadas (pluviómetro atascado);
  - acumulados desproporcionados.
- **Racha** muy por encima de las vecinas y **humedad** imposible (≤ 3 %).

Un aviso solo se sugiere si se repite al menos 6 pasadas hoy (≈ 1 h) o en 2 días de la
última semana. En el editor:
- **Marcar deficiente** pone la calidad de esa variable a *Deficiente*.
- **Descartar** añade `qc-ignore=<variable>` a las notas de la estación, para no volver a
  avisar de esa variable.

**Revisión de las deficientes** (`scraper/aragonwx/rehab.py`, `rehab.json`, una vez al día;
pestaña **Deficientes** del editor). Cada variable marcada *Deficiente* se compara día a día,
en los últimos 14 días cerrados de `history/`, con la mediana de sus vecinas fiables:
- máxima y mínima: ≤ 20 km y |Δz| < 300 m; día bueno si |diferencia| ≤ max(2 °C, 2·σ);
  «parece recuperada» con ≥ 8 días, ≥ 90 % buenos, |sesgo| ≤ 0,7 °C y ningún día a más de
  2,5 °C hacia el lado del fallo (por encima en la máxima, por debajo en la mínima);
- lluvia: solo los días con lluvia en las vecinas (≥ 3 y ninguno malo) o en los que marca
  ≥ 3 mm con las vecinas secas;
- racha: días con mediana ≥ 20 km/h, razón con la mediana entre 0,65 y 1,5;
- una serie congelada nunca se da por buena.
El botón **Quitar «Deficiente»** deja la variable sin valorar. En invierno, cuidado con la
máxima: un sensor al sol apenas se pasa con el sol bajo.

## Estado y avisos

- **`estado.html`:** estado de cada red (estaciones con dato en las últimas 24 h, última vez
  que funcionó), de AROME, de las sugerencias y del control de calidad. Enlace en el pie del
  panel del mapa.
- **Avisos en el bucle:** si una red lleva más de 1 h caída o con menos de la mitad de lo
  habitual, el bucle abre una incidencia «[alerta] …». Llega por correo y se cierra sola al
  recuperarse.
- **`watchdog`** (cada 30 min): si los datos llevan más de 40 min sin actualizarse o AROME
  más de 9 h sin publicar, relanza el workflow y abre una incidencia.

## Desarrollo local

```bash
pip install -r scraper/requirements.txt
export AEMET_API_KEY="..."
(cd scraper && python -m aragonwx.build --out ../out --history-dir ../history)
python -m http.server 8000      # → http://localhost:8000 (lee out/ y history/)
```

`--only AEMET,SAIH` limita la pasada a esas fuentes (útil para probar).
