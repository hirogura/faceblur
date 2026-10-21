"""顔の検出 (OpenCV + YuNet).

顔検出モデル (YuNet) はリポジトリに同梱しない. 初回起動時に
``models/`` へダウンロードして保存し, 以降はローカルだけを使う.
"""

from __future__ import annotations

import shutil
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path

MODEL_NAME = "face_detection_yunet_2023mar.onnx"
MODEL_URL = (
    "https://github.com/opencv/opencv_zoo/raw/main/models/"
    f"face_detection_yunet/{MODEL_NAME}"
)
USER_AGENT = "faceblur (+https://github.com/hirogura/faceblur)"


class ModelMissingError(RuntimeError):
    """顔検出モデルが手元にない (まだダウンロードしていない)."""


class FaceDetector:
    """YuNet を使って写真の中の顔を探す."""

    def __init__(
        self,
        model_path: Path,
        score_threshold: float = 0.6,
        nms_threshold: float = 0.3,
        max_side: int = 1600,
    ) -> None:
        self.model_path = Path(model_path)
        self.score_threshold = score_threshold
        self.nms_threshold = nms_threshold
        self.max_side = max_side
        self._lock = threading.Lock()
        self._detector = None
        self._input_size = (0, 0)

    # --- モデル -------------------------------------------------------------
    def model_exists(self) -> bool:
        return self.model_path.is_file() and self.model_path.stat().st_size > 0

    def download_model(self, timeout: float = 120.0) -> Path:
        """モデルを ``models/`` へダウンロードする."""
        self.model_path.parent.mkdir(parents=True, exist_ok=True)
        request = urllib.request.Request(MODEL_URL, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                with tempfile.NamedTemporaryFile(
                    dir=self.model_path.parent, delete=False
                ) as tmp:
                    shutil.copyfileobj(response, tmp)
                    temp_path = Path(tmp.name)
        except (urllib.error.URLError, OSError) as exc:
            raise ModelMissingError(f"モデルのダウンロードに失敗しました: {exc}") from exc
        temp_path.replace(self.model_path)
        return self.model_path

    def ensure_model(self, allow_download: bool = True) -> Path:
        """モデルを用意してそのパスを返す. 無ければダウンロードする."""
        with self._lock:
            if self.model_exists():
                return self.model_path
            if not allow_download:
                raise ModelMissingError("顔検出モデルがありません")
            return self.download_model()

    def _load(self):
        """FaceDetectorYN を作る (初回のときだけ)."""
        if self._detector is not None:
            return self._detector
        import cv2  # 遅延読み込み (opencv が無い環境でも画面は動く)

        if not self.model_exists():
            raise ModelMissingError("顔検出モデルがありません")
        with self._lock:
            if self._detector is not None:
                return self._detector
            detector = cv2.FaceDetectorYN.create(
                str(self.model_path),
                "",
                (320, 320),
                self.score_threshold,
                self.nms_threshold,
                5000,
            )
            self._detector = detector
            return detector

    # --- 検出 ---------------------------------------------------------------
    def detect(self, data: bytes) -> dict:
        """画像データから顔を探す.

        戻り値は ``{"width": ..., "height": ..., "faces": [...]}``.
        """
        import cv2
        import numpy as np

        buffer = np.frombuffer(data, dtype=np.uint8)
        image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError("画像を読み込めませんでした")

        height, width = image.shape[:2]
        scale = min(1.0, self.max_side / max(width, height))
        if scale < 1.0:
            image = cv2.resize(
                image, (int(width * scale), int(height * scale)), interpolation=cv2.INTER_AREA
            )
            height, width = image.shape[:2]

        detector = self._load()
        with self._lock:
            if self._input_size != (width, height):
                detector.setInputSize((width, height))
                self._input_size = (width, height)
            _, faces = detector.detect(image)

        result = []
        if faces is not None:
            for face in faces:
                x, y, w, h = (int(round(float(v))) for v in face[:4])
                result.append(
                    {
                        "x": x,
                        "y": y,
                        "w": w,
                        "h": h,
                        "score": round(float(face[-1]), 3),
                    }
                )
        result.sort(key=lambda item: item["score"], reverse=True)
        return {"width": width, "height": height, "faces": result}
