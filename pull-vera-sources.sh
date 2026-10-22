#!/usr/bin/env bash
# Pulls every saved .vera source off the device, one file per version.
#
# A project's versions live in the app sandbox as
#   {filesDir}/vera/<projectId>/<versionId>.json
# and each of those is a JSON object with a 'source' field holding the .vera
# text (plus 'vbc2', the compiled bytecode, and 'prompt', kept here too as a
# sidecar so it is clear what produced the file). A project with 0 versions --
# generated but never saved -- has no file here at all; see CLAUDE.md, "Checking
# things without a device", or read the Code tab live with uitest dumpLayout.
#
# Usage:
#   ./pull-vera-sources.sh [output-dir]      # default: ./vera-src
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/tool-paths.sh"

PATH="$(vera_hdc_dir):$PATH"
export PATH

OUT="${1:-$SCRIPT_DIR/vera-src}"
BASE="/data/app/el2/100/base/com.vera.probe.dyn/haps/entry/files/vera"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$OUT"

echo "=== Reading the project index ==="
hdc shell "cat $BASE/index.json" 2>/dev/null > "$TMP/index.json"
if [[ ! -s "$TMP/index.json" ]]; then
  echo "ERROR: no index.json on the device (or the app has never run)." >&2
  exit 1
fi

echo "=== Listing version files ==="
# One line per version file, project-id/version-id.json, skipping the index
# itself and the non-version json the app also keeps in the same directory.
mapfile -t FILES < <(hdc shell \
  "find $BASE -mindepth 2 -maxdepth 2 -name '*.json' ! -name '*.state.json'" \
  2>/dev/null | tr -d '\r')

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "No saved versions found -- every project here has 0 versions."
  exit 0
fi

python3 - "$OUT" "$TMP/index.json" <<'PY'
import json, sys
out_dir, index_path = sys.argv[1], sys.argv[2]
projects = {p['id']: p['name'] for p in json.load(open(index_path))}
json.dump(projects, open(sys.argv[2] + '.names', 'w'))
PY

COUNT=0
for remote in "${FILES[@]}"; do
  [[ -z "$remote" ]] && continue
  version_id=$(basename "$remote" .json)
  project_id=$(basename "$(dirname "$remote")")
  local_json="$TMP/$version_id.json"
  hdc file recv "$remote" "$local_json" >/dev/null 2>&1 || {
    echo "  skip (could not fetch): $remote" >&2
    continue
  }
  written=$(python3 - "$local_json" "$OUT" "$TMP/index.json.names" "$project_id" "$version_id" <<'PY'
import json, re, sys
local_json, out_dir, names_path, project_id, version_id = sys.argv[1:6]
try:
    data = json.load(open(local_json))
except (json.JSONDecodeError, OSError):
    print('')
    sys.exit(0)
if 'source' not in data:
    print('')
    sys.exit(0)
names = json.load(open(names_path))
project_name = names.get(project_id, project_id)
safe = re.sub(r'[^A-Za-z0-9_-]+', '-', project_name).strip('-') or project_id
path = f'{out_dir}/{safe}--{version_id}.vera'
with open(path, 'w') as f:
    f.write(data['source'])
prompt = data.get('prompt', '')
if prompt:
    with open(f'{out_dir}/{safe}--{version_id}.prompt.txt', 'w') as f:
        f.write(prompt)
print(path)
PY
)
  if [[ -n "$written" ]]; then
    echo "  $written"
    COUNT=$((COUNT + 1))
  fi
done

echo
echo "=== Done: $COUNT source file(s) in $OUT ==="
