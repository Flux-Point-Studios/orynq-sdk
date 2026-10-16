#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: install-compact.sh DESTINATION" >&2
  exit 2
fi
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  echo "This pinned compiler installer requires Linux x86_64" >&2
  exit 2
fi

archive=compactc_v0.31.1_x86_64-unknown-linux-musl.zip
checksum=e291b4bab4d4e857707008f8b1c25c2b8e0c843f6c737d0ee6c0d9ac69a6bbfb
temporary_directory=$(mktemp -d)
trap 'rm -rf "$temporary_directory"' EXIT
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --max-time 120 \
  "https://github.com/midnightntwrk/compact/releases/download/compactc-v0.31.1/$archive" \
  --output "$temporary_directory/$archive"
if ! printf '%s  %s\n' "$checksum" "$temporary_directory/$archive" | sha256sum --check --status; then
  echo "Compact compiler archive checksum mismatch" >&2
  exit 1
fi
unzip -q "$temporary_directory/$archive" -d "$temporary_directory/compiler"
[[ $("$temporary_directory/compiler/compactc" --version) == 0.31.1 ]]
mkdir -p "$1"
cp -a "$temporary_directory/compiler/." "$1/"
[[ $("$1/compactc" --version) == 0.31.1 ]]
echo "Installed Compact compiler 0.31.1 with verified SHA-256"
