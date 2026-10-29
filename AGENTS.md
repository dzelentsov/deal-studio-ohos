# Repository instructions

## Sources and architecture

- Read `CLAUDE.md` for detailed device/tool safety rules and subsystem pointers; `README.md` documents build/signing and benchmark interpretation. Prefer scripts/config over stale prose.
- This is **dynamic ArkTS**, not the static port. Build profiles currently target SDK `26.0.0`, OpenHarmony, arm64 only; do not infer device compatibility from build success.
- The app starts at `entry/src/main/ets/entryability/EntryAbility.ets`, loading `pages/AppShell`. Language/compiler/VM code lives under `entry/src/main/ets/vera/`.
- Generate and chat share `vera/agent/VeraBuildRoute.ets`; inspect it and `docs/agent.md` before changing generation routing. Callers must report a not-built outcome, not add a separate generate-from-scratch fallback.
- `vera/VeraUiCatalog.ets` is the source for UI compiler signatures, validation rules and prompt material. A new component also needs decoding in `vera/VeraUi.ets`, rendering in `components/VeraPreview.ets`, and inclusion in its `RENDERED` list. Colours/sizes belong in `vera/VeraTheme.ets`.
- Read `docs/intent-call-contract.md` before changing intent success/failure handling: `intent.call` can return JSON, `"ok"`, `"declined code=N"`, or `"error N: ..."`.

## Verification without a phone

- Prefer `tools/vera-harness/` checks: `source-loader.js` transpiles **current `.ets` sources directly**; a prior HAP build or import rewriting is unnecessary. Requires Node and an existing TypeScript module (`require('typescript')`, or configure `VERA_TYPESCRIPT_PATH` to its module path).
- Run focused checks from the repository root, selecting those relevant to the change:

  ```bash
  node tools/vera-harness/smoke-check.js
  node tools/vera-harness/needs-plan-check.js
  node tools/vera-harness/agent-check.js
  node tools/vera-harness/gfx-check.js
  node tools/vera-harness/live-widget-check.js
  node tools/vera-harness/live-form-check.js
  ```

- Harness transpilation is **not ArkTS typechecking**; platform/native APIs and SDK validation are stubbed. There is no configured repository-wide standalone lint/typecheck command; `code-linter.json5` only selects `.ets` files. Use the HAP build for ArkTS build validation when required.
- `compileVeraSource` throws `CompileError` with `.diagnostics`; it does not return diagnostics on failure.
- For a single VERA program: `node tools/vera-harness/run.js path/to/program.vera [entryFunction=view] [stateJson]`. Explicit state is VM tagged-tuple JSON, not ordinary application JSON.
- For visual changes, make a deterministic proof rather than waiting for model generation: pipe `run.js`'s decoded tree into `node tools/vera-harness/proof-sheet.js --width=360 --preset=clean` and save the SVG outside the repo. This approximates layout, not native ArkUI geometry.
- Do not glob-run harness scripts: `*-run.js` can invoke live models/services. `visual-check.js --capture-baseline` rewrites checked-in fixtures; do not use it for routine verification.
- For shell changes, run `bash -n` on each changed script and ShellCheck if available. Run `git diff --check` for every change.
- For USB-network C++ changes, run both host tests: `g++ -std=c++17 -Wall -Wextra -Werror -I entry/src/main/cpp tools/usbnet-packets-test.cpp -o /tmp/opencode/usbnet-packets-test && /tmp/opencode/usbnet-packets-test`, then the tunnel's ThreadSanitizer/AddressSanitizer commands at the top of `tools/usbnet-tunnel-test.cpp` (fake tun/relay, no device).

## Build and device safety

- Routine rebuild/in-place update: **`./update-phone.sh`**. It already checks prerequisites; do not repeat checks or reread build scripts unless it fails. Requires exactly one phone and an existing system installation; verifies identity and install timestamps after updating. **Stop on any error.**
- Never uninstall, clear app data, or change the bundle name to bypass an update failure. `{filesDir}/vera` contains saved projects, program state and the API key. Before risky device operations, use `./pull-vera-sources.sh --raw` (`--no-settings` excludes the key); never commit or paste the pulled data.
- First installation requires explicit confirmation that the app is absent; use the manual workflow in `README.md`. `push-vera-sources.sh` is dry-run by default: run `--check` first and obtain approval before `--apply`.
- For other builds, follow the prerequisite checks in `CLAUDE.md`. Missing tools: stop and ask using its prescribed wording; never guess machine paths or install tools. Paths/UDIDs belong in the environment, not repository files; explicitly configured locations must not silently fall back.
- Offline build: `./build-hap.sh --unsigned`. Needs only Hvigor/SDK configuration: absolute `HVIGORW`, `OHOS_BASE_SDK_HOME`, `DEVECO_SDK_HOME`; scripts require Bash 4+. It performs a clean build despite `--incremental`, writing HAPs to `${HAP_OUT_DIR:-/tmp/vera-probe-dyn-hap}`. Without `--unsigned`, it also requires device-bound signing and signs automatically.
- `std/intent` requires system signing. Preserve the distribution certificate in `signing/UnsgnedReleasedProfileTemplate.json`: changing it changes app identity and prevents updates. Generated device profiles must not be committed.
- Missing git-ignored `entry/src/main/cpp/llama.cpp` intentionally builds a no-model stub; its warning does **not** block ordinary updates. Use `REQUIRE_LLAMA=1 ./update-phone.sh` only when requested. For model support, fetch the commit pinned in `entry/src/main/cpp/CMakeLists.txt`, then remove `entry/.cxx` once.
- Keys/endpoints are persisted launch parameters, never compiled in (`deepseekKey` or `cloudKey`, `apiBase`, `apiModel`, `veraServer`); only native callers such as `hdc shell aa start` may set development parameters. `jevProxy` is a flag (`1`), not a URL. Generate-screen prompts are English regardless of conversation language.
- Device updates stop the USB VPN; re-enable it afterward if needed. USB-network implementation constraints and relay setup are in `CLAUDE.md`.
