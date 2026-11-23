/**
 * VERA-L VBC2 Virtual Machine — dynamic ArkTS port of vera-server/src/vm.ts.
 *
 * Differences from the TypeScript original:
 *   - one numeric type: every number is a VeraNumberValue (a double). There is
 *     no int and no 32-bit overflow; whole numbers are exact up to 2^53.
 *   - readonly → dropped (not enforced in dynamic ArkTS)
 *   - discriminated union Instruction → class with all fields
 *   - JSON.parse for VBC2 deserialization
 */

let allocationSerial: number = 0
const valueBirths: WeakMap<RuntimeValue, number> = new WeakMap<RuntimeValue, number>()
const cellBirths: WeakMap<Cell, number> = new WeakMap<Cell, number>()
const arrayBirths: WeakMap<RuntimeValue[], number> = new WeakMap<RuntimeValue[], number>()
const objectBirths: WeakMap<Map<string, RuntimeValue>, number> = new WeakMap<Map<string, RuntimeValue>, number>()

function nextAllocationSerial(): number {
  if (!Number.isSafeInteger(allocationSerial) || allocationSerial >= Number.MAX_SAFE_INTEGER) {
    throw new RuntimeTrap('R-JOURNAL', 'allocation serial exhausted')
  }
  allocationSerial += 1
  return allocationSerial
}

export abstract class RuntimeValue {
  constructor() { valueBirths.set(this, nextAllocationSerial()) }
}
export class VeraNumberValue extends RuntimeValue { value: number; constructor(v: number) { super(); this.value = v; } }
export class VeraStringValue extends RuntimeValue { value: string; constructor(v: string) { super(); this.value = v; } }
export class VeraBooleanValue extends RuntimeValue { value: boolean; constructor(v: boolean) { super(); this.value = v; } }
export class VeraNullValue extends RuntimeValue {}
export class VeraArrayValue extends RuntimeValue {
  elements: RuntimeValue[]
  constructor(e: RuntimeValue[]) {
    super()
    if (!arrayBirths.has(e)) { arrayBirths.set(e, 0) }
    this.elements = e
  }
}
export class VeraObjectValue extends RuntimeValue {
  classIdentity: string
  fields: Map<string, RuntimeValue> = new Map<string, RuntimeValue>()
  constructor(identity: string, fields: Map<string, RuntimeValue>) {
    super()
    this.classIdentity = identity
    if (!objectBirths.has(fields)) { objectBirths.set(fields, 0) }
    this.fields = fields
  }
}

export function freshArrayValue(elements: RuntimeValue[]): VeraArrayValue {
  let backing = elements.slice()
  arrayBirths.set(backing, nextAllocationSerial())
  return new VeraArrayValue(backing)
}

export function freshObjectValue(identity: string, fields: Map<string, RuntimeValue>): VeraObjectValue {
  let backing = new Map<string, RuntimeValue>(fields)
  objectBirths.set(backing, nextAllocationSerial())
  return new VeraObjectValue(identity, backing)
}

export class Cell {
  value: RuntimeValue
  constructor(v: RuntimeValue) { cellBirths.set(this, nextAllocationSerial()); this.value = v; }
}

export class FunctionValue extends RuntimeValue {
  name: string
  captures: Cell[]
  constructor(name: string, captures: Cell[]) { super(); this.name = name; this.captures = captures; }
}

export class ExternalFunctionValue extends RuntimeValue {
  module: string
  funcName: string
  constructor(mod: string, name: string) { super(); this.module = mod; this.funcName = name; }
}

export const NULL_VALUE: VeraNullValue = new VeraNullValue()

export class RuntimeTrap extends Error {
  trapCode: string
  /** The source line it happened on: 0 until the frame it happened in has said, -1 when the bytecode has no lines. */
  line: number = 0
  /** For a trap from running too long or a list growing without end: the line of the loop it was in, else 0. */
  loopLine: number = 0
  constructor(code: string, message: string) { super(message); this.trapCode = code; }
}

export interface VmHostSafetyScope {
  accept(): void
  rollback(): void
  discard(): void
}

export interface VmSafetyOptions {
  journalMode?: 'JOURNAL'
  journalMaxEntries?: number
}

export interface VmSafetyDiagnostics {
  readonly journalReservations: number
  readonly journalUndoRecords: number
  readonly runtimeBirthSerial: number
}

export interface VmSafetyTurnScope {
  accept(): void
  rollback(): void
  discard(): void
}

class VmTurnToken {}

class EmptyVmHostSafetyScope implements VmHostSafetyScope {
  accept(): void {}
  rollback(): void {}
  discard(): void {}
}

class VmSafetyTurnScopeRecord implements VmSafetyTurnScope {
  accept: () => void
  rollback: () => void
  discard: () => void

  constructor(settle: (receiver: VmSafetyTurnScope, action: string) => void) {
    class VmSafetyTurnCallbacks implements VmSafetyTurnScope {
      accept(): void { settle(this, 'accept') }
      rollback(): void { settle(this, 'rollback') }
      discard(): void { settle(this, 'discard') }
    }
    let callbacks: VmSafetyTurnCallbacks = new VmSafetyTurnCallbacks()
    this.accept = callbacks.accept
    this.rollback = callbacks.rollback
    this.discard = callbacks.discard
  }
}

class VmUndoRecord {
  array: RuntimeValue[] | null = null
  fields: Map<string, RuntimeValue> | null = null
  cell: Cell | null = null
  index: number = 0
  key: string = ''
  length: number = 0
  value: RuntimeValue = NULL_VALUE
  kind: string
  constructor(kind: string) { this.kind = kind }

  undo(): void {
    if (this.cell !== null) { this.cell.value = this.value }
    else if (this.fields !== null) { this.fields.set(this.key, this.value) }
    else if (this.array !== null) {
      if (this.kind === 'push') { this.array.length = this.length }
      else { this.array[this.index] = this.value }
    }
  }
}

export abstract class HostEnvironment {
  abstract invoke(module: string, name: string, args: RuntimeValue[], awaited: boolean): RuntimeValue
  beginSafetyTurn(_reserve: () => void): VmHostSafetyScope {
    throw new RuntimeTrap('R-JOURNAL', 'host does not support safety turns')
  }
  setSafetyPure(pure: boolean): void {
    if (pure) { throw new RuntimeTrap('R-PURE', 'host does not support pure calls') }
  }
}

export class EmptyHostEnvironment extends HostEnvironment {
  beginSafetyTurn(_reserve: () => void): VmHostSafetyScope {
    return new EmptyVmHostSafetyScope()
  }
  setSafetyPure(_pure: boolean): void {}
  invoke(module: string, name: string, _args: RuntimeValue[], _awaited: boolean): RuntimeValue {
    throw new RuntimeTrap('R0015', `external function unavailable: ${module}.${name}`)
  }
}

export class Instruction {
  op: string
  value: string = ''
  numValue: number = 0
  boolValue: boolean = false
  slot: number = 0
  name: string = ''
  module: string = ''
  operator: string = ''
  target: number = 0
  count: number = 0
  awaited: boolean = false
  classIdentity: string = ''
  fields: string[] = []
  functionName: string = ''
  captures: number[] = []

  constructor(op: string) { this.op = op; }
}

export class BytecodeFunction {
  name: string
  parameterCount: number
  localCount: number
  isAsync: boolean
  instructions: Instruction[]
  /** The source line of each instruction; empty for bytecode compiled before lines were kept. */
  lines: number[]

  constructor(name: string, paramCount: number, localCount: number, isAsync: boolean, instructions: Instruction[],
      lines: number[] = []) {
    this.name = name
    this.parameterCount = paramCount
    this.localCount = localCount
    this.isAsync = isAsync
    this.instructions = instructions
    this.lines = lines
  }
}

export class BytecodeModule {
  functions: BytecodeFunction[]
  entryCandidates: string[]

  constructor(functions: BytecodeFunction[], entries: string[]) {
    this.functions = functions
    this.entryCandidates = entries
  }
}

class Frame {
  stack: RuntimeValue[] = []
  locals: Cell[]
  pc: number = 0
  fn: BytecodeFunction
  captures: Cell[]

  constructor(fn: BytecodeFunction, captures: Cell[], args: RuntimeValue[]) {
    this.fn = fn
    this.captures = captures
    this.locals = []
    for (let i: number = 0; i < fn.localCount; i++) {
      this.locals.push(new Cell(i < args.length ? args[i] : NULL_VALUE))
    }
  }
}

export interface VmExecutionBudget {
  now: () => number
  deadlineMs?: number
}

export class VirtualMachine {
  private functions: Map<string, BytecodeFunction> = new Map<string, BytecodeFunction>()
  private functionValues: Map<string, FunctionValue> = new Map<string, FunctionValue>()
  private externalValues: Map<string, ExternalFunctionValue> = new Map<string, ExternalFunctionValue>()
  private host: HostEnvironment
  private maxSteps: number
  private steps: number = 0
  private budgetNow: (() => number) | null = null
  private budgetDeadlineMs: number = 1000
  private budgetStartedAt: number = -1
  private budgetLastNow: number = -1
  private budgetActive: boolean = false
  private budgetFailure: RuntimeTrap | null = null
  private budgetFrame: Frame | null = null
  readonly coverage: 'GRAPH_SLOTS_DEFERRED_INTENTS' = 'GRAPH_SLOTS_DEFERRED_INTENTS'
  private safetyEnabled: boolean = false
  private journalLimit: number = 65536
  private journalCount: number = 0
  private journal: VmUndoRecord[] = []
  private turnBoundary: number = -1
  private pureBoundary: number = -1
  private safetyExecuting: boolean = false
  private safetySettling: boolean = false
  private safetyInvalid: boolean = false
  private safetyViolations: number = 0
  private safetyFailed: boolean = false
  private safetyFailure: RuntimeTrap | null = null
  private turnToken: VmTurnToken | null = null
  private usedTransactions: WeakSet<Object> = new WeakSet<Object>()

  constructor(module: BytecodeModule, host: HostEnvironment = new EmptyHostEnvironment(), maxSteps: number = 5000000,
      budget: VmExecutionBudget | null = null, safety: VmSafetyOptions | null = null) {
    this.host = host
    this.maxSteps = maxSteps
    if (budget !== null) {
      let now = budget.now
      let deadlineMs = budget.deadlineMs
      if (deadlineMs === undefined) { deadlineMs = 1000 }
      if (typeof now !== 'function') { throw new RuntimeTrap('R-BUDGET', 'budget clock must be a function') }
      if (!Number.isFinite(deadlineMs) || deadlineMs < 0) {
        throw new RuntimeTrap('R-BUDGET', 'budget deadlineMs must be finite and nonnegative')
      }
      if (!Number.isSafeInteger(maxSteps) || maxSteps < 0) {
        throw new RuntimeTrap('R-BUDGET', 'budget maxSteps must be a nonnegative safe integer')
      }
      this.budgetNow = now
      this.budgetDeadlineMs = deadlineMs
    }
    if (safety !== null) {
      if (budget === null) { throw new RuntimeTrap('R-JOURNAL', 'safety requires an injected budget') }
      if (safety.journalMode !== undefined && safety.journalMode !== 'JOURNAL') {
        throw new RuntimeTrap('R-JOURNAL', 'only JOURNAL safety is supported')
      }
      let limit = safety.journalMaxEntries === undefined ? 65536 : safety.journalMaxEntries
      if (!Number.isSafeInteger(limit) || limit < 0) {
        throw new RuntimeTrap('R-JOURNAL', 'journal capacity must be a nonnegative safe integer')
      }
      this.journalLimit = limit
      this.safetyEnabled = true
    }
    for (let fn of module.functions) {
      this.functions.set(fn.name, fn)
    }
  }

  private failSafety(code: string, message: string): RuntimeTrap {
    this.safetyViolations += 1
    this.safetyFailed = true
    if (this.safetyFailure === null) { this.safetyFailure = new RuntimeTrap(code, message) }
    return this.safetyFailure
  }

  private checkSafety(): void {
    if (this.safetyFailure !== null) { throw this.safetyFailure }
    if (this.safetyInvalid) { throw this.failSafety('R-JOURNAL', 'VM safety instance is invalid') }
  }

  beginTurn(tx: Object, _root: RuntimeValue): VmSafetyTurnScope {
    if (!this.safetyEnabled) { throw new RuntimeTrap('R-JOURNAL', 'VM safety is disabled') }
    if (this.safetyExecuting || this.safetySettling) {
      throw this.failSafety('R-JOURNAL', 'reentrant turn begin')
    }
    this.checkSafety()
    if (tx === null || typeof tx !== 'object' || this.safetyExecuting || this.safetySettling ||
        this.turnToken !== null || this.usedTransactions.has(tx)) {
      throw this.failSafety('R-JOURNAL', 'invalid or reentrant turn begin')
    }
    this.usedTransactions.add(tx)
    let token: VmTurnToken = new VmTurnToken()
    this.turnToken = token
    this.turnBoundary = allocationSerial
    this.journal = []
    this.journalCount = 0
    this.safetyFailed = false
    this.safetySettling = true
    let hostScope: VmHostSafetyScope
    try {
      hostScope = this.host.beginSafetyTurn(() => this.reserveHost(token))
      this.checkSafety()
      if (hostScope === null || typeof hostScope !== 'object' || typeof hostScope.accept !== 'function' ||
          typeof hostScope.rollback !== 'function' || typeof hostScope.discard !== 'function') {
        throw this.failSafety('R-JOURNAL', 'invalid host safety scope')
      }
    } catch (e) {
      this.safetyInvalid = true
      throw this.failSafety('R-JOURNAL', 'host safety turn failed')
    } finally {
      this.safetySettling = false
    }
    let settle = (receiver: VmSafetyTurnScope, action: string): void => {
      if (receiver !== scope) { throw this.failSafety('R-JOURNAL', 'foreign safety scope receiver') }
      this.settleTurn(token, hostScope, action)
    }
    let scope: VmSafetyTurnScope = new VmSafetyTurnScopeRecord(settle)
    return scope
  }

  private settleTurn(token: VmTurnToken, hostScope: VmHostSafetyScope, action: string): void {
    if (this.safetyInvalid || this.safetyExecuting || this.safetySettling || this.turnToken !== token) {
      throw this.failSafety('R-JOURNAL', 'invalid or reentrant turn settlement')
    }
    if (action === 'accept' && this.safetyFailed) {
      throw this.failSafety('R-JOURNAL', 'failed turn cannot be accepted')
    }
    this.safetySettling = true
    let violations = this.safetyViolations
    try {
      if (action === 'rollback') {
        for (let i = this.journal.length - 1; i >= 0; i--) { this.journal[i].undo() }
        hostScope.rollback()
      } else if (action === 'accept') { hostScope.accept() }
      else { this.safetyInvalid = true; hostScope.discard() }
      if (this.safetyViolations !== violations) { throw this.failSafety('R-JOURNAL', 'reentrant safety settlement') }
    } catch (e) {
      this.safetyInvalid = true
      throw this.failSafety('R-JOURNAL', 'host safety settlement failed')
    } finally {
      this.turnToken = null
      this.turnBoundary = -1
      this.journal = []
      this.journalCount = 0
      this.safetySettling = false
    }
    if (!this.safetyInvalid) { this.safetyFailure = null; this.safetyFailed = false }
  }

  private reserveHost(token: VmTurnToken): void {
    if (this.turnToken !== token || !this.safetyExecuting || this.safetySettling) {
      throw this.failSafety('R-JOURNAL', 'host reservation outside execution')
    }
    this.checkSafety()
    if (this.pureBoundary >= 0) { throw this.failSafety('R-PURE', 'host mutation in pure call') }
    this.reserveJournal()
  }

  private reserveJournal(): void {
    this.checkSafety()
    if (this.journalCount >= this.journalLimit) { throw this.failSafety('R-JOURNAL', 'journal capacity exceeded') }
    this.journalCount += 1
  }

  private reserveWrite(born: number): boolean {
    if (!this.safetyEnabled) { return false }
    this.checkSafety()
    if (this.pureBoundary >= 0 && born <= this.pureBoundary) {
      throw this.failSafety('R-PURE', 'write to pre-existing storage in pure call')
    }
    if (born > this.turnBoundary) { return false }
    this.reserveJournal()
    return true
  }

  private storeCell(cell: Cell, value: RuntimeValue): void {
    if (this.reserveWrite(cellBirths.get(cell) || 0)) {
      let record = new VmUndoRecord('cell')
      record.cell = cell
      record.value = cell.value
      this.journal.push(record)
    }
    cell.value = value
  }

  executePure(entry: string, args: RuntimeValue[] = []): RuntimeValue {
    if (!this.safetyEnabled) { return this.execute(entry, args) }
    return this.executeSafety(entry, args, true)
  }

  private executeSafety(entry: string, args: RuntimeValue[], pure: boolean): RuntimeValue {
    if (this.safetyExecuting || this.safetySettling) {
      throw this.failSafety('R-JOURNAL', 'reentrant safety execution')
    }
    this.checkSafety()
    if (this.safetyExecuting || this.safetySettling || this.turnToken === null || this.safetyFailed) {
      throw this.failSafety('R-JOURNAL', 'execution requires an idle active safety turn')
    }
    this.safetyExecuting = true
    this.pureBoundary = pure ? allocationSerial : -1
    try {
      if (pure) { this.host.setSafetyPure(true); this.checkSafety() }
      let result = this.executeBudgeted(entry, args)
      this.checkSafety()
      return result
    } catch (e) {
      this.safetyFailed = true
      if (this.safetyFailure !== null) { throw this.safetyFailure }
      throw e as Error
    } finally {
      try {
        if (pure) { this.host.setSafetyPure(false); this.checkSafety() }
      } catch (e) {
        this.safetyFailed = true
        throw this.failSafety('R-PURE', 'pure host cleanup failed')
      } finally {
        this.pureBoundary = -1
        this.safetyExecuting = false
      }
    }
  }

  // Steps executed by the most recent execute() call (reset per call).
  stepsExecuted(): number { return this.steps }

  safetyDiagnostics(): VmSafetyDiagnostics {
    const diagnostics: VmSafetyDiagnostics = {
      journalReservations: this.journalCount,
      journalUndoRecords: this.journal.length,
      runtimeBirthSerial: allocationSerial
    }
    return diagnostics
  }

  /** Every class the program builds objects of, with its fields: what an object of an older program must match to be kept. */
  classShapes(): Map<string, string[]> {
    let shapes: Map<string, string[]> = new Map<string, string[]>()
    this.functions.forEach((fn: BytecodeFunction) => {
      for (let inst of fn.instructions) {
        if (inst.op === 'make-object' && !shapes.has(inst.classIdentity)) { shapes.set(inst.classIdentity, inst.fields.slice()) }
      }
    })
    return shapes
  }

  execute(entry: string, args: RuntimeValue[] = []): RuntimeValue {
    if (this.safetyEnabled) { return this.executeSafety(entry, args, false) }
    if (this.budgetNow !== null) { return this.executeBudgeted(entry, args) }
    let fn = this.functions.get(entry)
    if (fn == undefined) {
      throw new RuntimeTrap('R0001', `entry function not found: ${entry}`)
    }
    this.steps = 0
    return this.run(new Frame(fn, [], args))
  }

  private executeBudgeted(entry: string, args: RuntimeValue[]): RuntimeValue {
    if (this.budgetActive) { throw this.failBudget('reentrant execution is not allowed') }
    this.budgetActive = true
    this.budgetFailure = null
    this.budgetStartedAt = -1
    this.steps = 0
    let fn = this.functions.get(entry)
    try {
      this.checkBudget()
      if (fn === undefined) { throw new RuntimeTrap('R0001', `entry function not found: ${entry}`) }
      this.budgetFrame = new Frame(fn, [], args)
      let result = this.run(this.budgetFrame)
      this.checkBudget()
      return result
    } catch (e) {
      let error = this.checkBudgetOnError(e as Error)
      if (error instanceof RuntimeTrap && error.line === 0 && fn !== undefined) { locateTrap(error, fn, 0) }
      throw error
    } finally {
      this.budgetFrame = null
      this.budgetStartedAt = -1
      this.budgetFailure = null
      this.budgetActive = false
    }
  }

  private failBudget(message: string): RuntimeTrap {
    if (this.budgetFailure === null) {
      this.budgetFailure = new RuntimeTrap('R-BUDGET', message)
      if (this.budgetFrame !== null) {
        locateTrap(this.budgetFailure, this.budgetFrame.fn, Math.max(0, this.budgetFrame.pc - 1))
      }
    }
    return this.budgetFailure
  }

  private checkBudget(): void {
    if (this.safetyEnabled) { this.checkSafety() }
    if (this.budgetFailure !== null) { throw this.budgetFailure }
    let now = this.budgetNow
    if (now === null) { return }
    let current: number
    try {
      current = now()
    } catch (e) {
      throw this.failBudget('budget clock failed')
    }
    if (this.safetyEnabled) { this.checkSafety() }
    if (this.budgetFailure !== null) { throw this.budgetFailure as RuntimeTrap }
    if (!Number.isFinite(current) || current < 0 || current < this.budgetLastNow) {
      throw this.failBudget('budget clock must be finite, nonnegative and monotonic')
    }
    this.budgetLastNow = current
    if (this.budgetStartedAt < 0) { this.budgetStartedAt = current }
    if (current - this.budgetStartedAt >= this.budgetDeadlineMs) {
      throw this.failBudget(`execution exceeded ${this.budgetDeadlineMs} ms deadline`)
    }
  }

  private checkBudgetOnError(error: Error): Error {
    try {
      this.checkBudget()
    } catch (e) {
      if (this.budgetFailure !== null) { return this.budgetFailure }
    }
    return error
  }

  private run(frame: Frame): RuntimeValue {
    let previousFrame = this.budgetFrame
    if (this.budgetNow !== null) { this.budgetFrame = frame }
    try {
      return this.runFrame(frame)
    } catch (e) {
      let error = this.budgetNow === null ? e as Error : this.checkBudgetOnError(e as Error)
      if (error instanceof RuntimeTrap && error.line === 0) { locateTrap(error, frame.fn, frame.pc - 1) }
      throw error
    } finally {
      this.budgetFrame = previousFrame
    }
  }

  private runFrame(frame: Frame): RuntimeValue {
    while (frame.pc < frame.fn.instructions.length) {
      this.steps += 1
      if (this.budgetNow === null && this.steps > this.maxSteps) {
        throw new RuntimeTrap('R0017', `execution exceeded ${this.maxSteps} steps`)
      }
      let inst = frame.fn.instructions[frame.pc]
      frame.pc += 1
      if (this.budgetNow !== null) {
        if (this.steps > this.maxSteps) { throw this.failBudget(`execution exceeded ${this.maxSteps} steps`) }
        if (this.steps % 1024 === 0) { this.checkBudget() }
      }
      switch (inst.op) {
        case 'push-number':
          frame.stack.push(new VeraNumberValue(inst.numValue))
          break
        case 'push-string':
          frame.stack.push(new VeraStringValue(inst.value))
          break
        case 'push-boolean':
          frame.stack.push(new VeraBooleanValue(inst.boolValue))
          break
        case 'push-null':
          frame.stack.push(NULL_VALUE)
          break
        case 'load-local':
          frame.stack.push(this.cell(frame.locals, inst.slot).value)
          break
        case 'store-local':
          this.storeCell(this.cell(frame.locals, inst.slot), this.pop(frame))
          break
        case 'load-capture':
          frame.stack.push(this.cell(frame.captures, inst.slot).value)
          break
        case 'store-capture':
          this.storeCell(this.cell(frame.captures, inst.slot), this.pop(frame))
          break
        case 'load-function': {
          let val = this.functionValues.get(inst.name)
          if (val == undefined) {
            val = new FunctionValue(inst.name, [])
            this.functionValues.set(inst.name, val)
          }
          frame.stack.push(val)
          break
        }
        case 'load-external': {
          let key = `${inst.module}::${inst.name}`
          let val = this.externalValues.get(key)
          if (val == undefined) {
            val = new ExternalFunctionValue(inst.module, inst.name)
            this.externalValues.set(key, val)
          }
          frame.stack.push(val)
          break
        }
        case 'pop':
          this.pop(frame)
          break
        case 'duplicate':
          frame.stack.push(frame.stack[frame.stack.length - 1])
          break
        case 'unary':
          frame.stack.push(this.unary(inst.operator, this.pop(frame)))
          break
        case 'binary': {
          let r = this.pop(frame)
          let l = this.pop(frame)
          frame.stack.push(this.binary(inst.operator, l, r))
          break
        }
        case 'jump':
          frame.pc = inst.target
          break
        case 'jump-if-false':
          if (!this.asBoolean(this.pop(frame))) { frame.pc = inst.target; }
          break
        case 'call':
          this.callInst(frame, inst)
          break
        case 'return':
          return this.pop(frame)
        case 'make-array':
          frame.stack.push(freshArrayValue(this.take(frame, inst.count)))
          break
        case 'array-push': {
          let v = this.pop(frame)
          let arr = this.asArray(this.pop(frame))
          if (arr.elements.length >= 4096) {
            throw new RuntimeTrap('R0022', 'array length limit reached (4096)')
          }
          if (this.reserveWrite(arrayBirths.get(arr.elements) || 0)) {
            let record = new VmUndoRecord('push')
            record.array = arr.elements
            record.length = arr.elements.length
            this.journal.push(record)
          }
          arr.elements.push(v)
          frame.stack.push(new VeraNumberValue(arr.elements.length))
          break
        }
        case 'array-pop': {
          let arr = this.asArray(this.pop(frame))
          if (arr.elements.length === 0) {
            throw new RuntimeTrap('R0023', 'pop from an empty array')
          }
          if (this.reserveWrite(arrayBirths.get(arr.elements) || 0)) {
            let record = new VmUndoRecord('pop')
            record.array = arr.elements
            record.index = arr.elements.length - 1
            record.value = arr.elements[record.index]
            this.journal.push(record)
          }
          frame.stack.push(arr.elements.pop() as RuntimeValue)
          break
        }
        case 'length': {
          let v = this.pop(frame)
          if (v instanceof VeraArrayValue) {
            frame.stack.push(new VeraNumberValue(v.elements.length))
          } else if (v instanceof VeraStringValue) {
            frame.stack.push(new VeraNumberValue(v.value.length))
          } else {
            throw new RuntimeTrap('R0008', 'expected array or string')
          }
          break
        }
        case 'string-symbols': {
          let v = this.pop(frame)
          if (!(v instanceof VeraStringValue)) { throw new RuntimeTrap('R0008', 'expected string') }
          let chars: RuntimeValue[] = []
          for (let ch of Array.from(v.value)) { chars.push(new VeraStringValue(ch)) }
          frame.stack.push(freshArrayValue(chars))
          break
        }
        case 'ensure-not-null': {
          let v = this.pop(frame)
          if (v instanceof VeraNullValue) { throw new RuntimeTrap('R0018', 'ensure-not-null failed') }
          frame.stack.push(v)
          break
        }
        case 'load-index': {
          let idx = this.index(this.pop(frame))
          let arr = this.asArray(this.pop(frame))
          frame.stack.push(this.indexValue(arr, idx))
          break
        }
        case 'store-index': {
          let v = this.pop(frame)
          let idx = this.index(this.pop(frame))
          let arr = this.asArray(this.pop(frame))
          this.indexValue(arr, idx)
          if (this.reserveWrite(arrayBirths.get(arr.elements) || 0)) {
            let record = new VmUndoRecord('index')
            record.array = arr.elements
            record.index = idx
            record.value = arr.elements[idx]
            this.journal.push(record)
          }
          arr.elements[idx] = v
          break
        }
        case 'make-object': {
          let vals = this.take(frame, inst.fields.length)
          let fields = new Map<string, RuntimeValue>()
          for (let i: number = 0; i < inst.fields.length; i++) {
            fields.set(inst.fields[i], vals[i])
          }
          frame.stack.push(freshObjectValue(inst.classIdentity, fields))
          break
        }
        case 'load-field': {
          let obj = this.asObject(this.pop(frame))
          let v = obj.fields.get(inst.name)
          if (v == undefined) { throw new RuntimeTrap('R0010', `missing field ${inst.name}`) }
          frame.stack.push(v)
          break
        }
        case 'store-field': {
          let v = this.pop(frame)
          let obj = this.asObject(this.pop(frame))
          if (!obj.fields.has(inst.name)) { throw new RuntimeTrap('R0010', `missing field ${inst.name}`) }
          if (this.reserveWrite(objectBirths.get(obj.fields) || 0)) {
            let record = new VmUndoRecord('field')
            record.fields = obj.fields
            record.key = inst.name
            record.value = obj.fields.get(inst.name) as RuntimeValue
            this.journal.push(record)
          }
          obj.fields.set(inst.name, v)
          break
        }
        case 'make-closure': {
          let caps: Cell[] = []
          for (let c of inst.captures) {
            if (c >= 0) { caps.push(this.cell(frame.locals, c)) }
            else { caps.push(this.cell(frame.captures, -c - 1)) }
          }
          frame.stack.push(new FunctionValue(inst.functionName, caps))
          break
        }
      }
    }
    throw new RuntimeTrap('R0012', 'function ended without return')
  }

  private callInst(frame: Frame, inst: Instruction): void {
    let args = this.take(frame, inst.count)
    let callee = this.pop(frame)
    if (callee instanceof FunctionValue) {
      let fn = this.functions.get(callee.name)
      if (fn == undefined) { throw new RuntimeTrap('R0001', `function not found: ${callee.name}`) }
      if (fn.isAsync !== inst.awaited) { throw new RuntimeTrap('R0013', 'async call invariant') }
      frame.stack.push(this.run(new Frame(fn, callee.captures, args)))
    } else if (callee instanceof ExternalFunctionValue) {
      if (this.budgetNow === null) {
        frame.stack.push(this.host.invoke(callee.module, callee.funcName, args, inst.awaited))
      } else {
        this.checkBudget()
        try {
          let result = this.host.invoke(callee.module, callee.funcName, args, inst.awaited)
          if (this.safetyEnabled) { this.checkSafety() }
          this.checkBudget()
          frame.stack.push(result)
        } catch (e) {
          throw this.checkBudgetOnError(e as Error)
        }
      }
    } else {
      throw new RuntimeTrap('R0014', 'value is not callable')
    }
  }

  private unary(op: string, value: RuntimeValue): RuntimeValue {
    if (op === '!') { return new VeraBooleanValue(!this.asBoolean(value)) }
    if (value instanceof VeraNumberValue) { return new VeraNumberValue(-value.value) }
    throw new RuntimeTrap('R0002', 'invalid unary operand')
  }

  private binary(op: string, left: RuntimeValue, right: RuntimeValue): RuntimeValue {
    if (op === '===') { return new VeraBooleanValue(this.equal(left, right)) }
    if (op === '!==') { return new VeraBooleanValue(!this.equal(left, right)) }
    if (op === '&&') { return new VeraBooleanValue(this.asBoolean(left) && this.asBoolean(right)) }
    if (op === '||') { return new VeraBooleanValue(this.asBoolean(left) || this.asBoolean(right)) }
    if (left instanceof VeraStringValue && right instanceof VeraStringValue) {
      if (op === '+') { return new VeraStringValue(left.value + right.value) }
      return new VeraBooleanValue(this.compareStr(op, left.value, right.value))
    }
    let a = this.asNumber(left)
    let b = this.asNumber(right)
    if (op === '+') { return new VeraNumberValue(a + b) }
    if (op === '-') { return new VeraNumberValue(a - b) }
    if (op === '*') { return new VeraNumberValue(a * b) }
    // Division by zero stays a trap, as it was for the old int: an Infinity or
    // NaN would otherwise travel into state and onto the screen as text.
    if (op === '/') {
      if (b === 0) { throw new RuntimeTrap('R0003', 'division by zero') }
      return new VeraNumberValue(a / b)
    }
    if (op === '%') {
      if (b === 0) { throw new RuntimeTrap('R0004', 'modulo by zero') }
      return new VeraNumberValue(a % b)
    }
    return new VeraBooleanValue(this.compareNum(op, a, b))
  }

  private compareNum(op: string, a: number, b: number): boolean {
    if (op === '<') { return a < b }
    if (op === '<=') { return a <= b }
    if (op === '>') { return a > b }
    if (op === '>=') { return a >= b }
    throw new RuntimeTrap('R0005', `invalid comparison ${op}`)
  }

  private compareStr(op: string, a: string, b: string): boolean {
    if (op === '<') { return a < b }
    if (op === '<=') { return a <= b }
    if (op === '>') { return a > b }
    if (op === '>=') { return a >= b }
    throw new RuntimeTrap('R0005', `invalid comparison ${op}`)
  }

  private equal(a: RuntimeValue, b: RuntimeValue): boolean {
    if (a instanceof VeraNullValue || b instanceof VeraNullValue) { return a instanceof VeraNullValue && b instanceof VeraNullValue }
    if (a instanceof VeraNumberValue && b instanceof VeraNumberValue) { return a.value === b.value }
    if (a instanceof VeraStringValue && b instanceof VeraStringValue) { return a.value === b.value }
    if (a instanceof VeraBooleanValue && b instanceof VeraBooleanValue) { return a.value === b.value }
    if (a instanceof FunctionValue && b instanceof FunctionValue) { return a === b }
    if (a instanceof ExternalFunctionValue && b instanceof ExternalFunctionValue) { return a === b }
    return false
  }

  private pop(frame: Frame): RuntimeValue {
    let v = frame.stack.pop()
    if (v == undefined) { throw new RuntimeTrap('R0007', 'stack underflow') }
    return v
  }

  private take(frame: Frame, count: number): RuntimeValue[] {
    if (frame.stack.length < count) { throw new RuntimeTrap('R0007', 'stack underflow') }
    let result: RuntimeValue[] = []
    let start = frame.stack.length - count
    for (let i = start; i < frame.stack.length; i++) { result.push(frame.stack[i]) }
    while (frame.stack.length > start) { this.pop(frame) }
    return result
  }

  private asNumber(v: RuntimeValue): number { if (!(v instanceof VeraNumberValue)) { throw new RuntimeTrap('R0008', 'expected number') } return (v as VeraNumberValue).value }
  private asBoolean(v: RuntimeValue): boolean { if (!(v instanceof VeraBooleanValue)) { throw new RuntimeTrap('R0008', 'expected boolean') } return (v as VeraBooleanValue).value }
  private asArray(v: RuntimeValue): VeraArrayValue { if (!(v instanceof VeraArrayValue)) { throw new RuntimeTrap('R0008', 'expected array') } return v as VeraArrayValue }
  private asObject(v: RuntimeValue): VeraObjectValue { if (!(v instanceof VeraObjectValue)) { throw new RuntimeTrap('R0008', 'expected object') } return v as VeraObjectValue }
  private index(v: RuntimeValue): number {
    let i = this.asNumber(v)
    if (!Number.isInteger(i)) { throw new RuntimeTrap('R0009', 'array index must be a whole number, got ' + i.toString()) }
    if (i < 0) { throw new RuntimeTrap('R0009', 'array index out of bounds') }
    return i
  }
  private indexValue(arr: VeraArrayValue, idx: number): RuntimeValue { if (idx < 0 || idx >= arr.elements.length) { throw new RuntimeTrap('R0009', 'array index out of bounds') } return arr.elements[idx] }
  private cell(vals: Cell[], idx: number): Cell { if (idx < 0 || idx >= vals.length) { throw new RuntimeTrap('R0016', 'invalid slot') } return vals[idx] }
}

export function formatRuntimeValue(value: RuntimeValue): string {
  if (value instanceof VeraNumberValue) { return value.value.toString() }
  if (value instanceof VeraStringValue) { return value.value }
  if (value instanceof VeraBooleanValue) { return value.value ? 'true' : 'false' }
  if (value instanceof VeraNullValue) { return 'null' }
  if (value instanceof VeraArrayValue) { return '[' + value.elements.map((e: RuntimeValue) => formatRuntimeValue(e)).join(', ') + ']' }
  if (value instanceof VeraObjectValue) {
    let entries: string[] = []
    for (let entry of value.fields) { entries.push(entry[0] + ': ' + formatRuntimeValue(entry[1])) }
    return '{' + entries.join(', ') + '}'
  }
  if (value instanceof FunctionValue) { return `<function ${value.name}>` }
  if (value instanceof ExternalFunctionValue) { return `<external ${value.module}.${value.funcName}>` }
  return '<unknown>'
}

/**
 * Program state, encoded so it survives a restart.
 *
 * Tagged rather than plain JSON because plain JSON would lose classIdentity,
 * which make-object sets and which field access relies on.
 *
 * Functions are deliberately unrepresentable. A closure in state would be a
 * captured environment that no longer exists after a restart, so it is better to
 * fail loudly at save time than to restore something subtly wrong.
 */
export function encodeRuntimeValue(value: RuntimeValue): Object {
  if (value instanceof VeraNumberValue) { return ['n', (value as VeraNumberValue).value] as Object }
  if (value instanceof VeraStringValue) { return ['s', (value as VeraStringValue).value] as Object }
  if (value instanceof VeraBooleanValue) { return ['b', (value as VeraBooleanValue).value] as Object }
  if (value instanceof VeraNullValue) { return ['z'] as Object }
  if (value instanceof VeraArrayValue) {
    let items: Object[] = []
    for (let e of (value as VeraArrayValue).elements) { items.push(encodeRuntimeValue(e)) }
    return ['a', items] as Object
  }
  if (value instanceof VeraObjectValue) {
    let obj = value as VeraObjectValue
    let entries: Object[] = []
    for (let entry of obj.fields) { entries.push([entry[0], encodeRuntimeValue(entry[1])] as Object) }
    return ['o', obj.classIdentity, entries] as Object
  }
  throw new RuntimeTrap('R0024', 'value cannot be saved: ' + formatRuntimeValue(value))
}

export function decodeRuntimeValue(raw: Object): RuntimeValue {
  let parts = raw as Object[]
  let tag = parts[0] as string
  if (tag === 'n') { return new VeraNumberValue(parts[1] as number) }
  if (tag === 's') { return new VeraStringValue(parts[1] as string) }
  if (tag === 'b') { return new VeraBooleanValue(parts[1] as boolean) }
  if (tag === 'z') { return NULL_VALUE }
  if (tag === 'a') {
    let items: RuntimeValue[] = []
    for (let e of parts[1] as Object[]) { items.push(decodeRuntimeValue(e)) }
    return freshArrayValue(items)
  }
  if (tag === 'o') {
    let fields = new Map<string, RuntimeValue>()
    for (let entry of parts[2] as Object[]) {
      let pair = entry as Object[]
      fields.set(pair[0] as string, decodeRuntimeValue(pair[1]))
    }
    return freshObjectValue(parts[1] as string, fields)
  }
  throw new RuntimeTrap('R0025', 'unknown saved value tag: ' + tag)
}

/**
 * Says where a trap happened: the function and line, and for one that comes from running too long or a list
 * growing without end, the loop it happened in -- what a person or a repair needs to find the mistake.
 */
function locateTrap(trap: RuntimeTrap, fn: BytecodeFunction, at: number): void {
  if (at < 0 || at >= fn.lines.length || fn.lines[at] <= 0) { trap.line = -1; return }
  trap.line = fn.lines[at]
  let where = ' (in ' + fn.name + ', line ' + trap.line.toString()
  if (trap.trapCode === 'R0017' || trap.trapCode === 'R0022' || trap.trapCode === 'R-BUDGET') {
    // The innermost loop around it: the backward jump over it whose target is nearest.
    let start = -1
    for (let i = at; i < fn.instructions.length; i++) {
      let inst = fn.instructions[i]
      if (inst.op === 'jump' && inst.target <= at && inst.target > start) { start = inst.target }
    }
    if (start >= 0 && fn.lines[start] > 0) {
      trap.loopLine = fn.lines[start]
      // A list that outgrew its limit was fed by a loop that never ended; a run out of steps may also be a
      // loop that ends, but too late (5 s of audio built sample by sample).
      where += ', inside the loop at line ' + fn.lines[start].toString() + (trap.trapCode === 'R0022'
        ? ', which never stopped: check that something in it changes what its condition reads'
        : ', which never stopped or does too much work for one tap: check that it ends, and how many times it runs')
    }
  }
  trap.message = trap.message + where + ')'
}

export function deserializeVbc2(source: string): BytecodeModule {
  let root = JSON.parse(source) as Object[]
  if (!Array.isArray(root) || root[0] !== 'VBC2') {
    throw new RuntimeTrap('VBC0004', 'unsupported VBC version')
  }
  let entries = root[1] as string[]
  let rawFunctions = root[2] as Object[][]
  let functions: BytecodeFunction[] = []
  for (let item of rawFunctions) {
    let rawInstructions = item[4] as Object[][]
    let instructions: Instruction[] = []
    for (let raw of rawInstructions) {
      instructions.push(decodeInstruction(raw))
    }
    functions.push(new BytecodeFunction(
      item[0] as string,
      item[1] as number,
      item[2] as number,
      item[3] as boolean,
      instructions,
      item.length > 5 ? item[5] as number[] : []
    ))
  }
  return new BytecodeModule(functions, entries)
}

function decodeInstruction(raw: Object[]): Instruction {
  let op = raw[0] as string
  let inst = new Instruction(op)
  switch (op) {
    // The built-in demo programs (VeraPrograms.ets) were compiled when the
    // language still had int; their whole-number constants read as numbers.
    case 'push-int': inst.op = 'push-number'; inst.numValue = parseInt(raw[1] as string); break
    case 'push-number': inst.numValue = raw[1] as number; break
    case 'push-string': inst.value = raw[1] as string; break
    case 'push-boolean': inst.boolValue = raw[1] as boolean; break
    case 'push-null': break
    case 'load-local': inst.slot = raw[1] as number; break
    case 'store-local': inst.slot = raw[1] as number; break
    case 'load-capture': inst.slot = raw[1] as number; break
    case 'store-capture': inst.slot = raw[1] as number; break
    case 'load-function': inst.name = raw[1] as string; break
    case 'load-external': inst.module = raw[1] as string; inst.name = raw[2] as string; break
    case 'pop': break
    case 'duplicate': break
    case 'unary': inst.operator = raw[1] as string; break
    case 'binary': inst.operator = raw[1] as string; break
    case 'jump': inst.target = raw[1] as number; break
    case 'jump-if-false': inst.target = raw[1] as number; break
    case 'call': inst.count = raw[1] as number; inst.awaited = raw[2] as boolean; break
    case 'return': break
    case 'make-array': inst.count = raw[1] as number; break
    case 'array-push': break
    case 'array-pop': break
    case 'length': break
    case 'string-symbols': break
    case 'ensure-not-null': break
    case 'load-index': break
    case 'store-index': break
    case 'make-object':
      inst.classIdentity = raw[1] as string
      inst.fields = raw[2] as string[]
      break
    case 'load-field': inst.name = raw[1] as string; break
    case 'store-field': inst.name = raw[1] as string; break
    case 'make-closure':
      inst.functionName = raw[1] as string
      inst.captures = raw[2] as number[]
      break
    default:
      throw new RuntimeTrap('VBC0003', `unknown opcode: ${op}`)
  }
  return inst
}
