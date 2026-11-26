"""Offline multi-spawner Seed checker.

The upstream project exposes this as ``/multiseed``.  This module keeps the
same encounter tables (``multi-es.json`` and ``groupids.json``) but runs the
calculation locally, without reading a Switch or a save file.
"""

from __future__ import annotations

import importlib
import json
from functools import lru_cache
from pathlib import Path

from pla_mmo.paths import get_project_root

ROOT = get_project_root()
RESOURCE_ROOT = ROOT / "offline_engine" / "static" / "resources"
ANNOTATION_PATH = ROOT / "cache" / "spawn-maps" / "multi-groups.json"
BUNDLED_ANNOTATION_PATH = ROOT / "static" / "spawn-maps" / "multi-groups.json"

MAP_LABELS = {
    "ObsidianFieldlands": "黑曜原野",
    "CrimsonMirelands": "红莲湿地",
    "CobaltCoastlands": "群青海岸",
    "CoronetHighlands": "天冠山麓",
    "AlabasterIcelands": "纯白冻土",
}

MAP_PREFIXES = {
    "Obsidian Fieldlands": "ObsidianFieldlands",
    "Crimson Mirelands": "CrimsonMirelands",
    "Cobalt Coastlands": "CobaltCoastlands",
    "Coronet Highlands": "CoronetHighlands",
    "Alabaster Icelands": "AlabasterIcelands",
}

FILTERS = {
    "is_shiny": "只看闪光",
    "is_alpha": "只看头目",
    "is_square_shiny": "只看方块闪",
    "is_shiny_alpha": "闪光 + 头目",
    "is_square_alpha": "方块闪 + 头目",
    "is_square_normal": "方块闪 + 普通",
    "all": "全部",
}
DEPTHS = (5, 9, 12, 16)
MAX_RESULTS = 300


@lru_cache(maxsize=1)
def _groups() -> tuple[dict, ...]:
    path = RESOURCE_ROOT / "groupids.json"
    raw = json.loads(path.read_text(encoding="utf-8-sig"))
    return tuple(item for item in raw if isinstance(item, dict))


@lru_cache(maxsize=1)
def _tables() -> dict:
    path = RESOURCE_ROOT / "multi-es.json"
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _map_key(name: str) -> str:
    for prefix, key in MAP_PREFIXES.items():
        if name.startswith(prefix):
            return key
    return ""


def _annotations() -> dict:
    raw = None
    for path in (ANNOTATION_PATH, BUNDLED_ANNOTATION_PATH):
        try:
            raw = json.loads(path.read_text(encoding="utf-8-sig"))
            break
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            continue
    if not isinstance(raw, dict):
        return {}
    result = {}
    for key, item in (raw or {}).items():
        if not isinstance(item, dict):
            continue
        points = []
        for point in item.get("points") or []:
            try:
                x, y = float(point.get("x")), float(point.get("y"))
            except (TypeError, ValueError):
                continue
            if 0 <= x <= 1 and 0 <= y <= 1:
                points.append({"x": round(x, 6), "y": round(y, 6)})
        if not points:
            continue
        try:
            group_id = int(item.get("group_id") or key)
        except (TypeError, ValueError):
            continue
        maxalive = int(item.get("maxalive") or 2)
        ui_id = str(item.get("ui_id") or (f"{group_id}-3" if maxalive == 3 else group_id))
        result[str(key)] = {
            "key": str(key),
            "group_id": group_id,
            "ui_id": ui_id,
            "name": str(item.get("name") or ""),
            "region": str(item.get("region") or ""),
            "map": str(item.get("map") or ""),
            "points": points[:10],
            "maxalive": maxalive,
            "has_night": bool(item.get("has_night")),
            "night_only": bool(item.get("night_only")),
        }
    return result


def catalog() -> dict:
    tables = _tables()
    annotations = _annotations()
    groups = []
    base_by_id = {}
    for item in _groups():
        raw_id = str(item.get("id") or "").strip()
        if not raw_id.isdigit():
            continue
        name = str(item.get("name") or "").strip()
        map_key = _map_key(name)
        has_base = raw_id in tables
        has_night = f"{raw_id}n" in tables
        group = {
            "id": int(raw_id),
            "engine_id": int(raw_id),
            "name": name,
            "map": map_key,
            "map_label": MAP_LABELS.get(map_key, map_key),
            "has_night": has_night,
            "night_only": bool(has_night and not has_base),
            "maxalive": 2,
        }
        groups.append(group)
        base_by_id[raw_id] = group
    # 3-3 页面单独成一个可选生成点组；计算仍用上游 group_id，但固定 3 只。
    variants = {}
    for entry in annotations.values():
        ui_id = str(entry["ui_id"])
        if ui_id in base_by_id:
            continue
        base = base_by_id.get(str(entry["group_id"]))
        if not base or ui_id in variants:
            continue
        variants[ui_id] = {
            "id": ui_id,
            "engine_id": int(entry["group_id"]),
            "name": f"{base['name']} (3-3)",
            "map": entry.get("map") or base["map"],
            "map_label": MAP_LABELS.get(entry.get("map") or base["map"], base["map_label"]),
            "has_night": base["has_night"],
            "night_only": base["night_only"],
            "maxalive": 3,
        }
    groups.extend(variants.values())
    return {
        "groups": groups,
        "points": annotations,
        "filters": [{"key": key, "label": label} for key, label in FILTERS.items()],
        "max_results": MAX_RESULTS,
    }


def _group(group_id) -> dict:
    key = str(group_id)
    for item in catalog()["groups"]:
        if str(item["id"]) == key:
            return item
    raise ValueError("未知的多只生成点。")


def _gender_symbol(value) -> str:
    if isinstance(value, str):
        return {"male": "♂", "female": "♀", "genderless": "无性别"}.get(value.lower(), value)
    return {0: "♂", 1: "♀", 2: "无性别"}.get(value, "—")


def _normalize(item: dict, group: dict, maxalive: int, is_night: bool) -> dict:
    path = [int(part) for part in item.get("path") or []]
    return {
        "species": str(item.get("species") or ""),
        "path": path,
        "path_label": "初始" if not path else "-".join(str(part) for part in path),
        "depth": len(path),
        "shiny": bool(item.get("shiny")),
        "square": bool(item.get("square")),
        "alpha": bool(item.get("alpha")),
        "ivs": [int(value) for value in item.get("ivs") or []],
        "nature": str(item.get("nature") or ""),
        "gender": _gender_symbol(item.get("gender")),
        "rolls": int(item.get("rolls") or 0),
        "group_id": group["id"],
        "group_name": group["name"],
        "map": group["map"],
        "map_label": group["map_label"],
        "maxalive": maxalive,
        "is_night": is_night,
    }


def _matches(result: dict, filter_key: str) -> bool:
    if filter_key == "is_alpha":
        return result["alpha"]
    if filter_key == "is_square_shiny":
        return result["shiny"] and result["square"]
    if filter_key == "is_shiny_alpha":
        return result["shiny"] and result["alpha"]
    if filter_key == "is_square_alpha":
        return result["shiny"] and result["square"] and result["alpha"]
    if filter_key == "is_square_normal":
        return result["shiny"] and result["square"] and not result["alpha"]
    if filter_key == "all":
        return True
    return result["shiny"]


def check(
    seed: str,
    group_id,
    maxalive: int = 2,
    maxdepth: int = 9,
    is_night: bool = False,
    filter_key: str = "is_shiny",
    rolls: int = 5,
) -> dict:
    seed_text = str(seed or "").strip().lower().removeprefix("0x")
    if not seed_text.isdigit():
        raise ValueError("Seed 必须是十进制整数。")
    if len(seed_text) > 20:
        raise ValueError("Seed 超出 64 位范围。")
    try:
        maxalive = int(maxalive)
        maxdepth = int(maxdepth)
    except (TypeError, ValueError) as exc:
        raise ValueError("生成点参数格式不正确。") from exc
    if maxalive not in (2, 3):
        raise ValueError("生成数量只能是 2 或 3。")
    if maxdepth not in DEPTHS:
        raise ValueError("最大刷新次数只能是 5、9、12 或 16。")
    if maxalive == 3 and maxdepth > 9:
        maxdepth = 9
    if filter_key not in FILTERS:
        raise ValueError("未知的结果筛选条件。")

    group = _group(group_id)
    if group.get("maxalive") == 3:
        maxalive = 3
    engine_id = int(group.get("engine_id") or group["id"])
    tables = _tables()
    target = f"{engine_id}n" if is_night else str(engine_id)
    if target not in tables:
        if is_night:
            raise ValueError("这个生成点没有夜晚生成表。")
        raise ValueError("这个生成点只有夜晚表，请勾选夜晚。")

    try:
        engine = importlib.import_module("offline_engine.pla.checkmulti")
        raw = engine.check_multi_spawner_seed(
            int(seed_text),
            10,
            engine_id,
            maxalive,
            maxdepth,
            bool(is_night),
            rolls_override=int(rolls),
        )
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"本地多只计算失败：{type(exc).__name__}: {exc}") from exc

    matches = []
    total_matches = 0
    for item in raw or []:
        result = _normalize(item, group, maxalive, bool(is_night))
        if not _matches(result, filter_key):
            continue
        total_matches += 1
        if len(matches) < MAX_RESULTS:
            matches.append(result)

    return {
        "ok": True,
        "seed": seed_text,
        "group": group,
        "maxalive": maxalive,
        "maxdepth": maxdepth,
        "is_night": bool(is_night),
        "filter": filter_key,
        "rolls": int(rolls),
        "total_results": len(raw or []),
        "total_matches": total_matches,
        "returned": len(matches),
        "truncated": total_matches > len(matches),
        "results": matches,
    }
