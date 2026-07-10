#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
asset_dir="$repo_root/assets/dulli"
source_svg="$asset_dir/logo.svg"

if command -v magick >/dev/null 2>&1; then
  imagemagick=(magick)
elif command -v convert >/dev/null 2>&1; then
  imagemagick=(convert)
else
  echo "ImageMagick ('magick' or 'convert') is required." >&2
  exit 1
fi

render() {
  local size="$1"
  local output="$2"
  "${imagemagick[@]}" -background none "$source_svg" -resize "${size}x${size}" -depth 8 "PNG32:$output"
}

render 1024 "$asset_dir/dulli-universal-1024.png"
render 180 "$asset_dir/dulli-web-apple-touch-180.png"
render 32 "$asset_dir/dulli-web-favicon-32x32.png"
render 16 "$asset_dir/dulli-web-favicon-16x16.png"

windows_tmp="$(mktemp -d)"
trap 'rm -rf "$windows_tmp"' EXIT
for size in 16 24 32 48 64 128 256; do
  render "$size" "$windows_tmp/$size.png"
done
"${imagemagick[@]}" \
  "$windows_tmp/16.png" \
  "$windows_tmp/24.png" \
  "$windows_tmp/32.png" \
  "$windows_tmp/48.png" \
  "$windows_tmp/64.png" \
  "$windows_tmp/128.png" \
  "$windows_tmp/256.png" \
  "$asset_dir/dulli-windows.ico"
cp "$asset_dir/dulli-windows.ico" "$asset_dir/dulli-web-favicon.ico"

echo "Regenerated T3 Dulli assets in $asset_dir"
