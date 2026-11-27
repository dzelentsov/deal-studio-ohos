import type { RuntimeValue } from '../../vera/VeraInterpreter'
import type { RuntimeMode } from './Messages'
import type { CommitClass, StateTurnSource } from '../CommitPolicy'
import type {
  LoadResult, CommitResult, CommitTaskRequest, CommitTaskResult, PublishGenerationRequest,
  StateHeader
} from '../StateIo'

export interface StateIdentity {
  readonly appId: string
  readonly stamp: string
}

export interface StateVersion {
  readonly vmGeneration: number
  readonly revision: number
}

export interface StateSnapshot {
  readonly identity: StateIdentity
  readonly version: StateVersion
  readonly encoded: string
  readonly digest: string
}

export interface StateTransaction {
  readonly id: number
  readonly commitClass: CommitClass
  readonly source: StateTurnSource
  readonly hasEffects: boolean
}

export interface StateRollbackScope {
  accept(): void
  rollback(): void
  discard(): void
}

export interface StateRollbackGuard {
  readonly coverage: 'GRAPH_SLOTS_DEFERRED_INTENTS'
  beginTurn(tx: StateTransaction, root: RuntimeValue): StateRollbackScope
}

export interface StateStoragePort {
  load(appId: string, expectedStamp: string): Promise<LoadResult>
  recoverLost?(appId: string, expectedStamp: string): Promise<LoadResult>
  readHeader(appId: string): Promise<StateHeader | null>
  commit(request: CommitTaskRequest): Promise<CommitTaskResult>
  publishGeneration(request: PublishGenerationRequest): Promise<CommitTaskResult>
  whenIdle(): Promise<void>
  close(): Promise<void>
}

export interface StateStorageFactory {
  create(): StateStoragePort
}

export interface InMemoryStateResult {
  readonly status: 'IN_MEMORY'
  readonly vmGeneration: number
  readonly revision: number
}

export interface UnchangedStateResult {
  readonly status: 'UNCHANGED'
  readonly vmGeneration: number
  readonly revision: number
  readonly reason: 'CLEAN' | 'INIT_EQUAL' | 'ABSENT'
}

export interface InMemoryLoadResult {
  readonly kind: 'IN_MEMORY'
}

export type StateAcceptanceResult = CommitResult | InMemoryStateResult | UnchangedStateResult
export type StateLoadResult = LoadResult | InMemoryLoadResult
export type StateReloadReason = 'STALE_REVISION' | 'APP_RESUME'
export type StateCheckpointReason = 'PERIODIC' | 'BACKGROUND' | 'FINAL'
export type StateManagerPhase = 'NEW' | 'STARTING' | 'READY' | 'DEGRADED' | 'RELOAD_PENDING' | 'FAULTED' | 'CLOSED'

export interface StateReloadOutcome {
  readonly status: 'RELOADED' | 'UNCHANGED' | 'RELOAD_PENDING' | 'FAULTED'
  readonly load: StateLoadResult | null
  readonly discardedDirty: boolean
}

export type StateRecreateReason = 'ABSENT' | 'STAMP_MISMATCH' | 'LOST'

export interface StateRecreateRequiredResult {
  readonly status: 'RECREATE_REQUIRED'
  readonly reason: StateRecreateReason
  readonly load: LoadResult
  readonly discardedDirty: boolean
}

export type ReloadResult = StateReloadOutcome | StateRecreateRequiredResult

export interface StateManagerStatus {
  readonly mode: RuntimeMode
  readonly phase: StateManagerPhase
  readonly vmGeneration: number
  readonly baseRevision: number
  readonly dirty: boolean
  readonly dirtySeq: number
  readonly dirtySince: number
  readonly needsReload: boolean
  readonly transientFailures: number
  readonly reloadAttempts: number
  readonly pendingOperations: number
}

export interface StateDiagnostic extends StateDiagnosticMetrics {
  readonly code: string
  readonly appId: string
  readonly vmGeneration: number
  readonly baseRevision: number
  readonly stage: string
  readonly dirtyAgeMs: number
}

export interface StateDiagnosticMetrics {
  readonly vmGeneration?: number
  readonly baseRevision?: number
  readonly revision?: number
  readonly durationMs?: number
  readonly commitClass?: string
  readonly turnSource?: string
  readonly format?: string
  readonly loadSource?: string
  readonly outcome?: string
  readonly dirty?: boolean
  readonly transientFailures?: number
  readonly reloadAttempts?: number
  readonly payloadBytes?: number
  readonly commitsPerSecond?: number
  readonly p95DurationMs?: number
  readonly sampleCount?: number
  readonly windowMs?: number
}

export interface StatePort {
  load(preserveWorkingState?: boolean): Promise<StateLoadResult>
  recoverLost(): Promise<LoadResult>
  beginTurn(commitClass: CommitClass, source?: StateTurnSource): StateTransaction
  getWorkingState(): RuntimeValue
  setWorkingState(tx: StateTransaction, value: RuntimeValue): void
  markEffects(tx: StateTransaction): void
  proveNoMutation(tx: StateTransaction): void
  commitTurn(tx: StateTransaction): Promise<StateAcceptanceResult>
  rollbackTurn(tx: StateTransaction): void
  checkpointIfDue(now: number): Promise<CommitResult | null>
  checkpoint(reason?: StateCheckpointReason): Promise<CommitResult | null>
  reloadAfterExternalWrite(reason: StateReloadReason): Promise<ReloadResult>
  checkOnResume(): Promise<ReloadResult>
  finalSave(): Promise<StateAcceptanceResult>
  committedSnapshot(): StateSnapshot | null
  captureWorkingSnapshot(): string
  publishGeneration(next?: number): Promise<StateAcceptanceResult>
  preparePromotion(): Promise<StateLoadResult>
  awaitReadyForImmediate(): Promise<void>
  whenIdle(): Promise<void>
  status(): StateManagerStatus
  close(): Promise<void>
}
