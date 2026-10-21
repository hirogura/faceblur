"""設定値 (環境変数で上書きできる)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except ValueError:
        return default


@dataclass
class Settings:
    host: str = os.environ.get("FACEBLUR_HOST", "127.0.0.1")
    port: int = _env_int("FACEBLUR_PORT", 3370)
    max_upload_bytes: int = _env_int("FACEBLUR_MAX_UPLOAD", 40 * 1024 * 1024)
    detect_score: float = _env_float("FACEBLUR_DETECT_SCORE", 0.6)
    detect_max_side: int = _env_int("FACEBLUR_DETECT_MAX_SIDE", 1600)
    admin_token: str = os.environ.get("FACEBLUR_ADMIN_TOKEN", "")
    repo_root: Path = REPO_ROOT
    model_dir: Path = field(
        default_factory=lambda: Path(
            os.environ.get("FACEBLUR_MODEL_DIR", "") or (REPO_ROOT / "models")
        )
    )

    @property
    def model_path(self) -> Path:
        from .detector import MODEL_NAME

        return self.model_dir / MODEL_NAME

    @property
    def static_dir(self) -> Path:
        return Path(__file__).resolve().parent / "static"


SETTINGS = Settings()
