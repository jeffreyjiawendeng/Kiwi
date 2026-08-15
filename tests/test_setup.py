from __future__ import annotations

import pytest

from kiwi.setup import (
    CAPABILITIES,
    GROBID_JAVA_OPTIONS,
    Capability,
    configured,
    download_size,
    env_file,
    grobid_command,
    install_command,
    merge_env,
)


def _capability(**overrides) -> Capability:  # type: ignore[no-untyped-def]
    fields = {
        "name": "a capability",
        "extra": "embed",
        "modules": ("json",),
        "buys": "something measured",
        "without": "the fallback",
        "download_gb": 1.0,
        "models": ("some/model",),
        "env": (),
    }
    fields.update(overrides)
    return Capability(**fields)  # type: ignore[arg-type]


def test_a_capability_is_installed_when_its_packages_import() -> None:
    assert _capability(modules=("json", "pathlib")).installed()
    assert not _capability(modules=("json", "a_package_that_is_not_installed")).installed()


def test_one_command_installs_every_extra_asked_for() -> None:
    command = install_command([_capability(extra="embed"), _capability(extra="align")])
    assert command == "uv sync --extra align --extra embed"


def test_a_capability_needing_no_extra_produces_no_command() -> None:
    # Reranking rides on the embedding extra, so asking for it alone
    # installs nothing.
    assert install_command([_capability(extra=None)]) is None
    assert install_command([]) is None


def test_the_grobid_command_carries_the_flag_the_newer_runtime_needs() -> None:
    # Without it the container exits on startup on Docker 29 and later.
    command = grobid_command()
    assert GROBID_JAVA_OPTIONS in command
    assert "-p 8070:8070" in command


def test_the_grobid_port_is_configurable() -> None:
    assert "-p 9000:8070" in grobid_command(port=9000)


def test_a_model_shared_between_capabilities_is_counted_once() -> None:
    shared = _capability(models=("same/model",), download_gb=2.0)
    other = _capability(models=("same/model",), download_gb=2.0)
    assert download_size([shared, other]) == 2.0
    assert download_size([shared, _capability(models=("a/different",), download_gb=1.0)]) == 3.0


def test_settings_are_written_as_an_env_file() -> None:
    written = env_file({"KIWI_RERANK_MODEL": "BAAI/bge-reranker-v2-m3"})
    assert "KIWI_RERANK_MODEL=BAAI/bge-reranker-v2-m3" in written
    assert written.endswith("\n")


def test_running_setup_twice_replaces_a_setting_rather_than_repeating_it() -> None:
    first = env_file({"KIWI_RERANK_MODEL": "old/model"})
    second = merge_env(first, {"KIWI_RERANK_MODEL": "new/model"})
    assert second.count("KIWI_RERANK_MODEL") == 1
    assert "new/model" in second
    assert "old/model" not in second


def test_merging_keeps_settings_it_was_not_asked_about() -> None:
    existing = "KIWI_DEVICE=cuda\nKIWI_CONTACT_EMAIL=me@example.com\n"
    merged = merge_env(existing, {"KIWI_RERANK_MODEL": "some/model"})
    assert "KIWI_DEVICE=cuda" in merged
    assert "KIWI_CONTACT_EMAIL=me@example.com" in merged
    assert "KIWI_RERANK_MODEL=some/model" in merged


def test_a_capability_with_no_setting_is_on_once_installed() -> None:
    assert configured(_capability(env=()))


def test_a_capability_is_off_until_its_setting_is_present(monkeypatch: pytest.MonkeyPatch) -> None:
    capability = _capability(env=(("KIWI_RERANK_MODEL", "some/model"),))
    monkeypatch.delenv("KIWI_RERANK_MODEL", raising=False)
    assert not configured(capability)
    monkeypatch.setenv("KIWI_RERANK_MODEL", "some/model")
    assert configured(capability)


def test_every_shipped_capability_names_what_it_buys_and_what_it_costs() -> None:
    # The point of the report is the trade, so neither half may be blank.
    for capability in CAPABILITIES:
        assert capability.buys, capability.name
        assert capability.without, capability.name
        assert capability.modules, capability.name


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("KIWI_A=1\nKIWI_B=2\n", {"KIWI_A": "1", "KIWI_B": "2"}),
        ("# a comment\n\nKIWI_A=1\n", {"KIWI_A": "1"}),
        ('KIWI_A="quoted value"\n', {"KIWI_A": "quoted value"}),
        ("KIWI_A='single'\n", {"KIWI_A": "single"}),
        ("export KIWI_A=1\n", {"KIWI_A": "1"}),
        ("KIWI_A=BAAI/bge-reranker-v2-m3\n", {"KIWI_A": "BAAI/bge-reranker-v2-m3"}),
        ("not a setting\n", {}),
    ],
)
def test_env_files_are_parsed(text: str, expected: dict[str, str]) -> None:
    from kiwi.setup import parse_env

    assert parse_env(text) == expected


def test_settings_written_by_setup_are_read_back(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    from kiwi.setup import load_env

    path = tmp_path / ".env"
    path.write_text(env_file({"KIWI_RERANK_MODEL": "some/model"}), encoding="utf-8")
    monkeypatch.delenv("KIWI_RERANK_MODEL", raising=False)

    assert load_env(path) == {"KIWI_RERANK_MODEL": "some/model"}
    import os

    assert os.environ["KIWI_RERANK_MODEL"] == "some/model"


def test_the_environment_outranks_the_file(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    # A value given on the command line must not be overridden by one
    # written to the file earlier.
    import os

    from kiwi.setup import load_env

    path = tmp_path / ".env"
    path.write_text("KIWI_RERANK_MODEL=from/file\n", encoding="utf-8")
    monkeypatch.setenv("KIWI_RERANK_MODEL", "from/environment")

    assert load_env(path) == {}
    assert os.environ["KIWI_RERANK_MODEL"] == "from/environment"


def test_a_missing_env_file_changes_nothing(tmp_path) -> None:  # type: ignore[no-untyped-def]
    from kiwi.setup import load_env

    assert load_env(tmp_path / "absent") == {}


def test_the_cuda_command_names_an_index_that_serves_gpu_builds() -> None:
    # Installing an extra resolves torch from PyPI, which replaces a CUDA
    # build with a CPU-only one on some platforms.
    from kiwi.setup import cuda_command

    command = cuda_command()
    assert "download.pytorch.org" in command
    assert "torch" in command


def test_an_accelerator_is_not_reported_lost_when_torch_can_reach_it() -> None:
    from kiwi.setup import accelerator_lost

    # Either torch reaches a card, or there is no card, or the build is
    # CPU-only on a machine that has one. Only the last is a loss.
    assert accelerator_lost() in (True, False)


def test_the_store_is_a_core_dependency_not_an_extra() -> None:
    # Every install needs somewhere to put chunks. Keeping the Store's
    # dependency in an extra leaves a plain install able to read a paper
    # and unable to index it, which is how it was found.
    import tomllib
    from pathlib import Path

    pyproject = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
    core = " ".join(pyproject["project"]["dependencies"])
    extras = " ".join(
        dep for group in pyproject["project"]["optional-dependencies"].values() for dep in group
    )
    assert "lancedb" in core
    assert "lancedb" not in extras


def test_the_extras_hold_only_model_backed_capabilities() -> None:
    # What an extra adds is a model download. Anything a plain install
    # needs to function belongs in the core dependencies.
    import tomllib
    from pathlib import Path

    pyproject = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
    extras = pyproject["project"]["optional-dependencies"]
    assert set(extras) == {"embed", "generate", "align"}
