#!/usr/bin/env bash
# Sign the HAP with a system provision profile.
#
# Why this exists instead of arkui-sign: that command takes only a target, a
# mode and a UDID, and reads its profile template from the kit's own
# hapsigner/dist. There is no flag for a different profile, and editing the
# kit's copy would change every project signed on this machine. So this calls
# hap-sign-tool.jar directly with the profile in this repo -- the same two steps
# and the same arguments the kit uses (see arkts_agent_kit/tools/hapsigner.py:
# sign_profile, sign_app), pointed at signing/UnsgnedReleasedProfileTemplate.json.
#
# That profile differs from the kit's release template in exactly four fields:
#   "apl": "system_basic"          -- the level the intent permissions live at
#   "app-feature": "hos_system_app"-- without it every system API answers 202
#   "acls": { "allowed-acls": ... }-- the permissions granted across levels
#   "bundle-name"                  -- this app's bundle
#
# The template is not signed as is: this script derives
# $HAP_OUT_DIR/vera-probe-dyn-device-profile.json from it (app-distribution-type
# internaltesting, a fresh UUID, validity from now-5min to now+30d, debug-info
# with the connected device's UDID) and signs that. Type, certificate, bundle
# name, APL, app-feature and ACLs are preserved. Take the certificate from the
# kit's own template: appId derives from it, and another one fails as
# 9568332 "install sign info inconsistent".
#
# What to expect on install. The permissions in module.json5 are granted by this
# profile or not at all, and the device decides at install time, not at run
# time:
#   "install bundle successfully"                        -> profile accepted
#   "install failed due to grant request permissions..."  -> profile refused
# So the install output is the answer; there is no need to run anything to find
# out.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/tool-paths.sh"
HAPSIGNER=$(vera_hapsigner)
DIST="$HAPSIGNER/dist"
HAP_OUT_DIR="${HAP_OUT_DIR:-/tmp/vera-probe-dyn-hap}"
UNSIGNED="$HAP_OUT_DIR/vera-probe-dyn-unsigned.hap"
SIGNED="$HAP_OUT_DIR/vera-probe-dyn-system-signed.hap"
PROFILE_TEMPLATE="$SCRIPT_DIR/signing/UnsgnedReleasedProfileTemplate.json"
PROFILE_IN="$HAP_OUT_DIR/vera-probe-dyn-device-profile.json"
PROFILE_OUT="$HAP_OUT_DIR/vera-probe-dyn-system.p7b"

vera_require_cmd java
vera_require_cmd python3
# Checked again on purpose (build-hap.sh and update-phone.sh already did): the
# signature must be bound to the device that is connected right now.
vera_signing_device
vera_app_bundle "$SCRIPT_DIR" >/dev/null

[[ -f "$PROFILE_TEMPLATE" ]] || { echo "ERROR: missing $PROFILE_TEMPLATE" >&2; exit 1; }
[[ -f "$UNSIGNED" ]] || { echo "ERROR: missing $UNSIGNED (run ./build-hap.sh --unsigned first)" >&2; exit 1; }

python3 - "$PROFILE_TEMPLATE" "$PROFILE_IN" "$UDID" <<'PY'
import json, sys, time, uuid
from pathlib import Path
profile = json.loads(Path(sys.argv[1]).read_text())
if profile['type'] != 'release' or profile['bundle-info']['app-feature'] != 'hos_system_app':
    sys.exit('ERROR: expected a release system-app profile')
now = int(time.time())
profile['app-distribution-type'] = 'internaltesting'
profile['uuid'] = str(uuid.uuid4())
profile['validity'] = {'not-before': now - 300, 'not-after': now + 30 * 24 * 60 * 60}
profile['debug-info'] = {'device-id-type': 'udid', 'device-ids': [sys.argv[3]]}
Path(sys.argv[2]).write_text(json.dumps(profile, indent=4) + '\n')
PY

echo "=== Sign profile ==="
java -jar "$DIST/hap-sign-tool.jar" sign-profile \
  -mode localSign \
  -keyAlias "OpenHarmony Application Profile Release" \
  -keyPwd 123456 \
  -inFile "$PROFILE_IN" \
  -outFile "$PROFILE_OUT" \
  -keystoreFile "$DIST/OpenHarmony.p12" \
  -keystorePwd 123456 \
  -signAlg SHA256withECDSA \
  -profileCertFile "$DIST/OpenHarmonyProfileRelease.pem"

echo
echo "=== Sign app ==="
rm -f "$SIGNED"
java -jar "$DIST/hap-sign-tool.jar" sign-app \
  -mode localSign \
  -keyAlias "OpenHarmony Application Release" \
  -signAlg SHA256withECDSA \
  -appCertFile "$DIST/OpenHarmonyApplication.pem" \
  -profileFile "$PROFILE_OUT" \
  -inFile "$UNSIGNED" \
  -keystoreFile "$DIST/OpenHarmony.p12" \
  -outFile "$SIGNED" \
  -keyPwd 123456 \
  -keystorePwd 123456

echo
echo "=== Done ==="
ls -lh "$SIGNED"
printf 'install with: hdc -t %q install %q\n' "$HDC_DEVICE" "$SIGNED"
