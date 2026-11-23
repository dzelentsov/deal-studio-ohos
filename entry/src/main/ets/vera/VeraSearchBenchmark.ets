/**
 * Rigorous timing benchmark for find_sdk_function/find_intent_function's
 * two search paths (token vs embedding) -- 3 interleaved passes over the
 * same 22 real `need` strings DeepSeek actually asked during the 10 live
 * prompts in docs/embeddings-benchmark.md, calling the search functions
 * directly, with no DeepSeek round trip involved at all.
 *
 * Same "dev-only diagnostic, reachable only from a launch parameter sent by a
 * native caller such as the shell" shape as IntentProbe.ets's runProbe, with one
 * difference: unlike a raw intent call, this needs both corpus caches
 * already warm, which only happens inside GeneratePage.ets's own resource
 * loading -- so EntryAbility.ets's extractBenchmark only sets `requested`
 * here; GeneratePage.ets's ensureEmbeddingsReady() is what actually calls
 * runSearchBenchmark(), once both caches report ready.
 *
 *   hdc shell aa start -a EntryAbility -b com.vera.probe.dyn \
 *     --ps veraBenchmark 1
 *   hdc shell hilog -x | grep VERA-BENCH
 *
 * Methodology (see docs/embeddings-benchmark.md for the full writeup):
 *   - Three full passes over all 22 need-strings, not three consecutive
 *     reps of one before moving to the next -- spreads any time-based
 *     drift (thermal, GC) evenly across every need-string instead of
 *     concentrating it on whichever ones happen to run later.
 *   - No warmup pass discarded. A real generation is "cold" for these
 *     functions too; discarding a warmup rep would make this less
 *     representative of real conditions, not more.
 *   - Timed region is the search call only -- Date.now() immediately
 *     around findSdkFunctionFromCache/findSdkFunctionByEmbedding (and the
 *     intent equivalents), logging happens after the delta is captured,
 *     never inside the timed window.
 *   - No DeepSeek involved: calls the four search functions directly, so
 *     there is no network latency or model non-determinism in the need
 *     string itself (DeepSeek does not reliably repeat the same phrasing
 *     across separate real generations -- confirmed directly while
 *     collecting the first version of this benchmark).
 */

import { hilog } from '@kit.PerformanceAnalysisKit'
import { systemDateTime } from '@kit.BasicServicesKit'
import { VirtualMachine, BytecodeModule, RuntimeValue, RuntimeTrap, VeraNumberValue, VeraStringValue,
  VeraBooleanValue, VeraObjectValue, VeraArrayValue, NULL_VALUE, VmSafetyTurnScope, VmHostSafetyScope,
  deserializeVbc2, encodeRuntimeValue, decodeRuntimeValue } from './VeraInterpreter'
import { UiHostEnvironment, VeraUiNode, decodeVeraUi } from './VeraUi'
import { compileVeraSource } from './VeraCompiler'
import { pointerValue, decodeGfx } from './VeraGfx'
import { sceneEventValue, decodeScene } from './VeraScene'
import { store } from './ProjectStore'
import { veraStateStamp } from './VeraStateStamp'
import { canonicalPayload, validateEncodedState } from '../runtime/StateFileFormat'
import { findSdkFunctionFromCache, sdkIndexSize } from './VeraSdkIndex'
import { findIntentFunction } from './VeraIntentIndex'
import { findSdkFunctionByEmbedding, sdkEmbeddingsReady } from './VeraSdkEmbeddingCache'
import { findIntentFunctionByEmbedding, intentEmbeddingsReady } from './VeraIntentEmbeddingCache'

const DOMAIN = 0x0000

class BenchCase {
  prompt: string = ''
  need: string = ''
  constructor(prompt: string, need: string) { this.prompt = prompt; this.need = need }
}

// Exactly the 22 real need-strings DeepSeek asked during the 10 live
// prompts in docs/embeddings-benchmark.md, grouped by the prompt that
// produced them -- not written fresh for this benchmark.
const SDK_CASES: BenchCase[] = [
  new BenchCase('1', 'read the current battery level'),
  new BenchCase('2', 'turn on the phone flashlight torch'),
  new BenchCase('3', 'turn Bluetooth on or off'),
  new BenchCase('4', 'take a photo with the camera'),
  new BenchCase('5', 'start turn by turn navigation to a destination address'),
  new BenchCase('6', 'read the current weather forecast for my location'),
  new BenchCase('7a', 'scan a QR code with the camera and return the decoded text'),
  new BenchCase('7b', 'scan a barcode or QR code using the camera'),
  new BenchCase('8a', 'vibrate the phone'),
  new BenchCase('8b', 'show a notification'),
  new BenchCase('9', 'check whether the phone is currently connected to WiFi'),
  new BenchCase('10a', 'record a short voice memo from the microphone'),
  new BenchCase('10b', 'play back a recorded audio file'),
]

const INTENT_CASES: BenchCase[] = [
  new BenchCase('2', 'turn on the phone flashlight torch'),
  new BenchCase('3', 'open Bluetooth settings'),
  new BenchCase('4', 'take a photo with the camera'),
  new BenchCase('5', 'start turn by turn navigation to an address'),
  new BenchCase('6', 'send a text message to a contact'),
  new BenchCase('7a', 'open a web link in the browser'),
  new BenchCase('7b', 'open a URL or web page in the web browser'),
  new BenchCase('9', 'open the WiFi settings screen'),
  new BenchCase('10', 'record a voice memo with the sound recorder app'),
]

let requestedFlag = false

/** Set by EntryAbility.extractBenchmark when `--ps veraBenchmark 1` is
 * present; checked by GeneratePage.ensureEmbeddingsReady() once both
 * corpus caches are confirmed warm. */
export function requestBenchmark(): void { requestedFlag = true }

/** Consumes the flag: true at most once per launch parameter, even if
 * ensureEmbeddingsReady() itself runs more than once in the same process
 * (confirmed on-device: a single `--ps veraBenchmark 1` launch produced
 * two full, interleaved runSearchBenchmark() passes under the same pid --
 * GeneratePage's own page lifecycle invoking its resource-loading path
 * twice, not a benchmark-specific bug). Checking requestedFlag without
 * clearing it let every one of those calls see "requested" and start its
 * own full run; clearing it here on first read makes a second call see
 * false no matter how many times ensureEmbeddingsReady() itself runs. */
export function benchmarkRequested(): boolean {
  if (!requestedFlag) { return false }
  requestedFlag = false
  return true
}

async function benchSdk(c: BenchCase, pass: number): Promise<void> {
  let t0 = Date.now()
  let tokenResults = findSdkFunctionFromCache(c.need, 8)
  let tokenMs = Date.now() - t0
  let t1 = Date.now()
  let embedResults = await findSdkFunctionByEmbedding(c.need, 8)
  let embeddingFullMs = Date.now() - t1
  hilog.info(DOMAIN, 'VERA', 'VERA-BENCH-SDK prompt=' + c.prompt + ' pass=' + pass.toString() +
    ' need="' + c.need + '" tokenMs=' + tokenMs.toString() +
    ' embeddingFullMs=' + embeddingFullMs.toString() +
    ' tokenFound=' + tokenResults.length.toString() +
    ' embeddingFound=' + (embedResults === null ? 0 : embedResults.length).toString())
}

async function benchIntent(c: BenchCase, pass: number): Promise<void> {
  let t0 = Date.now()
  let tokenResults = findIntentFunction(c.need, 8)
  let tokenMs = Date.now() - t0
  let t1 = Date.now()
  let embedResults = await findIntentFunctionByEmbedding(c.need, 8)
  let embeddingFullMs = Date.now() - t1
  hilog.info(DOMAIN, 'VERA', 'VERA-BENCH-INTENT prompt=' + c.prompt + ' pass=' + pass.toString() +
    ' need="' + c.need + '" tokenMs=' + tokenMs.toString() +
    ' embeddingFullMs=' + embeddingFullMs.toString() +
    ' tokenFound=' + tokenResults.length.toString() +
    ' embeddingFound=' + (embedResults === null ? 0 : embedResults.length).toString())
}

export async function runSearchBenchmark(): Promise<void> {
  hilog.info(DOMAIN, 'VERA', 'VERA-BENCH start sdkReady=' + sdkEmbeddingsReady().toString() +
    ' intentReady=' + intentEmbeddingsReady().toString() + ' sdkCorpusSize=' + sdkIndexSize().toString())
  for (let pass = 1; pass <= 3; pass++) {
    for (let c of SDK_CASES) { await benchSdk(c, pass) }
    for (let c of INTENT_CASES) { await benchIntent(c, pass) }
  }
  hilog.info(DOMAIN, 'VERA', 'VERA-BENCH done')
}

const P2_MODES: string[] = ['baseline', 'budget', 'JOURNAL', 'journal-pure']
const P2_WARMUPS: number = 20
const P2_SAMPLES: number = 15
const P2_LIMIT: number = 65536
const P2_RUN_MS: number = 60000
const P2_WORK_MS: number = 15000
const P2_PREFLIGHT_MS: number = 25
const P2_PREFLIGHT_STEPS: number = 100000
let p2Active: boolean = false
let p2CanContinue: (() => boolean) | null = null

function p2CheckActive(): void {
  if (p2CanContinue !== null && !p2CanContinue()) { throw new Error('P2_CANCELLED') }
}

function p2Now(): number {
  let value = systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, true) / 1000000
  if (!Number.isFinite(value) || value < 0) { throw new Error('P2_CLOCK') }
  return value
}

interface P2LogRecord {
  event?: string
  runId?: string
  protocol?: number
  outcome?: string
  mode?: string
  modes?: string[]
  workload?: number
  corpus?: number
  kind?: number
  handlers?: number
  pure?: number
  maxSteps?: number
  deadlineMs?: number
  steps?: number
  sample?: number
  operations?: number
  successfulOperations?: number
  failedOperations?: number
  unexecutedOperations?: number
  stepsPerOperation?: number
  batchMs?: number
  msPerOperation?: number
  failedBatchMs?: number
  warmup?: number
  warmups?: number
  successfulSamples?: number
  failedSamples?: number
  journalReservations?: number
  journalUndoRecords?: number
  hostReservations?: number
  runtimeBirthSerialDelta?: number
  blockedCalls?: number
  deferredEffects?: number
  rootUnchanged?: number
  callIndex?: number
  inputUnchanged?: number
  resultMatchesInputBefore?: number
  resultMatchesInputAfter?: number
  returnSameRuntimeValue?: number
  persistenceFormatValid?: number
  stateRoundTripEqual?: number
  postStatePureViewChecked?: number
  postStatePureViewOutcome?: string
  stateSchemaChecked?: number
  rollbackSucceeded?: number
  checkScope?: string
  ownershipAliasCorrectnessChecked?: number
  minimumUndo?: number
  minimumHost?: number
  expectedReservations?: number
  reservationExpectationsMet?: number
  journalLimit?: number
  executionOutcome?: string
  rootRestored?: number
  rollbackMs?: number
  synchronousHostMs?: number
  hostCalls?: number
  cooperative?: number
  elapsedMs?: number
  projectsListed?: number
  projectsVisited?: number
  versionsListed?: number
  bytecodesRead?: number
  statesRead?: number
  versionsSelected?: number
  versionsNotSelected?: number
  rejected?: number
  oversized?: number
  versionSelectionCap?: number
  seedMode?: number
  nodesVisited?: number
  traversalLimited?: number
  unvisitedNodesCountKnown?: number
  handlersDiscovered?: number
  handlersSelected?: number
  handlersSkipped?: number
  twoParameterFunctions?: number
  pureEntriesSelected?: number
  handlerSelectionCap?: number
  pureSelectionCap?: number
  explorationPasses?: number
  effectCallbacksExercised?: number
  samples?: number
  widgetMaxSteps?: number
  widgetDeadlineMs?: number
  runLimitMs?: number
  workLimitMs?: number
  preflightLimitMs?: number
  preflightMaxSteps?: number
  referenceMs?: number
  stopReason?: string
  batchCap?: number
  targetBatchMs?: number
  baselineCurrentInfrastructure?: number
  nativeEffectsExecuted?: number
  gcForced?: number
  clock?: string
  birthSerialIsAllocationBytes?: number
  journalPureHandlers?: number
  hardPreemption?: number
  compileTimed?: number
  setupTimed?: number
  codecsTimed?: number
  fingerprintsTimed?: number
  journalBeginExecuteAcceptTimed?: number
  rollbackInSamples?: number
  budgetEnabled?: number
  journalEnabled?: number
  executePure?: number
  preInfrastructureBaseline?: number
  pureOnly?: number
  workloadsPlanned?: number
  workloadsAttempted?: number
  workloadsComplete?: number
  inventoryComplete?: number
  selectedWorkloadsComplete?: number
  workloadsSkipped?: number
}

function p2Log(runId: string, values: P2LogRecord): void {
  values.runId = runId
  values.protocol = 2
  hilog.info(DOMAIN, 'VERA', 'VERA-P2 %{public}s', JSON.stringify(values))
}

function p2Code(error: Object): string {
  if (error instanceof RuntimeTrap) {
    if (error.trapCode === 'R-BUDGET') { return 'budget' }
    if (error.trapCode === 'R-JOURNAL') { return 'journal' }
    if (error.trapCode === 'R-PURE') { return 'pure' }
    if (error.trapCode === 'R0017') { return 'steps' }
    return 'trap'
  }
  return 'error'
}

async function p2Yield(): Promise<void> {
  p2CheckActive()
  await new Promise<void>((resolve) => { setTimeout(() => { resolve() }, 1) })
  p2CheckActive()
}

class P2Host extends UiHostEnvironment {
  hostReservations: number = 0
  blockedCalls: number = 0
  slowProbe: boolean = false
  probeCalls: number = 0

  beginSafetyTurn(reserve: () => void): VmHostSafetyScope {
    return super.beginSafetyTurn((): void => { reserve(); this.hostReservations += 1 })
  }

  invoke(module: string, name: string, args: RuntimeValue[], awaited: boolean): RuntimeValue {
    if (module === 'std/p2' && name === 'wait' && this.slowProbe) {
      this.probeCalls += 1
      let until = p2Now() + 8
      while (p2Now() < until) {}
      return NULL_VALUE
    }
    if (module === 'std/time') {
      if (name === 'nowMillis') { return new VeraNumberValue(1700000000000) }
      if (name === 'nowSeconds') { return new VeraNumberValue(1700000000) }
      if (name === 'daysSinceEpoch') { return new VeraNumberValue(19675) }
      if (name === 'millisOfDay') { return new VeraNumberValue(43200000) }
      if (name === 'hourOfDay') { return new VeraNumberValue(12) }
      if (name === 'minuteOfHour') { return new VeraNumberValue(0) }
      if (name === 'weekday') { return new VeraNumberValue(2) }
      if (name === 'dayOfMonth') { return new VeraNumberValue(14) }
      if (name === 'monthOfYear') { return new VeraNumberValue(11) }
      if (name === 'year') { return new VeraNumberValue(2023) }
    } else if (module === 'std/ui' || module === 'std/math' || module === 'std/strings' ||
        module === 'std/gfx' || module === 'std/scene' || (module === 'std/sdk' && name === 'call')) {
      return super.invoke(module, name, args, awaited)
    }
    this.blockedCalls += 1
    throw new RuntimeTrap('R0015', 'P2_BLOCKED')
  }
}

class P2Call {
  entry: string
  input: RuntimeValue | null
  kind: number
  constructor(entry: string, kind: number, input: RuntimeValue | null = null) {
    this.entry = entry; this.kind = kind; this.input = input
  }
}

class P2Work {
  index: number
  corpus: number
  module: BytecodeModule
  seed: string
  calls: P2Call[]
  pure: boolean
  maxSteps: number = 5000000
  deadlineMs: number = 1000
  constructor(index: number, corpus: number, module: BytecodeModule, seed: string, calls: P2Call[], pure: boolean) {
    this.index = index; this.corpus = corpus; this.module = module; this.seed = seed
    this.calls = calls; this.pure = pure
    if (calls.some((call: P2Call): boolean => call.kind === 2)) { this.maxSteps = 100000 }
  }
}

class P2Prepared {
  host: P2Host
  vm: VirtualMachine
  root: RuntimeValue
  result: RuntimeValue = NULL_VALUE
  args: RuntimeValue[][] = []
  tx: Object = new Object()
  scope: VmSafetyTurnScope | null = null
  steps: number = 0
  constructor(work: P2Work, mode: string, limit: number = P2_LIMIT) {
    this.host = new P2Host()
    this.host.effectsAllowed = !work.pure && work.calls[0].kind !== 0
    this.vm = new VirtualMachine(work.module, this.host, work.maxSteps,
      mode === 'baseline' ? null : { now: p2Now, deadlineMs: work.deadlineMs },
      mode === 'JOURNAL' || mode === 'journal-pure' ? { journalMode: 'JOURNAL', journalMaxEntries: limit } : null)
    this.root = work.seed.length === 0 ? NULL_VALUE : decodeRuntimeValue(JSON.parse(work.seed) as Object)
    for (let call of work.calls) {
      let args: RuntimeValue[] = call.kind === 0 ? [] : [this.root]
      if (call.input !== null) {
        args.push(decodeRuntimeValue(encodeRuntimeValue(call.input)))
      }
      this.args.push(args)
    }
  }
}

function p2Execute(work: P2Work, mode: string, prepared: P2Prepared, diagnostics: boolean = false): void {
  if (mode === 'JOURNAL' || mode === 'journal-pure') {
    prepared.scope = prepared.vm.beginTurn(prepared.tx, prepared.root)
  }
  let state = prepared.root
  for (let i = 0; i < work.calls.length; i++) {
    let call = work.calls[i]
    if (call.kind !== 0) { prepared.args[i][0] = state }
    try {
      prepared.result = mode === 'journal-pure' && work.pure
        ? prepared.vm.executePure(call.entry, prepared.args[i]) : prepared.vm.execute(call.entry, prepared.args[i])
    } finally {
      if (diagnostics) { prepared.steps += prepared.vm.stepsExecuted() }
    }
    if (call.kind === 0 || call.kind === 5) { state = prepared.result }
  }
}

function p2Accept(prepared: P2Prepared): void {
  if (prepared.scope !== null) { prepared.scope.accept(); prepared.scope = null }
}

function p2Rollback(prepared: P2Prepared): boolean {
  if (prepared.scope === null) { return true }
  try { prepared.scope.rollback(); prepared.scope = null; return true } catch (_e) { return false }
}

function p2Fingerprint(prepared: P2Prepared): string {
  let effects = prepared.host.pendingEffects.map((effect): Object => [effect.id, effect.kind, effect.fn,
    Array.from(effect.values.entries()), effect.resultHandler, effect.rawTarget, effect.rawParams, effect.rawMode])
  return JSON.stringify([encodeRuntimeValue(prepared.root), encodeRuntimeValue(prepared.result), effects])
}

function p2Validate(work: P2Work, prepared: P2Prepared): void {
  if (work.pure && JSON.stringify(encodeRuntimeValue(prepared.root)) !== work.seed) {
    throw new Error('P2_PURE_ROOT')
  }
  let kind = work.calls[work.calls.length - 1].kind
  if (kind === 1 || kind === 2) {
    if (decodeVeraUi(prepared.result).length === 0) { throw new Error('P2_UI') }
  }
  if (kind === 3) { decodeGfx(prepared.result) }
  if (kind === 4) { decodeScene(prepared.result) }
}

const P2_SOURCE: string = `
import * as ui from "std/ui"
import * as gfx from "std/gfx"
import * as scene from "std/scene"
import * as sdk from "std/sdk"
@jsonable class AppState { n: number; values: number[]; }
function init(): AppState {
  let values: number[] = [];
  let i: number = 0;
  while (i < 2048) { values.push(i); i = i + 1; }
  return {n: 0, values: values};
}
function mutate(state: AppState, value: number): AppState {
  state.n = state.n + value;
  state.values[0] = state.values[0] + value;
  state.values.push(value);
  return state;
}
function aliasMutate(state: AppState, value: number): AppState {
  let next: AppState = {n: state.n + value, values: state.values};
  next.values.pop();
  next.values[0] = next.values[0] + value;
  next.values.push(value);
  return next;
}
function fresh(state: AppState, value: number): AppState {
  let values: number[] = [value, state.n];
  values[0] = values[0] + 1;
  return {n: state.n + value, values: values};
}
function pressure(state: AppState, value: number): AppState {
  let i: number = 0;
  while (i < value) { state.values[0] = state.values[0] + 1; i = i + 1; }
  return state;
}
function deferred(state: AppState, value: number): AppState {
  sdk.call("com.vera.p2/entry/EntryAbility/Deferred", [], "answered");
  state.n = state.n + value;
  return state;
}
function answered(state: AppState, value: string): AppState { return state; }
function view(state: AppState): ui.View {
  return ui.Column("default", [ui.NumberText("body", state.n, "", "", 1, -1),
    ui.Button("primary", "Add", "mutate", 1, true),
    ui.Surface("default", 100, 100, "draw", "", ""), ui.World("default", 100, "buildScene", "")]);
}
function widget(state: AppState, size: number): ui.View { return ui.Text("body", ui.numberToString(state.n)); }
function draw(state: AppState): gfx.Shape[] { return [gfx.circle(state.n, 2, 3, "ink")]; }
function buildScene(state: AppState): scene.Thing[] { return [scene.box("p2", state.n, 1, 0, 1, 1, 1, "accent")]; }
`

async function p2Measure(runId: string, work: P2Work, stopAt: number): Promise<boolean> {
  let modes = work.pure ? P2_MODES : P2_MODES.slice(0, 3)
  if (!work.pure) {
    p2Log(runId, { event: 'mode', workload: work.index, mode: 'journal-pure', outcome: 'unsupported' })
  }
  if (p2Now() >= stopAt) { return false }
  let reference = ''
  let referenceSteps = 0
  let referenceMs = 0
  let referencePrepared: P2Prepared | null = null
  try {
    referencePrepared = new P2Prepared(work, 'budget')
    let started = p2Now()
    p2Execute(work, 'budget', referencePrepared, true)
    referenceMs = p2Now() - started
    referenceSteps = referencePrepared.steps
    p2Validate(work, referencePrepared)
    reference = p2Fingerprint(referencePrepared)
  } catch (e) {
    p2Log(runId, { event: 'work', workload: work.index, corpus: work.corpus, outcome: 'preflight-' + p2Code(e as Object) })
    return false
  }
  if (work.corpus > 0 && (referenceSteps > P2_PREFLIGHT_STEPS || referenceMs > P2_PREFLIGHT_MS)) {
    p2Log(runId, { event: 'work', workload: work.index, corpus: work.corpus, outcome: 'skip-cost', steps: referenceSteps,
      referenceMs: referenceMs, stopReason: referenceSteps > P2_PREFLIGHT_STEPS
        ? (referenceMs > P2_PREFLIGHT_MS ? 'preflight-steps-and-time' : 'preflight-steps') : 'preflight-time' })
    return false
  }
  referencePrepared = null
  p2Log(runId, { event: 'work', workload: work.index, corpus: work.corpus, outcome: 'ready',
    kind: work.calls[0].kind, handlers: work.calls.length, pure: work.pure ? 1 : 0,
    maxSteps: work.maxSteps, deadlineMs: work.deadlineMs, steps: referenceSteps })
  let diagnosticsOk = await p2Diagnostics(runId, work, stopAt)
  let successes: number[] = modes.map((): number => 0)
  let failures: number[] = modes.map((): number => 0)
  let warmups: number[] = modes.map((): number => 0)
  let batchSizes: number[] = modes.map((): number => 1)
  let enabled: boolean[] = modes.map((): boolean => true)
  let completed = true
  let stopReason = ''
  let workStop = Math.min(stopAt, p2Now() + P2_WORK_MS)
  for (let round = 0; round < P2_WARMUPS + P2_SAMPLES; round++) {
    for (let offset = 0; offset < modes.length; offset++) {
      let m = (offset + round + work.index) % modes.length
      if (!enabled[m]) { continue }
      if (p2Now() >= workStop) {
        completed = false; stopReason = p2Now() >= stopAt ? 'run-limit' : 'work-limit'; break
      }
      let mode = modes[m]
      let count = round < P2_WARMUPS ? 1 : batchSizes[m]
      let batch: P2Prepared[] = []
      try {
        for (let i = 0; i < count; i++) { batch.push(new P2Prepared(work, mode)) }
      } catch (e) {
        enabled[m] = false
        p2Log(runId, { event: 'setup', workload: work.index, mode: mode, outcome: p2Code(e as Object) })
        continue
      }
      if (p2Now() >= workStop) {
        completed = false; stopReason = p2Now() >= stopAt ? 'run-limit' : 'work-limit'; break
      }
      let done = 0
      let outcome = 'ok'
      let started = p2Now()
      try {
        for (let item of batch) { p2Execute(work, mode, item); p2Accept(item); done += 1 }
      } catch (e) { outcome = p2Code(e as Object) }
      let elapsed = p2Now() - started
      let fingerprintFailures = 0
      for (let i = 0; i < done; i++) {
        try {
          if (p2Fingerprint(batch[i]) !== reference) { fingerprintFailures += 1 }
        } catch (_e) { fingerprintFailures += 1 }
      }
      if (done < batch.length) { p2Rollback(batch[done]) }
      if (fingerprintFailures > 0) { outcome = 'mismatch' }
      if (!Number.isFinite(elapsed) || elapsed <= 0) { outcome = 'clock-resolution' }
      let ok = outcome === 'ok' && done === count
      if (round < P2_WARMUPS) {
        if (ok) { warmups[m] += 1 }
      } else {
        if (ok) { successes[m] += 1 } else { failures[m] += 1 }
        let record: P2LogRecord = { event: 'sample', workload: work.index, corpus: work.corpus,
          mode: mode, sample: round - P2_WARMUPS, operations: count, successfulOperations: done - fingerprintFailures,
          failedOperations: fingerprintFailures + (done < count ? 1 : 0), unexecutedOperations: Math.max(0, count - done - 1),
          outcome: outcome, stepsPerOperation: referenceSteps }
        if (ok) { record.batchMs = elapsed; record.msPerOperation = elapsed / count }
        else if (elapsed > 0) { record.failedBatchMs = elapsed }
        p2Log(runId, record)
      }
      if (!ok) {
        enabled[m] = false
        if (round < P2_WARMUPS) {
          p2Log(runId, { event: 'warmup', workload: work.index, mode: mode, warmup: round, outcome: outcome })
        }
      } else if (round >= P2_WARMUPS - 1) {
        batchSizes[m] = Math.max(1, Math.min(16, Math.floor(2 / Math.max(0.001, elapsed / count))))
      }
      batch = []
      await p2Yield()
    }
    if (!completed || !enabled.some((value: boolean): boolean => value)) { break }
  }
  for (let m = 0; m < modes.length; m++) {
    p2Log(runId, { event: 'mode', workload: work.index, mode: modes[m], warmups: warmups[m],
      successfulSamples: successes[m], failedSamples: failures[m],
      outcome: successes[m] >= P2_SAMPLES && warmups[m] >= P2_WARMUPS ? 'complete' : 'partial',
      stopReason: successes[m] >= P2_SAMPLES && warmups[m] >= P2_WARMUPS ? ''
        : enabled[m] ? stopReason : 'mode-failed' })
    if (successes[m] < P2_SAMPLES || warmups[m] < P2_WARMUPS) { completed = false }
  }
  return completed && diagnosticsOk
}

async function p2Diagnostics(runId: string, work: P2Work, stopAt: number): Promise<boolean> {
  let modes = work.pure ? P2_MODES : P2_MODES.slice(0, 3)
  let correct = true
  for (let mode of modes) {
    if (p2Now() >= stopAt) { correct = false; break }
    let prepared: P2Prepared | null = null
    try {
      prepared = new P2Prepared(work, mode)
      let before = prepared.vm.safetyDiagnostics()
      let rootBefore = JSON.stringify(encodeRuntimeValue(prepared.root))
      p2Execute(work, mode, prepared, true)
      let after = prepared.vm.safetyDiagnostics()
      p2Validate(work, prepared)
      let unchanged = rootBefore === JSON.stringify(encodeRuntimeValue(prepared.root))
      let reservations = after.journalReservations
      let undo = after.journalUndoRecords
      let host = prepared.host.hostReservations
      if ((work.pure && !unchanged) || reservations !== undo + host) { correct = false }
      p2Accept(prepared)
      p2Log(runId, { event: 'diagnostic', workload: work.index, mode: mode,
        steps: prepared.steps, journalReservations: reservations, journalUndoRecords: undo,
        hostReservations: host, runtimeBirthSerialDelta: after.runtimeBirthSerial - before.runtimeBirthSerial,
        blockedCalls: prepared.host.blockedCalls, deferredEffects: prepared.host.pendingEffects.length,
        rootUnchanged: unchanged ? 1 : 0,
        outcome: work.pure && !unchanged ? 'pure-root-changed' : reservations !== undo + host ? 'counter-mismatch' : 'ok' })
      if (work.calls.some((call: P2Call): boolean => call.kind === 5)) {
        if (p2Now() >= stopAt || !p2Transitions(runId, work, mode)) { correct = false }
      }
    } catch (e) {
      correct = false
      let record: P2LogRecord = { event: 'diagnostic', workload: work.index, mode: mode,
        outcome: p2Code(e as Object) }
      if (prepared !== null) {
        let counters = prepared.vm.safetyDiagnostics()
        record.steps = prepared.steps
        record.journalReservations = counters.journalReservations
        record.journalUndoRecords = counters.journalUndoRecords
        record.hostReservations = prepared.host.hostReservations
        record.blockedCalls = prepared.host.blockedCalls
        record.deferredEffects = prepared.host.pendingEffects.length
        record.rollbackSucceeded = p2Rollback(prepared) ? 1 : 0
      }
      p2Log(runId, record)
    }
    await p2Yield()
  }
  return correct
}

function p2ReturnedState(work: P2Work, value: RuntimeValue, record: P2LogRecord): boolean {
  record.stateSchemaChecked = 0
  record.postStatePureViewChecked = 0
  try {
    let payload = canonicalPayload(encodeRuntimeValue(value))
    validateEncodedState(payload)
    record.persistenceFormatValid = 1
    let decoded = decodeRuntimeValue(JSON.parse(payload) as Object)
    record.stateRoundTripEqual = canonicalPayload(encodeRuntimeValue(decoded)) === payload ? 1 : 0
    if (record.stateRoundTripEqual !== 1) { record.outcome = 'state-roundtrip-mismatch'; return false }
  } catch (e) {
    record.persistenceFormatValid = 0
    record.outcome = 'state-format-' + p2Code(e as Object)
    return false
  }
  if (!p2Has(work.module, 'view')) { record.postStatePureViewOutcome = 'absent'; return true }
  record.postStatePureViewChecked = 1
  let scope: VmSafetyTurnScope | null = null
  try {
    let host = new P2Host()
    host.effectsAllowed = false
    let vm = new VirtualMachine(work.module, host, 100000, { now: p2Now, deadlineMs: work.deadlineMs },
      { journalMode: 'JOURNAL', journalMaxEntries: P2_LIMIT })
    let before = JSON.stringify(encodeRuntimeValue(value))
    scope = vm.beginTurn(new Object(), value)
    let roots = decodeVeraUi(vm.executePure('view', [value]))
    if (before !== JSON.stringify(encodeRuntimeValue(value)) || host.pendingEffects.length !== 0) {
      record.postStatePureViewOutcome = 'state-or-effects-changed'
    } else { record.postStatePureViewOutcome = roots.length > 0 ? 'ok' : 'empty' }
  } catch (e) { record.postStatePureViewOutcome = p2Code(e as Object) }
  finally {
    if (scope !== null) {
      try { scope.rollback() }
      catch (_e) {
        record.postStatePureViewOutcome = 'settlement-failed'
        try { scope.discard() } catch (_discard) {}
      }
    }
  }
  if (record.postStatePureViewOutcome !== 'ok') {
    record.outcome = 'post-state-view-' + record.postStatePureViewOutcome
    return false
  }
  return true
}

function p2Transitions(runId: string, work: P2Work, mode: string): boolean {
  let prepared: P2Prepared | null = null
  let callIndex = 0
  let correct = true
  let records: P2LogRecord[] = []
  try {
    prepared = new P2Prepared(work, mode)
    if (mode === 'JOURNAL' || mode === 'journal-pure') {
      prepared.scope = prepared.vm.beginTurn(prepared.tx, prepared.root)
    }
    let state = prepared.root
    for (let i = 0; i < work.calls.length; i++) {
      callIndex = i
      let call = work.calls[i]
      if (call.kind !== 0) { prepared.args[i][0] = state }
      let input = state
      let inputBefore = call.kind === 5 ? JSON.stringify(encodeRuntimeValue(input)) : ''
      prepared.result = mode === 'journal-pure' && work.pure
        ? prepared.vm.executePure(call.entry, prepared.args[i]) : prepared.vm.execute(call.entry, prepared.args[i])
      if (call.kind === 5) {
        let inputAfter = JSON.stringify(encodeRuntimeValue(input))
        let result = JSON.stringify(encodeRuntimeValue(prepared.result))
        let record: P2LogRecord = { event: 'transition', workload: work.index, corpus: work.corpus, mode: mode,
          callIndex: i, inputUnchanged: inputBefore === inputAfter ? 1 : 0,
          resultMatchesInputBefore: result === inputBefore ? 1 : 0,
          resultMatchesInputAfter: result === inputAfter ? 1 : 0,
          returnSameRuntimeValue: prepared.result === input ? 1 : 0, outcome: 'ok' }
        if (!p2ReturnedState(work, prepared.result, record)) { correct = false }
        records.push(record)
      }
      if (call.kind === 0 || call.kind === 5) { state = prepared.result }
    }
    p2Validate(work, prepared)
    p2Accept(prepared)
    for (let record of records) { p2Log(runId, record) }
    return correct
  } catch (e) {
    let record: P2LogRecord = { event: 'transition', workload: work.index, corpus: work.corpus,
      mode: mode, callIndex: callIndex, outcome: p2Code(e as Object) }
    if (prepared !== null && prepared.scope !== null) { record.rollbackSucceeded = p2Rollback(prepared) ? 1 : 0 }
    p2Log(runId, record)
    return false
  }
}

function p2Ownership(runId: string, module: BytecodeModule, seed: string): boolean {
  let scopes: string[] = ['public-old-root-map-array-backing-n-first-tail-length-mutate-rollback',
    'public-fresh-root-distinct-map-shared-array-backing-n-first-tail-length-rollback',
    'public-pure-alias-before-pop-root-map-array-backing-n-first-tail-length',
    'public-accepted-fresh-root-no-clone-next-turn-map-array-backing-n-first-tail-length-mutate-rollback']
  let correct = true
  for (let i = 0; i < scopes.length; i++) {
    let pure = i === 2
    let alias = i === 1 || pure
    let crossTurn = i === 3
    let mode = pure ? 'journal-pure' : 'JOURNAL'
    let prepared: P2Prepared | null = null
    let record: P2LogRecord = { event: 'ownership', checkScope: scopes[i], workload: 0,
      mode: mode, outcome: 'failed', ownershipAliasCorrectnessChecked: 0 }
    try {
      let one = new VeraNumberValue(1)
      let work = new P2Work(0, 0, module, seed, [new P2Call(alias ? 'aliasMutate' : 'mutate', 5, one)], pure)
      prepared = new P2Prepared(work, mode)
      let setupCorrect = true
      if (crossTurn) {
        let original = prepared.root as VeraObjectValue
        let originalArray = original.fields.get('values') as VeraArrayValue
        prepared.scope = prepared.vm.beginTurn(prepared.tx, prepared.root)
        prepared.result = prepared.vm.execute('fresh', [prepared.root, one])
        let fresh = prepared.result as VeraObjectValue
        let freshArray = fresh.fields.get('values') as VeraArrayValue
        let counters = prepared.vm.safetyDiagnostics()
        setupCorrect = fresh !== original && fresh.fields !== original.fields && freshArray !== originalArray &&
          freshArray.elements !== originalArray.elements && counters.journalReservations === 0 &&
          counters.journalUndoRecords === 0 && prepared.host.hostReservations === 0
        p2Accept(prepared)
        prepared.root = prepared.result
        prepared.tx = new Object()
      }
      if (!(prepared.root instanceof VeraObjectValue)) { throw new Error('P2_OWNERSHIP') }
      let root = prepared.root
      let fields = root.fields
      let values = fields.get('values')
      let n = fields.get('n')
      if (!(values instanceof VeraArrayValue) || !(n instanceof VeraNumberValue)) { throw new Error('P2_OWNERSHIP') }
      let elements = values.elements
      let first = elements[0]
      let tail = elements[elements.length - 1]
      if (!(first instanceof VeraNumberValue) || !(tail instanceof VeraNumberValue)) { throw new Error('P2_OWNERSHIP') }
      let oldLength = crossTurn ? 2 : 2048
      let oldN = crossTurn ? 1 : 0
      let oldFirst = crossTurn ? 2 : 0
      let oldTail = crossTurn ? 0 : 2047
      setupCorrect = setupCorrect && fields.size === 2 && n.value === oldN && first.value === oldFirst &&
        tail.value === oldTail && elements.length === oldLength
      prepared.scope = prepared.vm.beginTurn(prepared.tx, root)
      let executionOutcome = 'ok'
      try {
        prepared.result = pure ? prepared.vm.executePure('aliasMutate', [root, one])
          : prepared.vm.execute(alias ? 'aliasMutate' : 'mutate', [root, one])
      } catch (e) { executionOutcome = p2Code(e as Object) }
      record.executionOutcome = executionOutcome
      let counters = prepared.vm.safetyDiagnostics()
      record.journalReservations = counters.journalReservations
      record.journalUndoRecords = counters.journalUndoRecords
      record.hostReservations = prepared.host.hostReservations
      let expectedUndo = pure ? 0 : 3
      let reservationsExpected = counters.journalReservations === expectedUndo &&
        counters.journalUndoRecords === expectedUndo && prepared.host.hostReservations === 0
      record.reservationExpectationsMet = reservationsExpected ? 1 : 0
      let result = prepared.result
      let resultN: RuntimeValue = NULL_VALUE
      let executionCorrect = executionOutcome === (pure ? 'pure' : 'ok') && prepared.root === root &&
        root.fields === fields && fields.size === 2 && fields.get('values') === values && values.elements === elements
      if (pure) {
        executionCorrect = executionCorrect && fields.get('n') === n && n.value === oldN &&
          elements.length === oldLength && elements[0] === first && first.value === oldFirst &&
          elements[oldLength - 1] === tail && tail.value === oldTail
      } else {
        if (!(result instanceof VeraObjectValue)) { throw new Error('P2_OWNERSHIP') }
        resultN = result.fields.get('n') as RuntimeValue
        let resultArray = result.fields.get('values')
        executionCorrect = executionCorrect && resultN instanceof VeraNumberValue && resultN !== n &&
          resultN.value === oldN + 1 && n.value === oldN && first.value === oldFirst && tail.value === oldTail &&
          resultArray instanceof VeraArrayValue && resultArray === values && resultArray.elements === elements &&
          elements[0] instanceof VeraNumberValue && (elements[0] as VeraNumberValue).value === oldFirst + 1 &&
          elements[elements.length - 1] === one && one.value === 1
        if (alias) {
          executionCorrect = executionCorrect && result !== root && result.fields !== fields && result.fields.size === 2 &&
            fields.get('n') === n && n.value === oldN && elements.length === oldLength
        } else {
          executionCorrect = executionCorrect && result === root && elements.length === oldLength + 1 &&
            elements[oldLength - 1] === tail && tail.value === oldTail
        }
      }
      let rolledBack = p2Rollback(prepared)
      record.rollbackSucceeded = rolledBack ? 1 : 0
      let restored = prepared.root === root && root.fields === fields && fields.size === 2 && fields.get('n') === n &&
        n.value === oldN && fields.get('values') === values && values.elements === elements &&
        elements.length === oldLength && elements[0] === first && first.value === oldFirst &&
        elements[oldLength - 1] === tail && tail.value === oldTail
      record.rootRestored = restored ? 1 : 0
      let resultRestored = true
      if (alias && !pure) {
        resultRestored = result instanceof VeraObjectValue && result !== root && result.fields !== fields &&
          result.fields.size === 2 && result.fields.get('n') === resultN && resultN instanceof VeraNumberValue &&
          resultN.value === 1 && result.fields.get('values') === values && values.elements === elements
      }
      record.ownershipAliasCorrectnessChecked = 1
      if (setupCorrect && executionCorrect && rolledBack && restored && resultRestored && reservationsExpected) {
        record.outcome = 'ok'
      }
    } catch (e) { record.outcome = p2Code(e as Object) }
    finally {
      if (prepared !== null && prepared.scope !== null) {
        record.rollbackSucceeded = p2Rollback(prepared) ? 1 : 0
        if (prepared.scope !== null) {
          try { prepared.scope.discard() } catch (_e) {}
          prepared.scope = null
        }
        record.outcome = 'failed'
      }
    }
    if (record.outcome !== 'ok') { correct = false }
    p2Log(runId, record)
  }
  return correct
}

async function p2Settlement(runId: string, work: P2Work, limit: number, expected: string,
  minimumUndo: number, minimumHost: number, expectedReservations: number = -1): Promise<boolean> {
  let prepared = new P2Prepared(work, 'JOURNAL', limit)
  let before = JSON.stringify(encodeRuntimeValue(prepared.root))
  let outcome = 'ok'
  try { p2Execute(work, 'JOURNAL', prepared, true) } catch (e) { outcome = p2Code(e as Object) }
  let counters = prepared.vm.safetyDiagnostics()
  let started = p2Now()
  let rolledBack = p2Rollback(prepared)
  let elapsed = p2Now() - started
  let restored = before === JSON.stringify(encodeRuntimeValue(prepared.root)) && prepared.host.pendingEffects.length === 0
  let reservationsExpected = counters.journalUndoRecords >= minimumUndo &&
    prepared.host.hostReservations >= minimumHost &&
    (expectedReservations < 0 || counters.journalReservations === expectedReservations)
  let correct = rolledBack && restored && outcome === expected && reservationsExpected &&
    counters.journalReservations === counters.journalUndoRecords + prepared.host.hostReservations
  let record: P2LogRecord = { event: 'settlement', workload: work.index,
    checkScope: 'serialized-root-and-deferred-effects', ownershipAliasCorrectnessChecked: 0,
    minimumUndo: minimumUndo, minimumHost: minimumHost, expectedReservations: expectedReservations,
    reservationExpectationsMet: reservationsExpected ? 1 : 0,
    mode: 'JOURNAL', journalLimit: limit, steps: prepared.steps,
    journalReservations: counters.journalReservations, journalUndoRecords: counters.journalUndoRecords,
    hostReservations: prepared.host.hostReservations,
    outcome: correct ? 'ok' : 'failed', executionOutcome: outcome,
    rootRestored: restored ? 1 : 0 }
  if (elapsed > 0) { record.rollbackMs = elapsed }
  p2Log(runId, record)
  await p2Yield()
  return correct
}

async function p2HostDeadline(runId: string): Promise<boolean> {
  let module = deserializeVbc2(JSON.stringify(['VBC2', ['probe'], [
    ['probe', 0, 0, false, [['load-external', 'std/p2', 'wait'], ['call', 0, false], ['return']]]
  ]]))
  let host = new P2Host()
  host.slowProbe = true
  let vm = new VirtualMachine(module, host, 5000000, { now: p2Now, deadlineMs: 4 })
  let outcome = 'unexpected-success'
  let started = p2Now()
  try { vm.execute('probe') } catch (e) { outcome = p2Code(e as Object) }
  let elapsed = p2Now() - started
  let correct = outcome === 'budget' && host.probeCalls === 1
  let record: P2LogRecord = { event: 'host-deadline', mode: 'budget', deadlineMs: 4,
    synchronousHostMs: 8, hostCalls: host.probeCalls, cooperative: 1, steps: vm.stepsExecuted(),
    outcome: correct ? 'ok' : 'failed', executionOutcome: outcome }
  if (elapsed > 0) { record.elapsedMs = elapsed }
  p2Log(runId, record)
  await p2Yield()
  return correct
}

class P2Corpus {
  index: number
  module: BytecodeModule
  saved: string
  constructor(index: number, module: BytecodeModule, saved: string) {
    this.index = index; this.module = module; this.saved = saved
  }
}

class P2Inventory {
  selected: P2Corpus[]
  complete: boolean
  constructor(selected: P2Corpus[], complete: boolean) {
    this.selected = selected; this.complete = complete
  }
}

async function p2Inventory(runId: string, stopAt: number): Promise<P2Inventory> {
  let selected: P2Corpus[] = []
  p2CheckActive()
  let projects = store.listProjects(1000000)
  let listed = 0
  let readStates = 0
  let bytecodes = 0
  let rejected = 0
  let oversized = 0
  let visited = 0
  let complete = true
  for (let project of projects) {
    if (p2Now() >= stopAt) { complete = false; break }
    let versions = store.listVersions(project.id, 4000000, (): boolean => {
      p2CheckActive()
      if (p2Now() >= stopAt) { complete = false; return false }
      return true
    })
    visited += 1
    for (let version of versions) {
      if (p2Now() >= stopAt) { complete = false; break }
      listed += 1
      p2CheckActive()
      if (version.vbc2.length === 0) {
        rejected += 1
      } else {
        bytecodes += 1
        if (version.vbc2.length > 2000000) {
          oversized += 1
        } else if (selected.length < 4) {
          try {
            let module = deserializeVbc2(version.vbc2)
            let saved = store.loadState(project.id, version.id, veraStateStamp(version.vbc2), 1100000)
            readStates += 1
            if (saved.length > 1000000) { oversized += 1 }
            else { selected.push(new P2Corpus(listed, module, saved)) }
          } catch (_e) { rejected += 1 }
        }
      }
      if (listed % 8 === 0) { await p2Yield() }
    }
    if (!complete) { break }
    await p2Yield()
  }
  p2Log(runId, { event: 'inventory', projectsListed: projects.length, projectsVisited: visited,
    versionsListed: listed, bytecodesRead: bytecodes, statesRead: readStates, versionsSelected: selected.length,
    versionsNotSelected: Math.max(0, listed - selected.length), rejected: rejected, oversized: oversized,
    versionSelectionCap: 4, outcome: complete ? 'complete' : 'partial' })
  return new P2Inventory(selected, complete)
}

function p2Has(module: BytecodeModule, entry: string): boolean {
  return module.functions.some((fn): boolean => fn.name === entry)
}

function p2Arity(module: BytecodeModule, entry: string): number {
  for (let fn of module.functions) { if (fn.name === entry) { return fn.parameterCount } }
  return -1
}

function p2NodeInput(node: VeraUiNode): RuntimeValue | null {
  if (node.kind === 'field') { return new VeraStringValue('12') }
  if (node.kind === 'toggle' || node.kind === 'checkbox') { return new VeraBooleanValue(!node.checked) }
  if (node.kind === 'surface') { return new VeraNumberValue(16) }
  if (node.kind === 'world') { return sceneEventValue('tap', '', '', 0, 0, 0, 0, [], []) }
  if (node.kind === 'ticker') { return new VeraNumberValue(Math.max(16, node.minimum)) }
  if (node.kind === 'slider' || node.kind === 'numberfield') { return new VeraNumberValue(node.minimum) }
  if (node.kind === 'timefield') { return new VeraNumberValue(720) }
  if (node.kind === 'datefield') { return new VeraNumberValue(19675) }
  if (node.kind === 'select' || node.kind === 'tabs') { return new VeraNumberValue(0) }
  if (node.kind === 'button' || node.kind === 'iconbutton' || node.kind === 'cell' ||
      node.kind === 'listitem' || node.kind === 'numberlistitem' || node.kind === 'timelineitem' ||
      node.kind === 'path' || node.kind === 'backhandler' || node.kind === 'snackbar') {
    return new VeraNumberValue(node.eventValue)
  }
  return null
}

async function p2SavedWork(runId: string, corpus: P2Corpus, nextIndex: number, stopAt: number): Promise<P2Work[]> {
  let works: P2Work[] = []
  let seed = ''
  let seedMode = 0
  let init = new P2Work(nextIndex++, corpus.index, corpus.module, '', [new P2Call('init', 0)], false)
  works.push(init)
  let prepared: P2Prepared | null = null
  try {
    if (corpus.saved.length > 0) {
      seed = JSON.stringify(encodeRuntimeValue(decodeRuntimeValue(JSON.parse(corpus.saved) as Object)))
      seedMode = 1
    }
  } catch (_e) { seed = ''; seedMode = 2 }
  if (seed.length === 0) {
    try {
      prepared = new P2Prepared(init, 'budget')
      p2Execute(init, 'budget', prepared)
      seed = JSON.stringify(encodeRuntimeValue(prepared.result))
    } catch (e) {
      p2Log(runId, { event: 'coverage', corpus: corpus.index, seedMode: seedMode, outcome: 'init-' + p2Code(e as Object) })
      return works
    }
  }
  prepared = null
  let pureCalls: P2Call[] = []
  if (p2Has(corpus.module, 'view')) { pureCalls.push(new P2Call('view', 1)) }
  if (p2Has(corpus.module, 'widget')) {
    pureCalls.push(new P2Call('widget', 2, p2Arity(corpus.module, 'widget') === 2 ? new VeraNumberValue(2) : null))
  }
  if (p2Has(corpus.module, 'draw')) { pureCalls.push(new P2Call('draw', 3)) }
  if (p2Has(corpus.module, 'buildScene')) { pureCalls.push(new P2Call('buildScene', 4)) }
  let handlers: P2Call[] = []
  let seen: Set<string> = new Set<string>()
  let pureSeen: Set<string> = new Set<string>()
  for (let call of pureCalls) { pureSeen.add(call.entry) }
  let discovered = 0
  let skipped = 0
  let nodes = 0
  let traversalLimited = false
  let viewOutcome = 'absent'
  let addHandler = (entry: string, input: RuntimeValue | null, eligible: boolean): void => {
    if (entry.length === 0 || seen.has(entry)) { return }
    discovered += 1
    if (!eligible || input === null || handlers.length >= 4 || p2Arity(corpus.module, entry) !== 2) { skipped += 1; return }
    seen.add(entry)
    handlers.push(new P2Call(entry, 5, input))
  }
  let walk = (items: VeraUiNode[]): void => {
    for (let node of items) {
      if (nodes >= 512 || p2Now() >= stopAt) { traversalLimited = true; return }
      nodes += 1
      addHandler(node.action, p2NodeInput(node), node.enabled && (node.kind !== 'ticker' ||
        (node.checked && node.minimum > 0 && node.tickerId.length > 0)))
      if (node.kind === 'surface') { addHandler(node.value, pointerValue('down', 0, 12, 12), node.enabled) }
      if ((node.kind === 'surface' || node.kind === 'world') && node.label.length > 0 && !pureSeen.has(node.label)) {
        pureSeen.add(node.label)
        if (pureCalls.length < 8 && p2Arity(corpus.module, node.label) === 1) {
          pureCalls.push(new P2Call(node.label, node.kind === 'surface' ? 3 : 4))
        }
      }
      walk(node.children)
    }
  }
  if (p2Has(corpus.module, 'view') && p2Now() < stopAt) {
    let view = new P2Work(nextIndex, corpus.index, corpus.module, seed, [new P2Call('view', 1)], true)
    try {
      prepared = new P2Prepared(view, 'budget')
      p2Execute(view, 'budget', prepared)
      let roots = decodeVeraUi(prepared.result)
      walk(roots)
      viewOutcome = roots.length > 0 ? 'ok' : 'empty'
    } catch (e) { viewOutcome = p2Code(e as Object) }
  }
  for (let call of pureCalls) { works.push(new P2Work(nextIndex++, corpus.index, corpus.module, seed, [call], true)) }
  for (let call of handlers) { works.push(new P2Work(nextIndex++, corpus.index, corpus.module, seed, [call], false)) }
  if (handlers.length > 1) {
    works.push(new P2Work(nextIndex++, corpus.index, corpus.module, seed, handlers.slice(0, 2), false))
  }
  let candidates = corpus.module.functions.filter((fn): boolean => fn.parameterCount === 2 &&
    fn.name !== 'widget' && fn.name.indexOf('$') < 0).length
  p2Log(runId, { event: 'coverage', corpus: corpus.index, seedMode: seedMode, nodesVisited: nodes,
    traversalLimited: traversalLimited ? 1 : 0, unvisitedNodesCountKnown: traversalLimited ? 0 : 1,
    handlersDiscovered: discovered, handlersSelected: handlers.length,
    handlersSkipped: skipped, twoParameterFunctions: candidates, pureEntriesSelected: pureCalls.length,
    handlerSelectionCap: 4, pureSelectionCap: 8, explorationPasses: 1, effectCallbacksExercised: 0,
    outcome: viewOutcome })
  return works
}

export async function runVmSafetyBenchmark(runId: string, canContinue: (() => boolean) | null = null): Promise<void> {
  if (p2Active) { p2Log(runId, { event: 'end', outcome: 'busy' }); return }
  if (canContinue !== null && !canContinue()) { return }
  p2Active = true
  p2CanContinue = canContinue
  let started = 0
  let attempted = 0
  let complete = 0
  let planned = 0
  let inventoryComplete = false
  let outcome = 'complete'
  try {
    started = p2Now()
    let stopAt = started + P2_RUN_MS
    p2Log(runId, { event: 'start', outcome: 'ok', modes: P2_MODES, warmups: P2_WARMUPS, samples: P2_SAMPLES,
      maxSteps: 5000000, deadlineMs: 1000, widgetMaxSteps: 100000, widgetDeadlineMs: 1000,
      journalLimit: P2_LIMIT, runLimitMs: P2_RUN_MS, workLimitMs: P2_WORK_MS,
      preflightLimitMs: P2_PREFLIGHT_MS, preflightMaxSteps: P2_PREFLIGHT_STEPS, batchCap: 16, targetBatchMs: 2,
      baselineCurrentInfrastructure: 1, nativeEffectsExecuted: 0, gcForced: 0, clock: 'startup-ns-to-ms',
      birthSerialIsAllocationBytes: 0, journalPureHandlers: 0, hardPreemption: 0,
      compileTimed: 0, setupTimed: 0, codecsTimed: 0, fingerprintsTimed: 0,
      journalBeginExecuteAcceptTimed: 1, rollbackInSamples: 0 })
    for (let mode of P2_MODES) {
      let journal = mode === 'JOURNAL' || mode === 'journal-pure'
      p2Log(runId, { event: 'configuration', mode: mode, budgetEnabled: mode === 'baseline' ? 0 : 1,
        journalEnabled: journal ? 1 : 0, executePure: mode === 'journal-pure' ? 1 : 0,
        maxSteps: 5000000, deadlineMs: mode === 'baseline' ? -1 : 1000,
        journalLimit: journal ? P2_LIMIT : 0, preInfrastructureBaseline: 0,
        pureOnly: mode === 'journal-pure' ? 1 : 0 })
    }
    let inventory = await p2Inventory(runId, Math.min(stopAt, started + 10000))
    inventoryComplete = inventory.complete
    if (!inventoryComplete) { outcome = 'partial' }
    let module = deserializeVbc2(compileVeraSource(P2_SOURCE, 'p2-public').vbc2)
    let init = new P2Work(0, 0, module, '', [new P2Call('init', 0)], false)
    let initial = new P2Prepared(init, 'budget')
    p2Execute(init, 'budget', initial)
    let seed = JSON.stringify(encodeRuntimeValue(initial.result))
    if (!p2Ownership(runId, module, seed)) { outcome = 'partial' }
    let one = new VeraNumberValue(1)
    let works: P2Work[] = [init,
      new P2Work(1, 0, module, seed, [new P2Call('mutate', 5, one)], false),
      new P2Work(2, 0, module, seed, [new P2Call('fresh', 5, one)], false),
      new P2Work(3, 0, module, seed, [new P2Call('fresh', 5, one), new P2Call('mutate', 5, one)], false),
      new P2Work(4, 0, module, seed, [new P2Call('view', 1)], true),
      new P2Work(5, 0, module, seed, [new P2Call('widget', 2, new VeraNumberValue(2))], true),
      new P2Work(6, 0, module, seed, [new P2Call('draw', 3)], true),
      new P2Work(7, 0, module, seed, [new P2Call('buildScene', 4)], true),
      new P2Work(8, 0, module, seed, [new P2Call('pressure', 5, new VeraNumberValue(8192))], false),
      new P2Work(9, 0, module, seed, [new P2Call('deferred', 5, one)], false)]
    if (!(await p2Settlement(runId, works[1], P2_LIMIT, 'ok', 3, 0))) { outcome = 'partial' }
    if (!(await p2Settlement(runId, works[8], 8, 'journal', 8, 0, 8))) { outcome = 'partial' }
    if (!(await p2Settlement(runId, works[9], P2_LIMIT, 'ok', 1, 1))) { outcome = 'partial' }
    if (!(await p2HostDeadline(runId))) { outcome = 'partial' }
    let nextIndex = 10
    for (let item of inventory.selected) {
      if (p2Now() >= stopAt - 3000) { outcome = 'partial'; break }
      let saved = await p2SavedWork(runId, item, nextIndex, stopAt)
      nextIndex += saved.length
      for (let work of saved) { works.push(work) }
      await p2Yield()
    }
    planned = works.length
    for (let work of works) {
      if (p2Now() >= stopAt - 1500) { outcome = 'partial'; break }
      attempted += 1
      if (await p2Measure(runId, work, stopAt - 1500)) { complete += 1 }
      else { outcome = 'partial' }
      await p2Yield()
    }
  } catch (e) { outcome = canContinue !== null && !canContinue() ? 'cancelled' : p2Code(e as Object) }
  finally {
    try {
      let record: P2LogRecord = { event: 'end', outcome: outcome, workloadsPlanned: planned,
        workloadsAttempted: attempted, workloadsComplete: complete, inventoryComplete: inventoryComplete ? 1 : 0,
        selectedWorkloadsComplete: planned > 0 && complete === planned ? 1 : 0,
        workloadsSkipped: Math.max(0, planned - attempted), nativeEffectsExecuted: 0 }
      if (started > 0) { record.elapsedMs = p2Now() - started }
      p2Log(runId, record)
    } finally { p2CanContinue = null; p2Active = false }
  }
}
