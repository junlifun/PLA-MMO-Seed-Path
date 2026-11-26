"""Build the fixed-alpha location map from the community PlacementSpawner dump.

Primary location source (GPL-3.0):
    https://github.com/Lincoln-LM/JS-Finder/tree/main/Resources/pla_spawners

The community JSON has exact spawner names (``swm_no_07``, ``oyb_ex_02``) and
game coordinates. The Serebii page supplies the rendered alpha marker set; we
use it to keep any Serebii-only alpha point while matching coordinates to the
community spawner name. The raw dumps are used for their "Containing Locations"
text (Tranquility Cove, Ginkgo Landing, ...).

The app reads only the generated cache/spawn-maps/maps.json; it never contacts
either site at runtime. For local personal use.
"""

from __future__ import annotations

import concurrent.futures
import json
import re
import sys
import urllib.request
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "cache" / "spawn-maps"
RESOURCE_ROOT = ROOT / "offline_engine" / "static" / "resources"
STATIC_ROOT = ROOT / "static"

MAPS = (
    ("ObsidianFieldlands", "obsidianfieldlands", "ha_area01", "黑曜原野"),
    ("CrimsonMirelands", "crimsonmirelands", "ha_area02", "红莲湿地"),
    ("CobaltCoastlands", "cobaltcoastlands", "ha_area03", "群青海岸"),
    ("CoronetHighlands", "coronethighlands", "ha_area04", "天冠山麓"),
    ("AlabasterIcelands", "alabastericelands", "ha_area05", "纯白冻土"),
)

COMMUNITY_BASE = "https://raw.githubusercontent.com/Lincoln-LM/JS-Finder/main/Resources/pla_spawners"
SEREBII_BASE = "https://www.serebii.net/pokearth/hisui"
USER_AGENT = "Mozilla/5.0 PLA-MMO-Path-Finder/0.9.5"
TILE_SIZE = 256
GRID = 8
WORLD_EXTENT = 1024.0


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=35) as response:
        return response.read()


def fetch_text(url: str) -> str:
    return fetch(url).decode("utf-8", errors="replace")


def load_pokedex() -> dict[str, dict]:
    entries = json.loads((RESOURCE_ROOT / "pokedex.json").read_text(encoding="utf-8-sig"))
    index = {}
    for entry in entries:
        # Form-specific rows use an ``id`` such as Goodra-1; prefer that over
        # the shared species name so Hisuian forms keep their own gender ratio.
        for value in (entry.get("id"), entry.get("species")):
            key = str(value or "").strip()
            if key:
                index.setdefault(key.casefold(), entry)
    return index


def load_engine_spawners(map_key: str) -> dict[str, dict]:
    return json.loads((RESOURCE_ROOT / f"{map_key}.json").read_text(encoding="utf-8-sig"))


def normalize_species(value: str) -> str:
    return re.sub(r"^Alpha\s*", "", str(value or "").strip(), flags=re.I)


def spawner_meta(spawner: str, engine: dict[str, dict], pokedex: dict[str, dict]) -> dict:
    slots = engine.get(spawner) or {}
    species = ""
    valid_keys = []
    for slot_key, values in slots.items():
        valid = {
            key: weight
            for key, weight in (values or {}).items()
            if str(key).strip().casefold() != "none" and str(key).strip()
        }
        if not valid:
            continue
        valid_keys.append(slot_key)
        if not species:
            species = normalize_species(next(iter(valid)))
    entry = pokedex.get(species.casefold()) if species else None
    times = ["any"]
    if valid_keys and not all(key.lower().startswith("any time") for key in valid_keys):
        has_night = any(key.lower().startswith("night") for key in valid_keys)
        has_day = any(key.lower().startswith(("day", "dawn", "dusk", "morning")) for key in valid_keys)
        times = ["day", "night"] if has_day and has_night else ["night"] if has_night else ["day"] if has_day else ["any"]
    return {
        "species": species,
        "national": int(entry.get("dex_national") or 0) if entry else 0,
        "gender_ratio": int(entry.get("gender_ratio")) if entry and entry.get("gender_ratio") is not None else 255,
        "times": times,
    }


def pokedex_by_national(pokedex: dict[str, dict]) -> dict[int, str]:
    result = {}
    for entry in pokedex.values():
        national = int(entry.get("dex_national") or 0)
        species = str(entry.get("species") or "").strip()
        if national and species:
            result.setdefault(national, species)
    return result


def parse_serebii_alpha(page: str) -> tuple[list[dict], dict[int, set[int]]]:
    markers = re.findall(
        r"\{ coords: \[([^\]]+)\], icon:\s*(\w+), tableID: (\d+), layer: (\w+) \}",
        page,
    )
    filter_match = re.search(r"var pokeFilter = \{(.*?)\};", page, re.S)
    table_to_national: dict[int, set[int]] = {}
    if filter_match:
        for national, table_ids in re.findall(
            r"(\d+): \{ tableIDs: \[ ([^\]]*) \] \}", filter_match.group(1)
        ):
            for table_id in re.findall(r"\d+", table_ids):
                table_to_national.setdefault(int(table_id), set()).add(int(national))
    alpha = []
    for coords, icon, table_id, _layer in markers:
        if icon != "alphaIcon":
            continue
        try:
            parts = [float(v.strip()) for v in coords.split(",")]
        except ValueError:
            continue
        if len(parts) >= 3:
            alpha.append({"coords": parts[:3], "table_id": int(table_id)})
    return alpha, table_to_national


def find_alpha_spawner_for_species(species: str, engine: dict[str, dict]) -> str:
    target = f"Alpha{normalize_species(species)}".casefold()
    matches = []
    for spawner, slots in engine.items():
        for values in slots.values():
            if any(str(name).strip().casefold() == target for name in (values or {})):
                matches.append(spawner)
                break
    return matches[0] if len(matches) == 1 else ""


def parse_raw_locations(text: str) -> list[dict]:
    result = []
    for line in text.splitlines():
        if 'Spawner("' not in line:
            continue
        coords_match = re.search(r"V3f\(([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)\)", line)
        name_match = re.search(r'EncounterTableId\s*=\s*\*/\s*"([^"]+)"', line)
        loc_match = re.search(r"// Containing Locations:\s*(.+?)\s*$", line)
        if not coords_match or not name_match:
            continue
        result.append(
            {
                "name": name_match.group(1),
                "coords": [float(coords_match.group(i)) for i in (1, 2, 3)],
                "area": loc_match.group(1).strip() if loc_match else "",
            }
        )
    return result


def nearest(points: list[dict], coords: list[float], tolerance: float = 2.0) -> dict | None:
    best = None
    best_distance = tolerance
    for point in points:
        distance = sum((a - b) ** 2 for a, b in zip(point["coords"], coords)) ** 0.5
        if distance < best_distance:
            best = point
            best_distance = distance
    return best


def build_map(map_key: str, slug: str, area: str, label: str, pokedex: dict[str, dict]) -> dict:
    engine = load_engine_spawners(map_key)
    community = json.loads(fetch_text(f"{COMMUNITY_BASE}/jsons/{slug}.json"))
    raw = parse_raw_locations(fetch_text(f"{COMMUNITY_BASE}/dumps/Spawner_{area}.txt"))
    serebii, table_to_national = parse_serebii_alpha(fetch_text(f"{SEREBII_BASE}/{slug}.shtml"))
    national_species = pokedex_by_national(pokedex)

    alpha_community = []
    community_points = []
    for key, item in community.items():
        coords = [float(value) for value in item.get("coords") or []][:3]
        if len(coords) < 3:
            continue
        point = {
            "name": str(item.get("name") or ""),
            "coords": coords,
            "group_id": int(item.get("groupID") or 0),
            "icon": str(item.get("icon") or ""),
        }
        community_points.append(point)
        if point["icon"].endswith("/alpha.png"):
            alpha_community.append(point)

    points = []
    used = set()
    for marker in serebii:
        coords = marker["coords"]
        # Match against every community marker, not only alpha icons: a few
        # fixed alphas (e.g. night-only Golbat) are stored as standard markers
        # in the community dump but have an Alpha slot table.
        match = nearest(community_points, coords)
        name = match["name"] if match else ""
        if match:
            used.add((match["name"], tuple(round(v, 3) for v in match["coords"])))
        meta = spawner_meta(name, engine, pokedex) if name else {}
        species = meta.get("species", "")
        if not species:
            for national in sorted(table_to_national.get(marker["table_id"], set())):
                species = normalize_species(national_species.get(national, ""))
                if species:
                    break
        if not name and species:
            name = find_alpha_spawner_for_species(species, engine)
            if name:
                meta = spawner_meta(name, engine, pokedex)
                species = meta.get("species", species)
        location = nearest(raw, coords)
        area_text = (location or {}).get("area", "") if location else ""
        area_text = area_text.replace("��", "'")
        points.append(
            {
                "id": f"{map_key}-{len(points):02d}",
                "name": name,
                "spawners": [name] if name else [],
                "species": species,
                "x": round(max(0.0, min(1.0, coords[0] / WORLD_EXTENT)), 6),
                "y": round(max(0.0, min(1.0, coords[2] / WORLD_EXTENT)), 6),
                "gender_ratio": int(meta.get("gender_ratio", 255)),
                "times": meta.get("times", ["any"]),
                "area": area_text,
                "alpha": True,
            }
        )

    # Keep community alpha points that Serebii did not expose.
    for item in alpha_community:
        key = (item["name"], tuple(round(v, 3) for v in item["coords"]))
        if key in used:
            continue
        meta = spawner_meta(item["name"], engine, pokedex)
        location = nearest(raw, item["coords"])
        points.append(
            {
                "id": f"{map_key}-{len(points):02d}",
                "name": item["name"],
                "spawners": [item["name"]],
                "species": meta.get("species", ""),
                "x": round(max(0.0, min(1.0, item["coords"][0] / WORLD_EXTENT)), 6),
                "y": round(max(0.0, min(1.0, item["coords"][2] / WORLD_EXTENT)), 6),
                "gender_ratio": int(meta.get("gender_ratio", 255)),
                "times": meta.get("times", ["any"]),
                "area": (location or {}).get("area", ""),
                "alpha": True,
            }
        )

    # Deduplicate by spawner name + rounded coordinates.
    unique = []
    seen = set()
    for point in points:
        key = (point["name"], round(point["x"], 4), round(point["y"], 4))
        if key in seen:
            continue
        seen.add(key)
        unique.append(point)

    image_name = f"{map_key}.webp"
    build_map_image(slug, OUT / image_name)
    return {
        "key": map_key,
        "label": label,
        "slug": slug,
        "image": image_name,
        "width": TILE_SIZE * GRID,
        "height": TILE_SIZE * GRID,
        "source": "Serebii.net Pokearth + Lincoln-LM/JS-Finder PlacementSpawner dumps",
        "points": unique,
    }


def build_map_image(slug: str, target: Path) -> None:
    if target.is_file() and target.stat().st_size > 0:
        print(f"[skip] {target} already exists")
        return

    def tile(x: int, y: int) -> Image.Image:
        url = f"https://www.serebii.net/pokearth/hisui/{slug}/tile_2-{x}-{y}.png"
        try:
            from io import BytesIO

            image = Image.open(BytesIO(fetch(url))).convert("RGB")
            return image.resize((TILE_SIZE, TILE_SIZE), Image.Resampling.LANCZOS)
        except Exception as exc:  # noqa: BLE001
            print(f"[warn] {slug} tile {x}-{y}: {exc}", file=sys.stderr)
            return Image.new("RGB", (TILE_SIZE, TILE_SIZE), (238, 240, 232))

    canvas = Image.new("RGB", (TILE_SIZE * GRID, TILE_SIZE * GRID), (238, 240, 232))
    jobs = [(x, y) for y in range(GRID) for x in range(GRID)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda pair: (pair, tile(*pair)), jobs))
    for (x, y), image in results:
        canvas.paste(image, (x * TILE_SIZE, y * TILE_SIZE))
    target.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(target, "WEBP", quality=86, method=6)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    STATIC_ROOT.mkdir(parents=True, exist_ok=True)
    alpha_icon = STATIC_ROOT / "alpha.png"
    if not alpha_icon.is_file() or alpha_icon.stat().st_size == 0:
        alpha_icon.write_bytes(fetch(f"{SEREBII_BASE}/icons/alpha.png"))
        print(f"[ok] {alpha_icon}")
    pokedex = load_pokedex()
    maps = []
    for map_key, slug, area, label in MAPS:
        print(f"[map] {map_key}")
        maps.append(build_map(map_key, slug, area, label, pokedex))
    payload = {
        "source": "Serebii.net Pokearth + Lincoln-LM/JS-Finder (GPL-3.0), local personal use",
        "width": TILE_SIZE * GRID,
        "height": TILE_SIZE * GRID,
        "maps": maps,
    }
    (OUT / "maps.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    for entry in maps:
        print(f"[ok] {entry['key']}: {len(entry['points'])} alpha points")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
