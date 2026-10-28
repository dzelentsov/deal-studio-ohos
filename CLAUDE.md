# Working on this repo

A HarmonyOS app that generates small programs from a plain-English prompt,
compiles them on the phone and renders them as native ArkUI. `entry/src/main/
ets/vera/` is the language: compiler, VM, the `std/ui` catalogue and the theme.
`entry/src/main/ets/components/VeraPreview.ets` is the renderer. `README.md`
covers the benchmark side, the generation modes, the tool table and signing in
detail.

## Routine update: just run the script

For a rebuild and in-place update of an app that is already installed:

```bash
./update-phone.sh
```

It checks the tools and the installed app itself. Do not repeat the checks below
or reread the build scripts on a routine update unless the command fails.

It needs exactly one connected phone and an existing system installation with the
same bundle name, and refuses to install otherwise. It builds with `--unsigned`,
signs once, installs without deleting anything, and verifies that app ID, UID and
first-install time did not change while update time advanced.

**On any error, stop.** Never uninstall, clear app data or change the bundle name
to work around an update failure.

## Any other build: find out what is missing, then ask

For a build with device-bound system signing, check the external tools and the
connected device first. For an offline `--unsigned` build, run only the Hvigor
and SDK checks; hapsigner, Java, Python, hdc and a device are not needed.

```bash
bash -c 'source ./tool-paths.sh
printf "%-18s %s\n" hvigorw "$(vera_hvigorw 2>&1)"
printf "%-18s %s\n" OHOS_BASE_SDK_HOME "$(vera_sdk_home 2>&1)"
printf "%-18s %s\n" hapsigner "$(vera_hapsigner 2>&1)"
vera_require_cmd java && java -version
vera_require_cmd python3 && python3 --version
vera_signing_device'
```

Tool locations are set in the shell environment, never in scripts or
documentation; the table of variables is in `README.md` ("Running it"). An
explicitly set variable is an instruction, not a hint: if the thing is not where
it says, the script fails and names the variable rather than quietly using
another copy. Never store machine-specific paths or real UDIDs in the repo.

**If any check prints an ERROR line, stop and ask the person working with you.
Do not guess a path and do not install anything.** Ask exactly this:

> This workflow needs *(name only the required tools)*, and I cannot find
> *(name the ones that failed)*. Where are they on this machine? Please configure
> `HVIGORW`, `OHOS_BASE_SDK_HOME` and `DEVECO_SDK_HOME`, `HAPSIGNER` and Java on
> `PATH`, `HDC_DIR` or `PATH`, or `KIT_ROOT` or `PATH` as appropriate for this
> workflow. I will use these environment settings without storing paths in
> scripts or documentation.

One more prerequisite is not in this repo and is not covered by that command:
**llama.cpp**, under `entry/src/main/cpp/llama.cpp` (git-ignored). Fetch the
commit pinned in `entry/src/main/cpp/CMakeLists.txt` (the commands are in the
comment at its top), then delete `entry/.cxx` once. Without it the build still
succeeds but produces a stub with no model support, and the Generate and Chat
screens say so in their status line.
A missing llama.cpp is currently the normal case: `build-hap.sh` warns and
`update-phone.sh` carries on, so do not stop an update because of that warning.
`REQUIRE_LLAMA=1 ./update-phone.sh` makes it refuse instead; use it only when the
person asks.

## Building and signing

`build-hap.sh` runs a clean Hvigor build (`createHapTask`, wrapper from
`HVIGORW`, invoked with `bash`) and copies the HAP to
`${HAP_OUT_DIR:-/tmp/vera-probe-dyn-hap}`. By default it then calls
`sign-system.sh`; `--unsigned` skips signing. Command, outputs and the signing
profile are described in `README.md`. Do not expect an `arkui-hvigor` wrapper or
its JSON status protocol; it is not used.

A **first installation** is manual (see `README.md`, "First installation") and
needs the person's explicit confirmation that the app is absent on the device.
`update-phone.sh` never does it. That confirmation does not extend to
uninstalling or clearing data if an installation turns out to exist.

A program that calls `std/intent` needs system signing, because
`insightIntentDriver` is a system API.

For shell-only changes, run:

```bash
for script in build-hap.sh sign-system.sh update-phone.sh tool-paths.sh measure.sh pull-vera-sources.sh send-prompt.sh; do
  bash -n "$script" || exit
done
git diff --check
```

No shell lint or typecheck command is configured; use ShellCheck if it is
available.

## Three traps that cost real time

**Never `hdc uninstall`.** It destroys `{filesDir}/vera`: every saved project,
every program's state and the DeepSeek API key. The sandbox is readable from
`hdc shell`, so before anything risky run `./pull-vera-sources.sh --raw` (a
complete copy; add `--no-settings` to leave the API key out). If an
install is refused, work out why. A normal app cannot be updated into a system
app in place (`9568294 apptype not same`), so a bundle that has ever been
installed normally must be built under a throwaway `bundleName` to test a system
profile.

**The API key is a launch parameter**, never compiled in, and it survives
restarts once stored:

```bash
hdc shell aa start -a EntryAbility -b com.vera.probe.dyn --ps deepseekKey sk-...
```

The same goes for `vera-server`, if the Server generation mode is wanted:
`--ps veraServer http://host:port`. Neither has a default, and neither belongs
in the source.

**Prompts typed into the Generate screen are written in English**, even when the
conversation is not.

## Reading from and driving the phone

Three helper scripts talk to the phone through `hdc` and honour `HDC_DEVICE`:

- `./pull-vera-sources.sh [--raw [--no-settings]] [dir]` pulls the saved programs
  off the phone: `<project>--<version>.vera`, `.prompt.txt` and `.vbc2` plus
  `manifest.json` (version order, hashes, phone times, every other version field,
  and a `rebuildable` flag). With `--raw` it also makes a complete copy of the
  app's data in `dir/raw/` (including the catalogue, program state and
  `settings.json` with the API key): use it as the backup before anything risky.
  Programs that were generated but never saved are not on the device. The output
  holds the person's prompts and, with `--raw`, the API key: never commit it,
  never paste it.
- `./push-vera-sources.sh [--check | --apply] [--raw] [dir]` copies programs onto
  a phone: by default rebuilt from the plain files and `manifest.json` (projects
  with a version that is not `rebuildable` are skipped), with `--raw` from the
  complete copy. Dry run by default. Run `--check` first (it only works if the
  phone lets the hdc shell write into the sandbox with the app's owner) and do
  not run `--apply` without the person's go-ahead.
- `./send-prompt.sh [-t X Y] "text"` types text into the focused field. Prompts
  are English (see above).
- `./measure.sh [reps]` is the cold-run benchmark. It needs `arkui-device-cli`
  and writes `results/device.jsonl`.

## Checking things without a device

The ArkTS build leaves plain TypeScript in
`entry/build/default/cache/default/default@CompileArkTS/esmodule/release/entry/src/main/ets/vera/`,
so the compiler, the VM, the UI decoder and the theme all run under node on the
host. That is the fast way to check a change: seconds, no install, no
generation. Two things to know: imports come out as
`"@normalized:N&&&entry/src/main/ets/vera/X&"` and must be rewritten to
`"./X.js"`, and `compileVeraSource` **throws** `CompileError` carrying
`.diagnostics` rather than returning them.

For anything visual, render a proof sheet rather than waiting on a generated app
to happen to contain the thing you changed: a hand-built node tree in the
renderer, or an SVG rasterised on the host. Chasing a layout bug through
minute-long generations does not converge; that mistake has been made here.

## Where the pieces are

| file | what it is |
|---|---|
| `entry/src/main/ets/vera/VeraUiCatalog.ets` | the one description of `std/ui`: components, styles, icons, composition rules. The compiler interface, the validator and the model's prompt are all generated from it |
| `entry/src/main/ets/vera/VeraTheme.ets` | six presets, light and dark, and every colour and size the renderer uses |
| `entry/src/main/ets/vera/VeraIcons.ets` | sixteen icons as path data, normalised to one optical size |
| `entry/src/main/resources/rawfile/vera-skill.txt` | the prompt, with `{{UI_CATALOG}}` spliced in |
| `docs/demo-prompts.md` | the prompts this is demonstrated with, and what to check in the output |
| `docs/prompts/intent-coverage.md` | 59 prompts that between them reach 596 of the 640 intents this phone has, each with the addresses it should pull in and a table to record what the phone actually did. `tools/prompt-coverage.py` checks it against the pulled `insight_intent.db` on the host. Run that before editing a prompt, because the wording decides which addresses the model is shown |
| `docs/prompts/block-composition.md` | prompts for the composed blocks (record_log and the readers that take their data from its ports), the layout and blocks each should give, and a column for what the phone did. Blocks, ports, layouts, holes and the composition record are in `VeraTemplates.ets`, `VeraLayouts.ets`, `VeraHoles.ets`, `VeraComposition.ets`; host checks are `tools/vera-harness/{ledger,itinerary,timer,reminders,composition,hole,port-bind,section-pick,route,verify}-check.js` |
| `docs/agent.md` | how a new screen is built now: the route (`vera/agent/VeraBuildRoute.ets`), the agent (`vera/agent/VeraAgent.ets`), the plan format (`vera/ScreenPlan.ets`), holes the model writes (`vera/agent/AgentHole.ets`, `AgentCustom.ets`), the terms, the measured results and the switches. Host checks `tools/vera-harness/{agent,plan,parts,compose}-check.js`; live runs `tools/vera-harness/agent-run.js` |
| `docs/examples/shanghai-layover.vera` | a program the model actually wrote, kept verbatim |
| `docs/intent-call-contract.md` | `intent.call`'s signature and its four-shape answer contract (JSON / `"ok"` / `"declined code=N"` / `"error N: ..."`), with two confirmed device cases of generated code checking for `"ok"` or not checking at all. Read before touching a handler that reports success or failure |

Adding a component means editing the catalogue, adding a case in `VeraUi.ets`,
and adding a branch in `VeraPreview.ets`; the compiler, the validator and the
prompt follow from the catalogue on their own. The renderer keeps a second
hardcoded list of kinds it can draw and complains on startup if it drifts from
the catalogue.
