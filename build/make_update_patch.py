#!/usr/bin/env python3
"""Create a file manifest and an adjacent-version update patch.

The full manifest is used only at build time.  A patch contains the files that
changed between two builds plus ``patch.json`` with enough hashes for the
updater to refuse to overwrite locally modified files.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import zipfile
from pathlib import Path

EXCLUDED_DIRS = {"cache", "__pycache__", ".git"}
EXCLUDED_FILES = {
    ".installed",
    "app-console.log",
    "runtime_errors.log",
    "update-state.json",
}
EXCLUDED_PREFIXES = ("unins",)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _included(relative: Path) -> bool:
    parts = relative.parts
    if any(part in EXCLUDED_DIRS for part in parts):
        return False
    if relative.name.lower() in EXCLUDED_FILES:
        return False
    if relative.suffix.lower() in {".pyc", ".pyo"}:
        return False
    if parts and parts[0].lower().startswith(EXCLUDED_PREFIXES):
        return False
    return True


def build_manifest(root: Path, version: str) -> dict:
    files = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        if not _included(relative):
            continue
        files.append(
            {
                "path": relative.as_posix(),
                "size": path.stat().st_size,
                "sha256": _sha256(path),
            }
        )
    return {"version": version, "files": files}


def _write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def make_patch(root: Path, current: dict, previous: dict, output: Path, info_path: Path) -> dict:
    previous_files = {
        str(item.get("path")): item
        for item in previous.get("files", [])
        if isinstance(item, dict) and item.get("path")
    }
    current_files = {str(item["path"]): item for item in current["files"]}
    changed = []
    for relative, item in current_files.items():
        old = previous_files.get(relative)
        if old and old.get("sha256") == item["sha256"] and old.get("size") == item["size"]:
            continue
        changed.append(
            {
                "path": relative,
                "action": "replace" if old else "add",
                "size": item["size"],
                "sha256": item["sha256"],
                "source_sha256": str(old.get("sha256")) if old else None,
            }
        )
    deleted = [
        {
            "path": relative,
            "action": "delete",
            "size": 0,
            "sha256": None,
            "source_sha256": str(old.get("sha256")),
        }
        for relative, old in previous_files.items()
        if relative not in current_files
    ]
    changed.sort(key=lambda item: item["path"])
    deleted.sort(key=lambda item: item["path"])
    patch_info = {
        "base_version": str(previous.get("version") or ""),
        "version": str(current.get("version") or ""),
        "files": changed + deleted,
    }

    output.parent.mkdir(parents=True, exist_ok=True)
    output.unlink(missing_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        archive.writestr(
            "patch.json",
            json.dumps(patch_info, ensure_ascii=False, indent=2) + "\n",
        )
        for item in changed:
            archive.write(root / item["path"], item["path"])

    patch_info.update(
        {
            "name": output.name,
            "size": output.stat().st_size,
            "sha256": _sha256(output),
            "url": "",
        }
    )
    _write_json(info_path, patch_info)
    return patch_info


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--previous-manifest", default="")
    parser.add_argument("--patch", default="")
    parser.add_argument("--info", default="")
    args = parser.parse_args()

    root = Path(args.root)
    if not root.is_dir():
        raise SystemExit(f"package root not found: {root}")
    current = build_manifest(root, args.version)
    _write_json(Path(args.manifest), current)

    if args.previous_manifest and args.patch and args.info:
        previous = json.loads(Path(args.previous_manifest).read_text(encoding="utf-8-sig"))
        info = make_patch(root, current, previous, Path(args.patch), Path(args.info))
        print(
            f"patch {info['base_version']} -> {info['version']}: "
            f"{len(info['files'])} file(s), {info['size']} bytes, {info['sha256']}"
        )
    else:
        print(f"manifest {args.version}: {len(current['files'])} file(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
