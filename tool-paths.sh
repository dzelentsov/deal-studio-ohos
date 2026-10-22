#!/usr/bin/env bash

vera_kit_bin() {
  local exe="$1" sub
  if [ -n "${KIT_ROOT:-}" ]; then
    for sub in tools .venv/bin bin; do
      if [ -x "$KIT_ROOT/$sub/$exe" ]; then
        printf '%s\n' "$KIT_ROOT/$sub/$exe"
        return 0
      fi
    done
    printf 'ERROR: KIT_ROOT is %s but %s is not in tools/, .venv/bin/ or bin/.\n' "$KIT_ROOT" "$exe" >&2
    return 1
  fi
  if command -v "$exe" >/dev/null 2>&1; then
    command -v "$exe"
    return 0
  fi
  printf 'ERROR: cannot find %s. Add it to PATH or set KIT_ROOT.\n' "$exe" >&2
  return 1
}

vera_hvigorw() {
  local wrapper="${HVIGORW:-}"
  if [ -z "$wrapper" ]; then
    printf 'ERROR: HVIGORW is required. Export it with the full path to the Hvigor 7.26.0.static wrapper; PATH is not used.\n' >&2
    return 1
  fi
  if [[ "$wrapper" != /* ]]; then
    printf 'ERROR: HVIGORW must be an absolute path to the Hvigor wrapper.\n' >&2
    return 1
  fi
  if [ -f "$wrapper" ] && [ -r "$wrapper" ]; then
    printf '%s\n' "$wrapper"
    return 0
  fi
  printf 'ERROR: cannot read hvigorw at %s. Set HVIGORW to the Hvigor wrapper.\n' "$wrapper" >&2
  return 1
}

vera_sdk_home() {
  local name sdk
  for name in OHOS_BASE_SDK_HOME DEVECO_SDK_HOME; do
    sdk="${!name:-}"
    if [ -z "$sdk" ]; then
      printf 'ERROR: %s is required. Export it with the SDK root.\n' "$name" >&2
      return 1
    fi
    if [ ! -d "$sdk" ]; then
      printf 'ERROR: %s is %s but that directory does not exist.\n' "$name" "$sdk" >&2
      return 1
    fi
  done
  printf '%s\n' "$OHOS_BASE_SDK_HOME"
}

vera_hdc_dir() {
  if [ -n "${HDC_DIR:-}" ]; then
    [ -x "$HDC_DIR/hdc" ] && { printf '%s\n' "$HDC_DIR"; return 0; }
    printf 'ERROR: HDC_DIR is %s but there is no executable hdc in it.\n' "$HDC_DIR" >&2
    return 1
  fi
  if command -v hdc >/dev/null 2>&1; then
    dirname "$(command -v hdc)"
    return 0
  fi
  printf 'ERROR: cannot find hdc. Add its toolchains directory to PATH or set HDC_DIR.\n' >&2
  return 1
}

vera_signing_device() {
  local targets actual_udid
  HDC_DIR=$(vera_hdc_dir) || return 1
  targets=$("$HDC_DIR/hdc" list targets) || return 1
  HDC_DEVICE=$(printf '%s\n' "$targets" | python3 -c '
import os, sys
devices = [s.strip() for s in sys.stdin if s.strip() and s.strip() != "[Empty]"]
selected = os.environ.get("HDC_DEVICE", "")
if selected:
    if selected not in devices:
        sys.exit("ERROR: HDC_DEVICE is not connected")
elif len(devices) == 1:
    selected = devices[0]
else:
    sys.exit("ERROR: connect exactly one phone or set HDC_DEVICE")
print(selected)
') || return 1
  actual_udid=$("$HDC_DIR/hdc" -t "$HDC_DEVICE" shell bm get --udid) || return 1
  actual_udid=$(printf '%s\n' "$actual_udid" | python3 -c '
import re, sys
matches = re.findall(r"(?m)^[ \t]*([0-9A-Fa-f]{64})[ \t\r]*$", sys.stdin.read())
if len(matches) != 1:
    sys.exit("ERROR: cannot read a unique device UDID from hdc")
print(matches[0])
') || return 1
  if [[ -n "${UDID:-}" && "$UDID" != "$actual_udid" ]]; then
    printf 'ERROR: UDID does not match the connected HDC_DEVICE.\n' >&2
    return 1
  fi
  UDID="$actual_udid"
  export HDC_DIR HDC_DEVICE UDID
  printf 'Signing device: %s\nUDID: %s\n' "$HDC_DEVICE" "$UDID"
}

vera_hapsigner() {
  if [ -z "${HAPSIGNER:-}" ]; then
    printf 'ERROR: HAPSIGNER is required. Set it to the directory holding dist/.\n' >&2
    return 1
  fi
  if [ -d "$HAPSIGNER/dist" ]; then
    printf '%s\n' "$HAPSIGNER"
    return 0
  fi
  printf 'ERROR: HAPSIGNER is %s but it has no dist/.\n' "$HAPSIGNER" >&2
  return 1
}

vera_add_toolchains_to_path() {
  if [ -n "${OHOS_TOOLCHAINS:-}" ]; then
    if [ ! -d "$OHOS_TOOLCHAINS" ]; then
      printf 'ERROR: OHOS_TOOLCHAINS is %s but that directory does not exist.\n' "$OHOS_TOOLCHAINS" >&2
      return 1
    fi
    export PATH="$OHOS_TOOLCHAINS:$PATH"
  fi
  return 0
}
