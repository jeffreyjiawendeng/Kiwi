from __future__ import annotations

import pytest

from kiwi.device import (
    HEADROOM_GB,
    available_device,
    describe_device,
    fits_in_memory,
    free_memory_gb,
    release_memory,
    resolve_device,
)


def test_cpu_is_always_selectable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KIWI_DEVICE", "cpu")
    assert resolve_device() == "cpu"


def test_explicit_argument_wins_over_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KIWI_DEVICE", "cuda")
    assert resolve_device("cpu") == "cpu"


def test_auto_matches_what_is_available(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KIWI_DEVICE", "auto")
    assert resolve_device() == available_device()


def test_unset_environment_behaves_as_auto(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("KIWI_DEVICE", raising=False)
    assert resolve_device() == available_device()


def test_naming_an_unavailable_device_falls_back_to_cpu(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("kiwi.device.available_device", lambda: "cpu")
    assert resolve_device("cuda") == "cpu"
    assert resolve_device("mps") == "cpu"


def test_an_unrecognised_device_falls_back_to_cpu(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KIWI_DEVICE", "tpu")
    assert resolve_device() == "cpu"


def test_whitespace_and_case_are_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KIWI_DEVICE", "  CPU  ")
    assert resolve_device() == "cpu"


def test_available_device_is_one_of_the_known_devices() -> None:
    assert available_device() in {"cpu", "cuda", "mps"}


def test_describe_leaves_non_gpu_devices_alone() -> None:
    assert describe_device("cpu") == "cpu"
    assert describe_device("mps") == "mps"


def test_cpu_reports_no_measurable_free_memory() -> None:
    assert free_memory_gb("cpu") is None


def test_a_model_fits_when_free_memory_is_unknown() -> None:
    # An unmeasurable device is attempted rather than refused.
    assert fits_in_memory("cpu", required_gb=999.0) is True


def test_a_model_fits_only_with_headroom_to_spare(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("kiwi.device.free_memory_gb", lambda device: 10.0)
    assert fits_in_memory("cuda", required_gb=10.0 - HEADROOM_GB) is True
    assert fits_in_memory("cuda", required_gb=10.0 - HEADROOM_GB + 0.1) is False


def test_a_model_larger_than_free_memory_does_not_fit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("kiwi.device.free_memory_gb", lambda device: 4.0)
    assert fits_in_memory("cuda", required_gb=24.0) is False


def test_releasing_memory_is_safe_to_call() -> None:
    release_memory()
    release_memory()
