#!/bin/sh
# Verifies the runner's units with systemd-analyze --user verify, laid out as the install lays them
# out: a HOME whose ~/.local/lib/orynq-midnight-runner/checkout is this checkout. Outside a login
# session (CI) it gives the verifying manager a runtime directory of its own.
set -eu
here=$(dirname "$(readlink -f "$0")")
home=$(mktemp -d)
trap 'rm -rf "$home"' EXIT
mkdir -p "$home/.local/lib/orynq-midnight-runner" "$home/units" "$home/run"
chmod 700 "$home/run"
ln -s "$(cd "$here/../../../.." && pwd)" "$home/.local/lib/orynq-midnight-runner/checkout"
cp "$here"/*.service "$here"/*.path "$here"/*.timer "$home/units/"
ln -s 'orynq-midnight-runner@.service' "$home/units/orynq-midnight-runner@bf35fa0c.service"
HOME="$home" XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$home/run}" systemd-analyze --user verify \
  "$home/units/orynq-midnight-runner@bf35fa0c.service" \
  "$home/units/orynq-midnight-runner-dispatch.service" \
  "$home/units/orynq-midnight-runner-dispatch.path" \
  "$home/units/orynq-midnight-runner-dispatch.timer"
echo "systemd-analyze --user verify: the runner's units are valid"
