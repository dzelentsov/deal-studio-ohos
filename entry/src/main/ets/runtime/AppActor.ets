import { VirtualMachine, deserializeVbc2, RuntimeValue, VeraNumberValue,
  encodeRuntimeValue, decodeRuntimeValue } from '../vera/VeraInterpreter'
import { UiHostEnvironment, HostEffect, VeraUiNode, decodeVeraUi } from '../vera/VeraUi'
import { decodeGfx, GfxOp } from '../vera/VeraGfx'
import { decodeScene, WorldSpec as SceneSpec } from '../vera/VeraScene'
import { carryState } from '../vera/VeraStateCarry'
import { store } from '../vera/ProjectStore'
import { ProgramRef, AcquireOptions, RuntimeMode } from './shared/Messages'
import { StageTrace } from './trace/StageTrace'
import { HostActor } from './InProcessHost'
import type { StatePort, StateTransaction, StateAcceptanceResult, ReloadResult } from './shared/StatePort'
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
}

export interface AppActorTurnVersion {
  readonly mode: RuntimeMode
  readonly vmGeneration: number
  readonly stateRevision: number
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

  constructor(state: StatePort, vm: VirtualMachine, host: UiHostEnvironment, mode: RuntimeMode,
      policy: CommitPolicy, callbacks: AppActorTurnCallbacks) {
    this.state = state
    this.vm = vm
    this.host = host
    this.mode = mode
    this.policy = policy
    this.callbacks = callbacks
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

  async runTurn(source: StateTurnSource, persist: boolean, calls: AppActorTurnCall[]): Promise<StateAcceptanceResult> {
    this.assertIdle()
    if (calls.length === 0) { throw new AppActorTurnError('STATE_VALIDATION_FAILED', 'handler') }
    if (this.mode === 'PREVIEW' && source !== 'INIT' && source !== 'CARRY') {
      throw new AppActorTurnError('STATE_PREVIEW_SUPPRESSED', 'handler')
    }
    let owner = this.owner()
    let commitClass = this.policy.classify(source, persist)
    let admitted = calls.map((call: AppActorTurnCall): AppActorTurnCall => {
      return { entry: call.entry, args: call.args.slice(), useState: call.useState }
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
      let tx: StateTransaction | null = null
      let submitted = false
      let result: StateAcceptanceResult
      let hasEffects = false
      try {
        tx = this.state.beginTurn(commitClass, source)
        this.host.effectsAllowed = this.mode !== 'PREVIEW'
        for (let call of admitted) {
          let args = call.useState ? [this.state.getWorkingState()].concat(call.args) : call.args
          let value = this.vm.execute(call.entry, args)
          this.assertOwner(owner)
          this.state.setWorkingState(tx, value)
          if (this.host.pendingEffects.length > 0) { this.state.markEffects(tx) }
        }
        hasEffects = this.host.pendingEffects.length > 0
        this.host.effectsAllowed = false
        this.currentPhase = 'COMMIT_PENDING'
        submitted = true
        this.recovering++
        try { result = await this.state.commitTurn(tx) }
        finally { this.recovering-- }
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
      await this.publish(result, effects, owner)
      return result
    } catch (error) {
      this.host.pendingEffects = []
      if (this.mode === 'PREVIEW') { throw error as Error }
      if (!this.owns(owner)) { throw new AppActorTurnError('STATE_UNAVAILABLE', 'state') }
      throw this.issue(error as Error, 'handler')
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

  private flushCheckpoint(owner: AppActorTurnOwner): void {
    if (this.checkpointReload) { return }
    let snapshot = this.checkpointDelivery
    this.checkpointDelivery = null
    if (snapshot === null || !this.owns(owner) || this.currentPhase === 'FAULTED') { return }
    let phase = this.currentPhase
    this.currentPhase = 'PUBLISHING'
    this.publications++
    try { this.deliverSnapshot(snapshot, owner) }
    catch (error) { this.checkpointFailure = new AppActorTurnError((error as Error).message, 'snapshot') }
    finally {
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
      owner: AppActorTurnOwner): Promise<void> {
    this.publications++
    try { await this.publishOwned(result, effects, owner) }
    finally { this.publications-- }
  }

  private async publishOwned(result: StateAcceptanceResult | null, effects: HostEffect[],
      owner: AppActorTurnOwner): Promise<void> {
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
    this.assertAvailable()
    let reading = true
    let pure = (call: AppActorTurnCall): RuntimeValue => {
      this.assertOwner(owner)
      this.assertAvailable()
      if (!reading) { throw new AppActorTurnError('STATE_TURN_PENDING', 'view') }
      return this.executePure(call)
    }
    try {
      let delivery: void | Promise<void>
      try { delivery = this.callbacks.render(version, pure) }
      finally { reading = false }
      await delivery
    } catch (error) {
      if (failure === null) { failure = new AppActorTurnError((error as Error).message, 'render', result) }
    }
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
        let version = this.version()
        if (version.vmGeneration !== before.vmGeneration || version.stateRevision !== before.stateRevision ||
            this.state.committedSnapshot()?.encoded !== encoded) {
          this.currentPhase = 'PUBLISHING'
          await this.publish(null, [], next)
        }
      } else {
        this.assertOwner(owner)
        this.assertAvailable()
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
      }
    } catch (error) {
      let saving = this.issue(error as Error, 'state')
      failure = this.requiredFailure
      if (failure === null) { failure = saving }
      else if (saving !== failure) { failure.saveError = saving }
    } finally {
      try { await this.state.close() }
      catch (error) {
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
  render: (paint: boolean, reveal: boolean) => void | Promise<void>
  snapshot: (encoded: string) => void
  saved: (projectId: string) => void
  effects: (effects: HostEffect[]) => void
  error: (kind: string, message: string) => void
}

export class AppActor implements HostActor {
  private callbacks: AppActorCallbacks
  private traceOwner: Object
  private vm: VirtualMachine | null = null
  private host: UiHostEnvironment | null = null
  private currentState: RuntimeValue | null = null
  private diskState: string = ''
  private refreshes: boolean = false
  private mode: RuntimeMode = 'PREVIEW'
  private program: ProgramRef | null = null
  private persistKey: string = ''
  private seedState: string = ''
  private lastViewAt: number = 0
  private lastSurfaceSave: number = 0
  private worldUnsaved: boolean = false
  private disposed: boolean = false
  private cancelled: boolean = false

  constructor(callbacks: AppActorCallbacks, traceOwner: Object) {
    this.callbacks = callbacks
    this.traceOwner = traceOwner
  }

  ready(): boolean {
    return !this.disposed && !this.cancelled && this.vm !== null && this.currentState !== null
  }

  initialize(program: ProgramRef, options: AcquireOptions, refresh: boolean = true): void {
    if (this.disposed || this.cancelled) { return }
    this.clearEffects()
    this.vm = null
    this.host = null
    this.currentState = null
    this.diskState = ''
    this.refreshes = false
    this.lastViewAt = 0
    this.lastSurfaceSave = 0
    this.worldUnsaved = false
    this.program = program
    this.mode = options.mode
    this.persistKey = options.persistKey
    this.seedState = options.seedState
    if (program.vbc2.length === 0) { return }
    try {
      this.host = new UiHostEnvironment()
      let module = deserializeVbc2(program.vbc2)
      this.vm = new VirtualMachine(module, this.host)
      this.refreshes = module.functions.some((fn): boolean => fn.name === 'widgetRefresh')
      this.currentState = this.restoreState()
      if (this.currentState === null) {
        StageTrace.emit(this.traceOwner, 'EXECUTE', { entry: 'init', kind: 'INIT' })
        this.currentState = this.seeded(this.vm!.execute('init'))
      }
      this.notifyStateSnapshot()
      if (!this.ready()) { return }
      this.callbacks.render(true, false)
      if (!this.ready()) { return }
      if (refresh) { this.runWidgetRefresh() }
    } catch (e) {
      StageTrace.emit(this.traceOwner, 'ERROR', { kind: 'INIT' })
      this.clearEffects()
      this.callbacks.error('INIT', 'Init error: ' + (e as Error).message)
    }
  }

  replaceProgram(program: ProgramRef, options: AcquireOptions): void {
    this.initialize(program, options)
  }

  promote(options: AcquireOptions): void {
    if (this.disposed || this.cancelled ||
        (this.mode === options.mode && this.persistKey === options.persistKey)) { return }
    this.mode = options.mode
    this.persistKey = options.persistKey
    if (this.mode === 'PREVIEW') { this.clearEffects() }
    this.notifyStateSnapshot()
    if (!this.ready()) { return }
    this.callbacks.render(true, false)
  }

  reconcileState(): void {
    if (!this.ready() || this.mode === 'PREVIEW') { return }
    let keys = this.stateKeys()
    let changed = keys.length > 0 && store.loadState(keys[0], keys[1], this.stamp()) !== this.diskState
    StageTrace.emit(this.traceOwner, 'RESUME_STATE_RELOAD', { changed: changed })
    if (changed) {
      let restored = this.restoreState()
      if (restored !== null) { this.currentState = restored }
    }
  }

  resume(): void {
    if (!this.ready() || this.mode === 'PREVIEW') { return }
    this.reconcileState()
    this.callbacks.render(true, false)
    if (!this.ready()) { return }
    this.runWidgetRefresh()
  }

  snapshot(): string {
    if (!this.ready() || this.mode === 'PREVIEW') { return '' }
    return JSON.stringify(encodeRuntimeValue(this.currentState!))
  }

  notifyStateSnapshot(): void {
    if (!this.ready() || this.mode === 'PREVIEW') { return }
    try {
      let encoded = this.snapshot()
      StageTrace.snapshot(this.traceOwner, encoded)
      this.callbacks.snapshot(encoded)
    } catch (e) {
      StageTrace.emit(this.traceOwner, 'ERROR', { kind: 'SNAPSHOT' })
      console.warn('VERA-STATE snapshot unavailable: ' + (e as Error).message)
    }
  }

  persistState(): boolean {
    try {
      return this.saveNow()
    } catch (e) {
      console.error('VERA-STATE save failed: ' + (e as Error).message)
      return false
    }
  }

  saveNow(): boolean {
    if (!this.ready() || this.mode !== 'LIVE_PERSISTENT') { return false }
    let keys = this.stateKeys()
    if (keys.length === 0) { return false }
    let encoded = ''
    try {
      encoded = JSON.stringify(encodeRuntimeValue(this.currentState!))
      store.saveState(keys[0], keys[1], this.stamp(), encoded)
      this.diskState = encoded
      this.worldUnsaved = false
      this.callbacks.saved(keys[0])
      if (StageTrace.enabled()) {
        StageTrace.emit(this.traceOwner, 'SAVE', { digest: StageTrace.digest(encoded), result: 'OK' })
      }
      return true
    } catch (e) {
      StageTrace.emit(this.traceOwner, 'ERROR', { kind: 'SAVE' })
      if (StageTrace.enabled()) {
        StageTrace.emit(this.traceOwner, 'SAVE', { digest: StageTrace.digest(encoded), result: 'ERROR' })
      }
      throw e as Error
    }
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

  dispose(): void {
    this.cancel()
    this.disposed = true
    this.vm = null
    this.host = null
    this.currentState = null
    this.diskState = ''
    this.refreshes = false
    this.mode = 'PREVIEW'
    this.program = null
    this.persistKey = ''
    this.seedState = ''
    this.lastViewAt = 0
    this.lastSurfaceSave = 0
    this.worldUnsaved = false
  }

  view(): VeraUiNode | null {
    if (!this.ready()) { return null }
    this.lastViewAt = Date.now()
    if (this.host !== null) { this.host!.effectsAllowed = false }
    StageTrace.emit(this.traceOwner, 'EXECUTE', { entry: 'view', kind: 'VIEW' })
    let nodes = decodeVeraUi(this.vm!.execute('view', [this.currentState!]))
    return nodes.length > 0 ? nodes[0] : null
  }

  draw(entry: string): GfxOp[] {
    if (!this.ready() || entry.length === 0) { return [] }
    if (this.host !== null) { this.host!.effectsAllowed = false }
    StageTrace.emit(this.traceOwner, 'EXECUTE', { entry: entry, kind: 'DRAW' })
    return decodeGfx(this.vm!.execute(entry, [this.currentState!]))
  }

  buildScene(entry: string): SceneSpec {
    if (!this.ready() || entry.length === 0) { return new SceneSpec() }
    if (this.host !== null) { this.host!.effectsAllowed = false }
    StageTrace.emit(this.traceOwner, 'EXECUTE', { entry: entry, kind: 'BUILD' })
    return decodeScene(this.vm!.execute(entry, [this.currentState!]))
  }

  dispatch(action: string, payload: RuntimeValue, persist: boolean = true, kind: string = 'HANDLER', skipIfSame: boolean = false): void {
    if (!this.ready() || this.mode === 'PREVIEW') { return }
    let t0 = Date.now()
    try {
      if (this.host !== null) { this.host!.effectsAllowed = true }
      let before = this.currentState!
      let beforeCode = skipIfSame ? this.stateCode(before) : ''
      StageTrace.emit(this.traceOwner, 'EXECUTE', { entry: action, kind: kind })
      this.currentState = this.vm!.execute(action, [before, payload])
      if (this.host !== null) { this.host!.effectsAllowed = false }
      if (skipIfSame && this.stateCode(this.currentState!) === beforeCode) {
        if (persist && this.worldUnsaved) { this.persistState() }
        this.drainEffects()
        return
      }
      StageTrace.emit(this.traceOwner, 'INPUT_APPLIED', { action: action })
      this.notifyStateSnapshot()
      if (!this.ready()) { return }
      console.info('VERA-ACTION ' + action + ' steps=' + this.vm!.stepsExecuted().toString() +
        ' ms=' + (Date.now() - t0).toString())
      this.callbacks.render(true, true)
      if (!this.ready()) { return }
      if (persist) {
        this.persistState()
      } else {
        this.worldUnsaved = true
      }
      if (!this.ready()) { return }
      this.drainEffects()
    } catch (e) {
      StageTrace.emit(this.traceOwner, 'ERROR', { kind: kind })
      this.clearEffects()
      console.error('VERA-ACTION ' + action + ' TRAP steps=' + this.vm!.stepsExecuted().toString() +
        ' ms=' + (Date.now() - t0).toString() + ' err=' + (e as Error).message)
      this.callbacks.error(kind, 'Action error: ' + (e as Error).message)
    }
  }

  runWidgetRefresh(): void {
    if (!this.refreshes || !this.ready() || this.mode === 'PREVIEW') { return }
    try {
      if (this.host !== null) { this.host!.effectsAllowed = true }
      StageTrace.emit(this.traceOwner, 'EXECUTE', { entry: 'widgetRefresh', kind: 'WIDGET_REFRESH' })
      this.currentState = this.vm!.execute('widgetRefresh', [this.currentState!])
      if (this.host !== null) { this.host!.effectsAllowed = false }
      this.notifyStateSnapshot()
      if (!this.ready()) { return }
      this.callbacks.render(true, false)
      if (!this.ready()) { return }
      this.persistState()
      if (!this.ready()) { return }
      this.drainEffects()
    } catch (e) {
      StageTrace.emit(this.traceOwner, 'ERROR', { kind: 'WIDGET_REFRESH' })
      this.clearEffects()
      console.warn('VERA-REFRESH widgetRefresh failed: ' + (e as Error).message)
    }
  }

  frameHandlers(actions: string[], elapsed: number): void {
    if (!this.ready() || this.mode === 'PREVIEW') { return }
    try {
      if (this.host !== null) { this.host!.effectsAllowed = true }
      for (let action of actions) {
        if (action.length === 0) { continue }
        StageTrace.emit(this.traceOwner, 'EXECUTE', { entry: action, kind: 'FRAME' })
        this.currentState = this.vm!.execute(action, [this.currentState!, new VeraNumberValue(elapsed)])
      }
      if (this.host !== null) { this.host!.effectsAllowed = false }
      this.drainEffects()
    } catch (e) {
      this.clearEffects()
      throw e as Error
    }
  }

  move(action: string, payload: RuntimeValue): void {
    if (!this.ready() || this.mode === 'PREVIEW') { return }
    try {
      if (this.host !== null) { this.host!.effectsAllowed = true }
      StageTrace.emit(this.traceOwner, 'EXECUTE', { entry: action, kind: 'MOVE' })
      this.currentState = this.vm!.execute(action, [this.currentState!, payload])
      if (this.host !== null) { this.host!.effectsAllowed = false }
      StageTrace.emit(this.traceOwner, 'INPUT_APPLIED', { action: action })
      this.drainEffects()
    } catch (e) {
      this.clearEffects()
      throw e as Error
    }
  }

  viewDue(now: number): boolean {
    return this.ready() && now - this.lastViewAt >= 100
  }

  beginSurfaceLoop(now: number): void {
    if (!this.ready() || this.mode === 'PREVIEW') { return }
    this.lastSurfaceSave = now
  }

  surfaceSave(now: number, editsPending: boolean): string {
    if (!this.ready() || this.mode === 'PREVIEW' || now - this.lastSurfaceSave < 5000) { return 'NOT_DUE' }
    if (editsPending) { return 'DEFERRED' }
    if (!this.persistState()) { return 'NOT_SAVED' }
    this.lastSurfaceSave = now
    this.notifyStateSnapshot()
    return 'DONE'
  }

  worldSave(now: number, editsPending: boolean, stopping: boolean): string {
    if (!this.ready() || this.mode === 'PREVIEW' || !this.worldUnsaved ||
      (!stopping && now - this.lastSurfaceSave < 5000)) { return 'NOT_DUE' }
    if (editsPending) { return 'DEFERRED' }
    if (!this.persistState()) { return 'ERROR' }
    this.lastSurfaceSave = now
    return 'DONE'
  }

  worldDirty(): boolean {
    return this.worldUnsaved
  }

  private stateCode(state: RuntimeValue): string {
    return JSON.stringify(encodeRuntimeValue(state))
  }

  private stateKeys(): string[] {
    if (this.disposed || this.mode !== 'LIVE_PERSISTENT') { return [] }
    let slash = this.persistKey.indexOf('/')
    if (this.persistKey.length === 0 || slash <= 0) { return [] }
    return [this.persistKey.substring(0, slash), this.persistKey.substring(slash + 1)]
  }

  private stamp(): string {
    return this.program !== null ? this.program!.stamp : ''
  }

  private seeded(fresh: RuntimeValue): RuntimeValue {
    if (this.seedState.length === 0 || this.mode === 'PREVIEW') { return fresh }
    try {
      let carried = carryState(fresh, decodeRuntimeValue(JSON.parse(this.seedState) as Object), this.vm!.classShapes())
      if (this.host !== null) { this.host!.effectsAllowed = false }
      StageTrace.emit(this.traceOwner, 'EXECUTE', { entry: 'view', kind: 'VIEW' })
      this.vm!.execute('view', [carried])
      console.info('VERA-STATE carried into the refined program')
      return carried
    } catch (e) {
      StageTrace.emit(this.traceOwner, 'ERROR', { kind: 'STATE_CARRY' })
      console.warn('VERA-STATE could not carry the old state, starting clean: ' + (e as Error).message)
      return fresh
    }
  }

  private restoreState(): RuntimeValue | null {
    let keys = this.stateKeys()
    if (keys.length === 0) { return null }
    let encoded = store.loadState(keys[0], keys[1], this.stamp())
    this.diskState = encoded
    if (encoded.length === 0) { return null }
    try {
      return decodeRuntimeValue(JSON.parse(encoded) as Object)
    } catch (e) {
      StageTrace.emit(this.traceOwner, 'ERROR', { kind: 'RESTORE' })
      console.error('VERA-STATE restore failed, starting clean: ' + (e as Error).message)
      return null
    }
  }

  private drainEffects(): void {
    if (!this.ready() || this.mode === 'PREVIEW' || this.host === null) { return }
    let effects: HostEffect[] = this.host!.pendingEffects
    if (effects.length === 0) { return }
    this.host!.pendingEffects = []
    this.callbacks.effects(effects)
  }
}
