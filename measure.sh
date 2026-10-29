#!/usr/bin/env bash
#
# Cold-run measurement loop for the VERA probe -- the paired half of
# webview-probe/measure.sh. Same device, same OS build, same clock, same two
# prompts, so the two sets of numbers are directly comparable.
#
# Every run force-stops the app first. A warm runtime reports a much cheaper
# number than a user opening a freshly generated program actually pays.
#
# Buttons are located from a layout dump by their text rather than by hardcoded
# coordinates, because they sit partway down a scrolling page and their
# position depends on panel size. To override, set TICTACTOE_XY and DASHBOARD_XY
# ("<x> <y>", from a screenshot). If the dump finds nothing and no override is
# set, it falls back to coordinates verified on one 1280x2832 panel.
#
# usage: ./measure.sh [reps]        (default 3)

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/tool-paths.sh"

vera_add_toolchains_to_path
vera_use_hdc || exit 1
DEVICE_CLI=$(vera_kit_bin arkui-device-cli)
BUNDLE="com.vera.probe.dyn"
REPS="${1:-3}"
OUT="${OUT:-$SCRIPT_DIR/results/device.jsonl}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Centre of the on-screen element whose text contains $1, from a layout dump.
locate() {
  rm -f "$WORK"/*.json
  "$DEVICE_CLI" dump-layout "$WORK" >/dev/null 2>&1 || return 1
  local f="" cand
  for cand in "$WORK"/*.json; do
    [[ -e "$cand" ]] || continue
    if [[ -z "$f" || "$cand" -nt "$f" ]]; then f="$cand"; fi
  done
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
[[ -s "$OUT" ]] && cp "$OUT" "$OUT.prev"
: > "$OUT"
{
  printf 'model=%s\n' "$(hdc shell param get const.product.model 2>/dev/null | tr -d '\r')"
  printf 'os=%s\n' "$(hdc shell param get const.ohos.fullname 2>/dev/null | tr -d '\r')"
  printf 'date=%s\n' "$(date -u +%FT%TZ)"
} > "${OUT%.jsonl}.meta"

for page in tictactoe dashboard; do
  var="$(tr '[:lower:]' '[:upper:]' <<<"$page")_XY"
  for ((i = 1; i <= REPS; i++)); do
    hdc shell aa force-stop "$BUNDLE" >/dev/null 2>&1
    sleep 2
    hdc shell hilog -r >/dev/null 2>&1
    hdc shell aa start -a EntryAbility -b "$BUNDLE" >/dev/null 2>&1
    sleep 4                                        # let the ArkUI page settle

    src="env"
    xy="${!var:-}"
    [[ -n "$xy" ]] || { src="layout dump"; xy=$(locate "Bench $page" 2>/dev/null) || xy=""; }
    [[ -n "$xy" ]] || { src=fallback; xy="${FALLBACK[$page]:-}"; }
    [[ -n "$xy" ]] || {
      echo "could not find the 'Bench $page' button." >&2
      echo "Screenshot the device and set ${var}=\"<x> <y>\"." >&2
      exit 1
    }
    echo "[$page #$i] tap $xy ($src)" >&2
    hdc shell uitest uiInput click "$xy" >/dev/null 2>&1
    sleep 6

    log=$(hdc shell "hilog -x" 2>/dev/null | tr -d '\r' || true)
    run=$(grep -oE 'VERA_PROBE \{.*\}' <<<"$log" | tail -1 || true)
    ui=$(grep -oE 'VERA_PROBE_UI \{.*\}' <<<"$log" | tail -1 || true)
    if [[ -z "$run" ]]; then
      echo "ERROR: no VERA_PROBE line in hilog for $page, run $i (tap at $xy missed, or the app crashed?)." >&2
      echo "Results so far are in $OUT; the previous run, if any, is in $OUT.prev." >&2
      exit 1
    fi
    python3 - "$page" "$i" "${run#VERA_PROBE }" "${ui#VERA_PROBE_UI }" <<'PY' | tee -a "$OUT"
import json, sys
page, rep, run, ui = sys.argv[1:5]
rec = {"page": page, "rep": int(rep)}
try:
    rec.update(json.loads(run))
except ValueError:
    rec["raw"] = run
if ui:
    try:
        rec["ui"] = json.loads(ui)
    except ValueError:
        rec["ui_raw"] = ui
print(json.dumps(rec, separators=(",", ":")))
PY
  done
done

echo
echo "wrote $OUT"
