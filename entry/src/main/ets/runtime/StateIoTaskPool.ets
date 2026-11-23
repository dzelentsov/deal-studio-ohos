import { taskpool } from '@kit.ArkTS'
import {
  StateIoOptions, StateIoError, StateErrorCode, StateHeader, LoadResult,
  CommitPrecondition, CommitTaskRequest, PublishGenerationRequest, CommitTaskResult, CommitResult,
  StateIoTaskRequest, StateIoTaskReply, runStateIoTask
} from './StateIo'

@Concurrent
function stateIoTask(root: string, options: StateIoOptions, request: StateIoTaskRequest): StateIoTaskReply {
  return runStateIoTask(root, options, request)
}

function record(value: Object, keys: string[]): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      value instanceof Date || value instanceof Map || value instanceof Set ||
      value instanceof ArrayBuffer || ArrayBuffer.isView(value)) { return false }
  return Object.keys(value).every((key: string) => keys.indexOf(key) >= 0)
}

function counter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER
}

function stamp(value: string): boolean {
  return typeof value === 'string' && value.indexOf('\u0000') < 0
}

function appId(value: string): boolean {
  return typeof value === 'string' && value.split('/').length === 2 &&
    value.split('/').every((part: string) => part.length > 0 && part !== '.' && part !== '..' && !/[\u0000-\u001f\\]/.test(part))
}

function check(valid: boolean, stage: string): void {
  if (!valid) { throw new StateIoError('STATE_VALIDATION_FAILED', stage) }
}

function validCode(code: StateErrorCode): boolean {
  return ['STATE_VALIDATION_FAILED', 'STATE_SERIALIZATION_FAILED', 'STATE_WRITE_FAILED', 'STATE_SYNC_FAILED',
    'STATE_PUBLISH_FAILED', 'STATE_CORRUPTED', 'STATE_RECOVERY_FAILED', 'STATE_UNAVAILABLE', 'STATE_LOST',
    'STATE_LOCK_UNAVAILABLE', 'STATE_COMMIT_UNCERTAIN', 'STATE_READ_FAILED', 'STATE_HASH_FAILED',
    'STATE_TASK_SUBMIT_FAILED'].indexOf(code) >= 0
}

function validHeader(header: StateHeader, identity: string): boolean {
  return record(header, ['format', 'appId', 'schemaVersion', 'vmGeneration', 'revision', 'payloadLength', 'payloadHash']) &&
    header.format === 2 && header.appId === identity && header.schemaVersion === 1 &&
    counter(header.vmGeneration) && counter(header.revision) && counter(header.payloadLength) &&
    typeof header.payloadHash === 'string' && /^sha256:[0-9a-f]{64}$/.test(header.payloadHash)
}

function validCommit(result: CommitResult): boolean {
  if (!record(result, ['status', 'revision', 'backup', 'code', 'stage'])) { return false }
  if (result.status === 'COMMITTED') {
    return record(result, ['status', 'revision', 'backup']) && counter(result.revision) &&
      ['WRITTEN', 'SKIPPED', 'FAILED'].indexOf(result.backup) >= 0
  }
  if (result.status === 'FAILED' || result.status === 'COMMIT_UNCERTAIN') {
    return record(result, ['status', 'code', 'stage']) && validCode(result.code) &&
      typeof result.stage === 'string' && result.stage.length > 0 &&
      (result.status === 'COMMIT_UNCERTAIN' ? result.code === 'STATE_COMMIT_UNCERTAIN' : result.code !== 'STATE_COMMIT_UNCERTAIN')
  }
  return record(result, ['status']) && ['FENCED_COMMIT', 'STALE_REVISION', 'STALE'].indexOf(result.status) >= 0
}

function validLoad(value: LoadResult, identity: string, expectedStamp: string): boolean {
  if (!record(value, ['kind', 'format', 'source', 'header', 'stamp', 'encodedState', 'matchingStamp', 'code', 'stage', 'recovered'])) {
    return false
  }
  if (value.kind === 'READY') {
    return (value.format === 'FORMAT2' ? validHeader(value.header as StateHeader, identity) :
      value.format === 'LEGACY' && value.header === undefined && value.source === 'MAIN') &&
      ['MAIN', 'BAK'].indexOf(value.source as string) >= 0 && stamp(value.stamp as string) &&
      value.matchingStamp === (value.stamp === expectedStamp) &&
      (value.matchingStamp ? typeof value.encodedState === 'string' : value.encodedState === undefined) &&
      value.recovered === (value.source === 'BAK') && value.code === undefined && value.stage === undefined
  }
  return ['ABSENT', 'LOST', 'UNAVAILABLE'].indexOf(value.kind) >= 0 &&
    value.format === undefined && value.source === undefined && value.header === undefined &&
    value.stamp === undefined && value.encodedState === undefined && value.matchingStamp === undefined &&
    value.recovered === undefined && (value.kind === 'ABSENT' ? value.code === undefined && value.stage === undefined :
      validCode(value.code as StateErrorCode) && typeof value.stage === 'string' && value.stage.length > 0)
}

export class StateIoTaskPool {
  private root: string
  private options: StateIoOptions
  private stateMaxBytes: number
  private tail: Promise<void> = Promise.resolve()
  private accepting: boolean = true
  private uncertain: boolean = false
  private fenced: boolean = false
  private sequence: number = 0
  private pendingIds: Set<string> = new Set<string>()

  constructor(root: string, options: StateIoOptions, stateMaxBytes: number) {
    check(typeof root === 'string' && root.startsWith('/') && stamp(root) &&
      !root.split('/').some((part: string) => part === '.' || part === '..'), 'options')
    check(record(options, ['directoryFsync', 'lockTimeoutMs', 'tmpOrphanAgeMs']), 'options')
    check(options.directoryFsync === 'REQUIRED' || options.directoryFsync === 'UNSUPPORTED', 'options')
    let lockTimeoutMs = options.lockTimeoutMs === undefined ? 100 : options.lockTimeoutMs
    let tmpOrphanAgeMs = options.tmpOrphanAgeMs === undefined ? 60000 : options.tmpOrphanAgeMs
    check(counter(lockTimeoutMs) && counter(tmpOrphanAgeMs) && Number.isSafeInteger(stateMaxBytes) &&
      stateMaxBytes > 0 && stateMaxBytes < 16 * 1024 * 1024, 'options')
    this.root = root
    let ownedOptions: StateIoOptions = {
      directoryFsync: options.directoryFsync, lockTimeoutMs: lockTimeoutMs, tmpOrphanAgeMs: tmpOrphanAgeMs
    }
    this.options = ownedOptions
    this.stateMaxBytes = stateMaxBytes
  }

  whenIdle(): Promise<void> {
    return this.tail.then(() => {
      if (this.uncertain) { throw new StateIoError('STATE_COMMIT_UNCERTAIN', 'task-drain-uncertain') }
    })
  }

  close(): Promise<void> {
    this.accepting = false
    return this.whenIdle()
  }

  fence(): Promise<void> { return this.close() }

  private admit(): void {
    if (!this.accepting || this.fenced) { throw new StateIoError('STATE_UNAVAILABLE', 'task-fenced') }
  }

  private reserve(id: string): void {
    check(typeof id === 'string' && id.length > 0 && id.length <= 256, 'operation-id')
    check(!this.pendingIds.has(id), 'operation-id-duplicate')
    this.pendingIds.add(id)
  }

  private envelopeId(): string {
    check(counter(this.sequence + 1), 'operation-id-capacity')
    return '@state-io:' + (++this.sequence)
  }

  private enqueue(request: StateIoTaskRequest): Promise<StateIoTaskReply> {
    let envelope: StateIoTaskRequest = {
      operationId: this.envelopeId(), kind: request.kind, appId: request.appId,
      expectedStamp: request.expectedStamp, commit: request.commit, publication: request.publication
    }
    let pending = this.tail.then(() => this.execute(envelope))
    this.tail = pending.then(() => {}, () => {})
    return pending
  }

  private async execute(request: StateIoTaskRequest): Promise<StateIoTaskReply> {
    if (this.fenced) { throw new StateIoError('STATE_UNAVAILABLE', 'task-fenced') }
    let execution: Promise<Object>
    try {
      let task = new taskpool.Task(stateIoTask, this.root, this.options, request)
      task.setTransferList(request.commit ? [request.commit.payload] : [])
      execution = taskpool.execute(task, taskpool.Priority.MEDIUM)
    } catch (_error) { throw new StateIoError('STATE_TASK_SUBMIT_FAILED', 'task-submit') }
    let reply: StateIoTaskReply
    try { reply = await execution as StateIoTaskReply }
    catch (_error) { return this.unknown(request, 'task-execute') }
    try {
      if (!record(reply, ['operationId', 'kind', 'load', 'header', 'result', 'error']) ||
          reply.operationId !== request.operationId || reply.kind !== request.kind) {
        return this.unknown(request, 'task-correlation')
      }
      if (request.kind === 'load' || request.kind === 'recoverLost') {
        if (reply.header !== undefined || reply.result !== undefined || reply.error !== undefined ||
            !validLoad(reply.load as LoadResult, request.appId as string, request.expectedStamp as string)) {
          return this.unknown(request, 'task-result')
        }
        if ((reply.load as LoadResult).code === 'STATE_COMMIT_UNCERTAIN') { this.uncertain = true; this.fenced = true }
      } else if (request.kind === 'readHeader') {
        if (reply.load !== undefined || reply.result !== undefined) { return this.unknown(request, 'task-result') }
        if (reply.error !== undefined) {
          if (reply.header !== undefined || !record(reply.error, ['code', 'stage']) ||
              !validCode(reply.error.code) || typeof reply.error.stage !== 'string') {
            return this.unknown(request, 'task-result')
          }
        } else if (reply.header !== null && !validHeader(reply.header as StateHeader, request.appId as string)) {
          return this.unknown(request, 'task-result')
        }
      } else {
        if (reply.load !== undefined || reply.header !== undefined || reply.error !== undefined ||
            !validCommit(reply.result as CommitResult)) { return this.unknown(request, 'task-result') }
        let result = reply.result as CommitResult
        if (result.status === 'COMMITTED' && result.revision !== (request.commit ?
          request.commit.pre.baseRevision + 1 : (request.publication as PublishGenerationRequest).expectedRevision)) {
          return this.unknown(request, 'task-result')
        }
        let status = result.status
        if (status === 'COMMIT_UNCERTAIN') { this.uncertain = true }
        if (status === 'COMMIT_UNCERTAIN' || status === 'FENCED_COMMIT' || status === 'STALE_REVISION') { this.fenced = true }
      }
    } catch (_error) { return this.unknown(request, 'task-result') }
    return reply
  }

  private unknown(request: StateIoTaskRequest, stage: string): StateIoTaskReply {
    this.uncertain = true
    this.fenced = true
    if (request.kind === 'readHeader') { throw new StateIoError('STATE_READ_FAILED', stage) }
    if (request.kind === 'load' || request.kind === 'recoverLost') {
      return { operationId: request.operationId, kind: request.kind,
        load: { kind: 'UNAVAILABLE', code: 'STATE_COMMIT_UNCERTAIN', stage: stage } }
    }
    return { operationId: request.operationId, kind: request.kind,
      result: { status: 'COMMIT_UNCERTAIN', code: 'STATE_COMMIT_UNCERTAIN', stage: stage } }
  }

  async load(identity: string, expectedStamp: string): Promise<LoadResult> {
    try {
      this.admit()
      check(appId(identity) && stamp(expectedStamp), 'load-request')
      let reply = await this.enqueue({ operationId: '', kind: 'load', appId: identity, expectedStamp: expectedStamp })
      return reply.load as LoadResult
    } catch (error) {
      let issue = error as StateIoError
      return { kind: 'UNAVAILABLE', code: issue.code, stage: issue.stage }
    }
  }

  async recoverLost(identity: string, expectedStamp: string): Promise<LoadResult> {
    try {
      this.admit()
      check(appId(identity) && stamp(expectedStamp), 'lost-request')
      let reply = await this.enqueue({ operationId: '', kind: 'recoverLost', appId: identity, expectedStamp: expectedStamp })
      return reply.load as LoadResult
    } catch (error) {
      let issue = error instanceof StateIoError ? error : new StateIoError('STATE_UNAVAILABLE', 'lost-authority-refused')
      return { kind: 'UNAVAILABLE', code: issue.code, stage: issue.stage }
    }
  }

  async readHeader(identity: string): Promise<StateHeader | null> {
    this.admit()
    check(appId(identity), 'header-request')
    let reply = await this.enqueue({ operationId: '', kind: 'readHeader', appId: identity })
    if (reply.error) { throw new StateIoError(reply.error.code, reply.error.stage) }
    return reply.header as StateHeader | null
  }

  async commit(request: CommitTaskRequest): Promise<CommitTaskResult> {
    let id = ''
    let reserved = false
    try {
      check(record(request, ['operationId', 'pre', 'schemaVersion', 'stamp', 'payload', 'backupDue']), 'commit-request')
      id = typeof request.operationId === 'string' ? request.operationId : ''
      this.admit()
      this.reserve(id)
      reserved = true
      check(record(request.pre, ['appId', 'vmGeneration', 'baseRevision']) && appId(request.pre.appId) &&
        counter(request.pre.vmGeneration) && counter(request.pre.baseRevision) &&
        request.pre.baseRevision + 1 < Number.MAX_SAFE_INTEGER && request.schemaVersion === 1 &&
        stamp(request.stamp) && request.payload instanceof ArrayBuffer && typeof request.backupDue === 'boolean', 'commit-request')
      check(request.payload.byteLength <= this.stateMaxBytes, 'payload-size')
      let pre: CommitPrecondition = {
        appId: request.pre.appId, vmGeneration: request.pre.vmGeneration, baseRevision: request.pre.baseRevision
      }
      let owned: CommitTaskRequest = {
        operationId: id, pre: pre, schemaVersion: request.schemaVersion,
        stamp: request.stamp, payload: request.payload.slice(0), backupDue: request.backupDue
      }
      let reply = await this.enqueue({ operationId: id, kind: 'commit', commit: owned })
      return { operationId: id, result: reply.result as CommitResult }
    } catch (error) { return this.refused(id, error) }
    finally { if (reserved) { this.pendingIds.delete(id) } }
  }

  async publishGeneration(request: PublishGenerationRequest): Promise<CommitTaskResult> {
    let id = ''
    let reserved = false
    try {
      check(record(request, ['operationId', 'appId', 'nextVmGeneration', 'expectedSource', 'expectedRevision', 'expectedStamp']), 'publication-request')
      id = typeof request.operationId === 'string' ? request.operationId : ''
      this.admit()
      this.reserve(id)
      reserved = true
      check(appId(request.appId) && counter(request.nextVmGeneration) && counter(request.expectedRevision) &&
        stamp(request.expectedStamp) && ['MAIN', 'BAK', 'LEGACY', 'ABSENT'].indexOf(request.expectedSource) >= 0, 'publication-request')
      let owned: PublishGenerationRequest = {
        operationId: id, appId: request.appId, nextVmGeneration: request.nextVmGeneration,
        expectedSource: request.expectedSource, expectedRevision: request.expectedRevision, expectedStamp: request.expectedStamp
      }
      let reply = await this.enqueue({ operationId: id, kind: 'publishGeneration', publication: owned })
      return { operationId: id, result: reply.result as CommitResult }
    } catch (error) { return this.refused(id, error) }
    finally { if (reserved) { this.pendingIds.delete(id) } }
  }

  private refused(id: string, error: Object): CommitTaskResult {
    let issue = error instanceof StateIoError ? error : new StateIoError('STATE_SERIALIZATION_FAILED', 'task-snapshot')
    return { operationId: id, result: { status: 'FAILED', code: issue.code, stage: issue.stage } }
  }
}
