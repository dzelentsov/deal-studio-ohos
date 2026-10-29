#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 0 ]] || { printf 'Usage: %s\n' "$0" >&2; exit 1; }
SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/tool-paths.sh"
START=$SECONDS

HVIGORW=$(vera_hvigorw)
OHOS_BASE_SDK_HOME=$(vera_sdk_home)
export HVIGORW OHOS_BASE_SDK_HOME DEVECO_SDK_HOME
printf '%-18s %s\n' hvigorw "$HVIGORW"
printf '%-18s %s\n' OHOS_BASE_SDK_HOME "$OHOS_BASE_SDK_HOME"
printf '%-18s %s\n' DEVECO_SDK_HOME "$DEVECO_SDK_HOME"
HDC_DIR=$(vera_hdc_dir)
HAPSIGNER=$(vera_hapsigner)
export HDC_DIR HAPSIGNER
export HAP_OUT_DIR="${HAP_OUT_DIR:-/tmp/vera-probe-dyn-hap}"
HDC="$HDC_DIR/hdc"

vera_require_cmd python3
vera_require_cmd java

BUNDLE=$(vera_app_bundle "$SCRIPT_DIR")

TARGETS=$("$HDC" list targets)
mapfile -t DEVICES < <(printf '%s\n' "$TARGETS" | tr -d '\r' | python3 -c 'import sys; sys.stdout.writelines(s.strip() + "\n" for s in sys.stdin if s.strip() and s.strip() != "[Empty]")')
if [[ ${#DEVICES[@]} -ne 1 ]]; then
  printf 'ERROR: connect exactly one phone; found %s. Nothing installed.\n' "${#DEVICES[@]}" >&2
  exit 1
fi
DEVICE="${DEVICES[0]}"
if [[ -n "${HDC_DEVICE:-}" && "$HDC_DEVICE" != "$DEVICE" ]]; then
  printf 'ERROR: HDC_DEVICE is not connected. Nothing installed.\n' >&2
  exit 1
fi
export HDC_DEVICE="$DEVICE"
vera_signing_device

snapshot() {
  "$HDC" -t "$DEVICE" shell bm dump -n "$BUNDLE" | python3 -c '
import json, sys
raw = sys.stdin.read()
try:
    d = json.loads(raw[raw.index("{"):].rstrip("\x00\r\n "))
    a = d["applicationInfo"]
    if a["isSystemApp"] is not True:
        sys.exit("ERROR: installed app is not a system app; refusing an incompatible update")
    print(json.dumps({k: d[k] for k in ("name", "appId", "uid", "firstInstallTime", "updateTime")}, sort_keys=True))
except (ValueError, KeyError) as e:
    sys.exit("ERROR: cannot inspect the installed app; refusing installation: " + str(e))
'
}

if [[ ! -f "$SCRIPT_DIR/entry/src/main/cpp/llama.cpp/CMakeLists.txt" && "${REQUIRE_LLAMA:-0}" == 1 ]]; then
  printf 'ERROR: REQUIRE_LLAMA=1, but llama.cpp is missing under entry/src/main/cpp; refusing to replace the installed app with a stub build. Nothing installed.\n' >&2
  exit 1
fi

BEFORE=$(snapshot)
printf '=== Update %s on %s (no uninstall or data clearing) ===\n' "$BUNDLE" "$DEVICE"
"$SCRIPT_DIR/build-hap.sh" --unsigned
"$SCRIPT_DIR/sign-system.sh"
INSTALL_OUTPUT=$("$HDC" -t "$DEVICE" install "$HAP_OUT_DIR/vera-probe-dyn-system-signed.hap" 2>&1) || {
  printf '%s\n' "$INSTALL_OUTPUT" >&2
  exit 1
}
printf '%s\n' "$INSTALL_OUTPUT"
INSTALL_LOWER=${INSTALL_OUTPUT,,}
[[ "$INSTALL_OUTPUT" == *"install bundle successfully"* && "$INSTALL_LOWER" != *"fail"* && "$INSTALL_LOWER" != *"error"* ]] || {
  printf 'ERROR: update failed; no uninstall or retry attempted.\n' >&2
  exit 1
}
AFTER=$(snapshot)
python3 - "$BEFORE" "$AFTER" <<'PY'
import json, sys
before, after = map(json.loads, sys.argv[1:])
for key in ('name', 'appId', 'uid', 'firstInstallTime'):
    if before[key] != after[key]:
        sys.exit('ERROR: update verification failed: ' + key + ' changed')
if after['updateTime'] <= before['updateTime']:
    sys.exit('ERROR: updateTime did not advance')
print('Verified in-place update: app identity and first install time unchanged.')
PY
printf 'Done in %ss.\n' "$((SECONDS - START))"
