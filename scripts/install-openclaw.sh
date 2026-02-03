#!/usr/bin/env bash
set -euo pipefail

say() { printf "\n\033[1m%s\033[0m\n" "$*"; }

say "1) Installing OpenClaw (official installer)..."
if ! command -v openclaw >/dev/null 2>&1; then
  curl -fsSL https://openclaw.ai/install.sh | bash
fi

export PATH="$HOME/.local/bin:$HOME/bin:$PATH"

if ! command -v openclaw >/dev/null 2>&1; then
  echo "openclaw not found in PATH after install."
  echo "Open a new terminal (or source your shell profile) then rerun."
  exit 1
fi

say "2) Running OpenClaw onboarding (best-effort)..."
openclaw onboard --install-daemon >/dev/null 2>&1 || true

say "3) Installing Orynq OpenClaw recorder (process-trace + anchoring)..."
npx --yes @fluxpointstudios/orynq-openclaw@latest install --service

say "Done."
echo "Next:"
echo "  - Put your key in: ~/.config/orynq-openclaw/service.env"
echo "  - Check status:   orynq-openclaw status"
echo "  - Tail logs:      orynq-openclaw logs -f"
