import { cryptoFramework } from '@kit.CryptoArchitectureKit'
import type { RuntimeValue } from '../vera/VeraInterpreter'
import type { RuntimeMode } from './shared/Messages'
import { CommitPolicy } from './CommitPolicy'
import type { CommitClass, StateTurnSource, StateSaveReason } from './CommitPolicy'
import type {
  LoadResult, CommitResult, CommittedResult, CommitTaskRequest,
  CommitTaskResult, PublishGenerationRequest, StateHeader, StateErrorCode
} from './StateIo'
import {
  encodeStateFile, decodeStateFile, assembleStateFile, validateStateFile,
  statePayloadBytes, statePayloadHash
} from './StateFormat'
import type {
  StatePort, StateSnapshot, StateTransaction, StateRollbackGuard, StateRollbackScope,
  StateStoragePort, StateStorageFactory, StateLostRecoveryAuthority, StateAcceptanceResult, StateLoadResult,
  StateReloadReason, StateCheckpointReason, StateManagerPhase, StateManagerStatus,
  StateDiagnostic, StateDiagnosticMetrics, ReloadResult, StateRecreateReason, StateRecreateRequiredResult, UnchangedStateResult
} from './shared/StatePort'

export interface StateManagerOptions {
  appId: string
  stamp: string
  mode: RuntimeMode
  stateMaxBytes: number
  initialState: RuntimeValue
  storage?: StateStoragePort
  storageFactory?: StateStorageFactory
  lostRecoveryAuthority?: StateLostRecoveryAuthority
  rollbackGuard?: StateRollbackGuard
  vmJournal?: boolean
  journalMode?: 'JOURNAL'
  vmGeneration?: number
  policy?: CommitPolicy
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  diagnostic?: (event: StateDiagnostic) => void
  diagnosticEnabled?: () => boolean
  durable?: () => void
}

export class StateManagerError extends Error {
  readonly code: string
  readonly stage: string
  constructor(code: string, stage: string) {
    super(code + ' at ' + stage)
    this.code = code
    this.stage = stage
  }
}

class ManagedStateTransaction implements StateTransaction {
  readonly id: number
  readonly commitClass: CommitClass
  readonly source: StateTurnSource
  hasEffects: boolean = false
  possibleMutation: boolean = true
  rootReplaced: boolean = false
  settling: boolean = false
  readonly originalRoot: RuntimeValue
  readonly originalDirty: boolean
  scope: StateRollbackScope | null = null
  constructor(id: number, commitClass: CommitClass, source: StateTurnSource,
      root: RuntimeValue, dirty: boolean) {
    this.id = id
    this.commitClass = commitClass
    this.source = source
    this.originalRoot = root
    this.originalDirty = dirty
  }
}

interface StateSaveCapture {
  encoded: string
  seq: number
}

interface EffectCommitSample {
  at: number
  duration: number
}

function validCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER
}

function failed(code: StateErrorCode, stage: string): CommitResult {
  return { status: 'FAILED', code: code, stage: stage }
}

function snapshotDigest(encoded: string): string {
  try {
    let digest = cryptoFramework.createMd('SHA256')
    digest.updateSync({ data: statePayloadBytes(encoded) })
    let hex = ''
    for (let byte of digest.digestSync().data) { hex += byte.toString(16).padStart(2, '0') }
    return 'sha256:' + hex
  } catch (error) {
    throw error as Error
  }
}

export class StateManager implements StatePort {
  private readonly appId: string
  private readonly stamp: string
  private mode: RuntimeMode
  private readonly stateMaxBytes: number
  private readonly policy: CommitPolicy
  private readonly safety: boolean
  private readonly guard: StateRollbackGuard | undefined
  private readonly factory: StateStorageFactory | undefined
  private readonly lostRecoveryAuthority: StateLostRecoveryAuthority | undefined
  private lostRecoveryPending: boolean = false
  private readonly clock: () => number
  private readonly sleeper: (ms: number) => Promise<void>
  private readonly diagnostic: ((event: StateDiagnostic) => void) | undefined
  private readonly diagnosticEnabled: (() => boolean) | undefined
  private diagnosticEmitting: boolean = false
  private readonly durable: (() => void) | undefined
  private storage: StateStoragePort | null
  private working: RuntimeValue
  private snapshot: StateSnapshot | null = null
  private phase: StateManagerPhase = 'NEW'
  private invalidated: boolean = false
  private generation: number
  private revision: number = 0
  private loadedGeneration: number = 0
  private loaded: LoadResult | null = null
  private published: boolean = false
  private dirty: boolean = false
  private dirtySeq: number = 0
  private dirtySince: number = 0
  private memoryAccepted: boolean = false
  private memoryAcceptedSince: number = 0
  private effectWindows: Map<StateTurnSource, EffectCommitSample[]> =
    new Map<StateTurnSource, EffectCommitSample[]>()
  private lastCommit: number = 0
  private lastProbe: number = 0
  private lastBackupAt: number = 0
  private commitsSinceBackup: number = 0
  private transientFailures: number = 0
  private needsReload: boolean = false
  private reloadAttempts: number = 0
  private reopenRequired: boolean = false
  private active: ManagedStateTransaction | null = null
  private sequence: number = 0
  private tail: Promise<void> = Promise.resolve()
  private pending: number = 0
  private exclusive: number = 0
  private idleWaiters: Array<() => void> = []
  private closing: boolean = false
  private closePromise: Promise<void> | null = null
  private blockedPayloadSeq: number = -1
  private promotionPending: boolean = false
  private captureInFlight: boolean = false

  constructor(options: StateManagerOptions) {
    if (typeof options.appId !== 'string' || options.appId.length === 0 ||
        /[\u0000-\u001f\\]/.test(options.appId) ||
        (options.mode === 'LIVE_PERSISTENT' && (options.appId.split('/').length !== 2 ||
          options.appId.split('/').some((part: string) => part.length === 0 || part === '.' || part === '..'))) ||
        typeof options.stamp !== 'string' || options.stamp.indexOf('\u0000') >= 0 ||
        !Number.isSafeInteger(options.stateMaxBytes) || options.stateMaxBytes <= 0 ||
        options.stateMaxBytes >= 16 * 1024 * 1024 ||
        ['PREVIEW', 'LIVE_EPHEMERAL', 'LIVE_PERSISTENT'].indexOf(options.mode) < 0 ||
        (options.journalMode !== undefined && options.journalMode !== 'JOURNAL') ||
        (options.vmGeneration !== undefined && !validCounter(options.vmGeneration))) {
      throw new StateManagerError('STATE_VALIDATION_FAILED', 'options')
    }
    this.safety = options.vmJournal !== false
    if (this.safety && (!options.rollbackGuard ||
        options.rollbackGuard.coverage !== 'GRAPH_SLOTS_DEFERRED_INTENTS')) {
      throw new StateManagerError('STATE_ROLLBACK_GUARD_REQUIRED', 'options')
    }
    if (options.mode === 'LIVE_PERSISTENT' && !options.storage && !options.storageFactory) {
      throw new StateManagerError('STATE_STORAGE_REQUIRED', 'options')
    }
    this.appId = options.appId
    this.stamp = options.stamp
    this.mode = options.mode
    this.stateMaxBytes = options.stateMaxBytes
    this.working = options.initialState
    this.generation = options.vmGeneration === undefined ? 0 : options.vmGeneration
    this.policy = options.policy === undefined ? new CommitPolicy() : options.policy
    this.guard = options.rollbackGuard
    this.factory = options.storageFactory
    this.lostRecoveryAuthority = options.lostRecoveryAuthority
    this.storage = options.storage === undefined ? null : options.storage
    let clock = options.now
    this.clock = (): number => {
      try {
        let now = clock === undefined ? Date.now() : clock()
        if (Number.isFinite(now) && now >= 0) { return now }
      } catch (_error) {}
      return Date.now()
    }
    this.sleeper = options.sleep === undefined ? (ms: number): Promise<void> =>
      new Promise<void>((resolve: () => void) => { setTimeout(resolve, ms) }) : options.sleep
    this.diagnostic = options.diagnostic
    this.diagnosticEnabled = options.diagnosticEnabled
    this.durable = options.durable
  }

  private resetStorageHealth(stage: string): void {
    let degraded = this.phase === 'DEGRADED' || this.transientFailures >= this.policy.degradedAfter
    this.transientFailures = 0
    if (degraded) { this.emit('STATE_DEGRADED', stage, { outcome: 'EXIT' }) }
  }

  private markDurable(): void {
    try { this.durable?.() } catch (_error) { this.emit('STATE_DURABLE_CALLBACK_FAILED', 'publication') }
  }

  status(): StateManagerStatus {
    return {
      mode: this.mode, phase: this.phase, vmGeneration: this.generation,
      baseRevision: this.revision, dirty: this.dirty, dirtySeq: this.dirtySeq,
      dirtySince: this.dirtySince, needsReload: this.needsReload,
      transientFailures: this.transientFailures, reloadAttempts: this.reloadAttempts,
      pendingOperations: this.pending
    }
  }

  private diagnosticsActive(): boolean {
    if (!this.diagnostic || this.diagnosticEmitting) { return false }
    this.diagnosticEmitting = true
    try { return this.diagnosticEnabled === undefined || this.diagnosticEnabled() === true }
    catch (_error) { return false }
    finally { this.diagnosticEmitting = false }
  }

  private emit(code: string, stage: string, metrics: StateDiagnosticMetrics = {}): void {
    if (!this.diagnosticsActive()) { return }
    this.diagnosticEmitting = true
    try {
      let event: StateDiagnostic = {
        code: code, appId: this.appId,
        vmGeneration: metrics.vmGeneration === undefined ? this.generation : metrics.vmGeneration,
        baseRevision: metrics.baseRevision === undefined ? this.revision : metrics.baseRevision, stage: stage,
        dirtyAgeMs: this.dirty ? Math.max(0, this.clock() - this.dirtySince) :
          this.memoryAccepted ? Math.max(0, this.clock() - this.memoryAcceptedSince) : 0,
        revision: metrics.revision, durationMs: metrics.durationMs,
        commitClass: metrics.commitClass, turnSource: metrics.turnSource,
        format: metrics.format, loadSource: metrics.loadSource, outcome: metrics.outcome,
        dirty: this.dirty, transientFailures: this.transientFailures, reloadAttempts: this.reloadAttempts,
        payloadBytes: metrics.payloadBytes, commitsPerSecond: metrics.commitsPerSecond,
        p95DurationMs: metrics.p95DurationMs, sampleCount: metrics.sampleCount, windowMs: metrics.windowMs
      }
      this.diagnostic?.(event)
    } catch (_error) {}
    finally { this.diagnosticEmitting = false }
  }

  private emitLockWait(stage: string, durationMs: number | undefined, outcome: string): void {
    if (durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0) {
      this.emit('STATE_LOCK_WAIT', stage, { durationMs: durationMs, outcome: outcome })
    }
  }

  private assertOutsideDiagnostic(): void {
    if (this.diagnosticEmitting) { throw new StateManagerError('STATE_TURN_PENDING', 'diagnostic') }
  }

  private isFaulted(): boolean { return this.invalidated }

  private isTerminal(): boolean { return this.isFaulted() || this.phase === 'CLOSED' }

  private assertLive(): void {
    this.assertOutsideDiagnostic()
    if (this.isFaulted() || this.phase === 'CLOSED') {
      throw new StateManagerError('STATE_UNAVAILABLE', this.phase)
    }
  }

  private assertReady(): void {
    this.assertLive()
    if (this.lostRecoveryPending) { throw new StateManagerError('STATE_NOT_READY', 'lost-recovery') }
    if (this.needsReload) { throw new StateManagerError('STATE_RELOAD_PENDING', 'admission') }
    if (this.phase !== 'READY' && this.phase !== 'DEGRADED') {
      throw new StateManagerError('STATE_NOT_READY', 'admission')
    }
    if (this.mode === 'LIVE_PERSISTENT' && !this.published) {
      throw new StateManagerError('STATE_GENERATION_PENDING', 'admission')
    }
  }

  private notifyIdle(): void {
    if (this.pending !== 0 || this.active !== null) { return }
    let waiters = this.idleWaiters
    this.idleWaiters = []
    for (let resolve of waiters) { resolve() }
  }

  private enqueue<T>(kind: string, work: () => Promise<T>): Promise<T> {
    this.assertOutsideDiagnostic()
    if (this.closing && kind !== 'CLOSE') { throw new StateManagerError('STATE_UNAVAILABLE', 'closing') }
    this.pending++
    if (kind !== 'CHECKPOINT' && kind !== 'FINAL') { this.exclusive++ }
    let result = this.tail.then(async (): Promise<T> => {
      try {
        if (kind !== 'CLOSE' && kind !== 'FAULT_DRAIN' && kind !== 'IMMEDIATE') { this.assertLive() }
        return await work()
      } finally {
        if (this.isFaulted() && this.storage !== null) {
          try { await this.storage.close() } catch (_error) {}
        }
        this.captureInFlight = false
        this.pending--
        if (kind !== 'CHECKPOINT' && kind !== 'FINAL') { this.exclusive-- }
        this.notifyIdle()
      }
    })
    this.tail = result.then(() => {}, () => {})
    return result
  }

  async whenIdle(): Promise<void> {
    while (this.pending !== 0 || this.active !== null) {
      await new Promise<void>((resolve: () => void) => { this.idleWaiters.push(resolve) })
    }
  }

  async awaitReadyForImmediate(): Promise<void> {
    await this.whenIdle()
    this.assertReady()
    if (this.phase === 'DEGRADED') { throw new StateManagerError('STATE_DEGRADED', 'admission') }
  }

  private io(): StateStoragePort {
    this.assertLive()
    if (this.storage === null) {
      if (!this.factory) { throw new StateManagerError('STATE_STORAGE_REQUIRED', 'storage') }
      this.storage = this.factory.create()
    }
    return this.storage
  }

  private async reopen(): Promise<void> {
    this.assertLive()
    if (!this.reopenRequired) { return }
    if (!this.factory) { throw new StateManagerError('STATE_STORAGE_FACTORY_REQUIRED', 'reload') }
    if (this.storage !== null) {
      await this.storage.close()
      this.assertLive()
      await this.storage.whenIdle()
    }
    this.assertLive()
    this.storage = this.factory.create()
    this.reopenRequired = false
  }

  private nextId(): string {
    if (!validCounter(this.sequence + 1)) { throw new StateManagerError('STATE_CORRUPTED', 'operation-capacity') }
    return this.appId + ':' + (++this.sequence)
  }

  private encode(): string {
    let text = encodeStateFile({
      appId: this.appId, schemaVersion: 1, vmGeneration: this.generation,
      revision: this.revision, stamp: this.stamp
    }, this.working)
    return validateStateFile(text, this.appId).encodedState
  }

  private decode(encoded: string, generation: number, revision: number): RuntimeValue {
    return decodeStateFile(assembleStateFile({
      appId: this.appId, schemaVersion: 1, vmGeneration: generation,
      revision: revision, stamp: this.stamp
    }, encoded), this.appId).value
  }

  private makeSnapshot(encoded: string, generation: number, revision: number): StateSnapshot {
    return {
      identity: { appId: this.appId, stamp: this.stamp },
      version: { vmGeneration: generation, revision: revision },
      encoded: encoded, digest: snapshotDigest(encoded)
    }
  }

  committedSnapshot(): StateSnapshot | null {
    let current = this.snapshot
    if (current === null) { return null }
    return {
      identity: { appId: current.identity.appId, stamp: current.identity.stamp },
      version: { vmGeneration: current.version.vmGeneration, revision: current.version.revision },
      encoded: current.encoded, digest: current.digest
    }
  }

  captureWorkingSnapshot(): string {
    this.assertReady()
    if (this.active !== null || this.exclusive !== 0) {
      throw new StateManagerError('STATE_TURN_PENDING', 'snapshot')
    }
    let encoded = this.encode()
    if (statePayloadBytes(encoded).byteLength > this.stateMaxBytes) {
      throw new StateManagerError('STATE_VALIDATION_FAILED', 'payload-size')
    }
    return encoded
  }

  load(preserveWorkingState: boolean = false): Promise<StateLoadResult> {
    this.assertLive()
    if (this.active !== null || this.pending !== 0 || this.phase !== 'NEW') {
      throw new StateManagerError('STATE_TURN_PENDING', 'load')
    }
    this.phase = 'STARTING'
    return this.enqueue<StateLoadResult>('LOAD', async (): Promise<StateLoadResult> => {
      if (this.mode !== 'LIVE_PERSISTENT') {
        this.phase = 'READY'
        this.emit('STATE_LOAD', 'load', { outcome: 'IN_MEMORY' })
        return { kind: 'IN_MEMORY' }
      }
      return this.loadDisk(preserveWorkingState, !preserveWorkingState)
    })
  }

  private async loadDisk(preserve: boolean, initial: boolean = false): Promise<LoadResult> {
    let result: LoadResult
    let started = this.clock()
    try {
      await this.reopen()
      result = await this.io().load(this.appId, this.stamp)
    } catch (_error) {
      result = { kind: 'UNAVAILABLE', code: 'STATE_READ_FAILED', stage: 'load' }
    }
    this.emitLockWait('load', result.lockWaitMs, result.kind)
    this.emit('STATE_LOAD', 'load', { outcome: result.kind, format: result.format,
      vmGeneration: result.header?.vmGeneration, loadSource: result.source,
      baseRevision: result.header?.revision, revision: result.header?.revision,
      durationMs: Math.max(0, this.clock() - started) })
    if (this.isTerminal()) {
      return { kind: 'UNAVAILABLE', code: 'STATE_UNAVAILABLE', stage: 'load-invalidated' }
    }
    if (result.kind === 'LOST' && initial && !preserve && this.lostRecoveryAuthority !== undefined &&
        this.io().recoverLost !== undefined) {
      return this.recoverInitialLost()
    }
    return this.installLoad(result, preserve)
  }

  private installLoad(result: LoadResult, preserve: boolean): LoadResult {
    if (this.isTerminal()) {
      return { kind: 'UNAVAILABLE', code: 'STATE_UNAVAILABLE', stage: 'load-invalidated' }
    }
    if (result.kind === 'LOST') {
      this.loaded = this.copyLoad(result)
      this.snapshot = null
      this.fault('STATE_LOST', 'recovery-reset-unavailable')
      return result
    }
    if (result.kind === 'UNAVAILABLE') {
      if (result.code === 'STATE_COMMIT_UNCERTAIN') { this.fault('STATE_COMMIT_UNCERTAIN', 'load') }
      else {
        this.needsReload = true
        this.phase = 'RELOAD_PENDING'
        this.emit('STATE_RELOAD_PENDING', result.stage === undefined ? 'load' : result.stage)
      }
      return result
    }
    try {
      let generation = result.header === undefined ? 0 : result.header.vmGeneration
      let revision = result.header === undefined ? 0 : result.header.revision
      if (!validCounter(generation) || !validCounter(revision) ||
          (result.kind === 'READY' && (result.stamp === undefined ||
            (result.format !== 'LEGACY' && result.format !== 'FORMAT2') ||
            (result.format === 'FORMAT2' && (!result.header || result.header.appId !== this.appId))))) {
        throw new StateManagerError('STATE_CORRUPTED', 'load-metadata')
      }
      let snapshot: StateSnapshot | null = null
      let root = this.working
      if (result.kind === 'READY' && result.stamp === this.stamp) {
        if (result.encodedState === undefined) { throw new StateManagerError('STATE_CORRUPTED', 'load-payload') }
        let decoded = this.decode(result.encodedState, generation, revision)
        snapshot = this.makeSnapshot(result.encodedState, generation, revision)
        if (!preserve) { root = decoded }
      }
      this.assertLive()
      this.loaded = this.copyLoad(result)
      this.loadedGeneration = generation
      this.revision = revision
      this.snapshot = snapshot
      this.working = root
      this.needsReload = false
      this.reloadAttempts = 0
      this.resetStorageHealth('load')
      this.published = false
      this.phase = 'STARTING'
      if (result.source === 'BAK' || result.recovered) {
        this.emit('STATE_RECOVERY', 'load', { outcome: result.kind, format: result.format,
          loadSource: result.source, revision: revision })
      }
      return this.copyLoad(result)
    } catch (_error) {
      this.fault('STATE_CORRUPTED', 'load-decode')
      return { kind: 'UNAVAILABLE', code: 'STATE_CORRUPTED', stage: 'load-decode' }
    }
  }

  private async recoverInitialLost(): Promise<LoadResult> {
    let authority = this.lostRecoveryAuthority as StateLostRecoveryAuthority
    let storage = this.io()
    let active = true
    let called = false
    let finished = false
    let work: Promise<void> | null = null
    let outcome: LoadResult | null = null
    this.lostRecoveryPending = true
    try {
      await authority.withExclusiveDrained(this.appId, (): Promise<void> => {
        if (!active || called) {
          this.fault('STATE_COMMIT_UNCERTAIN', 'lost-authority-callback')
          return Promise.reject(new StateManagerError('STATE_COMMIT_UNCERTAIN', 'lost-authority-callback'))
        }
        called = true
        work = (async (): Promise<void> => {
          try {
            if (storage.recoverLost === undefined) {
              throw new StateManagerError('STATE_RECOVERY_FAILED', 'lost-capability')
            }
            let recovered = await storage.recoverLost(this.appId, this.stamp)
            this.emitLockWait('recoverLost', recovered.lockWaitMs, recovered.kind)
            if (!active || this.isFaulted()) {
              throw new StateManagerError('STATE_COMMIT_UNCERTAIN', 'lost-authority-incomplete')
            }
            if (recovered.kind !== 'ABSENT' && recovered.kind !== 'READY') {
              throw new StateManagerError('STATE_RECOVERY_FAILED', 'lost-reset')
            }
            let installed = this.installLoad(recovered, false)
            if (installed.kind !== 'ABSENT' && installed.kind !== 'READY' || this.isFaulted()) {
              throw new StateManagerError('STATE_RECOVERY_FAILED', 'lost-install')
            }
            if (installed.kind === 'READY') { outcome = installed; return }
            let publication = await this.publish()
            if (!active || this.isFaulted() || publication.status !== 'UNCHANGED' ||
                this.generation !== 1 || this.revision !== 0) {
              throw new StateManagerError('STATE_RECOVERY_FAILED', 'lost-publication')
            }
            this.markDirty()
            let committed = await this.save('IMMEDIATE', null)
            if (!active || this.isFaulted() || committed === null || committed.status !== 'COMMITTED' ||
                committed.revision !== 1 || this.snapshot === null || this.loaded === null ||
                this.generation !== 1 || this.status().baseRevision !== 1) {
              throw new StateManagerError('STATE_COMMIT_UNCERTAIN', 'lost-initial-commit')
            }
            outcome = this.copyLoad(this.loaded)
          } finally { finished = true }
        })()
        return work
      })
      if (!called || !finished || outcome === null || this.isFaulted()) {
        throw new StateManagerError('STATE_COMMIT_UNCERTAIN', 'lost-authority-incomplete')
      }
    } catch (_error) {
      this.fault('STATE_COMMIT_UNCERTAIN', 'lost-recovery')
      outcome = null
    } finally {
      active = false
      if (work !== null) {
        try { await work } catch (_error) {}
      }
      this.lostRecoveryPending = false
    }
    if (outcome === null || this.isFaulted()) {
      this.snapshot = null
      return { kind: 'UNAVAILABLE', code: 'STATE_COMMIT_UNCERTAIN', stage: 'lost-recovery' }
    }
    return outcome
  }

  private copyLoad(result: LoadResult): LoadResult {
    let header = result.header
    let copy: LoadResult = {
      kind: result.kind, format: result.format, source: result.source, stamp: result.stamp,
      encodedState: result.encodedState, matchingStamp: result.matchingStamp,
      code: result.code, stage: result.stage, recovered: result.recovered, lockWaitMs: result.lockWaitMs
    }
    if (header !== undefined) {
      copy.header = {
        format: header.format, appId: header.appId, schemaVersion: header.schemaVersion,
        vmGeneration: header.vmGeneration, revision: header.revision,
        payloadLength: header.payloadLength, payloadHash: header.payloadHash
      }
    }
    return copy
  }

  publishGeneration(next?: number): Promise<StateAcceptanceResult> {
    this.assertLive()
    if (this.active !== null || this.pending !== 0 || this.needsReload) {
      throw new StateManagerError('STATE_TURN_PENDING', 'publication')
    }
    return this.enqueue<StateAcceptanceResult>('PUBLICATION', () => this.publish(next))
  }

  private unchanged(reason: 'CLEAN' | 'INIT_EQUAL' | 'ABSENT'): UnchangedStateResult {
    return { status: 'UNCHANGED', vmGeneration: this.generation, revision: this.revision, reason: reason }
  }

  private async publish(next?: number): Promise<StateAcceptanceResult> {
    if (this.isTerminal()) { return failed('STATE_UNAVAILABLE', 'publication-invalidated') }
    if (this.mode !== 'LIVE_PERSISTENT') { return this.unchanged('CLEAN') }
    if (!this.loaded) { throw new StateManagerError('STATE_NOT_READY', 'publication') }
    if (this.published && next === undefined) { return this.unchanged('CLEAN') }
    if (this.loaded.kind === 'ABSENT') {
      if (next !== undefined && next !== 1) {
        this.fault('STATE_CORRUPTED', 'absent-generation')
        return failed('STATE_CORRUPTED', 'absent-generation')
      }
      this.generation = 1
      this.loadedGeneration = 0
      this.revision = 0
      this.published = true
      this.phase = 'READY'
      return this.unchanged('ABSENT')
    }
    let generation = Math.max(this.generation, this.loadedGeneration) + 1
    if (next !== undefined && next !== generation || !validCounter(generation)) {
      this.fault('STATE_CORRUPTED', 'generation-capacity')
      return failed('STATE_CORRUPTED', 'generation-capacity')
    }
    this.phase = 'STARTING'
    let started = this.clock()
    let waited = 0
    while (true) {
      if (this.isTerminal()) { return failed('STATE_UNAVAILABLE', 'publication-invalidated') }
      let request: PublishGenerationRequest = {
        operationId: this.nextId(), appId: this.appId, nextVmGeneration: generation,
        expectedSource: this.loaded.format === 'LEGACY' ? 'LEGACY' : this.loaded.source as 'MAIN' | 'BAK',
        expectedRevision: this.revision, expectedStamp: this.loaded.stamp as string
      }
      let result = await this.submitPublication(request)
      this.emitLockWait('publication', result.lockWaitMs, result.status)
      if (result.status === 'COMMITTED' || result.status === 'COMMIT_UNCERTAIN') { this.markDurable() }
      if (this.isTerminal()) { return failed('STATE_UNAVAILABLE', 'publication-invalidated') }
      if (result.status === 'COMMITTED') {
        this.generation = generation
        this.loadedGeneration = generation
        this.published = true
        this.loaded.format = 'FORMAT2'
        this.loaded.source = 'MAIN'
        if (this.loaded.header !== undefined) { this.loaded.header.vmGeneration = generation }
        if (this.snapshot !== null) {
          this.snapshot = {
            identity: { appId: this.appId, stamp: this.stamp },
            version: { vmGeneration: generation, revision: this.revision },
            encoded: this.snapshot.encoded, digest: this.snapshot.digest
          }
        }
        this.phase = 'READY'
        return result
      }
      if (result.status !== 'STALE') {
        if (result.status === 'STALE_REVISION') { this.reopenRequired = true }
        this.fault(result.status, 'publication')
        return result
      }
      let elapsed = Math.max(this.clock() - started, waited)
      if (elapsed >= this.policy.publishGenerationDeadlineMs) {
        this.fault('STATE_LOCK_UNAVAILABLE', 'publication-deadline')
        return result
      }
      let delay = Math.min(Math.max(1, this.policy.publishRetryMs), this.policy.publishGenerationDeadlineMs - elapsed)
      try { await this.sleeper(delay) }
      catch (_error) {
        this.fault('STATE_LOCK_UNAVAILABLE', 'publication-timer')
        return failed('STATE_LOCK_UNAVAILABLE', 'publication-timer')
      }
      waited += delay
    }
  }

  private async submitPublication(request: PublishGenerationRequest): Promise<CommitResult> {
    try { return this.correlate(await this.io().publishGeneration(request), request.operationId, this.revision) }
    catch (_error) { return { status: 'COMMIT_UNCERTAIN', code: 'STATE_COMMIT_UNCERTAIN', stage: 'publication-result' } }
  }

  beginTurn(commitClass: CommitClass, source: StateTurnSource = 'INPUT'): StateTransaction {
    this.assertReady()
    if (source === 'INIT' || source === 'CARRY' || source === 'EFFECT_RESULT') { commitClass = 'IMMEDIATE' }
    if (this.closing || ['IMMEDIATE', 'THROTTLED', 'VOLATILE'].indexOf(commitClass) < 0 ||
        ['INIT', 'CARRY', 'INPUT', 'EFFECT_RESULT', 'TICK', 'SURFACE', 'MOVE'].indexOf(source) < 0 ||
        this.active !== null || this.exclusive !== 0 ||
        (this.pending !== 0 && (this.pending !== 1 || !this.captureInFlight)) ||
        (commitClass === 'IMMEDIATE' && this.pending !== 0)) {
      throw new StateManagerError('STATE_TURN_PENDING', 'begin')
    }
    if (this.mode === 'PREVIEW' && source !== 'INIT' && source !== 'CARRY') {
      throw new StateManagerError('STATE_PREVIEW_SUPPRESSED', 'begin')
    }
    if (commitClass === 'IMMEDIATE' && this.phase === 'DEGRADED') {
      throw new StateManagerError('STATE_DEGRADED', 'begin')
    }
    this.nextId()
    let tx = new ManagedStateTransaction(this.sequence, commitClass, source, this.working, this.dirty)
    this.active = tx
    try {
      if (this.safety) { tx.scope = (this.guard as StateRollbackGuard).beginTurn(tx, this.working) }
      return tx
    } catch (_error) {
      this.active = null
      this.fault('STATE_ROLLBACK_FAILED', 'guard-begin')
      this.notifyIdle()
      throw new StateManagerError('STATE_ROLLBACK_FAILED', 'guard-begin')
    }
  }

  private transaction(tx: StateTransaction): ManagedStateTransaction {
    this.assertOutsideDiagnostic()
    if (this.active === null || this.active !== tx || this.active.settling) {
      throw new StateManagerError('STATE_TRANSACTION_INVALID', 'turn')
    }
    return this.active
  }

  getWorkingState(): RuntimeValue { return this.working }

  setWorkingState(tx: StateTransaction, value: RuntimeValue): void {
    let turn = this.transaction(tx)
    this.assertReady()
    turn.possibleMutation = true
    if (this.working !== value) { turn.rootReplaced = true }
    this.working = value
  }

  markEffects(tx: StateTransaction): void {
    let turn = this.transaction(tx)
    if (this.mode === 'PREVIEW') { throw new StateManagerError('STATE_PREVIEW_SUPPRESSED', 'effects') }
    turn.hasEffects = true
  }

  proveNoMutation(tx: StateTransaction): void {
    let turn = this.transaction(tx)
    if (turn.rootReplaced || this.working !== turn.originalRoot) {
      throw new StateManagerError('STATE_MUTATION_POSSIBLE', 'proof')
    }
    turn.possibleMutation = false
  }

  rollbackTurn(tx: StateTransaction): void {
    let turn = this.transaction(tx)
    if (this.isFaulted()) { this.abandonTurn(turn); return }
    this.refuseTurn(turn, this.needsReload)
  }

  private finishTurn(tx: ManagedStateTransaction): void {
    this.active = null
    try { if (tx.scope !== null) { tx.scope.accept() } }
    catch (_error) { this.fault('STATE_ROLLBACK_FAILED', 'guard-accept'); throw new StateManagerError('STATE_ROLLBACK_FAILED', 'guard-accept') }
    finally { this.notifyIdle() }
  }

  private refuseTurn(tx: ManagedStateTransaction, stale: boolean): void {
    try {
      if (this.safety) {
        if (tx.scope === null) { throw new StateManagerError('STATE_ROLLBACK_FAILED', 'guard-missing') }
        tx.scope.rollback()
        this.working = tx.originalRoot
      } else {
        this.emit('VM_ROLLBACK_SKIPPED', 'turn-refusal')
        if (tx.possibleMutation && !stale) { this.fault('STATE_MUTATION_REFUSED', 'safety-off') }
      }
    } catch (_error) {
      this.fault('STATE_ROLLBACK_FAILED', 'guard-rollback')
    } finally {
      tx.hasEffects = false
      this.active = null
      this.notifyIdle()
    }
    if ((tx.source === 'INIT' || tx.source === 'CARRY') && this.published && !stale) {
      this.fault('STATE_INITIALIZATION_REFUSED', 'initialization')
    }
  }

  private abandonTurn(tx: ManagedStateTransaction): void {
    tx.hasEffects = false
    this.active = null
    try { if (tx.scope !== null) { tx.scope.discard() } }
    catch (_error) { this.emit('STATE_ROLLBACK_FAILED', 'guard-discard') }
    this.notifyIdle()
  }

  private markDirty(): void {
    if (!validCounter(this.dirtySeq + 1)) { this.fault('STATE_CORRUPTED', 'dirty-capacity'); throw new StateManagerError('STATE_CORRUPTED', 'dirty-capacity') }
    if (!this.dirty) { this.dirtySince = this.clock() }
    this.dirty = true
    this.dirtySeq++
    this.emit('STATE_DIRTY', 'commit')
  }

  async commitTurn(tx: StateTransaction): Promise<StateAcceptanceResult> {
    let turn = this.transaction(tx)
    if (this.isFaulted() || this.needsReload) {
      if (this.isFaulted()) { this.abandonTurn(turn) }
      else {
        this.refuseTurn(turn, true)
        if (!this.isFaulted()) { await this.reloadAfterExternalWrite('STALE_REVISION') }
      }
      return failed('STATE_UNAVAILABLE', 'turn-base-invalid')
    }
    this.assertReady()
    let effective: CommitClass
    try { effective = this.policy.effective(turn.commitClass, turn.hasEffects) }
    catch (error) {
      this.refuseTurn(turn, false)
      throw error instanceof Error ? error : new StateManagerError('STATE_VALIDATION_FAILED', 'turn-policy')
    }
    turn.settling = true
    if (this.mode !== 'LIVE_PERSISTENT') {
      this.finishTurn(turn)
      if (this.mode === 'LIVE_EPHEMERAL' && turn.possibleMutation) {
        if (!this.memoryAccepted) { this.memoryAcceptedSince = this.clock() }
        this.memoryAccepted = true
      }
      return { status: 'IN_MEMORY', vmGeneration: this.generation, revision: 0 }
    }
    if (effective !== 'IMMEDIATE') {
      try { this.markDirty() }
      catch (error) {
        this.abandonTurn(turn)
        throw error instanceof Error ? error : new StateManagerError('STATE_CORRUPTED', 'dirty-capacity')
      }
      this.finishTurn(turn)
      if (effective === 'THROTTLED' && this.pending === 0 &&
          this.policy.throttledDue(this.clock(), this.lastCommit)) {
        let result = await this.enqueue<CommitResult | null>('CHECKPOINT', () => this.save('THROTTLED', null))
        if (result !== null) { return result }
      }
      return { status: 'IN_MEMORY', vmGeneration: this.generation, revision: this.revision }
    }
    return this.enqueue<StateAcceptanceResult>('IMMEDIATE', async (): Promise<StateAcceptanceResult> => {
      if (this.isFaulted() || this.needsReload) {
        if (this.isFaulted()) { this.abandonTurn(turn) }
        else {
          this.refuseTurn(turn, true)
          if (!this.isFaulted()) { await this.reload('STALE_REVISION') }
        }
        return failed('STATE_UNAVAILABLE', 'promotion-base-invalid')
      }
      if (this.phase === 'DEGRADED') {
        this.refuseTurn(turn, false)
        return failed('STATE_LOCK_UNAVAILABLE', 'degraded-promotion')
      }
      if ((turn.source === 'INIT' || turn.source === 'CARRY') && !turn.hasEffects &&
          !turn.originalDirty && this.snapshot !== null) {
        let equal = false
        try {
          let encoded = this.encode()
          equal = statePayloadBytes(encoded).byteLength <= this.stateMaxBytes &&
            snapshotDigest(encoded) === this.snapshot.digest && encoded === this.snapshot.encoded
        } catch (_error) {}
        if (equal) {
          this.finishTurn(turn)
          return this.unchanged('INIT_EQUAL')
        }
      }
      let result = await this.save('IMMEDIATE', turn)
      return result === null ? this.unchanged('CLEAN') : result
    })
  }

  private correlate(reply: CommitTaskResult, id: string, revision: number): CommitResult {
    if (!reply || reply.operationId !== id || !reply.result ||
        ['COMMITTED', 'STALE', 'STALE_REVISION', 'FENCED_COMMIT', 'COMMIT_UNCERTAIN', 'FAILED']
          .indexOf(reply.result.status) < 0 ||
        (reply.result.status === 'COMMITTED' && (!validCounter(reply.result.revision) ||
          reply.result.revision !== revision || ['WRITTEN', 'SKIPPED', 'FAILED'].indexOf(reply.result.backup) < 0))) {
      return { status: 'COMMIT_UNCERTAIN', code: 'STATE_COMMIT_UNCERTAIN', stage: 'result-correlation' }
    }
    return reply.result
  }

  private async save(reason: StateSaveReason, turn: ManagedStateTransaction | null): Promise<CommitResult | null> {
    if (turn !== null || reason === 'THROTTLED') { return this.saveMeasured(reason, turn) }
    let started = this.clock()
    this.emit('STATE_CHECKPOINT', reason, { outcome: 'ENTER' })
    try {
      let result = await this.saveMeasured(reason, turn)
      this.emit('STATE_CHECKPOINT', reason, { outcome: result === null ? this.dirty ? 'SKIPPED' : 'CLEAN' : result.status,
        durationMs: Math.max(0, this.clock() - started) })
      return result
    } catch (error) {
      this.emit('STATE_CHECKPOINT', reason, { outcome: 'FAILED', durationMs: Math.max(0, this.clock() - started) })
      throw error as Error
    }
  }

  private async saveMeasured(reason: StateSaveReason, turn: ManagedStateTransaction | null): Promise<CommitResult | null> {
    if (turn === null && this.active !== null) {
      throw new StateManagerError('STATE_TURN_PENDING', 'save-capture')
    }
    if (this.isTerminal() || this.needsReload || !this.published) {
      return failed('STATE_UNAVAILABLE', 'save-blocked')
    }
    if (turn === null && (!this.dirty || this.blockedPayloadSeq === this.dirtySeq)) { return null }
    let started = this.clock()
    let baseRevision = this.revision
    let commitClass: CommitClass = reason === 'THROTTLED' ? 'THROTTLED' : 'IMMEDIATE'
    this.emit('STATE_COMMIT_BEGIN', reason, { revision: this.revision + 1,
      commitClass: commitClass, turnSource: turn?.source })
    if (!validCounter(this.revision + 1)) {
      this.fault('STATE_CORRUPTED', 'revision-capacity')
      if (turn !== null) { this.abandonTurn(turn) }
      return failed('STATE_CORRUPTED', 'revision-capacity')
    }
    let capture: StateSaveCapture
    let bytes: Uint8Array
    try {
      capture = { encoded: this.encode(), seq: this.dirtySeq }
      bytes = statePayloadBytes(capture.encoded)
      if (bytes.byteLength > this.stateMaxBytes) {
        if (turn === null) { this.blockedPayloadSeq = this.dirtySeq }
        let result = failed('STATE_VALIDATION_FAILED', 'payload-size')
        await this.handleRefusal(result, turn, reason, started)
        return result
      }
    } catch (_error) {
      if (turn === null) { this.blockedPayloadSeq = this.dirtySeq }
      let result = failed('STATE_SERIALIZATION_FAILED', 'serialize')
      await this.handleRefusal(result, turn, reason, started)
      return result
    }
    let request: CommitTaskRequest
    try {
      request = {
        operationId: this.nextId(), pre: { appId: this.appId, vmGeneration: this.generation, baseRevision: this.revision },
        schemaVersion: 1, stamp: this.stamp, payload: bytes.buffer as ArrayBuffer,
        backupDue: this.policy.backupDue(reason, this.commitsSinceBackup, this.lastBackupAt, this.clock())
      }
    } catch (_error) {
      this.fault('STATE_CORRUPTED', 'commit-preparation')
      if (turn !== null) { this.abandonTurn(turn) }
      return failed('STATE_CORRUPTED', 'commit-preparation')
    }
    let result: CommitResult
    this.captureInFlight = turn === null
    try { result = this.correlate(await this.io().commit(request), request.operationId, this.revision + 1) }
    catch (_error) { result = { status: 'COMMIT_UNCERTAIN', code: 'STATE_COMMIT_UNCERTAIN', stage: 'commit-result' } }
    this.emitLockWait('commit', result.lockWaitMs, result.status)
    if (result.status === 'COMMITTED') {
      let durationMs = result.backupDurationMs
      this.emit('STATE_BACKUP', result.backup, { outcome: result.backup,
        durationMs: result.backup !== 'SKIPPED' && durationMs !== undefined &&
          Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : undefined })
    }
    if (result.status === 'COMMITTED' || result.status === 'COMMIT_UNCERTAIN') { this.markDurable() }
    if (this.isTerminal()) {
      if (turn !== null) { this.abandonTurn(turn) }
      if (result.status === 'COMMITTED') {
        throw new StateManagerError('STATE_COMMIT_UNCERTAIN', 'commit-invalidated')
      }
      return failed('STATE_UNAVAILABLE', 'commit-invalidated')
    }
    if (result.status !== 'COMMITTED') {
      await this.handleRefusal(result, turn, reason, started)
      return result
    }
    try { await this.confirmCommit(result, capture) }
    catch (_error) { this.fault('STATE_COMMIT_UNCERTAIN', 'commit-confirmation') }
    if (turn !== null) {
      if (this.isFaulted()) { this.abandonTurn(turn) }
      else { this.finishTurn(turn) }
    }
    if (this.isFaulted()) { throw new StateManagerError('STATE_COMMIT_UNCERTAIN', 'snapshot-confirmation') }
    let duration = Math.max(0, this.clock() - started)
    this.emit('STATE_COMMIT_OK', reason, { baseRevision: baseRevision, revision: result.revision,
      durationMs: duration, commitClass: commitClass, turnSource: turn?.source,
      payloadBytes: bytes.byteLength, outcome: 'COMMITTED' })
    if (turn !== null && turn.hasEffects) { this.recordEffectCommit(turn.source, duration) }
    return result
  }

  private async confirmCommit(result: CommittedResult, capture: StateSaveCapture): Promise<void> {
    this.assertLive()
    let snapshot: StateSnapshot | null = null
    let committed: LoadResult
    try {
      snapshot = this.makeSnapshot(capture.encoded, this.generation, result.revision)
      committed = {
        kind: 'READY', format: 'FORMAT2', source: 'MAIN', stamp: this.stamp,
        matchingStamp: true, encodedState: capture.encoded, recovered: false,
        header: {
          format: 2, appId: this.appId, schemaVersion: 1, vmGeneration: this.generation,
          revision: result.revision, payloadLength: statePayloadBytes(capture.encoded).byteLength,
          payloadHash: statePayloadHash(this.stamp, statePayloadBytes(capture.encoded))
        }
      }
    } catch (_error) {
      try {
        this.assertLive()
        let loaded = await this.io().load(this.appId, this.stamp)
        this.emitLockWait('snapshot-reread', loaded.lockWaitMs, loaded.kind)
        this.assertLive()
        if (loaded.kind !== 'READY' || loaded.stamp !== this.stamp || !loaded.header ||
            loaded.header.vmGeneration !== this.generation || loaded.header.revision !== result.revision ||
            loaded.encodedState !== capture.encoded) {
          throw new StateManagerError('STATE_COMMIT_UNCERTAIN', 'snapshot-reread')
        }
        this.decode(loaded.encodedState, this.generation, result.revision)
        snapshot = this.makeSnapshot(loaded.encodedState, this.generation, result.revision)
        committed = this.copyLoad(loaded)
      } catch (_error) { this.fault('STATE_COMMIT_UNCERTAIN', 'snapshot-reread'); return }
    }
    this.assertLive()
    this.snapshot = snapshot
    this.revision = result.revision
    this.loadedGeneration = this.generation
    this.loaded = committed
    this.lastCommit = this.clock()
    this.resetStorageHealth('commit')
    if (!this.isFaulted()) { this.phase = 'READY' }
    if (capture.seq === this.dirtySeq) {
      this.dirty = false
      this.dirtySince = 0
      this.memoryAccepted = false
      this.memoryAcceptedSince = 0
    }
    if (result.backup === 'WRITTEN') {
      this.commitsSinceBackup = 0
      this.lastBackupAt = this.lastCommit
    } else {
      this.commitsSinceBackup++
    }
  }

  private recordEffectCommit(source: StateTurnSource, durationMs: number): void {
    if (!this.diagnosticsActive()) { this.effectWindows.clear(); return }
    let now = this.clock()
    let samples: EffectCommitSample[] = this.effectWindows.get(source) || []
    let window = samples.filter((sample: EffectCommitSample): boolean =>
      sample.at <= now && now - sample.at < 1000)
    let sample: EffectCommitSample = { at: now, duration: durationMs }
    window.push(sample)
    this.effectWindows.set(source, window)
    let durations = window.map((sample): number => sample.duration).sort((a: number, b: number): number => a - b)
    this.emit('STATE_EFFECT_COMMIT_RATE', 'commit', { turnSource: source,
      commitsPerSecond: window.length, windowMs: 1000,
      p95DurationMs: durations[Math.ceil(durations.length * 0.95) - 1], sampleCount: durations.length })
  }

  private fault(code: string, stage: string): void {
    this.invalidated = true
    if (this.phase !== 'CLOSED') { this.phase = 'FAULTED' }
    this.published = false
    this.discardDirty(stage)
    this.emit(code, stage)
    if (this.pending === 0 && !this.closing && this.storage !== null) {
      this.enqueue<void>('FAULT_DRAIN', async (): Promise<void> => {}).catch(() => {})
    }
  }

  private discardDirty(stage: string): boolean {
    let discarded = this.dirty || this.memoryAccepted
    if (discarded) { this.emit('STATE_DIRTY_DISCARDED', stage) }
    this.memoryAccepted = false
    this.memoryAcceptedSince = 0
    this.dirty = false
    this.dirtySince = 0
    this.blockedPayloadSeq = -1
    return discarded
  }

  private async handleRefusal(result: CommitResult, turn: ManagedStateTransaction | null,
      reason: StateSaveReason, started: number): Promise<void> {
    if (result.status === 'COMMITTED') { return }
    this.emit('STATE_COMMIT_FAIL', result.status === 'FAILED' || result.status === 'COMMIT_UNCERTAIN' ?
      result.stage : reason, { outcome: result.status, revision: this.revision + 1,
      durationMs: Math.max(0, this.clock() - started),
      commitClass: reason === 'THROTTLED' ? 'THROTTLED' : 'IMMEDIATE',
      turnSource: turn?.source })
    if (this.isTerminal()) {
      if (turn !== null) { this.abandonTurn(turn) }
      return
    }
    if (this.lostRecoveryPending) {
      this.fault('STATE_COMMIT_UNCERTAIN', 'lost-initial-commit')
      if (turn !== null) { this.abandonTurn(turn) }
      return
    }
    this.emit(result.status === 'FAILED' || result.status === 'COMMIT_UNCERTAIN' ? result.code : result.status,
      result.status === 'FAILED' || result.status === 'COMMIT_UNCERTAIN' ? result.stage : reason)
    if (result.status === 'COMMIT_UNCERTAIN' || result.status === 'FENCED_COMMIT') {
      this.fault(result.status, reason)
      if (turn !== null) { this.abandonTurn(turn) }
      return
    }
    let stale = result.status === 'STALE_REVISION'
    if (turn !== null) { this.refuseTurn(turn, stale) }
    if (stale) {
      this.needsReload = true
      this.reopenRequired = true
      if (reason === 'FINAL') {
        this.discardDirty('final-stale')
        this.fault('STATE_REVISION_CONFLICT', 'final-stale')
      } else if (this.active === null && !this.isFaulted()) {
        await this.reload('STALE_REVISION')
      } else if (!this.isFaulted()) { this.phase = 'RELOAD_PENDING' }
      return
    }
    if (this.policy.transient(result)) {
      this.transientFailures++
      if (this.transientFailures >= this.policy.degradedAfter && !this.isFaulted() && this.phase !== 'DEGRADED') {
        this.phase = 'DEGRADED'
        this.emit('STATE_DEGRADED', reason, { outcome: 'ENTER' })
      }
    }
  }

  checkpointIfDue(now: number): Promise<CommitResult | null> {
    this.assertLive()
    if (this.mode !== 'LIVE_PERSISTENT') { return Promise.resolve(null) }
    if (this.needsReload) {
      return this.reloadAfterExternalWrite('STALE_REVISION').then(() => null)
    }
    if (this.pending !== 0 || this.active !== null ||
        !this.policy.checkpointDue(now, this.lastCommit, this.dirty ? this.dirtySince : this.lastProbe)) {
      return Promise.resolve(null)
    }
    if (!this.dirty && this.phase === 'DEGRADED') {
      return this.enqueue<CommitResult | null>('PROBE', async (): Promise<CommitResult | null> => {
        this.lastProbe = now
        await this.resumeCheck()
        return null
      })
    }
    return this.checkpoint('PERIODIC')
  }

  checkpoint(reason: StateCheckpointReason = 'PERIODIC'): Promise<CommitResult | null> {
    this.assertReady()
    if (this.mode !== 'LIVE_PERSISTENT') { return Promise.resolve(null) }
    if (this.active !== null || this.pending !== 0) { throw new StateManagerError('STATE_TURN_PENDING', 'checkpoint') }
    return this.enqueue<CommitResult | null>('CHECKPOINT', () => this.save(reason, null))
  }

  finalSave(): Promise<StateAcceptanceResult> {
    this.assertLive()
    if (this.active !== null) { throw new StateManagerError('STATE_TURN_PENDING', 'final') }
    return this.enqueue<StateAcceptanceResult>('FINAL', async (): Promise<StateAcceptanceResult> => {
      this.assertReady()
      if (this.active !== null) { throw new StateManagerError('STATE_TURN_PENDING', 'final-capture') }
      if (this.mode !== 'LIVE_PERSISTENT') { return { status: 'IN_MEMORY', vmGeneration: this.generation, revision: 0 } }
      if (!this.dirty) { return this.unchanged('CLEAN') }
      this.blockedPayloadSeq = -1
      let result = await this.save('FINAL', null)
      return result === null ? this.unchanged('CLEAN') : result
    })
  }

  reloadAfterExternalWrite(reason: StateReloadReason): Promise<ReloadResult> {
    this.assertLive()
    if (!this.needsReload) { this.assertReady() }
    if (this.active !== null) { throw new StateManagerError('STATE_TURN_PENDING', 'reload') }
    return this.enqueue<ReloadResult>('RELOAD', () => this.reload(reason))
  }

  private async reload(reason: StateReloadReason): Promise<ReloadResult> {
    this.assertLive()
    if (this.mode !== 'LIVE_PERSISTENT') {
      return { status: 'UNCHANGED', load: null, discardedDirty: false }
    }
    this.needsReload = true
    this.phase = 'RELOAD_PENDING'
    let preserving = this.promotionPending
    let discarded = preserving ? false : this.discardDirty(reason)
    let attempts = this.reloadAttempts + 1
    let loaded = await this.loadDisk(preserving)
    if (loaded.kind === 'LOST') { return this.recreateRequired('LOST', loaded, discarded) }
    if (this.isTerminal()) { return { status: 'FAULTED', load: loaded, discardedDirty: discarded } }
    if (!preserving) {
      if (loaded.kind === 'ABSENT') { return this.recreateRequired('ABSENT', loaded, discarded) }
      if (loaded.kind === 'READY' && loaded.stamp !== this.stamp) {
        return this.recreateRequired('STAMP_MISMATCH', loaded, discarded)
      }
    }
    if (loaded.kind === 'READY' || loaded.kind === 'ABSENT') {
      let publication = await this.publish()
      if (this.isTerminal()) { return { status: 'FAULTED', load: loaded, discardedDirty: discarded } }
      if (publication.status === 'COMMITTED' || publication.status === 'UNCHANGED') {
        if (preserving) { this.markDirty(); this.promotionPending = false }
        this.needsReload = false
        this.reloadAttempts = 0
        this.resetStorageHealth(reason)
        return { status: 'RELOADED', load: loaded, discardedDirty: discarded }
      }
    }
    this.reloadAttempts = attempts
    this.needsReload = true
    if (attempts >= this.policy.reloadMaxAttempts && !this.isFaulted()) {
      this.fault('STATE_RELOAD_PENDING', 'reload-attempts')
    }
    return { status: this.isFaulted() ? 'FAULTED' : 'RELOAD_PENDING', load: loaded, discardedDirty: discarded }
  }

  private recreateRequired(reason: StateRecreateReason, loaded: LoadResult,
      discarded: boolean): StateRecreateRequiredResult {
    this.loaded = this.copyLoad(loaded)
    this.snapshot = null
    this.needsReload = true
    this.promotionPending = false
    this.fault('STATE_RECREATE_REQUIRED', reason)
    return { status: 'RECREATE_REQUIRED', reason: reason, load: this.copyLoad(loaded), discardedDirty: discarded }
  }

  checkOnResume(): Promise<ReloadResult> {
    this.assertLive()
    if (this.active !== null) { throw new StateManagerError('STATE_TURN_PENDING', 'resume') }
    return this.enqueue<ReloadResult>('RESUME', () => this.resumeCheck())
  }

  private async resumeCheck(): Promise<ReloadResult> {
    this.assertLive()
    if (!this.needsReload) { this.assertReady() }
    if (this.mode !== 'LIVE_PERSISTENT') { return { status: 'UNCHANGED', load: null, discardedDirty: false } }
    if (this.needsReload) { return this.reload('APP_RESUME') }
    try {
      let header: StateHeader | null = await this.io().readHeader(this.appId)
      if (this.isTerminal()) { return { status: 'FAULTED', load: null, discardedDirty: false } }
      let unchanged = header === null ? this.loaded !== null && this.loaded.kind === 'ABSENT' :
        header.appId === this.appId && header.vmGeneration === this.generation && header.revision === this.revision &&
        (this.loaded === null || this.loaded.header === undefined || header.payloadHash === this.loaded.header.payloadHash)
      if (!unchanged) { return this.reload('APP_RESUME') }
      this.resetStorageHealth('APP_RESUME')
      this.phase = 'READY'
      return { status: 'UNCHANGED', load: null, discardedDirty: false }
    } catch (_error) {
      if (this.isTerminal()) { return { status: 'FAULTED', load: null, discardedDirty: false } }
      this.needsReload = true
      this.phase = 'RELOAD_PENDING'
      this.reloadAttempts++
      this.emit('STATE_RELOAD_PENDING', 'resume-header')
      if (this.reloadAttempts >= this.policy.reloadMaxAttempts) { this.fault('STATE_RELOAD_PENDING', 'resume-header') }
      return { status: this.isFaulted() ? 'FAULTED' : 'RELOAD_PENDING', load: null, discardedDirty: false }
    }
  }

  preparePromotion(): Promise<StateLoadResult> {
    this.assertReady()
    if (this.mode === 'LIVE_PERSISTENT' || this.active !== null || this.pending !== 0) {
      throw new StateManagerError('STATE_TURN_PENDING', 'promotion')
    }
    if (!this.storage && !this.factory) { throw new StateManagerError('STATE_STORAGE_REQUIRED', 'promotion') }
    this.mode = 'LIVE_PERSISTENT'
    this.promotionPending = true
    this.phase = 'STARTING'
    return this.enqueue<StateLoadResult>('PROMOTION', async (): Promise<StateLoadResult> => {
      let loaded = await this.loadDisk(true)
      if (loaded.kind !== 'READY' && loaded.kind !== 'ABSENT') { return loaded }
      this.assertLive()
      let result = await this.publish()
      this.assertLive()
      if (result.status !== 'COMMITTED' && result.status !== 'UNCHANGED') {
        throw new StateManagerError(result.status, 'promotion')
      }
      this.markDirty()
      this.promotionPending = false
      return loaded
    })
  }

  close(): Promise<void> {
    this.assertOutsideDiagnostic()
    if (this.closePromise !== null) { return this.closePromise }
    if (this.active !== null) { throw new StateManagerError('STATE_TURN_PENDING', 'close') }
    this.closing = true
    this.closePromise = this.enqueue<void>('CLOSE', async (): Promise<void> => {
      try { if (this.storage !== null) { await this.storage.close() } }
      finally { this.phase = 'CLOSED' }
    })
    return this.closePromise
  }
}
