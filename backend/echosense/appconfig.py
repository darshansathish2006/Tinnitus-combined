"""Domain configuration bridge.

The `clinical`, `ml`, `dsp` and `chat` packages are deliberately framework-free —
they are pure Python and can be imported by a management command, a test, or a
notebook without Django being involved. They still need a handful of settings
(where model artifacts live, the model version string, the optional Claude key),
so this module exposes them behind a tiny object rather than making those packages
import `django.conf` and drag the framework in with them.

Values come from Django settings when Django is configured, and fall back to
environment variables otherwise, so `python -m ml.train` still works standalone.
"""

from __future__ import annotations

import os
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent


class DomainSettings:
    """Framework-free view of the settings the domain packages need."""

    @staticmethod
    def _get(name: str, default):
        try:
            from django.conf import settings as django_settings

            if django_settings.configured:
                return getattr(django_settings, name, default)
        except Exception:
            pass
        return os.environ.get(f"ECHOSENSE_{name}", default)

    @property
    def artifacts_dir(self) -> Path:
        path = Path(self._get("ARTIFACTS_DIR", BACKEND_ROOT / "artifacts"))
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def model_version(self) -> str:
        return str(self._get("MODEL_VERSION", "esai-predict-2.0.0"))

    @property
    def anthropic_api_key(self) -> str | None:
        value = self._get("ANTHROPIC_API_KEY", None)
        return str(value) if value else None

    @property
    def anthropic_model(self) -> str:
        return str(self._get("ANTHROPIC_MODEL", "claude-sonnet-5"))


settings = DomainSettings()
