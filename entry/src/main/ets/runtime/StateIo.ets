import { fileIo as fs } from '@kit.CoreFileKit'
import fileIo from '@ohos.fileio'
import { util } from '@kit.ArkTS'
import {
  StateHeader, DecodedStateData, StateFormatError, STATE_HEADER_WINDOW_BYTES,
  assembleStateFile, canonicalPayload, validateEncodedState, validateStateFile,
  readStateHeader, statePayloadBytes
} from './StateFileFormat'

export { StateHeader } from './StateFileFormat'

export type StateErrorCode = 'STATE_VALIDATION_FAILED' | 'STATE_SERIALIZATION_FAILED' |
  'STATE_WRITE_FAILED' | 'STATE_SYNC_FAILED' | 'STATE_PUBLISH_FAILED' |
  'STATE_CORRUPTED' | 'STATE_RECOVERY_FAILED' | 'STATE_UNAVAILABLE' | 'STATE_LOST' |
  'STATE_LOCK_UNAVAILABLE' | 'STATE_COMMIT_UNCERTAIN' | 'STATE_READ_FAILED' |
  'STATE_HASH_FAILED' | 'STATE_TASK_SUBMIT_FAILED'

export interface StateIoOptions {
  directoryFsync: 'REQUIRED' | 'UNSUPPORTED'
  lockTimeoutMs?: number
  tmpOrphanAgeMs?: number
}

export type LoadKind = 'READY' | 'ABSENT' | 'LOST' | 'UNAVAILABLE'

export interface LoadResult {
  kind: LoadKind
  format?: 'FORMAT2' | 'LEGACY'
  source?: 'MAIN' | 'BAK'
  header?: StateHeader
  stamp?: string
  encodedState?: string
  matchingStamp?: boolean
  code?: StateErrorCode
  stage?: string
  recovered?: boolean
}

export interface CommitPrecondition {
  appId: string
  vmGeneration: number
  baseRevision: number
}

export interface CommitTaskRequest {
  operationId: string
  pre: CommitPrecondition
  schemaVersion: number
  stamp: string
  payload: ArrayBuffer
  backupDue: boolean
}

export interface PublishGenerationRequest {
  operationId: string
  appId: string
  nextVmGeneration: number
  expectedSource: 'MAIN' | 'BAK' | 'LEGACY' | 'ABSENT'
  expectedRevision: number
  expectedStamp: string
}

export interface CommittedResult {
  status: 'COMMITTED'
  revision: number
  backup: 'WRITTEN' | 'SKIPPED' | 'FAILED'
}

export interface FencedCommitResult {
  status: 'FENCED_COMMIT'
}

export interface StaleRevisionResult {
  status: 'STALE_REVISION'
}

export interface StaleCommitResult {
  status: 'STALE'
}

export interface FailedCommitResult {
  status: 'FAILED'
  code: StateErrorCode
  stage: string
}

export interface UncertainCommitResult {
  status: 'COMMIT_UNCERTAIN'
  code: 'STATE_COMMIT_UNCERTAIN'
  stage: string
}

export type CommitResult = CommittedResult | FencedCommitResult | StaleRevisionResult |
  StaleCommitResult | FailedCommitResult | UncertainCommitResult

export interface CommitTaskResult {
  operationId: string
  result: CommitResult
}

export interface StateCleanupScope {
  projectId: string
  versionId?: string
}

export interface StateRemovedResult {
  status: 'REMOVED'
}

export type StateCleanupResult = StateRemovedResult | FailedCommitResult | UncertainCommitResult

export interface StateCleanupTaskRequest {
  operationId: string
  scope: StateCleanupScope
}

export interface StateCleanupTaskReply {
  operationId: string
  result: StateCleanupResult
}

export function runStateCleanupTask(root: string, options: StateIoOptions,
    request: StateCleanupTaskRequest): StateCleanupTaskReply {
  let result: StateCleanupResult
  try {
    let io = new StateIo(root, options)
    io.removeStateFilesKeepingStableLocks(request.scope)
    let removed: StateRemovedResult = { status: 'REMOVED' }
    result = removed
  } catch (error) {
    let issue: StateIoError = error instanceof StateIoError ? error :
      new StateIoError('STATE_COMMIT_UNCERTAIN', 'cleanup-worker')
    if (issue.code === 'STATE_COMMIT_UNCERTAIN') {
      let uncertain: UncertainCommitResult = {
        status: 'COMMIT_UNCERTAIN', code: 'STATE_COMMIT_UNCERTAIN', stage: issue.stage
      }
      result = uncertain
    } else {
      let failed: FailedCommitResult = { status: 'FAILED', code: issue.code, stage: issue.stage }
      result = failed
    }
  }
  let reply: StateCleanupTaskReply = { operationId: request.operationId, result: result }
  return reply
}

export interface StateIoTaskRequest {
  operationId: string
  kind: 'load' | 'readHeader' | 'commit' | 'publishGeneration'
  appId?: string
  expectedStamp?: string
  commit?: CommitTaskRequest
  publication?: PublishGenerationRequest
}

export interface StateIoTaskError {
  code: StateErrorCode
  stage: string
}

export interface StateIoTaskReply {
  operationId: string
  kind: 'load' | 'readHeader' | 'commit' | 'publishGeneration'
  load?: LoadResult
  header?: StateHeader | null
  result?: CommitResult
  error?: StateIoTaskError
}

export function runStateIoTask(root: string, options: StateIoOptions, request: StateIoTaskRequest): StateIoTaskReply {
  let reply: StateIoTaskReply = { operationId: request.operationId, kind: request.kind }
  try {
    let io = new StateIo(root, options)
    if (request.kind === 'load') { reply.load = io.load(request.appId as string, request.expectedStamp as string) }
    else if (request.kind === 'readHeader') { reply.header = io.readHeader(request.appId as string) }
    else if (request.kind === 'commit') { reply.result = io.commit(request.commit as CommitTaskRequest) }
    else if (request.kind === 'publishGeneration') {
      reply.result = io.publishGeneration(request.publication as PublishGenerationRequest)
    } else { throw new StateIoError('STATE_VALIDATION_FAILED', 'task-kind') }
  } catch (error) {
    if (request.kind === 'load') {
      reply.load = { kind: 'UNAVAILABLE', code: 'STATE_COMMIT_UNCERTAIN', stage: 'task-worker' }
    } else if (request.kind === 'readHeader') {
      let issue = error instanceof StateIoError ? error : new StateIoError('STATE_READ_FAILED', 'task-worker')
      let taskError: StateIoTaskError = { code: issue.code, stage: issue.stage }
      reply.error = taskError
    } else {
      reply.result = { status: 'COMMIT_UNCERTAIN', code: 'STATE_COMMIT_UNCERTAIN', stage: 'task-worker' }
    }
  }
  return reply
}

export class StateIoError extends Error {
  code: StateErrorCode
  stage: string
  causeCode?: string | number
  constructor(code: StateErrorCode, stage: string, causeCode?: string | number) {
    super(code + ' at ' + stage)
    this.code = code
    this.stage = stage
    this.causeCode = causeCode
  }
}

interface StatePaths {
  directory: string
  main: string
  backup: string
  lock: string
}

interface FileRead {
  kind: 'VALID' | 'ABSENT' | 'CORRUPT' | 'IO'
  text?: string
  data?: DecodedStateData
  error?: StateIoError
}

const STATE_OPEN_EXCL: number = 0o200
const STATE_SCHEMA_VERSION: number = 1
const STATE_IO_CHUNK_BYTES: number = 65536

function errorCode(error: Object): string | number | undefined {
  return (error as StateIoError).code
}

function cleanupVersion(name: string): string | null {
  if (typeof name !== 'string' || name.length === 0 || /[\/\\\u0000-\u001f]/.test(name) || name === '.' || name === '..') {
    throw new StateIoError('STATE_VALIDATION_FAILED', 'removal-list-name')
  }
  let match = /^(.+)\.state\.json(\.commit\.lock|(?:\.bak)?(?:\.(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9]+\.(?:[0-9]*|[0-9]+e-[0-9]+|-[0-9]+))\.tmp)?)$/.exec(name)
  return match === null ? null : match[1]
}

function counter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER
}

function failure(error: Object, stage: string, code: StateErrorCode): StateIoError {
  if (error instanceof StateIoError) { return error }
  if (error instanceof StateFormatError) {
    return new StateIoError(error.code as StateErrorCode, stage)
  }
  let nativeCode = errorCode(error)
  if (nativeCode === 13900012 || nativeCode === 13900001) {
    return new StateIoError('STATE_UNAVAILABLE', stage, nativeCode)
  }
  return new StateIoError(code, stage, nativeCode)
}

function closeQuietly(file: fs.File | null): void {
  if (file !== null) {
    try { fs.closeSync(file) } catch (_error) {}
  }
}

function releaseLock(file: fs.File | null): void {
  if (file !== null) {
    try { file.unlock() } catch (_error) {}
    closeQuietly(file)
  }
}

function strictUtf8(bytes: Uint8Array, stage: string): string {
  let decoder: util.TextDecoder
  try { decoder = util.TextDecoder.create('utf-8', { fatal: true, ignoreBOM: true }) }
  catch (error) { throw failure(error, stage + '-decoder', 'STATE_SERIALIZATION_FAILED') }
  let text: string
  try { text = bytes.byteLength === 0 ? '' : decoder.decodeToString(bytes, { stream: false }) }
  catch (_error) { throw new StateIoError('STATE_CORRUPTED', stage + '-utf8') }
  let encoded: Uint8Array
  try { encoded = statePayloadBytes(text) }
  catch (error) { throw failure(error, stage + '-encoder', 'STATE_SERIALIZATION_FAILED') }
  if (encoded.byteLength !== bytes.byteLength) { throw new StateIoError('STATE_CORRUPTED', stage + '-utf8') }
  for (let i = 0; i < bytes.byteLength; i++) {
    if (bytes[i] !== encoded[i]) { throw new StateIoError('STATE_CORRUPTED', stage + '-utf8') }
  }
  return text
}

function readBytes(file: fs.File, size: number, stage: string): Uint8Array {
  let bytes = new Uint8Array(size)
  let offset = 0
  while (offset < size) {
    let length = Math.min(size - offset, STATE_IO_CHUNK_BYTES)
    let chunk = new ArrayBuffer(length)
    let count: number
    try { count = fs.readSync(file.fd, chunk, { offset: offset, length: length }) }
    catch (error) { throw failure(error, stage + '-read', 'STATE_READ_FAILED') }
    if (count === 0) { throw new StateIoError('STATE_CORRUPTED', stage + '-truncated') }
    if (!Number.isInteger(count) || count < 0 || count > length) {
      throw new StateIoError('STATE_READ_FAILED', stage + '-read-count')
    }
    bytes.set(new Uint8Array(chunk, 0, count), offset)
    offset += count
  }
  return bytes
}

function fileSize(file: fs.File, stage: string): number {
  try {
    let stat = fs.statSync(file.fd)
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) {
      throw new StateIoError('STATE_CORRUPTED', stage + '-stat')
    }
    return stat.size
  } catch (error) { throw failure(error, stage + '-stat', 'STATE_READ_FAILED') }
}

function ready(read: FileRead, source: 'MAIN' | 'BAK', expectedStamp: string): LoadResult {
  let data = read.data as DecodedStateData
  let matching = data.stamp === expectedStamp
  return {
    kind: 'READY', format: data.format, source: source, header: data.header,
    stamp: data.stamp, encodedState: matching ? data.encodedState : undefined,
    matchingStamp: matching, recovered: source === 'BAK'
  }
}

function unavailable(error: StateIoError): LoadResult {
  return { kind: 'UNAVAILABLE', code: error.code, stage: error.stage }
}

function refused(error: Object, stage: string): CommitResult {
  let issue = failure(error, stage, 'STATE_WRITE_FAILED')
  if (issue.code === 'STATE_COMMIT_UNCERTAIN') {
    return { status: 'COMMIT_UNCERTAIN', code: 'STATE_COMMIT_UNCERTAIN', stage: issue.stage }
  }
  return { status: 'FAILED', code: issue.code, stage: issue.stage }
}

export class StateIo {
  private root: string
  private directoryFsync: 'REQUIRED' | 'UNSUPPORTED'
  private lockTimeoutMs: number
  private tmpOrphanAgeMs: number

  constructor(root: string, options: StateIoOptions) {
    if (typeof root !== 'string' || !root.startsWith('/') || root.indexOf('\u0000') >= 0 ||
        root.split('/').some((part: string) => part === '.' || part === '..') ||
        !options || (options.directoryFsync !== 'REQUIRED' && options.directoryFsync !== 'UNSUPPORTED')) {
      throw new StateIoError('STATE_VALIDATION_FAILED', 'options')
    }
    this.root = root.replace(/\/+$/, '') || '/'
    this.directoryFsync = options.directoryFsync
    this.lockTimeoutMs = options.lockTimeoutMs === undefined ? 100 : options.lockTimeoutMs
    this.tmpOrphanAgeMs = options.tmpOrphanAgeMs === undefined ? 60000 : options.tmpOrphanAgeMs
    if (!Number.isSafeInteger(this.lockTimeoutMs) || this.lockTimeoutMs < 0 ||
        !Number.isSafeInteger(this.tmpOrphanAgeMs) || this.tmpOrphanAgeMs < 0) {
      throw new StateIoError('STATE_VALIDATION_FAILED', 'options')
    }
  }

  private paths(appId: string): StatePaths {
    if (typeof appId !== 'string') { throw new StateIoError('STATE_VALIDATION_FAILED', 'app-id') }
    let parts = appId.split('/')
    if (parts.length !== 2 || parts.some((part: string) =>
      part.length === 0 || part === '.' || part === '..' || /[\u0000-\u001f\\]/.test(part))) {
      throw new StateIoError('STATE_VALIDATION_FAILED', 'app-id')
    }
    let directory = this.root + (this.root === '/' ? '' : '/') + parts[0]
    let main = directory + '/' + parts[1] + '.state.json'
    return { directory: directory, main: main, backup: main + '.bak', lock: main + '.commit.lock' }
  }

  private checkRoot(): void {
    let file: fs.File | null = null
    try { file = fs.openSync(this.root, fs.OpenMode.READ_ONLY | fs.OpenMode.DIR | fs.OpenMode.NOFOLLOW) }
    catch (error) { throw new StateIoError('STATE_UNAVAILABLE', 'root-open', errorCode(error)) }
    finally { closeQuietly(file) }
  }

  private directoryExists(paths: StatePaths): boolean {
    let file: fs.File | null = null
    try {
      file = fs.openSync(paths.directory, fs.OpenMode.READ_ONLY | fs.OpenMode.DIR | fs.OpenMode.NOFOLLOW)
      return true
    } catch (error) {
      this.checkRoot()
      if (errorCode(error) === 13900002) { return false }
      throw failure(error, 'project-open', 'STATE_UNAVAILABLE')
    } finally { closeQuietly(file) }
  }

  private ensureDirectory(paths: StatePaths): void {
    this.checkRoot()
    if (!this.directoryExists(paths)) {
      try { fs.mkdirSync(paths.directory) }
      catch (error) {
        if (errorCode(error) !== 13900015) { throw failure(error, 'project-create', 'STATE_WRITE_FAILED') }
      }
      if (!this.directoryExists(paths)) { throw new StateIoError('STATE_UNAVAILABLE', 'project-create') }
    }
    this.syncDirectory(this.root, 'project-dir-sync')
  }

  private readFile(path: string, appId: string, stage: string): FileRead {
    let file: fs.File | null = null
    try {
      try { file = fs.openSync(path, fs.OpenMode.READ_ONLY | fs.OpenMode.NOFOLLOW) }
      catch (error) {
        if (errorCode(error) === 13900002) { return { kind: 'ABSENT' } }
        throw error as Error
      }
      let size = fileSize(file, stage)
      let bytes = readBytes(file, size, stage)
      if (fileSize(file, stage) !== size) { throw new StateIoError('STATE_CORRUPTED', stage + '-changed') }
      let text = strictUtf8(bytes, stage)
      let data = validateStateFile(text, appId, STATE_SCHEMA_VERSION)
      return { kind: 'VALID', text: text, data: data }
    } catch (error) {
      let issue = failure(error, stage, 'STATE_READ_FAILED')
      return { kind: issue.code === 'STATE_CORRUPTED' ? 'CORRUPT' : 'IO', error: issue }
    } finally { closeQuietly(file) }
  }

  private lock(paths: StatePaths, timeout: number = this.lockTimeoutMs): fs.File | null {
    let file: fs.File | null = null
    try {
      file = fs.openSync(paths.lock, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.NOFOLLOW)
      let start = Date.now()
      let attempts = 0
      do {
        try { file.tryLock(true); return file }
        catch (error) {
          let code = errorCode(error)
          if (code !== 13900034 && code !== 13900010) {
            throw failure(error, 'lock-acquire', 'STATE_LOCK_UNAVAILABLE')
          }
        }
        attempts++
      } while (Date.now() - start < timeout && attempts < 100000)
      closeQuietly(file)
      return null
    } catch (error) {
      closeQuietly(file)
      throw failure(error, 'lock-open', 'STATE_LOCK_UNAVAILABLE')
    }
  }

  private syncDirectory(path: string, stage: string): void {
    if (this.directoryFsync === 'UNSUPPORTED') { return }
    let directory: fs.File | null = null
    try {
      directory = fs.openSync(path, fs.OpenMode.READ_ONLY | fs.OpenMode.DIR | fs.OpenMode.NOFOLLOW)
      fs.fsyncSync(directory.fd)
    } catch (error) { throw failure(error, stage, 'STATE_SYNC_FAILED') }
    finally { closeQuietly(directory) }
  }

  private safeWrite(path: string, directory: string, text: string, prefix: string): void {
    let fd: number | null = null
    let temp = ''
    let owned = false
    let renamed = false
    let stage = prefix + '-encode'
    try {
      let bytes = statePayloadBytes(text)
      stage = prefix + '-temp-name'
      temp = path + '.' + util.generateRandomUUID() + '.tmp'
      stage = prefix + '-temp-open'
      fd = fileIo.openSync(temp,
        fs.OpenMode.CREATE | STATE_OPEN_EXCL | fs.OpenMode.WRITE_ONLY | fs.OpenMode.NOFOLLOW, 0o600)
      owned = true
      let offset = 0
      stage = prefix + '-temp-write'
      while (offset < bytes.byteLength) {
        let chunk = bytes.slice(offset, Math.min(bytes.byteLength, offset + STATE_IO_CHUNK_BYTES))
        let count = fs.writeSync(fd, chunk.buffer as ArrayBuffer, { offset: offset, length: chunk.byteLength })
        if (!Number.isInteger(count) || count <= 0 || count > chunk.byteLength) {
          throw new StateIoError('STATE_WRITE_FAILED', stage)
        }
        offset += count
      }
      stage = prefix + '-temp-fsync'
      fs.fsyncSync(fd)
      stage = prefix + '-temp-close'
      fileIo.closeSync(fd)
      fd = null
      stage = prefix + '-rename'
      fs.renameSync(temp, path)
      renamed = true
      stage = prefix + '-dir-fsync'
      this.syncDirectory(directory, stage)
    } catch (error) {
      if (renamed) { throw new StateIoError('STATE_COMMIT_UNCERTAIN', stage, errorCode(error)) }
      let code: StateErrorCode = stage.endsWith('-temp-fsync') ? 'STATE_SYNC_FAILED' :
        stage.endsWith('-rename') ? 'STATE_PUBLISH_FAILED' : 'STATE_WRITE_FAILED'
      throw failure(error, stage, code)
    } finally {
      if (fd !== null) {
        try { fileIo.closeSync(fd) } catch (_error) {}
      }
      if (owned && !renamed) {
        try { fs.unlinkSync(temp) } catch (_error) {}
      }
    }
  }

  private cleanup(paths: StatePaths): void {
    let stage = 'cleanup-list'
    try {
      let base = paths.main.slice(paths.directory.length + 1)
      let names = fs.listFileSync(paths.directory)
      let now = Date.now()
      for (let name of names) {
        let suffix = name.startsWith(base + '.bak.') ? name.slice((base + '.bak.').length) :
          name.startsWith(base + '.') ? name.slice((base + '.').length) : ''
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i.test(suffix)) { continue }
        let path = paths.directory + '/' + name
        stage = 'cleanup-stat'
        let stat = fs.lstatSync(path)
        if (stat.isFile() && now - stat.mtime * 1000 > this.tmpOrphanAgeMs) {
          stage = 'cleanup-unlink'
          fs.unlinkSync(path)
        }
      }
    } catch (error) {
      throw failure(error, stage, stage === 'cleanup-unlink' ? 'STATE_WRITE_FAILED' : 'STATE_READ_FAILED')
    }
  }

  removeStateFilesKeepingStableLocks(scope: StateCleanupScope): void {
    let locks: fs.File[] = []
    let changed = false
    let stage = 'removal-scope'
    let issue: StateIoError | null = null
    try {
      if (!scope || typeof scope.projectId !== 'string' ||
          (scope.versionId !== undefined && typeof scope.versionId !== 'string')) {
        throw new StateIoError('STATE_VALIDATION_FAILED', stage)
      }
      let paths = this.paths(scope.projectId + '/' + (scope.versionId === undefined ? '@project' : scope.versionId))
      if (scope.projectId.indexOf('/') >= 0 || (scope.versionId !== undefined && scope.versionId.indexOf('/') >= 0)) {
        throw new StateIoError('STATE_VALIDATION_FAILED', stage)
      }
      if (this.directoryFsync !== 'REQUIRED') { throw new StateIoError('STATE_SYNC_FAILED', 'removal-fsync-required') }
      this.checkRoot()
      if (!this.directoryExists(paths)) { return }
      stage = 'removal-list'
      let names = fs.listFileSync(paths.directory)
      let versions = new Set<string>()
      if (scope.versionId !== undefined) { versions.add(scope.versionId) }
      for (let name of names) {
        let version = cleanupVersion(name)
        if (version === null || (scope.versionId !== undefined && version !== scope.versionId)) { continue }
        this.paths(scope.projectId + '/' + version)
        versions.add(version)
      }
      let ordered = Array.from(versions).sort()
      for (let version of ordered) {
        stage = 'removal-lock'
        let lock = this.lock(this.paths(scope.projectId + '/' + version))
        if (lock === null) { throw new StateIoError('STATE_LOCK_UNAVAILABLE', stage) }
        locks.push(lock)
        stage = 'removal-lock-stat'
        if (!fs.statSync(lock.fd).isFile()) { throw new StateIoError('STATE_LOCK_UNAVAILABLE', stage) }
      }
      stage = 'removal-locked-list'
      let targets: string[] = []
      for (let name of fs.listFileSync(paths.directory)) {
        let version = cleanupVersion(name)
        if (version === null || (scope.versionId !== undefined && version !== scope.versionId)) { continue }
        if (!versions.has(version)) { throw new StateIoError('STATE_LOCK_UNAVAILABLE', 'removal-new-identity') }
        if (!name.endsWith('.commit.lock')) { targets.push(name) }
      }
      stage = 'removal-dir-preflight'
      this.syncDirectory(paths.directory, stage)
      targets.sort()
      for (let name of targets) {
        let path = paths.directory + '/' + name
        stage = 'removal-stat'
        try {
          if (!fs.lstatSync(path).isFile()) { throw new StateIoError('STATE_UNAVAILABLE', stage) }
        } catch (error) {
          if (errorCode(error) === 13900002) { continue }
          throw error as Error
        }
        stage = 'removal-unlink'
        changed = true
        try { fs.unlinkSync(path) }
        catch (error) { if (errorCode(error) !== 13900002) { throw error as Error } }
      }
      stage = 'removal-dir-fsync'
      this.syncDirectory(paths.directory, stage)
    } catch (error) {
      issue = changed ? new StateIoError('STATE_COMMIT_UNCERTAIN', stage, errorCode(error)) :
        failure(error, stage, stage.indexOf('dir-') >= 0 ? 'STATE_SYNC_FAILED' :
          stage.indexOf('lock') >= 0 ? 'STATE_LOCK_UNAVAILABLE' : 'STATE_READ_FAILED')
    } finally {
      for (let i = locks.length - 1; i >= 0; i--) {
        try { locks[i].unlock() }
        catch (error) { if (issue === null) { issue = new StateIoError('STATE_COMMIT_UNCERTAIN', 'removal-unlock', errorCode(error)) } }
        try { fs.closeSync(locks[i]) }
        catch (error) { if (issue === null) { issue = new StateIoError('STATE_COMMIT_UNCERTAIN', 'removal-close', errorCode(error)) } }
      }
    }
    if (issue !== null) { throw issue as Error }
  }

  private cleanupValidMain(paths: StatePaths, appId: string): void {
    let lock: fs.File | null = null
    try {
      lock = this.lock(paths, 0)
      if (lock !== null && this.readFile(paths.main, appId, 'cleanup-main').kind === 'VALID') { this.cleanup(paths) }
    } catch (_error) {}
    finally { releaseLock(lock) }
  }

  load(appId: string, expectedStamp: string): LoadResult {
    let lock: fs.File | null = null
    try {
      let paths = this.paths(appId)
      this.checkRoot()
      if (!this.directoryExists(paths)) { return { kind: 'ABSENT' } }
      let main = this.readFile(paths.main, appId, 'load-main')
      if (main.kind === 'VALID') {
        this.cleanupValidMain(paths, appId)
        return ready(main, 'MAIN', expectedStamp)
      }
      if (main.kind === 'IO') {
        return unavailable(main.error as StateIoError)
      }
      lock = this.lock(paths)
      if (lock === null) { return unavailable(new StateIoError('STATE_LOCK_UNAVAILABLE', 'recovery-lock')) }
      this.checkRoot()
      main = this.readFile(paths.main, appId, 'recovery-main')
      if (main.kind === 'VALID') {
        try { this.cleanup(paths) } catch (_error) {}
        return ready(main, 'MAIN', expectedStamp)
      }
      if (main.kind === 'IO') {
        return unavailable(main.error as StateIoError)
      }
      let backup = this.readFile(paths.backup, appId, 'recovery-backup')
      if (backup.kind === 'VALID' && (backup.data as DecodedStateData).format === 'FORMAT2') {
        this.safeWrite(paths.main, paths.directory, backup.text as string, 'recovery')
        try { this.cleanup(paths) } catch (_error) {}
        return ready(backup, 'BAK', expectedStamp)
      }
      this.checkRoot()
      if (backup.kind === 'IO') { return unavailable(backup.error as StateIoError) }
      if (main.kind === 'ABSENT' && backup.kind === 'ABSENT') { return { kind: 'ABSENT' } }
      let issue = main.error || backup.error
      return { kind: 'LOST', code: issue ? issue.code : 'STATE_CORRUPTED', stage: issue ? issue.stage : 'recovery-backup-format' }
    } catch (error) { return unavailable(failure(error, 'load', 'STATE_RECOVERY_FAILED')) }
    finally { releaseLock(lock) }
  }

  readCommittedReadOnly(appId: string, expectedStamp: string): LoadResult {
    try {
      let paths = this.paths(appId)
      this.checkRoot()
      if (!this.directoryExists(paths)) { return { kind: 'ABSENT' } }
      let main = this.readFile(paths.main, appId, 'readonly-main')
      if (main.kind === 'VALID') { return ready(main, 'MAIN', expectedStamp) }
      this.checkRoot()
      if (main.kind === 'ABSENT') { return { kind: 'ABSENT' } }
      let issue = main.error as StateIoError
      return main.kind === 'IO' ? unavailable(issue) : { kind: 'LOST', code: issue.code, stage: issue.stage }
    } catch (error) { return unavailable(failure(error, 'readonly', 'STATE_READ_FAILED')) }
  }

  readHeader(appId: string): StateHeader | null {
    let file: fs.File | null = null
    let stage = 'header-open'
    try {
      let paths = this.paths(appId)
      this.checkRoot()
      if (!this.directoryExists(paths)) { return null }
      try { file = fs.openSync(paths.main, fs.OpenMode.READ_ONLY | fs.OpenMode.NOFOLLOW) }
      catch (error) {
        this.checkRoot()
        if (errorCode(error) === 13900002) { return null }
        throw error as Error
      }
      stage = 'header-read'
      let size = fileSize(file, stage)
      let prefix = readBytes(file, Math.min(size, STATE_HEADER_WINDOW_BYTES), stage)
      let header: StateHeader | undefined
      try {
        let parsed = readStateHeader(strictUtf8(prefix, stage), size <= STATE_HEADER_WINDOW_BYTES)
        if (parsed.kind === 'READY') { header = parsed.header }
      } catch (error) {
        if (!(error instanceof StateFormatError) &&
            (!(error instanceof StateIoError) || error.code !== 'STATE_CORRUPTED')) { throw error as Error }
      }
      if (header !== undefined) {
        if (header.appId !== appId || header.schemaVersion !== STATE_SCHEMA_VERSION) {
          throw new StateIoError('STATE_CORRUPTED', 'header-identity')
        }
        if (fileSize(file, stage) !== size) { throw new StateIoError('STATE_CORRUPTED', 'header-changed') }
        return header
      }
      stage = 'header-full-read'
      let text = strictUtf8(readBytes(file, size, stage), stage)
      if (fileSize(file, stage) !== size) { throw new StateIoError('STATE_CORRUPTED', 'header-changed') }
      return validateStateFile(text, appId, STATE_SCHEMA_VERSION).header || null
    } catch (error) { throw failure(error, stage, 'STATE_READ_FAILED') }
    finally { closeQuietly(file) }
  }

  commit(request: CommitTaskRequest): CommitResult {
    let lock: fs.File | null = null
    try {
      if (!request || !request.pre || typeof request.operationId !== 'string' || request.operationId.length === 0 ||
          !counter(request.pre.vmGeneration) || !counter(request.pre.baseRevision) ||
          request.pre.baseRevision + 1 >= Number.MAX_SAFE_INTEGER || request.schemaVersion !== STATE_SCHEMA_VERSION ||
          typeof request.stamp !== 'string' || request.stamp.indexOf('\u0000') >= 0 ||
          !(request.payload instanceof ArrayBuffer) || typeof request.backupDue !== 'boolean') {
        throw new StateIoError('STATE_VALIDATION_FAILED', 'commit-request')
      }
      let paths = this.paths(request.pre.appId)
      let payload: string
      try {
        payload = strictUtf8(new Uint8Array(request.payload), 'payload')
        if (canonicalPayload(validateEncodedState(payload)) !== payload) {
          throw new StateIoError('STATE_VALIDATION_FAILED', 'payload-canonical')
        }
      } catch (error) {
        if ((error as StateIoError).code === 'STATE_CORRUPTED') {
          throw new StateIoError('STATE_VALIDATION_FAILED', 'payload-utf8')
        }
        throw failure(error, 'payload-validation', 'STATE_VALIDATION_FAILED')
      }
      this.ensureDirectory(paths)
      lock = this.lock(paths)
      if (lock === null) { return { status: 'STALE' } }
      this.checkRoot()
      let main = this.readFile(paths.main, request.pre.appId, 'commit-current')
      if (main.kind === 'ABSENT') {
        let backup = this.readFile(paths.backup, request.pre.appId, 'commit-backup')
        if (backup.kind === 'IO') { throw backup.error as StateIoError }
        if (backup.kind !== 'ABSENT' || request.pre.baseRevision !== 0) { return { status: 'STALE_REVISION' } }
        if (request.pre.vmGeneration !== 1) { return { status: 'FENCED_COMMIT' } }
      } else {
        if (main.kind !== 'VALID') { throw main.error as StateIoError }
        let current = main.data as DecodedStateData
        if (current.vmGeneration !== request.pre.vmGeneration) { return { status: 'FENCED_COMMIT' } }
        if (current.revision !== request.pre.baseRevision) { return { status: 'STALE_REVISION' } }
      }
      let revision = request.pre.baseRevision + 1
      let text: string
      try {
        text = assembleStateFile({
          appId: request.pre.appId, schemaVersion: request.schemaVersion,
          vmGeneration: request.pre.vmGeneration, revision: revision, stamp: request.stamp
        }, payload)
      } catch (error) { throw failure(error, 'commit-assemble', 'STATE_SERIALIZATION_FAILED') }
      this.safeWrite(paths.main, paths.directory, text, 'commit-main')
      let backup: 'WRITTEN' | 'SKIPPED' | 'FAILED' = 'SKIPPED'
      if (request.backupDue) {
        try { this.safeWrite(paths.backup, paths.directory, text, 'commit-backup'); backup = 'WRITTEN' }
        catch (_error) { backup = 'FAILED' }
      }
      return { status: 'COMMITTED', revision: revision, backup: backup }
    } catch (error) { return refused(error, 'commit') }
    finally { releaseLock(lock) }
  }

  publishGeneration(request: PublishGenerationRequest): CommitResult {
    let lock: fs.File | null = null
    try {
      if (!request || typeof request.operationId !== 'string' || request.operationId.length === 0 ||
          !counter(request.nextVmGeneration) || !counter(request.expectedRevision) ||
          typeof request.expectedStamp !== 'string' || request.expectedStamp.indexOf('\u0000') >= 0 ||
          ['MAIN', 'BAK', 'LEGACY', 'ABSENT'].indexOf(request.expectedSource) < 0) {
        throw new StateIoError('STATE_VALIDATION_FAILED', 'publication-request')
      }
      let paths = this.paths(request.appId)
      this.ensureDirectory(paths)
      lock = this.lock(paths)
      if (lock === null) { return { status: 'STALE' } }
      this.checkRoot()
      let main = this.readFile(paths.main, request.appId, 'publication-main')
      if (request.expectedSource === 'ABSENT') {
        let backup = this.readFile(paths.backup, request.appId, 'publication-backup')
        if (main.kind === 'IO') { throw main.error as StateIoError }
        if (backup.kind === 'IO') { throw backup.error as StateIoError }
        if (main.kind !== 'ABSENT' || backup.kind !== 'ABSENT' || request.expectedRevision !== 0 ||
            request.nextVmGeneration !== 1) { return { status: 'STALE_REVISION' } }
        return { status: 'COMMITTED', revision: 0, backup: 'SKIPPED' }
      }
      if (main.kind === 'ABSENT') { return { status: 'STALE_REVISION' } }
      if (main.kind !== 'VALID') { throw main.error as StateIoError }
      let current = main.data as DecodedStateData
      if (current.revision !== request.expectedRevision || current.stamp !== request.expectedStamp ||
          request.nextVmGeneration <= current.vmGeneration) { return { status: 'STALE_REVISION' } }
      if ((request.expectedSource === 'LEGACY') !== (current.format === 'LEGACY')) { return { status: 'STALE_REVISION' } }
      if (request.expectedSource === 'BAK') {
        let backup = this.readFile(paths.backup, request.appId, 'publication-backup')
        if (backup.kind === 'IO') { throw backup.error as StateIoError }
        if (backup.kind !== 'VALID' || (backup.data as DecodedStateData).format !== 'FORMAT2' ||
            backup.text !== main.text) { return { status: 'STALE_REVISION' } }
      }
      let text: string
      try {
        text = assembleStateFile({
          appId: request.appId, schemaVersion: STATE_SCHEMA_VERSION,
          vmGeneration: request.nextVmGeneration, revision: current.revision, stamp: current.stamp
        }, current.encodedState)
      } catch (error) { throw failure(error, 'publication-assemble', 'STATE_SERIALIZATION_FAILED') }
      this.safeWrite(paths.main, paths.directory, text, 'publication-main')
      return { status: 'COMMITTED', revision: current.revision, backup: 'SKIPPED' }
    } catch (error) { return refused(error, 'publication') }
    finally { releaseLock(lock) }
  }
}
