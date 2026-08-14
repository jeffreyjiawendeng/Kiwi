"""Device selection for model-backed components.

Models run on the fastest device present. A machine with no accelerator,
or without the GPU build of torch installed, runs on the CPU, so the
components behave the same either way and only differ in speed.

``KIWI_DEVICE`` pins the choice to ``cuda``, ``mps``, or ``cpu``. A device
that is named but unavailable falls back to the CPU rather than failing,
because a slower answer is more useful than none.
"""

from __future__ import annotations

import os

AUTO = "auto"
CPU = "cpu"
CUDA = "cuda"
MPS = "mps"

# Memory left unused on the accelerator. The display server and other
# processes share the card, and an allocation that consumes all of it
# destabilises the machine rather than failing cleanly.
HEADROOM_GB = 2.0


def available_device() -> str:
    """The fastest device torch can reach, or ``cpu``."""
    try:
        import torch
    except ImportError:
        return CPU

    if torch.cuda.is_available():
        return CUDA
    backend = getattr(torch.backends, MPS, None)
    if backend is not None and backend.is_available():
        return MPS
    return CPU


def resolve_device(preferred: str | None = None) -> str:
    """The device to run a model on.

    Reads ``preferred``, then ``KIWI_DEVICE``, then picks the fastest
    device present.
    """
    requested = (preferred or os.environ.get("KIWI_DEVICE") or AUTO).strip().lower()
    if requested == AUTO:
        return available_device()
    if requested == CPU:
        return CPU
    if requested in (CUDA, MPS) and requested == available_device():
        return requested
    return CPU


def free_memory_gb(device: str) -> float | None:
    """Memory currently free on ``device``, or ``None`` where unknown.

    System memory is not reported, so a CPU device returns ``None``.
    """
    if device != CUDA:
        return None
    try:
        import torch

        free, _ = torch.cuda.mem_get_info()
        return float(free) / 1e9
    except Exception:
        return None


def fits_in_memory(device: str, required_gb: float) -> bool:
    """Whether a model of ``required_gb`` loads with headroom to spare.

    True where the free memory cannot be measured, so an unknown device
    is attempted rather than refused.
    """
    free = free_memory_gb(device)
    if free is None:
        return True
    return free - required_gb >= HEADROOM_GB


def release_memory() -> None:
    """Return cached allocator blocks to the driver.

    Worth calling after a model is dropped, since the caching allocator
    holds freed blocks and the next allocation may need them back.
    """
    try:
        import gc

        import torch

        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        return


def describe_device(device: str) -> str:
    """Device name for reporting, including the GPU model where known."""
    if device != CUDA:
        return device
    try:
        import torch

        return f"{CUDA} ({torch.cuda.get_device_name(0)})"
    except Exception:
        return CUDA
