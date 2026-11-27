import { fileIo as fs } from '@kit.CoreFileKit'
import { util } from '@kit.ArkTS'
import { systemDateTime, BusinessError } from '@kit.BasicServicesKit'
import { requestHeadline } from './ProjectText'
import { ProjectStateMigration, ProjectStateLifecycles } from './ProjectStateMigration'
import type {
  ProjectMigrationMetadata, ProjectVersionInput, ProjectStateLifecyclePort, ProjectStateTaskPoolPort,
  ProjectInitialStatePort, ProjectStateTaskPoolCleanupPort, ProjectStateScope,
  ProjectStateRecoveryOwner, ProjectStateRecoveryScope
} from './ProjectStateMigration'
import { StateIoTaskPool } from '../runtime/StateIoTaskPool'
import { StateCleanupTaskPool } from '../runtime/StateCleanupTaskPool'
import { StateManager } from '../runtime/StateManager'
import type { StateManagerOptions } from '../runtime/StateManager'
import type { StateStoragePort, StateStorageFactory } from '../runtime/shared/StatePort'
import { StateIoError } from '../runtime/StateIo'
import type { LoadResult, StateHeader, CommitResult, StateCleanupScope } from '../runtime/StateIo'
import { canonicalPayload, validateEncodedState, statePayloadBytes } from '../runtime/StateFileFormat'
import { BytecodeModule, VirtualMachine, EmptyHostEnvironment, NULL_VALUE, decodeRuntimeValue } from './VeraInterpreter'
import type { RuntimeValue } from './VeraInterpreter'

export const STATE_MAX_BYTES: number = 1048576

export interface ProjectRuntimeFlags {
  vmJournal: boolean
  journalMode: 'JOURNAL'
}


export class Project {
  id: string = ''
  name: string = ''
  icon: string = ''
  createdAt: number = 0
}

/** What the project list shows of a project, without opening each of its versions every time it is drawn. */
export class ProjectSummary {
  versions: number = 0
  /** The request the latest version began as. */
  request: string = ''
  /** When it was last worked on: its latest version, or its creation when it has none. */
  updatedAt: number = 0
}

export class VersionMetrics {
  provider: string = ''
  model: string = ''
  elapsedMs: number = 0
  runs: number = 0
  attempts: number = 0
  inputTokens: number = -1
  cacheHitTokens: number = -1
  outputTokens: number = -1
  estimatedUsd: number = -1
  partial: boolean = true
}

export class Version {
  id: string = ''
  projectId: string = ''
  source: string = ''
  vbc2: string = ''
  /** Short label for the version list. */
  note: string = ''
  /**
   * The request that produced this version, in full. `note` is a truncation of
   * it for the list, and used to be all that was kept -- so the instruction a
   * program was built from was lost as soon as it exceeded a hundred characters.
   */
  prompt: string = ''
  lastPrompt: string = ''
  parentVersionId: string = ''
  /**
   * How the version came about when it began as a composed template: the section kinds Jev chose,
   * comma-separated ("record_log,bar_chart"), with "+model" appended when the model then rewrote
   * it. Empty for a program written from scratch and for versions saved before this was kept.
   */
  origin: string = ''
  /**
   * The composition record (VeraComposition.ets) as JSON when this version is a composed screen the
   * model has not rewritten: what a structural edit rebuilds the program from. Empty otherwise.
   */
  composition: string = ''
  metrics: VersionMetrics | null = null
  createdAt: number = 0
}

function generateId(): string {
  let now = Date.now()
  let rand = Math.floor(Math.random() * 0xFFFFFF)
  return now.toString(36) + rand.toString(36)
}

function ensureDir(path: string): void {
  try { fs.mkdirSync(path, true) } catch (_e) {}
}

function readJson(path: string, maxBytes: number = 0, rejectOversized: boolean = false): string {
  let oversized = false
  try {
    let stat = fs.statSync(path)
    if (stat.size === 0) { return '' }
    if (maxBytes > 0) {
      oversized = stat.size > maxBytes
      if (!oversized) {
        let text = fs.readTextSync(path, { length: maxBytes + 1 })
        oversized = text.length > 0 && new util.TextEncoder().encodeInto(text).length > maxBytes
        if (!oversized) { return text }
      }
    } else {
      return fs.readTextSync(path)
    }
  } catch (_e) {}
  if (oversized && rejectOversized) { throw new Error('PROJECT_READ_LIMIT') }
  return ''
}

function writeJson(path: string, content: string): void {
  let file: fs.File | null = null
  let failed = false
  try {
    file = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC)
    let expectedBytes = new util.TextEncoder().encodeInto(content).byteLength
    let writtenBytes = fs.writeSync(file.fd, content)
    if (writtenBytes !== expectedBytes) { throw new Error('PROJECT_METADATA_WRITE_INCOMPLETE') }
  } catch (e) {
    failed = true
    throw e as Error
  } finally {
    if (file !== null) {
      try {
        fs.closeSync(file)
      } catch (e) {
        if (!failed) { throw e as Error }
      }
    }
  }
}

class ProjectStateTasks implements ProjectStateTaskPoolPort {
  private store: ProjectStore

  constructor(store: ProjectStore) { this.store = store }

  async load(appId: string, stamp: string): Promise<LoadResult> {
    let storage = this.store.createStateStorage()
    try { return await storage.load(appId, stamp) } finally { await storage.close() }
  }

  async readHeader(appId: string): Promise<StateHeader | null> {
    let storage = this.store.createStateStorage()
    try { return await storage.readHeader(appId) } finally { await storage.close() }
  }
}

class ProjectInitialState implements ProjectInitialStatePort {
  private accept: (appId: string, stamp: string, encoded: string) => Promise<CommitResult>

  constructor(accept: (appId: string, stamp: string, encoded: string) => Promise<CommitResult>) {
    this.accept = accept
  }

  acceptInitialState(appId: string, stamp: string, encoded: string): Promise<CommitResult> {
    return this.accept(appId, stamp, encoded)
  }
}

class ProjectStateCleanup implements ProjectStateTaskPoolCleanupPort {
  private root: string
  private uncertain: Map<string, StateIoError> = new Map<string, StateIoError>()

  constructor(root: string) { this.root = root }

  async removeStateFilesKeepingStableLocks(scope: ProjectStateScope): Promise<void> {
    let prior = this.uncertain.get(scope.projectId)
    if (prior !== undefined) { throw prior as Error }
    let cleanup = new StateCleanupTaskPool(this.root, { directoryFsync: 'REQUIRED' })
    let cleanupScope: StateCleanupScope = { projectId: scope.projectId, versionId: scope.versionId }
    try { await cleanup.removeStateFilesKeepingStableLocks(cleanupScope) }
    catch (error) {
      if (error instanceof StateIoError && error.code === 'STATE_COMMIT_UNCERTAIN') {
        this.uncertain.set(scope.projectId, error)
      }
      throw error as Error
    }
  }
}

class ProjectInitialStateOptions implements StateManagerOptions {
  appId: string
  stamp: string
  mode: 'LIVE_PERSISTENT' = 'LIVE_PERSISTENT'
  stateMaxBytes: number = STATE_MAX_BYTES
  initialState: RuntimeValue = NULL_VALUE
  storageFactory: StateStorageFactory
  rollbackGuard?: VirtualMachine
  vmJournal: boolean
  journalMode: 'JOURNAL'

  constructor(appId: string, stamp: string, factory: StateStorageFactory,
      guard: VirtualMachine | undefined, flags: ProjectRuntimeFlags) {
    this.appId = appId
    this.stamp = stamp
    this.storageFactory = factory
    this.rollbackGuard = guard
    this.vmJournal = flags.vmJournal
    this.journalMode = flags.journalMode
  }
}

class ProjectStateStorageFactory implements StateStorageFactory {
  private store: ProjectStore

  constructor(store: ProjectStore) { this.store = store }

  create(): StateStoragePort { return this.store.createStateStorage() }
}

export class ProjectStore {
  private root: string = ''
  private migration: ProjectStateMigration | null = null
  private lifecycles: ProjectStateLifecycles = new ProjectStateLifecycles()

  init(filesDir: string): void {
    let root = filesDir + '/vera'
    if (this.root.length > 0 && this.root !== root) { throw new Error('Project state root already initialized') }
    this.root = root
    ensureDir(this.root)
  }

  stateRoot(): string {
    if (this.root.length === 0) { throw new Error('Project state root not initialized') }
    return this.root
  }

  runtimeFlags(): ProjectRuntimeFlags {
    let safe: ProjectRuntimeFlags = { vmJournal: true, journalMode: 'JOURNAL' }
    try {
      let raw = JSON.parse(readJson(this.stateRoot() + '/runtime-flags.json', 4096)) as Record<string, Object>
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw) ||
          Object.keys(raw).length !== 2 || (raw['vmJournal'] !== 'on' && raw['vmJournal'] !== 'off') ||
          raw['journalMode'] !== 'JOURNAL') { return safe }
      return { vmJournal: raw['vmJournal'] === 'on', journalMode: 'JOURNAL' }
    } catch (_error) { return safe }
  }

  createStateStorage(): StateStoragePort {
    return new StateIoTaskPool(this.stateRoot(), { directoryFsync: 'REQUIRED' }, STATE_MAX_BYTES)
  }

  registerStateLifecycle(port: ProjectStateLifecyclePort): () => void {
    return this.lifecycles.register(port)
  }

  assertStateAdmission(appId: string): void {
    this.stateMigration().assertStateAdmission(appId)
  }

  trackStateOperation<T>(appId: string, operation: () => Promise<T>): Promise<T> {
    return this.stateMigration().trackStateOperation(appId, operation)
  }

  trackStateActivation<T>(appId: string, operation: (owner: ProjectStateRecoveryOwner) => Promise<T>): Promise<T> {
    return this.stateMigration().trackStateActivation(appId, operation)
  }

  withExclusiveStateRecovery<T>(appId: string, owner: ProjectStateRecoveryOwner,
      operation: (scope: ProjectStateRecoveryScope) => Promise<T>): Promise<T> {
    return this.stateMigration().withExclusiveStateRecovery(appId, owner, operation)
  }

  private stateMigration(): ProjectStateMigration {
    if (this.migration === null) {
      let cleanupPort = new ProjectStateCleanup(this.stateRoot())
      let tasks = new ProjectStateTasks(this)
      let initialState = new ProjectInitialState((appId: string, stamp: string, encoded: string): Promise<CommitResult> =>
        this.acceptInitialState(appId, stamp, encoded))
      this.migration = new ProjectStateMigration(this.migrationMetadata(), tasks, initialState, this.lifecycles, cleanupPort)
    }
    return this.migration
  }

  private async acceptInitialState(appId: string, stamp: string, encoded: string): Promise<CommitResult> {
    let payload = canonicalPayload(validateEncodedState(encoded))
    if (statePayloadBytes(payload).byteLength > STATE_MAX_BYTES) { throw new Error('PROJECT_READ_LIMIT') }
    let seed = decodeRuntimeValue(JSON.parse(payload) as Object)
    let flags = this.runtimeFlags()
    let guard = flags.vmJournal ? new VirtualMachine(new BytecodeModule([], []), new EmptyHostEnvironment(), 0,
      { now: (): number => systemDateTime.getUptime(systemDateTime.TimeType.STARTUP), deadlineMs: 1000 },
      { journalMode: flags.journalMode }) : undefined
    let storageFactory = new ProjectStateStorageFactory(this)
    let options = new ProjectInitialStateOptions(appId, stamp, storageFactory, guard, flags)
    let manager = new StateManager(options)
    try {
      let loaded = await manager.load()
      if (loaded.kind !== 'ABSENT') { throw new Error('Initial state target is not absent') }
      let published = await manager.publishGeneration()
      if (published.status !== 'UNCHANGED' || published.reason !== 'ABSENT') {
        throw new Error('Initial state generation not accepted: ' + published.status)
      }
      let tx = manager.beginTurn('IMMEDIATE', 'CARRY')
      manager.setWorkingState(tx, seed)
      let result = await manager.commitTurn(tx)
      if (result.status !== 'COMMITTED') { throw new Error('Initial state not accepted: ' + result.status) }
      return result
    } finally { await manager.close() }
  }

  private indexPath(): string { return this.root + '/index.json' }
  private projectDir(id: string): string { return this.root + '/' + id }
  private versionPath(projectId: string, versionId: string): string {
    return this.projectDir(projectId) + '/' + versionId + '.json'
  }

  loadState(projectId: string, versionId: string, stamp: string, maxBytes: number = 0): Promise<string> {
    return this.stateMigration().loadState(projectId, versionId, stamp, maxBytes)
  }

  clearState(projectId: string, versionId: string): Promise<void> {
    return this.stateMigration().clearState(projectId, versionId)
  }

  private readIndex(maxBytes: number = 0): Project[] {
    let text = readJson(this.indexPath(), maxBytes)
    if (text.length === 0) { return [] }
    try {
      let arr = JSON.parse(text) as Object[]
      let result: Project[] = []
      for (let item of arr) {
        let p = new Project()
        let obj = item as Record<string, Object>
        p.id = obj['id'] as string
        p.name = obj['name'] as string
        p.icon = obj['icon'] as string
        p.createdAt = obj['createdAt'] as number
        result.push(p)
      }
      return result
    } catch (_e) { return [] }
  }

  private writeIndex(projects: Project[]): void {
    let arr: Object[] = []
    for (let p of projects) {
      let obj: Record<string, Object> = {}
      obj['id'] = p.id
      obj['name'] = p.name
      obj['icon'] = p.icon
      obj['createdAt'] = p.createdAt
      arr.push(obj)
    }
    let path = this.indexPath()
    let temp = path + '.' + Date.now().toString() + '.' + Math.random().toString().substring(2) + '.tmp'
    try {
      writeJson(temp, JSON.stringify(arr))
      fs.renameSync(temp, path)
    } catch (error) {
      throw error as Error
    } finally {
      try { fs.unlinkSync(temp) } catch (_error) {}
    }
  }

  listProjects(maxBytes: number = 0): Project[] {
    return this.readIndex(maxBytes)
  }

  /** Per project, read from its versions once and kept until a version is saved or deleted. */
  private summaries: Map<string, ProjectSummary> = new Map<string, ProjectSummary>()

  summaryOf(project: Project): ProjectSummary {
    let known = this.summaries.get(project.id)
    if (known !== undefined) { return known }
    let versions = this.listVersions(project.id)
    let summary = new ProjectSummary()
    summary.versions = versions.length
    summary.updatedAt = project.createdAt
    if (versions.length > 0) {
      summary.updatedAt = Math.max(project.createdAt, versions[0].createdAt)
      summary.request = requestHeadline(versions[0].prompt, versions[0].note)
    }
    this.summaries.set(project.id, summary)
    return summary
  }

  getProject(id: string): Project | null {
    let projects = this.readIndex()
    for (let p of projects) {
      if (p.id === id) { return p }
    }
    return null
  }

  createProject(name: string, icon: string): Project {
    let p = new Project()
    p.id = generateId()
    p.name = name
    p.icon = icon
    p.createdAt = Date.now()
    let projects = this.readIndex()
    projects.push(p)
    this.writeIndex(projects)
    ensureDir(this.projectDir(p.id))
    return p
  }

  updateProject(id: string, name: string, icon: string): void {
    let projects = this.readIndex()
    for (let p of projects) {
      if (p.id === id) {
        p.name = name
        p.icon = icon
        break
      }
    }
    this.writeIndex(projects)
  }

  deleteProject(id: string): Promise<void> {
    if (this.getProject(id) === null && !this.canRetryProjectRemoval(id)) { return Promise.resolve() }
    return this.stateMigration().deleteProject(id)
  }

  listVersions(projectId: string, maxBytes: number = 0, canRead: (() => boolean) | null = null): Version[] {
    let dir = this.projectDir(projectId)
    let versions: Version[] = []
    try {
      if (canRead !== null && !canRead()) { return versions }
      let files = fs.listFileSync(dir)
      for (let file of files) {
        if (canRead !== null && !canRead()) { break }
        // Saved program state lives in this directory too, as
        // `<versionId>.state.json` -- which also ends in `.json`. Without this
        // it was read as a version record, and because parseVersion only
        // returned null on a JSON syntax error, the result was a phantom entry
        // in the version list: no date, no bytecode, badged "needs compile".
        if (!file.endsWith('.json') || file.endsWith('.state.json')) { continue }
        let text = readJson(dir + '/' + file, maxBytes)
        if (text.length === 0) { continue }
        let v = this.parseVersion(text)
        if (v !== null) { versions.push(v!) }
      }
    } catch (_e) {}
    versions.sort((a: Version, b: Version): number => b.createdAt - a.createdAt)
    return versions
  }

  getVersion(projectId: string, versionId: string): Version | null {
    let text = readJson(this.versionPath(projectId, versionId))
    if (text.length === 0) { return null }
    return this.parseVersion(text)
  }

  getLatestRunnableVersion(projectId: string): Version | null {
    let versions = this.listVersions(projectId)
    for (let version of versions) {
      if (version.vbc2.length > 0) { return version }
    }
    return null
  }

  getLatestVersion(projectId: string): Version | null {
    let versions = this.listVersions(projectId)
    if (versions.length === 0) { return null }
    return versions[0]
  }

  createVersion(projectId: string, source: string, vbc2: string, note: string,
      prompt: string = '', origin: string = '', composition: string = '',
      lastPrompt: string = '', parentVersionId: string = '', metrics: VersionMetrics | null = null,
      initialState: string = '', initialStamp: string = ''): Promise<Version> {
    return this.stateMigration().createVersion({ projectId: projectId, source: source, vbc2: vbc2, note: note,
      prompt: prompt, origin: origin, composition: composition, lastPrompt: lastPrompt,
      parentVersionId: parentVersionId, metrics: metrics, initialState: initialState, initialStamp: initialStamp })
  }

  private prepareVersion(input: ProjectVersionInput): Version {
    let v = new Version()
    v.id = generateId()
    v.projectId = input.projectId
    v.source = input.source
    v.vbc2 = input.vbc2
    v.note = input.note
    v.prompt = input.prompt || input.note
    v.lastPrompt = input.lastPrompt || v.prompt
    v.parentVersionId = input.parentVersionId || ''
    v.origin = input.origin || ''
    v.composition = input.composition || ''
    v.metrics = input.metrics || null
    v.createdAt = Date.now()
    return v
  }

  private publishVersion(v: Version): void {
    ensureDir(this.projectDir(v.projectId))
    let obj: Record<string, Object> = {}
    obj['id'] = v.id
    obj['projectId'] = v.projectId
    obj['source'] = v.source
    obj['vbc2'] = v.vbc2
    obj['note'] = v.note
    obj['prompt'] = v.prompt
    obj['lastPrompt'] = v.lastPrompt
    obj['parentVersionId'] = v.parentVersionId
    obj['origin'] = v.origin
    obj['composition'] = v.composition
    if (v.metrics !== null) { obj['metrics'] = v.metrics }
    obj['createdAt'] = v.createdAt
    writeJson(this.versionPath(v.projectId, v.id), JSON.stringify(obj))
    this.summaries.delete(v.projectId)
  }

  migrationMetadata(): ProjectMigrationMetadata {
    let metadata: ProjectMigrationMetadata = {
      prepareVersion: (input: ProjectVersionInput): Version => this.prepareVersion(input),
      publishVersion: (version: Version): void => this.publishVersion(version),
      listVersions: (projectId: string): Version[] => this.listVersions(projectId),
      removeVersionMetadata: (projectId: string, versionId: string): void => {
        this.summaries.delete(projectId)
        try { fs.unlinkSync(this.versionPath(projectId, versionId)) } catch (error) {
          if (error === null || error === undefined || (error as BusinessError).code !== 13900002) {
            throw error as Error
          }
        }
      },
      removeProjectMetadata: (projectId: string): void => {
        this.summaries.delete(projectId)
        for (let version of this.listVersions(projectId)) {
          fs.unlinkSync(this.versionPath(projectId, version.id))
        }
        this.writeIndex(this.readIndex().filter((project: Project): boolean => project.id !== projectId))
      }
    }
    return metadata
  }

  updateVersionVbc2(projectId: string, versionId: string, vbc2: string): void {
    let v = this.getVersion(projectId, versionId)
    if (v === null) { return }
    v!.vbc2 = vbc2
    let obj: Record<string, Object> = {}
    obj['id'] = v!.id
    obj['projectId'] = v!.projectId
    obj['source'] = v!.source
    obj['vbc2'] = v!.vbc2
    obj['note'] = v!.note
    // Rewriting the bytecode must not drop the request this version came from.
    obj['prompt'] = v!.prompt
    obj['lastPrompt'] = v!.lastPrompt
    obj['parentVersionId'] = v!.parentVersionId
    obj['origin'] = v!.origin
    obj['composition'] = v!.composition
    if (v!.metrics !== null) { obj['metrics'] = v!.metrics! }
    obj['createdAt'] = v!.createdAt
    writeJson(this.versionPath(projectId, versionId), JSON.stringify(obj))
  }

  canRetryProjectRemoval(projectId: string): boolean {
    return this.stateMigration().canRetryProjectRemoval(projectId)
  }

  canRetryVersionRemoval(projectId: string, versionId: string): boolean {
    return this.stateMigration().canRetryVersionRemoval(projectId, versionId)
  }

  deleteVersion(projectId: string, versionId: string): Promise<boolean> {
    return this.stateMigration().deleteVersion(projectId, versionId)
  }

  private metricNumber(obj: Record<string, Object>, key: string): number {
    let value = obj[key]
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : -1
  }

  private parseMetrics(raw: Object): VersionMetrics | null {
    if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) { return null }
    let obj = raw as Record<string, Object>
    let metrics = new VersionMetrics()
    metrics.provider = typeof obj['provider'] === 'string' ? obj['provider'] as string : ''
    metrics.model = typeof obj['model'] === 'string' ? obj['model'] as string : ''
    metrics.elapsedMs = this.metricNumber(obj, 'elapsedMs')
    metrics.runs = this.metricNumber(obj, 'runs')
    metrics.attempts = this.metricNumber(obj, 'attempts')
    metrics.inputTokens = this.metricNumber(obj, 'inputTokens')
    metrics.cacheHitTokens = this.metricNumber(obj, 'cacheHitTokens')
    metrics.outputTokens = this.metricNumber(obj, 'outputTokens')
    metrics.estimatedUsd = this.metricNumber(obj, 'estimatedUsd')
    metrics.partial = obj['partial'] !== false || metrics.elapsedMs < 0 || metrics.runs < 0 ||
      metrics.attempts < 0 || metrics.inputTokens < 0 || metrics.cacheHitTokens < 0 ||
      metrics.outputTokens < 0 || metrics.estimatedUsd < 0
    return metrics
  }

  private parseVersion(text: string): Version | null {
    try {
      let obj = JSON.parse(text) as Record<string, Object>
      // Parsing succeeded, but that only says the file is JSON -- not that it
      // is a version. A record with no id is some other file, and returning a
      // Version full of undefined fields hides that from every caller.
      let id = (obj['id'] as string) || ''
      if (id.length === 0) { return null }
      let v = new Version()
      v.id = id
      v.projectId = obj['projectId'] as string
      v.source = obj['source'] as string
      v.vbc2 = (obj['vbc2'] as string) || ''
      v.note = (obj['note'] as string) || ''
      // Versions saved before prompts were kept fall back to the truncated note.
      v.prompt = (obj['prompt'] as string) || v.note
      v.lastPrompt = (obj['lastPrompt'] as string) || v.prompt
      v.parentVersionId = (obj['parentVersionId'] as string) || ''
      v.origin = (obj['origin'] as string) || ''
      v.composition = (obj['composition'] as string) || ''
      v.metrics = this.parseMetrics(obj['metrics'])
      v.createdAt = obj['createdAt'] as number
      return v
    } catch (_e) { return null }
  }
}

export const store: ProjectStore = new ProjectStore()
