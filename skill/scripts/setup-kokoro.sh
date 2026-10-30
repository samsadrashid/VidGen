#!/usr/bin/env sh
# One-time install of the Kokoro-82M natural voice (Apache-2.0, runs offline) for VidGen narration.
# Installs into $VIDGEN_KOKORO_DIR, default ~/.vidgen/kokoro: a Python venv with kokoro-onnx + the two model files (~340 MB).
# Safe to re-run: finished parts are skipped. Usage: sh setup-kokoro.sh
set -eu
DIR="${VIDGEN_KOKORO_DIR:-$HOME/.vidgen/kokoro}"
BASE=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
mkdir -p "$DIR"
echo "Kokoro -> $DIR"

if [ ! -x "$DIR/venv/bin/python" ] || ! "$DIR/venv/bin/python" -c 'import kokoro_onnx, soundfile' 2>/dev/null; then
  if command -v uv >/dev/null 2>&1; then
    uv venv --allow-existing --python 3.11 "$DIR/venv"
    uv pip install --python "$DIR/venv/bin/python" kokoro-onnx soundfile
  else
    PY=$(command -v python3.11 || command -v python3.12 || command -v python3 || true)
    [ -n "$PY" ] || { echo "ERROR: need python3 (>= 3.10) or uv: brew install uv" >&2; exit 1; }
    "$PY" -c 'import sys; sys.exit(sys.version_info < (3, 10))' || { echo "ERROR: $PY is older than 3.10; install uv (brew install uv) and re-run" >&2; exit 1; }
    "$PY" -m venv "$DIR/venv"
    "$DIR/venv/bin/python" -m pip install --quiet --upgrade pip
    "$DIR/venv/bin/python" -m pip install --quiet kokoro-onnx soundfile
  fi
fi

for f in kokoro-v1.0.onnx voices-v1.0.bin; do
  if [ -s "$DIR/$f" ]; then echo "have $f"; continue; fi
  echo "downloading $f"
  curl -fL --retry 3 -o "$DIR/$f.part" "$BASE/$f"
  mv "$DIR/$f.part" "$DIR/$f"
done

"$DIR/venv/bin/python" -c 'import kokoro_onnx' && echo 'Kokoro ready. In a storyboard: "tts": "kokoro", "voice": "af_heart"'
[ "$DIR" = "$HOME/.vidgen/kokoro" ] || echo "Custom location: export VIDGEN_KOKORO_DIR=\"$DIR\""
