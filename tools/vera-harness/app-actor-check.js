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
let cryptoFailure = null
let cryptoFailureStage = 'create'
let now = 100000
const worker = require('./state-io-check').createWorkerFixture('/actor-fixture/vera', event => {
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
      const file = '/actor-fixture/vera/' + appId + '.state.json'
      const decoded = format2.validateStateFile(disk.get(file), appId, 1)
      assert.equal(decoded.format, 'FORMAT2')
      assert.equal(decoded.revision, reply.result.revision)
      if (request.commit) {
        assert.equal(decoded.vmGeneration, request.commit.pre.vmGeneration)
        assert.equal(decoded.revision, request.commit.pre.baseRevision + 1)
      } else assert.equal(decoded.vmGeneration, request.publication.nextVmGeneration)
      records.push({ type: request.kind === 'commit' ? 'save' : 'publication', file, payload: JSON.parse(disk.get(file)), result: reply.result })
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
  const source = fs.readFileSync(file, 'utf8').replace(/^@Concurrent\s*$/gm, '')
  const compiled = ts.transpileModule(source, {
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
      TextEncoder: class {
        encodeInto(text) { return text.length === 0 ? undefined : new TextEncoder().encode(text) }
      },
      TextDecoder: { create(encoding, options) {
        const decoder = new TextDecoder(encoding, options)
        return { decodeToString: (value, decodeOptions) => decoder.decode(value, decodeOptions) }
      } },
      generateRandomUUID: () => crypto.randomUUID()
    } }
    if (name === '@kit.CryptoArchitectureKit') return { cryptoFramework: { createMd(algorithm) {
      assert.equal(algorithm, 'SHA256')
      if (cryptoFailure && cryptoFailureStage === 'create') throw cryptoFailure
      const hash = crypto.createHash('sha256')
      let updates = 0
      return {
        updateSync({ data }) {
          if (cryptoFailure && cryptoFailureStage === 'update' + ++updates) throw cryptoFailure
          hash.update(data)
        },
        digestSync() {
          if (cryptoFailure && cryptoFailureStage === 'digest') throw cryptoFailure
          return { data: hash.digest() }
        }
      }
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
const { AppActor } = load(path.join(root, 'runtime/AppActor.ets'))
const { StageTrace } = load(path.join(root, 'runtime/trace/StageTrace.ets'))
const { compileVeraSource } = vera('VeraCompiler')
const { VeraNumberValue, VeraStringValue } = vera('VeraInterpreter')
const { pointerValue } = vera('VeraGfx')
const { WorldSpec, sceneEventValue } = vera('VeraScene')
const { store, ProjectStore } = vera('ProjectStore')
const { veraStateStamp } = vera('VeraStateStamp')
store.init('/actor-fixture')
const target = 'com.example.actor/entry/EntryAbility/Record'
const effect = label => `sdk.call("${target}", ["label", "${label}", "value", ui.numberToString(state.n)], "answered");`
const trap = 'let empty: number[] = []; state.n = empty[2];'
function fixture({ initial = 1, refresh = '', init = '', initResult = '', view = '', extraFields = '', extraInit = '' } = {}) {
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
  return ${initResult || `{n: ${initial}, calls: 0, refreshes: 0, marks: [], badView: false${extraInit}}`};
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
  state.badView = true;
  ${effect('breakView')}
  return state;
}
function recover(state: AppState, value: number): AppState {
  state.badView = false;
  state.n = state.n + value;
  state.calls = state.calls + 1;
  return state;
}
function answered(state: AppState, answer: string): AppState {
  state.calls = state.calls + 1;
  state.n = state.n + answer.length();
  return state;
}
function frameA(state: AppState, ms: number): AppState {
  state.n = state.n * 10 + 1;
  state.calls = state.calls + 1;
  state.marks.push(ms);
  ${effect('frameA')}
  return state;
}
function frameB(state: AppState, ms: number): AppState {
  state.n = state.n * 10 + 2;
  state.calls = state.calls + 1;
  state.marks.push(ms);
  ${effect('frameB')}
  return state;
}
function pointer(state: AppState, p: gfx.Pointer): AppState {
  state.n = state.n + p.x + p.y + p.id;
  state.calls = state.calls + 1;
  ${effect('pointer')}
  return state;
}
function draw(state: AppState): gfx.Shape[] { return [gfx.circle(state.n, 2, 3, "ink")]; }
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
  ${view}
  return ui.Text("body", "n=" + ui.numberToString(state.n));
}
`
}
const refreshSuccess = `state.n = state.n + 10; state.refreshes = state.refreshes + 1; ${effect('refresh')}`
const refreshTrap = `state.n = state.n + 100; state.refreshes = state.refreshes + 1; ${effect('refresh-fail')} ${trap}`
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
  refreshed: compile(fixture({ refresh: refreshSuccess })),
  refreshTrap: compile(fixture({ refresh: refreshTrap })),
  newer: compile(fixture({ initial: 5, refresh: refreshSuccess, extraFields: 'added: number;', extraInit: ', added: 42' })),
  initTrap: compile(fixture({ init: 'let empty: number[] = []; let n: number = empty[2];' })),
  initEffect: compile(fixture({ init: `sdk.call("${target}", [], "answered");` })),
  viewEffect: compile(fixture({ view: effect('view') })),
  world: compile(fixture() + `
function build(state: AppState): scene.Thing[] {
  return [scene.floor("ink"), scene.box("body", state.n, 2, 3, 1, 2, 3, "accent")];
}
function buildEffect(state: AppState): scene.Thing[] {
  ${effect('build')}
  return [];
}
function buildTrap(state: AppState): scene.Thing[] {
  let empty: number[] = [];
  return [scene.box("body", empty[2], 0, 0, 1, 1, 1, "ink")];
}
function buildInvalid(state: AppState): scene.Thing[] {
  return [scene.floor("ink"), scene.floor("accent")];
}
function worldEvent(state: AppState, e: scene.Event): AppState {
  if (e.kind === "hit" && e.speed > 0) {
    state.n = state.n + e.speed;
    state.calls = state.calls + 1;
  }
  ${effect('world')}
  return state;
}
function worldCopy(state: AppState, value: number): AppState {
  return {n: state.n, calls: state.calls, refreshes: state.refreshes, marks: state.marks, badView: state.badView};
}
`)
}
function unpack(value) {
  assert(Array.isArray(value), 'snapshot contains tagged tuples, not runtime objects')
  switch (value[0]) {
    case 'n': assert.equal(typeof value[1], 'number'); return value[1]
    case 's': assert.equal(typeof value[1], 'string'); return value[1]
    case 'b': assert.equal(typeof value[1], 'boolean'); return value[1]
    case 'z': return null
    case 'a': return value[1].map(unpack)
    case 'o':
      assert.equal(typeof value[1], 'string')
      return Object.fromEntries(value[2].map(([key, item]) => [key, unpack(item)]))
    default: assert.fail('unknown snapshot tag: ' + value[0])
  }
}
const stateOf = encoded => unpack(JSON.parse(encoded))
function edited(encoded, changes) {
  const tuple = JSON.parse(encoded)
  for (const [key, value] of Object.entries(changes)) {
    const pair = tuple[2].find(item => item[0] === key)
    assert(pair, key)
    pair[1] = typeof value === 'boolean' ? ['b', value] : typeof value === 'number' ? ['n', value] : ['s', value]
  }
  return JSON.stringify(tuple)
}
const options = (mode = 'LIVE_PERSISTENT', persistKey = 'project/version', seedState = '') => ({ mode, persistKey, seedState })
const stateFile = (key = 'project/version') => '/actor-fixture/vera/' + key.split('/')[0] + '/' + key.slice(key.indexOf('/') + 1) + '.state.json'
function saveExternal(program, encoded, key = 'project/version') {
  const prior = disk.has(stateFile(key)) ? JSON.parse(disk.get(stateFile(key))) : null
  disk.set(stateFile(key), format2.assembleStateFile({ appId: key, schemaVersion: 1,
    vmGeneration: prior?.vmGeneration || 1, revision: (prior?.revision || 0) + 1, stamp: program.stamp }, encoded))
}
function probe({ onError, diagnostics = false } = {}) {
  const events = []
  records = events
  const snapshots = [], frames = [], effects = []
  let actor
  function error(kind, message, stop = true) {
    events.push({ type: 'ui-error', kind, message })
    if (stop) events.push({ type: 'stop', kind })
  }
  const render = (paint = true, reveal = false) => {
    events.push({ type: 'render', paint, reveal })
    try {
      const root = actor.view()
      const frame = { type: 'frame', root: JSON.parse(JSON.stringify(root)), paint, reveal }
      frames.push(frame)
      events.push(frame)
    } catch (e) {
      error('VIEW', 'View error: ' + e.message, false)
    }
  }
  actor = new AppActor({
    render,
    snapshot(encoded) {
      assert.equal(typeof encoded, 'string')
      stateOf(encoded)
      snapshots.push(encoded)
      events.push({ type: 'snapshot', encoded })
    },
    saved(projectId) { events.push({ type: 'saved', projectId }) },
    effects(batch) {
      for (const item of batch) {
        const request = { type: 'effect', id: item.id, kind: item.kind, target: item.rawTarget,
          params: [...item.values], handler: item.resultHandler, mode: item.rawMode }
        effects.push(request)
        events.push(request)
      }
    },
    error(kind, message) {
      error(kind, message, kind !== 'INIT' && !(kind === 'state' && message === 'STATE_RECOVERY'))
      if (onError) onError(kind, message, actor)
    }
  }, events)
  StageTrace.configure(true, record => {
    if (diagnostics) events.push({ type: 'diagnostic', event: record.event, attributes: record.attributes })
    if (record.event === 'EXECUTE') events.push({ type: 'execute', entry: record.attributes.entry })
    if (record.event === 'RESUME_STATE_RELOAD') events.push({ type: 'reload', changed: record.attributes.changed })
  })
  return { actor, events, snapshots, frames, effects, render, error,
    reset() { events.length = 0; snapshots.length = 0; frames.length = 0; effects.length = 0 },
    async state() { return stateOf(await actor.snapshot()) },
    paint(entry = 'draw') {
      const before = events.length
      try {
        const ops = actor.draw(entry)
        events.push({ type: 'draw', entry, ops: JSON.parse(JSON.stringify(ops)) })
        return ops
      } catch (e) {
        assert(events.slice(before).some(event => event.type === 'ui-error' && event.message === e.message), 'actor reports the rejected pure draw')
        return null
      }
    }
  }
}
const sequence = p => p.events.filter(e => ['execute', 'snapshot', 'frame', 'save', 'saved', 'effect', 'ui-error', 'stop', 'draw', 'reload'].includes(e.type))
  .map(e => e.type === 'execute' ? e.entry : e.type === 'effect' ? 'effect:' + e.params[0][1] : e.type === 'ui-error' || e.type === 'stop' ? e.type + ':' + e.kind : e.type)
const entries = p => p.events.filter(e => e.type === 'execute').map(e => e.entry)
const count = (p, type) => p.events.filter(e => e.type === type).length
const noIo = p => assert.equal(p.events.filter(e => ['load-attempt', 'load', 'save-attempt', 'save', 'saved'].includes(e.type)).length, 0)
const noErrors = p => assert.equal(count(p, 'ui-error'), 0)
const number = n => new VeraNumberValue(n)
const tests = []
function test(name, run) { tests.push({ name, run }) }
let fresh

test('current-source identity and private ownership; preview has no second execution/state path', async () => {
  assert.strictEqual(vera('ProjectStore').store, store)
  assert.strictEqual(load(path.join(root, 'runtime/../vera/VeraInterpreter.ets')), vera('VeraInterpreter'))
  const actorSource = fs.readFileSync(path.join(root, 'runtime/AppActor.ets'), 'utf8')
  const actorAst = ts.createSourceFile('AppActor.ts', actorSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const actorClass = actorAst.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'AppActor')
  for (const name of ['vm', 'host', 'manager', 'coordinator', 'pureCapability', 'mode', 'program', 'persistKey']) {
    const field = actorClass.members.find(member => member.name && member.name.getText(actorAst) === name)
    assert(field && field.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.PrivateKeyword), name + ' is private')
  }
  const preview = fs.readFileSync(path.join(root, 'components/VeraPreview.ets'), 'utf8')
  assert.match(preview, /import\s*\{[^}]*InProcessHost[^}]*\}\s*from\s*['"]\.\.\/runtime\/InProcessHost['"]/m)
  assert.match(preview, /class\s+PreviewSubscriber\s+implements\s+AppSubscriber/)
  assert(!/\bAppActor\b|\bRuntimeValue\b|\bnew\s+(VirtualMachine|UiHostEnvironment)\b|\bvm!?\.execute\s*\(|\bcurrentState\b|\bcarryState\s*\(|\bstore\.(loadState|saveState)\s*\(/.test(preview))
  for (const method of ['acquire', 'promote', 'replaceProgram', 'release', 'postInput', 'postTick', 'postSurfaceFrame', 'requestDraw', 'requestSnapshot']) {
    assert(preview.includes('this.runtime.' + method + '('), method + ' delegated to host')
  }
  const gfx = fs.readFileSync(path.join(root, 'vera/GfxPaint.ets'), 'utf8')
  assert(!/from\s+['"](?:@kit\.|@ohos\.|.*VeraInterpreter)/.test(gfx))
  assert.match(gfx, /from ['"]\.\/VeraTheme['"]/)
  const facing = fs.readFileSync(path.join(root, 'vera/VeraGfx.ets'), 'utf8')
  assert.match(facing, /export\s*\{[^}]*paintGfx[^}]*\}\s*from ['"]\.\/GfxPaint['"]/m)
  assert.match(facing, /from ['"]\.\/GfxPaint['"]/)
  assert.match(facing, /from ['"]\.\/VeraInterpreter['"]/)
})

test('uninitialized and empty program readiness; rejected init never publishes and persistent init effects commit first', async () => {
  const p = probe()
  assert.equal(p.actor.ready(), false)
  assert.equal(await p.actor.snapshot(), '')
  assert.equal(p.actor.view(), null)
  assert.deepEqual(p.actor.draw('draw'), [])
  await assert.rejects(p.actor.initialize({ vbc2: '', stamp: '' }, options()), /STATE_VALIDATION_FAILED/)
  assert.equal(p.actor.ready(), false)
  assert.equal(p.snapshots.length + p.frames.length + p.effects.length, 0)
  for (const program of [programs.initTrap, programs.initEffect, { vbc2: 'not bytecode', stamp: 'bad' }]) {
    p.reset()
    if (program === programs.initEffect) {
      await p.actor.replaceProgram(program, options())
      assert(p.actor.ready())
      assert.equal(count(p, 'save'), 1)
      assert.equal(p.effects.length, 1)
      assert(p.events.findIndex(e => e.type === 'save') < p.events.findIndex(e => e.type === 'effect'))
      assert.equal(count(p, 'saved'), 1)
    } else {
      await assert.rejects(p.actor.replaceProgram(program, options()))
      assert.equal(p.actor.ready(), false)
      assert.equal(await p.actor.snapshot(), '')
      assert.equal(p.snapshots.length + p.frames.length + p.effects.length + count(p, 'saved'), 0)
      assert.equal(count(p, 'save'), 0)
      assert.equal(count(p, 'ui-error'), 1)
      assert.equal(p.events.find(event => event.type === 'ui-error').kind, 'init')
      await p.actor.dispatch('change', number(5))
      assert.equal(count(p, 'ui-error'), 1)
    }
    assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
  }
  p.reset()
  await p.actor.replaceProgram(programs.basic, options('LIVE_EPHEMERAL', ''))
  assert(p.actor.ready())
  fresh = await p.actor.snapshot()
  assert.deepEqual(await p.state(), { n: 1, calls: 0, refreshes: 0, marks: [], badView: false })
  assert.deepEqual(sequence(p), ['init', 'snapshot', 'view', 'frame'])
})

test('persistent initialization order: snapshot/view precede refresh snapshot/view/save/effects', async () => {
  const p = probe()
  await p.actor.initialize(programs.refreshed, options())
  assert.deepEqual(sequence(p), ['init', 'save', 'snapshot', 'saved', 'view', 'frame', 'widgetRefresh', 'save', 'snapshot', 'effect:refresh', 'saved', 'view', 'frame'])
  assert.deepEqual(p.snapshots.map(s => stateOf(s).n), [1, 11])
  assert.deepEqual(p.frames.map(f => f.root.text), ['n=1', 'n=11'])
  assert(p.frames.every(f => f.paint && !f.reveal))
  assert.equal((await p.state()).refreshes, 1)
  assert.equal(count(p, 'saved'), 2)
  assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
  assert.equal(await store.loadState('project', 'version', programs.refreshed.stamp), (await p.actor.snapshot()))
  assert.deepEqual(p.effects[0].params, [['label', 'refresh'], ['value', '11']])
  assert.equal(p.effects[0].target, target)
  assert.equal(p.effects[0].handler, 'answered')
  assert.equal(p.effects[0].mode, 'background')
  noErrors(p)
})

test('saved persistent state beats seed and init; mismatched stamp uses seed', async () => {
  await saveExternal(programs.basic, edited(fresh, { n: 40, calls: 6 }))
  const p = probe()
  await p.actor.initialize(programs.basic, options('LIVE_PERSISTENT', 'project/version', edited(fresh, { n: 9 })))
  assert.equal((await p.state()).n, 40)
  assert.equal((await p.state()).calls, 6)
  assert.deepEqual(sequence(p), ['restore', 'snapshot', 'view', 'frame'])
  assert.equal(count(p, 'publication'), 1)
  assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
  assert.equal(count(p, 'save'), 0)
  p.reset()
  await p.actor.replaceProgram(programs.newer, options('LIVE_PERSISTENT', 'project/version', edited(fresh, { n: 9 })))
  assert.deepEqual(sequence(p), ['init', 'save', 'snapshot', 'saved', 'view', 'frame', 'widgetRefresh', 'save', 'snapshot', 'effect:refresh', 'saved', 'view', 'frame'])
  assert.equal((await p.state()).n, 19)
  assert.equal((await p.state()).added, 42)
})

test('malformed disk recovers through init; malformed seed rejects and carry view validation fails without a second init', async () => {
  let scenario = 0
  for (const stored of ['{broken', JSON.stringify({ stamp: programs.basic.stamp, value: ['unknown'] })]) {
    for (const seed of ['', '{broken', JSON.stringify(['unknown'])]) {
      disk.clear()
      const key = seed ? 'malformed-recovery-' + ++scenario + '/version' : 'project/version'
      const file = stateFile(key)
      disk.set(file, stored)
      const p = probe()
      if (seed) {
        await assert.rejects(p.actor.initialize(programs.basic, options('LIVE_PERSISTENT', key, seed)), error => error.code === 'STATE_VALIDATION_FAILED')
        assert.equal(p.actor.ready(), false)
        assert.equal(await p.actor.snapshot(), '')
        assert.equal(entries(p).filter(e => e === 'init').length, 0)
        assert.equal(p.snapshots.length + p.frames.length + p.effects.length + count(p, 'saved'), 0)
        assert.equal(count(p, 'save') + count(p, 'publication'), 0)
        assert.equal(disk.has(file), false)
        assert.equal(disk.has(file + '.bak'), false)
        assert.equal(count(p, 'ui-error'), 1)
        assert.equal(p.events.find(e => e.type === 'ui-error').kind, 'carry')
        assert(!p.events.some(e => e.message === 'STATE_RECOVERY'))
        assert.throws(() => store.assertStateAdmission(key), /admission fenced/)
      } else {
        await p.actor.initialize(programs.basic, options('LIVE_PERSISTENT', key))
        assert(p.actor.ready())
        assert.deepEqual(entries(p), ['init', 'view'])
        assert.equal(await p.actor.snapshot(), fresh)
        assert.equal(count(p, 'save'), 1)
        assert.equal(count(p, 'snapshot'), 1)
        assert.equal(p.frames[0].root.text, 'n=1')
        assert.deepEqual(p.events.filter(e => e.type === 'ui-error'), [{ type: 'ui-error', kind: 'state', message: 'STATE_RECOVERY' }])
        assert.equal(count(p, 'stop'), 0)
        assert.doesNotThrow(() => store.assertStateAdmission(key))
      }
      const quarantines = p.events.filter(e => e.type === 'quarantine')
      assert.equal(quarantines.length, 1)
      assert.equal(quarantines[0].file, file)
      assert.equal(disk.get(quarantines[0].to), stored)
      assert.deepEqual(p.events.filter(e => e.type === 'task-submit').map(e => e.request.kind), seed ? ['load', 'recoverLost'] : ['load', 'recoverLost', 'commit'])
      assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
      await p.actor.dispose()
    }
  }
  disk.clear()
  const p = probe()
  await assert.rejects(p.actor.initialize(programs.basic, options('LIVE_PERSISTENT', 'project/version', '{broken')))
  assert.equal(p.actor.ready(), false)
  assert.equal(disk.has(stateFile()), false)
  assert.equal(p.snapshots.length + p.frames.length + count(p, 'save'), 0)
  const q = probe()
  await assert.rejects(q.actor.initialize(programs.basic, options('LIVE_EPHEMERAL', '', edited(fresh, { n: -4 }))))
  assert.equal(q.actor.ready(), false)
  assert.deepEqual(entries(q), ['init'])
  assert.equal(q.snapshots.length + q.frames.length + q.effects.length, 0)
  noIo(q)
})

test('carry uses new class shape and defaults, preserving compatible state only', async () => {
  const p = probe()
  await p.actor.initialize(programs.newer, options('LIVE_EPHEMERAL', '', edited(fresh, { n: 7, calls: 3 })))
  assert.equal((await p.state()).n, 17)
  assert.equal((await p.state()).calls, 3)
  assert.equal((await p.state()).added, 42)
  assert.equal((await p.state()).refreshes, 1)
  assert.deepEqual(entries(p), ['init', 'view', 'widgetRefresh', 'view'])
  noIo(p)
  noErrors(p)
})

test('preview ignores disk and seed; dispatch/move/frame/refresh/snapshot/save remain inert', async () => {
  await saveExternal(programs.refreshed, edited(fresh, { n: 80 }))
  for (const seed of [edited(fresh, { n: 99 }), '{broken']) {
    const p = probe()
    await p.actor.initialize(programs.refreshed, options('PREVIEW', 'project/version', seed))
    assert(p.actor.ready())
    assert.deepEqual(sequence(p), ['init', 'view', 'frame'])
    assert.equal(p.frames[0].root.text, 'n=1')
    assert.equal((await p.actor.snapshot()), '')
    p.reset()
    await p.actor.dispatch('change', number(100))
    await p.actor.dispatch('fail', number(100))
    await p.actor.move('pointer', pointerValue('move', 1, 2, 3))
    await p.actor.frameHandlers(['frameA', 'frameB'], 16)
    await p.actor.runWidgetRefresh()
    await p.actor.resume()
    await p.actor.notifyStateSnapshot()
    await p.actor.persistState()
    p.actor.beginSurfaceLoop(now)
    assert.equal(await p.actor.surfaceSave(now + 6000, false), 'NOT_DUE')
    assert.deepEqual(p.events, [])
    p.render()
    assert.equal(p.frames[0].root.text, 'n=1')
    assert.deepEqual(entries(p), ['view'])
    noIo(p)
    noErrors(p)
  }
})

test('ephemeral seed/refresh/handlers/effect answers work without reading or writing disk', async () => {
  const p = probe()
  await p.actor.initialize(programs.refreshed, options('LIVE_EPHEMERAL', 'ignored/key', edited(fresh, { n: 4 })))
  assert.deepEqual(sequence(p), ['init', 'snapshot', 'view', 'frame', 'widgetRefresh', 'snapshot', 'effect:refresh', 'view', 'frame'])
  assert.equal((await p.state()).n, 14)
  p.reset()
  await p.actor.dispatch('change', number(2))
  assert.deepEqual(sequence(p), ['change', 'snapshot', 'effect:change', 'view', 'frame'])
  assert.equal((await p.state()).n, 16)
  assert(p.frames[0].paint && p.frames[0].reveal)
  await p.actor.dispatch('answered', new VeraStringValue('ok'), true, 'EFFECT_RESULT')
  assert.equal((await p.state()).n, 18)
  assert.equal((await p.state()).calls, 2)
  await p.actor.persistState()
  await p.actor.resume()
  assert.equal((await p.state()).n, 28)
  noIo(p)
  noErrors(p)
})

test('dispatch commits before snapshot/effects/view and effects override persist=false', async () => {
  const p = probe()
  await p.actor.initialize(programs.basic, options())
  p.reset()
  await p.actor.dispatch('change', number(2))
  assert.deepEqual(sequence(p), ['change', 'save', 'snapshot', 'effect:change', 'saved', 'view', 'frame'])
  assert.equal(stateOf(p.snapshots[0]).n, 3)
  assert.equal(p.frames[0].root.text, 'n=3')
  const saved = disk.get(stateFile())
  p.reset()
  await p.actor.dispatch('change', number(4), false, 'TICK')
  assert.deepEqual(sequence(p), ['change', 'save', 'snapshot', 'effect:change', 'saved', 'view', 'frame'])
  assert.equal((await p.state()).n, 7)
  assert.notEqual(disk.get(stateFile()), saved)
  assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
  p.reset()
  await p.actor.dispatch('answered', new VeraStringValue('ok'), true, 'EFFECT_RESULT')
  assert.deepEqual(sequence(p), ['answered', 'save', 'snapshot', 'saved', 'view', 'frame'])
  assert.equal((await p.state()).n, 9)
  noErrors(p)
})

test('promotion preserves VM, state and effect sequence; no init, disk reload or refresh', async () => {
  await saveExternal(programs.refreshed, edited(fresh, { n: 90 }))
  const p = probe()
  await p.actor.initialize(programs.refreshed, options('PREVIEW', 'project/version', edited(fresh, { n: 70 })))
  p.reset()
  const live = options('LIVE_PERSISTENT', 'project/version', edited(fresh, { n: 60 }))
  await p.actor.promote(live)
  assert.deepEqual(sequence(p), ['restore', 'save', 'snapshot', 'saved', 'view', 'frame'])
  assert.equal(count(p, 'publication'), 1)
  assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
  assert.equal((await p.state()).n, 1)
  assert.equal((await p.state()).refreshes, 0)
  await p.actor.dispatch('change', number(3))
  const id = p.effects[0].id
  const snapshot = (await p.actor.snapshot())
  p.reset()
  await p.actor.promote(live)
  assert.deepEqual(p.events, [])
  assert.equal((await p.actor.snapshot()), snapshot)
  await p.actor.promote(options('LIVE_EPHEMERAL', ''))
  assert.deepEqual(sequence(p), ['restore', 'snapshot', 'view', 'frame'])
  assert.equal((await p.actor.snapshot()), snapshot)
  p.reset()
  await p.actor.dispatch('change', number(1))
  assert.equal(p.effects[0].id, id + 1)
  noIo(p)
  p.reset()
  await p.actor.promote(options('PREVIEW', 'project/version'))
  assert.deepEqual(sequence(p), ['restore', 'view', 'frame'])
  assert.equal((await p.actor.snapshot()), '')
  p.reset()
  await p.actor.dispatch('change', number(100))
  assert.deepEqual(p.events, [])
  await p.actor.promote(live)
  assert.equal((await p.state()).n, 5)
  assert.equal((await p.state()).calls, 2)
  assert.equal((await p.state()).refreshes, 0)
})

test('both watcher orders replace with complete latest options and converge, with and without saved live state', async () => {
  for (const stored of [false, true]) {
    const outcomes = []
    for (const order of ['promote-first', 'replace-first']) {
      disk.clear()
      if (stored) await saveExternal(programs.newer, edited(fresh, { n: 70, calls: 8 }), 'latest/new-version')
      const p = probe()
      await p.actor.initialize(programs.basic, options('PREVIEW', 'old/version', edited(fresh, { n: 99 })))
      p.reset()
      const latest = options('LIVE_PERSISTENT', 'latest/new-version', edited(fresh, { n: 20 }))
      if (order === 'promote-first') {
        await p.actor.promote(latest)
        assert.equal((await p.state()).n, 1)
        assert(!entries(p).includes('widgetRefresh'))
        p.reset()
      }
      await p.actor.replaceProgram(programs.newer, latest)
      const restored = stored && order === 'replace-first'
      assert.equal((await p.state()).n, restored ? 80 : 30)
      assert.equal((await p.state()).refreshes, 1)
      assert.equal(entries(p).filter(entry => entry === 'init').length, restored ? 0 : 1)
      assert.equal(p.frames[0].root.text, restored ? 'n=70' : 'n=20')
      assert.equal(p.events.find(e => e.type === 'save').file, stateFile('latest/new-version'))
      assert(p.events.filter(e => e.type === 'saved').every(e => e.projectId === 'latest'))
      const encoded = (await p.actor.snapshot())
      p.reset()
      await p.actor.promote(latest)
      assert.deepEqual(p.events, [])
      assert.equal(await store.loadState('latest', 'new-version', programs.newer.stamp), encoded)
      assert.equal(await store.loadState('latest', 'new-version', programs.basic.stamp), '')
      outcomes.push(encoded)
      noErrors(p)
    }
    if (stored) {
      assert.equal(stateOf(outcomes[0]).n, 30)
      assert.equal(stateOf(outcomes[1]).n, 80)
    } else assert.equal(outcomes[0], outcomes[1])
  }
})

test('replacement resets old runtime and installs new mode, key and seed, including live-to-preview', async () => {
  const p = probe()
  await p.actor.initialize(programs.refreshed, options())
  await p.actor.dispatch('change', number(2))
  p.reset()
  await p.actor.replaceProgram(programs.newer, options('LIVE_EPHEMERAL', '', edited(fresh, { n: 8 })))
  assert.equal((await p.state()).n, 18)
  assert.equal((await p.state()).calls, 0)
  assert.equal((await p.state()).added, 42)
  noIo(p)
  p.reset()
  await p.actor.replaceProgram(programs.refreshed, options('PREVIEW', 'new/project', edited(fresh, { n: 50 })))
  assert.deepEqual(sequence(p), ['init', 'view', 'frame'])
  assert.equal((await p.actor.snapshot()), '')
  assert.equal(p.frames[0].root.text, 'n=1')
  await p.actor.resume()
  await p.actor.runWidgetRefresh()
  noIo(p)
})

test('resume adopts external Form state before view/refresh/save and does not roll back unsaved live state for identical disk', async () => {
  const p = probe()
  await p.actor.initialize(programs.refreshed, options())
  await p.actor.dispatch('change', number(5), false)
  assert.equal((await p.state()).n, 16)
  p.reset()
  await p.actor.resume()
  assert.deepEqual(sequence(p), ['reload', 'view', 'frame', 'widgetRefresh', 'save', 'snapshot', 'effect:refresh', 'saved', 'view', 'frame'])
  assert.equal(count(p, 'publication'), 0)
  assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
  assert.equal(p.frames[0].root.text, 'n=16')
  assert.equal((await p.state()).n, 26)
  await saveExternal(programs.refreshed, edited((await p.actor.snapshot()), { n: 100, calls: 50 }))
  p.reset()
  await p.actor.resume()
  assert.deepEqual(sequence(p), ['reload', 'snapshot', 'view', 'frame', 'widgetRefresh', 'save', 'snapshot', 'effect:refresh', 'saved', 'view', 'frame'])
  assert.equal(count(p, 'publication'), 1)
  assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
  assert.equal(p.frames[0].root.text, 'n=100')
  assert.equal((await p.state()).n, 110)
  assert.equal((await p.state()).calls, 50)
  assert.equal(stateOf(await store.loadState('project', 'version', programs.refreshed.stamp)).n, 110)
  noErrors(p)
})

test('resume malformed or missing external state retains live state; no unconditional overwrite without refresh', async () => {
  for (const value of ['{broken', JSON.stringify({ stamp: programs.basic.stamp, value: ['unknown'] }), null]) {
    disk.clear()
    const p = probe()
    await p.actor.initialize(programs.basic, options())
    await p.actor.dispatch('change', number(2))
    await p.actor.dispatch('change', number(3), false)
    if (value === null) disk.delete(stateFile())
    else disk.set(stateFile(), value)
    p.reset()
    await assert.rejects(p.actor.resume(), value === null ? /STATE_RECREATE_REQUIRED/ : /STATE_RELOAD_PENDING/)
    if (value === null) assert.equal(await p.actor.snapshot(), '')
    else await assert.rejects(p.actor.snapshot(), /STATE_RELOAD_PENDING/)
    assert.equal(p.frames.length, 0)
    assert.equal(count(p, 'save') + count(p, 'snapshot'), 0)
    assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
    assert.equal(disk.get(stateFile()), value === null ? undefined : value)
    assert.equal(count(p, 'ui-error'), 1)
    assert.equal(p.events.find(e => e.type === 'ui-error').kind, 'state')
  }
})

test('handler traps roll back in-place mutations, suppress queued effects and report once before recovery', async () => {
  const p = probe()
  await p.actor.initialize(programs.basic, options())
  await p.actor.persistState()
  const saved = disk.get(stateFile())
  p.reset()
  await assert.rejects(p.actor.dispatch('fail', number(7)), /array index out of bounds/)
  assert.deepEqual(sequence(p), ['fail', 'ui-error:handler', 'stop:handler'])
  assert.match(p.events.find(e => e.type === 'ui-error').message, /array index out of bounds/)
  assert.deepEqual(await p.state(), { n: 1, calls: 0, refreshes: 0, marks: [], badView: false })
  assert.equal(disk.get(stateFile()), saved)
  assert.equal(p.snapshots.length + p.frames.length + p.effects.length, 0)
  p.reset()
  await p.actor.dispatch('recover', number(1))
  assert.equal((await p.state()).n, 2)
  assert.equal((await p.state()).calls, 1)
  assert.equal(p.effects.length, 0)
  assert.deepEqual(entries(p), ['recover', 'view'])
  assert.equal(stateOf(await store.loadState('project', 'version', programs.basic.stamp)).n, 2)
  assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
})

test('view trap after successful handler keeps last tree; snapshot/save/effects continue without rerun or timer stop', async () => {
  const p = probe()
  await p.actor.initialize(programs.basic, options())
  const lastFrame = p.frames[0]
  p.reset()
  await p.actor.dispatch('breakView', number(4))
  assert.deepEqual(sequence(p), ['breakView', 'save', 'snapshot', 'effect:breakView', 'saved', 'view', 'ui-error:VIEW'])
  assert.equal((await p.state()).n, 5)
  assert.equal((await p.state()).calls, 1)
  assert.equal(p.frames.length, 0)
  assert.equal(lastFrame.root.text, 'n=1')
  assert.equal(count(p, 'stop'), 0)
  assert.equal(stateOf(p.snapshots[0]).n, 5)
  assert.equal(stateOf(await store.loadState('project', 'version', programs.basic.stamp)).n, 5)
  p.reset()
  await p.actor.dispatch('recover', number(1))
  assert.equal(p.frames[0].root.text, 'n=6')
  assert.equal((await p.state()).calls, 2)
  assert.deepEqual(entries(p), ['recover', 'view'])
})

test('view effects forbidden during initial render and after handlers without leaking effects', async () => {
  const p = probe()
  await p.actor.initialize(programs.viewEffect, options())
  assert(p.actor.ready())
  assert.deepEqual(sequence(p), ['init', 'save', 'snapshot', 'saved', 'view', 'ui-error:VIEW'])
  assert.match(p.events.find(e => e.type === 'ui-error').message, /sdk.call is unavailable during pure execution/)
  p.reset()
  await p.actor.dispatch('change', number(2))
  assert.deepEqual(sequence(p), ['change', 'save', 'snapshot', 'effect:change', 'saved', 'view', 'ui-error:VIEW'])
  assert.equal((await p.state()).calls, 1)
  assert.equal(count(p, 'stop'), 0)
})

test('draw effects forbidden; independent draw trap cannot rerun or undo completed handler/save/effects', async () => {
  const p = probe()
  await p.actor.initialize(programs.basic, options())
  p.reset()
  await p.actor.dispatch('change', number(2))
  const snapshot = (await p.actor.snapshot())
  for (const entry of ['drawEffect', 'drawTrap']) {
    const before = p.events.length
    assert.equal(p.paint(entry), null)
    assert.deepEqual(sequence({ events: p.events.slice(before) }), [entry, 'ui-error:view', 'stop:view'])
    assert.equal((await p.actor.snapshot()), snapshot)
  }
  assert.equal(entries(p).filter(e => e === 'change').length, 1)
  assert.equal(p.effects.length, 1)
  assert.equal(count(p, 'save'), 1)
  p.reset()
  const ops = p.paint()
  assert.equal(ops.length, 1)
  assert.equal(ops[0].x, 3)
  assert.deepEqual(p.actor.draw(''), [])
  await p.actor.dispatch('recover', number(1))
  assert.equal(p.effects.length, 0)
  assert.equal((await p.state()).calls, 2)
})

test('save failures roll back handler state and suppress publication/effects; retry commits through TaskPool', async () => {
  for (const stage of ['open', 'write', 'close', 'rename']) {
    const p = probe()
    await p.actor.initialize(programs.basic, options())
    await p.actor.persistState()
    const saved = disk.get(stateFile())
    p.reset()
    failure = stage
    await assert.rejects(p.actor.dispatch('change', number(3)), /STATE_/)
    failure = ''
    if (stage === 'close') for (const fd of [...worker.memory.fds.keys()]) worker.memory.closeSync(fd)
    assert.equal((await p.state()).n, 1)
    assert.equal((await p.state()).calls, 0)
    assert.equal(p.snapshots.length + p.frames.length + p.effects.length + count(p, 'saved'), 0)
    assert.equal(disk.get(stateFile()), saved)
    assert(p.events.some(e => e.type === 'task-result' && e.reply.result?.status === 'FAILED'))
    assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
    assert.equal(count(p, 'ui-error'), 1)
    assert(![...disk.keys()].some(file => file.endsWith('.tmp')))
    p.reset()
    await p.actor.dispatch('change', number(3))
    assert.deepEqual(sequence(p), ['change', 'save', 'snapshot', 'effect:change', 'saved', 'view', 'frame'])
    assert.equal(stateOf(await store.loadState('project', 'version', programs.basic.stamp)).n, 4)
    assert.equal((await p.state()).calls, 1)
    assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
    await p.actor.dispose()
    disk.clear()
  }
})

test('refresh traps reject, roll back mutations and effects, and publish no failed turn state', async () => {
  const p = probe()
  await assert.rejects(p.actor.initialize(programs.refreshTrap, options()), /array index out of bounds/)
  assert.deepEqual(sequence(p), ['init', 'save', 'snapshot', 'saved', 'view', 'frame', 'widgetRefresh', 'ui-error:handler', 'stop:handler'])
  assert.equal(p.frames[0].root.text, 'n=1')
  assert.equal(stateOf(p.snapshots[0]).n, 1)
  assert.equal((await p.state()).n, 1)
  assert.equal((await p.state()).refreshes, 0)
  assert.equal(count(p, 'save'), 1)
  assert.equal(p.effects.length, 0)
  p.reset()
  await assert.rejects(p.actor.runWidgetRefresh(), /array index out of bounds/)
  assert.deepEqual(sequence(p), ['widgetRefresh', 'ui-error:handler', 'stop:handler'])
  assert.equal((await p.state()).n, 1)
  assert.equal((await p.state()).refreshes, 0)
  p.reset()
  await p.actor.dispatch('recover', number(1))
  assert.equal((await p.state()).n, 2)
  assert.equal(p.effects.length, 0)
  assert.equal(stateOf(await store.loadState('project', 'version', programs.refreshTrap.stamp)).n, 2)
  assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
})

test('refresh view failure still saves and delivers effects; no handler rerun or timer stop', async () => {
  const p = probe()
  await p.actor.initialize(programs.refreshed, options())
  await p.actor.dispatch('breakView', number(1), false)
  p.reset()
  await p.actor.runWidgetRefresh()
  assert.deepEqual(sequence(p), ['widgetRefresh', 'save', 'snapshot', 'effect:refresh', 'saved', 'view', 'ui-error:VIEW'])
  assert.equal((await p.state()).n, 22)
  assert.equal((await p.state()).refreshes, 2)
  assert.equal(count(p, 'stop'), 0)
})

const worldEvent = (kind, speed = 0) => sceneEventValue(kind, 'body', '', 0, 0, 0, speed, [], [])

test('world build decodes actor state with effects disabled, propagates traps and is inert when unavailable', async () => {
  const p = probe()
  assert.deepEqual(p.actor.buildScene('build'), new WorldSpec())
  await p.actor.initialize(programs.world, options())
  p.reset()
  const before = (await p.actor.snapshot())
  const scene = p.actor.buildScene('build')
  assert(scene instanceof WorldSpec)
  assert.deepEqual(scene.bodies[0].position, [1, 2, 3])
  assert.equal(scene.bodies[0].id, 'body')
  assert(scene.floor)
  assert.deepEqual(sequence(p), ['build'])
  assert.equal((await p.actor.snapshot()), before)
  assert.throws(() => p.actor.buildScene('buildEffect'), /sdk.call is unavailable during pure execution/)
  assert.throws(() => p.actor.buildScene('buildTrap'))
  assert.throws(() => p.actor.buildScene('buildInvalid'), /at most one scene.floor/)
  assert.deepEqual(p.actor.buildScene(''), new WorldSpec())
  assert.equal(p.effects.length + p.frames.length + p.snapshots.length, 0)
  noIo(p)
  await p.actor.dispatch('recover', number(1))
  assert.equal(p.effects.length, 0)
  assert.equal(p.actor.buildScene('build').bodies[0].position[0], 2)
  await p.actor.initialize(programs.world, options('PREVIEW'))
  p.reset()
  assert.equal(p.actor.buildScene('build').bodies[0].position[0], 1)
  await p.actor.dispatch('worldEvent', worldEvent('hit', 3), false, 'WORLD', true)
  assert.equal(p.actor.worldDirty(), false)
  assert.equal(await p.actor.worldSave(now + 5000, false, true), 'NOT_DUE')
  await p.actor.dispose()
  assert.deepEqual(p.actor.buildScene('build'), new WorldSpec())
})

test('world effects commit before publication even for unchanged handlers; encoded equality detects in-place changes', async () => {
  const p = probe()
  await p.actor.initialize(programs.world, options())
  p.reset()
  await p.actor.dispatch('worldEvent', worldEvent('tap'), true, 'WORLD', true)
  assert.deepEqual(sequence(p), ['worldEvent', 'save', 'snapshot', 'effect:world', 'saved', 'view', 'frame'])
  assert.equal(p.actor.worldDirty(), false)
  p.reset()
  await p.actor.dispatch('worldCopy', number(0), true, 'WORLD', true)
  assert.deepEqual(sequence(p), ['worldCopy', 'save', 'snapshot', 'saved'])
  p.reset()
  await p.actor.dispatch('worldEvent', worldEvent('hit', 2), false, 'WORLD', true)
  assert.deepEqual(sequence(p), ['worldEvent', 'save', 'snapshot', 'effect:world', 'saved', 'view', 'frame'])
  assert.equal((await p.state()).n, 3)
  assert.equal(p.actor.worldDirty(), false)
  assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
  p.reset()
  await p.actor.dispatch('worldEvent', worldEvent('hit'), false, 'WORLD', true)
  assert.deepEqual(sequence(p), ['worldEvent', 'save', 'snapshot', 'effect:world', 'saved', 'view', 'frame'])
  assert.equal(p.actor.worldDirty(), false)
  p.reset()
  await p.actor.dispatch('worldEvent', worldEvent('settled'), true, 'WORLD', true)
  assert.deepEqual(sequence(p), ['worldEvent', 'save', 'snapshot', 'effect:world', 'saved', 'view', 'frame'])
  assert.equal(p.actor.worldDirty(), false)
  assert.equal(stateOf(await store.loadState('project', 'version', programs.world.stamp)).n, 3)
  p.reset()
  await p.actor.dispatch('worldCopy', number(0))
  assert.deepEqual(sequence(p), ['worldCopy', 'save', 'snapshot', 'saved', 'view', 'frame'])
  noErrors(p)
})

test('world save shares the 5000ms gate, defers drafts, bypasses time when stopping and publishes committed snapshots', async () => {
  const p = probe()
  await p.actor.initialize(programs.world, options())
  p.actor.beginSurfaceLoop(now)
  assert.equal(await p.actor.worldSave(now + 6000, false, true), 'NOT_DUE')
  await p.actor.dispatch('recover', number(2), false, 'WORLD', true)
  p.reset()
  assert.equal(await p.actor.worldSave(now + 4999, false, false), 'NOT_DUE')
  assert.equal(await p.actor.worldSave(now + 5000, true, false), 'DEFERRED')
  assert.equal(await p.actor.worldSave(now + 5000, true, true), 'DEFERRED')
  assert.deepEqual(p.events, [])
  assert.equal(p.actor.worldDirty(), true)
  assert.equal(await p.actor.worldSave(now + 5000, false, false), 'DONE')
  assert.deepEqual(sequence(p), ['save', 'snapshot', 'saved'])
  assert.equal(p.actor.worldDirty(), false)
  await p.actor.dispatch('recover', number(3), false, 'WORLD', true)
  p.reset()
  assert.equal(await p.actor.surfaceSave(now + 9999, false), 'NOT_DUE')
  assert.equal(await p.actor.worldSave(now + 9999, false, false), 'NOT_DUE')
  assert.equal(await p.actor.worldSave(now + 9999, false, true), 'DONE')
  assert.deepEqual(sequence(p), ['save', 'snapshot', 'saved'])
  assert.equal(stateOf(await store.loadState('project', 'version', programs.world.stamp)).n, 6)
  assert.equal(p.actor.worldDirty(), false)
})

test('failed world persistence retains dirty state and deadline for immediate retries and unchanged saving events', async () => {
  for (const stage of ['open', 'write', 'close', 'rename']) {
    disk.clear()
    const p = probe()
    await p.actor.initialize(programs.world, options())
    assert.equal(await p.actor.persistState(), true)
    const saved = disk.get(stateFile())
    p.actor.beginSurfaceLoop(now)
    await p.actor.dispatch('recover', number(2), false, 'WORLD', true)
    p.reset()
    failure = stage
    if (stage === 'write' || stage === 'close') assert.equal(await p.actor.worldSave(now + 5000, false, false), 'ERROR')
    else await assert.rejects(p.actor.worldSave(now + 5000, false, false), /STATE_/)
    assert.equal(p.actor.worldDirty(), true)
    assert.equal(disk.get(stateFile()), saved)
    assert.equal(p.snapshots.length + p.frames.length + count(p, 'saved'), 0)
    assert(p.events.some(e => e.type === 'task-result' && e.reply.result?.status === 'FAILED'))
    assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
    await assert.rejects(p.actor.dispatch('worldEvent', worldEvent('settled'), true, 'WORLD', true), /STATE_/)
    assert.equal(p.actor.worldDirty(), true)
    assert.equal(p.effects.length + p.snapshots.length + p.frames.length, 0)
    failure = ''
    if (stage === 'close') for (const fd of [...worker.memory.fds.keys()]) worker.memory.closeSync(fd)
    p.reset()
    assert.equal(await p.actor.worldSave(now + 5000, false, false), 'DONE')
    assert.equal(p.actor.worldDirty(), false)
    assert.deepEqual(sequence(p), ['save', 'snapshot', 'saved'])
    noErrors(p)
  }
})

test('world dirty clears on any successful persist, initialization and dispose, but not on unavailable persistence', async () => {
  const p = probe()
  assert.equal(p.actor.worldDirty(), false)
  assert.equal(await p.actor.worldSave(now, false, true), 'NOT_DUE')
  assert.equal(await p.actor.persistState(), false)
  for (const opts of [options('LIVE_EPHEMERAL', ''), options('LIVE_PERSISTENT', 'invalid')]) {
    if (opts.mode === 'LIVE_PERSISTENT') {
      const q = probe()
      await assert.rejects(q.actor.initialize(programs.world, opts), /Invalid project state identity/)
      assert.equal(q.actor.ready(), false)
      assert.equal(q.actor.worldDirty(), false)
      continue
    }
    await p.actor.initialize(programs.world, opts)
    await p.actor.dispatch('recover', number(2), false, 'WORLD', true)
    p.reset()
    assert.equal(await p.actor.worldSave(now, false, true), 'NOT_DUE')
    assert.equal(p.actor.worldDirty(), false)
    assert.equal(await p.actor.persistState(), false)
    noIo(p)
  }
  records = p.events
  await p.actor.initialize(programs.world, options())
  assert.equal(p.actor.worldDirty(), false)
  await p.actor.dispatch('recover', number(2), false, 'WORLD', true)
  assert.equal(p.actor.worldDirty(), true)
  assert.equal(await p.actor.persistState(), true)
  assert.equal(p.actor.worldDirty(), false)
  await p.actor.dispatch('worldEvent', worldEvent('hit', 2), false, 'WORLD', true)
  await p.actor.dispatch('recover', number(1))
  assert.equal(p.actor.worldDirty(), false)
  await p.actor.dispatch('worldEvent', worldEvent('hit', 2), false, 'WORLD', true)
  await p.actor.dispose()
  assert.equal(p.actor.worldDirty(), false)
  await assert.rejects(p.actor.worldSave(now + 6000, false, true), /STATE_UNAVAILABLE/)
})

test('surface frame handlers execute in caller order; effects precede explicit UI draw/view and periodic save/snapshot', async () => {
  const p = probe()
  await p.actor.initialize(programs.basic, options())
  p.actor.beginSurfaceLoop(now)
  p.reset()
  now += 5000
  await p.actor.frameHandlers(['frameA', '', 'frameB'], 16)
  assert.deepEqual(sequence(p), ['save', 'snapshot', 'effect:frameA', 'effect:frameB', 'saved'])
  assert.equal((await p.state()).n, 112)
  assert.deepEqual((await p.state()).marks, [16, 16])
  assert.equal(p.snapshots.length, 1)
  assert.equal(p.frames.length, 0)
  assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
  assert(p.actor.viewDue(now))
  assert.equal(p.paint()[0].x, 112)
  p.render(false)
  assert.equal(await p.actor.surfaceSave(now, false), 'NOT_DUE')
  assert.deepEqual(sequence(p), ['save', 'snapshot', 'effect:frameA', 'effect:frameB', 'saved', 'draw', 'draw', 'view', 'frame'])
  assert(!p.frames[0].paint && !p.frames[0].reveal)
  assert.equal(stateOf(p.snapshots[0]).n, 112)
  noErrors(p)
})

test('surface move effects precede UI drawing, with no actor render, snapshot or durable save', async () => {
  const p = probe()
  await p.actor.initialize(programs.basic, options())
  p.reset()
  await p.actor.move('pointer', pointerValue('move', 2, 3, 4))
  assert.deepEqual(sequence(p), ['save', 'snapshot', 'effect:pointer', 'saved'])
  assert.equal((await p.state()).n, 10)
  assert.equal((await p.state()).calls, 1)
  assert.equal(p.snapshots.length, 1)
  assert.equal(p.frames.length, 0)
  assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
  p.paint()
  assert.deepEqual(sequence(p), ['save', 'snapshot', 'effect:pointer', 'saved', 'draw', 'draw'])
  now += 100
  assert(p.actor.viewDue(now))
  p.render(false)
  assert.equal(p.frames[0].root.text, 'n=10')
  assert.equal(count(p, 'save'), 1)
  assert.equal(count(p, 'saved'), 1)
})

test('frame and move traps propagate for caller reporting, suppress effects and retain partial mutation', async () => {
  for (const kind of ['FRAME', 'MOVE']) {
    disk.clear()
    const p = probe()
    await p.actor.initialize(programs.basic, options())
    p.reset()
    let trapped
    try {
      if (kind === 'FRAME') await p.actor.frameHandlers(['frameA', 'fail', 'frameB'], 4)
      else await p.actor.move('fail', number(4))
    } catch (e) {
      trapped = e
    }
    assert(trapped && /array index out of bounds/.test(trapped.message))
    assert.equal(count(p, 'ui-error'), 1)
    assert.deepEqual(sequence(p).slice(-2), ['ui-error:handler', 'stop:handler'])
    assert.equal((await p.state()).n, 1)
    assert.equal((await p.state()).calls, 0)
    assert.deepEqual((await p.state()).marks, [])
    assert.equal(p.snapshots.length + p.frames.length + p.effects.length + count(p, 'save'), 0)
    p.reset()
    await p.actor.dispatch('recover', number(1))
    assert.equal(p.effects.length, 0)
  }
})

test('view cadence boundary and surface edit gate defer without advancing save deadline', async () => {
  const p = probe()
  await p.actor.initialize(programs.basic, options())
  assert.equal(p.actor.viewDue(now + 99), false)
  assert.equal(p.actor.viewDue(now + 100), true)
  now += 100
  p.render(false)
  assert.equal(p.actor.viewDue(now + 99), false)
  assert.equal(p.actor.viewDue(now + 100), true)
  p.actor.beginSurfaceLoop(now)
  p.reset()
  await p.actor.move('recover', number(10))
  p.reset()
  assert.equal(await p.actor.surfaceSave(now + 4999, false), 'NOT_DUE')
  assert.equal(await p.actor.surfaceSave(now + 5000, true), 'DEFERRED')
  assert.equal(await p.actor.surfaceSave(now + 9000, true), 'DEFERRED')
  assert.deepEqual(p.events, [])
  assert.equal(await p.actor.surfaceSave(now + 9000, false), 'DONE')
  assert.deepEqual(sequence(p), ['save', 'snapshot', 'saved'])
  assert.equal(stateOf(p.snapshots[0]).n, 11)
  p.reset()
  assert.equal(await p.actor.surfaceSave(now + 13999, false), 'NOT_DUE')
  assert.equal(await p.actor.surfaceSave(now + 14000, false), 'NOT_DUE')
  await p.actor.move('recover', number(0))
  p.actor.beginSurfaceLoop(now + 15000)
  p.reset()
  assert.equal(await p.actor.surfaceSave(now + 19999, false), 'NOT_DUE')
  assert.deepEqual(p.events, [])
  assert.equal(await p.actor.surfaceSave(now + 20000, false), 'DONE')
})

test('failed surface save publishes no snapshot, retains deadline and retries immediately', async () => {
  const p = probe()
  await p.actor.initialize(programs.basic, options())
  await p.actor.persistState()
  const saved = disk.get(stateFile())
  p.actor.beginSurfaceLoop(now)
  await p.actor.move('recover', number(10))
  p.reset()
  failure = 'rename'
  await assert.rejects(p.actor.surfaceSave(now + 5000, false), /STATE_PUBLISH_FAILED/)
  failure = ''
  assert.deepEqual(sequence(p), ['ui-error:state', 'stop:state'])
  assert.equal(p.snapshots.length, 0)
  assert.equal(count(p, 'save-attempt'), 1)
  assert.equal(count(p, 'saved'), 0)
  assert.equal(disk.get(stateFile()), saved)
  assert(p.events.some(e => e.type === 'task-result' && e.reply.result?.status === 'FAILED'))
  assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
  assert.equal(count(p, 'ui-error'), 1)
  p.reset()
  assert.equal(await p.actor.surfaceSave(now + 5000, false), 'DONE')
  assert.deepEqual(sequence(p), ['save', 'snapshot', 'saved'])
  assert.equal(stateOf(p.snapshots[0]).n, 11)
  assert.equal(stateOf(await store.loadState('project', 'version', programs.basic.stamp)).n, 11)
  p.reset()
  assert.equal(await p.actor.surfaceSave(now + 9999, false), 'NOT_DUE')
  assert.deepEqual(p.events, [])
  assert.equal(await p.actor.surfaceSave(now + 10000, false), 'NOT_DUE')
  assert.deepEqual(sequence(p), [])
  await p.actor.move('recover', number(0))
  assert.equal(await p.actor.surfaceSave(now + 10000, false), 'DONE')
  assert.deepEqual(sequence(p), ['save', 'snapshot', 'saved'])
})

test('ephemeral periodic saves are not due and malformed persistent keys reject before publication', async () => {
  for (const opts of [options('LIVE_EPHEMERAL', ''), options('LIVE_PERSISTENT', ''), options('LIVE_PERSISTENT', 'invalid'), options('LIVE_PERSISTENT', '/version')]) {
    const p = probe()
    if (opts.mode === 'LIVE_PERSISTENT') {
      await assert.rejects(p.actor.initialize(programs.basic, opts), /Invalid project state identity/)
      assert.equal(p.actor.ready(), false)
      assert.equal(p.snapshots.length + p.frames.length + p.effects.length + count(p, 'save'), 0)
      assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
      continue
    }
    await p.actor.initialize(programs.basic, opts)
    p.actor.beginSurfaceLoop(now)
    p.reset()
    await p.actor.frameHandlers(['frameA'], 16)
    assert.equal(await p.actor.surfaceSave(now + 5000, false), 'NOT_DUE')
    assert.equal(await p.actor.surfaceSave(now + 5000, false), 'NOT_DUE')
    assert.equal(p.snapshots.length, 1)
    assert.equal((await p.state()).n, 11)
    noIo(p)
  }
})

test('real ProjectStore TaskPool roundtrip retains Format 2 identity and refusal leaves previous atomic record', async () => {
  const other = new ProjectStore()
  other.init('/actor-fixture')
  const encoded = edited(fresh, { n: 23 })
  const p = probe()
  await p.actor.initialize(programs.basic, options('LIVE_PERSISTENT', 'roundtrip/version', encoded))
  const file = stateFile('roundtrip/version')
  const payload = JSON.parse(disk.get(file))
  assert.deepEqual(Object.keys(payload), ['format', 'appId', 'schemaVersion', 'vmGeneration', 'revision', 'payloadLength', 'payloadHash', 'stamp', 'value'])
  assert.equal(payload.format, 2)
  assert.equal(payload.appId, 'roundtrip/version')
  assert.equal(payload.revision, 1)
  assert.deepEqual(payload.value, JSON.parse(encoded))
  assert.equal(payload.stamp, programs.basic.stamp)
  assert.equal(await store.loadState('roundtrip', 'version', programs.basic.stamp), encoded)
  assert.equal(await other.loadState('roundtrip', 'version', 'wrong-stamp'), '')
  const previous = disk.get(file)
  for (const stage of ['open', 'write', 'close', 'rename']) {
    p.reset()
    failure = stage
    await assert.rejects(p.actor.dispatch('change', number(76)), /STATE_/)
    failure = ''
    if (stage === 'close') for (const fd of [...worker.memory.fds.keys()]) worker.memory.closeSync(fd)
    assert.equal(disk.get(file), previous)
    assert.equal((await p.state()).n, 23)
    assert.equal(p.snapshots.length + p.frames.length + p.effects.length, 0)
    assert(p.events.some(e => e.type === 'task-result' && e.reply.result?.status === 'FAILED'))
    assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
    assert.equal(await store.loadState('roundtrip', 'version', programs.basic.stamp), encoded)
    assert(![...disk.keys()].some(key => key.endsWith('.tmp')))
  }
  await p.actor.dispose()
  const q = probe()
  await assert.rejects(q.actor.initialize(programs.basic, options('LIVE_PERSISTENT', 'roundtrip/invalid', '{broken')))
  assert.equal(q.snapshots.length + q.frames.length + q.effects.length + count(q, 'save'), 0)
  assert.equal(disk.has(stateFile('roundtrip/invalid')), false)
  assert.equal(disk.get(file), previous)
  await other.clearState('roundtrip', 'version')
  assert.equal(await other.loadState('roundtrip', 'version', programs.basic.stamp), '')
})

const format2 = load(path.join(root, 'runtime/StateFormat.ets'))
const codec = vera('VeraInterpreter')
const stateMeta = { appId: 'format/version', schemaVersion: 1, vmGeneration: 3, revision: 7, stamp: 'program-λ😀' }
const corruptState = run => assert.throws(run, error => error.code === 'STATE_CORRUPTED')

test('Format 2 roundtrip preserves tagged insertion order, arrays and class identity with SHA-256 over UTF-8', async () => {
  const entries = [['10', ['n', -0]], ['2', ['s', 'λ😀\u0000\\\"']], ['é', ['b', true]],
    ['é', ['z']], ['😀', ['a', [['n', 2], ['n', 1]]]]]
  const value = codec.decodeRuntimeValue(['o', 'AppState#identity', entries])
  const text = format2.encodeStateFile(stateMeta, value)
  const file = JSON.parse(text)
  assert.deepEqual(Object.keys(file), ['format', 'appId', 'schemaVersion', 'vmGeneration', 'revision', 'payloadLength', 'payloadHash', 'stamp', 'value'])
  const payload = format2.canonicalPayload(codec.encodeRuntimeValue(value))
  assert.equal(file.payloadLength, Buffer.byteLength(payload, 'utf8'))
  assert.equal(file.payloadHash, 'sha256:' + crypto.createHash('sha256').update(stateMeta.stamp + '\u0000' + payload, 'utf8').digest('hex'))
  const decoded = format2.decodeStateFile(text, stateMeta.appId)
  assert.equal(decoded.format, 'FORMAT2')
  assert.equal(decoded.vmGeneration, 3)
  assert.equal(decoded.revision, 7)
  assert.equal(decoded.ignoreBackup, false)
  assert.equal(decoded.value.classIdentity, 'AppState#identity')
  assert.deepEqual([...decoded.value.fields.keys()], entries.map(entry => entry[0]))
  assert.deepEqual(decoded.value.fields.get('😀').elements.map(item => item.value), [2, 1])
  assert.equal(Object.is(decoded.value.fields.get('10').value, -0), false)
  assert.equal(format2.encodeStateFile(stateMeta, decoded.value), text)
  const reversed = codec.decodeRuntimeValue(['o', 'AppState#identity', [...entries].reverse()])
  assert.notEqual(format2.encodeStateFile(stateMeta, reversed), text)
  assert.notEqual(codec.formatRuntimeValue(value), codec.formatRuntimeValue(reversed))
  for (const size of [0, 1, 55, 56, 63, 64, 65, 1024, 8192]) {
    const content = 'λ😀'.repeat(size)
    assert.deepEqual(Buffer.from(format2.statePayloadBytes(content)), Buffer.from(content))
    assert.equal(format2.statePayloadHash('stamp', format2.statePayloadBytes(content)),
      'sha256:' + crypto.createHash('sha256').update('stamp\u0000' + content).digest('hex'))
  }
})

test('canonical JSON explicitly sorts properties by UTF-16 but never sorts tagged fields or ordinary arrays', async () => {
  const pairs = [['10', 10], ['2', 2], ['é', 3], ['😀', 4], ['\ue000', 5], ['a', -0]]
  const expected = '{"10":10,"2":2,"a":0,"é":3,"😀":4,"\ue000":5}'
  assert.equal(format2.canonicalPayload(Object.fromEntries(pairs)), expected)
  assert.equal(format2.canonicalPayload(Object.fromEntries([...pairs].reverse())), expected)
  assert.equal(format2.canonicalPayload([2, 1, 'λ', null]), '[2,1,"λ",null]')
  for (const bad of [undefined, () => {}, NaN, Infinity, -Infinity, new Date(), [undefined], new Array(1)]) {
    assert.throws(() => format2.canonicalPayload(bad), error => error.code === 'STATE_VALIDATION_FAILED')
  }
  const cycle = []; cycle.push(cycle)
  assert.throws(() => format2.canonicalPayload(cycle), error => error.code === 'STATE_VALIDATION_FAILED')
  const shared = [1]
  assert.equal(format2.canonicalPayload([shared, shared]), '[[1],[1]]')
})

test('Format 2 detects payload, stamp, length, schema, identity, counter and header corruption', async () => {
  const text = format2.encodeStateFile(stateMeta, codec.decodeRuntimeValue(['s', 'safe']))
  for (const [from, to] of [
    ['"safe"', '"evil"'], ['program-λ😀', 'program-λ😈'], ['"format":2', '"format":3'],
    ['"payloadLength":12', '"payloadLength":13'], ['"schemaVersion":1', '"schemaVersion":2'],
    ['"revision":7', '"revision":-1'], ['"revision":7', '"revision":1.5'],
    ['"revision":7', '"revision":9007199254740991'], ['"revision":7', '"revision":9007199254740992'],
    ['"vmGeneration":3', '"vmGeneration":9007199254740991'],
    ['"format":2,"appId":"format/version"', '"appId":"format/version","format":2']
  ]) {
    assert.notEqual(text.replace(from, to), text, from)
    corruptState(() => format2.decodeStateFile(text.replace(from, to), stateMeta.appId))
  }
  corruptState(() => format2.decodeStateFile(text, 'another/version'))
  corruptState(() => format2.decodeStateFile(text.slice(0, -1), stateMeta.appId))
  corruptState(() => format2.decodeStateFile(text + 'junk', stateMeta.appId))
  corruptState(() => format2.decodeStateFile(text.replace(',"value":', ',"formatVersion":2,"value":'), stateMeta.appId))
  corruptState(() => format2.decodeStateFile(text.replace(',"value":', ',"stamp":"duplicate","value":'), stateMeta.appId))
  for (const field of ['revision', 'vmGeneration']) {
    corruptState(() => format2.encodeStateFile({ ...stateMeta, [field]: Number.MAX_SAFE_INTEGER }, codec.NULL_VALUE))
    const edge = format2.encodeStateFile({ ...stateMeta, [field]: Number.MAX_SAFE_INTEGER - 1 }, codec.NULL_VALUE)
    assert.equal(format2.decodeStateFile(edge, stateMeta.appId)[field], Number.MAX_SAFE_INTEGER - 1)
  }
  corruptState(() => format2.encodeStateFile({ ...stateMeta, stamp: 'bad\u0000stamp' }, codec.NULL_VALUE))
  assert.throws(() => format2.encodeStateFile(stateMeta, new codec.VeraNumberValue(NaN)), error => error.code === 'STATE_VALIDATION_FAILED')
  assert.throws(() => format2.encodeStateFile(stateMeta, new codec.FunctionValue('f', [])), error => error.code === 'STATE_VALIDATION_FAILED')
})

test('header scanner stops before payload and requests full read for oversized or split headers', async () => {
  const text = format2.encodeStateFile(stateMeta, new codec.VeraStringValue('x'.repeat(4096)))
  const prefix = text.slice(0, format2.STATE_HEADER_WINDOW_BYTES)
  const header = format2.readStateHeader(prefix)
  assert.equal(header.kind, 'READY')
  assert.equal(header.header.revision, 7)
  assert.equal(header.stamp, stateMeta.stamp)
  assert.equal(text.slice(header.payloadOffset, header.payloadOffset + 5), '["s",')
  assert.equal(format2.readStateHeader(text.slice(0, header.payloadOffset) + 'not JSON').kind, 'READY')
  for (let end = 0; end < header.payloadOffset; end++) {
    assert.equal(format2.readStateHeader(text.slice(0, end)).kind, 'NEED_MORE', 'prefix ' + end)
  }
  const large = format2.encodeStateFile({ ...stateMeta, stamp: '"\\λ😀'.repeat(600) }, codec.NULL_VALUE)
  assert.equal(format2.readStateHeader(large.slice(0, 1024)).kind, 'NEED_MORE')
  assert.equal(format2.readStateHeader(large, true).kind, 'READY')
  corruptState(() => format2.readStateHeader(large.slice(0, 1024), true))
})

test('Format 2 validates hashes against literal payload bytes rather than reserialized JSON', async () => {
  const payload = '["s","\\u03bb"]'
  const text = format2.assembleStateFile(stateMeta, payload)
  const decoded = format2.decodeStateFile(text, stateMeta.appId)
  assert.equal(decoded.encodedState, payload)
  assert.equal(decoded.value.value, 'λ')
  corruptState(() => format2.decodeStateFile(text.replace('\\u03bb', 'λ'), stateMeta.appId))
  for (const invalid of [' ["z"]', '["z"] ', '[ "z"]', '["z",1]', '{broken']) {
    assert.throws(() => format2.assembleStateFile(stateMeta, invalid), error => error.code === 'STATE_VALIDATION_FAILED')
  }
  const withSpace = format2.assembleStateFile(stateMeta, '["s","space inside"]')
  assert.equal(format2.decodeStateFile(withSpace, stateMeta.appId).value.value, 'space inside')
  cryptoFailure = Error('crypto service unavailable')
  try {
    for (cryptoFailureStage of ['create', 'update1', 'update2', 'digest']) {
      assert.throws(() => format2.decodeStateFile(text, stateMeta.appId), error => error === cryptoFailure)
      assert.throws(() => format2.assembleStateFile(stateMeta, payload), error => error === cryptoFailure)
    }
  } finally { cryptoFailure = null; cryptoFailureStage = 'create' }
})

test('Format 2 and old ProjectStore alternate without state loss; legacy counters are zero and backup is ignored', async () => {
  const value = codec.decodeRuntimeValue(JSON.parse(edited(fresh, { n: 23 })))
  const meta = { ...stateMeta, appId: 'roundtrip/version', stamp: programs.basic.stamp }
  const file = stateFile(meta.appId)
  disk.set(file, format2.encodeStateFile(meta, value))
  const oldRead = await store.loadState('roundtrip', 'version', meta.stamp)
  assert.deepEqual(JSON.parse(oldRead), codec.encodeRuntimeValue(value))
  const mismatch = format2.decodeStateFile(disk.get(file), meta.appId)
  assert.equal(mismatch.stamp, meta.stamp)
  assert.equal(mismatch.revision, meta.revision)
  assert.equal(await store.loadState('roundtrip', 'version', 'new-program'), '')
  disk.set(file, JSON.stringify({ stamp: meta.stamp, value: JSON.parse(oldRead) }))
  disk.set(file + '.bak', 'invalid stale backup')
  const legacy = format2.decodeStateFile(disk.get(file), meta.appId)
  assert.equal(legacy.format, 'LEGACY')
  assert.equal(legacy.vmGeneration, 0)
  assert.equal(legacy.revision, 0)
  assert.equal(legacy.ignoreBackup, true)
  assert.deepEqual(codec.encodeRuntimeValue(legacy.value), codec.encodeRuntimeValue(value))
  const p = probe()
  await p.actor.initialize(programs.basic, options('LIVE_PERSISTENT', meta.appId))
  const restored = format2.decodeStateFile(disk.get(file), meta.appId)
  assert.equal(restored.format, 'FORMAT2')
  assert.equal(restored.revision, 0)
  assert(restored.vmGeneration > 0)
  assert.equal(await p.actor.snapshot(), oldRead)
  assert.equal(count(p, 'publication'), 1)
  assert.equal(count(p, 'save'), 0)
  assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
  await p.actor.dispose()
  for (const bad of [null, {}, ['n'], ['n', null], ['n', '1'], ['s', 3], ['b', 1], ['z', 1],
    ['a', {}], ['o', 1, []], ['o', 'C', [['x', ['z']], ['x', ['z']]]], ['o', 'C', [['x']]], ['f', 'fn']]) {
    corruptState(() => format2.decodeStateFile(JSON.stringify({ stamp: meta.stamp, value: bad }), meta.appId))
  }
  for (const raw of ['null', '[]', '{}', '{broken', '{"stamp":1,"value":["z"]}']) {
    corruptState(() => format2.decodeStateFile(raw, meta.appId))
  }
})

test('actors own independent real VM/state/host; dispose is idempotent and all execution becomes inert', async () => {
  const p = probe()
  await p.actor.initialize(programs.basic, options('LIVE_EPHEMERAL', ''))
  await p.actor.dispatch('change', number(2))
  const q = probe()
  await q.actor.initialize(programs.basic, options('LIVE_EPHEMERAL', ''))
  assert.equal((await q.state()).n, 1)
  await q.actor.dispatch('change', number(8))
  assert.equal((await p.state()).n, 3)
  assert.equal((await q.state()).n, 9)
  assert.equal(p.effects[0].id, q.effects[0].id)
  await p.actor.dispose()
  assert.equal(p.actor.ready(), false)
  p.reset()
  records = p.events
  await p.actor.dispose()
  for (const operation of [
    () => p.actor.initialize(programs.refreshed, options()),
    () => p.actor.replaceProgram(programs.refreshed, options()),
    () => p.actor.promote(options()),
    () => p.actor.resume(),
    () => p.actor.runWidgetRefresh(),
    () => p.actor.dispatch('change', number(5)),
    () => p.actor.move('pointer', pointerValue('move', 0, 1, 2)),
    () => p.actor.frameHandlers(['frameA'], 16),
    () => p.actor.persistState(),
    () => p.actor.notifyStateSnapshot(),
    () => p.actor.snapshot()
  ]) await assert.rejects(operation(), /STATE_UNAVAILABLE/)
  p.actor.beginSurfaceLoop(now)
  p.actor.clearEffects()
  assert.equal(p.actor.view(), null)
  assert.deepEqual(p.actor.draw('draw'), [])
  assert.equal(p.actor.viewDue(now + 10000), false)
  await assert.rejects(p.actor.surfaceSave(now + 10000, false), /STATE_UNAVAILABLE/)
  assert.deepEqual(p.events, [])
  assert.equal((await q.state()).n, 9)
  await q.actor.dispose()
})

test('initial corrupt main and backup commit the actual init once before effects and recovery notification', async () => {
  const program = compile(fixture({ initial: '6 * 7', init: `sdk.call("${target}", ["label", "init"], "answered");` }))
  const file = stateFile()
  disk.set(file, '{broken-main')
  disk.set(file + '.bak', '{broken-backup')
  const p = probe()
  await p.actor.initialize(program, options())
  assert(p.actor.ready())
  assert.deepEqual(await p.state(), { n: 42, calls: 0, refreshes: 0, marks: [], badView: false })
  assert.deepEqual(sequence(p), ['init', 'save', 'snapshot', 'effect:init', 'saved', 'view', 'frame', 'ui-error:state'])
  assert.equal(count(p, 'publication'), 0)
  assert.equal(p.snapshots.length, 1)
  assert.equal(p.frames[0].root.text, 'n=42')
  assert.equal(p.effects.length, 1)
  assert.equal(p.effects[0].target, target)
  assert.equal(p.effects[0].handler, 'answered')
  assert.equal(count(p, 'stop'), 0)
  const saved = format2.validateStateFile(disk.get(file), 'project/version')
  assert.equal(saved.stamp, program.stamp)
  assert.equal(saved.revision, 1)
  assert.equal(saved.encodedState, await p.actor.snapshot())
  assert.deepEqual(p.events.filter(e => e.type === 'quarantine').map(e => [e.file, disk.get(e.to)]), [[file, '{broken-main'], [file + '.bak', '{broken-backup']])
  assert.deepEqual(p.events.filter(e => e.type === 'task-submit').map(e => e.request.kind), ['load', 'recoverLost', 'commit'])
  assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
  assert.doesNotThrow(() => store.assertStateAdmission('project/version'))
  p.reset()
  await p.actor.dispatch('change', number(1))
  assert.equal((await p.state()).n, 43)
  assert.equal(count(p, 'ui-error'), 0)
  assert.deepEqual(entries(p), ['change', 'view'])
  await p.actor.dispose()
})

async function withoutVmJournal(run) {
  const file = store.stateRoot() + '/runtime-flags.json'
  const previous = disk.get(file)
  disk.set(file, JSON.stringify({ vmJournal: 'off', journalMode: 'JOURNAL' }))
  try {
    assert.deepEqual(store.runtimeFlags(), { vmJournal: false, journalMode: 'JOURNAL' })
    await run()
  } finally {
    if (previous === undefined) disk.delete(file)
    else disk.set(file, previous)
    assert.equal(store.runtimeFlags().vmJournal, previous === undefined ? true : JSON.parse(previous).vmJournal === 'on')
  }
}
const mutatedRecoveryInit = `
  let state: AppState = {n: 6, calls: 0, refreshes: 0, marks: [], badView: false};
  state.n = state.n * 7;
  state.calls = state.calls + 1;
  state.marks.push(state.n);
  ${effect('init')}
`

test('vmJournal:false LOST recovery commits the actual mutated init once before any publication or success notification', async () => {
  await withoutVmJournal(async () => {
    const key = 'no-journal-recovery-success/version'
    const file = stateFile(key)
    const program = compile(fixture({ init: mutatedRecoveryInit, initResult: 'state' }))
    disk.set(file, '{broken-main')
    disk.set(file + '.bak', '{broken-backup')
    const p = probe({ diagnostics: true })
    worker.taskpool.plans.push({}, {}, { hold: true })
    const initializing = p.actor.initialize(program, options('LIVE_PERSISTENT', key))
    try {
      await turnMicrotasks()
      const held = worker.taskpool.executions.find(entry => !entry.finished && entry.args[2].kind === 'commit')
      assert(held, 'actual init waits for its real TaskPool commit')
      assert.deepEqual(entries(p), ['init'])
      assert.equal(p.events.filter(e => e.type === 'diagnostic' && e.event === 'VM_EXECUTE' && e.attributes.entryCategory === 'INIT').length, 1)
      assert.equal(p.snapshots.length + p.frames.length + p.effects.length + count(p, 'save') + count(p, 'saved') + count(p, 'publication'), 0)
      assert(!p.events.some(e => e.message === 'STATE_RECOVERY'))
      assert.equal(disk.has(file), false)
      assert.throws(() => store.assertStateAdmission(key), /admission fenced/)
      worker.taskpool.finish(held)
      await initializing
      assert(p.actor.ready())
      const expected = { n: 42, calls: 1, refreshes: 0, marks: [42], badView: false }
      assert.deepEqual(await p.state(), expected)
      assert.deepEqual(sequence(p), ['init', 'save', 'snapshot', 'effect:init', 'saved', 'view', 'frame', 'ui-error:state'])
      assert.equal(p.snapshots.length, 1)
      assert.deepEqual(stateOf(p.snapshots[0]), expected)
      assert.equal(p.frames[0].root.text, 'n=42')
      assert.equal(p.effects.length, 1)
      assert.deepEqual(p.effects[0].params, [['label', 'init'], ['value', '42']])
      assert.equal(p.effects[0].target, target)
      assert.equal(p.effects[0].handler, 'answered')
      assert.deepEqual(p.events.filter(e => e.type === 'ui-error'), [{ type: 'ui-error', kind: 'state', message: 'STATE_RECOVERY' }])
      assert.equal(count(p, 'stop') + count(p, 'publication'), 0)
      const saved = format2.validateStateFile(disk.get(file), key)
      assert.equal(saved.stamp, program.stamp)
      assert.equal(saved.revision, 1)
      assert.equal(saved.encodedState, await p.actor.snapshot())
      assert.deepEqual(p.events.filter(e => e.type === 'quarantine').map(e => [e.file, disk.get(e.to)]), [[file, '{broken-main'], [file + '.bak', '{broken-backup']])
      assert.deepEqual(p.events.filter(e => e.type === 'task-result' && e.reply.load).map(e => e.reply.load.kind), ['LOST', 'ABSENT'])
      assert.deepEqual(p.events.filter(e => e.type === 'task-submit').map(e => e.request.kind), ['load', 'recoverLost', 'commit'])
      assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
      assert(p.events.some(e => e.type === 'diagnostic' && e.event === 'VM_SAFETY_SWITCH' && e.attributes.safety === false))
      assert.equal(p.events.filter(e => e.type === 'diagnostic' && e.event === 'VM_EXECUTE' && e.attributes.entryCategory === 'INIT').length, 1)
      assert(!p.events.some(e => e.type === 'diagnostic' && e.event === 'VM_JOURNAL'))
      assert.doesNotThrow(() => store.assertStateAdmission(key))
    } finally {
      for (const held of worker.taskpool.executions.filter(entry => !entry.finished)) worker.taskpool.finish(held)
      await initializing.catch(() => {})
      await p.actor.dispose()
    }
  })
})

for (const ending of ['trap', 'commit-refusal']) {
  test('vmJournal:false LOST recovery ' + ending + ' after mutated init fails closed without rollback, publication or retry and retains its fence', async () => {
    await withoutVmJournal(async () => {
      const key = 'no-journal-recovery-' + ending + '/version'
      const file = stateFile(key)
      const program = compile(fixture({ init: mutatedRecoveryInit + (ending === 'trap' ? trap : ''), initResult: 'state' }))
      disk.set(file, '{broken-main')
      disk.set(file + '.bak', '{broken-backup')
      let rule
      if (ending === 'commit-refusal') {
        worker.memory.fail('write', event => event.path.startsWith(file + '.') && event.path.endsWith('.tmp'))
        rule = worker.memory.rules[worker.memory.rules.length - 1]
      }
      const p = probe({ diagnostics: true })
      try {
        await assert.rejects(p.actor.initialize(program, options('LIVE_PERSISTENT', key)), ending === 'trap' ? /array index out of bounds/ : /STATE_WRITE_FAILED/)
        if (rule) assert.equal(rule.remaining, 0)
        assert.equal(p.actor.ready(), false)
        assert.equal(await p.actor.snapshot(), '')
        assert.equal(p.actor.view(), null)
        assert.deepEqual(entries(p), ['init'])
        assert.equal(p.snapshots.length + p.frames.length + p.effects.length + count(p, 'save') + count(p, 'saved') + count(p, 'publication'), 0)
        assert.equal(disk.has(file), false)
        assert.equal(disk.has(file + '.bak'), false)
        assert.deepEqual(p.events.filter(e => e.type === 'quarantine').map(e => [e.file, disk.get(e.to)]), [[file, '{broken-main'], [file + '.bak', '{broken-backup']])
        assert(![...disk.keys()].some(name => name.endsWith('.tmp')))
        assert.equal(count(p, 'ui-error'), 1)
        assert.equal(p.events.find(e => e.type === 'ui-error').kind, ending === 'trap' ? 'init' : 'state')
        assert(!p.events.some(e => e.message === 'STATE_RECOVERY'))
        assert.deepEqual(p.events.filter(e => e.type === 'task-result' && e.reply.load).map(e => e.reply.load.kind), ['LOST', 'ABSENT'])
        assert.deepEqual(p.events.filter(e => e.type === 'task-submit').map(e => e.request.kind), ending === 'trap' ? ['load', 'recoverLost'] : ['load', 'recoverLost', 'commit'])
        assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
        if (rule) assert(p.events.some(e => e.type === 'task-result' && e.reply.result?.status === 'FAILED' && e.reply.result.code === 'STATE_WRITE_FAILED'))
        assert(p.events.some(e => e.type === 'diagnostic' && e.event === 'VM_SAFETY_SWITCH' && e.attributes.safety === false))
        const executions = p.events.filter(e => e.type === 'diagnostic' && e.event === 'VM_EXECUTE' && e.attributes.entryCategory === 'INIT')
        assert.equal(executions.length, 1)
        assert.equal(executions[0].attributes.outcome, ending === 'trap' ? 'TRAP' : 'OK')
        assert(p.events.some(e => e.type === 'diagnostic' && e.event === 'VM_ROLLBACK_SKIPPED' && e.attributes.stage === 'turn-refusal'))
        assert(p.events.some(e => e.type === 'diagnostic' && e.event === 'STATE_MUTATION_REFUSED' && e.attributes.stage === 'safety-off'))
        assert(!p.events.some(e => e.type === 'diagnostic' && e.event === 'VM_JOURNAL'))
        assert.throws(() => store.assertStateAdmission(key), /admission fenced/)
        p.reset()
        await p.actor.dispatch('change', number(5))
        await p.actor.resume()
        await p.actor.notifyStateSnapshot()
        assert.equal(await p.actor.persistState(), false)
        assert.equal(await p.actor.snapshot(), '')
        await assert.rejects(p.actor.initialize(program, options('LIVE_PERSISTENT', key)), /admission fenced/)
        assert.deepEqual(p.events, [])
        await p.actor.dispose()
        assert.throws(() => store.assertStateAdmission(key), /admission fenced/)
        const q = probe()
        try {
          await assert.rejects(q.actor.initialize(programs.basic, options('LIVE_PERSISTENT', key)), /admission fenced/)
          assert.deepEqual(q.events, [])
          assert.equal(q.actor.ready(), false)
        } finally { await q.actor.dispose() }
      } finally {
        if (rule) worker.memory.rules.splice(worker.memory.rules.indexOf(rule), 1)
        await p.actor.dispose()
      }
    })
  })
}

test('initial corrupt disk carries seed into new defaults once and refreshes only after recovery commit', async () => {
  const seed = edited(fresh, { n: 7, calls: 3 })
  const file = stateFile()
  disk.set(file, '{broken')
  const p = probe()
  await p.actor.initialize(programs.newer, options('LIVE_PERSISTENT', 'project/version', seed))
  assert(p.actor.ready())
  assert.deepEqual(await p.state(), { n: 17, calls: 3, refreshes: 1, marks: [], badView: false, added: 42 })
  assert.deepEqual(entries(p), ['init', 'view', 'widgetRefresh', 'view'])
  assert.deepEqual(p.snapshots.map(encoded => stateOf(encoded)), [
    { n: 7, calls: 3, refreshes: 0, marks: [], badView: false, added: 42 },
    { n: 17, calls: 3, refreshes: 1, marks: [], badView: false, added: 42 }
  ])
  assert.deepEqual(sequence(p), ['init', 'save', 'snapshot', 'saved', 'view', 'frame', 'ui-error:state', 'widgetRefresh', 'save', 'snapshot', 'effect:refresh', 'saved', 'view', 'frame'])
  assert.deepEqual(p.frames.map(frame => frame.root.text), ['n=7', 'n=17'])
  assert.equal(count(p, 'stop'), 0)
  assert.equal(p.events.filter(e => e.type === 'ui-error' && e.message === 'STATE_RECOVERY').length, 1)
  const saved = format2.validateStateFile(disk.get(file), 'project/version')
  assert.equal(saved.revision, 2)
  assert.equal(saved.encodedState, await p.actor.snapshot())
  assert.equal(await store.loadState('project', 'version', programs.newer.stamp), saved.encodedState)
  assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
  await p.actor.dispose()
})

test('initial recovery init and carry failures discard queued effects without publishing a placeholder', async () => {
  const initEffectTrap = compile(fixture({ init: `sdk.call("${target}", ["label", "init-fail"], "answered"); let empty: number[] = []; let n: number = empty[2];` }))
  const cases = [
    { program: programs.initTrap, seed: '', error: /array index out of bounds/, kind: 'init' },
    { program: initEffectTrap, seed: '', error: /array index out of bounds/, kind: 'init' },
    { program: programs.initEffect, seed: edited(fresh, { n: -4 }), error: /array index out of bounds/, kind: 'carry' }
  ]
  for (const [index, scenario] of cases.entries()) {
    disk.clear()
    const key = 'failed-init-recovery-' + index + '/version'
    const file = stateFile(key)
    disk.set(file, '{broken')
    const p = probe()
    await assert.rejects(p.actor.initialize(scenario.program, options('LIVE_PERSISTENT', key, scenario.seed)), scenario.error)
    assert.equal(p.actor.ready(), false)
    assert.equal(await p.actor.snapshot(), '')
    assert.equal(p.actor.view(), null)
    assert.deepEqual(entries(p), ['init'])
    assert.equal(p.snapshots.length + p.frames.length + p.effects.length + count(p, 'saved') + count(p, 'save') + count(p, 'publication'), 0)
    assert.equal(disk.has(file), false)
    assert.equal(disk.has(file + '.bak'), false)
    assert.equal(count(p, 'quarantine'), 1)
    assert.equal(disk.get(p.events.find(e => e.type === 'quarantine').to), '{broken')
    assert.equal(count(p, 'ui-error'), 1)
    assert.equal(p.events.find(e => e.type === 'ui-error').kind, scenario.kind)
    assert(!p.events.some(e => e.message === 'STATE_RECOVERY'))
    assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
    assert.throws(() => store.assertStateAdmission(key), /admission fenced/)
    p.reset()
    await p.actor.dispatch('change', number(5))
    assert.equal(p.snapshots.length + p.frames.length + p.effects.length + count(p, 'save'), 0)
    await assert.rejects(p.actor.initialize(programs.basic, options('LIVE_PERSISTENT', key)), /admission fenced/)
    assert.equal(count(p, 'task-submit'), 0)
    await p.actor.dispose()
  }
})

test('initial recovery commit failure publishes no state, effects or success notification and retains its fence', async () => {
  const key = 'failed-commit-recovery/version'
  const file = stateFile(key)
  disk.set(file, '{broken')
  worker.memory.fail('write', event => event.path.startsWith(file + '.') && event.path.endsWith('.tmp'))
  const rule = worker.memory.rules[worker.memory.rules.length - 1]
  const p = probe()
  await assert.rejects(p.actor.initialize(programs.initEffect, options('LIVE_PERSISTENT', key)), /STATE_WRITE_FAILED/)
  assert.equal(rule.remaining, 0)
  assert.equal(p.actor.ready(), false)
  assert.equal(await p.actor.snapshot(), '')
  assert.deepEqual(entries(p), ['init'])
  assert.equal(p.snapshots.length + p.frames.length + p.effects.length + count(p, 'save') + count(p, 'saved') + count(p, 'publication'), 0)
  assert.equal(disk.has(file), false)
  assert.equal(disk.has(file + '.bak'), false)
  assert.equal(count(p, 'quarantine'), 1)
  assert.equal(count(p, 'ui-error'), 1)
  assert(!p.events.some(e => e.message === 'STATE_RECOVERY'))
  assert(![...disk.keys()].some(name => name.endsWith('.tmp')))
  assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
  assert.throws(() => store.assertStateAdmission(key), /admission fenced/)
  await p.actor.dispose()
})

test('initial recovery rechecks a valid disk race and restores it without reset, seed, init or quarantine', async () => {
  const file = stateFile()
  const encoded = edited(fresh, { n: 91, calls: 8 })
  const valid = format2.assembleStateFile({ appId: 'project/version', schemaVersion: 1,
    vmGeneration: 4, revision: 7, stamp: programs.initEffect.stamp }, encoded)
  disk.set(file, '{broken')
  let raced = false
  worker.taskpool.plans.push({ reply(reply) {
    assert.equal(reply.load.kind, 'LOST')
    disk.set(file, valid)
    raced = true
    return reply
  } })
  const p = probe()
  await p.actor.initialize(programs.initEffect, options('LIVE_PERSISTENT', 'project/version', '{broken-seed'))
  assert(raced)
  assert(p.actor.ready())
  assert.equal(await p.actor.snapshot(), encoded)
  assert.deepEqual(entries(p), ['restore', 'view'])
  assert.deepEqual(sequence(p), ['restore', 'snapshot', 'view', 'frame', 'ui-error:state'])
  assert.equal(p.frames[0].root.text, 'n=91')
  assert.equal(p.effects.length + count(p, 'save') + count(p, 'saved') + count(p, 'quarantine') + count(p, 'stop'), 0)
  assert.equal(count(p, 'publication'), 1)
  const saved = format2.validateStateFile(disk.get(file), 'project/version')
  assert.equal(saved.revision, 7)
  assert.equal(saved.vmGeneration, 5)
  assert.equal(saved.encodedState, encoded)
  assert.deepEqual(p.events.filter(e => e.type === 'task-submit').map(e => e.request.kind), ['load', 'recoverLost', 'publishGeneration'])
  assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
  assert.doesNotThrow(() => store.assertStateAdmission('project/version'))
  await p.actor.dispose()
})

test('unavailable initial disk never grants recovery or quarantines and can retry normally', async () => {
  for (const stage of ['stat', 'open', 'read']) {
    disk.clear()
    const key = 'unavailable-initial-' + stage + '/version'
    const file = stateFile(key)
    disk.set(file, '{broken')
    disk.set(file + '.bak', '{broken-backup')
    worker.memory.fail(stage, event => event.path === file)
    const rule = worker.memory.rules[worker.memory.rules.length - 1]
    const p = probe()
    await assert.rejects(p.actor.initialize(programs.initEffect, options('LIVE_PERSISTENT', key)), /STATE_READ_FAILED/)
    assert.equal(rule.remaining, 0)
    assert.equal(p.actor.ready(), false)
    assert.equal(await p.actor.snapshot(), '')
    assert.deepEqual(entries(p), [])
    assert.equal(p.snapshots.length + p.frames.length + p.effects.length + count(p, 'save') + count(p, 'saved') + count(p, 'quarantine'), 0)
    assert.equal(disk.get(file), '{broken')
    assert.equal(disk.get(file + '.bak'), '{broken-backup')
    assert.deepEqual(p.events.filter(e => e.type === 'task-submit').map(e => e.request.kind), ['load'])
    assert.equal(count(p, 'ui-error'), 1)
    assert.equal(p.events.find(e => e.type === 'ui-error').kind, 'state')
    assert(!p.events.some(e => e.message === 'STATE_RECOVERY'))
    assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
    assert.doesNotThrow(() => store.assertStateAdmission(key))
    disk.delete(file)
    disk.delete(file + '.bak')
    p.reset()
    await p.actor.initialize(programs.basic, options('LIVE_PERSISTENT', key))
    assert(p.actor.ready())
    assert.equal(await p.actor.snapshot(), fresh)
    assert.equal(count(p, 'quarantine'), 0)
    noErrors(p)
    await p.actor.dispose()
  }
})

test('unavailable recovery recheck preserves corrupt files without quarantine, init or notification', async () => {
  const key = 'unavailable-recovery-recheck/version'
  const file = stateFile(key)
  disk.set(file, '{broken')
  disk.set(file + '.bak', '{broken-backup')
  let rule
  worker.taskpool.plans.push({ reply(reply) {
    assert.equal(reply.load.kind, 'LOST')
    worker.memory.fail('read', event => event.path === file)
    rule = worker.memory.rules[worker.memory.rules.length - 1]
    return reply
  } })
  const p = probe()
  await assert.rejects(p.actor.initialize(programs.initEffect, options('LIVE_PERSISTENT', key)), /STATE_READ_FAILED/)
  assert.equal(rule.remaining, 0)
  assert.equal(p.actor.ready(), false)
  assert.equal(await p.actor.snapshot(), '')
  assert.deepEqual(entries(p), [])
  assert.equal(p.snapshots.length + p.frames.length + p.effects.length + count(p, 'save') + count(p, 'saved') + count(p, 'quarantine'), 0)
  assert.equal(disk.get(file), '{broken')
  assert.equal(disk.get(file + '.bak'), '{broken-backup')
  assert.deepEqual(p.events.filter(e => e.type === 'task-submit').map(e => e.request.kind), ['load', 'recoverLost'])
  assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
  assert.equal(count(p, 'ui-error'), 1)
  assert.equal(p.events.find(e => e.type === 'ui-error').kind, 'state')
  assert(!p.events.some(e => e.message === 'STATE_RECOVERY'))
  assert.throws(() => store.assertStateAdmission(key), /admission fenced/)
  await p.actor.dispose()
})

test('public pending initialization rejects promotion before tracking and lets recovery and queued input settle', async () => {
  const key = 'pending-init-promotion/version'
  disk.set(stateFile(key), '{broken')
  const p = probe()
  const initializing = p.actor.initialize(programs.basic, options('LIVE_PERSISTENT', key))
  const promoting = assert.rejects(p.actor.promote(options('LIVE_PERSISTENT', key)), turnError('STATE_TURN_PENDING', 'state'))
  const input = p.actor.dispatch('change', number(2))
  await turnBounded(Promise.all([initializing, promoting, input]))
  assert(p.actor.ready())
  assert.equal((await p.state()).n, 3)
  assert.deepEqual(entries(p), ['init', 'view', 'change', 'view'])
  assert.equal(count(p, 'quarantine'), 1)
  assert.equal(count(p, 'save'), 2)
  assert.equal(p.events.filter(e => e.message === 'STATE_RECOVERY').length, 1)
  assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
  assert.doesNotThrow(() => store.assertStateAdmission(key))
  await turnBounded(p.actor.promote(options('LIVE_EPHEMERAL', '')))
  assert.equal((await p.state()).n, 3)
  await p.actor.dispose()
})

test('different-key queued initializations recover without dependencies and retain the exact pending admission count', async () => {
  const firstKey = 'queued-init-first/version', secondKey = 'queued-init-second/version'
  disk.set(stateFile(firstKey), '{broken-first')
  disk.set(stateFile(secondKey), '{broken-second')
  const p = probe()
  worker.taskpool.plans.push({}, {}, {}, { hold: true })
  const first = p.actor.initialize(programs.basic, options('LIVE_PERSISTENT', firstKey))
  const second = p.actor.initialize(programs.basic, options('LIVE_PERSISTENT', secondKey))
  await turnBounded(assert.rejects(p.actor.initialize(programs.basic, options('LIVE_PERSISTENT', firstKey)), /activation already pending/))
  await turnBounded(first)
  await turnMicrotasks()
  const held = worker.taskpool.executions.find(entry => !entry.finished && entry.args[2].appId === secondKey)
  assert(held, 'second initialization remains pending after the first settles')
  assert.equal(held.args[2].kind, 'load')
  await turnBounded(assert.rejects(p.actor.promote(options('LIVE_PERSISTENT', firstKey)), turnError('STATE_TURN_PENDING', 'state')))
  assert.equal(count(p, 'quarantine'), 1)
  worker.taskpool.finish(held)
  await turnBounded(second)
  assert(p.actor.ready())
  assert.equal(await p.actor.snapshot(), fresh)
  assert.equal(count(p, 'quarantine'), 2)
  assert.equal(p.events.filter(e => e.message === 'STATE_RECOVERY').length, 2)
  assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
  assert.doesNotThrow(() => store.assertStateAdmission(firstKey))
  assert.doesNotThrow(() => store.assertStateAdmission(secondKey))
  await turnBounded(p.actor.promote(options('LIVE_EPHEMERAL', '')))
  assert.equal(await p.actor.snapshot(), fresh)
  await p.actor.dispose()
})

test('failed initialization releases its pending count and admits a later successful promotion', async () => {
  const p = probe()
  await assert.rejects(p.actor.initialize(programs.basic, options('LIVE_PERSISTENT', 'invalid')), /Invalid project state identity/)
  await assert.rejects(p.actor.promote(options('LIVE_EPHEMERAL', '')), turnError('ACTOR_NOT_READY', 'state'))
  await assert.rejects(p.actor.initialize(programs.initTrap, options('LIVE_EPHEMERAL', '')), /array index out of bounds/)
  await p.actor.initialize(programs.basic, options('PREVIEW', ''))
  await turnBounded(p.actor.promote(options('LIVE_PERSISTENT', 'after-failed-init/version')))
  assert(p.actor.ready())
  assert.equal(await p.actor.snapshot(), fresh)
  await p.actor.dispose()
})

test('recovery notification cancellation or disposal rejects activation and retains its fence after commit', async () => {
  for (const ending of ['cancel', 'dispose']) {
    const key = 'recovery-callback-' + ending + '/version'
    disk.set(stateFile(key), '{broken')
    let disposal
    const p = probe({ onError(kind, message, actor) {
      if (kind !== 'state' || message !== 'STATE_RECOVERY') return
      assert(actor.ready())
      assert.throws(() => store.assertStateAdmission(key), /admission fenced/)
      if (ending === 'dispose') disposal = actor.dispose()
      else actor.cancel()
    } })
    await turnBounded(assert.rejects(p.actor.initialize(programs.refreshed, options('LIVE_PERSISTENT', key)),
      turnError('STATE_COMMIT_UNCERTAIN', 'state')))
    if (disposal) await turnBounded(disposal)
    assert.equal(p.actor.ready(), false)
    assert.equal(p.actor.view(), null)
    assert.deepEqual(entries(p), ['init', 'view'])
    assert.equal(count(p, 'save'), 1)
    assert.equal(p.snapshots.length, 1)
    assert.equal(p.frames.length, 1)
    assert.equal(p.effects.length, 0)
    assert.equal(p.events.filter(e => e.message === 'STATE_RECOVERY').length, 1)
    assert.equal(count(p, 'ui-error'), 1)
    assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
    assert.equal(format2.validateStateFile(disk.get(stateFile(key)), key).encodedState, fresh)
    assert.throws(() => store.assertStateAdmission(key), /admission fenced/)
    const q = probe()
    await turnBounded(assert.rejects(q.actor.initialize(programs.basic, options('LIVE_PERSISTENT', key)), /admission fenced/))
    assert.equal(count(q, 'task-submit'), 0)
    await q.actor.dispose()
    await p.actor.dispose()
  }
})

const legacyTestCount = tests.length
const { AppActorTurnCoordinator, AppActorTurnError } = load(path.join(root, 'runtime/AppActor.ets'))
const { StateManager, StateManagerError } = load(path.join(root, 'runtime/StateManager.ets'))
const { CommitPolicy } = load(path.join(root, 'runtime/CommitPolicy.ets'))
const { UiHostEnvironment, decodeVeraUi } = vera('VeraUi')
const coordinatedProgram = compile(fixture() + `
function quiet(state: AppState, value: number): AppState {
  state.n = state.n + value;
  state.calls = state.calls + 1;
  state.marks.push(value);
  return state;
}
function swap(state: AppState, value: number): AppState {
  state.n = state.n + value;
  state.marks.push(value);
  ${effect('swap')}
  return {n: state.n, calls: state.calls + 1, refreshes: state.refreshes, marks: [value], badView: false};
}
function freshPure(): number[] {
  let values: number[] = [1];
  values.push(2);
  values[0] = 3;
  return values;
}
function mutateArray(values: number[]): number[] {
  values.push(99);
  return values;
}
function mutateView(state: AppState): ui.View {
  state.n = state.n + 100;
  return ui.Text("body", "mutated");
}
function mutateMarks(state: AppState): ui.View {
  state.marks.push(99);
  return ui.Text("body", "mutated");
}
function replaceMarks(state: AppState, value: number): AppState {
  state.marks = [value];
  return state;
}
`)
const turnCall = (entry, args = [], useState = true) => ({ entry, args, useState })
const turnError = (code, kind, acceptance) => error => {
  assert(error instanceof AppActorTurnError, 'coordinator reports a typed AppActorTurnError')
  if (code !== undefined) assert.equal(error.code, code)
  assert.equal(error.message, error.code)
  if (kind !== undefined) assert.equal(error.kind, kind)
  if (acceptance !== undefined) assert.deepEqual(error.acceptance, acceptance)
  return true
}
function turnDeferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function turnBounded(promise, budget = 1000) {
  let settled = false, result, failure
  Promise.resolve(promise).then(value => { settled = true; result = value }, error => { settled = true; failure = error })
  for (let i = 0; i < budget && !settled; i++) await Promise.resolve()
  assert(settled, 'coordinator operation settles within a deterministic microtask budget')
  if (failure) throw failure
  return result
}
async function turnMicrotasks() {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}
class TurnStorage {
  constructor(events) {
    this.events = events
    this.text = null
    this.requests = []
    this.plans = []
    this.closed = false
    this.loads = 0
    this.publications = 0
    this.ids = new Set()
  }
  async load(appId, stamp) {
    assert.equal(appId, 'coordinator/version')
    assert.equal(stamp, coordinatedProgram.stamp)
    assert(!this.closed)
    this.loads++
    if (this.text === null) return { kind: 'ABSENT' }
    const decoded = format2.validateStateFile(this.text, appId)
    return { kind: 'READY', format: 'FORMAT2', source: 'MAIN', stamp: decoded.stamp,
      encodedState: decoded.encodedState, header: decoded.header, matchingStamp: decoded.stamp === stamp }
  }
  async readHeader(appId) {
    assert(!this.closed)
    return this.text === null ? null : format2.validateStateFile(this.text, appId).header
  }
  hold(result) {
    const gate = turnDeferred(), started = turnDeferred()
    this.plans.push({ gate, started, result })
    return { gate, started }
  }
  async commit(request) {
    assert(!this.closed)
    assert(!this.ids.has(request.operationId))
    this.ids.add(request.operationId)
    const owned = structuredClone(request, { transfer: [request.payload] })
    assert.equal(request.payload.byteLength, 0)
    const encoded = Buffer.from(owned.payload).toString('utf8')
    format2.validateEncodedState(encoded)
    assert.equal(owned.pre.appId, 'coordinator/version')
    assert.equal(owned.stamp, coordinatedProgram.stamp)
    assert.equal(owned.schemaVersion, 1)
    assert.equal(typeof owned.backupDue, 'boolean')
    const base = this.text === null ? { vmGeneration: 1, revision: 0 } :
      format2.validateStateFile(this.text, owned.pre.appId).header
    assert.equal(owned.pre.vmGeneration, base.vmGeneration)
    assert.equal(owned.pre.baseRevision, base.revision)
    this.requests.push(owned)
    this.events.push({ type: 'commit-start', encoded })
    const plan = this.plans.shift()
    if (plan) { plan.started.resolve(); await plan.gate.promise }
    const result = plan && plan.result || { status: 'COMMITTED', revision: base.revision + 1, backup: 'SKIPPED' }
    if (result.status === 'COMMITTED') {
      assert.equal(result.revision, base.revision + 1)
      this.text = format2.assembleStateFile({ appId: owned.pre.appId, schemaVersion: owned.schemaVersion,
        vmGeneration: owned.pre.vmGeneration, revision: result.revision, stamp: owned.stamp }, encoded)
    }
    this.events.push({ type: 'commit-finish', result })
    return { operationId: owned.operationId, result }
  }
  async publishGeneration(request) {
    assert(!this.closed)
    this.publications++
    const previous = format2.validateStateFile(this.text, request.appId)
    assert.equal(request.expectedRevision, previous.header.revision)
    assert.equal(request.expectedStamp, previous.stamp)
    assert.equal(request.expectedSource, 'MAIN')
    assert.equal(request.nextVmGeneration, previous.header.vmGeneration + 1)
    this.text = format2.assembleStateFile({ appId: request.appId, schemaVersion: 1,
      vmGeneration: request.nextVmGeneration, revision: previous.header.revision,
      stamp: previous.stamp }, previous.encodedState)
    return { operationId: request.operationId,
      result: { status: 'COMMITTED', revision: previous.header.revision, backup: 'SKIPPED' } }
  }
  async whenIdle() {}
  async close() { this.closed = true }
}
async function turnProbe({ mode = 'LIVE_PERSISTENT', initialize = true, render, snapshot, effects, onError,
    policy = new CommitPolicy(), storageText = null } = {}) {
  const events = [], snapshots = [], deliveries = [], frames = [], errors = [], scopes = []
  const storage = new TurnStorage(events)
  storage.text = storageText
  const host = new UiHostEnvironment()
  const vm = new codec.VirtualMachine(codec.deserializeVbc2(coordinatedProgram.vbc2), host, 5000000,
    { now: () => now, deadlineMs: 1000 }, { journalMode: 'JOURNAL' })
  const guard = { coverage: vm.coverage, beginTurn(tx, rootValue) {
    const scope = vm.beginTurn(tx, rootValue)
    scopes.push('begin')
    return Object.fromEntries(['accept', 'rollback', 'discard'].map(kind => [kind, () => {
      scopes.push(kind)
      return scope[kind]()
    }]))
  } }
  const managerOptions = { appId: 'coordinator/version', stamp: coordinatedProgram.stamp, mode,
    stateMaxBytes: 100000, initialState: codec.NULL_VALUE, storage, rollbackGuard: guard, policy, now: () => now }
  const state = new StateManager(managerOptions)
  const loaded = await state.load()
  assert.equal(loaded.kind, mode === 'LIVE_PERSISTENT' ? storageText === null ? 'ABSENT' : 'READY' : 'IN_MEMORY')
  if (mode === 'LIVE_PERSISTENT') assert(['UNCHANGED', 'COMMITTED'].includes((await state.publishGeneration()).status))
  let actor
  const callbacks = {
    snapshot(value) {
      assert.equal(actor.phase(), 'PUBLISHING')
      assert.equal(host.effectsAllowed, false)
      assert.deepEqual(host.pendingEffects, [])
      stateOf(value.encoded)
      snapshots.push(value)
      events.push({ type: 'snapshot', value })
      if (snapshot) snapshot(value, actor)
    },
    effects(value) {
      assert.equal(actor.phase(), 'PUBLISHING')
      assert.equal(host.effectsAllowed, false)
      assert.deepEqual(host.pendingEffects, [])
      deliveries.push(value)
      events.push({ type: 'effects', value })
      if (effects) effects(value, actor)
    },
    render(version, pure) {
      assert.equal(actor.phase(), 'PUBLISHING')
      assert.equal(host.effectsAllowed, false)
      events.push({ type: 'render', version })
      const nodes = decodeVeraUi(pure(turnCall('view')))
      frames.push(nodes)
      if (render) return render(version, pure, actor)
    },
    error(error) {
      assert(error instanceof AppActorTurnError)
      errors.push(error)
      events.push({ type: 'error', error })
      if (onError) onError(error)
    }
  }
  actor = new AppActorTurnCoordinator(state, vm, host, mode, policy, callbacks)
  const p = { actor, state, host, vm, storage, events, snapshots, deliveries, frames, errors, scopes,
    managerOptions, callbacks, policy,
    run: (entry, value = 1, source = 'INPUT', persist = true) => actor.runTurn(source, persist, [turnCall(entry, [number(value)])]),
    value: () => unpack(codec.encodeRuntimeValue(state.getWorkingState())),
    reset() { events.length = snapshots.length = deliveries.length = frames.length = errors.length = scopes.length = 0 }
  }
  if (initialize) {
    const accepted = await actor.runTurn('INIT', true, [turnCall('init', [], false)])
    assert.equal(accepted.status, mode === 'LIVE_PERSISTENT' ? 'COMMITTED' : 'IN_MEMORY')
    assert.equal(actor.phase(), 'READY')
    p.reset()
  }
  return p
}
const turnSequence = p => p.events.map(event => event.type)
const turnClean = p => {
  assert.equal(p.actor.phase(), 'READY')
  assert.equal(p.host.effectsAllowed, false)
  assert.deepEqual(p.host.pendingEffects, [])
  assert.equal(p.state.status().pendingOperations, 0)
}

test('coordinator PREVIEW admits only init/carry and never publishes, persists or delivers effects', async () => {
  const p = await turnProbe({ mode: 'PREVIEW', initialize: false })
  assert.equal(p.host.effectsAllowed, false)
  assert.equal((await p.actor.runTurn('INIT', true, [turnCall('init', [], false)])).status, 'IN_MEMORY')
  assert.equal((await p.run('quiet', 2, 'CARRY')).status, 'IN_MEMORY')
  assert.equal(p.value().n, 3)
  assert.equal(decodeVeraUi(p.actor.pure(turnCall('view')))[0].text, 'n=3')
  for (const source of ['INPUT', 'EFFECT_RESULT', 'TICK', 'SURFACE', 'MOVE']) {
    await assert.rejects(p.run('change', 5, source), turnError('STATE_PREVIEW_SUPPRESSED', 'handler', null))
  }
  await assert.rejects(p.actor.snapshotBarrier(), turnError('STATE_PREVIEW_SUPPRESSED', 'state', null))
  const before = p.state.captureWorkingSnapshot()
  await assert.rejects(p.run('change', 4, 'CARRY'), error => error.trapCode === 'R0026')
  assert.equal(p.state.captureWorkingSnapshot(), before)
  assert.deepEqual(p.events, [])
  assert.equal(p.storage.loads + p.storage.publications + p.storage.requests.length, 0)
  assert.equal(p.state.committedSnapshot(), null)
  assert.equal(p.state.status().baseRevision, 0)
  turnClean(p)
})

test('coordinator ephemeral revisions stay zero with real effects, multi-handler state and no storage activity', async () => {
  const p = await turnProbe({ mode: 'LIVE_EPHEMERAL' })
  const result = await p.actor.runTurn('SURFACE', false,
    [turnCall('frameA', [number(16)]), turnCall('frameB', [number(17)])])
  assert.deepEqual(result, { status: 'IN_MEMORY', vmGeneration: 0, revision: 0 })
  assert.deepEqual(turnSequence(p), ['snapshot', 'effects', 'render'])
  assert.equal(stateOf(p.snapshots[0].encoded).n, 112)
  assert.deepEqual(p.value().marks, [16, 17])
  assert.equal(p.frames[0][0].text, 'n=112')
  assert.deepEqual(p.deliveries[0].effects.map(item => [...item.values]), [
    [['label', 'frameA'], ['value', '11']], [['label', 'frameB'], ['value', '112']]
  ])
  for (const version of [p.snapshots[0], p.deliveries[0], p.events.find(event => event.type === 'render').version]) {
    assert.equal(version.mode, 'LIVE_EPHEMERAL')
    assert.equal(version.stateRevision, 0)
    assert.equal(version.vmGeneration, 0)
  }
  assert.equal(p.state.committedSnapshot(), null)
  assert.equal(p.storage.loads + p.storage.publications + p.storage.requests.length, 0)
  assert.deepEqual(p.scopes, ['begin', 'accept'])
  turnClean(p)
})

test('coordinator immediate persistent acceptance waits for commit then snapshot, effects and actual pure render', async () => {
  const p = await turnProbe()
  const before = p.state.committedSnapshot()
  const hold = p.storage.hold()
  let settled = false
  const pending = p.run('change', 4).then(result => { settled = true; return result })
  await turnBounded(hold.started.promise)
  assert.equal(p.actor.phase(), 'COMMIT_PENDING')
  assert.equal(p.state.status().baseRevision, 1)
  assert.deepEqual(p.state.committedSnapshot(), before)
  assert.deepEqual(turnSequence(p), ['commit-start'])
  assert.equal(p.value().n, 5)
  assert.equal(p.host.pendingEffects.length, 1)
  assert.equal(p.host.effectsAllowed, false)
  assert.deepEqual(p.scopes, ['begin'])
  await turnMicrotasks()
  assert.equal(settled, false)
  hold.gate.resolve()
  const result = await turnBounded(pending)
  assert.equal(result.status, 'COMMITTED')
  assert.equal(result.revision, 2)
  assert.deepEqual(turnSequence(p), ['commit-start', 'commit-finish', 'snapshot', 'effects', 'render'])
  assert.deepEqual(p.scopes, ['begin', 'accept'])
  const committed = p.state.committedSnapshot()
  assert.equal(p.snapshots[0].encoded, committed.encoded)
  assert.equal(p.snapshots[0].stateRevision, 2)
  assert.equal(p.snapshots[0].vmGeneration, 1)
  assert.equal(p.snapshots[0].mode, 'LIVE_PERSISTENT')
  assert.equal(p.deliveries[0].stateRevision, 2)
  assert.equal(p.deliveries[0].vmGeneration, 1)
  assert.equal(p.frames[0][0].text, 'n=5')
  assert.equal(stateOf(format2.validateStateFile(p.storage.text, 'coordinator/version').encodedState).n, 5)
  assert.equal(p.state.status().dirty, false)
  turnClean(p)
})

test('coordinator immediate admission waits for an outstanding real StateManager checkpoint before handler mutation', async () => {
  const p = await turnProbe()
  await p.run('quiet', 2, 'MOVE', false)
  p.reset()
  const hold = p.storage.hold()
  const checkpoint = p.state.checkpoint('PERIODIC')
  await turnBounded(hold.started.promise)
  const pending = p.run('change', 4)
  assert.equal(p.actor.phase(), 'EXECUTING')
  await turnMicrotasks()
  assert.equal(p.value().n, 3)
  assert.deepEqual(p.scopes, [])
  assert.deepEqual(p.host.pendingEffects, [])
  assert.equal(p.storage.requests.length, 2)
  hold.gate.resolve()
  assert.equal((await turnBounded(checkpoint)).revision, 2)
  assert.equal((await turnBounded(pending)).revision, 3)
  assert.equal(p.value().n, 7)
  assert.equal(p.storage.requests[2].pre.baseRevision, 2)
  assert.deepEqual(turnSequence(p), ['commit-start', 'commit-finish', 'commit-start', 'commit-finish', 'snapshot', 'effects', 'render'])
  assert.equal(p.snapshots.length, 1)
  assert.equal(p.snapshots[0].stateRevision, 3)
  turnClean(p)
})

test('coordinator persistent volatile turns are dirty render-only, snapshot barrier does not commit', async () => {
  const p = await turnProbe()
  const before = p.state.committedSnapshot(), commits = p.storage.requests.length
  for (const [source, persist] of [['INPUT', false], ['MOVE', true], ['SURFACE', true], ['TICK', true]]) {
    p.reset()
    const result = await p.run('quiet', 2, source, persist)
    assert.equal(result.status, 'IN_MEMORY')
    assert.deepEqual(turnSequence(p), ['render'])
    assert.deepEqual(p.state.committedSnapshot(), before)
    assert.equal(p.state.status().baseRevision, 1)
    assert.equal(p.state.status().dirty, true)
    assert.equal(p.storage.requests.length, commits)
    const encoded = await p.actor.snapshotBarrier()
    assert.deepEqual(stateOf(encoded), p.value())
    assert.notEqual(encoded, before.encoded)
    assert.equal(p.storage.requests.length, commits)
    turnClean(p)
  }
  assert.equal(p.value().n, 9)
  assert.equal(p.state.status().dirtySeq, 4)
})

for (const source of ['MOVE', 'SURFACE', 'TICK', 'INPUT']) {
  test('coordinator queued effects promote ' + source + ' to immediate persistence even with persist=false', async () => {
    const p = await turnProbe()
    await p.run('quiet', 2, 'MOVE', false)
    p.reset()
    const before = p.state.committedSnapshot(), hold = p.storage.hold()
    const pending = p.run('change', 3, source, false)
    await turnBounded(hold.started.promise)
    assert.equal(p.actor.phase(), 'COMMIT_PENDING')
    assert.deepEqual(p.state.committedSnapshot(), before)
    assert.equal(p.state.status().dirty, true)
    assert.deepEqual(turnSequence(p), ['commit-start'])
    hold.gate.resolve()
    assert.equal((await turnBounded(pending)).status, 'COMMITTED')
    assert.deepEqual(turnSequence(p), ['commit-start', 'commit-finish', 'snapshot', 'effects', 'render'])
    assert.equal(p.value().n, 6)
    assert.deepEqual(p.value().marks, [2, 3])
    assert.equal(stateOf(p.snapshots[0].encoded).n, 6)
    assert.equal(p.deliveries[0].effects.length, 1)
    assert.equal(p.state.status().dirty, false)
    turnClean(p)
  })
}

test('coordinator throttled checkpoint transient refusal keeps dirty working state without committed publication', async () => {
  const p = await turnProbe()
  const before = p.state.committedSnapshot()
  now += 1000
  const result = { status: 'FAILED', code: 'STATE_WRITE_FAILED', stage: 'fixture-before-write' }
  const hold = p.storage.hold(result)
  const pending = p.run('quiet', 2, 'TICK')
  await turnBounded(hold.started.promise)
  hold.gate.resolve()
  assert.deepEqual(await turnBounded(pending), result)
  assert.deepEqual(turnSequence(p), ['commit-start', 'commit-finish', 'error', 'render'])
  assert.equal(p.errors.length, 1)
  turnError(result.code, 'state', result)(p.errors[0])
  assert.equal(p.value().n, 3)
  assert.equal(p.state.status().dirty, true)
  assert.deepEqual(p.state.committedSnapshot(), before)
  assert.deepEqual(p.scopes, ['begin', 'accept'])
  p.reset()
  now += 1000
  assert.equal((await p.run('quiet', 2, 'TICK')).status, 'COMMITTED')
  assert.deepEqual(turnSequence(p), ['commit-start', 'commit-finish', 'snapshot', 'render'])
  assert.equal(p.value().n, 5)
  assert.equal(p.state.status().dirty, false)
  turnClean(p)
})

test('coordinator multi-handler root replacement and graph mutation rollback on a later actual VM trap', async () => {
  const p = await turnProbe()
  const original = p.state.getWorkingState(), marks = original.fields.get('marks')
  const before = p.state.committedSnapshot(), text = p.storage.text, commits = p.storage.requests.length
  await assert.rejects(p.actor.runTurn('INPUT', true, [turnCall('change', [number(2)]),
    turnCall('swap', [number(3)]), turnCall('fail', [number(4)]), turnCall('change', [number(100)])]),
  turnError(undefined, 'handler', null))
  assert.equal(p.state.getWorkingState(), original)
  assert.equal(original.fields.get('marks'), marks)
  assert.deepEqual(p.value(), stateOf(before.encoded))
  assert.deepEqual(p.scopes, ['begin', 'rollback'])
  assert.equal(p.storage.requests.length, commits)
  assert.equal(p.storage.text, text)
  assert.deepEqual(turnSequence(p), ['error'])
  assert.equal(p.errors.length, 1)
  assert.match(p.errors[0].code, /index|bound/i)
  p.reset()
  await p.run('change', 1)
  assert.deepEqual(p.deliveries[0].effects.map(item => item.id), [1])
  assert.deepEqual(p.value().marks, [1])
  turnClean(p)
})

for (const result of [
  { status: 'FAILED', code: 'STATE_WRITE_FAILED', stage: 'fixture-before-write' },
  { status: 'STALE' }
]) {
  test('coordinator multi-handler commit refusal ' + result.status + ' restores original root, nested backing and effects IDs', async () => {
    const p = await turnProbe()
    const original = p.state.getWorkingState(), marks = original.fields.get('marks')
    const before = p.state.committedSnapshot(), text = p.storage.text
    const hold = p.storage.hold(result)
    const pending = p.actor.runTurn('INPUT', true, [turnCall('change', [number(2)]),
      turnCall('swap', [number(3)]), turnCall('change', [number(4)])])
    const rejected = assert.rejects(pending, turnError(result.code || result.status, 'state', result))
    await turnBounded(hold.started.promise)
    assert.notEqual(p.state.getWorkingState(), original)
    assert.equal(original.fields.get('n').value, 6)
    assert.deepEqual(marks.elements.map(item => item.value), [2, 3])
    hold.gate.resolve()
    await turnBounded(rejected)
    assert.equal(p.state.getWorkingState(), original)
    assert.equal(original.fields.get('marks'), marks)
    assert.deepEqual(p.value(), stateOf(before.encoded))
    assert.deepEqual(p.state.committedSnapshot(), before)
    assert.equal(p.storage.text, text)
    assert.equal(p.state.status().dirty, false)
    assert.deepEqual(p.scopes, ['begin', 'rollback'])
    assert.deepEqual(turnSequence(p), ['commit-start', 'commit-finish', 'error'])
    assert.equal(p.errors.length, 1)
    p.reset()
    await p.run('change', 1)
    assert.equal(p.deliveries[0].effects[0].id, 1)
    turnClean(p)
  })
}

for (const result of [
  { status: 'COMMIT_UNCERTAIN', code: 'STATE_COMMIT_UNCERTAIN', stage: 'fixture-after-write' },
  { status: 'FENCED_COMMIT' }
]) {
  test('coordinator ' + result.status + ' discards the real VM journal, effects and dirty state without rollback/publication', async () => {
    const p = await turnProbe()
    await p.run('quiet', 2, 'MOVE', false)
    p.reset()
    const before = p.state.committedSnapshot(), original = p.state.getWorkingState()
    const hold = p.storage.hold(result)
    const pending = p.actor.runTurn('INPUT', true, [turnCall('change', [number(3)]), turnCall('swap', [number(4)])])
    const rejected = assert.rejects(pending, turnError(result.code || result.status, 'state', result))
    await turnBounded(hold.started.promise)
    hold.gate.resolve()
    await turnBounded(rejected)
    assert.deepEqual(p.scopes, ['begin', 'discard'])
    assert.equal(original.fields.get('n').value, 10)
    assert.notEqual(p.state.getWorkingState(), original)
    assert.equal(p.state.status().dirty, false)
    assert.deepEqual(p.state.committedSnapshot(), before)
    assert.equal(p.actor.phase(), 'FAULTED')
    assert.equal(p.state.status().phase, 'FAULTED')
    assert.deepEqual(turnSequence(p), ['commit-start', 'commit-finish', 'error'])
    assert.equal(p.host.effectsAllowed, false)
    assert.deepEqual(p.host.pendingEffects, [])
    const commits = p.storage.requests.length
    await assert.rejects(p.run('quiet'), turnError('STATE_UNAVAILABLE', 'state'))
    assert.throws(() => p.actor.pure(turnCall('view')), turnError('STATE_UNAVAILABLE', 'state'))
    await assert.rejects(p.actor.snapshotBarrier(), turnError('STATE_UNAVAILABLE', 'state'))
    await p.state.whenIdle()
    assert.equal(p.storage.closed, true)
    assert.equal(p.storage.requests.length, commits)
    assert.equal(p.errors.length, 1)
  })
}

test('coordinator pure epochs allow local fresh values but reject prior pure results and handler-created backing mutations', async () => {
  const p = await turnProbe()
  const freshValues = p.actor.pure(turnCall('freshPure', [], false))
  assert.deepEqual(freshValues.elements.map(item => item.value), [3, 2])
  assert.throws(() => p.actor.pure(turnCall('mutateArray', [freshValues], false)), turnError(undefined, 'view', null))
  assert.match(p.errors[0].code, /pure|pre-existing/i)
  assert.deepEqual(freshValues.elements.map(item => item.value), [3, 2])
  await p.run('replaceMarks', 7)
  const before = p.state.committedSnapshot(), rootValue = p.state.getWorkingState(), marks = rootValue.fields.get('marks')
  p.reset()
  for (const entry of ['mutateView', 'mutateMarks', 'drawEffect']) {
    assert.throws(() => p.actor.pure(turnCall(entry)), turnError(undefined, 'view', null))
    assert.equal(p.state.getWorkingState(), rootValue)
    assert.equal(rootValue.fields.get('marks'), marks)
    assert.deepEqual(marks.elements.map(item => item.value), [7])
    assert.deepEqual(p.state.committedSnapshot(), before)
    assert.deepEqual(p.value(), stateOf(before.encoded))
    assert.deepEqual(p.host.pendingEffects, [])
    assert.equal(p.host.effectsAllowed, false)
    assert.equal(p.actor.phase(), 'READY')
  }
  assert.equal(p.errors.length, 3)
  assert.deepEqual(turnSequence(p), ['error', 'error', 'error'])
  assert.equal(decodeVeraUi(p.actor.pure(turnCall('view')))[0].text, 'n=1')
  assert.deepEqual(p.actor.pure(turnCall('freshPure', [], false)).elements.map(item => item.value), [3, 2])
  assert.deepEqual(p.state.committedSnapshot(), before)
  turnClean(p)
})

test('coordinator postcommit render trap preserves committed state and already-delivered effects', async () => {
  const p = await turnProbe()
  const commits = p.storage.requests.length
  let caught
  await assert.rejects(p.run('breakView', 2), error => {
    caught = error
    return turnError(undefined, 'render')(error)
  })
  assert.equal(p.storage.requests.length, commits + 1)
  assert.equal(caught.acceptance.status, 'COMMITTED')
  assert.equal(caught.acceptance.revision, 2)
  assert.equal(p.errors[0], caught)
  assert.deepEqual(turnSequence(p), ['commit-start', 'commit-finish', 'snapshot', 'effects', 'render', 'error'])
  assert.equal(p.snapshots.length, 1)
  assert.equal(p.deliveries.length, 1)
  assert.equal(p.deliveries[0].effects[0].values.get('label'), 'breakView')
  assert.equal(p.deliveries[0].stateRevision, 2)
  assert.deepEqual(stateOf(p.snapshots[0].encoded), p.value())
  assert.equal(p.value().badView, true)
  assert.equal(p.state.status().baseRevision, 2)
  assert.equal(p.state.status().dirty, false)
  assert.deepEqual(p.scopes, ['begin', 'accept'])
  turnClean(p)
  const committed = p.state.committedSnapshot()
  assert.throws(() => p.actor.pure(turnCall('view')), turnError(undefined, 'view'))
  assert.deepEqual(p.state.committedSnapshot(), committed)
  p.reset()
  await p.run('recover', 1)
  assert.equal(p.state.status().baseRevision, 3)
  assert.equal(p.frames[0][0].text, 'n=4')
  assert.equal(p.deliveries.length, 0)
  turnClean(p)
})

test('coordinator snapshot barrier waits for commit and asynchronous render, excludes new turns, and adds no commit', async () => {
  const renderGate = turnDeferred(), enteredRender = turnDeferred()
  let holdRender = false, savedPure
  const p = await turnProbe({ render(_version, pure) {
    savedPure = pure
    if (holdRender) { enteredRender.resolve(); return renderGate.promise }
  } })
  holdRender = true
  const hold = p.storage.hold(), commits = p.storage.requests.length
  const pending = p.run('change', 2)
  await turnBounded(hold.started.promise)
  let barrierDone = false
  const barrier = p.actor.snapshotBarrier().then(value => { barrierDone = true; return value })
  await turnMicrotasks()
  assert.equal(barrierDone, false)
  await assert.rejects(p.run('quiet'), turnError('STATE_TURN_PENDING', 'state'))
  assert.throws(() => p.actor.pure(turnCall('view')), turnError('STATE_TURN_PENDING', 'state'))
  hold.gate.resolve()
  await turnBounded(enteredRender.promise)
  assert.equal(p.actor.phase(), 'PUBLISHING')
  await assert.rejects(p.actor.snapshotBarrier(), turnError('STATE_TURN_PENDING', 'state'))
  assert.equal(decodeVeraUi(savedPure(turnCall('view')))[0].text, 'n=3')
  await turnMicrotasks()
  assert.equal(barrierDone, false)
  renderGate.resolve()
  assert.equal((await turnBounded(pending)).status, 'COMMITTED')
  const encoded = await turnBounded(barrier)
  assert.equal(encoded, p.state.committedSnapshot().encoded)
  assert.equal(stateOf(encoded).n, 3)
  assert.equal(p.storage.requests.length, commits + 1)
  assert.equal(p.errors.length, 0)
  assert.equal(await p.actor.snapshotBarrier(), encoded)
  assert.equal(p.storage.requests.length, commits + 1)
  turnClean(p)
})

test('coordinator render snapshot barriers reject instead of deadlocking accepted turns', async () => {
  for (const asynchronous of [false, true]) {
    let active = false
    const p = await turnProbe({ render(_version, _pure, actor) {
      if (!active) return
      return asynchronous ? Promise.resolve().then(() => actor.snapshotBarrier()) : actor.snapshotBarrier()
    } })
    active = true
    const commits = p.storage.requests.length
    let caught
    await assert.rejects(turnBounded(p.run('change', 2)), error => {
      caught = error
      return turnError('STATE_TURN_PENDING', 'render')(error)
    })
    assert.equal(caught.acceptance.status, 'COMMITTED')
    assert.equal(p.storage.requests.length, commits + 1)
    assert.deepEqual(p.scopes, ['begin', 'accept'])
    assert.equal(p.state.status().baseRevision, 2)
    assert.equal(p.value().n, 3)
    assert.equal(p.snapshots.length, 1)
    assert.equal(p.deliveries.length, 1)
    assert.equal(p.errors[0], caught)
    turnClean(p)
    assert.equal(await turnBounded(p.actor.snapshotBarrier()), p.state.committedSnapshot().encoded)
    active = false
    await p.run('quiet', 1)
    turnClean(p)
  }
})

test('coordinator publishing callbacks reject busy reentrancy without executing another handler', async () => {
  const rejections = [], phases = []
  let active = false
  function reenter(actor) {
    if (!active) return
    phases.push(actor.phase())
    rejections.push(assert.rejects(actor.runTurn('INPUT', true, [turnCall('quiet', [number(100)])]),
      turnError('STATE_TURN_PENDING', 'state')))
    assert.throws(() => actor.pure(turnCall('view')), turnError('STATE_TURN_PENDING', 'state'))
    for (const wait of [() => actor.snapshotBarrier(), () => actor.checkpoint('PERIODIC'),
      () => actor.checkpoint('BACKGROUND'), () => actor.checkpointIfDue(now), () => actor.resume(),
      () => actor.whenSettled(), () => actor.shutdown(false), () => actor.shutdown(true)]) {
      rejections.push(assert.rejects(wait(), turnError('STATE_TURN_PENDING', 'state')))
    }
  }
  const p = await turnProbe({ snapshot(_value, actor) { reenter(actor) },
    effects(_value, actor) { reenter(actor) }, render(_version, _pure, actor) { reenter(actor) } })
  active = true
  await p.run('change', 2)
  await Promise.all(rejections)
  assert.deepEqual(phases, ['PUBLISHING', 'PUBLISHING', 'PUBLISHING'])
  assert.equal(p.value().n, 3)
  assert.equal(p.value().calls, 1)
  assert.equal(p.errors.length, 0)
  assert.equal(p.storage.requests.length, 2)
  turnClean(p)
  for (const asynchronous of [false, true]) {
    let active = false
    const q = await turnProbe({ render(_version, _pure, actor) {
      if (!active) return
      const check = () => { actor.fence(); return assert.rejects(actor.shutdown(false), turnError('STATE_TURN_PENDING', 'state')) }
      return asynchronous ? Promise.resolve().then(check) : check()
    } })
    active = true
    await assert.rejects(turnBounded(q.run('quiet')), turnError('STATE_UNAVAILABLE', 'state'))
    await turnBounded(q.actor.shutdown(false))
  }
})

test('coordinator EXECUTING rejects reentrancy from actual UiHost invocation without poisoning the active VM turn', async () => {
  const p = await turnProbe()
  const invoke = p.host.invoke.bind(p.host), checks = []
  let executing = false
  p.host.invoke = (...args) => {
    if (!executing && p.actor.phase() === 'EXECUTING') {
      executing = true
      checks.push(assert.rejects(p.run('quiet', 100), turnError('STATE_TURN_PENDING', 'state')))
      assert.throws(() => p.actor.pure(turnCall('view')), turnError('STATE_TURN_PENDING', 'state'))
    }
    return invoke(...args)
  }
  await p.run('change', 2)
  await Promise.all(checks)
  assert.equal(executing, true)
  assert.equal(p.value().n, 3)
  assert.equal(p.value().calls, 1)
  assert.deepEqual(p.scopes, ['begin', 'accept'])
  assert.equal(p.deliveries[0].effects.length, 1)
  assert.equal(p.errors.length, 0)
  turnClean(p)
})

test('coordinator idle barrier excludes admission until capture and failed turn barrier captures rollback without extra commit', async () => {
  const p = await turnProbe()
  const before = p.state.committedSnapshot(), commits = p.storage.requests.length
  const idleBarrier = p.actor.snapshotBarrier()
  await assert.rejects(p.run('quiet', 100), turnError('STATE_TURN_PENDING', 'state'))
  assert.equal(await idleBarrier, before.encoded)
  assert.equal(p.storage.requests.length, commits)
  const result = { status: 'FAILED', code: 'STATE_SYNC_FAILED', stage: 'fixture-before-publish' }
  const hold = p.storage.hold(result)
  const pending = p.run('change', 2)
  const rejected = assert.rejects(pending, turnError(result.code, 'state', result))
  await turnBounded(hold.started.promise)
  const barrier = p.actor.snapshotBarrier()
  hold.gate.resolve()
  await turnBounded(rejected)
  assert.equal(await turnBounded(barrier), before.encoded)
  assert.equal(p.storage.requests.length, commits + 1)
  assert.deepEqual(p.scopes, ['begin', 'rollback'])
  assert.equal(p.value().n, 1)
  assert.equal(p.snapshots.length + p.deliveries.length + p.frames.length, 0)
  turnClean(p)
})

test('coordinator typed publication errors preserve commit and still deliver later callbacks exactly once', async () => {
  for (const kind of ['snapshot', 'effects', 'render']) {
    let fail = false
    const hook = () => { if (fail) throw Error('fixture-' + kind) }
    const p = await turnProbe({ [kind]: hook, onError() { throw Error('error callback must not mask original') } })
    fail = true
    let caught
    await assert.rejects(p.run('change', 2), error => {
      caught = error
      return turnError('fixture-' + kind, kind)(error)
    })
    assert.equal(p.errors.length, 1)
    assert.equal(p.errors[0], caught)
    assert.equal(caught.acceptance.status, 'COMMITTED')
    assert.deepEqual(turnSequence(p), ['commit-start', 'commit-finish', 'snapshot', 'effects', 'render', 'error'])
    assert.equal(p.snapshots.length, 1)
    assert.equal(p.deliveries.length, 1)
    assert.equal(p.frames.length, 1)
    assert.equal(p.state.status().baseRevision, 2)
    assert.equal(p.value().n, 3)
    assert.equal(p.state.committedSnapshot().encoded, p.snapshots[0].encoded)
    turnClean(p)
  }
})

test('coordinator mode, readiness, queued effects, empty calls and actual rollback guard validation fail before activation', async () => {
  const p = await turnProbe({ mode: 'LIVE_EPHEMERAL' })
  for (const mode of ['PREVIEW', 'LIVE_PERSISTENT', 'INVALID']) {
    assert.throws(() => new AppActorTurnCoordinator(p.state, p.vm, p.host, mode, p.policy, p.callbacks),
      turnError('STATE_VALIDATION_FAILED', 'state'))
  }
  p.host.pendingEffects.push({ fixture: true })
  assert.throws(() => new AppActorTurnCoordinator(p.state, p.vm, p.host, 'LIVE_EPHEMERAL', p.policy, p.callbacks),
    turnError('STATE_VALIDATION_FAILED', 'state'))
  p.host.pendingEffects = []
  for (const rollbackGuard of [undefined, { coverage: 'GRAPH_ONLY', beginTurn() { assert.fail('incomplete guard must not execute') } }]) {
    assert.throws(() => new StateManager({ ...p.managerOptions, rollbackGuard }),
      error => error instanceof StateManagerError && error.code === 'STATE_ROLLBACK_GUARD_REQUIRED')
  }
  const unready = new StateManager(p.managerOptions)
  assert.throws(() => new AppActorTurnCoordinator(unready, p.vm, p.host, 'LIVE_EPHEMERAL', p.policy, p.callbacks),
    turnError('ACTOR_NOT_READY', 'state'))
  await assert.rejects(p.actor.runTurn('INPUT', true, []), turnError('STATE_VALIDATION_FAILED', 'handler'))
  assert.deepEqual(p.events, [])
  assert.deepEqual(p.scopes, [])
  assert.equal(p.value().n, 1)
  await p.state.close()
  assert.equal(p.actor.phase(), 'FAULTED')
  await assert.rejects(p.run('quiet'), turnError('STATE_UNAVAILABLE', 'state'))
})

test('coordinator init equality publishes the confirmed generation/revision without another commit', async () => {
  const first = await turnProbe()
  const p = await turnProbe({ storageText: first.storage.text, initialize: false })
  assert.equal(p.storage.publications, 1)
  const result = await p.actor.runTurn('CARRY', false, [turnCall('init', [], false)])
  assert.equal(result.status, 'UNCHANGED')
  assert.equal(result.reason, 'INIT_EQUAL')
  assert.equal(p.storage.requests.length, 0)
  assert.deepEqual(turnSequence(p), ['snapshot', 'render'])
  assert.equal(p.snapshots[0].vmGeneration, 2)
  assert.equal(p.snapshots[0].stateRevision, 1)
  assert.equal(p.snapshots[0].encoded, p.state.committedSnapshot().encoded)
  assert.equal(p.frames[0][0].text, 'n=1')
  turnClean(p)
})

test('coordinator checkpoints overlap volatile turns, serialize immediate/effect promotion and resume external versions', async () => {
  for (const [reason, entry, source] of [['PERIODIC', 'quiet', 'MOVE'], ['BACKGROUND', 'quiet', 'INPUT'], ['DUE', 'change', 'MOVE']]) {
    const p = await turnProbe()
    await p.run('quiet', 2, 'MOVE', false)
    assert.equal(await p.actor.checkpointIfDue(now + 4999), null)
    p.reset()
    const hold = p.storage.hold()
    const checkpoint = reason === 'DUE' ? p.actor.checkpointIfDue(now + 5000) : p.actor.checkpoint(reason)
    await turnBounded(hold.started.promise)
    assert.strictEqual(p.actor.checkpoint('BACKGROUND'), checkpoint)
    const pending = p.run(entry, 2, source)
    let settled = false
    const idle = p.actor.whenSettled().then(() => { settled = true })
    await turnMicrotasks()
    assert.equal(settled, false)
    assert.equal(p.storage.requests.length, 2)
    assert.equal(p.snapshots.length + p.deliveries.length, 0)
    if (source === 'INPUT') {
      assert.equal(p.value().n, 3)
      assert.deepEqual(p.scopes, [])
    } else {
      assert.equal(p.value().n, 5)
      if (entry === 'quiet') assert.equal((await turnBounded(pending)).status, 'IN_MEMORY')
      else assert.equal(p.host.pendingEffects.length, 1)
    }
    hold.gate.resolve()
    assert.equal((await turnBounded(checkpoint)).revision, 2)
    await turnBounded(pending)
    await turnBounded(idle)
    assert.equal(p.snapshots[0].stateRevision, 2)
    assert.equal(stateOf(p.snapshots[0].encoded).n, 3)
    assert.equal(p.state.status().dirty, entry === 'quiet' && source === 'MOVE')
    assert.deepEqual(p.snapshots.map(item => item.stateRevision), source === 'MOVE' && entry === 'quiet' ? [2] : [2, 3])
    if (entry === 'change') assert.equal(p.deliveries[0].stateRevision, 3)
    if (source === 'MOVE' && entry === 'quiet') {
      p.reset()
      const before = p.state.status(), encoded = p.state.captureWorkingSnapshot(), loads = p.storage.loads
      assert.equal((await turnBounded(p.actor.resume())).status, 'UNCHANGED')
      assert.equal(p.state.captureWorkingSnapshot(), encoded)
      assert.deepEqual(p.state.status(), before)
      assert.equal(p.storage.loads, loads)
      assert.deepEqual(p.events, [])
      const external = edited(encoded, { n: 70 })
      p.storage.text = format2.assembleStateFile({ appId: 'coordinator/version', schemaVersion: 1,
        vmGeneration: 1, revision: 9, stamp: coordinatedProgram.stamp }, external)
      const reloaded = await turnBounded(p.actor.resume())
      assert.equal(reloaded.status, 'RELOADED')
      assert.equal(reloaded.discardedDirty, true)
      assert.equal(p.value().n, 70)
      assert.equal(p.state.status().dirty, false)
      assert.equal(p.storage.publications, 1)
      assert.equal(p.snapshots[0].encoded, external)
      assert.equal(p.snapshots[0].vmGeneration, 2)
      assert.equal(p.snapshots[0].stateRevision, 9)
      assert.equal(p.frames[0][0].text, 'n=70')
      assert.equal(p.storage.requests.length, 2)
      await p.run('quiet', 1)
      assert.equal(p.snapshots[1].stateRevision, 10)
      assert.equal(p.snapshots[1].vmGeneration, 2)
    }
    turnClean(p)
  }
  for (const checkpoint of [true, false]) {
    const p = await turnProbe()
    p.state.factory = { create() { p.storage.closed = false; return p.storage } }
    await p.run('quiet', 2, 'MOVE', false)
    p.reset()
    const hold = p.storage.hold({ status: 'STALE_REVISION' })
    const pending = checkpoint ? p.actor.checkpoint('BACKGROUND') : p.run('change', 2)
    const rejected = assert.rejects(pending, turnError('STALE_REVISION', 'state', { status: 'STALE_REVISION' }))
    await turnBounded(hold.started.promise)
    const oldInput = checkpoint ? assert.rejects(p.run('change', 2), turnError('STATE_UNAVAILABLE', 'state')) : null
    const barrier = checkpoint ? null : p.actor.snapshotBarrier()
    if (oldInput) {
      await turnMicrotasks()
      assert.equal(p.value().n, 3)
      assert.deepEqual(p.scopes, [])
    }
    const external = edited(p.state.committedSnapshot().encoded, { n: 80 })
    p.storage.text = format2.assembleStateFile({ appId: 'coordinator/version', schemaVersion: 1,
      vmGeneration: 1, revision: 7, stamp: coordinatedProgram.stamp }, external)
    hold.gate.resolve()
    await turnBounded(rejected)
    if (oldInput) {
      await turnBounded(oldInput)
      assert.deepEqual(p.scopes, [])
      assert.equal(p.storage.requests.length, 2)
      assert.equal(p.value().n, 80)
      assert.equal(p.state.committedSnapshot().encoded, external)
      assert.equal(p.actor.phase(), 'READY')
    }
    if (barrier) assert.equal(await turnBounded(barrier), external)
    assert.deepEqual(p.snapshots.map(s => [s.vmGeneration, s.stateRevision, s.encoded]), [[2, 7, external]])
    assert.deepEqual(turnSequence(p).slice(-3), ['snapshot', 'render', 'error'])
    assert.equal(p.frames[0][0].text, 'n=80')
    assert.equal(p.deliveries.length, 0)
    turnClean(p)
  }
  const p = await turnProbe(), readHeader = p.storage.readHeader.bind(p.storage)
  p.storage.readHeader = async () => { throw Error('fixture-header') }
  await assert.rejects(p.actor.resume(), turnError('STATE_RELOAD_PENDING', 'state'))
  p.storage.readHeader = readHeader
  assert.equal(await turnBounded(p.actor.checkpointIfDue(now + 5000)), null)
  assert.deepEqual(p.snapshots.map(s => [s.vmGeneration, s.stateRevision]), [[2, 1]])
  turnClean(p)
})

test('coordinator shutdown drains render/storage, caches cleanup failure and local fence suppresses late callbacks', async () => {
  let cachedWhileRendering = true
  for (const save of [false, true, 'failure']) {
    const renderGate = turnDeferred(), rendered = turnDeferred(), closeGate = turnDeferred(), closing = turnDeferred()
    let active = false, finals = 0, closes = 0, done = false, caught
    const p = await turnProbe({ render() { if (active) { rendered.resolve(); return renderGate.promise } } })
    const finalSave = p.state.finalSave.bind(p.state), close = p.storage.close.bind(p.storage)
    p.state.finalSave = () => { finals++; return finalSave() }
    p.storage.close = async () => {
      closes++; closing.resolve(); await closeGate.promise; await close()
      if (save === 'failure') throw Error('fixture-close')
    }
    if (save !== true) await p.run('quiet', 2, 'MOVE', false)
    const hold = p.storage.hold()
    const checkpoint = save !== true ? p.actor.checkpoint('BACKGROUND') : null
    if (checkpoint) await turnBounded(hold.started.promise)
    active = true
    const pending = p.run(save !== true ? 'quiet' : 'change', 2, save !== true ? 'MOVE' : 'INPUT')
    if (!checkpoint) await turnBounded(hold.started.promise)
    const shutdown = p.actor.shutdown(save !== false)
    assert.strictEqual(p.actor.shutdown(!save), shutdown)
    const outcome = shutdown.then(() => { done = true }, error => { done = true; caught = error })
    const idle = p.actor.whenSettled().then(() => null, error => error)
    await assert.rejects(p.run('quiet'), turnError('STATE_UNAVAILABLE', 'state'))
    await turnMicrotasks()
    assert.equal(done, false)
    assert.equal(closes, 0)
    hold.gate.resolve()
    await turnBounded(rendered.promise)
    const repeated = p.actor.shutdown(false)
    repeated.catch(() => {})
    cachedWhileRendering = cachedWhileRendering && repeated === shutdown
    await turnMicrotasks()
    assert.equal(done, false)
    assert.equal(closes, 0)
    if (save === 'failure') {
      const failed = { status: 'FAILED', code: 'STATE_SYNC_FAILED', stage: 'fixture-final' }
      const finalHold = p.storage.hold(failed)
      renderGate.resolve()
      await turnBounded(pending)
      await turnBounded(finalHold.started.promise)
      finalHold.gate.resolve()
    } else renderGate.resolve()
    await turnBounded(pending)
    await turnBounded(closing.promise)
    assert.equal(done, false)
    assert.equal(finals, save === false ? 0 : 1)
    assert.equal(p.storage.requests.length, save === 'failure' ? 3 : 2)
    assert.equal(p.storage.closed, false)
    closeGate.resolve()
    await turnBounded(outcome)
    assert.equal(await turnBounded(idle), caught || null)
    assert.strictEqual(p.actor.shutdown(false), shutdown)
    assert.equal(closes, 1)
    assert.equal(p.storage.closed, true)
    assert.equal(p.actor.phase(), 'FAULTED')
    if (save === 'failure') {
      turnError('STATE_SYNC_FAILED', 'state')(caught)
      assert.equal(caught.acceptance.stage, 'fixture-final')
      turnError('fixture-close', 'close')(caught.closeError)
    } else assert.equal(caught, undefined)
  }
  const p = await turnProbe(), hold = p.storage.hold()
  const pending = assert.rejects(p.run('change', 2), turnError('STATE_UNAVAILABLE', 'state'))
  await turnBounded(hold.started.promise)
  p.actor.fence(); p.actor.fence()
  hold.gate.resolve()
  await turnBounded(pending)
  await turnBounded(p.actor.whenSettled())
  assert.equal(p.actor.phase(), 'FAULTED')
  assert.equal(p.snapshots.length + p.deliveries.length + p.frames.length + p.errors.length, 0)
  assert.equal(stateOf(format2.validateStateFile(p.storage.text, 'coordinator/version').encodedState).n, 3)
  await assert.rejects(p.run('quiet'), turnError('STATE_UNAVAILABLE', 'state'))
  await assert.rejects(p.actor.checkpoint('BACKGROUND'), turnError('STATE_UNAVAILABLE', 'state'))
  assert.equal(p.host.effectsAllowed, false)
  assert.deepEqual(p.host.pendingEffects, [])
  assert.equal(cachedWhileRendering, true, 'shutdown must return its exact cached Promise during a held render')
  for (const resume of [false, true]) {
    const q = await turnProbe(), gate = turnDeferred(), started = turnDeferred(), closeGate = turnDeferred(), closing = turnDeferred()
    let caught, done = false
    q.storage.close = async () => { closing.resolve(); await closeGate.promise; q.storage.closed = true }
    q.state.finalSave = () => assert.fail('shutdown(false) must not final-save')
    await q.run('quiet', 2, 'MOVE', false)
    if (resume) q.storage.readHeader = async () => { started.resolve(); await gate.promise; throw Error('fixture-header') }
    const hold = resume ? { started, gate } : q.storage.hold({ status: 'FENCED_COMMIT' })
    const work = resume ? q.actor.resume() : q.actor.checkpoint('BACKGROUND')
    const rejected = assert.rejects(work, error => { caught = error; return turnError(resume ? 'STATE_RELOAD_PENDING' : 'FENCED_COMMIT', 'state')(error) })
    await turnBounded(hold.started.promise)
    const shutdown = q.actor.shutdown(false), outcome = assert.rejects(shutdown, error => { done = true; assert.strictEqual(error, caught); return true })
    assert.strictEqual(q.actor.shutdown(true), shutdown)
    hold.gate.resolve(); await turnBounded(closing.promise)
    assert.equal(done, false)
    closeGate.resolve(); await turnBounded(rejected); await turnBounded(outcome)
    assert.equal(q.storage.closed, true)
    assert.strictEqual(q.actor.shutdown(false), shutdown)
  }
  for (const failSave of [false, true]) {
    const q = await turnProbe(), conflict = q.storage.hold({ status: 'STALE_REVISION' })
    q.state.factory = { create() { q.storage.closed = false; return q.storage } }
    let caught, finals = 0
    await q.run('quiet', 2, 'MOVE', false)
    const rejected = assert.rejects(q.actor.checkpoint('BACKGROUND'), error => {
      caught = error; return turnError('STALE_REVISION', 'state', { status: 'STALE_REVISION' })(error)
    })
    await turnBounded(conflict.started.promise)
    const external = edited(q.state.committedSnapshot().encoded, { n: 80 })
    q.storage.text = format2.assembleStateFile({ appId: 'coordinator/version', schemaVersion: 1,
      vmGeneration: 1, revision: 7, stamp: coordinatedProgram.stamp }, external)
    conflict.gate.resolve(); await turnBounded(rejected)
    assert.equal(q.value().n, 80)
    assert.equal((await q.run('quiet', 2, 'MOVE', false)).status, 'IN_MEMORY')
    assert.equal(q.value().n, 82)
    assert.equal(q.state.status().dirty, true)
    assert.equal(q.storage.requests.length, 2)
    const failed = { status: 'FAILED', code: 'STATE_SYNC_FAILED', stage: 'fixture-final' }
    const finalSave = q.state.finalSave.bind(q.state), hold = q.storage.hold(failSave ? failed : undefined)
    q.state.finalSave = () => { finals++; return finalSave() }
    const shutdown = q.actor.shutdown(true), outcome = assert.rejects(shutdown, error => { assert.strictEqual(error, caught); return true })
    assert.strictEqual(q.actor.shutdown(false), shutdown)
    await turnBounded(hold.started.promise)
    assert.equal(finals, 1)
    assert.equal(q.storage.closed, false)
    hold.gate.resolve(); await turnBounded(outcome)
    const saved = format2.validateStateFile(q.storage.text, 'coordinator/version')
    assert.equal(stateOf(saved.encodedState).n, failSave ? 80 : 82)
    assert.deepEqual([saved.header.vmGeneration, saved.header.revision], [2, failSave ? 7 : 8])
    assert.equal(q.storage.requests.length, 3)
    assert.equal(q.state.status().dirty, failSave)
    if (failSave) {
      turnError('STALE_REVISION', 'state')(caught)
      turnError('STATE_SYNC_FAILED', 'state', failed)(caught.saveError)
      assert.notStrictEqual(caught.saveError, caught)
      assert.strictEqual(q.errors.at(-1), caught.saveError)
    } else assert.equal(caught.saveError, null)
    assert.equal(q.storage.closed, true)
    assert.equal(q.state.status().phase, 'CLOSED')
    assert.strictEqual(q.actor.shutdown(true), shutdown)
  }
})

test('default AppActor activates coordinator/StateManager/journal safety and publishes only accepted async turns', async () => {
  const source = fs.readFileSync(path.join(root, 'runtime/AppActor.ets'), 'utf8')
  const ast = ts.createSourceFile('AppActor.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const actorClass = ast.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'AppActor')
  const coordinatorClass = ast.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'AppActorTurnCoordinator')
  const body = (owner, name) => {
    const members = owner.members.filter(member => member.name && member.name.getText(ast) === name)
    assert.equal(members.length, 1, name + ' has exactly one implementation')
    assert(members[0].body, name + ' retains a guarded body')
    return members[0].body.getText(ast)
  }
  for (const name of ['AppActorTurnCoordinator', 'StateManager', 'CommitPolicy', 'executePure', 'beginTurn', 'snapshotBarrier', 'checkpoint', 'checkpointIfDue', 'whenSettled', 'shutdown', 'fence']) {
    assert(new RegExp('\\b' + name + '\\b').test(source), name + ' remains in the activated ownership path')
  }
  assert.match(body(actorClass, 'activate'), /new StateManager\(managerOptions\)/)
  assert.match(body(actorClass, 'activate'), /new AppActorTurnCoordinator\(this\.manager!, this\.vm!, this\.host!, this\.mode, policy/)
  assert.match(body(actorClass, 'activate'), /rollbackGuard = this\.safety \? this\.vm! : undefined/)
  assert.match(body(actorClass, 'activate'), /vmJournal = this\.safety/)
  assert.match(body(actorClass, 'turn'), /await this\.coordinator!\.runTurn\(source, persist, calls, skipIfSame\)/)
  assert.match(body(actorClass, 'snapshot'), /this\.coordinator!\.snapshotBarrier\(\)/)
  assert.match(body(actorClass, 'surfaceSave'), /await this\.coordinator!\.checkpointIfDue\(now\)/)
  assert.match(body(actorClass, 'worldSave'), /await this\.coordinator!\.checkpoint\('BACKGROUND'\)/)
  assert.match(body(actorClass, 'quiesce'), /await this\.coordinator!\.whenSettled\(\)/)
  assert.match(body(actorClass, 'retire'), /await this\.closeRuntime\(this\.coordinator, this\.manager, saveState\)/)
  assert.match(body(actorClass, 'closeMemoryRuntime'), /await this\.closeRuntime\(runtime\.coordinator, runtime\.manager, false\)/)
  assert.match(body(actorClass, 'closeRuntime'), /if \(coordinator !== null\) \{ await coordinator\.shutdown\(saveState\) \}/)
  assert.match(body(actorClass, 'closeRuntime'), /else if \(manager !== null\) \{ await manager\.close\(\) \}/)
  assert.match(body(actorClass, 'closeRuntime'), /if \(\(coordinator === null \|\| !coordinator\.closureConfirmed\(\)\) && this\.closureFailure === null\) \{\s*this\.closureFailure = error as Error\s*\}\s*throw error as Error/)
  assert.match(body(coordinatorClass, 'shutdownState'), /await this\.state\.close\(\)\s*this\.closed = true/)
  assert.match(body(actorClass, 'closureConfirmed'), /return this\.disposalSettled && this\.closureFailure === null/)
  assert.match(body(coordinatorClass, 'runTurn'), /this\.state\.beginTurn\(/)
  for (const guard of [/this\.fenced = true/, /this\.epoch\+\+/, /this\.currentPhase = 'FAULTED'/, /this\.checkpointDelivery = null/, /this\.host\.effectsAllowed = false/, /this\.host\.pendingEffects = \[\]/]) {
    assert.match(body(coordinatorClass, 'fence'), guard)
  }
  assert.doesNotMatch(actorClass.getText(ast), /store\.(?:saveState|loadState)\(|private (?:currentState|diskState)\b/)
  let machines = 0
  function visit(node) {
    if (ts.isNewExpression(node) && node.expression.getText(ast) === 'VirtualMachine') {
      machines++
      assert.equal(node.arguments.length, 5, 'VM retains instruction budget, deadline and journal options')
      assert.match(node.arguments[3].getText(ast), /deadlineMs: 1000/)
      assert.match(node.arguments[4].getText(ast), /journalMode: flags\.journalMode/)
    }
    ts.forEachChild(node, visit)
  }
  visit(actorClass)
  assert.equal(machines, 1)
  const p = probe()
  await p.actor.initialize(programs.basic, options())
  p.reset()
  await p.actor.dispatch('change', number(2))
  assert.deepEqual(sequence(p), ['change', 'save', 'snapshot', 'effect:change', 'saved', 'view', 'frame'])
  const payload = format2.validateStateFile(disk.get(stateFile()), 'project/version')
  assert.equal(payload.format, 'FORMAT2')
  assert.equal(payload.revision, 2)
  assert.equal(count(p, 'task-submit'), count(p, 'task-result'))
  p.reset()
  await assert.rejects(p.actor.dispatch('fail', number(4)), /array index out of bounds/)
  assert.equal((await p.state()).n, 3)
  assert.deepEqual((await p.state()).marks, [2])
  assert.equal(stateOf(payload.encodedState).n, 3)
  assert.equal(p.snapshots.length + p.effects.length + count(p, 'save'), 0)
  assert.equal(count(p, 'ui-error'), 1)
})

const originalNow = Date.now
const originalConsole = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, console[level]]))
let passed = 0, legacyPassed = 0
async function main() {
  try {
    Date.now = () => now
    for (const level of ['info', 'warn', 'error']) console[level] = (...args) => records.push({ type: 'log-' + level, message: args.join(' ') })
    for (const [index, { name, run }] of tests.entries()) {
      disk.clear()
      records = []
      failure = ''
      now = 100000
      try {
        await turnBounded(Promise.resolve().then(run), 3000)
        if (index >= legacyTestCount && index !== tests.length - 1) {
          assert.equal(disk.size, 0, 'coordinator scenarios never use ProjectStore/CoreFileKit storage')
          noIo({ events: records })
        }
        passed++
        if (index < legacyTestCount) legacyPassed++
        console.log('PASS ' + name)
      } catch (error) {
        originalConsole.error('FAIL ' + name + '\n' + error.stack)
        process.exitCode = 1
      } finally {
        failure = ''
        StageTrace.configure(false)
      }
    }
  } finally {
    Date.now = originalNow
    Object.assign(console, originalConsole)
  }
  console.log(`app-actor-check: ${passed}/${tests.length} focused actor scenarios passed; legacy ${legacyPassed}/${legacyTestCount}, added ${passed - legacyPassed}/${tests.length - legacyTestCount}`)
  console.log('Scope: existing AppActor scenarios migrated to async TaskPool/StateManager plus AppActorTurnCoordinator with real compiler/VM/UI host/CommitPolicy and isolated in-memory storage; no InProcessHost/mailbox, ArkUI/device, network or model execution.')
}
main().catch(error => { originalConsole.error(error.stack); process.exitCode = 1 })
