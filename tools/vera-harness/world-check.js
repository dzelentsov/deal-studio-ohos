// ui.World and std/scene on the host: the module compiles from its table, the three example worlds compile, build
// and smoke-run, a world flattens into its spec within its contract (one id per body, at most 300, one camera,
// orbit centres that exist and do not go round in a circle), the diff creates, removes, updates and kicks only
// what it should, orbits chain, a die's top face is right for all 24 ways it can lie, the prompt describes it all,
// and wrong build or event functions -- or a program of its own named `scene` -- are compile errors.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {retainedPayloadChecks, retainedOwnership, retainedLimits} = require('./gfx-check')
const worldRetained = {
  name: 'scene retained payload',
  types: ['SceneThing', 'SceneThingValue', 'SceneOrbit', 'SceneKick', 'ScenePath', 'SceneWander', 'ScenePlayer',
    'SceneFollow', 'SceneSwing', 'BodySpec', 'WorldSpec', 'WorldDiff', 'CameraSpec', 'FloorSpec', 'TableSpec', 'SkySpec', 'ZoneSpec', 'FollowSpec'],
  keys: ['thing', 'points', 'parts', 'orbit', 'bodies'], payloadKeys: ['thing'],
  modules: ['VeraScene', 'VeraPhysics', 'VeraWorldPlay'],
  files: ['components/VeraWorld3D.ets', 'vera/VeraScene.ets', 'vera/VeraPhysics.ets', 'vera/VeraWorldPlay.ets'],
  ownership: retainedOwnership, limits: retainedLimits,
  synchronous: [
    {file: 'vera/VeraScene.ets', owner: 'asNumbers', reachability: 'VM synchronous',
      cost: 'Checks caller-provided most before primitive copy; shape/hull/path callers select finite geometry caps',
      budget: 'Host boundary elapsed time only; geometry validation and hull construction run synchronously',
      evidence: ['let out: number[] = []', "if (items.length > most) { throw new RuntimeTrap('R0029', 'scene: ' + what + ' holds at most ' + most.toString() + ' numbers; got ' + items.length.toString()) }"]},
    {file: 'vera/VeraScene.ets', owner: 'asParts', reachability: 'VM synchronous',
      cost: 'MAX_GROUP_PARTS=16 checked before traversal; MAX_BODY_PARTS=32 checked after partCount geometry work',
      budget: 'Host pre/post samples, no preemption within geometry computation',
      evidence: ['let out: SceneThing[] = []', "if (items.length < 1 || items.length > MAX_GROUP_PARTS) { throw new RuntimeTrap('R0029', where + ' holds 1 to ' + MAX_GROUP_PARTS.toString() + ' parts; got ' + items.length.toString()) }"]},
    {file: 'vera/VeraScene.ets', owner: 'decodeScene', reachability: 'outside VM',
      cost: 'Post-build decoding scans supplied elements; body/zone caps do not cap skipped inputs',
      budget: 'Caller wall time, not interpreter instruction or host-boundary sampling',
      evidence: ['let world = new WorldSpec()', 'if (!(value instanceof VeraArrayValue)) { return world }']}
  ],
  review: {
    SceneThing: 'D copy is shallow: points, parts, kick, orbit, path, wander, player, follow, swing remain borrowed immutable aliases',
    bodySpec: 'D fresh BodySpec tree and pose/dimension arrays; points and motion metadata alias retained SceneThing',
    MotionCarry: 'D fresh-decoded BodySpec mutation before retention: travelStart/rotation replacement and copied orbit, never orbit.phaseDeg in place',
    consumers: 'Physics/WorldPlay/World3D/Preview/runtime/locomotion/look read payloads; renderer caches/nodes/maps and carried motion records are owned separately; makeRevisionedFrame reads borrowed scene specs into JSON-detached output without mutating source payloads',
    benchmark: 'D p2Validate reads SceneThing payloads into a fresh decoded world and discards it; p2Fingerprint serializes VM fields and queued effect metadata, not retained thing fields. Synthetic scene events are fresh local VM allocations; no borrowed payload writes, native effect dispatch, effect callback execution or native lifetime changes',
    nativeAudit: 'Completed native-source review: physics copies typed-array input synchronously into native-owned data; step job captures dt/substeps by value and uses owned world pointers; USB workers join; llama copies inputs. No VM-graph aliases retained; this harness does not execute NAPI or prove native lifetimes',
    nativeBudget: 'Physics step/stepEnd/Idle waits are renderer/simulation paths outside UiHostEnvironment VM dispatch; USB join and model/search work are not VM synchronous host routes. Native waits remain non-preemptible caller costs, not VM budget coverage',
    unresolved: 'WorldBox next !== prev is an identity gate, not universal freshness proof; retry/publication ordering remains separate from native ownership audit'
  },
  discovery: {
    'components/VeraPreview.ets': '353361b29bac4b170dcfca4bf6f2a8d120f646a1a8ec7a7f3f44b6369d55cfa4',
    'components/VeraWorld3D.ets': '300ecbf4f0e948f361970f6698cb13061d909b837d78edefd3c83373ee1b4047',
    'runtime/AppActor.ets': '68ad123b5f1fa109b1ea2327eb21723bc16d4f10205a16b596411496b2041830',
    'runtime/InProcessHost.ets': '5a18779450ce883361fab52a1a0abf58696f4f74b5624f1429e9a099f5b5e9cf',
    'runtime/shared/Messages.ets': 'ae8f8e064d357d7a761386023b204a0900d6b391246106a088a18b0851d6752e',
    'vera/agent/AgentSurface.ets': '35e117360d2c8a754c8c887fc9bd2ab9abfe5487ab3e6d64951e2d04c4a216c4',
    'vera/VeraCompiler.ets': '67de636f4ce1cc7649ff653a8783915b1e909e17b71d6616bc02aaecad32b0fb',
    'vera/VeraLocomotion.ets': 'c84270ffc984e7c9c3c6fd8b9ed9fbc8ba62ea595906d605f01eb1acadaecd67',
    'vera/VeraLook3D.ets': '97a287ab41223edf8c13b95da2db4f869bd33060069a85425c719c561cbc5ce3',
    'vera/VeraPhysics.ets': 'ca8b7ab69e51e59e38725bfaa82cc11c6d2956450a4483ab80511ae3d00d5fb4',
    'vera/VeraScene.ets': '53b3e4e23b92a4c740f3d1b8fe69e48518cfb8ca2ffda6746a14b5cadc2c08ad',
    'vera/VeraSearchBenchmark.ets': '48e5717398ea44d70369f6ca4d3d575a59604b2a12775f4eebb49378331e4582',
    'vera/VeraSmoke.ets': '95624e72708e34cc302286aae108552f5d3ba453b44ff2681a70d6219aca9605',
    'vera/VeraUi.ets': 'f063c2f2dfaa7cade58dbf2237c99c2ae92792d223c18ba55eee87bea67f0acc',
    'vera/VeraUiCatalog.ets': '4c2462c94dfc193398837d23303a0e6aa212849e5b0e884f3a55602753a1c587',
    'vera/VeraWorldPlay.ets': 'ebb49161a017750dfba277b94ad74f372e37410f27510bf50326d499ad015c11'
  },
  inventory: {
    'components/VeraPreview.ets': [5, 34, '6a10718813efee20c3e7edca2a29010ef3620435e41af5e42b9ce86e9d8b8ad0'],
    'components/VeraWorld3D.ets': [38, 412, '7e03d4a8f8b76bf0cc2fd2804dc0d52a769eef72d501382ac100f3f060980c45'],
    'runtime/AppActor.ets': [1, 4, '5e5190dd00eeeb21c09f5ebe4a3be7f6c68f1642c770d04d77f7af93c13e993e'],
    'runtime/InProcessHost.ets': [2, 19, '047babf1892945cdfc3adc8cb943ea08596c5fd39c83684d861dd1c7f58bc9b2'],
    'vera/VeraLocomotion.ets': [8, 54, 'acf5f400277924ed50c2dd3571b530af50a04cb5be55acad6fe79e1cfc45dc0e'],
    'vera/VeraLook3D.ets': [16, 162, 'e125634e115f70fe2be82b0f22ec71d0d90366b7c4dfc9c13a310263ee4e35e7'],
    'vera/VeraPhysics.ets': [14, 217, '6215ec5a44dbf1305ac8b41d147a32832efb0d991210d7a45ebf9b9541163e75'],
    'vera/VeraScene.ets': [37, 725, '07d5b072c42b5729bc4a10c21c59be32351293be144442f79945851a005d2c29'],
    'vera/VeraSearchBenchmark.ets': [1, 1, '98445d56d4e2e79ddd789eeecf629942212acf7475306e65929b8aa8679307e8'],
    'vera/VeraSmoke.ets': [1, 1, 'd474d5c5007bd78b14332d52db0dcaa6f9d2472184eb9cc1224b29c8beb6b57b'],
    'vera/VeraWorldPlay.ets': [25, 342, '1eaf828fc366b6ccb6d8f5a97120c7190e8c9a411c6001386a5b17632508b004']
  },
  bodies: {
    'vera/VeraScene.ets:asNumbers': ['7d8acf21d9c9375fa89bb561420c2b2c611f98ff4cf54d5edaf24b2a82fc51ab', 'A borrowed VM primitives extracted into D per-call fresh output; no module-shared reused array; hash is a bounded review gate, not semantic freshness proof'],
    'vera/VeraScene.ets:SceneThing': ['7edd55bdfe61cd1aa1f668dee327ec5799a0a33a0261c2f9d0048f7f8ca52c9a', 'D defaults and shallow functional copy preserve immutable descendants'],
    'vera/VeraScene.ets:SceneThingValue': ['5e0783d2aecb2ef36a6c62a46171cb0135d21239673bdeb113f121cff184c16c', 'A fresh wrapper map via freshObjectValue provenance with D retained thing alias'],
    'vera/VeraScene.ets:BodySpec': ['001de72e0fa2852f33698523315edc5be98a52d9e5d4ddfd380b00ec1e83cbb3', 'D per-instance arrays and shared immutable metadata'],
    'vera/VeraScene.ets:WorldSpec': ['8320097d4c313e8df9fede49a749b3eef181b73a08da4ea65a223a580ccb322b', 'D fresh body/zone collections'],
    'vera/VeraScene.ets:asParts': ['b40082ed82d061f3c92ef1b86b2c929763bf94a4d0878b54c581ffab559787c4', 'D copies parts before recentering, retains nested immutable aliases'],
    'vera/VeraScene.ets:asBody': ['db842b3e05fbff8b67580c9457e5b3b42b02702f8122f49dec92e2dd70f597a0', 'D wrappers receive shallow fresh copy, not original thing'],
    'vera/VeraScene.ets:bodySpec': ['308c59ebf76fdd64c2307724e829cd66eafc4b52462d504b58c9b1341008ecbd', 'D fresh body/parts tree, dimensions and poses; points and metadata remain aliases'],
    'vera/VeraScene.ets:decodeScene': ['bc803ee6de10319e5676f56379aecf11a9ab807948b356d700a4394defe1f09a', 'D fresh world validated before return'],
    'vera/VeraScene.ets:MotionCarry.apply': ['feb55b596a9d2692f7a71c672549167dc67b57a014abcf5c4cc1cff83249db5e', 'D fresh body rotation/orbit replaced, old aliased orbit never mutated'],
    'vera/VeraWorldPlay.ets:WorldPlay.rebuild': ['5a761ca891787cf6e40db92bf87f9f792ee23131ad442978783178e783c9ae62', 'D carry applied to fresh decode before diff/sim/retention'],
    'components/VeraWorld3D.ets:BodyNode.constructor': ['8b8492db53d5cb8995fe7b5f5fc0dc13ea28b10b5de3b193d678a3be812d361d', 'D renderer node retains borrowed spec separately'],
    'components/VeraWorld3D.ets:WorldBox.applyOne': ['396c2bedb97c9e3424efde29a98f38eb168c748517ec28e7a2be192a82431f87', 'D carry identity gate and spec publication/renderer updates pinned']
  },
  probes: [
    ['scene primitive extraction reuses module-shared output', 'vera/VeraScene.ets',
      `function asNumbers(args: RuntimeValue[], i: number, what: string, most: number): number[] {
  let v = i < args.length ? args[i] : null
  if (!(v instanceof VeraArrayValue)) { throw new RuntimeTrap('R0020', 'scene: ' + what + ' must be a number[]') }
  let items = (v as VeraArrayValue).elements
  if (items.length > most) {
    throw new RuntimeTrap('R0029', 'scene: ' + what + ' holds at most ' + most.toString() + ' numbers; got ' + items.length.toString())
  }
  let out: number[] = []`,
      `const sharedNumericOutput: number[] = []
function asNumbers(args: RuntimeValue[], i: number, what: string, most: number): number[] {
  let v = i < args.length ? args[i] : null
  if (!(v instanceof VeraArrayValue)) { throw new RuntimeTrap('R0020', 'scene: ' + what + ' must be a number[]') }
  let items = (v as VeraArrayValue).elements
  if (items.length > most) {
    throw new RuntimeTrap('R0029', 'scene: ' + what + ' holds at most ' + most.toString() + ' numbers; got ' + items.length.toString())
  }
  let out: number[] = sharedNumericOutput
  out.length = 0`, null, null, true],
    ['shape.thing.orbit.phaseDeg mutation', 'vera/VeraScene.ets', 'this.thing = thing', 'this.thing = thing; this.thing.orbit.phaseDeg = 99'],
    ['bodySpec shared alias mutation', 'vera/VeraScene.ets', 'b.points = t.points', 'b.points = t.points; const shared = b.points; shared.push(99);', 'shared.push(99)'],
    ['erased consumer alias', 'vera/VeraPhysics.ets', 'apply(diff: WorldDiff, next: WorldSpec): void {',
      'apply(diff: WorldDiff, next: WorldSpec): void { const hidden = next as Object; consume(hidden);', 'consume(hidden)'],
    ['destructured unknown receiver', 'vera/VeraScene.ets', 'function bodySpec(t: SceneThing): BodySpec {',
      'function bodySpec(t: SceneThing): BodySpec { const {orbit: motion} = input; motion.phaseDeg = 99;', 'motion.phaseDeg = 99'],
    ['erased destructured consumer alias', 'components/VeraWorld3D.ets', 'let prev = this.applied',
      'let prev = this.applied; const erased = next as Object; const {bodies: parts} = erased; consume(parts);', 'consume(parts)'],
    ['MotionCarry shared orbit write', 'vera/VeraScene.ets', 'b.orbit = c', 'o.phaseDeg = m.phaseUsed; b.orbit = c'],
    ['MotionCarry fresh orbit weakened', 'vera/VeraScene.ets', 'let c = new SceneOrbit()', 'let c = o'],
    ['functional copy weakened', 'vera/VeraScene.ets', 'return t.copy()', 'return t'],
    ['group part copy weakened', 'vera/VeraScene.ets', 'out.push(t.copy())', 'out.push(t)'],
    ['approved carry write repeated by loop', 'vera/VeraScene.ets', 'b.travelStart = m.travelUsed',
      'for (let repeat = 0; repeat < 2; repeat++) { b.travelStart = m.travelUsed }'],
    ['approved carry conditional bypass', 'vera/VeraScene.ets', 'b.travelStart = m.travelUsed', 'if (false) { b.travelStart = m.travelUsed }'],
    ['new source consumer', 'runtime/P3SceneProbe.ets', '', "import {BodySpec as Body} from '../vera/VeraScene'; export function steal(b: Body): void { const erased = b as Object; consume(erased); }", 'consume(erased)'],
    ['new unknown thing destructuring', 'runtime/P3SceneProbe.ets', '', 'export function steal(input: Object): void { const {thing: shape} = input; shape.orbit.phaseDeg = 9; }', 'shape.orbit.phaseDeg = 9']
  ]
}
retainedPayloadChecks(worldRetained)
const {loadVera} = require('./source-loader')
const {compileVeraSource} = loadVera('VeraCompiler')
const {VirtualMachine, deserializeVbc2, VeraNumberValue, VeraStringValue, VeraBooleanValue, VeraArrayValue} = loadVera('VeraInterpreter')
const {UiHostEnvironment, decodeVeraUi} = loadVera('VeraUi')
const S = loadVera('VeraScene')
const {smokeRun} = loadVera('VeraSmoke')
const {describeCatalogForPrompt, describeComponents, catalogKinds, CATALOG} = loadVera('VeraUiCatalog')

const example = name => fs.readFileSync(path.join(__dirname, 'examples', name + '.vera'), 'utf8')
const codes = src => {
  try { compileVeraSource(src); return [] } catch (e) { if (!e.diagnostics) throw e; return e.diagnostics.map(d => d.code + ' ' + d.message) }
}
const traps = (fn, code, re, msg) => assert.throws(fn, e => e.trapCode === code && (!re || re.test(e.message)), msg)

// ---- the module is its table: every function compiles with its arity, needs no import, and an import still works
const thingArg = 'scene.box("t", 0, 0.5, 0, 1, 1, 1, "accent")'
const calls = S.SCENE_FUNCTIONS.map((f, i) => {
  const args = f.params.filter(p => !p.optional).map(p => p.kind === 'number' ? '1' : p.kind === 'color' ? '"accent"'
    : p.kind === 'boolean' ? 'true' : p.kind === 'thing' ? thingArg : p.kind === 'thing[]' ? '[' + thingArg + ']'
    : p.kind === 'number[]' ? '[0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]'
    : p.name === 'id' ? '"b' + i + '"' : '"t"')
  return `let v${i}: scene.Thing = scene.${f.name}(${args.join(', ')});`
})
const program = (buildBody, extra = '', world = 'ui.World("default", 0, "build", "")') => `
@jsonable class AppState { n: number; }
function init(): AppState { return {n: 0}; }
${extra}
function build(state: AppState): scene.Thing[] {
  let things: scene.Thing[] = [];
  ${buildBody}
  return things;
}
function view(state: AppState): ui.View { return ui.AppTheme("clean", "", [${world}, ui.Text("body", "x")]); }
`
assert.deepEqual(codes(program(calls.join('\n  '))), [], 'every std/scene function compiles from the table')
assert.deepEqual(codes('import * as scene from "std/scene"\n' + program('things.push(scene.floor("surface"));')), [], 'an explicit import still works')

// ---- literal colours and empty ids are compile errors
for (const good of ['ink', 'accent', '#abc', '#a1b2c3']) {
  assert.deepEqual(codes(program(`things.push(scene.sphere("s", 0, 1, 0, 1, "${good}"));`)), [], good + ' is a colour')
}
for (const bad of ['red', '#12', '']) {
  const found = codes(program(`things.push(scene.sphere("s", 0, 1, 0, 1, "${bad}"));`))
  assert.ok(found.some(c => c.startsWith('E2112') && c.includes('unknown colour')), JSON.stringify(bad) + ' is refused: ' + found)
}
assert.ok(codes(program('things.push(scene.box("", 0, 1, 0, 1, 1, 1, "ink"));')).some(c => c.startsWith('E2112') && c.includes('needs an id')))

// ---- build and event signatures
const withEvent = (fn, world) => codes(program('things.push(scene.floor("surface"));', fn, world))
const eventWorld = 'ui.World("default", 0, "build", "onWorld")'
assert.deepEqual(withEvent('function onWorld(state: AppState, e: scene.Event): AppState { return state; }', eventWorld), [])
assert.ok(withEvent('function onWorld(state: AppState, e: number): AppState { return state; }', eventWorld)
  .some(c => c.startsWith('E2106') && c.includes('e: scene.Event')), 'an event handler takes a scene.Event')
assert.ok(withEvent('function onWorld(state: AppState, e: scene.Event): number { return 1; }', eventWorld)
  .some(c => c.startsWith('E2106') && c.includes('e: scene.Event')), 'an event handler returns the state')
assert.ok(withEvent('', 'ui.World("default", 0, "build", "nothing")').some(c => c.startsWith('E2106') && c.includes('no function named "nothing"')))
assert.ok(withEvent('', 'ui.World("default", 0, "", "")').some(c => c.startsWith('E2106') && c.includes('needs a build function')), 'build is not optional')
assert.ok(withEvent('function shapes(state: AppState): gfx.Shape[] { let s: gfx.Shape[] = []; return s; }', 'ui.World("default", 0, "shapes", "")')
  .some(c => c.startsWith('E2106') && c.includes('scene.Thing[]')), 'build returns scene.Thing[]')
assert.ok(withEvent('function two(state: AppState, n: number): scene.Thing[] { let s: scene.Thing[] = []; return s; }', 'ui.World("default", 0, "two", "")')
  .some(c => c.startsWith('E2106') && c.includes('scene.Thing[]')), 'build takes only the state')
// The surface's messages are unchanged by the shared table.
assert.ok(codes(`
@jsonable class AppState { n: number; }
function init(): AppState { return {n: 0}; }
function view(state: AppState): ui.View { return ui.AppTheme("clean", "", [ui.Surface("default", 100, 100, "", "", "")]); }
`).some(c => c === 'E2106 a ui.Surface needs a draw function: function draw(state: AppState): gfx.Shape[]'))

// ---- a program's own `scene` hides std/scene: said so, not "field selection requires class"
const clash = codes(program('things.push(scene.floor("surface"));', 'function scene(n: number): number { return n; }'))
assert.ok(clash.some(c => c.startsWith('E2116') && c.includes('own function or variable named "scene"')), 'scene clash: ' + clash)
const clashLocal = codes(program('let scene: number = 1;\n  things.push(scene.floor("surface"));'))
// A local named scene, once scene.Thing has bound the prelude, is already refused as shadowing it.
assert.ok(clashLocal.some(c => c.startsWith('E2116') || c.startsWith('E2004 declaration scene shadows')), 'a local named scene: ' + clashLocal)
// ... and a program's own `scene` that never touches std/scene is fine.
assert.deepEqual(codes(program('things.push(scene2(1));', 'function scene2(n: number): scene.Thing { return scene.floor("surface"); }')), [])
assert.deepEqual(codes(`
@jsonable class AppState { n: number; }
function init(): AppState { return {n: 0}; }
function scene(n: number): number { return n + 1; }
function view(state: AppState): ui.View { return ui.AppTheme("clean", "", [ui.Text("body", ui.numberToString(scene(state.n)))]); }
`), [], 'a function named scene is fine while std/scene is not used')

// ---- the three examples compile, build and smoke-run
const run = name => {
  const compiled = compileVeraSource(example(name))
  const vm = new VirtualMachine(deserializeVbc2(compiled.vbc2), new UiHostEnvironment())
  const state = vm.execute('init')
  const worlds = []
  const find = nodes => { for (const n of nodes) { if (n.kind === 'world') worlds.push(n); find(n.children) } }
  find(decodeVeraUi(vm.execute('view', [state])))
  assert.equal(worlds.length, 1, name + ' draws one world')
  return {compiled, vm, state, node: worlds[0], spec: S.decodeScene(vm.execute(worlds[0].label, [state]))}
}
for (const name of ['world-solar', 'world-dice', 'world-cubes']) {
  const {compiled, node} = run(name)
  assert.equal(smokeRun(compiled), '', name + ' smoke-runs')
  assert.equal(compiled.handlers.get('onWorld'), 'sceneEvent', name + ': the event handler is reported for smoke and play')
  assert.equal(node.label, 'build'); assert.equal(node.action, 'onWorld'); assert.equal(node.style, 'default'); assert.equal(node.minimum, 0)
}

{
  const {spec} = run('world-solar')
  assert.ok(spec.camera && spec.camera.orbit, 'the solar system camera orbits')
  assert.equal(spec.floor, null); assert.equal(spec.table, null)
  assert.equal(spec.bodies.length, 10, 'sun, eight planets and the moon')
  const sun = spec.bodies.find(b => b.id === 'Sun')
  assert.ok(sun.glow && sun.motion === 'kinematic' && sun.spinPeriodS === 25 && sun.shape === 'sphere')
  assert.deepEqual(sun.dims, [1.2, 1.2, 1.2])
  const earth = spec.bodies.find(b => b.id === 'Earth'), neptune = spec.bodies.find(b => b.id === 'Neptune')
  assert.equal(earth.orbit.centre, 'Sun'); assert.equal(earth.orbit.periodS, 10)
  assert.ok(Math.abs(neptune.orbit.periodS / earth.orbit.periodS - 164.8) < 1e-9, 'periods keep the real proportion')
  assert.equal(spec.bodies.find(b => b.id === 'Moon').orbit.centre, 'Earth')
  // The moon is 0.2 from the earth wherever the earth is.
  for (const t of [0, 3.3, 17]) {
    const at = S.orbitPositions(spec, t), e = at.get('Earth'), m = at.get('Moon')
    assert.ok(Math.abs(Math.hypot(m[0] - e[0], m[2] - e[2]) - 0.2) < 1e-9, 'the moon follows the earth at t=' + t)
    assert.ok(Math.abs(Math.hypot(e[0], e[2]) - 1.9) < 1e-9)
  }
  // A tap on a planet names it.
  const {compiled, vm, state} = run('world-solar')
  const next = vm.execute('onWorld', [state, S.sceneEventValue('tap', 'Mars', '', 1, 0, 1, 0, [], [])])
  const texts = []; (function walk(ns) { for (const n of ns) { if (n.kind === 'text') texts.push(n.text); walk(n.children) } })(decodeVeraUi(vm.execute('view', [next])))
  assert.ok(texts.includes('Mars'), 'the tapped planet is named: ' + texts)
  assert.ok(compiled)
}
{
  const {spec, vm, state} = run('world-dice')
  assert.ok(spec.table && spec.table.width === 1.2 && spec.table.depth === 0.9)
  assert.equal(spec.bodies.length, 2)
  for (const d of spec.bodies) {
    assert.ok(d.isDie && d.shape === 'box' && d.motion === 'loose' && d.mass === 1 && d.kick && d.kick.trigger === 0, 'a die: ' + JSON.stringify(d))
  }
  // Throw: the trigger moves, so the diff kicks both dice and nothing else.
  const thrown = vm.execute('onThrow', [state, new VeraNumberValue(0)])
  const spec2 = S.decodeScene(vm.execute('build', [thrown]))
  const d = S.diffWorld(spec, spec2)
  assert.deepEqual(d.kick.map(b => b.id), ['d1', 'd2']); assert.equal(d.create.length + d.remove.length + d.recreate.length + d.setPose.length, 0)
  // Settled: the faces are read and added up.
  const read = vm.execute('onWorld', [thrown, S.sceneEventValue('settled', '', '', 0, 0, 0, 0, ['d1', 'd2'], [3, 4])])
  assert.equal(read.fields.get('total').value, 7); assert.equal(read.fields.get('read').value, 1)
  const texts = []; (function walk(ns) { for (const n of ns) { if (n.kind === 'text') texts.push(n.text); walk(n.children) } })(decodeVeraUi(vm.execute('view', [read])))
  assert.ok(texts.includes('3 + 4 = 7'), texts.join('|'))
}
{
  const {spec, vm, state} = run('world-cubes')
  assert.ok(spec.floor); assert.equal(spec.bodies.length, 101, 'a hundred cubes and a ball')
  // No cube starts inside another or below the floor.
  const cubes = spec.bodies.filter(b => b.shape === 'box')
  for (const c of cubes) assert.ok(c.position[1] - c.dims[1] / 2 >= -1e-9, c.id + ' is above the floor')
  for (let i = 0; i < cubes.length; i++) for (let j = i + 1; j < cubes.length; j++) {
    const a = cubes[i], b = cubes[j]
    const overlap = [0, 1, 2].every(k => Math.abs(a.position[k] - b.position[k]) < (a.dims[k] + b.dims[k]) / 2 - 1e-9)
    assert.ok(!overlap, a.id + ' overlaps ' + b.id)
  }
  // A shot is a new ball, created with its trigger, so kicked at once; the old ball goes; the wall is left alone.
  const shot = vm.execute('onShoot', [state, new VeraNumberValue(0)])
  const d = S.diffWorld(spec, S.decodeScene(vm.execute('build', [shot])))
  assert.deepEqual(d.create.map(b => b.id), ['ball1']); assert.deepEqual(d.kick.map(b => b.id), ['ball1']); assert.deepEqual(d.remove, ['ball0'])
  assert.equal(d.setPose.length + d.recreate.length + d.material.length, 0)
}

// ---- decode: the contract
const host = new UiHostEnvironment()
const call = (name, ...args) => host.invoke('std/scene', name, args.map(a => typeof a === 'number' ? new VeraNumberValue(a)
  : typeof a === 'string' ? new VeraStringValue(a) : typeof a === 'boolean' ? new VeraBooleanValue(a) : a), false)
const box = (id, x = 0, y = 0.5, z = 0, color = 'ink', size = 1) => call('box', id, x, y, z, size, size, size, color)
const world = items => S.decodeScene(new VeraArrayValue(items))

traps(() => world([box('a'), box('a', 3)]), 'R0029', /two bodies have the id "a"/, 'a duplicate id traps')
traps(() => world(Array.from({length: S.MAX_WORLD_BODIES + 1}, (_, i) => box('b' + i, i * 2))), 'R0028', /at most 300 bodies/, 'the cap traps')
assert.equal(world(Array.from({length: S.MAX_WORLD_BODIES}, (_, i) => box('b' + i, i * 2))).bodies.length, 300, '300 is allowed')
traps(() => world([call('camera', 0, 1, 2, 0, 0, 0, false), call('camera', 1, 1, 2, 0, 0, 0, false)]), 'R0029', /at most one scene.camera/)
traps(() => world([call('floor', 'ink'), call('floor', 'ink')]), 'R0029', /at most one scene.floor/)
traps(() => world([call('orbit', box('p'), 'nowhere', 1, 1, 0)]), 'R0029', /no body has that id/, 'an orbit round nothing traps')
traps(() => world([call('orbit', box('a'), 'b', 1, 1, 0), call('orbit', box('b'), 'a', 1, 1, 0)]), 'R0029', /round in a circle/, 'an orbit cycle traps')
traps(() => world([call('loose', box('c'), 1), call('orbit', box('p'), 'c', 1, 1, 0)]), 'R0029', /which is loose/, 'a loose centre traps')
traps(() => call('orbit', call('loose', box('a'), 1), 'b', 1, 1, 0), 'R0029', /loose, so it cannot also orbit/)
traps(() => call('loose', call('orbit', box('a'), 'b', 1, 1, 0), 1), 'R0029', /cannot also be loose/)
traps(() => call('kick', call('spin', box('a'), 3), 1, 0, 0, 0, 0), 'R0029', /cannot be kicked/)
traps(() => call('spin', call('loose', box('a'), 1), 3), 'R0029', /cannot also spin/)
traps(() => call('orbit', box('a'), 'a', 1, 1, 0), 'R0029', /cannot orbit itself/)
for (const setup of [call('camera', 0, 1, 2, 0, 0, 0, false), call('table', 1, 1, 'ink'), call('floor', 'ink')]) {
  for (const w of ['loose', 'glow', 'spin']) traps(() => call(w, setup, 1), 'R0029', /takes a body/, w + ' on the ' + setup.thing.kind)
}
traps(() => call('glow', new VeraNumberValue(1)), 'R0020', /takes a scene.Thing/, 'a wrapper of a non-thing traps')
traps(() => call('box', 'a', 0, 0, 0, 1, 1, 1, 7), 'R0020', null, 'a colour that is not a string traps')
traps(() => call('box', 'a', 0, NaN, 0, 1, 1, 1, 'ink'), 'R0020', /finite/, 'NaN traps')
traps(() => call('sphere', 'a', 0, 0, 0, 0, 'ink'), 'R0029', /more than 0/, 'a size of 0 traps')
traps(() => call('box', '', 0, 0, 0, 1, 1, 1, 'ink'), 'R0029', /needs an id/)
traps(() => call('loose', box('a'), 0), 'R0029', /mass must be more than 0/)
traps(() => call('camera', 1, 1, 1, 1, 1, 1, true), 'R0029', /looks at the point it stands on/)
traps(() => host.invoke('std/scene', 'teleport', [], false), 'R0015')

// Every field resolved.
{
  const k = call('bounce', call('turn', call('kick', box('k', 1, 2, 3, '#ff0000', 0.5), 4, 1, 2, 3, 0.5), 10, 20, 30), 0.9, 1.5)
  const b = world([k, call('table', 2, 1, 'surface'), call('camera', 0, 2, 3, 0, 0, 0, true)]).bodies[0]
  assert.deepEqual({id: b.id, shape: b.shape, dims: b.dims, position: b.position, rotation: b.rotation, color: b.color, motion: b.motion,
    mass: b.mass, restitution: b.restitution, friction: b.friction, kick: {...b.kick}, orbit: b.orbit, spinPeriodS: b.spinPeriodS, glow: b.glow, isDie: b.isDie},
  {id: 'k', shape: 'box', dims: [0.5, 0.5, 0.5], position: [1, 2, 3], rotation: [10, 20, 30], color: '#ff0000', motion: 'loose',
    mass: 1, restitution: 0.9, friction: 1, kick: {trigger: 4, vx: 1, vy: 2, vz: 3, spin: 0.5}, orbit: null, spinPeriodS: 0, glow: false, isDie: false},
  'kick makes a body loose with mass 1, bounce clamps to 0..1')
  const c = call('cylinder', 'c', 0, 0.5, 0, 0.2, 1, 'accent')
  assert.deepEqual(world([c]).bodies[0].dims, [0.4, 1, 0.4])
  // A wrapper copies: the thing it was handed is unchanged.
  const plain = box('p'); call('glow', plain); assert.equal(plain.thing.glow, false)
  // Not a thing in the list: left out, as gfx leaves out what is not a shape.
  assert.equal(world([box('x'), new VeraNumberValue(1)]).bodies.length, 1)
}

{
  const guardedMaps = new WeakSet()
  const rejectMapMutation = () => { throw new TypeError('retained Map mutation') }
  const freeze = (value, seen = new WeakSet()) => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return value
    seen.add(value)
    if (value instanceof Map) {
      for (const [key, item] of Map.prototype.entries.call(value)) { freeze(key, seen); freeze(item, seen) }
      if (!guardedMaps.has(value)) {
        for (const name of ['set', 'delete', 'clear']) Object.defineProperty(value, name, {value: rejectMapMutation})
        guardedMaps.add(value)
      }
    }
    for (const key of Reflect.ownKeys(value)) freeze(value[key], seen)
    return Object.freeze(value)
  }
  const identities = new WeakMap()
  let nextIdentity = 0
  const identity = value => {
    if (!identities.has(value)) identities.set(value, ++nextIdentity)
    return identities.get(value)
  }
  const snapshot = value => {
    const seen = new WeakSet()
    const visit = item => {
      if (item === null || (typeof item !== 'object' && typeof item !== 'function')) return ['value', item]
      const id = identity(item)
      if (seen.has(item) || typeof item === 'function') return ['ref', id]
      seen.add(item)
      return ['object', id, Object.getPrototypeOf(item),
        item instanceof Map ? [...Map.prototype.entries.call(item)].map(([key, entry]) => [visit(key), visit(entry)]) : null,
        Reflect.ownKeys(item).map(key => [key, visit(item[key])])]
    }
    return visit(value)
  }
  const retained = []
  const retain = value => {
    freeze(value)
    retained.push([value, snapshot(value)])
    return value
  }
  const unchanged = () => {
    for (const [value, before] of retained) assert.deepEqual(snapshot(value), before, 'retained scene payload and identities are unchanged')
  }
  const probeThing = box('ownership-probe')
  const probeKey = {key: 'retained'}
  const probeValue = {nested: new Map([['value', new VeraNumberValue(7)]])}
  probeThing.fields.set(probeKey, probeValue)
  const probeInput = retain(new VeraArrayValue([probeThing]))
  assert.equal(probeInput.elements[0].fields, probeThing.fields)
  for (const map of [probeThing.fields, probeValue.nested]) {
    const [key, value] = map.entries().next().value
    const before = snapshot(map)
    for (const mutate of [() => map.set(key, value), () => map.set('new', value), () => map.delete(key), () => map.clear()]) {
      assert.throws(mutate, {name: 'TypeError', message: 'retained Map mutation'})
      assert.deepEqual(snapshot(map), before, 'rejected Map mutations leave entries and identities intact')
    }
    assert.ok(Object.isFrozen(map))
  }
  assert.ok(Object.isFrozen(probeKey))
  assert.ok(Object.isFrozen(probeValue))
  assert.ok(Object.isFrozen(probeValue.nested.get('value')))
  assert.equal(S.decodeScene(probeInput).bodies[0].id, 'ownership-probe')
  unchanged()
  const snapshotProbe = freeze(new Map([[probeKey, probeValue]]))
  const probeBefore = snapshot(snapshotProbe)
  assert.deepEqual(snapshot(snapshotProbe), probeBefore, 'Map snapshots are deterministic')
  Map.prototype.set.call(snapshotProbe, probeKey, {nested: probeValue.nested})
  assert.notDeepEqual(snapshot(snapshotProbe), probeBefore, 'snapshots detect equal-content value replacement by identity')
  Map.prototype.delete.call(snapshotProbe, probeKey)
  Map.prototype.set.call(snapshotProbe, {key: 'retained'}, probeValue)
  assert.notDeepEqual(snapshot(snapshotProbe), probeBefore, 'snapshots detect equal-content key replacement by identity')
  Map.prototype.clear.call(snapshotProbe)
  assert.notDeepEqual(snapshot(snapshotProbe), probeBefore, 'snapshots include Map entries')
  Map.prototype.set.call(snapshotProbe, probeKey, probeValue)
  assert.deepEqual(snapshot(snapshotProbe), probeBefore, 'restoring the original entries restores the snapshot')
  const nums = values => retain(new VeraArrayValue(values.map(n => new VeraNumberValue(n))))
  const outline = nums([0, 0, 4, 0, 0, 2])
  const vertices = nums([0, 0, 0, 2, 0, 0, 0, 4, 0, 0, 0, 6])
  const route = nums([0, 0, 4, 0, 4, 4])
  const otherRoute = nums([-3, 1, -3, 6])
  const firstPath = retain(call('path', box('fresh-path-one'), route, 1, false))
  const secondPath = retain(call('path', box('fresh-path-two'), otherRoute, 2, false))
  assert.notEqual(firstPath.thing.path.points, secondPath.thing.path.points, 'successive retained paths own per-call extracted arrays')
  assert.notEqual(firstPath.thing.path.points, route.elements, 'first path does not borrow VM storage')
  assert.notEqual(secondPath.thing.path.points, otherRoute.elements, 'second path does not borrow VM storage')
  assert.deepEqual(firstPath.thing.path.points, [0, 0, 4, 0, 4, 4], 'second extraction leaves first retained route unchanged')
  assert.deepEqual(secondPath.thing.path.points, [-3, 1, -3, 6])
  assert.ok(secondPath.thing.path.points.every(n => typeof n === 'number'), 'scene extraction stores primitives, not VM wrappers')
  unchanged()
  const sheet = retain(call('shape', 'sheet', 1, 2, 3, outline, 'accent'))
  const hull = retain(call('hull', 'hull', 8, 0, 0, vertices, 'warning'))
  assert.deepEqual([sheet.thing.x, sheet.thing.y, sheet.thing.z, sheet.thing.w, sheet.thing.h, sheet.thing.d], [3, 2, 4, 4, 0.04, 2])
  assert.deepEqual(sheet.thing.points, [-2, -1, 2, -1, -2, 1])
  assert.deepEqual([hull.thing.x, hull.thing.y, hull.thing.z, hull.thing.w, hull.thing.h, hull.thing.d], [9, 2, 3, 2, 4, 6])
  assert.deepEqual(hull.thing.points, [-1, -2, -3, 1, -2, -3, -1, 2, -3, -1, -2, 3])
  const transform = (name, input, args, expected) => {
    retain(input)
    const output = call(name, input, ...args)
    assert.notEqual(output, input, name + ' returns a new opaque value')
    assert.notEqual(output.thing, input.thing, name + ' copies the thing')
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(output.thing[key], value, name + ' sets ' + key)
    unchanged()
    return retain(output)
  }
  const thick = transform('thick', sheet, [0.5], {h: 0.5})
  const leg = transform('swing', thick, [20, 2, 90], {swing: Object.assign(new S.SceneSwing(), {deg: 20, periodS: 2, phaseDeg: 90})})
  const parts = retain(new VeraArrayValue([leg, box('foot', 5, 2, 4)]))
  const group = retain(call('group', 'walker', 0, 0, 0, parts))
  assert.deepEqual([group.thing.x, group.thing.y, group.thing.z, group.thing.w, group.thing.h, group.thing.d], [3.25, 2, 4, 4.5, 1, 2])
  assert.deepEqual(group.thing.parts.map(p => [p.id, p.x, p.y, p.z]), [['sheet', -0.25, 0, 0], ['foot', 1.75, 0, 0]])
  assert.notEqual(group.thing.parts, parts.elements)
  assert.notEqual(group.thing.parts[0], leg.thing)
  assert.equal(group.thing.parts[0].points, leg.thing.points)
  assert.equal(group.thing.parts[0].swing, leg.thing.swing)
  const walking = transform('path', group, [route, 1, false], {motion: 'kinematic', path: Object.assign(new S.ScenePath(), {points: [0, 0, 4, 0, 4, 4], speed: 1, loop: false})})
  const roaming = transform('wander', box('roamer', -8), [3, 1], {motion: 'kinematic', wander: Object.assign(new S.SceneWander(), {radius: 3, speed: 1})})
  const orbiting = transform('orbit', call('sphere', 'planet', 0, 1, 0, 0.5, 'accent'), ['centre', 3, 8, 0],
    {motion: 'kinematic', orbit: Object.assign(new S.SceneOrbit(), {centre: 'centre', radius: 3, periodS: 8, phaseDeg: 0})})
  const spinning = transform('spin', orbiting, [8], {spinPeriodS: 8})
  const painted = transform('paint', spinning, ['bands', 'warning'], {pattern: 'bands', color2: 'warning'})
  const ringed = transform('rings', painted, [0.7, 1, 'ink'], {ringInner: 0.7, ringOuter: 1, ringColor: 'ink'})
  const loose = transform('loose', box('pilot', 12), [2], {motion: 'loose', mass: 2})
  const kicked = transform('kick', loose, [1, 2, 3, 4, 0.5], {kick: Object.assign(new S.SceneKick(), {trigger: 1, vx: 2, vy: 3, vz: 4, spin: 0.5})})
  const player = transform('player', kicked, [3, 'Jump'], {player: Object.assign(new S.ScenePlayer(), {speed: 3, action: 'Jump'})})
  const followed = transform('follow', player, [5, 2], {follow: Object.assign(new S.SceneFollow(), {distance: 5, height: 2})})
  for (const input of [walking, roaming, ringed, followed, hull]) {
    const copy = input.thing.copy()
    assert.notEqual(copy, input.thing)
    assert.deepEqual(copy, input.thing)
    for (const key of ['points', 'parts', 'kick', 'orbit', 'path', 'wander', 'player', 'follow', 'swing']) assert.equal(copy[key], input.thing[key], 'copy retains ' + key)
    transform('turn', input, [10, 20, 30], {rx: 10, ry: 20, rz: 30})
    transform('glow', input, [], {glow: true})
    transform('mark', input, ['warning'], {mark: 'warning'})
    transform('trail', input, [], {trail: true})
    transform('bounce', input, [-1, 2], {restitution: 0, friction: 1})
  }
  for (const [name, input, args, key, field, expected] of [
    ['kick', followed, [2, 4, 5, 6, 1], 'kick', 'trigger', 2],
    ['orbit', ringed, ['centre', 4, 4, 45], 'orbit', 'phaseDeg', 45],
    ['player', followed, [4, 'Run'], 'player', 'action', 'Run'],
    ['follow', followed, [6, 3], 'follow', 'distance', 6],
    ['swing', leg, [30, 4, 180], 'swing', 'phaseDeg', 180]
  ]) {
    const output = call(name, input, ...args)
    assert.notEqual(output.thing[key], input.thing[key], name + ' replaces rather than edits a retained config')
    assert.equal(output.thing[key][field], expected)
    unchanged()
  }
  const input = retain(new VeraArrayValue([box('centre', 0, 1), ringed, walking, roaming, followed, hull,
    call('floor', 'surface'), call('sky', 'ink', 42), call('zone', 'goal', 2, 3, 1, 'accent')]))
  const decoded = S.decodeScene(input)
  assert.deepEqual(decoded.bodies.map(b => b.id), ['centre', 'planet', 'walker', 'roamer', 'pilot', 'hull'])
  assert.deepEqual({...decoded.floor}, {color: 'surface'})
  assert.deepEqual({...decoded.sky}, {color: 'ink', stars: 42})
  assert.deepEqual({...decoded.follow}, {target: 'pilot', distance: 5, height: 2})
  assert.deepEqual(decoded.zones.map(z => ({...z})), [{id: 'goal', x: 2, z: 3, r: 1, color: 'accent'}])
  for (const value of [ringed, walking, roaming, followed, hull]) {
    const b = decoded.bodies.find(b => b.id === value.thing.id)
    for (const key of ['points', 'kick', 'orbit', 'path', 'wander', 'player']) assert.equal(b[key], value.thing[key], 'decode shares read-only ' + key)
    assert.notEqual(b.parts, value.thing.parts)
    assert.deepEqual(b.position, [value.thing.x, value.thing.y, value.thing.z])
    assert.deepEqual(b.dims, [value.thing.w, value.thing.h, value.thing.d])
  }
  const child = decoded.bodies.find(b => b.id === 'walker').parts[0]
  assert.notEqual(child, group.thing.parts[0])
  assert.equal(child.points, leg.thing.points)
  assert.equal(child.swing, leg.thing.swing)
  assert.deepEqual(child.position, [-0.25, 0, 0])
  child.position[0] = 99
  assert.equal(group.thing.parts[0].x, -0.25)
  const setup = retain(new VeraArrayValue([call('table', 8, 6, 'surface'), call('camera', 0, 4, 8, 0, 0, 0, true)]))
  const setupSpec = S.decodeScene(setup)
  assert.deepEqual({...setupSpec.table}, {width: 8, depth: 6, color: 'surface'})
  assert.deepEqual({...setupSpec.camera}, {x: 0, y: 4, z: 8, lookX: 0, lookY: 0, lookZ: 0, orbit: true})
  const motion = multiplier => retain(new VeraArrayValue([
    call('spin', box('centre', 0, 1), 8 / multiplier),
    call('spin', call('orbit', box('planet'), 'centre', 3, 8 / multiplier, 0), 8 / multiplier),
    call('path', group, route, multiplier, false), call('wander', box('roamer', -8), 3, multiplier)
  ]))
  const carry = new S.MotionCarry()
  const slowInput = motion(1), fastInput = motion(2)
  const slow = S.decodeScene(slowInput)
  carry.apply(slow, 0)
  retain(slow)
  const before = S.orbitPositions(slow, 1)
  const fast = S.decodeScene(fastInput)
  carry.apply(fast, 1)
  const planet = fast.bodies.find(b => b.id === 'planet')
  assert.equal(planet.orbit.phaseDeg, 315)
  assert.equal(planet.rotation[1], 315)
  assert.notEqual(planet.orbit, fastInput.elements[1].thing.orbit)
  assert.equal(fastInput.elements[1].thing.orbit.phaseDeg, 0)
  assert.deepEqual(fast.bodies.filter(b => b.path || b.wander).map(b => b.travelStart), [-1, -1])
  const after = S.orbitPositions(fast, 1)
  assert.deepEqual([...after.keys()], ['centre', 'planet', 'walker', 'roamer'])
  for (const [id, pose] of before) {
    const got = after.get(id)
    for (let k = 0; k < 6; k++) assert.ok(Math.abs(k === 4 ? Math.sin((got[k] - pose[k]) * Math.PI / 360) : got[k] - pose[k]) < 1e-9, id + ' carries pose ' + k)
  }
  assert.equal(S.orbitPositions(fast, 1.5).get('walker')[0], 2, 'the carried path advances at its new speed')
  retain(fast)
  assert.ok(S.diffWorld(fast, S.decodeScene(fastInput)).setPose.some(b => b.id === 'planet'), 'the carried pose differs from the raw build')
  const P = loadVera('VeraPhysics')
  const sim = new P.WorldSim(new P.FakePhys())
  const simulated = retain(Object.assign(new S.WorldSpec(), {bodies: [...fast.bodies, decoded.bodies.find(b => b.id === 'pilot')]}))
  sim.apply(S.diffWorld(null, simulated), simulated)
  sim.step(1000 / 60, 1.5)
  assert.deepEqual(sim.poseOf('walker').slice(0, 3), [2, 2, 0], 'the frozen path moves its group in FakePhys')
  const livePlanet = sim.poseOf('planet'), wantPlanet = S.orbitPositions(fast, 1.5).get('planet')
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(livePlanet[k] - wantPlanet[k]) < 1e-6, 'the frozen orbit moves in FakePhys')
  assert.ok(sim.poseOf('pilot')[1] > 0.5, 'the frozen player kick is consumed by FakePhys')
  const records = P.bodyRecords(fast.bodies.find(b => b.id === 'walker'))
  assert.equal(records.records.length, 24)
  assert.equal(records.points.length, 18)
  assert.deepEqual(records.records.slice(0, 4), [3, -0.25, 0, 0], 'the outline part is packed at its group-local position')
  unchanged()

  const {playWorld, WorldPlayReport} = loadVera('VeraWorldPlay')
  const compiled = compileVeraSource(program(`
    things.push(scene.spin(scene.sphere("centre", 0, 1, 0, 0.5, "ink"), 8 / (state.n + 1)));
    things.push(scene.spin(scene.orbit(scene.sphere("planet", 0, 1, 0, 0.4, "accent"), "centre", 2, 8 / (state.n + 1), 0), 8 / (state.n + 1)));
    things.push(scene.path(scene.group("walker", 0, 0, 0, [scene.swing(scene.thick(scene.shape("leg", 0, 1, 0, [-0.5, -0.5, 0.5, -0.5, 0, 0.5], "accent"), 0.5), 20, 2, 0)]), [4, 0, 6, 0], state.n + 1, false));
  `, 'function onWorld(state: AppState, e: scene.Event): AppState { return {n: state.n + 1}; }', eventWorld))
  const execute = VirtualMachine.prototype.execute
  const builds = []
  VirtualMachine.prototype.execute = function(name, ...args) {
    const result = execute.call(this, name, ...args)
    if (name === 'build') builds.push(retain(result))
    return result
  }
  const report = new WorldPlayReport()
  try {
    assert.equal(playWorld(compiled, true, report, 'self'), '', 'production WorldPlay consumes frozen VM builds through rebuilds and frames')
  } finally {
    VirtualMachine.prototype.execute = execute
  }
  assert.equal(builds.length, 5, 'initial build, three body taps and one empty-space tap all rebuild')
  assert.deepEqual(builds.map(v => v.elements[1].thing.orbit.periodS), [8, 4, 8 / 3, 2, 8 / 5])
  assert.deepEqual(builds.map(v => v.elements[2].thing.path.speed), [1, 2, 3, 4, 5])
  assert.equal(report.bodies, 3)
  assert.equal(report.stateChanged, true)
  assert.ok(report.slowestSteps > 0)
  assert.equal(VirtualMachine.prototype.execute, execute)
  unchanged()
}

// ---- diff
{
  const W = items => world(items)
  const first = W([box('a'), call('kick', box('k', 2), 1, 0, 0, 0, 0), call('kick', box('z', 4), 0, 0, 0, 0, 0), call('floor', 'surface')])
  let d = S.diffWorld(null, first)
  assert.deepEqual(d.create.map(b => b.id), ['a', 'k', 'z']); assert.deepEqual(d.kick.map(b => b.id), ['k'], 'created with a trigger other than 0: kicked')
  assert.ok(d.floorChanged && !d.cameraChanged && !d.tableChanged)
  assert.ok(S.diffWorld(first, first).empty(), 'the same world is no change')
  // Loose bodies returned somewhere else: ignored. Static body moved: setPose. Colour: material. Size: recreate. Gone: remove.
  const next = W([box('a', 5), call('kick', box('k', 9, 9, 9, 'accent'), 1, 0, 0, 0, 0), call('kick', box('z', 4, 0.5, 0, 'ink', 2), 0, 0, 0, 0, 0),
    call('floor', 'surface')])
  d = S.diffWorld(first, next)
  assert.deepEqual(d.setPose.map(b => b.id), ['a']); assert.deepEqual(d.material.map(b => b.id), ['k']); assert.deepEqual(d.recreate.map(b => b.id), ['z'])
  assert.equal(d.kick.length + d.create.length + d.remove.length, 0, 'a loose body moved in the spec is not moved')
  d = S.diffWorld(first, W([box('a'), call('kick', box('k', 2), 1, 0, 0, 0, 0), call('kick', box('z', 4), 0, 0, 0, 0, 0)]))
  assert.ok(d.floorChanged && d.empty() === false && d.create.length === 0)
  d = S.diffWorld(first, W([box('a')]))
  assert.deepEqual(d.remove, ['k', 'z'])
  // Kick only on a change of trigger.
  const kicked = W([box('a'), call('kick', box('k', 2), 2, 0, 0, 0, 0), call('kick', box('z', 4), 0, 0, 0, 0, 0), call('floor', 'surface')])
  assert.deepEqual(S.diffWorld(first, kicked).kick.map(b => b.id), ['k'])
  assert.equal(S.diffWorld(kicked, kicked).kick.length, 0)
  // A static body turned, a loose body made static: setPose and recreate.
  const turned = W([call('turn', box('a'), 0, 45, 0), box('k', 2), call('kick', box('z', 4), 0, 0, 0, 0, 0), call('floor', 'surface')])
  d = S.diffWorld(first, turned)
  assert.deepEqual(d.setPose.map(b => b.id), ['a']); assert.deepEqual(d.recreate.map(b => b.id), ['k'])
  // The camera.
  assert.ok(S.diffWorld(W([call('camera', 0, 1, 2, 0, 0, 0, false)]), W([call('camera', 0, 1, 3, 0, 0, 0, false)])).cameraChanged)
}

// ---- orbits: chains resolved, spin added
{
  const spec = world([call('spin', box('sun', 0, 1, 0), 8), call('orbit', box('earth'), 'sun', 2, 4, 0), call('orbit', box('moon'), 'earth', 0.5, 1, 90),
    box('rock', 7, 0.5, 7)])
  const close = (a, b, msg) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9, msg + ': ' + a + ' vs ' + b))
  let at = S.orbitPositions(spec, 0)
  assert.equal(at.has('rock'), false, 'a static body is not the orbits\' business')
  close(at.get('sun'), [0, 1, 0, 0, 0, 0], 'the sun at 0')
  close(at.get('earth'), [2, 1, 0, 0, 0, 0], 'the earth at 0')
  close(at.get('moon'), [2, 1, -0.5, 0, 0, 0], 'the moon at 0, a quarter round')
  at = S.orbitPositions(spec, 1)
  close(at.get('sun'), [0, 1, 0, 0, 45, 0], 'the sun spins 45 degrees in a second')
  close(at.get('earth'), [0, 1, -2, 0, 0, 0], 'a quarter of a year: counter-clockwise from above')
  close(at.get('moon'), [0, 1, -2.5, 0, 0, 0], 'the moon round the earth where the earth is now')
  at = S.orbitPositions(spec, 2)
  close(at.get('earth'), [-2, 1, 0, 0, 0, 0], 'half a year')
}

// ---- a new period goes on from where the body is (a Faster button), not from where the period alone would put it
{
  const close = (a, b, msg) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9, msg + ': ' + a + ' vs ' + b))
  const solar = (m, phase = 0) => world([call('spin', box('sun', 0, 1, 0), 8 / m), call('orbit', box('earth'), 'sun', 2, 12 / m, phase),
    call('orbit', box('moon'), 'earth', 0.5, 3 / m, 90)])
  const carry = new S.MotionCarry()
  const slow = solar(1); carry.apply(slow, 0)
  const t = 100.3
  const before = S.orbitPositions(slow, t)
  const fast = solar(2); carry.apply(fast, t)
  const after = S.orbitPositions(fast, t)
  const mod = v => ((v % 360) + 360) % 360
  for (const id of ['sun', 'earth', 'moon']) {
    close(after.get(id).slice(0, 3), before.get(id).slice(0, 3), id + ' stays where it was when the period halves')
    const dry = mod(after.get(id)[4] - before.get(id)[4])
    assert.ok(dry < 1e-6 || 360 - dry < 1e-6, id + ' keeps its turn: ' + dry)
  }
  // ... and goes on at the new period: a quarter of the new year (3 s) later the earth is a quarter round.
  const e0 = S.orbitPositions(fast, t).get('earth'), e1 = S.orbitPositions(fast, t + 1.5).get('earth')
  const angle = p => Math.atan2(-p[2], p[0]) * 180 / Math.PI
  assert.ok(Math.abs(((angle(e1) - angle(e0)) % 360 + 360) % 360 - 90) < 1e-6, 'a quarter of the new 6 s year in 1.5 s')
  // The same state again keeps the carried start; a start the program moves itself is taken as written.
  const again = solar(2); carry.apply(again, t + 5)
  close(S.orbitPositions(again, t + 5).get('earth'), S.orbitPositions(fast, t + 5).get('earth'), 'an unchanged state changes nothing')
  const moved = solar(2, 45); carry.apply(moved, t + 5)
  assert.equal(moved.bodies.find(b => b.id === 'earth').orbit.phaseDeg, 45, 'a new start is the program\'s')
  // Without the carry the earth would jump: the check above means something.
  const raw = S.orbitPositions(solar(2), t).get('earth')
  assert.ok(Math.hypot(raw[0] - before.get('earth')[0], raw[2] - before.get('earth')[2]) > 0.5, 'uncarried, the earth jumps')
}

// ---- a pinch: fingers spread twice as far bring the camera to half the distance, along its line of sight, within
// ZOOM_NEAREST..ZOOM_FARTHEST of where the whole world was framed; the clip planes follow it
{
  const L = loadVera('VeraLook3D')
  assert.equal(L.pinchDistance(10, 100, 200, 10), 5, 'spread twice as far: half the distance')
  assert.equal(L.pinchDistance(5, 100, 50, 10), 10, 'closed back: the framing again')
  assert.equal(L.pinchDistance(10, 100, 10000, 10), 10 * L.ZOOM_NEAREST, 'no nearer than ZOOM_NEAREST of the framing')
  assert.equal(L.pinchDistance(10, 100, 1, 10), 10 * L.ZOOM_FARTHEST, 'no further than ZOOM_FARTHEST')
  assert.equal(L.pinchDistance(7, 0, 50, 10), 7, 'fingers on one spot change nothing')
  const pose = new L.CameraPose(); pose.eye = [0, 8, 6]; pose.look = [0, 0, 0]
  L.zoomPose(pose, 5, 4)
  assert.ok(pose.eye.every((v, i) => Math.abs(v - [0, 4, 3][i]) < 1e-9), 'along the line of sight: ' + pose.eye)
  assert.ok(pose.near > 0 && pose.near < 5 - 0 && pose.far > 5 + 4, 'clip planes round the world at the new distance')
}

// ---- topFace for all 24 orientations of a die
{
  const det = M => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0])
  const quat = R => {   // a rotation matrix (columns are the local axes in world coordinates) as [x, y, z, w]
    const t = R[0][0] + R[1][1] + R[2][2]
    if (t > 0) { const s = Math.sqrt(t + 1) * 2; return [(R[2][1] - R[1][2]) / s, (R[0][2] - R[2][0]) / s, (R[1][0] - R[0][1]) / s, s / 4] }
    if (R[0][0] > R[1][1] && R[0][0] > R[2][2]) { const s = Math.sqrt(1 + R[0][0] - R[1][1] - R[2][2]) * 2; return [s / 4, (R[0][1] + R[1][0]) / s, (R[0][2] + R[2][0]) / s, (R[2][1] - R[1][2]) / s] }
    if (R[1][1] > R[2][2]) { const s = Math.sqrt(1 + R[1][1] - R[0][0] - R[2][2]) * 2; return [(R[0][1] + R[1][0]) / s, s / 4, (R[1][2] + R[2][1]) / s, (R[0][2] - R[2][0]) / s] }
    const s = Math.sqrt(1 + R[2][2] - R[0][0] - R[1][1]) * 2; return [(R[0][2] + R[2][0]) / s, (R[1][2] + R[2][1]) / s, s / 4, (R[1][0] - R[0][1]) / s]
  }
  const FACE = {'+x': 3, '-x': 4, '+y': 2, '-y': 5, '+z': 1, '-z': 6}
  const names = ['x', 'y', 'z']
  const seen = new Set()
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]
  for (const p of perms) for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sz of [1, -1]) {
    const R = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], signs = [sx, sy, sz]
    for (let col = 0; col < 3; col++) R[p[col]][col] = signs[col]
    if (det(R) !== 1) continue
    // The face on top is the local axis whose world-y entry is not 0: +x up shows 3, -x up (+x down) shows 4, ...
    let up = ''
    for (let col = 0; col < 3; col++) if (R[1][col] !== 0) up = (R[1][col] > 0 ? '+' : '-') + names[col]
    const q = quat(R)
    // Both signs of a quaternion are the same rotation.
    assert.equal(S.topFace(...q), FACE[up], 'orientation ' + JSON.stringify(R) + ' shows ' + up)
    assert.equal(S.topFace(...q.map(v => -v)), FACE[up])
    seen.add(JSON.stringify(R))
  }
  assert.equal(seen.size, 24, 'all 24 orientations')
  // Lying flat, and tipped 10 degrees: still the same face.
  assert.equal(S.topFace(0, 0, 0, 1), 2)
  const h = 45 * Math.PI / 180
  assert.equal(S.topFace(Math.sin(h), 0, 0, Math.cos(h)), 6, 'turned +90 about x: +z points down, -z up')
  const tip = 55 * Math.PI / 180
  assert.equal(S.topFace(Math.sin(tip), 0, 0, Math.cos(tip)), 6, 'tipped past 90 a little: still -z up')
  const small = 5 * Math.PI / 180
  assert.equal(S.topFace(Math.sin(small), 0, 0, Math.cos(small)), 2, 'tipped 10 degrees: +y still up')
}

// ---- the look (VeraLook3D): colours in linear light, the default camera, the table, the pips, rotations
{
  const L = loadVera('VeraLook3D')
  const {resolveTheme} = loadVera('VeraTheme')
  const theme = resolveTheme('clean', '', false)
  const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < eps, msg + ': ' + a + ' vs ' + b)
  // A literal: sRGB as written, then linear by the standard curve (0.5 sRGB is 0.214 linear; below 0.04045 it is c / 12.92).
  assert.deepEqual(L.lookRgba(theme, '#ff8000'), [1, 128 / 255, 0, 1])
  const lin = L.lookLinear(theme, '#ff8000')
  near(lin[0], 1, 1e-12, 'white channel'); near(lin[1], Math.pow((128 / 255 + 0.055) / 1.055, 2.4), 1e-12, 'mid channel'); assert.equal(lin[2], 0)
  near(L.srgbToLinear(0.5), 0.21404, 1e-4, 'sRGB 0.5'); near(L.srgbToLinear(0.02), 0.02 / 12.92, 1e-12, 'the linear toe')
  assert.deepEqual(L.lookRgba(theme, '#abc'), [0xaa / 255, 0xbb / 255, 0xcc / 255, 1], '#rgb')
  near(L.lookRgba(theme, '#11223380')[3], 0x80 / 255, 1e-3, '#rrggbbaa keeps its alpha')
  // A role: the theme's own colour, as std/gfx paints it.
  const hex = theme.primary.toLowerCase()
  assert.deepEqual(L.lookRgba(theme, 'accent'), [1, 3, 5].map(i => parseInt(hex.substring(i, i + 2), 16) / 255).concat([1]), 'accent is the theme primary')
  near(L.lookLinear(theme, 'accent')[2], L.srgbToLinear(parseInt(hex.substring(5, 7), 16) / 255), 1e-12, 'accent in linear light')
  assert.deepEqual(L.lookRgba(theme, '', L.LOOK_PIP_ROLE), L.lookRgba(theme, 'ink'), 'an empty colour takes the fallback role')
  assert.equal(L.lookColorKey(theme, 'accent', false), L.lookColorKey(theme, theme.primary, false), 'a role and its colour share a material')
  assert.notEqual(L.lookColorKey(theme, 'accent', true), L.lookColorKey(theme, 'accent', false), 'glow is a material of its own')
  // The recipe.
  assert.equal(L.LOOK_SUN_INTENSITY, 14); assert.deepEqual(L.LOOK_SUN_POSITION, [3, 10, 4]); assert.equal(L.LOOK_AMBIENT, 0.55); assert.equal(L.LOOK_SHADOWS, true)

  // Rotations: quatXYZ turns x, then y, then z; lookAtQuat points the node's -z at the target.
  const rot = (q, v) => {   // rotate v by the unit quaternion q = [x, y, z, w]
    const [x, y, z, w] = q, [vx, vy, vz] = v
    const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx)
    return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)]
  }
  const close3 = (a, b, msg) => a.forEach((v, i) => near(v, b[i], 1e-9, msg))
  close3(rot(L.quatXYZ(0, 90, 0), [1, 0, 0]), [0, 0, -1], 'y 90 takes +x to -z')
  close3(rot(L.quatXYZ(90, 90, 0), [0, 1, 0]), [1, 0, 0], 'x first: +y goes to +z, then y 90 takes it to +x')
  for (const [eye, at] of [[[0, 4.5, 8], [0, 0, 0]], [[3, 10, 4], [0, 0, 0]], [[0, 5, 0.0001], [0, 0, 0]], [[-2, 1, -3], [1, 0.5, 2]]]) {
    const q = L.lookAtQuat(eye, at, [0, 1, 0]), f = rot(q, [0, 0, -1]), d = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]], n = Math.hypot(...d)
    close3(f, d.map(v => v / n), 'the camera at ' + eye + ' looks at ' + at)
    assert.ok(rot(q, [0, 1, 0])[1] > -1e-9, 'and its up is not upside down')
  }

  // The default camera sees every body wherever its orbit takes it: each one inside the view cone, in front of the eye.
  const sees = (pose, aspect, points, msg) => {
    const f = [pose.look[0] - pose.eye[0], pose.look[1] - pose.eye[1], pose.look[2] - pose.eye[2]], fl = Math.hypot(...f)
    const half = Math.min(pose.fov / 2, Math.atan(Math.tan(pose.fov / 2) * aspect))
    for (const p of points) {
      const d = [p[0] - pose.eye[0], p[1] - pose.eye[1], p[2] - pose.eye[2]], dl = Math.hypot(...d)
      const angle = Math.acos(Math.min(1, (d[0] * f[0] + d[1] * f[1] + d[2] * f[2]) / (dl * fl)))
      assert.ok(angle + Math.asin(Math.min(1, p[3] / dl)) <= half + 1e-9, msg + ': ' + p + ' at ' + (angle * 180 / Math.PI).toFixed(1) + ' deg')
      assert.ok(dl - p[3] > pose.near && dl + p[3] < pose.far, msg + ': ' + p + ' between the planes')
    }
  }
  const solar = run('world-solar').spec
  const noCamera = Object.assign(Object.create(Object.getPrototypeOf(solar)), solar, {camera: null})
  for (const aspect of [1, 2, 0.5]) {
    const pose = L.defaultCamera(noCamera, aspect)
    assert.equal(pose.orbit, false)
    for (const t of [0, 7, 40, 600]) {
      const at = S.orbitPositions(noCamera, t)
      sees(pose, aspect, noCamera.bodies.map(b => { const p = at.get(b.id); return [p[0], p[1], p[2], Math.hypot(...b.dims) / 2] }),
        'the default camera, aspect ' + aspect + ', t=' + t)
    }
  }
  const cubes = run('world-cubes').spec
  sees(L.defaultCamera(cubes, 1.5), 1.5, cubes.bodies.map(b => [...b.position, Math.hypot(...b.dims) / 2]), 'the default camera on the cubes')
  const dice = run('world-dice').spec
  const diceCam = L.defaultCamera(dice, 1)
  sees(diceCam, 1, L.tableParts(dice.table).map(p => [p[0], p[1], p[2], Math.hypot(p[3], p[4], p[5]) / 2]), 'the default camera sees the whole table')
  assert.ok(diceCam.eye[1] > diceCam.look[1], 'and looks down on it')
  const empty = L.defaultCamera(world([]), 1)
  assert.ok(empty.eye.every(Number.isFinite) && empty.near > 0 && empty.far > empty.near, 'an empty world still has a camera')
  // The program's own camera is used as written when the world fits it: the dice on a wide box.
  const mine = L.worldCamera(dice, 1.5)
  assert.deepEqual([mine.eye, mine.look, mine.orbit], [[0, 1.25, 0.85], [0, 0, 0], false])
  assert.equal(L.worldCamera(solar, 1).orbit, true, 'a fitted camera still orbits')
  // On a tall box it keeps its direction and look point but stands back until every orbit fits (a generated solar
  // system on the phone lost Neptune off the side); every body is then in view wherever its orbit takes it.
  for (const aspect of [0.6, 0.45]) {
    const tall = L.worldCamera(solar, aspect)
    assert.deepEqual(tall.look, [0, 0, 0], 'the look point stays')
    const k = tall.eye[0] === 0 && tall.eye[2] !== 0 ? tall.eye[2] / 8 : NaN
    near(tall.eye[1] / 4.5, k, 1e-9, 'the direction stays')
    assert.ok(k > 1, 'a tall box moves the camera back, aspect ' + aspect)
    for (const t of [0, 7, 40]) {
      const at = S.orbitPositions(solar, t)
      sees(tall, aspect, solar.bodies.map(b => { const p = at.get(b.id) || b.position; return [p[0], p[1], p[2], Math.hypot(...b.dims) / 2] }),
        'the fitted camera, aspect ' + aspect + ', t=' + t)
    }
  }
  // Never nearer than written: a camera far back already stays where it is.
  const far = Object.assign(Object.create(Object.getPrototypeOf(solar)), solar,
    {camera: Object.assign(Object.create(Object.getPrototypeOf(solar.camera)), solar.camera, {x: 0, y: 40, z: 70})})
  assert.deepEqual(L.worldCamera(far, 0.5).eye, [0, 40, 70], 'a camera already far enough is left alone')
  // Nothing is added by the host on its own: what is behind a world is the app's background unless scene.sky gives one,
  // trails are drawn only for bodies with scene.trail (and only round a centre that does not move: not the moon's round
  // the moving Earth), and a glowing body that stands still is the light, as bright for what it lights whatever the
  // scale. Text over the world is light when what is behind it is dark.
  const strip = (w, f) => Object.assign(Object.create(Object.getPrototypeOf(w)), w, f(w))
  assert.equal(L.worldHasBackdrop(solar), true); assert.equal(L.worldHasBackdrop(dice), false); assert.equal(L.worldHasBackdrop(cubes), false)
  const apple = strip(solar, w => ({sky: null, bodies: w.bodies.map(b => Object.assign(Object.create(Object.getPrototypeOf(b)), b, {glow: false, trail: false}))}))
  assert.equal(L.worldHasBackdrop(apple), false, 'no sky, no trail, nothing shining: no backdrop, whatever the ground')
  assert.equal(L.isDarkRgba(L.worldBackgroundRgba(solar, theme)), true, 'the sky the program gave is dark')
  assert.equal(L.isDarkRgba(L.worldBackgroundRgba(apple, theme)), false, 'without a sky, the light theme\'s background')
  assert.equal(L.isDarkRgba([1, 1, 1, 1]), false); assert.equal(L.isDarkRgba([0.1, 0.1, 0.15, 1]), true)
  const rings = L.worldTrails(solar)
  const planets = solar.bodies.filter(b => b.orbit !== null && b.orbit.centre === 'Sun')
  assert.equal(rings.length, new Set(planets.map(b => Math.abs(b.orbit.radius).toFixed(4))).size, 'one trail per planet orbit')
  assert.ok(rings.every(r => r[0] === 0 && r[2] === 0 && r[3] > 0), 'round the sun at the origin')
  assert.ok(!rings.some(r => Math.abs(r[3] - 0.2) < 1e-9), 'no trail for the moon round the moving Earth')
  assert.deepEqual(L.worldTrails(apple), [], 'no scene.trail, no trails')
  const sky = world([call('sky', '#000010', 99999)])
  assert.deepEqual([sky.sky.color, sky.sky.stars], ['#000010', S.MAX_SKY_STARS], 'stars clamped to MAX_SKY_STARS')
  traps(() => world([call('sky', 'ink', 1), call('sky', 'ink', 2)]), 'R0029', /at most one scene.sky/)
  assert.ok(S.diffWorld(solar, apple).backdropChanged && !S.diffWorld(solar, solar).backdropChanged, 'a new sky or trail repaints the backdrop')
  // A lamp 0.5 m over what it lights is dimmer than a sun 2 m from its planets, by the square of the distance.
  const lamp = world([call('glow', call('sphere', 'lamp', 0, 0.6, 0, 0.05, '#fff2c0')), call('box', 'a', 0.3, 0.05, 0.4, 0.1, 0.1, 0.1, 'ink'),
    call('box', 'b', -0.3, 0.05, -0.4, 0.1, 0.1, 0.1, 'ink'), call('floor', 'surface')])
  const lampCd = L.glowCandela(lamp, L.worldSuns(lamp)[0])
  assert.ok(lampCd < L.GLOW_CANDELA * 0.2 && lampCd > 0, 'a lamp near what it lights is gentler: ' + lampCd)
  assert.equal(L.worldGlows(lamp), true, 'a lamp lights its floor world as a sun lights space')
  assert.deepEqual(L.worldSuns(solar).map(s => s.slice(0, 3)), [[0, 0, 0]], 'the sun is the one sun')
  assert.deepEqual(L.worldSuns(dice), [])
  const stars = L.starField(220)
  assert.equal(stars.length, 220); assert.deepEqual(L.starField(220), stars, 'the same sky every time')
  assert.ok(stars.every(st => Math.abs(Math.hypot(st[0], st[1], st[2]) - 1) < 1e-9 && st[3] > 0 && st[3] <= 1), 'unit directions, visible')
  assert.ok(stars.filter(st => st[1] > 0).length > 90 && stars.filter(st => st[1] < 0).length > 90, 'spread over the whole sphere')
  // Patterns are named by how they look, not by what planet they suit.
  { const V0 = loadVera('VeraSurfaces'); assert.ok(V0.SURFACE_PATTERNS.every(p => !/planet|giant|moon|world|star|asteroid/i.test(p.join(' '))), 'no pattern names a kind of body') }
  // scene.paint, rings and mark: carried to the body, checked, and any change to them makes the body again.
  {
    const earth = (pattern, extra = x => x) => world([extra(call('paint', call('sphere', 'e', 0, 0, 0, 0.2, '#1f5fa8'), pattern, '#3f8a3a'))])
    const e = earth('patches').bodies[0]
    assert.deepEqual([e.pattern, e.color2, e.rings, e.mark], ['patches', '#3f8a3a', [], ''])
    traps(() => earth('marble'), 'R0029', /no pattern "marble".*"patches"/, 'an unknown pattern names the ones there are')
    traps(() => world([call('paint', call('box', 'b', 0, 0, 0, 1, 1, 1, 'ink'), 'bands', 'ink')]), 'R0029', /paints a sphere/)
    const saturn = world([call('rings', call('sphere', 's', 0, 0, 0, 0.2, '#f0e0b0'), 0.26, 0.46, '#d8c8a0')]).bodies[0]
    assert.deepEqual([saturn.rings, saturn.ringColor], [[0.26, 0.46], '#d8c8a0'])
    traps(() => world([call('rings', call('sphere', 's', 0, 0, 0, 0.2, 'ink'), 0.1, 0.4, 'ink')]), 'R0029', /beyond its radius/)
    traps(() => world([call('rings', call('sphere', 's', 0, 0, 0, 0.2, 'ink'), 0.4, 0.3, 'ink')]), 'R0029', /outer more than inner/)
    assert.equal(world([call('mark', call('sphere', 'm', 0, 0, 0, 0.1, 'ink'), '')]).bodies[0].mark, 'accent', 'a mark is the accent by default')
    const a = earth('patches'), b = earth('patches', t => call('mark', t, 'accent'))
    assert.deepEqual(S.diffWorld(a, b).recreate.map(x => x.id), ['e'], 'marking a painted ball makes it again')
    const recoloured = world([call('paint', call('sphere', 'e', 0, 0, 0, 0.2, '#ffd166'), 'patches', '#3f8a3a')])
    assert.deepEqual(S.diffWorld(a, recoloured).recreate.map(x => x.id), ['e'], 'a painted ball\'s colour is in its mesh')
    assert.deepEqual(S.diffWorld(a, earth('patches')).recreate, [], 'the same paint changes nothing')
    // Rings count in the world's size, so the camera fits them.
    const ringed = world([call('camera', 0, 0.2, 1, 0, 0, 0, false), call('rings', call('sphere', 's', 0, 0, 0, 0.1, 'ink'), 0.15, 0.6, 'ink')])
    assert.ok(L.worldBounds(ringed)[3] >= 0.6, 'rings widen the bounds')
    const V = loadVera('VeraSurfaces')
    const sph = V.paintedSphere(1, 'patches', [0.12, 0.37, 0.66], [0.25, 0.54, 0.23], 7)
    assert.equal(sph.positions.length, sph.colors.length); assert.equal(sph.indices.length, V.SURFACE_LON * (V.SURFACE_LAT - 1) * 6)
    const tones = new Set()
    for (let i = 0; i < sph.colors.length; i += 3) tones.add(sph.colors[i + 2] > 0.9 ? 'ice' : sph.colors[i + 2] > sph.colors[i + 1] ? 'sea' : 'land')
    assert.deepEqual([...tones].sort(), ['ice', 'land', 'sea'], 'patches has two colours and white caps')
    for (let i = 0; i < sph.indices.length; i += 3) {
      const P = k => sph.positions.slice(sph.indices[i + k] * 3, sph.indices[i + k] * 3 + 3)
      const [A, B, C] = [P(0), P(1), P(2)], u = B.map((v, k) => v - A[k]), w = C.map((v, k) => v - A[k])
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
      if (n[0] * A[0] + n[1] * A[1] + n[2] * A[2] <= 0) { assert.fail('a sphere triangle faces inward at ' + i) }
    }
    assert.deepEqual(V.paintedSphere(1, 'craters', [0.6, 0.6, 0.6], [0.4, 0.4, 0.4], 3).colors,
      V.paintedSphere(1, 'craters', [0.6, 0.6, 0.6], [0.4, 0.4, 0.4], 3).colors, 'one id, one surface')
  }
  // A drag circles the eye round the look point at the same distance, and the tilt stays within its limits.
  const eye2 = L.orbitEye([0, 4.5, 8], [0, 0, 0], 0.7, 0.2, -1.45, 1.45)
  near(Math.hypot(...eye2), Math.hypot(0, 4.5, 8), 1e-9, 'same distance after a drag')
  const low = L.orbitEye([0, 1, 5], [0, 0, 0], 0, -3, 0.05, 1.45)
  near(Math.asin(low[1] / Math.hypot(...low)), 0.05, 1e-9, 'no lower than the floor allows')

  // The table: its top's upper face is y = 0, the walls stand on it round the playing area.
  const parts = L.tableParts(dice.table)
  assert.equal(parts.length, 5)
  near(parts[0][1] + parts[0][4] / 2, 0, 1e-12, 'the top ends at y = 0')
  for (const w of parts.slice(1)) near(w[1] - w[4] / 2, 0, 1e-12, 'a wall stands on y = 0')
  near(parts[4][0] - parts[4][3] / 2, dice.table.width / 2, 1e-12, 'the +x wall starts at the edge of the play area')
  near(parts[2][2] - parts[2][5] / 2, dice.table.depth / 2, 1e-12, 'the +z wall starts at the edge of the play area')

  // The pips: 21, each face its number of them, on the face it names.
  const pips = L.pipLayout(0.5)
  assert.equal(pips.length, 21)
  const axis = {1: [2, 1], 6: [2, -1], 3: [0, 1], 4: [0, -1], 2: [1, 1], 5: [1, -1]}
  for (let face = 1; face <= 6; face++) {
    const on = pips.filter(p => p[0] === face)
    assert.equal(on.length, face, face + ' pips on face ' + face)
    for (const p of on) near(p[1 + axis[face][0]], axis[face][1] * 0.5 * L.PIP_DEPTH, 1e-12, 'pip on face ' + face)
  }
  // The face the pips put on top is the face topFace reads: +y up is 2.
  assert.equal(S.topFace(0, 0, 0, 1), pips.filter(p => p[2] > 0.4).length, 'the upward face has as many pips as topFace says')
}

// ---- physics: WorldSim over FakePhys (vera/VeraPhysics.ets)
{
  const P = loadVera('VeraPhysics')
  const L = loadVera('VeraLook3D')
  const FRAME_MS = 1000 / 60
  // A program run against the sim the way the phone runs it: build on each state, diff, apply, frames, events back to the handler.
  const play = (name, {frames = 600, onFrame = null, engine = null} = {}) => {
    const {vm, state: s0} = run(name)
    const sim = new P.WorldSim(engine || new P.FakePhys())
    let state = s0, spec = null, t = 0
    const log = []
    const rebuild = () => {
      const next = S.decodeScene(vm.execute('build', [state]))
      sim.apply(S.diffWorld(spec, next), next)
      spec = next
    }
    const send = e => { log.push(e); state = vm.execute('onWorld', [state, S.sceneEventValue(e.kind, e.body, e.other, e.x, e.y, e.z, e.speed, e.bodies, e.values)]); rebuild() }
    rebuild()
    for (let f = 0; f < frames; f++) {
      if (onFrame) { const next = onFrame(f, state, vm); if (next) { state = next; rebuild() } }
      t += FRAME_MS / 1000
      sim.step(FRAME_MS, t)
      for (const e of sim.takeEvents()) send(e)
    }
    return {sim, log, state: () => state, spec: () => spec}
  }

  // Dice: thrown, they settle, the faces told are the faces their rotations show, and the program adds them up.
  {
    const {sim, log, state} = play('world-dice', {frames: 60 + 8 * 60, onFrame: (f, st, vm) =>
      f === 60 ? vm.execute('onThrow', [st, new VeraNumberValue(0)]) : null})
    const settled = log.filter(e => e.kind === 'settled')
    assert.equal(settled.length, 1, 'one settle per throw: ' + JSON.stringify(settled))
    const e = settled[0]
    assert.deepEqual(e.bodies, ['d1', 'd2'])
    for (let k = 0; k < 2; k++) {
      const pose = sim.poseOf(e.bodies[k])
      assert.ok(e.values[k] >= 1 && e.values[k] <= 6, 'a face: ' + e.values)
      assert.equal(e.values[k], S.topFace(pose[3], pose[4], pose[5], pose[6]), 'the face told is the face on top')
      assert.ok(Math.abs(pose[0]) < 0.6 && Math.abs(pose[2]) < 0.45 && pose[1] > 0 && pose[1] < 0.2, e.bodies[k] + ' lies on the table: ' + pose)
    }
    assert.equal(state().fields.get('read').value, 1, 'the program read the throw')
    assert.equal(state().fields.get('total').value, e.values[0] + e.values[1])
  }
  // Six throws in a row, nine seconds apart: each settles once, and the dice never leave the table.
  {
    const {log, sim} = play('world-dice', {frames: 6 * 9 * 60, onFrame: (f, st, vm) =>
      f % (9 * 60) === 30 ? vm.execute('onThrow', [st, new VeraNumberValue(0)]) : null})
    const settles = log.filter(e => e.kind === 'settled')
    assert.equal(settles.length, 6, 'six throws, six settles')
    for (const e of settles) assert.ok(e.values.every(v => v >= 1 && v <= 6))
    for (const id of ['d1', 'd2']) {
      const p = sim.poseOf(id)
      assert.ok(Math.abs(p[0]) < 0.6 && Math.abs(p[2]) < 0.45, id + ' is still on the table after six throws: ' + p)
    }
  }
  // Settling within 8 s of simulated time, counted in frames.
  {
    const sim = new P.WorldSim(new P.FakePhys())
    const {vm, state} = run('world-dice')
    const a = S.decodeScene(vm.execute('build', [state]))
    sim.apply(S.diffWorld(null, a), a)
    for (let f = 0; f < 90; f++) sim.step(FRAME_MS, f / 60)
    assert.equal(sim.takeEvents().filter(e => e.kind === 'settled').length, 0, 'dice dropped without a throw do not settle as a throw')
    assert.equal(sim.needsFrames(), false, 'and once they lie still nothing needs frames')
    const b = S.decodeScene(vm.execute('build', [vm.execute('onThrow', [state, new VeraNumberValue(0)])]))
    sim.apply(S.diffWorld(a, b), b)
    assert.equal(sim.needsFrames(), true, 'a throw needs frames')
    let at = -1
    for (let f = 0; f < 8 * 60 && at < 0; f++) { sim.step(FRAME_MS, f / 60); if (sim.takeEvents().some(e => e.kind === 'settled')) at = f }
    assert.ok(at > 10 && at < 8 * 60, 'settled within 8 s: frame ' + at)
    // The kick fires only when the trigger changes: the same state again does nothing.
    sim.apply(S.diffWorld(b, b), b)
    for (let f = 0; f < 120; f++) sim.step(FRAME_MS, f / 60)
    assert.equal(sim.takeEvents().length, 0, 'no new kick, no new settle')
    assert.equal(sim.awake, 0)
    // A kick is velocity and a tumble about an axis seeded by id and trigger.
    const ax = P.kickAxis('d1', 1)
    assert.ok(Math.abs(Math.hypot(...ax) - 1) < 1e-9); assert.deepEqual(P.kickAxis('d1', 1), ax); assert.notDeepEqual(P.kickAxis('d1', 2), ax)
  }
  // A kick goes to the engine as setVelocity, only on a change of trigger.
  {
    const calls = []
    const fake = new P.FakePhys()
    const spy = new Proxy(fake, {get: (o, k) => typeof o[k] === 'function' ? (...a) => { if (k === 'setVelocity') calls.push(a); return o[k](...a) } : o[k]})
    const sim = new P.WorldSim(spy)
    const block = t => S.decodeScene(new VeraArrayValue([call('table', 1, 1, 'surface'), call('kick', call('box', 'd', 0, 0.3, 0, 0.1, 0.1, 0.1, 'white'), t, 1, 2, 3, 1)]))
    let prev = null
    for (const t of [0, 0, 5, 5, 5, 6]) { const next = block(t); sim.apply(S.diffWorld(prev, next), next); prev = next }
    assert.deepEqual(calls.map(c => c.slice(1, 4)), [[1, 2, 3], [1, 2, 3]], 'kicked at 5 and at 6, not at 0 nor on a repeat')
    const w = calls[0].slice(4); assert.ok(Math.abs(Math.hypot(...w) - 2 * Math.PI) < 1e-9, 'one turn a second, as written')
    // Created with a trigger other than 0: kicked at once.
    const sim2 = new P.WorldSim(spy); calls.length = 0
    const born = block(3); sim2.apply(S.diffWorld(null, born), born)
    assert.equal(calls.length, 1)
    // A die is thrown fair whatever was written: 4 to 6 turns a second about any axis, its velocity varied a little.
    const die = t => S.decodeScene(new VeraArrayValue([call('table', 1, 1, 'surface'), call('kick', call('die', 'd', 0, 0.3, 0, 0.1, 'white'), t, 1, 2, 3, 1)]))
    const throwsOf = random => {
      const got = []
      const s = new P.WorldSim(new Proxy(new P.FakePhys(), {get: (o, k) => typeof o[k] === 'function' ? (...a) => { if (k === 'setVelocity') got.push(a.slice(1)); return o[k](...a) } : o[k]}), random)
      let before = null
      for (let t = 1; t <= 200; t++) { const next = die(t); s.apply(S.diffWorld(before, next), next); before = next }
      return got
    }
    const thrown = throwsOf(null)
    assert.equal(thrown.length, 200)
    for (const v of thrown) {
      const turns = Math.hypot(v[3], v[4], v[5]) / (2 * Math.PI)
      assert.ok(turns >= P.DIE_MIN_TURNS - 1e-9 && turns <= P.DIE_MIN_TURNS + P.DIE_EXTRA_TURNS + 1e-9, 'a die tumbles 4 to 6 turns a second: ' + turns)
      const across = Math.hypot(v[0], v[2]) / Math.hypot(1, 3)
      assert.ok(across >= 1 - P.DIE_SPEED_JITTER - 1e-9 && across <= 1 + P.DIE_SPEED_JITTER + 1e-9, 'its speed across within the jitter: ' + across)
      assert.ok(Math.abs(v[1] / 2 - 1) <= P.DIE_LIFT_JITTER + 1e-9, 'its lift within the jitter')
      const angle = Math.abs(Math.atan2(v[2], v[0]) - Math.atan2(3, 1)) * 180 / Math.PI
      assert.ok(angle <= P.DIE_TURN_DEG + 1e-6, 'its direction turned at most ' + P.DIE_TURN_DEG + ' degrees: ' + angle)
    }
    // The axes are level, spread over every direction: x and z each average near 0 and their squares near 1/2.
    assert.ok(thrown.every(v => v[4] === 0), 'a die tumbles about a level axis (a spin about the upright does not turn it over)')
    for (const k of [3, 5]) {
      const unit = thrown.map(v => v[k] / Math.hypot(v[3], v[4], v[5]))
      const mean = unit.reduce((a, b) => a + b, 0) / unit.length
      const sq = unit.reduce((a, b) => a + b * b, 0) / unit.length
      assert.ok(Math.abs(mean) < 0.15 && Math.abs(sq - 1 / 2) < 0.1, 'spin axes spread evenly: ' + mean + ' ' + sq)
    }
    assert.deepEqual(throwsOf(null), thrown, 'on the host a throw is seeded by id and trigger: the same every run')
    let draws = 0
    const fromRandom = throwsOf(() => { draws++; return 0.5 })
    assert.equal(draws, 2 + 5 * 200, 'with a random source (the phone: Math.random), the start draws two numbers and each throw five')
    assert.ok(fromRandom.every(v => Math.abs(Math.hypot(v[3], v[4], v[5]) / (2 * Math.PI) - 5) < 1e-9), 'and uses them')
    // A die is created lying on a face drawn at random, one of the 24 turns of a cube onto itself, where it was written.
    const start = new Set()
    for (let k = 0; k < 240; k++) {
      const q = P.dieStartTurn(P.seededRandom(k))
      assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-9)
      start.add(S.topFace(q[0], q[1], q[2], q[3]) + ':' + q.map(x => x.toFixed(3)).join(','))
    }
    assert.equal(new Set([...start].map(x => x.split(':')[0])).size, 6, 'every face can start on top')
    assert.equal(start.size, 24, 'and every quarter turn of it')
    const pose = id => { const s2 = new P.WorldSim(new P.FakePhys()); const w2 = die(0); s2.apply(S.diffWorld(null, w2), w2); return s2.poseOf(id) }
    const p0 = pose('d')
    assert.deepEqual(p0.slice(0, 3).map(x => Math.round(x * 1e6) / 1e6), [0, 0.3, 0], 'where it was written')
    assert.deepEqual(pose('d'), p0, 'the same start on every host run')
    const boxPose = (() => { const s2 = new P.WorldSim(new P.FakePhys()); const w2 = block(0); s2.apply(S.diffWorld(null, w2), w2); return s2.poseOf('d') })()
    assert.deepEqual(boxPose.slice(3), [0, 0, 0, 1], 'a box that is not a die starts as written')
  }
  // Six hundred throws of world-dice on FakePhys (whose dice tumble only roughly and lie flat by a snap): the faces spread.
  // Ten seconds a throw: two dice caught jittering on each other are stopped by each one's own sleep cap (8 s of touching),
  // one after the other, so the rare throw that ends that way settles a little after 9 s.
  {
    const counts = [0, 0, 0, 0, 0, 0, 0]
    let repeats = 0, last = 0
    const presses = new Set()
    for (let k = 0; k < 600; k++) presses.add(30 + k * 600)
    const {log} = play('world-dice', {frames: 30 + 600 * 600, onFrame: (f, st, vm) => presses.has(f) ? vm.execute('onThrow', [st, new VeraNumberValue(0)]) : null})
    const settles = log.filter(e => e.kind === 'settled')
    assert.equal(settles.length, 600, 'six hundred throws, six hundred settles')
    for (const e of settles) { const v = e.values[0]; counts[v]++; repeats += v === last ? 1 : 0; last = v }
    console.log('world-check: 600 FakePhys throws of d1: ' + counts.slice(1).map((c, k) => (k + 1) + ':' + c).join(' ') + ', the same face twice ' + repeats)
    assert.ok(counts.slice(1).every(c => c >= 60 && c <= 140), 'every face comes up on FakePhys too: ' + counts)
  }
  // Out of the bound: a loose body that leaves the table goes back where it was created.
  {
    const sim = new P.WorldSim(new P.FakePhys())
    const w = S.decodeScene(new VeraArrayValue([call('table', 1, 1, 'surface'), call('loose', call('box', 'b', 0, 0.2, 0, 0.1, 0.1, 0.1, 'ink'), 1)]))
    sim.apply(S.diffWorld(null, w), w)
    const i = sim.index.get('b')
    sim.engine.setPose(i, 0, -2, 0, 0, 0, 0, 1)   // as if it had fallen through (this also becomes its home in the engine...)
    sim.engine.setPose(i, 0, 0.2, 0, 0, 0, 0, 1)  // ... so put the home back, then throw it far off the side
    sim.engine.setVelocity(i, 40, 0, 0, 0, 0, 0)
    let back = false
    for (let f = 0; f < 60 && !back; f++) {
      sim.step(FRAME_MS, f / 60)
      for (let k = 0; k < sim.poseCount; k++) if (sim.idAt(sim.poses[k * 8]) === 'b' && Math.abs(sim.poses[k * 8 + 1]) < 1e-6 && Math.abs(sim.poses[k * 8 + 3]) < 1e-6 && f > 0) back = true
    }
    assert.ok(back, 'the box came back to where it was created, and was reported as moved')
    // A world with no table or floor floats: nothing falls.
    const space = new P.WorldSim(new P.FakePhys())
    const s = S.decodeScene(new VeraArrayValue([call('loose', call('sphere', 'm', 0, 1, 0, 0.1, 'ink'), 1)]))
    space.apply(S.diffWorld(null, s), s)
    for (let f = 0; f < 60; f++) space.step(FRAME_MS, f / 60)
    assert.ok(Math.abs(space.poseOf('m')[1] - 1) < 1e-6, 'no gravity in space')
  }
  // Fixed steps: never more than four a frame, and a long gap is not caught up.
  {
    const steps = []
    const fake = new P.FakePhys()
    const spy = new Proxy(fake, {get: (o, k) => typeof o[k] === 'function' ? (...a) => { if (k === 'stepBegin') steps.push(a); return o[k](...a) } : o[k]})
    const sim = new P.WorldSim(spy)
    const w = S.decodeScene(new VeraArrayValue([call('floor', 'surface'), call('loose', call('sphere', 'm', 0, 1, 0, 0.1, 'ink'), 1)]))
    sim.apply(S.diffWorld(null, w), w)
    sim.step(8, 0); assert.equal(steps.length, 0, 'half a step waits')
    sim.step(9, 0); assert.deepEqual(steps.pop(), [1 / 60, 1])
    sim.step(1000, 0); assert.deepEqual(steps.pop(), [4 / 60, 4], 'a second-long gap is four steps')
    sim.step(50, 0); assert.deepEqual(steps.pop(), [3 / 60, 3])
  }
  // Cubes: the ball knocks the wall about; the knocks are told as hits, at most one each HIT_INTERVAL_S, each gathering
  // every body knocked since the last, and the program counts the bodies.
  {
    let shot = false
    const engine = new P.FakePhys()
    const frames = []
    const {log, state, sim} = play('world-cubes', {frames: 5 * 60, engine, onFrame: (f, st, vm) => {
      frames.push(f)
      if (f === 60) { shot = true; return vm.execute('onShoot', [st, new VeraNumberValue(0)]) }
      return null
    }})
    const hits = log.filter(e => e.kind === 'hit')
    assert.ok(shot && hits.length >= 2, 'the ball knocks into the wall: ' + hits.length + ' hits')
    assert.ok(hits.some(e => e.bodies.includes('ball1')), 'the ball itself is among the bodies knocked')
    for (const e of hits) {
      assert.ok(e.speed > 1 && e.body.length > 0 && e.bodies.length > 0, 'a hit names a body and is harder than 1 m/s')
      assert.equal(e.bodies.length, e.values.length)
      assert.equal(new Set(e.bodies).size, e.bodies.length, 'each body once a hit')
      assert.ok(e.values.every((v, k) => v > 1 && (k === 0 || v <= e.values[k - 1])), 'speeds, hardest first: ' + e.values)
      assert.equal(e.values[0], e.speed, 'the first body knocked hardest, at the hit\'s speed')
      assert.ok(e.bodies[0] === e.body || e.bodies[0] === e.other || e.values[0] === e.speed)
    }
    const total = hits.reduce((a, e) => a + e.bodies.length, 0)
    assert.equal(state().fields.get('knocked').value, total, 'the program counts every body knocked')
    const knocked = spec => spec.bodies.filter(b => b.shape === 'box').filter(b => {
      const p = sim.poseOf(b.id)
      return Math.hypot(p[0] - b.position[0], p[1] - b.position[1], p[2] - b.position[2]) > 0.03
    }).length
    const {spec: wall} = run('world-cubes')
    assert.ok(knocked(wall) >= 3, 'cubes in the wall were knocked out of place: ' + knocked(wall))
    assert.ok(hits.length <= Math.ceil(4 * 60 / 60 / P.HIT_INTERVAL_S) + 1, 'at most four hits a second: ' + hits.length + ' in 4 s')
    // "settled" tells, for each body that is not a die, whether it was knocked from where it was built.
    const settle = log.filter(e => e.kind === 'settled').pop()
    assert.ok(settle !== undefined, 'the shot settles')
    const over = settle.bodies.filter((id, k) => settle.values[k] === 1)
    assert.ok(settle.values.every(v => v === 0 || v === 1), 'a box tells 0 or 1: ' + settle.values)
    assert.ok(over.length >= 3 && over.length < settle.bodies.length, 'some cubes were knocked over, not all: ' + over.length)
    console.log('world-check: the shot told ' + hits.length + ' hits of ' + total + ' bodies knocked and moved ' + knocked(wall) +
      ' cubes, ' + over.length + ' knocked over at settle (FakePhys)')
  }
  {
    // The rate, with an engine that reports nine pairs hard every step (and one too soft).
    const fake = new P.FakePhys()
    let pairs = []
    fake.drainContacts = out => { pairs.forEach((v, k) => { out[k] = v }); return pairs.length / 3 }
    const sim = new P.WorldSim(fake)
    const items = [call('floor', 'surface')]
    for (let k = 0; k < 11; k++) items.push(call('loose', call('box', 'c' + k, k * 0.3, 0.05, 0, 0.1, 0.1, 0.1, 'ink'), 1))
    const w = S.decodeScene(new VeraArrayValue(items))
    sim.apply(S.diffWorld(null, w), w)
    const idx = id => sim.index.get(id)
    pairs = []
    for (let k = 0; k < 9; k++) pairs.push(idx('c' + k), idx('c' + (k + 1)), 2 + k * 0.1)
    pairs.push(idx('c10'), -1, 0.5)   // too soft
    const told = []
    for (let f = 0; f < 60; f++) { sim.step(FRAME_MS, f / 60); for (const e of sim.takeEvents()) if (e.kind === 'hit') told.push([f, e]) }
    // The first at once, then one each quarter second: frames 0, 15, 30, 45.
    assert.deepEqual(told.map(x => x[0]), [0, 15, 30, 45], 'one hit at once, then one each 250 ms: ' + told.map(x => x[0]))
    for (const [, e] of told) {
      assert.deepEqual(e.bodies, ['c8', 'c9', 'c7', 'c6', 'c5', 'c4', 'c3', 'c2', 'c1', 'c0'], 'every body knocked, hardest first, the soft one left out')
      assert.equal(e.body, 'c8'); assert.equal(e.other, 'c9'); assert.ok(Math.abs(e.speed - 2.8) < 1e-6, 'the hardest pair')
    }
    // Knocks stop (frames 46 to 59 were gathered, not yet told): what was gathered still arrives once the interval is up,
    // and then nothing.
    pairs = []
    assert.equal(sim.needsFrames(), true, 'a gathered knock keeps the frames going until it is told')
    const late = []
    for (let f = 60; f < 90; f++) { sim.step(FRAME_MS, f / 60); for (const e of sim.takeEvents()) if (e.kind === 'hit') late.push([f, e]) }
    assert.deepEqual(late.map(x => x[0]), [60]); assert.equal(late[0][1].bodies.length, 10)
  }
  // Deterministic: two runs, the same events and the same poses.
  {
    const once = () => {
      const {log, sim} = play('world-dice', {frames: 400, onFrame: (f, st, vm) => f === 30 || f === 200 ? vm.execute('onThrow', [st, new VeraNumberValue(0)]) : null})
      return JSON.stringify([log, sim.poseOf('d1'), sim.poseOf('d2')])
    }
    assert.equal(once(), once(), 'two runs, one result')
    const cubes = () => JSON.stringify(play('world-cubes', {frames: 200, onFrame: (f, st, vm) => f === 20 ? vm.execute('onShoot', [st, new VeraNumberValue(0)]) : null}).log)
    assert.equal(cubes(), cubes())
  }
  // Settled belongs to the kick before it (phone, phase 2: a settle carried the faces of the throw before). The order is
  // press -> throws + 1 -> build -> kick -> the dice seen awake -> all asleep -> one settle, read from the poses after the
  // kick, delivered to the state that has the new throw.
  {
    // An engine that takes three steps to act on a kick: until then the dice lie asleep where the last throw left them.
    class LateWake extends P.FakePhys {
      constructor(delay) { super(); this.pending = []; this.delay = delay; this.left = 0 }
      setVelocity(...a) { if (this.delay < 0) return; this.pending.push(a); this.left = this.delay }
      step(dt, n) {
        if (this.left > 0 && --this.left === 0) { for (const a of this.pending) super.setVelocity(...a); this.pending = [] }
        return super.step(dt, n)
      }
    }
    const dropped = engine => {
      const sim = new P.WorldSim(engine)
      const {vm, state} = run('world-dice')
      const a = S.decodeScene(vm.execute('build', [state]))
      sim.apply(S.diffWorld(null, a), a)
      for (let f = 0; f < 120; f++) sim.step(FRAME_MS, f / 60)
      assert.equal(sim.awake, 0, 'the dropped dice lie still')
      sim.takeEvents()
      const b = S.decodeScene(vm.execute('build', [vm.execute('onThrow', [state, new VeraNumberValue(0)])]))
      return {sim, a, b}
    }
    {
      const {sim, a, b} = dropped(new LateWake(3))
      const before = ['d1', 'd2'].map(id => sim.poseOf(id))
      sim.apply(S.diffWorld(a, b), b)
      assert.equal(sim.kickSerial, 1); assert.equal(sim.lastKickAwake, 0, 'the engine has not woken them yet')
      const settles = []
      for (let f = 0; f < 10 * 60; f++) { sim.step(FRAME_MS, f / 60); for (const e of sim.takeEvents()) if (e.kind === 'settled') settles.push([f, e]) }
      assert.equal(settles.length, 1, 'one settle for one kick, not one before the dice woke: ' + settles.map(x => x[0]))
      const [at, e] = settles[0]
      assert.ok(at > 20, 'settled after the dice flew, not on the frames before they woke: frame ' + at)
      assert.equal(e.kick, 1); assert.ok(e.afterMs > 300, 'afterMs ' + e.afterMs)
      const after = ['d1', 'd2'].map(id => sim.poseOf(id))
      assert.deepEqual(e.values, after.map(p => S.topFace(p[3], p[4], p[5], p[6])), 'the faces told are read from the poses after the kick')
      assert.ok(before.some((p, k) => Math.hypot(p[0] - after[k][0], p[2] - after[k][2]) > 0.05), 'and the dice did move')
    }
    {
      // A kick the engine never acts on still settles, once, on the faces the dice show.
      const {sim, a, b} = dropped(new LateWake(-1))
      sim.apply(S.diffWorld(a, b), b)
      const settles = []
      for (let f = 0; f < 120; f++) { sim.step(FRAME_MS, f / 60); for (const e of sim.takeEvents()) if (e.kind === 'settled') settles.push(f) }
      assert.deepEqual(settles, [P.SETTLE_WAKE_STEPS - 1], 'a kick that wakes nothing settles after SETTLE_WAKE_STEPS steps')
    }
    {
      // A second throw before the first has settled supersedes it: one settle, for the second.
      const {sim, a, b} = dropped(new P.FakePhys())
      sim.apply(S.diffWorld(a, b), b)
      for (let f = 0; f < 10; f++) sim.step(FRAME_MS, f / 60)
      const {vm, state} = run('world-dice')
      const c = S.decodeScene(vm.execute('build', [vm.execute('onThrow', [vm.execute('onThrow', [state, new VeraNumberValue(0)]), new VeraNumberValue(0)])]))
      sim.apply(S.diffWorld(b, c), c)
      const settles = []
      for (let f = 0; f < 10 * 60; f++) { sim.step(FRAME_MS, f / 60); for (const e of sim.takeEvents()) if (e.kind === 'settled') settles.push(e.kick) }
      assert.deepEqual(settles, [2], 'two throws in quick succession settle once, for the second')
    }
    {
      // An engine that overlaps steps (the native one: the step runs on its own thread while the frame is drawn) is read
      // a frame late. The same throw then settles once, a frame later, on the same faces, and nothing is lost.
      class Overlapping extends P.FakePhys {
        constructor() { super(); this.begun = 0; this.ended = 0 }
        overlaps() { return true }
        stepBegin(dt, n) { this.begun++; super.stepBegin(dt, n) }
        stepEnd() { this.ended++; return super.stepEnd() }
      }
      const throwOnce = engine => {
        const {sim, a, b} = dropped(engine)
        sim.apply(S.diffWorld(a, b), b)
        const settles = []
        let poses = 0
        for (let f = 0; f < 10 * 60; f++) {
          sim.step(FRAME_MS, f / 60)
          poses += sim.poseCount
          for (const e of sim.takeEvents()) if (e.kind === 'settled') settles.push([f, e.kick, e.values.join(',')])
        }
        return {settles, poses, sim}
      }
      const plain = throwOnce(new P.FakePhys())
      const engine = new Overlapping()
      const late = throwOnce(engine)
      assert.equal(late.settles.length, 1, 'one settle, overlapping: ' + JSON.stringify(late.settles))
      assert.deepEqual(late.settles.map(x => x.slice(1)), plain.settles.map(x => x.slice(1)), 'the same kick and faces as stepping in place')
      assert.equal(late.settles[0][0], plain.settles[0][0] + 1, 'told one frame later')
      assert.ok(late.poses > 0 && Math.abs(late.poses - plain.poses) <= 8, 'the same poses written: ' + late.poses + ' vs ' + plain.poses)
      assert.equal(engine.begun - engine.ended, 1, 'one step in flight at the end of a frame, the rest collected')
      late.sim.reset()
      assert.equal(engine.begun, engine.ended, 'reset collects the step in flight')
      // A frame is collect, then the program hears the events, then advance: in between no step runs, so a handler
      // that changes the world is applied without waiting on the step thread.
      {
        const {sim, a, b} = dropped(engine)
        sim.apply(S.diffWorld(a, b), b)
        sim.step(FRAME_MS, 0)
        assert.equal(engine.begun - engine.ended, 1, 'a step in flight after a frame')
        sim.collect()
        assert.equal(engine.begun, engine.ended, 'collect finishes it')
        sim.advance(FRAME_MS, 1 / 60)
        assert.equal(engine.begun - engine.ended, 1, 'advance begins the next')
        sim.reset()
      }
      // An apply while a step runs finishes that step first, while the engine's indices still name its bodies: a
      // knock it saw is not told of the body that takes the freed index in this apply.
      {
        class Contacting extends Overlapping {
          constructor() { super(); this.fake = -1 }
          drainContacts(out) {
            if (this.fake < 0) return super.drainContacts(out)
            out[0] = this.fake; out[1] = -1; out[2] = 5
            this.fake = -1
            return 1
          }
        }
        const eng = new Contacting()
        const sim = new P.WorldSim(eng)
        const one = id => S.decodeScene(new VeraArrayValue([call('floor', 'surface'),
          call('loose', call('box', id, 0, 0.05, 0, 0.1, 0.1, 0.1, 'ink'), 1)]))
        const x = one('x')
        const y = one('y')
        sim.apply(S.diffWorld(null, x), x)
        sim.step(FRAME_MS, 0)
        let ix = -1
        for (let i = 0; i < 16; i++) if (sim.idAt(i) === 'x') ix = i
        assert.ok(ix >= 0, 'x has an index')
        eng.fake = ix
        sim.apply(S.diffWorld(x, y), y)
        let iy = -1
        for (let i = 0; i < 16; i++) if (sim.idAt(i) === 'y') iy = i
        assert.equal(iy, ix, 'y took the index x freed (the case this guards)')
        const told = []
        for (let f = 1; f < 30; f++) { sim.step(FRAME_MS, f / 60); for (const e of sim.takeEvents()) if (e.kind === 'hit') told.push(e) }
        assert.ok(told.every(e => e.body !== 'y' && !e.bodies.includes('y')), 'no hit names y: ' + JSON.stringify(told.map(e => e.body)))
      }
    }
    // Bodies of any shape: scene.shape (an outline, a sheet unless scene.thick) and scene.hull (3D points) are centred on their points' box,
    // their dims are that box, they go to the engine as convex pieces, and new points make the body again.
    {
      const nums = a => new VeraArrayValue(a.map(v => new VeraNumberValue(v)))
      const tri = [0.1, 0.1, 0.3, 0.1, 0.2, 0.3]
      const w = S.decodeScene(new VeraArrayValue([call('table', 1.2, 0.9, 'surface'),
        call('loose', call('thick', call('shape', 't', 0, 0.3, 0, nums(tri), 'accent'), 0.04), 1),
        call('hull', 'p', 0.4, 0, 0, nums([-0.1, 0, -0.1, 0.1, 0, -0.1, 0.1, 0, 0.1, -0.1, 0, 0.1, 0, 0.15, 0]), 'warning')]))
      const t = w.bodies.find(b => b.id === 't')
      const p = w.bodies.find(b => b.id === 'p')
      assert.equal(t.shape, 'shape')
      assert.deepEqual(t.dims.map(v => +v.toFixed(6)), [0.2, 0.04, 0.2], 'a shape is as big as its outline and as thick as h')
      assert.deepEqual(t.position.map(v => +v.toFixed(6)), [0.2, 0.3, 0.2], 'and stands where its outline\'s box is centred')
      assert.deepEqual(p.dims.map(v => +v.toFixed(6)), [0.2, 0.15, 0.2], 'a hull is as big as its points')
      assert.deepEqual(p.position.map(v => +v.toFixed(6)), [0.4, 0.075, 0], 'and centred on them')
      class Counting extends P.FakePhys {
        constructor() { super(); this.parts = [] }
        addParts(records, points, kind) { this.parts.push([records.length / 12, points.length]); return super.addParts(records, points, kind) }
      }
      const eng = new Counting()
      const sim = new P.WorldSim(eng)
      sim.apply(S.diffWorld(null, w), w)
      assert.deepEqual(eng.parts, [[1, 18], [1, 15]], 'one convex part each: ' + JSON.stringify(eng.parts))
      assert.ok(sim.poseOf('t') !== null && sim.poseOf('p') !== null, 'both are in the engine')
      const moved = S.decodeScene(new VeraArrayValue([call('table', 1.2, 0.9, 'surface'),
        call('loose', call('thick', call('shape', 't', 0, 0.3, 0, nums([0.1, 0.1, 0.3, 0.1, 0.25, 0.3]), 'accent'), 0.04), 1),
        call('hull', 'p', 0.4, 0, 0, nums([-0.1, 0, -0.1, 0.1, 0, -0.1, 0.1, 0, 0.1, -0.1, 0, 0.1, 0, 0.15, 0]), 'warning')]))
      assert.deepEqual(S.diffWorld(w, moved).recreate.map(b => b.id), ['t'], 'new points make the body again')
      const refuse = (fn, args, re) => assert.throws(() => call(fn, ...args), e => re.test(e.message), fn + ' refused: ' + re)
      refuse('shape', ['x', 0, 0, 0, nums([0, 0, 1, 1, 1, 0, 0, 1]), 'ink'], /cross/)
      refuse('shape', ['x', 0, 0, 0, nums([0, 0, 1, 0]), 'ink'], /at least 3/)
      refuse('thick', [call('shape', 'x', 0, 0, 0, nums(tri), 'ink'), 0], /more than 0/)
      refuse('thick', [call('box', 'x', 0, 0, 0, 1, 1, 1, 'ink'), 0.1], /takes a scene.shape/)
      // Without thick a shape is a flat sheet: a hundredth of its larger side thick, a millimetre at least.
      const sheet = S.decodeScene(new VeraArrayValue([call('shape', 's', 0, 0, 0, nums(tri), 'ink')])).bodies[0]
      assert.ok(Math.abs(sheet.dims[1] - 0.002) < 1e-12, 'a 20 cm sheet is 2 mm thick: ' + sheet.dims[1])
      const chip = S.decodeScene(new VeraArrayValue([call('shape', 'c', 0, 0, 0, nums([0, 0, 0.02, 0, 0, 0.02]), 'ink')])).bodies[0]
      assert.equal(chip.dims[1], 0.001, 'a 2 cm sheet is 1 mm thick')
      refuse('hull', ['x', 0, 0, 0, nums([0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1]), 'ink'], /one plane/)
      // A wrapper takes them as it takes any body.
      assert.doesNotThrow(() => call('turn', call('spin', call('thick', call('shape', 'y', 0, 0, 0, nums(tri), 'ink'), 0.1), 3), 90, 0, 0))
    }
    // A group: one body of parts. Centred on the box round its parts (turned parts counted turned), its dims that box; the
    // physics gets a record per part where it sits; a change to a part makes it again; parts may not move on their own.
    {
      const thing = items => new VeraArrayValue(items)
      const snow = (headColor = 'white') => call('group', 'man', 0, 0, 0, thing([
        call('sphere', 'base', 0, 0.15, 0, 0.15, 'white'),
        call('sphere', 'head', 0, 0.36, 0, 0.1, headColor),
        call('turn', call('box', 'hat', 0, 0.5, 0, 0.3, 0.04, 0.04, 'ink'), 0, 0, 90)]))
      const w = S.decodeScene(new VeraArrayValue([call('floor', 'surface'), call('loose', snow(), 2)]))
      const g = w.bodies[0]
      assert.equal(g.shape, 'group')
      assert.equal(g.parts.length, 3)
      // The hat turned upright reaches 0.15 above and below 0.5: the group spans y 0 .. 0.65, x and z -0.15 .. 0.15.
      assert.deepEqual(g.dims.map(v => +v.toFixed(6)), [0.3, 0.65, 0.3], 'dims are the box round the parts: ' + g.dims)
      assert.deepEqual(g.position.map(v => +v.toFixed(6)), [0, 0.325, 0], 'centred on it')
      assert.deepEqual(g.parts[0].position.map(v => +v.toFixed(6)), [0, -0.175, 0], 'parts moved to match')
      const recs = P.bodyRecords(g)
      assert.equal(recs.records.length, 3 * 12, 'a record per part')
      assert.deepEqual(recs.records.slice(0, 4).map(v => +v.toFixed(6)), [1, 0, -0.175, 0], 'the base ball, where it sits')
      assert.ok(Math.abs(recs.records[2 * 12 + 6] - Math.sin(Math.PI / 4)) < 1e-9, 'the hat turned 90 degrees about z')
      class Counting extends P.FakePhys {
        constructor() { super(); this.parts = [] }
        addParts(records, points, kind) { this.parts.push(records.length / 12); return super.addParts(records, points, kind) }
      }
      const eng = new Counting()
      const sim = new P.WorldSim(eng)
      sim.apply(S.diffWorld(null, w), w)
      assert.deepEqual(eng.parts, [3], 'one body of three parts')
      for (let f = 0; f < 120; f++) sim.step(FRAME_MS, f / 60)
      assert.ok(sim.poseOf('man')[1] > 0.3 && sim.poseOf('man')[1] < 0.36, 'it stands on the floor: ' + sim.poseOf('man')[1])
      const w2 = S.decodeScene(new VeraArrayValue([call('floor', 'surface'), call('loose', snow('accent'), 2)]))
      assert.deepEqual(S.diffWorld(w, w2).recreate.map(b => b.id), [], 'a part\'s new colour does not make the group again')
      assert.deepEqual(S.diffWorld(w, w2).material.map(b => b.id), ['man'], 'it is a material update: the body stays where it is')
      assert.deepEqual(S.diffWorld(w, S.decodeScene(new VeraArrayValue([call('floor', 'surface'), call('loose', snow(), 2)]))).recreate, [],
        'the same group is left alone')
      const part = call('box', 'p', 0, 0, 0, 0.1, 0.1, 0.1, 'ink')
      const refuse = (items, re) => assert.throws(() => call('group', 'g', 0, 0, 0, thing(items)), e => re.test(e.message), String(re))
      refuse([call('loose', part, 1)], /wrap the group instead/)
      refuse([call('kick', part, 1, 0, 1, 0, 1)], /wrap the group instead/)
      refuse([call('spin', part, 2)], /wrap the group instead/)
      refuse([call('mark', part, 'accent')], /wrap the group instead/)
      refuse([call('glow', part)], /wrap the group instead/)
      refuse([call('group', 'inner', 0, 0, 0, thing([part]))], /is a group/)
      refuse([call('die', 'd', 0, 0, 0, 0.1, 'white')], /is a die/)
      refuse([], /1 to 16 parts/)
      refuse([part, part], /two parts have the id/)
      refuse(Array.from({length: 17}, (_, k) => call('box', 'p' + k, k, 0, 0, 0.1, 0.1, 0.1, 'ink')), /1 to 16 parts/)
      // The group is wrapped as any body is.
      assert.doesNotThrow(() => call('kick', call('mark', call('turn', snow(), 0, 30, 0), 'accent'), 1, 0, 2, 0, 1))
      // The prompt names the parts' type.
      assert.match(S.describeSceneForPrompt ? S.describeSceneForPrompt() : JSON.stringify(S.SCENE_FUNCTIONS.map(f => f.name)), /group/)
    }
    // A block added on top of a tower built in an earlier state rests on it, as one built with it would.
    {
      const tower = n => S.decodeScene(new VeraArrayValue([call('floor', 'surface'),
        ...Array.from({length: n}, (_, k) => call('loose', call('box', 'b' + k, 0, 0.05 + 0.1 * k, 0, 0.1, 0.1, 0.1, 'ink'), 1))]))
      const sim = new P.WorldSim(new P.FakePhys())
      const t3 = tower(3)
      sim.apply(S.diffWorld(null, t3), t3)
      assert.equal(sim.restingCount, 3, 'the tower is built resting')
      for (let f = 0; f < 30; f++) sim.step(FRAME_MS, f / 60)
      const t4 = tower(4)
      sim.apply(S.diffWorld(t3, t4), t4)
      assert.equal(sim.restingCount, 1, 'the block added on top later rests too')
      assert.equal(sim.awake, 0, 'and nothing is awake')
    }
    // Five presses, each after the last settle (as on the phone): five settles, each delivered to the state of its own
    // throw, which then shows the faces it was told.
    {
      const presses = [30, 300, 570, 840, 1110]
      const seen = []
      let lastRead = 0
      const {log, state} = play('world-dice', {frames: 1400, onFrame: (f, st, vm) => {
        const read = st.fields.get('read').value
        if (read !== lastRead) {
          lastRead = read
          assert.equal(read, st.fields.get('throws').value, 'the settle reached the state of its throw')
          seen.push([read, st.fields.get('total').value])
        }
        return presses.includes(f) ? vm.execute('onThrow', [st, new VeraNumberValue(0)]) : null
      }})
      const settles = log.filter(e => e.kind === 'settled')
      assert.deepEqual(settles.map(e => e.kick), [1, 2, 3, 4, 5], 'one settle per press, in order')
      assert.deepEqual(seen, settles.map(e => [e.kick, e.values[0] + e.values[1]]), 'each settle ends its own throw, and the program shows its faces')
      assert.equal(state().fields.get('read').value, 5)
    }
  }
  // knockedOver: moved more than half the smallest side, or turned more than 25 degrees, from how it was built.
  {
    const b = {position: [0, 0.05, 0], dims: [0.1, 0.1, 0.1], rotation: [0, 0, 0]}
    const pose = (x, y, z, deg) => { const h = deg * Math.PI / 360; return new Float32Array([x, y, z, Math.sin(h), 0, 0, Math.cos(h)]) }
    assert.equal(P.knockedOver(b, pose(0, 0.05, 0, 0)), false, 'where it was built')
    assert.equal(P.knockedOver(b, pose(0.04, 0.05, 0, 0)), false, 'nudged 4 cm')
    assert.equal(P.knockedOver(b, pose(0.06, 0.05, 0, 0)), true, 'pushed 6 cm')
    assert.equal(P.knockedOver(b, pose(0, 0.05, 0, 20)), false, 'leaning 20 degrees')
    assert.equal(P.knockedOver(b, pose(0, 0.05, 0, 90)), true, 'on its side')
    const turned = {position: [0, 0.05, 0], dims: [0.1, 0.1, 0.1], rotation: [90, 0, 0]}
    assert.equal(P.knockedOver(turned, pose(0, 0.05, 0, 90)), false, 'built on its side and still so')
  }
  // A wall built resting stands still until hit: a hundred cubes, five seconds, nothing moves and nothing knocks.
  {
    const {spec} = run('world-cubes')
    const created = spec.bodies
    const resting = P.restingAtStart(spec, created, new Set())
    assert.equal(resting.length, 101, 'the hundred cubes rest on the floor and on each other, and the ball on the floor')
    assert.deepEqual(P.restingAtStart(run('world-dice').spec, run('world-dice').spec.bodies, new Set()), [], 'dice in the air start awake')
    // A cube beside the wall, not over anything, and one sunk into the floor start awake too.
    const odd = S.decodeScene(new VeraArrayValue([call('floor', 'surface'), call('loose', call('box', 'up', 0, 0.3, 0, 0.1, 0.1, 0.1, 'ink'), 1),
      call('loose', call('box', 'sunk', 1, 0.02, 0, 0.1, 0.1, 0.1, 'ink'), 1), call('loose', call('box', 'on', 0, 0.15, 0, 0.1, 0.1, 0.1, 'ink'), 1),
      call('loose', call('box', 'base', 0, 0.05, 0, 0.1, 0.1, 0.1, 'ink'), 1), call('loose', call('box', 'off', 0.2, 0.15, 0, 0.1, 0.1, 0.1, 'ink'), 1)]))
    assert.deepEqual(P.restingAtStart(odd, odd.bodies, new Set()).sort(), ['base', 'on'], 'only what stands on something rests')
    assert.deepEqual(P.restingAtStart(odd, odd.bodies, new Set(['base'])), [], 'a thrown body does not rest, nor what stands on it')
    const sim = new P.WorldSim(new P.FakePhys())
    sim.apply(S.diffWorld(null, spec), spec)
    assert.equal(sim.restingCount, 101)
    let hits = 0
    for (let f = 0; f < 5 * 60; f++) { sim.step(FRAME_MS, f / 60); hits += sim.takeEvents().filter(e => e.kind === 'hit').length }
    const moved = spec.bodies.filter(b => b.shape === 'box').filter(b => {
      const p = sim.poseOf(b.id)
      return Math.hypot(p[0] - b.position[0], p[1] - b.position[1], p[2] - b.position[2]) > 0.001
    })
    assert.deepEqual(moved.map(b => b.id), [], 'no cube moved more than 1 mm in 5 s')
    assert.equal(hits, 0, 'and nothing was knocked')
  }
  // Orbits in a world with loose bodies go to the engine as kinematic moves, where orbitPositions puts them.
  {
    const moves = []
    const fake = new P.FakePhys()
    const spy = new Proxy(fake, {get: (o, k) => typeof o[k] === 'function' ? (...a) => { if (k === 'moveKinematic') moves.push(a); return o[k](...a) } : o[k]})
    const sim = new P.WorldSim(spy)
    const w = S.decodeScene(new VeraArrayValue([call('floor', 'surface'), call('sphere', 'c', 0, 0.5, 0, 0.1, 'ink'),
      call('orbit', call('sphere', 'o', 0, 0, 0, 0.05, 'ink'), 'c', 1, 4, 0), call('loose', call('box', 'b', 3, 0.05, 0, 0.1, 0.1, 0.1, 'ink'), 1)]))
    sim.apply(S.diffWorld(null, w), w)
    sim.step(FRAME_MS, 1)
    const want = S.orbitPositions(w, 1).get('o')
    assert.equal(moves.length, 1); assert.deepEqual(moves[0].slice(1, 4), want.slice(0, 3))
  }
  // Removing and re-creating bodies frees and reuses engine indices; ids follow.
  {
    const sim = new P.WorldSim(new P.FakePhys())
    const a = S.decodeScene(new VeraArrayValue([call('floor', 'surface'), call('loose', call('box', 'x', 0, 0.05, 0, 0.1, 0.1, 0.1, 'ink'), 1)]))
    const b = S.decodeScene(new VeraArrayValue([call('floor', 'surface'), call('loose', call('box', 'y', 0, 0.05, 0, 0.1, 0.1, 0.1, 'ink'), 1)]))
    sim.apply(S.diffWorld(null, a), a); const ix = sim.index.get('x')
    sim.apply(S.diffWorld(a, b), b)
    assert.equal(sim.index.get('x'), undefined); assert.equal(sim.idAt(sim.index.get('y')), 'y')
    assert.equal(sim.index.get('y'), ix, 'the freed index is reused'); assert.equal(sim.hasLoose(), true)
  }

  // The touch geometry: a point projects where the camera sees it, and a drag maps onto the floor.
  {
    const pose = new L.CameraPose(); pose.eye = [0, 2, 4]; pose.look = [0, 0, 0]
    const c = L.projectPoint(pose, 300, 200, [0, 0, 0])
    assert.ok(Math.abs(c[0] - 150) < 1e-9 && Math.abs(c[1] - 100) < 1e-9, 'the look point is the middle of the box')
    const right = L.projectPoint(pose, 300, 200, [1, 0, 0]); assert.ok(right[0] > 150 && Math.abs(right[1] - 100) < 1e-9, '+x is to the right')
    const up = L.projectPoint(pose, 300, 200, [0, 1, 0]); assert.ok(up[1] < 100, '+y is up on the screen')
    assert.equal(L.projectPoint(pose, 300, 200, [0, 3, 6]), null, 'behind the eye is not on screen')
    // The top edge of the view at the look point's depth: fov is vertical.
    const depth = Math.hypot(2, 4), half = depth * Math.tan(pose.fov / 2), b = L.cameraBasis(pose)
    const top = L.projectPoint(pose, 300, 200, b[2].map(v => v * half))
    assert.ok(Math.abs(top[1]) < 1e-6, 'fov is vertical: ' + top)
    assert.ok(Math.abs(L.metresPerVp(pose, 200, depth) * 200 - 2 * half) < 1e-9)
    const near = (a, b, msg) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9, msg + ': ' + a))
    near(L.floorDirection(pose, 0, -10), [0, 0, -1], 'a drag up the screen is away from the camera')
    near(L.floorDirection(pose, 10, 0), [1, 0, 0], 'a drag right is to the camera\'s right')
    near(L.floorDirection(pose, 0, 0), [0, 0, 0], 'no drag, no direction')
    const side = new L.CameraPose(); side.eye = [4, 1, 0]; side.look = [0, 0, 0]
    near(L.floorDirection(side, 0, -1), [-1, 0, 0], 'from the side, up the screen is towards -x')
  }
  // The look: a neutral floor is the page a little darker, a neutral table is felt, a table as white as its die is darkened.
  {
    const {resolveTheme} = loadVera('VeraTheme')
    const theme = resolveTheme('clean', '', false)
    const bg = L.lookRgba(theme, 'background'), floor = L.lookRgba(theme, L.floorColor(theme, 'surface'))
    for (let k = 0; k < 3; k++) assert.ok(floor[k] < bg[k] + 1e-9 && floor[k] > bg[k] * 0.9, 'the floor is the page, a little darker')
    assert.equal(L.floorColor(theme, '#336699'), '#336699', 'a floor colour of its own is kept')
    // The lit floor: base = target / gain in linear (clamped), so lit by the gain it comes out as the target; matte, shadow receiving.
    const lin = c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    assert.equal(L.FLOOR_LIGHT_GAIN, 4.5); assert.ok(L.FLOOR_LIGHT_GAIN_GLOW > L.FLOOR_LIGHT_GAIN)
    assert.equal(L.FLOOR_ROUGHNESS, 1); assert.equal(L.FLOOR_METALLIC, 0); assert.equal(L.FLOOR_SPECULAR, 0)
    assert.equal(L.floorGain(false), 4.5); assert.equal(L.floorGain(true), L.FLOOR_LIGHT_GAIN_GLOW)
    const base = L.floorBaseLinear(theme, 'surface', L.floorGain(false))
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(base[k] * L.FLOOR_LIGHT_GAIN - lin(floor[k])) < 1e-9, 'floor base is target / gain: ' + base)
    assert.deepEqual(L.floorBaseLinear(theme, '#ffffff', 1.0).slice(0, 3), [1, 1, 1], 'clamped to 1')
    assert.ok(L.floorBaseLinear(theme, '#ffffff', 0.5)[0] === 1, 'clamped at the top')
    L.setFloorGainOverride(2); assert.equal(L.floorGain(false), 2); assert.equal(L.floorGain(true), 2)
    L.setFloorGainOverride(0); assert.equal(L.floorGain(false), L.FLOOR_LIGHT_GAIN)
    assert.equal(L.linearHex(L.lookLinear(theme, '#c3c9d2')), '#c3c9d2', 'linearHex round trips')
    const src = require('fs').readFileSync(__dirname + '/../../entry/src/main/ets/components/VeraWorld3D.ets', 'utf8')
    assert.ok(/shadowReceiver = true/.test(src) && !/UNLIT_SHADOW_ALPHA/.test(src), 'the floor is one shadow-receiving lit material')
    assert.equal(L.tableColor, undefined, 'the table is the colour the program gives it: no felt, no darkening by the host')
    assert.equal(L.worldGlows(run('world-solar').spec), true); assert.equal(L.worldGlows(run('world-dice').spec), false)
  }
}

// ---- the catalogue and the prompt
assert.ok(catalogKinds().includes('world'))
const spec = CATALOG.find(c => c.name === 'World')
assert.deepEqual(spec.props.map(p => p.name + ':' + p.kind), ['style:string', 'height:number', 'build:string', 'event:string'])
assert.equal(spec.card, false, 'a World is not drawn on a home-screen card')
const prompt = describeCatalogForPrompt()
assert.ok(prompt.includes('ui.World(style, height, build, event)'), 'the World signature is in the prompt')
assert.ok(prompt.includes('World: default fill'))
for (const f of S.SCENE_FUNCTIONS) assert.ok(prompt.includes('  scene.' + f.name + '('), 'scene.' + f.name + ' is in the prompt')
assert.ok(prompt.includes('class scene.Event { kind: string; body: string; other: string; x: number; y: number; z: number; speed: number; bodies: string[]; values: number[] }'))
assert.ok(!prompt.includes('A die is not a Motion: build the solid with ui.Stage'), 'Motion no longer sends a die to Stage')
assert.ok(prompt.includes('ui.World with scene.die'))
assert.ok(describeComponents(['World']).includes('std/scene (always available as scene'), 'asking about World is asking about std/scene')
assert.ok(!describeComponents(['Surface']).includes('std/scene'), 'a Surface alone does not bring std/scene')
assert.ok(!describeCatalogForPrompt(new Set(['Column', 'Text'])).includes('std/scene'))

// ---- smoke: a world that breaks its contract is refused before it is served
const broken = codes(program('things.push(scene.box("a", 0, 1, 0, 1, 1, 1, "ink"));\n  things.push(scene.box("a", 2, 1, 0, 1, 1, 1, "ink"));'))
assert.deepEqual(broken, [], 'two bodies with one id compile (ids are computed at run time)')
const smoke = smokeRun(compileVeraSource(program('things.push(scene.box("a", 0, 1, 0, 1, 1, 1, "ink"));\n  things.push(scene.box("a", 2, 1, 0, 1, 1, 1, "ink"));')))
assert.ok(/stopped when the program starts/.test(smoke) && /two bodies have the id "a"/.test(smoke), 'smoke builds the world and stops on a duplicate id: ' + smoke)

// ---- the NAPI glue sizes writes into a Float32Array by FloatCapacity, never by napi_get_typedarray_info's length,
// which is in bytes on OpenHarmony: sized by it, drainContacts wrote past the ArkTS buffer and ArkUI crashed in layout.
{
  const glue = fs.readFileSync(path.join(__dirname, '../../entry/src/main/cpp/napi_phys.cpp'), 'utf8')
  const fa = glue.slice(glue.indexOf('float *FloatArray('), glue.indexOf('napi_value PhysInit'))
  assert.ok(/\*length = vphys::FloatCapacity\(jsLength, reported, bufferBytes, offset\)/.test(fa), 'FloatArray sizes by FloatCapacity')
  assert.ok(/napi_get_typedarray_info\(env, v, &type, &reported,/.test(fa), "the typed array's own length is only an upper bound")
  assert.ok(!/napi_get_typedarray_info\([^)]*\blength\b/.test(glue), 'no write is sized by the reported length')
}

// FakePhys's sleep cap as the native one's: each body's own, counting only time spent touching something.
{
  const P = loadVera('VeraPhysics')
  const fp = new P.FakePhys()
  fp.setGravity(-9.81)
  fp.setBound(-5, 99, 99)
  const floor = fp.addBox(50, 0.5, 50, P.PHYS_STATIC)
  fp.setPose(floor, 0, -0.5, 0, 0, 0, 0, 1)
  const a = fp.addBox(0.05, 0.05, 0.05, P.PHYS_DYNAMIC)
  fp.setPose(a, 0, 0.05, 0, 0, 0, 0, 1)
  fp.setVelocity(a, 0, 0, 0, 0, 0, 0)
  for (let k = 0; k < 600; k++) fp.step(1 / 60, 1)
  const b = fp.addBox(0.05, 0.05, 0.05, P.PHYS_DYNAMIC)
  fp.setPose(b, 2, 1, 0, 0, 0, 0, 1)
  for (let k = 0; k < 60; k++) fp.step(1 / 60, 1)
  const out = new Float32Array(7)
  fp.readPose(b, out)
  assert.ok(out[1] < 0.1, 'FakePhys: a body added 10 s after the last kick still falls: ' + out[1])
  // No gravity, nothing to touch: a thrown body drifts on past the cap.
  const space = new P.FakePhys()
  space.setGravity(0)
  space.setBound(-50, 50, 50)
  const d = space.addBox(0.05, 0.05, 0.05, P.PHYS_DYNAMIC)
  space.setPose(d, 0, 0, 0, 0, 0, 0, 1)
  space.setVelocity(d, 1, 0, 0, 0, 0, 0)
  for (let k = 0; k < 720; k++) space.step(1 / 60, 1)
  space.readPose(d, out)
  assert.ok(out[0] > 8 && space.awakeDynamic() === 1, 'FakePhys: free flight is not stopped by the sleep cap: ' + out[0])
}
// The ground made again (a table that goes, a new floor): bodies resting on the old one are woken to fall or settle on the
// new one, instead of hanging asleep where the old ground was. A body still moving is left as it goes.
{
  const P = loadVera('VeraPhysics')
  const fp = new P.FakePhys()
  const sim = new P.WorldSim(fp)
  const dice = [call('loose', call('die', 'd1', 0, 0.15, 0, 0.3, 'white'), 1)]
  const onTable = world([call('table', 1.2, 0.9, 'surface'), call('floor', 'surface'), ...dice])
  sim.apply(S.diffWorld(null, onTable), onTable)
  for (let k = 0; k < 120; k++) sim.step(1000 / 60, k / 60)
  const die = () => fp.bodies.find(b => b.alive && b.kind === P.PHYS_DYNAMIC)
  assert.equal(die().awake, false, 'the die rests asleep on the table')
  const noTable = world([call('floor', 'surface'), ...dice])
  sim.apply(S.diffWorld(onTable, noTable), noTable)
  assert.equal(die().awake, true, 'the table gone, the die resting on it is woken')
  for (let k = 0; k < 180; k++) sim.step(1000 / 60, 2 + k / 60)
  assert.equal(die().awake, false, 'and settles again on the floor')
}
// An apply given again after one that stopped half-way (the 3D side failed): bodies already made are made again, not twice.
{
  const P = loadVera('VeraPhysics')
  const fp = new P.FakePhys()
  const sim = new P.WorldSim(fp)
  const w1 = world([call('floor', 'surface')])
  const w2 = world([call('floor', 'surface'), call('loose', call('box', 'x', 0, 0.5, 0, 0.2, 0.2, 0.2, 'ink'), 1)])
  sim.apply(S.diffWorld(null, w1), w1)
  sim.apply(S.diffWorld(w1, w2), w2)
  sim.apply(S.diffWorld(w1, w2), w2)
  assert.equal(fp.bodies.filter(b => b.alive && b.kind === P.PHYS_DYNAMIC).length, 1, 'one body for x, not two')
}

console.log('world-check ok')
