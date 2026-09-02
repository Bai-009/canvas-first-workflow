#!/usr/bin/env bash
# 把 docs/assets/src/*.html 渲染成 2x PNG。需要本机装有 Google Chrome，且联网（字体从 Google Fonts 拉）。
set -euo pipefail
cd "$(dirname "$0")/.."
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
for src in docs/assets/src/*.html; do
  name=$(basename "$src" .html)
  w=$(grep -o 'width:[0-9]*px; height:[0-9]*px; background' "$src" | head -1 | sed -E 's/width:([0-9]*)px.*/\1/')
  h=$(grep -o 'width:[0-9]*px; height:[0-9]*px; background' "$src" | head -1 | sed -E 's/.*height:([0-9]*)px.*/\1/')
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --window-size="${w},${h}" --force-device-scale-factor=2 \
    --virtual-time-budget=20000 --screenshot="docs/assets/${name}.png" "file://$PWD/$src" 2>/dev/null
  echo "rendered docs/assets/${name}.png (${w}x${h} @2x)"
done
