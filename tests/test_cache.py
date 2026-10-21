"""サーバーに残す画像のキャッシュのテスト."""

from __future__ import annotations

import time

from faceblur.cache import ImageCache


def test_put_and_count(tmp_path):
    cache = ImageCache(tmp_path / "images")
    assert cache.count() == 0
    path = cache.put(b"data")
    assert path is not None and path.is_file()
    assert cache.count() == 1


def test_put_ignores_empty_data(tmp_path):
    cache = ImageCache(tmp_path / "images")
    assert cache.put(b"") is None
    assert cache.count() == 0


def test_clear_removes_everything(tmp_path):
    cache = ImageCache(tmp_path / "images")
    for i in range(3):
        cache.put(f"data{i}".encode())
    assert cache.count() == 3
    assert cache.clear() == 3
    assert cache.count() == 0


def test_purge_removes_old_files(tmp_path):
    cache = ImageCache(tmp_path / "images", keep=10, max_age=0.01)
    cache.put(b"old")
    time.sleep(0.05)
    cache.put(b"new")
    cache.purge()
    assert cache.count() == 1


def test_purge_keeps_only_the_latest(tmp_path):
    cache = ImageCache(tmp_path / "images", keep=2, max_age=3600)
    for i in range(5):
        cache.put(f"data{i}".encode())
        time.sleep(0.01)
    assert cache.count() == 2
