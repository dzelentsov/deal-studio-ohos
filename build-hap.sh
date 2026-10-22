#!/usr/bin/env bash
set -euo pipefail

UNSIGNED_ONLY=false
case "${1:-}" in
  --unsigned) UNSIGNED_ONLY=true; shift ;;
  "") ;;
  *) printf 'Usage: %s [--unsigned]\n' "$0" >&2; exit 1 ;;
esac
[[ $# -eq 0 ]] || { printf 'Usage: %s [--unsigned]\n' "$0" >&2; exit 1; }

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/tool-paths.sh"
HVIGORW=$(vera_hvigorw)
OHOS_BASE_SDK_HOME=$(vera_sdk_home)
export OHOS_BASE_SDK_HOME DEVECO_SDK_HOME
if [[ "$UNSIGNED_ONLY" == false ]]; then
  HAPSIGNER=$(vera_hapsigner)
  export HAPSIGNER
  command -v java >/dev/null
  command -v python3 >/dev/null
  vera_signing_device
fi
export HAP_OUT_DIR="${HAP_OUT_DIR:-/tmp/vera-probe-dyn-hap}"
HAP_NAME="vera-probe-dyn-unsigned.hap"

echo "=== Build HAP ==="
printf 'Hvigor wrapper: %s\n' "$HVIGORW"
HVIGOR_EXIT=0
(
  cd -- "$SCRIPT_DIR" || exit
  bash "$HVIGORW" clean --mode module -p module=entry -p product=default createHapTask --analyze=normal --parallel --incremental --no-daemon
) || HVIGOR_EXIT=$?
if [[ "$HVIGOR_EXIT" -ne 0 ]]; then
  printf 'ERROR: hvigor failed (exit %s).\n' "$HVIGOR_EXIT" >&2
  exit "$HVIGOR_EXIT"
fi

echo
echo "=== Copy HAP ==="
HAP_SRC="$SCRIPT_DIR/entry/build/default/outputs/default/$HAP_NAME"
if [[ ! -f "$HAP_SRC" ]]; then
  echo "ERROR: HAP not found at $HAP_SRC" >&2
  exit 1
fi

mkdir -p "$HAP_OUT_DIR"
cp "$HAP_SRC" "$HAP_OUT_DIR/$HAP_NAME"
ls -lh "$HAP_OUT_DIR/$HAP_NAME"

if [[ "$UNSIGNED_ONLY" == true ]]; then
  printf 'HAP: %s/%s\n' "$HAP_OUT_DIR" "$HAP_NAME"
  exit 0
fi

echo
echo "=== Sign ==="
"$SCRIPT_DIR/sign-system.sh"

echo
echo "=== Done ==="
echo "HAP: $HAP_OUT_DIR/vera-probe-dyn-system-signed.hap"
