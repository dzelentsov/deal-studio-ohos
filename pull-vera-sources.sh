#!/usr/bin/env bash
# Pulls every saved .vera source off the device, one file per version.
#
# A project's versions live in the app sandbox as
#   {filesDir}/vera/<projectId>/<versionId>.json
# and each of those is a JSON object with a 'source' field holding the .vera
# text (plus 'vbc2', the compiled bytecode, and 'prompt', kept here too as a
# sidecar so it is clear what produced the file). A project with 0 versions --
# generated but never saved -- has no file here at all; read the Code tab live
# with uitest dumpLayout instead.
#
# The app sandbox is readable from `hdc shell` on the current system-signed
# build, so no uninstall, root or debug build is needed. settings.json (which
# holds the API key) is never copied.
#
# Usage:
#   ./pull-vera-sources.sh [--raw] [output-dir]      # default: ./vera-src
#   --raw   also keep the original JSON of every version and every program state
#           under <output-dir>/raw/ (a full copy of the saved projects)

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/tool-paths.sh"

vera_use_hdc || exit 1
vera_require_cmd python3 || exit 1

RAW=0
if [[ "${1:-}" == "--raw" ]]; then RAW=1; shift; fi
OUT="${1:-$SCRIPT_DIR/vera-src}"
BASE="/data/app/el2/100/base/com.vera.probe.dyn/haps/entry/files/vera"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$OUT"

echo "=== Reading the project index ==="
hdc shell "cat $BASE/index.json" > "$TMP/index.json" 2>&1 || true
if ! python3 -c 'import json, sys; json.load(open(sys.argv[1], encoding="utf-8"))' "$TMP/index.json" 2>/dev/null; then
  echo "ERROR: cannot read $BASE/index.json from the device." >&2
  echo "hdc said: $(head -n 1 "$TMP/index.json" | tr -d '\r' | cut -c1-200)" >&2
  echo "(Is a phone connected, has the app run at least once, and is HDC_DEVICE right?)" >&2
  exit 1
fi

echo "=== Listing version files ==="
# One line per file, <project-id>/<file>.json, one level below the index (so the
# index and settings.json are not listed). *.state.json are program state, not
# versions: they are only fetched with --raw.
mapfile -t FILES < <(hdc shell \
  "find $BASE -mindepth 2 -maxdepth 2 -name '*.json'" \
  2>/dev/null | tr -d '\r' | grep '^/' | sort)

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "No saved versions found -- every project here has 0 versions."
  exit 0
fi

python3 - "$TMP/index.json" "$TMP/names.json" <<'PY'
import json, sys
try:
    with open(sys.argv[1], encoding='utf-8') as f:
        projects = {p['id']: p['name'] for p in json.load(f)}
except (ValueError, KeyError, TypeError):
    print('warning: unexpected index.json layout; files are named by project id', file=sys.stderr)
    projects = {}
with open(sys.argv[2], 'w', encoding='utf-8') as f:
    json.dump(projects, f, ensure_ascii=False)
PY

COUNT=0
FAILED=0
for remote in "${FILES[@]}"; do
  [[ -z "$remote" ]] && continue
  is_state=0
  [[ "$remote" == *.state.json ]] && is_state=1
  [[ $is_state -eq 1 && $RAW -eq 0 ]] && continue
  version_id=$(basename "$remote" .json)
  project_id=$(basename "$(dirname "$remote")")
  local_json="$TMP/$project_id--$version_id.json"
  rm -f "$local_json"
  hdc file recv "$remote" "$local_json" >/dev/null 2>&1 || true
  if [[ ! -s "$local_json" ]]; then
    echo "  skip (could not fetch): $remote" >&2
    FAILED=$((FAILED + 1))
    continue
  fi
  if [[ $RAW -eq 1 ]]; then
    mkdir -p "$OUT/raw/$project_id"
    cp "$local_json" "$OUT/raw/$project_id/$(basename "$remote")"
  fi
  [[ $is_state -eq 1 ]] && continue
  written=$(python3 - "$local_json" "$OUT" "$TMP/names.json" "$project_id" "$version_id" <<'PY'
import json, re, sys
local_json, out_dir, names_path, project_id, version_id = sys.argv[1:6]
try:
    with open(local_json, encoding='utf-8') as f:
        data = json.load(f)
except (ValueError, OSError):
    print('')
    sys.exit(0)
if not isinstance(data, dict) or 'source' not in data:
    print('')
    sys.exit(0)
with open(names_path, encoding='utf-8') as f:
    names = json.load(f)
project_name = str(names.get(project_id, project_id))
safe = re.sub(r'[^A-Za-z0-9_-]+', '-', project_name).strip('-') or project_id
path = f'{out_dir}/{safe}--{version_id}.vera'
with open(path, 'w', encoding='utf-8', newline='') as f:
    f.write(data['source'])
prompt = data.get('prompt', '')
if prompt:
    with open(f'{out_dir}/{safe}--{version_id}.prompt.txt', 'w', encoding='utf-8', newline='') as f:
        f.write(prompt)
print(path)
PY
  ) || { echo "  skip (unreadable): $remote" >&2; FAILED=$((FAILED + 1)); continue; }
  if [[ -n "$written" ]]; then
    echo "  $written"
    COUNT=$((COUNT + 1))
  fi
done

echo
echo "=== Done: $COUNT source file(s) in $OUT ==="
[[ $RAW -eq 1 ]] && echo "Raw JSON copies are in $OUT/raw/"
if [[ $FAILED -gt 0 ]]; then
  echo "WARNING: $FAILED file(s) could not be fetched or read; this copy is incomplete." >&2
  exit 1
fi
