"""In-app installer for the local RNG engine.

The engine itself is not part of this repository: it is built from the upstream
GPL-3.0 project `capitalism-sudo/pla-multi-checker-web`. Before this module the
only way to obtain it was to run `prepare_offline_engine.bat` from a terminal,
which is invisible to users who reached the app through `启动.vbs` and saw a
failed calculation. This module exposes the same script to the UI with:

* the exact folder and file list the app expects,
* a one-click download + install that runs the script in the background,
* a "pick a ZIP you downloaded yourself" path for restricted networks,
* a log tail so the progress is visible instead of silent.
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
import webbrowser
import zipfile
from collections import deque
from pathlib import Path

UPSTREAM_REPO = "https://github.com/capitalism-sudo/pla-multi-checker-web"
UPSTREAM_ZIP_URLS = (
    "https://codeload.github.com/capitalism-sudo/pla-multi-checker-web/zip/refs/heads/main",
    "https://github.com/capitalism-sudo/pla-multi-checker-web/archive/refs/heads/main.zip",
)
SEEDHASHES_URL = "https://fifamvp.pythonanywhere.com/static/resources/seedhashes.json"

# Every entry the app checks before it reports the engine as installed.
REQUIRED_ENTRIES = (
    ("pla/checkmmo.py", "本地 MMO 计算代码"),
    ("app/__init__.py", "资源路径适配器"),
    ("static/resources/mmo_es.json", "遭遇表 mmo_es.json"),
    ("static/resources/mmopaths.json", "路径表 mmopaths.json"),
    ("static/resources/nonbonuspaths.json", "非奖励路径表 nonbonuspaths.json"),
    ("static/resources/seedhashes.json", "候选列表 seedhashes.json"),
)

MAX_LOG_LINES = 400


class EngineInstaller:
    """Run the vendoring script once and report its progress to the UI."""

    def __init__(self, project_root, engine_root=None, script_path=None, log_path=None):
        # Resolve once: the script path is handed to a subprocess whose cwd is
        # the project root, so a relative root would resolve twice.
        self.project_root = Path(project_root).resolve()
        self.engine_root = Path(engine_root or (self.project_root / "offline_engine")).resolve()
        self.script_path = Path(script_path or (self.project_root / "tools" / "prepare_offline_engine.py")).resolve()
        self.log_path = Path(log_path or (self.project_root / "offline_engine_setup.log")).resolve()

        self._lock = threading.Lock()
        self._state = "idle"  # idle | running | success | failed
        self._mode = ""
        self._error = ""
        self._started_at = None
        self._finished_at = None
        self._lines = deque(maxlen=MAX_LOG_LINES)
        self._thread = None
        self._temp_root = None

    # ------------------------------------------------------------------ guide
    def guide(self) -> dict:
        entries = []
        for relative, label in REQUIRED_ENTRIES:
            path = self.engine_root / relative
            entries.append({
                "path": relative,
                "label": label,
                "exists": path.is_file(),
                "absolute": str(path),
            })
        frozen = bool(getattr(sys, "frozen", False))
        return {
            "ok": True,
            "engine_root": str(self.engine_root),
            "project_root": str(self.project_root),
            "log_path": str(self.log_path),
            "script_path": str(self.script_path),
            "frozen": frozen,
            "auto_install_supported": self.script_path.is_file() and not frozen,
            "upstream_repo": UPSTREAM_REPO,
            "upstream_zip_urls": list(UPSTREAM_ZIP_URLS),
            "seedhashes_url": SEEDHASHES_URL,
            "entries": entries,
        }

    # ------------------------------------------------------------------ start
    def start(self, mode: str = "auto", zip_path: str | None = None) -> dict:
        with self._lock:
            if self._state == "running":
                return {"ok": True, "already_running": True, **self._snapshot_locked()}

            if not self.script_path.is_file():
                return {
                    "ok": False,
                    "error": "找不到安装脚本 tools/prepare_offline_engine.py。请使用「选择本地 ZIP 安装」，或按界面提示手动放置文件。",
                }
            if getattr(sys, "frozen", False):
                return {
                    "ok": False,
                    "error": "绿色版不包含安装脚本，请使用「选择本地 ZIP 安装」。",
                }

            if mode == "zip":
                if not zip_path:
                    return {"ok": False, "error": "请先选择一个上游源码 ZIP 文件。"}
                archive = Path(zip_path)
                if not archive.is_file():
                    return {"ok": False, "error": f"找不到文件：{archive}"}
                if archive.suffix.lower() != ".zip":
                    return {"ok": False, "error": "请选择 .zip 格式的上游源码包。"}

            self._state = "running"
            self._mode = mode
            self._error = ""
            self._lines.clear()
            self._started_at = time.time()
            self._finished_at = None
            self._thread = threading.Thread(
                target=self._run, args=(mode, zip_path), name="pla-engine-installer", daemon=True
            )
            self._thread.start()
            return {"ok": True, "started": True, **self._snapshot_locked()}

    # ------------------------------------------------------------------- run
    def _append(self, line: str) -> None:
        with self._lock:
            self._lines.append(line)

    def _run(self, mode: str, zip_path: str | None) -> None:
        try:
            source_dir = None
            if mode == "zip":
                source_dir = self._extract_zip(zip_path)
                self._append(f"已解压本地 ZIP：{zip_path}")

            command = [sys.executable, "-u", str(self.script_path)]
            if source_dir:
                command.append(str(source_dir))
            self._append("开始安装：" + " ".join(command))

            creation_flags = 0
            if os.name == "nt":
                creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            process = subprocess.Popen(
                command,
                cwd=str(self.project_root),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                creationflags=creation_flags,
            )
            if process.stdout is not None:
                for line in process.stdout:
                    self._append(line.rstrip())
            code = process.wait()
            if code == 0:
                with self._lock:
                    self._state = "success"
                    self._finished_at = time.time()
                self._append("安装脚本执行完成，正在等待程序重新验证引擎。")
            else:
                with self._lock:
                    self._state = "failed"
                    self._finished_at = time.time()
                    self._error = f"安装脚本退出码 {code}。请查看下方日志或 offline_engine_setup.log。"
        except Exception as exc:  # noqa: BLE001 - reported to the user verbatim
            with self._lock:
                self._state = "failed"
                self._finished_at = time.time()
                self._error = f"{type(exc).__name__}: {exc}"
            self._append(f"安装失败：{type(exc).__name__}: {exc}")
        finally:
            self._cleanup_temp()

    def _extract_zip(self, zip_path: str | None) -> str:
        self._cleanup_temp()
        # Stage inside the project instead of the system temp folder: user temp
        # directories are sometimes locked down or on a small system drive, and
        # this keeps the whole install inside one known location.
        staging = self.project_root / ".engine-staging"
        if staging.exists():
            import shutil

            shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir(parents=True, exist_ok=True)
        self._temp_root = staging
        with zipfile.ZipFile(zip_path) as archive:
            archive.extractall(staging)
        for candidate in staging.rglob("checkmmo.py"):
            if candidate.parent.name == "pla" and (candidate.parent.parent / "static" / "resources").is_dir():
                return str(candidate.parent.parent)
        raise RuntimeError("ZIP 里找不到 pla/checkmmo.py 和 static/resources，可能不是上游源码包。")

    def _cleanup_temp(self) -> None:
        if self._temp_root is None:
            return
        try:
            import shutil

            shutil.rmtree(self._temp_root, ignore_errors=True)
        finally:
            self._temp_root = None

    # --------------------------------------------------------------- snapshot
    def _snapshot_locked(self) -> dict:
        elapsed = 0.0
        if self._started_at:
            end = self._finished_at or time.time()
            elapsed = round(end - self._started_at, 1)
        return {
            "state": self._state,
            "running": self._state == "running",
            "mode": self._mode,
            "error": self._error,
            "elapsed_seconds": elapsed,
            "log": list(self._lines),
            "log_path": str(self.log_path),
        }

    def snapshot(self) -> dict:
        with self._lock:
            return {"ok": True, **self._snapshot_locked()}

    # ------------------------------------------------------------------ misc
    def open_folder(self) -> dict:
        try:
            self.engine_root.mkdir(parents=True, exist_ok=True)
            if os.name != "nt":
                raise RuntimeError("该功能仅支持 Windows。")
            os.startfile(str(self.engine_root))  # noqa: S606 - local folder only
            return {"ok": True, "path": str(self.engine_root)}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"无法打开引擎文件夹：{type(exc).__name__}: {exc}"}

    def open_upstream(self) -> dict:
        try:
            webbrowser.open(UPSTREAM_REPO)
            return {"ok": True, "url": UPSTREAM_REPO}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"无法打开浏览器：{type(exc).__name__}: {exc}"}
