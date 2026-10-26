#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# The crypto-bigint timing-advisory analysis applies to this one public-input verifier.
# New production sources, build scripts, dependency changes or accepted inputs need review.
if [ -e build.rs ] || [ -L build.rs ] || [ "$(find src \( -type f -o -type l \) | LC_ALL=C sort)" != 'src/main.rs' ]; then
  echo 'Native verifier source inventory changed; review the public-input-only security boundary' >&2
  exit 1
fi
sha256sum --check public-input-boundary.sha256
echo 'Reviewed RUSTSEC-2026-0387 exception: this pinned public-input-only native verifier; no signing or proving use is covered.'
