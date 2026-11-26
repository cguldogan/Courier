#!/bin/sh
# Assembles the GitHub Pages site (.github/workflows/pages.yml) into a directory, default _site/:
#   - site/ as it is (HTML, CSS, JS, the social preview image);
#   - images/: the app icon from build/ and docs/images/logo.png, and WebP copies of the other PNGs
#     in docs/images/ (screenshots and the how-it-works infographic), 1600 px and 800 px wide.
# docs/images/ and build/icon.svg stay the single source of truth; nothing generated is committed.
# Needs cwebp (Ubuntu: apt-get install webp; macOS: brew install webp).
#
# Local preview: sh .github/scripts/assemble-site.sh /tmp/courier-site, then serve that directory
# under /Courier/ (the GitHub Pages project path).
set -eu

out="${1:-_site}"
command -v cwebp >/dev/null 2>&1 || { echo "assemble-site: cwebp not found (apt-get install webp / brew install webp)" >&2; exit 1; }

rm -rf "$out"
mkdir -p "$out/images"
cp -R site/. "$out/"
cp build/icon.svg "$out/images/icon.svg"
cp docs/images/logo.png "$out/images/icon-256.png"

for png in docs/images/*.png; do
  name="$(basename "$png" .png)"
  [ "$name" = logo ] && continue
  cwebp -quiet -q 82 -m 6 -resize 1600 0 "$png" -o "$out/images/$name.webp"
  cwebp -quiet -q 82 -m 6 -resize 800 0 "$png" -o "$out/images/$name-800.webp"
done

echo "assemble-site: $(find "$out" -type f | wc -l | tr -d ' ') files, $(du -sk "$out" | cut -f1) KB in $out"
