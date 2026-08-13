from __future__ import annotations

from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def fixtures_dir() -> Path:
    return FIXTURES


@pytest.fixture(autouse=True)
def _isolated_kiwi_data_dir(
    tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Keep the known-projects registry (and any other Kiwi-installation
    state) out of the real machine's app-data directory during tests."""
    monkeypatch.setenv("KIWI_DATA_DIR", str(tmp_path_factory.mktemp("kiwi-data")))
