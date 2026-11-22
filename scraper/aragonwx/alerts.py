#!/usr/bin/env python3
"""
Avisos de fallo como incidencias de GitHub (llegan por correo a quien vigila el repo).

  python -m aragonwx.alerts --health ../out/health.json
        Desde el bucle de update-data: si una red lleva más de 1 h caída o degradada
        abre una incidencia «[alerta] <red>»; cuando se recupera, la comenta y la cierra.

  python -m aragonwx.alerts --watchdog
        Desde el workflow watchdog (cada 30 min): comprueba que los bucles siguen vivos
        (now.json con menos de 40 min, AROME publicado hace menos de 9 h). Si no, relanza
        el workflow y abre una incidencia; la cierra cuando vuelve a funcionar.

Necesita GH_TOKEN (o GITHUB_TOKEN) y GITHUB_REPOSITORY.
"""

import argparse
import datetime as dt
import json
import os
import sys
import time
from datetime import datetime, timezone

import requests

from .common import TZ, log

API = "https://api.github.com"
NAMES = {"AEMET": "AEMET", "SAIH": "SAIH Ebro", "WU": "Weather Underground", "WC": "WeatherCloud",
         "MC": "Meteoclimatic", "IBERICAM": "Ibericam", "HOLFUY": "Holfuy", "AVAMET": "AVAMET"}
DOWN_AFTER = 3600


def gh():
    tok = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    repo = os.environ.get("GITHUB_REPOSITORY", "ccalvosa/AragonWX")
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {tok}", "Accept": "application/vnd.github+json",
                      "X-GitHub-Api-Version": "2022-11-28"})
    return s, repo


def hhmm(ts):
    return datetime.fromtimestamp(ts, TZ).strftime("%d/%m %H:%M")


def open_alerts(s, repo):
    r = s.get(f"{API}/repos/{repo}/issues", params={"labels": "alerta", "state": "open", "per_page": 100}, timeout=30)
    r.raise_for_status()
    return {i["title"].split(":")[0]: i for i in r.json() if "pull_request" not in i}


def raise_alert(s, repo, existing, key, title, body):
    if key in existing:
        return
    r = s.post(f"{API}/repos/{repo}/issues", json={"title": f"{key}: {title}", "body": body, "labels": ["alerta"]},
               timeout=30)
    r.raise_for_status()
    log(f"  aviso abierto: {key}: {title}")


def clear_alert(s, repo, existing, key, body):
    i = existing.get(key)
    if not i:
        return
    s.post(f"{API}/repos/{repo}/issues/{i['number']}/comments", json={"body": body}, timeout=30)
    s.patch(f"{API}/repos/{repo}/issues/{i['number']}", json={"state": "closed", "state_reason": "completed"}, timeout=30)
    log(f"  aviso cerrado: {key}")


def check_sources(path):
    h = json.load(open(path, encoding="utf-8"))
    s, repo = gh()
    existing = open_alerts(s, repo)
    now = h["ts"]
    for src, v in h["sources"].items():
        key = f"[alerta] {NAMES.get(src, src)}"
        bad = v["status"] != "ok"
        if bad and now - (v.get("since") or now) >= DOWN_AFTER:
            what = "sin datos" if v["status"] == "down" else "menos estaciones de lo normal"
            last = f"el {hhmm(v['last_ok'])}" if v.get("last_ok") else "nunca en las últimas 24 h"
            raise_alert(s, repo, existing, key, what, (
                f"**{NAMES.get(src, src)}** está **{what}** desde el {hhmm(v['since'])} (hora peninsular).\n\n"
                f"- Estaciones con datos ahora: {v['ok']} de {v['n']} (lo habitual: {v['typical']})\n"
                f"- Última pasada normal: {last}\n\n"
                f"Revisa el log de **update-data** en Actions. Esta incidencia se cerrará sola cuando se recupere."))
        elif not bad:
            clear_alert(s, repo, existing, key, f"Recuperada el {hhmm(now)}: {v['ok']} estaciones con datos.")


def radar_ts(doc):
    """Hora (epoch) de la última imagen del radar."""
    return dt.datetime.strptime(doc["frames"][-1]["t"], "%Y-%m-%dT%H:%MZ").replace(tzinfo=dt.timezone.utc).timestamp()


def watchdog():
    s, repo = gh()
    existing = open_alerts(s, repo)
    now = time.time()
    raw = f"https://raw.githubusercontent.com/{repo}"
    checks = [
        ("[alerta] update-data parado", "data.yml", f"{raw}/data/now.json", "ts", 40 * 60,
         "Los datos de las estaciones no se actualizan"),
        ("[alerta] update-arome parado", "arome.yml", f"{raw}/arome/manifest.json", "generated", 9 * 3600,
         "AROME no publica una pasada nueva"),
        # el radar publica una imagen cada 5 min (llegan con ~6 min de retraso)
        ("[alerta] update-radar parado", "radar.yml", f"{raw}/radar/manifest.json", radar_ts, 40 * 60,
         "El radar de Zaragoza no publica imágenes nuevas"),
    ]
    for key, wf, url, field, max_age, what in checks:
        try:
            doc = requests.get(url, params={"t": int(now // 60)}, timeout=30).json()
            ts = field(doc) if callable(field) else doc[field]
        except Exception as e:
            log(f"  {key}: no se puede leer {url} ({e})")
            continue
        age = now - ts
        if age > max_age:
            r = s.post(f"{API}/repos/{repo}/actions/workflows/{wf}/dispatches", json={"ref": "main"}, timeout=30)
            relaunched = "se ha relanzado automáticamente" if r.status_code == 204 else f"no se pudo relanzar ({r.status_code})"
            raise_alert(s, repo, existing, key, what.lower(), (
                f"{what} desde hace {age / 3600:.1f} h (último dato: {hhmm(ts)}, hora peninsular).\n\n"
                f"El workflow **{wf}** {relaunched}. Si sigue sin funcionar, revisa su log en Actions. "
                + ("Si el bucle funciona pero no llegan imágenes, el fallo puede estar en el bucket de "
                   "EUMETNET OPERA (el log dirá «sin ficheros» o «no responde»). " if wf == "radar.yml" else "") +
                f"Esta incidencia se cerrará sola cuando vuelva a publicar."))
            log(f"  {key}: {age / 60:.0f} min sin datos; relanzado ({r.status_code})")
        else:
            clear_alert(s, repo, existing, key, f"Vuelve a funcionar: último dato {hhmm(ts)}.")
            log(f"  {key.replace('[alerta] ', '')}: bien ({age / 60:.0f} min)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--health")
    ap.add_argument("--watchdog", action="store_true")
    a = ap.parse_args()
    try:
        if a.watchdog:
            watchdog()
        elif a.health:
            check_sources(a.health)
    except Exception as e:   # los avisos nunca deben romper el bucle
        log(f"  avisos: ERROR {type(e).__name__}: {e}")
        sys.exit(0)


if __name__ == "__main__":
    main()
