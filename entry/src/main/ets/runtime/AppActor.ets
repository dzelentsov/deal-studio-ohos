import { systemDateTime } from '@kit.BasicServicesKit'
import { VirtualMachine, deserializeVbc2, RuntimeValue, VeraNumberValue,
  NULL_VALUE, decodeRuntimeValue } from '../vera/VeraInterpreter'
import { UiHostEnvironment, HostEffect, VeraUiNode, decodeVeraUi } from '../vera/VeraUi'
import { decodeGfx, GfxOp } from '../vera/VeraGfx'
import { decodeScene, WorldSpec as SceneSpec } from '../vera/VeraScene'
import { carryState } from '../vera/VeraStateCarry'
import { store, STATE_MAX_BYTES } from '../vera/ProjectStore'
import { StateManager, StateManagerOptions } from './StateManager'
import { canonicalPayload, statePayloadBytes, validateEncodedState } from './StateFormat'
import { ProgramRef, AcquireOptions, RuntimeMode } from './shared/Messages'
import { StageTrace, StateLifecycleDiag } from './trace/StageTrace'
import { HostActor } from './InProcessHost'
import type { StatePort, StateTransaction, StateAcceptanceResult, ReloadResult, StateStorageFactory,
  StateStoragePort, StateDiagnostic } from './shared/StatePort'
import type { CommitResult } from './StateIo'
import { CommitPolicy, StateTurnSource } from './CommitPolicy'

export type AppActorTurnPhase = 'READY' | 'EXECUTING' | 'COMMIT_PENDING' | 'PUBLISHING' | 'FAULTED'

interface AppActorTurnOwner {
  readonly epoch: number
  readonly generation: number
}

export interface AppActorTurnCall {
  readonly entry: string
  readonly args: RuntimeValue[]
  readonly useState: boolean
  readonly value?: RuntimeValue
  readonly prepare?: (value: RuntimeValue) => RuntimeValue
}

export interface AppActorTurnVersion {
  readonly mode: RuntimeMode
  readonly vmGeneration: number
  readonly stateRevision: number
}

export interface AppActorCheckpoint {
  readonly completion: Promise<string>
}

export interface AppActorTurnSnapshot extends AppActorTurnVersion {
  readonly encoded: string
}

export interface AppActorTurnEffects extends AppActorTurnVersion {
  readonly effects: HostEffect[]
}

export class AppActorTurnError extends Error {
  readonly code: string
  readonly kind: string
  readonly acceptance: StateAcceptanceResult | null
  saveError: AppActorTurnError | null = null
  closeError: AppActorTurnError | null = null

  constructor(code: string, kind: string, acceptance: StateAcceptanceResult | null = null) {
    super(code)
    this.code = code
    this.kind = kind
    this.acceptance = acceptance
  }
}

export interface AppActorTurnCallbacks {
  snapshot: (snapshot: AppActorTurnSnapshot) => void
  effects: (delivery: AppActorTurnEffects) => void
  render: (version: AppActorTurnVersion, pure: (call: AppActorTurnCall) => RuntimeValue) => void | Promise<void>
  error: (error: AppActorTurnError) => void
  durable?: () => void
  saved?: (version: AppActorTurnVersion) => void
  resumed?: (changed: boolean) => void
}

export class AppActorTurnCoordinator {
  private state: StatePort
  private vm: VirtualMachine
  private host: UiHostEnvironment
  private readonly mode: RuntimeMode
  private policy: CommitPolicy
  private callbacks: AppActorTurnCallbacks
  private currentPhase: AppActorTurnPhase = 'READY'
  private settlement: Promise<void> = Promise.resolve()
  private barriers: number = 0
  private barrierSettlement: Promise<void> = Promise.resolve()
  private checkpointWork: Promise<CommitResult | null> | null = null
  private checkpointReady: Promise<void> | null = null
  private checkpointDelivery: AppActorTurnSnapshot | null = null
  private checkpointReload: boolean = false
  private checkpointFailure: AppActorTurnError | null = null
  private lifecycle: Promise<void> | null = null
  private shutdownPromise: Promise<void> | null = null
  private closed: boolean = false
  private exclusive: boolean = false
  private recovering: number = 0
  private recoveryGate: boolean = false
  private publications: number = 0
  private requiredFailure: AppActorTurnError | null = null
  private fenced: boolean = false
  private epoch: number = 0
  private generation: number
  private publishedGeneration: number = -1
  private publishedRevision: number = -1
  private readonly safety: boolean

  constructor(state: StatePort, vm: VirtualMachine, host: UiHostEnvironment, mode: RuntimeMode,
      policy: CommitPolicy, callbacks: AppActorTurnCallbacks, safety: boolean = true) {
    this.state = state
    this.vm = vm
    this.host = host
    this.mode = mode
    this.policy = policy
    this.callbacks = callbacks
    this.safety = safety
    this.generation = state.status().vmGeneration
    if (state.status().mode !== mode || host.pendingEffects.length !== 0) {
      throw new AppActorTurnError('STATE_VALIDATION_FAILED', 'state')
    }
    this.assertAvailable()
    this.host.effectsAllowed = false
  }

  phase(): AppActorTurnPhase {
    this.observeFault()
    return this.currentPhase
  }

  private observeFault(): void {
    let status = this.state.status()
    if (this.fenced || status.mode !== this.mode ||
        (this.recovering === 0 && status.vmGeneration !== this.generation) ||
        status.phase === 'FAULTED' || status.phase === 'CLOSED') { this.currentPhase = 'FAULTED' }
  }

  private owner(): AppActorTurnOwner {
    let owner: AppActorTurnOwner = { epoch: this.epoch, generation: this.generation }
    return owner
  }

  private owns(owner: AppActorTurnOwner): boolean {
    let status = this.state.status()
    return !this.fenced && owner.epoch === this.epoch && owner.generation === this.generation &&
      status.mode === this.mode && status.vmGeneration === owner.generation
  }

  private assertOwner(owner: AppActorTurnOwner): void {
    if (!this.owns(owner)) {
      this.observeFault()
      throw new AppActorTurnError('STATE_UNAVAILABLE', 'state')
    }
  }

  private assertLocalOwner(owner: AppActorTurnOwner): void {
    if (this.fenced || owner.epoch !== this.epoch || this.state.status().mode !== this.mode) {
      throw new AppActorTurnError('STATE_UNAVAILABLE', 'state')
    }
  }

  private alignOwner(owner: AppActorTurnOwner): AppActorTurnOwner {
    this.assertLocalOwner(owner)
    let current = this.owner()
    this.assertOwner(current)
    return current
  }

  private adoptRecovery(owner: AppActorTurnOwner): AppActorTurnOwner {
    this.assertLocalOwner(owner)
    let status = this.state.status()
    if (this.currentPhase === 'FAULTED' || status.needsReload ||
        status.phase !== 'READY' && status.phase !== 'DEGRADED') {
      throw new AppActorTurnError('STATE_RELOAD_PENDING', 'state')
    }
    this.committed(this.version())
    this.generation = status.vmGeneration
    if (this.checkpointDelivery !== null && this.checkpointDelivery.vmGeneration !== this.generation) {
      this.checkpointDelivery = null
      this.checkpointReload = false
    }
    return this.owner()
  }

  private retainFailure(error: Error, kind: string = 'state'): AppActorTurnError {
    let failure = error instanceof AppActorTurnError ? error : new AppActorTurnError(error.message, kind)
    if (this.requiredFailure === null) { this.requiredFailure = failure }
    return failure
  }

  private assertAdmission(): void {
    if (this.fenced || this.shutdownPromise !== null) { throw new AppActorTurnError('STATE_UNAVAILABLE', 'state') }
    if (this.exclusive || this.recoveryGate) { throw new AppActorTurnError('STATE_TURN_PENDING', 'state') }
  }

  private assertWaiting(): void {
    if (this.publications !== 0 || this.currentPhase === 'PUBLISHING') {
      throw new AppActorTurnError('STATE_TURN_PENDING', 'state')
    }
  }

  private assertAvailable(): void {
    this.observeFault()
    if (this.currentPhase === 'FAULTED') { throw new AppActorTurnError('STATE_UNAVAILABLE', 'state') }
    let status = this.state.status()
    if (status.needsReload || status.phase === 'RELOAD_PENDING') {
      throw new AppActorTurnError('STATE_RELOAD_PENDING', 'state')
    }
    if (status.phase !== 'READY' && status.phase !== 'DEGRADED') {
      throw new AppActorTurnError('ACTOR_NOT_READY', 'state')
    }
  }

  private assertIdle(): void {
    this.assertWaiting()
    this.assertAdmission()
    this.assertAvailable()
    if (this.currentPhase !== 'READY' || this.barriers !== 0) {
      throw new AppActorTurnError('STATE_TURN_PENDING', 'state')
    }
  }

  private issue(error: Error, kind: string, acceptance: StateAcceptanceResult | null = null): AppActorTurnError {
    let issue = error instanceof AppActorTurnError ? error : new AppActorTurnError(error.message, kind, acceptance)
    let status = this.state.status()
    if (!this.fenced && status.mode === this.mode && status.vmGeneration === this.generation) {
      this.publications++
      try { this.callbacks.error(issue) } catch (_error) {}
      finally { this.publications-- }
    }
    return issue
  }

  async runTurn(source: StateTurnSource, persist: boolean, calls: AppActorTurnCall[],
      skipIfSame: boolean = false): Promise<StateAcceptanceResult> {
    this.assertIdle()
    if (calls.length === 0) { throw new AppActorTurnError('STATE_VALIDATION_FAILED', 'handler') }
    if (this.mode === 'PREVIEW' && source !== 'INIT' && source !== 'CARRY') {
      throw new AppActorTurnError('STATE_PREVIEW_SUPPRESSED', 'handler')
    }
    let owner = this.owner()
    let commitClass = this.policy.classify(source, persist)
    let admitted = calls.map((call: AppActorTurnCall): AppActorTurnCall => {
      return { entry: call.entry, args: call.args.slice(), useState: call.useState,
        value: call.value, prepare: call.prepare }
    })
    this.currentPhase = 'EXECUTING'
    let release: () => void = (): void => {}
    this.settlement = new Promise<void>((resolve: () => void): void => { release = resolve })
    try {
      if (this.mode === 'LIVE_PERSISTENT' && commitClass === 'IMMEDIATE') {
        let ready = this.checkpointReady
        if (ready !== null) { await ready }
        await this.state.awaitReadyForImmediate()
        this.assertOwner(owner)
        this.assertAvailable()
        if (this.checkpointReload) { await this.publishCheckpointReload(owner) }
      }
      let before: string | null = null
      if (skipIfSame) {
        try { before = this.state.captureWorkingSnapshot() } catch (_error) {}
      }
      let tx: StateTransaction | null = null
      let submitted = false
      let result: StateAcceptanceResult
      let hasEffects = false
      try {
        tx = this.state.beginTurn(commitClass, source)
        this.host.effectsAllowed = this.mode !== 'PREVIEW'
        for (let call of admitted) {
          let args = call.useState ? [this.state.getWorkingState()].concat(call.args) : call.args
          if (!this.safety) { this.state.setWorkingState(tx, this.state.getWorkingState()) }
          let value = call.value === undefined ? this.vm.execute(call.entry, args) : call.value
          if (call.prepare !== undefined) { value = call.prepare(value) }
          this.assertOwner(owner)
          this.state.setWorkingState(tx, value)
          if (this.host.pendingEffects.length > 0) { this.state.markEffects(tx) }
        }
        hasEffects = this.host.pendingEffects.length > 0
        this.host.effectsAllowed = false
        this.currentPhase = 'COMMIT_PENDING'
        submitted = true
        this.recovering++
        try {
          result = await this.state.commitTurn(tx)
          if (this.mode === 'LIVE_PERSISTENT' && result.status === 'COMMITTED') { this.callbacks.durable?.() }
        } finally { this.recovering-- }
      } catch (error) {
        if (tx !== null && !submitted) {
          try { this.state.rollbackTurn(tx) }
          catch (_error) { this.currentPhase = 'FAULTED' }
        } else if (submitted) {
          this.currentPhase = 'FAULTED'
        }
        this.host.pendingEffects = []
        throw error as Error
      } finally {
        this.host.effectsAllowed = false
      }
      if (result.status === 'STALE_REVISION' || result.status === 'FAILED' &&
          (result.stage === 'turn-base-invalid' || result.stage === 'promotion-base-invalid')) {
        this.host.pendingEffects = []
        let refusal = new AppActorTurnError(result.status === 'FAILED' ? result.code : result.status, 'state', result)
        this.assertLocalOwner(owner)
        let status = this.state.status()
        if (!status.needsReload && (status.phase === 'READY' || status.phase === 'DEGRADED')) {
          owner = this.adoptRecovery(owner)
          this.currentPhase = 'PUBLISHING'
          try { await this.publish(null, [], owner) }
          catch (error) {
            this.assertOwner(owner)
            this.issue(error as Error, 'render')
          }
        }
        throw refusal
      }
      owner = this.alignOwner(owner)
      this.observeFault()
      if (result.status !== 'COMMITTED' && result.status !== 'IN_MEMORY' && result.status !== 'UNCHANGED') {
        this.host.pendingEffects = []
        let issue = new AppActorTurnError(result.status === 'FAILED' || result.status === 'COMMIT_UNCERTAIN' ?
          result.code : result.status, 'state', result)
        if (result.status === 'COMMIT_UNCERTAIN' || result.status === 'FENCED_COMMIT') {
          this.currentPhase = 'FAULTED'
        }
        if (this.policy.effective(commitClass, hasEffects) !== 'THROTTLED' ||
            !this.policy.transient(result) || this.currentPhase === 'FAULTED') { throw issue }
        this.assertAvailable()
        if (this.mode !== 'PREVIEW') { this.issue(issue as Error, 'state') }
      }
      this.assertAvailable()
      if (this.mode === 'PREVIEW') {
        this.host.pendingEffects = []
        return result
      }
      if (hasEffects && this.mode === 'LIVE_PERSISTENT' && result.status !== 'COMMITTED') {
        this.currentPhase = 'FAULTED'
        this.host.pendingEffects = []
        throw new AppActorTurnError('STATE_COMMIT_UNCERTAIN', 'state', result)
      }
      let effects = this.host.pendingEffects
      this.host.pendingEffects = []
      this.currentPhase = 'PUBLISHING'
      this.flushCheckpoint(owner)
      let render = true
      if (before !== null && effects.length === 0) {
        try { render = this.state.captureWorkingSnapshot() !== before } catch (_error) {}
      }
      await this.publish(result, effects, owner, render)
      return result
    } catch (error) {
      this.host.pendingEffects = []
      if (this.mode === 'PREVIEW') { throw error as Error }
      if (!this.owns(owner)) { throw new AppActorTurnError('STATE_UNAVAILABLE', 'state') }
      throw this.issue(error as Error, source === 'INIT' ? 'init' : source === 'CARRY' ? 'carry' : 'handler')
    } finally {
      this.host.effectsAllowed = false
      this.observeFault()
      if (this.currentPhase !== 'FAULTED') { this.flushCheckpoint(owner) }
      if (this.phase() !== 'FAULTED') { this.currentPhase = 'READY' }
      release()
    }
  }

  private version(): AppActorTurnVersion {
    let status = this.state.status()
    return {
      mode: this.mode, vmGeneration: status.vmGeneration,
      stateRevision: this.mode === 'LIVE_PERSISTENT' ? status.baseRevision : 0
    }
  }

  private committed(version: AppActorTurnVersion, result: StateAcceptanceResult | null = null): AppActorTurnSnapshot {
    let snapshot = this.state.committedSnapshot()
    if (snapshot === null || snapshot.version.vmGeneration !== version.vmGeneration ||
        snapshot.version.revision !== version.stateRevision) {
      this.currentPhase = 'FAULTED'
      throw new AppActorTurnError('STATE_COMMIT_UNCERTAIN', 'state', result)
    }
    return { mode: this.mode, vmGeneration: snapshot.version.vmGeneration,
      stateRevision: snapshot.version.revision, encoded: snapshot.encoded }
  }

  private deliverSnapshot(snapshot: AppActorTurnSnapshot, owner: AppActorTurnOwner): void {
    this.assertOwner(owner)
    if (snapshot.vmGeneration === this.publishedGeneration && snapshot.stateRevision < this.publishedRevision) { return }
    this.publishedGeneration = snapshot.vmGeneration
    this.publishedRevision = snapshot.stateRevision
    this.callbacks.snapshot(snapshot)
  }

  private notifySaved(owner: AppActorTurnOwner, version: AppActorTurnVersion): void {
    this.assertOwner(owner)
    if (this.mode !== 'LIVE_PERSISTENT') { return }
    this.publications++
    try { this.callbacks.saved?.(version) }
    finally { this.publications-- }
  }

  private flushCheckpoint(owner: AppActorTurnOwner): void {
    if (this.checkpointReload) { return }
    let snapshot = this.checkpointDelivery
    this.checkpointDelivery = null
    if (snapshot === null || !this.owns(owner) || this.currentPhase === 'FAULTED') { return }
    let phase = this.currentPhase
    this.currentPhase = 'PUBLISHING'
    this.publications++
    try {
      try { this.deliverSnapshot(snapshot, owner) }
      catch (error) { this.checkpointFailure = new AppActorTurnError((error as Error).message, 'snapshot') }
      try { this.notifySaved(owner, snapshot) }
      catch (error) {
        if (this.checkpointFailure === null) {
          this.checkpointFailure = new AppActorTurnError((error as Error).message, 'save')
        }
      }
    } finally {
      this.publications--
      if (this.phase() !== 'FAULTED') { this.currentPhase = phase }
    }
  }

  private async publishCheckpointReload(owner: AppActorTurnOwner): Promise<void> {
    if (!this.checkpointReload) { return }
    this.checkpointDelivery = null
    this.checkpointReload = false
    let phase = this.currentPhase
    this.currentPhase = 'PUBLISHING'
    try { await this.publish(null, [], owner) }
    finally {
      if (this.phase() !== 'FAULTED') { this.currentPhase = phase }
    }
  }

  private async publish(result: StateAcceptanceResult | null, effects: HostEffect[],
      owner: AppActorTurnOwner, render: boolean = true): Promise<void> {
    this.publications++
    try { await this.publishOwned(result, effects, owner, render) }
    finally { this.publications-- }
  }

  private async publishOwned(result: StateAcceptanceResult | null, effects: HostEffect[],
      owner: AppActorTurnOwner, render: boolean): Promise<void> {
    this.assertOwner(owner)
    let version = this.version()
    let failure: AppActorTurnError | null = null
    try {
      if (this.mode === 'LIVE_EPHEMERAL') {
        this.deliverSnapshot({
          mode: version.mode, vmGeneration: version.vmGeneration, stateRevision: 0,
          encoded: this.state.captureWorkingSnapshot()
        }, owner)
      } else if (result === null || result.status === 'COMMITTED' ||
          result.status === 'UNCHANGED' && result.reason === 'INIT_EQUAL') {
        this.deliverSnapshot(this.committed(version, result), owner)
      }
    } catch (error) {
      failure = new AppActorTurnError((error as Error).message, 'snapshot', result)
    }
    this.assertOwner(owner)
    if (this.currentPhase === 'FAULTED') { throw failure! }
    try {
      if (effects.length > 0) {
        this.callbacks.effects({
          mode: version.mode, vmGeneration: version.vmGeneration,
          stateRevision: version.stateRevision, effects: effects
        })
      }
    } catch (error) {
      if (failure === null) { failure = new AppActorTurnError((error as Error).message, 'effects', result) }
    }
    this.assertOwner(owner)
    if (result?.status === 'COMMITTED') {
      try { this.notifySaved(owner, version) }
      catch (error) {
        if (failure === null) { failure = new AppActorTurnError((error as Error).message, 'save', result) }
      }
    }
    this.assertAvailable()
    if (!render) {
      if (failure !== null) { throw failure }
      return
    }
    let reading = true
    let pure = (call: AppActorTurnCall): RuntimeValue => {
      this.assertOwner(owner)
      this.assertAvailable()
      if (!reading) { throw new AppActorTurnError('STATE_TURN_PENDING', 'view') }
      return this.executePure(call)
    }
    try {
      await this.callbacks.render(version, pure)
    } catch (error) {
      if (failure === null) { failure = new AppActorTurnError((error as Error).message, 'render', result) }
    } finally { reading = false }
    this.assertOwner(owner)
    if (failure !== null) { throw failure }
  }

  pure(call: AppActorTurnCall): RuntimeValue {
    this.assertIdle()
    this.currentPhase = 'EXECUTING'
    try { return this.executePure(call) }
    catch (error) {
      if (this.mode === 'PREVIEW') { throw error as Error }
      throw this.issue(error as Error, 'view')
    } finally {
      this.observeFault()
      if (this.phase() !== 'FAULTED') { this.currentPhase = 'READY' }
    }
  }

  private executePure(call: AppActorTurnCall): RuntimeValue {
    let owner = this.owner()
    let root = this.state.getWorkingState()
    if (!this.safety) {
      try {
        let value = this.vm.execute(call.entry, call.useState ? [root].concat(call.args) : call.args)
        this.assertOwner(owner)
        return value
      } catch (error) {
        this.currentPhase = 'FAULTED'
        this.checkpointDelivery = null
        this.host.effectsAllowed = false
        this.host.pendingEffects = []
        let tx: StateTransaction | null = null
        try {
          tx = this.state.beginTurn('VOLATILE', this.mode === 'PREVIEW' ? 'INIT' : 'INPUT')
          this.state.setWorkingState(tx, root)
        } catch (_error) {} finally {
          if (tx !== null) {
            try { this.state.rollbackTurn(tx) } catch (_error) {}
          }
        }
        throw this.retainFailure(error as Error, 'view')
      }
    }
    let scope = this.vm.beginTurn(new Object(), root)
    try {
      let result = this.vm.executePure(call.entry, call.useState ? [root].concat(call.args) : call.args)
      this.assertOwner(owner)
      scope.accept()
      return result
    } catch (error) {
      try { scope.rollback() }
      catch (_error) { this.currentPhase = 'FAULTED' }
      throw error as Error
    }
  }

  snapshotBarrier(): Promise<string> {
    try {
      this.assertWaiting()
      this.assertAdmission()
      if (this.mode === 'PREVIEW') { throw new AppActorTurnError('STATE_PREVIEW_SUPPRESSED', 'state') }
    } catch (error) { return Promise.reject(error) }
    this.barriers++
    let owner = this.owner()
    let result = this.settlement.then((): string => {
      this.alignOwner(owner)
      this.assertAvailable()
      return this.state.captureWorkingSnapshot()
    }).finally((): void => { this.barriers-- })
    this.barrierSettlement = Promise.all([this.barrierSettlement, result.then(() => {}, () => {})]).then(() => {})
    return result
  }

  checkpointIfDue(now: number): Promise<CommitResult | null> {
    if (this.checkpointWork !== null) { return Promise.resolve(null) }
    return this.startCheckpoint('PERIODIC', now)
  }

  checkpoint(reason: 'PERIODIC' | 'BACKGROUND' = 'PERIODIC'): Promise<CommitResult | null> {
    return this.startCheckpoint(reason)
  }

  private startCheckpoint(reason: 'PERIODIC' | 'BACKGROUND', now?: number): Promise<CommitResult | null> {
    let recovery = false
    try {
      this.assertWaiting()
      if (this.checkpointWork !== null) {
        if (this.fenced || this.shutdownPromise !== null || this.exclusive) { this.assertAdmission() }
        this.observeFault()
        if (this.currentPhase === 'FAULTED') { throw new AppActorTurnError('STATE_UNAVAILABLE', 'state') }
        return this.checkpointWork
      }
      this.assertAdmission()
      if (reason !== 'PERIODIC' && reason !== 'BACKGROUND') {
        throw new AppActorTurnError('STATE_VALIDATION_FAILED', 'state')
      }
      this.observeFault()
      if (this.currentPhase === 'FAULTED') { throw new AppActorTurnError('STATE_UNAVAILABLE', 'state') }
      let status = this.state.status()
      recovery = now !== undefined && (status.needsReload || status.phase === 'RELOAD_PENDING' ||
        status.phase === 'DEGRADED' && !status.dirty)
      if (!recovery) { this.assertAvailable() }
      if (now !== undefined && (this.currentPhase !== 'READY' || this.barriers !== 0)) {
        return Promise.resolve(null)
      }
      if (this.currentPhase !== 'READY' || this.barriers !== 0) {
        throw new AppActorTurnError('STATE_TURN_PENDING', 'state')
      }
    } catch (error) { return Promise.reject(error) }
    let owner = this.owner()
    if (recovery) { this.recoveryGate = true }
    let release: () => void = (): void => {}
    this.checkpointReady = new Promise<void>((resolve: () => void): void => { release = resolve })
    this.checkpointWork = this.finishCheckpoint(owner, reason, now, recovery, release).catch((error: Error) => {
      throw this.retainFailure(error)
    }).finally((): void => {
      release()
      this.checkpointReady = null
      this.checkpointWork = null
      this.recoveryGate = false
    })
    return this.checkpointWork
  }

  private acceptanceError(result: StateAcceptanceResult): AppActorTurnError | null {
    if (result.status === 'COMMITTED' || result.status === 'IN_MEMORY' || result.status === 'UNCHANGED') { return null }
    if (result.status === 'COMMIT_UNCERTAIN' || result.status === 'FENCED_COMMIT') { this.currentPhase = 'FAULTED' }
    return new AppActorTurnError(result.status === 'FAILED' || result.status === 'COMMIT_UNCERTAIN' ?
      result.code : result.status, 'state', result)
  }

  private async finishCheckpoint(owner: AppActorTurnOwner, reason: 'PERIODIC' | 'BACKGROUND',
      now: number | undefined, recovery: boolean, release: () => void): Promise<CommitResult | null> {
    try {
      let before = this.state.committedSnapshot()
      let result: CommitResult | null
      this.recovering++
      try { result = await (now === undefined ? this.state.checkpoint(reason) : this.state.checkpointIfDue(now)) }
      finally { this.recovering-- }
      this.assertLocalOwner(owner)
      let status = this.state.status()
      let recovered = (recovery || result?.status === 'STALE_REVISION') && !status.needsReload &&
        (status.phase === 'READY' || status.phase === 'DEGRADED') &&
        (status.vmGeneration !== owner.generation || recovery)
      let refusal = result === null ? null : this.acceptanceError(result)
      if (recovered) {
        owner = this.adoptRecovery(owner)
        let snapshot = this.committed(this.version())
        if (before === null || before.version.vmGeneration !== snapshot.vmGeneration ||
            before.version.revision !== snapshot.stateRevision || before.encoded !== snapshot.encoded) {
          this.checkpointDelivery = snapshot
          this.checkpointReload = true
          this.recoveryGate = true
        }
      } else {
        this.assertOwner(owner)
        if (result?.status === 'COMMITTED') {
          this.checkpointDelivery = this.committed({ mode: this.mode,
            vmGeneration: owner.generation, stateRevision: result.revision }, result)
        }
      }
      if (result !== null && refusal !== null && !recovered) {
        if (!this.policy.transient(result)) { throw refusal }
        this.issue(refusal as Error, 'state')
      }
      release()
      if (this.currentPhase !== 'READY') { await this.settlement }
      owner = this.alignOwner(owner)
      this.assertAvailable()
      if (this.checkpointReload) {
        try { await this.publishCheckpointReload(owner) }
        catch (error) {
          if (refusal === null) { throw error as Error }
          this.assertOwner(owner)
          this.issue(error as Error, 'render')
        }
      } else { this.flushCheckpoint(owner) }
      if (refusal !== null && recovered) { throw refusal }
      if (this.checkpointFailure !== null) {
        let error = this.checkpointFailure
        this.checkpointFailure = null
        throw error
      }
      return result
    } catch (error) {
      if (!this.owns(owner)) { throw new AppActorTurnError('STATE_UNAVAILABLE', 'state') }
      throw this.issue(error as Error, 'state')
    }
  }

  private async drain(): Promise<void> {
    let checkpoint = this.checkpointWork
    await Promise.all([this.settlement, this.barrierSettlement,
      checkpoint === null ? Promise.resolve() : checkpoint.then(() => {}, () => {})])
    await this.state.whenIdle()
  }

  async whenSettled(): Promise<void> {
    this.assertWaiting()
    if (this.shutdownPromise !== null) { return this.shutdownPromise }
    let lifecycle = this.lifecycle
    await this.drain()
    if (lifecycle !== null) { await lifecycle }
    if (this.requiredFailure !== null) { throw this.requiredFailure }
  }

  resume(): Promise<ReloadResult> {
    try {
      this.assertWaiting()
      this.assertAdmission()
      this.observeFault()
      if (this.currentPhase === 'FAULTED') { throw new AppActorTurnError('STATE_UNAVAILABLE', 'state') }
    } catch (error) { return Promise.reject(error) }
    this.exclusive = true
    let result = this.resumeState(this.owner()).catch((error: Error) => {
      throw this.retainFailure(error)
    }).finally((): void => {
      this.lifecycle = null
      if (this.shutdownPromise === null) { this.exclusive = false }
    })
    this.lifecycle = result.then(() => {}, () => {})
    return result
  }

  private async resumeState(owner: AppActorTurnOwner): Promise<ReloadResult> {
    try {
      await this.drain()
      owner = this.alignOwner(owner)
      this.observeFault()
      if (this.currentPhase === 'FAULTED') { throw new AppActorTurnError('STATE_UNAVAILABLE', 'state') }
      let before = this.version()
      let encoded = this.mode === 'LIVE_PERSISTENT' ? this.state.committedSnapshot()?.encoded : undefined
      let result: ReloadResult
      this.recovering++
      try { result = await this.state.checkOnResume() }
      finally { this.recovering-- }
      if (this.fenced || owner.epoch !== this.epoch || this.state.status().mode !== this.mode) {
        throw new AppActorTurnError('STATE_UNAVAILABLE', 'state')
      }
      if (result.status === 'RECREATE_REQUIRED' || result.status === 'FAULTED') {
        this.currentPhase = 'FAULTED'
        throw new AppActorTurnError(result.status === 'RECREATE_REQUIRED' ? 'STATE_RECREATE_REQUIRED' :
          'STATE_UNAVAILABLE', 'state')
      }
      if (result.status === 'RELOAD_PENDING') { throw new AppActorTurnError('STATE_RELOAD_PENDING', 'state') }
      if (result.status === 'RELOADED') {
        let next = this.adoptRecovery(owner)
        this.assertAvailable()
        this.callbacks.resumed?.(true)
        let version = this.version()
        if (version.vmGeneration !== before.vmGeneration || version.stateRevision !== before.stateRevision ||
            this.state.committedSnapshot()?.encoded !== encoded) {
          this.currentPhase = 'PUBLISHING'
          await this.publish(null, [], next)
        }
      } else {
        this.assertOwner(owner)
        this.assertAvailable()
        this.callbacks.resumed?.(false)
      }
      return result
    } catch (error) {
      this.observeFault()
      throw this.issue(error as Error, 'state')
    } finally {
      this.observeFault()
      if (this.currentPhase !== 'FAULTED') { this.currentPhase = 'READY' }
    }
  }

  shutdown(saveState: boolean): Promise<void> {
    if (this.shutdownPromise !== null) { return this.shutdownPromise }
    try { this.assertWaiting() }
    catch (error) { return Promise.reject(error) }
    this.exclusive = true
    this.shutdownPromise = this.shutdownState(saveState, this.lifecycle)
    return this.shutdownPromise
  }

  closureConfirmed(): boolean { return this.closed }

  private async shutdownState(saveState: boolean, lifecycle: Promise<void> | null): Promise<void> {
    let failure: AppActorTurnError | null = null
    try {
      if (lifecycle !== null) { await lifecycle }
      await this.drain()
      failure = this.requiredFailure
      if (saveState) {
        this.assertAvailable()
        let owner = this.owner()
        let result = await this.state.finalSave()
        this.assertOwner(owner)
        let error = this.acceptanceError(result)
        if (error !== null) { throw error }
        this.assertAvailable()
        if (result.status === 'COMMITTED') {
          this.currentPhase = 'PUBLISHING'
          try { await this.publish(result, [], owner, false) }
          finally {
            if (this.phase() !== 'FAULTED') { this.currentPhase = 'READY' }
          }
        }
      }
    } catch (error) {
      let saving = this.issue(error as Error, 'state')
      failure = this.requiredFailure
      if (failure === null) { failure = saving }
      else if (saving !== failure) { failure.saveError = saving }
    } finally {
      try {
        await this.state.close()
        this.closed = true
      } catch (error) {
        let closure = this.issue(error as Error, 'close')
        if (failure === null) { failure = closure }
        else { failure.closeError = closure }
      } finally { this.fence() }
    }
    if (failure !== null) { throw failure }
  }

  fence(): void {
    if (this.fenced) { return }
    this.fenced = true
    this.epoch++
    this.currentPhase = 'FAULTED'
    this.checkpointDelivery = null
    this.host.effectsAllowed = false
    this.host.pendingEffects = []
  }
}

export interface AppActorCallbacks {
  render: (paint: boolean, reveal: boolean, version?: AppActorTurnVersion) => void | Promise<void>
  snapshot: (encoded: string, version?: AppActorTurnVersion) => void
  saved: (projectId: string) => void
  effects: (effects: HostEffect[], version?: AppActorTurnVersion) => void
  error: (kind: string, message: string) => void
  version?: (version: AppActorTurnVersion) => void
  durable?: () => void
  identity?: () => string
  generation?: () => number
}

class AppActorStorageFactory implements StateStorageFactory {
  create(): StateStoragePort { return store.createStateStorage() }
}

class AppActorStateOptions implements StateManagerOptions {
  appId: string = ''
  stamp: string = ''
  mode: RuntimeMode = 'PREVIEW'
  stateMaxBytes: number = STATE_MAX_BYTES
  initialState: RuntimeValue = NULL_VALUE
  storageFactory?: StateStorageFactory
  rollbackGuard?: VirtualMachine
  vmJournal: boolean = true
  journalMode: 'JOURNAL' = 'JOURNAL'
  vmGeneration?: number
  policy: CommitPolicy = new CommitPolicy()
  durable?: () => void
  diagnostic?: (event: StateDiagnostic) => void
  diagnosticEnabled?: () => boolean
}

class AppActorMemoryRuntime {
  vm: VirtualMachine | null = null
  host: UiHostEnvironment | null = null
  manager: StateManager | null = null
  coordinator: AppActorTurnCoordinator | null = null
  pureCapability: ((call: AppActorTurnCall) => RuntimeValue) | null = null
  refreshes: boolean = false
  safety: boolean = true
  mode: RuntimeMode = 'PREVIEW'
  program: ProgramRef | null = null
  persistKey: string = ''
  lastViewAt: number = 0
  lastSurfaceSave: number = 0
  active: boolean = false
  durable: boolean = false
  muteRender: boolean = false
  reveal: boolean = false
  saveFailure: Error | null = null
  effectsAllowed: boolean = false
  pendingEffects: HostEffect[] = []
}

export class AppActor implements HostActor {
  private callbacks: AppActorCallbacks
  private traceOwner: Object
  private vm: VirtualMachine | null = null
  private host: UiHostEnvironment | null = null
  private manager: StateManager | null = null
  private coordinator: AppActorTurnCoordinator | null = null
  private pureCapability: ((call: AppActorTurnCall) => RuntimeValue) | null = null
  private refreshes: boolean = false
  private safety: boolean = true
  private mode: RuntimeMode = 'PREVIEW'
  private program: ProgramRef | null = null
  private persistKey: string = ''
  private lastViewAt: number = 0
  private lastSurfaceSave: number = 0
  private disposed: boolean = false
  private cancelled: boolean = false
  private active: boolean = false
  private durable: boolean = false
  private muteRender: boolean = false
  private reveal: boolean = false
  private tail: Promise<void> = Promise.resolve()
  private disposal: Promise<void> | null = null
  private disposalSettled: boolean = false
  private closureFailure: Error | null = null
  private saveFailure: Error | null = null
  private callbacksActive: number = 0

  constructor(callbacks: AppActorCallbacks, traceOwner: Object) {
    this.callbacks = callbacks
    this.traceOwner = traceOwner
  }

  ready(): boolean {
    if (this.disposed || this.cancelled || !this.active || this.coordinator === null) { return false }
    let phase = this.manager!.status().phase
    return phase !== 'NEW' && phase !== 'STARTING' && phase !== 'CLOSED' && phase !== 'FAULTED' &&
      this.coordinator!.phase() !== 'FAULTED'
  }

  durablePublished(): boolean { return this.durable }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.callbacksActive !== 0) { return Promise.reject(new AppActorTurnError('STATE_TURN_PENDING', 'state')) }
    if (this.disposed || this.cancelled) { return Promise.reject(new AppActorTurnError('STATE_UNAVAILABLE', 'state')) }
    let result = this.tail.then(async (): Promise<T> => {
      if (this.disposed || this.cancelled) { throw new AppActorTurnError('STATE_UNAVAILABLE', 'state') }
      return work()
    })
    this.tail = result.then(() => {}, () => {})
    return result
  }

  private tracked<T>(options: AcquireOptions, work: () => Promise<T>): Promise<T> {
    return options.mode === 'LIVE_PERSISTENT' ? store.trackStateOperation(options.persistKey, work) : work()
  }

  private version(): AppActorTurnVersion {
    let status = this.manager!.status()
    return { mode: this.mode, vmGeneration: status.vmGeneration,
      stateRevision: this.mode === 'LIVE_PERSISTENT' ? status.baseRevision : 0 }
  }

  private callback<T>(work: () => T): T {
    this.callbacksActive++
    try { return work() }
    finally { this.callbacksActive-- }
  }

  private align(version: AppActorTurnVersion = this.version()): void {
    this.callback(() => this.callbacks.version?.(version))
  }

  private markDurable(): void {
    if (this.durable) { return }
    this.durable = true
    this.callback(() => this.callbacks.durable?.())
  }

  private accepted(result: StateAcceptanceResult): void {
    if (result.status !== 'COMMITTED' && result.status !== 'IN_MEMORY' && result.status !== 'UNCHANGED') {
      throw new AppActorTurnError(result.status === 'FAILED' || result.status === 'COMMIT_UNCERTAIN' ?
        result.code : result.status, 'state', result)
    }
  }

  private publishSnapshot(encoded: string, version: AppActorTurnVersion): void {
    if (this.cancelled || this.disposed || this.mode === 'PREVIEW') { return }
    this.align(version)
    StageTrace.snapshot(this.traceOwner, encoded)
    this.callback(() => this.callbacks.snapshot(encoded, version))
  }

  private async render(version: AppActorTurnVersion,
      pure: ((call: AppActorTurnCall) => RuntimeValue) | null = null): Promise<void> {
    if (this.cancelled || this.disposed || this.muteRender) { return }
    this.align(version)
    this.callbacksActive++
    this.pureCapability = pure
    try {
      await this.callbacks.render(true, this.reveal, version)
    } finally {
      this.pureCapability = null
      this.callbacksActive--
    }
  }

  private async closeRuntime(coordinator: AppActorTurnCoordinator | null, manager: StateManager | null,
      saveState: boolean): Promise<void> {
    try {
      if (coordinator !== null) { await coordinator.shutdown(saveState) }
      else if (manager !== null) { await manager.close() }
    } catch (error) {
      if ((coordinator === null || !coordinator.closureConfirmed()) && this.closureFailure === null) {
        this.closureFailure = error as Error
      }
      throw error as Error
    }
  }

  private async retire(saveState: boolean = false): Promise<void> {
    this.active = false
    try {
      await this.closeRuntime(this.coordinator, this.manager, saveState)
    } finally {
      this.coordinator = null
      this.manager = null
      this.clearEffects()
    }
  }

  initialize(program: ProgramRef, options: AcquireOptions, refresh: boolean = true): Promise<void> {
    let target: AcquireOptions = { mode: options.mode, persistKey: options.persistKey, seedState: options.seedState }
    let source: ProgramRef = { vbc2: program.vbc2, stamp: program.stamp }
    return this.tracked(target, () => this.enqueue(async (): Promise<void> => {
      await this.retire()
      await this.activate(source, target, null)
      if (refresh) { await this.refreshWidget() }
    }))
  }

  replaceProgram(program: ProgramRef, options: AcquireOptions): Promise<void> {
    return this.initialize(program, options)
  }

  private async activate(program: ProgramRef, options: AcquireOptions, working: RuntimeValue | null): Promise<void> {
    this.program = program
    this.mode = options.mode
    this.persistKey = options.persistKey
    this.lastViewAt = 0
    this.lastSurfaceSave = 0
    this.durable = false
    this.saveFailure = null
    let initialKind = working !== null || options.seedState.length > 0 && options.mode !== 'PREVIEW' ? 'carry' : 'init'
    let reportedFailure: AppActorTurnError | null = null
    try {
      if (program.vbc2.length === 0) { throw new AppActorTurnError('STATE_VALIDATION_FAILED', initialKind) }
      let flags = store.runtimeFlags()
      if (working === null) {
        this.safety = flags.vmJournal
        let module = deserializeVbc2(program.vbc2)
        this.host = new UiHostEnvironment()
        this.vm = new VirtualMachine(module, this.host!, 5000000,
          this.safety ? { now: (): number => systemDateTime.getUptime(systemDateTime.TimeType.STARTUP), deadlineMs: 1000 } : null,
          this.safety ? { journalMode: flags.journalMode } : null)
        this.vm!.setDiagnostic?.((event, attributes): void => {
          StageTrace.diagnostic(this.traceOwner, event, {
            entryCategory: attributes.entryCategory, operation: attributes.operation, outcome: attributes.outcome,
            durationMs: attributes.durationMs, steps: attributes.steps, records: attributes.records,
            reservations: attributes.reservations, rollbacks: attributes.rollbacks, safety: attributes.safety
          })
        }, (): boolean => StageTrace.enabled())
        this.refreshes = module.functions.some((fn): boolean => fn.name === 'widgetRefresh')
      } else if (this.vm === null || this.host === null || this.safety !== flags.vmJournal) {
        throw new AppActorTurnError('STATE_RECREATE_REQUIRED', 'state')
      }
      this.host!.effectsAllowed = false
      let policy = new CommitPolicy()
      let persistent = this.mode === 'LIVE_PERSISTENT'
      let appId = persistent ? options.persistKey : this.callbacks.identity?.() || options.persistKey || 'memory'
      let managerOptions = new AppActorStateOptions()
      managerOptions.appId = appId
      managerOptions.stamp = program.stamp
      managerOptions.mode = this.mode
      managerOptions.initialState = working === null ? NULL_VALUE : working
      managerOptions.storageFactory = persistent ? new AppActorStorageFactory() : undefined
      managerOptions.rollbackGuard = this.safety ? this.vm! : undefined
      managerOptions.vmJournal = this.safety
      managerOptions.journalMode = flags.journalMode
      managerOptions.vmGeneration = persistent ? undefined : this.callbacks.generation?.() ?? 1
      managerOptions.policy = policy
      managerOptions.durable = (): void => this.markDurable()
      managerOptions.diagnosticEnabled = (): boolean => StageTrace.enabled()
      managerOptions.diagnostic = (event: StateDiagnostic): void => {
        let dispatch = (): void => {
          StageTrace.diagnostic(this.traceOwner, event.code, {
            stage: event.stage, generation: event.vmGeneration, baseRevision: event.baseRevision,
            revision: event.revision, dirtyAgeMs: event.dirtyAgeMs, durationMs: event.durationMs,
            commitClass: event.commitClass, turnSource: event.turnSource, format: event.format,
            loadSource: event.loadSource, outcome: event.outcome, dirty: event.dirty,
            transientFailures: event.transientFailures, reloadAttempts: event.reloadAttempts,
            payloadBytes: event.payloadBytes, commitsPerSecond: event.commitsPerSecond,
            p95DurationMs: event.p95DurationMs, sampleCount: event.sampleCount, windowMs: event.windowMs
          })
        }
        if (this.vm!.observeDiagnostics === undefined) { dispatch() }
        else { this.vm!.observeDiagnostics(dispatch) }
      }
      this.manager = new StateManager(managerOptions)
      let loaded = await this.manager!.load(working !== null)
      if (loaded.kind !== 'IN_MEMORY' && loaded.kind !== 'READY' && loaded.kind !== 'ABSENT') {
        throw new AppActorTurnError(loaded.kind === 'UNAVAILABLE' ? loaded.code || 'STATE_UNAVAILABLE' : 'STATE_LOST', 'state')
      }
      let publication = await this.manager!.publishGeneration()
      if (persistent && (publication.status === 'COMMITTED' || publication.status === 'COMMIT_UNCERTAIN')) {
        this.markDurable()
      }
      this.accepted(publication)
      this.align()
      if (this.cancelled || this.disposed) { throw new AppActorTurnError('STATE_UNAVAILABLE', 'state') }
      this.coordinator = new AppActorTurnCoordinator(this.manager!, this.vm!, this.host!, this.mode, policy, {
        snapshot: (snapshot): void => this.publishSnapshot(snapshot.encoded, snapshot),
        effects: (delivery): void => {
          if (this.cancelled || this.disposed) { return }
          this.align(delivery)
          this.callback(() => this.callbacks.effects(delivery.effects, delivery))
        },
        render: (version, pure): Promise<void> => this.render(version, pure),
        durable: (): void => this.markDurable(),
        saved: (version): void => {
          if (this.cancelled || this.disposed) { return }
          this.align(version)
          this.callback(() => this.callbacks.saved(this.persistKey.split('/')[0]))
        },
        resumed: (changed: boolean): void => {
          if (!this.cancelled && !this.disposed) {
            StageTrace.emit(this.traceOwner, 'RESUME_STATE_RELOAD', { changed: changed })
          }
        },
        error: (error): void => {
          reportedFailure = error
          StageTrace.emit(this.traceOwner, 'ERROR', { kind: error.kind })
          if (!this.cancelled && !this.disposed) { this.callback(() => this.callbacks.error(error.kind, error.code)) }
        }
      }, this.safety)
      this.active = true
      let restored = working !== null || loaded.kind === 'READY' && loaded.stamp === program.stamp
      let call: AppActorTurnCall = { entry: 'init', args: [], useState: false }
      let source: StateTurnSource = working !== null ? 'CARRY' : 'INIT'
      if (restored) { call = { entry: '', args: [], useState: false, value: this.manager!.getWorkingState() } }
      else if (options.seedState.length > 0 && this.mode !== 'PREVIEW') {
        let payload = canonicalPayload(validateEncodedState(options.seedState))
        if (statePayloadBytes(payload).byteLength > STATE_MAX_BYTES) {
          throw new AppActorTurnError('STATE_VALIDATION_FAILED', 'carry')
        }
        let seed = decodeRuntimeValue(JSON.parse(payload) as Object)
        source = 'CARRY'
        call = { entry: 'init', args: [], useState: false,
          prepare: (fresh: RuntimeValue): RuntimeValue => {
            let carried = carryState(fresh, seed, this.vm!.classShapes())
            let allowed = this.host!.effectsAllowed
            this.host!.effectsAllowed = false
            try { this.vm!.executePure('view', [carried]) }
            finally { this.host!.effectsAllowed = allowed }
            return carried
          }
        }
      }
      StageTrace.emit(this.traceOwner, 'EXECUTE', { entry: restored ? 'restore' : 'init', kind: source })
      await this.coordinator!.runTurn(source, true, [call])
      if (this.mode === 'PREVIEW') { await this.render(this.version()) }
    } catch (error) {
      this.active = false
      this.clearEffects()
      let failure = error as Error
      try { await this.retire() } catch (_closeError) {}
      if (failure !== reportedFailure) {
        let kind = error instanceof AppActorTurnError ? error.kind : initialKind
        StageTrace.emit(this.traceOwner, 'ERROR', { kind: kind })
        if (!this.cancelled && !this.disposed) {
          this.callback(() => this.callbacks.error(kind,
            error instanceof AppActorTurnError ? error.code : 'STATE_INITIALIZATION_FAILED'))
        }
      }
      throw failure
    }
  }

  private captureMemoryRuntime(): AppActorMemoryRuntime {
    let runtime = new AppActorMemoryRuntime()
    runtime.vm = this.vm
    runtime.host = this.host
    runtime.manager = this.manager
    runtime.coordinator = this.coordinator
    runtime.pureCapability = this.pureCapability
    runtime.refreshes = this.refreshes
    runtime.safety = this.safety
    runtime.mode = this.mode
    runtime.program = this.program
    runtime.persistKey = this.persistKey
    runtime.lastViewAt = this.lastViewAt
    runtime.lastSurfaceSave = this.lastSurfaceSave
    runtime.active = this.active
    runtime.durable = this.durable
    runtime.muteRender = this.muteRender
    runtime.reveal = this.reveal
    runtime.saveFailure = this.saveFailure
    runtime.effectsAllowed = this.host!.effectsAllowed
    runtime.pendingEffects = this.host!.pendingEffects
    return runtime
  }

  private restoreMemoryRuntime(runtime: AppActorMemoryRuntime): void {
    this.vm = runtime.vm
    this.host = runtime.host
    this.manager = runtime.manager
    this.coordinator = runtime.coordinator
    this.pureCapability = runtime.pureCapability
    this.refreshes = runtime.refreshes
    this.safety = runtime.safety
    this.mode = runtime.mode
    this.program = runtime.program
    this.persistKey = runtime.persistKey
    this.lastViewAt = runtime.lastViewAt
    this.lastSurfaceSave = runtime.lastSurfaceSave
    this.active = runtime.active
    this.durable = runtime.durable
    this.muteRender = runtime.muteRender
    this.reveal = runtime.reveal
    this.saveFailure = runtime.saveFailure
    this.host!.effectsAllowed = runtime.effectsAllowed
    this.host!.pendingEffects = runtime.pendingEffects
  }

  private async closeMemoryRuntime(runtime: AppActorMemoryRuntime): Promise<void> {
    try {
      await this.closeRuntime(runtime.coordinator, runtime.manager, false)
    } finally { this.clearEffects() }
  }

  promote(options: AcquireOptions): Promise<void> {
    let target: AcquireOptions = { mode: options.mode, persistKey: options.persistKey, seedState: options.seedState }
    return this.tracked(target, () => this.enqueue(async (): Promise<void> => {
      if (!this.ready()) { throw new AppActorTurnError('ACTOR_NOT_READY', 'state') }
      if (this.mode === target.mode && this.persistKey === target.persistKey) { return }
      await this.coordinator!.whenSettled()
      let working = this.manager!.getWorkingState()
      let program = this.program!
      if (this.mode === 'LIVE_PERSISTENT') {
        await this.retire(true)
        await this.activate(program, target, working)
        return
      }
      let previous = this.captureMemoryRuntime()
      this.active = false
      this.manager = null
      this.coordinator = null
      try {
        await this.activate(program, target, working)
      } catch (error) {
        if (!this.durable && !this.cancelled && !this.disposed &&
            this.safety === previous.safety && store.runtimeFlags().vmJournal === previous.safety) {
          this.restoreMemoryRuntime(previous)
        } else {
          try { await this.closeMemoryRuntime(previous) } catch (_closeError) {}
        }
        throw error as Error
      }
      await this.closeMemoryRuntime(previous)
    }))
  }

  reconcileState(): Promise<void> {
    return this.enqueue(async (): Promise<void> => {
      if (!this.ready() || this.mode === 'PREVIEW') { return }
      await this.coordinator!.resume()
      this.align()
    })
  }

  resume(): Promise<void> {
    return this.enqueue(async (): Promise<void> => {
      if (!this.ready() || this.mode === 'PREVIEW') { return }
      let result = await this.coordinator!.resume()
      this.align()
      if (result.status === 'UNCHANGED') { await this.render(this.version()) }
      await this.refreshWidget()
    })
  }

  snapshot(): Promise<string> {
    if (this.mode === 'PREVIEW') { return Promise.resolve('') }
    return this.enqueue(async (): Promise<string> => {
      if (!this.ready()) { return '' }
      return this.coordinator!.snapshotBarrier()
    })
  }

  notifyStateSnapshot(): Promise<void> {
    return this.enqueue(async (): Promise<void> => {
      if (!this.ready() || this.mode === 'PREVIEW') { return }
      await this.coordinator!.whenSettled()
      let snapshot = this.mode === 'LIVE_PERSISTENT' ? this.manager!.committedSnapshot() : null
      if (snapshot !== null) {
        this.publishSnapshot(snapshot.encoded, { mode: this.mode, vmGeneration: snapshot.version.vmGeneration,
          stateRevision: snapshot.version.revision })
      } else if (this.mode === 'LIVE_EPHEMERAL') {
        this.publishSnapshot(this.manager!.captureWorkingSnapshot(), this.version())
      }
    })
  }

  persistState(): Promise<boolean> { return this.saveNow() }

  saveNow(): Promise<boolean> {
    return this.enqueue(async (): Promise<boolean> => {
      if (!this.ready() || this.mode !== 'LIVE_PERSISTENT') { return false }
      try {
        await this.coordinator!.whenSettled()
        let result = await this.manager!.finalSave()
        if (result.status === 'COMMITTED') { this.markDurable() }
        this.accepted(result)
        this.saveFailure = null
        this.align()
        if (result.status === 'COMMITTED') {
          let snapshot = this.manager!.committedSnapshot()!
          this.publishSnapshot(snapshot.encoded, this.version())
          this.callback(() => this.callbacks.saved(this.persistKey.split('/')[0]))
          StageTrace.emit(this.traceOwner, 'SAVE', { digest: snapshot.digest, result: 'OK' })
        }
        return true
      } catch (error) {
        this.saveFailure = error as Error
        StageTrace.emit(this.traceOwner, 'ERROR', { kind: 'SAVE' })
        throw error as Error
      }
    })
  }

  clearEffects(): void {
    if (this.host !== null) {
      this.host!.effectsAllowed = false
      this.host!.pendingEffects = []
    }
  }

  cancel(): void {
    this.cancelled = true
    this.clearEffects()
  }

  async quiesce(): Promise<void> {
    await this.tail
    if (this.coordinator !== null) { await this.coordinator!.whenSettled() }
    else if (this.manager !== null) { await this.manager!.whenIdle() }
    if (this.saveFailure !== null && !this.ready()) { throw this.saveFailure }
  }

  dispose(): Promise<void> {
    if (this.disposal !== null) { return this.disposal }
    this.cancel()
    this.disposed = true
    this.disposal = (async (): Promise<void> => {
      let failure: Error | null = null
      try { await this.quiesce() } catch (error) { failure = error as Error }
      try { await this.retire() } catch (error) { if (failure === null) { failure = error as Error } }
      finally {
        this.vm = null
        this.host = null
        this.manager = null
        this.coordinator = null
        this.pureCapability = null
        this.program = null
        this.disposalSettled = true
      }
      if (failure !== null) { throw failure }
      if (this.closureFailure !== null) { throw this.closureFailure }
    })()
    return this.disposal
  }

  closureConfirmed(): boolean { return this.disposalSettled && this.closureFailure === null }

  private pure(entry: string, kind: string): RuntimeValue {
    this.host!.effectsAllowed = false
    StageTrace.emit(this.traceOwner, 'EXECUTE', { entry: entry, kind: kind })
    let call: AppActorTurnCall = { entry: entry, args: [], useState: true }
    return this.pureCapability === null ? this.coordinator!.pure(call) : this.pureCapability!(call)
  }

  view(): VeraUiNode | null {
    if (!this.ready()) { return null }
    this.lastViewAt = Date.now()
    let nodes = decodeVeraUi(this.pure('view', 'VIEW'))
    return nodes.length > 0 ? nodes[0] : null
  }

  draw(entry: string): GfxOp[] {
    if (!this.ready() || entry.length === 0) { return [] }
    return decodeGfx(this.pure(entry, 'DRAW'))
  }

  buildScene(entry: string): SceneSpec {
    if (!this.ready() || entry.length === 0) { return new SceneSpec() }
    return decodeScene(this.pure(entry, 'BUILD'))
  }

  private async turn(source: StateTurnSource, persist: boolean, calls: AppActorTurnCall[],
      muted: boolean = false, reveal: boolean = false, skipIfSame: boolean = false): Promise<void> {
    if (!this.ready() || this.mode === 'PREVIEW') { return }
    this.muteRender = muted
    this.reveal = reveal
    try {
      await this.coordinator!.runTurn(source, persist, calls, skipIfSame)
      this.align()
    } finally {
      this.muteRender = false
      this.reveal = false
    }
  }

  dispatch(action: string, payload: RuntimeValue, persist: boolean = true, kind: string = 'HANDLER',
      skipIfSame: boolean = false): Promise<void> {
    return this.enqueue(async (): Promise<void> => {
      if (!this.ready() || this.mode === 'PREVIEW') { return }
      let source: StateTurnSource = kind === 'TICK' ? 'TICK' : kind === 'EFFECT_RESULT' ? 'EFFECT_RESULT' : 'INPUT'
      StageTrace.emit(this.traceOwner, 'EXECUTE', { entry: action, kind: kind })
      await this.turn(source, persist, [{ entry: action, args: [payload], useState: true }], false, true, skipIfSame)
      StageTrace.emit(this.traceOwner, 'INPUT_APPLIED', { action: action })
    })
  }

  private async refreshWidget(): Promise<void> {
    if (!this.refreshes || !this.ready() || this.mode === 'PREVIEW') { return }
    StageTrace.emit(this.traceOwner, 'EXECUTE', { entry: 'widgetRefresh', kind: 'WIDGET_REFRESH' })
    await this.turn('INPUT', true, [{ entry: 'widgetRefresh', args: [], useState: true }])
  }

  runWidgetRefresh(): Promise<void> {
    return this.enqueue(() => this.refreshWidget())
  }

  frameHandlers(actions: string[], elapsed: number): Promise<void> {
    let calls = actions.filter((action: string): boolean => action.length > 0).map((action: string): AppActorTurnCall => {
      return { entry: action, args: [new VeraNumberValue(elapsed)], useState: true }
    })
    return this.enqueue(async (): Promise<void> => {
      if (calls.length === 0) { return }
      await this.turn('SURFACE', false, calls, true)
    })
  }

  move(action: string, payload: RuntimeValue): Promise<void> {
    return this.enqueue(() => this.turn('MOVE', false, [{ entry: action, args: [payload], useState: true }], true))
  }

  viewDue(now: number): boolean {
    return this.ready() && now - this.lastViewAt >= 100
  }

  beginSurfaceLoop(now: number): void {
    if (!this.ready() || this.mode === 'PREVIEW') { return }
    this.lastSurfaceSave = now
  }

  checkpointBackground(now: number): Promise<AppActorCheckpoint> {
    return this.enqueue(async (): Promise<AppActorCheckpoint> => {
      const operation = StateLifecycleDiag.operation()
      const started = StateLifecycleDiag.now()
      StateLifecycleDiag.emit('ACTOR', 'CHECKPOINT_BEGIN', operation)
      if (!this.ready() || this.mode !== 'LIVE_PERSISTENT') {
        StateLifecycleDiag.emit('ACTOR', 'CHECKPOINT_END', operation, 'NOT_DUE', StateLifecycleDiag.elapsed(started))
        return { completion: Promise.resolve('NOT_DUE') }
      }
      let coordinator = this.coordinator!
      try {
        let completion = coordinator.checkpoint('BACKGROUND').then((result: CommitResult | null): string => {
          StateLifecycleDiag.emit('ACTOR', 'CHECKPOINT_END', operation, result === null ? 'NOT_DUE' : result.status,
            StateLifecycleDiag.elapsed(started))
          if (result === null) { return 'NOT_DUE' }
          if (result.status !== 'COMMITTED') { return 'ERROR' }
          if (this.coordinator === coordinator) { this.lastSurfaceSave = now }
          return 'DONE'
        }, (error: Error): string => {
          StateLifecycleDiag.emit('ACTOR', 'CHECKPOINT_END', operation, 'REJECTED', StateLifecycleDiag.elapsed(started))
          throw error
        })
        completion.catch(() => undefined)
        return { completion: completion }
      } catch (error) {
        StateLifecycleDiag.emit('ACTOR', 'CHECKPOINT_END', operation, 'REJECTED', StateLifecycleDiag.elapsed(started))
        throw error as Error
      }
    })
  }

  surfaceSave(now: number, editsPending: boolean): Promise<string> {
    return this.enqueue(async (): Promise<string> => {
      if (!this.ready() || this.mode !== 'LIVE_PERSISTENT' || now - this.lastSurfaceSave < 5000) { return 'NOT_DUE' }
      if (editsPending) { return 'DEFERRED' }
      let result = await this.coordinator!.checkpointIfDue(now)
      if (result === null) { return 'NOT_DUE' }
      if (result.status !== 'COMMITTED') { return 'NOT_SAVED' }
      this.lastSurfaceSave = now
      return 'DONE'
    })
  }

  worldSave(now: number, editsPending: boolean, stopping: boolean): Promise<string> {
    return this.enqueue(async (): Promise<string> => {
      if (!this.ready() || this.mode !== 'LIVE_PERSISTENT' || !this.worldDirty() ||
          !stopping && now - this.lastSurfaceSave < 5000) { return 'NOT_DUE' }
      if (editsPending) { return 'DEFERRED' }
      let result = stopping ? await this.coordinator!.checkpoint('BACKGROUND') :
        await this.coordinator!.checkpointIfDue(now)
      if (result === null) { return 'NOT_DUE' }
      if (result.status !== 'COMMITTED') { return 'ERROR' }
      this.lastSurfaceSave = now
      return 'DONE'
    })
  }

  worldDirty(): boolean {
    return this.manager !== null && this.manager!.status().dirty
  }
}
