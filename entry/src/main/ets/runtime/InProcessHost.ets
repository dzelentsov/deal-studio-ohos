import { AppActor, AppActorCallbacks } from './AppActor'
import { AcquireOptions, ActorHandle, AdmissionResult, AppSubscriber, DrawRequest,
  EffectRequest, FrameEnvelope, HostOperationError, InputEvent, InputPayload,
  ProgramRef, RuntimeMode, SceneDraw, SceneEventPayload, SurfaceFrameEvent, TickEvent } from './shared/Messages'
import { RuntimeValue, VeraNumberValue, VeraStringValue, VeraBooleanValue } from '../vera/VeraInterpreter'
import { HostEffect, VeraUiNode } from '../vera/VeraUi'
import { GfxOp, pointerValue } from '../vera/VeraGfx'
import { sceneEventValue, WorldSpec } from '../vera/VeraScene'
import { StageTrace } from './trace/StageTrace'
import { EffectResultHost } from './HostEffectsBridge'

export interface HostActor {
  ready(): boolean
  initialize(program: ProgramRef, options: AcquireOptions, refresh?: boolean): void | Promise<void>
  promote(options: AcquireOptions): void | Promise<void>
  reconcileState(): void | Promise<void>
  resume(): void | Promise<void>
  snapshot(): string | Promise<string>
  notifyStateSnapshot(): void | Promise<void>
  runWidgetRefresh(): void | Promise<void>
  saveNow(): boolean | Promise<boolean>
  dispatch(action: string, payload: RuntimeValue, persist?: boolean, kind?: string,
    skipIfSame?: boolean): void | Promise<void>
  frameHandlers(actions: string[], elapsed: number): void | Promise<void>
  move(action: string, payload: RuntimeValue): void | Promise<void>
  view(): VeraUiNode | null | Promise<VeraUiNode | null>
  draw(entry: string): GfxOp[] | Promise<GfxOp[]>
  buildScene(entry: string): WorldSpec | Promise<WorldSpec>
  surfaceSave(now: number, editsPending: boolean): string | Promise<string>
  worldSave(now: number, editsPending: boolean, stopping: boolean): string | Promise<string>
  viewDue(now: number): boolean
  worldDirty(): boolean
  beginSurfaceLoop(now: number): void
  clearEffects(): void
  cancel(): void
  quiesce?(): void | Promise<void>
  dispose(): void | Promise<void>
}

export type HostActorFactory = (callbacks: AppActorCallbacks, traceOwner: Object) => HostActor

function chain<T, U>(value: T | Promise<T>, next: (value: T) => U | Promise<U>): U | Promise<U> {
  return value instanceof Promise ? value.then(next) : next(value)
}

function attempt<T>(run: () => T | Promise<T>, failed: (error: Error) => T | Promise<T>): T | Promise<T> {
  try {
    let value = run()
    return value instanceof Promise ? value.catch(failed) : value
  } catch (e) { return failed(e as Error) }
}

export class HostOperationFailure extends Error {
  code: HostOperationError

  constructor(code: HostOperationError) {
    super(code)
    this.name = 'HostOperationError'
    this.code = code
  }
}

interface ReleaseOptions {
  saveState?: boolean
}

interface SurfaceGfx {
  nodeId: number
  surfaceRevision: number
  ops: GfxOp[]
}

class PendingEffect {
  handler: string = ''
  leaseId: string = ''
  admitted: boolean = false
}

class HostLease {
  handle: ActorHandle
  record: ActorRecord | null
  state: string = 'PENDING'
  pending: number = 0
  editsPending: boolean = false
  releasePromise: Promise<void> | null = null

  constructor(handle: ActorHandle, record: ActorRecord) {
    this.handle = handle
    this.record = record
  }
}

class MailboxEntry {
  kind: string
  lease: HostLease
  handle: ActorHandle
  event: boolean = false
  critical: boolean = false
  coalescing: boolean = false
  key: string = ''
  segment: number = 0
  admissions: number = 0
  inputSeq: number | undefined = undefined
  input: InputEvent | null = null
  tick: TickEvent | null = null
  surface: SurfaceFrameEvent | null = null
  draws: DrawRequest[] = []
  effectId: number = 0
  text: string = ''
  program: ProgramRef | null = null
  options: AcquireOptions | null = null
  saveState: boolean = false
  reopen: boolean = false
  resolveHandle: ((handle: ActorHandle) => void) | null = null
  resolveSnapshot: ((encoded: string) => void) | null = null
  resolveVoid: (() => void) | null = null
  reject: ((error: Error) => void) | null = null

  constructor(kind: string, lease: HostLease) {
    this.kind = kind
    this.lease = lease
    this.handle = lease.handle
  }
}

class ActorRecord {
  appId: string
  program: ProgramRef
  options: AcquireOptions
  actor: HostActor | null = null
  retiring: HostActor | null = null
  frames: Promise<void>[] = []
  closing: boolean = false
  starting: boolean = false
  subscriber: AppSubscriber | null
  leases: Map<string, HostLease> = new Map<string, HostLease>()
  mailbox: MailboxEntry[] = []
  current: MailboxEntry | null = null
  effects: Map<number, PendingEffect> = new Map<number, PendingEffect>()
  vmGeneration: number = 1
  inputSeq: number = 0
  appliedSeq: number = 0
  frameSeq: number = 0
  effectSeq: number = 0
  segment: number = 0
  eventSlots: number = 0
  noncriticalSlots: number = 0
  blockedCritical: boolean = false
  blockedNoncritical: boolean = false
  scheduled: boolean = false
  initialized: boolean = false
  transitioning: boolean = false
  destroyed: boolean = false
  destruction: Promise<void> | null = null
  idleTimer: number = -1
  idleSince: number = 0
  turnFailed: boolean = false
  firstFrameFailed: boolean = false
  requiringFirstFrame: boolean = false
  deliveries: (() => void)[] | null = null

  constructor(appId: string, program: ProgramRef, options: AcquireOptions, subscriber: AppSubscriber) {
    this.appId = appId
    this.program = program
    this.options = options
    this.subscriber = subscriber
  }
}

export class InProcessHost implements EffectResultHost {
  private static instance: InProcessHost | null = null
  private now: () => number
  private registry: Map<string, ActorRecord> = new Map<string, ActorRecord>()
  private leases: Map<string, HostLease> = new Map<string, HostLease>()
  private released: WeakMap<Object, boolean> = new WeakMap<Object, boolean>()
  private ready: ActorRecord[] = []
  private nextIdentity: number = 0
  private nextLease: number = 0
  private draining: boolean = false
  private drainTimer: number = -1
  private disposed: boolean = false
  private disposeResolve: (() => void) | null = null
  private disposeReject: ((error: Error) => void) | null = null
  private disposeFailure: Error | null = null
  private disposePromise: Promise<void> | null = null
  private actorFactory: HostActorFactory | null
  private pending: number = 0
  private idleWaiters: (() => void)[] = []
  private cleanups: WeakMap<Object, Promise<void> | null> = new WeakMap<Object, Promise<void> | null>()

  constructor(now: () => number = () => Date.now(), actorFactory: HostActorFactory | null = null) {
    this.now = now
    this.actorFactory = actorFactory
  }

  whenIdle(): Promise<void> {
    if (this.isIdle()) { return Promise.resolve() }
    return new Promise<void>((resolve) => { this.idleWaiters.push(resolve) })
  }

  private isIdle(): boolean {
    return !this.draining && this.pending === 0 && this.ready.length === 0 && this.drainTimer === -1
  }

  private settleIdle(): void {
    if (!this.isIdle()) { return }
    let waiters = this.idleWaiters
    this.idleWaiters = []
    for (let resolve of waiters) { resolve() }
    if (this.disposed) { this.finishDispose() }
  }

  static get(): InProcessHost {
    if (InProcessHost.instance === null) { InProcessHost.instance = new InProcessHost() }
    return InProcessHost.instance!
  }

  acquire(appId: string, program: ProgramRef, options: AcquireOptions,
      subscriber: AppSubscriber): Promise<ActorHandle> {
    if (this.disposed) { return Promise.reject(new HostOperationFailure('ACTOR_NOT_READY')) }
    let config = this.copyOptions(options)
    let identity: string
    try {
      let requested = this.registry.get(appId)
      identity = this.identity(config, config.mode !== 'LIVE_PERSISTENT' && requested !== undefined ? requested : null)
      if (config.mode === 'LIVE_PERSISTENT' && appId.length > 0 && appId !== identity) {
        throw new HostOperationFailure('APP_ID_CONFLICT')
      }
    } catch (e) {
      return Promise.reject(e as Error)
    }
    let record = this.registry.get(identity)
    if (record !== undefined && record.leases.size === 0 &&
        (this.now() - record.idleSince >= 5000 || !this.compatible(record, program, config))) {
      this.destroyRecord(record)
      record = undefined
    }
    if (record !== undefined) {
      if (record.transitioning || record.closing) { return Promise.reject(new HostOperationFailure('ACTOR_NOT_READY')) }
      if (!this.compatible(record, program, config)) {
        return Promise.reject(new HostOperationFailure('APP_ID_CONFLICT'))
      }
      if (record.leases.size > 0 && record.subscriber !== subscriber) {
        return Promise.reject(new HostOperationFailure('SUBSCRIBER_CONFLICT'))
      }
      if (record.initialized && !record.actor!.ready()) {
        return Promise.reject(new HostOperationFailure('ACTOR_NOT_READY'))
      }
    }
    let initialize = record === undefined
    if (record === undefined) {
      record = new ActorRecord(identity, this.copyProgram(program), config, subscriber)
      this.createActor(record)
      this.registry.set(identity, record)
    }
    let target = record
    if (target.idleTimer !== -1) { clearTimeout(target.idleTimer); target.idleTimer = -1 }
    target.subscriber = subscriber
    let reopen = !initialize && target.initialized && target.leases.size === 0
    let lease = this.createLease(target)
    let entry = new MailboxEntry(initialize ? 'INITIALIZE' : 'ACQUIRE', lease)
    entry.reopen = reopen
    let promise = new Promise<ActorHandle>((resolve, reject) => {
      entry.resolveHandle = resolve
      entry.reject = reject
    })
    this.control(target, entry)
    return promise
  }

  promote(handle: ActorHandle, mode: RuntimeMode, persistKey: string): Promise<ActorHandle> {
    let lease = this.activeLease(handle)
    if (lease === null) { return Promise.reject(new HostOperationFailure('INVALID_HANDLE')) }
    let entry = new MailboxEntry('PROMOTE', lease)
    entry.options = { mode: mode, persistKey: mode === 'LIVE_PERSISTENT' ? persistKey : '', seedState: '' }
    return this.lifecycle(lease.record!, entry)
  }

  replaceProgram(handle: ActorHandle, program: ProgramRef, options: AcquireOptions): Promise<ActorHandle> {
    let lease = this.activeLease(handle)
    if (lease === null) { return Promise.reject(new HostOperationFailure('INVALID_HANDLE')) }
    let entry = new MailboxEntry('REPLACE', lease)
    entry.program = this.copyProgram(program)
    entry.options = this.copyOptions(options)
    return this.lifecycle(lease.record!, entry)
  }

  release(handle: ActorHandle, options?: ReleaseOptions): Promise<void> {
    if (this.released.has(handle)) { return Promise.resolve() }
    let lease = this.leases.get(handle.leaseId)
    if (lease === undefined || !this.matches(lease, handle)) {
      return Promise.reject(new HostOperationFailure('INVALID_HANDLE'))
    }
    if (lease.state === 'RELEASED') { return Promise.resolve() }
    if (lease.releasePromise !== null) { return lease.releasePromise! }
    if (this.disposed || lease.record === null) {
      return Promise.reject(new HostOperationFailure('INVALID_HANDLE'))
    }
    lease.state = 'CLOSING'
    let entry = new MailboxEntry('RELEASE', lease)
    entry.saveState = options !== undefined && options.saveState === true
    let promise = new Promise<void>((resolve, reject) => {
      entry.resolveVoid = resolve
      entry.reject = reject
    })
    lease.releasePromise = promise
    this.control(lease.record!, entry)
    return promise
  }

  postInput(handle: ActorHandle, input: InputEvent): AdmissionResult {
    let lease = this.liveLease(handle)
    if (lease === null) { return this.rejected(handle) }
    if (input.appId !== handle.appId || input.vmGeneration !== handle.vmGeneration) {
      return { status: 'REJECTED', reason: 'STALE_EVENT' }
    }
    if (input.kind !== 'HANDLER' && input.kind !== 'FIELD' && input.kind !== 'BACK' && input.kind !== 'SCENE' &&
        input.kind !== 'SURFACE_DOWN' && input.kind !== 'SURFACE_MOVE' &&
        input.kind !== 'SURFACE_UP' && input.kind !== 'SURFACE_CANCEL') {
      return { status: 'REJECTED', reason: 'INVALID_INPUT' }
    }
    if (!this.validPayload(input.payload) || input.action.length === 0 ||
        (input.kind === 'SCENE' && input.payload.kind !== 'SCENE') ||
        (input.skipIfSame !== undefined && typeof input.skipIfSame !== 'boolean')) {
      return { status: 'REJECTED', reason: 'INVALID_INPUT' }
    }
    let entry = new MailboxEntry(input.kind === 'SURFACE_MOVE' ? 'MOVE' : 'INPUT', lease)
    let payload: InputPayload = {
      kind: input.payload.kind, num: input.payload.num, str: input.payload.str,
      bool: input.payload.bool, phase: input.payload.phase, id: input.payload.id,
      x: input.payload.x, y: input.payload.y
    }
    if (input.payload.scene !== undefined) {
      let scene = input.payload.scene
      payload.scene = { kind: scene.kind, body: scene.body, other: scene.other,
        x: scene.x, y: scene.y, z: scene.z, speed: scene.speed,
        bodies: scene.bodies.slice(), values: scene.values.slice(),
        dir: scene.dir === undefined ? undefined : scene.dir.slice() }
    }
    entry.input = {
      appId: input.appId, vmGeneration: input.vmGeneration, kind: input.kind,
      action: input.action, payload: payload, persist: input.persist, draws: this.copyDraws(input.draws),
      skipIfSame: input.skipIfSame
    }
    entry.coalescing = entry.kind === 'MOVE'
    entry.key = input.action + ':' + input.payload.id.toString()
    return this.admit(lease.record!, entry, !entry.coalescing)
  }

  postTick(handle: ActorHandle, tick: TickEvent, ordered: boolean): AdmissionResult {
    let lease = this.liveLease(handle)
    if (lease === null) { return this.rejected(handle) }
    if (tick.action.length === 0 || tick.tickerId.length === 0) {
      return { status: 'REJECTED', reason: 'INVALID_TICK' }
    }
    let entry = new MailboxEntry('TICK', lease)
    entry.tick = { tickerId: tick.tickerId, action: tick.action, elapsed: tick.elapsed }
    entry.coalescing = !ordered
    entry.key = tick.tickerId
    return this.admit(lease.record!, entry, ordered)
  }

  postSurfaceFrame(handle: ActorHandle, frame: SurfaceFrameEvent): AdmissionResult {
    let lease = this.liveLease(handle)
    if (lease === null) { return this.rejected(handle) }
    let entry = new MailboxEntry('SURFACE_FRAME', lease)
    entry.surface = { elapsed: frame.elapsed, actions: frame.actions.slice(), draws: this.copyDraws(frame.draws),
      loopStartedAt: frame.loopStartedAt, worldOnly: frame.worldOnly, worldStopping: frame.worldStopping }
    entry.coalescing = frame.worldOnly !== true && frame.worldStopping !== true
    entry.critical = frame.worldStopping === true
    entry.key = frame.worldOnly === true ? 'world' : 'surface'
    return this.admit(lease.record!, entry, false)
  }

  postRefresh(handle: ActorHandle, source: 'APP'): AdmissionResult {
    let lease = this.liveLease(handle)
    if (lease === null) { return this.rejected(handle) }
    if (source !== 'APP') { return { status: 'REJECTED', reason: 'INVALID_SOURCE' } }
    let entry = new MailboxEntry('APP_RESUME', lease)
    entry.critical = true
    return this.admit(lease.record!, entry, false)
  }

  requestView(handle: ActorHandle): AdmissionResult {
    let lease = this.activeLease(handle)
    if (lease === null) { return this.rejected(handle) }
    if (!lease.record!.transitioning && !lease.record!.starting &&
        (!lease.record!.initialized || !lease.record!.actor!.ready())) {
      return { status: 'REJECTED', reason: 'ACTOR_NOT_READY' }
    }
    let entry = new MailboxEntry('VIEW', lease)
    entry.coalescing = true
    entry.key = 'view'
    return this.admit(lease.record!, entry, false)
  }

  requestDraw(handle: ActorHandle, draws: DrawRequest[]): AdmissionResult {
    let lease = this.activeLease(handle)
    if (lease === null) { return this.rejected(handle) }
    if (!lease.record!.transitioning && !lease.record!.starting &&
        (!lease.record!.initialized || !lease.record!.actor!.ready())) {
      return { status: 'REJECTED', reason: 'ACTOR_NOT_READY' }
    }
    let record = lease.record!
    if (draws.length === 0) { return { status: 'ACCEPTED' } }
    let unique: Map<string, DrawRequest> = new Map<string, DrawRequest>()
    for (let draw of this.copyDraws(draws)) { unique.set(this.drawKey(draw), draw) }
    let index: Map<string, MailboxEntry> = new Map<string, MailboxEntry>()
    for (let candidate of record.mailbox) {
      if (candidate.kind === 'DRAW' && candidate.lease === lease && candidate.segment === record.segment) {
        for (let prior of candidate.draws) { index.set(this.drawKey(prior), candidate) }
      }
    }
    let missing: DrawRequest[] = []
    let touched: Set<MailboxEntry> = new Set<MailboxEntry>()
    unique.forEach((draw: DrawRequest) => {
      let match = index.get(this.drawKey(draw))
      if (match === undefined) { missing.push(draw) }
      else { touched.add(match) }
    })
    if (!this.capacity(record, false, missing.length > 0 ? 1 : 0)) { return { status: 'BACKPRESSURE' } }
    touched.forEach((entry: MailboxEntry) => {
      for (let index = 0; index < entry.draws.length; index++) {
        let replacement = unique.get(this.drawKey(entry.draws[index]))
        if (replacement !== undefined) { entry.draws[index] = replacement }
      }
      entry.admissions++
      entry.lease.pending++
    })
    if (missing.length > 0) {
      let entry = new MailboxEntry('DRAW', lease)
      entry.coalescing = true
      entry.key = 'batch'
      entry.draws = missing
      this.enqueueEvent(record, entry, false)
    }
    this.kick(record)
    if (missing.length === 0) { return { status: 'COALESCED' } }
    return { status: 'ACCEPTED' }
  }

  postEffectResult(handle: ActorHandle, effectId: number, text: string): AdmissionResult {
    let lease = this.liveLease(handle)
    if (lease === null) { return this.rejected(handle) }
    let effect = lease.record!.effects.get(effectId)
    if (effect === undefined || effect.leaseId !== handle.leaseId || effect.admitted) {
      return { status: 'REJECTED', reason: 'STALE_EFFECT' }
    }
    let entry = new MailboxEntry('EFFECT_RESULT', lease)
    entry.critical = true
    entry.effectId = effectId
    entry.text = text
    return this.admit(lease.record!, entry, true)
  }

  requestSnapshot(handle: ActorHandle): Promise<string> {
    let lease = this.liveLease(handle)
    if (lease === null) { return Promise.reject(new HostOperationFailure('INVALID_HANDLE')) }
    let entry = new MailboxEntry('SNAPSHOT', lease)
    let promise = new Promise<string>((resolve, reject) => {
      entry.resolveSnapshot = resolve
      entry.reject = reject
    })
    this.control(lease.record!, entry)
    return promise
  }

  notifyEdits(handle: ActorHandle, pending: boolean): void {
    let lease = this.activeLease(handle)
    if (lease !== null) { lease.editsPending = pending }
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== null) { return this.disposePromise! }
    this.disposed = true
    if (this.drainTimer !== -1) { clearTimeout(this.drainTimer); this.drainTimer = -1 }
    this.ready = []
    let promise = new Promise<void>((resolve, reject) => {
      this.disposeResolve = resolve
      this.disposeReject = reject
    })
    this.disposePromise = promise
    this.pending++
    this.registry.forEach((record: ActorRecord) => {
      record.actor!.cancel()
      this.discard(record, () => true, 'ACTOR_NOT_READY')
      if (record.current === null) { this.destroyRecord(record) }
      else if (record.idleTimer !== -1) { clearTimeout(record.idleTimer); record.idleTimer = -1 }
    })
    this.registry.clear()
    this.leases.clear()
    this.pending--
    this.settleIdle()
    return promise
  }

  private copyProgram(program: ProgramRef): ProgramRef {
    return { vbc2: program.vbc2, stamp: program.stamp }
  }

  private copyOptions(options: AcquireOptions): AcquireOptions {
    return { mode: options.mode, persistKey: options.mode === 'LIVE_PERSISTENT' ? options.persistKey : '',
      seedState: options.mode === 'PREVIEW' ? '' : options.seedState }
  }

  private drawKey(draw: DrawRequest): string {
    return draw.surfaceRevision.toString() + ':' + draw.nodeId.toString()
  }

  private copyDraws(draws: DrawRequest[]): DrawRequest[] {
    return draws.map((draw: DrawRequest): DrawRequest => ({ nodeId: draw.nodeId, entry: draw.entry,
      surfaceRevision: draw.surfaceRevision }))
  }

  private identity(options: AcquireOptions, current: ActorRecord | null): string {
    if (options.mode === 'LIVE_PERSISTENT') {
      if (options.persistKey.length === 0) { throw new HostOperationFailure('APP_ID_CONFLICT') }
      return options.persistKey
    }
    if (options.mode !== 'PREVIEW' && options.mode !== 'LIVE_EPHEMERAL') {
      throw new HostOperationFailure('ACTOR_NOT_READY')
    }
    if (current !== null && current.options.mode === options.mode) { return current.appId }
    let identity = ''
    do {
      identity = (options.mode === 'PREVIEW' ? 'preview:' : 'live:') + (++this.nextIdentity).toString()
    } while (this.registry.has(identity))
    return identity
  }

  private compatible(record: ActorRecord, program: ProgramRef, options: AcquireOptions): boolean {
    return record.program.stamp === program.stamp && record.options.mode === options.mode &&
      record.options.persistKey === options.persistKey
  }

  private createLease(record: ActorRecord): HostLease {
    let handle: ActorHandle = { appId: record.appId, vmGeneration: record.vmGeneration,
      leaseId: 'lease:' + (++this.nextLease).toString() }
    let lease = new HostLease(handle, record)
    record.leases.set(handle.leaseId, lease)
    this.leases.set(handle.leaseId, lease)
    return lease
  }

  private matches(lease: HostLease, handle: ActorHandle): boolean {
    return lease.handle === handle && lease.handle.appId === handle.appId &&
      lease.handle.vmGeneration === handle.vmGeneration && lease.handle.leaseId === handle.leaseId
  }

  private activeLease(handle: ActorHandle): HostLease | null {
    if (this.disposed) { return null }
    let lease = this.leases.get(handle.leaseId)
    if (lease === undefined || lease.state !== 'ACTIVE' || !this.matches(lease, handle) ||
        lease.record === null || lease.record.destroyed ||
        (!lease.record.transitioning &&
          (lease.record.appId !== handle.appId || lease.record.vmGeneration !== handle.vmGeneration))) { return null }
    return lease
  }

  private liveLease(handle: ActorHandle): HostLease | null {
    let lease = this.activeLease(handle)
    if (lease === null || (!lease.record!.transitioning && !lease.record!.starting &&
        (!lease.record!.initialized || !lease.record!.actor!.ready())) ||
        lease.record!.options.mode === 'PREVIEW') { return null }
    return lease
  }

  private rejected(handle: ActorHandle): AdmissionResult {
    if (this.disposed) { return { status: 'REJECTED', reason: 'DISPOSED' } }
    let lease = this.activeLease(handle)
    if (lease === null) { return { status: 'REJECTED', reason: 'INVALID_HANDLE' } }
    if (lease.record!.options.mode === 'PREVIEW') { return { status: 'REJECTED', reason: 'PREVIEW' } }
    return { status: 'REJECTED', reason: 'ACTOR_NOT_READY' }
  }

  private validScene(scene: SceneEventPayload | undefined): boolean {
    if (scene === undefined || scene === null || typeof scene !== 'object' ||
        typeof scene.kind !== 'string' || typeof scene.body !== 'string' || typeof scene.other !== 'string' ||
        typeof scene.x !== 'number' || !Number.isFinite(scene.x) ||
        typeof scene.y !== 'number' || !Number.isFinite(scene.y) ||
        typeof scene.z !== 'number' || !Number.isFinite(scene.z) ||
        typeof scene.speed !== 'number' || !Number.isFinite(scene.speed) ||
        !Array.isArray(scene.bodies) || !Array.isArray(scene.values)) { return false }
    for (let body of scene.bodies) { if (typeof body !== 'string') { return false } }
    for (let value of scene.values) {
      if (typeof value !== 'number' || !Number.isFinite(value)) { return false }
    }
    if (scene.dir !== undefined) {
      if (!Array.isArray(scene.dir)) { return false }
      for (let value of scene.dir) {
        if (typeof value !== 'number' || !Number.isFinite(value)) { return false }
      }
    }
    return true
  }

  private validPayload(payload: InputPayload): boolean {
    if (payload === null || payload === undefined ||
        (payload.scene !== undefined && !this.validScene(payload.scene))) { return false }
    if (payload.kind === 'SCENE') { return this.validScene(payload.scene) }
    return payload.kind === 'NONE' || payload.kind === 'NUMBER' || payload.kind === 'STRING' ||
      payload.kind === 'BOOLEAN' || payload.kind === 'POINTER'
  }

  private payload(payload: InputPayload): RuntimeValue {
    switch (payload.kind) {
      case 'NUMBER': return new VeraNumberValue(payload.num)
      case 'STRING': return new VeraStringValue(payload.str)
      case 'BOOLEAN': return new VeraBooleanValue(payload.bool)
      case 'POINTER': return pointerValue(payload.phase, payload.id, payload.x, payload.y)
      case 'SCENE': {
        let scene = payload.scene!
        return sceneEventValue(scene.kind, scene.body, scene.other, scene.x, scene.y, scene.z,
          scene.speed, scene.bodies, scene.values, scene.dir === undefined ? [0, 0, 0] : scene.dir)
      }
      default: return new VeraNumberValue(0)
    }
  }

  private lifecycle(record: ActorRecord, entry: MailboxEntry): Promise<ActorHandle> {
    let promise = new Promise<ActorHandle>((resolve, reject) => {
      entry.resolveHandle = resolve
      entry.reject = reject
    })
    this.control(record, entry)
    return promise
  }

  private control(record: ActorRecord, entry: MailboxEntry): void {
    record.segment++
    entry.segment = record.segment
    record.mailbox.push(entry)
    record.segment++
    this.kick(record)
  }

  private capacity(record: ActorRecord, critical: boolean, slots: number = 1): boolean {
    if (slots === 0 || (record.eventSlots + slots <= 256 &&
        (critical || record.noncriticalSlots + slots <= 240))) { return true }
    if (critical) { record.blockedCritical = true } else { record.blockedNoncritical = true }
    return false
  }

  private admit(record: ActorRecord, entry: MailboxEntry, ordered: boolean): AdmissionResult {
    if (entry.coalescing) {
      let prior = record.mailbox.find((candidate: MailboxEntry): boolean => candidate.coalescing &&
        candidate.kind === entry.kind && candidate.key === entry.key &&
        candidate.lease === entry.lease && candidate.segment === record.segment)
      if (prior !== undefined) {
        if (entry.kind === 'TICK') {
          prior.tick = { tickerId: entry.tick!.tickerId, action: entry.tick!.action,
            elapsed: prior.tick!.elapsed + entry.tick!.elapsed }
        } else if (entry.kind === 'SURFACE_FRAME') {
          prior.surface = { elapsed: Math.min(100, prior.surface!.elapsed + entry.surface!.elapsed),
            actions: entry.surface!.actions, draws: entry.surface!.draws,
            loopStartedAt: entry.surface!.loopStartedAt !== undefined
              ? entry.surface!.loopStartedAt : prior.surface!.loopStartedAt,
            worldOnly: entry.surface!.worldOnly, worldStopping: entry.surface!.worldStopping }
        } else if (entry.kind === 'MOVE') {
          prior.input = entry.input
        }
        prior.admissions++
        entry.lease.pending++
        return { status: 'COALESCED' }
      }
    }
    if (!this.capacity(record, entry.critical)) { return { status: 'BACKPRESSURE' } }
    this.enqueueEvent(record, entry, ordered)
    let result: AdmissionResult = { status: 'ACCEPTED', inputSeq: entry.inputSeq }
    this.kick(record)
    return result
  }

  private enqueueEvent(record: ActorRecord, entry: MailboxEntry, ordered: boolean): void {
    entry.event = true
    entry.admissions++
    entry.lease.pending++
    if (!entry.coalescing) { record.segment++ }
    entry.segment = record.segment
    if (ordered) { entry.inputSeq = ++record.inputSeq }
    if (entry.kind === 'EFFECT_RESULT') { record.effects.get(entry.effectId)!.admitted = true }
    record.eventSlots++
    if (!entry.critical) { record.noncriticalSlots++ }
    record.mailbox.push(entry)
    if (!entry.coalescing) { record.segment++ }
  }

  private kick(record: ActorRecord): void {
    if (this.disposed || record.destroyed) { return }
    if (record.current === null && record.mailbox.length > 0 && !record.scheduled) {
      record.scheduled = true
      this.ready.push(record)
    }
    if (!this.draining && this.drainTimer === -1) { this.drain() }
  }

  private drain(): void {
    if (this.draining || this.disposed) { return }
    this.draining = true
    let started = this.now()
    let turns = 0
    try {
      while (!this.disposed && this.ready.length > 0) {
        let record = this.ready.shift()!
        record.scheduled = false
        if (record.destroyed || record.current !== null || record.mailbox.length === 0) { continue }
        let entry = record.mailbox.shift()!
        this.freeSlot(record, entry)
        record.current = entry
        record.turnFailed = false
        this.pending++
        let turn = attempt<void>(() => this.runTurn(record, entry),
          (error: Error): void => { this.failTurn(record, entry, error) })
        let result = chain(turn, () => this.awaitFrames(record))
        if (result instanceof Promise) {
          result.then(() => this.finishTurn(record, entry),
            (error: Error) => {
              this.failTurn(record, entry, error)
              this.finishTurn(record, entry)
            })
        } else { this.finishTurn(record, entry) }
        turns++
        if (this.now() - started >= 8 || turns >= 256) { break }
      }
    } finally {
      this.draining = false
      if (!this.disposed && this.ready.length > 0 && this.drainTimer === -1) {
        this.drainTimer = setTimeout(() => {
          this.drainTimer = -1
          this.drain()
        }, 0)
      }
      this.settleIdle()
    }
  }

  private failTurn(record: ActorRecord, entry: MailboxEntry, error: Error): void {
    if (entry.reject !== null) { entry.reject!(error) }
    else { this.report(record, this.turnKind(entry), error.message) }
  }

  private finishTurn(record: ActorRecord, entry: MailboxEntry): void {
    this.complete(entry)
    record.current = null
    this.pending--
    if (this.disposed) { this.destroyRecord(record) }
    else {
      this.writable(record)
      this.kick(record)
    }
    this.settleIdle()
  }

  private awaitFrames(record: ActorRecord): void | Promise<void> {
    if (record.frames.length === 0) { return }
    let frames = record.frames
    record.frames = []
    return Promise.all(frames).then(() => this.awaitFrames(record))
  }

  private freeSlot(record: ActorRecord, entry: MailboxEntry): void {
    if (!entry.event) { return }
    record.eventSlots--
    if (!entry.critical) { record.noncriticalSlots-- }
  }

  private complete(entry: MailboxEntry): void {
    entry.lease.pending -= entry.admissions
    entry.admissions = 0
  }

  private writable(record: ActorRecord): void {
    if (record.destroyed || record.subscriber === null || record.leases.size === 0) { return }
    let available = false
    if (record.blockedCritical && record.eventSlots < 256) {
      record.blockedCritical = false
      available = true
    }
    if (record.blockedNoncritical && record.eventSlots < 256 && record.noncriticalSlots < 240) {
      record.blockedNoncritical = false
      available = true
    }
    if (available) { this.safe(() => record.subscriber!.onMailboxWritable()) }
  }

  private validEntry(record: ActorRecord, entry: MailboxEntry): boolean {
    return !record.destroyed && entry.lease.record === record && entry.lease.state !== 'RELEASED' &&
      this.matches(entry.lease, entry.handle) && record.appId === entry.handle.appId &&
      record.vmGeneration === entry.handle.vmGeneration
  }

  private runTurn(record: ActorRecord, entry: MailboxEntry): void | Promise<void> {
    if (!this.validEntry(record, entry)) {
      if ((entry.kind === 'INITIALIZE' || entry.kind === 'ACQUIRE') && entry.lease.record === record) {
        this.removeLease(record, entry.lease)
      }
      throw new HostOperationFailure('INVALID_HANDLE')
    }
    if (entry.kind === 'INITIALIZE' || entry.kind === 'ACQUIRE') {
      return this.activate(record, entry)
    }
    if (entry.kind === 'RELEASE') {
      return this.finishRelease(record, entry)
    }
    if (entry.kind === 'PROMOTE' || entry.kind === 'REPLACE') {
      return this.changeRuntime(record, entry)
    }
    if (!record.initialized || !record.actor!.ready()) { throw new HostOperationFailure('ACTOR_NOT_READY') }
    let actor = record.actor!
    switch (entry.kind) {
      case 'SNAPSHOT':
        return chain(actor.snapshot(), (encoded: string): void => {
          if (this.disposed || !this.validEntry(record, entry)) {
            throw new HostOperationFailure('ACTOR_NOT_READY')
          }
          entry.resolveSnapshot!(encoded)
        })
      case 'INPUT':
        return actor.dispatch(entry.input!.action, this.payload(entry.input!.payload), entry.input!.persist,
          entry.input!.kind, entry.input!.skipIfSame || false)
      case 'TICK':
        return actor.dispatch(entry.tick!.action, new VeraNumberValue(entry.tick!.elapsed), true, 'TICK')
      case 'EFFECT_RESULT': {
        let effect = record.effects.get(entry.effectId)
        record.effects.delete(entry.effectId)
        if (effect === undefined) { return }
        StageTrace.emit(record, 'EFFECT_RESULT', { id: entry.effectId, resultHandler: effect.handler,
          generation: entry.handle.vmGeneration,
          outcome: entry.text.startsWith('declined') ? 'DECLINED' : entry.text.startsWith('error') ? 'ERROR' : 'OK' })
        return actor.dispatch(effect.handler, new VeraStringValue(entry.text), true, 'EFFECT_RESULT')
      }
      case 'APP_RESUME':
        return actor.resume()
      case 'VIEW':
        return this.render(record, false)
      case 'DRAW':
        return this.surfaceRender(record, entry.draws, false, 0)
      case 'SURFACE_FRAME': {
        let started = this.now()
        if (entry.surface!.loopStartedAt !== undefined) { actor.beginSurfaceLoop(entry.surface!.loopStartedAt!) }
        if (entry.surface!.worldOnly === true) {
          return chain(actor.worldSave(Date.now(), this.editsPending(record), entry.surface!.worldStopping === true),
            (save: string): void => {
              StageTrace.emit(record, 'SURFACE_FRAME', { actions: [], draws: [], save: save })
            })
        }
        let actions: string[] = entry.surface!.actions
        let frameDraws: DrawRequest[] = entry.surface!.draws
        return attempt<void>(() => chain(actor.frameHandlers(actions, entry.surface!.elapsed), () => {
          if (this.disposed) { return }
          return chain(this.surfaceRender(record, frameDraws, actor.viewDue(this.now()), this.now() - started), () => {
            if (record.turnFailed || this.disposed) { return }
            return chain(actor.surfaceSave(this.now(), this.editsPending(record)), (save: string): void => {
              StageTrace.emit(record, 'SURFACE_FRAME', {
                actions: actions,
                draws: frameDraws.map((draw: DrawRequest): string => draw.entry),
                save: save === 'NOT_SAVED' ? 'NOT_DUE' : save
              })
            })
          })
        }), (error: Error): void => {
          actor.clearEffects()
          this.report(record, 'frame', error.message)
        })
      }
      case 'MOVE': {
        let started = this.now()
        return attempt<void>(() => chain(actor.move(entry.input!.action, this.payload(entry.input!.payload)), () => {
          if (entry.inputSeq !== undefined) { record.appliedSeq = Math.max(record.appliedSeq, entry.inputSeq!) }
          if (this.disposed || entry.input!.draws.length === 0) { return }
          return this.surfaceRender(record, entry.input!.draws, actor.viewDue(this.now()), this.now() - started)
        }), (error: Error): void => {
          actor.clearEffects()
          this.report(record, 'move', error.message)
        })
      }
    }
  }

  private activate(record: ActorRecord, entry: MailboxEntry): void | Promise<void> {
    let frameSeq = record.frameSeq
    record.starting = true
    return attempt<void>(() => {
      let startup: void | Promise<void> = undefined
      if (entry.kind === 'INITIALIZE') {
        record.firstFrameFailed = false
        record.requiringFirstFrame = true
        startup = record.actor!.initialize(record.program, record.options, false)
      } else if (record.actor!.ready()) {
        if (entry.reopen) {
          record.firstFrameFailed = false
          record.requiringFirstFrame = true
          startup = record.actor!.reconcileState()
        }
        startup = chain(startup, () => {
          if (this.disposed) { throw new HostOperationFailure('ACTOR_NOT_READY') }
          return chain(record.actor!.notifyStateSnapshot(), () => this.render(record, false))
        })
      }
      return chain(startup, () => chain(this.awaitFrames(record), () => {
        if (this.disposed || record.destroyed || !record.actor!.ready() || record.turnFailed ||
            record.firstFrameFailed || record.frameSeq === frameSeq) {
          throw new HostOperationFailure('ACTOR_NOT_READY')
        }
        record.initialized = true
        record.requiringFirstFrame = false
        let refresh = entry.kind === 'INITIALIZE' || entry.reopen ? record.actor!.runWidgetRefresh() : undefined
        return chain(refresh, () => chain(this.awaitFrames(record), () => {
          if (this.disposed || record.destroyed || !record.actor!.ready()) {
            throw new HostOperationFailure('ACTOR_NOT_READY')
          }
          record.starting = false
          entry.lease.state = 'ACTIVE'
          entry.resolveHandle!(entry.lease.handle)
        }))
      }))
    }, (_: Error): void | Promise<void> => {
      record.requiringFirstFrame = false
      return chain(attempt<void>(() => this.awaitFrames(record), () => undefined), () => {
        record.starting = false
        let cleanup = entry.kind === 'INITIALIZE' ? this.destroyRecord(record) : undefined
        if (entry.kind !== 'INITIALIZE' && entry.lease.record === record) { this.removeLease(record, entry.lease) }
        return chain(cleanup, (): void => { throw new HostOperationFailure('ACTOR_NOT_READY') })
      })
    })
  }

  private changeRuntime(record: ActorRecord, entry: MailboxEntry): void | Promise<void> {
    let active = 0
    record.leases.forEach((lease: HostLease) => {
      if (lease.state === 'ACTIVE' || lease.state === 'CLOSING') { active++ }
    })
    if (active !== 1) { throw new HostOperationFailure('LEASE_CONFLICT') }
    if (!record.initialized || !record.actor!.ready()) { throw new HostOperationFailure('ACTOR_NOT_READY') }
    let options = entry.options!
    let identity = this.identity(options, record)
    let owner = this.registry.get(identity)
    if (owner !== undefined && owner !== record) { throw new HostOperationFailure('APP_ID_CONFLICT') }
    if (entry.kind === 'PROMOTE' && identity === record.appId && options.mode === record.options.mode) {
      entry.resolveHandle!(entry.lease.handle)
      return
    }
    let oldActor = record.actor!
    let oldAppId = record.appId
    let oldProgram = record.program
    let oldOptions = record.options
    let oldGeneration = record.vmGeneration
    let oldFrameSeq = record.frameSeq
    let oldAppliedSeq = record.appliedSeq
    let oldFirstFrameFailed = record.firstFrameFailed
    let committed = false
    record.transitioning = true
    record.deliveries = []
    record.firstFrameFailed = false
    record.requiringFirstFrame = true
    this.registry.set(identity, record)
    return attempt<void>(() => {
      record.appId = identity
      record.options = options
      let startup: void | Promise<void> = undefined
      if (entry.kind === 'REPLACE') {
        record.retiring = oldActor
        record.program = entry.program!
        record.vmGeneration++
        record.frameSeq = 0
        this.createActor(record)
        startup = record.actor!.initialize(record.program, options, false)
      } else { startup = record.actor!.promote(options) }
      return chain(startup, () => chain(this.awaitFrames(record), () => {
        if (this.disposed || record.destroyed || !record.actor!.ready() || record.turnFailed || record.firstFrameFailed ||
            record.frameSeq === (entry.kind === 'REPLACE' ? 0 : oldFrameSeq)) {
          throw new HostOperationFailure('ACTOR_NOT_READY')
        }
        let save: boolean | Promise<boolean> = true
        if (entry.kind === 'REPLACE' && oldOptions.mode === 'LIVE_PERSISTENT' && oldActor.worldDirty()) {
          save = oldActor.saveNow()
        }
        return chain(save, (saved: boolean) => {
          if (!saved || this.disposed || record.destroyed) { throw new HostOperationFailure('ACTOR_NOT_READY') }
          record.requiringFirstFrame = false
          let deliveries = record.deliveries!
          record.deliveries = null
          let handle: ActorHandle = { appId: identity, vmGeneration: record.vmGeneration,
            leaseId: entry.lease.handle.leaseId }
          entry.lease.handle = handle
          if (entry.kind === 'REPLACE') { entry.lease.editsPending = false }
          this.discard(record, (pending: MailboxEntry): boolean => pending.kind !== 'RELEASE' &&
            pending.kind !== 'PROMOTE' && pending.kind !== 'REPLACE', 'INVALID_HANDLE')
          for (let pending of record.mailbox) {
            if ((pending.kind === 'RELEASE' || pending.kind === 'PROMOTE' || pending.kind === 'REPLACE') &&
                pending.lease === entry.lease) { pending.handle = handle }
          }
          record.effects.clear()
          committed = true
           let cleanup = entry.kind === 'REPLACE' ? this.cleanupActor(oldActor) : undefined
           return chain(cleanup, () => {
             record.retiring = null
            for (let delivery of deliveries) {
              if (this.disposed) { break }
              this.safe(delivery)
            }
            if (this.disposed || !record.actor!.ready()) { throw new HostOperationFailure('ACTOR_NOT_READY') }
            let refresh: void | Promise<void> = undefined
            if (entry.kind === 'REPLACE' ||
                (entry.kind === 'PROMOTE' && oldOptions.mode === 'PREVIEW' && options.mode !== 'PREVIEW')) {
              refresh = record.actor!.runWidgetRefresh()
            }
            return chain(refresh, () => chain(this.awaitFrames(record), () => {
              if (this.disposed || !record.actor!.ready()) { throw new HostOperationFailure('ACTOR_NOT_READY') }
              if (identity !== oldAppId && this.registry.get(oldAppId) === record) { this.registry.delete(oldAppId) }
              record.transitioning = false
              entry.resolveHandle!(handle)
            }))
          })
        })
      }))
    }, (error: Error): void | Promise<void> => {
      record.requiringFirstFrame = false
      if (committed) {
        record.deliveries = null
        let failure = error
        let cleanup = attempt<void>(() => this.destroyRecord(record), (cleanupError: Error): void => {
          failure = cleanupError
        })
        return chain(cleanup, () => chain(attempt<void>(() => this.awaitFrames(record), () => undefined), (): void => {
          record.transitioning = false
          throw failure
        }))
      }
      let candidate = record.actor!
      record.actor = oldActor
      record.retiring = null
      record.appId = oldAppId
      record.program = oldProgram
      record.options = oldOptions
      record.vmGeneration = oldGeneration
      record.frameSeq = oldFrameSeq
      record.appliedSeq = oldAppliedSeq
      record.firstFrameFailed = oldFirstFrameFailed
      if (!this.disposed && !record.destroyed) { this.registry.set(oldAppId, record) }
      let failure: Error | null = null
      let cleanup = attempt<void>(() => entry.kind === 'REPLACE' ? this.cleanupActor(candidate) :
        !this.disposed ? oldActor.promote(oldOptions) : undefined, (cleanupError: Error): void => {
        failure = cleanupError
      })
      return chain(cleanup, () => chain(attempt<void>(() => this.awaitFrames(record), () => undefined), (): void => {
        if (identity !== oldAppId && this.registry.get(identity) === record) { this.registry.delete(identity) }
        record.deliveries = null
        record.transitioning = false
        if (failure !== null) { throw failure! }
        throw new HostOperationFailure('ACTOR_NOT_READY')
      }))
    })
  }

  private finishRelease(record: ActorRecord, entry: MailboxEntry): void | Promise<void> {
    let last = record.leases.size === 1
    record.closing = last
    let failure: Error | null = null
    return chain(attempt<void>(() => {
      if (last && entry.saveState && record.options.mode === 'LIVE_PERSISTENT') {
        return chain(record.actor!.saveNow(), (saved: boolean): void => {
          if (!saved) { throw new HostOperationFailure('ACTOR_NOT_READY') }
        })
      }
    }, (error: Error): void => { failure = error }), () => {
      let cleanup = attempt<void>(() => this.disposed ? this.cleanupActor(record.actor!) :
        last && record.actor!.quiesce !== undefined ? record.actor!.quiesce!() : undefined, (error: Error): void => {
        if (failure === null) { failure = error }
      })
      return chain(cleanup, () => {
        let teardown = attempt<void>(() => this.disposed ? this.destroyRecord(record) : undefined,
          (error: Error): void => { if (failure === null) { failure = error } })
        return chain(teardown, () => {
          if (failure !== null) { this.report(record, 'state', failure!.message) }
          if (entry.lease.record === record) { this.removeLease(record, entry.lease) }
          record.closing = false
          if (failure !== null) { entry.reject!(failure!) }
          else { entry.resolveVoid!() }
        })
      })
    })
  }

  private removeLease(record: ActorRecord, lease: HostLease): void {
    lease.state = 'RELEASED'
    lease.editsPending = false
    lease.record = null
    record.leases.delete(lease.handle.leaseId)
    this.leases.delete(lease.handle.leaseId)
    this.released.set(lease.handle, true)
    let stale: number[] = []
    record.effects.forEach((effect: PendingEffect, id: number) => {
      if (effect.leaseId === lease.handle.leaseId) { stale.push(id) }
    })
    for (let id of stale) { record.effects.delete(id) }
    if (record.leases.size === 0) {
      record.subscriber = null
      record.blockedCritical = false
      record.blockedNoncritical = false
      if (!this.disposed && !record.destroyed) {
        record.idleSince = this.now()
        record.idleTimer = setTimeout(() => {
          record.idleTimer = -1
          if (record.leases.size === 0) { this.destroyRecord(record) }
        }, 5000)
      }
    }
  }

  private editsPending(record: ActorRecord): boolean {
    let pending = false
    record.leases.forEach((lease: HostLease) => { if (lease.editsPending) { pending = true } })
    return pending
  }

  private createActor(record: ActorRecord): void {
    let actor: HostActor | null = null
    let owns = (): boolean => !this.disposed && !record.destroyed && record.actor === actor
    let callbacks: AppActorCallbacks = {
      render: (_paint: boolean, reveal: boolean): void | Promise<void> => {
        if (!owns()) { return }
        let current = record.current
        if (current !== null && current.inputSeq !== undefined) {
          record.appliedSeq = Math.max(record.appliedSeq, current.inputSeq!)
        }
        let prior = record.frames.length === 0 ? undefined : record.frames[record.frames.length - 1]
        let frame = chain(prior, () => owns() ? this.render(record, reveal) : undefined)
        if (frame instanceof Promise) { record.frames.push(frame) }
        return frame
      },
      snapshot: (encoded: string): void => {
        if (owns() && record.subscriber !== null) {
          this.deliver(record, () => record.subscriber!.onStateSnapshot(encoded))
        }
      },
      saved: (projectId: string): void => {
        if ((owns() || (!this.disposed && !record.destroyed && record.retiring === actor)) &&
            record.subscriber !== null) {
          this.deliver(record, () => record.subscriber!.onStateSaved(projectId))
        }
      },
      effects: (effects: HostEffect[]): void => { if (owns()) { this.deliverEffects(record, effects) } },
      error: (kind: string, message: string): void => { if (owns()) { this.report(record, kind, message) } }
    }
    actor = this.actorFactory === null ? new AppActor(callbacks, record) :
      this.actorFactory!(callbacks, record)
    record.actor = actor
  }

  private render(record: ActorRecord, reveal: boolean): void | Promise<void> {
    if (this.disposed || record.destroyed) { return }
    let started = this.now()
    let actor = record.actor!
    return attempt<void>(() => chain(actor.view(), (view: VeraUiNode | null) => {
      if (this.disposed || record.destroyed || record.actor !== actor) { return }
      if (view === null && record.requiringFirstFrame) {
        this.failFirstFrame(record)
        return
      }
      return this.deliverFrame(record, view, [], reveal, [0, 0, this.now() - started])
    }), (error: Error): void => {
      this.failFirstFrame(record)
      this.report(record, 'view', error.message)
    })
  }

  private failFirstFrame(record: ActorRecord): void {
    if (!record.requiringFirstFrame) { return }
    record.firstFrameFailed = true
    if (record.current !== null &&
        (record.current!.kind === 'INITIALIZE' || record.current!.kind === 'REPLACE')) {
      record.actor!.cancel()
    }
  }

  private surfaceRender(record: ActorRecord, draws: DrawRequest[], withView: boolean,
      handlersMs: number): void | Promise<void> {
    if (this.disposed || record.destroyed) { return }
    let gfx: Object[] = []
    let actor = record.actor!
    let started = this.now()
    let current: DrawRequest | null = null
    let drawNext = (index: number): void | Promise<void> => {
      for (let i = index; i < draws.length; i++) {
        if (this.disposed || record.destroyed || record.actor !== actor) { return }
        let draw = draws[i]
        current = draw
        let ops = actor.draw(draw.entry)
        let append = (value: GfxOp[]): void => {
          let item: SurfaceGfx = { nodeId: draw.nodeId, surfaceRevision: draw.surfaceRevision, ops: value }
          gfx.push(item)
          StageTrace.emit(record, 'DRAW', { nodeId: draw.nodeId, result: 'OK' })
        }
        if (ops instanceof Promise) { return chain(ops, (value: GfxOp[]) => {
          append(value)
          return drawNext(i + 1)
        }) }
        append(ops)
      }
    }
    let failed = false
    return chain(attempt<void>(() => drawNext(0), (error: Error): void => {
      failed = true
      if (current !== null) { StageTrace.emit(record, 'DRAW', { nodeId: current.nodeId, result: 'ERROR' }) }
      actor.clearEffects()
      this.report(record, 'draw', error.message)
    }), () => {
      if (failed || this.disposed || record.destroyed || record.actor !== actor) { return }
      let drawMs = this.now() - started
      started = this.now()
      let view = withView ? attempt<VeraUiNode | null>(() => actor.view(), (error: Error): null => {
        this.report(record, 'view', error.message)
        return null
      }) : null
      return chain(view, (node: VeraUiNode | null) => {
        if (withView && node === null && gfx.length === 0) { return }
        return this.deliverFrame(record, node, gfx, false, [handlersMs, drawMs, this.now() - started])
      })
    })
  }

  private deliverFrame(record: ActorRecord, view: Object | null, gfx: Object[], reveal: boolean,
      timing: number[]): void | Promise<void> {
    if (this.disposed || record.destroyed || record.subscriber === null) { return }
    let actor = record.actor!
    let scenes: SceneDraw[] = []
    let nodes: VeraUiNode[] = view === null ? [] : [view as VeraUiNode]
    let nextId = 1
    let buildNext = (): void | Promise<void> => {
      while (nodes.length > 0) {
        if (this.disposed || record.destroyed || record.actor !== actor) { return }
        let node = nodes.pop()!
        node.id = nextId++
        for (let index = node.children.length - 1; index >= 0; index--) { nodes.push(node.children[index]) }
        if (node.kind === 'world') {
          let spec = actor.buildScene(node.label)
          let nodeId = node.id
          if (spec instanceof Promise) {
            return chain(spec, (value: WorldSpec) => {
              scenes.push({ nodeId: nodeId, spec: value })
              return buildNext()
            })
          }
          scenes.push({ nodeId: nodeId, spec: spec })
        }
      }
    }
    return attempt<void>(() => chain(buildNext(), () => {
      if (this.disposed || record.destroyed || record.actor !== actor) { return }
      let frame: FrameEnvelope = { appId: record.appId, vmGeneration: record.vmGeneration,
        frameSeq: ++record.frameSeq, appliedSeq: record.appliedSeq, reveal: reveal,
        view: view === null ? null : JSON.parse(JSON.stringify(view)) as Object,
        gfx: JSON.parse(JSON.stringify(gfx)) as Object[], timing: timing,
        scenes: view === null ? undefined : JSON.parse(JSON.stringify(scenes)) as SceneDraw[] }
      StageTrace.frame(record, view, reveal)
      this.deliver(record, () => record.subscriber!.onViewFrame(frame))
    }), (error: Error): void => {
      actor.clearEffects()
      this.failFirstFrame(record)
      this.report(record, 'WORLD', 'World error: ' + error.message)
    })
  }

  private deliverEffects(record: ActorRecord, effects: HostEffect[]): void {
    if (this.disposed || record.destroyed || record.options.mode === 'PREVIEW' || record.current === null ||
        record.subscriber === null) { return }
    if (record.deliveries !== null) {
      record.deliveries!.push(() => this.deliverEffects(record, effects))
      return
    }
    let lease = record.current!.lease
    for (let effect of effects) {
      if (this.disposed || record.destroyed || lease.state === 'RELEASED') { return }
      let params: string[] = []
      effect.values.forEach((value: string, key: string) => { params.push(key, value) })
      let id = ++record.effectSeq
      let pending = new PendingEffect()
      pending.handler = effect.resultHandler
      pending.leaseId = lease.handle.leaseId
      record.effects.set(id, pending)
      let request: EffectRequest = { appId: record.appId, vmGeneration: record.vmGeneration,
        effectId: id, kind: effect.kind, rawTarget: effect.rawTarget, params: params,
        resultHandler: effect.resultHandler, mode: effect.rawMode.length > 0 ? effect.rawMode : 'background' }
      StageTrace.associateEffectOwner(request, record)
      StageTrace.request(record, id, effect.rawTarget, effect.values, effect.resultHandler,
        request.mode, record.vmGeneration)
      this.safe(() => record.subscriber!.onEffectRequest(request))
    }
  }

  private turnKind(entry: MailboxEntry): string {
    if (entry.kind === 'SURFACE_FRAME') { return 'frame' }
    if (entry.kind === 'MOVE') { return 'move' }
    if (entry.kind === 'DRAW') { return 'draw' }
    if (entry.kind === 'VIEW') { return 'view' }
    return 'handler'
  }

  private report(record: ActorRecord, kind: string, message: string): void {
    let normalized: string = kind.toLowerCase()
    if (normalized === 'field' || normalized === 'tick' || normalized === 'effect_result' ||
        normalized === 'back' || normalized === 'surface_down' || normalized === 'surface_up' ||
        normalized === 'surface_cancel') {
      normalized = 'handler'
    }
    if (normalized === 'view' || normalized === 'draw' || normalized === 'move' || normalized === 'frame' ||
        normalized === 'world') {
      StageTrace.emit(record, 'ERROR', { kind: normalized.toUpperCase() })
    }
    if (normalized === 'handler' || normalized === 'frame' || normalized === 'move' || normalized === 'draw' ||
        normalized === 'world' || normalized === 'scene') {
      record.turnFailed = true
      if (record.deliveries === null) {
        this.discard(record, (entry: MailboxEntry): boolean => entry.kind === 'TICK' ||
          entry.kind === 'SURFACE_FRAME', 'INVALID_HANDLE')
      }
    } else if (normalized === 'init') { record.turnFailed = true }
    if (this.disposed || record.destroyed || record.subscriber === null) { return }
    let inputSeq = record.current === null ? undefined : record.current!.inputSeq
    this.deliver(record, () => record.subscriber!.onError(normalized, message, inputSeq))
  }

  private deliver(record: ActorRecord, callback: () => void): void {
    if (record.deliveries !== null) { record.deliveries!.push(callback) }
    else if (!this.disposed && !record.destroyed && record.subscriber !== null) { this.safe(callback) }
  }

  private safe(callback: () => void): void {
    try { callback() } catch (_) {}
  }

  private discard(record: ActorRecord, predicate: (entry: MailboxEntry) => boolean,
      code: HostOperationError): void {
    let discarded: MailboxEntry[] = []
    let retained: MailboxEntry[] = []
    for (let entry of record.mailbox) {
      if (predicate(entry)) { discarded.push(entry) } else { retained.push(entry) }
    }
    record.mailbox = retained
    for (let entry of discarded) {
      this.freeSlot(record, entry)
      this.complete(entry)
      if (entry.kind === 'INITIALIZE' || entry.kind === 'ACQUIRE') {
        this.removeLease(record, entry.lease)
      }
      if (entry.kind === 'EFFECT_RESULT') {
        let effect = record.effects.get(entry.effectId)
        StageTrace.emit(record, 'EFFECT_RESULT', {id: entry.effectId,
          resultHandler: effect == undefined ? '' : effect.handler,
          generation: entry.handle.vmGeneration, outcome: 'DROPPED_STALE' })
      }
      if (entry.reject !== null) { entry.reject!(new HostOperationFailure(code) as Error) }
    }
  }

  private destroyRecord(record: ActorRecord): void | Promise<void> {
    if (record.destroyed) { return record.destruction || undefined }
    record.destroyed = true
    if (record.idleTimer !== -1) { clearTimeout(record.idleTimer); record.idleTimer = -1 }
    this.discard(record, () => true, 'ACTOR_NOT_READY')
    record.effects.clear()
    record.subscriber = null
    record.leases.forEach((lease: HostLease) => {
      lease.state = 'RELEASED'
      lease.editsPending = false
      lease.record = null
      this.leases.delete(lease.handle.leaseId)
      this.released.set(lease.handle, true)
    })
    record.leases.clear()
    let identities: string[] = []
    this.registry.forEach((candidate: ActorRecord, identity: string) => {
      if (candidate === record) { identities.push(identity) }
    })
    for (let identity of identities) { this.registry.delete(identity) }
    this.ready = this.ready.filter((candidate: ActorRecord): boolean => candidate !== record)
    record.scheduled = false
    this.pending++
    let failure: Error | null = null
    let cleanups: Promise<void>[] = []
    let actors: HostActor[] = [record.actor!]
    if (record.retiring !== null) { actors.push(record.retiring!); record.retiring = null }
    for (let actor of actors) {
      let cleanup = attempt<void>(() => this.cleanupActor(actor), (error: Error): void => {
        if (failure === null) { failure = error }
        if (this.disposed && this.disposeFailure === null) { this.disposeFailure = error }
      })
      if (cleanup instanceof Promise) { cleanups.push(cleanup) }
    }
    if (cleanups.length === 0) {
      this.pending--
      this.settleIdle()
      return
    }
    let completion = Promise.all(cleanups).then(() => {
      this.pending--
      this.settleIdle()
      if (failure !== null) { throw failure! }
    })
    record.destruction = completion
    completion.catch(() => undefined)
    return completion
  }

  private cleanupActor(actor: HostActor): void | Promise<void> {
    if (this.cleanups.has(actor)) { return this.cleanups.get(actor) || undefined }
    this.cleanups.set(actor, null)
    let cleanup = attempt<void>(() => actor.dispose(), (error: Error): Promise<void> => Promise.reject(error))
    if (cleanup instanceof Promise) {
      this.pending++
      let completion = cleanup.then(() => {
        this.pending--
        this.settleIdle()
      }, (error: Error): void => {
        if (this.disposed && this.disposeFailure === null) { this.disposeFailure = error }
        this.pending--
        this.settleIdle()
        throw error
      })
      this.cleanups.set(actor, completion)
      completion.catch(() => undefined)
      return completion
    }
  }

  private finishDispose(): void {
    if (this.isIdle() && this.disposeResolve !== null) {
      let resolve = this.disposeResolve!
      let reject = this.disposeReject!
      this.disposeResolve = null
      this.disposeReject = null
      if (this.disposeFailure !== null) { reject(this.disposeFailure!) }
      else { resolve() }
    }
  }
}
