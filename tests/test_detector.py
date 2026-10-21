"""顔検出のテスト."""

from __future__ import annotations

import pytest

from faceblur.config import SETTINGS
from faceblur.detector import FaceDetector, ModelMissingError


def make_png(color=(255, 255, 255), size=(48, 32)):
    """テスト用の小さな画像を作る."""
    import cv2
    import numpy as np

    img = np.full((size[1], size[0], 3), color, dtype=np.uint8)
    ok, buf = cv2.imencode(".png", img)
    assert ok
    return buf.tobytes()


def test_detect_rejects_garbage(tmp_path):
    detector = FaceDetector(tmp_path / "missing.onnx")
    with pytest.raises(ValueError):
        detector.detect("これは画像ではありません".encode())


def test_detect_needs_the_model(tmp_path):
    detector = FaceDetector(tmp_path / "missing.onnx")
    assert not detector.model_exists()
    with pytest.raises(ModelMissingError):
        detector.detect(make_png())


def test_detect_finds_nothing_on_a_blank_image(tmp_path):
    model = SETTINGS.model_path
    if not model.is_file():
        pytest.skip("顔検出モデルが未ダウンロードです")
    detector = FaceDetector(model)
    result = detector.detect(make_png())
    assert result["faces"] == []
    assert result["width"] == 48 and result["height"] == 32


def test_detect_returns_boxes_in_the_same_size(tmp_path):
    model = SETTINGS.model_path
    if not model.is_file():
        pytest.skip("顔検出モデルが未ダウンロードです")
    detector = FaceDetector(model)
    result = detector.detect(make_png(size=(120, 90)))
    assert result["width"] == 120
    assert result["height"] == 90
    for face in result["faces"]:
        assert face["w"] > 0 and face["h"] > 0
        assert 0.0 <= face["score"] <= 1.0
