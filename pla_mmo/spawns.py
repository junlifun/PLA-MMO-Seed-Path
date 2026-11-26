"""Single spawner (fixed spawn point / static alpha) shiny-advance calculation.

The vendored engine already implements this in ``offline_engine/pla/checkalpha.py``
(``check_alpha_from_seed``). It is the same seed the MMO calculator uses: one
``group_seed`` drives the map's spawners, so a seed obtained from a massive
outbreak also answers "which reset does this fixed alpha shine on".

This module is deliberately thin: it validates UI input, maps the friendly
options onto the engine's parameters, and normalises the engine's output.
"""

from __future__ import annotations

import importlib
import json
from functools import lru_cache
from pathlib import Path

from pla_mmo.local_engine import LocalEngineError
from pla_mmo.paths import get_project_root

RESOURCE_ROOT = get_project_root() / "offline_engine" / "static" / "resources"

# The engine's data files are named after the internal map id.
MAPS = (
    ("ObsidianFieldlands", "黑曜原野"),
    ("CrimsonMirelands", "红莲湿地"),
    ("CobaltCoastlands", "群青海岸"),
    ("CoronetHighlands", "天冠山麓"),
    ("AlabasterIcelands", "纯白冻土"),
)

# Shiny roll counts. Base spawner roll is 1; research 10 adds 1, perfect adds 3,
# the shiny charm adds 3 (see offline_engine/pla/core/rolls.py). The upstream site
# offers five of these and omits "charm + research 10"; the combinations are shown
# with their roll count so a value of 4 twice is not read as a duplicate.
ROLL_MODES = (
    {"key": "default", "label": "默认（1 次判定）", "rolls": 1},
    {"key": "research10", "label": "研究等级 10（2 次判定）", "rolls": 2},
    {"key": "perfect", "label": "完美研究（4 次判定）", "rolls": 4},
    {"key": "charm", "label": "闪耀护符（4 次判定）", "rolls": 4},
    {"key": "charm_research10", "label": "闪耀护符 + 研究等级 10（5 次判定）", "rolls": 5},
    {"key": "charm_perfect", "label": "闪耀护符 + 完美研究（7 次判定）", "rolls": 7},
)

# Female share of the gender ratio, used only to label the engine's raw roll.
GENDER_RATIOS = (
    {"key": "1:7", "label": "1 ♀ : 7 ♂", "female": 1 / 8},
    {"key": "1:3", "label": "1 ♀ : 3 ♂", "female": 1 / 4},
    {"key": "1:4", "label": "1 ♀ : 4 ♂", "female": 1 / 5},
    {"key": "1:1", "label": "1 ♀ : 1 ♂", "female": 1 / 2},
    {"key": "3:1", "label": "3 ♀ : 1 ♂", "female": 3 / 4},
    {"key": "male", "label": "仅 ♂", "female": 0.0},
    {"key": "female", "label": "仅 ♀", "female": 1.0},
    {"key": "genderless", "label": "无性别", "female": None},
)

MAX_ADVANCES = 50000


def _species_path(map_key: str) -> Path:
    return RESOURCE_ROOT / f"{map_key}_spawnerbyspecies.json"


@lru_cache(maxsize=8)
def _load_species_map(map_key: str) -> dict:
    path = _species_path(map_key)
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def catalog() -> dict:
    maps = []
    for key, label in MAPS:
        raw = _load_species_map(key)
        # The upstream tables contain a placeholder key that is not a species.
        species = sorted(
            name for name, spawner_list in raw.items()
            if str(name).strip() and str(name).strip().lower() != "none" and spawner_list
        )
        if not species:
            continue
        maps.append({"key": key, "label": label, "species": species})
    return {
        "maps": maps,
        "roll_modes": [dict(item) for item in ROLL_MODES],
        "gender_ratios": [dict(item) for item in GENDER_RATIOS],
        "max_advances": MAX_ADVANCES,
    }


def spawners(map_key: str, species: str) -> list[str]:
    data = _load_species_map(map_key)
    values = data.get(species)
    return [str(item) for item in values] if isinstance(values, list) else []


def _gender_label(raw: int, ratio_key: str, fixed_gender: bool) -> str:
    if fixed_gender:
        return {
            "male": "固定 ♂",
            "female": "固定 ♀",
            "genderless": "无性别",
        }.get(ratio_key, "固定性别 / 无性别")
    if raw is None or int(raw) < 0:
        return "固定性别 / 无性别"
    ratio = next((item for item in GENDER_RATIOS if item["key"] == ratio_key), None)
    if ratio is None or ratio["female"] is None:
        return "无性别"
    threshold = round(252 * float(ratio["female"]))
    return "♀" if int(raw) <= threshold else "♂"


def calculate(
    seed: str,
    map_key: str,
    species: str,
    spawner: str,
    *,
    is_night: bool = False,
    static_alpha: bool = True,
    fixed_gender: bool = False,
    rolls: int = 1,
    gender_ratio: str = "1:1",
) -> dict:
    seed_text = str(seed or "").strip().lower().removeprefix("0x")
    if not seed_text.isdigit():
        raise ValueError("Seed 必须是十进制整数。")
    if len(seed_text) > 20:
        raise ValueError("Seed 超出 64 位范围。")

    if map_key not in {key for key, _ in MAPS}:
        raise ValueError("未知的地图。")
    if not species:
        raise ValueError("请选择 spawner 宝可梦。")
    available = spawners(map_key, species)
    if not available:
        raise ValueError("该宝可梦在这张地图上没有 spawner 数据。")
    if spawner not in available:
        raise ValueError("所选 spawner 与该宝可梦不匹配。")

    roll_count = int(rolls)
    if roll_count < 1 or roll_count > 32:
        raise ValueError("判定次数必须在 1–32 之间。")

    try:
        engine = importlib.import_module("offline_engine.pla.checkalpha")
    except Exception as exc:  # noqa: BLE001 - surface a readable message
        raise LocalEngineError(f"本地引擎缺少单体生成点模块：{exc}") from exc

    pfilter = {
        "species": species,
        "mapname": map_key,
        "spawner": spawner,
        "daynight": bool(is_night),
    }

    try:
        raw_results = engine.check_alpha_from_seed(
            seed_text, roll_count, bool(static_alpha), bool(fixed_gender), pfilter
        )
    except Exception as exc:  # noqa: BLE001
        raise LocalEngineError(f"本地引擎计算失败：{type(exc).__name__}: {exc}") from exc

    results = []
    for item in raw_results or []:
        results.append({
            "advance": int(item.get("adv", 0)),
            "ivs": list(item.get("ivs") or []),
            "gender": _gender_label(item.get("gender"), gender_ratio, fixed_gender),
            "gender_raw": item.get("gender"),
            "nature": item.get("nature"),
            "species": item.get("species"),
            "sprite": item.get("sprite"),
            "shiny": bool(item.get("shiny")),
            "square": bool(item.get("square")),
            "alpha": bool(item.get("alpha")),
            "rolls": int(item.get("rolls", roll_count)),
        })

    return {
        "seed": seed_text,
        "map": map_key,
        "species": species,
        "spawner": spawner,
        "is_night": bool(is_night),
        "static_alpha": bool(static_alpha),
        "rolls": roll_count,
        "result_count": len(results),
        "results": results,
        "exhausted": not results,
    }
