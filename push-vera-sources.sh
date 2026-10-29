#!/usr/bin/env bash
# Copies saved VERA programs onto a phone -- the reverse of pull-vera-sources.sh.
#
# By default it works from what `./pull-vera-sources.sh` writes into the folder:
#   <project>--<versionId>.vera, .prompt.txt, .vbc2    the program, its prompt, its bytecode
#   manifest.json                                      the project catalogue and, for each
#                                                      version, the rest of its fields
# The version files the app keeps are rebuilt from these. At pull time every version
# was checked: it is marked "rebuildable" only if the rebuilt file is identical to
# the original. A project is added only if ALL its versions are rebuildable; the
# others are listed as skipped (use --raw for them). Program state (*.state.json)
# is not restored in this mode.
#
# With --raw it works from the complete copy made by `./pull-vera-sources.sh --raw`
# (the raw/ folder): the catalogue, every version JSON and every program state are
# copied byte for byte.
#
# What is touched on the phone, and what is not:
#   * a project is added only if its id is not in the phone's index.json;
#     projects already there are skipped whole, and no existing file is overwritten
#   * the phone's index.json is replaced as the very last step, after a copy of it
#     has been saved on this machine; until then the app's project list is untouched
#   * settings.json (API key, server address) is never touched
#
# Whether this works depends on the phone letting the hdc shell write into the app
# sandbox, and on the app being able to read what was written (same owner). So
# nothing is changed unless --apply is given, and --check reports exactly that.
#
# Usage:
#   ./push-vera-sources.sh [--raw] [dir]          dry run: show what would be added
#   ./push-vera-sources.sh --check                can this phone take files? (writes one
#                                                 tiny probe file in the sandbox and removes it)
#   ./push-vera-sources.sh --apply [--raw] [dir]  copy the projects (stops the app first)
#   dir is the folder pull-vera-sources.sh wrote to; it defaults to ./vera-src next to
#   this script. With --raw the raw/ folder inside it is used (raw/ itself works too).
#
# With more than one phone connected, export HDC_DEVICE first. The app must be
# installed on the target and have saved at least one program there (that
# creates the vera/ directory). Use the same app version on both phones.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/tool-paths.sh"

usage() {
  echo "usage: $0 [--check | --apply] [--raw] [dir]" >&2
  exit 2
}

MODE=plan
FROM_RAW=0
while [[ "${1:-}" == -* ]]; do
  case "$1" in
    --check) MODE=check ;;
    --apply) MODE=apply ;;
    --raw) FROM_RAW=1 ;;
    *) usage ;;
  esac
  shift
done
DATA_DIR="${1:-$SCRIPT_DIR/vera-src}"

vera_use_hdc || exit 1
vera_require_cmd python3 || exit 1

BUNDLE="com.vera.probe.dyn"
BASE="/data/app/el2/100/base/$BUNDLE/haps/entry/files/vera"
STAGE="/data/local/tmp/vera-push-$$"
TMP=$(mktemp -d)
STAGE_CREATED=0
INDEX_REPLACED=0
APP_OWNER=""

cleanup() {
  local rc=$?
  if [[ $STAGE_CREATED -eq 1 ]]; then
    hdc shell "rm -rf $STAGE" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
  if [[ $rc -ne 0 && "$MODE" == apply ]]; then
    if [[ $INDEX_REPLACED -eq 1 ]]; then
      echo "Stopped after the phone's index.json was replaced; see the messages above." >&2
    else
      echo "Stopped before the phone's index.json was replaced: the app's project list is untouched" >&2
      echo "(files copied so far are not referenced by it and are harmless)." >&2
    fi
  fi
}
trap cleanup EXIT

# remote_test -d|-f PATH  -> success if the test holds on the phone
remote_test() {
  [[ "$(hdc shell "[ $1 $2 ] && echo yes || echo no" 2>/dev/null | tr -d '\r' | tail -n 1)" == yes ]]
}

# owner_of PATH -> prints uid:gid of a path on the phone
owner_of() {
  local line uid gid
  line=$(hdc shell "ls -ldn $1" 2>/dev/null | tr -d '\r' | head -n 1)
  read -r _ _ uid gid _ <<<"$line"
  [[ "$uid" =~ ^[0-9]+$ && "$gid" =~ ^[0-9]+$ ]] || return 1
  printf '%s:%s\n' "$uid" "$gid"
}

# Can the hdc shell leave a file in the sandbox that the app can read?
# Sets APP_OWNER; returns 0 if yes.
probe_sandbox() {
  local probe="$BASE/.vera-push-probe" written file_owner chowned after relabel
  APP_OWNER=$(owner_of "$BASE") || { echo "  cannot read the owner of $BASE"; return 1; }
  written=$(hdc shell "echo ok > $probe && echo yes || echo no" 2>/dev/null | tr -d '\r' | tail -n 1)
  if [[ "$written" != yes ]]; then
    printf '  owner of the vera directory : %s\n  write by the hdc shell       : no\n' "$APP_OWNER"
    return 1
  fi
  file_owner=$(owner_of "$probe" || true)
  chowned=$(hdc shell "chown $APP_OWNER $probe && echo yes || echo no" 2>/dev/null | tr -d '\r' | tail -n 1)
  after=$(owner_of "$probe" || true)
  hdc shell "rm -f $probe" >/dev/null 2>&1 || true
  relabel=$(hdc shell "command -v restorecon" 2>/dev/null | tr -d '\r' | head -n 1)
  printf '  owner of the vera directory : %s\n' "$APP_OWNER"
  printf '  write by the hdc shell       : yes\n'
  printf '  owner of a new file          : %s\n' "${file_owner:-unknown}"
  printf '  chown to the directory owner : %s (owner afterwards: %s)\n' "$chowned" "${after:-unknown}"
  printf '  restorecon on the phone      : %s\n' "${relabel:-not found (SELinux labels of new files cannot be fixed or checked here)}"
  [[ "$after" == "$APP_OWNER" ]]
}

echo "=== Target phone ==="
vera_signing_device
echo "Model: $(hdc shell param get const.product.model 2>/dev/null | tr -d '\r' | head -n 1)"

if ! remote_test -d "$BASE"; then
  echo "ERROR: $BASE does not exist on the phone." >&2
  echo "Open the app there and save one program first (that creates the directory)." >&2
  exit 1
fi

if [[ "$MODE" == check ]]; then
  echo
  echo "=== Sandbox write check ==="
  if probe_sandbox; then
    echo "OK: the hdc shell can put files into the sandbox with the app's owner."
    echo "(This cannot prove the app accepts them; try --apply with one small project first.)"
    exit 0
  fi
  echo "NOT OK: this phone does not let the hdc shell put files into the sandbox in a form the app can read. Nothing was changed."
  exit 1
fi

DATA_DIR=$(cd -- "$DATA_DIR" 2>/dev/null && pwd) || {
  echo "ERROR: folder not found. Make it with ./pull-vera-sources.sh." >&2
  exit 1
}
if [[ $FROM_RAW -eq 1 ]]; then
  RAW="$DATA_DIR"
  if [[ ! -f "$RAW/index.json" && -f "$RAW/raw/index.json" ]]; then
    RAW="$RAW/raw"
  fi
  [[ -f "$RAW/index.json" ]] || {
    echo "ERROR: $RAW/index.json not found." >&2
    echo "Make the copy with ./pull-vera-sources.sh --raw (it saves the project list in raw/)." >&2
    exit 1
  }
  BACKUP_BASE=$(dirname "$RAW")
else
  [[ -f "$DATA_DIR/manifest.json" ]] || {
    echo "ERROR: $DATA_DIR/manifest.json not found." >&2
    echo "Make it with ./pull-vera-sources.sh (or use --raw to restore from the complete copy)." >&2
    exit 1
  }
  RAW="$TMP/build"
  BACKUP_BASE="$DATA_DIR"
  echo
  echo "=== Rebuilding the version files from the plain files ==="
  python3 - "$DATA_DIR" "$DATA_DIR/manifest.json" "$RAW" <<'PY'
import json, os, re, sys
data_dir, manifest_path, build_dir = sys.argv[1:4]
SAFE_ID = re.compile(r'^[A-Za-z0-9_-]+$')
SAFE_FILE = re.compile(r'^[A-Za-z0-9_.-]+\.json$')

def read_text(path):
    with open(path, encoding='utf-8', newline='') as f:
        return f.read()

try:
    with open(manifest_path, encoding='utf-8') as f:
        manifest = json.load(f)
except (OSError, ValueError):
    sys.exit('ERROR: %s is not a valid manifest' % manifest_path)

os.makedirs(build_dir, exist_ok=True)
index, ready, skipped = [], 0, []
for project in manifest.get('projects', []):
    pid = str(project.get('id', ''))
    entry = project.get('index_entry')
    name = project.get('name') or pid
    if not project.get('in_index') or not isinstance(entry, dict) or not SAFE_ID.match(pid):
        continue                                   # not in the catalogue: nothing to restore
    built, problem = {}, None
    for version in project.get('versions', []):
        fname = os.path.basename(version.get('phone_path', ''))
        names = version.get('readable_files') or []
        vera = [n for n in names if n.endswith('.vera')]
        if 'rebuildable' not in version:
            problem = 'the manifest is from an older pull-vera-sources.sh; run it again'
            break
        if not version.get('rebuildable') or not vera or not SAFE_FILE.match(fname):
            problem = 'version %s cannot be rebuilt from the plain files' % version.get('version')
            break
        try:
            obj = dict(version.get('fields') or {})
            for n in names:
                path = os.path.join(data_dir, n)
                if n.endswith('.vera'):
                    obj['source'] = read_text(path)
                elif n.endswith('.prompt.txt'):
                    obj['prompt'] = read_text(path)
                elif n.endswith('.vbc2'):
                    text = read_text(path)
                    obj['vbc2'] = text if version.get('vbc2_kind') == 'string' else json.loads(text)
        except (OSError, ValueError):
            problem = 'a file of version %s is missing or unreadable' % version.get('version')
            break
        built[fname] = obj
    if problem:
        skipped.append((name, pid, problem))
        continue
    index.append(entry)
    ready += 1
    if built:
        os.makedirs(os.path.join(build_dir, pid), exist_ok=True)
        for fname, obj in built.items():
            with open(os.path.join(build_dir, pid, fname), 'w', encoding='utf-8') as f:
                json.dump(obj, f, ensure_ascii=False)
with open(os.path.join(build_dir, 'index.json'), 'w', encoding='utf-8') as f:
    json.dump(index, f, ensure_ascii=False)
for name, pid, why in skipped:
    print('  skip    %s (%s): %s%s' % (name, pid, why, '' if 'run it again' in why else '; use --raw'))
print('%d project(s) can be rebuilt, %d skipped' % (ready, len(skipped)))
PY
fi

if remote_test -f "$BASE/index.json"; then
  INDEX_EXISTS=1
  hdc shell "cat $BASE/index.json" > "$TMP/target-index.json" 2>&1 || true
  if ! python3 -c 'import json, sys; json.load(open(sys.argv[1], encoding="utf-8"))' "$TMP/target-index.json" 2>/dev/null; then
    echo "ERROR: the index.json on the phone is not valid JSON; refusing to touch it." >&2
    exit 1
  fi
else
  INDEX_EXISTS=0
  echo '[]' > "$TMP/target-index.json"
fi

echo
echo "=== Plan ==="
python3 - "$RAW" "$TMP/target-index.json" "$TMP/merged-index.json" "$TMP/new-projects.txt" "$TMP/files.txt" <<'PY'
import json, os, re, sys
raw, target_path, merged_path, new_path, files_path = sys.argv[1:6]
SAFE_ID = re.compile(r'^[A-Za-z0-9_-]+$')
SAFE_FILE = re.compile(r'^[A-Za-z0-9_.-]+\.json$')

def load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)

try:
    source = load(os.path.join(raw, 'index.json'))
except (OSError, ValueError):
    source = None
if not isinstance(source, list):
    sys.exit('ERROR: %s/index.json is not a valid project list' % raw)
target = load(target_path)
if not isinstance(target, list):
    sys.exit('ERROR: the index.json on the phone is not a list; refusing to touch it')

have = {p.get('id') for p in target if isinstance(p, dict)}
merged = list(target)
new_ids, files = [], []
for p in source:
    if not isinstance(p, dict) or 'id' not in p:
        print('  skip    an entry without an id in the raw index')
        continue
    pid = str(p['id'])
    name = p.get('name', pid)
    if not SAFE_ID.match(pid):
        print('  skip    %s: unusual project id %r' % (name, pid))
        continue
    if pid in have:
        print('  skip    %s (%s): already on the phone' % (name, pid))
        continue
    pdir = os.path.join(raw, pid)
    names = sorted(os.listdir(pdir)) if os.path.isdir(pdir) else []
    names = [n for n in names if SAFE_FILE.match(n)]
    states = [n for n in names if n.endswith('.state.json')]
    print('  add     %s (%s): %d version file(s), %d state file(s)'
          % (name, pid, len(names) - len(states), len(states)))
    merged.append(p)
    new_ids.append(pid)
    files.extend('%s/%s' % (pid, n) for n in names)

with open(merged_path, 'w', encoding='utf-8') as f:
    json.dump(merged, f, ensure_ascii=False)
for path, items in ((new_path, new_ids), (files_path, files)):
    with open(path, 'w', encoding='utf-8') as f:
        f.write(''.join(i + '\n' for i in items))
PY

mapfile -t NEW_IDS < "$TMP/new-projects.txt"
mapfile -t FILES < "$TMP/files.txt"

if [[ ${#NEW_IDS[@]} -eq 0 ]]; then
  echo
  echo "Nothing to add."
  exit 0
fi

if [[ "$MODE" == plan ]]; then
  echo
  echo "Dry run: nothing was changed on the phone."
  echo "Next: $0 --check   (can this phone take files?), then $0 --apply"
  exit 0
fi

echo
echo "=== Sandbox write check ==="
probe_sandbox || {
  echo "ERROR: this phone does not let the hdc shell put files into the sandbox in a form the app can read; refusing. Nothing was changed." >&2
  exit 1
}

echo
echo "=== Applying ==="
echo "Stopping the app on the phone (it would overwrite index.json from memory)."
hdc shell "aa force-stop $BUNDLE" >/dev/null 2>&1 || true

BACKUP_DIR="$BACKUP_BASE/push-backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
if [[ $INDEX_EXISTS -eq 1 ]]; then
  cp "$TMP/target-index.json" "$BACKUP_DIR/index.json"
  echo "Saved the phone's current index.json to $BACKUP_DIR/index.json"
fi

STAGE_CREATED=1
hdc shell "mkdir -p $STAGE" >/dev/null 2>&1
for pid in "${NEW_IDS[@]}"; do
  hdc shell "mkdir -p $STAGE/$pid" >/dev/null 2>&1
done

# send_checked LOCAL REMOTE: copy to the staging area and compare sizes
send_checked() {
  local local_size remote_size
  local_size=$(wc -c < "$1" | tr -d ' ')
  hdc file send "$1" "$2" >/dev/null 2>&1 || true
  remote_size=$(hdc shell "wc -c < $2" 2>/dev/null | tr -d '\r ' | tail -n 1)
  if [[ "$local_size" != "$remote_size" ]]; then
    echo "ERROR: transfer of $1 failed (local $local_size bytes, phone ${remote_size:-nothing})." >&2
    return 1
  fi
}

echo "Sending to the staging area $STAGE on the phone:"
for rel in ${FILES[@]+"${FILES[@]}"}; do
  send_checked "$RAW/$rel" "$STAGE/$rel"
  echo "  $rel"
done
send_checked "$TMP/merged-index.json" "$STAGE/index.json"

HAS_RESTORECON=0
[[ -n "$(hdc shell "command -v restorecon" 2>/dev/null | tr -d '\r' | head -n 1)" ]] && HAS_RESTORECON=1

echo "Moving the files into the sandbox:"
for rel in ${FILES[@]+"${FILES[@]}"}; do
  pid=${rel%%/*}
  ok=$(hdc shell "mkdir -p $BASE/$pid && cp $STAGE/$rel $BASE/$rel && chown $APP_OWNER $BASE/$pid $BASE/$rel && echo yes || echo no" 2>/dev/null | tr -d '\r' | tail -n 1)
  if [[ "$ok" != yes ]]; then
    echo "ERROR: could not place $rel in the sandbox." >&2
    exit 1
  fi
  echo "  $rel"
done
if [[ $HAS_RESTORECON -eq 1 ]]; then
  for pid in "${NEW_IDS[@]}"; do
    hdc shell "[ -d $BASE/$pid ] && restorecon -R $BASE/$pid" >/dev/null 2>&1 || true
  done
fi

echo "Replacing index.json (last step):"
ok=$(hdc shell "cp $STAGE/index.json $BASE/index.json.new && chown $APP_OWNER $BASE/index.json.new && mv $BASE/index.json.new $BASE/index.json && echo yes || echo no" 2>/dev/null | tr -d '\r' | tail -n 1)
if [[ "$ok" != yes ]]; then
  echo "ERROR: could not replace index.json; the project list on the phone is unchanged." >&2
  exit 1
fi
INDEX_REPLACED=1
if [[ $HAS_RESTORECON -eq 1 ]]; then
  hdc shell "restorecon $BASE/index.json" >/dev/null 2>&1 || true
fi

echo
echo "=== Verifying ==="
hdc shell "cat $BASE/index.json" > "$TMP/after-index.json" 2>&1 || true
python3 - "$TMP/after-index.json" "$TMP/new-projects.txt" <<'PY'
import json, sys
with open(sys.argv[1], encoding='utf-8') as f:
    ids = {p.get('id') for p in json.load(f) if isinstance(p, dict)}
with open(sys.argv[2], encoding='utf-8') as f:
    wanted = [line.strip() for line in f if line.strip()]
missing = [i for i in wanted if i not in ids]
if missing:
    sys.exit('ERROR: not in the phone\'s index.json afterwards: ' + ', '.join(missing))
print('  index.json on the phone lists all %d new project(s)' % len(wanted))
PY
BAD=0
for rel in ${FILES[@]+"${FILES[@]}"}; do
  if ! remote_test -f "$BASE/$rel"; then
    echo "  MISSING on the phone: $rel" >&2
    BAD=$((BAD + 1))
    continue
  fi
  if [[ "$(owner_of "$BASE/$rel" || true)" != "$APP_OWNER" ]]; then
    echo "  WARNING: $rel is not owned by $APP_OWNER; the app may not be able to read it." >&2
    BAD=$((BAD + 1))
  fi
done
[[ $BAD -eq 0 ]] && echo "  ${#FILES[@]} file(s) are in place with the app's owner"

echo
echo "=== Done: ${#NEW_IDS[@]} project(s) added ==="
echo "Start the app on the phone: the projects should be in the list."
echo "If the app misbehaves, put the old project list back (your local copy is in $BACKUP_DIR):"
if [[ $INDEX_EXISTS -eq 1 ]]; then
  echo "  hdc -t \"$HDC_DEVICE\" file send \"$BACKUP_DIR/index.json\" /data/local/tmp/index.json.restore"
  echo "  hdc -t \"$HDC_DEVICE\" shell \"cp /data/local/tmp/index.json.restore $BASE/index.json.new && chown $APP_OWNER $BASE/index.json.new && mv $BASE/index.json.new $BASE/index.json\""
else
  echo "  (the phone had no index.json before: hdc -t \"$HDC_DEVICE\" shell \"rm $BASE/index.json\")"
fi
[[ $BAD -eq 0 ]] || exit 1
