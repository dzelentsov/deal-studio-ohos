# Changelog

## Device helper scripts, backup/restore of saved projects, and shell tooling hardening

This entry records work on the shell tooling and its documentation: a review and hardening pass over the build/sign/update scripts, fixes to the device helper scripts (`measure.sh`, `send-prompt.sh`), and two new scripts that copy saved projects off and onto a phone. It is a handoff reference for people and AI agents, not a release certification. No application code under `entry/src/` was changed.

Device behavior described here was exercised against a stubbed `hdc` and a fake app sandbox on the host unless "Verification" says otherwise. File paths are repository-relative. Consult the target branch's current workflow instructions before executing build or device commands.

### Summary

- Hardened the shared shell helpers: bash 4+ guard, explicit `ERROR` lines for missing tools, a complete hapsigner preflight, one shared bundle/profile check, masked UDID output, and an `hdc` wrapper that honours `HDC_DEVICE`.
- Fixed silent-exit and stale-data failure modes in `measure.sh` and `send-prompt.sh`; `measure.sh` now writes valid JSONL and keeps the previous results.
- Added `pull-vera-sources.sh`: copies saved programs off the phone as plain files plus a manifest, and with `--raw` a complete, size-checked copy of the app's `vera` data directory.
- Added `push-vera-sources.sh`: adds saved projects to a phone (for example a second one), from the plain files by default or from the complete copy with `--raw`. Dry run by default; `--check` tests whether the phone accepts files.
- Reworked `README.md` and `CLAUDE.md`: removed duplicated and stale text, documented the helper scripts, and replaced the "no backup route" statement with a working backup procedure.

### 1. Shared helpers and build/sign/update scripts

#### `tool-paths.sh`

- Sourcing fails with an `ERROR` on bash older than 4; the scripts use `mapfile`, `${var,,}`, and associative arrays.
- Added `vera_require_cmd`, so a missing `java` or `python3` prints an `ERROR` line instead of ending the script silently under `set -e`. This keeps the "ERROR line, stop and ask" protocol in `CLAUDE.md` working.
- `vera_hapsigner` now verifies the four files it needs under `dist/` (`hap-sign-tool.jar`, `OpenHarmony.p12`, `OpenHarmonyProfileRelease.pem`, `OpenHarmonyApplication.pem`), so a signed `build-hap.sh` fails before the build instead of after it. The duplicate file checks were removed from `update-phone.sh` and `sign-system.sh`.
- Added `vera_app_bundle`: returns the bundle name from `AppScope/app.json5` after checking that the system signing profile template belongs to it (`bundle-name`, `app-feature: hos_system_app`). `update-phone.sh` calls it before building; `sign-system.sh` calls it too, so a standalone first-install signing run is checked as well.
- `vera_signing_device` prints the UDID masked (first and last four characters).
- Added `vera_use_hdc`: puts the `hdc` directory on `PATH` and defines an `hdc` function that adds `-t "$HDC_DEVICE"` when it is set.
- `vera_hdc_dir` uses `type -P hdc` instead of `command -v hdc`. After `vera_use_hdc` defines the function, `command -v hdc` returned the function name, which led to `./hdc: No such file or directory` in `vera_signing_device`.

#### `build-hap.sh`, `update-phone.sh`, `sign-system.sh`

- `build-hap.sh` and `update-phone.sh` warn when `entry/src/main/cpp/llama.cpp` is missing, because the result is a stub build without local model support.
- A missing llama.cpp is currently the normal case, so `update-phone.sh` proceeds with the stub; `REQUIRE_LLAMA=1` makes it refuse before installing anything.
- `sign-system.sh`: the header now states that the profile differs from the kit's release template in four fields (`apl`, `app-feature`, `acls`, `bundle-name`), describes the derived device profile (`internaltesting`, fresh UUID, validity window, `debug-info` with the connected UDID), and notes that the certificate must come from the kit's own template. A missing unsigned HAP now points to `./build-hap.sh --unsigned`.

Main files: `tool-paths.sh`, `build-hap.sh`, `update-phone.sh`, `sign-system.sh`.

### 2. Device helper scripts

#### `measure.sh`

- Tap point order is now: `TICTACTOE_XY`/`DASHBOARD_XY` override, then the button located by text in a layout dump, then the fixed coordinates; the source used is printed. Before, the fixed coordinates were always chosen and the layout-dump path was dead code, although the Agent Kit was still required.
- `locate()` clears its work directory before each dump and takes the newest one instead of an arbitrary earlier file.
- A run with no `VERA_PROBE` line in hilog now stops with an explicit error. Before, `grep` under `set -euo pipefail` ended the script silently after the output file had been truncated.
- The default output is `results/device.jsonl` under the repository (override with `OUT`). The previous file is kept as `<out>.prev`. Each run is one valid JSON object per line (`page`, `rep`, the probe fields, and a `ui` snapshot); the old `{...} // {...}` lines were not valid JSON.
- `<out>.meta` records the device model, OS build, and date. It is best effort: it depends on what `param get` returns on the device.

#### `send-prompt.sh`

- A missing `hdc` now stops the script (before, it continued with a broken `PATH`).
- `-t X Y` must be two integers; `-f` checks that the file is readable; `HDC_DEVICE` is honoured, including in the Python subprocess; output is decoded as UTF-8; the exit code of `hdc` is propagated.

Main files: `measure.sh`, `send-prompt.sh`.

### 3. `pull-vera-sources.sh`: copying saved projects off the phone

The app sandbox under `{filesDir}/vera` is readable from `hdc shell` on the current system-signed build, so no uninstall, root, or debug build is needed. Nothing on the phone is changed.

- Default output (`./vera-src` next to the script, or the folder given): for each saved version `<project>--<versionId>.vera`, `.prompt.txt`, and `.vbc2` (the bytecode field as stored), plus `manifest.json`. Only version files are fetched; program state and `settings.json` are not.
- `manifest.json` holds the catalogue entries, each version's remaining fields, version order and "latest" by the phone's file modification time, SHA-256 and size of every version file, the phone's modification times, phone model, OS build and app version when the device reports them, and a per-version `rebuildable` flag. Written files get the phone's modification times locally.
- `--raw` also writes `raw/`: every file under the `vera` directory, any depth, byte for byte, same layout, each checked against its size on the phone. This includes the catalogue, every version JSON, `*.state.json`, and `settings.json` (copied with mode 600; `--no-settings` leaves it out).
- `rebuildable` is true only when the version JSON rebuilt from the plain files and the manifest equals the original after parsing. Fields larger than 20 KB, non-JSON files, or versions without `source` make a version non-rebuildable.
- If `stat` is missing on the phone, the listing falls back to bare paths and sizes are asked per file; modification times are then unknown.
- A failed or mismatching transfer never replaces an earlier good copy, is reported, and makes the script exit non-zero.
- Programs that were generated but never saved exist only as a catalogue entry.

### 4. `push-vera-sources.sh`: copying saved projects onto a phone

- Usage: `./push-vera-sources.sh [--check | --apply] [--raw] [dir]`. Without options it is a dry run that lists what would be added. `--check` writes and removes one probe file to test whether the phone accepts files the app can read.
- Default source: the plain files and `manifest.json` in `dir` (default `./vera-src`). The version files are rebuilt with the same recipe as the `rebuildable` check in `pull-vera-sources.sh`. A project is added only if all its versions are rebuildable; others are listed as skipped with the reason. Program state is not restored in this mode.
- `--raw`: restores from the complete copy in `dir/raw/`; the catalogue, every version JSON, and every program state are copied byte for byte.
- A project is added only if its id is not in the phone's `index.json`; existing projects are skipped whole, and no existing file is overwritten. Catalogue entries are copied as they are. Projects with no versions are restored as catalogue entries only.
- `--apply` first stops the app (it would otherwise rewrite `index.json` from memory), saves the phone's current `index.json` under `<dir>/push-backups/<time>/`, stages files in `/data/local/tmp` with size checks, moves them into the sandbox, and replaces `index.json` last through a temporary file and `mv`. Until that step the app's project list is untouched. Staging is removed afterwards, and the result is verified; a failure prints the commands to put the old list back.
- Ownership: files are given the owner of the `vera` directory (`chown`), and `restorecon` is run when the phone has it. SELinux labels cannot be inspected by the script. If a write is refused or the owner cannot be matched, the script refuses and changes nothing.
- `settings.json` is never written to a phone.

Main files: `pull-vera-sources.sh`, `push-vera-sources.sh`.

### 5. Documentation

- `README.md` is the reference for tools, environment, signing, installation, and the helper scripts; duplicated build/sign/preflight text was removed from `CLAUDE.md`, which keeps the agent workflow, the preflight command, and the traps.
- Removed leftovers of earlier tooling (`arkui-sign`, the `arkui-hvigor` JSON protocol) and the statement that the dynamic port had not run on a device; the SDK 26 remark now says a build configuration change alone does not establish runtime compatibility.
- A recorded one-time installation authorization was replaced by a rule: a first installation is manual and needs the person's explicit confirmation that the app is absent; it never extends to uninstalling or clearing data.
- "No backup route" was replaced by `./pull-vera-sources.sh --raw` as the backup to take before anything risky. The API-key note now says the sandbox is readable from `hdc shell`, so the key is not secret against someone with an authorized `hdc` and the unlocked phone.
- Added the bash 4+ requirement, the llama.cpp stub behavior and `REQUIRE_LLAMA`, a "Helper scripts" section, and the full script list for `bash -n`. Defined "the kit" as the ArkTS Agent Kit. The API 22 `--mode debug/release` observations are marked historical.

Main files: `README.md`, `CLAUDE.md`.

### 6. Verification performed during the session

The following are historical session results, not tests executed merely by adding this document:

- `bash -n` passed for every script. Warnings reported by `shellcheck` run by the user (SC2012, SC2209, SC2034, SC2317) were fixed and no longer appear.
- Behavior was exercised against a stubbed `hdc` and a fake sandbox: pull default and `--raw` (nested and binary files, empty file, failed and truncated transfers, missing `stat`, unreadable index), push dry run, `--check`, and `--apply` in both modes (content identical after parsing, idempotent re-run, refusal on a read-only sandbox, transfer failure leaving `index.json` untouched), and the `measure.sh` layout-dump, override, and fallback routes.
- On the development phone, as reported by the user: an earlier revision of `pull-vera-sources.sh` wrote the program and prompt files, and `push-vera-sources.sh --check` passed (writable, new files can be given the app's owner, `restorecon` present).
- Not performed: `push-vera-sources.sh --apply` on a device; opening restored projects in the app; the `--raw` copy, `manifest.json`, and `rebuildable` flags against real data; `find ... -exec stat`, `param get`, and `bm dump` output on a device; the `measure.sh` layout-dump route against a real `arkui-device-cli`.

### 7. Known limitations

- Restoring is meant for the same app version on both phones. The version JSON schema is not validated, and restored files get new modification times.
- Default-mode push does not restore program state or settings. A project with a non-rebuildable version is skipped there; use `--raw`.
- Catalogue entries are copied verbatim, including a persisted `pinned` flag. On another phone the Pin button may show a pinned state without a launcher shortcut; Unpin → Pin recreates it.
- `measure.sh` fallback coordinates are specific to one panel size.
- The pull output holds prompts and, with `--raw`, the API key in plain text.

### 8. Handoff rules for future changes

1. Never uninstall the app or clear its data. Take `./pull-vera-sources.sh --raw` first when anything risky is planned.
2. Keep the rebuild recipe in `pull-vera-sources.sh` (`rebuild`) and `push-vera-sources.sh` identical. Any change to how `.vera`, `.prompt.txt`, `.vbc2`, or the manifest `fields` are written must be mirrored.
3. New fields in the saved version JSON flow through the manifest `fields` automatically. A field larger than 20 KB makes that version non-rebuildable; use `--raw` or raise the limit deliberately.
4. Do not let `push-vera-sources.sh` overwrite existing files or write `settings.json`, and keep the `index.json` replacement as the last step.
5. Run `--check` before `--apply`, and do not run `--apply` without the person's go-ahead.
6. Keep `vera-src/` and `results/*.prev` out of git; never paste its contents (prompts, API key) into issues or logs.
7. After `vera_use_hdc`, find the `hdc` binary with `type -P`, not `command -v`.
8. Keep missing-tool failures as `ERROR` lines, so agents stop and ask instead of guessing paths.
