"""What a machine needs before Kiwi can do each thing.

Kiwi runs with nothing installed beyond its own dependencies: PDFs are
parsed by a GROBID service, and everything else falls back to keyword
search over what was parsed. Each capability past that costs a package
install, a model download, or a running service, and buys a measured
improvement. This module reports which are present and produces the
commands for the ones that are not. It does not install anything.

Sizes are the download the model host serves, rounded. The figures under
``buys`` are from eval/README.md.
"""

from __future__ import annotations

import importlib.util
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

GROBID_IMAGE = "lfoppiano/grobid:0.8.1"

# The bundled JDK cannot read the cgroup layout of Docker 29 and later,
# and the container exits on startup with a null pointer. Passing the
# flag is harmless on older versions, so it is always passed.
GROBID_JAVA_OPTIONS = "-XX:-UseContainerSupport"

_DOCKER_VERSION = re.compile(r"(\d+)\.")


@dataclass(frozen=True)
class Capability:
    """One thing Kiwi can do, and what it costs to turn on."""

    name: str
    extra: str | None
    modules: tuple[str, ...]
    buys: str
    without: str
    download_gb: float
    models: tuple[str, ...] = ()
    env: tuple[tuple[str, str], ...] = ()
    # What this costs on a machine with no accelerator, where that is
    # enough to change the decision.
    on_cpu: str = ""

    def installed(self) -> bool:
        """Whether every package this needs can be imported."""
        return all(importlib.util.find_spec(module) is not None for module in self.modules)


CAPABILITIES: tuple[Capability, ...] = (
    Capability(
        name="embeddings",
        extra="embed",
        modules=("sentence_transformers", "lancedb"),
        buys="hybrid retrieval, raising MRR from 0.818 to 0.847 on the tuning corpus",
        without="BM25 keyword search alone",
        download_gb=1.3,
        models=("BAAI/bge-large-en-v1.5",),
    ),
    Capability(
        name="claim alignment",
        extra="align",
        modules=("transformers", "torch"),
        buys="claim scoring at 0.860 accuracy and 0.015 false endorsement on SciFact",
        without="citations listed unscored",
        download_gb=3.2,
        models=(
            "dleemiller/finecat-nli-l",
            "MoritzLaurer/DeBERTa-v3-large-mnli-fever-anli-ling-wanli",
        ),
    ),
    Capability(
        name="reranking",
        extra=None,
        modules=("sentence_transformers",),
        buys="Recall@1 from 0.559 to 0.824 on the held-out corpus",
        without="ranking by rank fusion alone",
        download_gb=2.2,
        models=("BAAI/bge-reranker-v2-m3",),
        env=(("KIWI_RERANK_MODEL", "BAAI/bge-reranker-v2-m3"),),
        on_cpu="about 6.6 seconds per question, against 0.5 on an accelerator",
    ),
    Capability(
        name="generated answers and revisions",
        extra="generate",
        modules=("litellm",),
        buys="synthesised answers, and suggested rewrites for unsupported claims",
        without="ranked passages",
        download_gb=0.0,
        env=(("KIWI_GENERATOR_MODEL", "ollama/qwen2.5:7b-instruct"),),
    ),
)


def install_command(capabilities: list[Capability]) -> str | None:
    """The one command that installs every capability given."""
    extras = sorted({c.extra for c in capabilities if c.extra})
    if not extras:
        return None
    return "uv sync " + " ".join(f"--extra {extra}" for extra in extras)


def accelerator_lost() -> bool:
    """Whether this machine has a GPU that torch cannot reach.

    Installing an extra resolves torch from PyPI, which ships a CPU-only
    build on some platforms and replaces a CUDA one already installed.
    The symptom is a machine that was using its card and silently stops.
    """
    try:
        import torch
    except ImportError:
        return False
    if torch.cuda.is_available():
        return False
    return "+cpu" in torch.__version__ and _has_nvidia_gpu()


def _has_nvidia_gpu() -> bool:
    if shutil.which("nvidia-smi") is None:
        return False
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return bool(result.stdout.strip())


def cuda_command() -> str:
    """The command that puts a CUDA build of torch back."""
    return "uv pip install torch --index-url https://download.pytorch.org/whl/cu129"


def docker_version() -> int | None:
    """The installed Docker major version, or None when Docker is absent."""
    if shutil.which("docker") is None:
        return None
    try:
        result = subprocess.run(
            ["docker", "version", "--format", "{{.Client.Version}}"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    match = _DOCKER_VERSION.match(result.stdout.strip())
    return int(match.group(1)) if match else None


def grobid_command(port: int = 8070) -> str:
    """The command that starts GROBID on this host."""
    return (
        f"docker run --rm -p {port}:8070 -e JAVA_TOOL_OPTIONS={GROBID_JAVA_OPTIONS} {GROBID_IMAGE}"
    )


def env_file(settings: dict[str, str]) -> str:
    """The contents of a .env holding ``settings``."""
    lines = ["# Written by `kiwi setup`. Values here are read at startup."]
    lines += [f"{name}={value}" for name, value in sorted(settings.items())]
    return "\n".join(lines) + "\n"


def merge_env(existing: str, settings: dict[str, str]) -> str:
    """``existing`` with ``settings`` applied, keeping unrelated lines.

    A name already present is replaced in place rather than appended, so
    running setup twice does not leave the file with two of anything.
    """
    remaining = dict(settings)
    out: list[str] = []
    for line in existing.splitlines():
        name = line.split("=", 1)[0].strip()
        if name in remaining:
            out.append(f"{name}={remaining.pop(name)}")
        else:
            out.append(line)
    out += [f"{name}={value}" for name, value in sorted(remaining.items())]
    return "\n".join(out).rstrip("\n") + "\n"


def download_size(capabilities: list[Capability]) -> float:
    """Total model download for ``capabilities``, counting each once."""
    seen: set[str] = set()
    total = 0.0
    for capability in capabilities:
        if capability.download_gb and not set(capability.models) <= seen:
            total += capability.download_gb
            seen |= set(capability.models)
    return total


def parse_env(text: str) -> dict[str, str]:
    """The settings in a ``.env``.

    Blank lines and comments are skipped. A value may be quoted, and an
    ``export`` prefix is accepted so a file can also be sourced by a
    shell.
    """
    settings: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        name, _, value = stripped.partition("=")
        name = name.removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if name:
            settings[name] = value
    return settings


def load_env(path: Path | None = None) -> dict[str, str]:
    """Apply the settings in ``path`` to the environment.

    A name already present in the environment is left alone, so a value
    given on the command line outranks one written to the file earlier.
    Returns the settings that were applied.
    """
    path = path or Path(".env")
    if not path.is_file():
        return {}
    applied = {
        name: value
        for name, value in parse_env(path.read_text(encoding="utf-8")).items()
        if name not in os.environ
    }
    os.environ.update(applied)
    return applied


def configured(capability: Capability) -> bool:
    """Whether the environment already turns this capability on.

    A capability with no environment setting is on as soon as its
    packages are installed.
    """
    return all(os.environ.get(name) for name, _ in capability.env)
