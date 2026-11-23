'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { TextEncoder, TextDecoder } = require('node:util')
const ts = require(process.env.VERA_TYPESCRIPT_PATH || 'typescript')
const root = path.resolve(__dirname, '../../entry/src/main/ets/runtime')
const APP = 'project/app'
const ROOT = '/state-fixture'
const DIR = ROOT + '/project'
const MAIN = DIR + '/app.state.json'
const BAK = MAIN + '.bak'
const LOCK = MAIN + '.commit.lock'
const STAMP = 'fixture:状态'
const modes = { READ_ONLY: 0, WRITE_ONLY: 1, READ_WRITE: 2, CREATE: 0o100, TRUNC: 0o1000, DIR: 0o200000, NOFOLLOW: 0o400000 }
const EXCL = 0o200
const bytes = value => Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, 'utf8')
const nativeError = (code = 13900005) => Object.assign(new Error('injected native error ' + code), { code })
let active
let cryptoFailure
let cryptoCalls = []
let poolAdapter
let workerDepth = 0

class PoolAdapter {
  constructor() {
    this.plans = []
    this.tasks = []
    this.executions = []
    this.events = []
    const owner = this
    this.Priority = { MEDIUM: 2 }
    this.Task = class {
      constructor(fn, ...args) {
        this.plan = owner.plans.shift() || {}
        owner.tasks.push(this)
        if (this.plan.createError) throw Error('task creation failure')
        this.fn = fn
        this.args = args
      }
      setTransferList(list) {
        if (this.plan.transferError) throw Error('transfer setup failure')
        assert(Array.isArray(list))
        this.transfer = list
      }
    }
  }
  execute(task, priority) {
    assert.equal(priority, this.Priority.MEDIUM)
    assert(task.transfer, 'explicit transfer list required, even for metadata-only tasks')
    const original = task.args[2]
    assert.deepEqual(task.transfer, original.commit ? [original.commit.payload] : [])
    if (task.plan.submitError) throw Error('synchronous submission failure')
    const args = structuredClone(task.args, { transfer: task.transfer })
    assert.notEqual(args[1], task.args[1], 'worker options are a separate snapshot')
    assert.notEqual(args[2], original, 'worker envelope is a separate snapshot')
    if (original.commit) {
      assert.notEqual(args[2].commit, original.commit)
      assert.notEqual(args[2].commit.pre, original.commit.pre)
      assert.notEqual(args[2].commit.payload, original.commit.payload)
      assert.equal(original.commit.payload.byteLength, 0, 'owned buffer detached at execution submission')
    }
    if (original.publication) assert.notEqual(args[2].publication, original.publication)
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    const entry = { task, args, resolve, reject, started: false, finished: false }
    this.executions.push(entry)
    this.events.push('submit:' + args[2].operationId)
    if (task.plan.rejectBefore || task.plan.rejectLate) reject(Error('unconfirmed asynchronous submission'))
    if (!task.plan.hold && !task.plan.rejectBefore && !task.plan.rejectLate) queueMicrotask(() => this.finish(entry))
    return promise
  }
  finish(entry = this.executions.find(item => !item.finished)) {
    assert(entry && !entry.finished)
    entry.started = true
    this.events.push('start:' + entry.args[2].operationId)
    workerDepth++
    try {
      const value = entry.task.fn(...entry.args)
      const reply = entry.task.plan.reply ? entry.task.plan.reply(value) : value
      const cloned = structuredClone(reply)
      if (entry.task.plan.rejectAfter) entry.reject(Error('worker result lost'))
      else entry.resolve(cloned)
    } catch (error) { entry.reject(error) }
    finally {
      workerDepth--
      entry.finished = true
      this.events.push('finish:' + entry.args[2].operationId)
    }
  }
}

class MemoryFs {
  constructor() {
    this.nodes = new Map()
    this.fds = new Map()
    this.trace = []
    this.rules = []
    this.nextFd = 10
    this.nextInode = 1
    this.maxRead = Infinity
    this.maxWrite = Infinity
    this.put(ROOT, '', 'dir')
    this.put(DIR, '', 'dir')
  }
  put(file, value, kind = 'file', ageMs = 0) {
    const node = { id: this.nextInode++, data: bytes(value), kind, mtime: (Date.now() - ageMs) / 1000, owner: null }
    this.nodes.set(file, node)
    return node
  }
  text(file) { return this.nodes.get(file)?.data.toString('utf8') }
  event(op, details = {}) {
    const event = { op, ...details }
    this.trace.push(event)
    const rule = this.rules.find(item => item.remaining > 0 && item.match(event))
    if (rule) {
      rule.remaining--
      rule.hits = (rule.hits || 0) + 1
      return rule.action(event)
    }
  }
  once(match, action) { this.rules.push({ match, action, remaining: 1 }) }
  always(match, action) { this.rules.push({ match, action, remaining: Infinity, hits: 0 }) }
  fail(op, match = () => true, code = 13900005) {
    this.once(event => event.op === op && match(event), () => { throw nativeError(code) })
  }
  descriptor(file) {
    const fd = typeof file === 'number' ? file : file.fd
    assert(Number.isInteger(fd), 'numeric fd required')
    const opened = this.fds.get(fd)
    assert(opened, 'operation on closed fd ' + fd)
    return opened
  }
  openSync(file, flags, mode, legacy = false) {
    this.event('open', { path: file, flags, mode, legacy })
    assert(this.nodes.has(path.dirname(file)) || file === ROOT, 'missing parent: ' + file)
    let node = this.nodes.get(file)
    if (node && (flags & modes.CREATE) && (flags & EXCL)) throw nativeError(13900015)
    if (!node) {
      if (!(flags & modes.CREATE)) throw nativeError(13900002)
      node = this.put(file, '')
    }
    if ((flags & modes.DIR) && node.kind !== 'dir') throw nativeError(13900018)
    if ((flags & modes.NOFOLLOW) && node.kind === 'symlink') throw nativeError(13900016)
    if (flags & modes.TRUNC) node.data = Buffer.alloc(0)
    const fd = this.nextFd++
    const opened = { fd, path: file, node, flags }
    this.fds.set(fd, opened)
    if (legacy) return fd
    return { fd, tryLock: exclusive => this.tryLock(fd, exclusive), unlock: () => this.unlock(fd) }
  }
  closeSync(file) {
    const opened = this.descriptor(file)
    this.event('close', { path: opened.path, fd: opened.fd, inode: opened.node.id })
    if (opened.node.owner === opened.fd) opened.node.owner = null
    this.fds.delete(opened.fd)
  }
  tryLock(fd, exclusive) {
    const opened = this.descriptor(fd)
    assert.equal(exclusive, true)
    this.event('tryLock', { path: opened.path, fd })
    if (opened.node.owner !== null && opened.node.owner !== fd) throw nativeError(13900034)
    opened.node.owner = fd
    this.event('locked', { path: opened.path, fd })
  }
  unlock(fd) {
    const opened = this.descriptor(fd)
    this.event('unlock', { path: opened.path, fd })
    assert.equal(opened.node.owner, fd)
    opened.node.owner = null
  }
  statSync(file) {
    const opened = typeof file === 'string' ? null : this.descriptor(file)
    const node = opened ? opened.node : this.nodes.get(file)
    this.event('stat', { path: opened ? opened.path : file, fd: opened?.fd, inode: node?.id })
    if (!node) throw nativeError(13900002)
    return { size: node.data.length, mtime: node.mtime, isFile: () => node.kind === 'file', isDirectory: () => node.kind === 'dir' }
  }
  lstatSync(file) { return this.statSync(file) }
  readSync(fd, buffer, options) {
    const opened = this.descriptor(fd)
    assert.equal(opened.flags & 3, modes.READ_ONLY)
    const event = { path: opened.path, fd, inode: opened.node.id, offset: options.offset, length: options.length }
    const index = this.trace.length
    const override = this.event('read', event)
    const count = override === undefined ? Math.max(0, Math.min(options.length, this.maxRead, opened.node.data.length - options.offset)) : override
    if (count > 0) opened.node.data.copy(Buffer.from(buffer), 0, options.offset, options.offset + count)
    this.trace[index].count = count
    return count
  }
  writeSync(fd, buffer, options) {
    const opened = this.descriptor(fd)
    assert(opened.flags & (modes.WRITE_ONLY | modes.READ_WRITE))
    assert(buffer instanceof ArrayBuffer)
    const override = this.event('write', { path: opened.path, fd, inode: opened.node.id, offset: options.offset, length: options.length })
    const count = override === undefined ? Math.min(options.length, this.maxWrite) : override
    if (count > 0 && count <= options.length) {
      const next = Buffer.alloc(Math.max(opened.node.data.length, options.offset + count))
      opened.node.data.copy(next)
      Buffer.from(buffer).copy(next, options.offset, 0, count)
      opened.node.data = next
    }
    return count
  }
  fsyncSync(fd) {
    const opened = this.descriptor(fd)
    this.event('fsync', { path: opened.path, fd, kind: opened.node.kind })
  }
  renameSync(from, to) {
    this.event('rename', { path: from, to })
    const node = this.nodes.get(from)
    assert(node, 'rename source missing')
    assert(this.nodes.has(path.dirname(to)), 'rename target directory missing')
    this.nodes.set(to, node)
    this.nodes.delete(from)
  }
  unlinkSync(file) {
    this.event('unlink', { path: file })
    if (!this.nodes.delete(file)) throw nativeError(13900002)
  }
  mkdirSync(file) {
    this.event('mkdir', { path: file })
    if (this.nodes.has(file)) throw nativeError(13900015)
    assert(this.nodes.has(path.dirname(file)))
    this.put(file, '', 'dir')
  }
  listFileSync(dir) {
    this.event('list', { path: dir })
    return [...this.nodes.keys()].filter(file => path.dirname(file) === dir).map(file => path.basename(file))
  }
}
const filesystem = { OpenMode: modes }
for (const method of ['openSync', 'closeSync', 'statSync', 'lstatSync', 'readSync', 'writeSync', 'fsyncSync', 'renameSync', 'unlinkSync', 'mkdirSync', 'listFileSync']) {
  filesystem[method] = (...args) => {
    if (poolAdapter) assert(workerDepth > 0, 'StateIo filesystem call outside a worker')
    return active[method](...args)
  }
}
const legacyFilesystem = {
  openSync: (file, flags, mode) => {
    if (poolAdapter) assert(workerDepth > 0)
    return active.openSync(file, flags, mode, true)
  },
  closeSync: fd => {
    if (poolAdapter) assert(workerDepth > 0)
    assert.equal(typeof fd, 'number')
    return active.closeSync(fd)
  }
}
const util = {
  TextEncoder: class { encodeInto(text) { return new TextEncoder().encode(text) } },
  TextDecoder: { create(encoding, options) {
    assert.equal(encoding, 'utf-8')
    const decoder = new TextDecoder(encoding, options)
    return { decodeToString: (value, decodeOptions) => decoder.decode(value, decodeOptions) }
  } },
  generateRandomUUID: () => crypto.randomUUID()
}
const cryptoFramework = { createMd(algorithm) {
  assert.equal(algorithm, 'SHA256')
  const invoke = stage => {
    cryptoCalls.push(stage)
    if (cryptoFailure?.stage === stage) {
      const error = cryptoFailure.error
      cryptoFailure = null
      throw error
    }
  }
  invoke('create')
  const hash = crypto.createHash('sha256')
  let updates = 0
  return {
    updateSync({ data }) { invoke('update' + ++updates); hash.update(data) },
    digestSync() { invoke('digest'); return { data: hash.digest() } }
  }
} }
const cache = new Map()
const imports = []
function load(file) {
  file = path.resolve(file)
  assert(['StateIo.ets', 'StateFileFormat.ets', 'StateIoTaskPool.ets'].map(name => path.join(root, name)).includes(file), 'forbidden source import: ' + file)
  if (cache.has(file)) return cache.get(file).exports
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8').replace(/^@Concurrent\s*$/gm, ''), {
    fileName: file.replace(/\.ets$/, '.ts'),
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true },
    reportDiagnostics: true
  })
  const errors = (compiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error)
  assert.equal(errors.length, 0, errors.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n'))
  const module = { exports: {} }
  cache.set(file, module)
  const importer = name => {
    imports.push(name)
    if (name === '@kit.CoreFileKit') return { fileIo: filesystem }
    if (name === '@ohos.fileio') return { default: legacyFilesystem }
    if (name === '@kit.ArkTS') return { util, taskpool: {
      get Task() { return poolAdapter.Task },
      get Priority() { return poolAdapter.Priority },
      execute: (...args) => poolAdapter.execute(...args)
    } }
    if (name === '@kit.CryptoArchitectureKit') return { cryptoFramework }
    if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.ets'))
    throw Error('Forbidden dependency: ' + name)
  }
  new Function('require', 'module', 'exports', compiled.outputText)(importer, module, module.exports)
  return module.exports
}
const { StateIo } = load(path.join(root, 'StateIo.ets'))
const format = load(path.join(root, 'StateFileFormat.ets'))
const payload = text => JSON.stringify(['o', 'State', [['z', ['s', text]], ['a', ['n', 7]]]])
const SMALL = payload('hello 状态 café 🧪')
const LARGE = payload('状态🧪é'.repeat(14000))
const buffer = text => new TextEncoder().encode(text).buffer
const metadata = overrides => ({ appId: APP, schemaVersion: 1, vmGeneration: 3, revision: 7, stamp: STAMP, ...overrides })
const fileText = (overrides = {}, value = SMALL) => format.assembleStateFile(metadata(overrides), value)
const decode = (file = MAIN) => format.validateStateFile(active.text(file), APP)
const request = overrides => ({ operationId: 'commit-fixture', pre: { appId: APP, vmGeneration: 3, baseRevision: 7 }, schemaVersion: 1, stamp: STAMP, payload: buffer(SMALL), backupDue: false, ...overrides })
const publication = overrides => ({ operationId: 'publish-fixture', appId: APP, nextVmGeneration: 4, expectedSource: 'MAIN', expectedRevision: 7, expectedStamp: STAMP, ...overrides })
const isTemp = event => /\.tmp$/.test(event.path || '')
const isMainTemp = event => event.path?.startsWith(MAIN + '.') && !event.path.startsWith(BAK + '.') && isTemp(event)
const isBakTemp = event => event.path?.startsWith(BAK + '.') && isTemp(event)
const mutations = () => active.trace.filter(event => ['write', 'rename', 'unlink', 'mkdir'].includes(event.op) || (event.op === 'open' && (event.flags & modes.CREATE) && event.path !== LOCK))
function noWrites() { assert.deepEqual(mutations(), []) }
function noTemps() { assert.deepEqual([...active.nodes.keys()].filter(file => file.endsWith('.tmp')), []) }
function readOnlyTrace() {
  assert.deepEqual(active.trace.filter(event => ['tryLock', 'locked', 'unlock', 'write', 'rename', 'unlink', 'mkdir', 'list', 'fsync'].includes(event.op) || (event.op === 'open' && event.flags & modes.CREATE)), [])
}
function seed(overrides = {}, value = SMALL) { const text = fileText(overrides, value); active.put(MAIN, text); return text }
let passed = 0
const failures = []
function test(name, run) {
  active = new MemoryFs()
  cryptoFailure = null
  cryptoCalls = []
  const io = new StateIo(ROOT, { directoryFsync: 'REQUIRED', lockTimeoutMs: 0, tmpOrphanAgeMs: 60000 })
  let error
  try { run(io) } catch (issue) { error = issue }
  try {
    assert.equal(active.fds.size, 0, 'all descriptors released')
    assert([...active.nodes.values()].every(node => node.owner === null), 'all locks released')
    assert(!imports.some(name => /VM|Interpreter|Actor/.test(name)), 'no VM dependency')
    assert(active.rules.every(rule => rule.remaining === 0 || (rule.remaining === Infinity && rule.hits > 0)), 'every injected failure/hook exercised')
    assert.equal(cryptoFailure, null, 'crypto injection exercised')
  } catch (issue) { if (!error) error = issue }
  if (error) {
    failures.push({ name, error })
    console.error('FAIL ' + name + '\n' + error.stack)
  } else passed++
}

test('success / unicode large partial byte IO and native exclusive numeric fd', io => {
  assert(Buffer.byteLength(LARGE) > 65536)
  active.maxRead = 997
  active.maxWrite = 733
  const result = io.commit(request({ pre: { appId: APP, vmGeneration: 1, baseRevision: 0 }, payload: buffer(LARGE), backupDue: true }))
  assert.deepEqual(result, { status: 'COMMITTED', revision: 1, backup: 'WRITTEN' })
  assert.equal(active.text(MAIN), active.text(BAK))
  const loaded = io.load(APP, STAMP)
  assert.equal(loaded.encodedState, LARGE)
  assert.equal(loaded.source, 'MAIN')
  assert.equal(loaded.header.vmGeneration, 1)
  assert.equal(loaded.header.revision, 1)
  assert.equal(loaded.header.payloadLength, Buffer.byteLength(LARGE))
  const expectedHash = 'sha256:' + crypto.createHash('sha256').update(STAMP + '\0', 'utf8').update(LARGE, 'utf8').digest('hex')
  assert.equal(loaded.header.payloadHash, expectedHash)
  for (const event of active.trace.filter(event => event.op === 'open' && isTemp(event))) {
    assert.equal(event.legacy, true)
    assert(event.flags & EXCL)
    assert(event.flags & modes.NOFOLLOW)
    assert.equal(event.mode, 0o600)
  }
  for (const op of ['read', 'write']) {
    const events = active.trace.filter(event => event.op === op)
    assert(events.length > 100)
    assert(events.every(event => event.length <= 65536))
  }
  for (const to of [MAIN, BAK]) {
    const renameIndex = active.trace.findIndex(event => event.op === 'rename' && event.to === to)
    const temp = active.trace[renameIndex].path
    const operations = active.trace.slice(0, renameIndex).filter(event => event.path === temp).map(event => event.op)
    assert.deepEqual(operations.slice(-2), ['fsync', 'close'])
    assert(active.trace.slice(renameIndex + 1).some(event => event.op === 'fsync' && event.path === DIR))
  }
  noTemps()
})

for (const [name, pre, status] of [
  ['generation fence', { vmGeneration: 2, baseRevision: 7 }, 'FENCED_COMMIT'],
  ['future generation fence', { vmGeneration: 4, baseRevision: 7 }, 'FENCED_COMMIT'],
  ['revision conflict', { vmGeneration: 3, baseRevision: 6 }, 'STALE_REVISION']
]) test('CAS / ' + name, io => {
  const old = seed()
  assert.equal(io.commit(request({ pre: { appId: APP, ...pre } })).status, status)
  assert.equal(active.text(MAIN), old)
  noWrites()
})

test('CAS / competing descriptor timeout and subsequent revision conflict', io => {
  const old = seed()
  const peer = new StateIo(ROOT, { directoryFsync: 'REQUIRED', lockTimeoutMs: 0, tmpOrphanAgeMs: 60000 })
  active.once(event => event.op === 'locked', () => {
    const before = active.trace.length
    assert.equal(peer.commit(request()).status, 'STALE')
    assert.equal(active.text(MAIN), old)
    assert.equal(active.trace.slice(before).filter(event => event.op === 'tryLock').length, 1)
    assert.equal(active.fds.size, 1)
  })
  assert.equal(io.commit(request()).status, 'COMMITTED')
  assert.equal(peer.commit(request()).status, 'STALE_REVISION')
  assert.equal(decode().revision, 8)
})

for (const target of [MAIN, BAK]) test('CAS / first-create race ' + path.basename(target), io => {
  const winner = fileText({ vmGeneration: 1, revision: 1 })
  active.once(event => event.op === 'locked', () => { active.put(target, winner) })
  assert.equal(io.commit(request({ pre: { appId: APP, vmGeneration: 1, baseRevision: 0 } })).status, 'STALE_REVISION')
  assert.equal(active.text(target), winner)
  if (target === BAK) assert(!active.nodes.has(MAIN))
  noWrites()
})

for (const vmGeneration of [0, 99]) test('CAS / first absent commit generation ' + vmGeneration + ' is fenced', io => {
  assert.deepEqual(io.commit(request({ pre: { appId: APP, vmGeneration, baseRevision: 0 }, backupDue: true })), { status: 'FENCED_COMMIT' })
  assert(!active.nodes.has(MAIN))
  assert(!active.nodes.has(BAK))
  noWrites()
  noTemps()
  assert.deepEqual(io.commit(request({ pre: { appId: APP, vmGeneration: 1, baseRevision: 0 } })), { status: 'COMMITTED', revision: 1, backup: 'SKIPPED' })
  assert.equal(decode().vmGeneration, 1)
})

const invalidRequests = [
  ['schema', { schemaVersion: 2 }],
  ['malformed JSON', { payload: buffer('[') }],
  ['invalid tagged value', { payload: buffer('["unknown",1]') }],
  ['duplicate tagged field', { payload: buffer('["o","S",[["x",["n",1]],["x",["n",2]]]]') }],
  ['noncanonical whitespace', { payload: buffer('[ "n", 1 ]') }],
  ['noncanonical number', { payload: buffer('["n",1e0]') }],
  ['invalid utf8', { payload: Uint8Array.from([0x5b, 0x22, 0xc0, 0xaf, 0x22, 0x5d]).buffer }],
  ['truncated utf8', { payload: Uint8Array.from([0xf0, 0x9f]).buffer }],
  ['payload not buffer', { payload: SMALL }],
  ['null stamp', { stamp: 'bad\0stamp' }]
]
for (const [name, overrides] of invalidRequests) test('validation / first commit ' + name + ' never touches disk', io => {
  const result = io.commit(request({ pre: { appId: APP, vmGeneration: 1, baseRevision: 0 }, ...overrides }))
  assert.equal(result.status, 'FAILED')
  assert.equal(result.code, 'STATE_VALIDATION_FAILED')
  assert.equal(active.trace.length, 0)
  assert(!active.nodes.has(MAIN))
})

for (const [name, setup, expected] of [
  ['both absent', () => {}, 'ABSENT'],
  ['both corrupt', () => { active.put(MAIN, '{'); active.put(BAK, '{') }, 'LOST'],
  ['corrupt main missing backup', () => { active.put(MAIN, '{') }, 'LOST'],
  ['absent main corrupt backup', () => { active.put(BAK, '{') }, 'LOST'],
  ['invalid utf8 main', () => { active.put(MAIN, Buffer.from([0xff, 0xfe])) }, 'LOST'],
  ['root inaccessible EL2', () => { active.fail('open', event => event.path === ROOT, 13900012) }, 'UNAVAILABLE'],
  ['root permission', () => { active.fail('open', event => event.path === ROOT, 13900001) }, 'UNAVAILABLE'],
  ['main permission', () => { active.fail('open', event => event.path === MAIN, 13900001) }, 'UNAVAILABLE'],
  ['backup permission', () => { active.fail('open', event => event.path === BAK, 13900012) }, 'UNAVAILABLE'],
  ['project permission', () => { active.fail('open', event => event.path === DIR, 13900001) }, 'UNAVAILABLE'],
  ['missing root', () => { active.nodes.clear() }, 'UNAVAILABLE'],
  ['missing project', () => { active.nodes.delete(DIR) }, 'ABSENT']
]) test('load classification / ' + name, io => {
  setup()
  const before = active.text(MAIN)
  const loaded = io.load(APP, STAMP)
  assert.equal(loaded.kind, expected)
  assert.equal(loaded.encodedState, undefined)
  assert.equal(active.text(MAIN), before)
  noWrites()
})

for (const op of ['open', 'read', 'stat']) {
  for (const code of [13900005, 13900001, 13900012]) {
    for (const phase of ['initial', 'recovery']) test('main IO / persistent ' + op + ' code=' + code + ' phase=' + phase + ' never restores backup', io => {
      const old = seed()
      const mainInode = active.nodes.get(MAIN)
      const backup = fileText({ revision: 6 }, payload('backup must not replace main'))
      const backupInode = active.put(BAK, backup)
      const installFailure = () => active.always(event => event.op === op && event.path === MAIN, () => { throw nativeError(code) })
      if (phase === 'initial') installFailure()
      else {
        active.put(MAIN, '{')
        active.once(event => event.op === 'locked', () => {
          active.nodes.set(MAIN, mainInode)
          installFailure()
        })
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const loaded = io.load(APP, STAMP)
        assert.equal(loaded.kind, 'UNAVAILABLE')
        assert.equal(loaded.code, code === 13900005 ? 'STATE_READ_FAILED' : 'STATE_UNAVAILABLE')
        const stage = phase === 'recovery' && attempt === 0 ? 'recovery-main' : 'load-main'
        assert.equal(loaded.stage, stage + (op === 'open' ? '' : '-' + op))
        assert.equal(loaded.encodedState, undefined)
        assert.equal(active.text(MAIN), old)
        assert.equal(active.nodes.get(MAIN), mainInode)
        assert.equal(active.text(BAK), backup)
        assert.equal(active.nodes.get(BAK), backupInode)
        assert.equal(active.fds.size, 0)
        assert.equal(active.nodes.get(LOCK)?.owner ?? null, null)
      }
      assert(!active.trace.some(event => event.path === BAK))
      assert.equal(active.trace.filter(event => event.op === 'tryLock').length, phase === 'initial' ? 0 : 1)
      noWrites()
      noTemps()
    })
  }
}

for (const [name, damage] of [
  ['payload hash', text => text.replace('hello', 'jello')],
  ['payload length', text => text.replace(/"payloadLength":\d+/, '"payloadLength":1')],
  ['identity', () => fileText({ appId: 'other/app' })],
  ['schema', () => fileText({ schemaVersion: 2 })],
  ['stamp binding', text => text.replace('fixture:状态', 'altered:状态')],
  ['trailing garbage', text => text + 'garbage']
]) test('integrity / ' + name + ' is LOST without valid backup', io => {
  const damaged = damage(fileText())
  active.put(MAIN, damaged)
  assert.equal(io.load(APP, STAMP).kind, 'LOST')
  assert.equal(active.text(MAIN), damaged)
  noWrites()
})

for (const stamp of [STAMP, 'other stamp']) test('load / valid main wins higher generation revision different-stamp backup: ' + stamp, io => {
  const main = seed()
  active.put(BAK, fileText({ revision: 99, vmGeneration: 20, stamp: 'backup stamp' }, payload('backup')))
  const loaded = io.load(APP, stamp)
  assert.equal(loaded.kind, 'READY')
  assert.equal(loaded.source, 'MAIN')
  assert.equal(loaded.recovered, false)
  assert.equal(loaded.stamp, STAMP)
  assert.equal(loaded.header.revision, 7)
  assert.equal(loaded.matchingStamp, stamp === STAMP)
  assert.equal(loaded.encodedState, stamp === STAMP ? SMALL : undefined)
  assert.equal(active.text(MAIN), main)
  assert(!active.trace.some(event => event.op === 'open' && event.path === BAK))
  noWrites()
})

for (const absent of [false, true]) test('recovery / Format2 backup restores ' + (absent ? 'absent' : 'corrupt') + ' main with provenance', io => {
  if (!absent) active.put(MAIN, '{corrupt')
  const backup = fileText({ revision: 21, vmGeneration: 8 })
  active.put(BAK, backup)
  const loaded = io.load(APP, STAMP)
  assert.equal(loaded.kind, 'READY')
  assert.equal(loaded.source, 'BAK')
  assert.equal(loaded.recovered, true)
  assert.equal(loaded.header.revision, 21)
  assert.equal(loaded.header.vmGeneration, 8)
  assert.equal(loaded.encodedState, SMALL)
  assert.equal(active.text(MAIN), backup)
  assert.equal(active.text(BAK), backup)
  assert.equal(io.load(APP, STAMP).source, 'MAIN')
  noTemps()
})

for (const validMain of [true, false]) test('legacy / ' + (validMain ? 'main ignores backup' : 'backup never recovers main'), io => {
  const legacy = JSON.stringify({ stamp: STAMP, value: JSON.parse(SMALL) })
  if (validMain) {
    active.put(MAIN, legacy)
    active.put(BAK, fileText({ revision: 100 }))
  } else active.put(BAK, legacy)
  const loaded = io.load(APP, STAMP)
  assert.equal(loaded.kind, validMain ? 'READY' : 'LOST')
  if (validMain) {
    assert.equal(loaded.format, 'LEGACY')
    assert.equal(loaded.header, undefined)
    assert.equal(loaded.encodedState, SMALL)
    assert(!active.trace.some(event => event.op === 'open' && event.path === BAK))
  } else assert(!active.nodes.has(MAIN))
  noWrites()
})

for (const variant of ['matching', 'mismatch', 'corrupt', 'absent', 'missing project', 'permission']) test('readonly / ' + variant + ' no recovery lock cleanup or writes', io => {
  if (variant === 'matching' || variant === 'mismatch') seed()
  if (variant === 'corrupt') active.put(MAIN, '{')
  if (variant === 'missing project') active.nodes.delete(DIR)
  if (variant !== 'missing project') {
    active.put(BAK, fileText({ revision: 88 }))
    active.put(MAIN + '.' + crypto.randomUUID() + '.tmp', fileText(), 'file', 120000)
  }
  if (variant === 'permission') active.fail('open', event => event.path === MAIN, 13900012)
  const before = active.text(MAIN)
  const loaded = io.readCommittedReadOnly(APP, variant === 'mismatch' ? 'different' : STAMP)
  const expected = { matching: 'READY', mismatch: 'READY', corrupt: 'LOST', absent: 'ABSENT', 'missing project': 'ABSENT', permission: 'UNAVAILABLE' }
  assert.equal(loaded.kind, expected[variant])
  if (variant === 'mismatch') {
    assert.equal(loaded.encodedState, undefined)
    assert.equal(loaded.matchingStamp, false)
    assert.equal(loaded.stamp, STAMP)
    assert.equal(loaded.header.revision, 7)
    assert.equal(loaded.header.vmGeneration, 3)
    assert.equal(loaded.source, 'MAIN')
    assert.equal(loaded.format, 'FORMAT2')
  }
  if (variant === 'matching') assert.equal(loaded.encodedState, SMALL)
  assert.equal(active.text(MAIN), before)
  assert(!active.trace.some(event => event.path === BAK))
  readOnlyTrace()
})

test('header / bounded 1024 byte prefix without hashing full payload', io => {
  const value = payload('x'.repeat(140000))
  seed({}, value)
  cryptoCalls = []
  const header = io.readHeader(APP)
  assert.equal(header.revision, 7)
  assert.equal(header.payloadLength, Buffer.byteLength(value))
  const reads = active.trace.filter(event => event.op === 'read')
  assert.deepEqual(reads.map(event => [event.offset, event.length]), [[0, 1024]])
  assert.deepEqual(cryptoCalls, [])
  readOnlyTrace()
})

for (const variant of ['large stamp', 'split utf8']) test('header / full fallback ' + variant + ' same fd old inode across rename', io => {
  const stamp = variant === 'large stamp' ? 'long状态'.repeat(700) : STAMP
  let text = fileText({ stamp }, LARGE)
  if (variant === 'split utf8') {
    const offset = Buffer.byteLength(text.slice(0, text.indexOf('状态🧪é')))
    const pad = (1023 - offset % 1024 + 1024) % 1024
    text = fileText({ stamp }, payload('x'.repeat(pad) + '状态🧪é'.repeat(14000)))
    assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes(text).subarray(0, 1024)))
  }
  const oldNode = active.put(MAIN, text)
  const replacement = MAIN + '.replacement'
  active.put(replacement, fileText({ revision: 44, vmGeneration: 9 }))
  active.once(event => event.op === 'read' && event.path === MAIN && event.offset === 0, () => { active.renameSync(replacement, MAIN) })
  const header = io.readHeader(APP)
  assert.equal(header.revision, 7)
  assert.equal(header.vmGeneration, 3)
  assert.equal(decode().revision, 44)
  const reads = active.trace.filter(event => event.op === 'read')
  assert(reads.length >= 3)
  assert.equal(reads[0].length, 1024)
  assert.equal(reads[1].offset, 0)
  assert(reads.every(event => event.fd === reads[0].fd && event.inode === oldNode.id))
  assert.equal(active.trace.filter(event => event.op === 'open' && event.path === MAIN).length, 1)
  assert.equal(active.trace.filter(event => event.op === 'rename').length, 1)
})

for (const [name, setup, expectation] of [
  ['absent', () => {}, null],
  ['legacy', () => active.put(MAIN, JSON.stringify({ stamp: STAMP, value: JSON.parse(SMALL) })), null],
  ['wrong identity', () => active.put(MAIN, fileText({ appId: 'other/app' })), 'STATE_CORRUPTED'],
  ['wrong schema', () => active.put(MAIN, fileText({ schemaVersion: 2 })), 'STATE_CORRUPTED'],
  ['corrupt', () => active.put(MAIN, '{'), 'STATE_CORRUPTED']
]) test('header / ' + name, io => {
  setup()
  if (typeof expectation === 'string') assert.throws(() => io.readHeader(APP), error => error.code === expectation)
  else assert.equal(io.readHeader(APP), expectation)
  readOnlyTrace()
})

test('header / partial prefix reads remain bounded and use one descriptor', io => {
  seed({}, payload('x'.repeat(140000)))
  active.maxRead = 137
  cryptoCalls = []
  assert.equal(io.readHeader(APP).revision, 7)
  const reads = active.trace.filter(event => event.op === 'read')
  assert.equal(reads.reduce((sum, event) => sum + event.count, 0), 1024)
  assert(reads.every(event => event.fd === reads[0].fd && event.length <= 1024))
  assert.deepEqual(cryptoCalls, [])
  readOnlyTrace()
})

for (const variant of ['absent main', 'corrupt main', 'mismatched stamp']) test('recovery / ' + variant + ' preserves backup metadata', io => {
  if (variant === 'corrupt main' || variant === 'mismatched stamp') active.put(MAIN, '{')
  const backup = fileText({ revision: 30, vmGeneration: 11 })
  active.put(BAK, backup)
  const loaded = io.load(APP, variant === 'mismatched stamp' ? 'other' : STAMP)
  assert.equal(loaded.kind, 'READY')
  assert.equal(loaded.source, 'BAK')
  assert.equal(loaded.recovered, true)
  assert.equal(loaded.header.revision, 30)
  assert.equal(loaded.header.vmGeneration, 11)
  assert.equal(loaded.stamp, STAMP)
  assert.equal(loaded.encodedState, variant === 'mismatched stamp' ? undefined : SMALL)
  assert.equal(active.text(MAIN), backup)
  noTemps()
})

test('publication / literal payload revision stamp preserved generation increased and old writer fenced', io => {
  const literal = '["o","State",[["z",["s","\\u72b6\\u6001"]],["a",["n",1e0]]]]'
  seed({}, literal)
  assert.equal(io.publishGeneration(publication()).status, 'COMMITTED')
  const current = decode()
  assert.equal(current.encodedState, literal)
  assert.equal(current.stamp, STAMP)
  assert.equal(current.revision, 7)
  assert.equal(current.vmGeneration, 4)
  active.trace = []
  const before = active.text(MAIN)
  assert.equal(io.commit(request()).status, 'FENCED_COMMIT')
  assert.equal(active.text(MAIN), before)
  noWrites()
  noTemps()
})

test('publication / legacy conversion preserves tagged insertion order and stamp', io => {
  active.put(MAIN, JSON.stringify({ stamp: STAMP, value: JSON.parse(SMALL) }))
  assert.deepEqual(io.publishGeneration(publication({ expectedSource: 'LEGACY', expectedRevision: 0, nextVmGeneration: 1 })), { status: 'COMMITTED', revision: 0, backup: 'SKIPPED' })
  assert.equal(decode().format, 'FORMAT2')
  assert.equal(decode().encodedState, SMALL)
  assert.equal(decode().stamp, STAMP)
  assert.equal(decode().vmGeneration, 1)
})

test('publication / ABSENT does not create a state file', io => {
  assert.deepEqual(io.publishGeneration(publication({ expectedSource: 'ABSENT', expectedRevision: 0, expectedStamp: '', nextVmGeneration: 1 })), { status: 'COMMITTED', revision: 0, backup: 'SKIPPED' })
  assert(!active.nodes.has(MAIN))
  assert(!active.nodes.has(BAK))
  noWrites()
})

for (const [name, overrides] of [
  ['source legacy', { expectedSource: 'LEGACY' }],
  ['source absent', { expectedSource: 'ABSENT', expectedRevision: 0, nextVmGeneration: 1 }],
  ['source backup missing', { expectedSource: 'BAK' }],
  ['revision', { expectedRevision: 6 }],
  ['stamp', { expectedStamp: 'different' }],
  ['same generation', { nextVmGeneration: 3 }],
  ['older generation', { nextVmGeneration: 2 }]
]) test('publication / mismatch ' + name + ' does not write', io => {
  const old = seed()
  assert.equal(io.publishGeneration(publication(overrides)).status, 'STALE_REVISION')
  assert.equal(active.text(MAIN), old)
  noWrites()
})

for (const mismatch of [false, true]) test('publication / BAK after load restore ' + (mismatch ? 'rejects changed backup' : 'succeeds'), io => {
  active.put(MAIN, '{')
  const backup = fileText()
  active.put(BAK, backup)
  assert.equal(io.load(APP, STAMP).source, 'BAK')
  if (mismatch) active.put(BAK, fileText({ revision: 8 }))
  active.trace = []
  assert.equal(io.publishGeneration(publication({ expectedSource: 'BAK' })).status, mismatch ? 'STALE_REVISION' : 'COMMITTED')
  assert.equal(active.text(BAK), mismatch ? fileText({ revision: 8 }) : backup)
  if (mismatch) {
    assert.equal(active.text(MAIN), backup)
    noWrites()
  } else {
    assert.equal(decode().vmGeneration, 4)
    assert.equal(decode().revision, 7)
  }
  noTemps()
})

const faults = [
  ['open', 'open', undefined],
  ['write error', 'write', undefined],
  ['write zero', 'write', 0],
  ['write negative', 'write', -1],
  ['write over-count', 'write', 65537],
  ['write fractional', 'write', 0.5],
  ['fsync', 'fsync', undefined],
  ['close', 'close', undefined],
  ['rename', 'rename', undefined]
]
for (const [name, op, count] of faults) test('fault / main temp ' + name + ' FAILED preserves old main', io => {
  const old = seed()
  active.once(event => event.op === op && isMainTemp(event), () => {
    if (count !== undefined) return count
    throw nativeError()
  })
  const result = io.commit(request())
  assert.equal(result.status, 'FAILED')
  assert.equal(result.stage, 'commit-main-' + (op === 'rename' ? 'rename' : 'temp-' + (op === 'write' ? 'write' : op)))
  assert.equal(active.text(MAIN), old)
  assert(!active.nodes.has(BAK))
  noTemps()
})

test('fault / exclusive temp collision never truncates or deletes another owner file', io => {
  const old = seed()
  let collision
  active.once(event => event.op === 'open' && isMainTemp(event), event => {
    collision = event.path
    active.put(collision, 'foreign temp inode')
  })
  assert.equal(io.commit(request()).status, 'FAILED')
  assert.equal(active.text(MAIN), old)
  assert.equal(active.text(collision), 'foreign temp inode')
  assert(!active.trace.some(event => event.op === 'unlink'))
})

for (const [name, op, count] of faults) test('fault / recovery temp ' + name + ' UNAVAILABLE preserves corrupt main and valid backup', io => {
  active.put(MAIN, '{')
  const backup = fileText()
  active.put(BAK, backup)
  active.once(event => event.op === op && isMainTemp(event), () => {
    if (count !== undefined) return count
    throw nativeError()
  })
  const result = io.load(APP, STAMP)
  assert.equal(result.kind, 'UNAVAILABLE')
  assert.equal(active.text(MAIN), '{')
  assert.equal(active.text(BAK), backup)
  noTemps()
})

test('fault / short writes then error cleans partially written temp', io => {
  const old = seed()
  active.maxWrite = 19
  active.fail('write', event => isMainTemp(event) && event.offset >= 38)
  assert.equal(io.commit(request()).status, 'FAILED')
  assert.equal(active.text(MAIN), old)
  assert(active.trace.filter(event => event.op === 'write').length >= 3)
  noTemps()
})

test('fault / directory fsync after main rename COMMIT_UNCERTAIN new main visible', io => {
  seed()
  active.fail('fsync', event => event.path === DIR)
  const result = io.commit(request({ backupDue: true }))
  assert.deepEqual(result, { status: 'COMMIT_UNCERTAIN', code: 'STATE_COMMIT_UNCERTAIN', stage: 'commit-main-dir-fsync' })
  assert.equal(decode().revision, 8)
  assert(!active.nodes.has(BAK))
  noTemps()
})

for (const [name, op, count] of faults) test('fault / backup temp ' + name + ' COMMITTED backup FAILED', io => {
  seed()
  const backup = fileText({ revision: 5 })
  active.put(BAK, backup)
  active.once(event => event.op === op && isBakTemp(event), () => {
    if (count !== undefined) return count
    throw nativeError()
  })
  assert.deepEqual(io.commit(request({ backupDue: true })), { status: 'COMMITTED', revision: 8, backup: 'FAILED' })
  assert.equal(decode().revision, 8)
  assert.equal(active.text(BAK), backup)
  noTemps()
})

test('fault / backup directory fsync failure still COMMITTED backup FAILED', io => {
  seed()
  active.once(event => event.op === 'rename' && event.to === BAK, () => {
    active.fail('fsync', event => event.path === DIR)
  })
  assert.deepEqual(io.commit(request({ backupDue: true })), { status: 'COMMITTED', revision: 8, backup: 'FAILED' })
  assert.equal(active.text(MAIN), active.text(BAK))
  noTemps()
})

for (const operation of ['commit', 'publishGeneration']) {
  for (const directory of ['new', 'existing']) test('durability / ' + operation + ' retries failed parent fsync with ' + directory + ' project directory', io => {
    let old
    let backup
    if (directory === 'new') active.nodes.delete(DIR)
    else {
      old = seed()
      backup = fileText({ revision: 6 })
      active.put(BAK, backup)
    }
    const run = () => operation === 'commit'
      ? io.commit(request(directory === 'new' ? { pre: { appId: APP, vmGeneration: 1, baseRevision: 0 } } : {}))
      : io.publishGeneration(publication(directory === 'new' ? { expectedSource: 'ABSENT', expectedRevision: 0, expectedStamp: '', nextVmGeneration: 1 } : {}))
    active.fail('fsync', event => event.path === ROOT)
    assert.deepEqual(run(), { status: 'FAILED', code: 'STATE_SYNC_FAILED', stage: 'project-dir-sync' })
    assert(active.nodes.has(DIR))
    const projectInode = active.nodes.get(DIR)
    const mkdirIndex = active.trace.findIndex(event => event.op === 'mkdir')
    const failedSyncIndex = active.trace.findIndex(event => event.op === 'fsync' && event.path === ROOT)
    if (directory === 'new') assert(mkdirIndex >= 0 && mkdirIndex < failedSyncIndex)
    else assert.equal(mkdirIndex, -1)
    assert.equal(active.text(MAIN), old)
    assert.equal(active.text(BAK), backup)
    assert(!active.trace.some(event => ['tryLock', 'write', 'rename'].includes(event.op) || (event.op === 'open' && (isTemp(event) || event.path === LOCK))))
    assert.equal(active.fds.size, 0)
    noTemps()
    active.trace = []
    assert.equal(run().status, 'COMMITTED')
    assert.equal(active.nodes.get(DIR), projectInode)
    assert(!active.trace.some(event => event.op === 'mkdir'))
    const projectOpenIndex = active.trace.findIndex(event => event.op === 'open' && event.path === DIR)
    const rootSyncIndex = active.trace.findIndex(event => event.op === 'fsync' && event.path === ROOT)
    const lockIndex = active.trace.findIndex(event => event.op === 'open' && event.path === LOCK)
    assert(projectOpenIndex >= 0 && rootSyncIndex > projectOpenIndex && lockIndex > rootSyncIndex)
    assert.equal(active.trace.filter(event => event.op === 'fsync' && event.path === ROOT).length, 1)
    assert(active.trace.filter(event => ['write', 'rename'].includes(event.op) || (event.op === 'open' && isTemp(event))).every(event => active.trace.indexOf(event) > rootSyncIndex))
    if (operation === 'commit') assert.equal(decode().revision, directory === 'new' ? 1 : 8)
    else if (directory === 'existing') assert.equal(decode().vmGeneration, 4)
    else assert(!active.nodes.has(MAIN))
    assert.equal(active.text(BAK), backup)
    noTemps()
  })
}

test('durability / explicitly unsupported directory fsync reduced path', () => {
  seed()
  const io = new StateIo(ROOT, { directoryFsync: 'UNSUPPORTED', lockTimeoutMs: 0, tmpOrphanAgeMs: 60000 })
  assert.deepEqual(io.commit(request({ backupDue: true })), { status: 'COMMITTED', revision: 8, backup: 'WRITTEN' })
  const syncs = active.trace.filter(event => event.op === 'fsync')
  assert.equal(syncs.length, 2)
  assert(syncs.every(event => event.kind === 'file' && isTemp(event)))
  noTemps()
})

test('durability / REQUIRED does not silently reduce on unsupported dirsync', io => {
  seed()
  active.fail('fsync', event => event.path === DIR, 13900004)
  assert.equal(io.commit(request()).status, 'COMMIT_UNCERTAIN')
  assert.equal(decode().revision, 8)
  noTemps()
})

for (const mode of ['valid main', 'corrupt main', 'absent main', 'busy valid main']) test('orphans / ' + mode + ' only old own UUID main and backup temps after valid main', io => {
  if (mode.includes('valid main')) seed()
  if (mode === 'corrupt main') active.put(MAIN, '{')
  const own = [MAIN + '.' + crypto.randomUUID() + '.tmp', BAK + '.' + crypto.randomUUID() + '.tmp']
  for (const file of own) active.put(file, fileText({ revision: 100 }), 'file', 120000)
  const retained = [
    [MAIN + '.' + crypto.randomUUID() + '.tmp', 'file', 0],
    [BAK + '.' + crypto.randomUUID() + '.tmp', 'file', 1000],
    [MAIN + '.not-a-uuid.tmp', 'file', 120000],
    [DIR + '/other.state.json.' + crypto.randomUUID() + '.tmp', 'file', 120000],
    [MAIN + '.' + crypto.randomUUID() + '.tmp.extra', 'file', 120000],
    [MAIN + '.' + crypto.randomUUID() + '.tmp', 'symlink', 120000],
    [BAK + '.' + crypto.randomUUID() + '.tmp', 'dir', 120000]
  ]
  for (const [file, kind, age] of retained) active.put(file, 'unrelated', kind, age)
  let held
  if (mode === 'busy valid main') {
    held = filesystem.openSync(LOCK, modes.CREATE | modes.READ_WRITE)
    held.tryLock(true)
  }
  try {
    const loaded = io.load(APP, STAMP)
    assert.equal(loaded.kind, mode.includes('valid main') ? 'READY' : mode === 'corrupt main' ? 'LOST' : 'ABSENT')
    for (const file of own) assert.equal(active.nodes.has(file), mode !== 'valid main')
    for (const [file] of retained) assert(active.nodes.has(file))
    if (!mode.includes('valid main')) {
      assert.equal(active.text(MAIN), mode === 'corrupt main' ? '{' : undefined)
      assert(!active.trace.some(event => event.op === 'rename'))
    }
  } finally {
    if (held) { held.unlock(); filesystem.closeSync(held) }
  }
})

test('recovery / lock busy is UNAVAILABLE not LOST and never restores', io => {
  active.put(MAIN, '{')
  active.put(BAK, fileText())
  const held = filesystem.openSync(LOCK, modes.CREATE | modes.READ_WRITE)
  held.tryLock(true)
  try {
    const result = io.load(APP, STAMP)
    assert.equal(result.kind, 'UNAVAILABLE')
    assert.equal(result.code, 'STATE_LOCK_UNAVAILABLE')
    assert.equal(result.stage, 'recovery-lock')
    assert.equal(active.text(MAIN), '{')
    noWrites()
  } finally { held.unlock(); filesystem.closeSync(held) }
})

for (const stage of ['create', 'update1', 'update2', 'digest']) test('crypto / core preserves original ' + stage + ' operational error', () => {
  const text = fileText()
  const error = nativeError('CRYPTO_OPERATION_FAILED')
  cryptoFailure = { stage, error }
  assert.throws(() => format.validateStateFile(text, APP), issue => issue === error)
  assert.equal(active.trace.length, 0)
})

for (const stage of ['create', 'update1', 'update2', 'digest']) test('crypto / operational ' + stage + ' failure UNAVAILABLE no backup restoration', io => {
  const old = seed()
  active.put(BAK, fileText({ revision: 6 }))
  cryptoFailure = { stage, error: nativeError('CRYPTO_OPERATION_FAILED') }
  const loaded = io.load(APP, STAMP)
  assert.equal(loaded.kind, 'UNAVAILABLE')
  assert.equal(loaded.code, 'STATE_READ_FAILED')
  assert.equal(loaded.stage, 'load-main')
  assert.equal(loaded.encodedState, undefined)
  assert.equal(active.text(MAIN), old)
  assert(!active.trace.some(event => event.op === 'open' && event.path === BAK))
  noWrites()
})

const quarantines = () => [...active.nodes.keys()].filter(file => file.endsWith('.quarantine'))
const lostSeed = () => { active.put(MAIN, '{main'); active.put(BAK, '{backup'); return active.put(LOCK, 'stable lock') }

for (const variant of ['both corrupt', 'main only', 'backup only', 'invalid utf8', 'absent']) test('lost reset / durable quarantine ' + variant, io => {
  const lock = active.put(LOCK, 'stable lock')
  const originals = new Map()
  if (variant === 'both corrupt' || variant === 'main only') originals.set(MAIN, active.put(MAIN, '{main'))
  if (variant === 'both corrupt' || variant === 'backup only') originals.set(BAK, active.put(BAK, '{backup'))
  if (variant === 'invalid utf8') originals.set(MAIN, active.put(MAIN, Buffer.from([0xff, 0xfe])))
  const foreign = MAIN + '.foreign.quarantine'
  const foreignNode = active.put(foreign, 'older evidence')
  const temp = MAIN + '.' + crypto.randomUUID() + '.tmp'
  const tempNode = active.put(temp, 'orphan evidence', 'file', 120000)
  assert.deepEqual(io.recoverLost(APP, STAMP), { kind: 'ABSENT' })
  assert(!active.nodes.has(MAIN))
  assert(!active.nodes.has(BAK))
  assert.equal(active.nodes.get(LOCK), lock)
  assert.equal(active.text(LOCK), 'stable lock')
  assert.equal(active.nodes.get(foreign), foreignNode)
  assert.equal(active.nodes.get(temp), tempNode)
  for (const [original, node] of originals) {
    const names = quarantines().filter(file => file.startsWith(original + '.') && active.nodes.get(file) === node)
    assert.equal(names.length, 1)
    assert(/\.[0-9a-f-]{36}\.quarantine$/.test(names[0]))
  }
  const locked = active.trace.findIndex(event => event.op === 'locked')
  const unlocked = active.trace.findIndex(event => event.op === 'unlock')
  const renames = active.trace.filter(event => event.op === 'rename')
  assert.equal(renames.length, originals.size)
  for (const event of renames) {
    const index = active.trace.indexOf(event)
    assert(index > locked && index < unlocked)
    assert(active.trace.slice(locked + 1, index).some(item => item.op === 'read' && item.path === event.path))
    assert(active.trace.slice(index + 1, unlocked).some(item => item.op === 'fsync' && item.path === DIR))
    const reservation = active.trace.find(item => item.op === 'open' && item.path === event.to)
    assert(reservation.legacy && (reservation.flags & EXCL) && (reservation.flags & modes.NOFOLLOW))
    assert.equal(reservation.mode, 0o600)
  }
  assert(!active.trace.some(event => event.op === 'unlink' || event.op === 'write'))
  assert.deepEqual(io.recoverLost(APP, STAMP), { kind: 'ABSENT' })
  assert.equal(active.nodes.get(LOCK), lock)
  assert.equal(quarantines().length, originals.size + 1)
  assert.equal(io.commit(request({ pre: { appId: APP, vmGeneration: 1, baseRevision: 0 } })).status, 'COMMITTED')
  assert.equal(active.nodes.get(LOCK), lock)
  assert.equal(quarantines().length, originals.size + 1)
})

for (const legacy of [false, true]) for (const matching of [false, true]) test('lost reset / restored main wins under lock legacy=' + legacy + ' matching=' + matching, io => {
  const lock = lostSeed()
  assert.equal(io.load(APP, STAMP).kind, 'LOST')
  const text = legacy ? JSON.stringify({ stamp: STAMP, value: JSON.parse(LARGE) }) : fileText({}, LARGE)
  let restored
  active.trace = []
  active.once(event => event.op === 'locked', () => { restored = active.put(MAIN, text) })
  const result = io.recoverLost(APP, matching ? STAMP : 'other')
  assert.equal(result.kind, 'READY')
  assert.equal(result.source, 'MAIN')
  assert.equal(result.format, legacy ? 'LEGACY' : 'FORMAT2')
  assert.equal(result.matchingStamp, matching)
  assert.equal(result.encodedState, matching ? LARGE : undefined)
  assert.equal(active.nodes.get(MAIN), restored)
  assert.equal(active.text(BAK), '{backup')
  assert.equal(active.nodes.get(LOCK), lock)
  assert(active.trace.filter(event => event.op === 'read').reduce((sum, event) => sum + event.count, 0) >= Buffer.byteLength(text))
  assert(!active.trace.some(event => event.path === BAK))
  noWrites()
})

for (const matching of [false, true]) test('lost reset / restored valid backup recovered never quarantined matching=' + matching, io => {
  const lock = lostSeed()
  assert.equal(io.load(APP, STAMP).kind, 'LOST')
  const text = fileText({ revision: 44, vmGeneration: 18 }, LARGE)
  let restored
  active.once(event => event.op === 'locked', () => { restored = active.put(BAK, text) })
  const result = io.recoverLost(APP, matching ? STAMP : 'other')
  assert.equal(result.kind, 'READY')
  assert.equal(result.source, 'BAK')
  assert.equal(result.recovered, true)
  assert.equal(result.header.revision, 44)
  assert.equal(result.header.vmGeneration, 18)
  assert.equal(result.matchingStamp, matching)
  assert.equal(result.encodedState, matching ? LARGE : undefined)
  assert.equal(active.text(MAIN), text)
  assert.equal(active.nodes.get(BAK), restored)
  assert.equal(active.nodes.get(LOCK), lock)
  assert.deepEqual(quarantines(), [])
  noTemps()
})

for (const target of [MAIN, BAK]) for (const op of ['open', 'read', 'stat']) {
  for (const code of [13900005, 13900001, 13900012]) test('lost reset / operational ' + path.basename(target) + ' ' + op + ' ' + code, io => {
    const lock = lostSeed()
    const before = new Map(active.nodes)
    active.fail(op, event => event.path === target, code)
    const result = io.recoverLost(APP, STAMP)
    assert.equal(result.kind, 'UNAVAILABLE')
    assert.equal(result.code, code === 13900005 ? 'STATE_READ_FAILED' : 'STATE_UNAVAILABLE')
    for (const [file, node] of before) assert.equal(active.nodes.get(file), node)
    assert.equal(active.nodes.get(LOCK), lock)
    assert.deepEqual(quarantines(), [])
    noWrites()
  })
}

for (const target of [MAIN, BAK]) for (const stage of ['create', 'update1', 'update2', 'digest']) test('lost reset / hash operational failure ' + path.basename(target) + ' ' + stage, io => {
  lostSeed()
  const node = active.put(target, fileText())
  cryptoFailure = { stage, error: nativeError('CRYPTO_OPERATION_FAILED') }
  const result = io.recoverLost(APP, STAMP)
  assert.equal(result.kind, 'UNAVAILABLE')
  assert.equal(result.code, 'STATE_READ_FAILED')
  assert.equal(active.nodes.get(target), node)
  assert.deepEqual(quarantines(), [])
  noWrites()
})

for (const target of [MAIN, BAK]) for (const kind of ['dir', 'symlink']) test('lost reset / nonregular corrupt target refused ' + path.basename(target) + ' ' + kind, io => {
  lostSeed()
  active.put(target, '', kind)
  assert.equal(io.recoverLost(APP, STAMP).kind, 'UNAVAILABLE')
  assert.deepEqual(quarantines(), [])
  noWrites()
})

for (const target of [MAIN, BAK]) for (const [name, damage] of [
  ['hash', text => text.replace('hello', 'jello')],
  ['length', text => text.replace(/"payloadLength":\d+/, '"payloadLength":1')],
  ['identity', () => fileText({ appId: 'other/app' })],
  ['schema', () => fileText({ schemaVersion: 2 })],
  ['stamp', text => text.replace('fixture:状态', 'altered:状态')],
  ['trailing garbage', text => text + 'garbage']
]) test('lost reset / full validation quarantines ' + name + ' ' + path.basename(target), io => {
  lostSeed()
  const evidence = active.put(target, damage(fileText()))
  assert.deepEqual(io.recoverLost(APP, STAMP), { kind: 'ABSENT' })
  assert.equal(quarantines().filter(file => active.nodes.get(file) === evidence).length, 1)
  assert(!active.nodes.has(MAIN))
  assert(!active.nodes.has(BAK))
})

for (const target of [MAIN, BAK]) test('lost reset / quarantine stat failure preserves all evidence ' + path.basename(target), io => {
  lostSeed()
  const before = new Map(active.nodes)
  let stats = 0
  active.always(event => event.op === 'stat' && event.path === target, event => {
    if (event.fd === undefined) { stats++; throw nativeError(13900001) }
  })
  const result = io.recoverLost(APP, STAMP)
  assert.equal(result.kind, 'UNAVAILABLE')
  assert.equal(result.code, 'STATE_UNAVAILABLE')
  assert.equal(stats, 1)
  for (const [file, node] of before) assert.equal(active.nodes.get(file), node)
  noWrites()
})

for (const kind of ['dir', 'symlink']) test('lost reset / nonregular stable lock refused ' + kind, io => {
  lostSeed()
  const lock = active.put(LOCK, '', kind)
  assert.equal(io.recoverLost(APP, STAMP).kind, 'UNAVAILABLE')
  assert.equal(active.nodes.get(LOCK), lock)
  assert(!active.trace.some(event => event.op === 'read'))
  noWrites()
})

for (const mode of ['invalid uuid', 'uuid failure', 'reservation open', 'reservation close']) test('lost reset / pre-rename failure preserves corrupt sources ' + mode, io => {
  lostSeed()
  const main = active.nodes.get(MAIN)
  const backup = active.nodes.get(BAK)
  const originalUuid = util.generateRandomUUID
  if (mode === 'invalid uuid') util.generateRandomUUID = () => '../unsafe'
  if (mode === 'uuid failure') util.generateRandomUUID = () => { throw nativeError() }
  if (mode === 'reservation open') active.fail('open', event => event.path.endsWith('.quarantine'))
  if (mode === 'reservation close') active.fail('close', event => event.path.endsWith('.quarantine'))
  try {
    const result = io.recoverLost(APP, STAMP)
    assert.equal(result.kind, 'UNAVAILABLE')
    assert.notEqual(result.code, 'STATE_COMMIT_UNCERTAIN')
    assert.equal(active.nodes.get(MAIN), main)
    assert.equal(active.nodes.get(BAK), backup)
    assert(!active.trace.some(event => ['rename', 'unlink', 'write'].includes(event.op)))
  } finally { util.generateRandomUUID = originalUuid }
})

for (const stage of ['main read', 'backup read', 'main rename', 'backup rename', 'final sync']) test('lost reset / stable lock excludes competing writer during ' + stage, io => {
  const lock = lostSeed()
  const peer = new StateIo(ROOT, { directoryFsync: 'REQUIRED', lockTimeoutMs: 0 })
  const op = stage.endsWith('read') ? 'read' : stage.endsWith('rename') ? 'rename' : 'fsync'
  const target = stage.startsWith('main') ? MAIN : stage.startsWith('backup') ? BAK : DIR
  let syncs = 0
  active.once(event => event.op === op && event.path === target && (stage !== 'final sync' || ++syncs === 2), () => {
    assert.equal(lock.owner === null, false)
    assert.deepEqual(peer.commit(request({ pre: { appId: APP, vmGeneration: 1, baseRevision: 0 } })), { status: 'STALE' })
  })
  assert.deepEqual(io.recoverLost(APP, STAMP), { kind: 'ABSENT' })
  assert.equal(active.nodes.get(LOCK), lock)
  assert.equal(lock.owner, null)
  assert.equal(quarantines().length, 2)
})

test('lost reset / valid legacy backup remains LOST and untouched', io => {
  lostSeed()
  const backup = active.put(BAK, JSON.stringify({ stamp: STAMP, value: JSON.parse(SMALL) }))
  assert.deepEqual(io.recoverLost(APP, STAMP), { kind: 'LOST', code: 'STATE_CORRUPTED', stage: 'lost-backup-format' })
  assert.equal(active.nodes.get(BAK), backup)
  assert.equal(active.text(MAIN), '{main')
  noWrites()
})

test('lost reset / busy stable lock timeout no reads or mutation', io => {
  const lock = lostSeed()
  const held = filesystem.openSync(LOCK, modes.READ_WRITE)
  held.tryLock(true)
  active.trace = []
  try {
    assert.deepEqual(io.recoverLost(APP, STAMP), { kind: 'UNAVAILABLE', code: 'STATE_LOCK_UNAVAILABLE', stage: 'lost-lock' })
    assert.equal(active.nodes.get(LOCK), lock)
    assert(!active.trace.some(event => event.op === 'read'))
    noWrites()
  } finally { held.unlock(); filesystem.closeSync(held) }
})

for (const mode of ['root', 'project', 'missing project', 'lock', 'preflight', 'unsupported', 'invalid stamp', 'invalid identity']) test('lost reset / precondition refusal ' + mode, io => {
  const lock = lostSeed()
  if (mode === 'root') active.fail('open', event => event.path === ROOT, 13900012)
  if (mode === 'project') active.fail('open', event => event.path === DIR, 13900001)
  if (mode === 'missing project') active.nodes.delete(DIR)
  if (mode === 'lock') active.fail('open', event => event.path === LOCK)
  if (mode === 'preflight') active.fail('fsync', event => event.path === DIR)
  if (mode === 'unsupported') io = new StateIo(ROOT, { directoryFsync: 'UNSUPPORTED' })
  const result = io.recoverLost(mode === 'invalid identity' ? '../app' : APP, mode === 'invalid stamp' ? 'bad\0stamp' : STAMP)
  assert.equal(result.kind, 'UNAVAILABLE')
  assert.notEqual(result.code, 'STATE_COMMIT_UNCERTAIN')
  assert.equal(active.nodes.get(LOCK), lock)
  assert.equal(active.text(MAIN), '{main')
  assert.equal(active.text(BAK), '{backup')
  noWrites()
})

test('lost reset / exclusive quarantine collision preserves foreign evidence and corrupt sources', io => {
  lostSeed()
  let collision
  active.once(event => event.op === 'open' && event.path.endsWith('.quarantine'), event => {
    collision = event.path
    active.put(collision, 'foreign evidence')
  })
  assert.equal(io.recoverLost(APP, STAMP).kind, 'UNAVAILABLE')
  assert.equal(active.text(collision), 'foreign evidence')
  assert.equal(active.text(MAIN), '{main')
  assert.equal(active.text(BAK), '{backup')
  assert(!active.trace.some(event => ['rename', 'unlink', 'write'].includes(event.op)))
})

for (const mode of ['first rename', 'rename then throw', 'second rename', 'second reservation', 'final sync', 'unlock', 'close']) test('lost reset / partial or unconfirmed mutation ' + mode + ' is uncertain', io => {
  const lock = lostSeed()
  if (mode === 'first rename') active.fail('rename', event => event.path === MAIN)
  if (mode === 'rename then throw') active.once(event => event.op === 'rename', event => {
    active.nodes.set(event.to, active.nodes.get(event.path))
    active.nodes.delete(event.path)
    throw nativeError()
  })
  if (mode === 'second rename') active.fail('rename', event => event.path === BAK)
  if (mode === 'second reservation') active.fail('open', event => event.path.startsWith(BAK + '.') && event.path.endsWith('.quarantine'))
  if (mode === 'final sync') active.once(event => event.op === 'rename', () => { active.fail('fsync', event => event.path === DIR) })
  if (mode === 'unlock') active.fail('unlock', event => event.path === LOCK)
  if (mode === 'close') active.fail('close', event => event.path === LOCK)
  const result = io.recoverLost(APP, STAMP)
  assert.equal(result.kind, 'UNAVAILABLE')
  assert.equal(result.code, 'STATE_COMMIT_UNCERTAIN')
  assert.equal(active.nodes.get(LOCK), lock)
  for (const value of ['{main', '{backup']) assert([...active.nodes.values()].some(node => node.data.toString() === value))
  assert(!active.trace.some(event => event.op === 'unlink'))
  if (mode === 'close') for (const fd of [...active.fds.keys()]) filesystem.closeSync(fd)
})

for (const mode of ['rename', 'rename then throw', 'sync']) test('lost reset / valid backup restore unconfirmed ' + mode + ' stays uncertain', io => {
  const lock = lostSeed()
  const backup = active.put(BAK, fileText())
  if (mode === 'rename') active.fail('rename', event => event.to === MAIN)
  if (mode === 'rename then throw') active.once(event => event.op === 'rename' && event.to === MAIN, event => {
    active.nodes.set(event.to, active.nodes.get(event.path))
    active.nodes.delete(event.path)
    throw nativeError()
  })
  if (mode === 'sync') active.fail('fsync', event => event.path === DIR)
  assert.equal(io.recoverLost(APP, STAMP).code, 'STATE_COMMIT_UNCERTAIN')
  assert.equal(active.nodes.get(BAK), backup)
  assert.equal(active.nodes.get(LOCK), lock)
  assert.deepEqual(quarantines(), [])
  noTemps()
})

const storagePassed = passed
const { StateIoTaskPool } = load(path.join(root, 'StateIoTaskPool.ets'))
const OPTIONS = { directoryFsync: 'REQUIRED', lockTimeoutMs: 0, tmpOrphanAgeMs: 60000 }
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const pool = (limit = 1048576, options = OPTIONS) => new StateIoTaskPool(ROOT, options, limit)
const failureIs = (result, code, stage) => {
  assert.equal(result.result.status, 'FAILED')
  assert.equal(result.result.code, code)
  if (stage) assert.equal(result.result.stage, stage)
}
async function asyncTest(name, run) {
  active = new MemoryFs()
  cryptoFailure = null
  cryptoCalls = []
  poolAdapter = new PoolAdapter()
  let error
  try {
    await run()
    assert.equal(active.fds.size, 0)
    assert([...active.nodes.values()].every(node => node.owner === null))
    assert(active.rules.every(rule => rule.remaining === 0 || (rule.remaining === Infinity && rule.hits > 0)))
    assert.equal(cryptoFailure, null)
    assert(!imports.some(name => /VM|Interpreter|Actor/.test(name)))
  } catch (issue) { error = issue }
  poolAdapter = null
  if (error) {
    failures.push({ name, error })
    console.error('FAIL ' + name + '\n' + error.stack)
  } else passed++
}

async function checkTaskPool() {
  await asyncTest('pool / low-level recovery dispatches correlated worker and close waits', async () => {
    const lock = lostSeed()
    const lane = pool()
    poolAdapter.plans.push({ hold: true })
    const resetting = lane.recoverLost(APP, STAMP)
    let closed = false
    const closing = lane.close().then(() => { closed = true })
    await tick()
    assert.equal(poolAdapter.executions.length, 1)
    assert.equal(active.trace.length, 0)
    assert.equal(closed, false)
    const execution = poolAdapter.executions[0]
    assert.equal(execution.args[2].kind, 'recoverLost')
    assert.equal(execution.args[2].appId, APP)
    assert.equal(execution.args[2].expectedStamp, STAMP)
    assert(!('authority' in execution.args[2]))
    poolAdapter.finish()
    assert.deepEqual(await resetting, { kind: 'ABSENT' })
    await closing
    assert(closed)
    assert.equal(active.nodes.get(LOCK), lock)
    assert.equal(quarantines().length, 2)
    assert.equal((await lane.recoverLost(APP, STAMP)).code, 'STATE_UNAVAILABLE')
  })

  for (const variant of ['main', 'mismatched main', 'backup', 'mismatched backup', 'legacy backup', 'operational', 'timeout', 'partial rename', 'sync']) {
    await asyncTest('pool / recovery actual-source result ' + variant, async () => {
      const lock = lostSeed()
      if (variant.includes('backup')) active.put(BAK, variant === 'legacy backup' ? JSON.stringify({ stamp: STAMP, value: JSON.parse(SMALL) }) : fileText())
      else if (variant.includes('main')) seed()
      if (variant === 'operational') active.fail('read', event => event.path === BAK)
      if (variant === 'timeout') active.fail('tryLock', () => true, 13900034)
      if (variant === 'partial rename') active.fail('rename', event => event.path === BAK)
      if (variant === 'sync') active.once(event => event.op === 'rename', () => active.fail('fsync', event => event.path === DIR))
      const lane = pool()
      const result = await lane.recoverLost(APP, variant.startsWith('mismatched') ? 'other' : STAMP)
      if (variant.includes('main') || (variant.includes('backup') && variant !== 'legacy backup')) {
        assert.equal(result.kind, 'READY')
        assert.equal(result.source, variant.includes('main') ? 'MAIN' : 'BAK')
        assert.equal(result.matchingStamp, !variant.startsWith('mismatched'))
        assert.equal(result.encodedState, variant.startsWith('mismatched') ? undefined : SMALL)
        assert.equal(quarantines().length, 0)
      } else if (variant === 'legacy backup') assert.equal(result.kind, 'LOST')
      else assert.equal(result.kind, 'UNAVAILABLE')
      assert.equal(active.nodes.get(LOCK), lock)
      if (variant === 'partial rename' || variant === 'sync') {
        assert.equal(result.code, 'STATE_COMMIT_UNCERTAIN')
        assert.equal((await lane.load(APP, STAMP)).code, 'STATE_UNAVAILABLE')
        await assert.rejects(lane.close(), /STATE_COMMIT_UNCERTAIN/)
      } else await lane.close()
    })
  }

  for (const mode of ['createError', 'transferError', 'submitError', 'rejectBefore', 'rejectAfter', 'rejectLate', 'wrong-id', 'wrong-kind', 'malformed', 'serialization']) {
    await asyncTest('pool / recovery correlated submission ' + mode, async () => {
      lostSeed()
      const lane = pool()
      const plan = ['wrong-id', 'wrong-kind', 'malformed', 'serialization'].includes(mode) ? { reply: reply => {
        if (mode === 'wrong-id') return { ...reply, operationId: 'stale' }
        if (mode === 'wrong-kind') return { ...reply, kind: 'load' }
        if (mode === 'malformed') return { ...reply, load: { kind: 'ABSENT', recovered: true } }
        return { ...reply, unserializable: () => {} }
      } } : { [mode]: true }
      poolAdapter.plans.push(plan)
      const result = await lane.recoverLost(APP, STAMP)
      assert.equal(result.kind, 'UNAVAILABLE')
      if (['createError', 'transferError', 'submitError'].includes(mode)) {
        assert.equal(result.code, 'STATE_TASK_SUBMIT_FAILED')
        await lane.close()
        assert.equal(quarantines().length, 0)
      } else {
        assert.equal(result.code, 'STATE_COMMIT_UNCERTAIN')
        await assert.rejects(lane.close(), /STATE_COMMIT_UNCERTAIN/)
      }
      if (mode === 'rejectLate') poolAdapter.finish()
      assert.equal(poolAdapter.tasks.length, 1)
    })
  }

  for (const [identity, stamp] of [['../app', STAMP], [APP, 'bad\0stamp'], [APP, true], [false, STAMP]]) {
    await asyncTest('pool / recovery rejects invalid metadata ' + JSON.stringify([identity, stamp]), async () => {
      lostSeed()
      const lane = pool()
      assert.deepEqual(await lane.recoverLost(identity, stamp), {
        kind: 'UNAVAILABLE', code: 'STATE_VALIDATION_FAILED', stage: 'lost-request'
      })
      assert.equal(poolAdapter.tasks.length, 0)
      assert.equal(active.trace.length, 0)
      await lane.close()
    })
  }

  await asyncTest('pool / recovery serializes reset publication and first durable commit', async () => {
    const lock = lostSeed()
    const lane = pool()
    poolAdapter.plans.push({ hold: true })
    const resetting = lane.recoverLost(APP, STAMP)
    const publishing = lane.publishGeneration(publication({ expectedSource: 'ABSENT', expectedRevision: 0, nextVmGeneration: 1 }))
    const saving = lane.commit(request({ pre: { appId: APP, vmGeneration: 1, baseRevision: 0 } }))
    const closing = lane.close()
    await tick()
    assert.equal(poolAdapter.executions.length, 1)
    assert.equal(active.trace.length, 0)
    poolAdapter.finish()
    assert.deepEqual(await resetting, { kind: 'ABSENT' })
    assert.equal((await publishing).result.status, 'COMMITTED')
    assert.equal((await saving).result.status, 'COMMITTED')
    await closing
    assert.deepEqual(poolAdapter.executions.map(item => item.args[2].kind), ['recoverLost', 'publishGeneration', 'commit'])
    assert.equal(decode().vmGeneration, 1)
    assert.equal(decode().revision, 1)
    assert.equal(active.nodes.get(LOCK), lock)
    assert.equal(quarantines().length, 2)
  })

  await asyncTest('pool / confirmed recovery refusal permits retry on same lane', async () => {
    lostSeed()
    active.fail('read', event => event.path === MAIN)
    const lane = pool()
    const refused = lane.recoverLost(APP, STAMP)
    const retried = lane.recoverLost(APP, STAMP)
    assert.equal((await refused).code, 'STATE_READ_FAILED')
    assert.deepEqual(await retried, { kind: 'ABSENT' })
    assert.equal(poolAdapter.executions.length, 2)
    assert.equal(quarantines().length, 2)
    await lane.close()
  })

  await asyncTest('pool / uncertain recovery fences already queued publication and commit', async () => {
    lostSeed()
    active.fail('rename', event => event.path === BAK)
    const lane = pool()
    const resetting = lane.recoverLost(APP, STAMP)
    const publishing = lane.publishGeneration(publication({ expectedSource: 'ABSENT', expectedRevision: 0, nextVmGeneration: 1 }))
    const saving = lane.commit(request({ pre: { appId: APP, vmGeneration: 1, baseRevision: 0 } }))
    assert.equal((await resetting).code, 'STATE_COMMIT_UNCERTAIN')
    failureIs(await publishing, 'STATE_UNAVAILABLE', 'task-fenced')
    failureIs(await saving, 'STATE_UNAVAILABLE', 'task-fenced')
    assert.equal(poolAdapter.executions.length, 1)
    assert(!active.trace.some(event => event.op === 'write'))
    await assert.rejects(lane.whenIdle(), /STATE_COMMIT_UNCERTAIN/)
    await assert.rejects(lane.close(), /STATE_COMMIT_UNCERTAIN/)
  })

  await asyncTest('pool / ArkTS boundary avoids unsupported reflection and freezing', async () => {
    const source = fs.readFileSync(path.join(root, 'StateIoTaskPool.ets'), 'utf8')
    assert(!/Object\.(?:getPrototypeOf|getOwnPropertySymbols|getOwnPropertyDescriptor|getOwnPropertyNames)|\.prototype|\bReflect\b|['"]value['"]\s+in\b/.test(source))
    assert(!/Object\.(?:freeze|seal|preventExtensions)\b/.test(source))
    assert(source.includes('request.payload.slice(0)'))
  })

  await asyncTest('pool / options require explicit ADR limit and primitive DTOs', async () => {
    assert.throws(() => new StateIoTaskPool(ROOT, OPTIONS), /STATE_VALIDATION_FAILED/)
    for (const limit of [0, -1, NaN, Infinity, 1.5, 16 * 1024 * 1024]) assert.throws(() => pool(limit))
    for (const options of [null, new Date(), { ...OPTIONS, actor: {} }, { ...OPTIONS, lockTimeoutMs: -1 },
      { ...OPTIONS, directoryFsync: 'AUTO' }, { ...OPTIONS, directoryFsync: () => 'REQUIRED' }]) {
      assert.throws(() => pool(1024, options), /STATE_VALIDATION_FAILED/)
    }
    for (const root of ['relative', '/a/../b', '/a\0b']) assert.throws(() => new StateIoTaskPool(root, OPTIONS, 1024))
    assert.equal(poolAdapter.tasks.length, 0)
    assert.equal(active.trace.length, 0)
  })

  await asyncTest('pool / serial load header commit publication with rich results', async () => {
    seed()
    const lane = pool()
    poolAdapter.plans.push({ hold: true })
    const loaded = lane.load(APP, 'different-stamp')
    const header = lane.readHeader(APP)
    const committed = lane.commit(request())
    const published = lane.publishGeneration(publication({ expectedRevision: 8 }))
    let idle = false
    const barrier = lane.whenIdle().then(() => { idle = true })
    await tick()
    assert.equal(poolAdapter.executions.length, 1)
    assert.equal(active.trace.length, 0)
    assert.equal(idle, false)
    poolAdapter.finish()
    const loadResult = await loaded
    assert.equal(loadResult.kind, 'READY')
    assert.equal(loadResult.stamp, STAMP)
    assert.equal(loadResult.matchingStamp, false)
    assert.equal(loadResult.encodedState, undefined)
    assert.equal(loadResult.header.revision, 7)
    assert.equal((await header).revision, 7)
    assert.deepEqual(await committed, { operationId: 'commit-fixture', result: { status: 'COMMITTED', revision: 8, backup: 'SKIPPED' } })
    assert.deepEqual(await published, { operationId: 'publish-fixture', result: { status: 'COMMITTED', revision: 8, backup: 'SKIPPED' } })
    await barrier
    assert(idle)
    assert.equal(decode().vmGeneration, 4)
    const ids = poolAdapter.executions.map(item => item.args[2].operationId)
    assert.equal(new Set(ids).size, 4)
    assert.deepEqual(poolAdapter.events, ids.flatMap(id => ['submit:' + id, 'start:' + id, 'finish:' + id]))
    await lane.close()
  })

  await asyncTest('pool / independent actor lanes progress while one is held', async () => {
    seed()
    const first = pool(), second = pool()
    poolAdapter.plans.push({ hold: true })
    const waiting = first.load(APP, STAMP)
    await tick()
    assert.equal((await second.readHeader(APP)).revision, 7)
    assert.equal(poolAdapter.executions.length, 2)
    assert(!poolAdapter.executions[0].finished)
    poolAdapter.finish(poolAdapter.executions[0])
    assert.equal((await waiting).kind, 'READY')
    await Promise.all([first.close(), second.close()])
  })

  await asyncTest('pool / enqueue snapshots payload pre metadata publication and constructor options', async () => {
    seed()
    const options = { ...OPTIONS }
    const lane = pool(1048576, options)
    poolAdapter.plans.push({ hold: true })
    const waiting = lane.readHeader(APP)
    const input = request({ backupDue: true })
    const encoded = SMALL
    const committed = lane.commit(input)
    const next = publication({ expectedRevision: 8 })
    const published = lane.publishGeneration(next)
    options.directoryFsync = 'UNSUPPORTED'
    options.lockTimeoutMs = 90000
    new Uint8Array(input.payload).fill(0)
    input.pre.appId = 'evil/path'
    input.pre.baseRevision = 999
    input.operationId = 'changed'
    input.stamp = 'changed'
    input.backupDue = false
    next.operationId = 'changed'
    next.expectedRevision = 999
    next.nextVmGeneration = 999
    next.appId = 'evil/path'
    await tick()
    poolAdapter.finish()
    await waiting
    assert.equal((await committed).operationId, 'commit-fixture')
    assert.equal((await published).operationId, 'publish-fixture')
    assert.equal(decode().vmGeneration, 4)
    assert.equal(decode().encodedState, encoded)
    assert.equal(format.validateStateFile(active.text(BAK), APP).revision, 8)
    assert.equal(poolAdapter.executions[1].args[1].directoryFsync, 'REQUIRED')
    assert.equal(poolAdapter.executions[1].args[1].lockTimeoutMs, 0)
    await lane.close()
  })

  await asyncTest('pool / private snapshots transfer only owned payload and retain caller buffer', async () => {
    seed()
    const options = { ...OPTIONS }
    const lane = pool(1048576, options)
    const input = request()
    const callerPayload = input.payload
    const expectedBytes = Buffer.from(callerPayload).toString('hex')
    poolAdapter.plans.push({ hold: true })
    const saving = lane.commit(input)
    await tick()
    const execution = poolAdapter.executions[0]
    const owned = execution.task.args[2].commit
    assert.notEqual(execution.task.args[1], options)
    assert.notEqual(owned, input)
    assert.notEqual(owned.pre, input.pre)
    assert.notEqual(owned.payload, callerPayload)
    assert.equal(owned.payload.byteLength, 0)
    assert.equal(input.payload, callerPayload)
    assert.equal(callerPayload.byteLength, Buffer.byteLength(SMALL))
    assert.equal(Buffer.from(callerPayload).toString('hex'), expectedBytes)
    assert.equal(Buffer.from(execution.args[2].commit.payload).toString('hex'), expectedBytes)
    options.directoryFsync = 'UNSUPPORTED'
    input.pre.baseRevision = 999
    new Uint8Array(callerPayload).fill(0)
    assert.equal(execution.args[1].directoryFsync, 'REQUIRED')
    assert.equal(execution.args[2].commit.pre.baseRevision, 7)
    assert.equal(Buffer.from(execution.args[2].commit.payload).toString('hex'), expectedBytes)
    poolAdapter.finish()
    assert.equal((await saving).result.status, 'COMMITTED')
    assert.equal(decode().encodedState, SMALL)
    assert.equal(callerPayload.byteLength, Buffer.byteLength(SMALL))
    await lane.close()
  })

  await asyncTest('pool / payload limit UTF8 boundary no tasks for oversized queued request', async () => {
    seed()
    const lane = pool(Buffer.byteLength(SMALL))
    poolAdapter.plans.push({ hold: true })
    const waiting = lane.readHeader(APP)
    await tick()
    const taskCount = poolAdapter.tasks.length
    const large = await lane.commit(request({ payload: buffer(SMALL + ' ') }))
    failureIs(large, 'STATE_VALIDATION_FAILED', 'payload-size')
    assert.equal(poolAdapter.tasks.length, taskCount)
    const accepted = lane.commit(request({ operationId: 'exact' }))
    await tick()
    assert.equal(poolAdapter.tasks.length, 1)
    poolAdapter.finish()
    await waiting
    assert.equal((await accepted).result.status, 'COMMITTED')
    await lane.close()
  })

  await asyncTest('pool / invalid DTOs and duplicate IDs fail before task creation', async () => {
    const lane = pool()
    const invalid = [null, new Date(), request({ pre: null }), request({ pre: { appId: APP, vmGeneration: -1, baseRevision: 0 } }),
      request({ payload: new Uint8Array(4) }), request({ stamp: 'bad\0stamp' }), request({ backupDue: 1 }),
      request({ vm: {} }), request({ pre: { appId: APP, vmGeneration: 1, baseRevision: 0, actor: {} } }),
      request({ operationId: () => 'invalid-id' })]
    for (let i = 0; i < invalid.length; i++) {
      const input = invalid[i]
      if (input && typeof input.operationId === 'string') input.operationId = 'invalid:' + i
      failureIs(await lane.commit(input), 'STATE_VALIDATION_FAILED')
    }
    failureIs(await lane.publishGeneration(publication({ operationId: 'bad-publication', expectedSource: 'UNKNOWN' })), 'STATE_VALIDATION_FAILED')
    failureIs(await lane.commit(request({ operationId: '' })), 'STATE_VALIDATION_FAILED', 'operation-id')
    assert.equal((await lane.load('bad', STAMP)).code, 'STATE_VALIDATION_FAILED')
    await assert.rejects(lane.readHeader('../bad'), /STATE_VALIDATION_FAILED/)
    assert.equal(poolAdapter.tasks.length, 0)
    const valid = request({ operationId: 'once', pre: { appId: APP, vmGeneration: 1, baseRevision: 0 } })
    const accepted = lane.commit(valid)
    failureIs(await lane.publishGeneration(publication({ operationId: 'once' })), 'STATE_VALIDATION_FAILED', 'operation-id-duplicate')
    assert.equal((await accepted).result.status, 'COMMITTED')
    poolAdapter.plans.push({ submitError: true })
    failureIs(await lane.commit(valid), 'STATE_TASK_SUBMIT_FAILED', 'task-submit')
    const ids = poolAdapter.tasks.map(task => task.args[2].operationId)
    assert.equal(new Set(ids).size, ids.length)
    await lane.close()
  })

  await asyncTest('pool / long lived lane exceeds 4096 saves without retaining settled IDs', async () => {
    seed()
    const lane = pool()
    for (let i = 0; i < 8192; i++) {
      const id = 'long-lived:' + i
      poolAdapter.plans.push({ submitError: true })
      const result = await lane.commit(request({ operationId: id }))
      failureIs(result, 'STATE_TASK_SUBMIT_FAILED', 'task-submit')
      assert.equal(result.operationId, id)
      assert.equal(lane.pendingIds.size, 0)
    }
    const ids = poolAdapter.tasks.map(task => task.args[2].operationId)
    assert.equal(new Set(ids).size, 8192)
    assert.deepEqual(ids, Array.from({ length: 8192 }, (_, i) => '@state-io:' + (i + 1)))
    assert.equal((await lane.commit(request({ operationId: 'after-8192' }))).result.status, 'COMMITTED')
    assert.equal((await lane.readHeader(APP)).revision, 8)
    assert.equal(lane.pendingIds.size, 0)
    await lane.close()
  })

  await asyncTest('pool / rejected active duplicate cannot release accepted owner ID', async () => {
    seed()
    const lane = pool()
    poolAdapter.plans.push({ hold: true })
    const saving = lane.commit(request({ operationId: '@state-io:1' }))
    await tick()
    for (let i = 0; i < 3; i++) {
      failureIs(await lane.publishGeneration(publication({ operationId: '@state-io:1' })), 'STATE_VALIDATION_FAILED', 'operation-id-duplicate')
      assert.equal(lane.pendingIds.size, 1)
    }
    assert.equal(poolAdapter.tasks.length, 1)
    poolAdapter.finish()
    assert.equal((await saving).operationId, '@state-io:1')
    assert.equal(lane.pendingIds.size, 0)
    await lane.close()
  })

  await asyncTest('pool / reused caller ID cannot accept old envelope result', async () => {
    seed()
    const lane = pool()
    assert.equal((await lane.commit(request({ operationId: 'reused' }))).result.status, 'COMMITTED')
    const firstEnvelopeId = poolAdapter.executions[0].args[2].operationId
    poolAdapter.plans.push({ reply: reply => ({ ...reply, operationId: firstEnvelopeId }) })
    const result = await lane.commit(request({ operationId: 'reused', pre: { appId: APP, vmGeneration: 3, baseRevision: 8 } }))
    assert.equal(result.operationId, 'reused')
    assert.equal(result.result.status, 'COMMIT_UNCERTAIN')
    assert.equal(result.result.stage, 'task-correlation')
    assert.notEqual(poolAdapter.executions[1].args[2].operationId, firstEnvelopeId)
    assert.equal(lane.pendingIds.size, 0)
    await assert.rejects(lane.close(), /STATE_COMMIT_UNCERTAIN/)
  })

  for (const method of ['close', 'fence']) await asyncTest('pool / ' + method + ' drains owned final save and queued publication', async () => {
    seed()
    const lane = pool()
    poolAdapter.plans.push({ hold: true })
    const first = lane.commit(request({ backupDue: true }))
    const second = lane.publishGeneration(publication({ expectedRevision: 8 }))
    let drained = false
    const closing = lane[method]().then(() => { drained = true })
    failureIs(await lane.commit(request({ operationId: 'new' })), 'STATE_UNAVAILABLE', 'task-fenced')
    assert.equal((await lane.load(APP, STAMP)).code, 'STATE_UNAVAILABLE')
    await assert.rejects(lane.readHeader(APP), /STATE_UNAVAILABLE/)
    await tick()
    assert.equal(drained, false)
    assert.equal(poolAdapter.executions.length, 1)
    poolAdapter.finish()
    assert.equal((await first).result.status, 'COMMITTED')
    assert.equal((await second).result.status, 'COMMITTED')
    await closing
    assert(drained)
    assert.equal(decode().vmGeneration, 4)
    assert.equal(format.validateStateFile(active.text(BAK), APP).revision, 8)
    await lane.close()
  })

  for (const mode of ['createError', 'transferError', 'submitError']) {
    for (const kind of ['commit', 'publishGeneration', 'load', 'readHeader']) await asyncTest('pool / synchronous ' + mode + ' ' + kind + ' safe refusal queue continues', async () => {
      seed()
      const lane = pool()
      poolAdapter.plans.push({ [mode]: true })
      const pending = kind === 'commit' ? lane.commit(request()) : kind === 'publishGeneration' ? lane.publishGeneration(publication()) : lane[kind](APP, STAMP)
      const error = kind === 'readHeader' ? assert.rejects(pending, issue => issue.code === 'STATE_TASK_SUBMIT_FAILED') : pending.then(result => {
        if (kind === 'load') assert.equal(result.code, 'STATE_TASK_SUBMIT_FAILED')
        else failureIs(result, 'STATE_TASK_SUBMIT_FAILED', 'task-submit')
      })
      const next = lane.readHeader(APP)
      await error
      assert.equal((await next).revision, 7)
      assert.equal(decode().revision, 7)
      await lane.close()
    })
  }

  for (const mode of ['rejectBefore', 'rejectAfter', 'rejectLate']) {
    for (const kind of ['commit', 'publishGeneration', 'load', 'readHeader']) await asyncTest('pool / asynchronous ' + mode + ' ' + kind + ' uncertain no retry no assumed drain', async () => {
      seed()
      if (kind === 'load') active.put(MAIN, '{')
      if (kind === 'load') active.put(BAK, fileText())
      const lane = pool()
      poolAdapter.plans.push({ [mode]: true })
      const pending = kind === 'commit' ? lane.commit(request()) : kind === 'publishGeneration' ? lane.publishGeneration(publication()) : lane[kind](APP, STAMP)
      const outcome = kind === 'readHeader' ? assert.rejects(pending, issue => issue.code === 'STATE_READ_FAILED') : pending.then(result => {
        if (kind === 'load') {
          assert.equal(result.kind, 'UNAVAILABLE')
          assert.equal(result.code, 'STATE_COMMIT_UNCERTAIN')
        } else {
          assert.equal(result.operationId, kind === 'commit' ? 'commit-fixture' : 'publish-fixture')
          assert.equal(result.result.status, 'COMMIT_UNCERTAIN')
        }
      })
      const queued = lane.commit(request({ operationId: 'queued' }))
      await outcome
      failureIs(await queued, 'STATE_UNAVAILABLE', 'task-fenced')
      failureIs(await lane.commit(request({ operationId: 'retry' })), 'STATE_UNAVAILABLE', 'task-fenced')
      assert.equal(poolAdapter.executions.length, 1)
      await assert.rejects(lane.whenIdle(), /STATE_COMMIT_UNCERTAIN/)
      await assert.rejects(lane.close(), /STATE_COMMIT_UNCERTAIN/)
      if (mode === 'rejectLate') {
        assert.equal(poolAdapter.executions[0].started, false)
        poolAdapter.finish(poolAdapter.executions[0])
      }
      if (mode === 'rejectAfter' || mode === 'rejectLate') {
        assert.equal(decode().revision, kind === 'commit' ? 8 : 7)
        if (kind === 'publishGeneration') assert.equal(decode().vmGeneration, 4)
      }
    })
  }

  for (const kind of ['commit', 'publishGeneration', 'load', 'readHeader']) {
    for (const malformed of ['wrong-id', 'wrong-kind', 'bad-shape', 'missing', 'class-instance']) await asyncTest('pool / correlated ' + kind + ' rejects ' + malformed + ' result conservatively', async () => {
      seed()
      const lane = pool()
      poolAdapter.plans.push({ reply: reply => {
        if (malformed === 'wrong-id') return { ...reply, operationId: 'someone-else' }
        if (malformed === 'wrong-kind') return { ...reply, kind: 'unknown' }
        if (malformed === 'missing') return undefined
        const field = kind === 'load' ? 'load' : kind === 'readHeader' ? 'header' : 'result'
        if (malformed === 'bad-shape') return { ...reply, [field]: { kind: 'READY', status: 'COMMITTED', revision: -1 } }
        return { ...reply, [field]: new Date() }
      } })
      if (kind === 'readHeader') await assert.rejects(lane.readHeader(APP), /STATE_READ_FAILED/)
      else if (kind === 'load') assert.equal((await lane.load(APP, STAMP)).code, 'STATE_COMMIT_UNCERTAIN')
      else assert.equal((await (kind === 'commit' ? lane.commit(request()) : lane.publishGeneration(publication()))).result.status, 'COMMIT_UNCERTAIN')
      await assert.rejects(lane.close(), /STATE_COMMIT_UNCERTAIN/)
      assert.equal(poolAdapter.executions.length, 1)
    })
  }

  await asyncTest('pool / structured header worker errors do not poison serialization', async () => {
    seed()
    active.fail('read', event => event.path === MAIN)
    const lane = pool()
    await assert.rejects(lane.readHeader(APP), issue => issue.code === 'STATE_READ_FAILED' && issue.stage === 'header-read-read')
    assert.equal((await lane.load(APP, STAMP)).kind, 'READY')
    await lane.close()
  })

  await asyncTest('pool / recovery load retained through fence and reports actual backup source', async () => {
    active.put(MAIN, '{')
    active.put(BAK, fileText())
    const lane = pool()
    poolAdapter.plans.push({ hold: true })
    const loaded = lane.load(APP, STAMP)
    const closing = lane.close()
    await tick()
    poolAdapter.finish()
    const result = await loaded
    assert.equal(result.kind, 'READY')
    assert.equal(result.source, 'BAK')
    assert.equal(result.recovered, true)
    assert.equal(result.encodedState, SMALL)
    await closing
    assert.equal(decode().revision, 7)
  })

  await asyncTest('pool / worker catch returns uncertain structured DTO not thrown class', async () => {
    const { runStateIoTask } = load(path.join(root, 'StateIo.ets'))
    for (const kind of ['commit', 'publishGeneration', 'load', 'recoverLost', 'readHeader']) {
      const reply = runStateIoTask('invalid-root', OPTIONS, { operationId: 'caught:' + kind, kind, appId: APP })
      assert.deepEqual(structuredClone(reply), reply)
      assert.equal(reply.operationId, 'caught:' + kind)
      if (kind === 'load' || kind === 'recoverLost') assert.equal(reply.load.code, 'STATE_COMMIT_UNCERTAIN')
      else if (kind === 'readHeader') assert.equal(reply.error.code, 'STATE_VALIDATION_FAILED')
      else assert.equal(reply.result.status, 'COMMIT_UNCERTAIN')
    }
  })

  await asyncTest('pool / confirmed storage refusal queue continues and close preserves error', async () => {
    seed()
    active.fail('write', isMainTemp)
    const lane = pool()
    const saving = lane.commit(request())
    const next = lane.readHeader(APP)
    const closing = lane.close()
    failureIs(await saving, 'STATE_WRITE_FAILED')
    assert.equal((await next).revision, 7)
    await closing
    noTemps()
  })

  await asyncTest('pool / worker uncertain rename fences queued writes and recovery', async () => {
    seed()
    active.fail('fsync', event => event.path === DIR)
    const lane = pool()
    const saving = lane.commit(request())
    const queued = lane.load(APP, STAMP)
    assert.equal((await saving).result.status, 'COMMIT_UNCERTAIN')
    assert.equal((await queued).code, 'STATE_UNAVAILABLE')
    assert.equal(poolAdapter.executions.length, 1)
    assert.equal(decode().revision, 8)
    await assert.rejects(lane.close(), /STATE_COMMIT_UNCERTAIN/)
  })

  await asyncTest('pool / absent legacy and unavailable load preserve storage semantics', async () => {
    const lane = pool()
    assert.equal((await lane.load(APP, STAMP)).kind, 'ABSENT')
    assert.equal(await lane.readHeader(APP), null)
    active.put(MAIN, JSON.stringify({ stamp: STAMP, value: JSON.parse(SMALL) }))
    const legacy = await lane.load(APP, STAMP)
    assert.equal(legacy.kind, 'READY')
    assert.equal(legacy.format, 'LEGACY')
    assert.equal(legacy.header, undefined)
    assert.equal(await lane.readHeader(APP), null)
    active.fail('open', event => event.path === ROOT)
    assert.equal((await lane.load(APP, STAMP)).kind, 'UNAVAILABLE')
    await lane.close()
  })

  for (const kind of ['commit', 'publishGeneration']) await asyncTest('pool / wrong committed revision ' + kind + ' is an unknown outcome', async () => {
    seed()
    const lane = pool()
    poolAdapter.plans.push({ reply: reply => ({ ...reply, result: { ...reply.result, revision: reply.result.revision + 1 } }) })
    assert.equal((await (kind === 'commit' ? lane.commit(request()) : lane.publishGeneration(publication()))).result.status, 'COMMIT_UNCERTAIN')
    await assert.rejects(lane.close(), /STATE_COMMIT_UNCERTAIN/)
  })

  for (const kind of ['commit', 'publishGeneration', 'load', 'readHeader']) await asyncTest('pool / result serialization failure ' + kind + ' never a safe refusal', async () => {
    seed()
    const lane = pool()
    poolAdapter.plans.push({ reply: reply => ({ ...reply, unserializable: () => {} }) })
    if (kind === 'readHeader') await assert.rejects(lane.readHeader(APP), /STATE_READ_FAILED/)
    else if (kind === 'load') assert.equal((await lane.load(APP, STAMP)).code, 'STATE_COMMIT_UNCERTAIN')
    else assert.equal((await (kind === 'commit' ? lane.commit(request()) : lane.publishGeneration(publication()))).result.status, 'COMMIT_UNCERTAIN')
    await assert.rejects(lane.close(), /STATE_COMMIT_UNCERTAIN/)
  })

  for (const status of ['FENCED_COMMIT', 'STALE_REVISION']) await asyncTest('pool / ' + status + ' forbids stale queued work without claiming uncertainty', async () => {
    seed()
    const lane = pool()
    const rejected = lane.commit(request({ pre: { appId: APP, vmGeneration: status === 'FENCED_COMMIT' ? 2 : 3, baseRevision: 6 } }))
    const queued = lane.commit(request({ operationId: 'queued' }))
    assert.equal((await rejected).result.status, status)
    failureIs(await queued, 'STATE_UNAVAILABLE', 'task-fenced')
    assert.equal(poolAdapter.executions.length, 1)
    await lane.close()
    assert.equal(decode().revision, 7)
  })

  await asyncTest('pool / stale lock is a confirmed refusal next operation still runs', async () => {
    seed()
    active.put(LOCK, '')
    active.once(event => event.op === 'tryLock', () => { throw nativeError(13900034) })
    const lane = pool()
    const refused = lane.commit(request())
    const next = lane.commit(request({ operationId: 'after-lock' }))
    assert.equal((await refused).result.status, 'STALE')
    assert.equal((await next).result.status, 'COMMITTED')
    await lane.close()
  })

  console.log('state-io-check: ' + passed + ' passed, ' + failures.length + ' failed, ' + (passed + failures.length) + ' total; storage passed=' + storagePassed + '; task-pool passed=' + (passed - storagePassed) + '; source modules=' + cache.size + ', VM modules=0')
  if (failures.length) process.exitCode = 1
}
checkTaskPool().catch(error => { console.error(error.stack); process.exitCode = 1 })
