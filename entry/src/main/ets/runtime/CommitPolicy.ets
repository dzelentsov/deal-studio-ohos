import type { CommitResult } from './StateIo'

export type CommitClass = 'IMMEDIATE' | 'THROTTLED' | 'VOLATILE'
export type StateTurnSource = 'INIT' | 'CARRY' | 'INPUT' | 'EFFECT_RESULT' | 'TICK' | 'SURFACE' | 'MOVE'
export type StateSaveReason = 'IMMEDIATE' | 'THROTTLED' | 'PERIODIC' | 'BACKGROUND' | 'FINAL'

export interface CommitPolicyOptions {
  throttleMs?: number
  checkpointMs?: number
  backupEveryNCommits?: number
  backupMinIntervalMs?: number
  degradedAfter?: number
  reloadMaxAttempts?: number
  publishGenerationDeadlineMs?: number
  publishRetryMs?: number
}

function configured(value: number | undefined, fallback: number, minimum: number): number {
  let result = value === undefined ? fallback : value
  if (!Number.isSafeInteger(result) || result < minimum || result >= Number.MAX_SAFE_INTEGER) {
    throw new Error('STATE_VALIDATION_FAILED: commit policy')
  }
  return result
}

export class CommitPolicy {
  readonly throttleMs: number
  readonly checkpointMs: number
  readonly backupEveryNCommits: number
  readonly backupMinIntervalMs: number
  readonly degradedAfter: number
  readonly reloadMaxAttempts: number
  readonly publishGenerationDeadlineMs: number
  readonly publishRetryMs: number

  constructor(options: CommitPolicyOptions = {}) {
    this.throttleMs = configured(options.throttleMs, 1000, 1000)
    this.checkpointMs = configured(options.checkpointMs, 5000, 1)
    this.backupEveryNCommits = configured(options.backupEveryNCommits, 10, 1)
    this.backupMinIntervalMs = configured(options.backupMinIntervalMs, 60000, 0)
    this.degradedAfter = configured(options.degradedAfter, 3, 1)
    this.reloadMaxAttempts = configured(options.reloadMaxAttempts, 3, 1)
    this.publishGenerationDeadlineMs = configured(options.publishGenerationDeadlineMs, 8000, 1)
    this.publishRetryMs = configured(options.publishRetryMs, 25, 1)
    if (this.checkpointMs > 5000) { throw new Error('STATE_VALIDATION_FAILED: checkpoint interval') }
  }

  classify(source: StateTurnSource, persist: boolean = true): CommitClass {
    if (source === 'INIT' || source === 'CARRY' || source === 'EFFECT_RESULT') { return 'IMMEDIATE' }
    if (source === 'TICK') { return 'THROTTLED' }
    if (source === 'SURFACE' || source === 'MOVE') { return 'VOLATILE' }
    if (source === 'INPUT') { return persist ? 'IMMEDIATE' : 'VOLATILE' }
    throw new Error('STATE_VALIDATION_FAILED: turn source')
  }

  effective(commitClass: CommitClass, hasEffects: boolean): CommitClass {
    if (commitClass !== 'IMMEDIATE' && commitClass !== 'THROTTLED' && commitClass !== 'VOLATILE') {
      throw new Error('STATE_VALIDATION_FAILED: commit class')
    }
    return hasEffects ? 'IMMEDIATE' : commitClass
  }

  throttledDue(now: number, lastCommit: number): boolean {
    return Number.isFinite(now) && now >= 0 && now - lastCommit >= this.throttleMs
  }

  checkpointDue(now: number, lastCommit: number, dirtySince: number): boolean {
    return Number.isFinite(now) && now >= 0 && now - Math.max(lastCommit, dirtySince) >= this.checkpointMs
  }

  backupDue(reason: StateSaveReason, commitsSinceBackup: number, lastBackupAt: number, now: number): boolean {
    return (reason === 'IMMEDIATE' || reason === 'BACKGROUND' || reason === 'FINAL') &&
      commitsSinceBackup + 1 >= this.backupEveryNCommits && now - lastBackupAt >= this.backupMinIntervalMs
  }

  transient(result: CommitResult): boolean {
    return result.status === 'STALE' || result.status === 'FAILED' &&
      (result.code === 'STATE_WRITE_FAILED' || result.code === 'STATE_SYNC_FAILED' ||
        result.code === 'STATE_TASK_SUBMIT_FAILED')
  }
}
