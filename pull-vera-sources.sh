#!/usr/bin/env bash
# Pulls the saved programs off the phone, as plain files, one set per version.
#
# On the phone everything lives in the app sandbox, under
#   {filesDir}/vera/
#     index.json                       the project catalogue
#     settings.json                    API key, model, endpoints (a secret)
#     <projectId>/<versionId>.json     one saved version: 'source' (the .vera text),
#                                      'vbc2' (the compiled bytecode), 'prompt' and
#                                      whatever else the app keeps
#     <projectId>/*.state.json         saved state of a program
#
# By default, for every saved version this writes into <output-dir> (default:
# ./vera-src next to this script):
#   <project>--<versionId>.vera          the program (the 'source' field)
#   <project>--<versionId>.prompt.txt    the prompt that produced it (a prompt file is
#                                        written whenever the version has a prompt field)
#   <project>--<versionId>.vbc2          the compiled bytecode field, as stored
#   manifest.json                        the project catalogue, each project's versions
#                                        in the order they were saved, sizes and
#                                        SHA-256 of the version files, the phone's
#                                        modification times, phone model, OS build
#                                        and app version, and whether each version
#                                        can be rebuilt from these plain files
#                                        ("rebuildable"; see push-vera-sources.sh)
# File times of the written files are set to the phone's, so `ls -t` shows the
# versions in the order they were saved. Nothing else is copied: no program state,
# no settings.json.
#
# With --raw it also makes an exact copy of the WHOLE directory in <output-dir>/raw/
# (same layout): every file byte for byte, at any depth, each checked against its
# size on the phone -- the catalogue, every version JSON, *.state.json, settings.json
# and anything else. That is the copy push-vera-sources.sh restores from, and the
# backup to take before anything risky. settings.json holds the API key in plain
# text; it is copied with mode 600, or left out with --no-settings.
#
# A project with 0 versions -- generated but never saved -- has no version file on
# the phone, only its entry in the catalogue (kept in manifest.json, and in raw/).
# Read its Code tab live with uitest dumpLayout instead.
#
# Nothing on the phone is changed. The app sandbox is readable from `hdc shell` on
# the current system-signed build, so no uninstall, root or debug build is needed.
#
# Running it again into the same folder refreshes it. Files that have been removed
# on the phone are not deleted here. Leave the app idle while it runs: a file that
# changes in the middle is reported as a size mismatch; just run again.
#
# Usage:
#   ./pull-vera-sources.sh [--raw [--no-settings]] [output-dir]     # default: ./vera-src
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/tool-paths.sh"

vera_use_hdc || exit 1
vera_require_cmd python3 || exit 1

RAW=0
SETTINGS=1
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --raw) RAW=1 ;;
    --no-settings) SETTINGS=0 ;;
    *) echo "usage: $0 [--raw [--no-settings]] [output-dir]" >&2; exit 2 ;;
  esac
  shift
done
OUT="${1:-$SCRIPT_DIR/vera-src}"
RAWDIR="$OUT/raw"
BUNDLE="com.vera.probe.dyn"
BASE="/data/app/el2/100/base/$BUNDLE/haps/entry/files/vera"
TMP=$(mktemp -d)
WORK="$TMP/work"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$OUT" "$WORK"
[[ $RAW -eq 1 ]] && mkdir -p "$RAWDIR"

echo "=== Reading the project index ==="
hdc shell "cat $BASE/index.json" > "$TMP/index.json" 2>&1 || true
if ! python3 -c 'import json, sys; json.load(open(sys.argv[1], encoding="utf-8"))' "$TMP/index.json" 2>/dev/null; then
  echo "ERROR: cannot read $BASE/index.json from the device." >&2
  echo "hdc said: $(head -n 1 "$TMP/index.json" | tr -d '\r' | cut -c1-200)" >&2
  echo "(Is a phone connected, has the app run at least once, and is HDC_DEVICE right?)" >&2
  exit 1
fi

echo "=== Listing the files on the phone ==="
# Every file below the vera directory, at any depth: "<size> <mtime> <path>".
# If stat is missing on the phone, fall back to the bare paths ("- - <path>").
hdc shell "find $BASE -type f -exec stat -c '%s %Y %n' {} \\;" 2>/dev/null \
  | tr -d '\r' > "$TMP/listing.txt" || true
if ! grep -qE '^[0-9]+ [0-9]+ /' "$TMP/listing.txt"; then
  { hdc shell "find $BASE -type f" 2>/dev/null | tr -d '\r' | grep '^/' | sed 's/^/- - /'; } \
    > "$TMP/listing.txt" || true
fi

# Which files to fetch: with --raw all of them (index.json included, so raw/ is
# byte for byte); otherwise only the version files (<project>/<version>.json, not
# *.state.json). The index.json read above is only used for names and the manifest.
python3 - "$BASE" "$TMP/listing.txt" "$TMP/files.tsv" "$RAW" "$SETTINGS" <<'PY'
import re, sys
base, listing, tsv, raw, settings = sys.argv[1:6]
pattern = re.compile(r'^(\d+|-) (\d+|-) (/.+)$')
version = re.compile(r'^[^/]+/[^/]+\.json$')
rows = {}
with open(listing, encoding='utf-8', errors='replace') as f:
    for line in f:
        m = pattern.match(line.rstrip('\n'))
        if not m:
            continue
        size, mtime, path = m.groups()
        if not path.startswith(base + '/') or '\t' in path:
            continue
        rel = path[len(base) + 1:]
        if rel == '.vera-push-probe' or rel.endswith('/.vera-push-probe'):
            continue
        if raw == '1':
            if rel == 'settings.json' and settings != '1':
                continue
        elif not version.match(rel) or rel.endswith('.state.json'):
            continue
        rows[rel] = (size, mtime)
with open(tsv, 'w', encoding='utf-8') as f:
    for rel in sorted(rows):
        f.write('%s\t%s\t%s\n' % (rows[rel][0], rows[rel][1], rel))
PY

if [[ ! -s "$TMP/files.tsv" ]]; then
  if [[ $RAW -eq 1 ]]; then
    echo "No files besides index.json under $BASE on the phone."
  else
    echo "No saved versions found -- every project here has 0 versions."
  fi
fi
echo "$(wc -l < "$TMP/files.tsv" | tr -d ' ') file(s) to copy."

echo "=== Copying ==="
FETCHED=0
FAILED=0
while IFS=$'\t' read -r size _ rel; do
  [[ -n "$rel" ]] || continue
  fetched="$TMP/fetch.bin"
  rm -f "$fetched"
  hdc file recv "$BASE/$rel" "$fetched" >/dev/null 2>&1 </dev/null || true
  if [[ ! -e "$fetched" ]]; then
    echo "  FAILED (could not fetch): $rel" >&2
    FAILED=$((FAILED + 1))
    continue
  fi
  got=$(wc -c < "$fetched" | tr -d ' ')
  if [[ "$size" == "-" ]]; then
    # no stat on the phone: ask for the size of this one file
    size=$(hdc shell "wc -c < $BASE/$rel" 2>/dev/null </dev/null | tr -d '\r ' | tail -n 1)
    [[ "$size" =~ ^[0-9]+$ ]] || size="-"
  fi
  if [[ "$size" != "-" && "$got" != "$size" ]]; then
    echo "  FAILED (got $got bytes, the phone has $size): $rel" >&2
    FAILED=$((FAILED + 1))
    continue
  fi
  mkdir -p "$(dirname "$WORK/$rel")"
  mv "$fetched" "$WORK/$rel"
  if [[ $RAW -eq 1 ]]; then
    mkdir -p "$(dirname "$RAWDIR/$rel")"
    cp "$WORK/$rel" "$RAWDIR/$rel"
    [[ "$rel" == settings.json ]] && chmod 600 "$RAWDIR/$rel"
  fi
  FETCHED=$((FETCHED + 1))
  echo "  $rel ($got bytes)"
done < "$TMP/files.tsv"

echo "=== Device and app information ==="
MODEL=$(hdc shell param get const.product.model 2>/dev/null </dev/null | tr -d '\r' | head -n 1 || true)
OSBUILD=$(hdc shell param get const.ohos.fullname 2>/dev/null </dev/null | tr -d '\r' | head -n 1 || true)
hdc shell "bm dump -n $BUNDLE" > "$TMP/bm.txt" 2>&1 </dev/null || true
echo "Model: ${MODEL:-unknown}; OS: ${OSBUILD:-unknown}"

echo "=== Writing the program files and manifest.json ==="
RAW_ARG=""
[[ $RAW -eq 1 ]] && RAW_ARG="$RAWDIR"
python3 - "$WORK" "$RAW_ARG" "$OUT" "$TMP/files.tsv" \
  "$TMP/index.json" "$TMP/bm.txt" "${MODEL:-}" "${OSBUILD:-}" "$SETTINGS" "$BUNDLE" "$FAILED" <<'PY'
import hashlib, json, os, re, sys, time
work_dir, raw_dir, out_dir, tsv_path, index_path, bm_path, model, os_build, settings, bundle, failed = sys.argv[1:12]
BIG = {'source', 'vbc2', 'prompt'}

def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()

def iso(ts):
    return None if ts is None else time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(ts))

def set_time(path, ts):
    if ts is not None and os.path.exists(path):
        os.utime(path, (ts, ts))

def write_text(path, text, ts):
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(text)
    set_time(path, ts)

def extra_fields(data):
    """Every top-level field except source, vbc2 and prompt (those live in their own
    files), unless one is larger than 20 KB; then that version is not rebuildable."""
    return {key: value for key, value in data.items()
            if key not in BIG and len(json.dumps(value, ensure_ascii=False)) <= 20000}

def read_text(path):
    with open(path, encoding='utf-8', newline='') as f:
        return f.read()

def rebuild(fields, kind, written):
    """The recipe push-vera-sources.sh uses to rebuild a version file from the
    plain files. Keep the two in sync."""
    obj = dict(fields)
    for path in written:
        if path.endswith('.vera'):
            obj['source'] = read_text(path)
        elif path.endswith('.prompt.txt'):
            obj['prompt'] = read_text(path)
        elif path.endswith('.vbc2'):
            text = read_text(path)
            obj['vbc2'] = text if kind == 'string' else json.loads(text)
    return obj

try:
    with open(index_path, encoding='utf-8') as f:
        index = json.load(f)
except (OSError, ValueError):
    index = []
catalogue = {}
if isinstance(index, list):
    for entry in index:
        if isinstance(entry, dict) and 'id' in entry:
            catalogue[str(entry['id'])] = entry

app = {}
try:
    with open(bm_path, encoding='utf-8', errors='replace') as f:
        text = f.read()
    info = json.loads(text[text.index('{'):].rstrip('\x00\r\n '))
    for key in ('versionName', 'versionCode', 'updateTime'):
        if key in info:
            app[key] = info[key]
except (OSError, ValueError):
    pass

with open(tsv_path, encoding='utf-8') as f:
    rows = [line.rstrip('\n').split('\t') for line in f if line.strip()]

raw_files, versions, raw_total, programs, fetched_total = [], {}, 0, [], 0
for size, mtime, rel in rows:
    path = os.path.join(work_dir, rel)
    if not os.path.isfile(path):
        continue                                   # could not be fetched
    ts = int(mtime) if mtime.isdigit() else None
    nbytes = os.path.getsize(path)
    fetched_total += 1
    if raw_dir:
        set_time(os.path.join(raw_dir, rel), ts)
        raw_total += nbytes
        raw_files.append({'path': 'raw/' + rel, 'bytes': nbytes, 'sha256': sha256(path), 'phone_mtime': iso(ts)})
    m = re.match(r'^([^/]+)/([^/]+)\.json$', rel)
    if not m or rel.endswith('.state.json'):
        continue
    pid, vid = m.groups()
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = None
    record = {'version': vid, 'phone_path': rel, 'bytes': nbytes, 'sha256': sha256(path),
              'phone_mtime': iso(ts), 'has_source': isinstance(data, dict) and 'source' in data,
              'rebuildable': False}
    if raw_dir:
        record['raw_path'] = 'raw/' + rel
    if record['has_source']:
        name = str(catalogue.get(pid, {}).get('name', pid))
        safe = re.sub(r'[^A-Za-z0-9_-]+', '-', name).strip('-') or pid
        stem = os.path.join(out_dir, '%s--%s' % (safe, vid))
        written = []
        write_text(stem + '.vera', str(data['source']), ts)
        written.append(stem + '.vera')
        if isinstance(data.get('prompt'), str):
            write_text(stem + '.prompt.txt', data['prompt'], ts)
            written.append(stem + '.prompt.txt')
        if 'vbc2' in data:
            value = data['vbc2']
            write_text(stem + '.vbc2', value if isinstance(value, str) else json.dumps(value, ensure_ascii=False), ts)
            written.append(stem + '.vbc2')
        record['has_vbc2'] = 'vbc2' in data
        record['vbc2_kind'] = (None if 'vbc2' not in data
                               else 'string' if isinstance(data['vbc2'], str) else 'json')
        record['readable_files'] = [os.path.basename(p) for p in written]
        record['fields'] = extra_fields(data)
        # Can push-vera-sources.sh rebuild this exact version from the plain files
        # and manifest.json alone? True only if the rebuilt object equals the original.
        try:
            record['rebuildable'] = rebuild(record['fields'], record['vbc2_kind'], written) == data
        except (OSError, ValueError):
            record['rebuildable'] = False
        programs.extend(written)
    versions.setdefault(pid, []).append((ts, record))

projects = []
for pid in list(catalogue) + [p for p in versions if p not in catalogue]:
    ordered = sorted(versions.get(pid, []), key=lambda t: (t[0] is None, t[0] or 0, t[1]['version']))
    stamped = [t for t in ordered if t[0] is not None and t[1]['has_source']]
    if stamped:
        stamped[-1][1]['latest_by_phone_mtime'] = True
    projects.append({'id': pid, 'name': catalogue.get(pid, {}).get('name'),
                     'in_index': pid in catalogue, 'index_entry': catalogue.get(pid),
                     'versions': [rec for _, rec in ordered]})

manifest = {
    'created_utc': iso(int(time.time())),
    'tool': 'pull-vera-sources.sh',
    'bundle': bundle,
    'phone': {'model': model or None, 'os': os_build or None, 'app': app},
    'raw_copy': bool(raw_dir),
    'settings_copied': bool(raw_dir) and settings == '1',
    'failed_files': int(failed),
    'totals': {'files_fetched': fetched_total, 'projects': len(projects),
               'versions': sum(len(p['versions']) for p in projects)},
    'note': 'Version order and "latest" come from file modification times on the phone.',
    'projects': projects,
}
if raw_dir:
    manifest['totals']['raw_bytes'] = raw_total
    manifest['raw_files'] = raw_files
with open(os.path.join(out_dir, 'manifest.json'), 'w', encoding='utf-8') as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)
    f.write('\n')
for path in programs:
    if path.endswith('.vera'):
        print('  ' + path)
print('%d program(s) in %d project(s)' % (len([p for p in programs if p.endswith('.vera')]), len(projects)))
PY

echo
echo "=== Done: $FETCHED file(s) fetched ==="
echo "Manifest: $OUT/manifest.json"
if [[ $RAW -eq 1 ]]; then
  echo "Complete copy: $RAWDIR/"
  if [[ $SETTINGS -eq 1 ]]; then
    echo "NOTE: raw/settings.json contains the API key in plain text (mode 600). Keep it out of git."
  fi
fi
if [[ $FAILED -gt 0 ]]; then
  echo "WARNING: $FAILED file(s) could not be fetched or did not match their size; this copy is incomplete." >&2
  exit 1
fi
