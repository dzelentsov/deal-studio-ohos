import common from '@ohos.app.ability.common'
import { KeyboardAvoidMode } from '@ohos.arkui.UIContext'
import fs from '@ohos.file.fs'
import http from '@ohos.net.http'
import request from '@ohos.request'
import { Version, VersionMetrics, store } from '../vera/ProjectStore'
import { refreshForms } from '../vera/FormUpdater'
import { engine, LlamaEngine, GenerateRequest, GenerateResult, loadRawfileText } from '../vera/LlamaEngine'
import { compileVeraSource, CompileError } from '../vera/VeraCompiler'
import { applyRepair, repairPrompt } from '../vera/VeraRepair'
import { smokeRun } from '../vera/VeraSmoke'
import { logMark, logStep, initTrace, trace, traceCompile } from '../vera/VeraTiming'
import { deepseek, DEEPSEEK_GENERATION_MAX_TOKENS, SideCall } from '../vera/DeepSeekEngine'
import { VeraPreview } from '../components/VeraPreview'
import { settings } from '../vera/SettingsStore'
import { consent } from '../vera/VeraConsentStore'
import { describeCatalogForPrompt } from '../vera/VeraUiCatalog'
import { ensureUiEmbeddings } from '../vera/VeraUiIndex'
import { ensureCapabilities, prepareCapabilityEmbeddings } from '../vera/VeraCapabilities'
import { loadCatalogFile } from '../vera/VeraCatalogFile'
import { modelSupportNote } from '../vera/VeraEmbeddings'
import { ensureSdkEmbeddings } from '../vera/VeraSdkEmbeddingCache'
import { ensureIntentEmbeddings } from '../vera/VeraIntentEmbeddingCache'
import { benchmarkRequested, runSearchBenchmark } from '../vera/VeraSearchBenchmark'
import { sdkSearchRequested, runSdkSearchProbe } from '../vera/VeraSdkProbe'
import { uiEvalRequested, runUiEval } from '../vera/VeraUiEval'
import { uiAbRequested, runUiAb } from '../vera/VeraUiAb'
import { selectUiForPrompt, UI_SELECT_FULL, UI_SELECT_PROMPT, UI_TOOL_NOTE } from '../vera/VeraUiSelect'
import { sdkEvalRequested, runSdkEval } from '../vera/VeraSdkEval'
import { composeEnabled, ComposeResult } from '../vera/VeraCompose'
import { TemplateBuild, BUILD_COMPLETE, BUILD_TEMPLATE } from '../vera/VeraTemplatePipeline'
import { AgentRequest, AgentResult } from '../vera/agent/VeraAgent'
import { appAgentHost } from '../vera/agent/AgentAppHost'
import { AgentQuestion } from '../vera/agent/AgentQuestions'
import { QuestionCard } from '../components/QuestionCard'
import { buildScreen, RouteRequest, RouteOutcome, OUTCOME_AGENT, OUTCOME_TEMPLATE, OUTCOME_COMPLETE, OUTCOME_CANCELLED } from '../vera/agent/VeraBuildRoute'
import { templateSelectEnabled } from '../vera/VeraTemplateSelectFlag'
import { RouteInfo, routeLabel, routeShort, jevLabel, checkLabel, checkShort, routeWhy, ROUTE_BLOCKS, ROUTE_BLOCKS_MODEL, CHECK_CONFIRMED, CHECK_REJECTED, CHECK_FAILED, CHECK_NONE } from '../vera/VeraRoute'
import { compositionFromJson, compositionToJson, editComposition, selectEdit, Composition, CompositionEdit, EditResult } from '../vera/VeraComposition'

/** How the system prompt picks the std/ui components it describes: 'full', 'phrases' or 'prompt' (VeraUiSelect.ets). */
const UI_SELECT_MODE: string = UI_SELECT_PROMPT
const MAX_RETRIES: number = 3

// Appended to the request when the program above is a composed template, not the model's own earlier work.
const COMPLETION_NOTE: string = '\n\nThe program above is a ready-made screen chosen for this request. ' +
  'Keep its layout, theme and structure. Edit it so that everything the request asks for works: replace placeholder ' +
  'text with real content, and add the state, buttons, inputs and calculations the request needs. ' +
  'Return the complete program as source only.'
// vera-server's address is not written down here. It lives in settings, given
// the same way as the API key -- `--ps veraServer http://host:port` -- because
// one person's machine address has no business in a shared repository.
function serverUrl(): string { return settings.getServerUrl() }

// DeepSeek and Local both run the agent loop on the device and differ only in
// which model writes the code; Server hands the whole job to vera-server.
const MODE_DEEPSEEK: string = 'deepseek'
const MODE_SERVER: string = 'server'
const MODE_LOCAL: string = 'local'

// The lower half of the screen is one pane at a time: the running program,
// its source, or the numbers behind the run.
const TAB_PREVIEW: string = 'preview'
const TAB_CODE: string = 'code'
const TAB_METRICS: string = 'metrics'

class ServerDecodedResponse {
  source: string = ''
  bytecode: string = ''
}

class RefineRequest {
  prompt: string = ''
  previousSource: string = ''
}

class AttemptMetrics {
  attempt: number = 0
  // Waiting for the first token and streaming the rest have different causes:
  // a long wait is the prompt being read, a slow stream is the model writing.
  ttftMs: number = 0
  genMs: number = 0
  compileMs: number = 0
  inputTokens: number = 0
  outputTokens: number = 0
  cacheHitTokens: number = 0
  thinking: boolean = false
  thinkMs: number = 0
  finishReason: string = ''
  // Which layer rejected the program, taken from the leading digit of the
  // first diagnostic: E1 is the parser, E2 is names and types. Dying in the
  // parser means the model missed the syntax; dying later means it wrote
  // readable VERA-L that means the wrong thing.
  failLayer: string = ''
  failCode: string = ''
  success: boolean = false
}

/** One generation or refinement, kept after the next one starts. */
class RunRecord {
  request: string = ''
  attempts: AttemptMetrics[] = []
  compiled: boolean = false
  delta: SourceDelta = new SourceDelta()
}

/** Everything spent since the last fresh generation, refinements included. */
class RunTotals {
  runs: number = 0
  attempts: number = 0
  ms: number = 0
  llmMs: number = 0
  compileMs: number = 0
  inputTokens: number = 0
  cacheHitTokens: number = 0
  outputTokens: number = 0
}

/** How far a refinement moved the program it started from. */
class SourceDelta {
  added: number = 0
  removed: number = 0
  keptPercent: number = 0
  measured: boolean = false
}

/**
 * The compiler groups diagnostics by the layer that raises them, and the
 * leading digit says which: E1 comes from the parser, E2 from names and types.
 * The distinction is the useful one -- a program rejected by the parser missed
 * the syntax, one rejected later reads fine and means the wrong thing.
 */
function codeOf(errors: string): string {
  let m = errors.match(/[ER]\d{4}/)
  return m === null ? '' : m[0]
}

function layerOf(errors: string): string {
  if (errors.indexOf('The program compiled, but') >= 0) { return 'runtime' }
  let code = codeOf(errors)
  if (code.length === 0) { return 'compile' }
  let layer = code.substring(1, 2)
  if (layer === '1') { return 'parser' }
  if (layer === '2') { return 'names & types' }
  return 'layer E' + layer
}

function diffLines(before: string, after: string): SourceDelta {
  let delta = new SourceDelta()
  if (before.length === 0) { return delta }
  let oldLines: string[] = []
  for (let line of before.split('\n')) {
    let t = line.trim()
    if (t.length > 0) { oldLines.push(t) }
  }
  let newLines: string[] = []
  for (let line of after.split('\n')) {
    let t = line.trim()
    if (t.length > 0) { newLines.push(t) }
  }
  // Line multisets rather than a real diff: this answers "how much of the old
  // program survived" without running a diff algorithm on the phone.
  let counts = new Map<string, number>()
  for (let line of oldLines) {
    let n = counts.get(line)
    counts.set(line, (n === undefined ? 0 : n) + 1)
  }
  let kept = 0
  for (let line of newLines) {
    let n = counts.get(line)
    if (n !== undefined && n > 0) {
      kept += 1
      counts.set(line, n - 1)
    } else {
      delta.added += 1
    }
  }
  delta.removed = oldLines.length - kept
  delta.keptPercent = oldLines.length > 0 ? Math.round(kept * 100 / oldLines.length) : 0
  delta.measured = true
  return delta
}

function decodeServerResponse(body: string): ServerDecodedResponse {
  let lines = body.split('\n')
  let sourceLines: string[] = []
  let bytecodeLines: string[] = []
  let inSource = false
  let foundSource = false
  for (let line of lines) {
    if (line === ';vera-source-begin') {
      inSource = true
      foundSource = true
      continue
    }
    if (line === ';vera-source-end' && inSource) {
      inSource = false
      continue
    }
    if (inSource) {
      if (line.startsWith(';|')) {
        sourceLines.push(line.substring(2))
      }
      continue
    }
    bytecodeLines.push(line)
  }
  let result = new ServerDecodedResponse()
  result.source = foundSource ? sourceLines.join('\n') : ''
  result.bytecode = bytecodeLines.join('\n')
  return result
}

@Entry
@Component
struct GeneratePage {
  @State projectId: string = ''
  @State baseVersionId: string = ''
  @State prompt: string = ''
  @State requestHistory: string = ''
  @State baseVersionNumber: number = 0
  @State nextVersionNumber: number = 1
  @State baseError: string = ''
  @State generatedSource: string = ''
  @State status: string = ''
  @State generating: boolean = false
  @State modelReady: boolean = false
  @State mode: string = MODE_DEEPSEEK
  @State attempt: number = 0
  @State compiled: boolean = false
  @State compileErrors: string = ''
  /**
   * Experiment only (experiment/jev-template-select branch): what
   * the blocks (noteBlocks) decided for the most recent attempt, regardless of
   * outcome -- mirrors ChatMessage.templatePick (ChatPage.ets), which this
   * page lacked until it became clear hilog's ring buffer and the transient
   * `status` line (overwritten by the next phase) left no way to check
   * after the fact whether Jev was even asked. Cleared at the start of each
   * doGenerate() so a stale answer from a previous attempt is never shown
   * against the current one.
   */
  @State lastTemplatePick: string = ''
  /** Which way the request went (VeraRoute.ets): shown under the status line and on the Metrics tab. */
  @State routeInfo: RouteInfo = new RouteInfo()
  @State routeKnown: boolean = false
  @State routeVerifyMs: number = 0
  /** Set when the model's step failed and the blocks are shown without it. */
  @State routeFallback: string = ''
  /** The small model calls of this run (text for blocks, function bodies, second opinion, UI choice), for the Metrics tab. */
  @State sideCalls: SideCall[] = []
  @State compiledVbc2: string = ''
  /**
   * A picture of the screen drawn from the composer's sketch while the real program is still on its way:
   * it builds up as the sketch streams in, and stays up through a fallback generation. Taps are off;
   * it is never saved, and the finished program replaces it.
   */
  @State previewVbc2: string = ''
  @State previewNote: string = ''
  /** A blocking question from the agent (agent/AgentQuestions.ets), shown above the preview until it is answered. */
  @State questionText: string = ''
  @State questionOptions: string[] = []
  @State questionFallback: number = 0
  /** Answers the open question: an index, or null for its default. */
  private answerQuestion: ((index: number | null) => void) | null = null
  @State compiledSource: string = ''
  @State refinePrompt: string = ''
  @State program: RunTotals = new RunTotals()
  @State delta: SourceDelta = new SourceDelta()
  // Every run of this program, oldest first. A refinement used to wipe the
  // numbers of the generation it was refining, which is exactly the comparison
  // worth having.
  @State runs: RunRecord[] = []
  @State composerOpen: boolean = false
  @State tab: string = TAB_PREVIEW
  @State attempts: AttemptMetrics[] = []
  @State totalMs: number = 0
  @State fastPathRan: boolean = false
  @State fastJevMs: number = 0
  /** -1 means grounding wasn't needed this run -- distinct from a genuinely instant search. */
  @State fastSearchMs: number = -1
  @State fastContentMs: number = 0
  private systemPrompt: string = ''
  /** The skill with std/ui spliced in. */
  private promptTemplate: string = ''
  /** The skill before {{UI_CATALOG}} is filled in, so each request can choose what to describe. */
  private skillText: string = ''
  /** Components the current system prompt describes; empty means all of them. */
  private uiSelected: string[] = []
  private grammar: string = ''
  private previousSource: string = ''
  /** The next repair asks for SEARCH/REPLACE edits (VeraRepair); false after edits failed to apply. */
  private repairByEdit: boolean = true
  /**
   * A composed template that still needs its logic written (SectionPickOutcome.needsLogic). While set,
   * every attempt edits this program instead of writing one from scratch, and a failed last attempt
   * falls back to it as it stands. Cleared when a new generation starts.
   */
  private completionBase: string = ''
  /** The section kinds of the last composed screen, kept with a saved version as its origin; empty after a scratch run. */
  private templateKinds: string[] = []
  /**
   * The composition record (VeraComposition.ets) of the program on screen while it is a composed screen the
   * model has not rewritten; a refine that only adds, removes, replaces or moves a block rebuilds from it.
   * Empty after a scratch or model-finished program.
   */
  private compositionJson: string = ''
  private completionBaseVbc2: string = ''
  /** The composition record of completionBase, restored with it when the model cannot finish the template. */
  private completionComposition: string = ''
  /** True once a model-written program compiled in this generation; the saved origin then says "+model". */
  private modelWrote: boolean = false
  /** Bumped by every Generate, refine and Stop, so a run that was stopped knows it is stale when a new one resets cancelRequested. */
  private runId: number = 0
  private genStartTime: number = 0
  private cancelRequested: boolean = false
  private lastRequest: string = ''
  private failedSource: string = ''
  private serverBytecode: string = ''
  private pendingHistory: string = ''
  private pendingRequest: string = ''
  private acceptedRequest: string = ''
  private acceptedComposition: string = ''
  private acceptedOrigin: string = ''
  private acceptedMetrics: VersionMetrics | null = null
  private metricTotals: VersionMetrics = new VersionMetrics()
  private metricRunId: number = -1
  private metricMode: string = ''
  private metricModel: string = ''
  private metricPriced: boolean = false
  private metricRates: number[] = []
  private metricSeenSideCalls: Set<SideCall> = new Set<SideCall>()
  private metricPendingRuns: Set<number> = new Set<number>()
  private metricStaleRuns: Set<number> = new Set<number>()

  private prepareRequest(ask: string): void {
    this.finishMetrics(this.runId)
    this.pendingRequest = ask
    this.pendingHistory = this.requestHistory.length > 0 ?
      this.requestHistory + '\n\nRefinement:\n' + ask : ask
    this.metricRunId = this.runId + 1
    this.metricMode = this.mode
    this.metricModel = this.mode === MODE_DEEPSEEK ? settings.getModel() :
      (this.mode === MODE_LOCAL ? 'qwen2.5-coder-3b-instruct-q4_k_m' : '')
    this.metricPriced = this.mode === MODE_DEEPSEEK && this.metricModel === 'deepseek-flash' &&
      settings.getBaseUrl().replace(/\/+$/, '') === 'https://api.deepseek.com'
    this.metricRates = [this.ratePerMillion('cache'), this.ratePerMillion('fresh'), this.ratePerMillion('output')]
    this.metricSeenSideCalls = new Set<SideCall>(deepseek.getSideCalls())
    let totals = this.metricTotals
    if (totals.runs === 0) {
      totals.provider = this.modeLabel()
      totals.model = this.metricModel
    } else {
      if (totals.provider !== this.modeLabel()) { totals.provider = 'Mixed' }
      if (totals.model !== this.metricModel) { totals.model = 'Mixed' }
    }
    totals.runs++
    if (!this.metricPriced) { totals.partial = true }
  }

  private measuredTotal(total: number, value: number): number {
    return value < 0 ? total : Math.max(0, total) + value
  }

  private addMetricUsage(input: number, cached: number, output: number, priced: boolean): void {
    let totals = this.metricTotals
    totals.inputTokens = this.measuredTotal(totals.inputTokens, input)
    totals.cacheHitTokens = this.measuredTotal(totals.cacheHitTokens, cached)
    totals.outputTokens = this.measuredTotal(totals.outputTokens, output)
    if (priced && input >= 0 && cached >= 0 && output >= 0) {
      let usd = (cached * this.metricRates[0] + Math.max(0, input - cached) * this.metricRates[1] +
        output * this.metricRates[2]) / 1000000
      totals.estimatedUsd = this.measuredTotal(totals.estimatedUsd, usd)
    } else {
      totals.partial = true
    }
    if (input < 0 || cached < 0 || output < 0) { totals.partial = true }
  }

  private async metricWork<T>(run: number, work: () => Promise<T>): Promise<T> {
    this.metricPendingRuns.add(run)
    try {
      return await work()
    } finally {
      this.metricPendingRuns.delete(run)
      if (this.metricStaleRuns.delete(run) && this.metricRunId >= 0) {
        this.metricSeenSideCalls = new Set<SideCall>(deepseek.getSideCalls())
        this.metricTotals.partial = true
      }
    }
  }

  private collectMetricSideCalls(run: number): void {
    if (this.metricRunId !== run || this.metricMode === MODE_SERVER) { return }
    if (this.metricStaleRuns.size > 0) {
      this.metricTotals.partial = true
      return
    }
    for (let call of deepseek.getSideCalls()) {
      if (this.metricSeenSideCalls.has(call)) { continue }
      this.metricSeenSideCalls.add(call)
      if (!call.ok || (call.inputTokens === 0 && call.outputTokens === 0)) {
        this.metricTotals.partial = true
        continue
      }
      this.addMetricUsage(call.inputTokens, call.cachedTokens, call.outputTokens, this.metricPriced)
    }
  }

  private beginMetricAttempt(run: number): void {
    if (this.metricRunId === run) { this.metricTotals.attempts++ }
  }

  private recordMetricResult(run: number, result: GenerateResult): void {
    if (this.metricRunId !== run) { return }
    let known = result.inputTokens > 0 || result.outputTokens > 0
    let completeCache = this.metricMode === MODE_DEEPSEEK && deepseek.lastToolRounds() === 0 &&
      this.metricStaleRuns.size === 0
    let cached = completeCache && known ? deepseek.lastCacheHitTokens() : -1
    this.addMetricUsage(known ? result.inputTokens : -1, cached,
      known ? result.outputTokens : -1, this.metricPriced && completeCache)
    this.collectMetricSideCalls(run)
  }

  private finishMetrics(run: number): void {
    if (this.metricRunId !== run) { return }
    this.collectMetricSideCalls(run)
    this.metricTotals.elapsedMs += Math.max(0, Date.now() - this.genStartTime)
    this.metricRunId = -1
  }

  private copyMetrics(metrics: VersionMetrics): VersionMetrics {
    let copy = new VersionMetrics()
    copy.provider = metrics.provider
    copy.model = metrics.model
    copy.elapsedMs = metrics.elapsedMs
    copy.runs = metrics.runs
    copy.attempts = metrics.attempts
    copy.inputTokens = metrics.inputTokens
    copy.cacheHitTokens = metrics.cacheHitTokens
    copy.outputTokens = metrics.outputTokens
    copy.estimatedUsd = metrics.estimatedUsd
    copy.partial = metrics.partial
    return copy
  }

  private acceptRequest(): void {
    this.requestHistory = this.pendingHistory
    this.acceptedRequest = this.pendingRequest
    this.acceptedComposition = this.compositionJson
    this.acceptedOrigin = this.originLabel()
    this.totalMs = Math.max(0, Date.now() - this.genStartTime)
    this.finishMetrics(this.runId)
    this.acceptedMetrics = this.copyMetrics(this.metricTotals)
  }

  private startNew(): void {
    this.baseVersionId = ''
    this.baseVersionNumber = 0
    this.baseError = ''
    this.previousSource = ''
    this.requestHistory = ''
    this.pendingHistory = ''
    this.pendingRequest = ''
    this.acceptedRequest = ''
    this.acceptedComposition = ''
    this.acceptedOrigin = ''
    this.acceptedMetrics = null
    this.metricTotals = new VersionMetrics()
    this.metricRunId = -1
    this.metricSeenSideCalls = new Set<SideCall>()
    this.compiledSource = ''
    this.compiledVbc2 = ''
    this.generatedSource = ''
    this.compositionJson = ''
    this.completionBase = ''
    this.completionBaseVbc2 = ''
    this.completionComposition = ''
    this.templateKinds = []
    this.modelWrote = false
    this.previewVbc2 = ''
    this.previewNote = ''
    this.compiled = false
    this.compileErrors = ''
    this.prompt = ''
    this.refinePrompt = ''
    this.lastRequest = ''
    this.composerOpen = true
    this.nextVersionNumber = store.listVersions(this.projectId).length + 1
  }

  private hostContext(): common.Context {
    let context = this.getUIContext().getHostContext()
    if (context === undefined) {
      this.status = 'Generate host context is unavailable'
      throw new Error(this.status)
    }
    return context
  }

  aboutToAppear(): void {
    let params = this.getUIContext().getRouter().getParams() as Record<string, string>
    if (params !== null && params !== undefined) {
      this.projectId = params['projectId'] || ''
      this.baseVersionId = params['baseVersionId'] || ''
    }
    let context = this.hostContext()
    store.init(context.filesDir)
    let versions = store.listVersions(this.projectId)
    this.nextVersionNumber = versions.length + 1
    if (this.baseVersionId.length > 0) {
      let v = store.getVersion(this.projectId, this.baseVersionId)
      let index = versions.findIndex((version: Version): boolean => version.id === this.baseVersionId)
      if (v !== null && v.source.length > 0 && index >= 0) {
        this.baseVersionNumber = versions.length - index
        this.previousSource = v.source
        this.requestHistory = v.prompt
        this.compositionJson = v.composition
        this.templateKinds = v.origin.replace('+model', '').split(',').filter((kind: string): boolean => kind.length > 0)
        this.modelWrote = v.origin.endsWith('+model')
      } else {
        this.baseError = 'The selected version is unavailable or has no source. Return to the version list.'
      }
    }
    settings.init(context.filesDir)
    initTrace(context.filesDir)
    // Shrink the page for the keyboard instead of panning it: panning slides
    // the preview up under the title bar, and with the refine field pinned at
    // the bottom the page has to give up height, not move.
    this.getUIContext().setKeyboardAvoidMode(KeyboardAvoidMode.RESIZE)
    this.loadResources()
  }

  // The key can arrive from a launch parameter while this page sits in the
  // foreground, so re-read it whenever the page comes back into view.
  onPageShow(): void {
    if (this.mode === MODE_DEEPSEEK && !this.generating) {
      this.checkDeepSeek()
    }
  }

  private async loadResources(): Promise<void> {
    try {
      let context = this.hostContext()
      let mgr = context.resourceManager
      // Both catalogues are generated rather than written out in the rawfile,
      // so the prompt cannot describe a component the compiler rejects or the
      // renderer cannot draw, nor an intent the compiler will not accept and
      // the host will not send.
      // Loaded here as well as in EntryAbility: this page can be reached in a
      // process that started somewhere else, and a prompt built without the
      // file would offer fewer intents than the device actually has.
      consent.init(context.filesDir)
      let extra = loadCatalogFile(context.filesDir)
      if (extra.problems.length > 0) {
        console.warn('VERA-CATALOG rejected ' + extra.rejected.toString() + ' rows: ' +
          extra.problems.join('; '))
      }
      let skill = await loadRawfileText(mgr, 'vera-skill.txt')
      // The UI catalogue is the same for every request, so it is spliced in
      // once. The intent catalogue is not spliced at
      // all any more: find_intent_function (DeepSeekEngine.ets,
      // VeraIntentIndex.ets) looks it up, along with the raw device
      // registry, when the model decides it needs one.
      this.skillText = skill
      this.promptTemplate = skill
        .replace('{{UI_CATALOG}}', describeCatalogForPrompt())
        .replace('{{UI_TOOL_NOTE}}\n', '')
      // Chat and Generate share index readiness and background embedding work.
      ensureCapabilities(context)
      this.ensureEmbeddingsReady()
      this.systemPrompt = this.promptTemplate
      this.grammar = await loadRawfileText(mgr, 'vera.gbnf')
      this.status = 'Resources loaded'
    } catch (e) {
      this.status = 'Failed to load resources: ' + (e as Error).message
    }
    this.checkProvider()
  }

  private checkProvider(): void {
    if (this.mode === MODE_DEEPSEEK) {
      this.checkDeepSeek()
    } else if (this.mode === MODE_SERVER) {
      this.checkServer()
    } else {
      this.checkModel()
    }
  }

  private checkDeepSeek(): void {
    if (settings.hasApiKey()) {
      // A stub build cannot load the embedding model, so discovery falls back to
      // keywords; that belongs next to the provider line, which is what stays up.
      let note = modelSupportNote()
      this.status = 'DeepSeek ready (' + settings.getModel() + ', key ' + settings.maskedKey() + ')' +
        (note.length > 0 ? '. ' + note : '')
    } else {
      this.status = 'No API key. Send one with: aa start -a EntryAbility -b com.vera.probe.dyn --ps deepseekKey <key>'
    }
  }

  private async checkServer(): Promise<void> {
    if (!settings.hasServerUrl()) {
      // Said in full, because the address is not written down anywhere in the
      // app and the person has no other way to learn what is missing.
      this.status = 'No server address. Pass one at launch: ' +
        'hdc shell aa start -a EntryAbility -b com.vera.probe.dyn ' +
        '--ps veraServer http://host:port'
      return
    }
    this.status = 'Checking server...'
    let client = http.createHttp()
    try {
      let resp = await client.request(serverUrl() + '/health', {
        method: http.RequestMethod.GET,
        connectTimeout: 5000,
        readTimeout: 5000
      })
      if (resp.responseCode === 200) {
        let body = resp.result as string
        let health = JSON.parse(body) as Record<string, Object>
        this.status = 'Server ready (' + (health['model'] as string) + ')'
      } else {
        this.status = 'Server error: HTTP ' + resp.responseCode
      }
    } catch (e) {
      this.status = 'Server unreachable: ' + (e as Error).message
    } finally {
      client.destroy()
    }
  }

  private async checkModel(): Promise<void> {
    let filesDir = this.hostContext().filesDir
    let modelPath = LlamaEngine.defaultModelPath(filesDir)
    if (!LlamaEngine.modelExists(filesDir)) {
      // hdc file send is blocked on release-provisioned installs, so the
      // model is fetched from the vera-server /models endpoint instead.
      await this.downloadModel(modelPath)
    }
    this.modelReady = LlamaEngine.modelExists(filesDir)
    if (!this.modelReady) {
      this.status = 'Model not found'
      return
    }
    this.status = 'Model ready'
    if (!engine.isReady()) {
      this.status = 'Loading model...'
      let ok = engine.init({
        modelPath: modelPath,
        nCtx: 4096,
        nThreads: 4,
        nGpuLayers: 0
      })
      this.status = ok ? 'Model loaded' : 'Model load failed'
      this.modelReady = ok
    }
  }

  private async downloadModel(modelPath: string): Promise<void> {
    let context = this.hostContext()
    let filesDir = context.filesDir
    try {
      fs.mkdirSync(filesDir + '/models', true)
    } catch (_e) {}
    this.status = 'Downloading model (one-time, ~1.9GB)...'
    try {
      if (canIUse('SystemCapability.Request.FileTransferAgent')) {
        if (canIUse('SystemCapability.MiscServices.Download')) {
          let task = await request.downloadFile(context, {
            url: serverUrl() + '/models/qwen2.5-coder-3b-instruct-q4_k_m.gguf',
            filePath: modelPath
          })
          task.on('progress', (received: number, total: number): void => {
            if (total > 0) {
              this.status = 'Downloading model ' + Math.floor(received * 100 / total).toString() + '%'
            }
          })
          await new Promise<void>((resolve, reject) => {
            task.on('complete', (): void => { resolve() })
            task.on('fail', (err: number): void => { reject(new Error('download failed, code ' + err.toString())) })
          })
          this.status = 'Model downloaded'
          return
        }
        throw new Error('SystemCapability.MiscServices.Download is not supported')
      }
      throw new Error('SystemCapability.Request.FileTransferAgent is not supported')
    } catch (e) {
      this.status = 'Model download failed: ' + (e as Error).message
    }
  }

  /** Preserve UI preparation and evaluation hooks after shared capability preparation. */
  private async ensureEmbeddingsReady(): Promise<void> {
    let context = this.hostContext()
    let filesDir = context.filesDir
    await prepareCapabilityEmbeddings(context)
    let sdkPromise = ensureSdkEmbeddings(filesDir, context.resourceManager)
    let intentPromise = ensureIntentEmbeddings(filesDir, context.resourceManager)
    let uiPromise = ensureUiEmbeddings(filesDir)
    if (benchmarkRequested()) {
      await sdkPromise
      await intentPromise
      await runSearchBenchmark()
    }
    let search = sdkSearchRequested()
    if (search !== null) {
      await sdkPromise
      await runSdkSearchProbe(search)
    }
    if (uiEvalRequested()) {
      await uiPromise
      await runUiEval(context.resourceManager)
    }
    if (uiAbRequested()) {
      await uiPromise
      await runUiAb(context.resourceManager)
    }
    if (sdkEvalRequested()) {
      await sdkPromise
      await runSdkEval(context.resourceManager)
    }
  }

  private doGenerate(): void {
    if (this.prompt.trim().length === 0 || this.baseError.length > 0 || this.generating) { return }
    if (this.compiledSource.length > 0) { this.previousSource = this.compiledSource }
    if (this.mode === MODE_SERVER) {
      if (!settings.hasServerUrl()) { this.checkServer(); return }
      this.doServerGenerate()
      return
    }
    if (this.mode === MODE_DEEPSEEK && !settings.hasApiKey()) {
      this.checkDeepSeek()
      return
    }
    if (this.mode === MODE_LOCAL && !this.modelReady) { return }
    this.prepareRequest(this.prompt.trim())
    this.generating = true
    this.generatedSource = ''
    this.compiled = false
    this.compileErrors = ''
    this.attempt = 1
    this.attempts = []
    this.totalMs = 0
    this.fastPathRan = false
    this.fastJevMs = 0
    this.fastSearchMs = -1
    this.fastContentMs = 0
    this.routeKnown = false
    this.routeVerifyMs = 0
    this.routeFallback = ''
    this.sideCalls = []
    this.serverBytecode = ''
    this.previewVbc2 = ''
    this.previewNote = ''
    this.settleQuestion(null)
    this.cancelRequested = false
    this.failedSource = ''
    this.lastTemplatePick = ''
    this.completionBase = ''
    this.completionBaseVbc2 = ''
    this.completionComposition = ''
    if (this.previousSource.length === 0) {
      this.modelWrote = false
      this.templateKinds = []
      this.compositionJson = ''
    }
    this.runId++
    this.program = new RunTotals()
    this.delta = new SourceDelta()
    this.runs = []
    this.startRun(this.prompt.trim())
    this.genStartTime = Date.now()
    logMark('gen-start', 'chars=' + this.prompt.trim().length.toString())
    deepseek.clearSideCalls()
    this.sideCalls = []
    let startFields: Record<string, Object> = {}
    startFields['prompt'] = this.prompt.trim()
    startFields['refining'] = this.previousSource.length > 0
    startFields['effort'] = settings.getReasoningEffort()
    trace('gen-start', startFields)
    this.lastRequest = this.prompt.trim()
    // No pre-generation intent selection step any more: find_intent_function
    // and find_sdk_function (DeepSeekEngine.ets) are looked up by the model
    // itself, mid-generation, the first time either is worth calling.
    // JevSelector.ets is unchanged and still callable; nothing here calls it.
    this.status = 'Generating (attempt 1/' + MAX_RETRIES + ')...'
    // A new screen goes through the route (agent/VeraBuildRoute.ets): the agent and the blocks in the route's
    // order; what neither builds is reported as not built, not generated.
    // Not on top of a saved program: with previousSource set this is a change to it (the model edits it).
    let route = new RouteRequest()
    route.mode = this.mode
    if (this.previousSource.length === 0 && settings.hasSelectorKey()) {
      if (this.mode === MODE_DEEPSEEK && composeEnabled()) {
        route.agent = new AgentRequest()
        route.agent.prompt = this.prompt.trim()
      }
      if (templateSelectEnabled()) { route.blocksPrompt = this.prompt.trim() }
    }
    if (route.agent !== null || route.blocksPrompt.length > 0) {
      this.tryRoute(this.prompt.trim(), route)
      return
    }
    this.startAttemptOne(this.prompt.trim())
  }

  private async tryRoute(userPrompt: string, route: RouteRequest): Promise<void> {
    let run = this.runId
    this.metricTotals.partial = true
    let host = appAgentHost((s: string): void => { if (run === this.runId) { this.status = s } }, (vbc2: string): void => {
      if (run !== this.runId || this.cancelRequested) { return }
      this.previewVbc2 = vbc2
      this.previewNote = 'Sketching the screen...'
    }, (): boolean => run !== this.runId || this.cancelRequested, this.promptTemplate)
    host.ask = (question: AgentQuestion): Promise<number | null> => this.askPerson(question)
    let outcome: RouteOutcome = await this.metricWork(run, (): Promise<RouteOutcome> => buildScreen(route, host))
    if (run !== this.runId) { return }
    if (outcome.kind === OUTCOME_CANCELLED) {
      this.metricTotals.partial = true
      this.finishMetrics(run)
      return
    }
    if (outcome.agent !== null) { this.traceAgent(outcome.agent!) }
    if (outcome.blocks !== null) { this.noteBlocks(outcome.blocks!) }
    if (outcome.kind === OUTCOME_AGENT) {
      this.showAgent(outcome.agent!)
      return
    }
    if (outcome.kind === OUTCOME_TEMPLATE) {
      this.showTemplate(outcome.blocks!)
      return
    }
    if (outcome.kind === OUTCOME_COMPLETE) {
      let build: TemplateBuild = outcome.blocks!
      this.completionBase = build.source
      this.completionBaseVbc2 = build.vbc2
      this.completionComposition = build.composition
      this.status = build.status
      this.startAttemptOne(userPrompt, 'Completing template')
      return
    }
    // Nothing built it: no generation from scratch, the reason is shown, to be seen and fixed.
    this.totalMs = Date.now() - this.genStartTime
    this.generating = false
    this.status = 'Not built (' + (this.totalMs / 1000).toFixed(1) + ' s): ' + outcome.reason
    if (this.previewVbc2.length > 0) { this.previewNote = 'Preview from the sketch only — the app was not built' }
    this.traceEnd('not built: ' + outcome.reason)
    this.finishMetrics(run)
  }

  private traceAgent(result: AgentResult): void {
    let composed: ComposeResult = result.composed
    if (composed.source.length > 0) { traceCompile('compose', 0, composed.source, result.errors) }
    let fields: Record<string, Object> = {}
    fields['served'] = result.vbc2.length > 0
    fields['note'] = result.note
    fields['sketchMs'] = composed.sketchMs
    fields['firstPreviewMs'] = result.firstPreviewMs
    fields['previews'] = result.previews
    fields['jevMs'] = composed.jevMs
    fields['ms'] = result.ms
    fields['sketch'] = composed.sketch
    fields['answers'] = composed.answers
    fields['source'] = composed.source
    trace('compose', fields)
    console.info('VERA-COMPOSE ' + (result.vbc2.length > 0 ? 'served' : 'fell through') + ' ' + result.note)
  }

  private showAgent(result: AgentResult): void {
    let composed: ComposeResult = result.composed
    this.generatedSource = result.source
    this.compiledSource = result.source
    this.compiledVbc2 = result.vbc2
    this.acceptRequest()
    this.compiled = true
    this.compileErrors = ''
    this.composerOpen = false
    this.tab = TAB_PREVIEW
    this.generating = false
    this.totalMs = Date.now() - this.genStartTime
    this.status = 'Composed in ' + (this.totalMs / 1000).toFixed(1) + ' s (sketch ' + (composed.sketchMs / 1000).toFixed(1) +
      ' s, Jev ' + (composed.jevMs / 1000).toFixed(1) + ' s), no generation' +
      (composed.dropped.length > 0 ? '. Left out: ' + composed.dropped.join('; ') : '')
    let endFields: Record<string, Object> = {}
    endFields['ok'] = true
    endFields['attempt'] = 0
    endFields['totalMs'] = this.totalMs
    endFields['via'] = 'compose'
    trace('gen-end', endFields)
  }

  /** What the blocks (VeraTemplatePipeline.ets) answered, for the route rows and the Metrics tab, whichever way the request went. */
  private noteBlocks(build: TemplateBuild): void {
    this.fastJevMs = build.jevMs
    this.fastPathRan = true
    this.fastSearchMs = build.searchMs
    this.fastContentMs = build.contentMs
    this.routeInfo = build.route
    this.routeKnown = true
    this.routeVerifyMs = build.verifyMs
    this.sideCalls = deepseek.getSideCalls()
    this.lastTemplatePick = build.note
    if (build.action === BUILD_COMPLETE || build.action === BUILD_TEMPLATE) { this.templateKinds = build.kinds }
  }

  /** A screen composed from blocks that compiles, runs and is judged to cover the request: the result as it is. */
  private showTemplate(build: TemplateBuild): void {
    this.generatedSource = build.source
    this.compiledVbc2 = build.vbc2
    this.compiledSource = build.source
    this.compositionJson = build.composition
    this.acceptRequest()
    this.composerOpen = false
    this.tab = TAB_PREVIEW
    this.compiled = true
    this.compileErrors = ''
    this.generating = false
    this.totalMs = Date.now() - this.genStartTime
    this.status = build.status
    // The trace's closing event for a screen composed from blocks with no model call; tools/vera-bench waits for it.
    let templateEnd: Record<string, Object> = {}
    templateEnd['ok'] = true
    templateEnd['attempt'] = 0
    templateEnd['totalMs'] = this.totalMs
    templateEnd['outcome'] = 'template'
    trace('gen-end', templateEnd)
  }

  /**
   * Chooses which std/ui components the system prompt describes for this
   * request, then makes the first attempt. Only DeepSeek mode selects; every
   * other mode, and any failure on the way (no extraction, embeddings not
   * ready), describes the whole catalogue. The choice is made once and kept for
   * the retries, which only rewrite the user prompt.
   */
  private async startAttemptOne(userPrompt: string, label: string = 'Generating', plan: string = ''): Promise<void> {
    let run = this.runId
    this.systemPrompt = this.promptTemplate
    this.uiSelected = []
    if (UI_SELECT_MODE !== UI_SELECT_FULL && this.mode === MODE_DEEPSEEK && this.skillText.length > 0) {
      this.status = 'Choosing UI components...'
      let selectStartedAt = Date.now()
      let selected = await this.metricWork(run,
        (): Promise<Set<string> | null> => selectUiForPrompt(UI_SELECT_MODE, userPrompt, this.previousSource))
      logStep('ui-select', selectStartedAt, 'mode=' + UI_SELECT_MODE)
      if (run !== this.runId || this.cancelRequested) { return }
      if (selected === null) {
        console.info('VERA-UI-SELECT fallback to the whole catalogue')
      } else {
        let names: string[] = []
        selected.forEach((n: string) => { names.push(n) })
        this.uiSelected = names
        this.systemPrompt = this.skillText
          .replace('{{UI_CATALOG}}', describeCatalogForPrompt(selected))
          .replace('{{UI_TOOL_NOTE}}\n', UI_TOOL_NOTE)
        let uiFields: Record<string, Object> = {}
        uiFields['mode'] = UI_SELECT_MODE
        uiFields['described'] = names
        uiFields['promptChars'] = this.systemPrompt.length
        uiFields['fullChars'] = this.promptTemplate.length
        trace('ui-select', uiFields)
        console.info('VERA-UI-SELECT mode=' + UI_SELECT_MODE + ' described=' + names.length.toString() +
          ' promptChars=' + this.systemPrompt.length.toString() + ' fullChars=' + this.promptTemplate.length.toString())
      }
    }
    this.status = label + ' (attempt 1/' + MAX_RETRIES + ')...'
    let contextPrompt = this.requestHistory.length > 0 ?
      'Version request history:\n' + this.requestHistory + '\n\nCurrent change request:\n' + userPrompt : userPrompt
    this.runAttempt(plan.length > 0 ? contextPrompt + '\n\n' + plan : contextPrompt, '')
  }

  private async doServerGenerate(ask: string = ''): Promise<void> {
    let submitted = ask.length > 0 ? ask : this.prompt.trim()
    this.prepareRequest(submitted)
    this.cancelRequested = false
    let run = ++this.runId
    this.generating = true
    this.generatedSource = ''
    this.compiled = false
    this.compileErrors = ''
    this.attempts = []
    this.totalMs = 0
    this.fastPathRan = false
    this.fastJevMs = 0
    this.fastSearchMs = -1
    this.fastContentMs = 0
    this.routeKnown = false
    this.routeVerifyMs = 0
    this.routeFallback = ''
    this.sideCalls = []
    this.serverBytecode = ''
    this.program = new RunTotals()
    this.delta = new SourceDelta()
    this.runs = []
    this.startRun(submitted)
    this.genStartTime = Date.now()
    this.lastRequest = submitted
    this.status = this.previousSource.length > 0 ? 'Server refining...' : 'Server generating...'

    let metrics = new AttemptMetrics()
    metrics.attempt = 1
    this.beginMetricAttempt(run)
    let client = http.createHttp()
    try {
      let genStart = Date.now()
      // Refinement: send the base version's source so the server can edit it
      // instead of regenerating from scratch.
      let requestBody: string = this.pendingHistory
      let contentType: string = 'text/plain; charset=utf-8'
      if (this.previousSource.length > 0) {
        let refine = new RefineRequest()
        refine.prompt = this.pendingHistory
        refine.previousSource = this.previousSource
        requestBody = JSON.stringify(refine)
        contentType = 'application/json'
      }
      let resp = await client.request(serverUrl() + '/compile', {
        method: http.RequestMethod.POST,
        header: { 'Content-Type': contentType },
        extraData: requestBody,
        connectTimeout: 10000,
        readTimeout: 180000
      })
      if (run !== this.runId || this.cancelRequested) { return }
      metrics.genMs = Date.now() - genStart

      if (resp.responseCode === 200) {
        let body = resp.result as string
        let decoded = decodeServerResponse(body)
        if (decoded.source.trim().length === 0 || decoded.bytecode.trim().length === 0) {
          this.status = 'Server result has no source/bytecode pair; the previous successful result is unchanged'
          this.generating = false
          this.totalMs = Date.now() - this.genStartTime
          return
        }
        this.generatedSource = decoded.source
        this.serverBytecode = decoded.bytecode
        this.compiledVbc2 = decoded.bytecode
        this.compiledSource = decoded.source
        this.compositionJson = ''
        this.modelWrote = true
        this.acceptRequest()
        this.composerOpen = false
        this.tab = TAB_PREVIEW
        this.compiled = true
        this.compileErrors = ''
        metrics.success = true
        this.status = 'Server compiled successfully'
      } else {
        let body = resp.result as string
        try {
          let errObj = JSON.parse(body) as Record<string, Object>
          let diags = errObj['diagnostics'] as Object[]
          if (diags !== null && diags !== undefined && diags.length > 0) {
            let firstDiag = diags[0] as Record<string, Object>
            let msg = (firstDiag['message'] as string) || ''
            let generatedSrc = (firstDiag['generatedSource'] as string) || ''
            if (generatedSrc.length > 0) {
              this.generatedSource = generatedSrc
            }
            this.compileErrors = msg
          } else {
            this.compileErrors = 'Server error: HTTP ' + resp.responseCode
          }
        } catch (_e) {
          this.compileErrors = 'Server error: HTTP ' + resp.responseCode + ' — ' + body.substring(0, 200)
        }
        this.status = 'Server generation failed'
      }
    } catch (e) {
      if (run !== this.runId || this.cancelRequested) { return }
      this.compileErrors = 'Request failed: ' + (e as Error).message
      this.status = 'Server unreachable'
    } finally {
      client.destroy()
      if (run === this.runId) { this.finishMetrics(run) }
    }

    this.attempts = [metrics]
    this.totalMs = Date.now() - this.genStartTime
    this.generating = false
  }

  /**
   * The one place that knows which model is behind the loop. Everything after
   * it -- compile, collect diagnostics, retry -- is identical for both.
   */
  private async callModel(request: GenerateRequest, onToken: (token: string) => void, run: number): Promise<GenerateResult> {
    if (this.mode === MODE_DEEPSEEK) {
      // Initial generation, refinement, and retries share reasoning and output settings.
      await ensureCapabilities(this.hostContext())
      if (run !== this.runId || this.cancelRequested) { return new GenerateResult() }
      // Finishing a composed screen only adds to it, and reasoning was most of that call's output; repairs and a
      // generation from scratch still think.
      let finishingBase = this.completionBase.length > 0 && request.previousSource === this.completionBase
      deepseek.setThinking(!finishingBase)
      request.maxTokens = DEEPSEEK_GENERATION_MAX_TOKENS
      return deepseek.generate(request, onToken)
    }
    return Promise.resolve(engine.generate(request, onToken))
  }

  private async runAttempt(userPrompt: string, errorFeedback: string): Promise<void> {
    let run = this.runId
    this.generatedSource = ''
    let metrics = new AttemptMetrics()
    metrics.attempt = this.attempt

    let request = new GenerateRequest()
    request.systemPrompt = this.systemPrompt
    request.uiSelected = this.uiSelected
    request.uiTool = this.uiSelected.length > 0
    request.grammar = this.grammar
    request.maxTokens = 2048
    request.temperature = 0.2

    if (errorFeedback.length === 0) { this.repairByEdit = true }
    // Only DeepSeek is asked for edits; the local model rewrites as before.
    let editing = errorFeedback.length > 0 && this.repairByEdit && this.mode === MODE_DEEPSEEK
    if (errorFeedback.length > 0) {
      // Hand back the program that failed, not the last one that worked: the
      // diagnostics carry line and column numbers, and they only mean
      // something against the text they were produced from. Sending the last
      // good program instead made every retry a blind rewrite -- which is how
      // three attempts in a row used to trip over the same operator.
      request.previousSource = this.failedSource
      request.repairByEdit = editing
      request.userPrompt = repairPrompt(userPrompt, errorFeedback, editing, this.failedSource)
    } else if (this.completionBase.length > 0) {
      request.previousSource = this.completionBase
      request.userPrompt = userPrompt + COMPLETION_NOTE
    } else if (this.previousSource.length > 0) {
      request.previousSource = this.previousSource
      request.userPrompt = userPrompt
    } else {
      request.userPrompt = userPrompt
    }

    let genStart = Date.now()
    let firstTokenAt = 0
    let genResult: GenerateResult
    this.beginMetricAttempt(run)
    try {
      genResult = await this.metricWork(run, (): Promise<GenerateResult> => this.callModel(request, (token: string) => {
        if (run !== this.runId || this.cancelRequested) { return }
        if (firstTokenAt === 0) { firstTokenAt = Date.now() }
        this.generatedSource += token
      }, run))
      if (run !== this.runId) { return }
      this.recordMetricResult(run, genResult)
      if (genResult.text.length > 0) {
        this.generatedSource = genResult.text
      }
    } catch (e) {
      if (run !== this.runId) { return }
      this.metricTotals.partial = true
      metrics.genMs = Date.now() - genStart
      metrics.failLayer = 'request'
      this.attempts = [...this.attempts, metrics]
      this.totalMs = Date.now() - this.genStartTime
      this.addToProgram(metrics)
      this.traceEnd('request: ' + (e as Error).message)
      if (!this.fallBackToTemplate('Logic step failed (' + (e as Error).message + ')')) {
        this.status = 'Generation failed: ' + (e as Error).message
      }
      this.generating = false
      this.finishMetrics(run)
      return
    }
    metrics.genMs = Date.now() - genStart
    metrics.ttftMs = firstTokenAt > 0 ? firstTokenAt - genStart : 0
    if (this.cancelRequested) {
      this.attempts = [...this.attempts, metrics]
      this.totalMs = Date.now() - this.genStartTime
      this.status = 'Stopped'
      this.generating = false
      this.metricTotals.partial = true
      this.finishMetrics(run)
      return
    }
    metrics.inputTokens = genResult.inputTokens
    metrics.outputTokens = genResult.outputTokens
    if (this.mode === MODE_DEEPSEEK) {
      metrics.cacheHitTokens = deepseek.lastCacheHitTokens()
      metrics.finishReason = deepseek.lastFinishReason()
      metrics.thinking = true
      // Prefill from the engine rather than the token callback: the callback
      // only fires on visible content, so with reasoning on it would report
      // the thinking time as waiting.
      let prefill = deepseek.lastPrefillMs()
      if (prefill > 0) { metrics.ttftMs = prefill }
      metrics.thinkMs = deepseek.lastThinkMs()
    }

    if (editing && this.generatedSource.trim().length > 0) {
      let repair = applyRepair(this.failedSource, this.generatedSource)
      if (repair.source.length === 0) {
        // The edits did not fit the failed source: the next attempt rewrites it
        // in full, against the same diagnostics and the same failed text.
        traceCompile('generate', this.attempt, this.generatedSource, 'edit not applied: ' + repair.error)
        metrics.failLayer = 'edit'
        this.attempts = [...this.attempts, metrics]
        this.addToProgram(metrics)
        if (this.attempt < MAX_RETRIES) {
          this.repairByEdit = false
          this.attempt++
          this.status = 'Edit did not apply, rewriting (attempt ' + this.attempt + '/' + MAX_RETRIES + ')...'
          await this.runAttempt(userPrompt, errorFeedback)
        } else {
          this.totalMs = Date.now() - this.genStartTime
          this.traceEnd('compile')
          if (!this.fallBackToTemplate('Logic step failed: the edits did not apply after ' + MAX_RETRIES + ' attempts')) {
            this.status = 'Compilation failed after ' + MAX_RETRIES + ' attempts'
          }
          this.generating = false
          this.finishMetrics(run)
        }
        return
      }
      this.generatedSource = repair.source
    }

    if (this.generatedSource.trim().length === 0) {
      metrics.failLayer = 'empty'
      this.traceEnd('empty')
      if (!this.fallBackToTemplate('Logic step produced no program')) {
        this.status = 'Generation produced empty output'
      }
      this.generating = false
      this.attempts = [...this.attempts, metrics]
      this.totalMs = Date.now() - this.genStartTime
      this.addToProgram(metrics)
      this.finishMetrics(run)
      return
    }

    this.status = 'Compiling (attempt ' + this.attempt + '/' + MAX_RETRIES + ')...'
    let vbc2 = ''
    let errors = ''
    let compileStart = Date.now()
    try {
      let result = compileVeraSource(this.generatedSource.trim())
      // Run once before serving: a program that compiles can still stop at its first tap, and that is
      // repaired here like a compile error rather than found on the screen.
      let smokeStart = Date.now()
      errors = smokeRun(result)
      logStep('smoke', smokeStart, 'src=generate attempt=' + this.attempt.toString() + ' ok=' + (errors.length === 0).toString())
      vbc2 = errors.length === 0 ? result.vbc2 : ''
    } catch (e) {
      if (e instanceof CompileError) {
        errors = e.message
      } else {
        errors = (e as Error).message
      }
    }
    metrics.compileMs = Date.now() - compileStart
    logStep('compile', compileStart, 'src=generate attempt=' + this.attempt.toString() + ' ok=' + (errors.length === 0).toString())
    traceCompile('generate', this.attempt, this.generatedSource.trim(), errors)

    // A program cut off at the token ceiling fails to parse somewhere near its
    // end. Saying so is worth more to the next attempt than the parse error,
    // which describes the cut rather than the mistake.
    if (errors.length > 0 && this.mode === MODE_DEEPSEEK && deepseek.lastFinishReason() === 'length') {
      errors = 'The previous attempt was cut off at the output token limit before the program ended, so it did not parse. Write a shorter program.\n' + errors
    }

    if (errors.length === 0 && vbc2.length > 0) {
      let hadProgram = this.compiledVbc2.length > 0
      metrics.success = true
      this.attempts = [...this.attempts, metrics]
      this.addToProgram(metrics)
      this.totalMs = Date.now() - this.genStartTime
      // Source and bytecode are kept as a pair: the next failed attempt
      // overwrites generatedSource, and Save must not pair that broken text
      // with the bytecode of the program still on screen.
      this.delta = diffLines(this.previousSource, this.generatedSource.trim())
      let current = this.currentRun()
      if (current !== null) { current!.delta = this.delta }
      this.compiledVbc2 = vbc2
      this.compiledSource = this.generatedSource.trim()
      this.refinePrompt = ''
      this.composerOpen = false
      // Only when the program first appears: yanking the pane away from
      // someone reading the source or the numbers is worse than leaving it.
      if (!hadProgram) { this.tab = TAB_PREVIEW }
      this.compiled = true
      this.compileErrors = ''
      this.modelWrote = true
      this.compositionJson = ''
      this.acceptRequest()
      this.status = 'Compiled successfully on attempt ' + this.attempt
      logMark('gen-compiled', 'attempt=' + this.attempt.toString())
      let endFields: Record<string, Object> = {}
      endFields['ok'] = true
      endFields['attempt'] = this.attempt
      endFields['totalMs'] = this.totalMs
      trace('gen-end', endFields)
      this.generating = false
      return
    }

    metrics.failLayer = layerOf(errors)
    metrics.failCode = codeOf(errors)
    this.attempts = [...this.attempts, metrics]
    this.addToProgram(metrics)
    this.compileErrors = errors
    if (this.attempt < MAX_RETRIES) {
      // runAttempt clears generatedSource on entry, so the broken text has to
      // be kept now if the next attempt is to see it.
      this.failedSource = this.generatedSource.trim()
      // A program cut off at the limit has no end to edit; anything else is
      // repaired by edits.
      this.repairByEdit = !(this.mode === MODE_DEEPSEEK && deepseek.lastFinishReason() === 'length')
      this.attempt++
      this.status = (metrics.failLayer === 'runtime' ? 'Stopped on its first run' : 'Compile failed') +
        ', retrying (attempt ' + this.attempt + '/' + MAX_RETRIES + ')...'
      await this.runAttempt(userPrompt, errors)
    } else {
      this.totalMs = Date.now() - this.genStartTime
      this.generating = false
      this.traceEnd('compile')
      if (!this.fallBackToTemplate('Logic step failed to compile after ' + MAX_RETRIES + ' attempts')) {
        this.status = (metrics.failLayer === 'runtime' ? 'Still stopping on its first run' : 'Compilation failed') +
          ' after ' + MAX_RETRIES + ' attempts'
      }
      this.finishMetrics(run)
    }
  }

  /**
   * The composed template a model completion started from, shown when the model cannot finish it for any reason (a request that
   * failed, an empty answer, edits that did not apply, a program that does not compile). False when there is no such template,
   * and the caller reports the failure as before.
   */
  private fallBackToTemplate(reason: string): boolean {
    if (this.completionBase.length === 0) { return false }
    this.generatedSource = this.completionBase
    this.compiledSource = this.completionBase
    this.compiledVbc2 = this.completionBaseVbc2
    this.compositionJson = this.completionComposition
    this.acceptRequest()
    this.compileErrors = ''
    this.compiled = true
    this.composerOpen = false
    this.tab = TAB_PREVIEW
    this.generating = false
    this.status = reason + '; showing the template without it'
    this.routeFallback = reason
    return true
  }

  /** The trace's closing event for a generation that ended without a program. */
  private traceEnd(failure: string): void {
    let fields: Record<string, Object> = {}
    fields['ok'] = false
    fields['attempt'] = this.attempt
    fields['failure'] = failure
    trace('gen-end', fields)
  }

  private addToProgram(metrics: AttemptMetrics): void {
    this.sideCalls = deepseek.getSideCalls()
    let record = this.currentRun()
    if (record !== null) {
      record!.attempts = [...record!.attempts, metrics]
      record!.compiled = metrics.success
      this.runs = [...this.runs]
    }
    let totals = new RunTotals()
    totals.runs = this.program.runs
    totals.attempts = this.program.attempts + 1
    totals.ms = this.program.ms + metrics.genMs + metrics.compileMs
    totals.llmMs = this.program.llmMs + metrics.genMs
    totals.compileMs = this.program.compileMs + metrics.compileMs
    totals.inputTokens = this.program.inputTokens + metrics.inputTokens
    totals.cacheHitTokens = this.program.cacheHitTokens + metrics.cacheHitTokens
    totals.outputTokens = this.program.outputTokens + metrics.outputTokens
    this.program = totals
  }

  private startRun(request: string): void {
    let record = new RunRecord()
    record.request = request
    this.runs = [...this.runs, record]
    this.startRunTotals()
  }

  private currentRun(): RunRecord | null {
    return this.runs.length > 0 ? this.runs[this.runs.length - 1] : null
  }

  private startRunTotals(): void {
    let totals = new RunTotals()
    totals.runs = this.program.runs + 1
    totals.attempts = this.program.attempts
    totals.ms = this.program.ms
    totals.llmMs = this.program.llmMs
    totals.compileMs = this.program.compileMs
    totals.inputTokens = this.program.inputTokens
    totals.cacheHitTokens = this.program.cacheHitTokens
    totals.outputTokens = this.program.outputTokens
    this.program = totals
  }

  /**
   * DeepSeek's published rates for deepseek-flash, per million tokens. Peak is
   * 01:00-04:00 and 06:00-10:00 UTC on weekdays and costs twice as much. The
   * price list lives on their side, so every figure here is an estimate.
   */
  private ratePerMillion(kind: string): number {
    let now = new Date()
    let day = now.getUTCDay()
    let hour = now.getUTCHours()
    let peak = day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10))
    if (kind === 'cache') { return peak ? 0.006 : 0.003 }
    if (kind === 'fresh') { return peak ? 0.30 : 0.15 }
    return peak ? 1.20 : 0.60
  }

  private costOf(input: number, cached: number, output: number): number {
    let fresh = input - cached
    if (fresh < 0) { fresh = 0 }
    return (cached * this.ratePerMillion('cache') +
      fresh * this.ratePerMillion('fresh') +
      output * this.ratePerMillion('output')) / 1000000
  }

  private runCost(): number {
    return this.costOf(this.totalInputTokens(), this.totalCacheHitTokens(), this.totalOutputTokens())
  }

  private formatUsd(value: number): string {
    if (value <= 0) { return '$0' }
    if (value < 0.0001) { return '$' + value.toFixed(5) }
    if (value < 0.01) { return '$' + value.toFixed(4) }
    return '$' + value.toFixed(3)
  }

  /**
   * Output tokens over everything after the prompt was read. Reasoning tokens
   * are billed as output and take real time, so dividing by the visible
   * stream alone would report rates the model never reached.
   */
  private formatRate(metrics: AttemptMetrics): string {
    let workMs = metrics.genMs - metrics.ttftMs
    if (workMs <= 0 || metrics.outputTokens === 0) { return '' }
    return ' (' + Math.round(metrics.outputTokens * 1000 / workMs) + ' tok/s)'
  }

  private attemptVerdict(a: AttemptMetrics): string {
    if (a.success) { return a.thinking ? '✓ think' : '✓' }
    if (a.failLayer === 'request') { return '✗ request failed' }
    if (a.failLayer === 'empty') { return '✗ empty answer' }
    let verdict = '✗ ' + a.failLayer
    if (a.failCode.length > 0) { verdict += ' ' + a.failCode }
    if (a.finishReason === 'length') { verdict += ' · cut off at the token limit' }
    return verdict
  }

  private freshInputTokens(): number {
    let fresh = this.totalInputTokens() - this.totalCacheHitTokens()
    return fresh > 0 ? fresh : 0
  }

  private cacheLabel(): string {
    let cached = this.totalCacheHitTokens()
    if (cached === 0) { return '' }
    let percent = Math.round(cached * 100 / this.totalInputTokens())
    return ' (cached ' + cached + ' · ' + percent + '%)'
  }

  // Money only where it is actually spent and known: llama runs on the phone,
  // and what the server pays for a generation is not ours to guess.
  private programCostLabel(): string {
    if (this.mode !== MODE_DEEPSEEK) { return '' }
    return ' · ~' + this.formatUsd(
      this.costOf(this.program.inputTokens, this.program.cacheHitTokens, this.program.outputTokens))
  }

  private runVerdict(): string {
    if (this.generating) { return 'running attempt ' + this.attempt }
    if (this.compiled) { return 'compiled on attempt ' + this.attempt }
    return 'failed after ' + this.attempts.length + ' attempts'
  }

  private cachePercentNote(): string {
    let cached = this.totalCacheHitTokens()
    if (cached === 0 || this.totalInputTokens() === 0) { return 'nothing reused' }
    return 'reused by DeepSeek, ' + Math.round(cached * 100 / this.totalInputTokens()) + '%'
  }

  private rateNote(a: AttemptMetrics): string {
    let workMs = a.genMs - a.ttftMs
    if (workMs <= 0 || a.outputTokens === 0) { return 'model time' }
    return Math.round(a.outputTokens * 1000 / workMs) + ' tok/s'
  }

  /** Everything except the run on screen, newest first. */
  private pastRuns(): RunRecord[] {
    let past: RunRecord[] = []
    for (let i = this.runs.length - 2; i >= 0; i--) { past.push(this.runs[i]) }
    return past
  }

  private indexOfRun(record: RunRecord): number {
    for (let i = 0; i < this.runs.length; i++) {
      if (this.runs[i] === record) { return i }
    }
    return 0
  }

  private runMs(record: RunRecord): number {
    let ms = 0
    for (let a of record.attempts) { ms += a.genMs + a.compileMs }
    return ms
  }

  private pastRunSummary(record: RunRecord): string {
    let summary = record.attempts.length + (record.attempts.length === 1 ? ' attempt · ' : ' attempts · ')
    summary += this.formatMs(this.runMs(record))
    if (this.mode === MODE_DEEPSEEK) {
      let input = 0
      let cached = 0
      let output = 0
      for (let a of record.attempts) {
        input += a.inputTokens
        cached += a.cacheHitTokens
        output += a.outputTokens
      }
      summary += ' · ~' + this.formatUsd(this.costOf(input, cached, output))
    }
    if (record.delta.measured) {
      summary += ' · +' + record.delta.added + ' −' + record.delta.removed + ' lines'
    }
    return summary
  }

  private programSpentLabel(): string {
    if (this.mode !== MODE_DEEPSEEK) { return this.formatMs(this.program.ms) }
    return '~' + this.formatUsd(
      this.costOf(this.program.inputTokens, this.program.cacheHitTokens, this.program.outputTokens))
  }

  private runHeadline(): string {
    let head = this.compiled
      ? 'compiled on attempt ' + this.attempt
      : (this.generating ? 'running' : 'failed after ' + this.attempts.length + ' attempts')
    head += ' · ' + this.formatMs(this.totalMs)
    if (this.mode === MODE_DEEPSEEK) { head += ' · ~' + this.formatUsd(this.runCost()) }
    return head
  }

  /** Wall time inside the model across this run, retries included. */
  private runLlmMs(): number {
    let ms = 0
    for (let a of this.attempts) { ms += a.genMs }
    return ms
  }

  private runCompileMs(): number {
    let ms = 0
    for (let a of this.attempts) { ms += a.compileMs }
    return ms
  }

  private writeMs(a: AttemptMetrics): number {
    let ms = a.genMs - a.ttftMs - a.thinkMs
    return ms > 0 ? ms : 0
  }

  /**
   * Over everything after the prompt was read. Reasoning tokens are billed as
   * output and take real time, so dividing by the writing phase alone would
   * report a speed the model never reached.
   */
  private speedLabel(a: AttemptMetrics): string {
    let workMs = a.genMs - a.ttftMs
    if (workMs <= 0 || a.outputTokens === 0) { return '—' }
    return Math.round(a.outputTokens * 1000 / workMs) + ' tok/s'
  }

  private attemptTiming(a: AttemptMetrics): string {
    let parts = a.ttftMs > 0 ? 'wait ' + this.formatMs(a.ttftMs) + ' · ' : ''
    if (a.thinkMs > 0) { parts += 'think ' + this.formatMs(a.thinkMs) + ' · ' }
    parts += 'gen ' + this.formatMs(a.genMs) + this.formatRate(a)
    if (a.compileMs > 0) { parts += ' · compile ' + this.formatMs(a.compileMs) }
    if (a.inputTokens > 0 || a.outputTokens > 0) {
      parts += ' · ' + a.inputTokens + '→' + a.outputTokens
    }
    return parts
  }

  private hasResult(): boolean {
    return this.compiledVbc2.length > 0 && this.compiledSource.length > 0
  }

  /**
   * Sends the change request together with the program currently on screen.
   * The existing refine path does the rest: previousSource goes over as the
   * assistant's own last turn, so the model edits that program instead of
   * writing a new one, and a failed attempt still gets the three compiler
   * retries.
   */
  private doRefine(): void {
    let ask = this.refinePrompt.trim()
    if (ask.length === 0 || this.compiledSource.length === 0 || this.generating || this.baseError.length > 0) { return }
    // A change that only adds, removes, replaces or moves a block of a composed screen is made on its
    // record, with no model rewrite; anything else, and any step that does not hold, refines as before.
    if (this.compositionJson.length > 0 && this.mode === MODE_DEEPSEEK && templateSelectEnabled() && settings.hasSelectorKey()) {
      this.tryStructuralEdit(ask)
      return
    }
    this.refineWithModel(ask)
  }

  private async tryStructuralEdit(ask: string): Promise<void> {
    let record: Composition | null = compositionFromJson(this.compositionJson)
    if (record === null) {
      this.compositionJson = ''
      this.refineWithModel(ask)
      return
    }
    this.prepareRequest(ask)
    this.generating = true
    this.cancelRequested = false
    let run = ++this.runId
    this.genStartTime = Date.now()
    this.metricTotals.partial = true
    this.status = 'Checking whether this changes the structure...'
    let result: EditResult = await this.metricWork(run, (): Promise<EditResult> => editComposition(ask, record!, this.mode,
      (request: string, c: Composition): Promise<CompositionEdit> => selectEdit(request, c, settings.getSelectorKey())))
    // Stop bumps runId too, and has already said Stopped.
    if (run !== this.runId) { return }
    this.lastTemplatePick = result.note
    if (!result.applied || result.composition === null) {
      this.refineWithModel(ask, true)
      return
    }
    this.startRun(ask)
    this.lastRequest = ask
    this.previousSource = this.compiledSource
    this.generatedSource = result.source
    this.compiledSource = result.source
    this.compiledVbc2 = result.vbc2
    this.compositionJson = compositionToJson(result.composition!)
    this.templateKinds = result.composition!.kinds()
    this.acceptRequest()
    this.compiled = true
    this.compileErrors = ''
    this.generating = false
    this.refinePrompt = ''
    this.totalMs = Date.now() - this.genStartTime
    this.status = 'Changed the structure: ' + result.note
  }

  private refineWithModel(ask: string, continuing: boolean = false): void {
    // Refine from the last program that compiled, not from generatedSource --
    // a failed attempt leaves its broken text in there.
    this.previousSource = this.compiledSource
    if (this.mode === MODE_SERVER) {
      if (!settings.hasServerUrl()) { this.checkServer(); return }
      this.doServerGenerate(ask)
      return
    }
    if (!continuing) { this.prepareRequest(ask) }
    this.completionBase = ''
    this.completionBaseVbc2 = ''
    this.completionComposition = ''
    this.generating = true
    this.compiled = false
    this.compileErrors = ''
    this.attempt = 1
    this.attempts = []
    this.totalMs = 0
    this.fastPathRan = false
    this.fastJevMs = 0
    this.fastSearchMs = -1
    this.fastContentMs = 0
    this.routeKnown = false
    this.routeVerifyMs = 0
    this.routeFallback = ''
    this.sideCalls = []
    this.serverBytecode = ''
    this.cancelRequested = false
    if (!continuing) { this.runId++ }
    this.failedSource = ''
    this.delta = new SourceDelta()
    this.startRun(ask)
    if (!continuing) { this.genStartTime = Date.now() }
    this.lastRequest = ask
    this.status = 'Refining (attempt 1/' + MAX_RETRIES + ')...'
    this.startAttemptOne(ask, 'Refining')
  }

  /** The open question goes with its default: stopping or starting again must not leave the agent waiting. */
  private settleQuestion(index: number | null): void {
    let answer = this.answerQuestion
    this.answerQuestion = null
    this.questionText = ''
    this.questionOptions = []
    if (answer !== null) { answer(index) }
  }

  /** Puts the agent's question on the screen; the promise settles with the person's tap. */
  private askPerson(question: AgentQuestion): Promise<number | null> {
    this.settleQuestion(null)
    return new Promise<number | null>((resolve: (index: number | null) => void) => {
      this.questionText = question.text
      this.questionOptions = question.options
      this.questionFallback = question.fallback
      this.answerQuestion = resolve
    })
  }

  private stopGeneration(): void {
    if (!this.generating) { return }
    this.metricTotals.partial = true
    this.finishMetrics(this.runId)
    if (this.metricPendingRuns.has(this.runId)) { this.metricStaleRuns.add(this.runId) }
    this.settleQuestion(null)
    this.cancelRequested = true
    this.runId++
    if (this.mode === MODE_LOCAL) { engine.stop() }
    if (this.mode === MODE_DEEPSEEK) { deepseek.stop() }
    this.generating = false
    this.totalMs = Date.now() - this.genStartTime
    this.status = 'Stopped'
  }

  private doSave(): void {
    if (this.generating || this.compiledSource.length === 0 || !this.hasResult()) { return }
    let note = this.acceptedRequest
    if (note.length > 100) { note = note.substring(0, 100) + '...' }
    store.createVersion(this.projectId, this.compiledSource, this.compiledVbc2, note,
      this.requestHistory, this.acceptedOrigin, this.acceptedComposition, this.acceptedRequest, this.baseVersionId,
      this.acceptedMetrics)
    this.status = 'Saved with compiled bytecode'
    refreshForms()
    this.getUIContext().getRouter().back()
  }

  /** The saved version's origin: the kinds of the composed screen it began as, "+model" when the model finished or rewrote it. */
  private originLabel(): string {
    let kinds = this.templateKinds.filter((k: string): boolean => k !== 'none')
    if (kinds.length === 0) { return '' }
    let label = kinds.join(',')
    if (this.modelWrote) { label = label + '+model' }
    return label
  }

  private formatMs(ms: number): string {
    if (ms < 1000) return ms + 'ms'
    let secs = (ms / 1000).toFixed(1)
    return secs + 's'
  }

  private modeLabel(): string {
    if (this.mode === MODE_DEEPSEEK) { return 'DeepSeek' }
    if (this.mode === MODE_SERVER) { return 'Server' }
    return 'Local'
  }

  private modeSubtitle(): string {
    if (this.mode === MODE_DEEPSEEK) { return settings.getModel() + ' - agent loop on device' }
    if (this.mode === MODE_SERVER) { return serverUrl() }
    return 'On-device Qwen3-Coder-3B'
  }

  private modeTint(): string {
    if (this.mode === MODE_DEEPSEEK) { return '#E8F5E9' }
    if (this.mode === MODE_SERVER) { return '#E3F2FD' }
    return '#FFF3E0'
  }

  private modeInk(): string {
    if (this.mode === MODE_DEEPSEEK) { return '#2E7D32' }
    if (this.mode === MODE_SERVER) { return '#1565C0' }
    return '#E65100'
  }

  private nextMode(): string {
    if (this.mode === MODE_DEEPSEEK) { return MODE_SERVER }
    if (this.mode === MODE_SERVER) { return MODE_LOCAL }
    return MODE_DEEPSEEK
  }

  private tabTint(name: string): string {
    return this.tab === name ? '#007DFF' : '#F0F0F0'
  }

  private tabInk(name: string): string {
    return this.tab === name ? '#FFFFFF' : '#666666'
  }

  private canGenerate(): boolean {
    if (this.baseError.length > 0) { return false }
    if (this.mode === MODE_SERVER) { return settings.hasServerUrl() }
    if (this.mode === MODE_DEEPSEEK) { return settings.hasApiKey() }
    return this.modelReady
  }

  private totalCacheHitTokens(): number {
    let total = 0
    for (let a of this.attempts) total += a.cacheHitTokens
    return total
  }

  private totalInputTokens(): number {
    let total = 0
    for (let a of this.attempts) total += a.inputTokens
    return total
  }

  private totalOutputTokens(): number {
    let total = 0
    for (let a of this.attempts) total += a.outputTokens
    return total
  }

  /** The small calls that belong to one stage of the run: '1' checking Jev, '2' filling in text, '3' before the program is written. */
  private sideCallsOf(stage: string): SideCall[] {
    let out: SideCall[] = []
    for (let call of this.sideCalls) {
      let own = call.purpose === 'Second opinion on a weak pick' ? '1' : (call.purpose === 'Pick the UI components' ? '3' : '2')
      if (own === stage) { out.push(call) }
    }
    return out
  }

  private sideInput(calls: SideCall[]): number { let n = 0; for (let c of calls) { n += c.inputTokens } return n }
  private sideCached(calls: SideCall[]): number { let n = 0; for (let c of calls) { n += c.cachedTokens } return n }
  private sideOutput(calls: SideCall[]): number { let n = 0; for (let c of calls) { n += c.outputTokens } return n }
  private sideMs(calls: SideCall[]): number { let n = 0; for (let c of calls) { n += c.ms } return n }
  private sideCost(calls: SideCall[]): number { return this.costOf(this.sideInput(calls), this.sideCached(calls), this.sideOutput(calls)) }

  /** One small call on one line: what it was for, how long it took, what it read and wrote, what it cost. */
  private callLine(call: SideCall): string {
    if (!call.ok) { return this.formatMs(call.ms) + ' \u00B7 failed' }
    return this.formatMs(call.ms) + ' \u00B7 ' + call.inputTokens + ' in' +
      (call.cachedTokens > 0 ? ' (' + call.cachedTokens + ' cached)' : '') + ' \u00B7 ' + call.outputTokens + ' out \u00B7 ~' +
      this.formatUsd(this.costOf(call.inputTokens, call.cachedTokens, call.outputTokens))
  }

  /** Colour of the route headline: blocks alone, blocks the model finishes, or a program written from scratch. */
  routeTone(): string {
    if (this.routeInfo.route === ROUTE_BLOCKS) { return '#1F9D4C' }
    if (this.routeInfo.route === ROUTE_BLOCKS_MODEL) { return '#C77700' }
    return '#4A5A80'
  }

  /** A numbered stage heading with a coloured bar, so the three parts of a run cannot be mistaken for one another. */
  @Builder
  stageHeader(num: string, title: string, who: string, color: string) {
    Column({ space: 4 }) {
      // The row is narrower than the pane: the pane's right edge slices whatever touches it.
      Row({ space: 8 }) {
        Text(num)
          .fontSize(12)
          .fontWeight(FontWeight.Bold)
          .fontColor('#FFFFFF')
          .backgroundColor(color)
          .borderRadius(10)
          .width(20)
          .height(20)
          .textAlign(TextAlign.Center)
        Text(title).fontSize(13).fontWeight(FontWeight.Bold).fontColor(color).layoutWeight(1).maxLines(1)
        Text(who)
          .fontSize(10)
          .fontColor(color)
          .maxLines(1)
          .border({ width: 1, color: color, radius: 6 })
          .padding({ left: 6, right: 6, top: 2, bottom: 2 })
      }
      .width('92%')
      Divider().strokeWidth(2).color(color)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding({ top: 6 })
  }

  /** One small model call as a card: its purpose, then time, tokens and cost. */
  @Builder
  callRow(call: SideCall) {
    Column({ space: 2 }) {
      Text(call.purpose).fontSize(12).fontWeight(FontWeight.Medium).fontColor('#222222')
      Text(this.callLine(call)).fontSize(11).fontColor(call.ok ? '#666666' : '#C62828')
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding(10)
    .backgroundColor('#FFFFFF')
    .borderRadius(8)
  }

  /**
   * One fact per tile: a label, the number, and a line saying what it means.
   * Values stay short by construction, which is also what keeps the pane from
   * running off the side of a phone.
   */
  @Builder
  cell(label: string, value: string, note: string) {
    // Two nodes on purpose: in ArkUI width() sizes the content and padding is
    // added outside it, so a padded node that is also given a width or a
    // layout weight ends up wider than its parent. The outer node owns the
    // width, the inner one owns the padding.
    Column() {
      Column({ space: 2 }) {
        Text(label).fontSize(10).fontColor('#888888').maxLines(1)
        Text(value).fontSize(17).fontWeight(FontWeight.Bold).fontColor('#222222')
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(note).fontSize(10).fontColor('#999999').maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .alignItems(HorizontalAlign.Start)
      .padding(10)
    }
    .layoutWeight(1)
    .alignItems(HorizontalAlign.Start)
    .backgroundColor('#FFFFFF')
    .borderRadius(8)
  }

  @Builder
  pastRun(record: RunRecord, index: number) {
    Column() {
      Column({ space: 4 }) {
        Row({ space: 8 }) {
          Text('#' + (index + 1) + (index === 0 ? ' generated' : ' refined'))
            .fontSize(11).fontColor('#888888')
          Text(record.compiled ? '✓' : '✗')
            .fontSize(11)
            .fontColor(record.compiled ? '#2E7D32' : '#C62828')
        }
        Text(record.request.length > 0 ? record.request : '(no request)')
          .fontSize(12).fontColor('#333333')
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(this.pastRunSummary(record))
          .fontSize(11).fontColor('#888888')
      }
      .alignItems(HorizontalAlign.Start)
      .padding(10)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .backgroundColor('#FFFFFF')
    .borderRadius(8)
  }

  build() {
    Navigation() {
      Column() {
        if (this.baseError.length > 0) {
          Text(this.baseError)
            .fontSize(13).fontColor('#C62828').padding({ left: 16, right: 16, top: 8 })
        } else if (this.baseVersionId.length > 0) {
          Text('Changes apply to version ' + this.baseVersionNumber.toString() +
            '. Save creates version ' + this.nextVersionNumber.toString() + '.')
            .fontSize(13).fontColor('#007DFF').padding({ left: 16, right: 16, top: 8 })
        }
        if (this.requestHistory.length > 0) {
          Column({ space: 4 }) {
            Text('Version request').fontSize(12).fontColor('#888888').width('100%')
            Scroll() {
              Text(this.requestHistory).fontSize(13).fontColor('#333333').width('100%')
                .copyOption(CopyOptions.LocalDevice)
            }
            .width('100%')
            .constraintSize({ maxHeight: 110 })
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 8 })
        }

        Row({ space: 8 }) {
          Button(this.modeLabel())
            .type(ButtonType.Normal)
            .fontSize(12)
            .height(30)
            .backgroundColor(this.modeTint())
            .fontColor(this.modeInk())
            .enabled(!this.generating)
            .onClick(() => {
              this.mode = this.nextMode()
              this.checkProvider()
            })
          Text(this.modeSubtitle())
            .fontSize(11).fontColor('#999999').layoutWeight(1)
        }
        .width('100%')
        .padding({ left: 16, right: 16, top: 8 })

        // With a running program on screen the original request collapses to a
        // single line, leaving the height to the preview. Tapping it reopens
        // the composer to start over from a new request.
        if (this.hasResult() && !this.composerOpen) {
          Row({ space: 8 }) {
            Text(this.acceptedRequest)
              .fontSize(12)
              .fontColor('#666666')
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .layoutWeight(1)
              .onClick(() => { this.composerOpen = true })
            Button('New')
              .type(ButtonType.Normal)
              .fontSize(11)
              .height(28)
              .backgroundColor('#F0F0F0')
              .fontColor('#666666')
              .enabled(!this.generating)
              .onClick(() => { this.startNew() })
            Button('Save')
              .type(ButtonType.Normal)
              .fontSize(11)
              .height(28)
              .enabled(!this.generating)
              .onClick(() => { this.doSave() })
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 8 })
        } else {
          TextArea({ placeholder: this.baseVersionId.length > 0 || this.hasResult() ? 'What to change?' : 'Describe the app you want...', text: this.prompt })
            .onChange((value: string) => { this.prompt = value })
            .enabled(!this.generating && this.baseError.length === 0)
            .width('100%')
            .height(100)
            .margin(16)

          Row({ space: 10 }) {
            Button(this.generating ? 'Stop' : (this.baseVersionId.length > 0 || this.hasResult() ? 'Refine' : 'Generate'))
              .type(ButtonType.Normal)
              .layoutWeight(1)
              .enabled(this.canGenerate() || this.generating)
              .onClick(() => {
                if (this.generating) {
                  this.stopGeneration()
                } else {
                  this.doGenerate()
                }
              })
            Button('Save')
              .type(ButtonType.Normal)
              .layoutWeight(1)
              .enabled(this.hasResult() && !this.generating)
              .onClick(() => { this.doSave() })
          }
          .width('100%')
          .padding({ left: 16, right: 16 })
        }

        Row({ space: 8 }) {
          Text(this.status)
            .fontSize(12)
            .fontColor(this.compiled ? '#34C759' : '#999999')
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
        }
        .width('100%')
        .padding({ left: 16, right: 16, top: 8, bottom: 4 })

        if (!this.generating && this.hasResult() && this.generatedSource.trim() !== this.compiledSource.trim()) {
          Text('The last attempt was not applied. Save keeps the previous successful code and version request.')
            .fontSize(12).fontColor('#B25000')
            .padding({ left: 16, right: 16, bottom: 4 })
        }

        if (this.routeKnown) {
          Column({ space: 2 }) {
            Text(routeLabel(this.routeInfo))
              .fontSize(13)
              .fontWeight(FontWeight.Bold)
              .fontColor(this.routeTone())
            Text(jevLabel(this.routeInfo) + '  \u00B7  ' + checkLabel(this.routeInfo))
              .fontSize(11)
              .fontColor('#555555')
              .maxLines(2)
            Text(routeWhy(this.routeInfo))
              .fontSize(11)
              .fontColor('#777777')
              .maxLines(4)
            if (this.routeFallback.length > 0) {
              Text('The model step failed (' + this.routeFallback + '), so the blocks are shown without it.')
                .fontSize(11)
                .fontColor('#B25000')
                .maxLines(3)
            }
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)
          .padding({ left: 16, right: 16, top: 0, bottom: 4 })
        }

        // Experiment only (experiment/jev-template-select branch): survives
        // the next status change and hilog's ring buffer getting
        // overwritten -- see ChatMessage.templatePick for the Chat-side
        // equivalent and why this exists.
        if (this.lastTemplatePick.length > 0) {
          Row({ space: 8 }) {
            Text('Jev: ' + this.lastTemplatePick)
              .fontSize(11)
              .fontColor('#8A6D00')
              .maxLines(3)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .width('100%')
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 0, bottom: 4 })
        }

        Row({ space: 6 }) {
          Button('Preview')
            .type(ButtonType.Normal)
            .fontSize(12)
            .height(30)
            .layoutWeight(1)
            .backgroundColor(this.tabTint(TAB_PREVIEW))
            .fontColor(this.tabInk(TAB_PREVIEW))
            .onClick(() => { this.tab = TAB_PREVIEW })
          Button('Code')
            .type(ButtonType.Normal)
            .fontSize(12)
            .height(30)
            .layoutWeight(1)
            .backgroundColor(this.tabTint(TAB_CODE))
            .fontColor(this.tabInk(TAB_CODE))
            .onClick(() => { this.tab = TAB_CODE })
          Button('Metrics')
            .type(ButtonType.Normal)
            .fontSize(12)
            .height(30)
            .layoutWeight(1)
            .backgroundColor(this.tabTint(TAB_METRICS))
            .fontColor(this.tabInk(TAB_METRICS))
            .onClick(() => { this.tab = TAB_METRICS })
        }
        .width('100%')
        .padding({ left: 16, right: 16, bottom: 6 })

        // Compile errors belong to no single pane -- they explain what the
        // status line says, so they stay above all three.
        if (this.compileErrors.length > 0) {
          Scroll() {
            Text(this.compileErrors)
              .fontSize(11)
              .fontFamily('monospace')
              .fontColor('#FF3B30')
              .width('100%')
              .padding(8)
          }
          .width('100%')
          .constraintSize({ maxHeight: 100 })
          .margin({ left: 16, right: 16 })
          .backgroundColor('#FFF0F0')
          .borderRadius(8)
        }

        if (this.mode === MODE_LOCAL && !this.modelReady && !this.generating) {
          Column() {
            Text('Model not downloaded').fontSize(14).fontWeight(FontWeight.Medium)
            Text('Switch to Local mode to download the model automatically (one-time, ~1.9GB over WiFi).')
              .fontSize(12).fontColor('#666666').margin({ top: 4 })
          }
          .width('100%')
          .padding(16)
          .backgroundColor('#FFF8E0')
          .margin({ left: 16, right: 16, top: 8 })
          .borderRadius(8)
        }

        if (this.tab === TAB_PREVIEW) {
          Column() {
            if (this.questionText.length > 0) {
              QuestionCard({ question: this.questionText, options: this.questionOptions, fallback: this.questionFallback,
                onPick: (index: number): void => { this.settleQuestion(index) } })
                .margin({ bottom: 8 })
            }
            if (this.hasResult()) {
              VeraPreview({ vbc2: this.compiledVbc2 })
            } else if (this.generating && this.previewVbc2.length > 0) {
              Text(this.previewNote)
                .fontSize(12)
                .fontColor('#8A6D00')
                .width('100%')
                .padding({ left: 12, right: 12, top: 6, bottom: 2 })
              VeraPreview({ previewOnly: true, vbc2: this.previewVbc2 })
            } else {
              Text(this.generating ? 'Building...' : 'The program will run here once it compiles')
                .fontSize(13)
                .fontColor('#BBBBBB')
                .padding(24)
            }
          }
          .width('100%')
          .layoutWeight(1)
          .margin({ left: 12, right: 12, top: 4 })
          .backgroundColor('#FFFFFF')
          .border({ width: 1, color: '#D8E1ED' })
          .borderRadius(10)
          .clip(true)
        } else if (this.tab === TAB_CODE) {
          Scroll() {
            Text(!this.generating && this.hasResult() ? this.compiledSource :
              (this.generatedSource.length > 0 ? this.generatedSource : '(generated source will appear here)'))
              .fontSize(12)
              .fontFamily('monospace')
              .fontColor(this.generatedSource.length > 0 ? '#333333' : '#CCCCCC')
              .width('100%')
              .padding(12)
          }
          .width('100%')
          .layoutWeight(1)
          .align(Alignment.Top)
          .margin({ left: 12, right: 12, top: 4 })
          .backgroundColor('#F5F7FA')
          .borderRadius(10)
        } else {
          Scroll() {
            Column({ space: 10 }) {
              if (this.routeKnown || this.attempts.length > 0) {
                // Totals first, then the three stages in the order they happen.
                Row({ space: 8 }) {
                  this.cell('Total time', this.formatMs(this.totalMs), 'the whole run')
                  if (this.mode === MODE_DEEPSEEK) {
                    this.cell('Total cost', '~' + this.formatUsd(this.runCost() + this.sideCost(this.sideCalls)), 'all model calls')
                  }
                }
                .width('100%')
              }
              if (this.routeKnown) {
                this.stageHeader('1', 'Choosing blocks', 'Jev', '#2F6FEB')
                Row({ space: 8 }) {
                  this.cell('Route', routeShort(this.routeInfo), jevLabel(this.routeInfo))
                  this.cell('Jev', this.formatMs(this.fastJevMs), 'classify + pick blocks')
                }
                .width('100%')
                Row({ space: 8 }) {
                  this.cell('Check', checkShort(this.routeInfo),
                    this.routeInfo.check === CHECK_NONE ? 'no second look needed' : checkLabel(this.routeInfo).replace('Check: ', ''))
                  if (this.fastSearchMs >= 0) {
                    this.cell('Search', this.formatMs(this.fastSearchMs), 'real-data lookup')
                  }
                }
                .width('100%')
                ForEach(this.sideCallsOf('1'), (call: SideCall) => { this.callRow(call) })
                Text(routeWhy(this.routeInfo)).fontSize(12).fontColor('#555555').width('92%')

                if (this.sideCallsOf('2').length > 0 || this.fastContentMs > 0) {
                  this.stageHeader('2', 'Model fills in text', 'DeepSeek \u00B7 text only', '#1F9D4C')
                  ForEach(this.sideCallsOf('2'), (call: SideCall) => { this.callRow(call) })
                  Row({ space: 8 }) {
                    this.cell('Stage time', this.formatMs(this.sideMs(this.sideCallsOf('2'))), 'text for the blocks')
                    this.cell('Stage cost', '~' + this.formatUsd(this.sideCost(this.sideCallsOf('2'))),
                      this.sideInput(this.sideCallsOf('2')) + ' in \u00B7 ' + this.sideOutput(this.sideCallsOf('2')) + ' out')
                  }
                  .width('100%')
                }
              }
              if (this.attempts.length === 0 && !this.fastPathRan) {
                Text('No run yet').fontSize(13).fontColor('#BBBBBB').width('100%')
              } else if (this.attempts.length > 0) {
                this.stageHeader(this.routeKnown ? '3' : '1', 'Model writes the program', 'DeepSeek', '#C77700')
                ForEach(this.sideCallsOf('3'), (call: SideCall) => { this.callRow(call) })
                // Two tiles per row: a right-aligned column inside a full-width row kept landing
                // past the edge, and this needs no special case.
                Row({ space: 8 }) {
                  this.cell('Writing', this.formatMs(this.runLlmMs()), this.runVerdict())
                  if (this.mode === MODE_DEEPSEEK) {
                    this.cell('Stage cost', '~' + this.formatUsd(this.runCost()), 'incl. failed attempts')
                  }
                }
                .width('100%')

                // Where the writing time went: waiting on the model, or working on the phone.
                Row({ space: 8 }) {
                  this.cell('On device', this.formatMs(this.runCompileMs()), 'compiler only')
                }
                .width('100%')

                if (this.delta.measured) {
                  Row({ space: 8 }) {
                    this.cell('Changed', '+' + this.delta.added + ' −' + this.delta.removed + ' lines',
                      'against the previous version')
                    this.cell('Kept', this.delta.keptPercent + '%', 'of the previous lines')
                  }
                  .width('100%')
                }

                if (this.mode !== MODE_SERVER) {
                  Row({ space: 8 }) {
                    this.cell('Input', this.totalInputTokens() + ' toks', 'rules, request, old code')
                    this.cell('Cached', this.totalCacheHitTokens() + ' toks', this.cachePercentNote())
                  }
                  .width('100%')
                  Row({ space: 8 }) {
                    this.cell('Fresh', this.freshInputTokens() + ' toks', 'input at full price')
                    this.cell('Output', this.totalOutputTokens() + ' toks', 'program and reasoning')
                  }
                  .width('100%')
                }

                ForEach(this.attempts, (a: AttemptMetrics) => {
                  Column() {
                  Column({ space: 8 }) {
                    Row({ space: 8 }) {
                      Text('#' + a.attempt).fontSize(13).fontWeight(FontWeight.Bold)
                      Text(this.attemptVerdict(a))
                        .fontSize(11)
                        .fontColor(a.success ? '#2E7D32' : '#C62828')
                        .backgroundColor(a.success ? '#E8F8E8' : '#FFECEC')
                        .padding({ left: 8, right: 8, top: 3, bottom: 3 })
                        .borderRadius(6)
                        .maxLines(2)
                    }
                    .width('100%')
                    // Three disjoint phases of one model call, then the
                    // compiler. They add up to the run time, which the old
                    // layout implied but did not deliver.
                    Row({ space: 8 }) {
                      this.cell('Wait', a.ttftMs > 0 ? this.formatMs(a.ttftMs) : '—', 'until first token')
                      if (a.thinkMs > 0) {
                        this.cell('Think', this.formatMs(a.thinkMs), 'reasoning')
                      }
                      this.cell('Write', this.formatMs(this.writeMs(a)), 'streaming code')
                    }
                    .width('100%')
                    .alignItems(VerticalAlign.Top)
                    Row({ space: 8 }) {
                      this.cell('Compile', a.compileMs > 0 ? this.formatMs(a.compileMs) : '—', 'on device')
                      this.cell('Speed', this.speedLabel(a), 'output after the wait')
                    }
                    .width('100%')
                    .alignItems(VerticalAlign.Top)
                  }
                  .width('100%')
                  .padding(12)
                  }
                  .width('100%')
                  .backgroundColor('#FFFFFF')
                  .borderRadius(10)
                })

                if (this.program.runs > 1) {
                  Row({ space: 8 }) {
                    this.cell('Runs', this.program.runs + '', 'generation and refines')
                    this.cell('Spent', this.programSpentLabel(),
                      this.program.attempts + ' model calls in all')
                  }
                  .width('100%')

                  Row({ space: 8 }) {
                    this.cell('LLM wall', this.formatMs(this.program.llmMs), 'whole program')
                    this.cell('On device', this.formatMs(this.program.compileMs), 'whole program')
                  }
                  .width('100%')

                  Text('Earlier runs').fontSize(11).fontColor('#888888').width('100%')
                  ForEach(this.pastRuns(), (record: RunRecord) => {
                    this.pastRun(record, this.indexOfRun(record))
                  })
                }
              }
            }
            .width('100%')
            .alignItems(HorizontalAlign.Start)
          }
          .width('100%')
          .layoutWeight(1)
          .align(Alignment.Top)
          // The bar is drawn over the content, and the rightmost tile in every
          // row ends up sliced by it.
          .scrollBar(BarState.Off)
          // Vertical only: a percentage width resolves against the parent's
          // whole box, so any horizontal padding here pushes every card past
          // the right edge.
          .padding({ top: 12, bottom: 12 })
          .margin({ left: 12, right: 12, top: 4 })
          .backgroundColor('#F5F7FA')
          .borderRadius(10)
        }

        // Pinned under whichever pane is open: reading the source is exactly
        // when you want to ask for a change, so the bar does not belong to the
        // preview alone.
        if (this.hasResult()) {
          Row({ space: 8 }) {
            TextInput({ placeholder: 'What to change?', text: this.refinePrompt })
              .onChange((value: string) => { this.refinePrompt = value })
              .layoutWeight(1)
              .height(44)
              .enabled(!this.generating)
            Button(this.generating ? 'Stop' : 'Update')
              .type(ButtonType.Normal)
              .width(92)
              .height(44)
              .enabled(this.generating || (this.refinePrompt.trim().length > 0 && this.canGenerate()))
              .onClick(() => {
                if (this.generating) {
                  this.stopGeneration()
                } else {
                  this.doRefine()
                }
              })
          }
          .width('100%')
          .padding({ left: 12, right: 12, top: 8, bottom: 12 })
          .backgroundColor('#F7F9FC')
        }
      }
      .width('100%')
      .height('100%')
    }
    .title(this.baseVersionId.length > 0 ? 'Refine · Version ' + this.nextVersionNumber.toString() : 'Generate')
    .titleMode(NavigationTitleMode.Mini)
  }
}
