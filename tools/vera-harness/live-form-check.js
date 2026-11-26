// Actual form service and stores, with only filesystem/platform boundaries mocked.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const ts = require(process.env.VERA_TYPESCRIPT_PATH || 'typescript')
const { loadVera, sourceRoot } = require('./source-loader')
let readingForm = false
const formOperations = []
function metadataMutation(operation) {
  if (readingForm) formOperations.push({op: operation})
  assert(!readingForm, 'Form must not mutate metadata: ' + operation)
}
const worker = require('./state-io-check').createWorkerFixture('/fixture/vera', event => {
  if (readingForm) formOperations.push(event)
})
const {disk, memory} = worker, cache = new Map()
const formProvider = {}
const filesystem = {
  OpenMode: { CREATE: 1, WRITE_ONLY: 2, TRUNC: 4 },
  mkdirSync(file) {
    metadataMutation('mkdir')
    if (!memory.nodes.has(file)) {
      this.mkdirSync(path.dirname(file))
      memory.put(file, '', 'dir')
    }
  },
  openSync(file) { metadataMutation('open-write'); return { fd: file } },
  writeSync(file, value) { metadataMutation('write'); disk.set(file, value); return Buffer.byteLength(value, 'utf8') }, closeSync() {},
  statSync: file => memory.statSync(file),
  readTextSync(file) { if (!disk.has(file)) throw Object.assign(Error('absent'), {code: 13900002}); return disk.get(file) },
  renameSync(from, to) { metadataMutation('rename'); assert(disk.has(from)); disk.set(to, disk.get(from)); disk.delete(from) },
  unlinkSync(file) { metadataMutation('unlink'); disk.delete(file) },
  listFileSync: dir => memory.listFileSync(dir)
}
const committedFilesystem = {OpenMode: worker.filesystem.OpenMode}
for (const method of ['openSync', 'closeSync', 'statSync', 'lstatSync', 'readSync', 'writeSync', 'fsyncSync', 'renameSync', 'unlinkSync', 'mkdirSync', 'listFileSync']) {
  committedFilesystem[method] = memory[method].bind(memory)
}
const base = path.join(sourceRoot, 'vera')
function load(name) {
  const file = path.resolve(base, name + '.ets')
  if (cache.has(file)) return cache.get(file).exports
  if (['VeraLiveWidget', 'VeraStateStamp', 'VeraSource', 'VeraInterpreter'].includes(path.basename(name))) return loadVera(path.basename(name))
  const module = { exports: {} }; cache.set(file, module)
  const source = fs.readFileSync(file, 'utf8').replace(/^@Concurrent\s*$/gm, '')
  const compiled = ts.transpileModule(source, { fileName: file.replace(/\.ets$/, '.ts'),
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, reportDiagnostics: true })
  assert.deepEqual((compiled.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error), [])
  new Function('require','module','exports', compiled.outputText)(dep => {
    if (dep === '@kit.CoreFileKit') return { fileIo: file === path.join(sourceRoot, 'runtime/StateIo.ets') ? committedFilesystem : filesystem }
    if (dep === '@kit.ArkTS') return {util: worker.util, taskpool: worker.taskpool}
    if (dep === '@kit.BasicServicesKit') return {systemDateTime: {TimeType: {STARTUP: 0}, getUptime: () => 10000}}
    if (dep === '@kit.PerformanceAnalysisKit') return {hilog: {info() {}}}
    if (dep === '@kit.CryptoArchitectureKit') return {cryptoFramework: worker.cryptoFramework}
    if (dep === '@ohos.fileio') return {default: worker.legacyFilesystem}
    if (dep === '@kit.FormKit') return { formProvider, formBindingData: { createFormBindingData: value => value } }
    if (dep.startsWith('.')) return load(path.relative(base, path.resolve(path.dirname(file), dep)))
    throw Error(dep)
  }, module, module.exports)
  return module.exports
}
const snapshot = () => [...memory.nodes].sort(([a], [b]) => a.localeCompare(b))
  .map(([file, node]) => [file, node.kind, node.id, node.mtime, node.data.toString('hex'), node.owner])
async function readOnly(work) {
  const before = snapshot(), tasks = worker.taskpool.tasks.length, operations = formOperations.length
  readingForm = true
  try { return await work() } finally {
    readingForm = false
    for (const event of formOperations.slice(operations)) {
      assert(['open', 'stat', 'read', 'close', 'list'].includes(event.op), 'Form must not mutate storage: ' + event.op)
      if (event.op === 'open') assert.equal(event.flags & 3, worker.filesystem.OpenMode.READ_ONLY)
    }
    assert.deepEqual(snapshot(), before, 'Form reads/refusals preserve every file and directory')
    assert.equal(worker.taskpool.tasks.length, tasks, 'Form must not submit background writers')
    assert.equal(memory.fds.size, 0)
    assert([...memory.nodes.values()].every(node => node.owner === null))
  }
}
const {assembleStateFile, canonicalPayload} = load('../runtime/StateFileFormat')
const statePath = (projectId, versionId) => '/fixture/vera/' + projectId + '/' + versionId + '.state.json'
function appCommit(projectId, version, encoded, revision = 1) {
  disk.set(statePath(projectId, version.id), assembleStateFile({appId: projectId + '/' + version.id,
    schemaVersion: 1, vmGeneration: 1, revision, stamp: loadVera('VeraStateStamp').veraStateStamp(version.vbc2)}, canonicalPayload(JSON.parse(encoded))))
}
const {store} = load('ProjectStore'), {formBindings} = load('FormBindings')
store.init('/fixture'); formBindings.init('/fixture')
const project = store.createProject('Counter','🔢')
const source = fs.readFileSync(path.join(__dirname,'examples/widget-counter.vera'),'utf8')
;(async () => {
const version = await store.createVersion(project.id,source,loadVera('VeraCompiler').compileVeraSource(source).vbc2,'Counter')
formBindings.bind('form-1',project.id); formBindings.bind('form-2',project.id)
assert.deepEqual(formBindings.formsFor(project.id), ['form-1','form-2'])
const {FormBindings} = load('FormBindings'), other = new FormBindings(); other.init('/fixture')
assert.equal(other.projectFor('form-1'), project.id)
const service = load('LiveFormService'), {veraStateStamp} = load('VeraStateStamp')
const absent = await readOnly(() => service.liveFrame(project.id))
assert(!absent.live); assert.equal(absent.status, 'Open app to initialize state')
assert.equal(await store.loadState(project.id,version.id,veraStateStamp(version.vbc2)), '')
const {WidgetSession} = loadVera('VeraLiveWidget')
appCommit(project.id, version, new WidgetSession(version.vbc2,version.id,'').encodedState())
const initial = await readOnly(() => service.liveFrame(project.id))
assert(initial.live)
const tap = async (token, value) => readOnly(() => service.liveFormTap('form-1', JSON.stringify({action:'message',handler:'change',token,value})))
const updated = await tap(initial.token,1)
assert(updated.live); assert.equal(updated.formId,'form-1'); assert.equal(updated.token,initial.token)
assert.equal(updated.status, 'Open app to interact; widget actions unavailable')
const saved = await store.loadState(project.id,version.id,veraStateStamp(version.vbc2))
const stale = await tap('stale-token',1)
assert.equal(stale.status, updated.status)
assert.equal(await store.loadState(project.id,version.id,veraStateStamp(version.vbc2)),saved)
const forged = await tap(updated.token,999)
assert.equal(forged.status, updated.status)
// A refused tap gives back the seq of the frame the card showed: the card is not drawn again, so a touched Motion does not play.
const refused = await readOnly(() => service.liveFormTap('form-1', JSON.stringify({handler:'change',token:updated.token,seq:'shown-seq',value:999})))
assert.equal(refused.status, updated.status); assert.equal(refused.seq, 'shown-seq'); assert.equal(refused.token, updated.token)
assert.equal(await store.loadState(project.id,version.id,veraStateStamp(version.vbc2)),saved)
assert.equal(store.listVersions(project.id).length,1)
assert(![...disk.keys()].some(file=>file.endsWith('.tmp')))
assert.equal((await readOnly(() => service.liveBinding(project.id,'form-2'))).token, updated.token)
const second = await readOnly(() => service.liveFormTap('form-2', JSON.stringify({handler:'change',token:updated.token,value:-1})))
assert.equal(second.token,updated.token)
assert.equal(second.status, updated.status)
assert.equal((await tap(updated.token,1)).status, updated.status)
assert.equal(await store.loadState(project.id,version.id,veraStateStamp(version.vbc2)),saved)
// Additive refinement publishes saved state before the new version is discoverable.
const nextSource = source + '\nfunction widgetHelper(): number { return 1; }'
const nextCode = loadVera('VeraCompiler').compileVeraSource(nextSource).vbc2
const carried = await store.loadState(project.id,version.id,veraStateStamp(version.vbc2))
const publishing = store.createVersion(project.id,nextSource,nextCode,'Make widget','','','','','',null,carried,veraStateStamp(nextCode))
assert(publishing instanceof Promise)
assert.equal(store.getLatestVersion(project.id).id, version.id)
const nextVersion = await publishing
assert.equal(await store.loadState(project.id,nextVersion.id,veraStateStamp(nextCode)),carried)
assert.equal(await store.loadState(project.id,version.id,veraStateStamp(version.vbc2)),carried)
formBindings.bind('form-1','missing-project')
assert.equal(service.liveFrame(formBindings.projectFor('form-1')).title,'App removed')
formBindings.bind('form-1',project.id)
assert.equal(service.liveBinding(project.id,'form-1').formId,'form-1')
assert.equal(formBindings.dimensionFor('form-2'), 2, 'a card that never said its size is 2x2')
formBindings.setDimension('form-2', 4); assert.equal(other.dimensionFor('form-2'), 4, 'the size is shared with the other process')
assert.equal(service.liveBinding(project.id, 'form-2').dimension, 4, 'and the card is fitted to it')
formBindings.setDimension('form-2', 9); assert.equal(formBindings.dimensionFor('form-2'), 2, 'an unknown size is forgotten')
formBindings.setDimension('form-2', 3)
other.unbind('form-1'); assert.equal(formBindings.projectFor('form-1'),''); assert.equal(formBindings.projectFor('form-2'),project.id); assert.equal(formBindings.dimensionFor('form-1'), 2, 'a removed card forgets its size')
assert.equal(service.liveBinding('', 'unbound').formId, 'unbound')
const {refreshLedger} = load('FormBindings'); refreshLedger.init('/fixture')
const dailySource = fs.readFileSync(path.join(__dirname,'examples/widget-daily.vera'),'utf8')
const daily = store.createProject('Daily','📅')
const dailyVersion = await store.createVersion(daily.id,dailySource,loadVera('VeraCompiler').compileVeraSource(dailySource).vbc2,'Daily')
const dailyStamp = veraStateStamp(dailyVersion.vbc2)
formBindings.bind('form-d1',daily.id); formBindings.bind('form-d2',daily.id)
const withFields = (count, day) => { const s = JSON.parse(new WidgetSession(dailyVersion.vbc2,'x','').encodedState())
  for (const [name, value] of s[2]) { if (name === 'count') value[1] = count; if (name === 'day' && day !== null) value[1] = day }
  return JSON.stringify(s) }
const countOf = async () => JSON.parse(await store.loadState(daily.id,dailyVersion.id,dailyStamp))[2].find(f => f[0] === 'count')[1][1]
appCommit(daily.id,dailyVersion,withFields(5, 1))
const T = 1_800_000_000_000, period = 15 * 60_000
const first = await readOnly(() => service.liveFormRefresh('form-d1', T))
assert.equal(first.ran, false); assert.equal(await countOf(), 5, 'Form cannot reset yesterday\'s state'); assert.equal(first.binding.formId, 'form-d1')
appCommit(daily.id,dailyVersion,withFields(3, null), 2)
assert(!(await readOnly(() => service.liveFormRefresh('form-d2', T + 60_000))).ran)
const later = await readOnly(() => service.liveFormRefresh('form-d2', T + period))
assert.equal(later.ran, false); assert.equal(await countOf(), 3, 'Form only redraws the app commit')
assert(!(await readOnly(() => service.liveFormRefresh('form-2', T))).ran)
const liveSource = fs.readFileSync(path.join(__dirname,'examples/widget-source.vera'),'utf8')
const live = store.createProject('IMOEX','📈')
const liveVersion = await store.createVersion(live.id,liveSource,loadVera('VeraCompiler').compileVeraSource(liveSource).vbc2,'IMOEX')
formBindings.bind('form-s1',live.id)
const liveSeed = new WidgetSession(liveVersion.vbc2,'x','').encodedState()
appCommit(live.id,liveVersion,liveSeed)
const asked = []
const fetched = await readOnly(() => service.liveFormRefresh('form-s1', T, async params => { asked.push(Object.fromEntries(params)); assert.fail('Form must not fetch') }))
assert.equal(fetched.ran, false); assert.equal(asked.length, 0)
assert(fetched.binding.live)
assert.equal(await store.loadState(live.id,liveVersion.id,veraStateStamp(liveVersion.vbc2)),liveSeed)
let failedFetches = 0
const failed = await readOnly(() => service.liveFormRefresh('form-s1', T + period, async () => { failedFetches++; throw Error('HTTP 503') }))
assert.equal(failed.ran, false); assert.equal(failedFetches, 0)
assert.deepEqual(failed.binding.nodes, fetched.binding.nodes)
appCommit(live.id,liveVersion,liveSeed, 2)
const shown = await readOnly(() => service.liveBinding(live.id))
const button = JSON.stringify(shown.nodes).includes('"refresh"')
assert(button, 'the widget has its Refresh button')
let tappedFetches = 0
const tapped = await readOnly(() => service.liveFormTap('form-s1', JSON.stringify({handler: 'refresh', token: shown.token, seq:'refresh-seq', value: 0}),
  async () => { tappedFetches++; assert.fail('Form tap must not fetch') }))
assert.equal(tappedFetches, 0); assert.equal(tapped.status, updated.status)
assert.deepEqual(tapped.nodes, shown.nodes)
assert.equal(tapped.seq, 'refresh-seq'); assert.equal(shown.seq, '')
assert.equal(await store.loadState(live.id,liveVersion.id,veraStateStamp(liveVersion.vbc2)),liveSeed)
{
  const fresh = new WidgetSession(liveVersion.vbc2,'x','').encodedState()
  appCommit(live.id,liveVersion,fresh, 3)
  const shown = await readOnly(() => service.liveFrame(live.id))
  const appState = JSON.parse(fresh); for (const f of appState[2]) if (f[0] === 'lastCall') f[1][1] = 42
  appCommit(live.id,liveVersion,JSON.stringify(appState), 4)
  let calls = 0
  const refused = await readOnly(() => service.liveFormTap('form-s1', JSON.stringify({handler: 'refresh', token: shown.token, value: 0}), async () => {
    calls++; assert.fail('Form must not start a fetch or merge its result') }))
  const after = JSON.parse(await store.loadState(live.id,liveVersion.id,veraStateStamp(liveVersion.vbc2)))[2]
  assert.equal(calls, 0); assert.equal(refused.status, updated.status)
  assert.equal(after.find(f => f[0] === 'lastCall')[1][1], 42, 'the app commit after the shown frame is kept')
  assert.equal(after.find(f => f[0] === 'value')[1][1], JSON.parse(fresh)[2].find(f => f[0] === 'value')[1][1])
}
{
  formBindings.bind('form-s2', live.id)
  let fetches = 0
  const slow = async () => { fetches++; assert.fail('Concurrent Form refresh must not fetch') }
  const at = T + 5 * period
  const [a, b] = await readOnly(() => Promise.all([service.liveFormRefresh('form-s1', at, slow), service.liveFormRefresh('form-s2', at, slow)]))
  assert.equal(fetches, 0); assert.equal([a.ran, b.ran].filter(Boolean).length, 0)
  assert.equal(a.binding.token, b.binding.token)
  assert.deepEqual(a.binding.nodes, b.binding.nodes)
}
// Add widget through the system widget manager: the project offered is taken by the next card, once, while fresh.
formBindings.offer(project.id, T)
assert.equal(other.takeOffer(T + 30_000), project.id, 'the card added in the manager takes the offered project')
assert.equal(formBindings.takeOffer(T + 31_000), '', 'a second card is not bound to it')
formBindings.offer(project.id, T)
assert.equal(formBindings.takeOffer(T + 6 * 60_000), '', 'a stale offer is dropped')
const {publishLiveWidget, bindLiveForm, WIDGET_ADDED} = load('LiveWidgetPublish')
const sdkCalls = []
const resetProvider = (supported = true) => {
  sdkCalls.length = 0
  Object.assign(formProvider, {
    isRequestPublishFormSupported() { sdkCalls.push('support'); return Promise.resolve(supported) },
    openFormManager(want) { sdkCalls.push('manager'); assert.equal(want.parameters.projectId, project.id) },
    requestPublishForm(want, binding) {
      sdkCalls.push('publish')
      assert.equal(want.bundleName, 'com.vera.probe.dyn'); assert.equal(want.abilityName, 'VeraFormAbility')
      assert.equal(want.parameters.projectId, project.id); assert.equal(want.parameters['ohos.extra.param.key.form_name'], 'live')
      assert.equal(binding.projectId, project.id)
      return Promise.resolve('published-form')
    },
    getPublishedRunningFormInfoById(id) {
      sdkCalls.push('lookup'); assert.equal(id, 'bound-form')
      return Promise.resolve({formName: 'live', bundleName: 'com.vera.probe.dyn'})
    },
    getPublishedRunningFormInfos() { sdkCalls.push('refresh'); return Promise.resolve([]) }
  })
}
resetProvider()
assert.equal(await publishLiveWidget(project.id), WIDGET_ADDED)
assert.equal(formBindings.projectFor('published-form'), project.id)
assert.deepEqual(sdkCalls, ['support', 'publish', 'refresh'])
formBindings.unbind('published-form')
resetProvider(false)
assert.equal(await publishLiveWidget(project.id), 'Your launcher opened its widget list. Pick VERA live app: it will show this app.')
assert.deepEqual(sdkCalls, ['support', 'manager'])
assert.equal(other.takeOffer(), project.id)
assert.equal(other.takeOffer(), '')
resetProvider()
assert.equal(await bindLiveForm('bound-form', project.id), undefined)
assert.equal(formBindings.projectFor('bound-form'), project.id)
assert.deepEqual(sdkCalls, ['lookup', 'refresh'])
formBindings.unbind('bound-form')
for (const [method, supported, operation, calls] of [
  ['isRequestPublishFormSupported', true, () => publishLiveWidget(project.id), ['support']],
  ['requestPublishForm', true, () => publishLiveWidget(project.id), ['support', 'publish']],
  ['openFormManager', false, () => publishLiveWidget(project.id), ['support', 'manager']],
  ['getPublishedRunningFormInfoById', true, () => bindLiveForm('bound-form', project.id), ['lookup']]
]) {
  for (const asynchronous of method === 'openFormManager' ? [false] : [false, true]) {
    resetProvider(supported)
    const failure = Object.assign(new Error(method + (asynchronous ? ' rejected' : ' threw')), {code: 16500050, data: {method}})
    formProvider[method] = () => {
      sdkCalls.push(calls[calls.length - 1])
      if (asynchronous) return Promise.reject(failure)
      throw failure
    }
    let pending
    assert.doesNotThrow(() => { pending = operation() })
    assert(pending instanceof Promise)
    await assert.rejects(pending, error => { assert.strictEqual(error, failure); return true })
    assert.deepEqual(sdkCalls, calls)
    assert.equal(formBindings.projectFor('published-form'), '')
    assert.equal(formBindings.projectFor('bound-form'), '')
    formBindings.takeOffer()
  }
}
for (const info of [
  {formName: 'widget', bundleName: 'com.vera.probe.dyn'},
  {formName: 'live', bundleName: 'another.bundle'}
]) {
  resetProvider()
  formProvider.getPublishedRunningFormInfoById = () => { sdkCalls.push('lookup'); return Promise.resolve(info) }
  await assert.rejects(bindLiveForm('bound-form', project.id), /Not a VERA live widget/)
  assert.equal(formBindings.projectFor('bound-form'), '')
  assert.deepEqual(sdkCalls, ['lookup'])
}
console.log('PASS live forms: publish/bind success, SDK synchronous throws and async rejections preserve error identity, unsupported manager, foreign-card rejection, one-shot fresh offer, binding persistence/removal, committed read-only rendering, initialization refusal, tap/refresh refusal without fetches or writes, app-state preservation, concurrent cards')
})().catch(e => { console.error(e); process.exit(1) })
