#!/usr/bin/env python3
"""
Migración única desde la versión anterior (carpeta «old» del script 0124_v2.py).

Genera los ficheros de configuración del repositorio a partir de los CSV que
mantenía el script antiguo, quitando los valores medidos (que ahora viven en la
rama «data») y dejando solo lo que se edita a mano:

  config/stations.csv    red de estaciones (todas las fuentes)
  config/reservoirs.csv  embalses del SAIH Ebro
  config/gauges.csv      aforos del SAIH Ebro con umbrales de aviso
  config/webcams.csv     webcams (las de la DGT se descargan solas)

Opcionalmente recupera el histórico diario de historico_data.json (aunque esté
truncado) en history/AAAA-MM.json, y los historiales hidro de 72 h para que las
tendencias no empiecen de cero.

Uso:
    python scripts/migrate_old.py --old ../old --repo .
"""

import argparse
import csv
import json
import re
from pathlib import Path

ACTIVE_SOURCES = {"AEMET", "SAIH", "WU", "WC", "MC", "IBERICAM", "HOLFUY", "AVAMET"}

COLS = ["id", "source", "name", "prov", "lat", "lon", "alt", "link", "model", "notes",
        "q_tmax", "q_tmin", "q_prec", "q_wind", "tz_shift", "kind", "active"]


def clean(v):
    v = (v or "").strip()
    return "" if v in ("ND", "nan", "NaN", "None") else v


def split_name(raw, source):
    """'Huesca_Aeropuerto_AEMET (546m)' -> ('Huesca Aeropuerto', 546)."""
    raw = (raw or "").strip()
    alt = None
    m = re.search(r"\(\s*(-?\d+(?:[.,]\d+)?)\s*m\s*\)", raw)
    if m:
        alt = int(round(float(m.group(1).replace(",", "."))))
    name = re.sub(r"\(\s*[^)]*m\s*\)", "", raw).strip()
    name = re.sub(r"_(AEMET|SAIH|WU|WC|MC|IBERICAM\d?|Holfuy|AVAMET|EW|SIAR|Arantec)\s*$", "", name,
                  flags=re.I)
    name = re.sub(r"(AVAMET)$", "", name).strip()
    name = name.replace("_", " ").strip()
    return name, alt


def quality(v):
    v = clean(v)
    return v if v in ("Contrastada", "Deficiente") else ""


def norm_source(web, link):
    web = (web or "").strip()
    if web in ("IBERICAM", "IBERICAM1"):
        return "IBERICAM"
    if web == "IBERICAM2" or "holfuy.com" in (link or ""):
        return "HOLFUY"
    return {"Arantec": "ARANTEC", "EW": "ECOWITT"}.get(web, web.upper())


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def migrate_stations(old, repo):
    rows = []
    seen = set()
    for fname, kind_default in (("estaciones_actualizadas.csv", ""), ("OtrasAEMET.csv", "aux")):
        for r in read_csv(old / fname):
            sid = clean(r.get("COD"))
            if not sid or sid in seen:
                continue
            seen.add(sid)
            link = clean(r.get("Link"))
            src = norm_source(r.get("Web"), link)
            name, alt = split_name(r.get("Nombre"), src)
            try:
                lat, lon = float(r["Lat"]), float(r["Long"])
            except (TypeError, ValueError, KeyError):
                continue
            notes = clean(r.get("Observaciones"))
            kind = kind_default
            if src == "AEMET" and kind == "aux":
                kind = {"PLUVIOMETRICAS": "pluvio", "TERMOPLUVIOMETRICAS": "termopluvio",
                        "TERMOMETRICAS": "termo"}.get(notes, "aux")
            if src == "SAIH":
                kind = "pluvio" if "tabla-pluviometria" in link else "temp"
                if kind == "temp":
                    m = re.search(r"grafica-senal-([A-Z0-9]+)", link)
                    notes = (notes + " " if notes else "") + (f"tag={m.group(1)}" if m else "")
            rows.append({
                "id": sid, "source": src, "name": name, "prov": clean(r.get("Prov")),
                "lat": f"{lat:.5f}", "lon": f"{lon:.5f}", "alt": "" if alt is None else alt,
                "link": link, "model": clean(r.get("Modelo")), "notes": notes,
                "q_tmax": quality(r.get("Calidad_Max")), "q_tmin": quality(r.get("Calidad_Min")),
                "q_prec": quality(r.get("Calidad_Precipitacion")), "q_wind": quality(r.get("Calidad_Viento")),
                "tz_shift": "1" if clean(r.get("Problema_Hora")) == "SI" else "",
                "kind": kind,
                # las secundarias de AEMET (manuales) no publican datos en tiempo real
                "active": "1" if src in ACTIVE_SOURCES and kind_default != "aux" else "0",
            })
    rows.sort(key=lambda x: (x["source"], x["prov"], x["name"]))
    with open(repo / "config" / "stations.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLS)
        w.writeheader()
        w.writerows(rows)
    print(f"stations.csv: {len(rows)} estaciones")
    return rows


def num_es(s):
    m = re.search(r"-?\d+(?:[.,]\d+)?", s or "")
    return m.group(0).replace(",", ".") if m else ""


def migrate_hydro(old, repo):
    emb = read_csv(old / "embalses_actualizado.csv")
    with open(repo / "config" / "reservoirs.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "name", "lat", "lon", "capacity_hm3", "link"])
        for r in emb:
            w.writerow([r["codigo"], r["Embalse"], f'{float(r["Lat"]):.5f}', f'{float(r["Long"]):.5f}',
                        r["Capacidad"], r["Fuente_URL"]])
    afo = read_csv(old / "aforos.csv")
    with open(repo / "config" / "gauges.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "name", "lat", "lon", "warn_yellow", "warn_orange", "warn_red",
                    "since", "record_date", "record_level_m", "record_flow_m3s", "link"])
        for r in afo:
            w.writerow([r["codigo"], r["estación"], f'{float(r["lat"]):.5f}', f'{float(r["long"]):.5f}',
                        r["aviso_amarillo"], r["aviso_naranja"], r["aviso_rojo"], r["instalacion"],
                        r["fecha_max"], num_es(r["nivel_max"]), num_es(r["caudal_max"]), r["fuente_url"]])
    cams = read_csv(old / "webcams.csv")
    with open(repo / "config" / "webcams.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["name", "lat", "lon", "link", "notes"])
        for r in cams:
            try:
                w.writerow([r["Nombre"].strip(), f'{float(r["Lat"]):.5f}', f'{float(r["Long"]):.5f}',
                            r["Link"].strip(), clean(r.get("Observaciones"))])
            except (ValueError, KeyError):
                pass
    print(f"reservoirs.csv: {len(emb)} · gauges.csv: {len(afo)} · webcams.csv: {len(cams)}")
    return emb, afo


def recover_history(old, repo):
    """Lee historico_data.json estación a estación (tolera que esté truncado)."""
    path = old / "historico_data.json"
    if not path.exists():
        return
    text = path.read_text(encoding="utf-8", errors="ignore")
    dec = json.JSONDecoder()
    i = text.find("[") + 1
    months = {}
    n_st = 0
    while True:
        while i < len(text) and text[i] in " ,\n\r\t":
            i += 1
        if i >= len(text) or text[i] == "]":
            break
        try:
            obj, i = dec.raw_decode(text, i)
        except json.JSONDecodeError:
            break   # resto truncado
        n_st += 1
        sid = str(obj["id"])
        for e in obj.get("h", []):
            d = e.get("d")
            if not d:
                continue
            mon = months.setdefault(d[:7], {})
            mon.setdefault(sid, {})[d] = [e.get("x"), e.get("n"), e.get("p"), e.get("w")]
    for mon, st in sorted(months.items()):
        write_month(repo / "history" / f"{mon}.json", mon, st)
    print(f"histórico recuperado: {n_st} estaciones, meses {sorted(months)}")


def write_month(path, mon, st):
    """st = {id: {AAAA-MM-DD: [x, n, p, w]}} -> formato columnar del mes."""
    import calendar
    y, m = map(int, mon.split("-"))
    days = [f"{mon}-{d:02d}" for d in range(1, calendar.monthrange(y, m)[1] + 1)]
    data = {}
    for sid, byday in st.items():
        cols = {k: [None] * len(days) for k in "xnpw"}
        for k, d in enumerate(days):
            v = byday.get(d)
            if v:
                for j, key in enumerate("xnpw"):
                    if v[j] is not None:
                        cols[key][k] = round(float(v[j]), 1)
        cols = {k: a for k, a in cols.items() if any(x is not None for x in a)}
        if cols:
            data[sid] = cols
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"month": mon, "days": days, "vars": ["x", "n", "p", "w"], "data": data}, f,
                  separators=(",", ":"))


def seed_hydro_state(old, repo, emb, afo):
    """Historiales hidro de 72 h -> out/seed_hydro.json (estado inicial opcional)."""
    name2emb = {r["Embalse"].strip(): r["codigo"] for r in emb}
    name2afo = {r["estación_saih"].strip(): r["codigo"] for r in afo}
    seed = {"reservoirs": {}, "gauges": {}}
    for fname, key, names, f1, f2 in (("embalses_historial_72h.json", "reservoirs", name2emb, "vol", "pct"),
                                      ("aforos_historial_72h.json", "gauges", name2afo, "q", "h")):
        try:
            h = json.load(open(old / fname, encoding="utf-8"))
        except Exception:
            continue
        for name, pts in h.items():
            sid = names.get(name.strip())
            if sid:
                seed[key][sid] = [[p["ts"], p.get("v1"), p.get("v2")] for p in pts]
    out = repo / "out"
    out.mkdir(exist_ok=True)
    json.dump(seed, open(out / "seed_hydro.json", "w"), separators=(",", ":"))
    print(f"semilla hidro: {len(seed['reservoirs'])} embalses, {len(seed['gauges'])} aforos")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--old", type=Path, required=True)
    ap.add_argument("--repo", type=Path, default=Path("."))
    ap.add_argument("--no-history", action="store_true")
    a = ap.parse_args()
    (a.repo / "config").mkdir(exist_ok=True)
    migrate_stations(a.old, a.repo)
    emb, afo = migrate_hydro(a.old, a.repo)
    if not a.no_history:
        recover_history(a.old, a.repo)
    seed_hydro_state(a.old, a.repo, emb, afo)


if __name__ == "__main__":
    main()
