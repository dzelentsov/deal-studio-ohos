import { taskpool } from '@kit.ArkTS'
import {
  StateIoOptions, StateIoError, StateCleanupScope, StateCleanupTaskRequest,
  StateCleanupTaskReply, UncertainCommitResult, runStateCleanupTask
} from './StateIo'

@Concurrent
function stateCleanupTask(root: string, options: StateIoOptions, request: StateCleanupTaskRequest): StateCleanupTaskReply {
  try { return runStateCleanupTask(root, options, request) }
  catch (_error) {
    let result: UncertainCommitResult = {
      status: 'COMMIT_UNCERTAIN', code: 'STATE_COMMIT_UNCERTAIN', stage: 'cleanup-worker-execute'
    }
    let reply: StateCleanupTaskReply = { operationId: request.operationId, result: result }
    return reply
  }
}

function cleanupRecord(value: Object, keys: string[]): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      value instanceof Date || value instanceof Map || value instanceof Set ||
      value instanceof ArrayBuffer || ArrayBuffer.isView(value)) { return false }
  return Object.keys(value).every((key: string) => keys.indexOf(key) >= 0)
}

function cleanupCheck(valid: boolean, stage: string): void {
  if (!valid) { throw new StateIoError('STATE_VALIDATION_FAILED', stage) }
}

function cleanupIdentity(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..' &&
    !/[\/\\\u0000-\u001f]/.test(value)
}

function cleanupReply(value: StateCleanupTaskReply, id: string): boolean {
  if (!cleanupRecord(value, ['operationId', 'result']) || value.operationId !== id ||
      !cleanupRecord(value.result, ['status', 'code', 'stage'])) { return false }
  let result = value.result
  if (result.status === 'REMOVED') { return cleanupRecord(result, ['status']) }
  if (result.status !== 'FAILED' && result.status !== 'COMMIT_UNCERTAIN') { return false }
  return typeof result.stage === 'string' && result.stage.length > 0 &&
    (result.status === 'COMMIT_UNCERTAIN' ? result.code === 'STATE_COMMIT_UNCERTAIN' :
      ['STATE_VALIDATION_FAILED', 'STATE_WRITE_FAILED', 'STATE_SYNC_FAILED', 'STATE_UNAVAILABLE',
        'STATE_LOCK_UNAVAILABLE', 'STATE_READ_FAILED'].indexOf(result.code) >= 0)
}

export class StateCleanupTaskPool {
  private root: string
  private options: StateIoOptions
  private tail: Promise<void> = Promise.resolve()
  private accepting: boolean = true
  private sequence: number = 0
  private failures: Map<string, StateIoError> = new Map<string, StateIoError>()
  private uncertain: boolean = false

  constructor(root: string, options: StateIoOptions) {
    cleanupCheck(typeof root === 'string' && root.startsWith('/') && root.indexOf('\u0000') < 0 &&
      !root.split('/').some((part: string): boolean => part === '.' || part === '..'), 'cleanup-options')
    cleanupCheck(cleanupRecord(options, ['directoryFsync', 'lockTimeoutMs', 'tmpOrphanAgeMs']) &&
      options.directoryFsync === 'REQUIRED', 'cleanup-fsync-required')
    let timeout = options.lockTimeoutMs === undefined ? 100 : options.lockTimeoutMs
    let orphanAge = options.tmpOrphanAgeMs === undefined ? 60000 : options.tmpOrphanAgeMs
    cleanupCheck(Number.isSafeInteger(timeout) && timeout >= 0 &&
      Number.isSafeInteger(orphanAge) && orphanAge >= 0, 'cleanup-options')
    this.root = root
    let owned: StateIoOptions = { directoryFsync: 'REQUIRED', lockTimeoutMs: timeout, tmpOrphanAgeMs: orphanAge }
    this.options = owned
  }

  async removeStateFilesKeepingStableLocks(scope: StateCleanupScope): Promise<void> {
    cleanupCheck(cleanupRecord(scope, ['projectId', 'versionId']) && cleanupIdentity(scope.projectId) &&
      (scope.versionId === undefined || cleanupIdentity(scope.versionId)), 'cleanup-scope')
    this.admit(scope.projectId)
    cleanupCheck(Number.isSafeInteger(this.sequence + 1) && this.sequence + 1 < Number.MAX_SAFE_INTEGER, 'cleanup-sequence')
    let ownedScope: StateCleanupScope = { projectId: scope.projectId, versionId: scope.versionId }
    let request: StateCleanupTaskRequest = { operationId: '@state-cleanup:' + (++this.sequence), scope: ownedScope }
    let pending = this.tail.then((): Promise<void> => this.execute(request))
    this.tail = pending.then((): void => {}, (): void => {})
    return pending
  }

  whenIdle(): Promise<void> {
    return this.tail.then((): void => {
      if (this.uncertain) { throw new StateIoError('STATE_COMMIT_UNCERTAIN', 'cleanup-drain-uncertain') }
      if (this.failures.size > 0) { throw new StateIoError('STATE_UNAVAILABLE', 'cleanup-drain-fenced') }
    })
  }

  close(): Promise<void> {
    this.accepting = false
    return this.whenIdle()
  }

  private admit(projectId: string): void {
    let issue = this.failures.get(projectId)
    if (issue !== undefined) { throw issue as Error }
    if (!this.accepting) { throw new StateIoError('STATE_UNAVAILABLE', 'cleanup-closed') }
  }

  private fail(projectId: string, issue: StateIoError): void {
    this.failures.set(projectId, issue)
    if (issue.code === 'STATE_COMMIT_UNCERTAIN') { this.uncertain = true }
    throw issue as Error
  }

  private async execute(request: StateCleanupTaskRequest): Promise<void> {
    let prior = this.failures.get(request.scope.projectId)
    if (prior !== undefined) { throw prior as Error }
    let task: taskpool.Task
    try {
      task = new taskpool.Task(stateCleanupTask, this.root, this.options, request)
      task.setTransferList([])
    } catch (_error) {
      this.fail(request.scope.projectId, new StateIoError('STATE_TASK_SUBMIT_FAILED', 'cleanup-task-create'))
      return
    }
    let reply: StateCleanupTaskReply
    try { reply = await taskpool.execute(task, taskpool.Priority.MEDIUM) as StateCleanupTaskReply }
    catch (_error) {
      this.fail(request.scope.projectId, new StateIoError('STATE_COMMIT_UNCERTAIN', 'cleanup-task-execute'))
      return
    }
    let valid = false
    try { valid = cleanupReply(reply, request.operationId) }
    catch (_error) {
      this.fail(request.scope.projectId, new StateIoError('STATE_COMMIT_UNCERTAIN', 'cleanup-task-result'))
      return
    }
    if (!valid) {
      this.fail(request.scope.projectId, new StateIoError('STATE_COMMIT_UNCERTAIN', 'cleanup-task-result'))
      return
    }
    if (reply.result.status !== 'REMOVED') {
      this.fail(request.scope.projectId, new StateIoError(reply.result.code, reply.result.stage))
    }
  }
}
