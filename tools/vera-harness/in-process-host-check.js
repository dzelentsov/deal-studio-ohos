'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require(process.env.VERA_TYPESCRIPT_PATH || 'typescript')
const crypto = require('node:crypto')
const { TextEncoder, TextDecoder } = require('node:util')
const root = path.resolve(process.env.VERA_SOURCE_ROOT || path.join(__dirname, '../../entry/src/main/ets'))
const cache = new Map()
let records = []
let failure = ''
let now = 100000
let nextTimer = 0
const timers = new Map()
const hosts = []
const callbackErrors = []
const committedStates = new Map()
const worker = require('./state-io-check').createWorkerFixture('/host-fixture/vera', event => {
  if (event.op === 'stat' && event.path.endsWith('.state.json')) records.push({ type: 'load-attempt', file: event.path })
  if (event.op === 'read' && event.path.endsWith('.state.json')) records.push({ type: 'load', file: event.path })
  if (event.op === 'rename' && event.to.endsWith('.state.json')) records.push({ type: 'save-attempt', file: event.to })
  if (event.op === 'rename' && event.to.endsWith('.quarantine')) records.push({ type: 'quarantine', file: event.path, to: event.to })
}, () => failure)
const disk = worker.disk
const filesystem = new Proxy(worker.filesystem, { get(target, key) {
  if (key === 'readTextSync') return file => {
    assert(!worker.workerActive(), 'worker must use bounded byte reads')
    if (!disk.has(file)) throw Object.assign(Error('absent'), { code: 13900002 })
    return disk.get(file)
  }
  if (key === 'mkdirSync') return file => {
    if (worker.workerActive()) return target.mkdirSync(file)
    if (!worker.memory.nodes.has(file)) worker.memory.put(file, '', 'dir')
  }
  if (key === 'statSync') return file => worker.workerActive() ? target.statSync(file) : worker.memory.statSync(file)
  return target[key]
} })
const executeWorker = worker.taskpool.execute.bind(worker.taskpool)
worker.taskpool.execute = (task, priority) => {
  records.push({ type: 'task-submit', request: structuredClone(task.args[2]) })
  return executeWorker(task, priority).then(reply => {
    records.push({ type: 'task-result', reply })
    if (reply.result?.status === 'COMMITTED') {
      const request = task.args[2]
      const appId = request.commit?.pre.appId || request.publication.appId
      const file = '/host-fixture/vera/' + appId + '.state.json'
      const payload = JSON.parse(disk.get(file))
      const decoded = validateStateFile(disk.get(file), appId, 1)
      committedStates.set(JSON.stringify([appId, decoded.vmGeneration, decoded.revision]), { header: decoded, value: payload.value })
      assert.equal(decoded.format, 'FORMAT2')
      assert.equal(decoded.revision, reply.result.revision)
      if (request.commit) {
        assert.equal(decoded.vmGeneration, request.commit.pre.vmGeneration)
        assert.equal(decoded.revision, request.commit.pre.baseRevision + 1)
      } else assert.equal(decoded.vmGeneration, request.publication.nextVmGeneration)
      records.push({ type: request.kind === 'commit' ? 'save' : 'publication', file, payload, result: reply.result })
    }
    return reply
  })
}
const forbidden = name => new Proxy({}, { get(_target, key) {
  throw Error('Forbidden platform access: ' + name + '.' + String(key))
} })
function load(file) {
  file = path.resolve(file)
  if (cache.has(file)) return cache.get(file).exports
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8').replace(/^@Concurrent\s*$/gm, ''), {
    fileName: file.replace(/\.ets$/, '.ts'),
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true },
    reportDiagnostics: true
  })
  const errors = (compiled.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error)
  assert.equal(errors.length, 0, file + ': ' + errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'))
  const module = { exports: {} }
  cache.set(file, module)
  const importer = name => {
    if (name === '@kit.CoreFileKit') return { fileIo: filesystem }
    if (name === '@ohos.fileio') return { default: worker.legacyFilesystem }
    if (name === '@kit.BasicServicesKit') return { systemDateTime: {
      TimeType: { STARTUP: 0 }, getUptime: () => now
    } }
    if (name === '@kit.ArkTS') return { taskpool: worker.taskpool, util: {
      TextEncoder: class { encodeInto(text) { return new TextEncoder().encode(text) } },
      TextDecoder: { create(encoding, options) {
        const decoder = new TextDecoder(encoding, options)
        return { decodeToString: (value, decodeOptions) => decoder.decode(value, decodeOptions) }
      } },
      generateRandomUUID: () => crypto.randomUUID()
    } }
    if (name === '@kit.CryptoArchitectureKit') return { cryptoFramework: { createMd(algorithm) {
      assert.equal(algorithm, 'SHA256')
      const hash = crypto.createHash('sha256')
      return { updateSync({ data }) { hash.update(data) }, digestSync() { return { data: hash.digest() } } }
    } } }
    if (name === '@kit.PerformanceAnalysisKit') return { hilog: forbidden('hilog') }
    if (name.startsWith('@kit.') || name === 'libllama.so') return forbidden(name)
    if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.ets'))
    throw Error('Unsupported dependency: ' + name + ' from ' + file)
  }
  new Function('require', 'module', 'exports', compiled.outputText)(importer, module, module.exports)
  return module.exports
}
const vera = name => load(path.join(root, 'vera', name + '.ets'))
const { InProcessHost, makeRevisionedFrame, makeRevisionedEffect, makeStateSnapshot,
  sameHostPublication } = load(path.join(root, 'runtime/InProcessHost.ets'))
const { compileVeraSource } = vera('VeraCompiler')
const { veraStateStamp } = vera('VeraStateStamp')
const { assembleStateFile, validateStateFile } = load(path.join(root, 'runtime/StateFileFormat.ets'))
const storeModule = vera('ProjectStore')
let store = storeModule.store
store.init('/host-fixture')
const target = 'com.example.host/entry/EntryAbility/Record'
const effect = label => `sdk.call("${target}", ["label", "${label}", "value", ui.numberToString(state.n)], "answered");`
const trap = 'let empty: number[] = []; state.n = empty[2];'
function fixture({ initial = 1, refresh = '', init = '', extraFields = '', extraInit = '' } = {}) {
  return `
@jsonable class AppState {
  n: number;
  calls: number;
  refreshes: number;
  marks: number[];
  badView: boolean;
  ${extraFields}
}
function init(): AppState {
  ${init}
  return {n: ${initial}, calls: 0, refreshes: 0, marks: [], badView: false${extraInit}};
}
function add(state: AppState, value: number): AppState {
  state.n = state.n + value;
  state.calls = state.calls + 1;
  state.marks.push(value);
  return state;
}
function change(state: AppState, value: number): AppState {
  state.n = state.n + value;
  state.calls = state.calls + 1;
  state.marks.push(value);
  ${effect('change')}
  return state;
}
function fail(state: AppState, value: number): AppState {
  state.n = state.n + value;
  state.calls = state.calls + 1;
  state.marks.push(value);
  ${effect('fail')}
  ${trap}
  return state;
}
function breakView(state: AppState, value: number): AppState {
  state.n = state.n + value;
  state.calls = state.calls + 1;
  state.marks.push(value);
  state.badView = true;
  ${effect('breakView')}
  return state;
}
function recover(state: AppState, value: number): AppState {
  state.badView = false;
  state.n = state.n + value;
  state.calls = state.calls + 1;
  state.marks.push(value);
  return state;
}
function answered(state: AppState, answer: string): AppState {
  state.n = state.n + answer.length();
  state.calls = state.calls + 1;
  state.marks.push(answer.length());
  return state;
}
function toggle(state: AppState, value: boolean): AppState {
  if (value) { state.n = state.n + 20; }
  state.calls = state.calls + 1;
  return state;
}
function frameA(state: AppState, ms: number): AppState {
  state.n = state.n + ms;
  state.calls = state.calls + 1;
  state.marks.push(ms);
  ${effect('frameA')}
  return state;
}
function frameB(state: AppState, ms: number): AppState {
  state.n = state.n + ms * 2;
  state.calls = state.calls + 1;
  state.marks.push(0 - ms);
  ${effect('frameB')}
  return state;
}
function pointer(state: AppState, p: gfx.Pointer): AppState {
  state.n = state.n + p.x + p.y + p.id;
  state.calls = state.calls + 1;
  state.marks.push(p.x);
  ${effect('pointer')}
  return state;
}
function pointerFail(state: AppState, p: gfx.Pointer): AppState {
  state.n = state.n + p.x;
  state.calls = state.calls + 1;
  ${effect('pointerFail')}
  ${trap}
  return state;
}
function draw(state: AppState): gfx.Shape[] { return [gfx.circle(state.n, 2, 3, "ink")]; }
function drawOther(state: AppState): gfx.Shape[] { return [gfx.circle(state.n + 1000, 2, 3, "accent")]; }
function drawTrap(state: AppState): gfx.Shape[] {
  let empty: number[] = [];
  return [gfx.circle(empty[2], 2, 3, "ink")];
}
function drawEffect(state: AppState): gfx.Shape[] {
  ${effect('draw')}
  return [gfx.circle(state.n, 2, 3, "ink")];
}
${refresh ? `function widgetRefresh(state: AppState): AppState { ${refresh} return state; }` : ''}
function view(state: AppState): ui.View {
  if (state.badView || state.n < 0) { ${trap} }
  return ui.Text("body", "n=" + ui.numberToString(state.n));
}
`
}
function worldFixture({ build = 'build', refresh = '' } = {}) {
  return fixture({ refresh }).replace('return ui.Text("body", "n=" + ui.numberToString(state.n));', `
    return ui.AppTheme("clean", "", [ui.Text("body", "world"),
      ui.Column("default", [ui.World("default", 0, "${build}", "worldEvent")]),
      ui.World("default", 0, "buildOther", "worldEvent")]);`) + `
function build(state: AppState): scene.Thing[] {
  if (state.n > 20) { ${trap} }
  return [scene.floor("ink"), scene.box("body", state.n, 2, 3, 1, 2, 3, "accent")];
}
function buildOther(state: AppState): scene.Thing[] {
  return [scene.sphere("other", state.n + 100, 2, 3, 1, "ink")];
}
function buildTrap(state: AppState): scene.Thing[] {
  ${trap}
  return [];
}
function buildInvalid(state: AppState): scene.Thing[] {
  return [scene.floor("ink"), scene.floor("accent")];
}
function worldEvent(state: AppState, e: scene.Event): AppState {
  if (e.kind === "hit" && e.body === "body" && e.other === "other" && e.bodies[0] === "body") {
    state.n = state.n + e.speed;
    state.calls = state.calls + 1;
    state.marks.push(e.x);
    state.marks.push(e.y);
    state.marks.push(e.z);
    state.marks.push(e.values[0]);
    state.marks.push(e.dx);
    state.marks.push(e.dy);
    state.marks.push(e.dz);
  }
  return state;
}
function worldNoop(state: AppState, e: scene.Event): AppState {
  ${effect('worldNoop')}
  return state;
}
function worldFail(state: AppState, e: scene.Event): AppState {
  ${effect('worldFail')}
  ${trap}
  return state;
}
`
}
function compile(source) {
  try {
    const { vbc2 } = compileVeraSource(source)
    return { vbc2, stamp: veraStateStamp(vbc2) }
  } catch (error) {
    if (error.diagnostics) error.message += '\n' + JSON.stringify(error.diagnostics)
    throw error
  }
}
const programs = {
  basic: compile(fixture()),
  world: compile(worldFixture()),
  worldRefreshed: compile(worldFixture({ refresh: 'state.n = state.n + 1;' })),
  worldTrap: compile(worldFixture({ build: 'buildTrap' })),
  worldInvalid: compile(worldFixture({ build: 'buildInvalid' })),
  newer: compile(fixture({ initial: 5, extraFields: 'added: number;', extraInit: ', added: 42' })),
  refreshed: compile(fixture({ refresh: `state.n = state.n + 10; state.refreshes = state.refreshes + 1; ${effect('refresh')}` })),
  initTrap: compile(fixture({ init: 'let empty: number[] = []; let n: number = empty[2];' })),
  initEffect: compile(fixture({ init: `sdk.call("${target}", [], "answered");` })),
  initialViewTrap: compile(fixture({ initial: -1, refresh: `state.n = 100; ${effect('refresh')}` })),
  refreshViewTrap: compile(fixture({ refresh: `state.n = state.n + 10; state.refreshes = state.refreshes + 1; state.badView = true; ${effect('refresh')}` }))
}
function unpack(value) {
  assert(Array.isArray(value), 'snapshots use VM tagged tuples')
  switch (value[0]) {
    case 'n': assert.equal(typeof value[1], 'number'); return value[1]
    case 's': assert.equal(typeof value[1], 'string'); return value[1]
    case 'b': assert.equal(typeof value[1], 'boolean'); return value[1]
    case 'z': return null
    case 'a': return value[1].map(unpack)
    case 'o': return Object.fromEntries(value[2].map(([key, item]) => [key, unpack(item)]))
    default: assert.fail('unknown snapshot tag: ' + value[0])
  }
}
const stateOf = encoded => unpack(JSON.parse(encoded))
function encoded(n = 1, changes = {}) {
  const value = { n, calls: 0, refreshes: 0, marks: [], badView: false, ...changes }
  const pack = item => Array.isArray(item) ? ['a', item.map(pack)] :
    [typeof item === 'number' ? 'n' : typeof item === 'boolean' ? 'b' : 's', item]
  return JSON.stringify(['o', 'AppState', Object.entries(value).map(([key, item]) => [key, pack(item)])])
}
const options = (mode = 'LIVE_EPHEMERAL', persistKey = '', seedState = '') => ({ mode, persistKey, seedState })
const persistent = (key = 'project/version', seed = '') => options('LIVE_PERSISTENT', key, seed)
const stateFile = (key = 'project/version') => '/host-fixture/vera/' + key + '.state.json'
function external(program, value, key = 'project/version') {
  const previous = disk.has(stateFile(key)) ? JSON.parse(disk.get(stateFile(key))) : null
  disk.set(stateFile(key), assembleStateFile({ appId: key, schemaVersion: 1,
    vmGeneration: previous?.vmGeneration || 1, revision: (previous?.revision || 0) + 1,
    stamp: program.stamp }, value))
}
function host(factory = null) {
  const h = new InProcessHost(() => now, factory)
  hosts.push(h)
  return h
}
function probe() {
  const p = { frames: [], snapshots: [], effects: [], errors: [], saved: [], handles: [], writable: 0, flushes: 0,
    frameHook: null, errorHook: null, effectHook: null, writableHook: null }
  const invoke = (hook, ...args) => {
    if (!p[hook]) return
    try { p[hook](...args) } catch (error) { callbackErrors.push(error) }
  }
  p.subscriber = {
    onViewFrame(frame) {
      p.frames.push(frame)
      records.push({ type: 'frame', frame })
      invoke('frameHook', frame)
    },
    onError(kind, message, inputSeq) {
      const error = { kind, message, inputSeq }
      p.errors.push(error)
      records.push({ type: 'error', ...error })
      invoke('errorHook', error)
    },
    onStateSnapshot(value, snapshot) {
      try {
        stateOf(value)
        assert.equal(snapshot.encoded, value)
        assert(['LIVE_PERSISTENT', 'LIVE_EPHEMERAL'].includes(snapshot.runtimeMode))
        if (snapshot.runtimeMode === 'LIVE_PERSISTENT') {
          const committed = committedStates.get(JSON.stringify([snapshot.appId, snapshot.vmGeneration, snapshot.stateRevision]))
          assert(committed, 'snapshot must identify a confirmed durable publication')
          assert.equal(committed.header.vmGeneration, snapshot.vmGeneration)
          assert.equal(committed.header.revision, snapshot.stateRevision)
          assert.deepEqual(committed.value, JSON.parse(value))
        } else assert.equal(snapshot.stateRevision, 0)
        p.snapshots.push(value)
        records.push({ type: 'snapshot', value, snapshot })
      } catch (error) { callbackErrors.push(error) }
    },
    onStateSaved(projectId) {
      p.saved.push(projectId)
      records.push({ type: 'saved', projectId })
    },
    onEffectRequest(effect) {
      p.effects.push(effect)
      records.push({ type: 'effect', effect })
      invoke('effectHook', effect)
    },
    onActorHandle(handle) { p.handles.push(handle) },
    flushPendingInputFor() { p.flushes++ },
    onMailboxWritable() {
      p.writable++
      records.push({ type: 'writable' })
      invoke('writableHook')
    }
  }
  p.reset = () => {
    p.frames.length = 0
    p.snapshots.length = 0
    p.effects.length = 0
    p.errors.length = 0
    p.saved.length = 0
    p.writable = 0
    records.length = 0
  }
  return p
}
function watch(promise) {
  const result = { done: false, value: undefined, error: null }
  result.promise = Promise.resolve(promise).then(value => {
    result.done = true
    result.value = value
  }, error => {
    result.done = true
    result.error = error
  })
  return result
}
function nextDue(limit = now) {
  return [...timers.entries()].filter(([, timer]) => timer.at <= limit)
    .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
}
function runTimer(limit = now) {
  const due = nextDue(limit)
  if (!due) return false
  timers.delete(due[0])
  now = Math.max(now, due[1].at)
  due[1].callback(...due[1].args)
  return true
}
function flush() {
  let turns = 0
  while (nextDue()) {
    assert(++turns < 5000, 'fake timer drain must terminate')
    runTimer()
  }
}
function advance(ms) {
  const targetTime = now + ms
  let turns = 0
  while (nextDue(targetTime)) {
    assert(++turns < 5000, 'fake timer advance must terminate')
    runTimer(targetTime)
  }
  now = Math.max(now, targetTime)
}
async function outcome(value) {
  const result = value && value.promise ? value : watch(value)
  for (let turns = 0; !result.done && turns < 5000; turns++) {
    await Promise.resolve()
    if (!result.done) runTimer()
  }
  assert(result.done, 'operation did not settle within bounded fake drain')
  return result
}
async function finish(value) {
  const result = await outcome(value)
  if (result.error) throw result.error
  return result.value
}
async function rejects(value, code) {
  const result = await outcome(value)
  assert(result.error instanceof Error, 'expected rejected operation')
  if (code) assert.equal(result.error.code, code)
  return result.error
}
async function acquire(h, p, program = programs.basic, config = options(), id = '') {
  const handle = await finish(h.acquire(id, program, config, p.subscriber))
  await finish(h.whenIdle())
  return handle
}
const payload = (kind = 'NUMBER', num = 0, extra = {}) => ({ kind, num, str: '', bool: false, phase: 'move', id: 0, x: 0, y: 0, ...extra })
function input(handle, action = 'add', value = 0, extra = {}) {
  return { appId: handle.appId, vmGeneration: handle.vmGeneration, kind: 'HANDLER', action,
    payload: payload('NUMBER', value), persist: false, draws: [], ...extra }
}
const post = (h, handle, action = 'add', value = 0, extra = {}) => h.postInput(handle, input(handle, action, value, extra))
const tick = (tickerId, elapsed, action = 'add') => ({ tickerId, action, elapsed })
const draw = (nodeId = 1, entry = 'draw', surfaceRevision = 1) => ({ nodeId, entry, surfaceRevision })
const surface = (elapsed = 16, actions = ['frameA'], draws = [draw()]) => ({ elapsed, actions, draws })
const markedSurface = (loopStartedAt, ...args) => ({ ...surface(...args), loopStartedAt })
const sceneEvent = (extra = {}) => ({ kind: 'hit', body: 'body', other: 'other',
  x: 1, y: 2, z: 3, speed: 4, bodies: ['body'], values: [6], ...extra })
const sceneInput = (handle, scene = sceneEvent(), extra = {}) => input(handle, 'worldEvent', 0, {
  kind: 'SCENE', payload: payload('SCENE', 0, { scene }), skipIfSame: true, ...extra
})
const worldFrame = (extra = {}) => ({ elapsed: 0, actions: [], draws: [], worldOnly: true, ...extra })
function assertScenes(frame, n) {
  assert.notEqual(frame.view, null)
  const nodes = []
  const visit = node => { nodes.push(node); node.children.forEach(visit) }
  visit(frame.view)
  assert.deepEqual(nodes.map(node => node.id), nodes.map((_, index) => index + 1))
  assert.deepEqual(frame.scenes.map(scene => scene.nodeId), nodes.filter(node => node.kind === 'world').map(node => node.id))
  assert.deepEqual(frame.scenes.map(scene => scene.nodeId), [4, 5])
  assert.deepEqual(frame.scenes.map(scene => scene.spec.bodies[0].position[0]), [n, n + 100])
  assert(frame.scenes.every(scene => Object.getPrototypeOf(scene.spec) === Object.prototype))
}
const accepted = result => { assert.equal(result.status, 'ACCEPTED'); return result.inputSeq }
const coalesced = result => assert.equal(result.status, 'COALESCED')
const rejected = result => assert.equal(result.status, 'REJECTED')
const pressure = result => assert.equal(result.status, 'BACKPRESSURE')
const count = type => records.filter(record => record.type === type).length
const ioCount = () => records.filter(record => ['load-attempt', 'load', 'save-attempt', 'save'].includes(record.type)).length
const sequence = () => records.filter(record => ['snapshot', 'frame', 'save', 'saved', 'effect', 'error'].includes(record.type)).map(record => record.type)
const latest = p => p.frames[p.frames.length - 1]
const snapshot = async (h, handle) => stateOf(await finish(h.requestSnapshot(handle)))
async function queued(h, handle, p, run) {
  assert.equal(p.frameHook, null)
  const delivered = deferred()
  p.frameHook = () => {
    p.frameHook = null
    try { run(); delivered.resolve() } catch (error) { delivered.reject(error) }
  }
  accepted(h.requestView(handle))
  await finish(delivered.promise)
  if (callbackErrors.length) throw callbackErrors.shift()
}
const tests = []
function test(name, run) { tests.push({ name, run }) }

test('first frames and complete refresh arrive before asynchronous acquire resolves', async () => {
  const h = host(), p = probe()
  const pending = watch(h.acquire('', programs.refreshed, persistent(), p.subscriber))
  p.frameHook = () => assert.equal(pending.done, false)
  assert.equal(pending.done, false)
  assert.equal(p.frames.length, 0)
  const handle = await finish(pending)
  p.frameHook = null
  assert.deepEqual(p.frames.map(frame => frame.view.text), ['n=1', 'n=11'])
  assert.deepEqual(sequence(), ['save', 'snapshot', 'saved', 'frame', 'save', 'snapshot', 'effect', 'saved', 'frame'])
  assert.equal(count('task-submit'), count('task-result'))
  assert.equal(handle.appId, 'project/version')
  assert.equal((await snapshot(h, handle)).refreshes, 1)
  assert(p.frames.every(frame => !frame.reveal))
})

test('generated preview and ephemeral IDs are independent; persistent registry shares only its key', async () => {
  const h = host(), p = probe()
  const handles = []
  for (const mode of ['PREVIEW', 'PREVIEW', 'LIVE_EPHEMERAL', 'LIVE_EPHEMERAL']) {
    handles.push(await acquire(h, p, programs.basic, options(mode)))
  }
  assert.equal(new Set(handles.map(handle => handle.appId)).size, 4)
  assert(handles.slice(0, 2).every(handle => handle.appId.startsWith('preview:')))
  assert(handles.slice(2).every(handle => handle.appId.startsWith('live:')))
  const a = await acquire(h, p, programs.basic, persistent('one/v'))
  const b = await acquire(h, p, programs.basic, persistent('two/v'))
  accepted(post(h, a, 'add', 5))
  assert.equal((await snapshot(h, a)).n, 6)
  assert.equal((await snapshot(h, b)).n, 1)
})

test('preview ignores nonempty persistence key and seed, rejects every live producer', async () => {
  const h = host(), p = probe()
  external(programs.refreshed, encoded(99))
  const a = await acquire(h, p, programs.refreshed, options('PREVIEW', 'project/version', encoded(88)))
  assert.equal(latest(p).view.text, 'n=1')
  assert.equal(ioCount(), 0)
  assert.equal(p.snapshots.length + p.effects.length + p.saved.length, 0)
  for (const result of [post(h, a), h.postTick(a, tick('t', 3), false), h.postTick(a, tick('t', 3), true),
    h.postSurfaceFrame(a, surface()), h.postRefresh(a, 'APP'), h.postEffectResult(a, 1, 'ok')]) rejected(result)
  accepted(h.requestDraw(a, [draw()]))
  await rejects(h.requestSnapshot(a), 'INVALID_HANDLE')
  accepted(h.requestView(a))
  await finish(h.release(a, { saveState: true }))
  assert.equal(ioCount(), 0)
})

test('ephemeral carries seed and refreshes/effects without ProjectStore IO', async () => {
  const h = host(), p = probe()
  const a = await acquire(h, p, programs.refreshed, options('LIVE_EPHEMERAL', 'ignored/key', encoded(7)))
  assert.equal((await snapshot(h, a)).n, 17)
  accepted(post(h, a, 'change', 2, { persist: true }))
  accepted(h.postEffectResult(a, p.effects[p.effects.length - 1].effectId, 'ok'))
  accepted(h.postSurfaceFrame(a, surface()))
  await finish(h.release(a, { saveState: true }))
  assert.equal(ioCount(), 0)
  assert.equal(p.saved.length, 0)
})

test('persistent saved state precedes seed; mismatched stamps carry valid seeds and malformed seeds reject', async () => {
  const h = host(), p = probe()
  external(programs.basic, encoded(40))
  const a = await acquire(h, p, programs.basic, persistent('project/version', encoded(9)))
  assert.equal((await snapshot(h, a)).n, 40)
  assert.equal(latest(p).view.text, 'n=40')
  await rejects(h.acquire('', programs.newer, persistent('other/v', '{broken'), p.subscriber), 'ACTOR_NOT_READY')
  assert.equal(disk.has(stateFile('other/v')), false)
  assert.equal(p.errors.at(-1).kind, 'carry')
  external(programs.basic, encoded(70), 'third/v')
  const c = await acquire(h, p, programs.newer, persistent('third/v', encoded(8)))
  assert.equal((await snapshot(h, c)).n, 8)
})

for (const name of ['initTrap', 'initEffect', 'empty', 'bad']) {
  test(name + ' initialization obeys live effect admission and rejects invalid execution without publication', async () => {
    const h = host(), p = probe()
    const program = programs[name] || { vbc2: name === 'empty' ? '' : 'not-bytecode', stamp: name }
    if (name === 'initEffect') {
      const a = await acquire(h, p, program, persistent())
      assert.equal((await snapshot(h, a)).n, 1)
      assert.deepEqual(sequence(), ['save', 'snapshot', 'effect', 'saved', 'frame'])
      assert.equal(p.effects.length, 1)
      assert.equal(p.effects[0].stateRevision, latest(p).stateRevision)
      assert.equal(count('task-submit'), count('task-result'))
      p.reset()
      await rejects(h.acquire('', program, options('PREVIEW'), p.subscriber), 'ACTOR_NOT_READY')
      assert.equal(p.frames.length + p.snapshots.length + p.effects.length + count('save'), 0)
    } else {
      await rejects(h.acquire('', program, options(), p.subscriber), 'ACTOR_NOT_READY')
      assert.equal(p.frames.length + p.snapshots.length + p.effects.length + p.saved.length, 0)
      assert.equal(count('save'), 0)
      if (name !== 'empty') assert.equal(p.errors[0].kind, 'init')
    }
  })
}

test('same subscriber concurrent acquires have independent leases; conflicts leave originals usable', async () => {
  const h = host(), p = probe(), other = probe()
  const pa = h.acquire('', programs.basic, persistent(), p.subscriber)
  const pb = h.acquire('project/version', programs.basic, persistent(), p.subscriber)
  const a = await finish(pa), b = await finish(pb)
  assert.equal(a.appId, b.appId)
  assert.notEqual(a.leaseId, b.leaseId)
  await rejects(h.acquire(a.appId, programs.basic, persistent(), other.subscriber), 'SUBSCRIBER_CONFLICT')
  await rejects(h.acquire(a.appId, programs.newer, persistent(), p.subscriber), 'APP_ID_CONFLICT')
  accepted(post(h, a, 'add', 2))
  assert.equal((await snapshot(h, b)).n, 3)
  await finish(h.release(a))
  rejected(post(h, a))
  accepted(post(h, b, 'add', 3))
  assert.equal((await snapshot(h, b)).n, 6)
})

test('acquire rejects inconsistent persistent identities and empty keys', async () => {
  const h = host(), p = probe()
  await rejects(h.acquire('different/v', programs.basic, persistent(), p.subscriber), 'APP_ID_CONFLICT')
  await rejects(h.acquire('', programs.basic, persistent(''), p.subscriber), 'APP_ID_CONFLICT')
  assert.equal(p.frames.length, 0)
})

test('promote and replace require exclusive lease, including execution-time recheck', async () => {
  const h = host(), p = probe()
  const a = await acquire(h, p, programs.basic, persistent())
  const b = await acquire(h, p, programs.basic, persistent(), a.appId)
  await rejects(h.promote(a, 'LIVE_EPHEMERAL', ''), 'LEASE_CONFLICT')
  await rejects(h.replaceProgram(a, programs.newer, options()), 'LEASE_CONFLICT')
  accepted(post(h, b, 'add', 2))
  assert.equal((await snapshot(h, a)).n, 3)
  await finish(h.release(b))
  let attach, replace
  await queued(h, a, p, () => {
    attach = watch(h.acquire(a.appId, programs.basic, persistent(), p.subscriber))
    replace = watch(h.replaceProgram(a, programs.newer, persistent()))
  })
  const c = await finish(attach)
  await rejects(replace, 'LEASE_CONFLICT')
  accepted(post(h, c))
})

test('promote preserves VM, publishes target generation and carried state, and refreshes preview activation once', async () => {
  for (const mode of ['LIVE_PERSISTENT', 'LIVE_EPHEMERAL']) {
    const h = host(), p = probe()
    const old = await acquire(h, p, programs.refreshed, options('PREVIEW'))
    const actor = h.registry.get(old.appId).actor
    external(programs.refreshed, encoded(90))
    p.reset()
    const a = await finish(h.promote(old, mode, mode === 'LIVE_PERSISTENT' ? 'project/version' : ''))
    assert.equal(a.vmGeneration, old.vmGeneration + 1)
    assert.equal(a.leaseId, old.leaseId)
    assert.equal(h.registry.get(a.appId).actor, actor)
    if (mode === 'LIVE_PERSISTENT') assert.equal(a.appId, 'project/version')
    assert.notStrictEqual(a, old)
    assert.equal((await snapshot(h, a)).n, 11)
    assert.equal((await snapshot(h, a)).refreshes, 1)
    assert.equal(count('load-attempt') > 0, mode === 'LIVE_PERSISTENT')
    assert.equal(count('save'), mode === 'LIVE_PERSISTENT' ? 2 : 0)
    assert.equal(count('publication'), mode === 'LIVE_PERSISTENT' ? 1 : 0)
    assert.equal(count('task-submit'), count('task-result'))
    assert.deepEqual(sequence(), mode === 'LIVE_PERSISTENT' ?
      ['save', 'snapshot', 'saved', 'frame', 'save', 'snapshot', 'effect', 'saved', 'frame'] :
      ['snapshot', 'frame', 'snapshot', 'effect', 'frame'])
    assert.deepEqual(p.frames.map(frame => frame.view.text), ['n=1', 'n=11'])
    assert.equal(p.effects.length, 1)
    assert.equal(p.effects[0].appId, a.appId)
    assert.equal(p.effects[0].vmGeneration, a.vmGeneration)
    rejected(post(h, old))
    await rejects(h.requestSnapshot(old), 'INVALID_HANDLE')
    const frames = p.frames.length
    let same = await finish(h.promote(a, mode, mode === 'LIVE_PERSISTENT' ? 'project/version' : ''))
    assert.equal(p.frames.length, frames)
    for (const key of ['promoted/other', '']) {
      const existing = key && disk.has(stateFile(key))
      p.reset()
      same = await finish(h.promote(same, key ? 'LIVE_PERSISTENT' : 'LIVE_EPHEMERAL', key))
      assert.equal((await snapshot(h, same)).refreshes, 1)
      assert.equal((await snapshot(h, same)).n, 11)
      assert.equal(count('task-submit'), count('task-result'))
      assert.equal(count('save'), key && !existing ? 1 : 0)
      assert.equal(count('publication'), existing ? 1 : 0)
      assert.equal(h.registry.get(same.appId).actor, actor)
      assert.equal(p.effects.length, 0)
    }
    accepted(post(h, same, 'add', 2))
    assert.equal((await snapshot(h, same)).n, 13)
  }
  const h = host(), p = probe(), old = await acquire(h, p, programs.refreshed, options('PREVIEW'))
  const actor = h.registry.get(old.appId).actor, view = actor.view
  actor.view = () => null
  p.reset()
  await rejects(h.promote(old, 'LIVE_PERSISTENT', 'failed-promotion/version'), 'ACTOR_NOT_READY')
  assert.equal(count('save'), 1)
  assert.equal(count('task-submit'), count('task-result'))
  assert.equal(p.effects.length, 0)
  assert.equal(p.frames.length, 0)
  assert.equal(actor.ready(), false)
  rejected(post(h, old))
  actor.view = view
  p.reset()
  const retried = await acquire(h, p, programs.refreshed, persistent('failed-promotion/version'))
  assert.equal((await snapshot(h, retried)).refreshes, 1)
  assert.equal(p.effects.length, 1)
  assert.equal(count('publication'), 1)
  assert.equal(count('save'), 1)
})

test('replace changes generation, installs target config before init and fences old inputs/effects', async () => {
  const h = host(), p = probe()
  const old = await acquire(h, p)
  accepted(post(h, old, 'change', 1))
  await finish(h.whenIdle())
  const effectId = p.effects[0].effectId
  external(programs.newer, encoded(60, { added: 42 }))
  p.reset()
  const a = await finish(h.replaceProgram(old, programs.newer, persistent()))
  assert.equal(a.vmGeneration, old.vmGeneration + 1)
  assert.equal(a.appId, 'project/version')
  assert.equal(latest(p).view.text, 'n=60')
  assert.equal((await snapshot(h, a)).n, 60)
  rejected(post(h, old))
  rejected(h.postEffectResult(old, effectId, 'ok'))
  rejected(h.postEffectResult(a, effectId, 'ok'))
  rejected(h.postInput(a, input(old, 'add', 99)))
  accepted(post(h, a, 'add', 2, { persist: true }))
  assert.equal(JSON.parse(disk.get(stateFile())).stamp, programs.newer.stamp)
})

for (const operation of ['promote', 'replace']) {
  test(operation + ' target conflict leaves source/target registry, handles and state unchanged', async () => {
    const h = host(), p = probe(), q = probe()
    const a = await acquire(h, p)
    const b = await acquire(h, q, programs.basic, persistent('taken/v'))
    accepted(post(h, a, 'add', 3))
    const op = operation === 'promote' ? h.promote(a, 'LIVE_PERSISTENT', 'taken/v') : h.replaceProgram(a, programs.newer, persistent('taken/v'))
    await rejects(op, 'APP_ID_CONFLICT')
    assert.equal((await snapshot(h, a)).n, 4)
    assert.equal((await snapshot(h, b)).n, 1)
    const a2 = await acquire(h, p, programs.basic, options(), a.appId)
    accepted(post(h, a2, 'add', 2))
    assert.equal((await snapshot(h, a)).n, 6)
  })
}

for (const saved of [false, true]) {
  test('promote/replace watcher orders preserve explicit carry versus saved-state precedence, saved=' + saved, async () => {
    const results = []
    for (const order of ['promote-first', 'replace-first']) {
      const h = host(), p = probe(), key = order + '/v'
      if (saved) external(programs.newer, encoded(74, { added: 42 }), key)
      let a = await acquire(h, p, programs.basic, options('PREVIEW'))
      if (order === 'promote-first') a = await finish(h.promote(a, 'LIVE_PERSISTENT', key))
      a = await finish(h.replaceProgram(a, programs.newer, persistent(key, encoded(8))))
      const before = p.frames.length
      a = await finish(h.promote(a, 'LIVE_PERSISTENT', key))
      assert.equal(p.frames.length, before)
      const state = await snapshot(h, a)
      assert.equal(state.n, saved && order === 'replace-first' ? 74 : 8)
      accepted(h.postTick(a, tick('t', 2), true))
      accepted(h.postSurfaceFrame(a, surface(3)))
      accepted(post(h, a, 'add', 1, { persist: true }))
      await finish(h.whenIdle())
      const stored = JSON.parse(disk.get(stateFile(key)))
      assert.equal(stored.stamp, programs.newer.stamp)
      const final = await snapshot(h, a)
      assert.equal(final.n, state.n + 6)
      assert.equal(stateOf(JSON.stringify(stored.value)).n, final.n)
      assert.equal(count('task-submit'), count('task-result'))
      results.push({ state, final, value: stored.value })
    }
    if (!saved) assert.deepEqual(results[0], results[1])
    else assert.equal(results[1].final.n - results[0].final.n, 66)
  })
}

test('mode transitions stop live admission and retain generated identity only within same mode', async () => {
  const h = host(), p = probe()
  const old = await acquire(h, p)
  accepted(post(h, old, 'add', 4))
  const sameMode = await finish(h.replaceProgram(old, programs.newer, options()))
  assert.equal(sameMode.appId, old.appId)
  const preview = await finish(h.promote(sameMode, 'PREVIEW', ''))
  assert(preview.appId.startsWith('preview:'))
  rejected(h.postTick(preview, tick('t', 1), false))
  rejected(h.postSurfaceFrame(preview, surface()))
  const live = await finish(h.promote(preview, 'LIVE_EPHEMERAL', ''))
  assert(live.appId.startsWith('live:'))
  assert.notEqual(live.appId, old.appId)
  assert.equal((await snapshot(h, live)).n, 5)
})

test('serialized replacement discards pending old-generation fields, ticks, draws and snapshot barriers', async () => {
  const h = host(), p = probe(), a = await acquire(h, p)
  let replacement, staleSnapshot
  await queued(h, a, p, () => {
    replacement = watch(h.replaceProgram(a, programs.newer, options()))
    accepted(post(h, a, 'add', 100, { kind: 'FIELD' }))
    accepted(h.postTick(a, tick('t', 100), false))
    accepted(h.requestDraw(a, [draw()]))
    staleSnapshot = watch(h.requestSnapshot(a))
  })
  const b = await finish(replacement)
  await rejects(staleSnapshot, 'INVALID_HANDLE')
  assert.equal((await snapshot(h, b)).n, 5)
  assert.equal((await snapshot(h, b)).calls, 0)
})

test('release waits for queued and coalesced work, then one final save; closing calls share promise', async () => {
  const h = host(), p = probe(), a = await acquire(h, p, programs.basic, persistent())
  let first, second, releasedState, closingSnapshot
  await queued(h, a, p, () => {
    accepted(post(h, a, 'add', 2))
    accepted(h.postTick(a, tick('t', 3), false))
    coalesced(h.postTick(a, tick('t', 4), false))
    accepted(h.requestDraw(a, [draw(1)]))
    accepted(h.requestDraw(a, [draw(2)]))
    coalesced(h.requestDraw(a, [draw(1, 'drawOther'), draw(2, 'drawOther')]))
    first = h.release(a, { saveState: true })
    second = h.release(a, { saveState: false })
    assert.strictEqual(first, second)
    releasedState = watch(first)
    assert.equal(releasedState.done, false)
    rejected(post(h, a, 'add', 100))
    closingSnapshot = watch(h.requestSnapshot(a))
  })
  await finish(releasedState)
  await rejects(closingSnapshot, 'INVALID_HANDLE')
  const saves = records.filter(record => record.type === 'save')
  assert.equal(saves.length, 2)
  assert.equal(stateOf(JSON.stringify(saves[saves.length - 1].payload.value)).n, 10)
  assert.equal(p.saved.length, 2)
  assert.equal(count('task-submit'), count('task-result'))
  assert(records.findLastIndex(record => record.type === 'frame') < records.findLastIndex(record => record.type === 'save'))
  await finish(h.release(a, { saveState: true }))
  assert.equal(count('save'), 2)
})

test('first release policy wins and releasing one lease keeps other-lease work live', async () => {
  const h = host(), p = probe(), a = await acquire(h, p, programs.basic, persistent())
  const b = await acquire(h, p, programs.basic, persistent(), a.appId)
  let release, after, sawFinalSave = false
  p.reset()
  await queued(h, a, p, () => {
    accepted(post(h, a, 'add', 2))
    release = watch(h.release(a, { saveState: false }))
    h.release(a, { saveState: true })
    accepted(post(h, b, 'add', 3))
    after = watch(h.requestSnapshot(b))
  })
  await finish(release)
  assert.equal(count('save'), 0)
  assert.equal(stateOf(await finish(after)).n, 6)
  p.frameHook = () => { sawFinalSave = count('save') > 0; p.frameHook = null }
  accepted(post(h, b, 'add', 4))
  assert.equal(sawFinalSave, false)
  rejected(post(h, a))
  assert.equal((await snapshot(h, b)).n, 10)
})

test('release barrier excludes later work of another active lease across a scheduled yield', async () => {
  const h = host(), p = probe(), a = await acquire(h, p, programs.basic, persistent())
  const b = await acquire(h, p, programs.basic, persistent(), a.appId)
  let release, later
  await queued(h, a, p, () => {
    release = watch(h.release(a))
    accepted(post(h, b, 'add', 3))
    later = watch(h.requestSnapshot(b))
    p.frameHook = () => { now += 8 }
    now += 8
  })
  assert.equal(await finish(release), undefined)
  await Promise.resolve()
  assert.equal(later.done, false, 'release must settle without waiting for other lease snapshot')
  assert.equal(stateOf(await finish(later)).n, 4)
  rejected(post(h, a))
  accepted(post(h, b, 'add', 2))
})

test('nonlast release never final-saves; last save failure rejects after releasing its lease', async () => {
  const h = host(), p = probe(), a = await acquire(h, p, programs.basic, persistent())
  const b = await acquire(h, p, programs.basic, persistent(), a.appId)
  accepted(post(h, a, 'add', 4))
  p.reset()
  failure = 'rename'
  await finish(h.release(a, { saveState: true }))
  assert.equal(count('save-attempt'), 0)
  rejected(post(h, a))
  accepted(post(h, b, 'add', 2))
  assert.equal((await snapshot(h, b)).n, 7)
  const error = await rejects(h.release(b, { saveState: true }))
  assert.equal(error.code, 'STATE_PUBLISH_FAILED')
  assert.equal(count('task-submit'), count('task-result'))
  assert(records.some(record => record.type === 'task-result' && record.reply.result?.status === 'FAILED'))
  assert.equal(p.saved.length, 0)
  rejected(post(h, b))
  assert.equal(h.leases.size, 0)
  failure = ''
  await finish(h.release(a))
  await finish(h.release(b))
  assert.equal(count('save-attempt'), 1)
  assert.equal(h.records.size, 0)
  assert.equal(h.registry.size, 0)
  await finish(h.dispose())
  hosts.splice(hosts.indexOf(h), 1)
})

test('last lease idle reuse retains unsaved state, changes subscriber, cancels destruction', async () => {
  const h = host(), p = probe(), q = probe(), a = await acquire(h, p, programs.basic, persistent())
  accepted(post(h, a, 'add', 8))
  await finish(h.release(a))
  const idleTimer = [...timers.values()].find(timer => timer.at === now + 5000)
  assert(idleTimer)
  rejected(post(h, a))
  advance(4999)
  const b = await acquire(h, q, programs.basic, persistent(), a.appId)
  assert.notEqual(b.leaseId, a.leaseId)
  assert.equal((await snapshot(h, b)).n, 9)
  const before = p.frames.length
  advance(5001)
  accepted(post(h, b, 'add', 1))
  assert.equal(p.frames.length, before)
  assert.equal((await snapshot(h, b)).n, 10)
})

test('idle persistent reopen adopts same-stamp external state before its first snapshot and frame', async () => {
  const h = host(), p = probe(), q = probe(), a = await acquire(h, p, programs.basic, persistent())
  accepted(post(h, a, 'add', 1, { persist: true }))
  await finish(h.release(a))
  external(programs.basic, encoded(99))
  const oldFrames = p.frames.length
  q.reset()
  const b = await acquire(h, q, programs.basic, persistent(), a.appId)
  assert.equal(b.vmGeneration, a.vmGeneration + 1)
  assert.deepEqual(q.snapshots.map(value => stateOf(value).n), [99])
  assert.deepEqual(q.frames.map(frame => frame.view.text), ['n=99'])
  assert.deepEqual(sequence(), ['snapshot', 'frame'])
  assert.equal(count('publication'), 1)
  assert.equal(count('save'), 0)
  assert.equal(count('task-submit'), count('task-result'))
  accepted(post(h, b, 'add', 1, { persist: true }))
  assert.equal((await snapshot(h, b)).n, 100)
  assert.equal(stateOf(await finish(store.loadState('project', 'version', programs.basic.stamp))).n, 100)
  assert.equal(p.frames.length, oldFrames)
})

test('idle reopen keeps unsaved memory when a nonempty saved baseline is unchanged', async () => {
  external(programs.basic, encoded(1))
  const h = host(), p = probe(), a = await acquire(h, p, programs.basic, persistent())
  accepted(post(h, a, 'add', 8))
  await finish(h.release(a))
  const saved = disk.get(stateFile())
  p.reset()
  const b = await acquire(h, p, programs.basic, persistent(), a.appId)
  assert.deepEqual(p.snapshots.map(value => stateOf(value).n), [1], 'only the committed baseline is published')
  assert.deepEqual(p.frames.map(frame => frame.view.text), ['n=9'])
  assert.equal(count('save'), 0)
  assert.equal(disk.get(stateFile()), saved)
  assert.equal((await snapshot(h, b)).n, 9)
})

for (const changed of [false, true]) {
  test('idle reopen refreshes exactly once after first frame, changed disk=' + changed, async () => {
    const h = host(), p = probe(), a = await acquire(h, p, programs.refreshed, persistent())
    accepted(post(h, a, 'add', 5))
    await finish(h.release(a))
    if (changed) external(programs.refreshed, encoded(100))
    p.reset()
    const pending = watch(h.acquire(a.appId, programs.refreshed, persistent(), p.subscriber))
    assert.equal(pending.done, false)
    assert.equal(p.frames.length + p.snapshots.length, 0)
    const b = await finish(pending)
    const before = changed ? 100 : 16
    assert.deepEqual(p.snapshots.map(value => stateOf(value).n), changed ? [before, before + 10] : [11, before + 10])
    assert.deepEqual(p.frames.map(frame => frame.view.text), changed ? ['n=100', 'n=110'] : ['n=16', 'n=26'])
    assert.deepEqual(sequence(), changed ?
      ['snapshot', 'frame', 'save', 'snapshot', 'effect', 'saved', 'frame'] :
      ['snapshot', 'frame', 'save', 'snapshot', 'effect', 'saved', 'frame'])
    assert.equal((await snapshot(h, b)).refreshes, changed ? 1 : 2)
    assert.equal(stateOf(await finish(store.loadState('project', 'version', programs.refreshed.stamp))).n, before + 10)
  })
}

test('active and pending additional leases do not reload disk or duplicate reopen refresh', async () => {
  const h = host(), p = probe(), a = await acquire(h, p, programs.refreshed, persistent())
  external(programs.refreshed, encoded(100))
  p.reset()
  const b = await acquire(h, p, programs.refreshed, persistent(), a.appId)
  assert.deepEqual(p.frames.map(frame => frame.view.text), ['n=11'])
  assert.equal(ioCount(), 0)
  assert.equal(p.effects.length, 0)
  await finish(h.release(a))
  await finish(h.release(b))
  p.reset()
  let first, second
  const trigger = await acquire(h, p, programs.basic, options())
  p.reset()
  await queued(h, trigger, p, () => {
    first = watch(h.acquire(a.appId, programs.refreshed, persistent(), p.subscriber))
    second = watch(h.acquire(a.appId, programs.refreshed, persistent(), p.subscriber))
  })
  const c = await finish(first), d = await finish(second)
  assert.deepEqual(p.frames.slice(1).map(frame => frame.view.text), ['n=100', 'n=110', 'n=110'])
  assert.equal(count('save'), 1)
  assert.equal(p.effects.length, 1)
  assert.equal((await snapshot(h, c)).n, 110)
  assert.equal((await snapshot(h, d)).refreshes, 1)
})

for (const invalid of ['missing', 'malformed', 'wrong-stamp', 'invalid-tuple']) {
  test('idle reopen rejects unsafe ' + invalid + ' disk state without publishing or overwriting it', async () => {
    const h = host(), p = probe(), a = await acquire(h, p, programs.basic, persistent())
    accepted(post(h, a, 'add', 1, { persist: true }))
    accepted(post(h, a, 'add', 3))
    await finish(h.release(a))
    if (invalid === 'missing') disk.delete(stateFile())
    else if (invalid === 'malformed') disk.set(stateFile(), '{broken')
    else if (invalid === 'wrong-stamp') external(programs.newer, encoded(99))
    else disk.set(stateFile(), JSON.stringify({ stamp: programs.basic.stamp, value: ['unknown'] }))
    const saved = disk.get(stateFile())
    p.reset()
    await rejects(h.acquire(a.appId, programs.basic, persistent(), p.subscriber), 'ACTOR_NOT_READY')
    assert.equal(p.snapshots.length + p.frames.length + p.effects.length, 0)
    assert.equal(count('save'), 0)
    assert.equal(count('task-submit'), count('task-result'))
    assert.equal(disk.get(stateFile()), saved)
    assert.equal(h.leases.size, 0)
    const code = invalid === 'missing' || invalid === 'wrong-stamp' ? 'STATE_RECREATE_REQUIRED' : 'STATE_RELOAD_PENDING'
    assert.equal(p.errors.at(-1).message, code)
    assert.equal((await rejects(h.dispose())).code, code)
    hosts.splice(hosts.indexOf(h), 1)
  })
}

test('failed idle reopen first frame does not refresh, save or emit effects and can retry', async () => {
  const h = host(), p = probe(), a = await acquire(h, p, programs.refreshed, persistent())
  await finish(h.release(a))
  external(programs.refreshed, encoded(-1))
  p.reset()
  await rejects(h.acquire(a.appId, programs.refreshed, persistent(), p.subscriber), 'ACTOR_NOT_READY')
  assert.equal(p.frames.length + p.effects.length + p.saved.length + count('save'), 0)
  external(programs.refreshed, encoded(100))
  p.reset()
  const b = await acquire(h, p, programs.refreshed, persistent(), a.appId)
  assert.deepEqual(p.frames.map(frame => frame.view.text), ['n=100', 'n=110'])
  assert.equal((await snapshot(h, b)).n, 110)
})

for (const mode of ['PREVIEW', 'LIVE_EPHEMERAL']) {
  test('idle ' + mode + ' reopen never accesses disk', async () => {
    const h = host(), p = probe(), config = options(mode)
    const a = await acquire(h, p, programs.refreshed, config)
    await finish(h.release(a))
    p.reset()
    const b = await acquire(h, p, programs.refreshed, config, a.appId)
    assert.equal(ioCount(), 0)
    if (mode === 'PREVIEW') {
      assert.deepEqual(p.frames.map(frame => frame.view.text), ['n=1'])
      assert.equal(p.snapshots.length + p.effects.length, 0)
    } else {
      assert.deepEqual(p.frames.map(frame => frame.view.text), ['n=11', 'n=21'])
      assert.equal((await snapshot(h, b)).refreshes, 2)
      assert.equal(p.effects.length, 1)
    }
  })
}

for (const runExpiryTimer of [true, false]) {
  test('5-second idle expiry destroys unsaved state, timer executed=' + runExpiryTimer, async () => {
    const h = host(), p = probe(), a = await acquire(h, p, programs.basic, persistent())
    accepted(post(h, a, 'add', 8))
    await finish(h.release(a))
    if (runExpiryTimer) {
      advance(5000)
      await finish(h.whenIdle())
    } else now += 5000
    const b = await acquire(h, p, programs.basic, persistent(), a.appId)
    assert.equal((await snapshot(h, b)).n, 1)
    rejected(post(h, a))
  })
}

test('incompatible idle stamp is never silently reused', async () => {
  const h = host(), p = probe(), a = await acquire(h, p, programs.basic, persistent())
  accepted(post(h, a, 'add', 8))
  await finish(h.release(a))
  const b = await acquire(h, p, programs.newer, persistent(), a.appId)
  assert.equal((await snapshot(h, b)).n, 5)
  assert.equal((await snapshot(h, b)).added, 42)
})

test('240 noncritical plus 16 critical slots, full coalescing, writable ordered retry and slot-free barrier', async () => {
  const h = host(), p = probe(), a = await acquire(h, p)
  accepted(post(h, a, 'change', 0))
  await finish(h.whenIdle())
  const effectId = p.effects[0].effectId
  p.reset()
  let barrier, retryInput = true, retryEffect = true, retried = [], statuses = []
  p.writableHook = () => {
    if (retryInput) {
      const result = post(h, a, 'add', 900)
      statuses.push(result.status)
      if (result.status === 'ACCEPTED') { retryInput = false; retried.push(result.inputSeq) }
    }
    if (!retryInput && retryEffect) {
      const result = h.postEffectResult(a, effectId, 'ok')
      statuses.push(result.status)
      if (result.status === 'ACCEPTED') { retryEffect = false; retried.push(result.inputSeq) }
    }
  }
  await queued(h, a, p, () => {
    for (let i = 0; i < 239; i++) accepted(post(h, a, 'add', 1))
    accepted(h.postTick(a, tick('fast', 2), false))
    pressure(post(h, a, 'add', 900))
    for (let i = 0; i < 16; i++) {
      const result = h.postRefresh(a, 'APP')
      accepted(result)
      assert.equal(result.inputSeq, undefined)
    }
    pressure(h.postRefresh(a, 'APP'))
    pressure(h.postEffectResult(a, effectId, 'ok'))
    barrier = watch(h.requestSnapshot(a))
    assert.equal(p.snapshots.length, 0)
  })
  const atBarrier = stateOf(await finish(barrier))
  flush()
  assert.equal(atBarrier.n, 242)
  assert.equal(retryInput || retryEffect, false)
  assert.equal(retried.length, 2)
  assert(retried[0] < retried[1])
  assert(p.writable > 0)
  assert.equal((await snapshot(h, a)).n, 1144)
  assert.equal((await snapshot(h, a)).calls, 243)
  assert.equal(p.flushes, 0)
  rejected(h.postEffectResult(a, effectId, 'duplicate'))
})

test('eligible coalescing updates succeed at capacity but distinct keys get backpressure', async () => {
  const h = host(), p = probe(), a = await acquire(h, p)
  let barrier
  await queued(h, a, p, () => {
    for (let i = 0; i < 239; i++) accepted(post(h, a, 'add', 1))
    accepted(h.postTick(a, tick('t', 2), false))
    coalesced(h.postTick(a, tick('t', 3), false))
    pressure(h.postTick(a, tick('other', 100), false))
    pressure(h.requestView(a))
    barrier = watch(h.requestSnapshot(a))
  })
  assert.equal(stateOf(await finish(barrier)).n, 245)
})

test('effect results use critical reserve, preserve input order and never deliver twice', async () => {
  const h = host(), p = probe(), a = await acquire(h, p)
  accepted(post(h, a, 'change', 0))
  await finish(h.whenIdle())
  const id = p.effects[0].effectId
  let result, barrier
  await queued(h, a, p, () => {
    for (let i = 0; i < 240; i++) accepted(post(h, a, 'add', 1))
    result = h.postEffectResult(a, id, 'declined by the person')
    accepted(result)
    rejected(h.postEffectResult(a, id, 'duplicate'))
    barrier = watch(h.requestSnapshot(a))
  })
  const state = stateOf(await finish(barrier))
  assert.equal(state.n, 241 + 'declined by the person'.length)
  assert.equal(state.calls, 242)
  assert.equal(latest(p).appliedSeq, result.inputSeq)
  assert.equal(p.flushes, 0)
})

test('input, slow tick, effect result share monotonic seq; fast ticks, refresh and draw do not advance it', async () => {
  const h = host(), p = probe(), a = await acquire(h, p)
  accepted(post(h, a, 'change', 0))
  await finish(h.whenIdle())
  const id = p.effects[0].effectId
  p.reset()
  const seqs = []
  await queued(h, a, p, () => {
    seqs.push(accepted(post(h, a, 'add', 2)))
    seqs.push(accepted(h.postTick(a, tick('slow', 3), true)))
    seqs.push(accepted(post(h, a, 'add', 4, { kind: 'FIELD' })))
    seqs.push(accepted(h.postEffectResult(a, id, 'ok')))
    assert.equal(accepted(h.postTick(a, tick('fast', 5), false)), undefined)
    assert.equal(accepted(h.postRefresh(a, 'APP')), undefined)
    assert.equal(accepted(h.requestDraw(a, [draw()])), undefined)
  })
  assert.deepEqual(seqs, [2, 3, 4, 5])
  assert.deepEqual((await snapshot(h, a)).marks, [0, 2, 3, 4, 2, 5])
  assert.deepEqual(p.frames.map(frame => frame.appliedSeq), [1, 2, 3, 4, 5, 5, 5, 5])
  assert.deepEqual(p.frames.map(frame => frame.frameSeq), p.frames.map((_, i) => i + 3))
  assert(p.frames.slice(1, 6).every(frame => frame.reveal))
})

test('critical APP_RESUME preserves external Form update and fences later old-generation input', async () => {
  const h = host(), p = probe(), a = await acquire(h, p, programs.basic, persistent())
  external(programs.basic, encoded(50))
  p.reset()
  await queued(h, a, p, () => {
    accepted(post(h, a, 'add', 2))
    accepted(h.postRefresh(a, 'APP'))
    accepted(post(h, a, 'add', 3))
  })
  await finish(h.whenIdle())
  assert.deepEqual(p.frames.map(frame => frame.view.text), ['n=1', 'n=3', 'n=50'])
  const renewed = p.handles[p.handles.length - 1]
  assert.equal(renewed.leaseId, a.leaseId)
  assert.equal(renewed.vmGeneration, a.vmGeneration + 1)
  rejected(post(h, a, 'add', 3))
  assert.equal((await snapshot(h, renewed)).n, 50)
  accepted(post(h, renewed, 'add', 3))
  await finish(h.whenIdle())
  assert.equal(latest(p).view.text, 'n=53')
  assert.equal((await snapshot(h, renewed)).n, 53)
  assert.equal(count('save'), 0)
  assert.equal(count('publication'), 1)
  assert.equal(count('task-submit'), count('task-result'))
  assert.equal(stateOf(JSON.stringify(JSON.parse(disk.get(stateFile())).value)).n, 50)
})

test('reentrant frame callback posts enqueue non-recursively after async admission returns', async () => {
  const h = host(), p = probe(), a = await acquire(h, p)
  let depth = 0, maxDepth = 0, returned = false, nestedResult
  p.frameHook = frame => {
    depth++
    maxDepth = Math.max(maxDepth, depth)
    assert.equal(returned, true)
    if (frame.view.text === 'n=3') {
      const before = p.frames.length
      nestedResult = post(h, a, 'add', 4)
      assert.equal(p.frames.length, before)
    }
    depth--
  }
  accepted(post(h, a, 'add', 2))
  assert.equal(p.frames.length, 1)
  returned = true
  await finish(h.whenIdle())
  p.frameHook = null
  accepted(nestedResult)
  assert.equal(maxDepth, 1)
  assert.equal(latest(p).view.text, 'n=7')
  assert.equal((await snapshot(h, a)).calls, 2)
})

test('8ms budget yields with setTimeout zero and different actors drain fairly', async () => {
  const h = host(), p = probe(), q = probe()
  const a = await acquire(h, p), b = await acquire(h, q)
  const order = []
  let added = false
  p.frameHook = frame => {
    order.push('a:' + frame.view.text)
    now += 4
    if (!added) {
      added = true
      for (let i = 0; i < 6; i++) accepted(post(h, a, 'add', 1))
      accepted(post(h, b, 'add', 20))
    }
  }
  q.frameHook = frame => { order.push('b:' + frame.view.text); now += 4 }
  accepted(post(h, a, 'add', 1))
  assert.equal(order.length, 0)
  await until(() => order.length >= 2)
  assert.equal(order[1], 'b:n=21')
  await finish(h.whenIdle())
  p.frameHook = q.frameHook = null
  assert.equal(order.length, 8)
  assert.equal((await snapshot(h, a)).n, 8)
  assert.equal((await snapshot(h, b)).n, 21)
})

test('fast tick elapsed sums only by ticker ID; same action on independent tickers executes separately', async () => {
  const h = host(), p = probe(), a = await acquire(h, p)
  await queued(h, a, p, () => {
    accepted(h.postTick(a, tick('A', 2), false))
    accepted(h.postTick(a, tick('B', 7), false))
    coalesced(h.postTick(a, tick('A', 3), false))
  })
  assert.deepEqual((await snapshot(h, a)).marks, [5, 7])
  assert.equal((await snapshot(h, a)).calls, 2)
  const before = (await snapshot(h, a)).calls
  accepted(h.postTick(a, tick('A', 1), false))
  accepted(h.postTick(a, tick('A', 1), false))
  assert.equal((await snapshot(h, a)).calls, before + 2)
})

test('coalescing is lease-scoped even when ticker, view and draw keys match', async () => {
  const h = host(), p = probe(), a = await acquire(h, p, programs.basic, persistent())
  const b = await acquire(h, p, programs.basic, persistent(), a.appId)
  p.reset()
  await queued(h, a, p, () => {
    accepted(h.postTick(a, tick('same', 2), false))
    accepted(h.postTick(b, tick('same', 3), false))
    coalesced(h.postTick(a, tick('same', 4), false))
    accepted(h.requestView(a))
    accepted(h.requestView(b))
    accepted(h.requestDraw(a, [draw()]))
    accepted(h.requestDraw(b, [draw()]))
  })
  assert.deepEqual((await snapshot(h, b)).marks, [6, 3])
  assert.equal(p.frames.length, 7)
})

test('event type is part of coalescing key and requestView itself coalesces', async () => {
  const h = host(), p = probe(), a = await acquire(h, p)
  p.reset()
  await queued(h, a, p, () => {
    accepted(h.postTick(a, tick('view', 2), false))
    accepted(h.requestView(a))
    coalesced(h.requestView(a))
    accepted(h.postTick(a, tick('surface', 3), false))
    accepted(h.postSurfaceFrame(a, surface(4)))
    accepted(h.postTick(a, tick('empty', 5), false))
    accepted(h.requestDraw(a, []))
  })
  assert.deepEqual((await snapshot(h, a)).marks, [2, 3, 4, 5])
  assert.equal(p.frames.length, 6)
})

for (const boundary of ['input', 'slow-tick', 'resume', 'snapshot']) {
  test('coalescing segments cannot cross ' + boundary + ' ordering barrier', async () => {
    const h = host(), p = probe(), a = await acquire(h, p)
    let barrier
    await queued(h, a, p, () => {
      accepted(h.postTick(a, tick('A', 2), false))
      coalesced(h.postTick(a, tick('A', 3), false))
      if (boundary === 'input') accepted(post(h, a, 'add', 7))
      if (boundary === 'slow-tick') accepted(h.postTick(a, tick('A', 7), true))
      if (boundary === 'resume') accepted(h.postRefresh(a, 'APP'))
      if (boundary === 'snapshot') barrier = watch(h.requestSnapshot(a))
      accepted(h.postTick(a, tick('A', 11), false))
    })
    assert.deepEqual((await snapshot(h, a)).marks, boundary === 'input' || boundary === 'slow-tick' ? [5, 7, 11] : [5, 11])
    if (barrier) assert.deepEqual(stateOf(await finish(barrier)).marks, [5])
  })
}

test('surface coalescing caps elapsed at 100 and uses latest ordered actions and draw set', async () => {
  const h = host(), p = probe(), a = await acquire(h, p)
  await queued(h, a, p, () => {
    accepted(h.postSurfaceFrame(a, surface(60, ['frameA'], [draw(1)])))
    const frame = surface(70, ['frameB', 'frameA'], [draw(2, 'drawOther', 8)])
    coalesced(h.postSurfaceFrame(a, frame))
    frame.draws[0].surfaceRevision = 99
    frame.draws[0].nodeId = 99
    frame.draws[0].entry = 'drawTrap'
    frame.draws.length = 0
  })
  const state = await snapshot(h, a)
  assert.deepEqual(state.marks, [-100, 100])
  assert.equal(state.n, 301)
  const frame = latest(p)
  assert.deepEqual(frame.gfx.map(item => [item.nodeId, item.surfaceRevision]), [[2, 8]])
  assert.equal(frame.gfx[0].ops[0].x, 1301)
  assert.equal(frame.view, null)
  assert.equal(frame.timing.length, 3)
})

test('pointer move keeps latest payload/draws; down/up ordered barriers prevent merging', async () => {
  const h = host(), p = probe(), a = await acquire(h, p)
  const move = (x, draws = [draw()]) => input(a, 'pointer', 0, {
    kind: 'SURFACE_MOVE', payload: payload('POINTER', 0, { id: 2, x, y: 1 }), draws
  })
  await queued(h, a, p, () => {
    accepted(h.postInput(a, move(3)))
    const event = move(7, [draw(2, 'drawOther', 9)])
    coalesced(h.postInput(a, event))
    event.draws[0].surfaceRevision = 99
    event.draws[0].nodeId = 99
    event.draws[0].entry = 'drawTrap'
    event.draws.length = 0
    accepted(post(h, a, 'pointer', 0, { kind: 'SURFACE_UP', payload: payload('POINTER', 0, { id: 2, x: 10, y: 1 }) }))
    accepted(h.postInput(a, move(11, [])))
  })
  assert.deepEqual((await snapshot(h, a)).marks, [7, 10, 11])
  const gfx = p.frames.flatMap(frame => frame.gfx)
  assert.deepEqual(gfx.map(item => [item.nodeId, item.surfaceRevision]), [[2, 9]])
  assert.equal(gfx[0].ops[0].x, 1011)
  assert.equal(count('save'), 0)
})

test('requestDraw coalesces per revision and node, last entry wins, partial overlapping batches complete once', async () => {
  const h = host(), p = probe(), a = await acquire(h, p)
  let closing
  p.reset()
  await queued(h, a, p, () => {
    accepted(h.requestDraw(a, [draw(1), draw(1, 'drawOther'), draw(1, 'draw', 2)]))
    accepted(h.requestDraw(a, [draw(2), draw(3), draw(1, 'draw', 3)]))
    coalesced(h.requestDraw(a, [draw(1), draw(1, 'drawOther', 2), draw(2, 'drawOther')]))
    accepted(h.requestDraw(a, [draw(3, 'drawOther'), draw(4)]))
    const draws = [draw(1, 'drawOther', 3)]
    coalesced(h.requestDraw(a, draws))
    draws[0].surfaceRevision = 99
    draws[0].nodeId = 99
    draws[0].entry = 'drawTrap'
    draws.length = 0
    closing = watch(h.release(a))
  })
  await finish(closing)
  const gfx = p.frames.flatMap(frame => frame.gfx)
  assert.deepEqual(gfx.map(item => [item.nodeId, item.surfaceRevision, item.ops[0].x]),
    [[1, 1, 1], [1, 2, 1001], [2, 1, 1001], [3, 1, 1001], [1, 3, 1001], [4, 1, 1]])
  assert(p.frames.slice(1).every(frame => frame.view === null))
})

test('snapshot captures exact barrier position including critical result and excludes later input', async () => {
  const h = host(), p = probe(), a = await acquire(h, p)
  accepted(post(h, a, 'change', 0))
  await finish(h.whenIdle())
  const id = p.effects[0].effectId
  p.reset()
  let barrier
  await queued(h, a, p, () => {
    accepted(post(h, a, 'add', 2))
    accepted(h.postEffectResult(a, id, 'ok'))
    barrier = watch(h.requestSnapshot(a))
    accepted(post(h, a, 'add', 8))
  })
  assert.equal(stateOf(await finish(barrier)).n, 5)
  assert.equal((await snapshot(h, a)).n, 13)
  assert.equal(count('save'), 0)
})

for (const kind of ['handler', 'frame', 'move', 'draw']) {
  test(kind + ' trap discards queued ticks/surface frames, effects of failed call, and completes release accounting', async () => {
    const h = host(), p = probe(), a = await acquire(h, p)
    let release, seq
    p.reset()
    await queued(h, a, p, () => {
      if (kind === 'handler') seq = accepted(post(h, a, 'fail', 2))
      if (kind === 'frame') accepted(h.postSurfaceFrame(a, surface(2, ['fail'], [draw()])))
      if (kind === 'move') accepted(post(h, a, 'pointerFail', 0, { kind: 'SURFACE_MOVE', payload: payload('POINTER', 0, { x: 2 }), draws: [draw()] }))
      if (kind === 'draw') accepted(h.requestDraw(a, [draw(1, 'drawTrap')]))
      accepted(h.postTick(a, tick('fast', 100), false))
      coalesced(h.postTick(a, tick('fast', 100), false))
      accepted(h.postTick(a, tick('slow', 100), true))
      accepted(h.postSurfaceFrame(a, surface(100)))
      if (kind !== 'frame') coalesced(h.postSurfaceFrame(a, surface(100)))
      accepted(post(h, a, 'add', 3))
      release = watch(h.release(a))
    })
    await finish(release)
    assert.equal(p.effects.length, 0)
    const b = await acquire(h, p, programs.basic, options(), a.appId)
    const state = await snapshot(h, b)
    assert.equal(state.n, 4)
    assert.equal(state.calls, 1)
    assert.deepEqual(state.marks, [3])
    assert.equal(p.errors.length, 1, JSON.stringify(p.errors))
    assert.equal(p.errors[0].kind, kind)
    assert.equal(p.errors[0].inputSeq, seq)
  })
}

test('view trap keeps prior frame, continues save/effects once and reports ordered input sequence', async () => {
  const h = host(), p = probe(), a = await acquire(h, p, programs.basic, persistent())
  const last = latest(p), immutable = JSON.stringify(last)
  p.reset()
  const result = post(h, a, 'breakView', 2, { kind: 'FIELD', persist: true })
  const seq = accepted(result)
  await finish(h.whenIdle())
  assert.equal(p.frames.length, 0)
  assert.equal(JSON.stringify(last), immutable)
  assert.equal(p.errors.length, 1)
  assert.equal(p.errors[0].kind, 'view')
  assert.equal(p.errors[0].inputSeq, seq)
  assert.deepEqual(sequence(), ['save', 'snapshot', 'effect', 'saved', 'error'])
  assert.equal(count('task-submit'), count('task-result'))
  assert.equal(p.effects.length, 1)
  assert.equal(p.effects[0].params[3], '3')
  assert.equal(stateOf(JSON.stringify(JSON.parse(disk.get(stateFile())).value)).calls, 1)
  accepted(h.postTick(a, tick('slow', 3, 'recover'), true))
  assert.equal((await snapshot(h, a)).calls, 2)
  assert.equal(latest(p).view.text, 'n=6')
})

test('view trap does not discard queued ticks and field queue can release edits and continue', async () => {
  const h = host(), p = probe(), a = await acquire(h, p, programs.basic, persistent())
  const errorSeqs = []
  let failedSeq
  h.notifyEdits(a, true)
  p.errorHook = error => {
    errorSeqs.push(error.inputSeq)
    if (errorSeqs.length === 1) accepted(post(h, a, 'recover', 4, { kind: 'FIELD' }))
  }
  let completing = false
  await queued(h, a, p, () => {
    p.frameHook = frame => {
      if (frame.view && frame.view.text === 'n=10') {
        completing = true
        h.notifyEdits(a, false)
      }
    }
    failedSeq = accepted(post(h, a, 'breakView', 2, { kind: 'FIELD' }))
    accepted(h.postTick(a, tick('fast', 3), false))
  })
  await finish(h.whenIdle())
  p.frameHook = null
  assert.deepEqual(errorSeqs, [failedSeq, undefined])
  assert.equal(completing, true)
  assert.equal((await snapshot(h, a)).n, 10)
  p.reset()
  accepted(h.postSurfaceFrame(a, surface(1)))
  await finish(h.whenIdle())
  assert.equal(count('save'), 1)
  assert.equal(p.snapshots.length, 1)
  assert.equal(count('task-submit'), count('task-result'))
})

test('draw trap after frame handlers never repeats completed handlers or undoes delivered effects', async () => {
  const h = host(), p = probe(), a = await acquire(h, p)
  p.reset()
  accepted(h.postSurfaceFrame(a, surface(4, ['frameA'], [draw(1, 'drawTrap')])))
  await finish(h.whenIdle())
  assert.equal(p.frames.length, 0)
  assert.equal(p.effects.length, 1)
  assert.equal((await snapshot(h, a)).calls, 1)
  assert.equal((await snapshot(h, a)).n, 5)
  accepted(h.requestDraw(a, [draw()]))
  await finish(h.whenIdle())
  assert.equal(latest(p).gfx[0].ops[0].x, 5)
  assert.equal(p.errors[0].kind, 'draw')
})

test('draw effects are forbidden and callback exceptions do not repeat a completed handler', async () => {
  const h = host(), p = probe(), a = await acquire(h, p)
  accepted(h.requestDraw(a, [draw(1, 'drawEffect')]))
  await finish(h.whenIdle())
  assert.equal(p.effects.length, 0)
  const subscriberFrame = p.subscriber.onViewFrame
  p.subscriber.onViewFrame = frame => { subscriberFrame(frame); throw Error('fixture subscriber failure') }
  accepted(post(h, a, 'change', 2))
  assert.equal((await snapshot(h, a)).calls, 1)
  assert.equal(p.effects.length, 1)
  assert.equal(p.errors[0].kind, 'draw')
})

for (const failureMode of ['open', 'write', 'close', 'rename']) {
  test(failureMode + ' save failure rolls back handler state and suppresses effects until a later accepted turn', async () => {
    const h = host(), p = probe(), a = await acquire(h, p, programs.basic, persistent())
    const durable = disk.get(stateFile())
    p.reset()
    failure = failureMode
    try {
      accepted(post(h, a, 'change', 2, { persist: true }))
      await finish(h.whenIdle())
      assert.equal(p.saved.length + p.effects.length + p.snapshots.length + p.frames.length, 0)
      assert(p.errors.length > 0)
      assert.equal(count('save'), 0)
      assert.equal(count('task-submit'), count('task-result'))
      assert(records.some(record => record.type === 'task-result' && record.reply.result?.status === 'FAILED'))
      assert.equal(disk.get(stateFile()), durable)
      assert.equal((await snapshot(h, a)).calls, 0)
      assert.equal((await snapshot(h, a)).n, 1)
    } finally {
      failure = ''
      if (failureMode === 'close') {
        for (const fd of [...worker.memory.fds.keys()]) worker.memory.closeSync(fd)
      }
    }
    p.reset()
    accepted(post(h, a, 'change', 3, { persist: true }))
    await finish(h.whenIdle())
    assert.equal(p.saved.length, 1)
    assert.equal(p.effects.length, 1)
    assert.equal(p.errors.length, 0)
    assert.equal(count('save'), 1)
    assert.equal(count('task-submit'), count('task-result'))
    assert.equal((await snapshot(h, a)).calls, 1)
    assert.equal(stateOf(JSON.stringify(JSON.parse(disk.get(stateFile())).value)).n, 4)
    assert.deepEqual(sequence(), ['save', 'snapshot', 'effect', 'saved', 'frame'])
  })
}

test('notifyEdits is synchronous aggregate gate read at surface execution, not admission', async () => {
  const h = host(), p = probe(), a = await acquire(h, p, programs.basic, persistent())
  const b = await acquire(h, p, programs.basic, persistent(), a.appId)
  accepted(post(h, a, 'add', 0))
  await finish(h.whenIdle())
  advance(5000)
  p.reset()
  await queued(h, a, p, () => {
    accepted(h.postSurfaceFrame(a, surface(2, ['add'])))
    h.notifyEdits(b, true)
    accepted(post(h, b, 'add', 3, { kind: 'FIELD' }))
  })
  await finish(h.whenIdle())
  assert.equal(count('save') + p.snapshots.length, 0)
  h.notifyEdits(a, true)
  h.notifyEdits(b, false)
  p.reset()
  accepted(h.postSurfaceFrame(a, surface(2, ['add'])))
  await finish(h.whenIdle())
  assert.equal(count('save') + p.snapshots.length, 0)
  h.notifyEdits(a, false)
  p.reset()
  await queued(h, a, p, () => {
    h.notifyEdits(b, true)
    accepted(h.postSurfaceFrame(a, surface(2, ['add'])))
    h.notifyEdits(b, false)
  })
  await finish(h.whenIdle())
  assert.equal(count('save'), 1)
  assert.equal(p.snapshots.length, 1)
  assert.equal(p.effects.length, 0)
  assert.equal(count('task-submit'), count('task-result'))
  assert.deepEqual(sequence().slice(-3), ['save', 'snapshot', 'saved'])
})

for (const phase of ['start', 'restart']) {
  test('marked surface ' + phase + ' saves at 5000ms, not 4999ms', async () => {
    const h = host(), p = probe(), a = await acquire(h, p, programs.basic, persistent())
    if (phase === 'restart') {
      p.reset()
      accepted(h.postSurfaceFrame(a, markedSurface(now, 1, ['add'])))
      await finish(h.whenIdle())
      advance(5000)
      accepted(h.postSurfaceFrame(a, surface(1, ['add'])))
      await finish(h.whenIdle())
      assert.equal(count('save'), 1)
      advance(6000)
    }
    p.reset()
    accepted(h.postSurfaceFrame(a, markedSurface(now, 2, ['add'])))
    await finish(h.whenIdle())
    assert.equal(count('save') + p.snapshots.length, 0)
    advance(4999)
    accepted(h.postSurfaceFrame(a, surface(3, ['add'])))
    await finish(h.whenIdle())
    assert.equal(count('save') + p.snapshots.length, 0)
    advance(1)
    accepted(h.postSurfaceFrame(a, surface(4, ['add'])))
    await finish(h.whenIdle())
    assert.equal(count('save'), 1)
    assert.equal(p.saved.length, 1)
    assert.equal(p.snapshots.length, 1)
    assert.deepEqual(stateOf(p.snapshots[0]).marks.slice(-3), [2, 3, 4])
  })
}

for (const delay of [2300, 7000]) {
  test('first surface frame delayed ' + delay + 'ms uses captured loop start', async () => {
    const h = host(), p = probe(), a = await acquire(h, p, programs.basic, persistent())
    accepted(post(h, a, 'add', 0))
    await finish(h.whenIdle())
    const started = now
    advance(delay)
    p.reset()
    accepted(h.postSurfaceFrame(a, markedSurface(started, 2, ['add'])))
    await finish(h.whenIdle())
    if (delay < 5000) {
      assert.equal(count('save') + p.snapshots.length, 0)
      advance(4999 - delay)
      accepted(h.postSurfaceFrame(a, surface(3, ['add'])))
      await finish(h.whenIdle())
      assert.equal(count('save') + p.snapshots.length, 0)
      advance(1)
      accepted(h.postSurfaceFrame(a, surface(4, ['add'])))
      await finish(h.whenIdle())
    }
    assert.equal(count('save'), 1)
    assert.equal(p.snapshots.length, 1)
    assert.equal(stateOf(p.snapshots[0]).calls, delay < 5000 ? 4 : 2)
  })
}

test('queued surface frame copies loop start before producer mutates its DTO', async () => {
  const h = host(), p = probe(), a = await acquire(h, p, programs.basic, persistent())
  accepted(post(h, a, 'add', 0))
  await finish(h.whenIdle())
  const started = now
  p.reset()
  await queued(h, a, p, () => {
    const frame = markedSurface(started, 2, ['add'])
    accepted(h.postSurfaceFrame(a, frame))
    frame.loopStartedAt = started + 2300
    now += 2300
  })
  await finish(h.whenIdle())
  assert.equal(count('save') + p.snapshots.length, 0)
  advance(2699)
  accepted(h.postSurfaceFrame(a, surface(3, ['add'])))
  await finish(h.whenIdle())
  assert.equal(count('save') + p.snapshots.length, 0)
  advance(1)
  accepted(h.postSurfaceFrame(a, surface(4, ['add'])))
  await finish(h.whenIdle())
  assert.equal(count('save'), 1)
  assert.deepEqual(stateOf(p.snapshots[0]).marks, [0, 2, 3, 4])
})

for (const scenario of [
  { name: 'preserves prior marker when incoming is unmarked', first: -3000, incoming: undefined, expected: -3000 },
  { name: 'takes incoming marker when prior is unmarked', first: undefined, incoming: -3000, expected: -3000 },
  { name: 'takes newer incoming timestamp', first: -3000, incoming: -1000, expected: -1000 },
  { name: 'takes last incoming marker even with older timestamp', first: -1000, incoming: -3000, expected: -3000 }
]) {
  test('surface coalescing ' + scenario.name, async () => {
    const h = host(), p = probe(), a = await acquire(h, p, programs.basic, persistent())
    accepted(post(h, a, 'add', 0))
    await finish(h.whenIdle())
    advance(4000)
    const started = now + scenario.expected
    const frame = (offset, elapsed) => offset === undefined ? surface(elapsed, ['add']) : markedSurface(now + offset, elapsed, ['add'])
    p.reset()
    await queued(h, a, p, () => {
      accepted(h.postSurfaceFrame(a, frame(scenario.first, 2)))
      coalesced(h.postSurfaceFrame(a, frame(scenario.incoming, 3)))
      coalesced(h.postSurfaceFrame(a, surface(4, ['add'])))
    })
    assert.equal(count('save') + p.snapshots.length, 0)
    assert.deepEqual((await snapshot(h, a)).marks, [0, 9])
    advance(started + 4999 - now)
    accepted(h.postSurfaceFrame(a, surface(1, ['add'])))
    await finish(h.whenIdle())
    assert.equal(count('save') + p.snapshots.length, 0)
    advance(1)
    accepted(h.postSurfaceFrame(a, surface(1, ['add'])))
    await finish(h.whenIdle())
    assert.equal(count('save'), 1)
    assert.deepEqual(stateOf(p.snapshots[0]).marks, [0, 9, 1, 1])
  })
}

test('backpressured surface marker leaves old deadline intact and retry keeps captured start', async () => {
  const h = host(), p = probe(), a = await acquire(h, p, programs.basic, persistent())
  accepted(h.postSurfaceFrame(a, markedSurface(now, 1, ['add'])))
  await finish(h.whenIdle())
  advance(4000)
  const started = now, retry = markedSurface(started, 2, ['add'])
  p.reset()
  await queued(h, a, p, () => {
    for (let i = 0; i < 240; i++) accepted(post(h, a, 'add', 0))
    pressure(h.postSurfaceFrame(a, retry))
  })
  await finish(h.whenIdle())
  assert(p.writable > 0)
  assert.equal(count('save'), 0)
  advance(1000)
  accepted(h.postSurfaceFrame(a, surface(3, ['add'])))
  await finish(h.whenIdle())
  assert.equal(count('save'), 1)
  accepted(post(h, a, 'add', 0))
  await finish(h.whenIdle())
  advance(1500)
  p.reset()
  accepted(h.postSurfaceFrame(a, retry))
  await finish(h.whenIdle())
  assert.equal(count('save') + p.snapshots.length, 0)
  advance(started + 4999 - now)
  accepted(h.postSurfaceFrame(a, surface(4, ['add'])))
  await finish(h.whenIdle())
  assert.equal(count('save') + p.snapshots.length, 0)
  advance(1)
  accepted(h.postSurfaceFrame(a, surface(5, ['add'])))
  await finish(h.whenIdle())
  assert.equal(count('save'), 0, 'captured marker must not precede the StateManager checkpoint deadline')
  advance(1000)
  accepted(h.postSurfaceFrame(a, surface(6, ['add'])))
  await finish(h.whenIdle())
  assert.equal(count('save'), 1)
  assert.equal(count('task-submit'), count('task-result'))
  assert.deepEqual(stateOf(p.snapshots[0]).marks.slice(-6), [3, 0, 2, 4, 5, 6])
})

for (const barrierType of ['ordered', 'snapshot']) {
  test('unmarked surface after ' + barrierType + ' barrier does not reset marked loop deadline', async () => {
    const h = host(), p = probe(), a = await acquire(h, p, programs.basic, persistent())
    const started = now
    let barrier
    p.reset()
    await queued(h, a, p, () => {
      accepted(h.postSurfaceFrame(a, markedSurface(started, 2, ['add'])))
      if (barrierType === 'ordered') accepted(post(h, a, 'add', 7))
      else barrier = watch(h.requestSnapshot(a))
      accepted(h.postSurfaceFrame(a, surface(3, ['add'])))
      p.frameHook = () => {
        p.frameHook = null
        now += 2000
      }
    })
    await finish(h.whenIdle())
    if (barrier) assert.deepEqual(stateOf(await finish(barrier)).marks, [2])
    assert.deepEqual((await snapshot(h, a)).marks, barrierType === 'ordered' ? [2, 7, 3] : [2, 3])
    assert.equal(count('save'), 0)
    p.reset()
    advance(started + 4999 - now)
    accepted(h.postSurfaceFrame(a, surface(4, ['add'])))
    await finish(h.whenIdle())
    assert.equal(count('save') + p.snapshots.length, 0)
    advance(1)
    accepted(h.postSurfaceFrame(a, surface(5, ['add'])))
    await finish(h.whenIdle())
    assert.equal(count('save'), 1)
    assert.equal(p.snapshots.length, 1)
  })
}

test('replacement discards queued old surface marker and rejects stale deadline resets', async () => {
  const h = host(), p = probe(), a = await acquire(h, p, programs.basic, persistent())
  accepted(h.postSurfaceFrame(a, markedSurface(now, 1, ['add'])))
  await finish(h.whenIdle())
  advance(1000)
  let replacement
  await queued(h, a, p, () => {
    replacement = watch(h.replaceProgram(a, programs.newer, persistent()))
    accepted(h.postSurfaceFrame(a, markedSurface(now, 99)))
  })
  const b = await finish(replacement)
  p.reset()
  rejected(h.postSurfaceFrame(a, markedSurface(now, 99)))
  accepted(h.postSurfaceFrame(b, surface(2)))
  await finish(h.whenIdle())
  assert.equal(count('save'), 1)
  assert.deepEqual(stateOf(p.snapshots[0]).marks, [2])
  accepted(h.postSurfaceFrame(b, markedSurface(now, 3, ['add'])))
  await finish(h.whenIdle())
  p.reset()
  advance(4999)
  rejected(h.postSurfaceFrame(a, markedSurface(now, 99)))
  accepted(h.postSurfaceFrame(b, surface(4, ['add'])))
  await finish(h.whenIdle())
  assert.equal(count('save') + p.snapshots.length, 0)
  advance(1)
  accepted(h.postSurfaceFrame(b, surface(5, ['add'])))
  await finish(h.whenIdle())
  assert.equal(count('save'), 1)
  assert.equal(count('task-submit'), count('task-result'))
  assert.deepEqual(stateOf(p.snapshots[0]).marks, [2, 3, 4, 5])
})

test('surface save only snapshots on successful durable save and retries failure without 5-second delay', async () => {
  const h = host(), p = probe(), a = await acquire(h, p, programs.basic, persistent())
  accepted(h.postSurfaceFrame(a, markedSurface(now, 0, ['add'])))
  await finish(h.whenIdle())
  advance(5000)
  p.reset()
  failure = 'rename'
  accepted(h.postSurfaceFrame(a, surface(2, ['add'])))
  await finish(h.whenIdle())
  assert.equal(count('save'), 0)
  assert.equal(p.saved.length, 0)
  assert.equal(p.snapshots.length, 0, 'failed surface save must not publish STATE_SNAPSHOT')
  assert.equal(count('task-submit'), count('task-result'))
  assert(records.some(record => record.type === 'task-result' && record.reply.result?.status === 'FAILED'))
  failure = ''
  accepted(h.postSurfaceFrame(a, surface(3, ['add'])))
  await finish(h.whenIdle())
  assert.equal(count('save'), 1, 'failed save must leave periodic deadline due')
  assert.equal(p.snapshots.length, 1)
  assert.equal(stateOf(p.snapshots[0]).n, 6)
  p.reset()
  accepted(h.postSurfaceFrame(a, surface(1, ['add'])))
  await finish(h.whenIdle())
  advance(4999)
  accepted(h.postSurfaceFrame(a, surface(1, ['add'])))
  await finish(h.whenIdle())
  assert.equal(count('save'), 0)
  advance(1)
  accepted(h.postSurfaceFrame(a, surface(1, ['add'])))
  await finish(h.whenIdle())
  assert.equal(count('save'), 1)
  assert.equal(count('task-submit'), count('task-result'))
  await assert.rejects(finish(h.dispose()), /STATE_PUBLISH_FAILED/)
  hosts.splice(hosts.indexOf(h), 1)
})

test('surface cadence commits before snapshot/effects and draw/frame', async () => {
  const h = host(), p = probe(), a = await acquire(h, p, programs.basic, persistent())
  p.reset()
  now += 100
  accepted(h.postSurfaceFrame(a, surface(2, ['frameA', 'frameB'])))
  await finish(h.whenIdle())
  assert.equal(count('task-submit'), count('task-result'))
  assert.deepEqual(sequence(), ['save', 'snapshot', 'effect', 'effect', 'saved', 'frame'])
  assert.equal(latest(p).view.text, 'n=7')
  assert.equal(latest(p).gfx[0].ops[0].x, 7)
  assert.equal(latest(p).reveal, false)
  p.reset()
  now += 99
  accepted(h.postSurfaceFrame(a, surface(1)))
  await finish(h.whenIdle())
  assert.equal(latest(p).view, null)
  now += 1
  accepted(h.postSurfaceFrame(a, surface(1)))
  await finish(h.whenIdle())
  assert.equal(latest(p).view.text, 'n=9')
})

test('payload DTO kinds become real VM values, invalid event metadata is terminal and copies are isolated', async () => {
  const h = host(), p = probe(), a = await acquire(h, p)
  accepted(post(h, a, 'answered', 0, { payload: payload('STRING', 0, { str: 'abc' }) }))
  accepted(post(h, a, 'toggle', 0, { payload: payload('BOOLEAN', 0, { bool: true }) }))
  accepted(post(h, a, 'add', 0, { payload: payload('NONE') }))
  let admission
  await queued(h, a, p, () => {
    const event = input(a, 'add', 7)
    admission = h.postInput(a, event)
    event.action = 'fail'
    event.payload.num = 1000
    const t = tick('t', 2)
    accepted(h.postTick(a, t, false))
    t.elapsed = 1000
  })
  accepted(admission)
  assert.equal((await snapshot(h, a)).n, 33)
  for (const extra of [{ appId: 'wrong' }, { vmGeneration: a.vmGeneration + 1 }, { kind: 'TICK' },
    { action: '' }, { payload: payload('RUNTIME_VALUE') }]) rejected(h.postInput(a, input(a, 'add', 1, extra)))
  rejected(h.postEffectResult(a, 999, 'no mapping'))
  rejected(h.postRefresh(a, 'WIDGET'))
  assert.equal((await snapshot(h, a)).n, 33)
})

test('frames and effects are detached plain DTOs and delivered frames never mutate on later turns', async () => {
  const h = host(), p = probe(), a = await acquire(h, p)
  accepted(post(h, a, 'change', 2))
  await finish(h.whenIdle())
  const previous = latest(p), saved = JSON.stringify(previous)
  assert.equal(Object.getPrototypeOf(previous), Object.prototype)
  assert.equal(Object.getPrototypeOf(previous.view), Object.prototype)
  assert.equal(p.effects[0].rawTarget, target)
  assert.deepEqual(p.effects[0].params, ['label', 'change', 'value', '3'])
  assert.equal(p.effects[0].resultHandler, 'answered')
  assert.equal(p.effects[0].mode, 'background')
  assert.deepEqual(Object.keys(previous).sort(),
    ['appId', 'vmGeneration', 'frameSeq', 'appliedSeq', 'reveal', 'view', 'gfx', 'timing', 'scenes', 'runtimeMode', 'stateRevision'].sort())
  assert.deepEqual(Object.keys(p.effects[0]).sort(),
    ['appId', 'vmGeneration', 'effectId', 'kind', 'rawTarget', 'params', 'resultHandler', 'mode', 'runtimeMode', 'stateRevision'].sort())
  assert.equal(previous.runtimeMode, 'LIVE_EPHEMERAL')
  assert.equal(previous.stateRevision, 0)
  assert.equal(p.effects[0].runtimeMode, 'LIVE_EPHEMERAL')
  assert.equal(p.effects[0].stateRevision, 0)
  const version = { runtimeMode: 'LIVE_PERSISTENT', vmGeneration: a.vmGeneration, stateRevision: 7 }
  const frame = makeRevisionedFrame(previous, version), request = makeRevisionedEffect(p.effects[0], version)
  const encoded = await finish(h.requestSnapshot(a)), state = makeStateSnapshot(a.appId, encoded, version)
  assert.deepEqual(frame, { ...previous, ...version })
  assert.deepEqual(request, { ...p.effects[0], ...version })
  assert.deepEqual(state, { appId: a.appId, encoded, ...version })
  assert.equal(typeof p.snapshots[0], 'string')
  assert.equal(request.mode, 'background')
  assert.notEqual(request.mode, request.runtimeMode)
  for (const key of ['view', 'gfx', 'timing']) assert.notStrictEqual(frame[key], previous[key])
  assert.notStrictEqual(request.params, p.effects[0].params)
  const copies = JSON.stringify([frame, request, state])
  version.stateRevision = 8
  p.effects[0].params.push('subscriber edit')
  previous.view.text = 'subscriber edit'
  assert.equal(JSON.stringify([frame, request, state]), copies)
  p.effects[0].params.pop()
  previous.view.text = 'n=3'
  const nextRevision = makeRevisionedFrame(previous, version)
  assert.equal(nextRevision.stateRevision, 8)
  assert.equal(nextRevision.frameSeq, frame.frameSeq)
  assert.equal(nextRevision.appliedSeq, frame.appliedSeq)
  for (const runtimeMode of ['PREVIEW', 'LIVE_EPHEMERAL']) {
    const zero = { ...version, runtimeMode, stateRevision: 0 }
    assert.equal(makeRevisionedFrame(previous, zero).stateRevision, 0)
    const effectCopy = makeRevisionedEffect(p.effects[0], zero), snapshotCopy = makeStateSnapshot(a.appId, encoded, zero)
    if (runtimeMode === 'PREVIEW') assert.deepEqual([effectCopy, snapshotCopy], [null, null])
    else assert.deepEqual([effectCopy.stateRevision, snapshotCopy.stateRevision], [0, 0])
    assert.throws(() => makeRevisionedFrame(previous, { ...zero, stateRevision: 1 }))
    assert.throws(() => makeRevisionedEffect(p.effects[0], { ...zero, stateRevision: 1 }))
    assert.throws(() => makeStateSnapshot(a.appId, encoded, { ...zero, stateRevision: 1 }))
  }
  for (const bad of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    const invalid = { ...version, stateRevision: bad }
    assert.throws(() => makeRevisionedFrame(previous, invalid))
    assert.throws(() => makeRevisionedEffect(p.effects[0], invalid))
    assert.throws(() => makeStateSnapshot(a.appId, encoded, invalid))
  }
  const mismatch = { ...version, vmGeneration: a.vmGeneration + 1 }
  assert.throws(() => makeRevisionedFrame(previous, mismatch))
  assert.throws(() => makeRevisionedEffect(p.effects[0], mismatch))
  const fence = { incarnation: h, appId: a.appId, ...version }
  assert.equal(sameHostPublication(fence, { ...fence, stateRevision: 99 }), true)
  for (const change of [{ incarnation: host() }, { incarnation: {} }, { appId: 'other/v' },
    { runtimeMode: 'LIVE_EPHEMERAL' }, { vmGeneration: a.vmGeneration + 1 }]) {
    assert.equal(sameHostPublication(fence, { ...fence, ...change }), false)
  }
  const parse = file => ts.createSourceFile(file.replace(/\.ets$/, '.ts'),
    fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const ast = parse('runtime/InProcessHost.ets')
  const hostClass = ast.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'InProcessHost')
  assert(hostClass)
  const helperNames = new Set(['makeRevisionedFrame', 'makeRevisionedEffect', 'makeStateSnapshot', 'sameHostPublication'])
  const helperCalls = new Map([...helperNames].map(name => [name, 0]))
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && helperNames.has(node.expression.text)) {
      helperCalls.set(node.expression.text, helperCalls.get(node.expression.text) + 1)
    }
    ts.forEachChild(node, visit)
  }
  visit(hostClass)
  for (const [name, calls] of helperCalls) assert.equal(calls, 1, name + ' must guard its activated publication path')
  const member = name => hostClass.members.find(node => node.name?.getText(ast) === name).getText(ast)
  assert.match(member('ownsDelivery'), /sameHostPublication\(owner\.fence, this\.publicationFence\(record\)\)/)
  assert.match(member('deliver'), /this\.ownsDelivery\(record, owner\)/)
  assert.match(member('deliverFrame'), /makeRevisionedFrame\([\s\S]*version\)/)
  assert.match(member('deliverEffects'), /makeRevisionedEffect\([\s\S]*version\)/)
  assert.match(member('createActor'), /makeStateSnapshot\(record\.appId, encoded, this\.hostVersion\(record, version\)\)/)
  const messages = parse('runtime/shared/Messages.ets')
  const subscriber = messages.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'AppSubscriber')
  assert(subscriber)
  assert.deepEqual(subscriber.members.map(node => node.getText(messages).replace(/\s/g, '')), [
    'onViewFrame(frame:RevisionedFrameEnvelope):void', 'onError(kind:string,message:string,inputSeq?:number):void',
    'onStateSnapshot(encoded:string,snapshot?:StateSnapshotEnvelope):void', 'onStateSaved(projectId:string):void',
    'onEffectRequest(effect:RevisionedEffectRequest):void', "onActorHandle?(handle:ActorHandle,reason?:'REPLACE'|'PROMOTE'):void",
    'flushPendingInputFor(appId:string):void|Promise<void>', 'onMailboxWritable():void'
  ])
  previous.view.text = 'subscriber edit'
  accepted(h.requestView(a))
  await finish(h.whenIdle())
  assert.equal(latest(p).view.text, 'n=3')
  previous.view.text = 'n=3'
  assert.equal(JSON.stringify(previous), saved)
  accepted(post(h, a, 'add', 4))
  await finish(h.whenIdle())
  assert.equal(JSON.stringify(previous), saved)
  assert(latest(p).frameSeq > previous.frameSeq)
  assert.equal(JSON.stringify([frame, request, state]), copies)
  const later = makeRevisionedFrame(latest(p), version)
  assert.equal(later.stateRevision, nextRevision.stateRevision)
  assert(later.frameSeq > nextRevision.frameSeq)
  assert(later.appliedSeq > nextRevision.appliedSeq)
  accepted(h.requestDraw(a, [draw()]))
  await finish(h.whenIdle())
  const drawn = latest(p), drawnCopy = makeRevisionedFrame(drawn, version), drawnSaved = JSON.stringify(drawnCopy)
  drawn.gfx[0].ops[0].x = 999
  drawn.timing.push(999)
  assert.equal(JSON.stringify(drawnCopy), drawnSaved)
  const q = probe(), world = await acquire(h, q, programs.world)
  const scene = latest(q), sceneCopy = makeRevisionedFrame(scene, { ...version, vmGeneration: world.vmGeneration })
  const sceneSaved = JSON.stringify(sceneCopy)
  scene.scenes[0].spec.bodies[0].position[0] = 999
  assert.equal(JSON.stringify(sceneCopy), sceneSaved)
})

test('stale effect results after release and replacement are rejected without executing VM', async () => {
  const h = host(), p = probe(), a = await acquire(h, p)
  accepted(post(h, a, 'change', 1))
  await finish(h.whenIdle())
  const id = p.effects[0].effectId
  await finish(h.release(a))
  rejected(h.postEffectResult(a, id, 'ok'))
  const b = await acquire(h, p, programs.basic, options(), a.appId)
  rejected(h.postEffectResult(b, id, 'ok'))
  assert.equal((await snapshot(h, b)).calls, 1)
  accepted(post(h, b, 'change', 1))
  await finish(h.whenIdle())
  const id2 = p.effects[p.effects.length - 1].effectId
  const c = await finish(h.replaceProgram(b, programs.newer, options()))
  rejected(h.postEffectResult(b, id2, 'ok'))
  rejected(h.postEffectResult(c, id2, 'ok'))
  assert.equal((await snapshot(h, c)).calls, 0)
})

test('dispose rejects pending acquire/snapshot/lifecycle, cancels yields, never final-saves', async () => {
  const h = host(), p = probe(), q = probe(), a = await acquire(h, p)
  let pendingAcquire, pendingSnapshot, pendingReplace
  await queued(h, a, p, () => {
    pendingAcquire = watch(h.acquire('', programs.basic, options(), q.subscriber))
    accepted(post(h, a, 'add', 100))
    pendingSnapshot = watch(h.requestSnapshot(a))
    pendingReplace = watch(h.replaceProgram(a, programs.newer, options()))
    now += 8
  })
  assert([...timers.values()].some(timer => timer.delay === 0))
  const staleCallbacks = [...timers.values()].map(timer => timer.callback)
  await finish(h.dispose())
  await rejects(pendingAcquire, 'ACTOR_NOT_READY')
  await rejects(pendingSnapshot, 'ACTOR_NOT_READY')
  await rejects(pendingReplace, 'ACTOR_NOT_READY')
  const before = records.length
  for (const callback of staleCallbacks) callback()
  advance(10000)
  assert.equal(records.length, before)
  assert.equal(q.frames.length, 0)
  assert.equal(count('save'), 0)
  for (const result of [post(h, a), h.postTick(a, tick('t', 1), false), h.postSurfaceFrame(a, surface()),
    h.postRefresh(a, 'APP'), h.requestView(a), h.requestDraw(a, [draw()]), h.postEffectResult(a, 1, 'ok')]) rejected(result)
  await rejects(h.requestSnapshot(a), 'INVALID_HANDLE')
  await rejects(h.acquire('', programs.basic, options(), p.subscriber), 'ACTOR_NOT_READY')
  await rejects(h.promote(a, 'PREVIEW', ''), 'INVALID_HANDLE')
  await rejects(h.replaceProgram(a, programs.basic, options()), 'INVALID_HANDLE')
  h.notifyEdits(a, true)
  await finish(h.dispose())
})

test('dispose from frame callback retains accepted commit/effects and cancels outstanding release', async () => {
  const h = host(), p = probe(), a = await acquire(h, p, programs.basic, persistent())
  let disposing, releasing
  p.reset()
  p.frameHook = () => {
    p.frameHook = null
    releasing = watch(h.release(a, { saveState: true }))
    disposing = watch(h.dispose())
  }
  accepted(post(h, a, 'change', 2, { persist: true }))
  await until(() => disposing !== undefined)
  await finish(disposing)
  await rejects(releasing, 'ACTOR_NOT_READY')
  assert.equal(count('save'), 1)
  assert.equal(p.effects.length, 1)
  assert.equal(count('task-submit'), count('task-result'))
  assert.deepEqual(sequence(), ['save', 'snapshot', 'effect', 'saved', 'frame'])
  const before = records.length
  advance(10000)
  assert.equal(records.length, before)
})

test('dispose cancels idle destruction callback and old handles cannot reach a fresh host', async () => {
  const h = host(), p = probe(), a = await acquire(h, p, programs.basic, persistent())
  accepted(post(h, a, 'add', 2))
  await finish(h.release(a))
  const callbacks = [...timers.values()].map(timer => timer.callback)
  await finish(h.dispose())
  const freshHost = host(), q = probe(), b = await acquire(freshHost, q, programs.basic, persistent())
  for (const callback of callbacks) callback()
  rejected(post(freshHost, a, 'add', 100))
  assert.equal((await snapshot(freshHost, b)).n, 1)
})

for (const eventType of ['view', 'draw', 'move', 'surface']) {
  for (const barrierType of ['ordered', 'snapshot']) {
    test(eventType + ' coalescing preserves ' + barrierType + ' segment boundaries', async () => {
      const h = host(), p = probe(), a = await acquire(h, p)
      p.reset()
      let barrier
      const submit = value => {
        if (eventType === 'view') return h.requestView(a)
        if (eventType === 'draw') return h.requestDraw(a, [draw(1, value === 11 ? 'drawOther' : 'draw')])
        if (eventType === 'surface') return h.postSurfaceFrame(a, surface(value))
        return post(h, a, 'pointer', 0, { kind: 'SURFACE_MOVE',
          payload: payload('POINTER', 0, { x: value }), draws: [draw()] })
      }
      await queued(h, a, p, () => {
        accepted(submit(2))
        coalesced(submit(3))
        if (barrierType === 'ordered') accepted(post(h, a, 'add', 7))
        else barrier = watch(h.requestSnapshot(a))
        accepted(submit(11))
      })
      const state = await snapshot(h, a)
      const prefix = barrierType === 'ordered' ? [7] : []
      if (eventType === 'surface') assert.deepEqual(state.marks, [5, ...prefix, 11])
      if (eventType === 'move') assert.deepEqual(state.marks, [3, ...prefix, 11])
      if (eventType === 'view' || eventType === 'draw') assert.deepEqual(state.marks, prefix)
      assert.equal(p.frames.length, barrierType === 'ordered' ? 4 : 3)
      if (eventType === 'draw') assert.deepEqual(p.frames.flatMap(frame => frame.gfx).map(item => item.ops[0].x),
        barrierType === 'ordered' ? [1, 1008] : [1, 1001])
      if (barrier) {
        const before = stateOf(await finish(barrier))
        assert.deepEqual(before.marks, eventType === 'surface' ? [5] : eventType === 'move' ? [3] : [])
      }
    })
  }
}

test('coalescing remains eligible at all 256 slots and rejected events consume no sequence', async () => {
  const h = host(), p = probe(), a = await acquire(h, p)
  let lastSeq, nextSeq, barrier
  await queued(h, a, p, () => {
    for (let i = 0; i < 239; i++) lastSeq = accepted(post(h, a, 'add', 1))
    for (let i = 0; i < 16; i++) accepted(h.postRefresh(a, 'APP'))
    accepted(h.postTick(a, tick('at-capacity', 2), false))
    coalesced(h.postTick(a, tick('at-capacity', 3), false))
    pressure(post(h, a, 'add', 900))
    pressure(h.postRefresh(a, 'APP'))
    barrier = watch(h.requestSnapshot(a))
  })
  assert.equal(stateOf(await finish(barrier)).n, 245)
  nextSeq = accepted(post(h, a, 'add', 4))
  assert.equal(nextSeq, lastSeq + 1)
  assert.equal((await snapshot(h, a)).n, 249)
})

test('periodic failed save leaves deadline due for next immediate successful frame', async () => {
  const h = host(), p = probe(), a = await acquire(h, p, programs.basic, persistent())
  accepted(h.postSurfaceFrame(a, markedSurface(now, 0, ['add'])))
  await finish(h.whenIdle())
  advance(5000)
  failure = 'rename'
  p.reset()
  accepted(h.postSurfaceFrame(a, surface(2, ['add'])))
  await finish(h.whenIdle())
  assert.equal(count('save'), 0)
  assert.equal(count('task-submit'), count('task-result'))
  assert(records.some(record => record.type === 'task-result' && record.reply.result?.status === 'FAILED'))
  failure = ''
  accepted(h.postSurfaceFrame(a, surface(3, ['add'])))
  await finish(h.whenIdle())
  assert.equal(count('save'), 1, 'periodic failure must not postpone the retry by 5000ms')
  assert.equal(count('task-submit'), count('task-result'))
  assert.equal(p.saved.length, 1)
  assert.equal(stateOf(JSON.stringify(JSON.parse(disk.get(stateFile())).value)).n, 6)
  await assert.rejects(finish(h.dispose()), /STATE_PUBLISH_FAILED/)
  hosts.splice(hosts.indexOf(h), 1)
})

test('effect result closes coalescing segment and precedes snapshot barrier', async () => {
  const h = host(), p = probe(), a = await acquire(h, p)
  accepted(post(h, a, 'change', 0))
  await finish(h.whenIdle())
  const id = p.effects[0].effectId
  let barrier
  await queued(h, a, p, () => {
    accepted(h.postTick(a, tick('t', 2), false))
    accepted(h.postEffectResult(a, id, 'ok'))
    accepted(h.postTick(a, tick('t', 3), false))
    barrier = watch(h.requestSnapshot(a))
    accepted(h.postTick(a, tick('t', 4), false))
  })
  assert.deepEqual(stateOf(await finish(barrier)).marks, [0, 2, 2, 3])
  assert.deepEqual((await snapshot(h, a)).marks, [0, 2, 2, 3, 4])
})

test('closing release stays pending through callback completion before final durable save', async () => {
  const h = host(), p = probe(), a = await acquire(h, p, programs.basic, persistent())
  let release, inside = false
  p.reset()
  p.frameHook = frame => {
    if (inside || frame.view.text !== 'n=3') return
    inside = true
    release = watch(h.release(a, { saveState: true }))
    assert.equal(release.done, false)
    assert.equal(count('save'), 0)
    records.push({ type: 'delivery-completed' })
  }
  accepted(post(h, a, 'add', 2))
  await until(() => inside)
  p.frameHook = null
  await finish(release)
  assert.equal(count('save'), 1)
  assert(records.findIndex(record => record.type === 'delivery-completed') < records.findIndex(record => record.type === 'save'))
  assert.equal(stateOf(JSON.stringify(JSON.parse(disk.get(stateFile())).value)).n, 3)
})

test('MOVE admissions and coalescing never allocate inputSeq or advance appliedSeq', async () => {
  const h = host(), p = probe(), a = await acquire(h, p)
  const first = accepted(post(h, a, 'add', 2))
  await finish(h.whenIdle())
  const applied = latest(p).appliedSeq
  const moves = []
  await queued(h, a, p, () => {
    moves.push(post(h, a, 'pointer', 0, { kind: 'SURFACE_MOVE',
      payload: payload('POINTER', 0, { x: 3 }), draws: [draw()] }))
    moves.push(post(h, a, 'pointer', 0, { kind: 'SURFACE_MOVE',
      payload: payload('POINTER', 0, { x: 4 }), draws: [draw()] }))
  })
  const moveApplied = latest(p).appliedSeq
  const next = accepted(post(h, a, 'add', 5))
  assert.equal((await snapshot(h, a)).n, 12)
  assert.deepEqual(moves.map(result => result.status), ['ACCEPTED', 'COALESCED'])
  assert.deepEqual({ sequences: moves.map(result => result.inputSeq), moveApplied, next },
    { sequences: [undefined, undefined], moveApplied: applied, next: first + 1 })
})

test('initial view failure rejects activation before refresh can recover, save or emit effects', async () => {
  const h = host(), p = probe()
  await rejects(h.acquire('', programs.initialViewTrap, persistent(), p.subscriber), 'ACTOR_NOT_READY')
  assert.equal(p.frames.length, 0)
  assert.equal(p.snapshots.length, 1)
  assert.equal(stateOf(p.snapshots[0]).n, -1)
  assert.deepEqual(p.errors.map(error => [error.kind, error.inputSeq]), [['view', undefined]])
  assert.equal(count('save'), 1)
  assert.equal(count('task-submit'), count('task-result'))
  assert.equal(p.saved.length, 1)
  assert.equal(p.effects.length, 0)
  const a = await acquire(h, p, programs.basic, persistent())
  assert.equal((await snapshot(h, a)).n, 1)
})

for (const candidate of ['initTrap', 'initEffect', 'initialViewTrap']) {
  test(candidate + ' replacement fences old handles, effects and queued work after durable retirement', async () => {
    const h = host(), p = probe(), a = await acquire(h, p, programs.basic, persistent())
    accepted(post(h, a, 'change', 2, { persist: true }))
    await finish(h.whenIdle())
    const effectId = p.effects[0].effectId
    const frameSeq = latest(p).frameSeq
    const durable = disk.get(stateFile())
    p.reset()
    let replacement, before, after
    await queued(h, a, p, () => {
      accepted(post(h, a, 'add', 4))
      before = watch(h.requestSnapshot(a))
      replacement = watch(h.replaceProgram(a, programs[candidate], persistent('candidate/v')))
      accepted(post(h, a, 'add', 5))
      after = watch(h.requestSnapshot(a))
    })
    let committed
    if (candidate === 'initEffect') committed = await finish(replacement)
    else await rejects(replacement, candidate === 'initTrap' ? 'array index out of bounds (in init, line 11)' : 'ACTOR_NOT_READY')
    assert.equal(stateOf(await finish(before)).n, 7)
    await rejects(after, candidate === 'initEffect' ? 'INVALID_HANDLE' : 'ACTOR_NOT_READY')
    await finish(h.whenIdle())
    rejected(post(h, a))
    rejected(h.postEffectResult(a, effectId, 'ok'))
    assert.equal(unpack(JSON.parse(disk.get(stateFile())).value).n, 7)
    assert.equal(JSON.parse(disk.get(stateFile())).stamp, programs.basic.stamp)
    assert.notEqual(disk.get(stateFile()), durable)
    assert.equal(count('task-submit'), count('task-result'))
    assert.equal(count('save'), candidate === 'initTrap' ? 1 : 2)
    assert.equal(p.saved.length, candidate === 'initEffect' ? 1 : 0)
    const oldFrames = p.frames.filter(frame => frame.appId === a.appId)
    assert.deepEqual(oldFrames.map(frame => frame.view.text), ['n=3', 'n=7'])
    assert(oldFrames.every((frame, i) => frame.vmGeneration === a.vmGeneration && frame.frameSeq === frameSeq + i + 1))
    assert.deepEqual(p.snapshots.map(value => stateOf(value).n), candidate === 'initEffect' ? [1] : [])
    assert.equal(disk.has(stateFile('candidate/v')), candidate !== 'initTrap')
    assert.equal(p.effects.length, candidate === 'initEffect' ? 1 : 0)
    if (committed) {
      assert.equal((await snapshot(h, committed)).n, 1)
      assert.equal(p.effects[0].vmGeneration, committed.vmGeneration)
      await finish(h.release(committed))
    }
    const b = await acquire(h, p, programs.basic, persistent(), a.appId)
    assert.equal((await snapshot(h, b)).n, 7)
    const q = probe(), c = await acquire(h, q, programs.basic, persistent('candidate/v'))
    assert.equal((await snapshot(h, c)).n, 1)
  })
}

for (const operation of ['promote', 'replace']) {
  test('release queued after ' + operation + ' follows committed handle and performs one final save', async () => {
    const h = host(), p = probe(), a = await acquire(h, p)
    accepted(post(h, a, 'add', 3))
    p.reset()
    let transition, closing
    await queued(h, a, p, () => {
      transition = watch(operation === 'promote' ? h.promote(a, 'LIVE_PERSISTENT', 'target/v') :
        h.replaceProgram(a, programs.newer, persistent('target/v')))
      closing = watch(h.release(a, { saveState: true }))
      assert.equal(closing.done, false)
    })
    const b = await finish(transition)
    await finish(closing)
    assert.equal(b.appId, 'target/v')
    assert.equal(b.vmGeneration, JSON.parse(disk.get(stateFile('target/v'))).vmGeneration)
    assert.equal(count('save'), 1)
    assert.equal(count('task-submit'), count('task-result'))
    assert.equal(p.saved.length, 1)
    const saved = JSON.parse(disk.get(stateFile('target/v')))
    assert.equal(saved.stamp, operation === 'replace' ? programs.newer.stamp : programs.basic.stamp)
    assert.equal(stateOf(JSON.stringify(saved.value)).n, operation === 'replace' ? 5 : 4)
    rejected(post(h, a))
    rejected(post(h, b))
    await finish(h.release(b, { saveState: true }))
    assert.equal(count('save'), 1)
    const c = await acquire(h, p, operation === 'replace' ? programs.newer : programs.basic, persistent('target/v'))
    assert.equal((await snapshot(h, c)).n, operation === 'replace' ? 5 : 4)
  })

  test('pending acquire behind ' + operation + ' does not count as an earlier active lease', async () => {
    const h = host(), p = probe(), a = await acquire(h, p)
    let transition, attaching
    await queued(h, a, p, () => {
      transition = watch(operation === 'promote' ? h.promote(a, 'LIVE_PERSISTENT', 'target/v') :
        h.replaceProgram(a, programs.newer, options()))
      attaching = watch(h.acquire(a.appId, programs.basic, options(), p.subscriber))
      assert.equal(transition.done, false)
      assert.equal(attaching.done, false)
    })
    const b = await finish(transition)
    await rejects(attaching, 'INVALID_HANDLE')
    assert.equal((await snapshot(h, b)).n, operation === 'replace' ? 5 : 1)
    const config = operation === 'promote' ? persistent('target/v') : options()
    const c = await acquire(h, p, operation === 'replace' ? programs.newer : programs.basic, config, b.appId)
    assert.notEqual(c.leaseId, b.leaseId)
    accepted(post(h, c, 'add', 2))
    assert.equal((await snapshot(h, b)).n, operation === 'replace' ? 7 : 3)
  })
}

for (const phase of ['initial', 'refresh']) {
  test('dispose reentrant from ' + phase + ' initialization frame cancels refresh continuation and activation', async () => {
    const h = host(), p = probe()
    let disposing
    p.frameHook = frame => {
      if (frame.view.text !== (phase === 'initial' ? 'n=1' : 'n=11')) return
      p.frameHook = null
      disposing = watch(h.dispose())
    }
    const activation = watch(h.acquire('', programs.refreshed, persistent(), p.subscriber))
    await until(() => disposing !== undefined)
    await finish(disposing)
    await rejects(activation, 'ACTOR_NOT_READY')
    assert.deepEqual(p.frames.map(frame => frame.view.text), phase === 'initial' ? ['n=1'] : ['n=1', 'n=11'])
    assert.deepEqual(p.snapshots.map(value => stateOf(value).n), phase === 'initial' ? [1] : [1, 11])
    assert.equal(count('save'), phase === 'initial' ? 1 : 2)
    assert.equal(p.effects.length, phase === 'initial' ? 0 : 1)
    assert.equal(p.saved.length, phase === 'initial' ? 1 : 2)
    assert.equal(p.errors.length, 0)
    assert.equal(count('task-submit'), count('task-result'))
    const before = records.length
    advance(10000)
    assert.equal(records.length, before)
    assert.equal(timers.size, 0)
  })
}

test('normal initialization refresh view failure succeeds with durable state and effects before rendering', async () => {
  const h = host(), p = probe()
  p.frameHook = () => {
    assert.equal(count('save'), 1)
    records.push({ type: 'first-frame-delivered' })
    p.frameHook = null
  }
  const a = await acquire(h, p, programs.refreshViewTrap, persistent())
  assert.deepEqual(sequence(), ['save', 'snapshot', 'saved', 'frame', 'save', 'snapshot', 'effect', 'saved', 'error'])
  assert.deepEqual(p.frames.map(frame => frame.view.text), ['n=1'])
  const first = latest(p), immutable = JSON.stringify(first)
  assert.deepEqual(p.snapshots.map(value => stateOf(value).n), [1, 11])
  assert.deepEqual(p.errors.map(error => [error.kind, error.inputSeq]), [['view', undefined]])
  assert.equal(count('save'), 2)
  assert.equal(count('task-submit'), count('task-result'))
  assert.equal(p.effects.length, 1)
  assert.deepEqual(p.effects[0].params, ['label', 'refresh', 'value', '11'])
  assert.equal(p.effects[0].vmGeneration, a.vmGeneration)
  const saves = records.flatMap((record, index) => record.type === 'save' ? [index] : [])
  const delivered = records.findIndex(record => record.type === 'first-frame-delivered')
  assert(saves[0] < delivered && delivered < saves[1])
  const state = await snapshot(h, a)
  assert.deepEqual(state, { n: 11, calls: 0, refreshes: 1, marks: [], badView: true })
  assert.deepEqual(stateOf(JSON.stringify(JSON.parse(disk.get(stateFile())).value)), state)
  accepted(post(h, a, 'recover', 1))
  accepted(h.postEffectResult(a, p.effects[0].effectId, 'ok'))
  assert.equal((await snapshot(h, a)).refreshes, 1)
  assert.equal((await snapshot(h, a)).n, 14)
  assert.equal(JSON.stringify(first), immutable)
})

test('replacement refresh view failure retains first frame and publishes durable effects without rerun', async () => {
  const h = host(), p = probe(), old = await acquire(h, p)
  p.reset()
  p.frameHook = frame => {
    assert.equal(frame.vmGeneration, JSON.parse(disk.get(stateFile('replacement/v'))).vmGeneration)
    assert.equal(frame.appId, 'replacement/v')
    assert.equal(count('save'), 1)
    assert.equal(p.snapshots.length, 1)
    records.push({ type: 'first-frame-delivered' })
    p.frameHook = null
  }
  const a = await finish(h.replaceProgram(old, programs.refreshViewTrap, persistent('replacement/v')))
  rejected(post(h, old))
  assert.equal(a.vmGeneration, JSON.parse(disk.get(stateFile('replacement/v'))).vmGeneration)
  assert.deepEqual(sequence(), ['save', 'snapshot', 'saved', 'frame', 'save', 'snapshot', 'effect', 'saved', 'error'])
  assert.deepEqual(p.frames.map(frame => frame.view.text), ['n=1'])
  const first = latest(p), immutable = JSON.stringify(first)
  assert.deepEqual(p.snapshots.map(value => stateOf(value).n), [1, 11])
  assert.deepEqual(p.errors.map(error => [error.kind, error.inputSeq]), [['view', undefined]])
  assert.equal(count('save'), 2)
  assert.equal(count('task-submit'), count('task-result'))
  assert.equal(p.effects.length, 1)
  assert.deepEqual(p.effects[0].params, ['label', 'refresh', 'value', '11'])
  assert.equal(p.effects[0].appId, a.appId)
  assert.equal(p.effects[0].vmGeneration, a.vmGeneration)
  const saves = records.flatMap((record, index) => record.type === 'save' ? [index] : [])
  const delivered = records.findIndex(record => record.type === 'first-frame-delivered')
  assert(saves[0] < delivered && delivered < saves[1])
  const state = await snapshot(h, a)
  assert.deepEqual(state, { n: 11, calls: 0, refreshes: 1, marks: [], badView: true })
  const saved = JSON.parse(disk.get(stateFile('replacement/v')))
  assert.equal(saved.stamp, programs.refreshViewTrap.stamp)
  assert.deepEqual(stateOf(JSON.stringify(saved.value)), state)
  accepted(post(h, a, 'recover', 1))
  accepted(h.postEffectResult(a, p.effects[0].effectId, 'ok'))
  assert.equal((await snapshot(h, a)).n, 14)
  assert.equal((await snapshot(h, a)).refreshes, 1)
  assert.equal(JSON.stringify(first), immutable)
})

test('staged successful replacement commits each state before its corresponding initialization frame', async () => {
  const h = host(), p = probe(), old = await acquire(h, p)
  p.reset()
  p.frameHook = frame => {
    assert.equal(count('save'), frame.view.text === 'n=1' ? 1 : 2)
    assert.equal(p.effects.length, frame.view.text === 'n=1' ? 0 : 1)
    records.push({ type: 'frame-delivery-completed', text: frame.view.text })
  }
  const a = await finish(h.replaceProgram(old, programs.refreshed, persistent('replacement/v')))
  p.frameHook = null
  assert.deepEqual(sequence(), ['save', 'snapshot', 'saved', 'frame', 'save', 'snapshot', 'effect', 'saved', 'frame'])
  assert.deepEqual(records.filter(record => ['frame-delivery-completed', 'save', 'effect'].includes(record.type))
    .map(record => record.type === 'frame-delivery-completed' ? record.text : record.type), ['save', 'n=1', 'save', 'effect', 'n=11'])
  assert.equal((await snapshot(h, a)).refreshes, 1)
  assert.equal(count('task-submit'), count('task-result'))
  assert.equal(count('save'), 2)
  assert.equal(p.effects.length, 1)
})

for (const program of ['refreshed', 'refreshViewTrap']) {
  test('dispose from first committed replacement frame suppresses ' + program + ' refresh and persistence', async () => {
    const h = host(), p = probe(), old = await acquire(h, p)
    p.reset()
    let disposing
    p.frameHook = frame => {
      p.frameHook = null
      assert.equal(frame.vmGeneration, JSON.parse(disk.get(stateFile('replacement/v'))).vmGeneration)
      assert.equal(frame.appId, 'replacement/v')
      assert.equal(count('save'), 1)
      disposing = watch(h.dispose())
    }
    const replacing = watch(h.replaceProgram(old, programs[program], persistent('replacement/v')))
    await until(() => disposing !== undefined)
    await finish(disposing)
    await rejects(replacing, 'ACTOR_NOT_READY')
    assert.deepEqual(sequence(), ['save', 'snapshot', 'saved', 'frame'])
    assert.deepEqual(p.frames.map(frame => frame.view.text), ['n=1'])
    assert.deepEqual(p.snapshots.map(value => stateOf(value).n), [1])
    assert.equal(count('save'), 1)
    assert.equal(count('task-submit'), count('task-result'))
    assert.equal(p.saved.length, 1)
    assert.equal(p.effects.length + p.errors.length, 0)
    assert.equal(stateOf(JSON.stringify(JSON.parse(disk.get(stateFile('replacement/v'))).value)).n, 1)
    const before = records.length
    advance(10000)
    assert.equal(records.length, before)
    assert.equal(timers.size, 0)
  })
}

test('failed initialization immediately reacquires same program and key after external state correction', async () => {
  const h = host(), p = probe(), q = probe(), started = now
  external(programs.basic, encoded(-1))
  await rejects(h.acquire('', programs.basic, persistent(), p.subscriber), 'ACTOR_NOT_READY')
  assert.deepEqual(p.errors.map(error => error.kind), ['view'])
  assert.equal(p.frames.length, 0)
  assert.equal(timers.size, 0)
  external(programs.basic, encoded(23))
  const previous = records.length
  const a = await acquire(h, q, programs.basic, persistent(), 'project/version')
  assert.equal(now, started)
  assert.equal(a.appId, 'project/version')
  assert.deepEqual(q.frames.map(frame => frame.view.text), ['n=23'])
  assert.equal((await snapshot(h, a)).n, 23)
  assert.equal(q.errors.length, 0)
  assert.equal(p.frames.length, 0)
  assert.equal(p.errors.length, 1)
  assert(records.slice(previous).some(record => record.type === 'task-submit' && record.request.kind === 'load'))
  assert.equal(count('task-submit'), count('task-result'))
  assert.equal(count('publication'), 2)
  assert.equal(count('save'), 0)
})

test('requestDraw with more than 240 nodes on empty mailbox delivers one complete frame', async () => {
  const h = host(), p = probe(), a = await acquire(h, p)
  p.reset()
  const draws = Array.from({ length: 300 }, (_, i) => draw(i + 1))
  accepted(h.requestDraw(a, draws))
  assert.equal(p.frames.length, 1)
  assert.equal(latest(p).view, null)
  assert.deepEqual(latest(p).gfx.map(item => [item.nodeId, item.ops[0].x]), draws.map(item => [item.nodeId, 1]))
  assert.equal(p.errors.length, 0)
  assert.equal(timers.size, 0)
  await finish(h.release(a))
})

test('large queued requestDraw occupies one event slot rather than one slot per node', async () => {
  const h = host(), p = probe(), a = await acquire(h, p)
  p.reset()
  let barrier
  await queued(h, a, p, () => {
    accepted(h.requestDraw(a, Array.from({ length: 300 }, (_, i) => draw(i + 1))))
    for (let i = 0; i < 239; i++) accepted(post(h, a, 'add', 1))
    pressure(post(h, a, 'add', 1000))
    barrier = watch(h.requestSnapshot(a))
  })
  assert.equal(stateOf(await finish(barrier)).n, 240)
  const gfxFrames = p.frames.filter(frame => frame.gfx.length > 0)
  assert.equal(gfxFrames.length, 1)
  assert.deepEqual(gfxFrames[0].gfx.map(item => [item.nodeId, item.ops[0].x]),
    Array.from({ length: 300 }, (_, i) => [i + 1, 1]))
  assert.equal(p.errors.length, 0)
  await finish(h.release(a))
})

test('requestDraw backpressure leaves overlapping queued nodes unchanged and admits no partial new nodes', async () => {
  const h = host(), p = probe(), a = await acquire(h, p)
  p.reset()
  let barrier
  await queued(h, a, p, () => {
    accepted(h.requestDraw(a, [draw(1)]))
    for (let i = 0; i < 239; i++) accepted(h.postTick(a, tick('fast-' + i, 1), false))
    pressure(h.requestDraw(a, [draw(1, 'drawOther'), draw(2)]))
    pressure(h.requestDraw(a, [draw(1, 'drawOther'), draw(1, 'draw', 2)]))
    coalesced(h.requestDraw(a, [draw(1)]))
    barrier = watch(h.requestSnapshot(a))
  })
  assert.equal(stateOf(await finish(barrier)).n, 240)
  assert.deepEqual(p.frames.flatMap(frame => frame.gfx).map(item => [item.nodeId, item.ops[0].x]), [[1, 1]])
  p.reset()
  accepted(h.requestDraw(a, [draw(1, 'drawOther'), draw(2)]))
  assert.equal(p.frames.length, 1)
  assert.deepEqual(latest(p).gfx.map(item => [item.nodeId, item.ops[0].x]), [[1, 1240], [2, 240]])
  assert.equal(p.errors.length, 0)
  await finish(h.release(a))
})

test('every world view carries detached preorder scenes through acquire, promotion, replacement and resume', async () => {
  const h = host(), p = probe()
  let a = await acquire(h, p, programs.worldRefreshed, options('PREVIEW'))
  assertScenes(latest(p), 1)
  assert.equal(p.snapshots.length, 0)
  const generation = a.vmGeneration
  p.reset()
  a = await finish(h.promote(a, 'LIVE_PERSISTENT', 'world/version'))
  assert.equal(a.vmGeneration, generation)
  assert.equal(p.frames.length, 2)
  assertScenes(p.frames[0], 1)
  assertScenes(latest(p), 2)
  external(programs.worldRefreshed, encoded(7), 'world/version')
  p.reset()
  accepted(h.postRefresh(a, 'APP'))
  await finish(h.whenIdle())
  a = p.handles[p.handles.length - 1]
  assert.equal(p.frames.length, 2)
  assertScenes(p.frames[0], 7)
  assertScenes(p.frames[1], 8)
  a = await finish(h.replaceProgram(a, programs.world, persistent('world/version', encoded(8))))
  assertScenes(latest(p), 8)
  const previous = latest(p)
  const immutable = JSON.stringify(previous)
  accepted(post(h, a, 'add', 1))
  await finish(h.whenIdle())
  assertScenes(latest(p), 9)
  assert.equal(JSON.stringify(previous), immutable)
  previous.scenes[0].spec.bodies[0].position[0] = 999
  previous.scenes[1].spec.bodies.length = 0
  accepted(h.requestView(a))
  assertScenes(latest(p), 9)
  await finish(h.release(a))
  p.reset()
  a = await acquire(h, p, programs.world, persistent('world/version'), 'world/version')
  assertScenes(latest(p), 9)
  advance(101)
  accepted(h.postSurfaceFrame(a, surface(0, [], [draw()])))
  await finish(h.whenIdle())
  assertScenes(latest(p), 9)
  accepted(h.requestDraw(a, [draw()]))
  await finish(h.whenIdle())
  assert.equal(latest(p).view, null)
  assert.equal(latest(p).scenes, undefined)
  assert.equal(p.errors.length, 0)
})

test('initial live refresh and committed replacement attach scenes after corresponding durable commits', async () => {
  const h = host(), p = probe()
  const a = await acquire(h, p, programs.worldRefreshed, persistent())
  assert.equal(p.frames.length, 2)
  assertScenes(p.frames[0], 1)
  assertScenes(p.frames[1], 2)
  p.reset()
  const b = await finish(h.replaceProgram(a, programs.worldRefreshed, persistent('fresh/version')))
  assert.equal(p.frames.length, 2)
  assertScenes(p.frames[0], 1)
  assertScenes(p.frames[1], 2)
  assert.deepEqual(sequence(), ['save', 'snapshot', 'saved', 'frame', 'save', 'snapshot', 'saved', 'frame'])
  assert.equal(count('task-submit'), count('task-result'))
  assert.equal((await snapshot(h, b)).n, 2)
})

test('SCENE admissions detach all fields and arrays and remain ordered barriers', async () => {
  const h = host(), p = probe(), a = await acquire(h, p, programs.world)
  let seq
  await queued(h, a, p, () => {
    accepted(h.postTick(a, tick('same', 1), false))
    const event = sceneInput(a, sceneEvent({ dir: [0.5, -0.25, 1] }))
    seq = accepted(h.postInput(a, event))
    event.payload.scene.dir[0] = 100
    event.payload.scene.dir = [100, 100, 100]
    event.payload.scene.kind = 'changed'
    event.payload.scene.body = 'changed'
    event.payload.scene.other = 'changed'
    event.payload.scene.x = 100
    event.payload.scene.y = 100
    event.payload.scene.z = 100
    event.payload.scene.speed = 100
    event.payload.scene.bodies[0] = 'changed'
    event.payload.scene.values[0] = 100
    event.payload.scene = sceneEvent({ speed: 100 })
    event.skipIfSame = false
    accepted(h.postTick(a, tick('same', 2), false))
  })
  const state = await snapshot(h, a)
  assert.equal(state.n, 8)
  assert.deepEqual(state.marks, [1, 1, 2, 3, 6, 0.5, -0.25, 1, 2])
  assert.equal(state.calls, 3)
  assert(p.frames.some(frame => frame.appliedSeq === seq && frame.scenes[0].spec.bodies[0].position[0] === 6))
  assertScenes(latest(p), 8)
  assert.equal(p.errors.length, 0)
})

test('SCENE directions default missing components to zero', async () => {
  for (const [dir, expected] of [[undefined, [0, 0, 0]], [[], [0, 0, 0]], [[0.5], [0.5, 0, 0]]]) {
    const h = host(), p = probe(), a = await acquire(h, p, programs.world)
    accepted(h.postInput(a, sceneInput(a, sceneEvent({ dir }))))
    assert.deepEqual((await snapshot(h, a)).marks, [1, 2, 3, 6, ...expected])
    assert.equal(p.errors.length, 0)
  }
})

test('malformed SCENE fields are rejected without queueing or executing', async () => {
  const h = host(), p = probe(), a = await acquire(h, p, programs.world)
  p.reset()
  for (const field of ['kind', 'body', 'other']) {
    for (const value of [undefined, null, 1, {}, []]) {
      rejected(h.postInput(a, sceneInput(a, sceneEvent({ [field]: value }))))
    }
  }
  for (const field of ['x', 'y', 'z', 'speed']) {
    for (const value of [undefined, null, '1', NaN, Infinity, -Infinity]) {
      rejected(h.postInput(a, sceneInput(a, sceneEvent({ [field]: value }))))
    }
  }
  for (const value of [undefined, null, 'body', {}, [1], [undefined], Array(1)]) {
    rejected(h.postInput(a, sceneInput(a, sceneEvent({ bodies: value }))))
  }
  for (const value of [undefined, null, 1, {}, ['1'], [NaN], [Infinity], Array(1)]) {
    rejected(h.postInput(a, sceneInput(a, sceneEvent({ values: value }))))
  }
  for (const value of [null, 1, 'direction', {}, ['1'], [NaN], [Infinity], Array(1)]) {
    rejected(h.postInput(a, sceneInput(a, sceneEvent({ dir: value }))))
  }
  for (const value of [null, 1, {}, []]) rejected(h.postInput(a, sceneInput(a, value)))
  rejected(h.postInput(a, input(a, 'worldEvent', 0, { kind: 'SCENE' })))
  rejected(h.postInput(a, sceneInput(a, sceneEvent(), { skipIfSame: 'true' })))
  assert.equal(p.frames.length, 0)
  assert.equal(p.snapshots.length, 0)
  assert.equal(p.errors.length, 0)
  assert.equal((await snapshot(h, a)).n, 1)
})

test('skipIfSame does not bypass accepted scene turn publication, effects or default dispatch', async () => {
  const h = host(), p = probe(), a = await acquire(h, p, programs.world)
  p.reset()
  accepted(h.postInput(a, sceneInput(a, sceneEvent(), { action: 'worldNoop' })))
  await finish(h.whenIdle())
  assert.equal(p.frames.length, 1)
  assert.equal(p.snapshots.length, 1)
  assert.equal(p.effects.length, 1)
  accepted(h.postInput(a, sceneInput(a, sceneEvent(), { action: 'worldNoop', skipIfSame: false })))
  await finish(h.whenIdle())
  assert.equal(p.frames.length, 2)
  assert.equal(p.snapshots.length, 2)
  assert.equal(p.effects.length, 2)
  accepted(post(h, a, 'add', 0, { skipIfSame: true }))
  await finish(h.whenIdle())
  assert.equal(p.frames.length, 3)
  assert.equal((await snapshot(h, a)).calls, 1)
})

for (const program of ['worldTrap', 'worldInvalid']) {
  test(program + ' rejects initial and replacement frames without publishing partial scenes', async () => {
    const h = host(), p = probe()
    await rejects(h.acquire('', programs[program], options(), p.subscriber), 'ACTOR_NOT_READY')
    assert.equal(p.frames.length, 0)
    assert.equal(p.errors.length, 1)
    assert.equal(p.errors[0].kind, 'world')
    const a = await acquire(h, p, programs.world)
    const previous = latest(p), immutable = JSON.stringify(previous)
    p.reset()
    await rejects(h.replaceProgram(a, programs[program], options()), 'ACTOR_NOT_READY')
    assert.equal(p.frames.length, 0)
    assert.equal(JSON.stringify(previous), immutable)
    const failedHandle = { ...a, vmGeneration: a.vmGeneration + 1 }
    rejected(post(h, failedHandle, 'add', 1))
    await rejects(h.requestSnapshot(failedHandle), 'INVALID_HANDLE')
    assert.equal((await snapshot(h, a)).n, 1)
    accepted(post(h, a, 'add', 1))
    await finish(h.whenIdle())
    assertScenes(latest(p), 2)
    assert.equal(latest(p).vmGeneration, a.vmGeneration)
    assert.equal((await snapshot(h, a)).n, 2)
  })
}

test('replacement saves dirty persistent world state before publishing the committed candidate', async () => {
  const h = host(), p = probe()
  external(programs.world, encoded())
  const a = await acquire(h, p, programs.world, persistent())
  accepted(h.postInput(a, sceneInput(a)))
  accepted(h.postInput(a, sceneInput(a)))
  assert.equal((await snapshot(h, a)).n, 9)
  assert.equal(unpack(JSON.parse(disk.get(stateFile())).value).n, 1)
  p.reset()
  p.frameHook = () => {
    assert.equal(count('save'), 2)
    rejected(post(h, a))
  }
  const b = await finish(h.replaceProgram(a, programs.newer, persistent('candidate/v')))
  p.frameHook = null
  assert.equal(b.appId, 'candidate/v')
  assert.equal(b.vmGeneration, JSON.parse(disk.get(stateFile('candidate/v'))).vmGeneration)
  assert.deepEqual(sequence(), ['save', 'save', 'snapshot', 'saved', 'frame'])
  assert.deepEqual(p.saved, ['candidate'])
  assert.equal(count('save'), 2)
  assert.equal(count('task-submit'), count('task-result'))
  const durable = JSON.parse(disk.get(stateFile()))
  assert.equal(durable.stamp, programs.world.stamp)
  assert.equal(unpack(durable.value).n, 9)
  assert.equal(disk.has(stateFile('candidate/v')), true)
  assert.equal(unpack(JSON.parse(disk.get(stateFile('candidate/v'))).value).n, 5)
  assert.equal((await snapshot(h, b)).n, 5)
  await finish(h.release(b))
  const c = await acquire(h, p, programs.world, persistent())
  assertScenes(latest(p), 9)
  assert.equal((await snapshot(h, c)).n, 9)
})

for (const candidate of ['initTrap', 'initialViewTrap', 'worldTrap', 'worldInvalid']) {
  test(candidate + ' replacement commits dirty old world state before retiring it and validates candidate publication', async () => {
    const h = host(), p = probe()
    external(programs.world, encoded())
    const a = await acquire(h, p, programs.world, persistent())
    accepted(h.postInput(a, sceneInput(a)))
    await finish(h.whenIdle())
    const frameSeq = latest(p).frameSeq
    const durable = disk.get(stateFile())
    p.reset()
    const error = await rejects(h.replaceProgram(a, programs[candidate], persistent('candidate/v')),
      candidate === 'initTrap' ? 'array index out of bounds (in init, line 11)' : 'ACTOR_NOT_READY')
    assert.equal(error.handleInvalidated, true)
    assert.equal(error.message, error.cause.message)
    assert.equal(error.code, error.cause.code)
    assert.equal(count('save'), candidate === 'initTrap' ? 1 : 2)
    assert.equal(count('task-submit'), count('task-result'))
    assert.equal(p.frames.length + p.saved.length + p.effects.length + p.errors.length, 0)
    assert.equal(p.snapshots.length, 0)
    assert.notEqual(disk.get(stateFile()), durable)
    assert.equal(unpack(JSON.parse(disk.get(stateFile())).value).n, 5)
    assert.equal(disk.has(stateFile('candidate/v')), candidate !== 'initTrap')
    rejected(post(h, a))
    rejected(h.requestView(a))
    const b = await acquire(h, p, programs.world, persistent())
    assert(b.vmGeneration > a.vmGeneration)
    assert.equal((await snapshot(h, b)).n, 5)
    assertScenes(latest(p), 5)
    assert.equal(latest(p).frameSeq, 1)
    assert(frameSeq > 0)
  })
}

test('replacement save failure rolls back the candidate and preserves the old world handle and dirty state', async () => {
  const h = host(), p = probe()
  external(programs.world, encoded())
  const a = await acquire(h, p, programs.world, persistent())
  accepted(h.postInput(a, sceneInput(a)))
  await finish(h.whenIdle())
  const frameSeq = latest(p).frameSeq
  const durable = disk.get(stateFile())
  p.reset()
  failure = 'rename'
  const error = await rejects(h.replaceProgram(a, programs.newer, persistent('candidate/v')), 'ACTOR_NOT_READY')
  assert.equal(error.handleInvalidated, false)
  assert.equal(count('save'), 0)
  assert.equal(count('task-submit'), count('task-result'))
  assert(records.some(record => record.type === 'task-result' && record.reply.result?.status === 'FAILED'))
  assert.equal(p.frames.length + p.snapshots.length + p.saved.length + p.effects.length + p.errors.length, 0)
  assert.equal(disk.get(stateFile()), durable)
  assert.equal(disk.has(stateFile('candidate/v')), false)
  assert.equal((await snapshot(h, a)).n, 5)
  accepted(h.requestView(a))
  await finish(h.whenIdle())
  assert.equal(latest(p).vmGeneration, a.vmGeneration)
  assert.equal(latest(p).frameSeq, frameSeq + 1)
  assertScenes(latest(p), 5)
  failure = ''
  p.reset()
  try {
    let b
    await assert.doesNotReject(async () => {
      b = await finish(h.replaceProgram(a, programs.newer, persistent('candidate/v')))
    }, 'replacement must retry after a refused old-world save without losing the old handle')
    assert.equal(count('save'), 2)
    assert.equal(count('task-submit'), count('task-result'))
    const savedState = JSON.parse(disk.get(stateFile()))
    assert.equal(savedState.stamp, programs.world.stamp)
    assert.equal(unpack(savedState.value).n, 5)
    assert.deepEqual(p.saved, ['candidate'])
    assert.equal((await snapshot(h, b)).n, 5)
    assert.equal(latest(p).vmGeneration, b.vmGeneration)
    assert.equal(disk.has(stateFile('candidate/v')), true)
    rejected(post(h, a))
  } finally {
    await finish(h.dispose())
    hosts.splice(hosts.indexOf(h), 1)
  }
})

test('world build and SCENE handler errors drain animation work once and allow explicit recovery', async () => {
  for (const kind of ['world', 'scene']) {
    const h = host(), p = probe(), a = await acquire(h, p, programs.world)
    p.reset()
    let seq
    await queued(h, a, p, () => {
      seq = kind === 'world' ? accepted(post(h, a, 'change', 30)) :
        accepted(h.postInput(a, sceneInput(a, sceneEvent(), { action: 'worldFail' })))
      accepted(h.postTick(a, tick('fast', 100), false))
      accepted(h.postSurfaceFrame(a, surface(100)))
      accepted(post(h, a, 'add', kind === 'world' ? -30 : 1))
    })
    await finish(h.whenIdle())
    assert.equal(p.effects.length, kind === 'world' ? 1 : 0)
    assertScenes(latest(p), kind === 'world' ? 1 : 2)
    assert.equal((await snapshot(h, a)).calls, kind === 'world' ? 2 : 1)
    assert.equal(p.errors.length, 1, JSON.stringify(p.errors))
    assert.equal(p.errors[0].kind, kind, JSON.stringify(p.errors))
    assert.equal(p.errors[0].inputSeq, seq)
  }
})

test('world-only saves apply loop start first, defer edits and publish committed snapshot without surface work', async () => {
  const h = host(), p = probe(), a = await acquire(h, p, programs.world, persistent())
  accepted(h.postInput(a, sceneInput(a)))
  await finish(h.whenIdle())
  p.reset()
  accepted(h.postSurfaceFrame(a, worldFrame({ loopStartedAt: now, actions: ['fail'], draws: [draw(1, 'drawTrap')] })))
  await finish(h.whenIdle())
  assert.equal(ioCount(), 0)
  advance(4999)
  accepted(h.postSurfaceFrame(a, worldFrame()))
  await finish(h.whenIdle())
  assert.equal(ioCount(), 0)
  advance(1)
  h.notifyEdits(a, true)
  accepted(h.postSurfaceFrame(a, worldFrame()))
  await finish(h.whenIdle())
  assert.equal(ioCount(), 0)
  h.notifyEdits(a, false)
  accepted(h.postSurfaceFrame(a, worldFrame()))
  await finish(h.whenIdle())
  assert.equal(count('task-submit'), count('task-result'))
  assert.equal(count('save'), 1)
  assert.equal(p.saved.length, 1)
  assert.equal(p.frames.length, 0)
  assert.equal(p.snapshots.length, 1)
  assert.equal(stateOf(p.snapshots[0]).n, 5)
  assert.equal(p.errors.length, 0)
  accepted(h.postSurfaceFrame(a, worldFrame({ worldStopping: true })))
  await finish(h.whenIdle())
  assert.equal(count('save'), 1)
  assert.equal((await snapshot(h, a)).n, 5)
})

test('world save requests are barriers and stopping saves precede later inputs and final release', async () => {
  const h = host(), p = probe(), a = await acquire(h, p, programs.world, persistent())
  let closing
  p.reset()
  await queued(h, a, p, () => {
    accepted(h.postSurfaceFrame(a, worldFrame({ loopStartedAt: now })))
    accepted(h.postInput(a, sceneInput(a)))
    accepted(h.postSurfaceFrame(a, worldFrame({ worldStopping: true })))
    accepted(h.postInput(a, sceneInput(a)))
    accepted(h.postSurfaceFrame(a, worldFrame()))
    closing = watch(h.release(a, { saveState: true }))
  })
  await finish(closing)
  assert.deepEqual(records.filter(record => record.type === 'save').map(record => unpack(record.payload.value).n), [5, 9])
  assert.equal(p.snapshots.length, 2)
  assert.equal(p.errors.length, 0)
})

test('world-only save turns separate adjacent coalescing surface and tick segments', async () => {
  const h = host(), p = probe(), a = await acquire(h, p)
  await queued(h, a, p, () => {
    accepted(h.postSurfaceFrame(a, surface(1)))
    accepted(h.postTick(a, tick('same', 2), false))
    accepted(h.postSurfaceFrame(a, worldFrame()))
    accepted(h.postSurfaceFrame(a, surface(3)))
    accepted(h.postTick(a, tick('same', 4), false))
  })
  assert.deepEqual((await snapshot(h, a)).marks, [1, 2, 3, 4])
  assert.equal(p.errors.length, 0)
})

test('world saves keep dirty state on failure and stopping retries publish only committed snapshot', async () => {
  const h = host(), p = probe(), a = await acquire(h, p, programs.world, persistent())
  accepted(h.postInput(a, sceneInput(a)))
  await finish(h.whenIdle())
  p.reset()
  failure = 'rename'
  accepted(h.postSurfaceFrame(a, worldFrame({ worldStopping: true })))
  await finish(h.whenIdle())
  assert.equal(count('save'), 0)
  assert.equal(p.snapshots.length, 0)
  assert.equal(count('task-submit'), count('task-result'))
  assert(records.some(record => record.type === 'task-result' && record.reply.result?.status === 'FAILED'))
  failure = ''
  accepted(h.postSurfaceFrame(a, worldFrame({ worldStopping: true })))
  await finish(h.whenIdle())
  assert.equal(count('save'), 1)
  assert.equal(count('task-submit'), count('task-result'))
  assert.equal(p.frames.length, 0)
  assert.equal(p.snapshots.length, 1)
  assert.equal(stateOf(p.snapshots[0]).n, 5)
  await assert.rejects(finish(h.dispose()), /STATE_PUBLISH_FAILED/)
  hosts.splice(hosts.indexOf(h), 1)
})

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function microtasks() {
  for (let i = 0; i < 100; i++) await Promise.resolve()
}
async function until(predicate) {
  for (let turns = 0; !predicate() && turns < 5000; turns++) {
    await Promise.resolve()
    if (!predicate()) runTimer()
  }
  assert(predicate(), 'expected async stage within bounded fake drain')
}
function delayedActors() {
  const actors = []
  const { AppActor } = load(path.join(root, 'runtime/AppActor.ets'))
  const factory = (callbacks, owner) => {
    const real = new AppActor(callbacks, owner)
    const control = { real, callbacks, owner, calls: [], gates: new Map(), facade: {} }
    control.hold = method => {
      const gate = deferred()
      control.gates.set(method, gate)
      return gate
    }
    for (const method of Object.getOwnPropertyNames(AppActor.prototype)) {
      if (method === 'constructor') continue
      control.facade[method] = (...args) => {
        control.calls.push(method)
        const gate = control.gates.get(method)
        if (!gate) return real[method](...args)
        control.gates.delete(method)
        if (['view', 'draw', 'buildScene'].includes(method)) {
          const value = real[method](...args)
          return gate.promise.then(() => value)
        }
        return gate.promise.then(() => real[method](...args))
      }
    }
    actors.push(control)
    if (actors.configure) actors.configure(control, actors.length - 1)
    return control.facade
  }
  return { actors, factory }
}

test('async initialization exposes no provisional handle and awaits first-frame validation', async () => {
  const { actors, factory } = delayedActors()
  let init, view
  actors.configure = actor => { init = actor.hold('initialize'); view = actor.hold('view') }
  const h = host(factory), p = probe()
  const opening = watch(h.acquire('', programs.basic, options(), p.subscriber))
  const idle = watch(h.whenIdle())
  await microtasks()
  assert.equal(opening.done, false)
  assert.equal(idle.done, false)
  assert.equal(opening.value, undefined)
  assert.equal(p.frames.length, 0)
  init.resolve()
  await microtasks()
  assert.equal(opening.done, false)
  assert.equal(p.frames.length, 0)
  view.resolve()
  await finish(opening)
  await finish(idle)
  assert.equal(p.frames.length, 1)
  accepted(post(h, opening.value))
})

for (const method of ['initialize', 'view', 'runWidgetRefresh']) {
  test('async ' + method + ' failure rejects startup and permits clean reacquisition', async () => {
    const { actors, factory } = delayedActors()
    let gate
    actors.configure = (actor, index) => { if (index === 0) gate = actor.hold(method) }
    const h = host(factory), p = probe()
    const opening = watch(h.acquire('', programs.basic, persistent(), p.subscriber))
    await microtasks()
    gate.reject(Error('delayed ' + method))
    await rejects(opening, 'ACTOR_NOT_READY')
    await finish(h.whenIdle())
    assert.equal(actors[0].calls.filter(call => call === 'dispose').length, 1)
    assert.equal(h.leases.size, 0)
    const a = await acquire(h, p, programs.basic, persistent())
    accepted(post(h, a))
  })
}

test('async dispatch holds its mailbox and lease while another actor progresses', async () => {
  const { actors, factory } = delayedActors()
  const h = host(factory), p = probe(), q = probe()
  const a = await acquire(h, p), b = await acquire(h, q)
  const gate = actors[0].hold('dispatch')
  accepted(post(h, a, 'add', 2))
  accepted(post(h, a, 'add', 3))
  const barrier = watch(h.requestSnapshot(a))
  const release = watch(h.release(a))
  const idle = watch(h.whenIdle())
  rejected(post(h, a))
  accepted(post(h, b, 'add', 7))
  assert.equal((await snapshot(h, b)).n, 8)
  await microtasks()
  assert.equal(barrier.done, false)
  assert.equal(release.done, false)
  assert.equal(idle.done, false)
  assert.equal(actors[0].owner.current.kind, 'INPUT')
  assert.equal(actors[0].owner.current.lease.pending, 2)
  assert.equal(actors[0].calls.filter(call => call === 'dispatch').length, 1)
  gate.resolve()
  await finish(release)
  await finish(idle)
  assert.equal(stateOf(await finish(barrier)).n, 6)
  assert.equal(actors[0].owner.current, null)
})

for (const method of ['dispatch', 'frameHandlers', 'draw']) {
  test('async ' + method + ' rejection settles ownership once and drains later barriers', async () => {
    const { actors, factory } = delayedActors()
    const h = host(factory), p = probe(), a = await acquire(h, p)
    const gate = actors[0].hold(method)
    if (method === 'dispatch') accepted(post(h, a, 'add', 2))
    else if (method === 'draw') accepted(h.requestDraw(a, [draw()]))
    else accepted(h.postSurfaceFrame(a, surface()))
    const barrier = watch(h.requestSnapshot(a))
    gate.reject(Error('delayed operation refused'))
    await finish(barrier)
    await finish(h.whenIdle())
    assert.equal(p.errors.length, 1)
    assert.equal(actors[0].owner.current, null)
    assert.equal(actors[0].owner.leases.get(a.leaseId).pending, 0)
    accepted(post(h, a, 'add', 3))
    assert.equal((await snapshot(h, a)).n, 4)
  })
}

test('async snapshot retains its exact barrier and prevents later mutation', async () => {
  const { actors, factory } = delayedActors()
  const h = host(factory), p = probe(), a = await acquire(h, p)
  const gate = actors[0].hold('snapshot')
  const barrier = watch(h.requestSnapshot(a))
  accepted(post(h, a, 'add', 9))
  await microtasks()
  assert.equal(barrier.done, false)
  assert.equal(actors[0].calls.filter(call => call === 'dispatch').length, 0)
  gate.resolve()
  assert.equal(stateOf(await finish(barrier)).n, 1)
  await finish(h.whenIdle())
  assert.equal((await snapshot(h, a)).n, 10)
})

test('async replacement reserves source and target until cleanup and refresh settle', async () => {
  const { actors, factory } = delayedActors()
  const h = host(factory), p = probe(), a = await acquire(h, p, programs.basic, persistent())
  const cleanup = actors[0].hold('dispose')
  let startup, refresh
  actors.configure = actor => { startup = actor.hold('initialize'); refresh = actor.hold('runWidgetRefresh') }
  const replacing = watch(h.replaceProgram(a, programs.newer, persistent('target/version')))
  accepted(post(h, a, 'add', 90))
  await rejects(h.acquire('', programs.basic, persistent(), p.subscriber), 'ACTOR_NOT_READY')
  await rejects(h.acquire('', programs.newer, persistent('target/version'), p.subscriber), 'ACTOR_NOT_READY')
  await until(() => actors[0].calls.includes('dispose'))
  assert.equal(startup, undefined, 'live actor retirement precedes candidate construction')
  assert.equal(actors[0].calls.filter(call => call === 'dispose').length, 1)
  cleanup.resolve()
  await until(() => startup !== undefined)
  assert(startup, 'candidate constructed after retirement')
  assert.equal(replacing.done, false)
  startup.resolve()
  await microtasks()
  assert.equal(replacing.done, false)
  await rejects(h.acquire('', programs.basic, persistent(), p.subscriber), 'ACTOR_NOT_READY')
  refresh.resolve()
  const b = await finish(replacing)
  await finish(h.whenIdle())
  assert.equal((await snapshot(h, b)).n, 5)
  rejected(post(h, a))
  assert.equal(actors[0].calls.filter(call => call === 'dispose').length, 1)
})

for (const reason of ['REPLACE', 'PROMOTE']) test('committed ' + reason + ' handle precedes candidate publications', async () => {
  const h = host(), p = probe(), a = await acquire(h, p, programs.basic, options('PREVIEW'))
  const events = []
  const onHandle = p.subscriber.onActorHandle
  p.subscriber.onActorHandle = (handle, committedReason) => {
    events.push({ type: 'handle', handle, reason: committedReason, owned: h.leases.get(handle.leaseId).handle === handle })
    onHandle(handle)
  }
  for (const method of ['onViewFrame', 'onStateSnapshot', 'onEffectRequest']) {
    const original = p.subscriber[method]
    p.subscriber[method] = (...args) => { events.push({ type: method }); original(...args) }
  }
  const b = await finish(reason === 'REPLACE' ? h.replaceProgram(a, programs.newer, persistent()) :
    h.promote(a, 'LIVE_PERSISTENT', persistent().persistKey))
  assert.equal(events[0].type, 'handle')
  assert.equal(events[0].handle, b)
  assert.equal(events[0].reason, reason)
  assert.equal(events[0].owned, true)
  assert.equal(events.filter(event => event.type === 'handle').length, 1)
  assert(events.some(event => event.type === 'onViewFrame'))
  assert(events.some(event => event.type === 'onStateSnapshot'))
  rejected(post(h, a))
  rejected(post(h, { ...b }))
  accepted(post(h, b))
})

for (const stage of ['cleanup', 'boundary']) test('dispose at replacement ' + stage + ' suppresses candidate publications', async () => {
  const { actors, factory } = delayedActors()
  const h = host(factory), p = probe(), a = await acquire(h, p, programs.basic, options('PREVIEW'))
  const cleanup = actors[0].hold('dispose')
  const handles = p.handles.length
  let closing
  p.subscriber.onActorHandle = handle => {
    p.handles.push(handle)
    if (stage === 'boundary') closing = watch(h.dispose())
  }
  p.reset()
  const replacing = watch(h.replaceProgram(a, programs.newer, persistent()))
  await until(() => actors[0].calls.includes('dispose'))
  assert.equal(p.handles.length, handles)
  assert.equal(p.frames.length + p.snapshots.length + p.effects.length, 0)
  if (stage === 'cleanup') closing = watch(h.dispose())
  cleanup.resolve()
  await rejects(replacing, 'ACTOR_NOT_READY')
  await finish(closing)
  await finish(h.whenIdle())
  assert.equal(p.handles.length, handles + (stage === 'boundary' ? 1 : 0))
  assert.equal(p.frames.length + p.snapshots.length + p.effects.length, 0)
  assert.equal(h.leases.size, 0)
  assert.equal(h.registry.size, 0)
})

test('async preview replacement rollback keeps target reserved through candidate cleanup', async () => {
  const { actors, factory } = delayedActors()
  const h = host(factory), p = probe(), a = await acquire(h, p, programs.basic, options('PREVIEW'))
  let startup, cleanup
  actors.configure = actor => { startup = actor.hold('initialize'); cleanup = actor.hold('dispose') }
  const replacing = watch(h.replaceProgram(a, programs.newer, persistent('target/version')))
  rejected(post(h, a, 'add', 4))
  await until(() => startup !== undefined)
  startup.reject(Error('load refused'))
  await microtasks()
  assert.equal(replacing.done, false)
  await rejects(h.acquire('', programs.newer, persistent('target/version'), p.subscriber), 'ACTOR_NOT_READY')
  cleanup.resolve()
  await rejects(replacing, 'ACTOR_NOT_READY')
  await finish(h.whenIdle())
  assert.equal(actors[0].real.ready(), true)
  assert.equal(h.registry.get(a.appId).actor, actors[0].facade)
  accepted(h.requestView(a))
  await finish(h.whenIdle())
  assert.equal(latest(p).view.text, 'n=1')
  assert.equal(count('save'), 0)
})

test('async promotion retains valid-handle bounded admission and settles stale queued inputs', async () => {
  const { actors, factory } = delayedActors()
  const h = host(factory), p = probe(), a = await acquire(h, p)
  const gate = actors[0].hold('promote')
  const promoting = watch(h.promote(a, 'LIVE_PERSISTENT', 'target/version'))
  for (let i = 0; i < 240; i++) accepted(post(h, a, 'add', 1))
  assert.equal(post(h, a).status, 'BACKPRESSURE')
  const barrier = watch(h.requestSnapshot(a))
  const idle = watch(h.whenIdle())
  gate.resolve()
  const b = await finish(promoting)
  await rejects(barrier, 'INVALID_HANDLE')
  await finish(idle)
  assert.equal((await snapshot(h, b)).n, 1)
  assert.equal(actors[0].owner.eventSlots, 0)
})

test('async shared release never saves or quiesces; final rejection waits for cleanup', async () => {
  const { actors, factory } = delayedActors()
  const h = host(factory), p = probe(), a = await acquire(h, p, programs.basic, persistent())
  const b = await acquire(h, p, programs.basic, persistent(), a.appId)
  await finish(h.release(a, { saveState: true }))
  assert.equal(actors[0].calls.includes('saveNow'), false)
  assert.equal(actors[0].calls.includes('quiesce'), false)
  accepted(post(h, b, 'add', 2))
  const save = actors[0].hold('saveNow'), cleanup = actors[0].hold('quiesce')
  const promise = h.release(b, { saveState: true }), closing = watch(promise)
  assert.equal(h.release(b), promise)
  save.reject(Error('final commit refused'))
  await microtasks()
  assert.equal(closing.done, false)
  assert.equal(h.leases.size, 1)
  cleanup.resolve()
  assert.match((await rejects(closing)).message, /final commit refused/)
  assert.equal(h.leases.size, 0)
  rejected(post(h, b))
  await finish(h.whenIdle())
})

for (const method of ['initialize', 'dispatch', 'snapshot']) {
  test('dispose awaits delayed ' + method + ' and actor cleanup without late revival', async () => {
    const { actors, factory } = delayedActors()
    let gate
    if (method === 'initialize') actors.configure = actor => { gate = actor.hold(method) }
    const h = host(factory), p = probe()
    let operation
    if (method === 'initialize') operation = watch(h.acquire('', programs.basic, persistent(), p.subscriber))
    else {
      const a = await acquire(h, p, programs.basic, persistent())
      gate = actors[0].hold(method)
      if (method === 'snapshot') operation = watch(h.requestSnapshot(a))
      else accepted(post(h, a, 'add', 2))
    }
    const cleanup = actors[0].hold('dispose')
    p.reset()
    const promise = h.dispose(), closing = watch(promise), idle = watch(h.whenIdle())
    assert.equal(h.dispose(), promise)
    await microtasks()
    assert.equal(closing.done, false)
    assert.equal(idle.done, false)
    gate.resolve()
    await microtasks()
    assert.equal(closing.done, false)
    cleanup.resolve()
    await finish(closing)
    await finish(idle)
    if (operation) await rejects(operation, method === 'snapshot' ? 'STATE_UNAVAILABLE' : 'ACTOR_NOT_READY')
    assert.equal(h.registry.size, 0)
    assert.equal(h.leases.size, 0)
    assert.equal(p.frames.length + p.snapshots.length + p.effects.length + p.saved.length, 0)
    assert.equal(actors[0].calls.filter(call => call === 'dispose').length, 1)
  })
}

for (const method of ['resume', 'frameHandlers', 'move', 'draw', 'surfaceSave', 'worldSave']) {
  test('async ' + method + ' retains turn ownership through snapshot and idle barriers', async () => {
    const { actors, factory } = delayedActors()
    const h = host(factory), p = probe(), a = await acquire(h, p, programs.basic)
    const gate = actors[0].hold(method)
    let admitted
    if (method === 'resume') admitted = h.postRefresh(a, 'APP')
    else if (method === 'move') admitted = post(h, a, 'pointer', 0, {
      kind: 'SURFACE_MOVE', payload: payload('POINTER', 0), draws: [draw()]
    })
    else if (method === 'draw') admitted = h.requestDraw(a, [draw()])
    else admitted = h.postSurfaceFrame(a, method === 'worldSave' ? worldFrame() : surface())
    accepted(admitted)
    const barrier = watch(h.requestSnapshot(a)), idle = watch(h.whenIdle())
    await microtasks()
    assert.equal(barrier.done, false)
    assert.equal(idle.done, false)
    assert.notEqual(actors[0].owner.current, null)
    gate.resolve()
    await finish(barrier)
    await finish(idle)
    assert.equal(actors[0].owner.current, null)
    assert.equal(p.errors.length, 0)
  })
}

test('async idle reconciliation waits before snapshot, first frame and reopen refresh', async () => {
  const { actors, factory } = delayedActors()
  const h = host(factory), p = probe(), a = await acquire(h, p, programs.refreshed, persistent())
  await finish(h.release(a))
  const gate = actors[0].hold('reconcileState')
  external(programs.refreshed, encoded(30))
  p.reset()
  const reopening = watch(h.acquire('', programs.refreshed, persistent(), p.subscriber))
  const idle = watch(h.whenIdle())
  await microtasks()
  assert.equal(reopening.done, false)
  assert.equal(idle.done, false)
  assert.equal(p.frames.length + p.snapshots.length, 0)
  gate.resolve()
  const b = await finish(reopening)
  await finish(idle)
  assert.equal((await snapshot(h, b)).refreshes, 1)
  assert.equal(p.errors.length, 0)
})

test('async scene assembly stays sequential and publishes no partial frame', async () => {
  const { actors, factory } = delayedActors()
  let gate
  actors.configure = actor => { gate = actor.hold('buildScene') }
  const h = host(factory), p = probe()
  const opening = watch(h.acquire('', programs.world, options(), p.subscriber))
  await microtasks()
  assert.equal(p.frames.length, 0)
  assert.equal(actors[0].calls.filter(call => call === 'buildScene').length, 1)
  gate.resolve()
  await outcome(opening)
  assert.equal(opening.error, null, JSON.stringify({ errors: p.errors, calls: actors[0].calls }))
  await finish(h.whenIdle())
  assertScenes(latest(p), 1)
  assert.equal(actors[0].calls.filter(call => call === 'buildScene').length, 2)
})

test('async effect-result dispatch is not replayed and preserves following snapshot order', async () => {
  const { actors, factory } = delayedActors()
  const h = host(factory), p = probe(), a = await acquire(h, p)
  accepted(post(h, a, 'change', 2))
  await finish(h.whenIdle())
  const effect = p.effects[0], gate = actors[0].hold('dispatch')
  accepted(h.postEffectResult(a, effect.effectId, 'ok'))
  rejected(h.postEffectResult(a, effect.effectId, 'ok'))
  const barrier = watch(h.requestSnapshot(a))
  await microtasks()
  assert.equal(barrier.done, false)
  gate.resolve()
  await finish(barrier)
  await finish(h.whenIdle())
  assert.equal(actors[0].calls.filter(call => call === 'dispatch').length, 2)
  assert.equal(p.errors.length, 0)
})

test('obsolete actor callbacks cannot publish after replacement or disposal', async () => {
  const { actors, factory } = delayedActors()
  const h = host(factory), p = probe(), a = await acquire(h, p)
  const old = actors[0].callbacks
  const b = await finish(h.replaceProgram(a, programs.newer, options()))
  p.reset()
  old.snapshot(encoded(99))
  old.saved('obsolete')
  old.effects([])
  old.error('handler', 'obsolete')
  await old.render(true, true)
  assert.equal(p.frames.length + p.snapshots.length + p.saved.length + p.errors.length, 0)
  assert.equal((await snapshot(h, b)).n, 5)
  await finish(h.dispose())
  actors[1].callbacks.snapshot(encoded(99))
  await actors[1].callbacks.render(true, true)
  assert.equal(p.frames.length + p.snapshots.length, 0)
})

test('disposal during quiesce retains release until disposal cleanup completes', async () => {
  const { actors, factory } = delayedActors()
  const h = host(factory), p = probe(), a = await acquire(h, p)
  const quiesce = actors[0].hold('quiesce'), cleanup = actors[0].hold('dispose')
  const release = watch(h.release(a)), disposal = watch(h.dispose())
  quiesce.resolve()
  await microtasks()
  assert.equal(release.done, false)
  assert.equal(disposal.done, false)
  cleanup.resolve()
  await finish(release)
  await finish(disposal)
})

for (const failed of [false, true]) {
  test('dispose awaits already-running final save and cleanup; save rejection=' + failed, async () => {
    const { actors, factory } = delayedActors()
    const h = host(factory), p = probe(), a = await acquire(h, p, programs.basic, persistent())
    const save = deferred(), cleanup = actors[0].hold('dispose')
    actors[0].facade.saveNow = () => {
      const saved = actors[0].real.saveNow()
      return save.promise.then(() => saved)
    }
    const release = watch(h.release(a, { saveState: true }))
    await until(() => count('task-submit') === count('task-result'))
    await microtasks()
    const disposal = watch(h.dispose())
    await microtasks()
    assert.equal(release.done, false)
    assert.equal(disposal.done, false)
    if (failed) save.reject(Error('late final save failure'))
    else save.resolve()
    await microtasks()
    assert.equal(release.done, false)
    assert.equal(disposal.done, false)
    cleanup.resolve()
    if (failed) assert.match((await rejects(release)).message, /late final save failure/)
    else await finish(release)
    await finish(disposal)
    assert.equal(h.leases.size, 0)
    assert.equal(actors[0].calls.filter(call => call === 'dispose').length, 1)
  })
}

test('dispose during delayed preview replacement settles both actor cleanups and reservations', async () => {
  const { actors, factory } = delayedActors()
  const h = host(factory), p = probe(), a = await acquire(h, p, programs.basic, options('PREVIEW'))
  let startup, candidateCleanup
  actors.configure = actor => { startup = actor.hold('initialize'); candidateCleanup = actor.hold('dispose') }
  const replacing = watch(h.replaceProgram(a, programs.newer, persistent('target/version')))
  await until(() => startup !== undefined)
  const oldCleanup = actors[0].hold('dispose')
  const closing = watch(h.dispose())
  startup.resolve()
  await microtasks()
  assert.equal(closing.done, false)
  candidateCleanup.resolve()
  await microtasks()
  assert.equal(closing.done, false)
  oldCleanup.resolve()
  await rejects(replacing, 'STATE_UNAVAILABLE')
  await finish(closing)
  assert.equal(h.registry.size, 0)
  for (const actor of actors) assert.equal(actor.calls.filter(call => call === 'dispose').length, 1)
})

for (const operation of ['replace', 'promote']) {
  test('async postcommit ' + operation + ' refresh rejection destroys the undelivered lease', async () => {
    const { actors, factory } = delayedActors()
    const h = host(factory), p = probe()
    const a = await acquire(h, p, programs.basic, options('PREVIEW'))
    let refresh, cleanup
    if (operation === 'replace') {
      actors.configure = actor => { refresh = actor.hold('runWidgetRefresh'); cleanup = actor.hold('dispose') }
    } else {
      refresh = actors[0].hold('runWidgetRefresh')
      cleanup = actors[0].hold('dispose')
    }
    const changing = watch(operation === 'replace' ?
      h.replaceProgram(a, programs.newer, persistent('target/version')) :
      h.promote(a, 'LIVE_PERSISTENT', 'target/version'))
    await microtasks()
    const record = actors[0].owner, committed = record.leases.get(a.leaseId).handle
    assert.notEqual(committed, a)
    const queuedRelease = watch(h.release(committed)), idle = watch(h.whenIdle())
    refresh.reject(Error('postcommit refresh refused'))
    await microtasks()
    assert.equal(changing.done, false)
    assert.equal(idle.done, false)
    assert.equal(h.leases.size, 0)
    assert.equal(record.leases.size, 0)
    rejected(post(h, a))
    rejected(post(h, committed))
    await rejects(queuedRelease, 'ACTOR_NOT_READY')
    cleanup.resolve()
    assert.match((await rejects(changing)).message, /postcommit refresh refused/)
    await finish(idle)
    assert.equal(h.registry.size, 0)
    for (const actor of actors) assert.equal(actor.calls.filter(call => call === 'dispose').length, 1)
    actors.configure = null
    const b = await acquire(h, p, programs.newer, persistent('target/version'))
    accepted(post(h, b))
  })
}

for (const synchronous of [false, true]) {
  test('host disposal rejects its shared promise after every cleanup; sync failure=' + synchronous, async () => {
    const { actors, factory } = delayedActors()
    const h = host(factory), p = probe(), q = probe()
    await acquire(h, p)
    await acquire(h, q)
    const reason = Error('actor disposal refused')
    let failed
    if (synchronous) actors[0].facade.dispose = () => { throw reason }
    else failed = actors[0].hold('dispose')
    const remaining = actors[1].hold('dispose')
    const promise = h.dispose(), closing = watch(promise), idle = watch(h.whenIdle())
    assert.equal(h.dispose(), promise)
    if (failed) failed.reject(reason)
    await microtasks()
    assert.equal(closing.done, false)
    assert.equal(idle.done, false)
    assert.equal(h.leases.size, 0)
    assert.equal(h.registry.size, 2, 'identities stay fenced until cleanup completes')
    assert([...h.registry.values()].every(record => record.destroyed))
    remaining.resolve()
    assert.equal(await rejects(closing), reason)
    await finish(idle)
    assert.equal(h.registry.size, 1, 'failed cleanup retains its identity fence')
    assert.equal(h.dispose(), promise)
    assert.equal(await rejects(h.dispose()), reason)
    hosts.splice(hosts.indexOf(h), 1)
  })
}

test('release propagates disposal rejection after removing its lease and completing teardown', async () => {
  const { actors, factory } = delayedActors()
  const h = host(factory), p = probe(), a = await acquire(h, p)
  const quiesce = actors[0].hold('quiesce'), cleanup = actors[0].hold('dispose')
  const promise = h.release(a), release = watch(promise)
  assert.equal(h.release(a), promise)
  const disposal = watch(h.dispose()), idle = watch(h.whenIdle())
  quiesce.resolve()
  await microtasks()
  assert.equal(release.done, false)
  assert.equal(disposal.done, false)
  assert.equal(idle.done, false)
  const reason = Error('release disposal refused')
  cleanup.reject(reason)
  assert.equal(await rejects(release), reason)
  assert.equal(await rejects(disposal), reason)
  await finish(idle)
  assert.equal(h.leases.size, 0)
  assert.equal(h.registry.size, 1, 'failed cleanup retains its identity fence')
  assert.equal(h.registry.get(a.appId).destroyed, true)
  assert.equal(actors[0].owner.leases.size, 0)
  assert.equal(actors[0].owner.current, null)
  assert.equal(actors[0].calls.filter(call => call === 'dispose').length, 1)
  hosts.splice(hosts.indexOf(h), 1)
})

test('preview replacement propagates old disposal rejection only after candidate teardown', async () => {
  const { actors, factory } = delayedActors()
  const h = host(factory), p = probe(), a = await acquire(h, p, programs.basic, options('PREVIEW'))
  const oldCleanup = actors[0].hold('dispose')
  let candidateCleanup
  actors.configure = actor => { candidateCleanup = actor.hold('dispose') }
  const replacing = watch(h.replaceProgram(a, programs.newer, persistent('target/version')))
  const idle = watch(h.whenIdle()), reason = Error('old actor disposal refused')
  await until(() => actors[0].calls.includes('dispose'))
  oldCleanup.reject(reason)
  await until(() => actors[1].calls.includes('dispose'))
  assert.equal(replacing.done, false)
  assert.equal(idle.done, false)
  assert.equal(h.leases.size, 0)
  rejected(post(h, a))
  candidateCleanup.resolve()
  const error = await rejects(replacing)
  assert.equal(error.handleInvalidated, true)
  assert.equal(error.cause, reason)
  assert.equal(error.message, reason.message)
  assert.equal(error.cleanupError, reason)
  await finish(idle)
  assert.equal(h.registry.size, 2, 'source and target remain fenced after failed retirement')
  assert([...h.registry.values()].every(record => record.destroyed))
  assert.equal(actors[0].owner.current, null)
  for (const actor of actors) assert.equal(actor.calls.filter(call => call === 'dispose').length, 1)
  assert.equal(await rejects(h.dispose()), reason)
  hosts.splice(hosts.indexOf(h), 1)
})

test('preview replacement rollback propagates candidate disposal rejection and completes teardown', async () => {
  const { actors, factory } = delayedActors()
  const h = host(factory), p = probe(), a = await acquire(h, p, programs.basic, options('PREVIEW'))
  let startup, cleanup
  actors.configure = actor => { startup = actor.hold('initialize'); cleanup = actor.hold('dispose') }
  const replacing = watch(h.replaceProgram(a, programs.newer, persistent('target/version')))
  const idle = watch(h.whenIdle()), reason = Error('candidate disposal refused')
  await until(() => startup !== undefined)
  const startupError = Error('candidate startup refused')
  startup.reject(startupError)
  await microtasks()
  assert.equal(replacing.done, false)
  assert.equal(idle.done, false)
  cleanup.reject(reason)
  const error = await rejects(replacing)
  assert.equal(error.handleInvalidated, true)
  assert.equal(error.cause, startupError)
  assert.equal(error.message, startupError.message)
  assert.equal(error.cleanupError, reason)
  await finish(idle)
  assert.equal(h.registry.size, 2, 'source and target remain fenced after failed candidate cleanup')
  assert([...h.registry.values()].every(record => record.destroyed))
  assert.equal(h.leases.size, 0)
  rejected(post(h, a))
  assert.equal(actors[1].calls.filter(call => call === 'dispose').length, 1)
  assert.equal(await rejects(h.dispose()), reason)
  hosts.splice(hosts.indexOf(h), 1)
})

test('recovery preserves exact initiating owner without waiting for its current mailbox or checkpoints', async () => {
  const { actors, factory } = delayedActors()
  const h = host(factory), p = probe(), key = 'recovery-owner/v'
  const a = await acquire(h, p, programs.basic, persistent(key))
  const record = actors[0].owner
  const gate = actors[0].hold('dispatch')
  accepted(post(h, a, 'add', 2))
  const queuedSnapshot = watch(h.requestSnapshot(a))
  record.checkpoints++
  const scopeGate = deferred(), entered = deferred()
  const activation = watch(store.trackStateActivation(key, async owner => {
    actors[0].callbacks.recoveryOwner(owner)
    assert.equal(record.recoveryOwner, owner)
    try {
      return await store.withExclusiveStateRecovery(key, owner, async scope => {
        entered.resolve()
        scope.complete()
        await scopeGate.promise
      })
    } finally { actors[0].callbacks.recoveryOwner(null) }
  }))
  await finish(entered.promise)
  assert.equal(record.fenced, false)
  assert.equal(record.current.kind, 'INPUT')
  assert.equal(record.mailbox.length, 1)
  assert.equal(record.checkpoints, 1)
  assert.equal(queuedSnapshot.done, false)
  await rejects(h.acquire('', programs.basic, persistent(key), p.subscriber))
  rejected(post(h, a))
  await rejects(h.release(a))
  await rejects(h.checkpointBackground())
  assert.equal(activation.done, false, 'complete alone must not release admissions before the scope returns')
  scopeGate.resolve()
  await finish(activation)
  assert.equal(record.recoveryOwner, null)
  record.checkpoints--
  gate.resolve()
  await finish(queuedSnapshot)
  await finish(h.whenIdle())
  accepted(post(h, a))
})

test('recovery retires competitors through final save and cleanup without reviving released records', async () => {
  const { actors, factory } = delayedActors()
  const other = host(factory), q = probe(), key = 'recovery-retire/v'
  const b = await acquire(other, q, programs.basic, persistent(key))
  const h = host(factory), p = probe()
  const a = await acquire(h, p, programs.basic, persistent(key))
  const competitor = actors[0], initiator = actors[1]
  const save = competitor.hold('saveNow'), cleanup = competitor.hold('dispose')
  const entered = deferred(), scopeGate = deferred()
  const recovery = watch(store.trackStateActivation(key, async owner => {
    initiator.callbacks.recoveryOwner(owner)
    try {
      await store.withExclusiveStateRecovery(key, owner, async scope => {
        entered.resolve()
        await scopeGate.promise
        scope.complete()
      })
    } finally { initiator.callbacks.recoveryOwner(null) }
  }))
  await until(() => competitor.calls.includes('saveNow'))
  assert.equal(competitor.owner.fenced, true)
  assert.equal(initiator.owner.fenced, false)
  rejected(post(other, b))
  await rejects(other.release(b), 'INVALID_HANDLE')
  assert.equal(competitor.calls.includes('dispose'), false)
  save.resolve()
  await until(() => competitor.calls.includes('dispose'))
  assert.equal(recovery.done, false)
  cleanup.resolve()
  await finish(entered.promise)
  assert.equal(other.records.size, 0)
  assert.equal(other.registry.size, 0)
  await rejects(other.acquire('', programs.basic, persistent(key), q.subscriber))
  scopeGate.resolve()
  await finish(recovery)
  assert.equal(competitor.owner.fenced, true)
  assert.equal(competitor.owner.destroyed, true)
  rejected(post(other, b))
  accepted(post(h, a))
  assert(competitor.calls.indexOf('quiesce') < competitor.calls.indexOf('saveNow'))
  assert(competitor.calls.indexOf('saveNow') < competitor.calls.indexOf('dispose'))
})

test('recovery discards queued promotion and replacement targets behind the initiating scheduler turn', async () => {
  for (const operation of ['promote', 'replace']) {
    const { actors, factory } = delayedActors()
    const h = host(factory), p = probe(), key = 'recovery-queued-' + operation + '/v'
    const a = await acquire(h, p, programs.basic, persistent(key))
    const b = await acquire(h, p, programs.basic, options('PREVIEW'))
    const initiator = actors[0], competitor = actors[1], owner = {}
    initiator.callbacks.recoveryOwner(owner)
    let pending, barrier
    await queued(h, a, p, () => {
      pending = watch(operation === 'promote' ? h.promote(b, 'LIVE_PERSISTENT', key) :
        h.replaceProgram(b, programs.basic, persistent(key)))
      assert.equal(competitor.owner.current, null)
      barrier = h.fenceRecoveryAdmissions(key, owner)
      assert.equal(competitor.owner.mailbox.length, 0)
      assert.equal(initiator.owner.fenced, false)
    })
    await rejects(pending, 'ACTOR_NOT_READY')
    const drain = barrier.drainOtherActorsAndStorage()
    assert.strictEqual(barrier.drainOtherActorsAndStorage(), drain)
    await finish(drain)
    barrier.release()
    assert.equal(competitor.calls.includes('promote'), false)
    assert.equal(competitor.calls.filter(call => call === 'initialize').length, 1)
    assert.equal(actors.length, 2, 'discarded replacement must not construct a candidate')
    assert.equal(competitor.owner.fenced, true)
    assert.equal(competitor.owner.destroyed, true)
    rejected(h.requestView(b))
    initiator.callbacks.recoveryOwner(null)
  }
})

test('real actor recovery waits for independent busy ephemeral work and discards its queued promotion', async () => {
  const { actors, factory } = delayedActors()
  const h = host(factory), p = probe(), q = probe(), r = probe(), key = 'recovery-independent/v'
  const b = await acquire(h, q)
  const c = await acquire(h, r)
  const competitor = actors[0], gate = competitor.hold('dispatch')
  accepted(post(h, b, 'add', 2))
  await until(() => competitor.calls.includes('dispatch'))
  const promoting = watch(h.promote(b, 'LIVE_PERSISTENT', key))
  assert.equal(competitor.owner.current.kind, 'INPUT')
  assert.equal(competitor.owner.mailbox[0].kind, 'PROMOTE')
  disk.set(stateFile(key), '{broken-main')
  disk.set(stateFile(key) + '.bak', '{broken-backup')
  const opening = watch(h.acquire('', programs.basic, persistent(key), p.subscriber))
  await until(() => competitor.owner.fenced)
  const initiator = actors[2]
  assert.notEqual(initiator.owner.recoveryOwner, null)
  assert.equal(initiator.owner.current.kind, 'INITIALIZE')
  assert.equal(initiator.owner.fenced, false)
  assert.equal(competitor.owner.current.kind, 'INPUT')
  assert.equal(competitor.owner.mailbox.length, 0)
  await rejects(promoting, 'ACTOR_NOT_READY')
  await microtasks()
  assert.equal(opening.done, false)
  assert.equal(competitor.calls.includes('dispose'), false)
  assert.equal(records.some(event => event.type === 'task-submit' && event.request.kind === 'recoverLost'), false)
  assert.throws(() => store.assertStateAdmission(key), /fenced/)
  accepted(post(h, c, 'add', 7))
  assert.equal((await snapshot(h, c)).n, 8)
  assert.equal(opening.done, false, 'independent actors must progress while recovery waits for the competitor')
  gate.resolve()
  const a = await finish(opening)
  await finish(h.whenIdle())
  assert.equal(initiator.owner.recoveryOwner, null)
  assert.equal(initiator.owner.fenced, false)
  assert.equal(competitor.owner.fenced, true)
  assert.equal(competitor.owner.destroyed, true)
  assert.equal(competitor.calls.includes('promote'), false)
  assert.equal(competitor.calls.includes('saveNow'), false)
  assert.equal(competitor.calls.filter(call => call === 'dispose').length, 1)
  assert.equal(q.frames.length, 1, 'fenced current work must not publish its late frame')
  assert.equal((await snapshot(h, a)).n, 1)
  assert.equal(p.errors.filter(error => error.kind === 'state' && error.message === 'STATE_RECOVERY').length, 1)
  assert.equal(count('quarantine'), 2)
  assert.doesNotThrow(() => store.assertStateAdmission(key))
  rejected(post(h, b))
  accepted(post(h, a, 'add', 4))
  assert.equal((await snapshot(h, a)).n, 5)
})

for (const seed of ['', encoded(7)]) {
  test('real actor recovery owns its activation through committed init and scope release; seed=' + Boolean(seed), async () => {
    const h = host(), p = probe(), key = 'recovery-scope-' + Boolean(seed) + '/v'
    assert.equal(store.constructor.name, 'ProjectStore')
    disk.set(stateFile(key), '{broken-main')
    disk.set(stateFile(key) + '.bak', '{broken-backup')
    const observations = []
    let initiatingRecord, ownerToken, released = false
    const unregister = store.registerStateLifecycle({
      fenceAllAdmissions() { throw Error('recovery must not use removal fencing') },
      fenceRecoveryAdmissions(appId, owner) {
        assert.equal(appId, key)
        initiatingRecord = [...h.records].find(record => record.recoveryOwner === owner)
        assert(initiatingRecord, 'real AppActor must install the exact store activation token before recovery')
        assert.equal(initiatingRecord.actor.constructor.name, 'AppActor')
        assert.equal(initiatingRecord.current.kind, 'INITIALIZE')
        assert.equal(initiatingRecord.fenced, false)
        ownerToken = owner
        observations.push('fence')
        return {
          async drainOtherActorsAndStorage() {
            assert.equal(initiatingRecord.recoveryOwner, owner)
            assert.throws(() => store.assertStateAdmission(key), /fenced/)
            observations.push('drain')
          },
          release() {
            assert.equal(initiatingRecord.recoveryOwner, owner)
            assert.equal(initiatingRecord.actor.ready(), true)
            const committed = validateStateFile(disk.get(stateFile(key)), key, 1)
            assert.equal(stateOf(committed.encodedState).n, seed ? 7 : 1)
            assert.equal(committed.revision, 1)
            assert.equal(p.errors.filter(error => error.message === 'STATE_RECOVERY').length, 1)
            assert.throws(() => store.assertStateAdmission(key), /fenced/)
            released = true
            observations.push('release')
          }
        }
      }
    })
    p.frameHook = () => {
      assert.equal(released, false)
      assert.equal(initiatingRecord.recoveryOwner, ownerToken)
      assert.throws(() => store.assertStateAdmission(key), /fenced/)
      observations.push('frame')
    }
    p.errorHook = error => {
      if (error.kind !== 'state' || error.message !== 'STATE_RECOVERY') return
      assert.equal(released, false)
      assert.throws(() => store.assertStateAdmission(key), /fenced/)
      observations.push('recovery')
    }
    try {
      const a = await acquire(h, p, programs.basic, persistent(key, seed))
      p.frameHook = null
      assert.deepEqual(observations, ['fence', 'drain', 'frame', 'recovery', 'release'])
      assert.equal(initiatingRecord.recoveryOwner, null)
      assert.equal(initiatingRecord.fenced, false)
      assert.doesNotThrow(() => store.assertStateAdmission(key))
      assert.deepEqual(records.filter(event => event.type === 'task-submit').map(event => event.request.kind),
        ['load', 'recoverLost', 'commit'])
      assert.deepEqual(records.filter(event => event.type === 'quarantine').map(event => [event.file, disk.get(event.to)]),
        [[stateFile(key), '{broken-main'], [stateFile(key) + '.bak', '{broken-backup']])
      assert.equal((await snapshot(h, a)).n, seed ? 7 : 1)
      accepted(post(h, a, 'add', 3))
      assert.equal((await snapshot(h, a)).n, seed ? 10 : 4)
    } finally { unregister() }
  })
}

for (const mode of ['PREVIEW', 'LIVE_EPHEMERAL']) {
  test('real actor replacement recovery signals before fence release and buffered publications; source=' + mode, async () => {
    const h = host(), p = probe(), key = 'replacement-recovery/v'
    const old = await acquire(h, p, programs.basic, options(mode))
    const record = h.registry.get(old.appId), oldActor = record.actor
    disk.set(stateFile(key), '{broken-main')
    disk.set(stateFile(key) + '.bak', '{broken-backup')
    p.reset()
    const observations = []
    const unregister = store.registerStateLifecycle({
      fenceAllAdmissions() { throw Error('unexpected removal fence') },
      fenceRecoveryAdmissions(appId, owner) {
        assert.equal(appId, key)
        assert.equal(record.recoveryOwner, owner)
        assert.equal(record.current.kind, 'REPLACE')
        assert.equal(record.fenced, false)
        observations.push('fence')
        return {
          async drainOtherActorsAndStorage() { observations.push('drain') },
          release() {
            assert.throws(() => store.assertStateAdmission(key), /fenced/)
            assert.equal(p.errors.length, 1)
            assert.equal(p.frames.length + p.snapshots.length + p.effects.length + p.saved.length, 0)
            observations.push('release')
          }
        }
      }
    })
    p.errorHook = error => {
      assert.deepEqual(error, { kind: 'state', message: 'STATE_RECOVERY', inputSeq: undefined })
      assert.throws(() => store.assertStateAdmission(key), /fenced/)
      assert.equal(record.transitioning, true)
      assert.notEqual(record.recoveryOwner, null)
      assert.notEqual(record.actor, oldActor)
      assert.equal(record.actor.constructor.name, 'AppActor')
      assert.equal(record.actor.ready(), true)
      assert.equal(record.leases.get(old.leaseId).handle, old)
      assert(record.deliveries.length >= 4)
      assert.equal(p.frames.length + p.snapshots.length + p.effects.length + p.saved.length, 0)
      observations.push('recovery')
    }
    const onError = p.subscriber.onError
    p.subscriber.onError = (...args) => { onError(...args); throw Error('fixture recovery subscriber failure') }
    p.frameHook = () => {
      assert.doesNotThrow(() => store.assertStateAdmission(key))
      assert.equal(record.deliveries, null)
      assert.notEqual(record.leases.get(old.leaseId).handle, old)
      observations.push('frame')
    }
    try {
      const a = await finish(h.replaceProgram(old, programs.initEffect, persistent(key)))
      await finish(h.whenIdle())
      assert.deepEqual(observations, ['fence', 'drain', 'recovery', 'release', 'frame'])
      assert.deepEqual(sequence(), ['save', 'error', 'snapshot', 'effect', 'saved', 'frame'])
      assert.equal(p.errors.length, 1)
      assert.equal(p.effects.length, 1)
      assert.equal(p.frames.length, 1)
      assert.equal(p.snapshots.length, 1)
      assert.equal(count('quarantine'), 2)
      assert.equal(record.recoveryOwner, null)
      assert.equal(oldActor.ready(), false)
      assert.equal((await snapshot(h, a)).n, 1)
      assert.doesNotThrow(() => store.assertStateAdmission(key))
      rejected(post(h, old))
      accepted(post(h, a, 'add', 3))
      assert.equal((await snapshot(h, a)).n, 4)
    } finally { unregister() }
  })

  test('real actor replacement recovery subscriber disposal rejects and retains fence without buffered publications; source=' + mode, async () => {
    const h = host(), p = probe(), key = 'replacement-cancel/v'
    const old = await acquire(h, p, programs.basic, options(mode))
    const record = h.registry.get(old.appId), oldActor = record.actor
    disk.set(stateFile(key), '{broken-main')
    disk.set(stateFile(key) + '.bak', '{broken-backup')
    p.reset()
    let closing
    p.errorHook = error => {
      assert.deepEqual(error, { kind: 'state', message: 'STATE_RECOVERY', inputSeq: undefined })
      assert.throws(() => store.assertStateAdmission(key), /fenced/)
      assert.equal(record.current.kind, 'REPLACE')
      assert.equal(record.transitioning, true)
      assert.notEqual(record.recoveryOwner, null)
      assert.equal(record.actor.constructor.name, 'AppActor')
      assert.equal(record.actor.ready(), true)
      assert(record.deliveries.length >= 4)
      assert.equal(p.frames.length + p.snapshots.length + p.effects.length + p.saved.length, 0)
      closing = watch(h.dispose())
    }
    const error = await rejects(h.replaceProgram(old, programs.initEffect, persistent(key)), 'STATE_COMMIT_UNCERTAIN')
    assert.equal(error.handleInvalidated, true)
    assert(closing, 'recovery must synchronously invoke the subscriber')
    await finish(closing)
    await finish(h.whenIdle())
    assert.deepEqual(sequence(), ['save', 'error'])
    assert.equal(p.errors.length, 1)
    assert.equal(p.frames.length + p.snapshots.length + p.effects.length + p.saved.length, 0)
    assert.equal(count('save'), 1)
    assert.equal(count('quarantine'), 2)
    assert.equal(record.actor.ready(), false)
    assert.equal(record.destroyed, true)
    assert.equal(oldActor.ready(), false)
    assert.equal(h.records.size + h.registry.size + h.leases.size, 0)
    assert.throws(() => store.assertStateAdmission(key), /fenced/)
    assert.equal(validateStateFile(disk.get(stateFile(key)), key, 1).revision, 1)
    rejected(post(h, old))
    await rejects(h.acquire('', programs.basic, persistent(key), p.subscriber), 'ACTOR_NOT_READY')
  })
}

test('only exact normalized recovery signal bypasses replacement buffering with delivery ownership and deduplication', async () => {
  const { actors, factory } = delayedActors()
  const h = host(factory), p = probe(), old = await acquire(h, p, programs.basic, options('PREVIEW'))
  p.reset()
  let startup
  actors.configure = actor => { startup = actor.hold('initialize') }
  const replacing = watch(h.replaceProgram(old, programs.basic, options()))
  await until(() => startup !== undefined)
  const candidate = actors[1], record = candidate.owner
  const ordinary = [
    ['state', 'STATE_RECOVERY_FAILED'], ['recovery', 'STATE_RECOVERY'],
    ['state', 'STATE_RECOVERY extra'], ['state ', 'STATE_RECOVERY']
  ]
  for (const [kind, message] of ordinary) candidate.callbacks.error(kind, message)
  assert.equal(p.errors.length, 0)
  assert.equal(record.deliveries.length, ordinary.length)
  actors[0].callbacks.error('state', 'STATE_RECOVERY')
  assert.equal(p.errors.length, 0)
  const inputSeq = record.current.inputSeq
  record.current.inputSeq = 123
  candidate.callbacks.error('STATE', 'STATE_RECOVERY')
  candidate.callbacks.error('state', 'STATE_RECOVERY')
  assert.deepEqual(p.errors, [{ kind: 'state', message: 'STATE_RECOVERY', inputSeq: undefined }])
  assert.equal(record.deliveries.length, ordinary.length)
  assert.equal(record.turnFailed, false)
  record.current.inputSeq = inputSeq
  startup.resolve()
  const a = await finish(replacing)
  await finish(h.whenIdle())
  assert.deepEqual(p.errors.map(error => [error.kind, error.message]), [['state', 'STATE_RECOVERY'], ...ordinary])
  assert.deepEqual(sequence(), ['error', 'error', 'error', 'error', 'error', 'snapshot', 'frame'])
  p.reset()
  record.fenced = true
  candidate.callbacks.error('state', 'STATE_RECOVERY')
  assert.equal(p.errors.length, 0)
  record.fenced = false
  record.reportedErrors.clear()
  const lease = record.leases.get(a.leaseId)
  record.current = { lease }
  lease.state = 'RELEASED'
  candidate.callbacks.error('state', 'STATE_RECOVERY')
  assert.equal(p.errors.length, 0)
  lease.state = 'ACTIVE'
  record.current = null
  record.reportedErrors.clear()
  record.subscriber = null
  candidate.callbacks.error('state', 'STATE_RECOVERY')
  assert.equal(p.errors.length, 0)
  record.subscriber = p.subscriber
  await finish(h.dispose())
  candidate.callbacks.error('state', 'STATE_RECOVERY')
  assert.equal(p.errors.length, 0)
  rejected(post(h, a))
})

test('real actor recovery failure clears ownership but keeps admissions and competitors fenced', async () => {
  const { actors, factory } = delayedActors()
  const h = host(factory), p = probe(), q = probe(), key = 'recovery-real-failure/v'
  const b = await acquire(h, q)
  const competitor = actors[0], gate = competitor.hold('dispatch')
  accepted(post(h, b, 'add', 2))
  await until(() => competitor.calls.includes('dispatch'))
  const promoting = watch(h.promote(b, 'LIVE_PERSISTENT', key))
  disk.set(stateFile(key), '{broken')
  const opening = watch(h.acquire('', programs.initTrap, persistent(key), p.subscriber))
  await until(() => competitor.owner.fenced)
  const initiator = actors[1]
  assert.notEqual(initiator.owner.recoveryOwner, null)
  await rejects(promoting, 'ACTOR_NOT_READY')
  gate.resolve()
  await rejects(opening, 'ACTOR_NOT_READY')
  await finish(h.whenIdle())
  assert.equal(initiator.owner.recoveryOwner, null)
  assert.equal(initiator.owner.destroyed, true)
  assert.equal(competitor.owner.fenced, true)
  assert.equal(competitor.owner.destroyed, true)
  assert.throws(() => store.assertStateAdmission(key), /fenced/)
  await rejects(h.acquire('', programs.basic, persistent(key), p.subscriber))
  rejected(post(h, b))
  assert.equal(p.frames.length + p.snapshots.length + p.effects.length, 0)
  assert.equal(p.errors.filter(error => error.message === 'STATE_RECOVERY').length, 0)
  assert.equal(count('save'), 0)
  assert.equal(count('quarantine'), 1)
})

test('recovery waits for a current promotion and retires its fenced runtime after failure', async () => {
  const { actors, factory } = delayedActors()
  const h = host(factory), p = probe(), key = 'recovery-dependent/v'
  const a = await acquire(h, p, programs.basic, persistent(key))
  const b = await acquire(h, p, programs.basic, options('PREVIEW'))
  const initiator = actors[0], competitor = actors[1], owner = {}
  initiator.callbacks.recoveryOwner(owner)
  const gate = competitor.hold('promote')
  const promoting = watch(h.promote(b, 'LIVE_PERSISTENT', 'recovery-alias/v'))
  await until(() => competitor.calls.includes('promote'))
  assert.equal(h.registry.get(b.appId), competitor.owner)
  assert.equal(h.registry.get('recovery-alias/v'), competitor.owner)
  let barrier
  await queued(h, a, p, () => {
    barrier = h.fenceRecoveryAdmissions('recovery-alias/v', owner)
  })
  const drain = watch(barrier.drainOtherActorsAndStorage())
  await microtasks()
  assert.equal(drain.done, false)
  assert.equal(promoting.done, false)
  assert.equal(competitor.owner.fenced, true)
  assert.equal(initiator.owner.fenced, false)
  rejected(h.requestView(b))
  gate.reject(Error('independent promotion failed'))
  await rejects(promoting)
  await finish(drain)
  barrier.release()
  await finish(h.whenIdle())
  assert.equal(competitor.owner.fenced, true)
  assert.equal(competitor.owner.destroyed, true)
  assert.equal(competitor.calls.filter(call => call === 'promote').length, 1, 'fenced competitors must not restore their old runtime')
  initiator.callbacks.recoveryOwner(null)
})

test('recovery final save failure destroys competitors and release never restores their handles', async () => {
  const { actors, factory } = delayedActors()
  const h = host(factory), p = probe(), key = 'recovery-failure/v'
  const a = await acquire(h, p, programs.basic, persistent(key))
  const competitor = actors[0], owner = {}, reason = Error('recovery final save refused')
  competitor.callbacks.recoveryOwner({})
  const save = competitor.hold('saveNow')
  const barrier = h.fenceRecoveryAdmissions(key, owner)
  const drain = watch(barrier.drainOtherActorsAndStorage())
  await until(() => competitor.calls.includes('saveNow'))
  save.reject(reason)
  assert.equal(await rejects(drain), reason)
  assert.equal(competitor.owner.destroyed, true)
  assert.equal(competitor.calls.filter(call => call === 'dispose').length, 1)
  barrier.release()
  assert.equal(competitor.owner.fenced, true)
  rejected(post(h, a))
  await rejects(h.requestSnapshot(a), 'INVALID_HANDLE')
})

test('recovery waits for competing checkpoints and suppresses fenced deliveries until retirement', async () => {
  const { actors, factory } = delayedActors()
  const h = host(factory), p = probe(), key = 'recovery-checkpoint/v'
  const a = await acquire(h, p, programs.basic, persistent(key))
  const competitor = actors[0], record = competitor.owner
  record.checkpoints++
  p.reset()
  const barrier = h.fenceRecoveryAdmissions(key, {})
  const drain = watch(barrier.drainOtherActorsAndStorage())
  await microtasks()
  assert.equal(drain.done, false)
  competitor.callbacks.snapshot(encoded(), { mode: 'LIVE_PERSISTENT', vmGeneration: a.vmGeneration,
    stateRevision: record.stateRevision })
  competitor.callbacks.error('state', 'late checkpoint')
  assert.equal(p.snapshots.length + p.errors.length, 0)
  assert.equal(record.destroyed, false)
  rejected(post(h, a))
  record.checkpoints--
  h.settleRecord(record)
  await finish(drain)
  barrier.release()
  await finish(h.whenIdle())
  assert.equal(record.fenced, true)
  assert.equal(competitor.calls.filter(call => call === 'saveNow').length, 1)
  assert.equal(competitor.calls.filter(call => call === 'dispose').length, 1)
})

test('recovery owner callbacks from replaced actors cannot overwrite the current incarnation token', async () => {
  const { actors, factory } = delayedActors()
  const h = host(factory), p = probe(), a = await acquire(h, p, programs.basic, options('PREVIEW'))
  const b = await finish(h.replaceProgram(a, programs.newer, options('PREVIEW')))
  const record = actors[1].owner, owner = {}
  actors[1].callbacks.recoveryOwner(owner)
  actors[0].callbacks.recoveryOwner(null)
  assert.equal(record.recoveryOwner, owner)
  actors[0].callbacks.recoveryOwner({})
  assert.equal(record.recoveryOwner, owner)
  const barrier = h.fenceRecoveryAdmissions(b.appId, owner)
  await finish(barrier.drainOtherActorsAndStorage())
  barrier.release()
  assert.equal(record.fenced, false)
  actors[1].callbacks.recoveryOwner(null)
  assert.equal(record.recoveryOwner, null)
})

const selectedNames = process.argv.slice(2)
const selectedTests = selectedNames.length === 0 ? tests : tests.filter(({ name }) => selectedNames.includes(name))
for (const name of selectedNames) assert(tests.some(test => test.name === name), 'Unknown test: ' + name)

const originals = {
  now: Date.now, random: Math.random, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout,
  setInterval: global.setInterval, clearInterval: global.clearInterval,
  console: Object.fromEntries(['info', 'warn', 'error'].map(level => [level, console[level]]))
}
async function main() {
  let passed = 0
  try {
    Date.now = () => now
    Math.random = () => 0.125
    global.setTimeout = (callback, delay = 0, ...args) => {
      assert.equal(typeof callback, 'function')
      const id = ++nextTimer
      timers.set(id, { callback, delay, at: now + Math.max(0, Number(delay)), args })
      return id
    }
    global.clearTimeout = id => timers.delete(id)
    global.setInterval = () => { throw Error('unexpected actor-owned interval') }
    global.clearInterval = () => { throw Error('unexpected actor-owned interval cleanup') }
    for (const level of ['info', 'warn', 'error']) console[level] = (...args) => records.push({ type: 'log-' + level, message: args.join(' ') })
    for (const { name, run } of selectedTests) {
      disk.clear()
      store = new storeModule.ProjectStore()
      storeModule.store = store
      store.init('/host-fixture')
      committedStates.clear()
      records = []
      failure = ''
      now = 100000
      timers.clear()
      callbackErrors.length = 0
      hosts.length = 0
      try {
        await run()
        if (callbackErrors.length) throw callbackErrors[0]
        passed++
        console.log('PASS ' + name)
      } catch (error) {
        originals.console.error('FAIL ' + name + '\n' + error.stack)
        process.exitCode = 1
      } finally {
        failure = ''
        for (const h of hosts) {
          try { await finish(h.dispose()) } catch (error) {
            originals.console.error('FAIL teardown ' + name + '\n' + error.stack)
            process.exitCode = 1
          }
        }
        timers.clear()
      }
    }
  } finally {
    Date.now = originals.now
    Math.random = originals.random
    global.setTimeout = originals.setTimeout
    global.clearTimeout = originals.clearTimeout
    global.setInterval = originals.setInterval
    global.clearInterval = originals.clearInterval
    Object.assign(console, originals.console)
  }
  console.log(`in-process-host-check: ${passed}/${selectedTests.length} deterministic actual-source scenarios passed`)
  console.log('Scope: public InProcessHost API, real AppActor/compiler/VM/UI/Gfx/carry/ProjectStore; in-memory IO and fake clock/timers; no device, private corpus, model or service calls.')
}
main().catch(error => {
  originals.console.error(error.stack)
  process.exitCode = 1
})
