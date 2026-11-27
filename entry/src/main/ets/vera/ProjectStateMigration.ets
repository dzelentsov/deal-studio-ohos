import type { LoadResult, StateHeader, CommitResult, StateIoError } from '../runtime/StateIo'
import { statePayloadBytes } from '../runtime/StateFileFormat'
import type { Version, VersionMetrics } from './ProjectStore'

export interface ProjectVersionInput {
  projectId: string
  source: string
  vbc2: string
  note: string
  prompt?: string
  origin?: string
  composition?: string
  lastPrompt?: string
  parentVersionId?: string
  metrics?: VersionMetrics | null
  initialState?: string
  initialStamp?: string
}

export interface ProjectMigrationMetadata {
  prepareVersion: (input: ProjectVersionInput) => Version
  publishVersion: (version: Version) => void
  listVersions: (projectId: string) => Version[]
  removeVersionMetadata: (projectId: string, versionId: string) => void
  removeProjectMetadata: (projectId: string) => void
}

export interface ProjectStateTaskPoolPort {
  load(appId: string, expectedStamp: string): Promise<LoadResult>
  readHeader(appId: string): Promise<StateHeader | null>
}

export interface ProjectInitialStatePort {
  acceptInitialState(appId: string, stamp: string, encoded: string): Promise<CommitResult>
}

export interface ProjectStateScope {
  projectId: string
  versionId?: string
}

export type ProjectRemovalOutcome = 'CLEARED' | 'VERSION_DELETED' | 'PROJECT_DELETED' | 'FAILED'

export interface ProjectStateRemovalBarrier {
  quiesceActorsAndFinalSave(): Promise<void>
  drainAllCallersAndStorage(): Promise<void>
  release(outcome: ProjectRemovalOutcome): void
}

class ProjectStateRecoveryToken {
  private marker: boolean = true
}

export type ProjectStateRecoveryOwner = ProjectStateRecoveryToken

export interface ProjectStateRecoveryScope {
  complete: () => void
}

export interface ProjectStateRecoveryBarrier {
  drainOtherActorsAndStorage(): Promise<void>
  release(): void
}

export interface ProjectStateLifecyclePort {
  fenceAllAdmissions(scope: ProjectStateScope): ProjectStateRemovalBarrier
  fenceRecoveryAdmissions?(appId: string, owner: ProjectStateRecoveryOwner): ProjectStateRecoveryBarrier
}

interface ProjectStateActivation {
  appId: string
  pending: Promise<void>
  recoveryStarted: boolean
}

class ProjectStateAggregateRecoveryBarrier implements ProjectStateRecoveryBarrier {
  private barriers: ProjectStateRecoveryBarrier[]
  private failure: Error
  private failed: boolean
  private released: () => void

  constructor(barriers: ProjectStateRecoveryBarrier[], failure: Error, failed: boolean, released: () => void) {
    this.barriers = barriers
    this.failure = failure
    this.failed = failed
    this.released = released
  }

  async drainOtherActorsAndStorage(): Promise<void> {
    let failure = this.failure
    let failed = this.failed
    await Promise.all(this.barriers.map(async (barrier: ProjectStateRecoveryBarrier): Promise<void> => {
      try { await barrier.drainOtherActorsAndStorage() }
      catch (error) { if (!failed) { failure = error as Error; failed = true } }
    }))
    if (failed) { throw failure }
  }

  release(): void {
    for (let barrier of this.barriers) { barrier.release() }
    this.released()
  }
}

class ProjectStateAggregateBarrier implements ProjectStateRemovalBarrier {
  private barriers: ProjectStateRemovalBarrier[]
  private failure: Error
  private failed: boolean

  constructor(barriers: ProjectStateRemovalBarrier[], failure: Error, failed: boolean) {
    this.barriers = barriers
    this.failure = failure
    this.failed = failed
  }

  private async drain(operation: (barrier: ProjectStateRemovalBarrier) => Promise<void>): Promise<void> {
    let issue: Error = new Error('Project state lifecycle drain failed')
    let drainFailed = false
    await Promise.all(this.barriers.map(async (barrier: ProjectStateRemovalBarrier): Promise<void> => {
      try { await operation(barrier) } catch (error) { if (!drainFailed) { issue = error as Error; drainFailed = true } }
    }))
    if (this.failed) { throw this.failure }
    if (drainFailed) { throw issue }
  }

  quiesceActorsAndFinalSave(): Promise<void> {
    return this.drain((barrier: ProjectStateRemovalBarrier): Promise<void> => barrier.quiesceActorsAndFinalSave())
  }

  drainAllCallersAndStorage(): Promise<void> {
    return this.drain((barrier: ProjectStateRemovalBarrier): Promise<void> => barrier.drainAllCallersAndStorage())
  }

  release(outcome: ProjectRemovalOutcome): void {
    let issue: Error = new Error('Project state lifecycle release failed')
    let failed = false
    for (let barrier of this.barriers) {
      try { barrier.release(outcome) } catch (error) { if (!failed) { issue = error as Error; failed = true } }
    }
    if (failed) { throw issue }
  }
}

export class ProjectStateLifecycles implements ProjectStateLifecyclePort {
  private ports: Set<ProjectStateLifecyclePort> = new Set<ProjectStateLifecyclePort>()
  private recoveries: Set<string> = new Set<string>()

  register(port: ProjectStateLifecyclePort): () => void {
    if (this.recoveries.size > 0) { throw new Error('Project state lifecycle registration fenced by recovery') }
    if (this.ports.has(port)) { throw new Error('Project state lifecycle already registered') }
    this.ports.add(port)
    return (): void => { this.ports.delete(port) }
  }

  fenceAllAdmissions(scope: ProjectStateScope): ProjectStateRemovalBarrier {
    let barriers: ProjectStateRemovalBarrier[] = []
    let failure: Error = new Error('Project state lifecycle fence failed')
    let failed = false
    for (let port of Array.from(this.ports)) {
      try {
        barriers.push(port.fenceAllAdmissions({ projectId: scope.projectId, versionId: scope.versionId }))
      } catch (error) { if (!failed) { failure = error as Error; failed = true } }
    }
    return new ProjectStateAggregateBarrier(barriers, failure, failed)
  }

  fenceRecoveryAdmissions(appId: string, owner: ProjectStateRecoveryOwner): ProjectStateRecoveryBarrier {
    if (this.recoveries.has(appId)) { throw new Error('Project state recovery already fenced: ' + appId) }
    this.recoveries.add(appId)
    let barriers: ProjectStateRecoveryBarrier[] = []
    let failure: Error = new Error('Project state recovery fence failed')
    let failed = false
    for (let port of Array.from(this.ports)) {
      try {
        if (port.fenceRecoveryAdmissions === undefined) { throw new Error('Project state recovery lifecycle unsupported') }
        barriers.push(port.fenceRecoveryAdmissions(appId, owner))
      } catch (error) { if (!failed) { failure = error as Error; failed = true } }
    }
    return new ProjectStateAggregateRecoveryBarrier(barriers, failure, failed, (): void => { this.recoveries.delete(appId) })
  }
}

export interface ProjectStateTaskPoolCleanupPort {
  removeStateFilesKeepingStableLocks(scope: ProjectStateScope): Promise<void>
}

export interface ProjectCommittedReadOnlyPort {
  readCommittedReadOnly(appId: string, expectedStamp: string): LoadResult
}

function identity(projectId: string, versionId: string): string {
  for (let part of [projectId, versionId]) {
    if (part.length === 0 || part === '.' || part === '..' || /[\/\\\u0000-\u001f]/.test(part)) {
      throw new Error('Invalid project state identity')
    }
  }
  return projectId + '/' + versionId
}

function restorable(result: LoadResult, stamp: string): string {
  if (result.kind === 'UNAVAILABLE') { throw new Error(result.code || 'STATE_UNAVAILABLE') }
  return result.kind === 'READY' && result.stamp === stamp ? result.encodedState || '' : ''
}

export class FormProjectStateReader {
  private reader: ProjectCommittedReadOnlyPort

  constructor(reader: ProjectCommittedReadOnlyPort) { this.reader = reader }

  loadStateResult(projectId: string, versionId: string, stamp: string): LoadResult {
    return this.reader.readCommittedReadOnly(identity(projectId, versionId), stamp)
  }

  loadState(projectId: string, versionId: string, stamp: string): string {
    return restorable(this.loadStateResult(projectId, versionId, stamp), stamp)
  }
}

interface ProjectMetadataRemoval {
  scope: ProjectStateScope
  requestedOutcome: ProjectRemovalOutcome
  outcome: ProjectRemovalOutcome
  deletedVersionId: string
  publish: () => void
}

export class ProjectStateMigration {
  private metadata: ProjectMigrationMetadata
  private tasks: ProjectStateTaskPoolPort
  private initialState: ProjectInitialStatePort
  private lifecycle: ProjectStateLifecyclePort
  private cleanup: ProjectStateTaskPoolCleanupPort
  private blockedProjects: Set<string> = new Set<string>()
  private blockedApps: Set<string> = new Set<string>()
  private clearingApps: Set<string> = new Set<string>()
  private retryableRemovals: Set<string> = new Set<string>()
  private metadataRemovals: Map<string, ProjectMetadataRemoval> = new Map<string, ProjectMetadataRemoval>()
  private pending: Map<string, Set<Promise<void>>> = new Map<string, Set<Promise<void>>>()
  private activationOwners: Map<string, ProjectStateRecoveryOwner> = new Map<string, ProjectStateRecoveryOwner>()
  private activations: Map<ProjectStateRecoveryOwner, ProjectStateActivation> = new Map<ProjectStateRecoveryOwner, ProjectStateActivation>()
  private recoveringApps: Set<string> = new Set<string>()

  constructor(metadata: ProjectMigrationMetadata, tasks: ProjectStateTaskPoolPort,
      initialState: ProjectInitialStatePort, lifecycle: ProjectStateLifecyclePort,
      cleanup: ProjectStateTaskPoolCleanupPort) {
    this.metadata = metadata
    this.tasks = tasks
    this.initialState = initialState
    this.lifecycle = lifecycle
    this.cleanup = cleanup
  }

  private admit(projectId: string, versionId: string): string {
    let appId = identity(projectId, versionId)
    this.assertStateAdmission(appId)
    return appId
  }

  assertStateAdmission(appId: string): void {
    let parts = appId.split('/')
    if (parts.length !== 2) { throw new Error('Invalid project state identity') }
    identity(parts[0], parts[1])
    if (this.blockedProjects.has(parts[0]) || this.blockedApps.has(appId) || this.recoveringApps.has(appId)) {
      throw new Error('Project state admission fenced: ' + appId)
    }
  }

  trackStateOperation<T>(appId: string, operation: () => Promise<T>): Promise<T> {
    try {
      this.assertStateAdmission(appId)
      return this.track(appId, operation)
    } catch (error) { return Promise.reject(error) }
  }

  trackStateActivation<T>(appId: string, operation: (owner: ProjectStateRecoveryOwner) => Promise<T>): Promise<T> {
    try {
      this.assertStateAdmission(appId)
      if (this.activationOwners.has(appId)) { throw new Error('Project state activation already pending: ' + appId) }
      let owner = new ProjectStateRecoveryToken()
      this.activationOwners.set(appId, owner)
      return this.track(appId, () => operation(owner), owner)
    } catch (error) { return Promise.reject(error) }
  }

  withExclusiveStateRecovery<T>(appId: string, owner: ProjectStateRecoveryOwner,
      operation: (scope: ProjectStateRecoveryScope) => Promise<T>): Promise<T> {
    try {
      this.assertStateAdmission(appId)
      let activation = this.activations.get(owner)
      if (activation === undefined || activation.appId !== appId || activation.recoveryStarted ||
          this.activationOwners.get(appId) !== owner || !this.pending.get(appId)?.has(activation.pending)) {
        throw new Error('Invalid project state recovery owner: ' + appId)
      }
      activation.recoveryStarted = true
      this.recoveringApps.add(appId)
      if (this.lifecycle.fenceRecoveryAdmissions === undefined) {
        throw new Error('Project state recovery lifecycle unsupported')
      }
      let barrier = this.lifecycle.fenceRecoveryAdmissions(appId, owner)
      let initiating = activation.pending
      let accepted = Array.from(this.pending.get(appId)!).filter((pending: Promise<void>): boolean => pending !== initiating)
      return this.finishRecovery(appId, barrier, accepted, operation)
    } catch (error) { return Promise.reject(error) }
  }

  private async finishRecovery<T>(appId: string, barrier: ProjectStateRecoveryBarrier,
      accepted: Promise<void>[], operation: (scope: ProjectStateRecoveryScope) => Promise<T>): Promise<T> {
    let failure: Error = new Error('Project state recovery drain failed')
    let failed = false
    let settle = async (operation: () => Promise<void>): Promise<void> => {
      try { await operation() }
      catch (error) { if (!failed) { failure = error as Error; failed = true } }
    }
    let pending = accepted.map((operation: Promise<void>): Promise<void> => settle(() => operation))
    await settle(() => barrier.drainOtherActorsAndStorage())
    await Promise.all(pending)
    if (failed) { throw failure }
    let completed = false
    let active = true
    let scope: ProjectStateRecoveryScope = {
      complete: (): void => {
        if (!active) { throw new Error('Project state recovery scope closed') }
        completed = true
      }
    }
    let result: T
    try { result = await operation(scope) } finally { active = false }
    if (!completed) { throw new Error('Project state recovery completion required') }
    barrier.release()
    this.recoveringApps.delete(appId)
    return result
  }

  private track<T>(appId: string, operation: () => Promise<T>, owner?: ProjectStateRecoveryOwner): Promise<T> {
    let pending = this.pending.get(appId)
    if (pending === undefined) {
      pending = new Set<Promise<void>>()
      this.pending.set(appId, pending)
    }
    let accepted = pending
    let resolve: (value: T | PromiseLike<T>) => void = (_value: T | PromiseLike<T>): void => {}
    let reject: (reason: Object) => void = (_reason: Object): void => {}
    let result = new Promise<T>((done, fail): void => { resolve = done; reject = fail })
    let tracked = result.then((): void => {}, (error: Error): void => { throw error })
    accepted.add(tracked)
    let settle = (): void => {
      accepted.delete(tracked)
      if (accepted.size === 0) { this.pending.delete(appId) }
    }
    if (owner !== undefined) {
      this.activations.set(owner, { appId: appId, pending: tracked, recoveryStarted: false })
    }
    let finish = (): void => {
      settle()
      if (owner !== undefined) {
        this.activations.delete(owner)
        if (this.activationOwners.get(appId) === owner) { this.activationOwners.delete(appId) }
      }
    }
    tracked.then(finish, finish)
    try { resolve(operation()) } catch (error) { reject(error as Object) }
    return tracked.then((): Promise<T> => result)
  }

  loadStateResult(projectId: string, versionId: string, stamp: string): Promise<LoadResult> {
    try {
      let appId = this.admit(projectId, versionId)
      return this.track(appId, () => this.tasks.load(appId, stamp))
    } catch (error) { return Promise.reject(error) }
  }

  async loadState(projectId: string, versionId: string, stamp: string, maxBytes: number = 0): Promise<string> {
    let encoded = restorable(await this.loadStateResult(projectId, versionId, stamp), stamp)
    if (maxBytes > 0 && statePayloadBytes(encoded).byteLength > maxBytes) { throw new Error('PROJECT_READ_LIMIT') }
    return encoded
  }

  readHeader(projectId: string, versionId: string): Promise<StateHeader | null> {
    try {
      let appId = this.admit(projectId, versionId)
      return this.track(appId, () => this.tasks.readHeader(appId))
    } catch (error) { return Promise.reject(error) }
  }

  createVersion(input: ProjectVersionInput): Promise<Version> {
    try {
      this.admit(input.projectId, '@project')
      let version = this.metadata.prepareVersion(input)
      let appId = this.admit(version.projectId, version.id)
      let encoded = input.initialState || ''
      let stamp = input.initialStamp || ''
      return this.track(appId, async (): Promise<Version> => {
        if (encoded.length > 0) {
          let result = await this.initialState.acceptInitialState(appId, stamp, encoded)
          if (result.status !== 'COMMITTED') { throw new Error('Initial state not accepted: ' + result.status) }
        }
        this.metadata.publishVersion(version)
        return version
      })
    } catch (error) { return Promise.reject(error) }
  }

  async commitSave(check: () => Promise<boolean>, prepare: () => Promise<ProjectVersionInput | null>,
      accepted: (version: Version) => void): Promise<boolean> {
    if (!await check()) { return false }
    let input = await prepare()
    if (input === null) { return false }
    let version = await this.createVersion(input)
    accepted(version)
    return true
  }

  clearState(projectId: string, versionId: string): Promise<void> {
    return this.remove({ projectId: projectId, versionId: versionId }, 'CLEARED', () => {})
  }

  deleteProject(projectId: string): Promise<void> {
    for (let removal of Array.from(this.metadataRemovals.values())) {
      if (removal.scope.projectId === projectId && removal.outcome === 'PROJECT_DELETED') {
        return this.remove(removal.scope, removal.requestedOutcome, removal.publish, removal.deletedVersionId)
      }
    }
    return this.remove({ projectId: projectId }, 'PROJECT_DELETED', () => this.metadata.removeProjectMetadata(projectId))
  }

  canRetryProjectRemoval(projectId: string): boolean {
    identity(projectId, '@project')
    return Array.from(this.metadataRemovals.values()).some((removal: ProjectMetadataRemoval): boolean =>
      removal.scope.projectId === projectId && removal.outcome === 'PROJECT_DELETED')
  }

  canRetryVersionRemoval(projectId: string, versionId: string): boolean {
    identity(projectId, versionId)
    return this.metadataRemovals.has(this.removalKey({ projectId: projectId }, 'VERSION_DELETED', versionId))
  }

  private removalKey(scope: ProjectStateScope, outcome: ProjectRemovalOutcome, deletedVersionId: string): string {
    return JSON.stringify([scope.projectId, scope.versionId || '', outcome, deletedVersionId])
  }

  deleteVersion(projectId: string, versionId: string): Promise<boolean> {
    try {
      let key = this.removalKey({ projectId: projectId }, 'VERSION_DELETED', versionId)
      let removal = this.metadataRemovals.get(key)
      if (removal !== undefined) {
        let pending = removal
        return this.remove(pending.scope, pending.requestedOutcome, pending.publish, pending.deletedVersionId)
          .then((): boolean => pending.outcome === 'PROJECT_DELETED')
      }
      if (!this.retryableRemovals.has(key)) { this.admit(projectId, versionId) }
      let versions = this.metadata.listVersions(projectId)
      if (!versions.some((version: Version): boolean => version.id === versionId)) { return Promise.resolve(false) }
      let last = false
      return this.remove({ projectId: projectId }, 'VERSION_DELETED', () => {
        if (last) { this.metadata.removeProjectMetadata(projectId) }
        else { this.metadata.removeVersionMetadata(projectId, versionId) }
      }, versionId, (): ProjectRemovalOutcome => {
        last = this.metadata.listVersions(projectId).length === 1
        return last ? 'PROJECT_DELETED' : 'VERSION_DELETED'
      }).then(() => last)
    } catch (error) { return Promise.reject(error) }
  }

  private remove(requestedScope: ProjectStateScope, outcome: ProjectRemovalOutcome, publish: () => void,
      deletedVersionId: string = '', resolveOutcome?: () => ProjectRemovalOutcome): Promise<void> {
    try {
      let scope: ProjectStateScope = { projectId: requestedScope.projectId, versionId: requestedScope.versionId }
      let key = this.removalKey(scope, outcome, deletedVersionId)
      let appId = identity(scope.projectId, scope.versionId || deletedVersionId || '@project')
      if (Array.from(this.recoveringApps).some((recovering: string): boolean =>
        scope.versionId === undefined ? recovering.startsWith(scope.projectId + '/') : recovering === appId)) {
        throw new Error('Project state recovery fenced: ' + appId)
      }
      let metadataRemoval = this.metadataRemovals.get(key)
      if (metadataRemoval !== undefined) { this.metadataRemovals.delete(key) }
      else if (this.retryableRemovals.has(key)) { this.retryableRemovals.delete(key) }
      else { this.assertStateAdmission(appId) }
      if (scope.versionId === undefined) {
        if (Array.from(this.clearingApps).some((key: string): boolean => key.startsWith(scope.projectId + '/'))) {
          throw new Error('Project state removal fenced: ' + scope.projectId)
        }
        this.blockedProjects.add(scope.projectId)
      } else {
        this.blockedApps.add(appId)
        this.clearingApps.add(appId)
      }
      let lifecycleScope: ProjectStateScope = { projectId: scope.projectId, versionId: scope.versionId }
      let barrier = this.lifecycle.fenceAllAdmissions(lifecycleScope)
      let accepted: Promise<void>[] = []
      this.pending.forEach((operations: Set<Promise<void>>, key: string): void => {
        if (scope.versionId === undefined ? key.startsWith(scope.projectId + '/') : key === appId) {
          operations.forEach((operation: Promise<void>): void => { accepted.push(operation) })
        }
      })
      return this.finishRemoval(scope, outcome, publish, barrier, accepted, deletedVersionId, resolveOutcome, metadataRemoval)
    } catch (error) { return Promise.reject(error) }
  }

  private async finishRemoval(scope: ProjectStateScope, outcome: ProjectRemovalOutcome,
      publish: () => void, barrier: ProjectStateRemovalBarrier,
      accepted: Promise<void>[], deletedVersionId: string,
      resolveOutcome?: () => ProjectRemovalOutcome, metadataRemoval?: ProjectMetadataRemoval): Promise<void> {
    let key = this.removalKey(scope, outcome, deletedVersionId)
    let requestedOutcome = outcome
    let retryable = false
    let metadataFailed = false
    let failure: Error = new Error('Project state removal failed')
    let failed = false
    let settle = async (operation: () => Promise<Object | null | void>): Promise<void> => {
      try { await operation() } catch (error) {
        if (!failed) { failure = error as Error; failed = true }
      }
    }
    let pending = accepted.map((operation: Promise<void>): Promise<void> => settle(() => operation))
    try {
      await settle(() => barrier.quiesceActorsAndFinalSave())
      await Promise.all(pending)
      await settle(() => barrier.drainAllCallersAndStorage())
      if (failed) { throw failure }
      if (metadataRemoval !== undefined) { outcome = metadataRemoval.outcome }
      else {
        if (resolveOutcome !== undefined) { outcome = resolveOutcome() }
        let cleanupScope: ProjectStateScope = { projectId: scope.projectId, versionId: scope.versionId }
        if (deletedVersionId.length > 0 && outcome === 'VERSION_DELETED') { cleanupScope.versionId = deletedVersionId }
        try { await this.cleanup.removeStateFilesKeepingStableLocks(cleanupScope) }
        catch (error) {
          retryable = error !== null && error !== undefined &&
            ['STATE_VALIDATION_FAILED', 'STATE_WRITE_FAILED', 'STATE_SYNC_FAILED', 'STATE_UNAVAILABLE',
              'STATE_LOCK_UNAVAILABLE', 'STATE_READ_FAILED', 'STATE_TASK_SUBMIT_FAILED'].indexOf((error as StateIoError).code) >= 0
          throw error as Error
        }
      }
      metadataFailed = true
      publish()
      metadataFailed = false
      barrier.release(outcome)
      if (outcome === 'CLEARED') {
        let appId = identity(scope.projectId, scope.versionId!)
        this.blockedApps.delete(appId)
        this.clearingApps.delete(appId)
      }
      if (outcome === 'VERSION_DELETED') {
        this.blockedApps.add(identity(scope.projectId, deletedVersionId))
        this.blockedProjects.delete(scope.projectId)
      }
    } catch (error) {
      try {
        barrier.release('FAILED')
        if (metadataFailed) {
          let removal: ProjectMetadataRemoval = {
            scope: scope, requestedOutcome: requestedOutcome, outcome: outcome,
            deletedVersionId: deletedVersionId, publish: publish
          }
          this.metadataRemovals.set(key, removal)
        } else if (retryable) { this.retryableRemovals.add(key) }
      } catch (_releaseError) {}
      throw error as Error
    }
  }
}
