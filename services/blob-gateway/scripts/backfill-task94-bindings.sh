#!/usr/bin/env bash
#
# Task #94 — backfill aura → cert-daemon bindings on the running blob-gateway.
#
# Usage (run from the gateway-host machine; needs DAEMON_NOTIFY_TOKEN):
#
#   GATEWAY_URL="https://materios.fluxpointstudios.com" \
#   ADMIN_TOKEN="<value of DAEMON_NOTIFY_TOKEN>" \
#   ./services/blob-gateway/scripts/backfill-task94-bindings.sh
#
# This script is idempotent — re-running it is safe. Each binding is a
# simple POST that overwrites whatever value (or NULL) was there before.
#
# CONTEXT: as of task #94 deploy, the live preprod committee has 7 members
# but only TWO operators run separate aura/cert-daemon keys (the security-
# correct setup). The other 5 use aura-as-cert-daemon-signer (degenerate),
# so their heartbeat is picked up by direct lookup with no binding needed.
# We still register a binding for Hetzner as a degenerate row to make the
# binding table the canonical source of truth (no implicit mapping).

set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:?missing GATEWAY_URL}"
ADMIN_TOKEN="${ADMIN_TOKEN:?missing ADMIN_TOKEN}"

# (keyHash, validatorAura, label)
# The keyHash is the SHA-256 of the api_keys row's plaintext API key —
# look it up via SELECT key_hash FROM api_keys WHERE name = ? in quota.db.
declare -a BINDINGS=(
  # TrueAiData: aura 5Fn3UB... → cert-daemon 5ELL8NY... (label: OnTimeData)
  "87f4f26fc5f831c22f91a05c8958ddf04abb1adb3162138b4072ec7b46f3c960|5Fn3UBWziTisjT6cx1K42eqycX5Fz4n9wWw97o5zd3RmAR9J|TrueAiData"

  # MacBook: aura 5CoiW8b... → cert-daemon 5GgCBrK... (label: macbook-preprod)
  "7b3c071e7d15a7ffe36d0ab13462a5bff8e3f4240c5a909c902109797f79a43f|5CoiW8b5wm45shiSagjxyFgpz7DS8pZiESQRVUcxJU1W687J|MacBook"

  # gemtek-preprod: aura == cert-daemon == 5Dd7WuLMyb...
  "66a45d9b695c5047a7b94fd6428e0b9c4b8ea6b1a4b7f913c3b3d9ae8049f815|5Dd7WuLMyb71NT1Bea6oEZH8Je3MkQzamHVeU4tmQbtPWq2v|Gemtek (degenerate)"

  # node2-preprod: aura == cert-daemon == 5FHyiV88...
  "80f804755e41795471704daa0517c346c4f03948562e0f937cf07b377fd5c5e7|5FHyiV88YBjxMjjZroQKcjW2nGyvHsGrPYmP7HhUNBxEpdZ7|Node2 (degenerate)"

  # node3-preprod: aura == cert-daemon == 5FNdLcDW...
  "fbe4299fcc932c8f7e10a0ce8f57099cf24e834d197c47a3f7a43e3362775789|5FNdLcDWmnDxtsUwznPaxFr9u7nop3K2kmYmvTaZRTVQExkT|Node3 (degenerate)"

  # SuNewbie: aura == cert-daemon == 5DPCfuHrPkiUTtrRuKYZcWuRvSsFRi4X47W6BykF9VJFsNso
  "a322a2322af32a870835b5b249541ed173454b20fa31fdaea9f861d36247dbca|5DPCfuHrPkiUTtrRuKYZcWuRvSsFRi4X47W6BykF9VJFsNso|SuNewbie (degenerate)"

  # NOTE: Hetzner (aura 5ELbHN...) is sig-only registered and does not have
  # an api_keys row to bind. Its heartbeat is picked up by direct lookup
  # because aura == cert-daemon signer. No backfill row needed; if the
  # operator later creates an api_keys entry, they should run:
  #   curl -XPOST -H "x-admin-token: $TOK" \
  #     "$GW/admin/api-keys/<their-keyhash>/binding" \
  #     -d '{"validatorAura":"5ELbHNFv5rJveN4XnfF6zzTEqCiAbLP2mNEhNgF4iX5nS1h7"}'
)

apply_binding() {
  local key_hash="$1"
  local aura="$2"
  local label="$3"
  echo "→ binding $label  keyHash=${key_hash:0:16}…  aura=$aura"
  local out
  out=$(curl -sS -X POST \
    -H "Content-Type: application/json" \
    -H "x-admin-token: $ADMIN_TOKEN" \
    -d "{\"validatorAura\":\"$aura\"}" \
    "$GATEWAY_URL/admin/api-keys/$key_hash/binding")
  echo "  $out"
}

for entry in "${BINDINGS[@]}"; do
  IFS="|" read -r kh aura label <<<"$entry"
  apply_binding "$kh" "$aura" "$label"
done

echo
echo "Done. Verify with:"
echo "  curl -s '$GATEWAY_URL/heartbeats/status' | jq '.bindings'"
