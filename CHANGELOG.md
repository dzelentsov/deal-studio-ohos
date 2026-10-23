# Changelog

## Unreleased — SDK 26 compatibility, version provenance, and saved metrics

This entry records the work covered by the development session: platform and deployment compatibility work, followed by version/refinement tracking and persistent generation metrics. It is a handoff reference for people and AI agents, not a complete history of the application or a release certification.

Some SDK migration work was brought in from upstream and reconciled with this branch; it was not all newly authored during the session. Existing data-preservation safeguards were retained and strengthened rather than introduced from scratch. File paths below are repository-relative. Consult the target branch's current workflow instructions before executing build or device commands; this document intentionally does not replace or modify `README.md` or `CLAUDE.md`.

### Summary

- Consolidated SDK 26 build compatibility, scoped ArkUI APIs, native module typing, and selected SDK adapter fixes.
- Filtered deprecated SDK adapter candidates and preserved native error semantics in targeted handlers.
- Associated saved versions with their full accepted request history and explicitly selected base version.
- Kept the last successful source, bytecode, request, and metadata together after failed or cancelled refinements.
- Added persistent per-version metric snapshots without inheriting the base version's costs.
- Added a dedicated version Metrics window and redesigned version actions as a horizontal row.
- Restyled saved metrics with the same tile-based visual language as Generate's Metrics tab.
- The project's main **Run** button now selects the newest version with compiled bytecode. A note identifies the selected version when newer versions need compilation; if none are compiled, Run is disabled with an explanation.
- Added **Cancel/Delete** confirmation dialogs for mini-app and individual-version deletion, warning that deletion is irreversible. Deleting the only remaining version explicitly warns that the entire mini-app and its saved program data will also be deleted.
- Implemented **Pin/Unpin** with dynamic shortcuts, matching mini-app icons, and direct launch of the latest compiled version from the shortcut. The New Project icon picker now wraps within the dialog.

### 1. SDK 26 and platform compatibility

#### Build configuration

- Normalized compatible, target, and compile SDK values to `26.0.0`, retaining `runtimeOS: OpenHarmony`. This was compatibility work on an already API-26-oriented codebase, not a claim that API 26 was first introduced here.
- Retained ARM64 native builds through the `arm64-v8a` ABI configuration.
- Added the custom Hvigor `createHapTask`, which depends on `assembleHap` and gives the unsigned artifact the expected `vera-probe-dyn-unsigned.hap` name.
- Updated the build wrapper to invoke the configured Hvigor wrapper through Bash, perform a clean build, and copy the resulting HAP to the configured output directory.
- Kept offline `--unsigned` builds independent of signing and device prerequisites.

Main files: `build-profile.json5`, `entry/build-profile.json5`, `entry/hvigorfile.ts`, `build-hap.sh`.

#### ArkUI context and native bindings

- Adapted affected screens and the renderer to component/window-scoped UI APIs for navigation, host context, media queries, unit conversion, and dialogs.
- Added explicit handling for unavailable host contexts and rejected navigation promises in affected paths.
- Supplied explicit local storage for the widget entry component.
- Added a local declaration package for `libllama.so`, covering its native generation, embedding, scanning, and build-information interfaces. The ArkTS wrapper uses the typed native import instead of maintaining a separate cast-based interface.

Main files: `entry/src/main/ets/components/VeraPreview.ets`, affected files under `entry/src/main/ets/pages/`, `entry/src/main/ets/entryability/EntryAbility.ets`, `entry/src/main/ets/widget/pages/WidgetCard.ets`, `entry/src/main/cpp/types/libllama/index.d.ts`, `entry/src/main/ets/vera/LlamaEngine.ets`, `entry/oh-package.json5`.

#### Audio, capability checks, and resource cleanup

- Adapted volume, mute, and ringer implementations to the supported audio manager interfaces while keeping existing adapter addresses.
- Reworked PCM output around the renderer's `writeData` callback, with timeout and callback/resource cleanup.
- Added or restored capability checks for affected SDK adapters, audio/media operations, and embedding-model downloads.
- Improved failure handling for unavailable embedding downloads instead of allowing an unhandled failure to escape.
- Hardened chat/settings file writes so opened files are closed in `finally`. A cleanup failure does not replace an earlier write failure.

Main files: `entry/src/main/ets/vera/VeraSdkBackend.ets`, `entry/src/main/ets/vera/VeraCapabilities.ets`, `entry/src/main/ets/vera/ChatStore.ets`, `entry/src/main/ets/vera/SettingsStore.ets`.

### 2. SDK adapter generation and targeted warning fixes

- Updated backend generation to resolve capability requirements from live SDK declarations and exclude matching deprecated-only declarations.
- Kept a compatible live overload when one exists; missing or ambiguous live capability metadata remains an error rather than a guessed mapping.
- Removed the deprecated `PerformanceAnalysisKit.hidebug.dumpJsHeapData` adapter and updated associated selection/index metadata. The distinct `dumpJsRawHeapData` adapter remains; it is not treated as an equivalent replacement.
- Added targeted lexical error handling around calendar selection and camera/permission paths while preserving native error identity.
- Preserved the calendar answer convention: native failures become `error: [code: ]message`; a native void completion reported as `ok` is not independent proof that state was persisted.
- Added regression coverage for deprecation selection and synchronous/asynchronous calendar failures.

Main files: `tools/generate-sdk-backend.py`, `tools/sdk-backend-deprecation-check.py`, `tools/vera-harness/calendar-sdk-check.js`, `entry/src/main/ets/vera/VeraCalendarSdk.ets`, `entry/src/main/ets/vera/VeraSdkBackend.ets`, and the associated SDK selection/index metadata.

These are targeted fixes, not a claim that every SDK warning was eliminated. Terminal warning filtering must not be confused with fixing the underlying API or permission requirement. Do not restore excluded `systemTimer` adapters during unrelated backend regeneration.

### 3. Version request history and refinement provenance

Main files: `entry/src/main/ets/vera/ProjectStore.ets`, `entry/src/main/ets/pages/GeneratePage.ets`, `entry/src/main/ets/pages/ProjectPage.ets`.

#### Saved version fields

| Field | Meaning |
| --- | --- |
| `prompt` | Full readable request history for the accepted result: the base request plus successfully applied refinements on this branch. |
| `lastPrompt` | The most recent request/refinement included in that accepted result. |
| `parentVersionId` | ID of the explicitly selected saved base version; empty when starting without a saved base. |
| `note` | Short version-list label, not a replacement for the full request. |
| `metrics` | Optional saved metric snapshot described below. |

- The store explicitly writes and reads these fields and preserves them when replacing a version's bytecode.
- Existing files remain readable without a migration. A missing `prompt` falls back to the old note; a missing `lastPrompt` falls back to the available prompt; a missing parent ID stays empty.
- Old branch history is not reconstructed or invented from truncated notes.

#### Refinement behavior

- Per-version **Refine** loads the selected version, not whichever version happens to be latest.
- The selected source is supplied as the previous program, and accepted request history is included in the model context for the current change.
- The UI identifies the selected base and the new version that Save will create, displays the accepted request, and uses refinement-specific input labels.
- Missing or unusable selected bases block generation instead of silently switching to another base.
- **New** clears the base relationship, accepted history, result metadata, and saved-metrics snapshot for a new task.
- Server refinements use the server path and send the previous source together with the request history.

#### Accepted-result integrity

- Pending requests are promoted to accepted history only when a usable result is accepted.
- Source and compiled bytecode are kept as a matching successful pair. A failed candidate may still be visible during generation, but Save does not pair that candidate with older successful bytecode.
- Failed or cancelled refinements leave the previous successful code/request pair available for saving.
- Accepted composition/origin metadata is retained with that pair instead of being taken from a later failed candidate.
- Async run guards prevent stopped or superseded requests from accepting stale results in the affected model/server callbacks.
- A server response without both source and bytecode is rejected as a replacement result.
- Saving requires a successful source/bytecode pair; a broken source-only result is not saved through this path.

### 4. Persistent metrics for each saved version

A `VersionMetrics` object is stored inside the version JSON. Opening the saved version later restores this snapshot; this does not resume generation or reconstruct a full execution trace.

| Field | Meaning |
| --- | --- |
| `provider` | Generation mode/provider label captured for the work; `Mixed` when modes differ. |
| `model` | Captured model label where available; `Mixed` when model labels differ. |
| `elapsedMs` | Accumulated wall time within the recorded runs. |
| `runs` | Number of submitted generation/refinement runs in the recorded work. |
| `attempts` | Counted model/server generation attempts, including retries; not a count of every internal compile or selector call. |
| `inputTokens` | Measured input-token total where available. |
| `cacheHitTokens` | Measured cached input tokens, already included in input tokens. |
| `outputTokens` | Measured output-token total where available. |
| `estimatedUsd` | Available estimated cost for the priced, measured portion of the work. |
| `partial` | Conservative indication that the snapshot is not complete usage/billing accounting. |

#### Accounting boundaries

- Metrics describe work in the current generation page/session up to the last accepted result, including measured retries and earlier failed work on the way to that result.
- Costs and counters from a saved base version are **not** added to the new version.
- Several successful refinements before Save can contribute to one snapshot.
- Later failed or stopped changes do not overwrite the snapshot of the previously accepted code. If further work later succeeds, accumulated work can enter that newer accepted snapshot.
- Starting a new task resets the per-version metrics accumulator.
- Available side-call usage is collected without counting the same observed call twice.
- Cancellation and overlapping stale work can leave accounting incomplete; the implementation marks the data conservatively rather than claiming exact billing.

#### Unknown values and cost limitations

- Unknown numeric usage/cost values use `-1`, not a fabricated zero. The UI displays **No data**.
- Old versions without a snapshot retain `metrics: null` and show **Metrics were not saved for this version**.
- Parsing rejects non-finite/negative numeric values as unavailable and preserves a partial-data indication.
- Estimates use the existing `deepseek-flash` rate schedule only for the recognized official DeepSeek endpoint. Other models/endpoints and local/server generation are not assigned guessed prices.
- Multi-round generation currently lacks a complete cache-hit total for pricing. Its generation cost is not calculated from an incomplete cache figure; measured side-call costs may still be available.
- A displayed cost can therefore cover only part of the recorded work. It is an estimate, not a provider invoice.
- Current snapshots are conservatively marked partial; absence of a warning must not be assumed from positive token counts alone.
- Detailed attempt records, stage timings, source deltas, and token-stream timing are **not** persisted in this snapshot. Generate's live Metrics view can show more detail than the saved-version view.

### 5. Version list, source viewer, and Metrics presentation

- Moved per-version actions out of the right-hand column into a full-width bottom row: **Run · Refine · Src · Metrics**.
- Kept the version number, note, and creation time above the actions. Run is disabled when compiled bytecode is unavailable.
- Corrected Src headings to use the displayed version ordinal rather than the internal ID.
- Made the full version request and source scroll together while the heading and Close action remain outside the scrolling content.
- Added a separate Metrics window for each version, independent of the source viewer.
- Replaced the initial plain-text metrics presentation with tiles for time, estimated cost, runs, attempts, and token counts, plus provider/model labels and colored section headings.
- Matched Generate's Metrics visual language: light panel, white tiles, prominent values, short explanatory labels, and an explicit partial-data notice. The saved view uses its own builders; it is not the entire live Generate dashboard embedded in the version list.
- Retained clear empty/unknown states rather than drawing unavailable measurements as zero.

Main file: `entry/src/main/ets/pages/ProjectPage.ets`.

### 6. Pin/Unpin, shortcut icons, and direct mini-app launch

#### Dynamic shortcut registration and removal

- Replaced the initial Pin/Unpin placeholder with `shortcutManager.addDynamicShortcutInfos()` and `deleteDynamicShortcutInfos()`. Desktop-shortcut bookkeeping APIs are not used as a substitute for dynamic registration.
- Each shortcut uses the stable ID `shortcut_item_<projectId>` and the mini-app's name as its label. Unpin supplies that specific shortcut ID rather than deleting every dynamic shortcut belonging to the application.
- Persisted the project's `pinned` flag in the project index so the page restores the Pin/Unpin button state after reopening. Older projects without this field default to unpinned; no migration is required.
- Project deletion invokes the same Unpin path for a pinned mini-app. Confirmed deletion of its only remaining version follows the project-deletion path as well.
- The integration uses the system shortcut API and declares `ohos.permission.MANAGE_SHORTCUTS`; the installed application's system signing and permission grant remain prerequisites.

#### Shared icon resources

- Added ten packaged PNG resources corresponding to the existing mini-app icon choices, with a single `projectIconResource()` mapping and a default phone icon for unknown values.
- The library, project header, New Project picker, and dynamic shortcut now use the same artwork instead of passing an emoji string as a shortcut image reference.
- Shortcut metadata supplies the icon's resource reference and numeric `iconId`, with `moduleName: 'entry'` for resource resolution.
- Existing persisted emoji identifiers remain unchanged; the mapping supplies the images without rewriting saved projects. The packaged artwork replaces font-dependent emoji rendering in the affected screens.
- Changed the New Project icon picker to a wrapping, centered layout so all ten choices remain inside the dialog on narrow screens.

#### Launch routing

- The shortcut Want targets `EntryAbility` and carries string parameters `projectId` and `launchMode=runLatest`. The stable project ID, not its editable name, identifies the mini-app.
- `EntryAbility` reads these parameters on both `onCreate` and `onNewWant`, covering cold starts and taps while the main application is already running.
- Execution is resolved when the shortcut is tapped: `getLatestRunnableVersion()` selects the newest saved version with nonempty compiled bytecode, matching the main Run button's selection rule. The shortcut does not embed bytecode or permanently select a version.
- Opens `RunnerPage` with `projectId`, `versionId`, and `vbc2`, preserving the normal runner's version-specific state handling.
- If no version has compiled code, opens the project page with an explanation instead of starting an empty runner. A stale shortcut for a deleted project returns to the library with a message.
- Navigation waits for successful content loading, initializes the project store before reading it, and ignores callbacks from destroyed or superseded window stages. Launches carrying only `projectId`, such as existing widgets, retain their project-page behavior.

#### Verification and remaining limitations

- Unsigned ArkTS builds and `git diff --check` passed. Focused host checks passed 34 scoped cases covering routing/lifecycle behavior, shortcut metadata, runnable-version selection, all ten icon mappings, and the fallback icon.
- A host layout proof checked icon bounds at viewport widths of 320, 360, 400, and 600 vp. The user subsequently confirmed that the feature and corrected picker work on the device; the assistant did not install these changes.
- Previously created shortcuts need to be recreated through Unpin → Pin to receive the new icon metadata and launch parameters.
- Pin/Unpin still starts the platform operation asynchronously without awaiting its completion before saving the local flag. A later API rejection can therefore leave the displayed/persisted state inconsistent with the launcher. Project deletion likewise does not await shortcut removal; this is a known limitation, not transactional cleanup.
- The prototype still targets OS account ID `100`; current-account discovery and reconciliation with shortcuts changed outside the app are not implemented.

Main files: `entry/src/main/ets/vera/ProjectStore.ets`, `entry/src/main/ets/vera/ProjectIcons.ets`, `entry/src/main/ets/entryability/EntryAbility.ets`, `entry/src/main/ets/pages/Index.ets`, `entry/src/main/ets/pages/ProjectPage.ets`, `entry/src/main/resources/base/media/project_icon_*.png`, `entry/src/main/module.json5`.

### 7. Verification performed during the session

The following are historical session results, not tests executed merely by adding this document:

- Earlier compatibility work passed the calendar SDK harness (27 checks across 20 targets), a strict SDK backend typecheck, deprecation checks (10), and signing-workflow mock checks (68).
- An earlier device-bound signed ARM64 build was verified and installed; the user confirmed the signing/installation blocker was resolved.
- Request/refinement persistence, saved metrics, and the final tile-based metrics presentation each passed `./build-hap.sh --unsigned` after their respective changes.
- For the version/metrics phase, verification was deliberately restricted to unsigned builds. No additional tests, signing, installation, or device checks were performed for those UI changes.
- Successful compilation does not establish on-device visual correctness, full runtime behavior, or exact billing accuracy.
- Missing `entry/src/main/cpp/llama.cpp` produced the expected stub-build warning: local model generation and embedding support are unavailable in that artifact. An unsigned build succeeding does not prove that model support is present.
- Some unrelated host regression failures and SDK capability/permission warnings remained outside this task's scope; this entry does not claim a clean full-suite result.

### 8. Handoff rules for future changes

1. Treat accepted source, bytecode, request history, composition/origin, and metrics as one coherent result. Do not replace part of that result with data from a failed candidate.
2. Preserve explicitly selected parent IDs. Displayed version numbers are list ordinals, not durable IDs or a substitute for provenance.
3. Keep version parsing backward-compatible. Preserve the added fields in every manual version-JSON rewrite path.
4. Do not turn unknown metrics into zero, inherit base-version costs, or present measured partial costs as total lifetime spending.
5. Do not synthesize historical stage/attempt details for old snapshots. Add new persisted fields explicitly if richer saved dashboards are required.
6. Do not weaken update/signing safeguards or add machine paths, real device IDs, API keys, or exported personal prompts to the repository.
7. Raw version exports can preserve the JSON snapshot; there is no separate metrics sidecar. Unsaved generations are not exported.
8. Read the target branch's current build instructions before validation. Use unsigned builds when only compilation is requested; do not silently expand the task to device installation.
