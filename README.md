# vera-probe-dynamic

A HarmonyOS app (`com.vera.probe.dyn`) built on the VERA runtime, written in
**dynamic** ArkTS. It does two things:

- **Generates programs.** A plain-English prompt becomes a VERA-L program that is
  compiled on the phone and rendered as native ArkUI (see
  [Generation modes](#generation-modes)). `CLAUDE.md` describes this side of the
  repo.
- **Measures the runtime.** The embedded benchmark programs give a real-device
  cost for the VERA pipeline, paired with `webview-probe`, which loads the same
  two prompts as HTML into a WebView (see [What it measures](#what-it-measures)).

## Why a dynamic port exists

The `'use static'` original (`../vera-probe`) did not run on either available
device:

| device | blocker |
|---|---|
| SGT-AL00, API 22 | SDK 26 emits Panda bytecode 0.1.0.7; the VM accepts ≤ 0.0.0.5 |
| Mate 60 Pro, API 26 | SDK 26.0.0.26 is ABI-incompatible with the device's 26.0.0.37 |

The dynamic port originally targeted **API 22**, where `webview-probe` ran and
the WebView measurements were collected. The build profile now sets the
compatible, target and compile SDK versions to **26.0.0**. That is a build
configuration change; on its own it says nothing about runtime compatibility on
the API 26 device. The table above records the earlier static-runtime failures.

## What the measurement does and does not establish

**Does:** a real-device measurement of the VERA pipeline (parse, VM boot,
`render()`, decode, ArkUI construction, resident memory), directly comparable to
the WebView cost measured on the same phone. The comparison holds only against
`webview-probe` runs on the same device and OS build.

**Does not:** measure the runtime the VERA product targets. Static ArkTS runs on
the Panda static VM (`modules_static.abc`); dynamic ArkTS runs on the
ArkCompiler JS-style engine (`modules.abc`). These are different runtimes, and
the host measurement of 435 µs parse+boot was taken on the static one. Do not
blend these numbers with the host static figures: quote them as the
dynamic-ArkTS device cost, and treat the static-vs-dynamic gap as the remaining
open question.

Before quoting any timing, confirm that the rendered tree matches what
`vera-bench` produces on the host.

## The port

`entry/src/main/ets/vera/` is a mechanical port of the static runtime in
`vera-static-hello`: same algorithm and control flow, only the type system
differs.

| static | dynamic |
|---|---|
| `'use static'` | removed |
| `final class` | `class` |
| `int`, `double` | `number` |
| `Any` | `Object \| null \| undefined` |
| `x instanceof number` | `typeof x === 'number'` |
| `Int.toDouble(a & b)` | `a & b` — JS bitwise already yields a number |
| `JSON.parseJsonElement` | `JSON.parse` — the JsonElement API does not exist here |

`parseConstant` was rewritten rather than translated. The static version handled
only null, string, boolean, number and `BytecodeFunction`, so array and plain
object constants fell through to `Unsupported constant value`. That gap is now
closed. This is **not known to be the cause** of the `pairs` failure seen on the
real runtime: that artifact contains no container constants at all (16 numbers,
43 strings, 1 boolean, 8 functions), so the bug is still unexplained.

## What it measures

| metric | from |
|---|---|
| `parseUs` | `parseBytecodeAssembly(vbc1)` |
| `bootUs` | `new VeraVM(program)` + `run()` |
| `renderUs` | `invokeFunction('render')` |
| `decodeUs` | `decodeVeraUi` — validation and UI-node decode |
| `coldTotalUs` | the four above, first pass, nothing warm |
| `warmTotalUs` | same pipeline, mean of 100 iterations |
| `buildUs` | state write to ArkUI `onAppear`: the construction term |
| `pssDeltaKb` | `hidebug.getPss()` before vs after |

Timing uses `getUptime(TimeType.STARTUP, true)`, which returns nanoseconds. The
phases are microsecond-scale, so millisecond resolution would floor them all to
zero.

The programs are the exact artifacts the benchmark scored, compiled to vbc1 and
embedded as literals so the timed region has no network and no file I/O:
`tictactoe` (6557 B) and `dashboard` (1439 B) from `results/cortex5`.

`./measure.sh 3` runs three cold repetitions per program and writes
`results/device.jsonl`.

## Generation modes

The Generate screen cycles through three ways to turn a prompt into a VERA-L
program; the button top-left switches between them.

| mode | model | who writes the code |
|---|---|---|
| `DeepSeek` | `deepseek-flash` over HTTPS | the device: generate, compile, feed diagnostics back, retry |
| `Local` | Qwen2.5-Coder-3B in-process via llama.cpp | the device, same loop |
| `Server` | whatever `vera-server` runs | the server, which returns finished vbc2 |

DeepSeek and Local share one agent loop: `compileVeraSource` runs on the phone,
compiler diagnostics go back to the model, up to three attempts. They differ only
in where the model lives. Server is the original path, kept for comparison: the
phone ships a prompt and receives bytecode.

DeepSeek has no GBNF grammar to constrain decoding the way llama.cpp does, so
`vera.gbnf` is unused in that mode. `extractVeraSource` strips a markdown fence
if the model wraps the program in one.

### Settings: API key and server address

Neither value is compiled in, and neither has a default. Both are sent as launch
parameters and stored in the app sandbox at `{filesDir}/vera/settings.json`:

```bash
hdc shell aa start -a EntryAbility -b com.vera.probe.dyn --ps deepseekKey sk-...
hdc shell aa start -a EntryAbility -b com.vera.probe.dyn --ps veraServer http://host:port
```

Once stored, they survive restarts. The app never logs the key; the status line
shows only `sk-...abcd`, enough to confirm it arrived. With no `veraServer`
given, Server mode says so and the other two modes are unaffected.

The same file holds `model` and `baseUrl`, so pointing the app at another
OpenAI-compatible endpoint needs no rebuild.

This keeps the key out of git and out of the HAP, but it is not a secret against
someone holding the unlocked phone. Use a key dedicated to this project and
revoke it in the DeepSeek console if the phone leaves your hands.

## Running it

Build and device tools live outside this repo. Configure their locations in your
shell environment; the scripts never search machine-specific directories, and an
explicitly set variable never falls back to another installation. Keep tool paths
and real UDIDs out of the repo.

| tool | needed for | configuration |
|---|---|---|
| Hvigor 7.26.0.static wrapper | every build | `HVIGORW`: absolute path to the wrapper; never resolved from `PATH` |
| Build SDK 26.0.0 | every build | `OHOS_BASE_SDK_HOME` and `DEVECO_SDK_HOME`, both naming existing SDK directories |
| hdc | install/update, device-bound signing, measurement | SDK toolchains directory on `PATH`, or `HDC_DIR` naming the directory that contains `hdc` |
| hapsigner | signing | `HAPSIGNER`: directory containing `dist/hap-sign-tool.jar` |
| Java | signing | a JRE providing `java` on `PATH` |
| Python 3 | device-bound signing and update | `python3` on `PATH` |
| ArkTS Agent Kit | screen dumps and measurement only | `arkui-device-cli` on `PATH`, or `KIT_ROOT` containing `tools/`, `.venv/bin/` or `bin/` |

Add your SDK toolchains and command-line-tools `bin` directories to `PATH`.
`OHOS_TOOLCHAINS` optionally prepends an extra toolchains directory for
measurement. An offline `--unsigned` build needs only Hvigor and the SDK; no
device, hdc, hapsigner, Java or Python. `CLAUDE.md` has a command that checks
the tools.

**llama.cpp** is also not in this repo. Fetch the commit pinned in
`entry/src/main/cpp/CMakeLists.txt` into `entry/src/main/cpp/llama.cpp`
(git-ignored; the commands are in the comment at the top of that file), then
delete `entry/.cxx` once so CMake sees it. Without it the build still succeeds
but yields a stub with no model support: embedding search for SDK functions and
intents falls back to keywords, and the Generate and Chat screens say so in their
status line.

### Building

`build-hap.sh` validates and exports `OHOS_BASE_SDK_HOME` and `DEVECO_SDK_HOME`,
then runs this from the repository root:

```bash
bash "$HVIGORW" clean --mode module -p module=entry -p product=default createHapTask --analyze=normal --parallel --incremental --no-daemon
```

`createHapTask` runs `assembleHap` and renames the output to
`entry/build/default/outputs/default/vera-probe-dyn-unsigned.hap`. The script
copies it to `${HAP_OUT_DIR:-/tmp/vera-probe-dyn-hap}`, shows Hvigor output
directly, and stops on a nonzero exit or a missing HAP. The build is always
clean, despite `--incremental`.

By default `./build-hap.sh` first checks hapsigner, Java, Python 3 and the
connected signing device, builds, then calls `sign-system.sh` to produce
`vera-probe-dyn-system-signed.hap` in the output directory. `--unsigned` skips
signing.

### Updating an installed app

```bash
./update-phone.sh
```

This is the routine path. It requires exactly one connected phone and an existing
system installation of the app, and refuses to install otherwise. It pins
`HDC_DEVICE` to that phone and verifies its UDID, runs `build-hap.sh --unsigned`,
calls `sign-system.sh` once, installs without uninstalling or clearing data, and
checks that the app ID, UID and first-install time are unchanged while the update
time advanced. It stops on any failure and never performs a first installation.

### First installation

`update-phone.sh` cannot install an app that is absent. For a first installation,
select the device in the current shell so the manual install uses the same
target, then build, sign and install:

```bash
source ./tool-paths.sh
vera_signing_device
./build-hap.sh --unsigned
./sign-system.sh
hdc -t "$HDC_DEVICE" install "${HAP_OUT_DIR:-/tmp/vera-probe-dyn-hap}/vera-probe-dyn-system-signed.hap"
```

`vera_signing_device` needs Python 3, hdc and a connected device. It uses an
exported `HDC_DEVICE` to pick the target; otherwise exactly one device must be
connected. It reads the UDID with `hdc -t "$HDC_DEVICE" shell bm get --udid` and
exports `HDC_DEVICE` and `UDID`. An explicitly set `UDID` must match the
connected device or signing stops.

### System signing

`insightIntentDriver` is a system API, so a program that calls `std/intent` needs
the app to be a system app. `sign-system.sh` leaves
`signing/UnsgnedReleasedProfileTemplate.json` unchanged and derives
`$HAP_OUT_DIR/vera-probe-dyn-device-profile.json` (default output directory:
`/tmp/vera-probe-dyn-hap`). The derived profile:

- sets `app-distribution-type: internaltesting`, a fresh UUID, and validity from
  now minus five minutes to now plus 30 days;
- adds `debug-info` with `device-id-type: udid` and `device-ids: [connected UDID]`;
- preserves the release type, distribution certificate, bundle name, APL,
  app-feature and ACLs.

The device whitelist does not turn it into a debug build. Never commit the
generated profile or an actual UDID.

The repo's release system template differs from the kit's release template in
exactly four fields: `apl: system_basic`, `app-feature: hos_system_app`,
`acls.allowed-acls` (four entries), and the bundle name. **Take the certificate
from the kit's own template, not from another project's profile.** `appId` is
derived from `distribution-certificate`, and a different one fails as
`9568332 install sign info inconsistent`, which reads like a signing bug and is
not one.

The permissions in `module.json5` are granted by that profile or not at all, and
the device decides at install time. A normal build declaring them is refused
outright (`install failed due to grant request permissions failed`), so the
install output is the test: `install bundle successfully` means the profile was
accepted. To confirm afterwards:

```bash
hdc shell bm dump -n com.vera.probe.dyn      # isSystemApp, appPrivilegeLevel
hdc shell atm dump -t <accessTokenId> -b com.vera.probe.dyn   # grantStatus 0
```

An already-installed normal build cannot be updated into a system one
(`9568294 install failed due to apptype not same`).

**Never uninstall the app or clear its data.** That destroys `{filesDir}/vera`:
every project, every saved program state and the stored API key. The sandbox is
not readable from `hdc shell` on a release-signed build, so there is no backup
route. If an install is refused, find out why. To test a system profile on a
bundle that was ever installed normally, build under a throwaway `bundleName` and
install alongside it; never change the bundle name to work around an update
failure.

## Historical notes

Earlier device testing on API 22 used a debug build (`--mode debug`). On the
API 26 device, AppGallery installed a disposed rule against debug-signed
sideloaded apps and AMS refused the launch; a release build (`--mode release`)
yielded `os_integration`, which its risk control left alone. These are past
observations, not verification of the current SDK setup or of the default
system-signing workflow.
