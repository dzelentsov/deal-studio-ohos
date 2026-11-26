'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require(process.env.VERA_TYPESCRIPT_PATH || 'typescript')
let currentMemory
const worker = require('./state-io-check').createWorkerFixture('/fixture/files/vera', event => {
  if (currentMemory) currentMemory.workerEvent(event)
})
const executeWorker = worker.taskpool.execute.bind(worker.taskpool)
worker.taskpool.execute = (task, priority) => {
  const memory = currentMemory
  assert(memory, 'worker requires the current fixture')
  assert.equal(worker.memory.fds.size, 0, 'worker descriptors released before fixture synchronization')
  assert([...worker.memory.nodes.values()].every(node => node.owner === null), 'worker locks released before fixture synchronization')
  worker.memory.nodes.clear()
  for (const [file, text] of memory.entries) {
    worker.memory.put(file, text === null ? '' : text, text === null ? 'dir' : 'file', memory.ages.get(file) || 0)
  }
  return executeWorker(task, priority).finally(() => {
    memory.entries.clear()
    for (const [file, node] of worker.memory.nodes) memory.entries.set(file, node.kind === 'dir' ? null : node.data.toString('utf8'))
  })
}
const platform = {
  '@kit.ArkTS': {util: worker.util, taskpool: worker.taskpool},
  '@ohos.fileio': {default: worker.legacyFilesystem},
  '@kit.CryptoArchitectureKit': {cryptoFramework: worker.cryptoFramework},
  '@kit.BasicServicesKit': {systemDateTime: {TimeType: {STARTUP: 0}, getUptime: () => 10000}}
}
const sourceRoot = path.resolve(process.env.VERA_SOURCE_ROOT || path.join(__dirname, '../../entry/src/main/ets'))
const compiled = new Map()

function load(name, dependencies, console, cache = new Map()) {
  const file = path.resolve(sourceRoot, 'vera', name + '.ets')
  if (cache.has(file)) return cache.get(file).exports
  if (!compiled.has(name)) {
    const result = ts.transpileModule(fs.readFileSync(file, 'utf8').replace(/^@Concurrent\s*$/gm, ''), {
      fileName: file.replace(/\.ets$/, '.ts'),
      compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020},
      reportDiagnostics: true
    })
    assert.deepEqual((result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error), [],
      name + ' must transpile without syntax errors')
    compiled.set(name, result.outputText)
  }
  const mod = {exports: {}}
  cache.set(file, mod)
  new Function('require', 'module', 'exports', 'console', compiled.get(name))(dependency => {
    if (dependency === '@kit.CoreFileKit' && path.dirname(file).startsWith(path.join(sourceRoot, 'runtime'))) {
      return {fileIo: worker.filesystem}
    }
    if (dependency === '@kit.BasicServicesKit') return {...platform[dependency], ...dependencies[dependency]}
    if (Object.hasOwn(dependencies, dependency)) return dependencies[dependency]
    if (Object.hasOwn(platform, dependency)) return platform[dependency]
    if (dependency.startsWith('.')) {
      const relative = path.relative(path.join(sourceRoot, 'vera'), path.resolve(path.dirname(file), dependency))
      return load(relative, dependencies, console, cache)
    }
    assert.fail('Unexpected ' + name + ' dependency: ' + dependency)
  }, mod, mod.exports, console)
  return mod.exports
}

const businessError = (code, message) => Object.assign(new Error(message), {code})
const root = '/fixture/files/vera'
const indexPath = root + '/index.json'
const projectDir = root + '/target'
const checks = []

function memoryFs() {
  const entries = new Map([['/', null]])
  const handles = new Map(), ages = new Map()
  const calls = [], faults = []
  let nextFd = 1
  const within = (entry, dir) => entry === dir || entry.startsWith(dir + '/')
  function directory(dir) {
    if (entries.has(dir)) {
      assert.equal(entries.get(dir), null, 'Expected a directory: ' + dir)
      return
    }
    directory(path.posix.dirname(dir))
    entries.set(dir, null)
  }
  function file(name, text) {
    directory(path.posix.dirname(name))
    entries.set(name, text)
  }
  function requireEntry(name) {
    if (!entries.has(name)) { throw businessError(13900002, 'No such file or directory: ' + name) }
    return entries.get(name)
  }
  function record(method, name, flags, to) {
    calls.push(flags === undefined ? {method, path: name} : {method, path: name, flags})
    if (to !== undefined) calls[calls.length - 1].to = to
    if (isIndexTemp(name)) calls[calls.length - 1].destination = entries.get(indexPath)
    const at = faults.findIndex(f => f.method === method &&
      (f.path === undefined || (typeof f.path === 'function' ? f.path(name) : f.path === name)))
    if (at < 0) { return }
    const fault = faults.splice(at, 1)[0]
    if (fault.partial) { fault.partial() }
    throw fault.error
  }
  function erase(dir) {
    for (const name of entries.keys()) {
      if (within(name, dir)) { entries.delete(name) }
    }
  }
  const disk = {
    OpenMode: {CREATE: 1, WRITE_ONLY: 2, TRUNC: 4},
    mkdirSync(dir, recursive) {
      record('mkdir', dir)
      assert.equal(recursive, true)
      directory(dir)
    },
    statSync(name) {
      record('stat', name)
      const value = requireEntry(name)
      return {size: value === null ? 0 : Buffer.byteLength(value)}
    },
    readTextSync(name) {
      record('read', name)
      const text = requireEntry(name)
      assert.equal(typeof text, 'string')
      return text
    },
    listFileSync(dir) {
      record('list', dir)
      assert.equal(requireEntry(dir), null)
      return [...entries.keys()].filter(name => name !== dir && path.posix.dirname(name) === dir)
        .map(name => path.posix.basename(name))
    },
    openSync(name, mode) {
      record('open', name)
      assert.equal(mode, disk.OpenMode.CREATE | disk.OpenMode.WRITE_ONLY | disk.OpenMode.TRUNC)
      assert.equal(requireEntry(path.posix.dirname(name)), null)
      entries.set(name, '')
      const fd = nextFd++
      handles.set(fd, name)
      return {fd}
    },
    writeSync(fd, content) {
      assert.ok(handles.has(fd), 'Write needs an open handle')
      const name = handles.get(fd)
      record('write', name)
      entries.set(name, content)
      return Buffer.byteLength(content)
    },
    closeSync(handle) {
      assert.ok(handles.has(handle.fd), 'Close needs an open handle')
      const name = handles.get(handle.fd)
      handles.delete(handle.fd)
      record('close', name)
    },
    renameSync(from, to) {
      record('rename', from, undefined, to)
      assert.ok(![...handles.values()].includes(from), 'Rename must follow close')
      assert.equal(typeof requireEntry(from), 'string')
      entries.set(to, entries.get(from))
      entries.delete(from)
    },
    unlinkSync(name) {
      record('unlink', name)
      assert.equal(typeof requireEntry(name), 'string')
      entries.delete(name)
    },
    rmdirSync(dir) {
      record('rmdir', dir)
      assert.equal(requireEntry(dir), null)
      erase(dir)
    }
  }
  currentMemory = {disk, entries, calls, faults, handles, ages, file, directory, erase,
    workerEvent(event) {
      const method = ({stat: 'stat', read: 'read', list: 'list', open: 'open', write: 'write',
        close: 'close', rename: 'rename', unlink: 'unlink', mkdir: 'mkdir'})[event.op]
      if (method) record(method, event.path, event.flags)
    },
    inject(method, name, error, partial) { faults.push({method, path: name, error, partial}) },
    snapshot(dir = '/') {
      return [...entries].filter(([name]) => dir === '/' || within(name, dir))
        .sort(([a], [b]) => a.localeCompare(b))
    }}
  return currentMemory
}

function fixture(versionCount = 2) {
  const memory = memoryFs(), errors = [], warnings = [], platformCalls = []
  const logger = {error: (...args) => errors.push(args.join(' ')),
    warn: (...args) => warnings.push(args.join(' ')), info() {}}
  const textModule = load('ProjectText', {}, logger)
  const storeModule = load('ProjectStore', {
    '@kit.CoreFileKit': {fileIo: memory.disk},
    '@kit.BasicServicesKit': {},
    './ProjectText': textModule
  }, logger)
  const store = new storeModule.ProjectStore()
  store.init('/fixture/files')
  const project = Object.assign(new storeModule.Project(), {id: 'target', name: 'Target', icon: 'code', createdAt: 100})
  const other = Object.assign(new storeModule.Project(), {id: 'target-copy', name: 'Keep', icon: 'code', createdAt: 101})
  memory.file(indexPath, JSON.stringify([project, other]))
  const versions = []
  for (const p of [project, other]) {
    memory.directory(root + '/' + p.id)
    for (let i = 0; i < (p === project ? versionCount : 1); i++) {
      const version = Object.assign(new storeModule.Version(), {id: 'v' + i, projectId: p.id,
        source: 'source ' + i, vbc2: 'bytecode ' + i, note: 'Version ' + i,
        prompt: 'Request ' + i, createdAt: 200 + i})
      memory.file(root + '/' + p.id + '/' + version.id + '.json', JSON.stringify(version))
      memory.file(root + '/' + p.id + '/' + version.id + '.state.json', JSON.stringify({stamp: 'stamp', value: {count: i}}))
      memory.file(root + '/' + p.id + '/' + version.id + '.state.json.commit.lock', '')
      if (p === project) { versions.push(version) }
    }
    memory.file(root + '/' + p.id + '/assets/nested/data.bin', 'nested saved data')
  }
  const operationsModule = load('ProjectOperations', {
    './ProjectStore': storeModule,
    './ProjectIcons': {projectShortcutIconResource() { assert.fail('Deletion must not load shortcut icons') }},
    '@kit.AbilityKit': {
      bundleManager: {BundleFlag: {GET_BUNDLE_INFO_DEFAULT: 0}, getBundleInfoForSelfSync() {
        platformCalls.push('bundle')
        return {name: 'fixture.vera'}
      }},
      shortcutManager: {async getAllDesktopShortcutInfo(userId) {
        assert.equal(userId, 42)
        platformCalls.push('shortcuts')
        return []
      }}
    },
    '@kit.BasicServicesKit': {osAccount: {getAccountManager: () => ({getOsAccountLocalIdForUidSync(uid) {
      assert.equal(uid, 1000)
      platformCalls.push('account')
      return 42
    }})}},
    '@kit.IPCKit': {rpc: {RemoteObject: class {}}},
    '@kit.ArkTS': {process: {uid: 1000}, util: {}}
  }, logger)
  const operations = new operationsModule.ProjectOperations(store)
  const context = () => { assert.fail('An absent shortcut needs no launcher context') }
  memory.calls.length = 0
  return {...memory, store, project, other, versions, operations, context,
    status: operationsModule.ProjectOperationStatus, errors, warnings, platformCalls}
}

const mutations = f => f.calls.filter(c => ['mkdir', 'write', 'unlink', 'rmdir'].includes(c.method) ||
  c.method === 'open' && (c.flags === undefined || (c.flags & worker.filesystem.OpenMode.CREATE) !== 0))
const isIndexTemp = name => name.startsWith(indexPath + '.') && name.endsWith('.tmp') && path.posix.dirname(name) === root
const indexCalls = f => {
  const calls = f.calls.filter(c => (c.path === indexPath || isIndexTemp(c.path)) &&
    ['open', 'write', 'close', 'rename', 'unlink'].includes(c.method))
  for (const call of calls) {
    assert(isIndexTemp(call.path), 'Never open, write, close, rename or unlink the index destination directly')
    assert.equal(call.path, calls[0].path, 'One sibling temporary file per index publication')
    if (call.method !== 'unlink') assert.equal(call.destination, calls[0].destination, 'The index destination must remain unchanged until rename')
    if (call.method === 'rename') assert.equal(call.to, indexPath, 'Publish the sibling temporary file to the index destination')
  }
  return calls
}
const deletionCalls = f => {
  const index = indexCalls(f)
  return f.calls.filter(c => c.method === 'unlink' || index.includes(c)).map(c => index.includes(c) ?
    {method: c.method, path: indexPath + '.tmp', ...(c.to === undefined ? {} : {to: c.to})} : c)
}
const expectedDeletion = count => [
  ...Array.from({length: count}, (_, i) => ({method: 'unlink', path: projectDir + '/v' + i + '.state.json'})),
  ...Array.from({length: count}, (_, i) => ({method: 'unlink', path: projectDir + '/v' + (count - i - 1) + '.json'})),
  {method: 'open', path: indexPath + '.tmp'},
  {method: 'write', path: indexPath + '.tmp'},
  {method: 'close', path: indexPath + '.tmp'},
  {method: 'rename', path: indexPath + '.tmp', to: indexPath},
  {method: 'unlink', path: indexPath + '.tmp'}
]
function throwsIdentity(action, error) {
  assert.throws(action, caught => {
    assert.strictEqual(caught, error, 'The original thrown value must propagate unchanged')
    return true
  })
}
function preserved(f, index, other) {
  assert.equal(f.entries.get(indexPath), index, 'The project index must be unchanged')
  assert.deepEqual(f.snapshot(root + '/' + f.other.id), other, 'The other project must be unchanged')
  assert.deepEqual(f.faults, [], 'The injected fault must have been reached')
  assert.equal(f.handles.size, 0, 'No file handles may leak')
  assert.equal(worker.memory.fds.size, 0, 'No worker descriptors may leak')
  assert([...worker.memory.nodes.values()].every(node => node.owner === null), 'No worker locks may leak')
}
function deleted(f, other) {
  assert.deepEqual(f.snapshot(projectDir), [
    [projectDir, null], [projectDir + '/assets', null], [projectDir + '/assets/nested', null],
    [projectDir + '/assets/nested/data.bin', 'nested saved data'],
    ...f.versions.map(version => [projectDir + '/' + version.id + '.state.json.commit.lock', ''])
  ].sort(([a], [b]) => a.localeCompare(b)), 'Only stable locks and unrelated assets survive project metadata/state removal')
  assert.deepEqual(f.store.listProjects().map(p => p.id), [f.other.id])
  assert.deepEqual(f.snapshot(root + '/' + f.other.id), other, 'The other project must be unchanged')
  assert.equal(f.handles.size, 0, 'No file handles may leak')
  assert.equal(worker.memory.fds.size, 0, 'No worker descriptors may leak')
  assert([...worker.memory.nodes.values()].every(node => node.owner === null), 'No worker locks may leak')
}
function check(name, run) { checks.push({name, run}) }

check('state cleanup and metadata deletion precede index write and preserve the other project and its summary', async () => {
  const f = fixture(), other = f.snapshot(root + '/' + f.other.id)
  f.store.summaryOf(f.project)
  const otherSummary = f.store.summaryOf(f.other)
  await f.store.deleteProject(f.project.id)
  assert.deepEqual(deletionCalls(f), expectedDeletion(2))
  assert.deepEqual(f.calls.filter(c => c.method === 'rmdir'), [])
  deleted(f, other)
  assert.strictEqual(f.store.summaryOf(f.other), otherSummary)
  assert.equal(f.store.summaryOf(f.project).versions, 0)
})

check('missing directory code 13900002 still cleans up the index', async () => {
  const f = fixture(), other = f.snapshot(root + '/' + f.other.id)
  const cached = f.store.summaryOf(f.project)
  f.erase(projectDir)
  await f.store.deleteProject(f.project.id)
  assert.deepEqual(deletionCalls(f), expectedDeletion(0))
  assert.deepEqual(f.snapshot(projectDir), [])
  assert.deepEqual(f.store.listProjects().map(p => p.id), [f.other.id])
  assert.deepEqual(f.snapshot(root + '/' + f.other.id), other)
  const summary = f.store.summaryOf(f.project)
  assert.notStrictEqual(summary, cached)
  assert.equal(summary.versions, 0)
})

const failures = [
  ['permission', () => businessError(13900012, 'Permission denied')],
  ['busy', () => businessError(13900014, 'Device or resource busy')],
  ['unexpected business error', () => businessError(13900005, 'Unexpected I/O error')],
  ['ordinary Error', () => new Error('Unexpected failure')],
  ['non-Error object', () => ({message: 'Unexpected object', detail: 7})],
  ['string missing-directory code', () => ({code: '13900002', message: 'Not the numeric missing-directory code'})],
  ['primitive', () => 'unexpected thrown string'],
  ['null', () => null],
  ['undefined', () => undefined]
]
for (const [name, makeError] of failures) {
  check(name + ' is normalized across TaskPool, preserves the index without writes, and ' +
    (name === 'null' || name === 'undefined' ? 'retains the uncertain cleanup fence' : 'permits retry'), async () => {
    const f = fixture(), error = makeError(), before = f.snapshot()
    const index = f.entries.get(indexPath), other = f.snapshot(root + '/' + f.other.id)
    f.inject('list', projectDir, error)
    const code = error == null ? 'STATE_COMMIT_UNCERTAIN' : error.code === 13900012 ? 'STATE_UNAVAILABLE' : 'STATE_READ_FAILED'
    await assert.rejects(f.store.deleteProject(f.project.id), caught => {
      assert.equal(caught.code, code)
      assert.equal(caught.stage, error == null ? 'cleanup-worker' : 'removal-list')
      return true
    })
    assert.deepEqual(indexCalls(f), [], 'Failed worker cleanup must not open the index for writing')
    assert.deepEqual(deletionCalls(f), [])
    assert.deepEqual(f.snapshot(), before)
    preserved(f, index, other)
    f.calls.length = 0
    if (error == null) {
      await assert.rejects(f.store.deleteProject(f.project.id), /Project state admission fenced: target\/@project/)
      assert.throws(() => f.store.assertStateAdmission('target/v0'), /Project state admission fenced: target\/v0/)
      await assert.rejects(f.store.trackStateOperation('target/v0', () => {
        assert.fail('Uncertain cleanup must not admit storage work')
      }), /Project state admission fenced: target\/v0/)
      assert.doesNotThrow(() => f.store.assertStateAdmission('target-copy/v0'))
      assert.deepEqual(mutations(f), [])
      assert.deepEqual(f.snapshot(), before)
      preserved(f, index, other)
    } else {
      await f.store.deleteProject(f.project.id)
      assert.deepEqual(deletionCalls(f), expectedDeletion(2))
      deleted(f, other)
    }
  })
}

check('unknown project leaves even an orphan directory untouched', async () => {
  const f = fixture()
  f.file(root + '/unknown/nested/keep.json', '{"keep":true}')
  const before = f.snapshot()
  await f.store.deleteProject('unknown')
  assert.deepEqual(mutations(f), [])
  assert.deepEqual(f.snapshot(), before)
})

check('index open failure follows cleanup, invalidates summary, and retry removes the residual index entry', async () => {
  const f = fixture(), error = businessError(13900012, 'Cannot open index')
  const index = f.entries.get(indexPath), other = f.snapshot(root + '/' + f.other.id)
  const cached = f.store.summaryOf(f.project)
  assert.equal(cached.versions, 2)
  f.inject('open', isIndexTemp, error)
  await assert.rejects(f.store.deleteProject(f.project.id), caught => caught === error)
  assert.deepEqual(deletionCalls(f), [
    ...expectedDeletion(2).slice(0, -4),
    {method: 'unlink', path: indexPath + '.tmp'}
  ])
  assert(f.snapshot(projectDir).every(([name]) => !/\/v\d+\.(?:state\.)?json$/.test(name)))
  preserved(f, index, other)
  assert.ok(f.store.getProject(f.project.id), 'Failed index open must retain the index entry')
  const summary = f.store.summaryOf(f.project)
  assert.notStrictEqual(summary, cached)
  assert.equal(summary.versions, 0)
  assert.equal(summary.request, '')
  assert.equal(summary.updatedAt, f.project.createdAt)
  f.calls.length = 0
  await f.store.deleteProject(f.project.id)
  assert.deepEqual(deletionCalls(f), expectedDeletion(0))
  deleted(f, other)
})

check('partial metadata removal invalidates summary while preserving the index for retry', async () => {
  const f = fixture(), error = businessError(13900014, 'Partial metadata removal')
  const index = f.entries.get(indexPath), other = f.snapshot(root + '/' + f.other.id)
  const cached = f.store.summaryOf(f.project)
  assert.equal(cached.request, 'Request 1')
  f.inject('unlink', projectDir + '/v0.json', error)
  await assert.rejects(f.store.deleteProject(f.project.id), caught => caught === error)
  assert.deepEqual(indexCalls(f), [])
  preserved(f, index, other)
  const summary = f.store.summaryOf(f.project)
  assert.notStrictEqual(summary, cached)
  assert.equal(summary.versions, 1)
  assert.equal(summary.request, 'Request 0')
  assert.equal(summary.updatedAt, 200)
  await f.store.deleteProject(f.project.id)
  deleted(f, other)
})

check('last-version deletion propagates cleanup failure and retry deletes the project, version, and state', async () => {
  const f = fixture(1), error = businessError(13900012, 'Last version removal denied')
  const before = f.snapshot(), index = f.entries.get(indexPath), other = f.snapshot(root + '/' + f.other.id)
  f.inject('open', projectDir + '/v0.state.json.commit.lock', error)
  await assert.rejects(f.store.deleteVersion(f.project.id, f.versions[0].id), {code: 'STATE_UNAVAILABLE'})
  assert.deepEqual(indexCalls(f), [])
  assert.deepEqual(f.snapshot(), before)
  preserved(f, index, other)
  f.calls.length = 0
  assert.equal(await f.store.deleteVersion(f.project.id, f.versions[0].id), true)
  assert.deepEqual(deletionCalls(f), expectedDeletion(1))
  deleted(f, other)
})

for (const method of ['deleteProject', 'deleteVersion']) {
  for (const [name, makeError] of failures.slice(0, 4)) {
    check('ProjectOperations.' + method + ' returns Failed and logs ' + name + ', then releases its lock for retry', async () => {
      const f = fixture(1), error = makeError(), before = f.snapshot()
      const index = f.entries.get(indexPath), other = f.snapshot(root + '/' + f.other.id)
      const operation = method === 'deleteProject' ? 'Delete project' : 'Delete Version ' + f.versions[0].id
      const invoke = () => f.operations[method](f.context, f.project.id, f.versions[0].id)
      f.inject('open', projectDir + '/v0.state.json.commit.lock', error)
      const pending = invoke()
      assert.equal(await invoke(), f.status.Busy, 'The real operation must hold its lock while awaiting platform calls')
      assert.equal(await pending, f.status.Failed)
      const code = error.code === 13900012 ? 'STATE_UNAVAILABLE' : 'STATE_LOCK_UNAVAILABLE'
      assert.deepEqual(f.errors, [operation + ' failed for project "target": error code = ' +
        code + ', message = "' + code + ' at lock-open"'])
      assert.equal(f.warnings.length, 1)
      assert.match(f.warnings[0], /is busy$/)
      assert.deepEqual(indexCalls(f), [])
      assert.deepEqual(f.snapshot(), before)
      assert.deepEqual(f.platformCalls, method === 'deleteProject' ? ['bundle', 'account', 'shortcuts'] : [])
      preserved(f, index, other)
      f.calls.length = 0
      assert.equal(await invoke(), method === 'deleteProject' ? f.status.Success : f.status.ProjectDeleted,
        'Retry must not return Busy after the failed operation')
      assert.deepEqual(deletionCalls(f), expectedDeletion(1))
      assert.equal(f.errors.length, 1, 'Successful retry must not log a failure')
      assert.deepEqual(f.platformCalls, method === 'deleteProject' ?
        ['bundle', 'account', 'shortcuts', 'account', 'shortcuts'] : ['bundle', 'account', 'shortcuts'])
      deleted(f, other)
    })
  }
  check('ProjectOperations.' + method + ' succeeds through real store and platform lookup', async () => {
    const f = fixture(1), other = f.snapshot(root + '/' + f.other.id)
    const invoke = () => f.operations[method](f.context, f.project.id, f.versions[0].id)
    assert.equal(await invoke(), method === 'deleteProject' ? f.status.Success : f.status.ProjectDeleted)
    assert.deepEqual(deletionCalls(f), expectedDeletion(1))
    assert.deepEqual(f.platformCalls, ['bundle', 'account', 'shortcuts'])
    assert.deepEqual(f.errors, [])
    assert.deepEqual(f.warnings, [])
    deleted(f, other)
    f.calls.length = 0
    assert.equal(await invoke(), f.status.NotFound)
    assert.deepEqual(mutations(f), [])
  })
}

const atomicTargets = [
  {
    name: 'project state', path: projectDir + '/v0.state.json',
    before: ['n', 1], after: ['n', 2],
    async setup(memory) {
      const dependencies = {'@kit.CoreFileKit': {fileIo: memory.disk}, '@kit.BasicServicesKit': {}}
      const cache = new Map()
      const {ProjectStore} = load('ProjectStore', dependencies, console, cache)
      const {StateManager} = load('../runtime/StateManager', dependencies, console, cache)
      const V = load('VeraInterpreter', dependencies, console, cache)
      const format = load('../runtime/StateFileFormat', dependencies, console, cache)
      const store = new ProjectStore(); store.init('/fixture/files')
      memory.file(this.path, format.assembleStateFile({appId: 'target/v0', schemaVersion: 1,
        vmGeneration: 1, revision: 1, stamp: 'new-stamp'}, JSON.stringify(this.before)))
      const guard = new V.VirtualMachine(new V.BytecodeModule([], []), new V.EmptyHostEnvironment(), 0,
        {now: () => 10000, deadlineMs: 1000}, {journalMode: 'JOURNAL'})
      const manager = new StateManager({appId: 'target/v0', stamp: 'new-stamp', mode: 'LIVE_PERSISTENT',
        stateMaxBytes: 1048576, initialState: V.NULL_VALUE, storage: store.createStateStorage(),
        rollbackGuard: guard, now: () => 10000})
      assert.equal((await manager.load()).kind, 'READY')
      assert.equal((await manager.publishGeneration()).status, 'COMMITTED')
      return {manager, format,
        async save() {
          const tx = manager.beginTurn('IMMEDIATE', 'INPUT')
          manager.setWorkingState(tx, new V.VeraNumberValue(2))
          return manager.commitTurn(tx)
        },
        read: () => store.loadState('target', 'v0', 'new-stamp'), expected: '["n",2]'}
    }
  },
  {
    name: 'form bindings', path: root + '/forms.json',
    before: {existing: 'keep', form: 'old'}, after: {existing: 'keep', form: 'new'},
    setup(memory) {
      const {FormBindings} = load('FormBindings', {'@kit.CoreFileKit': {fileIo: memory.disk}}, console)
      const bindings = new FormBindings(); bindings.init('/fixture/files')
      return {save: () => bindings.bind('form', 'new'), read: () => bindings.projectFor('form'), expected: 'new'}
    }
  },
  {
    name: 'form sizes', path: root + '/form-sizes.json',
    before: {existing: 2, form: 3}, after: {existing: 2, form: 4},
    setup(memory) {
      const {FormBindings} = load('FormBindings', {'@kit.CoreFileKit': {fileIo: memory.disk}}, console)
      const bindings = new FormBindings(); bindings.init('/fixture/files')
      return {save: () => bindings.setDimension('form', 4), read: () => bindings.dimensionFor('form'), expected: 4}
    }
  },
  {
    name: 'form offer', path: root + '/form-offer.json',
    before: {projectId: 'old', at: 100}, after: {projectId: 'new', at: 200},
    setup(memory) {
      const {FormBindings} = load('FormBindings', {'@kit.CoreFileKit': {fileIo: memory.disk}}, console)
      const bindings = new FormBindings(); bindings.init('/fixture/files')
      return {save: () => bindings.offer('new', 200), read: () => bindings.takeOffer(201), expected: 'new'}
    }
  },
  {
    name: 'refresh ledger', path: root + '/widget-refresh.json',
    before: {existing: 100, target: 200}, after: {existing: 100, target: 300},
    setup(memory) {
      const {RefreshLedger} = load('FormBindings', {'@kit.CoreFileKit': {fileIo: memory.disk}}, console)
      const ledger = new RefreshLedger(); ledger.init('/fixture/files')
      return {save: () => ledger.markRun('target', 300), read: () => ledger.lastRun('target'), expected: 300}
    }
  }
]

for (const target of atomicTargets) {
  async function atomicFixture() {
    const memory = memoryFs(), api = await target.setup(memory)
    if (!api.manager) memory.file(target.path, JSON.stringify(target.before))
    memory.file(root + '/unrelated.json', '{"keep":true}')
    memory.calls.length = 0
    worker.memory.trace.length = 0
    return {...memory, ...api}
  }
  function atomicCalls(f) {
    return f.calls.filter(c => ['open', 'write', 'close', 'rename', 'unlink'].includes(c.method) &&
      (!f.manager || c.path.startsWith(target.path + '.') && c.path.endsWith('.tmp')))
  }
  function checkedTemp(f) {
    const calls = atomicCalls(f).filter(call => !f.orphan || call.path !== f.orphan), temp = calls[0].path
    assert.ok(temp.startsWith(target.path + '.') && temp.endsWith('.tmp'), 'Use a sibling temporary file')
    assert.ok(calls.every(c => c.path === temp), 'Only the temporary file may be opened, written, closed, renamed or unlinked')
    assert.equal(f.handles.size, 0, 'Every opened handle must be closed, including after write failure')
    if (f.manager) {
      assert.equal(worker.memory.fds.size, 0, 'Every worker descriptor must be closed')
      assert([...worker.memory.nodes.values()].every(node => node.owner === null), 'Every stable lock must be released')
      const writes = f.calls.filter(call => ['write', 'rename', 'unlink'].includes(call.method) ||
        call.method === 'open' && (call.flags & worker.filesystem.OpenMode.CREATE) !== 0 &&
        !call.path.endsWith('.commit.lock'))
      assert(writes.every(call => call.path === temp || call.path === f.orphan),
        'Never write the destination directly or mutate unrelated files')
    }
    assert.deepEqual(f.faults, [], 'Every injected fault must be reached')
    assert.equal(f.entries.get(root + '/unrelated.json'), '{"keep":true}')
    return temp
  }
  for (const cleanupFails of [false, true]) {
    check(target.name + ' keeps its schema and commits only after close' + (cleanupFails ? ' despite unlink failure' : ''), async () => {
      const f = await atomicFixture()
      if (f.manager) {
        try {
          const orphan = target.path + '.00000000-0000-4000-8000-000000000000.tmp'
          f.orphan = orphan
          f.file(orphan, 'incomplete JSON')
          f.ages.set(orphan, 120000)
          if (cleanupFails) f.inject('unlink', orphan, new Error('Cleanup failure'))
          const result = await f.save()
          assert.equal(result.status, 'COMMITTED')
          const methods = atomicCalls(f).filter(call => call.path !== orphan).map(call => call.method)
          assert.deepEqual(methods, ['open', 'write', 'close', 'rename'])
          const decoded = f.format.validateStateFile(f.entries.get(target.path), 'target/v0', 1)
          assert.equal(decoded.revision, 2)
          assert.equal(decoded.vmGeneration, 2)
          assert.equal(decoded.encodedState, JSON.stringify(target.after))
          assert.equal(await f.read(), f.expected)
          checkedTemp(f)
        } finally { await f.manager.close() }
        return
      }
      if (cleanupFails) { f.inject('unlink', undefined, new Error('Cleanup failure')) }
      await f.save()
      assert.deepEqual(atomicCalls(f).map(c => c.method), ['open', 'write', 'close', 'rename', 'unlink'])
      assert.equal(f.entries.has(checkedTemp(f)), false)
      assert.equal(f.entries.get(target.path), JSON.stringify(target.after))
      assert.equal(await f.read(), f.expected)
    })
  }
  const atomicFailures = [
    {name: 'open', method: 'open'},
    {name: 'partial open', method: 'open', partial: true},
    {name: 'partial write', method: 'write', partial: true},
    {name: 'close', method: 'close'},
    {name: 'rename', method: 'rename'},
    {name: 'write and close', method: 'write', partial: true, closeFails: true},
    {name: 'null write and close', method: 'write', closeFails: true, error: null},
    {name: 'undefined write and close', method: 'write', closeFails: true, error: undefined}
  ]
  for (const scenario of atomicFailures) {
    for (const cleanupFails of [false, true]) {
      check(target.name + ' preserves destination and original error on ' + scenario.name +
        (cleanupFails ? ' plus cleanup failure' : ''), async () => {
        const f = await atomicFixture(), before = f.snapshot()
        const error = Object.hasOwn(scenario, 'error') ? scenario.error : businessError(13900005, scenario.name)
        if (f.manager) {
          try {
            const destination = f.entries.get(target.path)
            const isTemp = name => name.startsWith(target.path + '.') && name.endsWith('.tmp')
            f.inject(scenario.method, isTemp, error, scenario.partial ? () => {
              const temp = f.calls[f.calls.length - 1].path
              worker.memory.put(temp, 'incomplete JSON')
            } : undefined)
            if (scenario.closeFails) f.inject('close', isTemp, new Error('Secondary close failure'))
            if (cleanupFails) {
              if (scenario.method === 'open') {
                f.orphan = target.path + '.00000000-0000-4000-8000-000000000000.tmp'
                f.file(f.orphan, 'incomplete JSON')
                f.ages.set(f.orphan, 120000)
                f.inject('unlink', f.orphan, new Error('Secondary cleanup failure'))
              } else f.inject('unlink', isTemp, new Error('Secondary cleanup failure'))
            }
            const result = await f.save()
            assert.equal(result.status, 'FAILED')
            assert.equal(result.code, scenario.method === 'rename' ? 'STATE_PUBLISH_FAILED' : 'STATE_WRITE_FAILED')
            assert.equal(result.stage, error == null ? 'commit' :
              'commit-main-' + (scenario.method === 'rename' ? 'rename' : 'temp-' + scenario.method))
            assert.equal(f.entries.get(target.path), destination, 'The previous destination must survive')
            const completedCalls = atomicCalls(f).filter(call => call.path !== f.orphan)
            if (scenario.closeFails) {
              const failedClose = f.calls.filter(call => call.method === 'close' && isTemp(call.path))
              assert.equal(failedClose.length, 1, 'The secondary close fault must be reached')
              const descriptors = [...worker.memory.fds.values()]
              assert.equal(descriptors.length, 1, 'Only the descriptor whose close failed remains open')
              assert.equal(descriptors[0].path, failedClose[0].path)
              worker.memory.closeSync(descriptors[0].fd)
            }
            assert.equal(await f.read(), JSON.stringify(target.before))
            const temp = checkedTemp(f)
            const expected = ['open']
            if (scenario.method !== 'open') expected.push('write', 'close')
            if (scenario.method === 'close') expected.push('close')
            if (scenario.method === 'rename') expected.push('rename')
            if (scenario.method !== 'open') expected.push('unlink')
            assert.deepEqual(completedCalls.map(call => call.method), expected,
              'Never rename after an open, write or close failure')
            assert.deepEqual(f.snapshot().filter(([name]) => name !== temp && name !== f.orphan), before)
            if (scenario.method !== 'open' && !cleanupFails) assert.equal(f.entries.has(temp), false)
            if (scenario.method === 'open' && scenario.partial) assert.equal(f.entries.get(temp), 'incomplete JSON',
              'An unowned partial-open artifact must never be removed')
            f.calls.length = 0
            assert.equal((await f.save()).status, 'COMMITTED', 'A retry must still succeed')
            assert.equal(await f.read(), f.expected)
            assert.equal(f.format.validateStateFile(f.entries.get(target.path), 'target/v0', 1).revision, 2)
            assert.equal(worker.memory.fds.size, 0)
            assert([...worker.memory.nodes.values()].every(node => node.owner === null))
          } finally { await f.manager.close() }
          return
        }
        f.inject(scenario.method, undefined, error, scenario.partial ? () => {
          const temp = f.calls[f.calls.length - 1].path
          f.file(temp, 'incomplete JSON')
        } : undefined)
        if (scenario.closeFails) { f.inject('close', undefined, new Error('Secondary close failure')) }
        if (cleanupFails) { f.inject('unlink', undefined, new Error('Secondary cleanup failure')) }
        throwsIdentity(f.save, error)
        const temp = checkedTemp(f)
        const expected = ['open']
        if (scenario.method !== 'open') { expected.push('write', 'close') }
        if (scenario.method === 'rename') { expected.push('rename') }
        expected.push('unlink')
        assert.deepEqual(atomicCalls(f).map(c => c.method), expected, 'Never rename after an open, write or close failure')
        assert.equal(f.entries.get(target.path), JSON.stringify(target.before), 'The previous destination must survive')
        if (cleanupFails) {
          assert.deepEqual(f.snapshot().filter(([name]) => name !== temp), before)
        } else {
          assert.deepEqual(f.snapshot(), before, 'Best-effort cleanup must remove even partially written temporary files')
        }
        f.calls.length = 0
        await f.save()
        assert.equal(f.entries.get(target.path), JSON.stringify(target.after), 'A retry must still succeed')
        assert.equal(await f.read(), f.expected)
        assert.equal(f.handles.size, 0)
      })
    }
  }
}

;(async () => {
  let failed = 0
  for (const {name, run} of checks) {
    try {
      await run()
      console.log('PASS ' + name)
    } catch (error) {
      failed++
      console.error('FAIL ' + name + '\n' + (error && error.stack || String(error)))
    }
  }
  console.log('project-delete-check: ' + (checks.length - failed) + '/' + checks.length + ' passed')
  if (failed) { process.exitCode = 1 }
})().catch(error => { console.error(error); process.exitCode = 1 })
