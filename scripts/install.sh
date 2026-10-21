#!/usr/bin/env bash
# faceblur のインストール (venv の作成 → systemd への登録 → 起動).
#
#   sudo ./scripts/install.sh
#
# 既存の venv があれば使い回す. 引数でポートとホストを変えられる.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${FACEBLUR_PORT:-3370}"
HOST="${FACEBLUR_HOST:-127.0.0.1}"
VENV="$ROOT/.venv"
SERVICE_FILE="/etc/systemd/system/faceblur.service"
MODEL_DIR="$ROOT/models"
MODEL_NAME="face_detection_yunet_2023mar.onnx"
MODEL_URL="https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/${MODEL_NAME}"

command -v python3 >/dev/null || { echo "python3 が必要です" >&2; exit 1; }
command -v git >/dev/null || { echo "git が必要です" >&2; exit 1; }

echo "==> venv を作る ($VENV)"

# python3 があるだけでは venv を作れないことがある.
# ensurepip (python3-venv パッケージ) が無い環境では venv の作成が失敗し,
# 中途半端な venv ディレクトリが残って "pip not found" で詰まる.
if ! python3 -c 'import ensurepip' >/dev/null 2>&1; then
  echo "==> python3-venv を導入する"
  PY_MINOR="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
  if command -v apt-get >/dev/null; then
    apt-get update >/dev/null || echo "   (apt-get update に失敗しましたが続行します)"
    apt-get install -y python3-venv || apt-get install -y "python${PY_MINOR}-venv"
  else
    echo "ensurepip がありません. python3-venv を手動でインストールしてください" >&2
    echo "(Debian/Ubuntu: sudo apt install python3-venv)" >&2
    exit 1
  fi
fi

# 失敗して中途半端に残った venv を引きずらないよう, pip 付きか確認する
if [ ! -x "$VENV/bin/pip" ]; then
  rm -rf "$VENV"
  python3 -m venv "$VENV"
fi

"$VENV/bin/pip" install --upgrade pip setuptools wheel >/dev/null

echo "==> 依存関係を入れる"
"$VENV/bin/pip" install -r "$ROOT/requirements.txt"

echo "==> 顔検出モデルを用意する ($MODEL_DIR/$MODEL_NAME)"
mkdir -p "$MODEL_DIR"
if [ ! -s "$MODEL_DIR/$MODEL_NAME" ]; then
  if command -v curl >/dev/null; then
    curl -fsSL -o "$MODEL_DIR/$MODEL_NAME.tmp" "$MODEL_URL" &&
      mv "$MODEL_DIR/$MODEL_NAME.tmp" "$MODEL_DIR/$MODEL_NAME" ||
      echo "   (モデルのダウンロードに失敗しました. 起動時に再試行します)"
  else
    echo "   (curl がありません. 起動時にダウンロードします)"
  fi
else
  echo "   (すでにあります)"
fi

echo "==> systemd ユニット installing"
sed -e "s#^WorkingDirectory=.*#WorkingDirectory=$ROOT#" \
    -e "s#^ExecStart=.*#ExecStart=$VENV/bin/python -m faceblur#" \
    -e "s#^Environment=FACEBLUR_HOST=.*#Environment=FACEBLUR_HOST=$HOST#" \
    -e "s#^Environment=FACEBLUR_PORT=.*#Environment=FACEBLUR_PORT=$PORT#" \
    "$ROOT/systemd/faceblur.service" > "$SERVICE_FILE"

systemctl daemon-reload
systemctl enable faceblur.service >/dev/null
systemctl restart faceblur.service

sleep 2
if systemctl is-active --quiet faceblur.service; then
  echo "==> 起動しました: http://$HOST:$PORT/"
  systemctl --no-pager --lines=5 status faceblur.service || true
else
  echo "==> 起動に失敗しました. journalctl -u faceblur.service を見てください" >&2
  journalctl -u faceblur.service --no-pager --lines=30 >&2 || true
  exit 1
fi

if command -v tailscale >/dev/null && tailscale serve --help >/dev/null 2>&1; then
  echo "==> tailscale serve で公開する (https://<端末名>:$PORT/)"
  tailscale serve --bg --https="$PORT" "http://127.0.0.1:$PORT" >/dev/null || \
    echo "   (tailscale serve に失敗しました. 手動で設定してください)"
fi
