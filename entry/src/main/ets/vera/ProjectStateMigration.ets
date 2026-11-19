import { LoadResult, StateHeader, CommitResult } from '../runtime/StateIo'
import { Version, VersionMetrics } from './ProjectStore'

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

export interface ProjectStateLifecyclePort {
  fenceAllAdmissions(scope: ProjectStateScope): ProjectStateRemovalBarrier
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

export class ProjectStateMigration {
  private metadata: ProjectMigrationMetadata
  private tasks: ProjectStateTaskPoolPort
  private initialState: ProjectInitialStatePort
  private lifecycle: ProjectStateLifecyclePort
  private cleanup: ProjectStateTaskPoolCleanupPort
  private blockedProjects: Set<string> = new Set<string>()
  private blockedApps: Set<string> = new Set<string>()
  private clearingApps: Set<string> = new Set<string>()
  private pending: Map<string, Set<Promise<Object | null>>> = new Map<string, Set<Promise<Object | null>>>()

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
    if (this.blockedProjects.has(projectId) || this.blockedApps.has(appId)) {
      throw new Error('Project state admission fenced: ' + appId)
    }
    return appId
  }

  private track<T extends Object | null>(appId: string, operation: () => Promise<T>): Promise<T> {
    let pending = this.pending.get(appId)
    if (pending === undefined) {
      pending = new Set<Promise<Object | null>>()
      this.pending.set(appId, pending)
    }
    let result = Promise.resolve().then(operation)
    pending.add(result)
    let settle = (): void => {
      pending!.delete(result)
      if (pending!.size === 0) { this.pending.delete(appId) }
    }
    result.then(settle, settle)
    return result
  }

  loadStateResult(projectId: string, versionId: string, stamp: string): Promise<LoadResult> {
    try {
      let appId = this.admit(projectId, versionId)
      return this.track(appId, () => this.tasks.load(appId, stamp))
    } catch (error) { return Promise.reject(error) }
  }

  async loadState(projectId: string, versionId: string, stamp: string): Promise<string> {
    return restorable(await this.loadStateResult(projectId, versionId, stamp), stamp)
  }

  readHeader(projectId: string, versionId: string): Promise<StateHeader | null> {
    try {
      let appId = this.admit(projectId, versionId)
      return this.track(appId, () => this.tasks.readHeader(appId))
    } catch (error) { return Promise.reject(error) }
  }

  createVersion(input: ProjectVersionInput): Promise<Version> {
    try {
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
    return this.remove({ projectId: projectId }, 'PROJECT_DELETED', () => this.metadata.removeProjectMetadata(projectId))
  }

  deleteVersion(projectId: string, versionId: string): Promise<boolean> {
    try {
      this.admit(projectId, versionId)
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
      let appId = this.admit(scope.projectId, scope.versionId || deletedVersionId || '@project')
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
      let accepted: Promise<Object | null>[] = []
      this.pending.forEach((operations: Set<Promise<Object | null>>, key: string): void => {
        if (scope.versionId === undefined ? key.startsWith(scope.projectId + '/') : key === appId) {
          operations.forEach((operation: Promise<Object | null>): void => { accepted.push(operation) })
        }
      })
      return this.finishRemoval(scope, outcome, publish, barrier, accepted, deletedVersionId, resolveOutcome)
    } catch (error) { return Promise.reject(error) }
  }

  private async finishRemoval(scope: ProjectStateScope, outcome: ProjectRemovalOutcome,
      publish: () => void, barrier: ProjectStateRemovalBarrier,
      accepted: Promise<Object | null>[], deletedVersionId: string,
      resolveOutcome?: () => ProjectRemovalOutcome): Promise<void> {
    let failure: Error = new Error('Project state removal failed')
    let failed = false
    let settle = async (operation: () => Promise<Object | null | void>): Promise<void> => {
      try { await operation() } catch (error) {
        if (!failed) { failure = error as Error; failed = true }
      }
    }
    let pending = accepted.map((operation: Promise<Object | null>): Promise<void> => settle(() => operation))
    try {
      await settle(() => barrier.quiesceActorsAndFinalSave())
      await Promise.all(pending)
      await settle(() => barrier.drainAllCallersAndStorage())
      if (failed) { throw failure }
      if (resolveOutcome !== undefined) { outcome = resolveOutcome() }
      let cleanupScope: ProjectStateScope = { projectId: scope.projectId, versionId: scope.versionId }
      if (deletedVersionId.length > 0 && outcome === 'VERSION_DELETED') { cleanupScope.versionId = deletedVersionId }
      await this.cleanup.removeStateFilesKeepingStableLocks(cleanupScope)
      publish()
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
      try { barrier.release('FAILED') } catch (_releaseError) {}
      throw error as Error
    }
  }
}
