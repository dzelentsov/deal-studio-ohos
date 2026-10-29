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

  vera_require_cmd java
  vera_require_cmd python3

  vera_signing_device
fi
export HAP_OUT_DIR="${HAP_OUT_DIR:-/tmp/vera-probe-dyn-hap}"
HAP_NAME="vera-probe-dyn-unsigned.hap"

if [[ ! -f "$SCRIPT_DIR/entry/src/main/cpp/llama.cpp/CMakeLists.txt" ]]; then
  printf 'WARNING: llama.cpp is missing under entry/src/main/cpp; this build will be a stub without model support.\n' >&2
fi

echo "=== Build HAP ==="
printf 'Hvigor wrapper: %s\n' "$HVIGORW"
HVIGOR_EXIT=0
(
  set -o pipefail
  cd -- "$SCRIPT_DIR" || exit

  exec 3>&1                                       # the real terminal is on fd 3
  : > /tmp/hvigor-out.log                         # truncate before running (needed for -a)
  : > /tmp/hvigor-err.log                         # truncate before running (needed for -a)

  bash "$HVIGORW" clean --mode module -p module=entry -p product=default createHapTask --analyze=normal --parallel --incremental --no-daemon \
    2> >(tee -a /tmp/hvigor-err.log \
    | awk '
        BEGIN {
          filter = "is[ \t]+system[ \t]+api|system[ \t]+capacity[ \t]+of[ \t]+this[ \t]+api|to[ \t]+use[ \t]+this[ \t]+api,[ \t]+you[ \t]+need[ \t]+to[ \t]+apply[ \t]+for[ \t]+the[ \t]+permissions:|can[ \t]+only[ \t]+be[ \t]+used[ \t]+for[ \t]+testing[ \t]+directories"
          ansi   = "\033\\[[0-9;?]*[A-Za-z]"
          reset  = "\033[0m"
          pending = ""
          suppress_blanks = 0
        }

        function norm(s) {
          gsub(ansi, "", s)
          return tolower(s)
        }

        {
          c = norm($0)                                            # IMPORTANT: normalize first

          hit      = (c ~ filter)
          is_blank = (c ~ /^[ \t\r]*$/)

          # 1) after a filtered WARN, swallow blank lines and ohos.permission.*
          if (suppress_blanks) {
            if (is_blank || c ~ /^[ \t]*ohos\.permission\./) { next }
            suppress_blanks = 0
          }

          # 2) hold the header and decide what to do with the pair
          if (pending != "") {
            if (hit) {
              pending = ""; suppress_blanks = 1
              printf "%s", reset; fflush()
              next
            }
            print pending; fflush()
            pending = ""
          }

          # 3) the current line is a WARN header
          if (c ~ /^warn:.*file:/ || c ~ /^>[ \t]*hvigor[ \t]+warn:.*file:/) {
            if (hit) {
              suppress_blanks = 1
              printf "%s", reset; fflush()
              next
            }
            pending = $0
            next
          }

          # 4) a standalone line containing the filter text
          if (hit) {
            suppress_blanks = 1
            printf "%s", reset; fflush()
            next
          }

          print; fflush()
        }

        END {
          if (pending != "") { print pending; fflush() }
        }
      ' >&3) \
  | tee /tmp/hvigor-out.log

  status=$?
  wait                                            # wait for the background tee/awk processes to finish writing
  exit $status
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
