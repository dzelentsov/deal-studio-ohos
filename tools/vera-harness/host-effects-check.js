'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require(process.env.VERA_TYPESCRIPT_PATH || 'typescript')
const root = path.resolve(__dirname, '../../entry/src/main/ets')
const cache = new Map()
const disk = new Map()
const timers = new Map()
const hosts = []
const bridges = []
const calls = []
const grants = new Map()
const consentChecks = []
const remembered = []
const callbackErrors = []
const unhandled = []
const traces = []
let now = 100000
let nextTimer = 0
let platform = () => Promise.resolve('ok')
const filesystem = {
  OpenMode: { CREATE: 1, WRITE_ONLY: 2, TRUNC: 4 },
  mkdirSync() {},
  openSync(file) { return { fd: file } },
  writeSync(file, value) { disk.set(file, value) },
  closeSync() {},
  statSync(file) {
    if (!disk.has(file)) throw Error('absent')
    return { size: disk.get(file).length }
  },
  readTextSync(file) {
    if (!disk.has(file)) throw Error('absent')
    return disk.get(file)
  },
  renameSync(from, to) {
    assert(disk.has(from))
    disk.set(to, disk.get(from))
    disk.delete(from)
  },
  unlinkSync(file) { disk.delete(file) },
  listFileSync(dir) { return [...disk.keys()].filter(file => path.dirname(file) === dir).map(file => path.basename(file)) }
}
const forbidden = name => new Proxy({}, { get(_target, key) {
  throw Error('Forbidden platform access: ' + name + '.' + String(key))
} })
const consent = {
  has(stamp, target) {
    consentChecks.push([stamp, target])
    return grants.get(stamp)?.has(target) === true
  },
  remember(stamp, target) {
    remembered.push([stamp, target])
    if (!grants.has(stamp)) grants.set(stamp, new Set())
    grants.get(stamp).add(target)
  }
}
function adapter(route, target, values, mode) {
  assert(values instanceof Map)
  const call = { route, target, values: [...values], mode }
  calls.push(call)
  return platform(call)
}
function load(file) {
  file = path.resolve(file)
  if (cache.has(file)) return cache.get(file).exports
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file.replace(/\.ets$/, '.ts'),
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true },
    reportDiagnostics: true
  })
  const errors = (compiled.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error)
  assert.equal(errors.length, 0, file + ': ' + errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'))
  const module = { exports: {} }
  cache.set(file, module)
  const importer = name => {
    if (name.endsWith('/VeraIntents')) return { runRawIntent: (target, values, mode) => adapter('intent', target, values, mode) }
    if (name.endsWith('/VeraSdkBackend')) return { runSdkAdapter: (target, values) => adapter('sdk', target, values) }
    if (name.endsWith('/VeraConsentStore')) return { consent }
    if (name === '@kit.CoreFileKit') return { fileIo: filesystem }
    if (name === '@kit.PerformanceAnalysisKit') return { hilog: forbidden('hilog') }
    if (name.startsWith('@kit.') || name === 'libllama.so') return forbidden(name)
    if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.ets'))
    throw Error('Unsupported dependency: ' + name + ' from ' + file)
  }
  new Function('require', 'module', 'exports', compiled.outputText)(importer, module, module.exports)
  return module.exports
}
const runtime = name => load(path.join(root, 'runtime', name + '.ets'))
const vera = name => load(path.join(root, 'vera', name + '.ets'))
const { InProcessHost } = runtime('InProcessHost')
const { HostEffectsBridge } = runtime('HostEffectsBridge')
const { StageTrace } = runtime('trace/StageTrace')
const { EffectController, executeEffect, effectValues, effectConsentKey, effectConsentTitle, effectConsentValues } = runtime('EffectController')
const { compileVeraSource } = vera('VeraCompiler')
const { veraStateStamp } = vera('VeraStateStamp')
const { store } = vera('ProjectStore')
store.init('/effects-fixture')
const target = 'com.example.effects/entry/EntryAbility/Record'
const sdkTarget = 'Fixture.device.read'
const effectCode = (label = 'fire', name = target, mode = '') =>
  `sdk.call("${name}", ["label", "${label}", "value", ui.numberToString(state.n)], "answered"${mode ? ', "' + mode + '"' : ''});`
function fixture({ refresh = false, refreshCount = 1, initial = 1, bad = false } = {}) {
  return `
@jsonable class AppState {
  n: number;
  field: string;
  answers: string[];
  observed: string[];
  order: string[];
  refreshes: number;
}
function init(): AppState {
  return {n: ${initial}, field: "initial", answers: [], observed: [], order: [], refreshes: 0};
}
function fire(state: AppState, value: number): AppState {
  state.n = state.n + value;
  ${effectCode()}
  return state;
}
function sdkFire(state: AppState, value: number): AppState {
  ${effectCode('sdk', sdkTarget)}
  return state;
}
function foreground(state: AppState, value: number): AppState {
  ${effectCode('foreground', target, 'foreground')}
  return state;
}
function ordered(state: AppState, value: number): AppState {
  sdk.call("${target}", ["z", "first", "a", "", "z", "last"], "answered");
  return state;
}
function pair(state: AppState, value: number): AppState {
  ${effectCode('first')}
  ${effectCode('second')}
  return state;
}
function add(state: AppState, value: number): AppState {
  state.n = state.n + value;
  state.order.push("add");
  return state;
}
function edit(state: AppState, value: string): AppState {
  state.field = value;
  state.order.push("field");
  return state;
}
function answered(state: AppState, value: string): AppState {
  state.answers.push(value);
  state.observed.push(state.field);
  state.order.push("answer");
  return state;
}
function widgetRefresh(state: AppState): AppState {
  state.refreshes = state.refreshes + 1;
  ${refresh ? Array.from({ length: refreshCount }, (_, index) => effectCode(index === 0 ? 'refresh' : 'refresh-' + index)).join('\n  ') : ''}
  return state;
}
function view(state: AppState): ui.View {
  ${bad ? 'let empty: number[] = []; state.n = empty[2];' : ''}
  return ui.Text("body", state.field);
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
  basic: compile(fixture()), newer: compile(fixture({ initial: 9 })),
  refresh: compile(fixture({ refresh: true })), bad: compile(fixture({ bad: true }))
}
function unpack(value) {
  assert(Array.isArray(value), 'snapshots must be VM tagged tuples')
  switch (value[0]) {
    case 'n': case 's': case 'b': return value[1]
    case 'z': return null
    case 'a': return value[1].map(unpack)
    case 'o': return Object.fromEntries(value[2].map(([key, item]) => [key, unpack(item)]))
    default: assert.fail('unknown snapshot tag: ' + value[0])
  }
}
const decode = encoded => unpack(JSON.parse(encoded))
const config = (mode = 'LIVE_EPHEMERAL', persistKey = '') => ({ mode, persistKey, seedState: '' })
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function microtasks() {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}
function runTimer() {
  const due = [...timers].filter(([, timer]) => timer.at <= now)
    .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
  if (!due) return false
  timers.delete(due[0])
  due[1].callback(...due[1].args)
  return true
}
async function pump() {
  for (let i = 0; i < 5000; i++) {
    await microtasks()
    if (!runTimer()) return
  }
  assert.fail('fake timer drain must terminate')
}
async function finish(promise) {
  let settled = false, value, failure
  Promise.resolve(promise).then(result => { settled = true; value = result }, error => { settled = true; failure = error })
  for (let i = 0; !settled && i < 5000; i++) {
    await microtasks()
    if (!settled) assert(runTimer(), 'operation unresolved without runnable fake timers')
  }
  assert(settled, 'operation did not settle')
  if (failure) throw failure
  return value
}
function accepted(result) {
  assert.equal(result.status, 'ACCEPTED', JSON.stringify(result))
  return result.inputSeq
}
function input(handle, action, value = 0, kind = 'HANDLER') {
  return { appId: handle.appId, vmGeneration: handle.vmGeneration, kind, action,
    payload: { kind: typeof value === 'string' ? 'STRING' : 'NUMBER', num: typeof value === 'number' ? value : 0,
      str: typeof value === 'string' ? value : '', bool: false, phase: 'move', id: 0, x: 0, y: 0 },
    persist: false, draws: [] }
}
function harness(options = {}) {
  const host = new InProcessHost(() => now)
  hosts.push(host)
  const p = { host, frames: [], snapshots: [], effects: [], errors: [], pending: [], failures: [],
    admissions: [], posts: [], events: [], fields: [], flushes: [], handle: null, binding: null,
    frameHook: null, effectHook: null, writableHook: null, postHook: null, flushHook: null }
  const invoke = (name, ...args) => {
    if (!p[name]) return
    try { return p[name](...args) } catch (error) { callbackErrors.push(error) }
  }
  const postResult = host.postEffectResult.bind(host)
  host.postEffectResult = (handle, effectId, text) => {
    p.events.push('post')
    const admission = p.postHook ? p.postHook(handle, effectId, text, postResult) : postResult(handle, effectId, text)
    p.posts.push({ handle, effectId, text, admission })
    return admission
  }
  p.flushInput = appId => {
    p.flushes.push(appId)
    p.events.push('flush')
    if (p.flushHook) return p.flushHook(appId)
    while (p.fields.length) {
      const value = p.fields.shift()
      accepted(host.postInput(p.handle, input(p.handle, 'edit', value, 'FIELD')))
    }
  }
  p.bridge = new HostEffectsBridge(host, {
    askBeforeCalls: false,
    onPending: effect => p.pending.push(effect),
    flushPendingInputFor: appId => p.flushInput(appId),
    onAdmitted: (effect, seq) => p.admissions.push({ effect, seq }),
    onFailure: (effect, error) => p.failures.push({ effect, error }),
    ...options
  })
  bridges.push(p.bridge)
  p.subscriber = {
    onViewFrame(frame) { p.frames.push(frame); p.events.push('frame'); invoke('frameHook', frame) },
    onStateSnapshot(encoded) { p.snapshots.push(decode(encoded)); p.events.push('snapshot') },
    onStateSaved() {},
    onError(kind, message, seq) { p.errors.push({ kind, message, seq }) },
    onEffectRequest(effect) {
      p.effects.push(effect)
      p.events.push('effect')
      p.binding.onEffectRequest(effect)
      invoke('effectHook', effect)
    },
    flushPendingInputFor: appId => p.flushInput(appId),
    onMailboxWritable() { p.events.push('writable'); p.bridge.onMailboxWritable(); invoke('writableHook') }
  }
  p.begin = (stamp = programs.basic.vbc2) => { p.binding = p.bridge.beginBinding(stamp); return p.binding }
  p.acquire = async (program = programs.basic, settings = config()) => {
    p.begin(program.vbc2)
    const promise = host.acquire('', program, settings, p.subscriber)
    p.handle = await finish(promise)
    p.binding.bind(p.handle)
    return p.handle
  }
  p.replace = async (program = programs.newer) => {
    p.begin(program.vbc2)
    p.handle = await finish(host.replaceProgram(p.handle, program, config()))
    p.binding.bind(p.handle)
    return p.handle
  }
  p.post = (action = 'fire', value = 0) => accepted(host.postInput(p.handle, input(p.handle, action, value)))
  p.snapshot = async () => decode(await finish(host.requestSnapshot(p.handle)))
  return p
}
function request(effectId = 1, extra = {}) {
  return { appId: 'app', vmGeneration: 1, effectId, kind: 'sdk', rawTarget: target,
    params: [], mode: 'background', resultHandler: 'answered', ...extra }
}
function controller(options = {}) {
  const p = { pending: [], completed: [], epoch: 1, stamp: 'version-a', active: true }
  p.controller = new EffectController({ askBeforeCalls: true, stamp: () => p.stamp,
    generation: () => p.epoch, isCurrent: () => p.active,
    onPending: effect => p.pending.push(effect), complete: (effect, text) => p.completed.push({ effect, text }), ...options })
  return p
}
const tests = []
function test(name, run) { tests.push({ name, run }) }

test('real sdk.call buffers initial widgetRefresh until actual acquired handle, flushes fields, dispatches result and persists snapshot', async () => {
  const answer = deferred()
  platform = () => answer.promise
  const p = harness()
  p.begin(programs.refresh.stamp)
  const acquiring = p.host.acquire('', programs.refresh, config('LIVE_PERSISTENT', 'project/version'), p.subscriber)
  assert.equal(p.effects.length, 1)
  assert.equal(p.handle, null)
  assert.equal(calls.length, 0)
  p.handle = await finish(acquiring)
  p.fields.push('typed before answer')
  p.binding.bind(p.handle)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].route, 'intent')
  assert.equal(calls[0].mode, 'background')
  answer.resolve('{"result":"verbatim"}')
  await pump()
  const state = await p.snapshot()
  assert.deepEqual(state.answers, ['{"result":"verbatim"}'])
  assert.deepEqual(state.observed, ['typed before answer'])
  assert.deepEqual(state.order, ['field', 'answer'])
  assert.equal(p.posts[0].handle, p.handle)
  assert.equal(p.posts[0].effectId, p.effects[0].effectId)
  assert.equal(p.admissions[0].seq, 2)
  assert(p.events.indexOf('flush') < p.events.indexOf('post'))
  assert.deepEqual(p.snapshots.at(-1), state)
  const saved = JSON.parse(disk.get('/effects-fixture/vera/project/version.state.json'))
  assert.equal(saved.stamp, programs.refresh.stamp)
  assert.deepEqual(unpack(saved.value), state)
  assert.deepEqual(p.errors, [])
  assert.deepEqual(p.failures, [])
})

test('real SDK dotted target and explicit foreground intent use actual executeEffect routing', async () => {
  const p = harness()
  await p.acquire()
  p.post('sdkFire')
  p.post('foreground')
  await pump()
  assert.deepEqual(calls.map(call => [call.route, call.target, call.mode]), [
    ['sdk', sdkTarget, undefined], ['intent', target, 'foreground']
  ])
  assert.deepEqual((await p.snapshot()).answers, ['ok', 'ok'])
})

test('real handler flat parameters arrive as ordered Map with duplicate replacement and default background mode', async () => {
  const p = harness()
  await p.acquire()
  p.post('ordered')
  await pump()
  assert.deepEqual(calls[0], { route: 'intent', target, values: [['z', 'last'], ['a', '']], mode: 'background' })
  assert.deepEqual((await p.snapshot()).answers, ['ok'])
})

test('slash predicate requires sdk kind; other-kind slash remains SDK and Map preserves insertion/default values', async () => {
  const effect = request(1, { kind: 'calendar', params: ['z', 'first', 'a', '', 'z', 'last', 'dangling'] })
  assert.deepEqual([...effectValues(effect)], [['z', 'last'], ['a', '']])
  await executeEffect(effect)
  await executeEffect(request(2))
  assert.deepEqual(calls, [
    { route: 'sdk', target, values: [['z', 'last'], ['a', '']], mode: undefined },
    { route: 'intent', target, values: [], mode: 'background' }
  ])
  assert.equal(effectConsentKey(effect), target)
  assert.equal(effectConsentTitle(request()), 'Run Record')
  assert.equal(effectConsentTitle(request(2, { rawTarget: sdkTarget })), 'Run read')
  assert.equal(effectConsentValues(effect), 'z: last\na: ')
  assert.equal(effectConsentValues(request()), '(no parameters)')
})

for (const action of ['fire', 'sdkFire']) {
  for (const text of ['{\"intentName\":\"Record\",\"nested\":{\"ok\":true}}', 'ok', 'declined code=10010001', 'error 2200003: denied', 'declined by the person', '']) {
    test(action + ' real result handler receives unchanged ' + JSON.stringify(text), async () => {
      platform = () => Promise.resolve(text)
      const p = harness()
      await p.acquire()
      p.post(action)
      await pump()
      assert.deepEqual((await p.snapshot()).answers, [text])
      assert.equal(p.posts[0].text, text)
      assert.equal(p.posts.length, 1)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].route, action === 'fire' ? 'intent' : 'sdk')
    })
  }
}

test('consent refusal returns exact string through real result handler and never calls platform', async () => {
  const p = harness({ askBeforeCalls: true })
  await p.acquire()
  p.post()
  assert.equal(calls.length, 0)
  assert.equal(p.pending.at(-1).rawTarget, target)
  p.bridge.refusePending()
  await pump()
  assert.deepEqual((await p.snapshot()).answers, ['declined by the person'])
  assert.equal(calls.length, 0)
  assert.deepEqual(remembered, [])
})

test('consent grants are keyed by captured stamp and raw target; replacement version must ask again', async () => {
  const p = harness({ askBeforeCalls: true })
  await p.acquire()
  p.post()
  p.bridge.allowPending()
  await pump()
  assert.deepEqual(remembered, [[programs.basic.vbc2, target]])
  p.post()
  await pump()
  assert.equal(calls.length, 2)
  p.post('sdkFire')
  assert.equal(p.pending.at(-1).rawTarget, sdkTarget)
  assert.equal(calls.length, 2)
  p.bridge.refusePending()
  await pump()
  await p.replace()
  p.post()
  assert.equal(calls.length, 2)
  assert.equal(p.pending.at(-1).rawTarget, target)
  assert.deepEqual(consentChecks.at(-1), [programs.newer.vbc2, target])
  p.bridge.allowPending()
  await pump()
  assert.deepEqual(remembered, [[programs.basic.vbc2, target], [programs.newer.vbc2, target]])
  assert.equal(calls.length, 3)
})

test('pending consent holds even no-consent followers, then allowed calls overlap and complete out of order', async () => {
  const first = deferred(), second = deferred(), third = deferred()
  const waiting = [first, second, third]
  platform = () => waiting[calls.length - 1].promise
  const p = controller()
  p.controller.accept([request(1), request(2, { kind: 'calendar' }), request(3)])
  assert.equal(calls.length, 0)
  assert.equal(p.pending.filter(Boolean).length, 1)
  p.controller.allowPending()
  assert.equal(calls.length, 3)
  assert.deepEqual(remembered, [['version-a', target]])
  second.resolve('second')
  third.resolve('third')
  first.resolve('first')
  await microtasks()
  assert.deepEqual(p.completed.map(item => [item.effect.effectId, item.text]), [[2, 'second'], [3, 'third'], [1, 'first']])
})

test('no-consent real platform calls overlap and dispatch in completion order', async () => {
  const first = deferred(), second = deferred()
  platform = () => calls.length === 1 ? first.promise : second.promise
  const p = harness()
  await p.acquire()
  p.post('pair')
  assert.equal(calls.length, 2)
  second.resolve('second')
  await pump()
  first.resolve('first')
  await pump()
  assert.deepEqual((await p.snapshot()).answers, ['second', 'first'])
  assert.deepEqual(p.posts.map(item => item.effectId), [p.effects[1].effectId, p.effects[0].effectId])
})

for (const [name, fail, text] of [
  ['synchronous adapter throw', () => { throw Error('sync adapter') }, 'error: sync adapter'],
  ['adapter rejection', () => Promise.reject(Error('async adapter')), 'error: async adapter'],
  ['non-Error rejection', () => Promise.reject('plain rejection'), 'error: plain rejection'],
  ['null rejection', () => Promise.reject(null), 'error: null']
]) {
  test(name + ' returns error prefix to real VM', async () => {
    platform = fail
    const p = harness()
    await p.acquire()
    p.post()
    await pump()
    assert.deepEqual((await p.snapshot()).answers, [text])
    assert.equal(p.posts[0].text, text)
    assert.deepEqual(p.failures, [])
  })
}

test('controller captures stamp at acceptance and copies request params across consent wait', async () => {
  const p = controller()
  const effect = request(1, { params: ['key', 'original'] })
  p.controller.accept([effect])
  effect.params[1] = 'mutated'
  effect.rawTarget = 'wrong.target'
  p.stamp = 'version-b'
  p.controller.allowPending()
  await microtasks()
  assert.deepEqual(remembered, [['version-a', target]])
  assert.deepEqual(calls[0].values, [['key', 'original']])
  assert.equal(p.completed[0].effect.rawTarget, target)
})

for (const kind of ['invalidate', 'generation', 'inactive']) {
  test('controller drops stale completion after ' + kind, async () => {
    const answer = deferred()
    platform = () => answer.promise
    const p = controller({ askBeforeCalls: false })
    p.controller.accept([request()])
    if (kind === 'invalidate') p.controller.invalidate()
    if (kind === 'generation') p.epoch++
    if (kind === 'inactive') p.active = false
    answer.resolve('stale')
    await microtasks()
    assert.deepEqual(p.completed, [])
  })
}

test('controller invalidation clears pending consent and held followers', async () => {
  const p = controller()
  p.controller.accept([request(), request(2)])
  p.controller.invalidate()
  p.controller.allowPending()
  p.controller.refusePending()
  await microtasks()
  assert.equal(calls.length, 0)
  assert.deepEqual(p.completed, [])
  assert.equal(p.pending.at(-1), null)
})

test('wrong app/generation and duplicate requests are rejected before and after actual handle binding', async () => {
  const p = harness()
  p.begin(programs.refresh.stamp)
  const acquiring = p.host.acquire('', programs.refresh, config(), p.subscriber)
  const original = p.effects[0]
  p.binding.onEffectRequest({ ...original, appId: 'wrong' })
  p.binding.onEffectRequest({ ...original, vmGeneration: original.vmGeneration + 1 })
  p.binding.onEffectRequest(original)
  p.handle = await finish(acquiring)
  p.binding.bind(p.handle)
  p.binding.onEffectRequest(original)
  p.binding.onEffectRequest({ ...original, appId: 'wrong', effectId: 90 })
  p.binding.onEffectRequest({ ...original, vmGeneration: 999, effectId: 91 })
  await pump()
  assert.equal(calls.length, 1)
  assert.deepEqual((await p.snapshot()).answers, ['ok'])
  assert.equal(p.posts.length, 1)
})

test('prebind buffer snapshots request and params and cannot be rebound to a second lease', async () => {
  const p = harness()
  p.begin(programs.refresh.stamp)
  const acquiring = p.host.acquire('', programs.refresh, config(), p.subscriber)
  const original = p.effects[0]
  original.params[1] = 'mutated-after-buffer'
  original.rawTarget = 'mutated.target'
  p.handle = await finish(acquiring)
  p.binding.bind(p.handle)
  p.binding.bind({ ...p.handle, appId: 'different' })
  await pump()
  assert.equal(calls[0].target, target)
  assert.equal(calls[0].values[0][1], 'refresh')
  assert.equal(p.posts[0].handle, p.handle)
})

test('replacement widgetRefresh buffers before returned handle and old binding never accepts replacement effects', async () => {
  const p = harness()
  await p.acquire()
  const oldHandle = p.handle, oldBinding = p.binding
  p.begin(programs.refresh.stamp)
  const replacing = p.host.replaceProgram(oldHandle, programs.refresh, config())
  assert.equal(p.effects.length, 1)
  assert.equal(calls.length, 0)
  const emitted = p.effects[0]
  assert.equal(emitted.vmGeneration, oldHandle.vmGeneration + 1)
  oldBinding.onEffectRequest(emitted)
  p.handle = await finish(replacing)
  p.binding.bind(p.handle)
  oldBinding.bind(p.handle)
  await pump()
  assert.equal(calls.length, 1)
  assert.equal(p.posts[0].handle, p.handle)
  assert.deepEqual((await p.snapshot()).answers, ['ok'])
})

test('failed binding discards buffered effects; failed acquire never executes platform', async () => {
  const p = harness()
  p.begin()
  const failed = p.binding
  failed.onEffectRequest(request())
  failed.failBinding()
  failed.bind({ appId: 'app', vmGeneration: 1, leaseId: 'late' })
  failed.onEffectRequest(request(2))
  await microtasks()
  assert.equal(calls.length, 0)
  p.begin(programs.bad.stamp)
  await assert.rejects(p.host.acquire('', programs.bad, config(), p.subscriber), error => error.code === 'ACTOR_NOT_READY')
  p.binding.failBinding()
  await microtasks()
  assert.equal(calls.length, 0)
})

for (const lifecycle of ['release', 'replace', 'promotion', 'dispose']) {
  test(lifecycle + ' invalidates in-flight origin and never rebinds stale callbacks to new handle', async () => {
    const answer = deferred()
    platform = () => answer.promise
    const p = harness()
    await p.acquire()
    p.post()
    const oldHandle = p.handle, oldBinding = p.binding, oldEffect = p.effects[0]
    p.bridge.invalidate()
    if (lifecycle === 'release') {
      await finish(p.host.release(oldHandle))
      await p.acquire()
    } else if (lifecycle === 'replace') {
      await p.replace()
    } else if (lifecycle === 'promotion') {
      p.begin(programs.basic.stamp)
      p.handle = await finish(p.host.promote(oldHandle, 'LIVE_PERSISTENT', 'promoted/version'))
      p.binding.bind(p.handle)
    } else {
      await finish(p.host.dispose())
    }
    oldBinding.bind(p.handle)
    oldBinding.onEffectRequest({ ...oldEffect, effectId: oldEffect.effectId + 100 })
    oldBinding.failBinding()
    answer.resolve('stale result')
    await pump()
    assert.equal(calls.length, 1)
    assert.equal(p.posts.length, 0)
    if (lifecycle !== 'dispose') {
      assert.deepEqual((await p.snapshot()).answers, [])
      platform = () => Promise.resolve('new result')
      p.post()
      await pump()
      assert.deepEqual((await p.snapshot()).answers, ['new result'])
      assert.equal(p.posts[0].handle, p.handle)
    }
  })
}

test('captureValidity cancellation while field flush awaits suppresses result', async () => {
  let valid = true
  const gate = deferred()
  const p = harness({ captureValidity: () => () => valid })
  await p.acquire()
  p.flushHook = () => gate.promise
  p.post()
  await microtasks()
  assert.equal(p.flushes.length, 1)
  valid = false
  gate.resolve()
  await pump()
  assert.equal(p.posts.length, 0)
  assert.deepEqual((await p.snapshot()).answers, [])
  assert.deepEqual(p.failures, [])
})

test('binding replacement while awaiting field flush drops old result and preserves new result', async () => {
  const gate = deferred()
  const p = harness()
  await p.acquire()
  p.flushHook = () => gate.promise
  p.post()
  await microtasks()
  await p.replace()
  gate.resolve()
  p.flushHook = null
  p.post()
  await pump()
  assert.equal(p.posts.length, 1)
  assert.equal(p.posts[0].handle, p.handle)
  assert.deepEqual((await p.snapshot()).answers, ['ok'])
})

test('readyToPost false defers without timers and explicit flush resumes exactly once', async () => {
  let ready = false
  const p = harness({ readyToPost: () => ready })
  await p.acquire()
  p.post()
  await microtasks()
  assert.equal(p.posts.length, 0)
  assert.equal(timers.size, 0)
  ready = true
  await finish(p.bridge.flush())
  await pump()
  assert.equal(p.posts.length, 1)
  await finish(p.bridge.flush())
  await pump()
  assert.equal(p.posts.length, 1)
  assert.deepEqual((await p.snapshot()).answers, ['ok'])
})

test('REJECTED admission is terminal and never retried or reexecuted', async () => {
  const answer = deferred()
  platform = () => answer.promise
  const p = harness()
  await p.acquire()
  p.post()
  await finish(p.host.release(p.handle))
  answer.resolve('late')
  await microtasks()
  assert.equal(p.posts.length, 1)
  assert.equal(p.posts[0].admission.status, 'REJECTED')
  await finish(p.bridge.onMailboxWritable())
  await finish(p.bridge.flush())
  await pump()
  assert.equal(p.posts.length, 1)
  assert.equal(calls.length, 1)
})

test('in-flight field flush and older actions are admitted before result', async () => {
  const gate = deferred()
  const p = harness()
  await p.acquire()
  let once = true
  p.flushHook = async () => {
    if (!once) return
    once = false
    await gate.promise
    accepted(p.host.postInput(p.handle, input(p.handle, 'edit', 'composed', 'FIELD')))
  }
  p.post()
  await microtasks()
  p.post('add', 5)
  assert.equal(p.posts.length, 0)
  gate.resolve()
  await pump()
  const state = await p.snapshot()
  assert.equal(state.n, 6)
  assert.deepEqual(state.order, ['add', 'field', 'answer'])
  assert.deepEqual(state.observed, ['composed'])
  assert.equal(p.posts[0].admission.inputSeq, 4)
})

test('composition deferred promise flush keeps completion queued until composition is committed', async () => {
  const composition = deferred()
  const p = harness()
  await p.acquire()
  p.flushHook = () => composition.promise.then(() => {
    accepted(p.host.postInput(p.handle, input(p.handle, 'edit', 'IME committed', 'FIELD')))
  })
  p.post('pair')
  await microtasks()
  assert.equal(p.posts.length, 0)
  assert.equal(calls.length, 2)
  assert.equal(timers.size, 0)
  composition.resolve()
  await pump()
  assert.deepEqual((await p.snapshot()).observed, ['IME committed', 'IME committed'])
  assert.equal(p.posts.length, 2)
})

function fillMailbox(p) {
  for (let i = 0; i < 240; i++) accepted(p.host.postInput(p.handle, input(p.handle, 'add', 1)))
  for (let i = 0; i < 16; i++) accepted(p.host.postRefresh(p.handle, 'APP'))
  assert.equal(p.host.postRefresh(p.handle, 'APP').status, 'BACKPRESSURE')
  now += 9
}
function fillOnNextFrame(p) {
  p.frameHook = () => {
    p.frameHook = null
    fillMailbox(p)
  }
}

test('real mailbox full256 in onFrame yields, rejects result BACKPRESSURE then writable retries same text once without reexecution', async () => {
  platform = () => Promise.resolve('{"retry":"same text"}')
  const p = harness()
  await p.acquire()
  fillOnNextFrame(p)
  p.post()
  assert.equal(calls.length, 1)
  await microtasks()
  assert.equal(p.posts.length, 1)
  assert.equal(p.posts[0].admission.status, 'BACKPRESSURE')
  assert.equal(p.admissions.length, 0)
  assert.equal(timers.size, 1)
  await pump()
  assert.deepEqual(p.posts.map(item => item.admission.status), ['BACKPRESSURE', 'ACCEPTED'])
  assert.deepEqual(p.posts.map(item => item.text), ['{"retry":"same text"}', '{"retry":"same text"}'])
  assert.equal(p.posts[0].effectId, p.posts[1].effectId)
  assert.equal(p.posts[0].handle, p.posts[1].handle)
  assert.equal(calls.length, 1)
  assert.equal(p.admissions.length, 1)
  const state = await p.snapshot()
  assert.equal(state.n, 241)
  assert.deepEqual(state.answers, ['{"retry":"same text"}'])
  assert(p.events.includes('writable'))
})

test('retained BACKPRESSURE completions retry FIFO in completion order, not request order', async () => {
  const first = deferred(), second = deferred()
  platform = () => calls.length === 1 ? first.promise : second.promise
  const p = harness()
  await p.acquire()
  fillOnNextFrame(p)
  p.post('pair')
  second.resolve('second')
  await microtasks()
  first.resolve('first')
  await microtasks()
  assert(p.posts.every(item => item.admission.status === 'BACKPRESSURE'))
  assert.equal(p.posts[0].effectId, p.effects[1].effectId)
  await pump()
  assert.deepEqual((await p.snapshot()).answers, ['second', 'first'])
  assert.deepEqual(p.posts.filter(item => item.admission.status === 'ACCEPTED').map(item => item.text), ['second', 'first'])
  assert.equal(calls.length, 2)
})

test('reentrant writable while still blocked must not spin microtasks or busy retry timers', async () => {
  const p = harness()
  await p.acquire()
  let attempts = 0
  p.postHook = (handle, id, text, post) => {
    attempts++
    if (attempts > 4) throw Error('bounded guard: reentrant writable busy loop')
    const admission = post(handle, id, text)
    if (admission.status === 'BACKPRESSURE') p.bridge.onMailboxWritable()
    return admission
  }
  fillOnNextFrame(p)
  p.post()
  await microtasks()
  assert(attempts <= 2, 'reentrant writable repeatedly retried unchanged BACKPRESSURE: ' + attempts)
  assert.equal(timers.size, 1)
  assert.equal(calls.length, 1)
  assert.deepEqual(p.failures, [])
})

for (const lifecycle of ['invalidate', 'replace']) {
  test('synchronous post fast-frame callback ' + lifecycle + ' cannot shift another result or notify stale admission', async () => {
    const p = harness()
    await p.acquire()
    p.post('pair')
    let replacing = null
    p.frameHook = () => {
      p.frameHook = null
      if (lifecycle === 'invalidate') p.bridge.invalidate()
      else {
        p.begin(programs.newer.stamp)
        replacing = p.host.replaceProgram(p.handle, programs.newer, config())
      }
    }
    await pump()
    assert.equal(p.posts.length, 1)
    assert.equal(p.admissions.length, 0)
    if (replacing) {
      p.handle = await finish(replacing)
      p.binding.bind(p.handle)
      p.post()
      await pump()
      assert.deepEqual((await p.snapshot()).answers, ['ok'])
      assert.equal(p.posts.length, 2)
    } else {
      assert.deepEqual((await p.snapshot()).answers, ['ok'])
    }
  })
}

test('synchronous post fast-frame reentrant refusal appends result without losing or duplicating queued completion', async () => {
  const p = harness({ askBeforeCalls: true })
  await p.acquire()
  grants.set(programs.basic.vbc2, new Set([target]))
  p.post('pair')
  p.post('sdkFire')
  assert.equal(p.pending.at(-1).rawTarget, sdkTarget)
  p.frameHook = () => {
    p.frameHook = null
    p.bridge.refusePending()
  }
  await pump()
  assert.deepEqual((await p.snapshot()).answers, ['ok', 'ok', 'declined by the person'])
  assert.equal(p.posts.length, 3)
  assert.equal(p.admissions.length, 3)
  assert.equal(calls.length, 2)
  assert.equal(new Set(p.posts.map(item => item.effectId)).size, 3)
})

for (const point of ['captureValidity', 'validity', 'flush', 'readyToPost', 'postEffectResult', 'onAdmitted']) {
  test('throwing ' + point + ' callback is reported once, removes failed result, and leaves no unhandled rejection', async () => {
    const failure = Error('fixture ' + point)
    let throwOnce = true
    const fail = () => {
      if (throwOnce) { throwOnce = false; throw failure }
    }
    const options = {}
    if (point === 'captureValidity') options.captureValidity = () => { fail(); return () => true }
    if (point === 'validity') options.captureValidity = () => () => { fail(); return true }
    if (point === 'readyToPost') options.readyToPost = () => { fail(); return true }
    if (point === 'onAdmitted') options.onAdmitted = fail
    const p = harness(options)
    await p.acquire()
    if (point === 'flush') p.flushHook = fail
    if (point === 'postEffectResult') p.postHook = (handle, id, text, post) => { fail(); return post(handle, id, text) }
    p.post('pair')
    await pump()
    assert.equal(p.failures.length, 1)
    assert.equal(p.failures[0].error, failure)
    const state = await p.snapshot()
    assert.equal(state.answers.length, point === 'onAdmitted' ? 2 : 1)
    assert.equal(calls.length, 2)
    const count = p.posts.length
    await finish(p.bridge.flush())
    await pump()
    assert.equal(p.posts.length, count)
    assert.deepEqual(unhandled, [])
  })
}

test('failed replacement binding cannot resurrect buffered requests or disturb the restored old actor', async () => {
  const p = harness()
  await p.acquire()
  const oldHandle = p.handle, oldBinding = p.binding
  p.begin(programs.bad.vbc2)
  const failed = p.binding
  failed.onEffectRequest(request(100, { appId: oldHandle.appId, vmGeneration: oldHandle.vmGeneration + 1 }))
  await assert.rejects(p.host.replaceProgram(oldHandle, programs.bad, config()), error => error.code === 'ACTOR_NOT_READY')
  failed.failBinding()
  failed.bind(oldHandle)
  oldBinding.bind(oldHandle)
  oldBinding.onEffectRequest(request(101, { appId: oldHandle.appId, vmGeneration: oldHandle.vmGeneration }))
  await microtasks()
  assert.equal(calls.length, 0)
  p.begin(programs.basic.vbc2)
  p.binding.bind(oldHandle)
  p.post()
  await pump()
  assert.deepEqual((await p.snapshot()).answers, ['ok'])
  assert.equal(p.posts.length, 1)
})

test('rejected asynchronous field flush reports failure and removes only that result', async () => {
  const p = harness()
  await p.acquire()
  let once = true
  p.flushHook = () => {
    if (!once) return
    once = false
    return Promise.reject(Error('field flush rejected'))
  }
  p.post('pair')
  await pump()
  assert.equal(p.failures.length, 1)
  assert.equal(p.failures[0].error.message, 'field flush rejected')
  assert.deepEqual((await p.snapshot()).answers, ['ok'])
  assert.equal(p.posts.length, 1)
})

test('throwing failure reporter is contained and later completion still posts', async () => {
  const reported = []
  const p = harness({ onFailure: (effect, error) => { reported.push([effect, error]); throw Error('reporter failure') } })
  await p.acquire()
  let once = true
  p.flushHook = () => {
    if (once) { once = false; throw Error('flush failure') }
  }
  p.post('pair')
  await pump()
  assert.equal(reported.length, 1)
  assert.equal(reported[0][1].message, 'flush failure')
  assert.deepEqual((await p.snapshot()).answers, ['ok'])
  assert.deepEqual(unhandled, [])
})

test('COALESCED effect result is reported as invalid and never retried', async () => {
  const p = harness()
  await p.acquire()
  p.postHook = () => ({ status: 'COALESCED' })
  p.post()
  await pump()
  assert.equal(p.failures.length, 1)
  assert.equal(p.failures[0].error.message, 'EFFECT_RESULT cannot be coalesced')
  await finish(p.bridge.onMailboxWritable())
  await pump()
  assert.equal(p.posts.length, 1)
  assert.equal(calls.length, 1)
})

for (const previous of [false, true]) {
  test('reentrant beginBinding from onPending(null) keeps newest binding with previous=' + previous, async () => {
    let armed = false, newest
    const p = harness({ onPending: effect => {
      p.pending.push(effect)
      if (effect === null && armed) {
        armed = false
        newest = p.bridge.beginBinding(programs.basic.vbc2)
      }
    } })
    if (previous) await p.acquire()
    armed = true
    const superseded = p.bridge.beginBinding('superseded')
    assert(newest)
    superseded.bind({ appId: 'wrong', vmGeneration: 99, leaseId: 'wrong' })
    superseded.onEffectRequest(request(100))
    superseded.failBinding()
    p.binding = newest
    if (!previous) p.handle = await finish(p.host.acquire('', programs.basic, config(), p.subscriber))
    newest.bind(p.handle)
    p.post()
    await pump()
    assert.equal(calls.length, 1)
    assert.equal(p.posts.length, 1)
    assert.deepEqual((await p.snapshot()).answers, ['ok'])
    assert.deepEqual(p.failures, [])
  })
}

for (const allowed of [true, false]) {
  test('controller ' + (allowed ? 'allow' : 'refuse') + ' clear callback cannot let accepted followers overtake resolution', async () => {
    const order = []
    let inserted = false
    platform = call => { order.push('execute:' + call.values[0][1]); return Promise.resolve('ok') }
    const tagged = id => request(id, { kind: id === 1 ? 'sdk' : 'calendar', params: ['id', String(id)] })
    const p = controller({
      onPending: effect => {
        if (effect === null && !inserted) {
          inserted = true
          p.controller.accept([tagged(3)])
          assert.deepEqual(order, [])
        }
      },
      complete: effect => order.push('complete:' + effect.effectId)
    })
    p.controller.accept([tagged(1), tagged(2)])
    if (allowed) p.controller.allowPending()
    else p.controller.refusePending()
    assert.deepEqual(order, allowed ? ['execute:1', 'execute:2', 'execute:3'] : ['complete:1', 'execute:2', 'execute:3'])
    await microtasks()
    assert.deepEqual(order, allowed
      ? ['execute:1', 'execute:2', 'execute:3', 'complete:1', 'complete:2', 'complete:3']
      : ['complete:1', 'execute:2', 'execute:3', 'complete:2', 'complete:3'])
    assert.deepEqual(remembered, allowed ? [['version-a', target]] : [])
  })
}

for (const resolution of ['resolved', 'rejected', 'refused']) {
  test('throwing controller complete after ' + resolution + ' reports failure and preserves reentrant followers and rerun', async () => {
    const failure = Error('complete ' + resolution)
    const failures = [], completed = []
    let once = true
    platform = () => resolution === 'rejected' ? Promise.reject(Error('adapter rejected')) : Promise.resolve('ok')
    const p = controller({ askBeforeCalls: resolution === 'refused',
      onFailure: (effect, error) => failures.push({ effect, error }),
      complete: (effect, text) => {
        completed.push([effect.effectId, text])
        if (once) {
          once = false
          p.controller.accept([request(3, { kind: 'calendar' })])
          throw failure
        }
      }
    })
    p.controller.accept([request(1), request(2, { kind: 'calendar' })])
    if (resolution === 'refused') p.controller.refusePending()
    await microtasks()
    p.controller.accept([request(4, { kind: 'calendar' })])
    await microtasks()
    assert.deepEqual(completed.map(item => item[0]), [1, 2, 3, 4])
    assert.equal(completed[0][1], resolution === 'refused' ? 'declined by the person'
      : resolution === 'rejected' ? 'error: adapter rejected' : 'ok')
    assert.equal(failures.length, 1)
    assert.equal(failures[0].effect.effectId, 1)
    assert.equal(failures[0].error, failure)
    assert.equal(calls.length, resolution === 'refused' ? 3 : 4)
    assert.deepEqual(unhandled, [])
  })
}

for (const point of ['show', 'allow-clear', 'refuse-clear', 'invalidate-clear']) {
  test('throwing controller onPending at ' + point + ' reports once and leaves followers runnable', async () => {
    const failure = Error('pending ' + point)
    const failures = []
    let once = true
    const p = controller({
      onPending: effect => {
        const matches = point === 'show' ? effect !== null : effect === null
        if (matches && once) {
          once = false
          p.controller.accept([request(3, { kind: 'calendar' })])
          throw failure
        }
      },
      onFailure: (effect, error) => failures.push({ effect, error })
    })
    p.controller.accept([request(1), request(2, { kind: 'calendar' })])
    if (point === 'allow-clear') p.controller.allowPending()
    if (point === 'refuse-clear') p.controller.refusePending()
    if (point === 'invalidate-clear') p.controller.invalidate()
    await microtasks()
    p.controller.accept([request(4, { kind: 'calendar' })])
    await microtasks()
    assert.equal(failures.length, 1)
    assert.equal(failures[0].error, failure)
    assert.equal(failures[0].effect?.effectId ?? null, point === 'invalidate-clear' ? null : 1)
    assert.deepEqual(p.completed.map(item => item.effect.effectId), point === 'invalidate-clear' ? [3, 4] : [2, 3, 4])
    assert.equal(calls.length, point === 'invalidate-clear' ? 2 : 3)
    p.controller.allowPending()
    p.controller.refusePending()
    await microtasks()
    assert.equal(failures.length, 1)
    assert.deepEqual(unhandled, [])
  })
}

for (const point of ['begin', 'invalidate']) {
  test('throwing bridge onPending(null) at ' + point + ' reports without breaking next binding', async () => {
    const failure = Error('bridge clear ' + point)
    let armed = false
    const p = harness({ onPending: effect => {
      if (effect === null && armed) { armed = false; throw failure }
    } })
    if (point === 'invalidate') await p.acquire()
    armed = true
    if (point === 'invalidate') p.bridge.invalidate()
    await p.acquire()
    p.post('pair')
    await pump()
    assert.equal(p.failures.length, 1)
    assert.equal(p.failures[0].effect, null)
    assert.equal(p.failures[0].error, failure)
    assert.deepEqual((await p.snapshot()).answers, ['ok', 'ok'])
  })
}

test('field flush barrier returning bridge.flush does not await itself and drains each result once', async () => {
  const p = harness()
  await p.acquire()
  p.flushHook = () => p.bridge.flush()
  p.post('pair')
  await pump()
  assert.equal(p.posts.length, 2)
  assert.equal(p.flushes.length, 2)
  assert.equal(calls.length, 2)
  assert.deepEqual((await p.snapshot()).answers, ['ok', 'ok'])
  assert.deepEqual(p.failures, [])
})

test('active flush is an immediately resolved kick, not a completion barrier', async () => {
  const gate = deferred()
  const p = harness()
  await p.acquire()
  p.flushHook = () => gate.promise
  p.post('pair')
  await microtasks()
  assert.equal(p.flushes.length, 1)
  await finish(p.bridge.flush())
  await finish(p.bridge.flush())
  assert.equal(p.posts.length, 0)
  assert.equal(p.flushes.length, 1)
  assert.equal(timers.size, 0)
  gate.resolve()
  await pump()
  assert.equal(p.posts.length, 2)
  assert.deepEqual((await p.snapshot()).answers, ['ok', 'ok'])
  await finish(p.bridge.flush())
  await pump()
  assert.equal(p.posts.length, 2)
})

for (const [text, outcome] of [['ok', 'OK'], ['declined code=7', 'DECLINED'], ['error 7: denied', 'ERROR']]) {
  test('host-authoritative ' + outcome + ' result trace precedes EXECUTE and duplicate admission adds no trace', async () => {
    platform = () => Promise.resolve(text)
    const p = harness()
    await p.acquire()
    p.post()
    await pump()
    const effect = p.effects[0]
    const requests = traces.filter(record => record.event === 'EFFECT_REQUEST')
    const results = traces.filter(record => record.event === 'EFFECT_RESULT')
    assert.equal(requests.length, 1)
    assert.equal(results.length, 1)
    assert.equal(results[0].session, requests[0].session)
    assert.deepEqual(results[0].attributes, { id: effect.effectId, resultHandler: 'answered', generation: p.handle.vmGeneration, outcome })
    const execution = traces.find(record => record.event === 'EXECUTE' && record.attributes.kind === 'EFFECT_RESULT')
    assert(execution)
    assert.equal(execution.session, results[0].session)
    assert(traces.indexOf(results[0]) < traces.indexOf(execution))
    const count = traces.length
    assert.equal(p.host.postEffectResult(p.handle, effect.effectId, 'duplicate').status, 'REJECTED')
    p.binding.onEffectRequest(effect)
    await pump()
    assert.equal(traces.length, count)
    assert.equal(calls.length, 1)
    assert.deepEqual((await p.snapshot()).answers, [text])
  })
}

test('BACKPRESSURE emits no premature result trace and retry emits one host result before execution', async () => {
  const p = harness()
  await p.acquire()
  fillOnNextFrame(p)
  p.post()
  await microtasks()
  assert.equal(p.posts[0].admission.status, 'BACKPRESSURE')
  assert.equal(traces.filter(record => record.event === 'EFFECT_REQUEST').length, 1)
  assert.equal(traces.filter(record => record.event === 'EFFECT_RESULT').length, 0)
  await pump()
  const results = traces.filter(record => record.event === 'EFFECT_RESULT')
  const execution = traces.find(record => record.event === 'EXECUTE' && record.attributes.kind === 'EFFECT_RESULT')
  assert.equal(results.length, 1)
  assert.equal(results[0].attributes.outcome, 'OK')
  assert(execution)
  assert(traces.indexOf(results[0]) < traces.indexOf(execution))
  assert.equal(traces.filter(record => record.event === 'EFFECT_REQUEST').length, 1)
  assert.equal(calls.length, 1)
  assert.deepEqual((await p.snapshot()).answers, ['ok'])
})

for (const phase of ['buffered', 'consent', 'in-flight', 'queued', 'backpressure', 'barrier', 'invalidity']) {
  test('stale bridge ' + phase + ' emits exactly one drop per effect and no duplicate request trace', async () => {
    const answer = deferred(), barrier = deferred()
    let valid = true
    if (phase === 'in-flight') platform = () => answer.promise
    const p = harness({ askBeforeCalls: phase === 'consent', captureValidity: () => () => valid,
      readyToPost: () => phase !== 'queued' })
    if (phase === 'buffered') {
      p.begin(programs.refresh.vbc2)
      p.handle = await finish(p.host.acquire('', programs.refresh, config(), p.subscriber))
    } else {
      await p.acquire()
      if (phase === 'barrier') p.flushHook = () => barrier.promise
      if (phase === 'backpressure') fillOnNextFrame(p)
      p.post(phase === 'consent' ? 'pair' : 'fire')
      if (phase === 'invalidity') valid = false
      await microtasks()
    }
    const oldBinding = p.binding
    const state = p.bridge.binding
    assert(state.owners instanceof Map)
    assert.equal(state.owners.size, phase === 'invalidity' ? 0 : p.effects.length)
    if (phase === 'backpressure') assert.equal(p.posts[0].admission.status, 'BACKPRESSURE')
    const effects = [...p.effects]
    const requestTraces = traces.filter(record => record.event === 'EFFECT_REQUEST')
    assert.equal(requestTraces.length, effects.length)
    assert.equal(traces.filter(record => record.event === 'EFFECT_RESULT').length, phase === 'invalidity' ? 1 : 0)
    p.bridge.invalidate()
    assert.equal(state.owners.size, 0)
    p.bridge.invalidate()
    oldBinding.bind(p.handle)
    for (const effect of effects) oldBinding.onEffectRequest(effect)
    oldBinding.failBinding()
    answer.resolve('late')
    barrier.resolve()
    await pump()
    await finish(p.bridge.flush())
    await pump()
    const results = traces.filter(record => record.event === 'EFFECT_RESULT')
    assert.equal(results.length, effects.length)
    for (const effect of effects) {
      const matching = results.filter(record => record.attributes.id === effect.effectId &&
        record.attributes.generation === effect.vmGeneration && record.attributes.outcome === 'DROPPED_STALE')
      assert.equal(matching.length, 1)
      const requested = requestTraces.find(record => record.attributes.id === effect.effectId &&
        record.attributes.generation === effect.vmGeneration)
      assert(requested)
      assert.equal(matching[0].session, requested.session)
    }
    assert.equal(traces.filter(record => record.event === 'EFFECT_REQUEST').length, effects.length)
    assert.equal(traces.filter(record => record.event === 'EXECUTE' && record.attributes.kind === 'EFFECT_RESULT').length, 0)
    assert.equal(p.posts.filter(post => post.admission.status === 'ACCEPTED').length, 0)
    assert.equal(p.posts.length, phase === 'backpressure' ? 1 : 0)
    assert.deepEqual((await p.snapshot()).answers, [])
    assert.deepEqual(p.failures, [])
  })
}

for (const lifecycle of ['rebind', 'invalidate']) {
  test('initial prebind effects remain owned when first pending callback triggers ' + lifecycle, async () => {
    const program = compile(fixture({ refresh: true, refreshCount: 3 }))
    let interrupted = false
    const p = harness({ askBeforeCalls: true, onPending: effect => {
      p.pending.push(effect)
      if (effect !== null && !interrupted) {
        interrupted = true
        if (lifecycle === 'rebind') p.begin(program.vbc2)
        else p.bridge.invalidate()
      }
    } })
    const oldBinding = p.begin(program.vbc2)
    const acquiring = p.host.acquire('', program, config(), p.subscriber)
    assert.equal(p.effects.length, 3)
    assert.equal(calls.length, 0)
    assert.deepEqual(p.pending, [null])
    p.handle = await finish(acquiring)
    const effects = [...p.effects]
    oldBinding.bind(p.handle)
    assert(interrupted)
    assert.deepEqual(p.pending.filter(Boolean).map(effect => effect.effectId), [effects[0].effectId])
    const dropped = traces.filter(record => record.event === 'EFFECT_RESULT')
    assert.equal(dropped.length, 3)
    for (const effect of effects) {
      assert.equal(dropped.filter(record => record.attributes.id === effect.effectId &&
        record.attributes.generation === effect.vmGeneration && record.attributes.outcome === 'DROPPED_STALE').length, 1)
    }
    assert.equal(calls.length, 0)
    assert.equal(p.posts.length, 0)
    if (lifecycle === 'invalidate') p.begin(program.vbc2)
    p.binding.bind(p.handle)
    oldBinding.bind(p.handle)
    for (const effect of effects) oldBinding.onEffectRequest(effect)
    oldBinding.failBinding()
    p.post()
    assert.equal(p.pending.at(-1).effectId, p.effects[3].effectId)
    p.bridge.allowPending()
    await pump()
    assert.equal(calls.length, 1)
    assert.equal(p.posts.length, 1)
    assert.equal(p.posts[0].effectId, p.effects[3].effectId)
    assert.deepEqual((await p.snapshot()).answers, ['ok'])
    assert.deepEqual(traces.filter(record => record.event === 'EFFECT_RESULT' &&
      record.attributes.outcome === 'DROPPED_STALE'), dropped)
    assert.equal(traces.filter(record => record.event === 'EFFECT_REQUEST').length, 4)
    assert.deepEqual(p.failures, [])
  })
}

for (const settlement of ['never', 'resolve', 'reject']) {
  test('controller invalidation immediately discards unresolved adapter once; later ' + settlement + ' cannot affect new work', async () => {
    const answer = deferred()
    const discarded = [], failures = []
    platform = () => answer.promise
    const p = controller({ askBeforeCalls: false, traceOwner: {}, traceRequests: true,
      onDiscard: effect => discarded.push(effect), onFailure: (effect, error) => failures.push({ effect, error }) })
    p.controller.accept([request(1), request(2)])
    assert.equal(calls.length, 2)
    assert.deepEqual(discarded, [])
    assert.equal(traces.filter(record => record.event === 'EFFECT_RESULT').length, 0)
    p.controller.invalidate()
    assert.deepEqual(discarded.map(effect => effect.effectId), [1, 2])
    const dropped = traces.filter(record => record.event === 'EFFECT_RESULT')
    assert.deepEqual(dropped.map(record => [record.attributes.id, record.attributes.outcome]),
      [[1, 'DROPPED_STALE'], [2, 'DROPPED_STALE']])
    p.controller.invalidate()
    assert.equal(discarded.length, 2)
    assert.deepEqual(p.completed, [])
    p.epoch++
    platform = () => Promise.resolve('new generation')
    p.controller.accept([request(3, { vmGeneration: p.epoch })])
    await microtasks()
    assert.deepEqual(p.completed.map(item => [item.effect.effectId, item.text]), [[3, 'new generation']])
    const beforeSettlement = [...traces]
    if (settlement === 'resolve') answer.resolve('stale completion')
    if (settlement === 'reject') answer.reject(Error('stale rejection'))
    await pump()
    p.controller.invalidate()
    assert.deepEqual(discarded.map(effect => effect.effectId), [1, 2])
    assert.deepEqual(traces, beforeSettlement)
    assert.equal(calls.length, 3)
    assert.deepEqual(p.completed.map(item => [item.effect.effectId, item.text]), [[3, 'new generation']])
    assert.deepEqual(failures, [])
    assert.deepEqual(unhandled, [])
  })
}

for (const lifecycle of ['invalidate', 'rebind']) {
  for (const settlement of ['never', 'resolve', 'reject']) {
    test('bridge ' + lifecycle + ' immediately drops in-flight effects once; later ' + settlement + ' cannot reach new binding', async () => {
      const answer = deferred()
      platform = () => answer.promise
      const p = harness()
      await p.acquire()
      const oldBinding = p.binding, oldHandle = p.handle
      p.post('pair')
      const effects = [...p.effects]
      assert.equal(calls.length, 2)
      assert.equal(traces.filter(record => record.event === 'EFFECT_RESULT').length, 0)
      if (lifecycle === 'invalidate') p.bridge.invalidate()
      else p.begin(programs.newer.vbc2)
      const dropped = traces.filter(record => record.event === 'EFFECT_RESULT')
      assert.equal(dropped.length, 2)
      for (const effect of effects) {
        assert.equal(dropped.filter(record => record.attributes.id === effect.effectId &&
          record.attributes.generation === oldHandle.vmGeneration && record.attributes.outcome === 'DROPPED_STALE').length, 1)
      }
      assert.equal(p.posts.length, 0)
      if (lifecycle === 'invalidate') p.begin(programs.newer.vbc2)
      p.handle = await finish(p.host.replaceProgram(oldHandle, programs.newer, config()))
      p.binding.bind(p.handle)
      oldBinding.bind(p.handle)
      for (const effect of effects) oldBinding.onEffectRequest(effect)
      oldBinding.failBinding()
      assert.equal(calls.length, 2)
      platform = () => Promise.resolve('new binding')
      p.post()
      await pump()
      assert.equal(p.posts.length, 1)
      assert.equal(p.posts[0].handle, p.handle)
      assert.deepEqual((await p.snapshot()).answers, ['new binding'])
      const beforeSettlement = [...traces]
      if (settlement === 'resolve') answer.resolve('stale completion')
      if (settlement === 'reject') answer.reject(Error('stale rejection'))
      await pump()
      await finish(p.bridge.flush())
      await pump()
      assert.deepEqual(traces, beforeSettlement)
      assert.deepEqual(traces.filter(record => record.event === 'EFFECT_RESULT' &&
        record.attributes.outcome === 'DROPPED_STALE'), dropped)
      assert.equal(calls.length, 3)
      assert.equal(p.posts.length, 1)
      assert.equal(p.admissions.length, 1)
      assert.deepEqual((await p.snapshot()).answers, ['new binding'])
      assert.deepEqual(p.failures, [])
      assert.deepEqual(unhandled, [])
    })
  }
}

for (const buffered of [false, true]) {
  test('accepted effects retain request session and release strong owners with buffered=' + buffered, async () => {
    const answer = deferred()
    platform = () => answer.promise
    const p = harness()
    if (buffered) await p.acquire(programs.refresh)
    else { await p.acquire(); p.post('pair') }
    const state = p.bridge.binding
    assert(state.owners instanceof Map)
    assert.equal(state.owners.size, p.effects.length)
    const requests = traces.filter(record => record.event === 'EFFECT_REQUEST')
    assert.equal(requests.length, p.effects.length)
    for (const effect of p.effects) assert(StageTrace.effectOwner(effect))
    answer.resolve('private response payload')
    await pump()
    assert.equal(state.owners.size, 0)
    const results = traces.filter(record => record.event === 'EFFECT_RESULT')
    assert.equal(results.length, requests.length)
    for (const requested of requests) {
      const matching = results.filter(record => record.attributes.id === requested.attributes.id &&
        record.attributes.generation === requested.attributes.generation)
      assert.equal(matching.length, 1)
      assert.equal(matching[0].session, requested.session)
      assert.equal(matching[0].attributes.outcome, 'OK')
    }
    for (const effect of p.effects) p.binding.onEffectRequest(effect)
    assert.equal(state.owners.size, 0)
    p.bridge.invalidate()
    assert.equal(state.owners.size, 0)
    assert.equal(traces.filter(record => record.event === 'EFFECT_RESULT').length, results.length)
    const serialized = JSON.stringify(traces)
    for (const payload of [target, 'private response payload', 'initial']) assert(!serialized.includes(payload))
    for (const requested of requests) {
      assert.match(requested.attributes.rawTarget, /^[0-9a-f]{16}$/)
      assert.match(requested.attributes.params, /^[0-9a-f]{16}$/)
      assert.match(requested.attributes.rawMode, /^[0-9a-f]{16}$/)
    }
    assert.deepEqual(p.failures, [])
  })
}

test('same effect id and generation stay session-isolated across actors and bridge rebindings', async () => {
  const late = deferred()
  platform = () => late.promise
  const p = harness(), q = harness()
  await p.acquire()
  await q.acquire()
  p.post()
  q.post()
  const first = p.effects[0], second = q.effects[0]
  assert.equal(first.effectId, second.effectId)
  assert.equal(first.vmGeneration, second.vmGeneration)
  const firstOwner = StageTrace.effectOwner(first), secondOwner = StageTrace.effectOwner(second)
  assert(firstOwner)
  assert(secondOwner)
  assert.notEqual(firstOwner, secondOwner)
  const requests = traces.filter(record => record.event === 'EFFECT_REQUEST')
  assert.equal(requests.length, 2)
  assert.notEqual(requests[0].session, requests[1].session)
  const oldState = p.bridge.binding, oldBinding = p.binding
  p.bridge.invalidate()
  assert.equal(oldState.owners.size, 0)
  assert.equal(q.bridge.binding.owners.size, 1)
  const firstDrop = traces.filter(record => record.event === 'EFFECT_RESULT')
  assert.equal(firstDrop.length, 1)
  assert.equal(firstDrop[0].session, requests[0].session)
  await finish(p.host.release(p.handle))
  await p.acquire()
  platform = () => Promise.resolve('new actor response')
  p.post()
  const third = p.effects[1]
  assert.equal(third.effectId, first.effectId)
  assert.equal(third.vmGeneration, first.vmGeneration)
  const thirdOwner = StageTrace.effectOwner(third)
  assert(thirdOwner)
  assert.notEqual(thirdOwner, firstOwner)
  assert.notEqual(thirdOwner, secondOwner)
  oldBinding.onEffectRequest(first)
  oldBinding.failBinding()
  await pump()
  late.resolve('old actor response')
  await pump()
  const allRequests = traces.filter(record => record.event === 'EFFECT_REQUEST')
  const results = traces.filter(record => record.event === 'EFFECT_RESULT')
  assert.equal(allRequests.length, 3)
  assert.equal(new Set(allRequests.map(record => record.session)).size, 3)
  assert.equal(results.length, 3)
  for (const [index, requested] of allRequests.entries()) {
    const matching = results.filter(record => record.session === requested.session)
    assert.equal(matching.length, 1)
    assert.equal(matching[0].attributes.id, requested.attributes.id)
    assert.equal(matching[0].attributes.generation, requested.attributes.generation)
    assert.equal(matching[0].attributes.outcome, index === 0 ? 'DROPPED_STALE' : 'OK')
  }
  assert.equal(oldState.owners.size, 0)
  assert.equal(p.bridge.binding.owners.size, 0)
  assert.equal(q.bridge.binding.owners.size, 0)
  assert.deepEqual((await p.snapshot()).answers, ['new actor response'])
  assert.deepEqual((await q.snapshot()).answers, ['old actor response'])
  assert.equal(calls.length, 3)
})

test('trace configure resets weak effect owner associations and disabled associations stay absent', async () => {
  const effect = request(), owner = {}
  StageTrace.associateEffectOwner(effect, owner)
  assert.equal(StageTrace.effectOwner(effect), owner)
  assert.equal(StageTrace.effectOwner({ ...effect }), undefined)
  assert.deepEqual(Object.keys(effect).sort(), Object.keys(request()).sort())
  StageTrace.configure(true, record => traces.push(record))
  assert.equal(StageTrace.effectOwner(effect), undefined)
  StageTrace.associateEffectOwner(effect, owner)
  assert.equal(StageTrace.effectOwner(effect), owner)
  StageTrace.configure(false, record => traces.push(record))
  assert.equal(StageTrace.effectOwner(effect), undefined)
  const disabled = request(2)
  StageTrace.associateEffectOwner(disabled, owner)
  assert.equal(StageTrace.effectOwner(disabled), undefined)
  StageTrace.configure(true, record => traces.push(record))
  assert.equal(StageTrace.effectOwner(effect), undefined)
  assert.equal(StageTrace.effectOwner(disabled), undefined)
  assert.deepEqual(traces, [])
})

test('disabled host requests carry no owner association or retained bridge owners', async () => {
  StageTrace.configure(false, record => traces.push(record))
  const late = deferred()
  platform = () => late.promise
  const p = harness()
  await p.acquire(programs.refresh)
  const state = p.bridge.binding
  assert.equal(StageTrace.effectOwner(p.effects[0]), undefined)
  assert.equal(state.owners.size, 0)
  p.bridge.invalidate()
  assert.equal(state.owners.size, 0)
  late.resolve('disabled response')
  await pump()
  assert.deepEqual(traces, [])
  StageTrace.configure(true, record => traces.push(record))
  assert.equal(StageTrace.effectOwner(p.effects[0]), undefined)
  assert.equal(p.posts.length, 0)
})

const hostBookkeeping = [
  { class: 'C', owner: 'UiHostEnvironment.pendingEffects', legacy: 'queueSdk appends immediately; owners drain or drop the array', required: 'A future guard.accept must leave accepted effects queued, not dispatch them; rollback restores the original queue baseline' },
  { class: 'C', owner: 'UiHostEnvironment.nextEffectId', legacy: 'queueSdk reserves and returns an ID immediately, before constructing the effect', required: 'Rollback restores the original ID baseline; IDs remain monotonically visible/reserved across the whole-turn queue; reuse is allowed only after refused results become unreachable' },
  { class: 'C', owner: 'UiHostEnvironment.effectsAllowed', legacy: 'owners toggle permission and usually force false on exit', required: 'Every future exit restores the original effectsAllowed value, not an assumed false; discard invalidates the host instance' },
  { class: 'C', owner: 'AppActor', legacy: 'toggles host permission; clearEffects drops requests; drainEffects replaces queue then invokes callbacks.effects', required: 'Future whole-turn acceptance retains effects queued; callbacks publish only afterward, never in scope.accept' },
  { class: 'C', owner: 'VeraLiveWidget', legacy: 'WidgetSession toggles permission, clears queues and extracts permitted source requests; answer refuses phone effects', required: 'Future refusal restores bookkeeping or discards and invalidates the instance; accepted source requests remain deferred' },
  { class: 'C', owner: 'VeraMovingPart', legacy: 'appMovingPart enables effects, drops requests during samples and clears permission/queue on exit', required: 'Future sample rollback restores original bookkeeping or discards and invalidates the instance' },
  { class: 'C', owner: 'VeraSurfacePlay', legacy: 'playSurface enables handler effects then drops requests in finally', required: 'Future whole-turn refusal restores the original permission/queue/ID baseline or discards and invalidates the instance' },
  { class: 'C', owner: 'VeraWorldPlay', legacy: 'WorldPlay.handle enables effects then clears permission/queue in finally', required: 'Future whole-turn refusal restores the original permission/queue/ID baseline or discards and invalidates the instance' },
  { class: 'C', owner: 'VeraSmoke', legacy: 'smokeRun enables handler effects then clears permission/queue in finally', required: 'Future sample rollback restores original bookkeeping or discards and invalidates the instance' },
  { class: 'C', owner: 'VeraSourceFind', legacy: 'sourceShownError enables then disables effects on its local host without draining', required: 'Future refusal restores bookkeeping or discards and invalidates the instance; no dispatch during acceptance' },
  { class: 'D', owner: 'VeraUi.nextNodeId', legacy: 'decodeVeraUi resets; decodeNode reads and increments', required: 'Decode-only scratch, reset per decode; not authoritative state or a turn effect ID' },
  { class: 'D', owner: 'UiHostEnvironment.invoke UI constructors', legacy: 'Surface/World/Ticker/BackHandler and other constructors return declarative view values', required: 'Registry declarations remain declarative decode data; no immediate VM registry mutation' },
  { class: 'C', owner: 'renderer registry updates', legacy: 'renderer consumes decoded declarations', required: 'Future registry updates are post-accept publication, not VM-time registration or effects callbacks in scope.accept' },
  { class: 'B', owner: 'StateManager authoritative root', legacy: 'beginTurn captures originalRoot and opens the rollback guard; setWorkingState replaces working; refuseTurn rolls back the guard and restores originalRoot; finishTurn accepts without publishing', required: 'Preserve authoritative root identity on refusal and defer publication until acceptance; classification records the implemented root rollback, not production transaction validation by this inventory' }
]
const hostGuardCoverage = {
  roots: ['entry/src/main/ets', 'widget/src/main/ets'],
  extensions: ['.ets', '.ts', '.tsx', '.js'],
  limits: 'Bounded conservative AST inventory, not an ArkTS type proof: tracks explicit type/import/new and cast-only seeds, local extends subclasses, local assignment aliases, receiver-independent sensitive binding keys, destructuring declarations/assignments and member escapes. File-wide alias names deliberately overapproximate shadowed/unrelated receivers and sensitive object-literal keys, including P2 counters/log declarations. Thirteen approved safety-scope/record/hook/invoke/queueSdk/decode bodies, five AppActorTurnCoordinator constructor/runTurn/publication/fence bodies and two P2Host safety/invoke forwarding bodies pin enclosing control. Coordinator permissions return to its owned false baseline outside VM guard settlement; the VM guard restores its captured entry permission. Benchmark hosts queue/introspect locally without adapter dispatch; benchmark diagnostics and other owner scopes pin ordered sites only, not control-flow equivalence. Token-aware printer normalization preserves literal whitespace. TypeScript parser recovery is used for ArkUI syntax. No inter-file/interprocedural alias inference, reflective string synthesis, eval, runtime/native alias proof, generated sources, other roots, journal-inactive validation or production transaction validation; StateManager B root classification is manually reviewed, not body-pinned here.'
}
const hostBaseline = {
  'entry/src/main/ets/components/VeraLiveTree.ets:<module>': ["import { VeraUiNode } from '../vera/VeraUi';"],
  'entry/src/main/ets/components/VeraPreview.ets:<module>': ["import { VeraUiNode, formatVeraNumber, formatVeraClock, formatVeraDate, unitAfter, keepUnits } from '../vera/VeraUi';"],
  'entry/src/main/ets/runtime/AppActor.ets:<module>': [
    "import { UiHostEnvironment, HostEffect, VeraUiNode, decodeVeraUi } from '../vera/VeraUi';",
    'export interface AppActorTurnEffects extends AppActorTurnVersion { readonly effects: HostEffect[]; }',
    'export interface AppActorTurnCallbacks { snapshot: (snapshot: AppActorTurnSnapshot) => void; effects: (delivery: AppActorTurnEffects) => void; render: (version: AppActorTurnVersion, pure: (call: AppActorTurnCall) => RuntimeValue) => void | Promise<void>; error: (error: AppActorTurnError) => void; }',
    'export interface AppActorCallbacks { render: (paint: boolean, reveal: boolean) => void | Promise<void>; snapshot: (encoded: string) => void; saved: (projectId: string) => void; effects: (effects: HostEffect[]) => void; error: (kind: string, message: string) => void; }'
  ],
  'entry/src/main/ets/runtime/AppActor.ets:AppActorTurnCoordinator': ['private host: UiHostEnvironment;'],
  'entry/src/main/ets/runtime/AppActor.ets:AppActorTurnCoordinator.constructor': [
    'host: UiHostEnvironment', 'this.host = host;', 'state.status().mode !== mode || host.pendingEffects.length !== 0', 'this.host.effectsAllowed = false;'
  ],
  'entry/src/main/ets/runtime/AppActor.ets:AppActorTurnCoordinator.runTurn': [
    "this.host.effectsAllowed = this.mode !== 'PREVIEW';", 'this.host.pendingEffects.length > 0',
    'hasEffects = this.host.pendingEffects.length > 0;', 'this.host.effectsAllowed = false;',
    'this.host.pendingEffects = [];', 'this.host.effectsAllowed = false;', 'this.host.pendingEffects = [];',
    'this.host.pendingEffects = [];', 'this.host.pendingEffects = [];', 'this.host.pendingEffects = [];',
    'effects = this.host.pendingEffects', 'this.host.pendingEffects = [];', 'await this.publish(result, effects, owner);',
    'this.host.pendingEffects = [];', 'this.host.effectsAllowed = false;'
  ],
  'entry/src/main/ets/runtime/AppActor.ets:AppActorTurnCoordinator.publish': ['await this.publishOwned(result, effects, owner);'],
  'entry/src/main/ets/runtime/AppActor.ets:AppActorTurnCoordinator.publishOwned': [
    'effects.length > 0', 'this.callbacks.effects({ mode: version.mode, vmGeneration: version.vmGeneration, stateRevision: version.stateRevision, effects: effects });'
  ],
  'entry/src/main/ets/runtime/AppActor.ets:AppActorTurnCoordinator.fence': ['this.host.effectsAllowed = false;', 'this.host.pendingEffects = [];'],
  'entry/src/main/ets/runtime/AppActor.ets:AppActor': ['private host: UiHostEnvironment | null = null;'],
  'entry/src/main/ets/runtime/AppActor.ets:AppActor.initialize': ['this.host = null;', 'this.host = new UiHostEnvironment();', 'this.vm = new VirtualMachine(module, this.host);'],
  'entry/src/main/ets/runtime/AppActor.ets:AppActor.clearEffects': ['this.host !== null', 'this.host!.effectsAllowed = false;', 'this.host!.pendingEffects = [];'],
  'entry/src/main/ets/runtime/AppActor.ets:AppActor.dispose': ['this.host = null;'],
  'entry/src/main/ets/runtime/AppActor.ets:AppActor.view': ['this.host !== null', 'this.host!.effectsAllowed = false;'],
  'entry/src/main/ets/runtime/AppActor.ets:AppActor.draw': ['this.host !== null', 'this.host!.effectsAllowed = false;'],
  'entry/src/main/ets/runtime/AppActor.ets:AppActor.buildScene': ['this.host !== null', 'this.host!.effectsAllowed = false;'],
  'entry/src/main/ets/runtime/AppActor.ets:AppActor.dispatch': ['this.host !== null', 'this.host!.effectsAllowed = true;', 'this.host !== null', 'this.host!.effectsAllowed = false;'],
  'entry/src/main/ets/runtime/AppActor.ets:AppActor.runWidgetRefresh': ['this.host !== null', 'this.host!.effectsAllowed = true;', 'this.host !== null', 'this.host!.effectsAllowed = false;'],
  'entry/src/main/ets/runtime/AppActor.ets:AppActor.frameHandlers': ['this.host !== null', 'this.host!.effectsAllowed = true;', 'this.host !== null', 'this.host!.effectsAllowed = false;'],
  'entry/src/main/ets/runtime/AppActor.ets:AppActor.move': ['this.host !== null', 'this.host!.effectsAllowed = true;', 'this.host !== null', 'this.host!.effectsAllowed = false;'],
  'entry/src/main/ets/runtime/AppActor.ets:AppActor.seeded': ['this.host !== null', 'this.host!.effectsAllowed = false;'],
  'entry/src/main/ets/runtime/AppActor.ets:AppActor.drainEffects': [
    "!this.ready() || this.mode === 'PREVIEW' || this.host === null", 'effects: HostEffect[] = this.host!.pendingEffects',
    'effects.length === 0', 'this.host!.pendingEffects = [];', 'this.callbacks.effects(effects);'
  ],
  'entry/src/main/ets/runtime/InProcessHost.ets:<module>': ["import { HostEffect, VeraUiNode } from '../vera/VeraUi';"],
  'entry/src/main/ets/vera/VeraLiveWidget.ets:<module>': ["import { UiHostEnvironment, VeraUiNode, decodeVeraUi, formatVeraNumber } from './VeraUi';"],
  'entry/src/main/ets/vera/VeraLiveWidget.ets:WidgetSession': ['private host: UiHostEnvironment = new UiHostEnvironment();'],
  'entry/src/main/ets/vera/VeraLiveWidget.ets:WidgetSession.constructor': ['this.vm = new VirtualMachine(module, this.host, LIVE_MAX_STEPS);'],
  'entry/src/main/ets/vera/VeraLiveWidget.ets:WidgetSession.settle': ['this.host.effectsAllowed = true;', 'this.host.pendingEffects = [];', 'this.host.effectsAllowed = false;', 'this.host.pendingEffects = [];'],
  'entry/src/main/ets/vera/VeraLiveWidget.ets:WidgetSession.frame': ['this.host.effectsAllowed = false;'],
  'entry/src/main/ets/vera/VeraLiveWidget.ets:WidgetSession.refresh': ['this.host.effectsAllowed = true;', 'this.host.pendingEffects = [];', 'this.host.effectsAllowed = false;', 'this.host.pendingEffects = [];'],
  'entry/src/main/ets/vera/VeraLiveWidget.ets:WidgetSession.answer': ['this.host.effectsAllowed = true;', 'this.host.pendingEffects = [];', 'this.host.pendingEffects.length > 0', 'this.host.effectsAllowed = false;', 'this.host.pendingEffects = [];'],
  'entry/src/main/ets/vera/VeraLiveWidget.ets:WidgetSession.tap': ['this.host.effectsAllowed = true;', 'this.host.pendingEffects = [];', 'this.host.effectsAllowed = false;', 'this.host.pendingEffects = [];'],
  'entry/src/main/ets/vera/VeraLiveWidget.ets:WidgetSession.tapSwitch': ['this.host.effectsAllowed = true;', 'this.host.pendingEffects = [];', 'this.host.effectsAllowed = false;', 'this.host.pendingEffects = [];'],
  'entry/src/main/ets/vera/VeraLiveWidget.ets:WidgetSession.tapSurface': ['this.host.effectsAllowed = true;', 'this.host.pendingEffects = [];', 'this.host.effectsAllowed = false;', 'this.host.pendingEffects = [];'],
  'entry/src/main/ets/vera/VeraLiveWidget.ets:WidgetSession.sourceRequests': ['this.host.pendingEffects'],
  'entry/src/main/ets/vera/VeraMovingPart.ets:<module>': ["import { decodeVeraUi, UiHostEnvironment, VeraUiNode } from './VeraUi';"],
  'entry/src/main/ets/vera/VeraMovingPart.ets:appMovingPart': ['host = new UiHostEnvironment()', 'host.effectsAllowed = true;', 'vm = new VirtualMachine(deserializeVbc2(vbc2), host, PART_MAX_VM_STEPS)', 'host.pendingEffects = [];', 'host.pendingEffects = [];', 'host.effectsAllowed = false;', 'host.pendingEffects = [];'],
  'entry/src/main/ets/vera/VeraSearchBenchmark.ets:<module>': [
    "import { UiHostEnvironment, VeraUiNode, decodeVeraUi } from './VeraUi';",
    'interface P2LogRecord { event?: string; runId?: string; protocol?: number; outcome?: string; mode?: string; modes?: string[]; workload?: number; corpus?: number; kind?: number; handlers?: number; pure?: number; maxSteps?: number; deadlineMs?: number; steps?: number; sample?: number; operations?: number; successfulOperations?: number; failedOperations?: number; unexecutedOperations?: number; stepsPerOperation?: number; batchMs?: number; msPerOperation?: number; failedBatchMs?: number; warmup?: number; warmups?: number; successfulSamples?: number; failedSamples?: number; journalReservations?: number; journalUndoRecords?: number; hostReservations?: number; runtimeBirthSerialDelta?: number; blockedCalls?: number; deferredEffects?: number; rootUnchanged?: number; callIndex?: number; inputUnchanged?: number; resultMatchesInputBefore?: number; resultMatchesInputAfter?: number; returnSameRuntimeValue?: number; persistenceFormatValid?: number; stateRoundTripEqual?: number; postStatePureViewChecked?: number; postStatePureViewOutcome?: string; stateSchemaChecked?: number; rollbackSucceeded?: number; checkScope?: string; ownershipAliasCorrectnessChecked?: number; minimumUndo?: number; minimumHost?: number; expectedReservations?: number; reservationExpectationsMet?: number; journalLimit?: number; executionOutcome?: string; rootRestored?: number; rollbackMs?: number; synchronousHostMs?: number; hostCalls?: number; cooperative?: number; elapsedMs?: number; projectsListed?: number; projectsVisited?: number; versionsListed?: number; bytecodesRead?: number; statesRead?: number; versionsSelected?: number; versionsNotSelected?: number; rejected?: number; oversized?: number; versionSelectionCap?: number; seedMode?: number; nodesVisited?: number; traversalLimited?: number; unvisitedNodesCountKnown?: number; handlersDiscovered?: number; handlersSelected?: number; handlersSkipped?: number; twoParameterFunctions?: number; pureEntriesSelected?: number; handlerSelectionCap?: number; pureSelectionCap?: number; explorationPasses?: number; effectCallbacksExercised?: number; samples?: number; widgetMaxSteps?: number; widgetDeadlineMs?: number; runLimitMs?: number; workLimitMs?: number; preflightLimitMs?: number; preflightMaxSteps?: number; referenceMs?: number; stopReason?: string; batchCap?: number; targetBatchMs?: number; baselineCurrentInfrastructure?: number; nativeEffectsExecuted?: number; gcForced?: number; clock?: string; birthSerialIsAllocationBytes?: number; journalPureHandlers?: number; hardPreemption?: number; compileTimed?: number; setupTimed?: number; codecsTimed?: number; fingerprintsTimed?: number; journalBeginExecuteAcceptTimed?: number; rollbackInSamples?: number; budgetEnabled?: number; journalEnabled?: number; executePure?: number; preInfrastructureBaseline?: number; pureOnly?: number; workloadsPlanned?: number; workloadsAttempted?: number; workloadsComplete?: number; inventoryComplete?: number; selectedWorkloadsComplete?: number; workloadsSkipped?: number; }'
  ],
  'entry/src/main/ets/vera/VeraSearchBenchmark.ets:P2Host': [
    'extends UiHostEnvironment', 'hostReservations: number = 0;', 'blockedCalls: number = 0;', 'slowProbe: boolean = false;', 'probeCalls: number = 0;',
    'beginSafetyTurn(reserve: () => void): VmHostSafetyScope', 'invoke(module: string, name: string, args: RuntimeValue[], awaited: boolean): RuntimeValue'
  ],
  'entry/src/main/ets/vera/VeraSearchBenchmark.ets:P2Host.beginSafetyTurn': [
    'return super.beginSafetyTurn((): void => { reserve(); this.hostReservations += 1; });', 'this.hostReservations += 1;'
  ],
  'entry/src/main/ets/vera/VeraSearchBenchmark.ets:P2Host.invoke': [
    "module === 'std/p2' && name === 'wait' && this.slowProbe", 'this.probeCalls += 1;', 'this.blockedCalls += 1;'
  ],
  'entry/src/main/ets/vera/VeraSearchBenchmark.ets:P2Prepared': ['host: P2Host;'],
  'entry/src/main/ets/vera/VeraSearchBenchmark.ets:P2Prepared.constructor': [
    'this.host = new P2Host();', 'this.host.effectsAllowed = !work.pure && work.calls[0].kind !== 0;',
    "this.vm = new VirtualMachine(work.module, this.host, work.maxSteps, mode === 'baseline' ? null : { now: p2Now, deadlineMs: work.deadlineMs }, mode === 'JOURNAL' || mode === 'journal-pure' ? { journalMode: 'JOURNAL', journalMaxEntries: limit } : null);"
  ],
  'entry/src/main/ets/vera/VeraSearchBenchmark.ets:p2Fingerprint': [
    'effects = prepared.host.pendingEffects.map((effect): Object => [effect.id, effect.kind, effect.fn, Array.from(effect.values.entries()), effect.resultHandler, effect.rawTarget, effect.rawParams, effect.rawMode])'
  ],
  'entry/src/main/ets/vera/VeraSearchBenchmark.ets:p2Diagnostics': [
    'host = prepared.host.hostReservations', '(work.pure && !unchanged) || reservations !== undo + host',
    "p2Log(runId, { event: 'diagnostic', workload: work.index, mode: mode, steps: prepared.steps, journalReservations: reservations, journalUndoRecords: undo, hostReservations: host, runtimeBirthSerialDelta: after.runtimeBirthSerial - before.runtimeBirthSerial, blockedCalls: prepared.host.blockedCalls, deferredEffects: prepared.host.pendingEffects.length, rootUnchanged: unchanged ? 1 : 0, outcome: work.pure && !unchanged ? 'pure-root-changed' : reservations !== undo + host ? 'counter-mismatch' : 'ok' });",
    'record.hostReservations = prepared.host.hostReservations;', 'record.blockedCalls = prepared.host.blockedCalls;', 'record.deferredEffects = prepared.host.pendingEffects.length;'
  ],
  'entry/src/main/ets/vera/VeraSearchBenchmark.ets:p2ReturnedState': [
    'host = new P2Host()', 'host.effectsAllowed = false;',
    "vm = new VirtualMachine(work.module, host, 100000, { now: p2Now, deadlineMs: work.deadlineMs }, { journalMode: 'JOURNAL', journalMaxEntries: P2_LIMIT })",
    'before !== JSON.stringify(encodeRuntimeValue(value)) || host.pendingEffects.length !== 0'
  ],
  'entry/src/main/ets/vera/VeraSearchBenchmark.ets:p2Ownership': [
    'setupCorrect = fresh !== original && fresh.fields !== original.fields && freshArray !== originalArray && freshArray.elements !== originalArray.elements && counters.journalReservations === 0 && counters.journalUndoRecords === 0 && prepared.host.hostReservations === 0;',
    'record.hostReservations = prepared.host.hostReservations;',
    'reservationsExpected = counters.journalReservations === expectedUndo && counters.journalUndoRecords === expectedUndo && prepared.host.hostReservations === 0'
  ],
  'entry/src/main/ets/vera/VeraSearchBenchmark.ets:p2Settlement': [
    'restored = before === JSON.stringify(encodeRuntimeValue(prepared.root)) && prepared.host.pendingEffects.length === 0',
    'reservationsExpected = counters.journalUndoRecords >= minimumUndo && prepared.host.hostReservations >= minimumHost && (expectedReservations < 0 || counters.journalReservations === expectedReservations)',
    'correct = rolledBack && restored && outcome === expected && reservationsExpected && counters.journalReservations === counters.journalUndoRecords + prepared.host.hostReservations',
    "record: P2LogRecord = { event: 'settlement', workload: work.index, checkScope: 'serialized-root-and-deferred-effects', ownershipAliasCorrectnessChecked: 0, minimumUndo: minimumUndo, minimumHost: minimumHost, expectedReservations: expectedReservations, reservationExpectationsMet: reservationsExpected ? 1 : 0, mode: 'JOURNAL', journalLimit: limit, steps: prepared.steps, journalReservations: counters.journalReservations, journalUndoRecords: counters.journalUndoRecords, hostReservations: prepared.host.hostReservations, outcome: correct ? 'ok' : 'failed', executionOutcome: outcome, rootRestored: restored ? 1 : 0 }"
  ],
  'entry/src/main/ets/vera/VeraSearchBenchmark.ets:p2HostDeadline': [
    'host = new P2Host()', 'host.slowProbe = true;', 'vm = new VirtualMachine(module, host, 5000000, { now: p2Now, deadlineMs: 4 })',
    "correct = outcome === 'budget' && host.probeCalls === 1",
    "record: P2LogRecord = { event: 'host-deadline', mode: 'budget', deadlineMs: 4, synchronousHostMs: 8, hostCalls: host.probeCalls, cooperative: 1, steps: vm.stepsExecuted(), outcome: correct ? 'ok' : 'failed', executionOutcome: outcome }"
  ],
  'entry/src/main/ets/vera/VeraSmoke.ets:<module>': ["import { UiHostEnvironment, decodeVeraUi, VeraUiNode } from './VeraUi';"],
  'entry/src/main/ets/vera/VeraSmoke.ets:smokeRun': ['host = new UiHostEnvironment()', 'vm = new VirtualMachine(deserializeVbc2(compiled.vbc2), host)', 'host.effectsAllowed = true;', 'host.effectsAllowed = false;', 'host.pendingEffects = [];'],
  'entry/src/main/ets/vera/VeraSourceFind.ets:<module>': ["import { UiHostEnvironment, VeraUiNode, decodeVeraUi, formatVeraNumber } from './VeraUi';"],
  'entry/src/main/ets/vera/VeraSourceFind.ets:sourceShownError': ['host = new UiHostEnvironment()', 'vm = new VirtualMachine(deserializeVbc2(vbc2), host)', 'host.effectsAllowed = true;', 'host.effectsAllowed = false;'],
  'entry/src/main/ets/vera/VeraSurfacePlay.ets:<module>': ["import { UiHostEnvironment, decodeVeraUi, VeraUiNode } from './VeraUi';"],
  'entry/src/main/ets/vera/VeraSurfacePlay.ets:playSurface': ['host = new UiHostEnvironment()', 'vm = new VirtualMachine(module, host)', 'host.effectsAllowed = true;', 'host.effectsAllowed = false;', 'host.pendingEffects = [];'],
  'entry/src/main/ets/vera/VeraUi.ets:HostEffect.constructor': ['this.id = id;'],
  'entry/src/main/ets/vera/VeraUi.ets:UiHostSafetyScope': ['private settle: (outcome: string) => void;', 'accept(): void', 'rollback(): void', 'discard(): void'],
  'entry/src/main/ets/vera/VeraUi.ets:UiHostSafetyScope.constructor': ['this.settle = settle;'],
  'entry/src/main/ets/vera/VeraUi.ets:UiHostSafetyScope.accept': ["this.settle('accept');"],
  'entry/src/main/ets/vera/VeraUi.ets:UiHostSafetyScope.rollback': ["this.settle('rollback');"],
  'entry/src/main/ets/vera/VeraUi.ets:UiHostSafetyScope.discard': ["this.settle('discard');"],
  'entry/src/main/ets/vera/VeraInterpreter.ets:VirtualMachine.beginTurn': ['hostScope = this.host.beginSafetyTurn(() => this.reserveHost(token));'],
  'entry/src/main/ets/vera/VeraInterpreter.ets:VirtualMachine.executeSafety': ['this.host.setSafetyPure(true);', 'this.host.setSafetyPure(false);'],
  'entry/src/main/ets/vera/VeraUi.ets:UiHostEnvironment': [
    'pendingEffects: HostEffect[] = [];', 'effectsAllowed: boolean = false;', 'private nextEffectId: number = 1;',
    'private safetyRecord: UiHostSafetyRecord | null = null;', 'private safetyPure: boolean = false;', 'private safetyInvalid: boolean = false;', 'private invoking: boolean = false;',
    'beginSafetyTurn(reserve: () => void): VmHostSafetyScope', 'setSafetyPure(pure: boolean): void', 'private checkSafetyIdle(): void', 'private settleSafety(record: UiHostSafetyRecord, outcome: string): void',
    'invoke(module: string, name: string, args: RuntimeValue[], awaited: boolean): RuntimeValue', 'private invokeValue(module: string, name: string, args: RuntimeValue[], awaited: boolean): RuntimeValue', 'private queueSdk(args: RuntimeValue[]): RuntimeValue'
  ],
  'entry/src/main/ets/vera/VeraUi.ets:UiHostEnvironment.beginSafetyTurn': [
    'this.checkSafetyIdle();', 'this.safetyRecord !== null || this.safetyPure', 'this.safetyRecord !== null', 'this.safetyRecord.failed = true;',
    'record = new UiHostSafetyRecord(this.pendingEffects, this.nextEffectId, this.effectsAllowed, reserve)', 'this.safetyRecord = record;',
    'this.settleSafety(record, outcome);'
  ],
  'entry/src/main/ets/vera/VeraUi.ets:UiHostEnvironment.setSafetyPure': ['this.checkSafetyIdle();', 'this.safetyPure = pure;'],
  'entry/src/main/ets/vera/VeraUi.ets:UiHostEnvironment.checkSafetyIdle': ['this.invoking', 'this.safetyRecord !== null', 'this.safetyRecord.failed = true;', 'this.safetyInvalid'],
  'entry/src/main/ets/vera/VeraUi.ets:UiHostEnvironment.settleSafety': [
    'this.checkSafetyIdle();', 'this.safetyRecord !== record', 'this.safetyRecord !== null', 'this.safetyRecord.failed = true;', 'this.pendingEffects = record.queue;', 'this.nextEffectId = record.nextId;',
    'this.pendingEffects.length = 0;', 'this.pendingEffects = record.queue;', 'this.safetyInvalid = true;', 'this.effectsAllowed = record.allowed;', 'this.safetyPure = false;', 'this.safetyRecord = null;'
  ],
  'entry/src/main/ets/vera/VeraUi.ets:UiHostEnvironment.invoke': [
    'this.checkSafetyIdle();', 'this.safetyRecord !== null && this.safetyRecord.failed', 'this.invoking = true;',
    'value = this.invokeValue(module, name, args, awaited)', 'this.safetyRecord !== null && this.safetyRecord.failed', 'this.safetyRecord !== null', 'this.safetyRecord.failed = true;', 'this.invoking = false;'
  ],
  'entry/src/main/ets/vera/VeraUi.ets:UiHostEnvironment.invokeValue': ['return this.queueSdk(args);'],
  'entry/src/main/ets/vera/VeraUi.ets:UiHostEnvironment.queueSdk': [
    'safety = this.safetyRecord !== null || this.safetyPure', '!safety && !this.effectsAllowed', 'this.safetyPure', 'safety && !this.effectsAllowed',
    'this.safetyRecord !== null', 'this.safetyRecord.reserve();', 'this.safetyRecord.failed', 'id = this.nextEffectId', 'this.nextEffectId = id + 1;',
    "effect = new HostEffect(id, 'sdk', 'call', values, safety ? handler : asString(args[2]))", 'this.pendingEffects.push(effect);', 'return new VeraNumberValue(id);'
  ],
  'entry/src/main/ets/vera/VeraUi.ets:<module>': ['nextNodeId: number = 0'],
  'entry/src/main/ets/vera/VeraUi.ets:decodeVeraUi': ['nextNodeId = 0;'],
  'entry/src/main/ets/vera/VeraUi.ets:decodeNode': ['node.id = nextNodeId;', 'nextNodeId += 1;'],
  'entry/src/main/ets/vera/VeraWidgetRefine.ets:<module>': ["import { decodeVeraUi, UiHostEnvironment, VeraUiNode } from './VeraUi';"],
  'entry/src/main/ets/vera/VeraWidgetRefine.ets:checkTaps': ['vm = new VirtualMachine(deserializeVbc2(vbc2), new UiHostEnvironment(), LIVE_MAX_STEPS)'],
  'entry/src/main/ets/vera/VeraWidgetRefine.ets:deadPicture': ['vm = new VirtualMachine(deserializeVbc2(vbc2), new UiHostEnvironment(), LIVE_MAX_STEPS)'],
  'entry/src/main/ets/vera/VeraWidgetRefine.ets:checkRefresh': ['host = new UiHostEnvironment()', 'vm = new VirtualMachine(deserializeVbc2(vbc2), host, LIVE_MAX_STEPS)'],
  'entry/src/main/ets/vera/VeraWorldPlay.ets:<module>': ["import { UiHostEnvironment, decodeVeraUi, VeraUiNode } from './VeraUi';"],
  'entry/src/main/ets/vera/VeraWorldPlay.ets:WorldPlay': ['readonly host: UiHostEnvironment;'],
  'entry/src/main/ets/vera/VeraWorldPlay.ets:WorldPlay.constructor': ['host: UiHostEnvironment', 'this.host = host;'],
  'entry/src/main/ets/vera/VeraWorldPlay.ets:WorldPlay.handle': ['this.host.effectsAllowed = true;', 'this.host.effectsAllowed = false;', 'this.host.pendingEffects = [];'],
  'entry/src/main/ets/vera/VeraWorldPlay.ets:playWorld': ['host = new UiHostEnvironment()', 'vm = new VirtualMachine(module, host)', 'play = new WorldPlay(world as VeraUiNode, state, vm, host, module)']
}
function hostSources() {
  const sources = new Map()
  const repo = path.resolve(root, '../../../..')
  function walk(dir) {
    if (!fs.existsSync(dir)) return
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name)
      if (item.isDirectory()) walk(file)
      else if (item.isFile() && hostGuardCoverage.extensions.includes(path.extname(file))) {
        sources.set(path.relative(repo, file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8'))
      }
    }
  }
  for (const dir of hostGuardCoverage.roots) walk(path.join(repo, dir))
  assert(sources.has('entry/src/main/ets/vera/VeraUi.ets'))
  return sources
}
const hostBodyBaseline = {
  'entry/src/main/ets/runtime/AppActor.ets:AppActorTurnCoordinator.constructor': `{
    this.state = state
    this.vm = vm
    this.host = host
    this.mode = mode
    this.policy = policy
    this.callbacks = callbacks
    this.generation = state.status().vmGeneration
    if (state.status().mode !== mode || host.pendingEffects.length !== 0) {
      throw new AppActorTurnError('STATE_VALIDATION_FAILED', 'state')
    }
    this.assertAvailable()
    this.host.effectsAllowed = false
  }`,
  'entry/src/main/ets/runtime/AppActor.ets:AppActorTurnCoordinator.runTurn': `{
    this.assertIdle()
    if (calls.length === 0) { throw new AppActorTurnError('STATE_VALIDATION_FAILED', 'handler') }
    if (this.mode === 'PREVIEW' && source !== 'INIT' && source !== 'CARRY') {
      throw new AppActorTurnError('STATE_PREVIEW_SUPPRESSED', 'handler')
    }
    let owner = this.owner()
    let commitClass = this.policy.classify(source, persist)
    let admitted = calls.map((call: AppActorTurnCall): AppActorTurnCall => {
      return { entry: call.entry, args: call.args.slice(), useState: call.useState }
    })
    this.currentPhase = 'EXECUTING'
    let release: () => void = (): void => {}
    this.settlement = new Promise<void>((resolve: () => void): void => { release = resolve })
    try {
      if (this.mode === 'LIVE_PERSISTENT' && commitClass === 'IMMEDIATE') {
        let ready = this.checkpointReady
        if (ready !== null) { await ready }
        await this.state.awaitReadyForImmediate()
        this.assertOwner(owner)
        this.assertAvailable()
        if (this.checkpointReload) { await this.publishCheckpointReload(owner) }
      }
      let tx: StateTransaction | null = null
      let submitted = false
      let result: StateAcceptanceResult
      let hasEffects = false
      try {
        tx = this.state.beginTurn(commitClass, source)
        this.host.effectsAllowed = this.mode !== 'PREVIEW'
        for (let call of admitted) {
          let args = call.useState ? [this.state.getWorkingState()].concat(call.args) : call.args
          let value = this.vm.execute(call.entry, args)
          this.assertOwner(owner)
          this.state.setWorkingState(tx, value)
          if (this.host.pendingEffects.length > 0) { this.state.markEffects(tx) }
        }
        hasEffects = this.host.pendingEffects.length > 0
        this.host.effectsAllowed = false
        this.currentPhase = 'COMMIT_PENDING'
        submitted = true
        this.recovering++
        try { result = await this.state.commitTurn(tx) }
        finally { this.recovering-- }
      } catch (error) {
        if (tx !== null && !submitted) {
          try { this.state.rollbackTurn(tx) }
          catch (_error) { this.currentPhase = 'FAULTED' }
        } else if (submitted) {
          this.currentPhase = 'FAULTED'
        }
        this.host.pendingEffects = []
        throw error as Error
      } finally {
        this.host.effectsAllowed = false
      }
      if (result.status === 'STALE_REVISION' || result.status === 'FAILED' &&
          (result.stage === 'turn-base-invalid' || result.stage === 'promotion-base-invalid')) {
        this.host.pendingEffects = []
        let refusal = new AppActorTurnError(result.status === 'FAILED' ? result.code : result.status, 'state', result)
        this.assertLocalOwner(owner)
        let status = this.state.status()
        if (!status.needsReload && (status.phase === 'READY' || status.phase === 'DEGRADED')) {
          owner = this.adoptRecovery(owner)
          this.currentPhase = 'PUBLISHING'
          try { await this.publish(null, [], owner) }
          catch (error) {
            this.assertOwner(owner)
            this.issue(error as Error, 'render')
          }
        }
        throw refusal
      }
      owner = this.alignOwner(owner)
      this.observeFault()
      if (result.status !== 'COMMITTED' && result.status !== 'IN_MEMORY' && result.status !== 'UNCHANGED') {
        this.host.pendingEffects = []
        let issue = new AppActorTurnError(result.status === 'FAILED' || result.status === 'COMMIT_UNCERTAIN' ?
          result.code : result.status, 'state', result)
        if (result.status === 'COMMIT_UNCERTAIN' || result.status === 'FENCED_COMMIT') {
          this.currentPhase = 'FAULTED'
        }
        if (this.policy.effective(commitClass, hasEffects) !== 'THROTTLED' ||
            !this.policy.transient(result) || this.currentPhase === 'FAULTED') { throw issue }
        this.assertAvailable()
        if (this.mode !== 'PREVIEW') { this.issue(issue as Error, 'state') }
      }
      this.assertAvailable()
      if (this.mode === 'PREVIEW') {
        this.host.pendingEffects = []
        return result
      }
      if (hasEffects && this.mode === 'LIVE_PERSISTENT' && result.status !== 'COMMITTED') {
        this.currentPhase = 'FAULTED'
        this.host.pendingEffects = []
        throw new AppActorTurnError('STATE_COMMIT_UNCERTAIN', 'state', result)
      }
      let effects = this.host.pendingEffects
      this.host.pendingEffects = []
      this.currentPhase = 'PUBLISHING'
      this.flushCheckpoint(owner)
      await this.publish(result, effects, owner)
      return result
    } catch (error) {
      this.host.pendingEffects = []
      if (this.mode === 'PREVIEW') { throw error as Error }
      if (!this.owns(owner)) { throw new AppActorTurnError('STATE_UNAVAILABLE', 'state') }
      throw this.issue(error as Error, 'handler')
    } finally {
      this.host.effectsAllowed = false
      this.observeFault()
      if (this.currentPhase !== 'FAULTED') { this.flushCheckpoint(owner) }
      if (this.phase() !== 'FAULTED') { this.currentPhase = 'READY' }
      release()
    }
  }`,
  'entry/src/main/ets/runtime/AppActor.ets:AppActorTurnCoordinator.publish': `{
    this.publications++
    try { await this.publishOwned(result, effects, owner) }
    finally { this.publications-- }
  }`,
  'entry/src/main/ets/runtime/AppActor.ets:AppActorTurnCoordinator.publishOwned': `{
    this.assertOwner(owner)
    let version = this.version()
    let failure: AppActorTurnError | null = null
    try {
      if (this.mode === 'LIVE_EPHEMERAL') {
        this.deliverSnapshot({
          mode: version.mode, vmGeneration: version.vmGeneration, stateRevision: 0,
          encoded: this.state.captureWorkingSnapshot()
        }, owner)
      } else if (result === null || result.status === 'COMMITTED' ||
          result.status === 'UNCHANGED' && result.reason === 'INIT_EQUAL') {
        this.deliverSnapshot(this.committed(version, result), owner)
      }
    } catch (error) {
      failure = new AppActorTurnError((error as Error).message, 'snapshot', result)
    }
    this.assertOwner(owner)
    if (this.currentPhase === 'FAULTED') { throw failure! }
    try {
      if (effects.length > 0) {
        this.callbacks.effects({
          mode: version.mode, vmGeneration: version.vmGeneration,
          stateRevision: version.stateRevision, effects: effects
        })
      }
    } catch (error) {
      if (failure === null) { failure = new AppActorTurnError((error as Error).message, 'effects', result) }
    }
    this.assertOwner(owner)
    this.assertAvailable()
    let reading = true
    let pure = (call: AppActorTurnCall): RuntimeValue => {
      this.assertOwner(owner)
      this.assertAvailable()
      if (!reading) { throw new AppActorTurnError('STATE_TURN_PENDING', 'view') }
      return this.executePure(call)
    }
    try {
      let delivery: void | Promise<void>
      try { delivery = this.callbacks.render(version, pure) }
      finally { reading = false }
      await delivery
    } catch (error) {
      if (failure === null) { failure = new AppActorTurnError((error as Error).message, 'render', result) }
    }
    this.assertOwner(owner)
    if (failure !== null) { throw failure }
  }`,
  'entry/src/main/ets/runtime/AppActor.ets:AppActorTurnCoordinator.fence': `{
    if (this.fenced) { return }
    this.fenced = true
    this.epoch++
    this.currentPhase = 'FAULTED'
    this.checkpointDelivery = null
    this.host.effectsAllowed = false
    this.host.pendingEffects = []
  }`,
  'entry/src/main/ets/vera/VeraSearchBenchmark.ets:P2Host.beginSafetyTurn': `{
    return super.beginSafetyTurn((): void => { reserve(); this.hostReservations += 1 })
  }`,
  'entry/src/main/ets/vera/VeraSearchBenchmark.ets:P2Host.invoke': `{
    if (module === 'std/p2' && name === 'wait' && this.slowProbe) {
      this.probeCalls += 1
      let until = p2Now() + 8
      while (p2Now() < until) {}
      return NULL_VALUE
    }
    if (module === 'std/time') {
      if (name === 'nowMillis') { return new VeraNumberValue(1700000000000) }
      if (name === 'nowSeconds') { return new VeraNumberValue(1700000000) }
      if (name === 'daysSinceEpoch') { return new VeraNumberValue(19675) }
      if (name === 'millisOfDay') { return new VeraNumberValue(43200000) }
      if (name === 'hourOfDay') { return new VeraNumberValue(12) }
      if (name === 'minuteOfHour') { return new VeraNumberValue(0) }
      if (name === 'weekday') { return new VeraNumberValue(2) }
      if (name === 'dayOfMonth') { return new VeraNumberValue(14) }
      if (name === 'monthOfYear') { return new VeraNumberValue(11) }
      if (name === 'year') { return new VeraNumberValue(2023) }
    } else if (module === 'std/ui' || module === 'std/math' || module === 'std/strings' ||
        module === 'std/gfx' || module === 'std/scene' || (module === 'std/sdk' && name === 'call')) {
      return super.invoke(module, name, args, awaited)
    }
    this.blockedCalls += 1
    throw new RuntimeTrap('R0015', 'P2_BLOCKED')
  }`,
  'UiHostSafetyScope.constructor': `{
    this.settle = settle
  }`,
  'UiHostSafetyScope.accept': `{ this.settle('accept') }`,
  'UiHostSafetyScope.rollback': `{ this.settle('rollback') }`,
  'UiHostSafetyScope.discard': `{ this.settle('discard') }`,
  'UiHostSafetyRecord.constructor': `{
    this.queue = queue
    this.entries = queue.slice()
    this.nextId = nextId
    this.allowed = allowed
    this.reserve = reserve
  }`,
  'UiHostEnvironment.beginSafetyTurn': `{
    this.checkSafetyIdle()
    if (this.safetyRecord !== null || this.safetyPure) {
      if (this.safetyRecord !== null) { this.safetyRecord.failed = true }
      throw new RuntimeTrap('R-TURN', 'host safety turn already active')
    }
    let record = new UiHostSafetyRecord(this.pendingEffects, this.nextEffectId, this.effectsAllowed, reserve)
    this.safetyRecord = record
    return new UiHostSafetyScope((outcome: string): void => { this.settleSafety(record, outcome) })
  }`,
  'UiHostEnvironment.setSafetyPure': `{
    this.checkSafetyIdle()
    this.safetyPure = pure
  }`,
  'UiHostEnvironment.checkSafetyIdle': `{
    if (this.invoking) {
      if (this.safetyRecord !== null) { this.safetyRecord.failed = true }
      throw new RuntimeTrap('R-TURN', 'host invoke is active')
    }
    if (this.safetyInvalid) { throw new RuntimeTrap('R-TURN', 'host safety instance discarded') }
  }`,
  'UiHostEnvironment.settleSafety': `{
    this.checkSafetyIdle()
    if (this.safetyRecord !== record) {
      if (this.safetyRecord !== null) { this.safetyRecord.failed = true }
      throw new RuntimeTrap('R-TURN', 'host safety scope already settled')
    }
    if (outcome === 'accept' && record.failed) { throw new RuntimeTrap('R-TURN', 'host safety scope failed') }
    if (outcome === 'rollback') {
      record.queue.length = 0
      for (let effect of record.entries) { record.queue.push(effect) }
      this.pendingEffects = record.queue
      this.nextEffectId = record.nextId
    }
    if (outcome === 'discard') {
      this.pendingEffects.length = 0
      record.queue.length = 0
      this.pendingEffects = record.queue
      this.safetyInvalid = true
    }
    this.effectsAllowed = record.allowed
    this.safetyPure = false
    this.safetyRecord = null
    record.queue = []
    record.entries = []
    record.reserve = (): void => {}
  }`,
  'UiHostEnvironment.invoke': `{
    this.checkSafetyIdle()
    if (this.safetyRecord !== null && this.safetyRecord.failed) {
      throw new RuntimeTrap('R-TURN', 'host safety scope failed')
    }
    this.invoking = true
    try {
      let value = this.invokeValue(module, name, args, awaited)
      if (this.safetyRecord !== null && this.safetyRecord.failed) {
        throw new RuntimeTrap('R-TURN', 'host safety scope failed')
      }
      return value
    } catch (e) {
      if (this.safetyRecord !== null) { this.safetyRecord.failed = true }
      throw e as Error
    } finally {
      this.invoking = false
    }
  }`,
  'UiHostEnvironment.queueSdk': `{
    let safety = this.safetyRecord !== null || this.safetyPure
    if (!safety && !this.effectsAllowed) {
      throw new RuntimeTrap('R0026', 'sdk.call may only be called from a handler, not from view')
    }
    let target = asString(args[0]).trim()
    let pairs = asArray(args[1]).elements
    if (pairs.length % 2 !== 0) {
      throw new RuntimeTrap('R0027', 'sdk.call parameters are name and value in pairs; got ' + pairs.length.toString() + ' items')
    }
    let values = new Map<string, string>()
    let order: string[] = []
    for (let i = 0; i + 1 < pairs.length; i = i + 2) {
      let key = asString(pairs[i]).trim()
      if (safety) { asString(pairs[i + 1]) }
      if (key.length === 0) { continue }
      values.set(key, asString(pairs[i + 1]))
      order.push(key)
    }
    let mode = args.length > 3 ? asString(args[3]) : 'background'
    let handler = safety ? asString(args[2]) : ''
    if (this.safetyPure) { throw new RuntimeTrap('R-PURE', 'sdk.call is unavailable during pure execution') }
    if (safety && !this.effectsAllowed) {
      throw new RuntimeTrap('R0026', 'sdk.call may only be called from a handler, not from view')
    }
    if (this.safetyRecord !== null) {
      this.safetyRecord.reserve()
      if (this.safetyRecord.failed) { throw new RuntimeTrap('R-TURN', 'host safety scope failed') }
    }
    let id = this.nextEffectId
    this.nextEffectId = id + 1
    let effect = new HostEffect(id, 'sdk', 'call', values, safety ? handler : asString(args[2]))
    effect.rawTarget = target
    effect.rawParams = order.join(' ')
    effect.rawMode = mode
    this.pendingEffects.push(effect)
    return new VeraNumberValue(id)
  }`,
  decodeVeraUi: `{
    nextNodeId = 0
    if (value instanceof VeraObjectValue) {
      return [decodeNode(value as VeraObjectValue, 0)]
    }
    return []
  }`,
  decodeNode: `{
    if (depth > 8) { throw new RuntimeTrap('R0021', 'view tree too deep (max 8)') }
    let node = new VeraUiNode()
    node.id = nextNodeId
    nextNodeId += 1
    for (let entry of obj.fields.entries()) {
      let key: string = entry[0]
      let v: RuntimeValue = entry[1]
      switch (key) {
        case 'type':
          if (v instanceof VeraStringValue) { node.kind = (v as VeraStringValue).value }
          break
        case 'style':
          if (v instanceof VeraStringValue) { node.style = (v as VeraStringValue).value }
          break
        case 'text':
          if (v instanceof VeraStringValue) { node.text = (v as VeraStringValue).value }
          break
        case 'src':
          if (v instanceof VeraStringValue) { node.source = (v as VeraStringValue).value }
          break
        case 'alt':
          if (v instanceof VeraStringValue) { node.alt = (v as VeraStringValue).value }
          break
        case 'action':
          if (v instanceof VeraStringValue) { node.action = (v as VeraStringValue).value }
          break
        case 'label':
          if (v instanceof VeraStringValue) { node.label = (v as VeraStringValue).value }
          break
        case 'tickerId':
          if (v instanceof VeraStringValue) { node.tickerId = (v as VeraStringValue).value }
          break
        case 'commands':
          if (v instanceof VeraStringValue) { node.commands = (v as VeraStringValue).value }
          break
        case 'prefix':
          if (v instanceof VeraStringValue) { node.prefix = (v as VeraStringValue).value }
          break
        case 'icon':
          if (v instanceof VeraStringValue) { node.icon = (v as VeraStringValue).value }
          break
        case 'suffix':
          if (v instanceof VeraStringValue) { node.suffix = (v as VeraStringValue).value }
          break
        case 'value':
          if (v instanceof VeraNumberValue) { node.eventValue = (v as VeraNumberValue).value }
          else if (v instanceof VeraStringValue) { node.value = (v as VeraStringValue).value }
          break
        case 'eventValue':
          if (v instanceof VeraNumberValue) { node.eventValue = (v as VeraNumberValue).value }
          break
        case 'numberValue':
          if (v instanceof VeraNumberValue) { node.numberValue = (v as VeraNumberValue).value }
          break
        case 'minimumDigits':
          if (v instanceof VeraNumberValue) { node.minimumDigits = (v as VeraNumberValue).value }
          break
        case 'decimals':
          if (v instanceof VeraNumberValue) { node.decimals = (v as VeraNumberValue).value }
          break
        case 'step':
          if (v instanceof VeraNumberValue) { node.step = (v as VeraNumberValue).value }
          break
        case 'spinPeriodMs':
          if (v instanceof VeraNumberValue) { node.spinPeriodMs = (v as VeraNumberValue).value }
          break
        case 'columns':
          if (v instanceof VeraNumberValue) { node.columns = (v as VeraNumberValue).value }
          break
        case 'minimum':
          if (v instanceof VeraNumberValue) { node.minimum = (v as VeraNumberValue).value }
          break
        case 'maximum':
          if (v instanceof VeraNumberValue) { node.maximum = (v as VeraNumberValue).value }
          break
        case 'checked':
          if (v instanceof VeraBooleanValue) { node.checked = (v as VeraBooleanValue).value }
          break
        case 'enabled':
          if (v instanceof VeraBooleanValue) { node.enabled = (v as VeraBooleanValue).value }
          break
        case 'bars':
          if (v instanceof VeraBooleanValue) { node.bars = (v as VeraBooleanValue).value }
          break
        case 'options':
          if (v instanceof VeraArrayValue) {
            let opts: string[] = []
            for (let o of (v as VeraArrayValue).elements) {
              if (o instanceof VeraStringValue) { opts.push((o as VeraStringValue).value) }
            }
            node.options = opts
          }
          break
        case 'series':
          if (v instanceof VeraArrayValue) {
            let nums: number[] = []
            for (let n of (v as VeraArrayValue).elements) {
              if (n instanceof VeraNumberValue) { nums.push((n as VeraNumberValue).value) }
            }
            node.series = nums
          }
          break
        case 'series2':
          if (v instanceof VeraArrayValue) {
            let nums2: number[] = []
            for (let n of (v as VeraArrayValue).elements) {
              if (n instanceof VeraNumberValue) { nums2.push((n as VeraNumberValue).value) }
            }
            node.series2 = nums2
          }
          break
        case 'series2Style':
          if (v instanceof VeraStringValue) { node.series2Style = (v as VeraStringValue).value }
          break
        case 'seriesLabel':
          if (v instanceof VeraStringValue) { node.seriesLabel = (v as VeraStringValue).value }
          break
        case 'series2Label':
          if (v instanceof VeraStringValue) { node.series2Label = (v as VeraStringValue).value }
          break
        case 'categories':
          if (v instanceof VeraArrayValue) {
            let cats: string[] = []
            for (let c of (v as VeraArrayValue).elements) {
              if (c instanceof VeraStringValue) { cats.push((c as VeraStringValue).value) }
            }
            node.categories = cats
          }
          break
        case 'keyboardType':
          if (v instanceof VeraStringValue) { node.keyboardType = (v as VeraStringValue).value }
          break
        case 'required':
          if (v instanceof VeraBooleanValue) { node.required = (v as VeraBooleanValue).value }
          break
        case 'requiredMessage':
          if (v instanceof VeraStringValue) { node.requiredMessage = (v as VeraStringValue).value }
          break
        case 'minLength':
          if (v instanceof VeraNumberValue) { node.minLength = (v as VeraNumberValue).value }
          break
        case 'minLengthMessage':
          if (v instanceof VeraStringValue) { node.minLengthMessage = (v as VeraStringValue).value }
          break
        case 'maxLength':
          if (v instanceof VeraNumberValue) { node.maxLength = (v as VeraNumberValue).value }
          break
        case 'maxLengthMessage':
          if (v instanceof VeraStringValue) { node.maxLengthMessage = (v as VeraStringValue).value }
          break
        case 'pattern':
          if (v instanceof VeraStringValue) { node.pattern = (v as VeraStringValue).value }
          break
        case 'patternMessage':
          if (v instanceof VeraStringValue) { node.patternMessage = (v as VeraStringValue).value }
          break
        case 'email':
          if (v instanceof VeraBooleanValue) { node.email = (v as VeraBooleanValue).value }
          break
        case 'emailMessage':
          if (v instanceof VeraStringValue) { node.emailMessage = (v as VeraStringValue).value }
          break
        case 'children':
          if (v instanceof VeraArrayValue) {
            for (let child of (v as VeraArrayValue).elements) {
              if (child instanceof VeraObjectValue) {
                node.children.push(decodeNode(child as VeraObjectValue, depth + 1))
              }
            }
          }
          break
        default:
          break
      }
    }
    node.style = resolveStyle(node.kind, node.style)
    if (node.series2Style.length > 0) { node.series2Style = resolveStyle(node.kind, node.series2Style) }
    return node
  }`
}
function hostCanonical(text) {
  const source = ts.createSourceFile('host-site.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const tokens = []
  function visit(node) {
    if (node.kind >= ts.SyntaxKind.FirstToken && node.kind <= ts.SyntaxKind.LastToken) tokens.push(node)
    else for (const child of node.getChildren(source)) visit(child)
  }
  visit(source)
  let end = 0, result = ''
  for (const token of tokens) {
    const start = token.getStart(source)
    result += text.slice(end, start).replace(/\s+/g, ' ') + text.slice(start, token.end)
    end = token.end
  }
  return (result + text.slice(end).replace(/\s+/g, ' ')).trim()
}
function hostInventory(sources) {
  const inventory = {}
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed })
  for (const [file, text] of [...sources].sort(([a], [b]) => a.localeCompare(b))) {
    const source = ts.createSourceFile(file.replace(/\.ets$/, '.ts'), text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const nodes = []
    function visit(node) { nodes.push(node); ts.forEachChild(node, visit) }
    visit(source)
    const print = node => hostCanonical(printer.printNode(ts.EmitHint.Unspecified, node, source))
    const hostTypes = new Set(['UiHostEnvironment', 'UiHost'])
    for (const node of nodes) {
      if (ts.isImportSpecifier(node) && hostTypes.has((node.propertyName || node.name).text)) hostTypes.add(node.name.text)
    }
    for (let changed = true; changed;) {
      const size = hostTypes.size
      for (const node of nodes) {
        if (ts.isClassDeclaration(node) && node.name && node.heritageClauses?.some(clause =>
          clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types.some(type => ts.isIdentifier(type.expression) && hostTypes.has(type.expression.text)))) hostTypes.add(node.name.text)
      }
      changed = size !== hostTypes.size
    }
    const aliases = new Set(hostTypes)
    const sensitive = new Set(['pendingEffects', 'effectsAllowed', 'nextEffectId', 'nextNodeId', 'beginSafetyTurn', 'setSafetyPure'])
    const unwrap = node => {
      while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node))) node = node.expression
      return node
    }
    const owner = node => {
      const names = []
      for (let at = node.parent; at && at !== source; at = at.parent) {
        if (ts.isClassDeclaration(at) || ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) names.unshift(at.name ? print(at.name) : '<anonymous>')
        else if (ts.isConstructorDeclaration(at)) names.unshift('constructor')
      }
      return names.join('.') || '<module>'
    }
    const internal = node => hostTypes.has(owner(node).split('.')[0]) || owner(node).split('.')[0] === 'UiHostSafetyScope'
    const nameOf = node => ts.isPropertyAccessExpression(node) ? node.name.text : ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : ''
    const hostType = node => node && print(node).split(/\W+/).some(name => hostTypes.has(name))
    const hostLike = raw => {
      if (raw && (ts.isAsExpression(raw) || ts.isTypeAssertionExpression(raw)) && hostType(raw.type)) return true
      if (raw && (ts.isParenthesizedExpression(raw) || ts.isNonNullExpression(raw) || ts.isAsExpression(raw) || ts.isTypeAssertionExpression(raw))) return hostLike(raw.expression)
      const node = unwrap(raw)
      if (!node) return false
      if (ts.isIdentifier(node)) return aliases.has(node.text)
      if (node.kind === ts.SyntaxKind.ThisKeyword) return internal(node)
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return aliases.has(nameOf(node)) || hostLike(node.expression)
      if (ts.isNewExpression(node)) return hostLike(node.expression)
      return false
    }
    function bind(name) {
      if (ts.isIdentifier(name)) aliases.add(name.text)
      else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name)
    }
    function bindTarget(raw) {
      const node = unwrap(raw)
      if (!node) return
      if (ts.isIdentifier(node)) aliases.add(node.text)
      else if (ts.isPropertyAccessExpression(node)) aliases.add(node.name.text)
      else if (ts.isElementAccessExpression(node) && nameOf(node)) aliases.add(nameOf(node))
      else if (ts.isObjectLiteralExpression(node)) {
        for (const item of node.properties) {
          if (ts.isPropertyAssignment(item)) bindTarget(item.initializer)
          else if (ts.isShorthandPropertyAssignment(item)) bindTarget(item.name)
          else if (ts.isSpreadAssignment(item)) bindTarget(item.expression)
        }
      } else if (ts.isArrayLiteralExpression(node)) {
        for (const item of node.elements) bindTarget(ts.isSpreadElement(item) ? item.expression : item)
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) bindTarget(node.left)
    }
    const sensitiveKey = node => node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? sensitive.has(node.text) : ts.isComputedPropertyName(node) && sensitiveKey(node.expression))
    for (const node of nodes) {
      if (ts.isBindingElement(node) && sensitiveKey(node.propertyName || node.name)) bind(node.name)
      if (ts.isPropertyAssignment(node) && sensitiveKey(node.name)) bindTarget(node.initializer)
      if (ts.isShorthandPropertyAssignment(node) && sensitiveKey(node.name)) bindTarget(node.name)
      if (ts.isImportSpecifier(node) && ['UiHostEnvironment', 'UiHost'].includes((node.propertyName || node.name).text)) aliases.add(node.name.text)
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isPropertyDeclaration(node)) && hostType(node.type)) bind(node.name)
    }
    for (let changed = true; changed;) {
      const size = aliases.size
      for (const node of nodes) {
        if (ts.isVariableDeclaration(node) && hostLike(node.initializer)) bind(node.name)
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && hostLike(node.right)) {
          bindTarget(node.left)
        }
      }
      changed = size !== aliases.size
    }
    const sites = new Set()
    for (const node of nodes) {
      const property = ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
      const identifier = ts.isIdentifier(node)
      const declaration = (ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node)) && internal(node)
      const hit = declaration || (property && (sensitive.has(nameOf(node)) || aliases.has(nameOf(node)) || hostLike(node.expression))) ||
        (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'nextNodeId') ||
        ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && /(?:^|\/)VeraUi$/.test(node.moduleSpecifier.text)) ||
        (identifier && (node.text === 'nextNodeId' || aliases.has(node.text))) || (node.kind === ts.SyntaxKind.ThisKeyword && internal(node) && !ts.isPropertyAccessExpression(node.parent))
      if (!hit) continue
      if (identifier && ((ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
          ((ts.isVariableDeclaration(node.parent) || ts.isParameter(node.parent) || ts.isPropertyDeclaration(node.parent) || ts.isClassDeclaration(node.parent)) && node.parent.name === node))) continue
      let site = node
      while (site.parent && site.parent !== source && !ts.isStatement(site) && !ts.isVariableDeclaration(site) && !ts.isParameter(site) && !ts.isPropertyDeclaration(site) && !ts.isMethodDeclaration(site) && !ts.isHeritageClause(site) && !ts.isImportDeclaration(site) &&
          !ts.isIfStatement(site.parent) && !ts.isForOfStatement(site.parent) && !ts.isForStatement(site.parent) && !ts.isWhileStatement(site.parent)) site = site.parent
      if (ts.isMethodDeclaration(site)) {
        const signature = print(site).split(' {')[0]
        const key = file + ':' + owner(site)
        if (!inventory[key]) inventory[key] = []
        if (!sites.has(site)) inventory[key].push(signature)
      } else {
        const key = file + ':' + owner(site)
        if (!inventory[key]) inventory[key] = []
        if (!sites.has(site)) inventory[key].push(print(site))
      }
      sites.add(site)
    }
  }
  return inventory
}
function checkHostBodies(sources) {
  const uiFile = 'entry/src/main/ets/vera/VeraUi.ets'
  const files = new Set([uiFile, ...Object.keys(hostBodyBaseline).filter(name => name.includes(':')).map(name => name.split(':')[0])])
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed })
  const print = (body, parsed) => hostCanonical(printer.printNode(ts.EmitHint.Unspecified, body, parsed))
  const actual = {}, expected = {}
  for (const file of files) {
    assert(sources.has(file), 'missing pinned host source: ' + file)
    const source = ts.createSourceFile(file, sources.get(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    function visit(node) {
      let name = ''
      if (node.parent && ts.isClassDeclaration(node.parent)) {
        const owner = node.parent.name?.text
        const member = ts.isConstructorDeclaration(node) ? 'constructor' : ts.isMethodDeclaration(node) ? node.name.getText(source) : ''
        const key = (file === uiFile ? '' : file + ':') + owner + '.' + member
        if (member && Object.hasOwn(hostBodyBaseline, key)) name = key
      }
      if (file === uiFile && ts.isFunctionDeclaration(node) && ['decodeVeraUi', 'decodeNode'].includes(node.name?.text)) name = node.name.text
      if (name) {
        assert(!Object.hasOwn(actual, name), 'duplicate pinned host body: ' + name)
        assert(node.body, 'missing pinned host body: ' + name)
        actual[name] = print(node.body, source)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  for (const [name, body] of Object.entries(hostBodyBaseline)) {
    const parsed = ts.createSourceFile('approved.ts', 'function approved() ' + body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    assert.equal(parsed.parseDiagnostics.length, 0)
    expected[name] = print(parsed.statements[0].body, parsed)
  }
  assert.deepEqual(actual, expected, 'P3 approved host mutation bodies/control changed')
}
function checkHostInventory(sources) {
  assert.deepEqual(hostInventory(sources), hostBaseline, 'P3 host access inventory changed; review owner-scoped normalized sites, order and escapes')
  checkHostBodies(sources)
}
test('P3 future C contracts, implemented B root rollback and D decode scratch stay distinct from legacy characterization', () => {
  assert.equal(hostBookkeeping.filter(row => row.class === 'C').length, 11)
  assert.equal(hostBookkeeping.filter(row => row.class === 'B').length, 1)
  assert.equal(hostBookkeeping.filter(row => row.class === 'D').length, 2)
  for (const row of hostBookkeeping) assert(row.owner && row.legacy && row.required)
})
test('P3 bounded actual-source host inventory', () => {
  const sources = hostSources()
  checkHostInventory(sources)
  console.log('P3 inventory: ' + sources.size + ' source files scanned; ' + Object.keys(hostBaseline).length +
    ' owner scopes; ' + Object.values(hostBaseline).reduce((count, sites) => count + sites.length, 0) + ' ordered baseline sites; ' + Object.keys(hostBodyBaseline).length + ' approved mutation bodies; 11 C future contracts / 1 B implemented root rollback / 2 D decode-only contracts')
  console.log('P3 limits: ' + hostGuardCoverage.limits)
})
const hostProbeFile = 'entry/src/main/ets/vera/VeraUi.ets'
const hostNegativeProbes = [
  ['extra pendingEffects.push', hostProbeFile, 'this.pendingEffects.push(effect)', 'this.pendingEffects.push(effect); this.pendingEffects.push(effect)'],
  ['review queue loop duplication', hostProbeFile, 'this.pendingEffects.push(effect)', 'for (let repeat=0;repeat<(values.has("repeat")?2:1);repeat++){this.pendingEffects.push(effect)}'],
  ['review conditional decode increment', hostProbeFile, 'nextNodeId += 1', 'if(depth<2){nextNodeId+=1}'],
  ['conditional decode reset', hostProbeFile, 'nextNodeId = 0\n', 'if (value instanceof VeraObjectValue) { nextNodeId = 0 }\n'],
  ['queue literal whitespace', hostProbeFile, "order.join(' ')", "order.join('  ')"],
  ['review untyped JS sensitive binding', 'entry/src/main/ets/runtime/P3Probe.js', '', 'export function drop(input) {const { pendingEffects: queue } = input; queue.length=0;}'],
  ['computed sensitive binding alias', 'entry/src/main/ets/runtime/P3Probe.js', '', 'export function drop(input) { const { ["pendingEffects"]: queue } = input; const later = queue; later.length = 0; }'],
  ['cast-only UiHost alias', 'entry/src/main/ets/runtime/P3Probe.ts', '', 'function drop(input: unknown) { const receiver = input as UiHost; const later = receiver; consume(later.unreviewed); }'],
  ['angle cast-only host alias', 'entry/src/main/ets/runtime/P3Probe.ts', '', 'function drop(input: unknown) { const receiver = <UiHostEnvironment>input; const later = receiver; consume(later.unreviewed); }'],
  ['sensitive destructuring assignment', 'entry/src/main/ets/runtime/P3Probe.js', '', 'export function drop(input) { let queue; ({ pendingEffects: queue } = input); const later = queue; later.length = 0; }'],
  ['host destructuring assignment', 'entry/src/main/ets/runtime/P3Probe.ts', '', 'function drop(input: UiHost) { let queue; ({ unreviewed: queue } = input); const later = queue; consume(later); }'],
  ['ID write', hostProbeFile, 'this.nextEffectId = id + 1', 'this.nextEffectId = id + 2'],
  ['ID reservation reorder', hostProbeFile, "this.nextEffectId = id + 1\n    let effect = new HostEffect(id, 'sdk', 'call', values, safety ? handler : asString(args[2]))", "let effect = new HostEffect(id, 'sdk', 'call', values, safety ? handler : asString(args[2]))\n    this.nextEffectId = id + 1"],
  ['nextNodeId extra increment', hostProbeFile, 'nextNodeId += 1', 'nextNodeId += 1; nextNodeId += 1'],
  ['erased Object.assign host escape', hostProbeFile, 'let id = this.nextEffectId', 'Object.assign({} as Object, this as Object); let id = this.nextEffectId'],
  ['typed differently named receiver', 'entry/src/main/ets/runtime/AppActor.ets', 'this.host!.pendingEffects = []', 'let receiver: UiHostEnvironment = this.host!; receiver.pendingEffects.push(null); this.host!.pendingEffects = []'],
  ['cast erased alias and dynamic access', 'entry/src/main/ets/runtime/AppActor.ets', 'this.host!.pendingEffects = []', 'let opaque = this.host as Object; let alias = opaque; alias[key] = []; this.host!.pendingEffects = []'],
  ['destructured queue alias', 'entry/src/main/ets/runtime/AppActor.ets', 'this.host!.pendingEffects = []', 'let { pendingEffects: queue } = this.host!; queue.push(null); this.host!.pendingEffects = []'],
  ['computed property unknown receiver', hostProbeFile, 'nextNodeId += 1', "opaque['pendingEffects'].push(null); nextNodeId += 1"],
  ['unknown host member escape', 'entry/src/main/ets/runtime/AppActor.ets', 'this.host!.pendingEffects = []', 'consume(this.host!.unreviewed); this.host!.pendingEffects = []'],
  ['internal unknown member', hostProbeFile, 'let id = this.nextEffectId', 'this.unreviewed = 1; let id = this.nextEffectId'],
  ['new file access', 'entry/src/main/ets/runtime/P3Probe.ets', '', "export function inspect(receiver: UiHostEnvironment): void { receiver.pendingEffects.push(null); }"],
  ['new file erased escape', 'entry/src/main/ets/runtime/P3Probe.ets', '', 'export function escape(receiver: UiHostEnvironment): Object { const hidden = receiver as Object; return Object.assign({}, hidden); }'],
  ['new import consumer', 'entry/src/main/ets/runtime/P3Probe.ets', '', "import * as declarations from '../vera/VeraUi';"],
  ['renamed import constructor', 'entry/src/main/ets/runtime/P3Probe.ets', '', "import { UiHostEnvironment as Renamed } from '../vera/VeraUi'; const receiver = new Renamed(); consume(receiver);"],
  ['UiHost internal alias escape', 'entry/src/main/ets/runtime/P3Probe.ets', '', 'class UiHost { run(): void { const erased = this as Object; consume(erased); } }'],
  ['receiver-independent safety begin alias', 'entry/src/main/ets/runtime/P3Probe.js', '', 'function hook(input) { const { beginSafetyTurn: begin } = input; const later = begin; consume(later); }'],
  ['receiver-independent safety pure alias', 'entry/src/main/ets/runtime/P3Probe.js', '', 'function hook(input) { let pure; ({ setSafetyPure: pure } = input); const later = pure; consume(later); }'],
  ['safety reserve bypass', hostProbeFile, 'this.safetyRecord.reserve()', 'if (false) { this.safetyRecord.reserve() }'],
  ['safety pure bypass', hostProbeFile, 'if (this.safetyPure) { throw', 'if (false && this.safetyPure) { throw'],
  ['safety rollback content bypass', hostProbeFile, 'record.queue.push(effect)', 'if (false) { record.queue.push(effect) }'],
  ['safety permission restore bypass', hostProbeFile, 'this.effectsAllowed = record.allowed', 'if (false) { this.effectsAllowed = record.allowed }'],
  ['safety settlement active bypass', hostProbeFile, 'if (this.invoking)', 'if (false && this.invoking)'],
  ['safety snapshot content bypass', hostProbeFile, 'this.entries = queue.slice()', 'this.entries = []'],
  ['safety invoke failure stickiness bypass', hostProbeFile, "} catch (e) {\n      if (this.safetyRecord !== null) { this.safetyRecord.failed = true }", "} catch (e) {\n      if (false && this.safetyRecord !== null) { this.safetyRecord.failed = true }"],
  ['safety overlap failure stickiness bypass', hostProbeFile, 'if (this.safetyRecord !== null || this.safetyPure)', 'if (false && (this.safetyRecord !== null || this.safetyPure))'],
  ['safety stale settlement stickiness bypass', hostProbeFile, 'if (this.safetyRecord !== record)', 'if (false && this.safetyRecord !== record)'],
  ['safety scope callback replacement', hostProbeFile, 'this.settle = settle', 'this.settle = (outcome: string): void => {}'],
  ['safety scope accept bypass', hostProbeFile, "this.settle('accept')", "if (false) { this.settle('accept') }"],
  ['safety scope rollback reroute', hostProbeFile, "this.settle('rollback')", "this.settle('accept')"],
  ['safety scope discard bypass', hostProbeFile, "this.settle('discard')", "if (false) { this.settle('discard') }"],
  ['safety scope construction bypass', hostProbeFile, 'this.settleSafety(record, outcome)', 'if (false) { this.settleSafety(record, outcome) }']
]
for (const [name, file, before, after] of hostNegativeProbes) {
  test('P3 static guard rejects ' + name + ' in memory', () => {
    const sources = hostSources()
    if (before) {
      assert(sources.get(file).includes(before), 'probe anchor missing: ' + name)
      sources.set(file, sources.get(file).replace(before, after))
    } else {
      assert(!sources.has(file))
      sources.set(file, after)
    }
    assert.throws(() => checkHostInventory(sources), { code: 'ERR_ASSERTION' }, name)
  })
}
test('P3 alias scan inventories erased and destructured uses beyond their seed declarations', () => {
  const file = 'entry/src/main/ets/runtime/P3Probe.ets'
  const inventory = hostInventory(new Map([[file, `function inspect(receiver: UiHostEnvironment): void {
    const opaque = receiver as Object;
    const second = opaque;
    Object.assign({}, second);
    second[key] = 1;
    const { pendingEffects: queue } = receiver;
    queue.push(null);
    consume(receiver.unreviewed);
  }`]]))
  assert.deepEqual(inventory[file + ':inspect'], [
    'receiver: UiHostEnvironment', 'opaque = receiver as Object', 'second = opaque',
    'Object.assign({}, second);', 'second[key] = 1;', '{ pendingEffects: queue } = receiver',
    'queue.push(null);', 'consume(receiver.unreviewed);'
  ])
})
for (const [name, text, uses] of [
  ['untyped sensitive binding', 'export function drop(input) {const { pendingEffects: queue } = input; const later = queue; later.length=0;}', ['later = queue', 'later.length = 0;']],
  ['cast-only UiHost', 'function drop(input: unknown) { const receiver = input as UiHost; const later = receiver; consume(later.unreviewed); }', ['later = receiver', 'consume(later.unreviewed);']],
  ['angle cast-only host', 'function drop(input: unknown) { const receiver = <UiHostEnvironment>input; const later = receiver; consume(later.unreviewed); }', ['later = receiver', 'consume(later.unreviewed);']],
  ['computed sensitive binding', 'function drop(input) { const { ["pendingEffects"]: queue } = input; const later = queue; later.length=0; }', ['later = queue', 'later.length = 0;']],
  ['shorthand sensitive assignment', 'function drop(input) { let pendingEffects; ({ pendingEffects } = input); const later = pendingEffects; later.length=0; }', ['later = pendingEffects', 'later.length = 0;']],
  ['sensitive assignment', 'function drop(input) { let queue; ({ pendingEffects: queue } = input); const later = queue; later.length=0; }', ['later = queue', 'later.length = 0;']],
  ['host assignment', 'function drop(input: UiHost) { let queue; ({ unreviewed: queue } = input); const later = queue; consume(later); }', ['later = queue', 'consume(later);']]
]) {
  test('P3 beyond-seed aliases remain inventoried for ' + name, () => {
    const file = 'entry/src/main/ets/runtime/P3Probe.ts'
    const sites = hostInventory(new Map([[file, text]]))[file + ':drop']
    for (const use of uses) assert(sites.includes(use), 'missing beyond-seed use: ' + use)
  })
}
test('P3 body pins reject review loop and conditional bypasses even with unchanged access sites', () => {
  for (const [before, after] of [
    ['this.pendingEffects.push(effect)', 'for (let repeat=0;repeat<(values.has("repeat")?2:1);repeat++){this.pendingEffects.push(effect)}'],
    ['nextNodeId += 1', 'if(depth<2){nextNodeId+=1}']
  ]) {
    const sources = hostSources()
    sources.set(hostProbeFile, sources.get(hostProbeFile).replace(before, after))
    assert.deepEqual(hostInventory(sources), hostBaseline)
    assert.throws(() => checkHostBodies(sources), /approved host mutation bodies\/control changed/)
  }
})
test('P3 token canonicalization preserves string, template and regex literal whitespace', () => {
  for (const [before, after] of [
    ["host.pendingEffects.push('a b');", "host.pendingEffects.push('a  b');"],
    ['host.pendingEffects.push(`a b`);', 'host.pendingEffects.push(`a  b`);'],
    ['host.pendingEffects.push(`a b${value}c d`);', 'host.pendingEffects.push(`a  b${value}c  d`);'],
    ['host.pendingEffects.push(/a b/);', 'host.pendingEffects.push(/a  b/);']
  ]) {
    const file = 'entry/src/main/ets/runtime/P3Probe.ts'
    assert.notDeepEqual(hostInventory(new Map([[file, before]])), hostInventory(new Map([[file, after]])))
  }
  assert.equal(hostCanonical("{\n  call('a  b');\n}"), "{ call('a  b'); }")
})
test('P3 static guard ignores whitespace without whole-source hashes', () => {
  const sources = hostSources()
  sources.set(hostProbeFile, sources.get(hostProbeFile).replace('this.nextEffectId = id + 1', 'this.nextEffectId\n = id + 1').replace('this.pendingEffects.push(effect)', 'this.pendingEffects.push( effect )').replace('if (depth > 8)', 'if ( depth\n > 8 )').replace('order.join(\' \')', 'order.join( \' \' )'))
  checkHostInventory(sources)
})
function legacyHostFixture() {
  const { UiHostEnvironment, decodeVeraUi } = vera('VeraUi')
  const values = vera('VeraInterpreter')
  const host = new UiHostEnvironment()
  const str = value => new values.VeraStringValue(value)
  const args = () => [str('  ' + sdkTarget + '  '), new values.VeraArrayValue([str('z'), str('first'), str('z'), str('last')]), str('answered')]
  return { host, args, str, values, decodeVeraUi, call: input => host.invoke('std/sdk', 'call', input || args(), false) }
}
test('P3 legacy queueSdk returns two immediate IDs with visible queued effects and no adapter dispatch', () => {
  const p = legacyHostFixture(), queue = p.host.pendingEffects
  assert.equal(p.host.effectsAllowed, false)
  assert.equal(p.host.nextEffectId, 1)
  p.host.effectsAllowed = true
  assert.equal(p.call().value, 1)
  assert.equal(p.host.pendingEffects, queue)
  assert.deepEqual(queue.map(effect => effect.id), [1])
  assert.equal(p.call().value, 2)
  assert.deepEqual(queue.map(effect => effect.id), [1, 2])
  assert.equal(p.host.nextEffectId, 3)
  assert.deepEqual([...queue[0].values], [['z', 'last']])
  assert.equal(queue[0].rawTarget, sdkTarget)
  assert.equal(queue[0].rawParams, 'z z')
  assert.equal(queue[0].rawMode, 'background')
  assert.equal(queue[0].resultHandler, 'answered')
  assert.deepEqual(calls, [])
})
test('P3 legacy compiled VM trap leaves queued IDs consumed and clearing the queue does not rewind them', () => {
  const p = legacyHostFixture()
  const program = compile(fixture() + `function fail(state: AppState, value: number): AppState { sdk.call("${sdkTarget}", [], "answered"); sdk.call("${sdkTarget}", [], "answered"); let empty: number[] = []; state.n = empty[0]; return state; }`)
  const vm = new p.values.VirtualMachine(p.values.deserializeVbc2(program.vbc2), p.host)
  const state = vm.execute('init')
  p.host.effectsAllowed = true
  assert.throws(() => vm.execute('fail', [state, new p.values.VeraNumberValue(0)]), error => error instanceof p.values.RuntimeTrap)
  assert.deepEqual(p.host.pendingEffects.map(effect => effect.id), [1, 2])
  assert.equal(p.host.nextEffectId, 3)
  assert.equal(p.host.effectsAllowed, true)
  p.host.pendingEffects = []
  assert.equal(p.call().value, 3)
  assert.deepEqual(calls, [])
})
for (const invalid of ['permission', 'target', 'array', 'odd pairs', 'key', 'value', 'mode', 'late handler']) {
  test('P3 legacy invalid SDK ' + invalid + ' preserves existing behavior', () => {
    const p = legacyHostFixture()
    p.host.effectsAllowed = true
    p.call()
    const queue = p.host.pendingEffects, first = queue[0], args = p.args(), number = new p.values.VeraNumberValue(7)
    let code = 'R0020'
    if (invalid === 'permission') { p.host.effectsAllowed = false; code = 'R0026' }
    if (invalid === 'target') args[0] = number
    if (invalid === 'array') args[1] = number
    if (invalid === 'odd pairs') { args[1] = new p.values.VeraArrayValue([p.str('key')]); code = 'R0027' }
    if (invalid === 'key') args[1].elements[0] = number
    if (invalid === 'value') args[1].elements[1] = number
    if (invalid === 'mode') args[3] = number
    if (invalid === 'late handler') args[2] = number
    const allowed = p.host.effectsAllowed
    assert.throws(() => p.call(args), error => error.trapCode === code)
    assert.equal(p.host.pendingEffects, queue)
    assert.deepEqual(queue, [first])
    assert.equal(p.host.effectsAllowed, allowed)
    assert.equal(p.host.nextEffectId, invalid === 'late handler' ? 3 : 2)
    p.host.effectsAllowed = true
    assert.equal(p.call().value, invalid === 'late handler' ? 3 : 2)
    assert.deepEqual(calls, [])
  })
}
test('P3 legacy UI registry declarations are values and decode IDs reset independently of SDK IDs', () => {
  const p = legacyHostFixture(), n = value => new p.values.VeraNumberValue(value)
  const declaration = (name, args) => p.host.invoke('std/ui', name, args, false)
  const nodes = [declaration('Surface', [p.str('default'), n(100), n(200), p.str('draw'), p.str('frame'), p.str('pointer')]),
    declaration('World', [p.str('default'), n(100), p.str('build'), p.str('event')]),
    declaration('Ticker', [p.str('default'), p.str('tick'), n(1000), new p.values.VeraBooleanValue(true), p.str('tickHandler')]),
    declaration('BackHandler', [p.str('back')])]
  const tree = declaration('Column', [p.str('default'), new p.values.VeraArrayValue(nodes)])
  for (let i = 0; i < 2; i++) {
    const decoded = p.decodeVeraUi(tree)
    assert.equal(decoded[0].id, 0)
    assert.deepEqual(decoded[0].children.map(node => node.id), [1, 2, 3, 4])
    assert.deepEqual(decoded[0].children.map(node => node.kind), ['surface', 'world', 'ticker', 'backhandler'])
  }
  assert.deepEqual(Object.keys(p.host).sort(), ['effectsAllowed', 'invoking', 'nextEffectId', 'pendingEffects', 'safetyInvalid', 'safetyPure', 'safetyRecord'])
  assert.equal(p.host.nextEffectId, 1)
  assert.deepEqual(p.host.pendingEffects, [])
  assert.deepEqual(calls, [])
})

for (const allowed of [false, true]) {
  for (const outcome of ['accept', 'rollback', 'discard']) {
    test('Step5 opt-in host ' + outcome + ' restores actual entry permission ' + allowed, () => {
      const p = legacyHostFixture()
      p.host.effectsAllowed = true
      p.call()
      const queue = p.host.pendingEffects, first = queue[0]
      p.host.effectsAllowed = allowed
      let reserved = 0
      const scope = p.host.beginSafetyTurn(() => {
        assert.equal(p.host.nextEffectId, 2 + reserved)
        assert.equal(queue.length, 1 + reserved)
        reserved++
      })
      p.host.effectsAllowed = true
      assert.equal(p.call().value, 2)
      assert.equal(p.call().value, 3)
      assert.equal(reserved, 2)
      const queued = queue.slice(), record = p.host.safetyRecord
      p.host.effectsAllowed = !allowed
      scope[outcome]()
      assert.equal(p.host.effectsAllowed, allowed)
      assert.equal(p.host.pendingEffects, queue)
      assert.equal(p.host.safetyRecord, null)
      assert.equal(p.host.safetyPure, false)
      assert.deepEqual(record.queue, [])
      assert.deepEqual(record.entries, [])
      assert.deepEqual(queue, outcome === 'rollback' ? [first] : outcome === 'accept' ? queued : [])
      assert.deepEqual(queue.map(effect => effect.id), outcome === 'accept' ? [1, 2, 3] : outcome === 'rollback' ? [1] : [])
      assert.equal(p.host.nextEffectId, outcome === 'rollback' ? 2 : 4)
      for (const again of ['accept', 'rollback', 'discard']) {
        assert.throws(() => scope[again](), error => error instanceof p.values.RuntimeTrap)
      }
      if (outcome === 'discard') {
        for (const invoke of [() => p.call(), () => p.host.invoke('std/ui', 'Text', [p.str('body'), p.str('text')], false),
          () => p.host.beginSafetyTurn(() => {}), () => p.host.setSafetyPure(false)]) {
          assert.throws(invoke, error => error instanceof p.values.RuntimeTrap)
        }
      } else {
        p.host.effectsAllowed = true
        const next = p.host.beginSafetyTurn(() => {})
        assert.equal(p.call().value, outcome === 'rollback' ? 2 : 4)
        assert.throws(() => scope.accept(), error => error instanceof p.values.RuntimeTrap)
        next.rollback()
      }
      assert.deepEqual(calls, [])
      assert.deepEqual(traces, [])
      assert.equal(timers.size, 0)
    })
  }
}
test('Step5 host rollback restores original array identity and entry content after owner replacement', () => {
  const p = legacyHostFixture()
  p.host.effectsAllowed = true
  p.call()
  p.call()
  const queue = p.host.pendingEffects, entries = queue.slice(), nextId = p.host.nextEffectId
  const scope = p.host.beginSafetyTurn(() => {})
  p.call()
  queue.reverse()
  queue.shift()
  const replacement = []
  p.host.pendingEffects = replacement
  p.call()
  scope.rollback()
  assert.equal(p.host.pendingEffects, queue)
  assert.deepEqual(queue, entries)
  assert.equal(queue[0], entries[0])
  assert.equal(queue[1], entries[1])
  assert.equal(p.host.nextEffectId, nextId)
  assert.equal(p.host.effectsAllowed, true)
})
test('Step5 host discard clears both captured and replaced queues and cannot be revived', () => {
  const p = legacyHostFixture()
  const queue = p.host.pendingEffects
  const scope = p.host.beginSafetyTurn(() => {})
  p.host.effectsAllowed = true
  p.call()
  const replacement = []
  p.host.pendingEffects = replacement
  p.call()
  scope.discard()
  assert.deepEqual(queue, [])
  assert.deepEqual(replacement, [])
  p.host.pendingEffects = []
  p.host.effectsAllowed = true
  assert.throws(() => p.call(), error => error instanceof p.values.RuntimeTrap)
})
for (const allowed of [false, true]) {
  for (const scoped of [false, true]) {
    test('Step5 pure SDK barrier precedes ID/queue mutation with permission=' + allowed + ', scope=' + scoped, () => {
      const p = legacyHostFixture(), queue = p.host.pendingEffects
      p.host.effectsAllowed = allowed
      let reserved = 0
      const scope = scoped ? p.host.beginSafetyTurn(() => { reserved++ }) : null
      p.host.setSafetyPure(true)
      try {
        assert.throws(() => p.call(), error => error.trapCode === 'R-PURE')
        assert.equal(p.host.nextEffectId, 1)
        assert.equal(p.host.pendingEffects, queue)
        assert.deepEqual(queue, [])
        assert.equal(p.host.effectsAllowed, allowed)
        assert.equal(reserved, 0)
        if (scoped) {
          assert.throws(() => p.host.invoke('std/ui', 'Text', [p.str('body'), p.str('pure')], false), error => error.trapCode === 'R-TURN')
          assert.throws(() => scope.accept(), error => error.trapCode === 'R-TURN')
        } else {
          assert.equal(p.host.invoke('std/ui', 'Text', [p.str('body'), p.str('pure')], false).fields.get('text').value, 'pure')
        }
      } finally {
        p.host.setSafetyPure(false)
      }
      if (scope) scope.rollback()
      p.host.effectsAllowed = true
      assert.equal(p.call().value, 1)
      assert.deepEqual(calls, [])
    })
  }
}
for (const pure of [false, true]) {
  for (const invalid of ['target', 'array', 'odd pairs', 'key', 'value', 'blank key value', 'mode', 'handler']) {
    test('Step5 safety validates SDK ' + invalid + ' before reserve/pure barrier with pure=' + pure, () => {
      const p = legacyHostFixture(), queue = p.host.pendingEffects, args = p.args()
      const number = new p.values.VeraNumberValue(7)
      let reserved = 0, code = 'R0020'
      const scope = p.host.beginSafetyTurn(() => { reserved++ })
      p.host.effectsAllowed = !pure
      p.host.setSafetyPure(pure)
      if (invalid === 'target') args[0] = number
      if (invalid === 'array') args[1] = number
      if (invalid === 'odd pairs') { args[1] = new p.values.VeraArrayValue([p.str('key')]); code = 'R0027' }
      if (invalid === 'key') args[1].elements[0] = number
      if (invalid === 'value') args[1].elements[1] = number
      if (invalid === 'blank key value') { args[1].elements[0] = p.str(' '); args[1].elements[1] = number }
      if (invalid === 'mode') args[3] = number
      if (invalid === 'handler') args[2] = number
      try {
        assert.throws(() => p.call(args), error => error.trapCode === code)
        assert.equal(reserved, 0)
        assert.equal(p.host.nextEffectId, 1)
        assert.equal(p.host.pendingEffects, queue)
        assert.deepEqual(queue, [])
        assert.equal(p.host.safetyRecord.failed, true)
        assert.throws(() => scope.accept(), error => error.trapCode === 'R-TURN')
        assert.throws(() => p.call(), error => error.trapCode === 'R-TURN')
      } finally {
        p.host.setSafetyPure(false)
        scope.rollback()
      }
    })
  }
}
test('Step5 safety disallowed SDK reserves nothing and validation remains first', () => {
  const p = legacyHostFixture()
  let reserved = 0
  const scope = p.host.beginSafetyTurn(() => { reserved++ })
  assert.throws(() => p.call(), error => error.trapCode === 'R0026')
  assert.throws(() => scope.accept(), error => error.trapCode === 'R-TURN')
  scope.rollback()
  const next = p.host.beginSafetyTurn(() => { reserved++ })
  const args = p.args()
  args[2] = new p.values.VeraNumberValue(1)
  assert.throws(() => p.call(args), error => error.trapCode === 'R0020')
  assert.equal(reserved, 0)
  assert.equal(p.host.nextEffectId, 1)
  assert.throws(() => next.accept(), error => error.trapCode === 'R-TURN')
  next.rollback()
})
test('Step5 failed reservation cannot allocate an ID or append an effect', () => {
  const p = legacyHostFixture(), refusal = new Error('full journal')
  p.host.effectsAllowed = true
  p.call()
  const queue = p.host.pendingEffects, entries = queue.slice()
  let reserved = 0
  const scope = p.host.beginSafetyTurn(() => { reserved++; throw refusal })
  assert.throws(() => p.call(), error => error === refusal)
  assert.equal(reserved, 1)
  assert.equal(p.host.nextEffectId, 2)
  assert.equal(p.host.pendingEffects, queue)
  assert.deepEqual(queue, entries)
  assert.equal(p.host.invoking, false)
  assert.throws(() => scope.accept(), error => error.trapCode === 'R-TURN')
  assert.throws(() => p.call(), error => error.trapCode === 'R-TURN')
  assert.equal(reserved, 1)
  scope.rollback()
})
for (const hook of ['invoke', 'begin', 'pure', 'accept', 'rollback', 'discard']) {
  test('Step5 reentrant host ' + hook + ' fails closed even when reservation swallows rejection', () => {
    const p = legacyHostFixture(), queue = p.host.pendingEffects
    p.host.effectsAllowed = true
    let scope, attempts = 0
    scope = p.host.beginSafetyTurn(() => {
      attempts++
      const nested = hook === 'invoke' ? () => p.host.invoke('std/ui', 'Text', [p.str('body'), p.str('nested')], false)
        : hook === 'begin' ? () => p.host.beginSafetyTurn(() => {})
        : hook === 'pure' ? () => p.host.setSafetyPure(true) : () => scope[hook]()
      assert.throws(nested, error => error instanceof p.values.RuntimeTrap)
    })
    assert.throws(() => p.call(), error => error instanceof p.values.RuntimeTrap)
    assert.equal(attempts, 1)
    assert.equal(p.host.nextEffectId, 1)
    assert.equal(p.host.pendingEffects, queue)
    assert.deepEqual(queue, [])
    assert.equal(p.host.invoking, false)
    assert.throws(() => scope.accept(), error => error instanceof p.values.RuntimeTrap)
    assert.throws(() => p.call(), error => error instanceof p.values.RuntimeTrap)
    scope.rollback()
    assert.equal(p.call().value, 1)
  })
}
test('Step5 scope cannot overlap or settle an unrelated live scope', () => {
  const p = legacyHostFixture()
  const first = p.host.beginSafetyTurn(() => {})
  assert.throws(() => p.host.beginSafetyTurn(() => {}), error => error instanceof p.values.RuntimeTrap)
  assert.throws(() => first.accept(), error => error.trapCode === 'R-TURN')
  first.rollback()
  const second = p.host.beginSafetyTurn(() => {})
  assert.throws(() => first.discard(), error => error instanceof p.values.RuntimeTrap)
  assert.throws(() => second.accept(), error => error.trapCode === 'R-TURN')
  second.rollback()
})

function safetyVmFixture(limit = 32) {
  const p = legacyHostFixture()
  const program = compile(fixture() + `
function queued(state: AppState): AppState {
  sdk.call("${sdkTarget}", [], "answered");
  sdk.call("${sdkTarget}", [], "answered");
  return state;
}
function mutateQueued(state: AppState): AppState {
  state.n = state.n + 1;
  sdk.call("${sdkTarget}", [], "answered");
  return state;
}
function queuedTrap(state: AppState): AppState {
  sdk.call("${sdkTarget}", [], "answered");
  state.n = state.n + 1;
  let empty: number[] = [];
  state.n = empty[0];
  return state;
}
function draw(state: AppState): gfx.Shape[] { return []; }
function frame(state: AppState, elapsedMs: number): AppState { return state; }
function pointer(state: AppState, p: gfx.Pointer): AppState { return state; }
function build(state: AppState): scene.Thing[] { return []; }
function event(state: AppState, e: scene.Event): AppState { return state; }
function tickHandler(state: AppState, value: number): AppState { return state; }
function back(state: AppState, value: number): AppState { return state; }
function declared(state: AppState): ui.View {
  return ui.Column("default", [ui.Surface("default", 100, 200, "draw", "frame", "pointer"),
    ui.World("default", 100, "build", "event"), ui.Ticker("default", "tick", 1000, true, "tickHandler"), ui.BackHandler("back")]);
}`)
  const module = p.values.deserializeVbc2(program.vbc2)
  const state = new p.values.VirtualMachine(module, p.host).execute('init')
  const external = new p.values.Instruction('load-external')
  external.module = 'std/sdk'
  external.name = 'call'
  const instructions = [external]
  for (let slot = 0; slot < 4; slot++) {
    const local = new p.values.Instruction('load-local')
    local.slot = slot
    instructions.push(local)
  }
  const call = new p.values.Instruction('call')
  call.count = 4
  instructions.push(call, new p.values.Instruction('return'))
  module.functions.push(new p.values.BytecodeFunction('rawSdk', 4, 4, false, instructions))
  const vm = new p.values.VirtualMachine(module, p.host, 100000, { now: () => now, deadlineMs: 1000 }, { journalMaxEntries: limit })
  return { ...p, vm, state }
}
for (const limit of [0, 1, 2]) {
  test('Step5 real VM shares journal capacity with one reservation per effect, limit=' + limit, () => {
    const p = safetyVmFixture(limit), queue = p.host.pendingEffects
    const scope = p.vm.beginTurn({}, p.state)
    p.host.effectsAllowed = true
    if (limit < 2) {
      assert.throws(() => p.vm.execute('queued', [p.state]), error => error.trapCode === 'R-JOURNAL')
      assert.throws(() => scope.accept(), error => error instanceof p.values.RuntimeTrap)
    } else {
      assert.equal(p.vm.execute('queued', [p.state]), p.state)
    }
    assert.deepEqual(queue.map(effect => effect.id), Array.from({ length: limit }, (_, i) => i + 1))
    assert.equal(p.host.nextEffectId, limit + 1)
    scope.rollback()
    assert.equal(p.host.pendingEffects, queue)
    assert.deepEqual(queue, [])
    assert.equal(p.host.nextEffectId, 1)
    assert.equal(p.host.effectsAllowed, false)
    assert.deepEqual(calls, [])
  })
}
test('Step5 real VM effect reservation and graph writes consume the same journal capacity', () => {
  const p = safetyVmFixture(1)
  const scope = p.vm.beginTurn({}, p.state)
  p.host.effectsAllowed = true
  assert.throws(() => p.vm.execute('mutateQueued', [p.state]), error => error.trapCode === 'R-JOURNAL')
  assert.equal(p.state.fields.get('n').value, 2)
  assert.deepEqual(p.host.pendingEffects, [])
  assert.equal(p.host.nextEffectId, 1)
  scope.rollback()
  assert.equal(p.state.fields.get('n').value, 1)
  assert.equal(p.host.effectsAllowed, false)
})
for (const allowed of [false, true]) {
  test('Step5 real VM pure SDK fails R-PURE before reservation with entry permission=' + allowed, () => {
    const p = safetyVmFixture(0), queue = p.host.pendingEffects
    p.host.effectsAllowed = allowed
    const scope = p.vm.beginTurn({}, p.state)
    assert.throws(() => p.vm.executePure('queued', [p.state]), error => error.trapCode === 'R-PURE')
    assert.equal(p.host.safetyPure, false)
    assert.equal(p.host.effectsAllowed, allowed)
    assert.equal(p.host.nextEffectId, 1)
    assert.equal(p.host.pendingEffects, queue)
    assert.deepEqual(queue, [])
    assert.throws(() => scope.accept(), error => error instanceof p.values.RuntimeTrap)
    scope.rollback()
    const next = p.vm.beginTurn({}, p.state)
    assert.equal(p.vm.executePure('view', [p.state]).fields.get('text').value, 'initial')
    next.accept()
  })
}
test('Step5 real VM acceptance retains whole-turn effects without dispatch or callbacks', () => {
  const p = safetyVmFixture(3), queue = p.host.pendingEffects
  p.host.effectsAllowed = true
  p.call()
  p.host.effectsAllowed = false
  const scope = p.vm.beginTurn({}, p.state)
  p.host.effectsAllowed = true
  p.vm.execute('queued', [p.state])
  p.vm.execute('sdkFire', [p.state, new p.values.VeraNumberValue(0)])
  const effects = queue.slice()
  p.vm.executePure('view', [p.state])
  scope.accept()
  assert.equal(p.host.pendingEffects, queue)
  assert.deepEqual(queue, effects)
  assert.deepEqual(queue.map(effect => effect.id), [1, 2, 3, 4])
  assert.equal(p.host.nextEffectId, 5)
  assert.equal(p.host.effectsAllowed, false)
  assert.deepEqual(calls, [])
  assert.deepEqual(traces, [])
  assert.equal(timers.size, 0)
})
test('Step5 real VM trap rollback restores graph and host queue baseline together', () => {
  const p = safetyVmFixture(), queue = p.host.pendingEffects
  p.host.effectsAllowed = true
  p.call()
  const first = queue[0]
  const scope = p.vm.beginTurn({}, p.state)
  p.vm.execute('queued', [p.state])
  assert.throws(() => p.vm.execute('queuedTrap', [p.state]), error => error instanceof p.values.RuntimeTrap)
  assert.equal(p.state.fields.get('n').value, 2)
  assert.deepEqual(queue.map(effect => effect.id), [1, 2, 3, 4])
  scope.rollback()
  assert.equal(p.state.fields.get('n').value, 1)
  assert.equal(p.host.pendingEffects, queue)
  assert.deepEqual(queue, [first])
  assert.equal(p.host.nextEffectId, 2)
  assert.equal(p.host.effectsAllowed, true)
})
test('Step5 real VM discard invalidates VM and host and removes unaccepted requests', () => {
  const p = safetyVmFixture()
  const scope = p.vm.beginTurn({}, p.state)
  p.host.effectsAllowed = true
  p.vm.execute('queued', [p.state])
  scope.discard()
  assert.deepEqual(p.host.pendingEffects, [])
  assert.equal(p.host.effectsAllowed, false)
  assert.throws(() => p.vm.execute('view', [p.state]), error => error instanceof p.values.RuntimeTrap)
  assert.throws(() => p.call(), error => error instanceof p.values.RuntimeTrap)
  assert.throws(() => p.vm.beginTurn({}, p.state), error => error instanceof p.values.RuntimeTrap)
})
test('Step5 real VM pure UI registry declarations remain decode-only data', () => {
  const p = safetyVmFixture(0)
  const scope = p.vm.beginTurn({}, p.state)
  const tree = p.vm.executePure('declared', [p.state])
  assert.deepEqual(p.decodeVeraUi(tree)[0].children.map(node => node.kind), ['surface', 'world', 'ticker', 'backhandler'])
  assert.deepEqual(p.host.pendingEffects, [])
  assert.equal(p.host.nextEffectId, 1)
  scope.accept()
  assert.deepEqual(calls, [])
})

for (const allowed of [false, true]) {
  for (const outcome of ['accept', 'rollback', 'discard']) {
    test('Step5 real VM ' + outcome + ' preserves nonempty baseline and entry permission=' + allowed, () => {
      const p = safetyVmFixture(), queue = p.host.pendingEffects
      p.host.effectsAllowed = true
      p.call()
      p.call()
      const baseline = queue.slice()
      p.host.effectsAllowed = allowed
      const scope = p.vm.beginTurn({}, p.state)
      p.host.effectsAllowed = true
      p.vm.execute('mutateQueued', [p.state])
      p.vm.execute('queued', [p.state])
      p.vm.executePure('view', [p.state])
      assert.equal(p.host.safetyPure, false)
      let replacement
      if (outcome !== 'accept') {
        queue.reverse()
        queue.shift()
        replacement = []
        p.host.pendingEffects = replacement
        p.vm.execute('queued', [p.state])
      }
      const accepted = queue.slice(), record = p.host.safetyRecord
      p.host.effectsAllowed = !allowed
      scope[outcome]()
      assert.equal(p.host.pendingEffects, queue)
      assert.equal(p.host.effectsAllowed, allowed)
      assert.equal(p.host.safetyPure, false)
      assert.equal(p.host.safetyRecord, null)
      assert.deepEqual(record.queue, [])
      assert.deepEqual(record.entries, [])
      assert.deepEqual(queue, outcome === 'accept' ? accepted : outcome === 'rollback' ? baseline : [])
      assert.equal(p.host.nextEffectId, outcome === 'accept' ? 6 : outcome === 'rollback' ? 3 : 8)
      assert.equal(p.state.fields.get('n').value, outcome === 'rollback' ? 1 : 2)
      if (outcome === 'discard') {
        assert.deepEqual(replacement, [])
        assert.throws(() => p.vm.beginTurn({}, p.state), error => error instanceof p.values.RuntimeTrap)
        assert.throws(() => p.host.setSafetyPure(false), error => error.trapCode === 'R-TURN')
        assert.throws(() => p.call(), error => error.trapCode === 'R-TURN')
      } else {
        const next = p.vm.beginTurn({}, p.state)
        p.host.effectsAllowed = true
        p.vm.execute('sdkFire', [p.state, new p.values.VeraNumberValue(0)])
        assert.equal(queue[queue.length - 1].id, outcome === 'accept' ? 6 : 3)
        next.rollback()
        assert.equal(p.host.effectsAllowed, allowed)
      }
      for (const again of ['accept', 'rollback', 'discard']) {
        assert.throws(() => scope[again](), error => error instanceof p.values.RuntimeTrap)
      }
      assert.deepEqual(calls, [])
      assert.deepEqual(traces, [])
      assert.equal(timers.size, 0)
    })
  }
}
for (const pure of [false, true]) {
  for (const invalid of ['mode', 'handler', 'blank key value']) {
    test('Step5 real VM validates late SDK ' + invalid + ' before journal/pure barrier, pure=' + pure, () => {
      const p = safetyVmFixture(0), queue = p.host.pendingEffects
      p.host.effectsAllowed = true
      p.call()
      const baseline = queue.slice(), args = p.args(), number = new p.values.VeraNumberValue(7)
      args.push(p.str('background'))
      if (invalid === 'mode') args[3] = number
      if (invalid === 'handler') args[2] = number
      if (invalid === 'blank key value') args[1] = new p.values.VeraArrayValue([p.str(' '), number])
      p.host.effectsAllowed = false
      const scope = p.vm.beginTurn({}, p.state)
      p.host.effectsAllowed = !pure
      assert.throws(() => pure ? p.vm.executePure('rawSdk', args) : p.vm.execute('rawSdk', args), error => error.trapCode === 'R0020')
      assert.equal(p.host.safetyPure, false)
      assert.equal(p.host.safetyRecord.failed, true)
      assert.equal(p.host.pendingEffects, queue)
      assert.deepEqual(queue, baseline)
      assert.equal(p.host.nextEffectId, 2)
      assert.throws(() => scope.accept(), error => error instanceof p.values.RuntimeTrap)
      assert.throws(() => p.vm.executePure('view', [p.state]), error => error instanceof p.values.RuntimeTrap)
      assert.throws(() => p.call(), error => error.trapCode === 'R-TURN')
      scope.rollback()
      assert.equal(p.host.effectsAllowed, false)
      const next = p.vm.beginTurn({}, p.state)
      assert.equal(p.vm.executePure('view', [p.state]).fields.get('text').value, 'initial')
      next.accept()
      assert.deepEqual(queue, baseline)
      assert.deepEqual(calls, [])
    })
  }
}
for (const failure of ['capacity', 'permission', 'pure', 'validation']) {
  for (const outcome of ['rollback', 'discard']) {
    test('Step5 real VM sticky ' + failure + ' failure allows only ' + outcome + ' settlement', () => {
      const p = safetyVmFixture(failure === 'capacity' ? 1 : 32), queue = p.host.pendingEffects
      p.host.effectsAllowed = true
      p.call()
      const baseline = queue.slice(), args = p.args()
      args.push(p.str('background'))
      if (failure === 'validation') args[2] = new p.values.VeraNumberValue(7)
      p.host.effectsAllowed = false
      const scope = p.vm.beginTurn({}, p.state)
      p.host.effectsAllowed = failure !== 'permission'
      const code = { capacity: 'R-JOURNAL', permission: 'R0026', pure: 'R-PURE', validation: 'R0020' }[failure]
      assert.throws(() => failure === 'pure' ? p.vm.executePure('rawSdk', args)
        : p.vm.execute(failure === 'capacity' ? 'queued' : 'rawSdk', failure === 'capacity' ? [p.state] : args), error => error.trapCode === code)
      assert.equal(p.host.safetyRecord.failed, true)
      assert.equal(p.host.safetyPure, false)
      const afterFailure = queue.slice(), nextId = p.host.nextEffectId
      p.host.effectsAllowed = true
      assert.throws(() => p.call(), error => error.trapCode === 'R-TURN')
      assert.throws(() => p.vm.execute('queued', [p.state]), error => error instanceof p.values.RuntimeTrap)
      assert.throws(() => scope.accept(), error => error instanceof p.values.RuntimeTrap)
      assert.deepEqual(queue, afterFailure)
      assert.equal(p.host.nextEffectId, nextId)
      scope[outcome]()
      assert.equal(p.host.pendingEffects, queue)
      assert.equal(p.host.effectsAllowed, false)
      assert.deepEqual(queue, outcome === 'rollback' ? baseline : [])
      if (outcome === 'rollback') {
        assert.equal(p.host.nextEffectId, 2)
        const next = p.vm.beginTurn({}, p.state)
        p.host.effectsAllowed = true
        p.vm.execute('rawSdk', p.args().concat(p.str('background')))
        assert.equal(queue[1].id, 2)
        next.accept()
      } else {
        assert.throws(() => p.call(), error => error.trapCode === 'R-TURN')
      }
      assert.deepEqual(calls, [])
    })
  }
}
for (const hook of ['executePure', 'beginTurn', 'pure hook', 'accept', 'rollback', 'discard']) {
  test('Step5 real VM swallowed reentrant ' + hook + ' cannot queue an effect or accept', () => {
    const p = safetyVmFixture(), queue = p.host.pendingEffects
    const begin = p.host.beginSafetyTurn.bind(p.host)
    let scope, attempts = 0
    p.host.beginSafetyTurn = reserve => begin(() => {
      attempts++
      const nested = hook === 'executePure' ? () => p.vm.executePure('view', [p.state])
        : hook === 'beginTurn' ? () => p.vm.beginTurn({}, p.state)
        : hook === 'pure hook' ? () => p.host.setSafetyPure(true) : () => scope[hook]()
      assert.throws(nested, error => error instanceof p.values.RuntimeTrap)
      reserve()
    })
    scope = p.vm.beginTurn({}, p.state)
    p.host.effectsAllowed = true
    assert.throws(() => p.vm.execute('queued', [p.state]), error => error instanceof p.values.RuntimeTrap)
    assert.equal(attempts, 1)
    assert.equal(p.host.pendingEffects, queue)
    assert.deepEqual(queue, [])
    assert.equal(p.host.nextEffectId, 1)
    assert.equal(p.host.invoking, false)
    assert.throws(() => scope.accept(), error => error instanceof p.values.RuntimeTrap)
    scope.rollback()
    assert.equal(p.host.effectsAllowed, false)
    p.host.beginSafetyTurn = begin
    const next = p.vm.beginTurn({}, p.state)
    p.host.effectsAllowed = true
    p.vm.execute('queued', [p.state])
    assert.deepEqual(queue.map(effect => effect.id), [1, 2])
    next.rollback()
    assert.deepEqual(calls, [])
  })
}
test('Step5 real VM later pure failure preserves an already accepted handler and its queued effects', () => {
  const p = safetyVmFixture(), queue = p.host.pendingEffects
  const handler = p.vm.beginTurn({}, p.state)
  p.host.effectsAllowed = true
  p.vm.execute('mutateQueued', [p.state])
  handler.accept()
  const accepted = queue.slice(), frame = p.vm.beginTurn({}, p.state)
  assert.throws(() => p.vm.executePure('queued', [p.state]), error => error.trapCode === 'R-PURE')
  frame.rollback()
  assert.equal(p.state.fields.get('n').value, 2)
  assert.equal(p.host.pendingEffects, queue)
  assert.deepEqual(queue, accepted)
  assert.equal(p.host.nextEffectId, 2)
  assert.equal(p.host.effectsAllowed, false)
  const next = p.vm.beginTurn({}, p.state)
  assert.equal(p.vm.executePure('view', [p.state]).fields.get('text').value, 'initial')
  next.accept()
  assert.deepEqual(calls, [])
})
test('Step5 legacy blank-key values remain skipped and a failed call does not poison the host', () => {
  const p = legacyHostFixture(), args = p.args()
  p.host.effectsAllowed = true
  args[1] = new p.values.VeraArrayValue([p.str(' '), new p.values.VeraNumberValue(7)])
  assert.equal(p.call(args).value, 1)
  assert.deepEqual([...p.host.pendingEffects[0].values], [])
  args[2] = new p.values.VeraNumberValue(7)
  assert.throws(() => p.call(args), error => error.trapCode === 'R0020')
  assert.equal(p.call().value, 3)
  assert.equal(p.host.safetyRecord, null)
})

const originals = {
  now: Date.now, random: Math.random, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout,
  setInterval: global.setInterval, clearInterval: global.clearInterval,
  console: Object.fromEntries(['info', 'warn', 'error'].map(level => [level, console[level]]))
}
const onUnhandled = error => unhandled.push(error)
async function main() {
  let passed = 0
  process.on('unhandledRejection', onUnhandled)
  try {
    Date.now = () => now
    Math.random = () => 0.125
    global.setTimeout = (callback, delay = 0, ...args) => {
      assert.equal(typeof callback, 'function')
      const id = ++nextTimer
      timers.set(id, { callback, at: now + Math.max(0, Number(delay)), args })
      return id
    }
    global.clearTimeout = id => timers.delete(id)
    global.setInterval = () => { throw Error('unexpected interval') }
    global.clearInterval = () => { throw Error('unexpected interval cleanup') }
    for (const level of ['info', 'warn', 'error']) console[level] = () => {}
    for (const { name, run } of tests) {
      now = 100000
      timers.clear()
      disk.clear()
      calls.length = 0
      grants.clear()
      consentChecks.length = 0
      remembered.length = 0
      callbackErrors.length = 0
      unhandled.length = 0
      traces.length = 0
      StageTrace.configure(true, record => traces.push(record))
      hosts.length = 0
      bridges.length = 0
      platform = () => Promise.resolve('ok')
      try {
        await run()
        await new Promise(resolve => setImmediate(resolve))
        assert.deepEqual(callbackErrors, [], 'subscriber fixture callback failed')
        assert.deepEqual(unhandled, [], 'unhandled asynchronous callback failure')
        passed++
        console.log('PASS ' + name)
      } catch (error) {
        originals.console.error('FAIL ' + name + '\n' + error.stack)
        process.exitCode = 1
      } finally {
        for (const bridge of bridges) bridge.invalidate()
        for (const host of hosts) await finish(host.dispose())
        timers.clear()
      }
    }
  } finally {
    StageTrace.configure(false)
    Date.now = originals.now
    Math.random = originals.random
    global.setTimeout = originals.setTimeout
    global.clearTimeout = originals.clearTimeout
    global.setInterval = originals.setInterval
    global.clearInterval = originals.clearInterval
    Object.assign(console, originals.console)
    process.removeListener('unhandledRejection', onUnhandled)
  }
  console.log(`host-effects-check: ${passed}/${tests.length} deterministic actual-source scenarios passed`)
  console.log('Scope: real InProcessHost/AppActor/compiler/VM/ProjectStore/EffectController/HostEffectsBridge/executeEffect; module-mocked adapters and consent, in-memory files and fake clock/timers; no platform, device, model or services.')
}
main().catch(error => {
  originals.console.error(error.stack)
  process.exitCode = 1
})
