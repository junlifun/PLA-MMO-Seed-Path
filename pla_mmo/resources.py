"""Downloadable resources for the path finder and the link collector.

Large third-party files live in the project's single ``cache/`` directory so a
user can back up or move the whole tool by copying one folder.  Nothing here is
bundled by the release package: a missing resource is downloaded from its
upstream GitHub release, verified, extracted, and reported to the settings page.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import threading
import time
import urllib.request
import zipfile
from datetime import datetime
from pathlib import Path

from pla_mmo.seed_link import PLUGIN_ID


POKELDN_VERSION = "v0.66.12"
POKELDN_ZIP_URL = (
    "https://github.com/junlifun/PLA-MMO-Seed-Path/releases/download/"
    "v0.9.5/pokeldn-slim-v0.66.12.zip"
)
POKELDN_ZIP_SHA256 = "6317e249c8896de2259468d41e751965fe76be64cc4e9044b6d38fa7b0c60a65"
POKELDN_ZIP_SIZE = 20_322_284

ETUMREP_VERSION = "v1.2.0"
ETUMREP_ZIP_URL = (
    "https://github.com/kwsch/EtumrepMMO/releases/download/"
    f"{ETUMREP_VERSION}/EtumrepMMO.ConsoleApp.1.2.0.zip"
)
ETUMREP_ZIP_SIZE = 27_607_463

FIRMWARE_VERSION = POKELDN_VERSION
FIRMWARE_URL = (
    "https://github.com/Decryptu/pokeldn/releases/download/"
    f"{FIRMWARE_VERSION}/pokeldn-radio-s3.bin"
)
FIRMWARE_SHA256 = "faab08c3344704418918b2d809bbefabdb724f498cc9d5fb98961fc62d2c1fd0"
FIRMWARE_SIZE = 783_216

USER_AGENT = "PLA-MMO-Path-Finder/0.9.5"


class ResourceError(RuntimeError):
    pass


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _find_marker(root: Path, marker: str) -> Path | None:
    direct = root / marker
    if direct.is_file():
        return direct
    for candidate in root.rglob(marker):
        if candidate.is_file():
            return candidate
    return None


class ResourceManager:
    def __init__(self, project_root: Path, seed_link, pokemon_assets, engine_status):
        self.project_root = Path(project_root).resolve()
        self.cache_root = self.project_root / "cache"
        self.download_dir = self.cache_root / "downloads"
        self.seed_link = seed_link
        self.pokemon_assets = pokemon_assets
        self.engine_status = engine_status

        self._lock = threading.RLock()
        self._states: dict[str, dict] = {}
        self._threads: dict[str, threading.Thread] = {}
        self._specs = self._build_specs()
        self.download_dir.mkdir(parents=True, exist_ok=True)

    # ----------------------------------------------------------------- specs
    def _build_specs(self) -> dict[str, dict]:
        return {
            "runtime": {
                "name": "Pokeldn 联机运行时",
                "summary": "精简源码运行时（下载约 20 MB，解压约 44 MB）；用于联机采集。",
                "target": self.cache_root / "pokeldn-slim",
                "marker": "pokeldn-slim/POKELDN-LICENSE.txt",
                "url": POKELDN_ZIP_URL,
                "sha256": POKELDN_ZIP_SHA256,
                "size": POKELDN_ZIP_SIZE,
                "version": POKELDN_VERSION,
                "project": "https://github.com/Decryptu/pokeldn",
                "required_for": "link",
                "kind": "zip",
            },
            "solver": {
                "name": "EtumrepMMO 求解器",
                "summary": "把四只 PA8 反推成 MMO 群体 Seed。",
                "target": self.cache_root / "etumrempmmo",
                "marker": "EtumrepMMO.ConsoleApp.1.2.0.exe",
                "url": ETUMREP_ZIP_URL,
                "sha256": "",
                "size": ETUMREP_ZIP_SIZE,
                "version": ETUMREP_VERSION,
                "project": "https://github.com/kwsch/EtumrepMMO",
                "required_for": "link",
                "kind": "zip",
            },
            "firmware": {
                "name": "ESP32-S3 无线固件",
                "summary": "换新板或固件损坏时使用；当前板已烧录。",
                "target": self.cache_root / "firmware" / "pokeldn-radio-s3.bin",
                "marker": "pokeldn-radio-s3.bin",
                "url": FIRMWARE_URL,
                "sha256": FIRMWARE_SHA256,
                "size": FIRMWARE_SIZE,
                "version": FIRMWARE_VERSION,
                "project": "https://github.com/Decryptu/pokeldn",
                "required_for": "",
                "kind": "file",
            },
            "keys": {
                "name": "prod.keys",
                "summary": "你自己 Switch 的密钥；不能从网上下载，也不会随工具分发。",
                "target": self.cache_root / "keys" / "prod.keys",
                "marker": "prod.keys",
                "url": "",
                "sha256": "",
                "size": 0,
                "version": "",
                "project": "",
                "required_for": "link",
                "kind": "user",
            },
        }

    # ---------------------------------------------------------------- status
    def _is_installed(self, key: str) -> bool:
        spec = self._specs[key]
        target = Path(spec["target"])
        if key == "keys":
            found, _ = self.seed_link.resolve_keys_path()
            return bool(found and found.is_file())
        if key == "firmware":
            return target.is_file() and target.stat().st_size > 0
        if key == "solver":
            if not target.is_dir():
                return False
            for pattern in ("EtumrepMMO.ConsoleApp.exe", "EtumrepMMO.exe", "EtumrepMMO*.exe"):
                if any(target.rglob(pattern)):
                    return True
            return False
        if key == "runtime":
            slim_marker = self.cache_root / "pokeldn-slim" / "pokeldn" / "__init__.py"
            return (target / "pokeldn.exe").is_file() or slim_marker.is_file()
        return target.exists()

    def _state(self, key: str) -> dict:
        with self._lock:
            return dict(self._states.get(key) or {
                "status": "idle", "percent": 0, "downloaded": 0,
                "total": 0, "message": "尚未开始", "error": "",
            })

    def _set_state(self, key: str, **changes) -> None:
        with self._lock:
            state = self._states.setdefault(key, {
                "status": "idle", "percent": 0, "downloaded": 0,
                "total": 0, "message": "尚未开始", "error": "",
            })
            state.update(changes)

    def snapshot(self) -> dict:
        resources = []
        missing_required = []
        for key, spec in self._specs.items():
            target = Path(spec["target"])
            installed = self._is_installed(key)
            state = self._state(key)
            display_target = target
            if key == "runtime":
                slim_dir = self.cache_root / "pokeldn-slim"
                if (slim_dir / "pokeldn" / "__init__.py").is_file():
                    display_target = slim_dir
            if key == "keys" and installed:
                found, _ = self.seed_link.resolve_keys_path()
                if found is not None:
                    display_target = found
            item = {
                "id": key,
                "name": spec["name"],
                "summary": spec["summary"],
                "installed": installed,
                "target": str(display_target),
                "exists": target.exists(),
                "download_url": spec["url"],
                "project_url": spec["project"],
                "sha256": spec["sha256"],
                "size": spec["size"],
                "version": spec["version"],
                "kind": spec["kind"],
                "required_for": spec["required_for"],
                "progress": state,
            }
            resources.append(item)
            if spec["required_for"] == "link" and not installed:
                missing_required.append({"id": key, "name": spec["name"]})
        engine = self.engine_status() if callable(self.engine_status) else {}
        images = self.pokemon_assets.status() if self.pokemon_assets is not None else {}
        return {
            "ok": True,
            "cache_root": str(self.cache_root),
            "resources": resources,
            "missing_required": missing_required,
            "engine": engine,
            "images": images,
            "download_dir": str(self.download_dir),
        }

    # -------------------------------------------------------------- download
    @staticmethod
    def _file_sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with Path(path).open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 256), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def _download(self, key: str, url: str, target: Path, expected_size: int = 0,
                  expected_sha: str = "") -> Path:
        target.parent.mkdir(parents=True, exist_ok=True)
        part = target.with_name(target.name + ".part")

        def sha256_file(path: Path) -> str:
            digest = hashlib.sha256()
            with path.open("rb") as source:
                for chunk in iter(lambda: source.read(1024 * 256), b""):
                    digest.update(chunk)
            return digest.hexdigest()

        offset = part.stat().st_size if part.exists() else 0
        if expected_size and offset > expected_size:
            part.unlink(missing_ok=True)
            offset = 0
        # A previous attempt may have finished the transfer and then failed while
        # extracting. Re-hash/reuse that complete part instead of downloading the
        # same large archive again.
        if offset and (not expected_size or offset == expected_size):
            if not expected_sha or sha256_file(part).lower() == expected_sha.lower():
                self._set_state(
                    key,
                    status="downloading",
                    downloaded=offset,
                    total=expected_size or offset,
                    percent=99,
                    message="使用已下载完成的文件…",
                    error="",
                )
                return part
            part.unlink(missing_ok=True)
            offset = 0

        digest = hashlib.sha256()
        if offset:
            with part.open("rb") as existing:
                for chunk in iter(lambda: existing.read(1024 * 256), b""):
                    digest.update(chunk)
        headers = {"User-Agent": USER_AGENT}
        if offset:
            headers["Range"] = f"bytes={offset}-"
        request = urllib.request.Request(url, headers=headers)
        downloaded = offset
        started = time.monotonic()
        with urllib.request.urlopen(request, timeout=60) as response:
            status = int(getattr(response, "status", 200) or 200)
            if offset and status != 206:
                # The server ignored Range; start over instead of appending to a
                # partial file that would no longer match the checksum.
                offset = 0
                downloaded = 0
                digest = hashlib.sha256()
            response_length = int(response.headers.get("Content-Length") or 0)
            total = expected_size or (downloaded + response_length if response_length else 0)
            mode = "ab" if offset else "wb"
            with part.open(mode) as output:
                self._set_state(
                    key,
                    status="downloading",
                    total=total,
                    downloaded=downloaded,
                    percent=min(99, int(downloaded * 100 / total)) if total else 0,
                    message=(
                        f"继续下载 {downloaded / 1024 / 1024:.1f} / {total / 1024 / 1024:.1f} MB"
                        if offset else "正在连接下载源…"
                    ),
                    error="",
                )
                while True:
                    chunk = response.read(1024 * 256)
                    if not chunk:
                        break
                    output.write(chunk)
                    digest.update(chunk)
                    downloaded += len(chunk)
                    percent = int(downloaded * 100 / total) if total else 0
                    speed = downloaded / max(0.1, time.monotonic() - started)
                    self._set_state(
                        key,
                        status="downloading",
                        downloaded=downloaded,
                        total=total,
                        percent=min(99, percent),
                        message=f"正在下载 {downloaded / 1024 / 1024:.1f} / {total / 1024 / 1024:.1f} MB · {speed / 1024 / 1024:.1f} MB/s",
                    )
        if expected_size and downloaded != expected_size:
            if downloaded < expected_size:
                # Keep the partial file so the next click can resume it.
                raise ResourceError(
                    f"下载未完成：得到 {downloaded} / {expected_size} 字节，可重试续传。"
                )
            part.unlink(missing_ok=True)
            raise ResourceError(f"下载大小不符：得到 {downloaded} 字节，预期 {expected_size} 字节。")
        if expected_sha:
            actual = sha256_file(part)
            if actual.lower() != expected_sha.lower():
                part.unlink(missing_ok=True)
                raise ResourceError("SHA256 校验失败，文件可能不完整或来源被篡改。")
        return part

    def _extract_zip(self, key: str, archive: Path, target: Path, marker: str) -> None:
        temp = target.with_name(target.name + f".tmp-{os.getpid()}")
        staged = target.with_name(target.name + f".new-{int(time.time())}")
        backup = target.with_name(target.name + f".old-{int(time.time())}")
        if temp.exists():
            shutil.rmtree(temp, ignore_errors=True)
        if staged.exists():
            shutil.rmtree(staged, ignore_errors=True)
        if backup.exists():
            shutil.rmtree(backup, ignore_errors=True)
        temp.mkdir(parents=True, exist_ok=True)
        self._set_state(key, status="extracting", percent=99, message="正在解压…")
        try:
            with zipfile.ZipFile(archive) as bundle:
                root = temp.resolve()
                for member in bundle.infolist():
                    destination = (temp / member.filename).resolve()
                    if destination != root and root not in destination.parents:
                        raise ResourceError(f"压缩包内存在非法路径：{member.filename}")
                bundle.extractall(temp)
            found = _find_marker(temp, marker)
            if found is None:
                raise ResourceError(f"压缩包内没有找到 {marker}。")
            source_root = found.parent
            staged.mkdir(parents=True, exist_ok=True)
            for item in source_root.iterdir():
                shutil.move(str(item), str(staged / item.name))
            if target.exists():
                target.rename(backup)
            try:
                staged.rename(target)
            except Exception:
                if backup.exists() and not target.exists():
                    backup.rename(target)
                raise
            shutil.rmtree(backup, ignore_errors=True)
        finally:
            shutil.rmtree(temp, ignore_errors=True)
            shutil.rmtree(staged, ignore_errors=True)

    def install(self, key: str) -> dict:
        spec = self._specs.get(key)
        if spec is None:
            return {"ok": False, "error": "未知资源。"}
        if spec["kind"] == "user":
            return {"ok": False, "error": "prod.keys 需要你自己选择并导入。"}
        with self._lock:
            thread = self._threads.get(key)
            if thread is not None and thread.is_alive():
                return {"ok": True, "already_running": True, "progress": self._state(key)}
            if self._is_installed(key):
                return {"ok": True, "installed": True, "message": "已经安装。"}
            self._states[key] = {
                "status": "starting", "percent": 0, "downloaded": 0,
                "total": spec["size"], "message": "准备下载…", "error": "",
            }
            thread = threading.Thread(target=self._install_worker, args=(key,), name=f"resource-{key}", daemon=True)
            self._threads[key] = thread
            thread.start()
        return {"ok": True, "started": True, "progress": self._state(key)}

    def _install_worker(self, key: str) -> None:
        spec = self._specs[key]
        target = Path(spec["target"])
        try:
            if spec["kind"] == "zip":
                archive = self.download_dir / f"{key}-{spec['version'].lstrip('v')}.zip"
                usable_archive = archive.is_file() and (
                    not spec["size"] or archive.stat().st_size == spec["size"]
                )
                if usable_archive and spec["sha256"]:
                    usable_archive = self._file_sha256(archive).lower() == spec["sha256"].lower()
                if usable_archive:
                    self._set_state(key, status="extracting", percent=99, message="使用已下载的压缩包…", error="")
                else:
                    archive.unlink(missing_ok=True)
                    part = self._download(key, spec["url"], archive, spec["size"], spec["sha256"])
                    os.replace(part, archive)
                self._extract_zip(key, archive, target, spec["marker"])
                if not self._is_installed(key):
                    raise ResourceError("安装后校验未通过：运行环境目录结构不完整。")
                archive.unlink(missing_ok=True)
            elif spec["kind"] == "file":
                target.parent.mkdir(parents=True, exist_ok=True)
                part = self._download(key, spec["url"], target, spec["size"], spec["sha256"])
                os.replace(part, target)
                if not self._is_installed(key):
                    raise ResourceError("安装后校验未通过：文件不存在或为空。")
            self._set_state(key, status="success", percent=100, message="安装完成。", error="")
        except Exception as exc:
            self._set_state(key, status="failed", percent=0, message="安装失败。", error=str(exc))

    # ---------------------------------------------------------------- folders
    def open_folder(self, key: str) -> dict:
        spec = self._specs.get(key)
        if spec is None:
            return {"ok": False, "error": "未知资源。"}
        target = Path(spec["target"])
        folder = target if target.is_dir() else target.parent
        if key == "runtime":
            slim_dir = self.cache_root / "pokeldn-slim"
            if (slim_dir / "pokeldn" / "__init__.py").is_file():
                folder = slim_dir
        try:
            folder.mkdir(parents=True, exist_ok=True)
            if os.name == "nt":
                os.startfile(str(folder))
            else:
                subprocess.Popen(["open" if os.uname().sysname == "Darwin" else "xdg-open", str(folder)])
        except OSError as exc:
            return {"ok": False, "error": f"无法打开文件夹：{exc}"}
        return {"ok": True, "path": str(folder)}

    def open_project(self, key: str) -> dict:
        spec = self._specs.get(key)
        if spec is None or not spec["project"]:
            return {"ok": False, "error": "该资源没有项目主页。"}
        try:
            import webbrowser
            webbrowser.open(spec["project"])
        except Exception as exc:
            return {"ok": False, "error": f"无法打开项目主页：{exc}"}
        return {"ok": True, "url": spec["project"]}

    def open_cache(self) -> dict:
        try:
            self.cache_root.mkdir(parents=True, exist_ok=True)
            if os.name == "nt":
                os.startfile(str(self.cache_root))
            else:
                subprocess.Popen(["open" if os.uname().sysname == "Darwin" else "xdg-open", str(self.cache_root)])
        except OSError as exc:
            return {"ok": False, "error": f"无法打开缓存目录：{exc}"}
        return {"ok": True, "path": str(self.cache_root)}
