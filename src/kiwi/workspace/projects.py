"""Known-project registry.

A launcher-style UI needs a persisted list of project paths rather than
one re-entered every time. This lives in the platform data directory,
outside any project, since it is Kiwi-installation state, not workspace
data. It is not part of the workspace format.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import platformdirs

from kiwi.types import Json

_REGISTRY_FILE = "projects.json"
_MAX_ENTRIES = 50


def _registry_path() -> Path:
    # KIWI_DATA_DIR overrides the platform default, keeping the registry
    # at a specific location instead of the platform's app-data directory.
    override = os.environ.get("KIWI_DATA_DIR")
    config_dir = Path(override) if override else Path(platformdirs.user_data_dir("kiwi"))
    config_dir.mkdir(parents=True, exist_ok=True)
    return config_dir / _REGISTRY_FILE


def list_known_projects() -> list[Json]:
    """Registered projects, most recently opened first. Entries whose
    folder no longer exists are pruned automatically."""
    path = _registry_path()
    if not path.exists():
        return []
    entries: list[Json] = json.loads(path.read_text(encoding="utf-8"))
    existing = [e for e in entries if Path(e["path"]).exists()]
    if len(existing) != len(entries):
        _write_registry(existing)
    return existing


def register_project(root: Path) -> Json:
    """Add or move ``root`` to the front of the registry.

    A name already recorded is kept: opening a project is not a rename.
    The default name is read off the resolved path rather than the one
    supplied, so a project reached by typing its folder in a different
    case is still called what the folder is called.
    """
    resolved = root.resolve()
    path = str(resolved)
    entries = list_known_projects()
    recorded = next((e.get("name") for e in entries if e["path"] == path), None)
    entry = {"path": path, "name": recorded or resolved.stem}
    remaining = [e for e in entries if e["path"] != path]
    remaining.insert(0, entry)
    _write_registry(remaining[:_MAX_ENTRIES])
    return entry


def forget_project(root: Path) -> bool:
    """Drop ``root`` from the registry. The folder is left alone.

    Returns whether an entry was removed.
    """
    resolved = str(root.resolve())
    entries = list_known_projects()
    kept = [e for e in entries if e["path"] != resolved]
    if len(kept) == len(entries):
        return False
    _write_registry(kept)
    return True


def forget_all_projects() -> int:
    """Empty the registry. Returns how many entries were dropped."""
    count = len(list_known_projects())
    _write_registry([])
    return count


def rename_project(root: Path, name: str) -> Json:
    """Rename a project in the registry and in its own manifest.

    The folder keeps its name on disk: a project is identified by where
    it is, and moving it is the filesystem's business rather than this
    application's.
    """
    resolved = Path(root).resolve()
    manifest_path = resolved / "kiwi.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["name"] = name
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    entries = list_known_projects()
    entry = {"path": str(resolved), "name": name}
    for i, existing in enumerate(entries):
        if existing["path"] == entry["path"]:
            entries[i] = entry
            break
    else:
        entries.insert(0, entry)
    _write_registry(entries)
    return entry


def _write_registry(entries: list[Json]) -> None:
    _registry_path().write_text(json.dumps(entries, indent=2) + "\n", encoding="utf-8")
