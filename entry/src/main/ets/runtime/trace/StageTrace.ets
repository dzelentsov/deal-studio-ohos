import { hilog } from '@kit.PerformanceAnalysisKit'
import { systemDateTime } from '@kit.BasicServicesKit'

type StateLifecycleRole = 'MAIN' | 'ACTOR' | 'FORM'
type StateLifecycleEvent = 'CREATE' | 'FOREGROUND' | 'BG_BEGIN' | 'BG_GRANT' | 'BG_EXPIRED' |
  'BG_CANCEL' | 'BG_TIMER_FAILED' | 'BG_SETTLED' | 'CHECKPOINT_BEGIN' | 'CHECKPOINT_END' | 'READ_BEGIN' | 'READ_END' |
  'FORM_ADD' | 'FORM_UPDATE' | 'FORM_EVENT' | 'FORM_REMOVE'
type StateLifecycleOutcome = 'NONE' | 'GRANTED' | 'REFUSED' | 'UNAVAILABLE' | 'INVALID' | 'CALLBACK' |
  'TIMER' | 'CANCELLED' | 'FAILED' | 'HOST_RESOLVED' | 'HOST_REJECTED' | 'COMMITTED' | 'FENCED_COMMIT' |
  'STALE_REVISION' | 'STALE' | 'COMMIT_UNCERTAIN' | 'NOT_DUE' | 'REJECTED' | 'READY' | 'ABSENT' | 'LOST'

export class StateLifecycleDiag {
  private static epoch: number = 0
  private static sequence: number = 0
  private static operations: number = 0

  static now(): number {
    try {
      const value = systemDateTime.getUptime(systemDateTime.TimeType.STARTUP)
      return StateLifecycleDiag.numeric(value)
    } catch (_) { return 0 }
  }

  static elapsed(start: number): number {
    try {
      const end = StateLifecycleDiag.now()
      return start > 0 && end >= start ? StateLifecycleDiag.numeric(end - start) : 0
    } catch (_) { return 0 }
  }

  static operation(): number {
    try { return ++StateLifecycleDiag.operations } catch (_) { return 0 }
  }

  private static numeric(value: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
  }

  private static category(value: string, allowed: string): string {
    return allowed.split('|').indexOf(value) >= 0 ? value : 'OTHER'
  }

  static emit(role: StateLifecycleRole, event: StateLifecycleEvent, operation: number = 0,
    outcome: StateLifecycleOutcome = 'NONE', durationMs: number = 0, foregroundReturned?: boolean,
    matchingStamp?: boolean, expirationObserved?: boolean): void {
    try {
      if (StateLifecycleDiag.epoch === 0) { StateLifecycleDiag.epoch = StateLifecycleDiag.numeric(Date.now()) }
      hilog.info(0, 'VERA-STATE-DIAG', '%{public}s', JSON.stringify({
        epoch: StateLifecycleDiag.epoch, seq: ++StateLifecycleDiag.sequence, atMs: StateLifecycleDiag.now(),
        role: StateLifecycleDiag.category(role, 'MAIN|ACTOR|FORM'),
        event: StateLifecycleDiag.category(event, 'CREATE|FOREGROUND|BG_BEGIN|BG_GRANT|BG_EXPIRED|BG_CANCEL|BG_TIMER_FAILED|BG_SETTLED|CHECKPOINT_BEGIN|CHECKPOINT_END|READ_BEGIN|READ_END|FORM_ADD|FORM_UPDATE|FORM_EVENT|FORM_REMOVE'),
        operation: StateLifecycleDiag.numeric(operation),
        outcome: StateLifecycleDiag.category(outcome, 'NONE|GRANTED|REFUSED|UNAVAILABLE|INVALID|CALLBACK|TIMER|CANCELLED|FAILED|HOST_RESOLVED|HOST_REJECTED|COMMITTED|FENCED_COMMIT|STALE_REVISION|STALE|COMMIT_UNCERTAIN|NOT_DUE|REJECTED|READY|ABSENT|LOST'),
        durationMs: StateLifecycleDiag.numeric(durationMs),
        foregroundReturned: typeof foregroundReturned === 'boolean' ? foregroundReturned : undefined,
        matchingStamp: typeof matchingStamp === 'boolean' ? matchingStamp : undefined,
        expirationObserved: typeof expirationObserved === 'boolean' ? expirationObserved : undefined
      }))
    } catch (_) {}
  }
}

export interface StageDiagnosticAttributes {
  generation?: number
  baseRevision?: number
  revision?: number
  dirtyAgeMs?: number
  durationMs?: number
  steps?: number
  records?: number
  reservations?: number
  rollbacks?: number
  transientFailures?: number
  reloadAttempts?: number
  payloadBytes?: number
  commitsPerSecond?: number
  p95DurationMs?: number
  sampleCount?: number
  windowMs?: number
  stage?: string
  commitClass?: string
  turnSource?: string
  format?: string
  loadSource?: string
  outcome?: string
  entryCategory?: string
  operation?: string
  safety?: boolean
  dirty?: boolean
}

export interface StageTraceAttributes extends StageDiagnosticAttributes {
  entry?: string
  kind?: string
  action?: string
  digest?: string
  treeHash?: string
  result?: string
  id?: number
  rawTarget?: string
  rawMode?: string
  generation?: number
  params?: string
  resultHandler?: string
  outcome?: string
  reason?: string
  tickerId?: string
  class?: string
  nodeId?: number
  actions?: string[]
  draws?: string[]
  save?: string
  reveal?: boolean
  changed?: boolean
}

export interface StageTraceRecord {
  session: number
  event: string
  at: number
  attributes: StageTraceAttributes
}

export class StageTrace {
  private static active: boolean = false
  private static sessions: WeakMap<Object, number> = new WeakMap<Object, number>()
  private static effectOwners: WeakMap<Object, Object> = new WeakMap<Object, Object>()
  private static nextSession: number = 0
  private static sink: ((record: StageTraceRecord) => void) | null = null

  static configure(enabled: boolean, sink?: (record: StageTraceRecord) => void): void {
    StageTrace.active = enabled
    StageTrace.sessions = new WeakMap<Object, number>()
    StageTrace.effectOwners = new WeakMap<Object, Object>()
    StageTrace.nextSession = 0
    StageTrace.sink = sink === undefined ? null : sink
  }

  static enabled(): boolean {
    return StageTrace.active
  }

  static associateEffectOwner(request: Object, owner: Object): void {
    if (!StageTrace.active) { return }
    StageTrace.effectOwners.set(request, owner)
  }

  static effectOwner(request: Object): Object | undefined {
    if (!StageTrace.active) { return undefined }
    return StageTrace.effectOwners.get(request)
  }

  private static copyAttributes(source: StageTraceAttributes): StageTraceAttributes {
    const copy: StageTraceAttributes = {}
    if (source.entry !== undefined) { copy.entry = source.entry }
    if (source.kind !== undefined) { copy.kind = source.kind }
    if (source.action !== undefined) { copy.action = source.action }
    if (source.digest !== undefined) { copy.digest = source.digest }
    if (source.treeHash !== undefined) { copy.treeHash = source.treeHash }
    if (source.result !== undefined) { copy.result = source.result }
    if (source.id !== undefined) { copy.id = source.id }
    if (source.rawTarget !== undefined) { copy.rawTarget = source.rawTarget }
    if (source.rawMode !== undefined) { copy.rawMode = source.rawMode }
    if (source.generation !== undefined) { copy.generation = source.generation }
    if (source.params !== undefined) { copy.params = source.params }
    if (source.resultHandler !== undefined) { copy.resultHandler = source.resultHandler }
    if (source.outcome !== undefined) { copy.outcome = source.outcome }
    if (source.reason !== undefined) { copy.reason = source.reason }
    if (source.tickerId !== undefined) { copy.tickerId = source.tickerId }
    if (source.class !== undefined) { copy.class = source.class }
    if (source.nodeId !== undefined) { copy.nodeId = source.nodeId }
    if (source.actions !== undefined) { copy.actions = source.actions.slice() }
    if (source.draws !== undefined) { copy.draws = source.draws.slice() }
    if (source.save !== undefined) { copy.save = source.save }
    if (source.reveal !== undefined) { copy.reveal = source.reveal }
    if (source.changed !== undefined) { copy.changed = source.changed }
    return copy
  }

  static emit(owner: Object, event: string, attributes: StageTraceAttributes = {}): void {
    if (!StageTrace.active) { return }
    try {
      const copy = StageTrace.copyAttributes(attributes)
      if (copy.tickerId !== undefined) { copy.tickerId = StageTrace.digest(copy.tickerId) }
      StageTrace.write(owner, event, copy)
    } catch (_) {}
  }

  private static write(owner: Object, event: string, attributes: StageTraceAttributes): void {
    try {
      let session = StageTrace.sessions.get(owner)
      if (session === undefined) {
        session = ++StageTrace.nextSession
        StageTrace.sessions.set(owner, session)
      }
      const record: StageTraceRecord = { session: session, event: event, at: Date.now(), attributes: attributes }
      if (StageTrace.sink !== null) {
        StageTrace.sink(record)
      } else {
        console.info('VERA-STAGE-TRACE ' + JSON.stringify(record))
      }
    } catch (_) {}
  }

  private static category(value: string | undefined, allowed: string): string | undefined {
    if (value === undefined) { return undefined }
    return allowed.split('|').indexOf(value) >= 0 ? value : 'OTHER'
  }

  private static numeric(value: number | undefined): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  }

  private static diagnosticAttributes(source: StageDiagnosticAttributes): StageTraceAttributes {
    const copy: StageTraceAttributes = {
      generation: StageTrace.numeric(source.generation), baseRevision: StageTrace.numeric(source.baseRevision),
      revision: StageTrace.numeric(source.revision), dirtyAgeMs: StageTrace.numeric(source.dirtyAgeMs),
      durationMs: StageTrace.numeric(source.durationMs), steps: StageTrace.numeric(source.steps),
      records: StageTrace.numeric(source.records), reservations: StageTrace.numeric(source.reservations),
      rollbacks: StageTrace.numeric(source.rollbacks), transientFailures: StageTrace.numeric(source.transientFailures),
      reloadAttempts: StageTrace.numeric(source.reloadAttempts), payloadBytes: StageTrace.numeric(source.payloadBytes),
      commitsPerSecond: StageTrace.numeric(source.commitsPerSecond), p95DurationMs: StageTrace.numeric(source.p95DurationMs),
      sampleCount: StageTrace.numeric(source.sampleCount), windowMs: StageTrace.numeric(source.windowMs),
      stage: StageTrace.category(source.stage, 'load|commit|publication|serialize|payload-size|safety-off|turn-refusal|guard-begin|guard-accept|guard-rollback|guard-discard|final-stale|resume-header|reload-attempts|initialization|IMMEDIATE|THROTTLED|PERIODIC|BACKGROUND|FINAL|STALE_REVISION|APP_RESUME|commit-result|result-correlation|commit-confirmation|snapshot-reread|payload-canonical|payload-utf8|commit-request|publication-request|lock|main-write|main-sync|main-rename|main-directory-sync|backup|FAILED|WRITTEN|SKIPPED|ABSENT|STAMP_MISMATCH|LOST'),
      commitClass: StageTrace.category(source.commitClass, 'IMMEDIATE|THROTTLED|VOLATILE'),
      turnSource: StageTrace.category(source.turnSource, 'INIT|CARRY|INPUT|EFFECT_RESULT|TICK|SURFACE|MOVE'),
      format: StageTrace.category(source.format, 'FORMAT2|LEGACY'),
      loadSource: StageTrace.category(source.loadSource, 'MAIN|BAK'),
      outcome: StageTrace.category(source.outcome, 'READY|ABSENT|LOST|UNAVAILABLE|IN_MEMORY|COMMITTED|FAILED|SKIPPED|WRITTEN|STALE|STALE_REVISION|FENCED_COMMIT|COMMIT_UNCERTAIN|OK|TRAP|BUDGET|JOURNAL|PURE|ACCEPT|ROLLBACK|DISCARD|OVERFLOW|CLEAN|INIT_EQUAL|ENTER|EXIT'),
      entryCategory: StageTrace.category(source.entryCategory, 'INIT|VIEW|WIDGET|DRAW|BUILD_SCENE|HANDLER'),
      operation: StageTrace.category(source.operation, 'HOST|STORAGE|CELL|ARRAY|OBJECT|CLEANUP'),
      safety: typeof source.safety === 'boolean' ? source.safety : undefined,
      dirty: typeof source.dirty === 'boolean' ? source.dirty : undefined
    }
    return JSON.parse(JSON.stringify(copy)) as StageTraceAttributes
  }

  static diagnostic(owner: Object, event: string, attributes: StageDiagnosticAttributes = {}): void {
    const allowed = 'STATE_LOAD|STATE_COMMIT_BEGIN|STATE_COMMIT_OK|STATE_COMMIT_FAIL|STATE_RECOVERY|STATE_BACKUP|STATE_LOCK_WAIT|STATE_DIRTY|STATE_CHECKPOINT|STATE_DIRTY_DISCARDED|STATE_DEGRADED|STATE_RELOAD_PENDING|STATE_EFFECT_COMMIT_RATE|VM_EXECUTE|VM_JOURNAL|VM_PURE_VIOLATION|VM_ROLLBACK_SKIPPED|VM_SAFETY_SWITCH|STATE_VALIDATION_FAILED|STATE_SERIALIZATION_FAILED|STATE_WRITE_FAILED|STATE_SYNC_FAILED|STATE_PUBLISH_FAILED|STATE_CORRUPTED|STATE_RECOVERY_FAILED|STATE_UNAVAILABLE|STATE_LOST|STATE_LOCK_UNAVAILABLE|STATE_COMMIT_UNCERTAIN|STATE_READ_FAILED|STATE_HASH_FAILED|STATE_TASK_SUBMIT_FAILED|STATE_REVISION_CONFLICT|STATE_GENERATION_MISMATCH|STATE_MUTATION_REFUSED|STATE_INITIALIZATION_REFUSED|STATE_ROLLBACK_FAILED|STATE_RECREATE_REQUIRED|STATE_DURABLE_CALLBACK_FAILED'
    if (!StageTrace.active) { return }
    try {
      StageTrace.write(owner, allowed.split('|').indexOf(event) >= 0 ? event : 'DIAGNOSTIC_OTHER',
        StageTrace.diagnosticAttributes(attributes))
    } catch (_) {}
  }

  static digest(text: string): string {
    let first = 2166136261
    let second = 5381
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      first = Math.imul(first ^ code, 16777619)
      second = Math.imul(second, 33) ^ code
    }
    return (first >>> 0).toString(16).padStart(8, '0') + (second >>> 0).toString(16).padStart(8, '0')
  }

  static snapshot(owner: Object, encoded: string): void {
    if (!StageTrace.active) { return }
    try {
      StageTrace.emit(owner, 'SNAPSHOT', { digest: StageTrace.digest(encoded) })
    } catch (_) {}
  }

  static frame(owner: Object, root: Object | null, reveal: boolean): void {
    if (!StageTrace.active) { return }
    try {
      StageTrace.emit(owner, 'FRAME', { treeHash: StageTrace.digest(JSON.stringify(root)), reveal: reveal })
    } catch (_) {}
  }

  static request(owner: Object, id: number, rawTarget: string, values: Map<string, string>, resultHandler: string,
    rawMode: string = '', generation: number = 0): void {
    if (!StageTrace.active) { return }
    try {
      const params: string[][] = []
      values.forEach((value: string, key: string): void => { params.push([key, value]) })
      StageTrace.emit(owner, 'EFFECT_REQUEST', { id: id, rawTarget: StageTrace.digest(rawTarget),
        params: StageTrace.digest(JSON.stringify(params)), resultHandler: resultHandler,
        rawMode: StageTrace.digest(rawMode), generation: generation })
    } catch (_) {}
  }
}
