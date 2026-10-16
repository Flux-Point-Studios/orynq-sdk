#!/usr/bin/env bash
# Compiles orynq-anchor-registry.compact into managed/ with the pinned compactc (installed by
# tools/compactc/install.sh), or checks that a fresh compile reproduces managed/ and HASHES.txt
# byte for byte. The check also compiles the source with its pure circuits unexported and
# requires the same keys and zkir, so the verifier keys provably do not depend on them.
#   COMPACTC=/path/to/compactc packages/anchors-midnight/contract/compile.sh --write|--check
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
compactc=${COMPACTC:-compactc}
source=orynq-anchor-registry.compact

die() { echo "contract compile: $*" >&2; exit 1; }
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
# The source map records paths relative to the working directory, so every compile runs from
# the directory holding the source, with managed/ beside it, exactly as committed.
compile() { (cd "$1" && "$compactc" "$source" managed >/dev/null); }
hashes() { (cd "$1" && find "$source" managed -type f | LC_ALL=C sort | while read -r f; do sha256 "$f"; done); }

version=$("$compactc" --version)
[ "$version" = 0.31.1 ] || die "compactc reports $version, expected 0.31.1"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

case "${1:-}" in
  --write)
    mkdir "$work/fresh"
    cp "$here/$source" "$work/fresh/"
    compile "$work/fresh"
    rm -rf "$here/managed"
    cp -R "$work/fresh/managed" "$here/managed"
    hashes "$here" >"$here/HASHES.txt"
    echo "contract compile: wrote managed/ and HASHES.txt"
    ;;
  --check)
    [ "$(hashes "$here")" = "$(cat "$here/HASHES.txt")" ] || die "the source or managed/ differs from HASHES.txt"
    mkdir "$work/fresh" "$work/unexported"
    cp "$here/$source" "$work/fresh/"
    compile "$work/fresh"
    diff -r "$here/managed" "$work/fresh/managed" >&2 || die "a fresh compile differs from managed/"
    sed 's/^export pure circuit /pure circuit /' "$here/$source" >"$work/unexported/$source"
    ! grep -q '^export pure circuit' "$work/unexported/$source" || die "pure circuits are still exported"
    compile "$work/unexported"
    for d in keys zkir; do
      diff -r "$here/managed/$d" "$work/unexported/managed/$d" >&2 || die "managed/$d depends on which pure circuits are exported"
    done
    echo "contract compile: a fresh compile reproduces managed/ and HASHES.txt; keys and zkir do not depend on the exported pure circuits"
    ;;
  *) die "usage: compile.sh --write|--check" ;;
esac
