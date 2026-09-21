"""The package's own facts: one version, a typed marker, the plugin entry point."""

from __future__ import annotations

import sys
from pathlib import Path

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover - 3.10 only
    import tomli as tomllib  # type: ignore[import-not-found,no-redef]

import iris_eval

ROOT = Path(__file__).resolve().parents[1]


def _pyproject() -> dict:
    return tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))


def test_version_is_stated_once() -> None:
    assert _pyproject()["project"]["version"] == iris_eval.__version__


def test_the_package_is_typed_and_registers_its_pytest_plugin() -> None:
    assert (ROOT / "src" / "iris_eval" / "py.typed").exists()
    assert _pyproject()["project"]["entry-points"]["pytest11"] == {"iris_eval": "iris_eval.pytest_plugin"}
    assert _pyproject()["project"]["dependencies"] == ["httpx>=0.27,<1"]


def test_every_public_name_is_exported() -> None:
    for name in ("IrisClient", "AsyncIrisClient", "IrisError", "IrisConnectionError", "find_server", "Evaluation", "Verdict"):
        assert hasattr(iris_eval, name), name
        assert name in iris_eval.__all__, name
