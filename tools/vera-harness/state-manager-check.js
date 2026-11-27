'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { TextEncoder, TextDecoder } = require('node:util')
const ts = require(process.env.VERA_TYPESCRIPT_PATH || 'typescript')
const root = path.resolve(__dirname, '../../entry/src/main/ets')
const APP = 'project/app'
const STAMP = 'manager:状态'
const cache = new Map()
const imported = new Set()
const codecCalls = { encode: 0, decode: 0 }
let cryptoHook = null
let uuid = 0

const policyPath = path.join(root, 'runtime/CommitPolicy.ets')
const util = {
  TextEncoder: class { encodeInto(text) { return new TextEncoder().encode(text) } },
  TextDecoder: { create(encoding, options) {
    assert.equal(encoding, 'utf-8')
    const decoder = new TextDecoder(encoding, options)
    return { decodeToString: (value, decodeOptions) => decoder.decode(value, decodeOptions) }
  } },
  generateRandomUUID: () => '00000000-0000-4000-8000-' + String(++uuid).padStart(12, '0')
}
const cryptoFramework = { createMd(algorithm) {
  assert.equal(algorithm, 'SHA256')
  if (cryptoHook) cryptoHook('create')
  const hash = crypto.createHash('sha256')
  return {
    updateSync({ data }) { if (cryptoHook) cryptoHook('update'); hash.update(data) },
    digestSync() { if (cryptoHook) cryptoHook('digest'); return { data: hash.digest() } }
  }
} }
const allowed = new Set([
  'runtime/StateManager.ets', 'runtime/shared/StatePort.ets', 'runtime/StateFormat.ets',
  'runtime/StateFileFormat.ets', 'runtime/CommitPolicy.ets', 'vera/VeraInterpreter.ets',
  'vera/VeraUi.ets', 'vera/VeraUiCatalog.ets', 'vera/VeraIcons.ets', 'vera/VeraGfx.ets',
  'vera/GfxPaint.ets', 'vera/VeraTheme.ets', 'vera/VeraMotion.ets', 'vera/VeraScene.ets',
  'vera/VeraSurfaces.ets', 'vera/VeraShapes.ets', 'vera/VeraParticles.ets', 'vera/VeraNoise.ets',
  'vera/VeraTextures.ets', 'vera/VeraModels.ets', 'widget/CardModel.ets'
].map(file => path.join(root, file)))
function load(file) {
  file = path.resolve(file)
  assert(allowed.has(file), 'unexpected source dependency: ' + file)
  if (cache.has(file)) return cache.get(file).exports
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file.replace(/\.ets$/, '.ts'),
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true },
    reportDiagnostics: true
  })
  const errors = (compiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error)
  assert.equal(errors.length, 0, errors.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n'))
  const mod = { exports: {} }
  cache.set(file, mod)
  const importer = name => {
    imported.add(name)
    if (name === '@kit.CryptoArchitectureKit') return { cryptoFramework }
    if (name === '@kit.ArkTS') return { util }
    if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.ets'))
    throw Error('Forbidden host dependency: ' + name)
  }
  new Function('require', 'module', 'exports', compiled.outputText)(importer, mod, mod.exports)
  if (file === path.join(root, 'vera/VeraInterpreter.ets')) {
    for (const [name, counter] of [['encodeRuntimeValue', 'encode'], ['decodeRuntimeValue', 'decode']]) {
      const original = mod.exports[name]
      mod.exports[name] = (...args) => { codecCalls[counter]++; return original(...args) }
    }
  }
  return mod.exports
}
const vm = load(path.join(root, 'vera/VeraInterpreter.ets'))
const format = load(path.join(root, 'runtime/StateFormat.ets'))
const { StateManager, StateManagerError } = load(path.join(root, 'runtime/StateManager.ets'))
const { CommitPolicy } = load(policyPath)
class RecordingPolicy extends CommitPolicy {
  constructor(options = {}) {
    super({ publishGenerationDeadlineMs: 25, publishRetryMs: 10,
      backupEveryNCommits: 1, backupMinIntervalMs: 0, ...options })
    this.calls = []
  }
  effective(...args) { this.calls.push(['effective', ...args]); return super.effective(...args) }
  throttledDue(...args) { this.calls.push(['throttledDue', ...args]); return super.throttledDue(...args) }
  checkpointDue(...args) { this.calls.push(['checkpointDue', ...args]); return super.checkpointDue(...args) }
  backupDue(...args) { this.calls.push(['backupDue', ...args]); return super.backupDue(...args) }
  transient(...args) { this.calls.push(['transient', ...args]); return super.transient(...args) }
}
load(path.join(root, 'runtime/shared/StatePort.ets'))
const num = value => new vm.VeraNumberValue(value)
const str = value => new vm.VeraStringValue(value)
const obj = fields => new vm.VeraObjectValue('State', new Map(Object.entries(fields)))
const seed = (value = 1) => obj({ n: num(value), text: str('状态') })
const get = manager => manager.getWorkingState().fields.get('n').value
const set = (manager, value) => manager.getWorkingState().fields.set('n', num(value))
const encode = value => format.canonicalPayload(vm.encodeRuntimeValue(value))
const plain = encoded => vm.decodeRuntimeValue(JSON.parse(encoded))
const encodedN = encoded => plain(encoded).fields.get('n').value
const refusal = (code = 'STATE_WRITE_FAILED', stage = 'fixture-before-write') => ({ status: 'FAILED', code, stage })
const uncertain = () => ({ status: 'COMMIT_UNCERTAIN', code: 'STATE_COMMIT_UNCERTAIN', stage: 'fixture-after-write' })
const errorCode = code => error => error instanceof StateManagerError && error.code === code
const fails = (run, code) => assert.throws(run, errorCode(code))
const tick = async (count = 20) => { for (let i = 0; i < count; i++) await Promise.resolve() }
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function observe(promise) {
  const state = { settled: false, value: undefined, error: null }
  Promise.resolve(promise).then(value => { state.settled = true; state.value = value }, error => { state.settled = true; state.error = error })
  return state
}
async function bounded(promise, label = 'operation') {
  const state = observe(promise)
  for (let i = 0; i < 1000 && !state.settled; i++) await Promise.resolve()
  assert(state.settled, label + ' did not settle within deterministic microtask budget')
  if (state.error) throw state.error
  return state.value
}

class GuardFixture {
  constructor() {
    this.coverage = 'GRAPH_SLOTS_DEFERRED_INTENTS'
    this.events = []
    this.slots = { global: new vm.Cell(num(10)), module: new vm.Cell(num(20)), capture: new vm.Cell(num(30)) }
    this.host = { fields: new Map([['old', 'field']]), tickers: ['old-ticker'], surface: ['old-surface'], effectId: 7 }
    this.intents = []
    this.failure = ''
  }
  beginTurn(tx, rootValue) {
    this.events.push(['begin', tx.id, rootValue])
    if (this.failure === 'begin') throw Error('guard begin failure')
    const saved = new Map()
    const visit = value => {
      if (!value || typeof value !== 'object' || saved.has(value)) return
      if (value instanceof Map) {
        const entries = [...value]
        saved.set(value, () => { value.clear(); for (const [key, item] of entries) value.set(key, item) })
        for (const [key, item] of entries) { visit(key); visit(item) }
      } else {
        const descriptors = Object.getOwnPropertyDescriptors(value)
        saved.set(value, () => {
          for (const key of Reflect.ownKeys(value)) if (!(key in descriptors)) delete value[key]
          Object.defineProperties(value, descriptors)
        })
        for (const descriptor of Object.values(descriptors)) visit(descriptor.value)
      }
    }
    visit(rootValue)
    visit(this.slots)
    visit(this.host)
    assert.equal(this.intents.length, 0)
    let settled = false
    const settle = kind => {
      assert(!settled, 'rollback scope settled exactly once')
      settled = true
      this.events.push([kind, tx.id])
      if (this.failure === kind) throw Error('guard ' + kind + ' failure')
      if (kind === 'rollback') for (const restore of [...saved.values()].reverse()) restore()
      if (kind === 'accept') for (const intent of this.intents) intent(this.host)
      this.intents = []
    }
    return { accept: () => settle('accept'), rollback: () => settle('rollback'), discard: () => settle('discard') }
  }
  count(kind) { return this.events.filter(event => event[0] === kind).length }
}
function diskState(value = seed(), options = {}) {
  const stamp = options.stamp === undefined ? STAMP : options.stamp
  const encodedState = encode(value)
  if (options.format === 'LEGACY') return {
    kind: 'READY', format: 'LEGACY', source: 'MAIN', stamp, encodedState,
    matchingStamp: stamp === STAMP, recovered: false
  }
  const data = format.validateStateFile(format.assembleStateFile({
    appId: APP, schemaVersion: 1, vmGeneration: 3, revision: 7, stamp,
    ...options.header
  }, encodedState), APP)
  return {
    kind: 'READY', format: 'FORMAT2', source: options.source || 'MAIN', stamp,
    encodedState, matchingStamp: stamp === STAMP, header: data.header,
    recovered: options.source === 'BAK'
  }
}
class StorageFixture {
  constructor(disk = { kind: 'ABSENT' }, name = 'pool') {
    this.disk = structuredClone(disk)
    this.name = name
    this.calls = []
    this.plans = { load: [], readHeader: [], commit: [], publishGeneration: [], close: [], whenIdle: [] }
    this.active = 0
    this.maxActive = 0
    this.closed = false
    this.ids = new Set()
    this.trace = []
  }
  plan(kind, plan) { this.plans[kind].push(plan); return plan }
  hold(kind, result) { const gate = deferred(); this.plan(kind, { gate, result }); return gate }
  count(kind) { return this.calls.filter(call => call.kind === kind).length }
  async run(kind, input, fallback) {
    if (!['close', 'whenIdle'].includes(kind)) assert(!this.closed, 'operation on closed storage incarnation')
    this.calls.push({ kind, input })
    this.trace.push('start:' + kind)
    if (!['close', 'whenIdle'].includes(kind)) {
      this.active++
      this.maxActive = Math.max(this.maxActive, this.active)
      assert.equal(this.active, 1, 'per-manager storage operations must not overlap')
    }
    const plan = this.plans[kind].shift() || {}
    try {
      if (plan.gate) await plan.gate.promise
      if (plan.error) throw plan.error
      let result = plan.result === undefined ? fallback() : plan.result
      if (typeof result === 'function') result = result(input)
      if (plan.after) result = plan.after(result, input)
      return structuredClone(result)
    } finally {
      if (!['close', 'whenIdle'].includes(kind)) this.active--
      this.trace.push('finish:' + kind)
    }
  }
  load(appId, expectedStamp) {
    assert.equal(appId, APP)
    assert.equal(expectedStamp, STAMP)
    return this.run('load', { appId, expectedStamp }, () => this.disk)
  }
  readHeader(appId) {
    assert.equal(appId, APP)
    return this.run('readHeader', { appId }, () => this.disk.header || null)
  }
  request(request, publication) {
    assert.equal(typeof request.operationId, 'string')
    assert(request.operationId.startsWith(APP + ':'))
    assert(!this.ids.has(request.operationId), 'operation IDs are unique across all writes')
    this.ids.add(request.operationId)
    if (publication) {
      assert.deepEqual(Object.keys(request).sort(), ['appId', 'expectedRevision', 'expectedSource', 'expectedStamp', 'nextVmGeneration', 'operationId'].sort())
      assert.equal(request.appId, APP)
      return structuredClone(request)
    }
    assert.deepEqual(Object.keys(request).sort(), ['backupDue', 'operationId', 'payload', 'pre', 'schemaVersion', 'stamp'].sort())
    assert.deepEqual(Object.keys(request.pre).sort(), ['appId', 'baseRevision', 'vmGeneration'])
    assert.equal(request.pre.appId, APP)
    assert.equal(request.schemaVersion, 1)
    assert.equal(request.stamp, STAMP)
    assert.equal(typeof request.backupDue, 'boolean')
    assert(request.payload instanceof ArrayBuffer)
    const owned = structuredClone(request, { transfer: [request.payload] })
    assert.equal(request.payload.byteLength, 0, 'manager relinquishes its DTO buffer')
    format.validateEncodedState(Buffer.from(owned.payload).toString('utf8'))
    return owned
  }
  commit(request) {
    const owned = this.request(request, false)
    return this.run('commit', owned, () => {
      const revision = owned.pre.baseRevision + 1
      const encodedState = Buffer.from(owned.payload).toString('utf8')
      const data = format.validateStateFile(format.assembleStateFile({
        appId: APP, schemaVersion: 1, stamp: owned.stamp,
        vmGeneration: owned.pre.vmGeneration, revision
      }, encodedState), APP)
      this.disk = { kind: 'READY', format: 'FORMAT2', source: 'MAIN', stamp: STAMP,
        matchingStamp: true, encodedState, header: data.header, recovered: false }
      return { operationId: owned.operationId, result: { status: 'COMMITTED', revision, backup: owned.backupDue ? 'WRITTEN' : 'SKIPPED' } }
    })
  }
  publishGeneration(request) {
    const owned = this.request(request, true)
    return this.run('publishGeneration', owned, () => {
      assert.equal(this.disk.kind, 'READY')
      assert.equal(owned.expectedStamp, this.disk.stamp)
      assert.equal(owned.expectedRevision, this.disk.header?.revision || 0)
      assert.equal(owned.expectedSource, this.disk.format === 'LEGACY' ? 'LEGACY' : this.disk.source)
      const revision = this.disk.header?.revision || 0
      this.disk = diskState(plain(this.disk.encodedState), {
        stamp: this.disk.stamp, header: { vmGeneration: owned.nextVmGeneration, revision }
      })
      return { operationId: owned.operationId, result: { status: 'COMMITTED', revision, backup: 'SKIPPED' } }
    })
  }
  whenIdle() { return this.run('whenIdle', null, () => { assert.equal(this.active, 0); return undefined }) }
  close() {
    return this.run('close', null, () => { assert.equal(this.active, 0, 'close drains storage work'); this.closed = true; return undefined })
  }
}
class RecoveryStorageFixture extends StorageFixture {
  constructor(disk, reservation) {
    super(disk)
    this.reservation = reservation
    this.plans.recoverLost = []
    this.quarantine = []
    this.ownership = []
  }
  run(kind, input, fallback) {
    this.ownership.push([kind, this.reservation.held])
    return super.run(kind, input, fallback)
  }
  recoverLost(appId, expectedStamp) {
    assert.equal(appId, APP)
    assert.equal(expectedStamp, STAMP)
    assert.equal(this.reservation.held, true, 'actor holds reservation during reset')
    return this.run('recoverLost', { appId, expectedStamp }, () => {
      if (this.disk.kind !== 'LOST') return this.disk
      this.quarantine.push(structuredClone(this.disk))
      this.disk = { kind: 'ABSENT' }
      return this.disk
    })
  }
}
function recoveryFixture(options = {}) {
  const reservation = { held: false, calls: 0,
    async run(operation) {
      assert.equal(this.held, false)
      this.calls++
      this.held = true
      try { return await operation() } finally { this.held = false }
    } }
  const storage = new RecoveryStorageFixture({ kind: 'LOST', code: 'STATE_CORRUPTED', stage: 'lost-backup-format' }, reservation)
  const c = fixture({ storage, allowInitialLostRecovery: true, policy: new CommitPolicy(), ...options })
  return { ...c, reservation }
}
function recoveryAdmissionDenied(c) {
  for (const commitClass of ['IMMEDIATE', 'VOLATILE', 'THROTTLED']) {
    fails(() => c.manager.beginTurn(commitClass), 'STATE_NOT_READY')
  }
  fails(() => c.manager.checkpoint(), 'STATE_NOT_READY')
  fails(() => c.manager.captureWorkingSnapshot(), 'STATE_NOT_READY')
  fails(() => c.manager.publishGeneration(), c.manager.status().pendingOperations ? 'STATE_TURN_PENDING' : 'STATE_NOT_READY')
  assert.equal(c.guard.count('begin'), 0)
}
function reply(result) { return { result: request => ({ operationId: request.operationId, result }) } }
function assertLoadMetadata(actual, expected) {
  assert.deepEqual(Object.fromEntries(Object.entries(actual).filter(([, value]) => value !== undefined)), expected)
}
function fixture(options = {}) {
  const guard = options.guard || new GuardFixture()
  const storage = options.storage || new StorageFixture(options.disk)
  const policy = options.policy || new RecordingPolicy()
  const events = []
  const sleeps = []
  const clock = { value: 10000 }
  const manager = new StateManager({
    appId: APP, stamp: STAMP, mode: 'LIVE_PERSISTENT', stateMaxBytes: 65536,
    initialState: seed(), rollbackGuard: guard, storage, policy,
    now: () => clock.value,
    sleep: async ms => { sleeps.push(ms); clock.value += ms },
    diagnostic: event => events.push(event), ...options
  })
  return { manager, guard, storage, policy, events, sleeps, clock }
}
async function ready(options = {}) {
  const context = fixture(options)
  await context.manager.load()
  if (context.manager.status().mode === 'LIVE_PERSISTENT') await context.manager.publishGeneration()
  assert.equal(context.manager.status().phase, 'READY')
  return context
}
async function turn(context, value, commitClass = 'VOLATILE', source = 'INPUT', effects = false) {
  const tx = context.manager.beginTurn(commitClass, source)
  set(context.manager, value)
  if (effects) context.manager.markEffects(tx)
  return context.manager.commitTurn(tx)
}
function quarantined(context, rollbackCount = 0) {
  const { manager, storage, guard } = context
  assert.equal(manager.status().phase, 'FAULTED')
  assert.equal(manager.status().dirty, false)
  assert.equal(guard.count('rollback'), rollbackCount, 'fault does not blindly rollback')
  fails(() => manager.beginTurn('VOLATILE'), 'STATE_UNAVAILABLE')
  fails(() => manager.checkpoint(), 'STATE_UNAVAILABLE')
  fails(() => manager.finalSave(), 'STATE_UNAVAILABLE')
  fails(() => manager.captureWorkingSnapshot(), 'STATE_UNAVAILABLE')
  const writes = storage.count('commit')
  return bounded(manager.whenIdle()).then(() => assert.equal(storage.count('commit'), writes))
}
const tests = []
function test(name, run) { tests.push({ name, run }) }

test('CommitPolicy defaults come from current source', () => {
  assert.deepEqual({ ...new CommitPolicy() }, {
    throttleMs: 1000, checkpointMs: 5000, backupEveryNCommits: 10,
    backupMinIntervalMs: 60000, degradedAfter: 3, reloadMaxAttempts: 3,
    publishGenerationDeadlineMs: 8000, publishRetryMs: 25
  })
  assert.equal(cache.get(policyPath).exports.CommitPolicy, CommitPolicy)
})
for (const [source, persistent, nonpersistent] of [
  ['INIT', 'IMMEDIATE', 'IMMEDIATE'], ['CARRY', 'IMMEDIATE', 'IMMEDIATE'],
  ['EFFECT_RESULT', 'IMMEDIATE', 'IMMEDIATE'], ['INPUT', 'IMMEDIATE', 'VOLATILE'],
  ['TICK', 'THROTTLED', 'THROTTLED'], ['SURFACE', 'VOLATILE', 'VOLATILE'], ['MOVE', 'VOLATILE', 'VOLATILE']
]) test('CommitPolicy classification ' + source + ' with every persistence setting', () => {
  const policy = new CommitPolicy()
  assert.equal(policy.classify(source), persistent)
  assert.equal(policy.classify(source, true), persistent)
  assert.equal(policy.classify(source, false), nonpersistent)
})
for (const commitClass of ['IMMEDIATE', 'THROTTLED', 'VOLATILE']) {
  test('CommitPolicy effective ' + commitClass + ' promotes every effectful turn', () => {
    const policy = new CommitPolicy()
    assert.equal(policy.effective(commitClass, false), commitClass)
    assert.equal(policy.effective(commitClass, true), 'IMMEDIATE')
  })
}
for (const value of ['', 'BAD', 'immediate', null, undefined, 0, {}, true]) {
  test('CommitPolicy rejects invalid source/class ' + String(value), () => {
    const policy = new CommitPolicy()
    for (const flag of [false, true]) {
      assert.throws(() => policy.classify(value, flag), /STATE_VALIDATION_FAILED: turn source/)
      assert.throws(() => policy.effective(value, flag), /STATE_VALIDATION_FAILED: commit class/)
    }
  })
}
for (const [key, minimum, maximum] of [
  ['throttleMs', 1000, Number.MAX_SAFE_INTEGER - 1], ['checkpointMs', 1, 5000],
  ['backupEveryNCommits', 1, Number.MAX_SAFE_INTEGER - 1], ['backupMinIntervalMs', 0, Number.MAX_SAFE_INTEGER - 1],
  ['degradedAfter', 1, Number.MAX_SAFE_INTEGER - 1], ['reloadMaxAttempts', 1, Number.MAX_SAFE_INTEGER - 1],
  ['publishGenerationDeadlineMs', 1, Number.MAX_SAFE_INTEGER - 1], ['publishRetryMs', 1, Number.MAX_SAFE_INTEGER - 1]
]) {
  test('CommitPolicy accepts exact configuration bounds for ' + key, () => {
    for (const value of [minimum, maximum]) assert.equal(new CommitPolicy({ [key]: value })[key], value)
    assert.equal(new CommitPolicy({ [key]: undefined })[key], new CommitPolicy()[key])
  })
  for (const value of [minimum - 1, maximum + 1, 1.5, NaN, Infinity, -Infinity, null, '1000', true]) {
    test('CommitPolicy rejects ' + key + '=' + String(value), () => {
      assert.throws(() => new CommitPolicy({ [key]: value }), /STATE_VALIDATION_FAILED/)
    })
  }
}
for (const throttleMs of [1000, 1500]) test('CommitPolicy throttle exact boundary ' + throttleMs, () => {
  const policy = new CommitPolicy({ throttleMs })
  for (const last of [0, 10000]) {
    for (const delta of [-1, 0, throttleMs - 1, throttleMs, throttleMs + 1]) {
      assert.equal(policy.throttledDue(last + delta, last), delta >= throttleMs)
    }
  }
  for (const now of [-1, NaN, Infinity, -Infinity]) assert.equal(policy.throttledDue(now, 0), false)
})
for (const checkpointMs of [1, 2500, 5000]) test('CommitPolicy checkpoint uses later commit/dirty age at ' + checkpointMs, () => {
  const policy = new CommitPolicy({ checkpointMs })
  for (const [last, dirty] of [[0, 0], [10000, 11000], [11000, 10000], [10000, 10000]]) {
    const base = Math.max(last, dirty)
    for (const delta of [-1, 0, checkpointMs - 1, checkpointMs, checkpointMs + 1]) {
      assert.equal(policy.checkpointDue(base + delta, last, dirty), delta >= checkpointMs)
    }
  }
  for (const now of [-1, NaN, Infinity, -Infinity]) assert.equal(policy.checkpointDue(now, 0, 0), false)
})
for (const reason of ['IMMEDIATE', 'THROTTLED', 'PERIODIC', 'BACKGROUND', 'FINAL']) {
  test('CommitPolicy backup reason/count/time boundaries ' + reason, () => {
    const policy = new CommitPolicy({ backupEveryNCommits: 10, backupMinIntervalMs: 60000 })
    for (const commits of [0, 8, 9, 10]) {
      for (const age of [-1, 0, 59999, 60000, 60001]) {
        assert.equal(policy.backupDue(reason, commits, 10000, 10000 + age),
          ['IMMEDIATE', 'BACKGROUND', 'FINAL'].includes(reason) && commits >= 9 && age >= 60000)
      }
    }
    assert.equal(new CommitPolicy({ backupEveryNCommits: 1, backupMinIntervalMs: 0 })
      .backupDue(reason, 0, 0, 0), ['IMMEDIATE', 'BACKGROUND', 'FINAL'].includes(reason))
  })
}
for (const code of [
  'STATE_VALIDATION_FAILED', 'STATE_SERIALIZATION_FAILED', 'STATE_WRITE_FAILED', 'STATE_SYNC_FAILED',
  'STATE_PUBLISH_FAILED', 'STATE_CORRUPTED', 'STATE_RECOVERY_FAILED', 'STATE_UNAVAILABLE', 'STATE_LOST',
  'STATE_LOCK_UNAVAILABLE', 'STATE_COMMIT_UNCERTAIN', 'STATE_READ_FAILED', 'STATE_HASH_FAILED', 'STATE_TASK_SUBMIT_FAILED'
]) test('CommitPolicy transient failure classification ' + code, () => {
  assert.equal(new CommitPolicy().transient(refusal(code)),
    ['STATE_WRITE_FAILED', 'STATE_SYNC_FAILED', 'STATE_TASK_SUBMIT_FAILED'].includes(code))
})
for (const result of [
  { status: 'STALE' }, { status: 'STALE_REVISION' }, { status: 'FENCED_COMMIT' }, uncertain(),
  ...['WRITTEN', 'SKIPPED', 'FAILED'].map(backup => ({ status: 'COMMITTED', revision: 1, backup }))
]) test('CommitPolicy transient result classification ' + result.status + (result.backup || ''), () => {
  assert.equal(new CommitPolicy().transient(result), result.status === 'STALE')
})

test('StatePort current source exposes the manager contract without runtime storage/VM imports', () => {
  const portFile = path.join(root, 'runtime/shared/StatePort.ets')
  const source = ts.createSourceFile('StatePort.ts', fs.readFileSync(portFile, 'utf8'), ts.ScriptTarget.ES2020, true)
  const port = source.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'StatePort')
  assert(port)
  const expected = ['load', 'recoverLost', 'beginTurn', 'getWorkingState', 'setWorkingState', 'markEffects', 'proveNoMutation',
    'commitTurn', 'rollbackTurn', 'checkpointIfDue', 'checkpoint', 'reloadAfterExternalWrite', 'checkOnResume',
    'finalSave', 'committedSnapshot', 'captureWorkingSnapshot', 'publishGeneration', 'preparePromotion',
    'awaitReadyForImmediate', 'whenIdle', 'status', 'close']
  assert.deepEqual(port.members.map(member => member.name.text).sort(), expected.sort())
  for (const name of expected) assert.equal(typeof StateManager.prototype[name], 'function', name)
  for (const node of source.statements.filter(ts.isImportDeclaration)) assert(node.importClause.isTypeOnly)
  assert(![...imported].some(name => /StateIoTaskPool|CoreFileKit|NetworkKit/.test(name)))
})

test('StatePort recreate outcome is typed with actual load metadata and all recreate reasons', () => {
  const source = ts.createSourceFile('StatePort.ts', fs.readFileSync(path.join(root, 'runtime/shared/StatePort.ets'), 'utf8'),
    ts.ScriptTarget.ES2020, true)
  const outcome = source.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'StateRecreateRequiredResult')
  assert(outcome)
  assert.deepEqual(Object.fromEntries(outcome.members.map(member => [member.name.text, member.type.getText(source)])), {
    status: "'RECREATE_REQUIRED'", reason: 'StateRecreateReason', load: 'LoadResult', discardedDirty: 'boolean'
  })
  const reasons = source.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'StateRecreateReason')
  assert.deepEqual(reasons.type.types.map(type => type.literal.text).sort(), ['ABSENT', 'LOST', 'STAMP_MISMATCH'])
  const reload = source.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'ReloadResult')
  assert.deepEqual(reload.type.types.map(type => type.getText(source)), ['StateReloadOutcome', 'StateRecreateRequiredResult'])
  for (const name of ['reloadAfterExternalWrite', 'checkOnResume']) {
    const port = source.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'StatePort')
    assert.equal(port.members.find(member => member.name.text === name).type.getText(source), 'Promise<ReloadResult>')
  }
})
for (const [throttleMs, checkpointMs] of [[1000, 5000], [2000, 2500]]) {
  test('manager executes actual policy throttleMs=' + throttleMs + ' checkpointMs=' + checkpointMs, async () => {
    const policy = new CommitPolicy({ throttleMs, checkpointMs })
    const c = await ready({ policy })
    assert.equal((await turn(c, 2, 'IMMEDIATE')).status, 'COMMITTED')
    c.clock.value += throttleMs - 1
    assert.equal((await turn(c, 3, 'THROTTLED', 'TICK')).status, 'IN_MEMORY')
    c.clock.value++
    assert.equal((await turn(c, 4, 'THROTTLED', 'TICK')).status, 'COMMITTED')
    await turn(c, 5)
    c.clock.value += checkpointMs - 1
    assert.equal(await c.manager.checkpointIfDue(c.clock.value), null)
    c.clock.value++
    assert.equal((await c.manager.checkpointIfDue(c.clock.value)).status, 'COMMITTED')
    assert.equal(c.storage.count('commit'), 3)
    assert.equal(c.manager.status().dirty, false)
  })
}

for (const options of [
  { appId: '../app' }, { appId: 'project/app/extra' }, { appId: 'project/\\app' },
  { stamp: 'bad\0stamp' }, { stateMaxBytes: 0 }, { stateMaxBytes: 16 * 1024 * 1024 },
  { stateMaxBytes: 1.5 }, { mode: 'BAD' }, { journalMode: 'COPY_IMMEDIATE' },
  { vmGeneration: Number.MAX_SAFE_INTEGER }, { vmGeneration: -1 }
]) test('invalid options refused: ' + JSON.stringify(options), () => {
  assert.throws(() => fixture(options), errorCode('STATE_VALIDATION_FAILED'))
})
test('journal-on requires explicit complete graph/slot/deferred-intent guard', () => {
  assert.throws(() => fixture({ rollbackGuard: undefined }), errorCode('STATE_ROLLBACK_GUARD_REQUIRED'))
  assert.throws(() => fixture({ rollbackGuard: { coverage: 'GRAPH_ONLY' } }), errorCode('STATE_ROLLBACK_GUARD_REQUIRED'))
})
test('persistent mode requires storage; safety-off does not require a guard', () => {
  assert.throws(() => fixture({ storage: undefined }), errorCode('STATE_STORAGE_REQUIRED'))
  fixture({ vmJournal: false, rollbackGuard: undefined })
})
for (const mode of ['PREVIEW', 'LIVE_EPHEMERAL']) {
  test(mode + ' suppresses every storage path and durable snapshot', async () => {
    const c = await ready({ mode })
    const { manager, storage } = c
    assert.equal((await manager.publishGeneration()).status, 'UNCHANGED')
    assert.equal((await manager.checkOnResume()).status, 'UNCHANGED')
    assert.equal((await manager.reloadAfterExternalWrite('APP_RESUME')).status, 'UNCHANGED')
    assert.equal(await manager.checkpointIfDue(999999), null)
    assert.equal(await manager.checkpoint(), null)
    assert.equal((await manager.finalSave()).status, 'IN_MEMORY')
    assert.equal(manager.committedSnapshot(), null)
    assert.equal(manager.status().vmGeneration, 0)
    assert.equal(manager.status().baseRevision, 0)
    const result = await turn(c, 2, 'VOLATILE', mode === 'PREVIEW' ? 'INIT' : 'INPUT')
    assert.deepEqual(result, { status: 'IN_MEMORY', vmGeneration: 0, revision: 0 })
    assert.equal(encodedN(manager.captureWorkingSnapshot()), 2)
    assert.equal(manager.status().dirty, false)
    assert.equal(storage.calls.length, 0)
    await manager.close()
  })
}
test('preview suppresses all noninitial sources and effects without damaging initialization scope', async () => {
  const c = await ready({ mode: 'PREVIEW' })
  for (const source of ['INPUT', 'EFFECT_RESULT', 'TICK', 'SURFACE', 'MOVE']) {
    fails(() => c.manager.beginTurn('VOLATILE', source), 'STATE_PREVIEW_SUPPRESSED')
  }
  const tx = c.manager.beginTurn('VOLATILE', 'CARRY')
  assert.equal(tx.commitClass, 'IMMEDIATE')
  fails(() => c.manager.markEffects(tx), 'STATE_PREVIEW_SUPPRESSED')
  c.manager.rollbackTurn(tx)
  assert.equal(c.guard.count('rollback'), 1)
})
test('ephemeral effects and host intents accept only at in-memory acceptance', async () => {
  const c = await ready({ mode: 'LIVE_EPHEMERAL' })
  const tx = c.manager.beginTurn('VOLATILE')
  c.manager.markEffects(tx)
  c.guard.intents.push(host => host.tickers.push('new'))
  assert.deepEqual(c.guard.host.tickers, ['old-ticker'])
  assert.equal((await c.manager.commitTurn(tx)).status, 'IN_MEMORY')
  assert.deepEqual(c.guard.host.tickers, ['old-ticker', 'new'])
  assert.equal(c.guard.count('accept'), 1)
  assert.equal(c.storage.calls.length, 0)
})

for (const commitClass of ['IMMEDIATE', 'THROTTLED', 'VOLATILE']) {
  test(commitClass + ' explicit trap rollback restores root, shared/cyclic aliases, slots and host bookkeeping without codec', async () => {
    const shared = new vm.VeraArrayValue([num(5)])
    const rootValue = obj({ n: num(1), left: shared, right: shared })
    rootValue.fields.set('self', rootValue)
    const c = await ready({ initialState: rootValue })
    const retainedMap = rootValue.fields
    c.guard.slots.capture.value = shared
    const slots = Object.values(c.guard.slots).map(cell => cell.value)
    const hostFields = c.guard.host.fields
    const before = { ...codecCalls }
    const tx = c.manager.beginTurn(commitClass)
    shared.elements.push(num(6))
    shared.elements[0] = num(8)
    rootValue.fields.set('new', num(9))
    c.guard.slots.global.value = seed(99)
    c.guard.slots.module.value = num(98)
    c.guard.slots.capture.value = seed(97)
    c.guard.host.effectId++
    c.guard.intents.push(host => { host.fields.set('new', 'bad'); host.tickers.push('bad'); host.surface.push('bad') })
    c.manager.markEffects(tx)
    c.manager.setWorkingState(tx, seed(10))
    c.manager.setWorkingState(tx, seed(11))
    c.manager.rollbackTurn(tx)
    assert.equal(c.manager.getWorkingState(), rootValue)
    assert.equal(rootValue.fields, retainedMap)
    assert.equal(rootValue.fields.get('left'), shared)
    assert.equal(rootValue.fields.get('right'), shared)
    assert.equal(rootValue.fields.get('self'), rootValue)
    assert.deepEqual(shared.elements.map(value => value.value), [5])
    assert(!rootValue.fields.has('new'))
    Object.values(c.guard.slots).forEach((cell, index) => assert.equal(cell.value, slots[index]))
    assert.equal(c.guard.host.fields, hostFields)
    assert.deepEqual([...hostFields], [['old', 'field']])
    assert.deepEqual(c.guard.host.tickers, ['old-ticker'])
    assert.deepEqual(c.guard.host.surface, ['old-surface'])
    assert.equal(c.guard.host.effectId, 7)
    assert.equal(c.guard.intents.length, 0)
    assert.equal(tx.hasEffects, false)
    assert.deepEqual(codecCalls, before, 'rollback cannot use persistence encode/decode even with cycles')
    assert.equal(c.guard.count('rollback'), 1)
    assert.equal(c.guard.count('accept'), 0)
  })
}
test('definitive immediate refusal restores only current turn and preserves prior dirty graph/age/sequence', async () => {
  const c = await ready()
  await turn(c, 2)
  const prior = c.manager.status()
  const rootValue = c.manager.getWorkingState()
  c.clock.value += 400
  c.storage.plan('commit', reply(refusal()))
  const tx = c.manager.beginTurn('IMMEDIATE')
  set(c.manager, 3)
  c.manager.setWorkingState(tx, seed(4))
  c.manager.markEffects(tx)
  c.guard.intents.push(host => host.fields.set('bad', 'bad'))
  assert.equal((await c.manager.commitTurn(tx)).status, 'FAILED')
  assert.equal(c.manager.getWorkingState(), rootValue)
  assert.equal(get(c.manager), 2)
  for (const key of ['dirty', 'dirtySince', 'dirtySeq', 'baseRevision']) assert.equal(c.manager.status()[key], prior[key], key)
  assert.equal(c.manager.committedSnapshot(), null)
  assert.equal(c.guard.intents.length, 0)
  assert.equal(tx.hasEffects, false)
  assert.equal(c.storage.count('commit'), 1, 'no automatic retry')
})
test('committed snapshots and status are defensive; dirty capture is distinct and digest is not file hash', async () => {
  const disk = diskState(seed(3))
  const c = await ready({ disk })
  const original = c.manager.committedSnapshot()
  assert.equal(original.version.vmGeneration, 4)
  assert.equal(original.version.revision, 7)
  assert.equal(original.digest, 'sha256:' + crypto.createHash('sha256').update(original.encoded).digest('hex'))
  assert.notEqual(original.digest, disk.header.payloadHash)
  const exposed = c.manager.committedSnapshot()
  exposed.identity.appId = 'wrong'
  exposed.identity.stamp = 'wrong'
  exposed.version.vmGeneration = 90
  exposed.version.revision = 90
  exposed.encoded = 'wrong'
  exposed.digest = 'wrong'
  const status = c.manager.status()
  status.phase = 'FAULTED'
  status.baseRevision = 90
  assert.deepEqual(c.manager.committedSnapshot(), original)
  assert.equal(c.manager.status().phase, 'READY')
  await turn(c, 5)
  assert.deepEqual(c.manager.committedSnapshot(), original)
  assert.equal(encodedN(c.manager.captureWorkingSnapshot()), 5)
  assert.equal(c.storage.count('commit'), 0)
})
test('load result/header and storage DTOs cannot mutate manager metadata', async () => {
  const c = fixture({ disk: diskState(seed(3)) })
  const result = await c.manager.load()
  result.header.vmGeneration = 88
  result.header.revision = 99
  result.stamp = 'wrong'
  result.source = 'BAK'
  result.encodedState = 'wrong'
  await c.manager.publishGeneration()
  const request = c.storage.calls.find(call => call.kind === 'publishGeneration').input
  assert.equal(request.expectedRevision, 7)
  assert.equal(request.expectedSource, 'MAIN')
  assert.equal(request.expectedStamp, STAMP)
  assert.equal(request.nextVmGeneration, 4)
  assert.equal(get(c.manager), 3)
})

for (const commitClass of ['VOLATILE', 'THROTTLED']) {
  test(commitClass + ' effect promotes to durable immediate and holds host intents/snapshot until result', async () => {
    const c = await ready({ disk: diskState() })
    const before = c.manager.committedSnapshot()
    const gate = c.storage.hold('commit')
    const tx = c.manager.beginTurn(commitClass, commitClass === 'VOLATILE' ? 'SURFACE' : 'TICK')
    set(c.manager, 5)
    c.manager.markEffects(tx)
    c.guard.intents.push(host => host.tickers.push('accepted'))
    const pending = observe(c.manager.commitTurn(tx))
    await tick()
    assert.equal(pending.settled, false)
    assert.equal(c.guard.count('accept'), 0)
    assert.deepEqual(c.manager.committedSnapshot(), before)
    assert.deepEqual(c.guard.host.tickers, ['old-ticker'])
    fails(() => c.manager.beginTurn('VOLATILE'), 'STATE_TURN_PENDING')
    fails(() => c.manager.captureWorkingSnapshot(), 'STATE_TURN_PENDING')
    gate.resolve()
    await bounded(c.manager.whenIdle())
    assert.equal(pending.error, null)
    assert.equal(pending.value.status, 'COMMITTED')
    assert.equal(c.manager.status().baseRevision, 8)
    assert.equal(encodedN(c.manager.committedSnapshot().encoded), 5)
    assert.equal(c.guard.count('accept'), 1)
    assert.deepEqual(c.guard.host.tickers, ['old-ticker', 'accepted'])
    assert.equal(c.storage.calls.find(call => call.kind === 'commit').input.backupDue, true)
  })
}
test('effect no-op remains disabled even with explicit proof and equal digest', async () => {
  const c = await ready({ disk: diskState() })
  const tx = c.manager.beginTurn('VOLATILE')
  c.manager.proveNoMutation(tx)
  c.manager.markEffects(tx)
  assert.equal((await c.manager.commitTurn(tx)).status, 'COMMITTED')
  assert.equal(c.storage.count('commit'), 1)
  assert.equal(c.manager.status().baseRevision, 8)
})
for (const source of ['INIT', 'CARRY', 'EFFECT_RESULT']) {
  test(source + ' forces immediate classification from volatile', async () => {
    const c = await ready()
    const tx = c.manager.beginTurn('VOLATILE', source)
    assert.equal(tx.commitClass, 'IMMEDIATE')
    set(c.manager, 8)
    assert.equal((await c.manager.commitTurn(tx)).status, 'COMMITTED')
    assert.equal(c.storage.count('commit'), 1)
  })
}
for (const source of ['INIT', 'CARRY']) {
  test(source + ' matching committed value skips write, but not with effects or prior dirty', async () => {
    const c = await ready({ disk: diskState() })
    let tx = c.manager.beginTurn('IMMEDIATE', source)
    assert.equal((await c.manager.commitTurn(tx)).reason, 'INIT_EQUAL')
    assert.equal(c.storage.count('commit'), 0)
    tx = c.manager.beginTurn('IMMEDIATE', source)
    c.manager.markEffects(tx)
    assert.equal((await c.manager.commitTurn(tx)).status, 'COMMITTED')
    await turn(c, 4)
    tx = c.manager.beginTurn('IMMEDIATE', source)
    set(c.manager, 1)
    assert.equal((await c.manager.commitTurn(tx)).status, 'COMMITTED')
    assert.equal(c.storage.count('commit'), 2)
  })
  test(source + ' definitive initialization refusal faults published candidate', async () => {
    const c = await ready({ disk: diskState() })
    c.storage.plan('commit', reply(refusal()))
    assert.equal((await turn(c, 8, 'IMMEDIATE', source)).status, 'FAILED')
    assert.equal(get(c.manager), 1)
    await quarantined(c, 1)
    assert(c.events.some(event => event.code === 'STATE_INITIALIZATION_REFUSED'))
  })
}
test('immediate saves entire prior dirty state, then advances revision and clears dirty only after durability', async () => {
  const c = await ready()
  await turn(c, 2)
  const tx = c.manager.beginTurn('IMMEDIATE')
  c.manager.getWorkingState().fields.set('extra', str('accepted dirty + immediate'))
  const gate = c.storage.hold('commit')
  const pending = c.manager.commitTurn(tx)
  await tick()
  assert.equal(c.manager.status().dirty, true)
  assert.equal(c.manager.status().baseRevision, 0)
  gate.resolve()
  assert.equal((await bounded(pending)).status, 'COMMITTED')
  const snapshot = plain(c.manager.committedSnapshot().encoded)
  assert.equal(snapshot.fields.get('n').value, 2)
  assert.equal(snapshot.fields.get('extra').value, 'accepted dirty + immediate')
  assert.equal(c.manager.status().dirty, false)
  assert.equal(c.manager.status().dirtySince, 0)
  assert.equal(c.manager.status().baseRevision, 1)
})

for (const commitClass of ['VOLATILE', 'THROTTLED']) {
  test('checkpoint captures immutable DTO/dirtySeq while overlapping accepted ' + commitClass + ' turns stay dirty', async () => {
    const c = await ready()
    await turn(c, 2)
    const firstSeq = c.manager.status().dirtySeq
    const firstAge = c.manager.status().dirtySince
    const gate = c.storage.hold('commit')
    const pending = c.manager.checkpoint()
    await tick()
    const captured = c.storage.calls.find(call => call.kind === 'commit').input
    assert.equal(encodedN(Buffer.from(captured.payload).toString('utf8')), 2)
    fails(() => c.manager.beginTurn('IMMEDIATE'), 'STATE_TURN_PENDING')
    const immediateReady = observe(c.manager.awaitReadyForImmediate())
    c.clock.value += 20
    const result = await turn(c, 3, commitClass)
    assert.equal(result.status, 'IN_MEMORY')
    assert.equal(c.manager.status().dirtySeq, firstSeq + 1)
    assert.equal(c.manager.status().dirtySince, firstAge)
    assert.equal(encodedN(c.manager.captureWorkingSnapshot()), 3)
    assert.equal(c.storage.count('commit'), 1)
    assert.equal(immediateReady.settled, false)
    gate.resolve()
    assert.equal((await bounded(pending)).status, 'COMMITTED')
    assert.equal(encodedN(c.manager.committedSnapshot().encoded), 2)
    assert.equal(get(c.manager), 3)
    assert.equal(c.manager.status().dirty, true)
    assert.equal(c.manager.status().dirtySince, firstAge)
    await bounded(c.manager.awaitReadyForImmediate())
    assert.equal((await c.manager.checkpoint()).status, 'COMMITTED')
    assert.equal(encodedN(c.manager.committedSnapshot().encoded), 3)
    assert.equal(c.manager.status().dirty, false)
    assert.equal(c.storage.maxActive, 1)
  })
}
test('rollback of overlapping checkpoint-era turn leaves dirtySeq unchanged and checkpoint may clean', async () => {
  const c = await ready()
  await turn(c, 2)
  const seq = c.manager.status().dirtySeq
  const gate = c.storage.hold('commit')
  const pending = c.manager.checkpoint()
  await tick()
  const tx = c.manager.beginTurn('VOLATILE')
  set(c.manager, 9)
  c.manager.rollbackTurn(tx)
  assert.equal(c.manager.status().dirtySeq, seq)
  gate.resolve()
  await bounded(pending)
  assert.equal(get(c.manager), 2)
  assert.equal(c.manager.status().dirty, false)
})
test('checkpoint failure never rolls back already accepted concurrent state', async () => {
  const c = await ready()
  await turn(c, 2)
  const gate = c.storage.hold('commit', request => ({ operationId: request.operationId, result: refusal() }))
  const pending = c.manager.checkpoint()
  await tick()
  await turn(c, 3)
  gate.resolve()
  assert.equal((await bounded(pending)).status, 'FAILED')
  assert.equal(get(c.manager), 3)
  assert.equal(c.guard.count('rollback'), 0)
  assert.equal(c.manager.status().dirty, true)
  assert.equal(c.manager.status().transientFailures, 1)
})
test('checkpoint can confirm while a concurrent volatile scope remains active without losing its root', async () => {
  const c = await ready()
  await turn(c, 2)
  const gate = c.storage.hold('commit')
  const pending = c.manager.checkpoint()
  await tick()
  const tx = c.manager.beginTurn('VOLATILE')
  c.manager.setWorkingState(tx, seed(9))
  gate.resolve()
  await bounded(pending)
  assert.equal(encodedN(c.manager.committedSnapshot().encoded), 2)
  c.manager.rollbackTurn(tx)
  assert.equal(get(c.manager), 2)
  assert.equal(c.manager.status().dirty, false)
})
test('throttled due boundaries use last durable time; volatile does not auto-submit', async () => {
  const c = await ready()
  await turn(c, 2, 'THROTTLED', 'TICK')
  assert.equal(c.storage.count('commit'), 1)
  c.clock.value += 999
  assert.equal((await turn(c, 3, 'THROTTLED', 'TICK')).status, 'IN_MEMORY')
  assert.equal(c.storage.count('commit'), 1)
  c.clock.value++
  assert.equal((await turn(c, 4, 'THROTTLED', 'TICK')).status, 'COMMITTED')
  assert.equal(c.storage.count('commit'), 2)
  c.clock.value += 10000
  await turn(c, 5)
  assert.equal(c.storage.count('commit'), 2)
  assert.equal(c.manager.status().dirty, true)
})
test('checkpointIfDue and clean finalSave avoid unnecessary writes', async () => {
  const c = await ready()
  assert.equal(await c.manager.checkpoint(), null)
  assert.equal((await c.manager.finalSave()).reason, 'CLEAN')
  await turn(c, 2)
  assert.equal(await c.manager.checkpointIfDue(c.clock.value + 4999), null)
  assert.equal((await c.manager.checkpointIfDue(c.clock.value + 5000)).status, 'COMMITTED')
  assert.equal(c.storage.count('commit'), 1)
  assert.equal(c.manager.status().dirty, false)
})

for (const kind of ['size', 'serialization']) {
  for (const commitClass of ['IMMEDIATE', 'THROTTLED', 'VOLATILE']) {
    test(kind + ' refusal for ' + commitClass + ' never submits and follows rollback/dirty rules', async () => {
      const c = await ready({ stateMaxBytes: 128 })
      const tx = c.manager.beginTurn(commitClass)
      const bad = kind === 'size' ? str('状态'.repeat(100)) : new vm.FunctionValue('closure', [])
      c.manager.getWorkingState().fields.set('bad', bad)
      let result = await c.manager.commitTurn(tx)
      if (commitClass === 'VOLATILE') result = await c.manager.checkpoint()
      assert.equal(result.status, 'FAILED')
      assert.equal(result.code, kind === 'size' ? 'STATE_VALIDATION_FAILED' : 'STATE_SERIALIZATION_FAILED')
      assert.equal(result.stage, kind === 'size' ? 'payload-size' : 'serialize')
      assert.equal(c.storage.count('commit'), 0)
      assert.equal(c.manager.status().transientFailures, 0)
      assert.equal(c.manager.status().phase, 'READY')
      assert.equal(c.manager.status().dirty, commitClass !== 'IMMEDIATE')
      assert.equal(c.guard.count('rollback'), commitClass === 'IMMEDIATE' ? 1 : 0)
      assert.equal(c.manager.getWorkingState().fields.has('bad'), commitClass !== 'IMMEDIATE')
      if (commitClass !== 'IMMEDIATE') {
        assert.equal(await c.manager.checkpoint(), null, 'unchanged invalid payload is not retried automatically')
        assert.equal((await c.manager.finalSave()).status, 'FAILED', 'explicit final save must report refusal')
        const fix = c.manager.beginTurn('VOLATILE')
        c.manager.getWorkingState().fields.delete('bad')
        await c.manager.commitTurn(fix)
        assert.equal((await c.manager.checkpoint()).status, 'COMMITTED', 'new dirtySeq unblocks persistence')
      }
    })
  }
}
test('payload maximum is measured in UTF-8 bytes and inclusive at exact boundary', async () => {
  const value = seed()
  const payload = encode(value)
  const size = Buffer.byteLength(payload)
  assert(size > payload.length)
  const exact = await ready({ initialState: value, stateMaxBytes: size })
  assert.equal((await exact.manager.commitTurn(exact.manager.beginTurn('IMMEDIATE'))).status, 'COMMITTED')
  const short = await ready({ stateMaxBytes: size - 1 })
  const result = await short.manager.commitTurn(short.manager.beginTurn('IMMEDIATE'))
  assert.equal(result.stage, 'payload-size')
  assert.equal(short.storage.count('commit'), 0)
})
test('captureWorkingSnapshot refuses oversize without silently cleaning dirty state', async () => {
  const c = await ready({ stateMaxBytes: 128 })
  const tx = c.manager.beginTurn('VOLATILE')
  c.manager.setWorkingState(tx, str('状态'.repeat(100)))
  await c.manager.commitTurn(tx)
  fails(() => c.manager.captureWorkingSnapshot(), 'STATE_VALIDATION_FAILED')
  assert.equal(c.manager.status().dirty, true)
  assert.equal(c.manager.status().phase, 'READY')
})

for (const result of [
  { status: 'STALE' }, refusal('STATE_WRITE_FAILED'), refusal('STATE_SYNC_FAILED'), refusal('STATE_TASK_SUBMIT_FAILED')
]) test('transient immediate refusal ' + (result.code || result.status) + ' rolls back exactly once without retry', async () => {
  const c = await ready({ disk: diskState() })
  const snapshot = c.manager.committedSnapshot()
  c.storage.plan('commit', reply(result))
  const tx = c.manager.beginTurn('IMMEDIATE')
  set(c.manager, 9)
  c.manager.markEffects(tx)
  assert.deepEqual(await c.manager.commitTurn(tx), result)
  assert.equal(get(c.manager), 1)
  assert.equal(c.guard.count('rollback'), 1)
  assert.equal(tx.hasEffects, false)
  assert.deepEqual(c.manager.committedSnapshot(), snapshot)
  assert.equal(c.manager.status().transientFailures, 1)
  assert.equal(c.storage.count('commit'), 1)
})
test('single transient counter spans immediate/throttled/checkpoint, blocks immediate at exact K and resets on commit', async () => {
  const c = await ready()
  c.storage.plan('commit', reply(refusal('STATE_TASK_SUBMIT_FAILED')))
  await turn(c, 2, 'IMMEDIATE')
  assert.equal(c.manager.status().transientFailures, 1)
  assert.equal(c.manager.status().phase, 'READY')
  c.storage.plan('commit', reply({ status: 'STALE' }))
  await turn(c, 3, 'THROTTLED', 'TICK')
  assert.equal(c.manager.status().transientFailures, 2)
  assert.equal(c.manager.status().phase, 'READY')
  c.storage.plan('commit', reply(refusal('STATE_SYNC_FAILED')))
  await c.manager.checkpoint()
  assert.equal(c.manager.status().transientFailures, 3)
  assert.equal(c.manager.status().phase, 'DEGRADED')
  assert.equal(get(c.manager), 3)
  const begins = c.guard.count('begin')
  fails(() => c.manager.beginTurn('IMMEDIATE'), 'STATE_DEGRADED')
  fails(() => c.manager.beginTurn('VOLATILE', 'EFFECT_RESULT'), 'STATE_DEGRADED')
  assert.equal(c.guard.count('begin'), begins, 'degraded refusal is before handler/guard execution')
  await turn(c, 4)
  c.clock.value = 10500
  assert.equal((await turn(c, 5, 'THROTTLED')).status, 'COMMITTED')
  assert.equal(c.manager.status().phase, 'READY')
  assert.equal(c.manager.status().transientFailures, 0)
  assert.equal(c.manager.status().dirty, false)
})
test('degraded dirty manager recovers through finalSave and resets counter', async () => {
  const c = await ready()
  await turn(c, 2)
  for (let i = 0; i < 3; i++) {
    c.storage.plan('commit', reply(refusal()))
    await c.manager.checkpoint()
  }
  assert.equal(c.manager.status().phase, 'DEGRADED')
  assert.equal((await c.manager.finalSave()).status, 'COMMITTED')
  assert.equal(c.manager.status().phase, 'READY')
  assert.equal(c.manager.status().transientFailures, 0)
  assert.equal(c.manager.status().dirty, false)
  await c.manager.awaitReadyForImmediate()
})
test('degraded clean manager probes storage at due point without writing', async () => {
  const c = await ready({ disk: diskState() })
  for (let i = 0; i < 3; i++) {
    c.storage.plan('commit', reply(refusal()))
    await turn(c, 9, 'IMMEDIATE')
  }
  assert.equal(c.manager.status().dirty, false)
  assert.equal(c.manager.status().phase, 'DEGRADED')
  assert.equal(await c.manager.checkpointIfDue(c.clock.value), null)
  assert.equal(c.storage.count('readHeader'), 1)
  assert.equal(c.storage.count('commit'), 3)
  assert.equal(c.manager.status().phase, 'READY')
  assert.equal(c.manager.status().transientFailures, 0)
})
test('effect promotion in degraded mode refuses current turn while preserving prior dirty', async () => {
  const c = await ready()
  await turn(c, 2)
  for (let i = 0; i < 3; i++) {
    c.storage.plan('commit', reply(refusal()))
    await c.manager.checkpoint()
  }
  const prior = c.manager.status()
  const tx = c.manager.beginTurn('VOLATILE')
  set(c.manager, 9)
  c.manager.markEffects(tx)
  assert.equal((await c.manager.commitTurn(tx)).stage, 'degraded-promotion')
  assert.equal(get(c.manager), 2)
  assert.equal(c.manager.status().dirtySeq, prior.dirtySeq)
  assert.equal(c.manager.status().dirty, true)
  assert.equal(c.storage.count('commit'), 3)
})

for (const action of ['trap', 'refusal', 'size', 'serialization']) {
  test('safety-off possible mutation ' + action + ' quarantines graph without rollback or later saves', async () => {
    const c = await ready({ vmJournal: false, stateMaxBytes: 128 })
    await turn(c, 2)
    const tx = c.manager.beginTurn('IMMEDIATE')
    set(c.manager, 9)
    c.manager.markEffects(tx)
    if (action === 'size') c.manager.setWorkingState(tx, str('状态'.repeat(100)))
    if (action === 'serialization') c.manager.setWorkingState(tx, new vm.FunctionValue('bad', []))
    if (action === 'trap') c.manager.rollbackTurn(tx)
    else {
      if (action === 'refusal') c.storage.plan('commit', reply(refusal('STATE_TASK_SUBMIT_FAILED')))
      assert.equal((await c.manager.commitTurn(tx)).status, 'FAILED')
    }
    assert.equal(c.guard.count('begin'), 0)
    assert.equal(tx.hasEffects, false)
    assert(c.events.some(event => event.code === 'VM_ROLLBACK_SKIPPED'))
    assert(c.events.some(event => event.code === 'STATE_DIRTY_DISCARDED'))
    await quarantined(c)
  })
}
for (const action of ['trap', 'refusal']) {
  test('safety-off proven no mutation ' + action + ' preserves prior dirty and normal accounting', async () => {
    const c = await ready({ vmJournal: false })
    await turn(c, 2)
    const prior = c.manager.status()
    const tx = c.manager.beginTurn('IMMEDIATE')
    c.manager.proveNoMutation(tx)
    c.manager.markEffects(tx)
    if (action === 'trap') c.manager.rollbackTurn(tx)
    else {
      c.storage.plan('commit', reply(refusal('STATE_TASK_SUBMIT_FAILED')))
      assert.equal((await c.manager.commitTurn(tx)).status, 'FAILED')
    }
    assert.equal(c.manager.status().phase, 'READY')
    for (const key of ['dirty', 'dirtySeq', 'dirtySince', 'baseRevision']) assert.equal(c.manager.status()[key], prior[key])
    assert.equal(c.manager.status().transientFailures, action === 'trap' ? 0 : 1)
    assert.equal(get(c.manager), 2)
    assert.equal(tx.hasEffects, false)
    assert.equal(c.guard.count('rollback'), 0)
    assert.equal((await c.manager.finalSave()).status, 'COMMITTED')
  })
}
test('no-mutation proof cannot survive any root replacement, even replacement back to original', async () => {
  const c = await ready({ vmJournal: false })
  const original = c.manager.getWorkingState()
  const tx = c.manager.beginTurn('IMMEDIATE')
  c.manager.proveNoMutation(tx)
  c.manager.setWorkingState(tx, seed(3))
  c.manager.setWorkingState(tx, original)
  fails(() => c.manager.proveNoMutation(tx), 'STATE_MUTATION_POSSIBLE')
  c.manager.rollbackTurn(tx)
  await quarantined(c)
})
test('safety-off accepted checkpoint refusal is not a failed immediate turn and remains dirty', async () => {
  const c = await ready({ vmJournal: false })
  await turn(c, 3)
  c.storage.plan('commit', reply(refusal('STATE_TASK_SUBMIT_FAILED')))
  await c.manager.checkpoint()
  assert.equal(c.manager.status().phase, 'READY')
  assert.equal(c.manager.status().dirty, true)
  assert.equal(get(c.manager), 3)
  assert(!c.events.some(event => event.code === 'VM_ROLLBACK_SKIPPED'))
})

for (const safety of [true, false]) {
  for (const result of [{ status: 'FENCED_COMMIT' }, uncertain()]) {
    for (const operation of ['IMMEDIATE', 'CHECKPOINT']) {
      test('safety=' + safety + ' ' + operation + ' ' + result.status + ' quarantines without rollback/retry', async () => {
        const c = await ready({ vmJournal: safety, disk: diskState() })
        const snapshot = c.manager.committedSnapshot()
        await turn(c, 2)
        c.storage.plan('commit', reply(result))
        let tx
        let pending
        if (operation === 'IMMEDIATE') {
          tx = c.manager.beginTurn('IMMEDIATE')
          set(c.manager, 9)
          c.manager.markEffects(tx)
          pending = c.manager.commitTurn(tx)
        } else pending = c.manager.checkpoint()
        assert.equal((await pending).status, result.status)
        assert.equal(get(c.manager), operation === 'IMMEDIATE' ? 9 : 2)
        if (tx) assert.equal(tx.hasEffects, false)
        assert.deepEqual(c.manager.committedSnapshot(), snapshot)
        assert.equal(c.guard.count('discard'), safety && tx ? 1 : 0)
        assert.equal(c.storage.count('commit'), 1)
        await quarantined(c)
      })
    }
  }
}
for (const malformed of [
  request => ({ operationId: 'other-incarnation', result: { status: 'COMMITTED', revision: 1, backup: 'WRITTEN' } }),
  request => ({ operationId: request.operationId, result: { status: 'COMMITTED', revision: 88, backup: 'WRITTEN' } }),
  request => ({ operationId: request.operationId, result: { status: 'COMMITTED', revision: 1, backup: 'BAD' } }),
  request => ({ operationId: request.operationId, result: { status: 'UNKNOWN' } }),
  () => null
]) test('malformed or unknown commit reply is uncertain: ' + tests.length, async () => {
  const c = await ready()
  c.storage.plan('commit', { result: malformed })
  assert.equal((await turn(c, 9, 'IMMEDIATE')).status, 'COMMIT_UNCERTAIN')
  await quarantined(c)
})
test('unclassified rejected storage promise is uncertain, not a definitive submission refusal', async () => {
  const c = await ready()
  c.storage.plan('commit', { error: Error('worker outcome unavailable') })
  assert.equal((await turn(c, 9, 'IMMEDIATE')).status, 'COMMIT_UNCERTAIN')
  await quarantined(c)
})

function factoryFixture(firstDisk = diskState(), secondDisk = diskState(seed(40), { header: { vmGeneration: 8, revision: 12 } }), options = {}) {
  const pools = [new StorageFixture(firstDisk, 'old'), new StorageFixture(secondDisk, 'fresh')]
  let created = 0
  const factory = { create() { assert(created < pools.length, 'unexpected extra storage incarnation'); return pools[created++] } }
  const c = fixture({ storage: undefined, storageFactory: factory, ...options })
  return { ...c, pools, created: () => created }
}
for (const safety of [true, false]) {
  for (const operation of ['IMMEDIATE', 'CHECKPOINT']) {
    test('stale ' + operation + ' safety=' + safety + ' drains old pool and reloads fresh disk, discarding dirty', async () => {
      const c = factoryFixture(undefined, undefined, { vmJournal: safety })
      await c.manager.load()
      await c.manager.publishGeneration()
      await turn(c, 2)
      const [old, fresh] = c.pools
      old.plan('commit', reply({ status: 'STALE_REVISION' }))
      const gate = fresh.hold('load')
      const pending = operation === 'IMMEDIATE' ? turn(c, 9, 'IMMEDIATE') : c.manager.checkpoint()
      await tick(60)
      assert.equal(c.created(), 2)
      assert.equal(old.closed, true)
      assert.equal(old.count('whenIdle'), 1)
      assert.equal(fresh.count('load'), 1)
      assert.equal(c.manager.status().phase, 'RELOAD_PENDING')
      fails(() => c.manager.beginTurn('VOLATILE'), 'STATE_RELOAD_PENDING')
      fails(() => c.manager.checkpoint(), 'STATE_RELOAD_PENDING')
      assert.equal(fresh.count('commit'), 0, 'no write from invalid base during reload')
      gate.resolve()
      assert.equal((await bounded(pending)).status, 'STALE_REVISION')
      assert.equal(get(c.manager), 40)
      assert.equal(c.manager.status().vmGeneration, 9)
      assert.equal(c.manager.status().baseRevision, 12)
      assert.equal(c.manager.status().dirty, false)
      assert.equal(c.manager.status().needsReload, false)
      assert.equal(c.guard.count('rollback'), safety && operation === 'IMMEDIATE' ? 1 : 0)
      assert.equal(old.count('commit'), 1)
      assert.equal(fresh.count('commit'), 0)
      assert(c.events.some(event => event.code === 'STATE_DIRTY_DISCARDED'))
    })
  }
}
for (const safety of [true, false]) test('final stale safety=' + safety + ' discards dirty, reports error, never reloads', async () => {
  const c = factoryFixture(undefined, undefined, { vmJournal: safety })
  await c.manager.load()
  await c.manager.publishGeneration()
  await turn(c, 2)
  c.pools[0].plan('commit', reply({ status: 'STALE_REVISION' }))
  assert.equal((await c.manager.finalSave()).status, 'STALE_REVISION')
  assert.equal(c.created(), 1)
  assert.equal(c.pools[0].count('load'), 1)
  assert.equal(c.manager.status().dirty, false)
  assert(c.events.some(event => event.code === 'STATE_DIRTY_DISCARDED'))
  await bounded(c.manager.close())
  assert.equal(c.manager.status().phase, 'CLOSED')
})
test('stale checkpoint with active accepted-later volatile scope blocks saves until scope settles and reloads', async () => {
  const c = factoryFixture()
  await c.manager.load()
  await c.manager.publishGeneration()
  await turn(c, 2)
  const gate = c.pools[0].hold('commit', request => ({ operationId: request.operationId, result: { status: 'STALE_REVISION' } }))
  const pending = c.manager.checkpoint()
  await tick()
  const graph = c.manager.getWorkingState()
  const cells = Object.values(c.guard.slots)
  const values = cells.map(cell => cell.value)
  const tx = c.manager.beginTurn('VOLATILE')
  set(c.manager, 9)
  for (const cell of cells) cell.value = num(99)
  c.guard.intents.push(host => host.surface.push('stale'))
  c.manager.markEffects(tx)
  gate.resolve()
  await bounded(pending)
  assert.equal(c.manager.status().needsReload, true)
  const result = await bounded(c.manager.commitTurn(tx))
  assert.equal(result.status, 'FAILED')
  assert.equal(tx.hasEffects, false)
  assert.equal(c.guard.count('rollback'), 1)
  assert.equal(c.guard.count('discard'), 0)
  for (const [index, cell] of cells.entries()) assert.equal(cell.value, values[index])
  assert.equal(graph.fields.get('n').value, 2)
  assert.deepEqual(c.guard.host.surface, ['old-surface'])
  assert.equal(c.guard.intents.length, 0)
  assert.equal(get(c.manager), 40)
  assert.equal(c.manager.status().phase, 'READY')
})
test('stale checkpoint followed by trap rollback can still reload after active scope ends', async () => {
  const c = factoryFixture()
  await c.manager.load()
  await c.manager.publishGeneration()
  await turn(c, 2)
  const gate = c.pools[0].hold('commit', request => ({ operationId: request.operationId, result: { status: 'STALE_REVISION' } }))
  const pending = c.manager.checkpoint()
  await tick()
  const tx = c.manager.beginTurn('VOLATILE')
  set(c.manager, 9)
  gate.resolve()
  await bounded(pending)
  c.manager.rollbackTurn(tx)
  assert.equal(c.manager.status().needsReload, true)
  assert.equal((await c.manager.reloadAfterExternalWrite('STALE_REVISION')).status, 'RELOADED')
  assert.equal(get(c.manager), 40)
})
test('reload unavailable blocks all turns, retries at most configured attempts, then faults', async () => {
  const c = await ready({ disk: diskState() })
  await turn(c, 2)
  for (let i = 1; i <= 3; i++) {
    c.storage.plan('load', { result: { kind: 'UNAVAILABLE', code: 'STATE_READ_FAILED', stage: 'fixture-read' } })
    const result = await c.manager.reloadAfterExternalWrite('APP_RESUME')
    assert.equal(result.status, i === 3 ? 'FAULTED' : 'RELOAD_PENDING')
    assert.equal(c.manager.status().reloadAttempts, i)
    if (i < 3) fails(() => c.manager.beginTurn('VOLATILE'), 'STATE_RELOAD_PENDING')
  }
  assert.equal(c.storage.count('commit'), 0)
  await quarantined(c)
})
for (const disk of [{ kind: 'ABSENT' }, diskState(seed(8), { stamp: 'different' })]) {
  test('reload never silently clean-starts from ' + disk.kind + (disk.stamp || ''), async () => {
    const c = await ready({ disk: diskState() })
    await turn(c, 9)
    c.storage.disk = structuredClone(disk)
    const publications = c.storage.count('publishGeneration')
    const reason = disk.kind === 'ABSENT' ? 'ABSENT' : 'STAMP_MISMATCH'
    const result = await c.manager.reloadAfterExternalWrite('APP_RESUME')
    assert.equal(result.status, 'RECREATE_REQUIRED')
    assert.equal(result.reason, reason)
    assert.equal(result.discardedDirty, true)
    assertLoadMetadata(result.load, disk)
    assert.equal(c.manager.status().needsReload, true)
    assert.equal(c.manager.committedSnapshot(), null)
    assert.equal(c.storage.count('publishGeneration'), publications)
    assert.equal(c.storage.count('commit'), 0)
    assert.deepEqual(c.storage.disk, disk)
    assert(c.events.some(event => event.code === 'STATE_RECREATE_REQUIRED' && event.stage === reason))
    if (disk.header) {
      assert.equal(c.manager.status().baseRevision, disk.header.revision)
      result.load.header.revision++
      assert.equal(c.storage.disk.header.revision, disk.header.revision)
    }
    await quarantined(c)
  })
}

for (const variant of ['ABSENT', 'MAIN', 'LEGACY', 'BAK', 'MISMATCH']) {
  test('load/publication matrix ' + variant + ' keeps actual metadata and obeys first-create', async () => {
    const initial = seed(99)
    const disk = variant === 'ABSENT' ? { kind: 'ABSENT' } : diskState(seed(3), {
      format: variant === 'LEGACY' ? 'LEGACY' : 'FORMAT2',
      source: variant === 'BAK' ? 'BAK' : 'MAIN', stamp: variant === 'MISMATCH' ? 'old-stamp' : STAMP
    })
    const c = fixture({ initialState: initial, disk })
    fails(() => c.manager.beginTurn('IMMEDIATE'), 'STATE_NOT_READY')
    const result = await c.manager.load()
    assert.equal(result.kind, disk.kind)
    assert.equal(c.manager.status().phase, 'STARTING')
    fails(() => c.manager.beginTurn('IMMEDIATE'), 'STATE_NOT_READY')
    const oldEncoded = c.storage.disk.encodedState
    const publication = await c.manager.publishGeneration()
    assert.equal(c.manager.status().phase, 'READY')
    if (variant === 'ABSENT') {
      assert.equal(publication.reason, 'ABSENT')
      assert.equal(c.storage.count('publishGeneration'), 0)
      assert.equal(c.storage.disk.kind, 'ABSENT')
      assert.equal(c.manager.status().vmGeneration, 1)
      assert.equal(c.manager.committedSnapshot(), null)
    } else {
      assert.equal(publication.status, 'COMMITTED')
      assert.equal(c.storage.disk.encodedState, oldEncoded)
      assert.equal(c.manager.status().baseRevision, variant === 'LEGACY' ? 0 : 7)
      assert.equal(c.manager.status().vmGeneration, variant === 'LEGACY' ? 1 : 4)
      assert.equal(c.storage.calls.find(call => call.kind === 'publishGeneration').input.expectedStamp, disk.stamp)
    }
    assert.equal(get(c.manager), ['ABSENT', 'MISMATCH'].includes(variant) ? 99 : 3)
    assert.equal(c.manager.committedSnapshot() === null, ['ABSENT', 'MISMATCH'].includes(variant))
    if (variant === 'BAK') assert(c.events.some(event => event.code === 'STATE_RECOVERY'))
    const tx = c.manager.beginTurn('IMMEDIATE', 'INIT')
    const accepted = await c.manager.commitTurn(tx)
    assert.equal(accepted.status, ['ABSENT', 'MISMATCH'].includes(variant) ? 'COMMITTED' : 'UNCHANGED')
    if (variant === 'ABSENT') {
      const request = c.storage.calls.find(call => call.kind === 'commit').input
      assert.deepEqual(request.pre, { appId: APP, vmGeneration: 1, baseRevision: 0 })
      assert.equal(accepted.revision, 1)
    }
  })
}
test('publish chooses max actor/disk generation + 1 and duplicate default publication is idempotent', async () => {
  const c = fixture({ disk: diskState(), vmGeneration: 12 })
  await c.manager.load()
  await c.manager.publishGeneration(13)
  assert.equal(c.manager.status().vmGeneration, 13)
  assert.equal((await c.manager.publishGeneration()).reason, 'CLEAN')
  assert.equal(c.storage.count('publishGeneration'), 1)
})
test('generation overflow and wrong explicit next refuse without storage submission', async () => {
  for (const options of [{ vmGeneration: Number.MAX_SAFE_INTEGER - 1 }, {}]) {
    const c = fixture({ disk: diskState(), ...options })
    await c.manager.load()
    const result = await c.manager.publishGeneration(options.vmGeneration ? undefined : 99)
    assert.equal(result.status, 'FAILED')
    assert.equal(result.code, 'STATE_CORRUPTED')
    assert.equal(c.storage.count('publishGeneration'), 0)
    await quarantined(c)
  }
})
test('publication retries STALE only after completion and deadline is exact with injected clock/sleep', async () => {
  const c = fixture({ disk: diskState() })
  await c.manager.load()
  for (let i = 0; i < 4; i++) c.storage.plan('publishGeneration', reply({ status: 'STALE' }))
  const result = await c.manager.publishGeneration()
  assert.equal(result.status, 'STALE')
  assert.deepEqual(c.sleeps, [10, 10, 5])
  assert.equal(c.storage.count('publishGeneration'), 4)
  assert.equal(c.storage.maxActive, 1)
  assert(c.events.some(event => event.stage === 'publication-deadline'))
  await quarantined(c)
})
test('publication retries can succeed without changing value/revision or submitting state payload', async () => {
  const c = fixture({ disk: diskState() })
  await c.manager.load()
  c.storage.plan('publishGeneration', reply({ status: 'STALE' }))
  assert.equal((await c.manager.publishGeneration()).status, 'COMMITTED')
  assert.deepEqual(c.sleeps, [10])
  assert.equal(c.storage.count('commit'), 0)
  assert.equal(c.manager.status().baseRevision, 7)
  assert.equal(get(c.manager), 1)
})
for (const result of [refusal('STATE_TASK_SUBMIT_FAILED'), { status: 'STALE_REVISION' }, { status: 'FENCED_COMMIT' }, uncertain()]) {
  test('publication definitive/invalid/uncertain refusal ' + (result.code || result.status) + ' never admits new runtime', async () => {
    const c = fixture({ disk: diskState() })
    await c.manager.load()
    c.storage.plan('publishGeneration', reply(result))
    assert.equal((await c.manager.publishGeneration()).status, result.status)
    assert.equal(c.storage.count('publishGeneration'), 1)
    assert.equal(c.storage.count('commit'), 0)
    assert.equal(c.sleeps.length, 0)
    await quarantined(c)
  })
}
test('publication stays STARTING during outstanding operation and close retains ownership', async () => {
  const c = fixture({ disk: diskState() })
  await c.manager.load()
  const gate = c.storage.hold('publishGeneration')
  const publication = c.manager.publishGeneration()
  await tick()
  assert.equal(c.manager.status().phase, 'STARTING')
  fails(() => c.manager.beginTurn('IMMEDIATE'), 'STATE_NOT_READY')
  const idle = observe(c.manager.whenIdle())
  const closing = c.manager.close()
  await tick()
  assert.equal(idle.settled, false)
  assert.equal(c.storage.count('close'), 0)
  gate.resolve()
  assert.equal((await bounded(publication)).status, 'COMMITTED')
  await bounded(closing)
  assert.equal(c.manager.status().phase, 'CLOSED')
  assert.equal(c.storage.closed, true)
})
for (const kind of ['LOST', 'UNAVAILABLE']) test('load ' + kind + ' does not initialize or write fresh state', async () => {
  const c = fixture({ disk: { kind, code: kind === 'LOST' ? 'STATE_LOST' : 'STATE_READ_FAILED' } })
  assert.equal((await c.manager.load()).kind, kind)
  assert.equal(c.storage.count('commit'), 0)
  assert.equal(c.storage.count('publishGeneration'), 0)
  assert.equal(c.manager.status().phase, kind === 'LOST' ? 'FAULTED' : 'RELOAD_PENDING')
  fails(() => c.manager.beginTurn('IMMEDIATE'), kind === 'LOST' ? 'STATE_UNAVAILABLE' : 'STATE_RELOAD_PENDING')
})
for (const change of [
  disk => { disk.header.vmGeneration = Number.MAX_SAFE_INTEGER },
  disk => { disk.header.revision = -1 },
  disk => { disk.header.appId = 'wrong/app' },
  disk => { delete disk.header },
  disk => { delete disk.encodedState },
  disk => { disk.encodedState = '["bad"]' }
]) test('invalid loaded metadata/payload faults without initialization: ' + tests.length, async () => {
  const disk = diskState()
  change(disk)
  const c = fixture({ disk })
  assert.equal((await c.manager.load()).code, 'STATE_CORRUPTED')
  await quarantined(c)
})
for (const variant of ['ABSENT', 'MATCH', 'MISMATCH']) test('ephemeral promotion ' + variant + ' preserves exact graph while establishing target metadata', async () => {
  const initial = seed(50)
  const disk = variant === 'ABSENT' ? { kind: 'ABSENT' } : diskState(seed(4), { stamp: variant === 'MISMATCH' ? 'old-stamp' : STAMP })
  const c = await ready({ mode: 'LIVE_EPHEMERAL', initialState: initial, disk })
  await turn(c, 55)
  await c.manager.preparePromotion()
  assert.equal(c.manager.status().mode, 'LIVE_PERSISTENT')
  assert.equal(c.manager.getWorkingState(), initial)
  assert.equal(get(c.manager), 55)
  assert.equal(c.manager.status().dirty, true)
  assert.equal(c.manager.status().baseRevision, variant === 'ABSENT' ? 0 : 7)
  assert.equal(c.storage.count('commit'), 0)
  const snapshot = c.manager.committedSnapshot()
  if (variant === 'MATCH') assert.equal(encodedN(snapshot.encoded), 4)
  else assert.equal(snapshot, null)
  await c.manager.finalSave()
  assert.equal(encodedN(c.manager.committedSnapshot().encoded), 55)
})

for (const variant of ['ABSENT', 'MATCH', 'MISMATCH']) {
  test('unavailable promotion retry preserves retained graph and slots for ' + variant, async () => {
    const shared = new vm.VeraArrayValue([num(5)])
    const initialState = obj({ n: num(50), left: shared, right: shared })
    const disk = variant === 'ABSENT' ? { kind: 'ABSENT' } : diskState(seed(4), {
      stamp: variant === 'MISMATCH' ? 'old-stamp' : STAMP
    })
    const c = await ready({ mode: 'LIVE_EPHEMERAL', initialState, disk, vmGeneration: 5 })
    c.guard.slots.capture.value = shared
    await turn(c, 55)
    c.storage.plan('load', { result: { kind: 'UNAVAILABLE', code: 'STATE_READ_FAILED', stage: 'promotion-read' } })
    assert.equal((await c.manager.preparePromotion()).kind, 'UNAVAILABLE')
    assert.equal(c.manager.status().phase, 'RELOAD_PENDING')
    fails(() => c.manager.beginTurn('VOLATILE'), 'STATE_RELOAD_PENDING')
    assert.equal(c.storage.count('commit'), 0)
    const result = await c.manager.reloadAfterExternalWrite('APP_RESUME')
    assert.equal(result.status, 'RELOADED')
    assertLoadMetadata(result.load, disk)
    assert.equal(result.discardedDirty, false)
    assert.equal(c.manager.getWorkingState(), initialState)
    assert.equal(initialState.fields.get('left'), shared)
    assert.equal(initialState.fields.get('right'), shared)
    assert.equal(c.guard.slots.capture.value, shared)
    assert.equal(get(c.manager), 55)
    assert.equal(c.manager.status().dirty, true)
    assert.equal(c.manager.status().vmGeneration, variant === 'ABSENT' ? 1 : 6)
    assert.equal(c.manager.status().baseRevision, variant === 'ABSENT' ? 0 : 7)
    assert.equal(c.events.some(event => event.code === 'STATE_DIRTY_DISCARDED'), false)
    assert.equal((await c.manager.finalSave()).status, 'COMMITTED')
    assert.equal(encodedN(c.storage.disk.encodedState), 55)
    const request = c.storage.calls.find(call => call.kind === 'commit').input
    assert.deepEqual(request.pre, { appId: APP, vmGeneration: variant === 'ABSENT' ? 1 : 6,
      baseRevision: variant === 'ABSENT' ? 0 : 7 })
  })
}
test('absent promotion resets ephemeral generation 5 to first-create generation 1', async () => {
  const c = await ready({ mode: 'LIVE_EPHEMERAL', vmGeneration: 5 })
  await turn(c, 55)
  const graph = c.manager.getWorkingState()
  assert.equal(c.manager.status().vmGeneration, 5)
  assert.equal((await c.manager.preparePromotion()).kind, 'ABSENT')
  assert.equal(c.manager.getWorkingState(), graph)
  assert.equal(c.manager.status().vmGeneration, 1)
  assert.equal(c.manager.status().baseRevision, 0)
  assert.equal(c.storage.count('publishGeneration'), 0)
  assert.equal(c.manager.committedSnapshot(), null)
  assert.equal((await c.manager.finalSave()).revision, 1)
  assert.deepEqual(c.storage.calls.find(call => call.kind === 'commit').input.pre,
    { appId: APP, vmGeneration: 1, baseRevision: 0 })
})
for (const pathName of ['LOAD', 'RELOAD', 'RESUME', 'PROMOTION', 'PROMOTION_RETRY']) {
  test('LOST ' + pathName + ' fails closed without resetting storage or clean initialization', async () => {
    const lost = { kind: 'LOST', code: 'STATE_CORRUPTED', stage: 'recovery-backup-format' }
    const c = pathName === 'LOAD' ? fixture({ disk: lost }) : await ready({
      mode: pathName.startsWith('PROMOTION') ? 'LIVE_EPHEMERAL' : 'LIVE_PERSISTENT', disk: diskState()
    })
    const graph = c.manager.getWorkingState()
    const publications = c.storage.count('publishGeneration')
    let result
    if (pathName === 'LOAD') result = await c.manager.load()
    else {
      await turn(c, 9)
      c.storage.disk = structuredClone(lost)
      if (pathName === 'PROMOTION_RETRY') {
        c.storage.plan('load', { result: { kind: 'UNAVAILABLE', code: 'STATE_READ_FAILED' } })
        await c.manager.preparePromotion()
      }
      if (pathName === 'PROMOTION') result = await c.manager.preparePromotion()
      else if (pathName === 'RESUME') result = await c.manager.checkOnResume()
      else result = await c.manager.reloadAfterExternalWrite('APP_RESUME')
    }
    if (['LOAD', 'PROMOTION'].includes(pathName)) assert.deepEqual(result, lost)
    else {
      assert.equal(result.status, 'RECREATE_REQUIRED')
      assert.equal(result.reason, 'LOST')
      assert.equal(result.discardedDirty, pathName !== 'PROMOTION_RETRY')
      assertLoadMetadata(result.load, lost)
      assert(c.events.some(event => event.code === 'STATE_RECREATE_REQUIRED' && event.stage === 'LOST'))
    }
    assert.equal(c.manager.getWorkingState(), graph)
    assert.equal(c.manager.committedSnapshot(), null)
    assert(c.events.some(event => event.code === 'STATE_LOST'))
    assert.equal(c.storage.count('commit'), 0)
    assert.equal(c.storage.count('publishGeneration'), publications)
    assert.deepEqual(c.storage.disk, lost)
    await quarantined(c)
  })
}

test('current recovery contracts expose explicit manager reset without authority injection', () => {
  const source = ts.createSourceFile('StatePort.ts', fs.readFileSync(path.join(root, 'runtime/shared/StatePort.ets'), 'utf8'),
    ts.ScriptTarget.ES2020, true)
  assert(!source.statements.some(node => ts.isInterfaceDeclaration(node) && node.name.text === 'StateLostRecoveryAuthority'))
  for (const name of ['StateStoragePort', 'StatePort']) {
    const port = source.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === name)
    const reset = port.members.find(member => member.name.text === 'recoverLost')
    assert.equal(Boolean(reset.questionToken), name === 'StateStoragePort')
    assert.equal(reset.type.getText(source), 'Promise<LoadResult>')
    assert.equal(reset.parameters.length, name === 'StateStoragePort' ? 2 : 0)
  }
  const manager = ts.createSourceFile('StateManager.ts', fs.readFileSync(path.join(root, 'runtime/StateManager.ets'), 'utf8'),
    ts.ScriptTarget.ES2020, true)
  const options = manager.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'StateManagerOptions')
  assert(!options.members.some(member => member.name.text === 'lostRecoveryAuthority'))
  const optin = options.members.find(member => member.name.text === 'allowInitialLostRecovery')
  assert(optin.questionToken)
  assert.equal(optin.type.getText(manager), 'boolean')
})
for (const kind of ['ABSENT', 'READY']) {
  test('ordinary initial ' + kind + ' never enables LOST reset', async () => {
    const c = recoveryFixture()
    c.storage.disk = kind === 'ABSENT' ? { kind } : diskState(seed(88))
    fails(() => c.manager.recoverLost(), 'STATE_NOT_READY')
    assert.equal((await c.manager.load()).kind, kind)
    fails(() => c.manager.recoverLost(), 'STATE_NOT_READY')
    assert.equal(c.reservation.calls, 0)
    assert.equal(c.storage.count('recoverLost'), 0)
    assert.equal(c.storage.count('commit'), 0)
    await c.manager.publishGeneration()
    assert.equal(c.manager.status().phase, 'READY')
    const tx = c.manager.beginTurn('VOLATILE')
    fails(() => c.manager.recoverLost(), 'STATE_TURN_PENDING')
    c.manager.rollbackTurn(tx)
  })
}
test('opted-in initial LOST waits for actor reset and never persists placeholder before ordinary INIT transaction', async () => {
  const placeholder = seed(42)
  placeholder.fields.set('self', placeholder)
  const c = recoveryFixture({ initialState: placeholder, vmGeneration: 5 })
  const lost = structuredClone(c.storage.disk)
  const loaded = await c.manager.load()
  assertLoadMetadata(loaded, lost)
  loaded.kind = 'ABSENT'
  assert.equal(c.manager.status().phase, 'STARTING')
  assert.equal(c.manager.status().dirty, false)
  assert.equal(c.storage.count('recoverLost'), 0)
  assert.equal(c.reservation.calls, 0)
  recoveryAdmissionDenied(c)
  await assert.rejects(c.manager.awaitReadyForImmediate(), errorCode('STATE_NOT_READY'))
  await assert.rejects(c.manager.finalSave(), errorCode('STATE_NOT_READY'))
  const gate = c.storage.hold('recoverLost')
  const recovering = c.reservation.run(() => c.manager.recoverLost())
  const outcome = observe(recovering)
  const idle = observe(c.manager.whenIdle())
  const immediate = observe(c.manager.awaitReadyForImmediate())
  try {
    await tick()
    assert.equal(c.reservation.held, true)
    assert.equal(c.manager.status().pendingOperations, 1)
    assert.equal(c.storage.active, 1)
    assert.equal(outcome.settled, false)
    assert.equal(idle.settled, false)
    assert.equal(immediate.settled, false)
    fails(() => c.manager.recoverLost(), 'STATE_TURN_PENDING')
    recoveryAdmissionDenied(c)
    assert.equal(c.storage.count('commit'), 0)
    assert.equal(c.storage.count('publishGeneration'), 0)
  } finally { gate.resolve() }
  assertLoadMetadata(await bounded(recovering), { kind: 'ABSENT' })
  await bounded(c.manager.whenIdle())
  await tick()
  assert.equal(immediate.error.code, 'STATE_NOT_READY')
  assert.equal(c.reservation.held, false)
  assert.equal(c.storage.quarantine.length, 1)
  assert.equal(c.storage.disk.kind, 'ABSENT')
  assert.equal(c.manager.getWorkingState(), placeholder)
  assert.equal(c.manager.committedSnapshot(), null)
  assert.equal(c.manager.status().phase, 'STARTING')
  assert.equal(c.manager.status().dirty, false)
  assert.equal(c.manager.status().vmGeneration, 5)
  assert.equal(c.manager.status().baseRevision, 0)
  fails(() => c.manager.recoverLost(), 'STATE_NOT_READY')
  fails(() => c.manager.beginTurn('IMMEDIATE', 'INIT'), 'STATE_NOT_READY')
  assert.equal(c.storage.count('commit'), 0)
  assert.equal(c.storage.count('publishGeneration'), 0)
  assert.equal((await c.manager.publishGeneration()).reason, 'ABSENT')
  assert.equal((await c.manager.finalSave()).reason, 'CLEAN')
  assert.equal(c.storage.disk.kind, 'ABSENT')
  assert.equal(c.storage.count('commit'), 0)
  const tx = c.manager.beginTurn('VOLATILE', 'INIT')
  const initialized = seed(99)
  c.manager.setWorkingState(tx, initialized)
  assert.equal((await c.manager.commitTurn(tx)).status, 'COMMITTED')
  assert.equal(c.manager.getWorkingState(), initialized)
  assert.equal(encodedN(c.storage.disk.encodedState), 99)
  assert.equal(encodedN(c.manager.committedSnapshot().encoded), 99)
  assert.equal(c.storage.count('commit'), 1)
  assert.equal(c.storage.count('load'), 1)
  assert.equal(c.storage.maxActive, 1)
  assert.deepEqual(c.storage.calls.find(call => call.kind === 'commit').input.pre,
    { appId: APP, vmGeneration: 1, baseRevision: 0 })
  assert.deepEqual(c.storage.ownership.filter(([kind]) => ['recoverLost', 'commit', 'publishGeneration'].includes(kind)),
    [['recoverLost', true], ['commit', false]])
  fails(() => c.manager.recoverLost(), 'STATE_NOT_READY')
})
for (const variant of ['MAIN', 'BAK', 'LEGACY', 'MISMATCH']) {
  test('explicit LOST reset recheck restored valid ' + variant + ' wins without quarantine or placeholder overwrite', async () => {
    const restored = diskState(seed(88), { source: variant === 'BAK' ? 'BAK' : 'MAIN',
      format: variant === 'LEGACY' ? 'LEGACY' : 'FORMAT2', stamp: variant === 'MISMATCH' ? 'old-stamp' : STAMP })
    const c = recoveryFixture({ initialState: seed(42) })
    assert.equal((await c.manager.load()).kind, 'LOST')
    await c.reservation.run(async () => {
      c.storage.disk = structuredClone(restored)
      assertLoadMetadata(await c.manager.recoverLost(), restored)
    })
    assert.equal(c.storage.count('recoverLost'), 1)
    assert.equal(c.storage.quarantine.length, 0)
    assert.equal(c.storage.count('commit'), 0)
    assert.equal(c.storage.count('publishGeneration'), 0)
    assert.deepEqual(c.storage.disk, restored)
    assert.equal(c.manager.status().phase, 'STARTING')
    assert.equal(c.manager.status().dirty, false)
    fails(() => c.manager.beginTurn('VOLATILE'), 'STATE_NOT_READY')
    fails(() => c.manager.recoverLost(), 'STATE_NOT_READY')
    assert.equal(get(c.manager), variant === 'MISMATCH' ? 42 : 88)
    assert.equal((await c.manager.publishGeneration()).status, 'COMMITTED')
    assert.equal(c.storage.count('commit'), 0)
    assert.equal(c.storage.disk.encodedState, restored.encodedState)
    assert.equal(c.storage.disk.stamp, restored.stamp)
    const tx = c.manager.beginTurn('IMMEDIATE', 'INIT')
    c.manager.setWorkingState(tx, seed(88))
    const result = await c.manager.commitTurn(tx)
    assert.equal(result.status, variant === 'MISMATCH' ? 'COMMITTED' : 'UNCHANGED')
    if (variant !== 'MISMATCH') assert.equal(result.reason, 'INIT_EQUAL')
    assert.equal(c.storage.count('commit'), variant === 'MISMATCH' ? 1 : 0)
  })
}
for (const optin of [undefined, false]) {
  test('initial LOST without opt-in ' + optin + ' fails closed without resetting', async () => {
    const c = recoveryFixture({ allowInitialLostRecovery: optin })
    assert.equal((await c.manager.load()).kind, 'LOST')
    fails(() => c.manager.recoverLost(), 'STATE_UNAVAILABLE')
    assert.equal(c.storage.count('recoverLost'), 0)
    assert.equal(c.storage.count('commit'), 0)
    assert.equal(c.storage.disk.kind, 'LOST')
    await quarantined(c)
  })
}
test('opted-in initial LOST without storage capability remains blocked and reset cannot retry', async () => {
  const c = recoveryFixture()
  c.storage.recoverLost = undefined
  assert.equal((await c.manager.load()).kind, 'LOST')
  recoveryAdmissionDenied(c)
  const result = await c.reservation.run(() => c.manager.recoverLost())
  assert.deepEqual(result, { kind: 'UNAVAILABLE', code: 'STATE_RECOVERY_FAILED', stage: 'lost-capability' })
  assert.equal(c.manager.status().phase, 'RELOAD_PENDING')
  fails(() => c.manager.recoverLost(), 'STATE_NOT_READY')
  fails(() => c.manager.publishGeneration(), 'STATE_TURN_PENDING')
  assert.equal(c.storage.count('recoverLost'), 0)
  assert.equal(c.storage.count('commit'), 0)
})
for (const pathName of ['PRESERVE', 'RELOAD', 'RESUME', 'PROMOTION', 'PROMOTION_RETRY', 'INITIAL_RETRY']) {
  test('opted-in ' + pathName + ' LOST never enables destructive reset', async () => {
    const c = recoveryFixture({ mode: pathName.startsWith('PROMOTION') ? 'LIVE_EPHEMERAL' : 'LIVE_PERSISTENT' })
    let result
    if (pathName === 'PRESERVE') result = await c.manager.load(true)
    else if (pathName === 'INITIAL_RETRY') {
      c.storage.plan('load', { result: { kind: 'UNAVAILABLE', code: 'STATE_READ_FAILED' } })
      await c.manager.load()
      result = await c.manager.checkOnResume()
    } else {
      if (!pathName.startsWith('PROMOTION')) c.storage.disk = diskState()
      await c.manager.load()
      if (!pathName.startsWith('PROMOTION')) await c.manager.publishGeneration()
      await turn(c, 9)
      c.storage.disk = { kind: 'LOST', code: 'STATE_CORRUPTED' }
      if (pathName === 'PROMOTION_RETRY') {
        c.storage.plan('load', { result: { kind: 'UNAVAILABLE', code: 'STATE_READ_FAILED' } })
        await c.manager.preparePromotion()
      }
      if (pathName === 'PROMOTION') result = await c.manager.preparePromotion()
      else if (pathName === 'RESUME') result = await c.manager.checkOnResume()
      else result = await c.manager.reloadAfterExternalWrite('APP_RESUME')
    }
    assert.equal(['PRESERVE', 'PROMOTION'].includes(pathName) ? result.kind : result.reason, 'LOST')
    fails(() => c.manager.recoverLost(), 'STATE_UNAVAILABLE')
    assert.equal(c.reservation.calls, 0)
    assert.equal(c.storage.count('recoverLost'), 0)
    assert.equal(c.storage.quarantine.length, 0)
    assert.equal(c.storage.count('commit'), 0)
    assert.equal(c.storage.disk.kind, 'LOST')
    await quarantined(c)
  })
}
for (const code of ['STATE_READ_FAILED', 'STATE_LOCK_UNAVAILABLE', 'STATE_COMMIT_UNCERTAIN']) {
  test('initial unavailable ' + code + ' never enables explicit reset', async () => {
    const c = recoveryFixture()
    c.storage.disk = { kind: 'UNAVAILABLE', code, stage: 'initial-read' }
    assert.equal((await c.manager.load()).code, code)
    fails(() => c.manager.recoverLost(), code === 'STATE_COMMIT_UNCERTAIN' ? 'STATE_UNAVAILABLE' : 'STATE_NOT_READY')
    assert.equal(c.storage.count('recoverLost'), 0)
    assert.equal(c.storage.count('commit'), 0)
    assert.equal(c.manager.status().phase, code === 'STATE_COMMIT_UNCERTAIN' ? 'FAULTED' : 'RELOAD_PENDING')
  })
}
for (const failure of ['LOST', 'UNAVAILABLE', 'PARTIAL_RESET', 'THROW', 'BAD_READY']) {
  test('explicit LOST reset ' + failure + ' fails closed without publishing or seeding', async () => {
    const c = recoveryFixture()
    assert.equal((await c.manager.load()).kind, 'LOST')
    if (failure === 'THROW') c.storage.plan('recoverLost', { error: Error('reset worker lost') })
    else if (failure === 'PARTIAL_RESET') c.storage.plan('recoverLost', { result: () => {
      c.storage.quarantine.push(structuredClone(c.storage.disk))
      c.storage.disk = { kind: 'ABSENT' }
      return { kind: 'UNAVAILABLE', code: 'STATE_COMMIT_UNCERTAIN', stage: 'lost-dir-fsync' }
    } })
    else if (failure === 'BAD_READY') {
      const bad = diskState()
      bad.encodedState = '["bad"]'
      c.storage.plan('recoverLost', { result: bad })
    } else c.storage.plan('recoverLost', { result: { kind: failure, code: 'STATE_RECOVERY_FAILED', stage: 'lost-reset' } })
    const result = await c.reservation.run(() => c.manager.recoverLost())
    assert.equal(c.manager.committedSnapshot(), null)
    assert.equal(c.storage.count('recoverLost'), 1)
    assert.equal(c.storage.count('commit'), 0)
    assert.equal(c.storage.count('publishGeneration'), 0)
    assert.equal(c.storage.quarantine.length, failure === 'PARTIAL_RESET' ? 1 : 0)
    if (failure === 'UNAVAILABLE') {
      assert.deepEqual(result, { kind: 'UNAVAILABLE', code: 'STATE_RECOVERY_FAILED', stage: 'lost-reset' })
      assert.equal(c.manager.status().phase, 'RELOAD_PENDING')
      fails(() => c.manager.beginTurn('IMMEDIATE'), 'STATE_NOT_READY')
      fails(() => c.manager.recoverLost(), 'STATE_NOT_READY')
      c.storage.disk = { kind: 'LOST', code: 'STATE_CORRUPTED' }
      assert.equal((await c.manager.checkOnResume()).reason, 'LOST')
    } else {
      assert.equal(result.kind, failure === 'LOST' ? 'LOST' : 'UNAVAILABLE')
      if (['THROW', 'PARTIAL_RESET'].includes(failure)) assert.equal(result.code, 'STATE_COMMIT_UNCERTAIN')
      if (failure === 'BAD_READY') assert.equal(result.code, 'STATE_CORRUPTED')
    }
    fails(() => c.manager.recoverLost(), 'STATE_UNAVAILABLE')
    await quarantined(c)
  })
}
test('initial LOST reset cannot start while initial load is pending', async () => {
  const c = recoveryFixture()
  const gate = c.storage.hold('load')
  const loading = c.manager.load()
  try {
    await tick()
    fails(() => c.manager.recoverLost(), 'STATE_TURN_PENDING')
    assert.equal(c.storage.count('recoverLost'), 0)
  } finally { gate.resolve() }
  assert.equal((await bounded(loading)).kind, 'LOST')
  assert.equal((await c.reservation.run(() => c.manager.recoverLost())).kind, 'ABSENT')
  assert.equal(c.storage.maxActive, 1)
})
test('explicit LOST reset unavailable result reloads valid state without retrying reset or committing placeholder', async () => {
  const c = recoveryFixture({ initialState: seed(42) })
  await c.manager.load()
  c.storage.plan('recoverLost', { result: { kind: 'UNAVAILABLE', code: 'STATE_LOCK_UNAVAILABLE', stage: 'lost-lock' } })
  assert.equal((await c.reservation.run(() => c.manager.recoverLost())).code, 'STATE_LOCK_UNAVAILABLE')
  assert.equal(c.manager.status().phase, 'RELOAD_PENDING')
  fails(() => c.manager.recoverLost(), 'STATE_NOT_READY')
  c.storage.disk = diskState(seed(88))
  assert.equal((await c.manager.checkOnResume()).status, 'RELOADED')
  assert.equal(get(c.manager), 88)
  assert.equal(c.storage.count('recoverLost'), 1)
  assert.equal(c.storage.count('commit'), 0)
  fails(() => c.manager.recoverLost(), 'STATE_NOT_READY')
})
test('explicit LOST reset followed by later resume LOST never permits another reset', async () => {
  const c = recoveryFixture()
  await c.manager.load()
  await c.reservation.run(() => c.manager.recoverLost())
  await c.manager.publishGeneration()
  await turn(c, 99, 'IMMEDIATE', 'INIT')
  c.storage.disk = { kind: 'LOST', code: 'STATE_CORRUPTED' }
  assert.equal((await c.manager.checkOnResume()).reason, 'LOST')
  fails(() => c.manager.recoverLost(), 'STATE_UNAVAILABLE')
  assert.equal(c.storage.count('recoverLost'), 1)
  assert.equal(c.storage.count('commit'), 1)
  await quarantined(c)
})
test('explicit LOST reset uncertain ordinary INIT commit faults without reset retry or placeholder persistence', async () => {
  const c = recoveryFixture({ initialState: seed(42) })
  await c.manager.load()
  await c.reservation.run(() => c.manager.recoverLost())
  await c.manager.publishGeneration()
  c.storage.plan('commit', reply(uncertain()))
  const tx = c.manager.beginTurn('IMMEDIATE', 'INIT')
  c.manager.setWorkingState(tx, seed(99))
  assert.equal((await c.manager.commitTurn(tx)).status, 'COMMIT_UNCERTAIN')
  assert.equal(c.storage.count('recoverLost'), 1)
  assert.equal(c.storage.count('commit'), 1)
  assert.equal(c.storage.disk.kind, 'ABSENT')
  assert.equal(encodedN(Buffer.from(c.storage.calls.find(call => call.kind === 'commit').input.payload).toString('utf8')), 99)
  fails(() => c.manager.recoverLost(), 'STATE_UNAVAILABLE')
  await quarantined(c)
})
for (const stage of ['BEFORE', 'DURING']) {
  test('explicit LOST reset close ' + stage + ' refuses new reset and drains queued storage', async () => {
    const c = recoveryFixture()
    await c.manager.load()
    let gate, recovering
    if (stage === 'DURING') {
      gate = c.storage.hold('recoverLost')
      recovering = c.reservation.run(() => c.manager.recoverLost())
      await tick()
    }
    const closing = c.manager.close()
    fails(() => c.manager.recoverLost(), 'STATE_UNAVAILABLE')
    if (gate) {
      await tick()
      assert.equal(c.storage.count('close'), 0)
      assert.equal(c.storage.active, 1)
      gate.resolve()
      assert.equal((await bounded(recovering)).kind, 'ABSENT')
    }
    await bounded(closing)
    fails(() => c.manager.recoverLost(), 'STATE_UNAVAILABLE')
    assert.equal(c.manager.status().phase, 'CLOSED')
    assert.equal(c.storage.count('recoverLost'), stage === 'DURING' ? 1 : 0)
    assert.equal(c.storage.count('commit'), 0)
    assert.equal(c.storage.count('close'), 1)
    assert.equal(c.storage.active, 0)
  })
}

test('APP_RESUME unchanged header preserves dirty graph, age, seq and committed snapshot', async () => {
  const c = await ready({ disk: diskState() })
  await turn(c, 5)
  const before = c.manager.status()
  const graph = c.manager.getWorkingState()
  const snapshot = c.manager.committedSnapshot()
  const result = await c.manager.checkOnResume()
  assert.deepEqual(result, { status: 'UNCHANGED', load: null, discardedDirty: false })
  assert.equal(c.manager.getWorkingState(), graph)
  assert.deepEqual(c.manager.committedSnapshot(), snapshot)
  for (const key of ['dirty', 'dirtySeq', 'dirtySince', 'baseRevision', 'vmGeneration']) assert.equal(c.manager.status()[key], before[key], key)
  assert.equal(c.storage.count('commit'), 0)
  assert.equal(c.storage.count('load'), 1)
})
for (const change of ['revision', 'vmGeneration', 'payloadHash']) test('APP_RESUME changed ' + change + ' reloads before mutation, disk wins', async () => {
  const c = await ready({ disk: diskState() })
  await turn(c, 5)
  c.storage.disk = diskState(seed(40), { header: { vmGeneration: 4, revision: 7 } })
  if (change === 'revision') c.storage.disk.header.revision++
  if (change === 'vmGeneration') c.storage.disk.header.vmGeneration++
  const result = await c.manager.checkOnResume()
  assert.equal(result.status, 'RELOADED')
  assert.equal(result.discardedDirty, true)
  assert.equal(get(c.manager), 40)
  assert.equal(c.manager.status().dirty, false)
  assert.equal(c.storage.count('commit'), 0)
})
test('resume header failures retain dirty without writing and block next mutation', async () => {
  const c = await ready({ disk: diskState() })
  await turn(c, 5)
  const before = c.manager.status()
  c.storage.plan('readHeader', { error: Error('read unavailable') })
  assert.equal((await c.manager.checkOnResume()).status, 'RELOAD_PENDING')
  assert.equal(c.manager.status().dirty, true)
  assert.equal(c.manager.status().dirtySeq, before.dirtySeq)
  assert.equal(c.manager.status().dirtySince, before.dirtySince)
  fails(() => c.manager.beginTurn('VOLATILE'), 'STATE_RELOAD_PENDING')
  assert.equal(c.storage.count('commit'), 0)
})

test('whenIdle includes active scopes, pending storage, and asynchronous close completion', async () => {
  const c = await ready()
  const tx = c.manager.beginTurn('VOLATILE')
  const idleScope = observe(c.manager.whenIdle())
  await tick()
  assert.equal(idleScope.settled, false)
  fails(() => c.manager.close(), 'STATE_TURN_PENDING')
  c.manager.rollbackTurn(tx)
  await bounded(c.manager.whenIdle())
  assert.equal(idleScope.settled, true)
  const closeGate = c.storage.hold('close')
  const close = c.manager.close()
  assert.equal(c.manager.close(), close, 'duplicate close shares exact in-flight Promise')
  const idleClose = observe(c.manager.whenIdle())
  await tick()
  assert.equal(idleClose.settled, false)
  closeGate.resolve()
  await bounded(close)
  await bounded(c.manager.whenIdle())
  assert.equal(c.manager.status().phase, 'CLOSED')
  fails(() => c.manager.load(), 'STATE_UNAVAILABLE')
})
test('close during load waits owned result and cannot revive closed manager', async () => {
  const c = fixture({ disk: diskState() })
  const gate = c.storage.hold('load')
  const loading = c.manager.load()
  await tick()
  const closing = c.manager.close()
  const idle = observe(c.manager.whenIdle())
  await tick()
  assert.equal(c.storage.count('close'), 0)
  assert.equal(idle.settled, false)
  gate.resolve()
  await bounded(loading)
  await bounded(closing)
  await tick()
  assert.equal(c.manager.status().phase, 'CLOSED')
  assert.equal(c.storage.closed, true)
  fails(() => c.manager.publishGeneration(), 'STATE_UNAVAILABLE')
})
for (const result of [null, refusal('STATE_TASK_SUBMIT_FAILED'), uncertain()]) {
  test('close preserves outstanding final-save outcome ' + (result?.status || 'COMMITTED') + ' and waits cleanup', async () => {
    const c = await ready()
    await turn(c, 5)
    const gate = c.storage.hold('commit', result ? request => ({ operationId: request.operationId, result }) : undefined)
    const saving = c.manager.finalSave()
    await tick()
    const closing = c.manager.close()
    const duplicate = c.manager.close()
    assert.equal(closing, duplicate)
    const idle = observe(c.manager.whenIdle())
    await tick()
    assert.equal(c.storage.count('close'), 0)
    assert.equal(idle.settled, false)
    fails(() => c.manager.beginTurn('VOLATILE'), 'STATE_TURN_PENDING')
    gate.resolve()
    assert.equal((await bounded(saving)).status, result?.status || 'COMMITTED')
    await bounded(closing)
    assert.equal(c.manager.status().phase, 'CLOSED')
    assert.equal(c.manager.status().pendingOperations, 0)
    assert.equal(c.storage.closed, true)
    assert.equal(c.storage.count('commit'), 1)
    await bounded(c.manager.whenIdle())
  })
}
test('finalSave captures accepted state and publishes only after confirmed storage completion', async () => {
  const c = await ready({ disk: diskState() })
  const snapshot = c.manager.committedSnapshot()
  await turn(c, 2)
  const seq = c.manager.status().dirtySeq
  const gate = c.storage.hold('commit')
  const pending = c.manager.finalSave()
  await tick()
  const immediate = observe(c.manager.awaitReadyForImmediate())
  try {
    assert.equal(c.storage.count('commit'), 1)
    const request = c.storage.calls.find(call => call.kind === 'commit').input
    assert.equal(encodedN(Buffer.from(request.payload).toString('utf8')), 2)
    assert.deepEqual(c.manager.committedSnapshot(), snapshot)
    assert.equal(c.manager.status().dirty, true)
    assert.equal(c.manager.status().dirtySeq, seq)
    await tick()
    assert.equal(immediate.settled, false)
  } finally {
    gate.resolve()
    assert.equal((await bounded(pending)).status, 'COMMITTED')
  }
  await bounded(c.manager.whenIdle())
  assert.equal(immediate.settled, true)
  assert.equal(immediate.error, null)
  assert.equal(c.manager.status().dirty, false)
  assert.equal(c.manager.status().dirtySeq, seq)
  assert.equal(c.manager.status().baseRevision, snapshot.version.revision + 1)
  assert.equal(get(c.manager), 2)
  assert.equal(encodedN(c.manager.committedSnapshot().encoded), 2)
})
for (const commitClass of ['VOLATILE', 'THROTTLED']) {
  test('FINAL captured write admits later ' + commitClass + ' and retains newer dirty sequence', async () => {
    const c = await ready({ disk: diskState() })
    await turn(c, 2)
    const before = c.manager.status()
    const gate = c.storage.hold('commit')
    const saving = c.manager.finalSave()
    fails(() => c.manager.beginTurn(commitClass), 'STATE_TURN_PENDING')
    await tick()
    const immediate = observe(c.manager.awaitReadyForImmediate())
    try {
      fails(() => c.manager.beginTurn('IMMEDIATE'), 'STATE_TURN_PENDING')
      assert.equal((await turn(c, 3, commitClass)).status, 'IN_MEMORY')
      assert.equal(c.manager.status().dirtySeq, before.dirtySeq + 1)
      assert.equal(c.storage.count('commit'), 1)
      assert.equal(immediate.settled, false)
    } finally {
      gate.resolve()
      assert.equal((await bounded(saving)).status, 'COMMITTED')
    }
    await bounded(c.manager.whenIdle())
    assert.equal(immediate.error, null)
    assert.equal(immediate.settled, true)
    assert.equal(get(c.manager), 3)
    assert.equal(encodedN(c.manager.committedSnapshot().encoded), 2)
    assert.equal(c.manager.status().dirty, true)
    assert.equal(c.manager.status().dirtySeq, before.dirtySeq + 1)
    assert.equal(c.manager.status().baseRevision, before.baseRevision + 1)
    assert.equal((await c.manager.finalSave()).status, 'COMMITTED')
    assert.equal(c.storage.count('commit'), 2)
    assert.equal(c.storage.maxActive, 1)
    assert.equal(c.manager.status().dirty, false)
    assert.equal(encodedN(c.manager.committedSnapshot().encoded), 3)
  })
}
test('queued final save after checkpoint captures latest accepted state without overlapping storage', async () => {
  const c = await ready()
  await turn(c, 2)
  const gate = c.storage.hold('commit')
  const checkpoint = c.manager.checkpoint()
  await tick()
  await turn(c, 3)
  const final = c.manager.finalSave()
  const idle = observe(c.manager.whenIdle())
  gate.resolve()
  await bounded(checkpoint)
  assert.equal((await bounded(final)).status, 'COMMITTED')
  await bounded(c.manager.whenIdle())
  assert.equal(idle.settled, true)
  assert.equal(c.storage.count('commit'), 2)
  assert.equal(c.storage.maxActive, 1)
  assert.equal(encodedN(c.manager.committedSnapshot().encoded), 3)
})
for (const effects of [false, true]) {
  test('checkpoint plus queued FINAL blocks new ' + (effects ? 'effectful' : 'volatile') + ' turn at admission, then FINAL capture admits memory turns', async () => {
    const c = await ready({ disk: diskState(), policy: new CommitPolicy() })
    await turn(c, 2)
    const checkpointGate = c.storage.hold('commit')
    const checkpoint = c.manager.checkpoint()
    await tick()
    assert.equal(c.manager.status().pendingOperations, 1)
    assert.equal((await turn(c, 3)).status, 'IN_MEMORY')
    const finalGate = c.storage.hold('commit')
    const final = c.manager.finalSave()
    const finalOutcome = observe(final)
    const idle = observe(c.manager.whenIdle())
    const immediate = observe(c.manager.awaitReadyForImmediate())
    const before = c.manager.status()
    const begins = c.guard.count('begin')
    const accepts = c.guard.count('accept')
    let admitted = null
    try {
      assert.equal(before.pendingOperations, 2)
      for (let attempt = 0; attempt < 2; attempt++) {
        fails(() => {
          admitted = c.manager.beginTurn('VOLATILE')
          set(c.manager, 99)
          if (effects) {
            c.manager.markEffects(admitted)
            c.guard.intents.push(host => host.surface.push('must-not-dispatch'))
          }
        }, 'STATE_TURN_PENDING')
        await tick()
      }
      assert.deepEqual(c.manager.status(), before)
      assert.equal(c.guard.count('begin'), begins)
      assert.equal(c.guard.count('accept'), accepts)
      assert.equal(c.guard.intents.length, 0)
      assert.deepEqual(c.guard.host.surface, ['old-surface'])
      assert.equal(get(c.manager), 3)
      assert.equal(c.storage.count('commit'), 1)
      assert.equal(finalOutcome.settled, false)
      assert.equal(idle.settled, false)
      assert.equal(immediate.settled, false)
      checkpointGate.resolve()
      assert.equal((await bounded(checkpoint)).status, 'COMMITTED')
      await tick()
      assert.equal(c.manager.status().pendingOperations, 1)
      assert.equal(c.storage.count('commit'), 2)
      assert.equal(finalOutcome.settled, false)
      const writes = c.storage.calls.filter(call => call.kind === 'commit')
      assert.deepEqual(writes.map(call => encodedN(Buffer.from(call.input.payload).toString('utf8'))), [2, 3])
      assert.equal((await bounded(turn(c, 4))).status, 'IN_MEMORY')
      assert.equal(c.manager.status().dirtySeq, before.dirtySeq + 1)
      assert.equal(c.storage.count('commit'), 2)
      assert.equal(idle.settled, false)
      assert.equal(immediate.settled, false)
    } finally {
      if (admitted) c.manager.rollbackTurn(admitted)
      checkpointGate.resolve()
      finalGate.resolve()
      await bounded(checkpoint)
      assert.equal((await bounded(final)).status, 'COMMITTED')
    }
    await bounded(c.manager.whenIdle())
    assert.equal(finalOutcome.error, null)
    assert.equal(idle.settled, true)
    assert.equal(immediate.settled, true)
    assert.equal(immediate.error, null)
    assert.equal(c.manager.status().pendingOperations, 0)
    assert.equal(c.manager.status().phase, 'READY')
    assert.equal(c.manager.status().dirty, true)
    assert.equal(get(c.manager), 4)
    assert.equal(encodedN(c.manager.committedSnapshot().encoded), 3)
    assert.equal((await bounded(c.manager.finalSave())).status, 'COMMITTED')
    assert.equal(c.manager.status().dirty, false)
    assert.equal(encodedN(c.manager.committedSnapshot().encoded), 4)
    assert.equal(c.storage.maxActive, 1)
    await bounded(c.manager.close())
    assert.equal(c.manager.status().phase, 'CLOSED')
  })
}
test('own captured FINAL admits volatile turn promoted by effects without deadlocking either write', async () => {
  const c = await ready({ disk: diskState(), policy: new CommitPolicy() })
  await turn(c, 2)
  const finalGate = c.storage.hold('commit')
  const final = c.manager.finalSave()
  await tick()
  assert.equal(c.manager.status().pendingOperations, 1)
  const tx = c.manager.beginTurn('VOLATILE')
  set(c.manager, 3)
  c.manager.markEffects(tx)
  c.guard.intents.push(host => host.surface.push('committed-effect'))
  const effectGate = c.storage.hold('commit')
  const effect = c.manager.commitTurn(tx)
  const effectOutcome = observe(effect)
  const idle = observe(c.manager.whenIdle())
  const immediate = observe(c.manager.awaitReadyForImmediate())
  try {
    assert.equal(c.manager.status().pendingOperations, 2)
    await tick()
    assert.equal(c.storage.count('commit'), 1)
    assert.equal(effectOutcome.settled, false)
    assert.equal(idle.settled, false)
    assert.equal(immediate.settled, false)
    assert.deepEqual(c.guard.host.surface, ['old-surface'])
    finalGate.resolve()
    assert.equal((await bounded(final)).status, 'COMMITTED')
    await tick()
    assert.equal(c.storage.count('commit'), 2)
    assert.equal(c.manager.status().pendingOperations, 1)
    assert.equal(encodedN(c.manager.committedSnapshot().encoded), 2)
    assert.equal(effectOutcome.settled, false)
    assert.equal(idle.settled, false)
    assert.deepEqual(c.guard.host.surface, ['old-surface'])
  } finally {
    finalGate.resolve()
    effectGate.resolve()
    await bounded(final)
    assert.equal((await bounded(effect)).status, 'COMMITTED')
  }
  await bounded(c.manager.whenIdle())
  assert.equal(effectOutcome.error, null)
  assert.equal(idle.settled, true)
  assert.equal(immediate.settled, true)
  assert.equal(immediate.error, null)
  assert.equal(c.manager.status().pendingOperations, 0)
  assert.equal(c.manager.status().phase, 'READY')
  assert.equal(c.manager.status().dirty, false)
  assert.equal(encodedN(c.manager.committedSnapshot().encoded), 3)
  assert.deepEqual(c.guard.host.surface, ['old-surface', 'committed-effect'])
  assert.equal(c.guard.intents.length, 0)
  assert.equal(c.storage.maxActive, 1)
  await bounded(c.manager.close())
  assert.equal(c.manager.status().phase, 'CLOSED')
})
test('separate managers can progress while another owns an unresolved storage operation', async () => {
  const a = await ready()
  const b = await ready()
  const gate = a.storage.hold('commit')
  const pending = turn(a, 5, 'IMMEDIATE')
  await tick()
  assert.equal((await bounded(turn(b, 8, 'IMMEDIATE'))).status, 'COMMITTED')
  assert.equal(a.manager.status().pendingOperations, 1)
  assert.equal(b.manager.status().pendingOperations, 0)
  gate.resolve()
  await bounded(pending)
})
test('close error rejects only after CLOSED and idleness settles; duplicate close keeps same rejection', async () => {
  const c = await ready()
  c.storage.plan('close', { error: Error('close failure') })
  const closing = c.manager.close()
  await assert.rejects(closing, /close failure/)
  assert.equal(c.manager.status().phase, 'CLOSED')
  assert.equal(c.manager.close(), closing)
  await bounded(c.manager.whenIdle())
  assert.equal(c.manager.status().pendingOperations, 0)
})
for (const failure of ['begin', 'accept', 'rollback']) test('guard ' + failure + ' failure faults and never leaks idle accounting', async () => {
  const c = await ready({ mode: 'LIVE_EPHEMERAL' })
  c.guard.failure = failure
  if (failure === 'begin') fails(() => c.manager.beginTurn('VOLATILE'), 'STATE_ROLLBACK_FAILED')
  else {
    const tx = c.manager.beginTurn('VOLATILE')
    if (failure === 'accept') await assert.rejects(c.manager.commitTurn(tx), errorCode('STATE_ROLLBACK_FAILED'))
    else c.manager.rollbackTurn(tx)
  }
  assert.equal(c.manager.status().phase, 'FAULTED')
  await bounded(c.manager.whenIdle())
  await bounded(c.manager.close())
})
test('consumed/foreign transactions cannot mutate root, dispatch effects, rollback or commit twice', async () => {
  const c = await ready()
  const tx = c.manager.beginTurn('VOLATILE')
  fails(() => c.manager.setWorkingState({ ...tx }, seed(9)), 'STATE_TRANSACTION_INVALID')
  c.manager.rollbackTurn(tx)
  fails(() => c.manager.setWorkingState(tx, seed(9)), 'STATE_TRANSACTION_INVALID')
  fails(() => c.manager.markEffects(tx), 'STATE_TRANSACTION_INVALID')
  fails(() => c.manager.rollbackTurn(tx), 'STATE_TRANSACTION_INVALID')
  await assert.rejects(c.manager.commitTurn(tx), errorCode('STATE_TRANSACTION_INVALID'))
})
test('diagnostic callback failure cannot disrupt commits and diagnostics contain no payload/state', async () => {
  const c = await ready({ diagnostic: () => { throw Error('subscriber error') } })
  assert.equal((await turn(c, 2, 'IMMEDIATE')).status, 'COMMITTED')
  const d = await ready()
  await turn(d, 3, 'IMMEDIATE')
  assert(d.events.length > 0)
  for (const event of d.events) assert.deepEqual(Object.keys(event).sort(),
    ['appId', 'baseRevision', 'code', 'dirtyAgeMs', 'stage', 'vmGeneration', 'revision', 'durationMs',
      'commitClass', 'turnSource', 'format', 'loadSource', 'outcome', 'dirty', 'transientFailures',
      'reloadAttempts', 'payloadBytes', 'commitsPerSecond', 'p95DurationMs', 'sampleCount', 'windowMs'].sort())
})

test('definitive refusal restores retained graph aliases/slots and deferred host state without decoding snapshot', async () => {
  const shared = new vm.VeraArrayValue([num(5)])
  const initialState = obj({ n: num(1), left: shared, right: shared })
  const c = await ready({ initialState })
  c.guard.slots.capture.value = shared
  const tx = c.manager.beginTurn('IMMEDIATE')
  shared.elements.push(num(8))
  c.guard.slots.capture.value = num(99)
  c.guard.intents.push(host => host.surface.push('rejected'))
  c.manager.setWorkingState(tx, seed(9))
  c.storage.plan('commit', reply(refusal('STATE_TASK_SUBMIT_FAILED')))
  const decodeCount = codecCalls.decode
  assert.equal((await c.manager.commitTurn(tx)).status, 'FAILED')
  assert.equal(codecCalls.decode, decodeCount, 'durable codec is never rollback machinery')
  assert.equal(c.manager.getWorkingState(), initialState)
  assert.equal(initialState.fields.get('left'), shared)
  assert.equal(initialState.fields.get('right'), shared)
  assert.equal(c.guard.slots.capture.value, shared)
  assert.deepEqual(shared.elements.map(item => item.value), [5])
  assert.deepEqual(c.guard.host.surface, ['old-surface'])
})
const { UiHostEnvironment } = load(path.join(root, 'vera/VeraUi.ets'))
const realInstruction = (op, properties = {}) => Object.assign(new vm.Instruction(op), properties)
const realLocal = slot => realInstruction('load-local', { slot })
const realFunction = (name, instructions, parameters = 2) =>
  new vm.BytecodeFunction(name, parameters, parameters, false, instructions)
const realModule = new vm.BytecodeModule([
  realFunction('write', [realLocal(0), realLocal(1), realInstruction('store-field', { name: 'n' }),
    realLocal(0), realInstruction('return')]),
  realFunction('replace', [realLocal(0), realLocal(1), realInstruction('store-field', { name: 'n' }),
    realLocal(1), realInstruction('make-object', { classIdentity: 'State', fields: ['n'] }), realInstruction('return')]),
  realFunction('index', [realLocal(0), realInstruction('push-number', { numValue: 0 }), realLocal(1),
    realInstruction('store-index'), realInstruction('push-null'), realInstruction('return')]),
  realFunction('push', [realLocal(0), realLocal(1), realInstruction('array-push'), realInstruction('return')]),
  realFunction('capture', [realLocal(0), realInstruction('store-capture', { slot: 0 }),
    realInstruction('push-null'), realInstruction('return')]),
  realFunction('call', [realLocal(0), realLocal(1), realInstruction('call', { count: 1 }), realInstruction('return')]),
  realFunction('effect', [realInstruction('load-external', { module: 'std/sdk', name: 'call' }),
    realLocal(0), realLocal(1), realLocal(2), realInstruction('call', { count: 3 }), realInstruction('return')], 3),
  realFunction('read', [realLocal(0), realInstruction('load-field', { name: 'n' }), realInstruction('return')]),
  realFunction('good', [realInstruction('push-null'), realInstruction('return')]),
  realFunction('long', [...Array.from({ length: 10 }, () => realInstruction('push-null')), realInstruction('return')])
], [])
const realTrap = code => error => error instanceof vm.RuntimeTrap && error.trapCode === code
const realEffectArgs = () => [str('fixture.nonexistent.operation'), vm.freshArrayValue([]), str('answered')]
class RecordingUiHost extends UiHostEnvironment {
  constructor() {
    super()
    this.settlements = []
    this.invocations = []
    this.failure = ''
    this.onAccept = null
    this.afterInvoke = null
  }
  beginSafetyTurn(reserve) {
    const scope = super.beginSafetyTurn(reserve)
    if (this.failure === 'begin') throw Error('host begin failure')
    return Object.fromEntries(['accept', 'rollback', 'discard'].map(kind => [kind, () => {
      this.settlements.push(kind)
      scope[kind]()
      if (kind === 'accept' && this.onAccept) this.onAccept()
      if (this.failure === kind) throw Error('host ' + kind + ' failure')
    }]))
  }
  invoke(...args) {
    this.invocations.push(args)
    const result = super.invoke(...args)
    if (this.afterInvoke) this.afterInvoke()
    return result
  }
}
async function realReady(options = {}, limits = {}) {
  const host = new RecordingUiHost()
  const machine = new vm.VirtualMachine(realModule, host, limits.maxSteps ?? 100,
    { now: limits.now || (() => 0), deadlineMs: 1000 },
    { journalMode: 'JOURNAL', journalMaxEntries: limits.journalMaxEntries ?? 65536 })
  const c = await ready({ ...options, rollbackGuard: machine })
  assert.equal(machine.coverage, 'GRAPH_SLOTS_DEFERRED_INTENTS')
  assert(host instanceof vm.HostEnvironment)
  return { ...c, machine, host }
}
function realQueue(c, tx) {
  c.host.effectsAllowed = true
  const id = c.machine.execute('effect', realEffectArgs())
  c.manager.markEffects(tx)
  return id.value
}
async function realFaulted(c) {
  assert.equal(c.manager.status().phase, 'FAULTED')
  assert.equal(c.manager.active, null)
  fails(() => c.manager.beginTurn('VOLATILE'), 'STATE_UNAVAILABLE')
  fails(() => c.manager.checkpoint(), 'STATE_UNAVAILABLE')
  fails(() => c.manager.finalSave(), 'STATE_UNAVAILABLE')
  fails(() => c.manager.captureWorkingSnapshot(), 'STATE_UNAVAILABLE')
  assert.throws(() => c.machine.execute('good'), realTrap('R-JOURNAL'))
  assert.throws(() => c.machine.beginTurn({}, c.manager.getWorkingState()), realTrap('R-JOURNAL'))
  const writes = c.storage.count('commit')
  await bounded(c.manager.whenIdle())
  assert.equal(c.manager.status().pendingOperations, 0)
  await bounded(c.manager.close())
  assert.equal(c.manager.status().phase, 'CLOSED')
  assert.equal(c.storage.count('commit'), writes)
}

for (const code of ['STATE_WRITE_FAILED', 'STATE_TASK_SUBMIT_FAILED']) {
  test('real VM multi-handler refusal restores originalRoot and accepted dirty baseline: ' + code, async () => {
    const c = await realReady()
    const root = c.manager.getWorkingState(), fields = root.fields
    const accepted = c.manager.beginTurn('VOLATILE')
    c.machine.execute('write', [root, num(2)])
    assert.equal((await c.manager.commitTurn(accepted)).status, 'IN_MEMORY')
    const before = c.manager.status(), entries = [...fields]
    const snapshot = c.manager.committedSnapshot(), decodes = codecCalls.decode
    const tx = c.manager.beginTurn('IMMEDIATE')
    const intermediate = c.machine.execute('replace', [root, num(3)])
    c.manager.setWorkingState(tx, intermediate)
    const final = c.machine.execute('replace', [intermediate, num(4)])
    c.manager.setWorkingState(tx, final)
    c.machine.execute('write', [root, num(5)])
    assert.equal(realQueue(c, tx), 1)
    c.storage.plan('commit', reply(refusal(code)))
    assert.equal((await c.manager.commitTurn(tx)).status, 'FAILED')
    assert.equal(codecCalls.decode, decodes)
    assert.equal(c.manager.getWorkingState(), root)
    assert.equal(root.fields, fields)
    assert.deepEqual([...fields], entries)
    for (const [key, value] of entries) assert.equal(fields.get(key), value)
    for (const key of ['dirty', 'dirtySeq', 'dirtySince', 'baseRevision']) {
      assert.equal(c.manager.status()[key], before[key], key)
    }
    assert.deepEqual(c.manager.committedSnapshot(), snapshot)
    assert.equal(tx.hasEffects, false)
    assert.deepEqual(c.host.pendingEffects, [])
    assert.equal(c.host.nextEffectId, 1)
    assert.equal(c.host.effectsAllowed, false)
    assert.deepEqual(c.host.settlements, ['accept', 'rollback'])
    const next = c.manager.beginTurn('VOLATILE')
    assert.equal(c.machine.executePure('read', [root]).value, 2)
    await c.manager.commitTurn(next)
    await bounded(c.manager.whenIdle())
  })
}
test('real VM pre-serialization refusal restores nested aliases, cycles and an external captured Cell', async () => {
  const shared = vm.freshArrayValue([num(6)])
  const nested = obj({ n: num(7), left: shared, right: shared })
  const root = obj({ n: num(1), nested, alias: shared })
  shared.elements.push(nested, shared, root)
  const cell = new vm.Cell(shared), closure = new vm.FunctionValue('capture', [cell])
  const c = await realReady({ initialState: root })
  const accepted = c.manager.beginTurn('VOLATILE')
  c.machine.execute('write', [root, num(2)])
  await c.manager.commitTurn(accepted)
  const before = c.manager.status(), entries = [...root.fields], nestedEntries = [...nested.fields]
  const elements = shared.elements, values = elements.slice(), fields = root.fields, nestedFields = nested.fields
  const counts = { ...codecCalls }, writes = c.storage.count('commit')
  const tx = c.manager.beginTurn('IMMEDIATE')
  c.manager.setWorkingState(tx, c.machine.execute('replace', [root, num(3)]))
  c.machine.execute('index', [new vm.VeraArrayValue(elements), num(8)])
  c.machine.execute('push', [shared, num(9)])
  c.machine.execute('write', [new vm.VeraObjectValue('Alias', nestedFields), num(10)])
  c.machine.execute('call', [closure, c.machine.execute('replace', [c.manager.getWorkingState(), num(4)])])
  c.manager.setWorkingState(tx, cell.value)
  realQueue(c, tx)
  c.policy.effective = () => { throw Error('refuse before serialization') }
  await assert.rejects(c.manager.commitTurn(tx), /refuse before serialization/)
  assert.deepEqual(codecCalls, counts)
  assert.equal(c.storage.count('commit'), writes)
  assert.equal(c.manager.getWorkingState(), root)
  assert.equal(root.fields, fields)
  assert.equal(nested.fields, nestedFields)
  assert.equal(shared.elements, elements)
  assert.deepEqual([...fields], entries)
  assert.deepEqual([...nestedFields], nestedEntries)
  for (const [key, value] of entries) assert.equal(fields.get(key), value)
  for (const [key, value] of nestedEntries) assert.equal(nestedFields.get(key), value)
  assert.equal(elements.length, values.length)
  values.forEach((value, index) => assert.equal(elements[index], value))
  assert.equal(root.fields.get('alias'), shared)
  assert.equal(nested.fields.get('left'), shared)
  assert.equal(nested.fields.get('right'), shared)
  assert.equal(elements[1], nested)
  assert.equal(elements[2], shared)
  assert.equal(elements[3], root)
  assert.equal(closure.captures[0], cell)
  assert.equal(cell.value, shared)
  for (const key of ['dirty', 'dirtySeq', 'dirtySince']) assert.equal(c.manager.status()[key], before[key])
  assert.equal(c.manager.status().phase, 'READY')
  assert.equal(tx.hasEffects, false)
  assert.deepEqual(c.host.pendingEffects, [])
  assert.equal(c.host.nextEffectId, 1)
  assert.deepEqual(c.host.settlements, ['accept', 'rollback'])
  await bounded(c.manager.whenIdle())
})
for (const result of [uncertain(), { status: 'FENCED_COMMIT' }]) {
  test('real VM ' + result.status + ' discards without rollback and quarantines VM and actual host', async () => {
    const c = await realReady(), root = c.manager.getWorkingState()
    const tx = c.manager.beginTurn('IMMEDIATE')
    c.machine.execute('write', [root, num(9)])
    realQueue(c, tx)
    c.storage.plan('commit', reply(result))
    assert.equal((await c.manager.commitTurn(tx)).status, result.status)
    assert.equal(c.manager.getWorkingState(), root)
    assert.equal(root.fields.get('n').value, 9)
    assert.equal(tx.hasEffects, false)
    assert.deepEqual(c.host.settlements, ['discard'])
    assert.equal(c.manager.committedSnapshot(), null)
    assert.deepEqual(c.host.pendingEffects, [])
    assert.throws(() => c.host.beginSafetyTurn(() => {}), realTrap('R-TURN'))
    assert.throws(() => c.host.invoke('std/sdk', 'call', realEffectArgs(), false), realTrap('R-TURN'))
    await realFaulted(c)
  })
}
for (const failure of ['begin', 'accept', 'rollback', 'discard']) {
  test('real VM actual host ' + failure + ' exception faults closed without leaking turn/idle accounting', async () => {
    const c = await realReady(), root = c.manager.getWorkingState(), original = root.fields.get('n')
    c.host.failure = failure
    if (failure === 'begin') fails(() => c.manager.beginTurn('IMMEDIATE'), 'STATE_ROLLBACK_FAILED')
    else {
      const tx = c.manager.beginTurn('IMMEDIATE')
      c.machine.execute('write', [root, num(9)])
      realQueue(c, tx)
      if (failure === 'accept') {
        await assert.rejects(c.manager.commitTurn(tx), errorCode('STATE_ROLLBACK_FAILED'))
        assert.equal(c.storage.count('commit'), 1)
        assert.equal(encodedN(c.storage.disk.encodedState), 9)
        assert.equal(encodedN(c.manager.committedSnapshot().encoded), 9)
        assert.equal(root.fields.get('n').value, 9)
      } else if (failure === 'rollback') {
        c.storage.plan('commit', reply(refusal()))
        assert.equal((await c.manager.commitTurn(tx)).status, 'FAILED')
        assert.equal(root.fields.get('n'), original)
        assert.deepEqual(c.host.pendingEffects, [])
      } else {
        c.storage.plan('commit', reply(uncertain()))
        assert.equal((await c.manager.commitTurn(tx)).status, 'COMMIT_UNCERTAIN')
        assert.equal(root.fields.get('n').value, 9)
        assert.deepEqual(c.host.pendingEffects, [])
      }
      fails(() => c.manager.markEffects(tx), 'STATE_TRANSACTION_INVALID')
    }
    assert.deepEqual(c.host.settlements, failure === 'begin' ? [] : [failure])
    assert(c.events.some(event => event.code === 'STATE_ROLLBACK_FAILED' && event.stage === 'guard-' + failure))
    await realFaulted(c)
  })
}
for (const failure of ['journal', 'steps', 'deadline']) {
  test('real VM ' + failure + ' exhaustion rolls back prior handler, effects and budget failure; next turn works', async () => {
    let time = 0
    const c = await realReady({}, { journalMaxEntries: failure === 'journal' ? 2 : 100,
      maxSteps: failure === 'steps' ? 8 : 100, now: () => time })
    const root = c.manager.getWorkingState(), original = root.fields.get('n'), before = c.manager.status()
    const tx = c.manager.beginTurn('IMMEDIATE')
    c.machine.execute('write', [root, num(5)])
    realQueue(c, tx)
    const effects = c.host.pendingEffects.slice()
    if (failure === 'deadline') c.host.afterInvoke = () => { time += 1001 }
    assert.throws(() => {
      if (failure === 'journal') c.machine.execute('write', [root, num(6)])
      else c.machine.execute(failure === 'steps' ? 'long' : 'effect', realEffectArgs())
    }, realTrap(failure === 'journal' ? 'R-JOURNAL' : 'R-BUDGET'))
    assert.equal(root.fields.get('n').value, 5)
    if (failure !== 'deadline') assert.deepEqual(c.host.pendingEffects, effects)
    c.manager.rollbackTurn(tx)
    assert.equal(c.manager.getWorkingState(), root)
    assert.equal(root.fields.get('n'), original)
    assert.equal(tx.hasEffects, false)
    assert.deepEqual(c.host.pendingEffects, [])
    assert.equal(c.host.nextEffectId, 1)
    assert.equal(c.host.effectsAllowed, false)
    assert.equal(c.storage.count('commit'), 0)
    for (const key of ['dirty', 'dirtySeq', 'dirtySince']) assert.equal(c.manager.status()[key], before[key])
    assert.equal(c.manager.status().phase, 'READY')
    c.host.afterInvoke = null
    const next = c.manager.beginTurn('VOLATILE')
    c.machine.execute('write', [root, num(7)])
    assert.equal((await c.manager.commitTurn(next)).status, 'IN_MEMORY')
    assert.deepEqual(c.host.settlements, ['rollback', 'accept'])
    await bounded(c.manager.whenIdle())
  })
}
for (const mode of ['LIVE_PERSISTENT', 'LIVE_EPHEMERAL']) {
  test('real VM ' + mode + ' acceptance clears manager transaction before scope accept without effect dispatch', async () => {
    const c = await realReady({ mode }), root = c.manager.getWorkingState()
    const queue = c.host.pendingEffects, tx = c.manager.beginTurn('IMMEDIATE')
    c.manager.setWorkingState(tx, c.machine.execute('replace', [root, num(7)]))
    assert.equal(realQueue(c, tx), 1)
    assert.equal(realQueue(c, tx), 2)
    const effects = queue.slice(), callbacks = [], invocations = c.host.invocations.length
    const replacement = c.manager.getWorkingState()
    c.host.answered = () => { callbacks.push('answered') }
    let accepts = 0
    c.host.onAccept = () => {
      accepts++
      assert.equal(c.manager.active, null)
      fails(() => c.manager.markEffects(tx), 'STATE_TRANSACTION_INVALID')
      fails(() => c.manager.setWorkingState(tx, root), 'STATE_TRANSACTION_INVALID')
      assert.equal(c.manager.getWorkingState(), replacement)
      assert.equal(c.storage.count('commit'), mode === 'LIVE_PERSISTENT' ? 1 : 0)
      if (mode === 'LIVE_PERSISTENT') assert.equal(encodedN(c.manager.committedSnapshot().encoded), 7)
      assert.equal(c.host.pendingEffects, queue)
      assert.deepEqual(queue, effects)
      assert.equal(c.host.invocations.length, invocations)
      assert.deepEqual(callbacks, [])
    }
    const result = await c.manager.commitTurn(tx)
    assert.equal(result.status, mode === 'LIVE_PERSISTENT' ? 'COMMITTED' : 'IN_MEMORY')
    assert.equal(accepts, 1)
    assert.equal(c.manager.getWorkingState(), replacement)
    assert.equal(c.host.pendingEffects, queue)
    assert.deepEqual(queue, effects)
    assert.deepEqual(queue.map(effect => effect.id), [1, 2])
    assert.equal(c.host.nextEffectId, 3)
    assert.equal(c.host.effectsAllowed, false)
    assert.equal(c.host.invocations.length, invocations)
    assert.deepEqual(callbacks, [])
    assert.deepEqual(c.host.settlements, ['accept'])
    c.host.onAccept = null
    const next = c.manager.beginTurn('VOLATILE')
    assert.equal(c.machine.executePure('read', [replacement]).value, 7)
    c.manager.rollbackTurn(next)
    assert.deepEqual(queue, effects)
    await bounded(c.manager.whenIdle())
  })
}
test('real VM later pure graph/effect failures preserve committed handler root, revision, snapshot and accepted effects', async () => {
  const c = await realReady(), root = c.manager.getWorkingState()
  const tx = c.manager.beginTurn('IMMEDIATE')
  const accepted = c.machine.execute('replace', [root, num(7)])
  c.manager.setWorkingState(tx, accepted)
  realQueue(c, tx)
  assert.equal((await c.manager.commitTurn(tx)).status, 'COMMITTED')
  const value = accepted.fields.get('n'), before = c.manager.status(), snapshot = c.manager.committedSnapshot()
  const queue = c.host.pendingEffects, effects = queue.slice(), id = c.host.nextEffectId
  for (const entry of ['write', 'effect']) {
    const scope = c.machine.beginTurn({}, accepted)
    assert.throws(() => c.machine.executePure(entry, entry === 'write' ? [accepted, num(8)] : realEffectArgs()), realTrap('R-PURE'))
    assert.equal(accepted.fields.get('n'), value)
    assert.throws(() => scope.accept(), realTrap(entry === 'write' ? 'R-PURE' : 'R-JOURNAL'))
    scope.rollback()
    assert.equal(c.manager.getWorkingState(), accepted)
    assert.equal(accepted.fields.get('n'), value)
    assert.deepEqual(c.manager.status(), before)
    assert.deepEqual(c.manager.committedSnapshot(), snapshot)
    assert.equal(c.storage.count('commit'), 1)
    assert.equal(c.host.pendingEffects, queue)
    assert.deepEqual(queue, effects)
    assert.equal(c.host.nextEffectId, id)
    assert.equal(c.host.effectsAllowed, false)
  }
  const next = c.machine.beginTurn({}, accepted)
  assert.equal(c.machine.executePure('read', [accepted]), value)
  next.accept()
  assert.deepEqual(c.host.settlements, ['accept', 'rollback', 'rollback', 'accept'])
  assert.deepEqual(queue, effects)
  await bounded(c.manager.whenIdle())
})
test('real VM multiple top-level handlers reset step budgets while retaining one rollback journal', async () => {
  const c = await realReady({}, { maxSteps: 5 }), root = c.manager.getWorkingState()
  const original = root.fields.get('n'), tx = c.manager.beginTurn('IMMEDIATE')
  for (let value = 2; value <= 5; value++) c.machine.execute('write', [root, num(value)])
  assert.equal(root.fields.get('n').value, 5)
  c.manager.rollbackTurn(tx)
  assert.equal(root.fields.get('n'), original)
  assert.deepEqual(c.host.settlements, ['rollback'])
  assert.equal(c.storage.count('commit'), 0)
  await bounded(c.manager.whenIdle())
})

test('confirmed durable commit with snapshot hashing failure rereads and validates without rollback or recommit', async () => {
  const c = await ready()
  let injected = false
  c.storage.plan('commit', { after: result => {
    cryptoHook = stage => {
      if (stage === 'create') { injected = true; cryptoHook = null; throw Error('snapshot digest unavailable once') }
    }
    return result
  } })
  assert.equal((await turn(c, 5, 'IMMEDIATE')).status, 'COMMITTED')
  assert.equal(injected, true)
  assert.equal(c.storage.count('load'), 2)
  assert.equal(c.storage.count('commit'), 1)
  assert.equal(c.guard.count('rollback'), 0)
  assert.equal(c.guard.count('accept'), 1)
  assert.equal(c.manager.status().baseRevision, 1)
  assert.equal(encodedN(c.manager.committedSnapshot().encoded), 5)
})
test('confirmed commit with unconfirmable snapshot faults without rollback, effects, or retry', async () => {
  const c = await ready()
  c.storage.plan('commit', { after: result => {
    cryptoHook = stage => { if (stage === 'create') { cryptoHook = null; throw Error('digest unavailable') } }
    c.storage.plan('load', { result: { kind: 'UNAVAILABLE', code: 'STATE_READ_FAILED' } })
    return result
  } })
  const tx = c.manager.beginTurn('IMMEDIATE')
  set(c.manager, 5)
  c.manager.markEffects(tx)
  await assert.rejects(c.manager.commitTurn(tx), errorCode('STATE_COMMIT_UNCERTAIN'))
  assert.equal(tx.hasEffects, false)
  assert.equal(c.storage.count('commit'), 1)
  assert.equal(c.guard.count('discard'), 1)
  await quarantined(c)
})
test('backup counters reset only on WRITTEN; FAILED/SKIPPED preserve due eligibility and durable commit', async () => {
  const c = await ready({ policy: new RecordingPolicy({ backupEveryNCommits: 2, backupMinIntervalMs: 0 }) })
  const due = []
  for (const backup of ['SKIPPED', 'FAILED', 'SKIPPED', 'WRITTEN', 'SKIPPED']) {
    c.storage.plan('commit', { after: (replyValue, request) => {
      due.push(request.backupDue)
      replyValue.result.backup = backup
      return replyValue
    } })
    assert.equal((await turn(c, due.length + 2, 'IMMEDIATE')).status, 'COMMITTED')
    assert.equal(c.manager.status().dirty, false)
    assert.equal(c.manager.status().phase, 'READY')
  }
  assert.deepEqual(due, [false, true, true, true, false])
  assert.equal(c.manager.status().baseRevision, 5)
  assert.equal(c.events.filter(event => event.code === 'STATE_BACKUP' && event.stage === 'FAILED').length, 1)
  assert.equal(c.guard.count('rollback'), 0)
})
test('backup minimum interval and periodic/background/final reasons are passed exact policy metadata', async () => {
  const policy = new RecordingPolicy({ backupMinIntervalMs: 60000 })
  const c = await ready({ policy })
  c.clock.value = 60000
  await turn(c, 2, 'IMMEDIATE')
  c.clock.value++
  await turn(c, 3)
  await c.manager.checkpoint('PERIODIC')
  await turn(c, 4)
  await c.manager.checkpoint('BACKGROUND')
  c.clock.value = 120000
  await turn(c, 5)
  await c.manager.finalSave()
  const writes = c.storage.calls.filter(call => call.kind === 'commit')
  assert.deepEqual(writes.map(call => call.input.backupDue), [true, false, false, true])
  const decisions = policy.calls.filter(call => call[0] === 'backupDue')
  assert.deepEqual(decisions.map(call => call[1]), ['IMMEDIATE', 'PERIODIC', 'BACKGROUND', 'FINAL'])
  assert.deepEqual(decisions.map(call => call[3]), [0, 60000, 60000, 60000])
})
test('checkpoint uncertain result during active volatile scope quarantines and later scope settlement discards', async () => {
  const c = await ready()
  await turn(c, 2)
  const gate = c.storage.hold('commit', request => ({ operationId: request.operationId, result: uncertain() }))
  const checkpoint = c.manager.checkpoint()
  await tick()
  const tx = c.manager.beginTurn('VOLATILE')
  set(c.manager, 9)
  c.manager.markEffects(tx)
  gate.resolve()
  await bounded(checkpoint)
  assert.equal(c.manager.status().phase, 'FAULTED')
  const idle = observe(c.manager.whenIdle())
  await tick()
  assert.equal(idle.settled, false, 'outstanding turn still belongs to lifecycle')
  assert.equal((await c.manager.commitTurn(tx)).status, 'FAILED')
  assert.equal(tx.hasEffects, false)
  assert.equal(c.guard.count('discard'), 1)
  await quarantined(c)
})
test('publication deadline remains bounded even when clock is frozen', async () => {
  const sleeps = []
  const c = fixture({ disk: diskState(), now: () => 10000, sleep: async ms => { sleeps.push(ms) } })
  await c.manager.load()
  for (let i = 0; i < 4; i++) c.storage.plan('publishGeneration', reply({ status: 'STALE' }))
  await c.manager.publishGeneration()
  assert.deepEqual(sleeps, [10, 10, 5])
  await quarantined(c)
})
test('publication retry timer rejection faults without a second publication', async () => {
  const c = fixture({ disk: diskState(), sleep: async () => { throw Error('timer unavailable') } })
  await c.manager.load()
  c.storage.plan('publishGeneration', reply({ status: 'STALE' }))
  const result = await c.manager.publishGeneration()
  assert.equal(result.stage, 'publication-timer')
  assert.equal(c.storage.count('publishGeneration'), 1)
  await quarantined(c)
})
test('publication rejected or unknown-incarnation result cannot produce READY', async () => {
  for (const plan of [
    { error: Error('publication worker lost') },
    { result: { operationId: 'superseded', result: { status: 'COMMITTED', revision: 7, backup: 'SKIPPED' } } }
  ]) {
    const c = fixture({ disk: diskState() })
    await c.manager.load()
    c.storage.plan('publishGeneration', plan)
    assert.equal((await c.manager.publishGeneration()).status, 'COMMIT_UNCERTAIN')
    await quarantined(c)
  }
})
test('resume with absent unchanged target preserves accepted dirty first-create state', async () => {
  const c = await ready()
  await turn(c, 8)
  const before = c.manager.status()
  assert.equal((await c.manager.checkOnResume()).status, 'UNCHANGED')
  assert.equal(c.manager.status().dirtySeq, before.dirtySeq)
  assert.equal(c.manager.status().dirty, true)
  assert.equal(get(c.manager), 8)
  assert.equal(c.storage.count('commit'), 0)
})
test('load uncertainty faults without initialization or clean-start fallback', async () => {
  const c = fixture({ disk: { kind: 'UNAVAILABLE', code: 'STATE_COMMIT_UNCERTAIN', stage: 'load-worker' } })
  assert.equal((await c.manager.load()).kind, 'UNAVAILABLE')
  await quarantined(c)
})
test('late checkpoint commit retains final revision before close and does not revive after CLOSED', async () => {
  const c = await ready()
  await turn(c, 8)
  const gate = c.storage.hold('commit')
  const checkpoint = c.manager.checkpoint()
  await tick()
  const close = c.manager.close()
  fails(() => c.manager.beginTurn('VOLATILE'), 'STATE_TURN_PENDING')
  gate.resolve()
  await bounded(checkpoint)
  await bounded(close)
  assert.equal(c.manager.status().phase, 'CLOSED')
  assert.equal(c.manager.status().baseRevision, 1)
  assert.equal(encodedN(c.manager.committedSnapshot().encoded), 8)
  await tick()
  assert.equal(c.manager.status().phase, 'CLOSED')
  assert.equal(c.storage.count('close'), 1)
})

async function main() {
  let passed = 0
  const failures = []
  for (const { name, run } of tests) {
    cryptoHook = null
    try {
      await bounded(Promise.resolve().then(run), name)
      passed++
    } catch (error) {
      failures.push({ name, error })
      console.error('FAIL ' + name + '\n' + error.stack)
    } finally { cryptoHook = null }
  }
  console.log('StateManager/StatePort: ' + passed + '/' + tests.length + ' passed; ' + failures.length + ' failed')
  if (failures.length) process.exitCode = 1
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
