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
    """Add or move ``root`` to the front of the registry."""
    resolved = str(root.resolve())
    entries = [e for e in list_known_projects() if e["path"] != resolved]
    entry = {"path": resolved, "name": root.stem}
    entries.insert(0, entry)
    _write_registry(entries[:_MAX_ENTRIES])
    return entry


def _write_registry(entries: list[Json]) -> None:
    _registry_path().write_text(json.dumps(entries, indent=2) + "\n", encoding="utf-8")
