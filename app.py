from __future__ import annotations

import ctypes
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import traceback
from datetime import datetime
import threading
import webbrowser
from pathlib import Path
from flask import Flask, jsonify, render_template, request, send_file

from pla_mmo.local_engine import LocalEngineError, LocalMMOEngine
from pla_mmo.calculator import build_calculation_params, calculate_mmo_path
from pla_mmo.calculator import RESEARCH_BONUS_ROLLS, _configured_research_level
from pla_mmo.engine_installer import EngineInstaller
from pla_mmo.spawns import calculate as calculate_spawn, catalog as spawn_catalog, spawners as spawner_names
from pla_mmo.multi import catalog as multi_catalog, check as calculate_multi
from pla_mmo.seed_manager import SeedManager
from pla_mmo.seed_link import SeedLinkService
from pla_mmo.resources import ResourceManager
from pla_mmo.board_flasher import BoardFlasher, BoardFlashError
from pla_mmo.spawn_maps import SpawnMapStore
from pla_mmo.settings import SettingsStore, get_data_dir
from pla_mmo.paths import get_log_dir, get_project_root
from pla_mmo.pokemon_assets import PokemonAssetManager
from pla_mmo.launcher import choose_local_port
from pla_mmo.updater import UpdateError, UpdateService

APP_VERSION = "0.9.13"
AUTHOR_NAME = "君粒"

PROJECT_ROOT = get_project_root()
RUNTIME_ERROR_LOG = (get_log_dir() / "runtime_errors.log") if getattr(sys, "frozen", False) else (PROJECT_ROOT / "runtime_errors.log")


def _append_runtime_error(title: str, exc: Exception | None = None, context: dict | None = None) -> None:
    lines = [
        "=" * 72,
        f"时间：{datetime.now().astimezone().isoformat(timespec='seconds')}",
        f"类型：{title}",
    ]
    if context:
        lines.append("上下文：" + json.dumps(context, ensure_ascii=False, default=str))
    if exc is not None:
        lines.append(f"异常：{type(exc).__name__}: {exc}")
        lines.extend(traceback.format_exception(type(exc), exc, exc.__traceback__))
    try:
        RUNTIME_ERROR_LOG.parent.mkdir(parents=True, exist_ok=True)
        with RUNTIME_ERROR_LOG.open("a", encoding="utf-8") as handle:
            handle.write("\n".join(lines).rstrip() + "\n")
    except OSError:
        # Logging must never turn a calculation failure into a second failure.
        pass


def _tail_text(path: Path, max_chars: int = 7000) -> str:
    try:
        content = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return "（文件尚不存在或无法读取）"
    content = content.strip()
    if not content:
        return "（文件为空）"
    return content[-max_chars:]


def create_app(test_config: dict | None = None) -> Flask:
    app = Flask(__name__)
    app.config.update(
        JSON_AS_ASCII=False,
        # Manual update archives can be around 56 MB (portable) or 35 MB
        # (Setup); keep a generous ceiling for the multipart upload.
        MAX_CONTENT_LENGTH=512 * 1024 * 1024,
    )
    if test_config:
        app.config.update(test_config)

    data_dir = Path(app.config.get("DATA_DIR") or get_data_dir())
    data_dir.mkdir(parents=True, exist_ok=True)
    cache_root = PROJECT_ROOT / "cache"
    cache_root.mkdir(parents=True, exist_ok=True)

    settings_store = SettingsStore(data_dir / "settings.json")
    seed_manager = SeedManager(settings_store)
    local_engine = LocalMMOEngine()
    pokemon_assets = PokemonAssetManager(PROJECT_ROOT, data_dir, cache_root / "pokemon-images")
    engine_installer = EngineInstaller(PROJECT_ROOT)
    seed_link = SeedLinkService(PROJECT_ROOT, settings_store, seed_manager)
    spawn_maps = SpawnMapStore()
    resource_manager = ResourceManager(PROJECT_ROOT, seed_link, pokemon_assets, local_engine.status)
    board_flasher = BoardFlasher(PROJECT_ROOT, seed_link)
    update_service = UpdateService(PROJECT_ROOT, APP_VERSION, data_dir, cache_root)

    app.extensions["pla_settings_store"] = settings_store
    app.extensions["pla_seed_manager"] = seed_manager
    app.extensions["pla_local_engine"] = local_engine
    app.extensions["pla_pokemon_assets"] = pokemon_assets
    app.extensions["pla_engine_installer"] = engine_installer
    app.extensions["pla_seed_link"] = seed_link
    app.extensions["pla_resource_manager"] = resource_manager
    app.extensions["pla_spawn_maps"] = spawn_maps
    app.extensions["pla_update_service"] = update_service

    # Images used to live in %LOCALAPPDATA%; copy them into the tool cache once
    # so users can back up everything by copying a single folder. Do it in the
    # background: the app and calculations never depend on these images.
    def _migrate_image_cache() -> None:
        old = data_dir / "pokemon"
        new = cache_root / "pokemon-images"
        if not old.is_dir():
            return
        try:
            if any(path.is_file() for path in new.rglob("*")):
                shutil.rmtree(old, ignore_errors=True)
                return
            shutil.copytree(old, new, dirs_exist_ok=True)
            old_state = data_dir / "pokemon-assets-state.json"
            if old_state.is_file():
                shutil.copy2(old_state, new / "state.json")
            # The cache folder is now the only copy; keep the tool portable.
            shutil.rmtree(old, ignore_errors=True)
        except OSError:
            pass

    threading.Thread(target=_migrate_image_cache, name="image-cache-migration", daemon=True).start()

    @app.get("/user-assets/<kind>/<filename>")
    def serve_user_pokemon_asset(kind: str, filename: str):
        # Asset names are restricted by the manager's PNG filename allow-list.
        path = pokemon_assets.resolve_asset(kind, filename)
        if path is None:
            return jsonify({"ok": False, "error": "图片资源不存在。"}), 404
        return send_file(path, mimetype="image/png", conditional=True, max_age=3600)

    def json_error(message: str, status: int = 400, **extra):
        body = {"ok": False, "error": message}
        body.update(extra)
        return jsonify(body), status

    @app.get("/")
    def index():
        appearance = settings_store.public_view()
        return render_template(
            "index.html",
            appearance_theme=appearance.get("appearance_theme", "forest"),
            appearance_mode=appearance.get("appearance_mode", "light"),
            appearance_preferences_saved=appearance.get("appearance_preferences_saved", False),
            app_version=APP_VERSION,
            author_name=AUTHOR_NAME,
        )

    @app.get("/api/health")
    def health():
        engine_status = local_engine.status()
        return jsonify({
            "ok": True,
            "app": "PLA MMO Path Finder",
            "version": APP_VERSION,
            "host_policy": "127.0.0.1 only",
            "calculation_engine": engine_status["engine"],
            "local_engine_installed": engine_status["installed"],
            "local_engine_verified": engine_status["verified"],
            "network_required_for_calculation": False,
        })

    @app.get("/api/seed")
    def get_seed():
        return jsonify(seed_manager.snapshot())

    @app.post("/api/seed/reload")
    def reload_seed():
        body = request.get_json(silent=True) or {}
        result = seed_manager.reload(
            confirm=bool(body.get("confirm", False)),
            expected_seed=body.get("expected_seed"),
        )
        status = 200 if result.get("ok") else 400
        return jsonify(result), status

    @app.post("/api/seed/cancel-pending")
    def cancel_pending_seed():
        return jsonify(seed_manager.cancel_pending())

    @app.get("/api/link/status")
    def link_status():
        return jsonify(seed_link.snapshot())

    @app.post("/api/link/probe")
    def link_probe():
        body = request.get_json(silent=True) or {}
        return jsonify(seed_link.probe(force=bool(body.get("force", True))))

    @app.post("/api/link/start")
    def link_start():
        body = request.get_json(silent=True) or {}
        channel = body.get("channel", 6)
        seconds = body.get("seconds", 1800)
        exchange_name = str(body.get("exchange_name") or "seed").strip() or "seed"
        result = seed_link.start(str(body.get("code") or ""), channel, seconds, exchange_name)
        if result.get("ok"):
            # Remember the operator's channel/wait/name choice for the next session.
            try:
                settings_store.update({
                    "link_channel": int(channel),
                    "link_seconds": int(seconds),
                    "link_exchange_name": exchange_name,
                })
            except (TypeError, ValueError, OSError):
                pass
        status = 200 if result.get("ok") else 400
        return jsonify(result), status

    @app.post("/api/link/stop")
    def link_stop():
        try:
            result = seed_link.stop()
        except Exception as exc:
            app.logger.exception("link stop failed")
            result = {"ok": False, "error": f"停止失败：{exc}"}
        return jsonify(result)

    @app.post("/api/link/solve-last")
    def link_solve_last():
        result = seed_link.solve_last()
        status = 200 if result.get("ok") else 400
        return jsonify(result), status

    @app.get("/api/link/pokemon-image/<int:index>")
    def link_pokemon_image(index: int):
        path = seed_link.pokemon_image(index)
        if path is None:
            return "", 404
        return send_file(path, conditional=True, max_age=0)

    @app.post("/api/link/choose-keys")
    def link_choose_keys():
        body = request.get_json(silent=True) or {}
        path = str(body.get("path") or "").strip()
        if not path:
            try:
                path = _open_keys_file_dialog()
            except Exception as exc:
                return json_error("无法打开系统文件选择窗口。", 500, detail=str(exc))
            if not path:
                return jsonify({"ok": True, "cancelled": True, **seed_link.snapshot()})
        result = seed_link.choose_keys(path)
        status = 200 if result.get("ok") else 400
        return jsonify(result), status

    @app.post("/api/seed/select")
    def select_seed_file():
        body = request.get_json(silent=True) or {}
        path = str(body.get("path", "")).strip()

        if not path:
            try:
                path = _open_txt_file_dialog()
            except Exception as exc:
                return json_error(
                    "无法打开系统文件选择窗口。可以在设置中直接粘贴 TXT 完整路径。",
                    500,
                    detail=str(exc),
                )
            if not path:
                return jsonify({"ok": True, "cancelled": True, **seed_manager.snapshot()})

        result = seed_manager.select_file(path, confirm=bool(body.get("confirm", False)))
        status = 200 if result.get("ok") else 400
        return jsonify(result), status

    @app.post("/api/seed/manual")
    def set_manual_seed():
        body = request.get_json(silent=True) or {}
        result = seed_manager.set_manual_seed(
            body.get("seed", ""),
            confirm=bool(body.get("confirm", False)),
        )
        status = 200 if result.get("ok") else 400
        return jsonify(result), status

    @app.get("/api/resources")
    def resources_status():
        return jsonify(resource_manager.snapshot())

    @app.post("/api/resources/install")
    def resources_install():
        body = request.get_json(silent=True) or {}
        result = resource_manager.install(str(body.get("id") or ""))
        status = 200 if result.get("ok") else 400
        return jsonify(result), status

    @app.post("/api/resources/open-folder")
    def resources_open_folder():
        body = request.get_json(silent=True) or {}
        result = resource_manager.open_folder(str(body.get("id") or ""))
        status = 200 if result.get("ok") else 400
        return jsonify(result), status

    @app.post("/api/resources/open-project")
    def resources_open_project():
        body = request.get_json(silent=True) or {}
        result = resource_manager.open_project(str(body.get("id") or ""))
        status = 200 if result.get("ok") else 400
        return jsonify(result), status

    @app.post("/api/resources/open-cache")
    def resources_open_cache():
        result = resource_manager.open_cache()
        status = 200 if result.get("ok") else 400
        return jsonify(result), status

    @app.errorhandler(413)
    def upload_too_large(_error):
        return jsonify({
            "ok": False,
            "error": "上传文件太大。",
            "hint": "更新包上限为 512 MB；请选择便携 ZIP 或 Setup.exe。",
        }), 413

    @app.get("/api/update/check")
    def update_check():
        force = str(request.args.get("force") or "").lower() in {"1", "true", "yes"}
        auto = str(request.args.get("auto") or "").lower() in {"1", "true", "yes"}
        return jsonify(update_service.check(force=force, auto=auto))

    @app.get("/api/update/status")
    def update_status():
        return jsonify(update_service.snapshot())

    @app.post("/api/update/skip")
    def update_skip():
        body = request.get_json(silent=True) or {}
        return jsonify(update_service.skip(str(body.get("version") or "")))

    @app.post("/api/update/download")
    def update_download():
        body = request.get_json(silent=True) or {}
        kind = str(body.get("kind") or "").strip() or None
        result = update_service.start_download(kind)
        return jsonify(result)

    @app.post("/api/update/pause")
    def update_pause():
        return jsonify(update_service.pause_download())

    @app.get("/api/update/download/status")
    def update_download_status():
        return jsonify({"ok": True, "download": update_service.snapshot()["download"]})

    @app.post("/api/update/manual")
    def update_manual():
        storage = request.files.get("file")
        if storage is None or not storage.filename:
            return json_error("请选择一个更新包文件。", 400)
        try:
            result = update_service.stage_manual(storage)
        except UpdateError as exc:
            return jsonify({
                "ok": False,
                "error": str(exc),
                "hint": exc.hint,
                "detail": exc.detail,
            }), 400
        return jsonify(result)

    @app.post("/api/update/install")
    def update_install():
        body = request.get_json(silent=True) or {}
        try:
            result = update_service.install(
                str(body.get("token") or ""),
                str(body.get("kind") or ""),
            )
        except UpdateError as exc:
            return jsonify({
                "ok": False,
                "error": str(exc),
                "hint": exc.hint,
                "detail": exc.detail,
            }), 400
        return jsonify(result)

    @app.post("/api/update/open-release")
    def update_open_release():
        try:
            webbrowser.open(update_service.snapshot().get("check", {}).get("release_url") or "https://github.com/junlifun/PLA-MMO-Seed-Path/releases/latest")
        except Exception as exc:
            return json_error(f"无法打开浏览器：{exc}", 500)
        return jsonify({"ok": True})

    @app.post("/api/update/open-folder")
    def update_open_folder():
        folder = update_service.update_dir
        folder.mkdir(parents=True, exist_ok=True)
        try:
            os.startfile(str(folder))  # type: ignore[attr-defined]
        except Exception as exc:
            return json_error(f"无法打开更新目录：{exc}", 500)
        return jsonify({"ok": True, "path": str(folder)})

    @app.get("/api/update/cleanup")
    def update_cleanup_targets():
        return jsonify({
            "ok": True,
            "data_dir": str(data_dir),
            "targets": update_service.cleanup_targets(),
        })

    @app.post("/api/update/cleanup")
    def update_cleanup():
        body = request.get_json(silent=True) or {}
        keys = body.get("keys")
        if not isinstance(keys, list):
            return json_error("请选择要清理的项目。", 400)
        if len(keys) > 32:
            return json_error("清理项目过多。", 400)
        return jsonify(update_service.cleanup([str(key) for key in keys]))

    @app.get("/api/settings")
    def get_settings():
        return jsonify(settings_store.public_view())

    @app.put("/api/settings")
    def update_settings():
        body = request.get_json(silent=True) or {}
        try:
            settings_store.update(body)
        except ValueError as exc:
            return json_error(str(exc), 400)
        except OSError as exc:
            _append_runtime_error("保存用户设置失败", exc)
            return json_error(
                "设置保存失败。请检查用户配置目录的写入权限和磁盘空间；原有设置已尽可能保留。",
                500,
            )
        return jsonify({"ok": True, "settings": settings_store.public_view(), "saved": True})

    @app.get("/api/pokemon-assets/status")
    def pokemon_assets_status():
        return jsonify(pokemon_assets.status())

    @app.post("/api/pokemon-assets/check")
    def pokemon_assets_check():
        return jsonify({**pokemon_assets.status(), "checked": True})

    @app.post("/api/pokemon-assets/choice")
    def pokemon_assets_choice():
        body = request.get_json(silent=True) or {}
        try:
            return jsonify(pokemon_assets.set_choice(str(body.get("choice", ""))))
        except ValueError as exc:
            return json_error(str(exc), 400)

    @app.post("/api/pokemon-assets/download")
    def pokemon_assets_download():
        return jsonify(pokemon_assets.set_choice("download"))

    @app.get("/api/pokemon-assets/progress")
    def pokemon_assets_progress():
        return jsonify(pokemon_assets.status())

    @app.post("/api/pokemon-assets/open-folder")
    def pokemon_assets_open_folder():
        return jsonify(pokemon_assets.open_custom_folder())

    @app.get("/api/board/status")
    def board_status():
        probe = {}
        if str(request.args.get("probe", "")).lower() in {"1", "true", "yes"}:
            try:
                probe = seed_link.probe(force=False)
            except Exception as exc:  # noqa: BLE001 - board status must stay available
                probe = {"ok": False, "error": str(exc), "ports": [], "board": None}
        return jsonify(board_flasher.status(probe=probe))

    @app.post("/api/board/flash")
    def board_flash():
        body = request.get_json(silent=True) or {}
        try:
            return jsonify(board_flasher.start(str(body.get("port") or "")))
        except BoardFlashError as exc:
            return json_error(str(exc), 400)

    @app.get("/api/board/flash/status")
    def board_flash_status():
        return jsonify({"ok": True, "flash": board_flasher.snapshot()})

    @app.get("/api/engine")
    def get_engine_status():
        return jsonify({"ok": True, **local_engine.status()})

    @app.get("/api/engine/guide")
    def get_engine_guide():
        return jsonify(engine_installer.guide())

    @app.post("/api/engine/install")
    def install_engine():
        body = request.get_json(silent=True) or {}
        mode = str(body.get("mode") or "auto").strip().lower()
        if mode not in {"auto", "zip"}:
            return json_error("不支持的安装方式。", 400)
        zip_path = str(body.get("zip_path") or "").strip() or None
        result = engine_installer.start(mode=mode, zip_path=zip_path)
        return jsonify(result), (200 if result.get("ok") else 400)

    @app.get("/api/engine/install-status")
    def engine_install_status():
        return jsonify(engine_installer.snapshot())

    @app.post("/api/engine/open-folder")
    def open_engine_folder():
        return jsonify(engine_installer.open_folder())

    @app.post("/api/engine/open-upstream")
    def open_engine_upstream():
        return jsonify(engine_installer.open_upstream())

    @app.post("/api/engine/choose-zip")
    def choose_engine_zip():
        try:
            path = _open_zip_file_dialog()
        except Exception as exc:
            return json_error(
                "无法打开文件选择窗口。可以把 ZIP 的完整路径直接粘贴到输入框。",
                500,
                detail=str(exc),
            )
        return jsonify({"ok": True, "path": path or ""})

    @app.get("/api/species")
    def get_species():
        try:
            data = local_engine.load_species()
            return jsonify({"ok": True, **data})
        except LocalEngineError as exc:
            return json_error(str(exc), 503)

    @app.get("/api/pokemon-catalog")
    def get_pokemon_catalog():
        try:
            return jsonify({"ok": True, **local_engine.load_research_catalog()})
        except LocalEngineError as exc:
            return json_error(str(exc), 503)

    @app.post("/api/calculate")
    def calculate():
        body = request.get_json(silent=True) or {}
        seed = seed_manager.current_seed
        if not seed:
            return json_error(
                "当前没有可用 Seed。请先设置 TXT 文件来源，刷新文件，或手动输入 Seed。",
                400,
            )

        try:
            params = build_calculation_params(body, settings_store.load())
        except ValueError as exc:
            return json_error(str(exc), 400)

        try:
            result = calculate_mmo_path(local_engine, seed, params)
            return jsonify({
                "ok": True,
                "seed": seed,
                "summary": result["summary"],
                "results": result["results"],
                "engine": result["engine"],
                "params": params,
            })
        except (LocalEngineError, ValueError) as exc:
            if isinstance(exc, LocalEngineError):
                _append_runtime_error(
                    "本地 RNG 引擎计算失败",
                    exc,
                    {"seed": seed, "params": params},
                )
            else:
                _append_runtime_error(
                    "计算参数校验失败",
                    exc,
                    {"seed": seed, "params": params},
                )
            status_code = 503 if isinstance(exc, LocalEngineError) else 400
            return json_error(
                str(exc),
                status_code,
                seed=seed,
                note="计算失败时没有生成或替代任何结果；计算由本地引擎执行，不会向远程 API 发送 Seed。",
            )
        except Exception as exc:
            _append_runtime_error(
                "计算时发生未预期错误",
                exc,
                {"seed": seed, "params": params},
            )
            app.logger.exception("Unexpected calculation error")
            return json_error(
                "计算时发生未预期错误。详细信息已写入 runtime_errors.log。",
                500,
                seed=seed,
            )

    @app.get("/api/spawns/catalog")
    def spawns_catalog():
        return jsonify({"ok": True, **spawn_catalog()})

    @app.get("/api/spawns/spawners")
    def spawns_spawners():
        return jsonify({
            "ok": True,
            "spawners": spawner_names(
                str(request.args.get("map", "")),
                str(request.args.get("species", "")),
            ),
        })

    @app.get("/api/spawns/maps")
    def spawns_maps():
        return jsonify(spawn_maps.catalog())

    @app.get("/api/spawns/map-image/<map_key>")
    def spawns_map_image(map_key: str):
        path = spawn_maps.image_path(map_key)
        if path is None:
            return "", 404
        return send_file(path, conditional=True, max_age=0)

    @app.post("/api/spawns/bind")
    def spawns_bind():
        body = request.get_json(silent=True) or {}
        result = spawn_maps.bind(
            str(body.get("point_id") or ""),
            str(body.get("spawner") or ""),
        )
        return jsonify(result), (200 if result.get("ok") else 400)

    @app.post("/api/spawn")
    def spawn_calculate():
        body = request.get_json(silent=True) or {}
        seed = str(body.get("seed") or "").strip() or (seed_manager.current_seed or "")
        settings = settings_store.load()
        species_key = str(body.get("species") or "").strip()
        species_key = re.sub(r"^Alpha\s*", "", species_key, flags=re.I)
        try:
            level = _configured_research_level(species_key, settings)
            shiny_charm = bool(settings.get("default_shiny_charm", True))
            rolls = 1 + RESEARCH_BONUS_ROLLS.get(level, 1) + (3 if shiny_charm else 0)
            result = calculate_spawn(
                seed=seed,
                map_key=str(body.get("map") or ""),
                species=str(body.get("species") or ""),
                spawner=str(body.get("spawner") or ""),
                is_night=bool(body.get("is_night", False)),
                static_alpha=bool(body.get("static_alpha", True)),
                fixed_gender=bool(body.get("fixed_gender", False)),
                rolls=rolls,
                gender_ratio=str(body.get("gender_ratio") or "1:1"),
            )
        except ValueError as exc:
            return json_error(str(exc), 400)
        except LocalEngineError as exc:
            _append_runtime_error("单体生成点计算失败", exc, {"body": body})
            return json_error(str(exc), 503)
        return jsonify({
            "ok": True,
            **result,
            "rolls": rolls,
            "research_level": level,
            "shiny_charm": shiny_charm,
        })

    @app.get("/api/multi/catalog")
    def multi_catalog_route():
        return jsonify({"ok": True, **multi_catalog()})

    @app.post("/api/multi/check")
    def multi_check_route():
        body = request.get_json(silent=True) or {}
        seed = str(body.get("seed") or "").strip() or (seed_manager.current_seed or "")
        settings = settings_store.load()
        try:
            level = _configured_research_level("", settings)
            shiny_charm = bool(settings.get("default_shiny_charm", True))
            rolls = 1 + RESEARCH_BONUS_ROLLS.get(level, 1) + (3 if shiny_charm else 0)
            result = calculate_multi(
                seed=seed,
                group_id=str(body.get("group_id") or ""),
                maxalive=int(body.get("maxalive") or 2),
                maxdepth=int(body.get("maxdepth") or 9),
                is_night=bool(body.get("is_night", False)),
                filter_key=str(body.get("filter") or "is_shiny"),
                rolls=rolls,
            )
        except (TypeError, ValueError) as exc:
            return json_error(str(exc), 400)
        return jsonify(result)


    @app.get("/api/diagnostics")
    def get_diagnostics():
        try:
            engine_status = local_engine.status()
        except Exception as exc:
            engine_status = {"error": f"{type(exc).__name__}: {exc}"}
            _append_runtime_error("读取本地引擎状态失败", exc)

        lines = [
            "PLA MMO 闪光路径助手 - 诊断报告",
            f"报告生成时间：{datetime.now().astimezone().isoformat(timespec='seconds')}",
            f"应用版本：{APP_VERSION}",
            f"作者：{AUTHOR_NAME}",
            f"Python：{sys.version.replace(chr(10), ' ')}",
            f"平台：{platform.platform()}",
            f"项目目录：{PROJECT_ROOT}",
            f"本地引擎状态：{json.dumps(engine_status, ensure_ascii=False, default=str)}",
            f"联机测 Seed 环境：{json.dumps(seed_link.environment(), ensure_ascii=False, default=str)}",
            f"用户配置状态：{json.dumps(settings_store.diagnostics(), ensure_ascii=False, default=str)}",
        ]
        log_root = get_log_dir() if getattr(sys, "frozen", False) else PROJECT_ROOT
        log_files = [
            ("runtime_errors.log（运行时错误和 traceback）", RUNTIME_ERROR_LOG),
            ("app-console.log（桌面版启动与标准输出）", log_root / "app-console.log"),
            ("offline_engine_setup.log（依赖、下载和引擎安装日志）", log_root / "offline_engine_setup.log"),
        ]
        paths = {}
        for label, path in log_files:
            paths[label] = str(path)
            lines.extend(["", f"--- {label} | {path} ---", _tail_text(path)])
        report = "\n".join(lines)
        return jsonify({"ok": True, "report": report, "log_paths": paths})


    return app


def _open_txt_file_dialog() -> str:
    # This dialog is intentionally local-only. The app binds to 127.0.0.1.
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    try:
        root.attributes("-topmost", True)
    except Exception:
        pass
    try:
        chosen = filedialog.askopenfilename(
            title="选择包含 Seed 的 TXT 文件",
            filetypes=[("TXT 文件", "*.txt"), ("所有文件", "*.*")],
        )
        return chosen or ""
    finally:
        root.destroy()


def _open_zip_file_dialog() -> str:
    """Pick an upstream source ZIP the user downloaded themselves."""
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    try:
        root.attributes("-topmost", True)
    except Exception:
        pass
    try:
        chosen = filedialog.askopenfilename(
            title="选择上游源码 ZIP（pla-multi-checker-web）",
            filetypes=[("ZIP 压缩包", "*.zip"), ("所有文件", "*.*")],
        )
        return chosen or ""
    finally:
        root.destroy()


def _open_keys_file_dialog() -> str:
    """Pick the user's own Switch prod.keys file for the link collector."""
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    try:
        root.attributes("-topmost", True)
    except Exception:
        pass
    try:
        chosen = filedialog.askopenfilename(
            title="选择你自己的 prod.keys（Switch 密钥）",
            filetypes=[("prod.keys", "prod.keys"), ("所有文件", "*.*")],
        )
        return chosen or ""
    finally:
        root.destroy()


def _wait_for_local_server(url: str, timeout_seconds: float = 18.0) -> bool:
    """Wait until Flask is ready before opening the embedded desktop view."""
    import time
    from urllib.request import urlopen

    deadline = time.monotonic() + timeout_seconds
    health_url = f"{url}/api/health"
    while time.monotonic() < deadline:
        try:
            with urlopen(health_url, timeout=0.6) as response:
                if response.status == 200:
                    return True
        except Exception:
            time.sleep(0.12)
    return False



_WINDOW_ICON_HANDLES = []


def _apply_windows_app_icon(window_title: str, icon_path: Path) -> bool:
    """Apply the bundled .ico to the native WebView2 window on Windows.

    pywebview does not support a portable ``create_window(icon=...)`` argument,
    so use the Win32 WM_SETICON message after the native window is shown.
    """
    if os.name != "nt" or not icon_path.is_file():
        return False

    import ctypes
    import time
    from ctypes import wintypes

    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
        user32.FindWindowW.restype = wintypes.HWND
        user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
        user32.GetWindowTextLengthW.restype = ctypes.c_int
        user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        user32.GetWindowTextW.restype = ctypes.c_int

        hwnd = None
        for _ in range(12):
            hwnd = user32.FindWindowW(None, window_title)
            if hwnd:
                break

            found = []
            enum_proc_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

            @enum_proc_type
            def enum_callback(candidate, _lparam):
                length = user32.GetWindowTextLengthW(candidate)
                if length <= 0:
                    return True
                buffer = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(candidate, buffer, length + 1)
                if window_title in buffer.value:
                    found.append(candidate)
                    return False
                return True

            user32.EnumWindows.argtypes = [enum_proc_type, wintypes.LPARAM]
            user32.EnumWindows.restype = wintypes.BOOL
            user32.EnumWindows(enum_callback, 0)
            if found:
                hwnd = found[0]
                break
            time.sleep(0.2)

        if not hwnd:
            return False

        user32.LoadImageW.argtypes = [
            wintypes.HINSTANCE, wintypes.LPCWSTR, wintypes.UINT,
            ctypes.c_int, ctypes.c_int, wintypes.UINT,
        ]
        user32.LoadImageW.restype = wintypes.HANDLE
        hicon = user32.LoadImageW(
            None, str(icon_path), 1, 0, 0, 0x0010 | 0x0040
        )
        if not hicon:
            return False

        user32.SendMessageW.argtypes = [
            wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM
        ]
        user32.SendMessageW.restype = ctypes.c_ssize_t
        icon_handle = int(hicon)
        user32.SendMessageW(hwnd, 0x0080, 0, icon_handle)  # WM_SETICON / ICON_SMALL
        user32.SendMessageW(hwnd, 0x0080, 1, icon_handle)  # WM_SETICON / ICON_BIG
        _WINDOW_ICON_HANDLES.append(hicon)
        return True
    except Exception as exc:
        _append_runtime_error("设置桌面窗口图标失败", exc, {"icon_path": str(icon_path)})
        return False


def _edge_executable() -> Path | None:
    candidates = [
        Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
        Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
    ]
    for path in candidates:
        if path.is_file():
            return path
    return None


def _run_edge_app_window(app: Flask, url: str, port: int) -> None:
    """Run a standalone Edge ``--app`` window with the local UI.

    This is the packaged fallback when pythonnet/WebView2 cannot be loaded.  It
    still gives a single dedicated window with no tabs or address bar, instead
    of opening the user's normal browser.
    """
    from werkzeug.serving import make_server
    import time

    edge = _edge_executable()
    if edge is None:
        raise RuntimeError("未找到 Microsoft Edge，无法打开独立窗口。")
    profile = get_data_dir() / "webview2-profile"
    profile.mkdir(parents=True, exist_ok=True)

    server = make_server("127.0.0.1", port, app, threaded=True)
    thread = threading.Thread(target=server.serve_forever, name="pla-edge-server", daemon=True)
    thread.start()
    if not _wait_for_local_server(url):
        server.shutdown()
        server.server_close()
        raise RuntimeError(f"本地服务未能在规定时间内启动：{url}")

    # A windowed PyInstaller process has unusual inherited handles.  Launch
    # Edge through the shell's "start" command so the window is created by the
    # normal user shell, not by the frozen host process.
    args = [
        "cmd.exe", "/c", "start", "", str(edge),
        f"--app={url}",
        "--window-size=1440,900",
        f"--user-data-dir={profile}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-mode",
    ]
    subprocess.Popen(
        args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=0,
    )
    try:
        # msedge.exe often returns immediately while the actual browser window
        # lives in a child process.  Keep the local server alive until no Edge
        # process using this dedicated profile remains.
        import psutil

        token = str(profile).lower()
        time.sleep(5.0)
        while True:
            alive = False
            for proc in psutil.process_iter(["cmdline"]):
                try:
                    cmdline = " ".join(proc.info.get("cmdline") or []).lower()
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
                if token in cmdline:
                    alive = True
                    break
            if not alive:
                break
            time.sleep(1.0)
    finally:
        try:
            server.shutdown()
        finally:
            server.server_close()


def _run_desktop_window(app: Flask, url: str, port: int, development: bool = False) -> None:
    """Run Flask behind a native WebView2 window and always release its socket."""
    from pla_mmo.settings import get_data_dir
    from werkzeug.serving import make_server

    # Keep the WebView profile separate from Edge/Chrome while preserving app
    # preferences such as the selected theme between launches.
    webview_data_dir = get_data_dir() / "webview2-profile"
    webview_data_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("WEBVIEW2_USER_DATA_FOLDER", str(webview_data_dir))

    try:
        import webview
    except ImportError as exc:
        raise RuntimeError(
            "缺少 pywebview，无法启动独立应用窗口。请重新运行 启动.vbs 让启动器安装依赖。"
        ) from exc

    # app.run() does not expose a supported stop method for a server started in
    # another thread. Use Werkzeug's server object so closing the native window
    # can stop the listener and release its port deterministically.
    server = make_server("127.0.0.1", port, app, threaded=True)
    server_thread = threading.Thread(
        target=server.serve_forever,
        name="pla-local-web-server",
        daemon=True,
    )

    try:
        server_thread.start()
        if not _wait_for_local_server(url):
            raise RuntimeError(
                f"本地服务未能在规定时间内启动：{url}。请查看 startup.log 和 runtime_errors.log。"
            )

        # pywebview.create_window() has no cross-backend ``icon`` argument.
        # Passing one raises TypeError on supported pywebview versions and aborts
        # startup before the native window can be created. Keep window options to
        # documented arguments so the standalone window launches reliably.
        window_options = {
            "width": 1440,
            "height": 900,
            "min_size": (1000, 680),
            "resizable": True,
            "text_select": True,
            "zoomable": True,
            "confirm_close": False,
            "background_color": "#f4f4ed",
        }

        window_title = f"PLA MMO 闪光路径助手 v{APP_VERSION} · {AUTHOR_NAME}"
        window = webview.create_window(
            window_title,
            url,
            **window_options,
        )
        icon_path = PROJECT_ROOT / "static" / "app.ico"
        if os.name == "nt" and icon_path.is_file():
            # Apply the app's mountain logo to the native Windows title bar after
            # pywebview has created its HWND. Do not pass unsupported icon= kwargs.
            def apply_window_icon():
                if not _apply_windows_app_icon(window_title, icon_path):
                    _append_runtime_error(
                        "桌面窗口图标尚未应用",
                        context={"icon_path": str(icon_path), "window_title": window_title},
                    )

            try:
                window.events.shown += apply_window_icon
            except Exception:
                threading.Timer(1.0, apply_window_icon).start()

        try:
            # Explicitly select modern WebView2 on Windows. It has its own profile
            # and does not open or depend on the user's ordinary browser window.
            # When the last native window closes, pywebview returns from start().
            webview.start(gui="edgechromium", debug=development)
        except Exception as exc:
            import traceback
            traceback.print_exc()
            print(f"[WEBVIEW-ERROR] {type(exc).__name__}: {exc}", flush=True)
            _append_runtime_error("独立应用窗口启动失败", exc, {"url": url})
            raise RuntimeError(
                "独立窗口启动失败。请确认 Windows 已安装 Microsoft Edge WebView2 Runtime，"
                "然后重新启动程序。详细信息已写入运行日志。"
            ) from exc
    finally:
        # This also runs if startup fails after the listener was created. Closing
        # the socket alone is not enough: shutdown() tells serve_forever() to exit.
        try:
            if server_thread.is_alive():
                server.shutdown()
        except Exception as exc:
            _append_runtime_error(
                "关闭本地服务失败",
                exc,
                {"url": url, "port": port},
            )
        finally:
            try:
                server.server_close()
            except Exception as exc:
                _append_runtime_error(
                    "释放本地服务端口失败",
                    exc,
                    {"url": url, "port": port},
                )
            if server_thread.ident is not None:
                server_thread.join(timeout=5)
            if server_thread.is_alive():
                _append_runtime_error(
                    "本地服务线程未能在关闭后及时退出",
                    context={"url": url, "port": port},
                )


def _desktop_mode_enabled() -> bool:
    """Use a native WebView window by default on Windows.

    Source runs also get the native window now, so ``python app.py`` behaves
    like the normal launcher instead of silently opening a browser. Set
    ``PLA_BROWSER=1`` (or ``PLA_DEV=1``) for browser-based development.
    """
    if os.environ.get("PLA_BROWSER") == "1" or os.environ.get("PLA_DEV") == "1":
        return False
    if getattr(sys, "frozen", False):
        return True
    return os.name == "nt"


def _configure_frozen_streams() -> None:
    """Keep diagnostics available when PyInstaller launches a windowed EXE."""
    if not getattr(sys, "frozen", False):
        return
    log_path = get_log_dir() / "app-console.log"
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        if sys.stdout is None:
            sys.stdout = log_path.open("a", encoding="utf-8", buffering=1)
        if sys.stderr is None:
            sys.stderr = sys.stdout
    except OSError:
        # Runtime error logging remains a separate fallback path.
        pass


def _ensure_source_streams() -> None:
    """Give pythonw (no console) a real stdout/stderr before Flask starts.

    启动.vbs launches the source app with pythonw so no console window stays
    behind. pythonw sets sys.stdout to None, so without this every print and
    Werkzeug request log would be lost; append them to app-console.log instead.
    """
    if sys.stdout is not None and sys.stderr is not None:
        return
    path = PROJECT_ROOT / "app-console.log"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        handle = path.open("a", encoding="utf-8", buffering=1)
    except OSError:
        return
    if sys.stdout is None:
        sys.stdout = handle
    if sys.stderr is None:
        sys.stderr = sys.stdout


def _show_fatal_error(message: str) -> None:
    if not (getattr(sys, "frozen", False) and os.name == "nt"):
        return
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(
            None,
            message + f"\n\n日志目录：{get_log_dir()}",
            f"PLA MMO Path Finder v{APP_VERSION} - 启动失败",
            0x10,
        )
    except Exception:
        pass


if __name__ == "__main__":
    _configure_frozen_streams()
    if not getattr(sys, "frozen", False):
        _ensure_source_streams()
    app = create_app()
    development = os.environ.get("PLA_DEV") == "1"
    desktop_mode = _desktop_mode_enabled()
    requested_port = os.environ.get("PLA_PORT", "5000").strip() or "5000"
    try:
        preferred_port = int(requested_port)
        port = choose_local_port(preferred=preferred_port)
    except (OSError, ValueError) as exc:
        print(f"[ERROR] 无法选择本地端口：{exc}")
        raise SystemExit(2) from exc
    url = f"http://127.0.0.1:{port}"
    print("=" * 58)
    print(f"PLA MMO 闪光路径助手 v{APP_VERSION}")
    if port != preferred_port:
        print(f"检测到端口 {preferred_port} 不可用，已切换到空闲端口 {port}。")
        print("这通常表示旧版本仍在运行；本次会使用当前版本的新端口。")
    print(f"本地服务地址：{url}")
    print("仅监听 127.0.0.1，不对局域网或公网开放。")
    if getattr(sys, "frozen", False):
        print(f"桌面发行版；用户配置和日志保存在：{get_data_dir()}")
    else:
        print("源码模式：首次运行请先安装依赖，并运行 prepare_offline_engine.bat 准备本地计算引擎。")
    print("=" * 58)

    if desktop_mode:
        try:
            _run_desktop_window(app, url, port, development=development)
        except Exception as exc:
            # Last-resort fallback for a machine without Edge.  The packaged
            # build uses Edge's dedicated --app window above, so it does not
            # depend on the fragile pythonnet/WebView2 packaging path.
            print(f"[WARN] 独立窗口启动失败，改用浏览器：{exc}")
            _append_runtime_error("独立窗口启动失败，回退浏览器", exc, {"url": url})
            try:
                if os.environ.get("PLA_NO_BROWSER") != "1" and (not development or os.environ.get("WERKZEUG_RUN_MAIN") == "true"):
                    threading.Timer(1.0, lambda: webbrowser.open(url)).start()
                app.run(
                    host="127.0.0.1",
                    port=port,
                    debug=development,
                    use_reloader=False,
                    threaded=True,
                )
            except Exception as fallback_exc:
                print(f"[ERROR] {fallback_exc}")
                _show_fatal_error(str(fallback_exc))
                raise SystemExit(3) from fallback_exc
    else:
        if os.environ.get("PLA_NO_BROWSER") != "1" and (not development or os.environ.get("WERKZEUG_RUN_MAIN") == "true"):
            threading.Timer(1.0, lambda: webbrowser.open(url)).start()
        app.run(
            host="127.0.0.1",
            port=port,
            debug=development,
            use_reloader=development,
            threaded=True,
        )
