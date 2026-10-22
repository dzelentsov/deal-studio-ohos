#!/usr/bin/env bash
#
# Cold-run measurement loop for the VERA probe -- the paired half of
# webview-probe/measure.sh. Same device, same OS build, same clock, same two
# prompts, so the two sets of numbers are directly comparable.
#
# Every run force-stops the app first. A warm runtime reports a much cheaper
# number than a user opening a freshly generated program actually pays.
#
# Buttons are located by text from a layout dump rather than by hardcoded
# coordinates, because they sit partway down a scrolling page and their
# position depends on panel size. If the dump route fails, set TICTACTOE_XY
# and DASHBOARD_XY from a screenshot and it will use those instead.
#
# usage: ./measure.sh [reps]        (default 3)

set -euo pipefail

. "$(cd -- "$(dirname -- "$0")" && pwd)/tool-paths.sh"
vera_add_toolchains_to_path
HDC_PATH=$(vera_hdc_dir 2>/dev/null) && export PATH="$HDC_PATH:$PATH"
DEVICE_CLI=$(vera_kit_bin arkui-device-cli)
BUNDLE="com.vera.probe.dyn"
REPS="${1:-3}"
OUT="${OUT:-results/device.jsonl}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Centre of the on-screen element whose text contains $1, from a layout dump.
locate() {
  "$DEVICE_CLI" dump-layout "$WORK" >/dev/null 2>&1 || return 1
  local f
  f=$(find "$WORK" -name "*.json" -newermt "-2 minutes" | head -1)
  [[ -n "$f" ]] || return 1
  python3 - "$f" "$1" <<'PY'
import json, sys
want = sys.argv[2].lower()
def walk(n):
    a = n.get("attributes", n) if isinstance(n, dict) else {}
    text = str(a.get("text", "")) + " " + str(a.get("description", ""))
    if want in text.lower() and a.get("bounds"):
        b = a["bounds"]
        if isinstance(b, str):                       # "[x1,y1][x2,y2]"
            nums = [int(v) for v in b.replace("[", " ").replace("]", " ")
                    .replace(",", " ").split()]
            if len(nums) == 4:
                print((nums[0]+nums[2])//2, (nums[1]+nums[3])//2); sys.exit(0)
        elif isinstance(b, dict):
            print((b["left"]+b["right"])//2, (b["top"]+b["bottom"])//2); sys.exit(0)
    for c in (n.get("children") or []) if isinstance(n, dict) else []:
        walk(c)
walk(json.load(open(sys.argv[1])))
sys.exit(1)
PY
}

# Verified from a screenshot on this 1280x2832 panel.
declare -A FALLBACK=( [tictactoe]="338 1453" [dashboard]="915 1453" )

mkdir -p "$(dirname "$OUT")"
: > "$OUT"

for page in tictactoe dashboard; do
  var="$(tr '[:lower:]' '[:upper:]' <<<"$page")_XY"
  for ((i = 1; i <= REPS; i++)); do
    hdc shell aa force-stop "$BUNDLE" >/dev/null 2>&1
    sleep 2
    hdc shell hilog -r >/dev/null 2>&1
    hdc shell aa start -a EntryAbility -b "$BUNDLE" >/dev/null 2>&1
    sleep 4                                        # let the ArkUI page settle

    xy="${!var:-}"
    [[ -n "$xy" ]] || xy="${FALLBACK[$page]}"
    [[ -n "$xy" ]] || xy=$(locate "Bench $page") || {
      echo "could not find the 'Bench $page' button." >&2
      echo "Screenshot the device and set ${var}=\"<x> <y>\"." >&2
      exit 1
    }
    hdc shell uitest uiInput click "$xy" >/dev/null 2>&1
    sleep 6

    log=$(hdc shell "hilog -x" 2>/dev/null | tr -d '\r')
    run=$(grep -oE 'VERA_PROBE \{.*\}' <<<"$log" | tail -1)
    ui=$(grep -oE 'VERA_PROBE_UI \{.*\}' <<<"$log" | tail -1)
    echo "${run#VERA_PROBE } ${ui:+// ${ui#VERA_PROBE_UI }}" | tee -a "$OUT"
  done
done

echo
echo "wrote $OUT"
