// carryState (VeraStateCarry.ets): a refined program starts from its own init() with what the old program's state held
// carried in, field by field. Same name and same kind keeps the old value; a new field starts at init; a field whose kind
// changed starts fresh; entries are kept whole.
'use strict'
const assert = require('node:assert/strict')
const {loadVera} = require('./source-loader')
const {carryState} = loadVera('VeraStateCarry')
const {compileVeraSource} = loadVera('VeraCompiler')
const {VirtualMachine, deserializeVbc2, decodeRuntimeValue, encodeRuntimeValue} = loadVera('VeraInterpreter')
const {UiHostEnvironment} = loadVera('VeraUi')

const program = (stateFields, init, extra = '') => `import * as ui from "std/ui"

@jsonable
class Entry {
  amount: number;
}

@jsonable
class AppState {
${stateFields}
}

function init(): AppState {
  let none: Entry[] = [];
  return ${init};
}

function add(state: AppState, value: number): AppState {
  let out: Entry[] = [];
  for (let e: Entry of state.entries) { out.push(e); }
  let next: Entry = {amount: value};
  out.push(next);
  return {__ALL__};
}
${extra}
function view(state: AppState): ui.View {
  return ui.Column("default", [ui.Text("body", "n=" + ui.numberToString(state.entries.length()))]);
}
`
const vm = source => new VirtualMachine(deserializeVbc2(compileVeraSource(source).vbc2), new UiHostEnvironment())
const plain = value => encodeRuntimeValue(value)

// The old program: a goal typed as text, two entries, a note.
const oldSource = program('  goalText: string;\n  entries: Entry[];\n  note: string;', '{goalText: "8", entries: none, note: ""}')
  .replace('{__ALL__}', '{goalText: state.goalText, entries: out, note: state.note}')
const old = vm(oldSource)
let state = old.execute('init')
state = old.execute('add', [state, decodeRuntimeValue(['n', 1])])
state = old.execute('add', [state, decodeRuntimeValue(['n', 2])])
const typed = JSON.parse(JSON.stringify(plain(state)).replace('"8"', '"10"'))

// The refined program: the goal is still a string, the note became a number, and a glass size was added.
const newSource = program('  goalText: string;\n  entries: Entry[];\n  note: number;\n  glassSize: number;',
  '{goalText: "8", entries: none, note: 0, glassSize: 250}')
  .replace('{__ALL__}', '{goalText: state.goalText, entries: out, note: state.note, glassSize: state.glassSize}')
const refined = vm(newSource)
const carried = carryState(refined.execute('init'), decodeRuntimeValue(typed))
const fields = carried.fields
assert.equal(fields.get('goalText').value, '10', 'what was typed is kept')
assert.equal(fields.get('entries').elements.length, 2, 'the entries are kept')
assert.equal(fields.get('note').value, 0, 'a field whose kind changed starts fresh')
assert.equal(fields.get('glassSize').value, 250, 'a new field starts at init')
assert.deepEqual([...fields.keys()], ['goalText', 'entries', 'note', 'glassSize'], 'the new program\'s fields, in its order')
// The new program runs on it.
const after = refined.execute('add', [carried, decodeRuntimeValue(['n', 3])])
assert.equal(after.fields.get('entries').elements.length, 3)
refined.execute('view', [after])

// The entry class was reshaped (a field added): the old entries do not fit it and the list starts clean, even though the
// fresh list is empty and a view that only counts them would pass.
{
  const reshaped = vm(newSource.replace('class Entry {\n  amount: number;\n}', 'class Entry {\n  amount: number;\n  minute: number;\n}')
    .replace('{amount: value}', '{amount: value, minute: 0}'))
  const kept = carryState(reshaped.execute('init'), decodeRuntimeValue(typed), reshaped.classShapes())
  assert.equal(kept.fields.get('entries').elements.length, 0, 'entries of a reshaped class are not carried')
  assert.equal(kept.fields.get('goalText').value, '10', 'the rest is still carried')
  const same = carryState(refined.execute('init'), decodeRuntimeValue(typed), refined.classShapes())
  assert.equal(same.fields.get('entries').elements.length, 2, 'entries of the same shape are carried')
}

// Nothing to carry from: an empty old list leaves the fresh one.
const empty = carryState(refined.execute('init'), old.execute('init'))
assert.equal(empty.fields.get('entries').elements.length, 0)

async function projectStateChecks() {
  const fs = require('node:fs'), path = require('node:path')
  const ts = require(process.env.VERA_TYPESCRIPT_PATH || 'typescript')
  const {sourceRoot} = require('./source-loader')
  const {ProjectStateMigration, FormProjectStateReader} = loadVera('ProjectStateMigration')
  const projectSource = fs.readFileSync(path.join(sourceRoot, 'vera/ProjectStore.ets'), 'utf8')
  const transpiled = ts.transpileModule(projectSource, {fileName: 'ProjectStore.ts',
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}, reportDiagnostics: true})
  assert.deepEqual((transpiled.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error), [])
  const deferred = () => {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    return {promise, resolve, reject}
  }
  const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  function fixture() {
    const entries = new Map(), handles = new Map(), events = []
    let nextFd = 1, failMetadata = false
    const missing = () => Object.assign(Error('missing'), {code: 13900002})
    const disk = {
      OpenMode: {CREATE: 1, WRITE_ONLY: 2, TRUNC: 4},
      mkdirSync() {},
      statSync(name) { if (!entries.has(name)) throw missing(); return {size: entries.get(name).length} },
      readTextSync(name) { if (!entries.has(name)) throw missing(); return entries.get(name) },
      openSync(name) {
        if (failMetadata && !name.endsWith('.state.json') && !name.endsWith('.tmp')) throw Error('metadata failed')
        const fd = nextFd++; handles.set(fd, name); entries.set(name, ''); return {fd}
      },
      writeSync(fd, text) { entries.set(handles.get(fd), text); return text.length },
      closeSync(file) { handles.delete(file.fd) },
      renameSync(from, to) { entries.set(to, entries.get(from)); entries.delete(from) },
      unlinkSync(name) { if (!entries.has(name)) throw missing(); entries.delete(name); events.push('unlink:' + name) },
      listFileSync(dir) { return [...entries.keys()].filter(name => path.posix.dirname(name) === dir).map(name => path.posix.basename(name)) },
      rmdirSync() { throw Error('recursive removal must not touch stable locks') }
    }
    const mod = {exports: {}}
    new Function('require', 'module', 'exports', transpiled.outputText)(name => {
      if (name === '@kit.CoreFileKit') return {fileIo: disk}
      if (name === './ProjectText') return {requestHeadline: text => text}
      throw Error('Unexpected runtime dependency: ' + name)
    }, mod, mod.exports)
    const store = new mod.exports.ProjectStore()
    store.init('/fixture/files')
    const project = store.createProject('Counter', '')
    const metadata = store.migrationMetadata()
    const publish = metadata.publishVersion
    metadata.publishVersion = version => { events.push('publish'); publish(version) }
    const tasks = {
      async load(appId, stamp) { events.push('load:' + appId); return {kind: 'ABSENT'} },
      async readHeader(appId) { events.push('header:' + appId); return null }
    }
    const seeds = {
      async acceptInitialState(appId, stamp, encoded) {
        events.push('seed:' + appId)
        entries.set('/fixture/files/vera/' + appId + '.state.json', JSON.stringify({stamp, value: JSON.parse(encoded)}))
        return {status: 'COMMITTED', revision: 1, backup: 'SKIPPED'}
      }
    }
    const barriers = []
    const lifecycle = {
      fenceAllAdmissions(scope) {
        events.push('fence'); assert.equal(typeof scope.projectId, 'string')
        const barrier = {
          scope, async quiesceActorsAndFinalSave() { events.push('final') },
          async drainAllCallersAndStorage() { events.push('drain') },
          release(outcome) { events.push('release:' + outcome) }
        }
        barriers.push(barrier)
        return barrier
      }
    }
    const cleanup = {
      async removeStateFilesKeepingStableLocks(scope) {
        events.push('cleanup')
        const prefix = '/fixture/files/vera/' + scope.projectId + '/'
        for (const name of entries.keys()) {
          const local = name.slice(prefix.length)
          if (name.startsWith(prefix) && (scope.versionId === undefined || local.startsWith(scope.versionId + '.state.json')) &&
              /\.state\.json(?:\.bak)?(?:\.[^.]+\.tmp)?$/.test(local)) entries.delete(name)
        }
      }
    }
    const facade = new ProjectStateMigration(metadata, tasks, seeds, lifecycle, cleanup)
    const input = (extra = {}) => ({projectId: project.id, source: 'source', vbc2: 'code', note: 'version', ...extra})
    const file = (versionId, suffix = '') => '/fixture/files/vera/' + project.id + '/' + versionId + '.state.json' + suffix
    return {store, project, metadata, tasks, seeds, lifecycle, cleanup, facade, input, file, entries, events, barriers,
      failMetadata() { failMetadata = true }}
  }
  {
    const f = fixture(), encoded = JSON.stringify(plain(after)), seed = deferred()
    f.seeds.acceptInitialState = async (appId, stamp, value) => {
      f.events.push('seed'); assert.equal(stamp, 'new'); assert.equal(value, encoded)
      await seed.promise
      f.entries.set('/fixture/files/vera/' + appId + '.state.json', encoded)
      f.events.push('durable')
      return {status: 'COMMITTED', revision: 1, backup: 'FAILED'}
    }
    let saved = false
    const saving = f.facade.commitSave(async () => { f.events.push('check'); return true }, async () => {
      f.events.push('prepare'); return f.input({initialState: encoded, initialStamp: 'new'})
    }, version => { saved = true; assert.equal(f.store.getLatestVersion(f.project.id).id, version.id); f.events.push('accepted') })
    await tick()
    assert.equal(saved, false)
    assert.equal(f.store.listVersions(f.project.id).length, 0)
    seed.resolve()
    assert.equal(await saving, true)
    assert.deepEqual(f.events, ['check', 'prepare', 'seed', 'durable', 'publish', 'accepted'])
    assert.equal(await f.facade.commitSave(async () => false, async () => { throw Error('must short circuit') }, () => {}), false)
    assert.equal(await f.facade.commitSave(async () => true, async () => null, () => { throw Error('must not accept') }), false)
    assert.equal(typeof f.store.loadState(f.project.id, f.store.getLatestVersion(f.project.id).id, 'other'), 'string')
    assert.equal(f.store.loadState(f.project.id, f.store.getLatestVersion(f.project.id).id, 'other'), '')
    assert.equal(f.facade.saveState, undefined)
    assert.equal(f.facade.commit, undefined)
  }
  for (const status of ['FAILED', 'COMMIT_UNCERTAIN', 'STALE_REVISION', 'FENCED_COMMIT', 'STALE', 'throw']) {
    const f = fixture(), before = [...f.entries]
    f.seeds.acceptInitialState = async () => { if (status === 'throw') throw Error('seed failed'); return {status} }
    await assert.rejects(f.facade.createVersion(f.input({initialState: '["n",1]'})))
    assert.deepEqual([...f.entries], before)
    assert(!f.events.includes('publish'))
  }
  {
    const f = fixture()
    f.failMetadata()
    await assert.rejects(f.facade.createVersion(f.input({initialState: '["n",9]', initialStamp: 'new'})), /metadata failed/)
    assert.equal(f.store.listVersions(f.project.id).length, 0)
    const state = [...f.entries].find(([name]) => name.endsWith('.state.json'))
    assert(state); assert.equal(JSON.parse(state[1]).value[1], 9)
    assert(!f.events.includes('cleanup'))
  }
  {
    const f = fixture()
    const header = {format: 2, appId: f.project.id + '/v', schemaVersion: 1, vmGeneration: 7, revision: 9,
      payloadLength: 7, payloadHash: 'sha256:actual'}
    const actual = {kind: 'READY', format: 'FORMAT2', source: 'BAK', header, stamp: 'old', matchingStamp: false, recovered: true}
    f.tasks.load = async () => actual
    f.tasks.readHeader = async () => header
    assert.equal(await f.facade.loadState(f.project.id, 'v', 'new'), '')
    assert.equal(await f.facade.loadStateResult(f.project.id, 'v', 'new'), actual)
    assert.equal(await f.facade.readHeader(f.project.id, 'v'), header)
    actual.stamp = 'new'; actual.encodedState = '["n",9]'; actual.matchingStamp = true
    assert.equal(await f.facade.loadState(f.project.id, 'v', 'new'), '["n",9]')
    const form = new FormProjectStateReader({readCommittedReadOnly: () => actual})
    assert.equal(form.loadState(f.project.id, 'v', 'new'), '["n",9]')
    assert.equal(form.loadStateResult(f.project.id, 'v', 'old'), actual)
    assert.equal(form.loadState(f.project.id, 'v', 'old'), '')
    for (const method of ['saveState', 'createVersion', 'clearState', 'deleteProject', 'commit']) assert.equal(form[method], undefined)
    for (const kind of ['ABSENT', 'LOST', 'UNAVAILABLE']) {
      f.tasks.load = async () => ({kind, code: 'STATE_UNAVAILABLE'})
      assert.equal((await f.facade.loadStateResult(f.project.id, 'v', 'new')).kind, kind)
      if (kind === 'UNAVAILABLE') await assert.rejects(f.facade.loadState(f.project.id, 'v', 'new'), /STATE_UNAVAILABLE/)
      else assert.equal(await f.facade.loadState(f.project.id, 'v', 'new'), '')
    }
    await assert.rejects(f.facade.loadState('../p', 'v', 'new'), /identity/)
  }
  {
    const f = fixture(), read = deferred(), final = deferred(), otherCallers = deferred()
    const version = await f.facade.createVersion(f.input())
    f.events.length = 0
    f.tasks.load = async appId => { f.events.push('load'); return appId.startsWith(f.project.id + '/') ? read.promise : {kind: 'ABSENT'} }
    const loading = f.facade.loadStateResult(f.project.id, version.id, 'code')
    await tick()
    f.lifecycle.fenceAllAdmissions = scope => {
      f.events.push('fence')
      return {
        async quiesceActorsAndFinalSave() { f.events.push('final'); await final.promise; f.entries.set(f.file(version.id), 'final state'); f.events.push('final-durable') },
        async drainAllCallersAndStorage() { f.events.push('drain'); await otherCallers.promise; f.entries.set(f.file(version.id, '.late.tmp'), 'late'); f.events.push('all-drained') },
        release(outcome) { f.events.push('release:' + outcome) }
      }
    }
    for (const suffix of ['', '.bak', '.writer.tmp', '.bak.writer.tmp', '.commit.lock']) f.entries.set(f.file(version.id, suffix), suffix)
    const clearing = f.facade.clearState(f.project.id, version.id)
    assert(f.events.includes('fence'), 'fence must happen before clearState returns its Promise')
    await assert.rejects(f.facade.loadState(f.project.id, version.id, 'code'), /fenced/)
    await assert.rejects(f.facade.readHeader(f.project.id, version.id), /fenced/)
    assert.equal(await f.facade.loadState('other', 'v', 'code'), '')
    final.resolve(); await tick()
    assert(!f.events.includes('drain'), 'accepted load must settle before storage drain')
    read.resolve({kind: 'ABSENT'}); await loading; await tick()
    assert(f.events.includes('drain')); assert(!f.events.includes('cleanup'))
    otherCallers.resolve(); await clearing
    assert.deepEqual(f.events.filter(event => !event.startsWith('unlink:')), [
      'load', 'fence', 'final', 'load', 'final-durable', 'drain', 'all-drained', 'cleanup', 'release:CLEARED'
    ])
    assert(f.entries.has(f.file(version.id, '.commit.lock')))
    for (const suffix of ['', '.bak', '.writer.tmp', '.bak.writer.tmp', '.late.tmp']) assert(!f.entries.has(f.file(version.id, suffix)))
    assert(f.store.getVersion(f.project.id, version.id))
    f.tasks.load = async () => ({kind: 'ABSENT'})
    assert.equal(await f.facade.loadState(f.project.id, version.id, 'code'), '')
  }
  {
    const f = fixture(), gate = deferred()
    const first = await f.facade.createVersion(f.input())
    const second = await f.facade.createVersion(f.input())
    f.lifecycle.fenceAllAdmissions = () => ({
      quiesceActorsAndFinalSave: () => gate.promise, async drainAllCallersAndStorage() {}, release() {}
    })
    const deleting = f.facade.deleteVersion(f.project.id, first.id)
    await assert.rejects(f.facade.createVersion(f.input()), /fenced/)
    await assert.rejects(f.facade.loadState(f.project.id, second.id, ''), /fenced/)
    gate.resolve(); assert.equal(await deleting, false)
    assert.equal(f.store.getVersion(f.project.id, first.id), null)
    assert(f.store.getVersion(f.project.id, second.id))
    await assert.rejects(f.facade.loadState(f.project.id, first.id, ''), /fenced/)
    assert.equal(await f.facade.loadState(f.project.id, second.id, ''), '')
    f.entries.set(f.file('orphan', '.bak'), 'backup')
    f.entries.set(f.file('orphan', '.commit.lock'), 'stable')
    assert.equal(await f.facade.deleteVersion(f.project.id, second.id), true)
    assert.equal(f.store.getProject(f.project.id), null)
    assert(!f.entries.has(f.file('orphan', '.bak')))
    assert(f.entries.has(f.file('orphan', '.commit.lock')))
    await assert.rejects(f.facade.createVersion(f.input()), /fenced/)
  }
  {
    const f = fixture(), seed = deferred()
    f.seeds.acceptInitialState = async () => { await seed.promise; f.events.push('durable'); return {status: 'COMMITTED'} }
    const creating = f.facade.createVersion(f.input({initialState: '["n",2]'}))
    await tick()
    const removing = f.facade.deleteProject(f.project.id)
    await tick(); assert(!f.events.includes('cleanup'))
    seed.resolve(); await creating; await removing
    assert(f.events.indexOf('publish') < f.events.indexOf('cleanup'))
    assert.equal(f.store.getProject(f.project.id), null)
    assert.equal(f.store.listVersions(f.project.id).length, 0)
  }
  {
    const f = fixture(), seed = deferred()
    const first = await f.facade.createVersion(f.input())
    f.seeds.acceptInitialState = async () => { await seed.promise; return {status: 'COMMITTED', revision: 1, backup: 'SKIPPED'} }
    const creating = f.facade.createVersion(f.input({initialState: '["n",3]'}))
    await tick()
    const deleting = f.facade.deleteVersion(f.project.id, first.id)
    seed.resolve()
    const second = await creating
    assert.equal(await deleting, false, 'an admitted seed prevents deleting the whole project')
    assert(f.store.getProject(f.project.id))
    assert(f.store.getVersion(f.project.id, second.id))
    assert.equal(f.barriers[0].scope.versionId, undefined)
    assert(f.events.includes('release:VERSION_DELETED'))
  }
  {
    const f = fixture(), gate = deferred()
    const first = await f.facade.createVersion(f.input())
    const second = await f.facade.createVersion(f.input())
    f.lifecycle.fenceAllAdmissions = () => ({
      quiesceActorsAndFinalSave: () => gate.promise, async drainAllCallersAndStorage() {}, release() {}
    })
    const clearing = f.facade.clearState(f.project.id, first.id)
    await assert.rejects(f.facade.deleteProject(f.project.id), /fenced/)
    await assert.rejects(f.facade.deleteVersion(f.project.id, second.id), /fenced/)
    gate.resolve(); await clearing
    assert.equal(await f.facade.deleteVersion(f.project.id, second.id), false)
  }
  {
    const f = fixture(), load = deferred()
    const version = await f.facade.createVersion(f.input())
    f.tasks.load = () => load.promise
    const loading = f.facade.loadStateResult(f.project.id, version.id, '')
    const loadFailure = assert.rejects(loading, /load failed/)
    const deleting = f.facade.deleteProject(f.project.id)
    const deleteFailure = assert.rejects(deleting, /load failed/)
    load.reject(Error('load failed'))
    await loadFailure; await deleteFailure
    assert(!f.events.includes('cleanup'))
    assert(f.events.includes('drain'))
    assert(f.store.getVersion(f.project.id, version.id))
  }
  for (const reason of [null, undefined]) {
    const f = fixture()
    const version = await f.facade.createVersion(f.input())
    f.lifecycle.fenceAllAdmissions = () => ({
      async quiesceActorsAndFinalSave() { throw reason },
      async drainAllCallersAndStorage() { f.events.push('drain') }, release() {}
    })
    let rejected = false
    await f.facade.clearState(f.project.id, version.id).then(() => {}, error => { rejected = true; assert.equal(error, reason) })
    assert(rejected)
    assert(!f.events.includes('cleanup'))
    assert(f.events.includes('drain'))
    await assert.rejects(f.facade.loadState(f.project.id, version.id, ''), /fenced/)
  }
  {
    const f = fixture()
    const version = await f.facade.createVersion(f.input())
    f.lifecycle.fenceAllAdmissions = () => ({
      async quiesceActorsAndFinalSave() {}, async drainAllCallersAndStorage() {},
      release(outcome) { if (outcome === 'CLEARED') throw Error('release failed') }
    })
    await assert.rejects(f.facade.clearState(f.project.id, version.id), /release failed/)
    await assert.rejects(f.facade.loadState(f.project.id, version.id, ''), /fenced/)
    await assert.rejects(f.facade.deleteProject(f.project.id), /fenced/)
  }
  for (const stage of ['final', 'drain', 'cleanup', 'fence', 'release', 'metadata']) {
    const f = fixture(), gate = deferred()
    const version = await f.facade.createVersion(f.input())
    f.events.length = 0
    const read = f.facade.loadStateResult(f.project.id, version.id, '')
    if (stage === 'cleanup') f.cleanup.removeStateFilesKeepingStableLocks = async () => { throw Error('cleanup failed') }
    if (stage === 'metadata') f.metadata.removeProjectMetadata = () => { throw Error('metadata failed') }
    f.lifecycle.fenceAllAdmissions = () => {
      if (stage === 'fence') throw Error('fence failed')
      return {
        async quiesceActorsAndFinalSave() { f.events.push('final'); if (stage === 'final') throw Error('final failed') },
        async drainAllCallersAndStorage() { f.events.push('drain'); await gate.promise; if (stage === 'drain') throw Error('drain failed') },
        release(outcome) { f.events.push('release:' + outcome); if (stage === 'release' && outcome !== 'FAILED') throw Error('release failed') }
      }
    }
    const deleting = f.facade.deleteProject(f.project.id)
    const refused = assert.rejects(deleting, new RegExp(stage + ' failed'))
    await read; await tick(); gate.resolve(); await refused
    assert.equal(f.store.getVersion(f.project.id, version.id) !== null, stage !== 'release')
    assert.equal(f.store.getProject(f.project.id) !== null, stage !== 'release')
    await assert.rejects(f.facade.loadState(f.project.id, version.id, ''), /fenced/)
    if (stage !== 'fence') assert(f.events.includes('release:FAILED'))
    if (stage === 'final') assert(f.events.includes('drain'), 'final-save error cannot skip draining other callers')
  }
  await cleanupTaskPoolChecks(fixture)
}

async function cleanupTaskPoolChecks(projectFixture) {
  const fs = require('node:fs'), path = require('node:path')
  const ts = require(process.env.VERA_TYPESCRIPT_PATH || 'typescript')
  const {sourceRoot} = require('./source-loader')
  const ROOT = '/cleanup-fixture', DIR = ROOT + '/p', MAIN = DIR + '/v.state.json', LOCK = MAIN + '.commit.lock'
  const UUID = '01234567-89ab-cdef-0123-456789abcdef'
  const modes = {READ_ONLY: 0, READ_WRITE: 2, CREATE: 64, DIR: 1024, NOFOLLOW: 2048}
  const native = code => Object.assign(Error('native ' + code), {code})
  let active, pool, worker = false
  class Disk {
    constructor() {
      this.nodes = new Map([[ROOT, {kind: 'dir'}], [DIR, {kind: 'dir'}]])
      this.handles = new Map(); this.events = []; this.rules = []; this.fd = 1
    }
    put(name, kind = 'file') { const node = {kind}; this.nodes.set(name, node); return node }
    event(op, name) {
      assert(worker, 'cleanup filesystem access must stay in the real worker')
      this.events.push({op, name})
      for (const rule of this.rules) if (rule.op === op && (!rule.name || rule.name === name)) rule.run(name)
    }
    openSync(name, flags) {
      this.event('open', name)
      let node = this.nodes.get(name)
      if (!node) {
        if (!(flags & modes.CREATE)) throw native(13900002)
        node = this.put(name)
      }
      assert(flags & modes.NOFOLLOW)
      if (node.kind === 'symlink') throw native(13900016)
      if ((flags & modes.DIR) && node.kind !== 'dir') throw native(13900018)
      const fd = this.fd++
      this.handles.set(fd, {name, node})
      return {fd, tryLock: exclusive => {
        assert.equal(exclusive, true)
        this.event('tryLock', name)
        if (node.owner !== undefined) throw native(13900034)
        node.owner = fd; this.event('locked', name)
      }, unlock: () => {
        this.event('unlock', name); assert.equal(node.owner, fd); delete node.owner
      }}
    }
    closeSync(file) {
      const opened = this.handles.get(file.fd)
      this.event('close', opened.name)
      if (opened.node.owner === file.fd) delete opened.node.owner
      this.handles.delete(file.fd)
    }
    statSync(fd) {
      const opened = this.handles.get(fd)
      this.event('stat', opened.name)
      return {isFile: () => opened.node.kind === 'file'}
    }
    lstatSync(name) {
      this.event('lstat', name)
      const node = this.nodes.get(name)
      if (!node) throw native(13900002)
      return {isFile: () => node.kind === 'file'}
    }
    listFileSync(name) {
      this.event('list', name)
      if (!this.nodes.has(name)) throw native(13900002)
      return [...this.nodes.keys()].filter(file => path.posix.dirname(file) === name).map(file => path.posix.basename(file))
    }
    unlinkSync(name) {
      this.event('unlink', name)
      const version = name.slice(0, name.indexOf('.state.json'))
      assert(this.nodes.get(version + '.state.json.commit.lock')?.owner !== undefined, 'unlink requires stable descriptor lock')
      assert(!name.endsWith('.commit.lock'))
      if (!this.nodes.delete(name)) throw native(13900002)
    }
    fsyncSync(fd) {
      const opened = this.handles.get(fd)
      this.event('fsync', opened.name)
      assert.equal(opened.node.kind, 'dir')
    }
  }
  class Pool {
    constructor() {
      this.tasks = []; this.plans = []; this.executions = []; this.Priority = {MEDIUM: 2}
      const owner = this
      this.Task = class {
        constructor(fn, ...args) {
          this.plan = owner.plans.shift() || {}; this.fn = fn; this.args = args
          owner.tasks.push(this)
          if (this.plan.createError) throw Error('create failure')
        }
        setTransferList(list) { assert.deepEqual(list, []); this.transfer = list }
      }
    }
    execute(task, priority) {
      assert.equal(priority, this.Priority.MEDIUM)
      assert.deepEqual(task.transfer, [])
      assert.equal(task.args[1].directoryFsync, 'REQUIRED')
      assert.equal(typeof task.args[2].operationId, 'string')
      assert.equal(typeof task.args[2].scope.projectId, 'string')
      const args = structuredClone(task.args)
      let resolve, reject
      const promise = new Promise((yes, no) => { resolve = yes; reject = no })
      const entry = {task, args, resolve, reject}; this.executions.push(entry)
      if (task.plan.submitError) throw Error('unknown synchronous execute failure')
      if (task.plan.rejectBefore || task.plan.rejectLate) reject(Error('unknown execution'))
      if (!task.plan.hold && !task.plan.rejectBefore && !task.plan.rejectLate) queueMicrotask(() => this.finish(entry))
      return promise
    }
    finish(entry = this.executions.at(-1)) {
      worker = true
      try {
        let reply = entry.task.fn(...entry.args)
        if (entry.task.plan.reply) reply = entry.task.plan.reply(reply)
        if (entry.task.plan.rejectAfter) entry.reject(Error('lost result'))
        else entry.resolve(structuredClone(reply))
      } catch (error) { entry.reject(error) }
      finally { worker = false }
    }
  }
  const cache = new Map(), dependencies = []
  function load(name) {
    assert(['StateCleanupTaskPool', 'StateIo', 'StateFileFormat'].includes(name))
    if (cache.has(name)) return cache.get(name).exports
    const source = fs.readFileSync(path.join(sourceRoot, 'runtime', name + '.ets'), 'utf8')
    if (name === 'StateCleanupTaskPool') {
      assert.match(source, /@Concurrent\s+function stateCleanupTask/)
      assert.doesNotMatch(source, /Object\.freeze/)
    }
    const compiled = ts.transpileModule(source.replace(/^@Concurrent\s*$/gm, ''), {fileName: name + '.ts',
      compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}, reportDiagnostics: true})
    assert.deepEqual((compiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error), [])
    const mod = {exports: {}}; cache.set(name, mod)
    new Function('require', 'module', 'exports', compiled.outputText)(dependency => {
      dependencies.push(dependency)
      if (dependency === '@kit.CoreFileKit') return {fileIo: new Proxy({OpenMode: modes}, {
        get(target, key) { return key in target ? target[key] : (...args) => active[key](...args) }
      })}
      if (dependency === '@kit.ArkTS') return {taskpool: {
        get Task() { return pool.Task }, get Priority() { return pool.Priority }, execute: (...args) => pool.execute(...args)
      }}
      if (dependency === '@ohos.fileio' || dependency === '@kit.CryptoArchitectureKit') return {}
      if (dependency.startsWith('./')) return load(dependency.slice(2))
      throw Error('forbidden worker dependency: ' + dependency)
    }, mod, mod.exports)
    return mod.exports
  }
  const {StateCleanupTaskPool} = load('StateCleanupTaskPool')
  const setup = () => {
    active = new Disk(); pool = new Pool()
    return new StateCleanupTaskPool(ROOT, {directoryFsync: 'REQUIRED', lockTimeoutMs: 0})
  }
  const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  const scope = {projectId: 'p', versionId: 'v'}
  const deleted = () => active.events.filter(event => event.op === 'unlink')
  {
    const cleanup = setup()
    const removable = ['', '.bak', '.' + UUID + '.tmp', '.bak.' + UUID.toUpperCase() + '.tmp',
      '.1730000000000.123456.tmp', '.bak.1730000000000.123456.tmp', '.1730000000000..tmp',
      '.1730000000000.2e-7.tmp', '.1730000000000.-7.tmp']
    const retained = ['.writer.tmp', '.bak.writer.tmp', '.tmp', '.commit.lock', '.commit.lock.' + UUID + '.tmp', '.bakx']
    for (const suffix of [...removable, ...retained]) active.put(MAIN + suffix)
    active.put(DIR + '/other.state.json')
    const inode = active.nodes.get(LOCK)
    await cleanup.removeStateFilesKeepingStableLocks(scope)
    for (const suffix of removable) assert(!active.nodes.has(MAIN + suffix), suffix)
    for (const suffix of retained) assert(active.nodes.has(MAIN + suffix), suffix)
    assert.equal(active.nodes.get(LOCK), inode)
    assert(active.nodes.has(DIR + '/other.state.json'))
    const lastUnlink = active.events.findLastIndex(event => event.op === 'unlink')
    const finalSync = active.events.findLastIndex(event => event.op === 'fsync')
    const unlock = active.events.findIndex(event => event.op === 'unlock')
    assert(lastUnlink < finalSync && finalSync < unlock)
    await cleanup.whenIdle(); assert.equal(active.handles.size, 0)
  }
  {
    const cleanup = setup()
    const names = ['v.state.json', 'orphan.state.json.bak', 'seed.state.json.' + UUID + '.tmp',
      'legacy.state.json.1730000000000.2.tmp', 'lockonly.state.json.commit.lock']
    for (const name of names) active.put(DIR + '/' + name)
    active.put(DIR + '/unrelated.json')
    const lockOnly = active.nodes.get(DIR + '/lockonly.state.json.commit.lock')
    await cleanup.removeStateFilesKeepingStableLocks({projectId: 'p'})
    for (const name of names.filter(name => !name.endsWith('.commit.lock'))) assert(!active.nodes.has(DIR + '/' + name))
    assert.equal(active.nodes.get(DIR + '/lockonly.state.json.commit.lock'), lockOnly)
    assert.equal(active.events.filter(event => event.op === 'locked').length, 5)
    assert(active.nodes.has(DIR + '/unrelated.json'))
  }
  for (const op of ['open', 'list', 'lstat', 'stat', 'tryLock', 'fsync', 'unlink']) {
    const cleanup = setup(); active.put(MAIN)
    active.rules.push({op, run() { throw native(13900013) }})
    await assert.rejects(cleanup.removeStateFilesKeepingStableLocks(scope), /STATE_/)
    const count = pool.tasks.length
    await assert.rejects(cleanup.removeStateFilesKeepingStableLocks(scope), /STATE_/)
    await assert.rejects(cleanup.whenIdle(), /STATE_/)
    assert.equal(pool.tasks.length, count, 'failed project must stay fenced')
    if (op !== 'unlink') assert.equal(deleted().length, 0)
  }
  {
    const cleanup = setup(); active.put(MAIN); active.put(MAIN + '.bak')
    active.rules.push({op: 'unlink', name: MAIN + '.bak', run() { throw native(13900013) }})
    await assert.rejects(cleanup.removeStateFilesKeepingStableLocks(scope), /STATE_COMMIT_UNCERTAIN/)
    assert(!active.nodes.has(MAIN)); assert(active.nodes.has(MAIN + '.bak')); assert(active.nodes.has(LOCK))
  }
  {
    const cleanup = setup(); active.put(MAIN)
    let count = 0
    active.rules.push({op: 'fsync', run() { if (++count === 2) throw native(13900005) }})
    await assert.rejects(cleanup.removeStateFilesKeepingStableLocks(scope), /STATE_COMMIT_UNCERTAIN/)
    assert(!active.nodes.has(MAIN)); assert(active.nodes.has(LOCK))
  }
  for (const op of ['unlock', 'close']) {
    const cleanup = setup(); active.put(MAIN)
    let fired = false
    active.rules.push({op, name: LOCK, run() {
      if (!fired) { fired = true; throw native(13900005) }
    }})
    await assert.rejects(cleanup.removeStateFilesKeepingStableLocks(scope), /STATE_COMMIT_UNCERTAIN/)
    await assert.rejects(cleanup.whenIdle(), /STATE_COMMIT_UNCERTAIN/)
    assert(active.nodes.has(LOCK))
  }
  {
    const cleanup = setup(); active.put(MAIN)
    const temp = MAIN + '.' + UUID + '.tmp'
    active.rules.push({op: 'locked', name: LOCK, run() { active.put(temp) }})
    await cleanup.removeStateFilesKeepingStableLocks(scope)
    assert(!active.nodes.has(temp), 'relist under the lock must include a final writer temp')
  }
  {
    const cleanup = setup(); active.put(MAIN)
    active.put(DIR + '/z.state.json.bak'); active.put(DIR + '/z.state.json.commit.lock').owner = 999
    await assert.rejects(cleanup.removeStateFilesKeepingStableLocks({projectId: 'p'}), /STATE_LOCK_UNAVAILABLE/)
    assert.equal(deleted().length, 0, 'project removal must acquire every identity before deleting anything')
    assert.equal(active.nodes.get(LOCK).owner, undefined)
  }
  for (const kind of ['dir', 'symlink']) {
    const cleanup = setup(); active.put(MAIN, kind)
    await assert.rejects(cleanup.removeStateFilesKeepingStableLocks(scope), /STATE_UNAVAILABLE/)
    assert.equal(deleted().length, 0)
  }
  {
    const cleanup = setup(); active.put(MAIN); active.put(LOCK).owner = 999
    await assert.rejects(cleanup.removeStateFilesKeepingStableLocks(scope), /STATE_LOCK_UNAVAILABLE/)
    assert.equal(active.events.filter(event => event.op === 'tryLock').length, 1)
    assert.equal(deleted().length, 0)
  }
  {
    const cleanup = setup(); active.put(MAIN)
    let lists = 0
    active.rules.push({op: 'list', run() { if (++lists === 2) active.put(DIR + '/late.state.json') }})
    await assert.rejects(cleanup.removeStateFilesKeepingStableLocks({projectId: 'p'}), /STATE_LOCK_UNAVAILABLE/)
    assert.equal(deleted().length, 0)
  }
  {
    const cleanup = setup(); active.nodes.delete(DIR)
    await cleanup.removeStateFilesKeepingStableLocks(scope)
    assert.equal(deleted().length, 0)
  }
  {
    const cleanup = setup(); active.nodes.delete(ROOT)
    await assert.rejects(cleanup.removeStateFilesKeepingStableLocks(scope), /STATE_UNAVAILABLE/)
  }
  for (const op of ['lstat', 'unlink']) {
    const cleanup = setup(); active.put(MAIN)
    active.rules.push({op, name: MAIN, run() { active.nodes.delete(MAIN); throw native(13900002) }})
    await cleanup.removeStateFilesKeepingStableLocks(scope)
  }
  {
    const cleanup = setup(); active.put(MAIN)
    pool.plans.push({hold: true})
    const mutable = {...scope}, first = cleanup.removeStateFilesKeepingStableLocks(mutable)
    mutable.projectId = 'not-p'
    const second = cleanup.removeStateFilesKeepingStableLocks(scope)
    await tick(); assert.equal(pool.executions.length, 1)
    assert.equal(pool.executions[0].args[2].scope.projectId, 'p')
    pool.finish(); await first; await second
    assert.equal(pool.executions.length, 2)
    await cleanup.close()
    await assert.rejects(cleanup.removeStateFilesKeepingStableLocks(scope), /STATE_UNAVAILABLE/)
  }
  {
    setup(); active.put(MAIN)
    const options = {directoryFsync: 'REQUIRED', lockTimeoutMs: 0, tmpOrphanAgeMs: 60000}
    const cleanup = new StateCleanupTaskPool(ROOT, options)
    options.directoryFsync = 'UNSUPPORTED'; options.lockTimeoutMs = -1; options.tmpOrphanAgeMs = -1
    await cleanup.removeStateFilesKeepingStableLocks(scope)
    assert.deepEqual(pool.executions[0].args[1], {directoryFsync: 'REQUIRED', lockTimeoutMs: 0, tmpOrphanAgeMs: 60000})
    assert(!active.nodes.has(MAIN))
  }
  {
    const cleanup = setup(), io = load('StateIo'), original = io.runStateCleanupTask
    io.runStateCleanupTask = () => { throw Error('unexpected worker failure') }
    try {
      await assert.rejects(cleanup.removeStateFilesKeepingStableLocks(scope), /STATE_COMMIT_UNCERTAIN at cleanup-worker-execute/)
      await assert.rejects(cleanup.whenIdle(), /STATE_COMMIT_UNCERTAIN/)
      assert.equal(pool.tasks.length, 1)
    } finally { io.runStateCleanupTask = original }
  }
  for (const plan of [{submitError: true}, {rejectBefore: true}, {rejectLate: true}, {rejectAfter: true},
    {reply: value => ({...value, operationId: 'wrong'})}, {reply: () => null},
    {reply: value => ({...value, result: {status: 'REMOVED', extra: true}})},
    {reply: value => ({...value, result: {status: 'FAILED', code: 'fake', stage: 'fake'}})}]) {
    const cleanup = setup(); active.put(MAIN); pool.plans.push(plan)
    const first = cleanup.removeStateFilesKeepingStableLocks(scope)
    const second = cleanup.removeStateFilesKeepingStableLocks(scope)
    await assert.rejects(first, /STATE_COMMIT_UNCERTAIN/)
    await assert.rejects(second, /STATE_COMMIT_UNCERTAIN/)
    await assert.rejects(cleanup.whenIdle(), /STATE_COMMIT_UNCERTAIN/)
    assert.equal(pool.tasks.length, 1)
    if (plan.rejectLate) { pool.finish(); assert(!active.nodes.has(MAIN)) }
  }
  {
    const cleanup = setup(); pool.plans.push({createError: true})
    await assert.rejects(cleanup.removeStateFilesKeepingStableLocks(scope), /STATE_TASK_SUBMIT_FAILED/)
    assert.equal(pool.executions.length, 0)
  }
  {
    const cleanup = setup()
    for (const bad of [{projectId: '..'}, {projectId: 'p/x'}, {projectId: 'p', versionId: ''},
      {projectId: 'p', versionId: '../v'}, {projectId: 'p', context: {}}]) {
      await assert.rejects(cleanup.removeStateFilesKeepingStableLocks(bad), /STATE_VALIDATION_FAILED/)
    }
    assert.equal(pool.tasks.length, 0)
    assert.throws(() => new StateCleanupTaskPool(ROOT, {directoryFsync: 'UNSUPPORTED'}), /STATE_VALIDATION_FAILED/)
  }
  for (const fail of [false, true]) {
    const cleanup = setup(), f = projectFixture()
    const version = await f.facade.createVersion(f.input())
    const name = ROOT + '/' + f.project.id + '/' + version.id + '.state.json'
    active.put(ROOT + '/' + f.project.id, 'dir'); active.put(name)
    f.cleanup.removeStateFilesKeepingStableLocks = scope => cleanup.removeStateFilesKeepingStableLocks(scope)
    if (fail) active.rules.push({op: 'unlink', run() { throw native(13900013) }})
    const operation = f.facade.clearState(f.project.id, version.id)
    if (fail) {
      await assert.rejects(operation, /STATE_COMMIT_UNCERTAIN/)
      await assert.rejects(f.facade.loadState(f.project.id, version.id, ''), /fenced/)
      assert(f.events.includes('release:FAILED'))
    } else {
      await operation; assert(!active.nodes.has(name)); assert(f.events.includes('release:CLEARED'))
    }
    assert(f.store.getVersion(f.project.id, version.id))
  }
  assert(!dependencies.some(name => /Context|Store|Interpreter|Host/.test(name)))
}
projectStateChecks().then(() => console.log('state-carry-check: ok'), error => { console.error(error); process.exitCode = 1 })
