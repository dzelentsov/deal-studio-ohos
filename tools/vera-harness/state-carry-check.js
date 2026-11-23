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

function externalGraphChecks() {
  const fs = require('node:fs'), path = require('node:path')
  const ts = require(process.env.VERA_TYPESCRIPT_PATH || 'typescript')
  const root = path.resolve(__dirname, '../../entry/src/main/ets')
  assert.equal(require('./source-loader').sourceRoot, root, 'external inventory: canonical source root')
  assert.equal(fs.realpathSync(root), root, 'external inventory: source root symlink')
  const sources = new Map()
  let bytes = 0, directories = 0
  const walk = dir => {
    assert(++directories <= 128, 'external inventory: directory bound')
    for (const entry of fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name)
      assert(!entry.isSymbolicLink(), 'external inventory: source symlink ' + file)
      if (entry.isDirectory()) walk(file)
      else if (/\.(ets|ts|tsx)$/.test(entry.name)) {
        const size = fs.statSync(file).size
        bytes += size
        assert(size <= 1024 * 1024 && bytes <= 16 * 1024 * 1024 && sources.size < 512,
          'external inventory: source size/file bound')
        sources.set(path.relative(root, file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8'))
      }
    }
  }
  walk(root)
  const interpreter = 'vera/VeraInterpreter.ets'
  const classes = ['RuntimeValue', 'VeraArrayValue', 'VeraObjectValue', 'Cell', 'FunctionValue', 'ExternalFunctionValue']
  const graphClasses = classes.slice(1)
  const ownership = {
    D: {meaning: 'No VM write: borrowed graph reads/decoding; freshness and borrowing are attributes, not safety classes',
      future: 'Allocation epoch on every new wrapper/storage/Cell/closure; journal only writes to pre-turn allocations',
      accesses: [
        ['VeraUi', 'UiHostEnvironment.queueSdk', 'asArray(args[1]).elements', 'pairs'],
        ['VeraUi', 'decodeNode', 'obj.fields', 'entries'],
        ['VeraUi', 'decodeNode', '(v as VeraArrayValue).elements', 'iteration', 5],
        ['VeraGfx', 'GfxShapeValue.constructor', 'freshObjectValue(GFX_SHAPE, new Map<string, RuntimeValue>()).fields', 'fresh backing'],
        ['VeraScene', 'SceneThingValue.constructor', 'freshObjectValue(SCENE_THING, new Map<string, RuntimeValue>()).fields', 'fresh backing'],
        ['VeraGfx', 'asNumbers', '(v as VeraArrayValue).elements', 'items'],
        ['VeraGfx', 'asStrings', '(v as VeraArrayValue).elements', 'iteration'],
        ['VeraGfx', 'shapesIn', '(value as VeraArrayValue).elements', 'iteration'],
        ['VeraScene', 'asNumbers', '(v as VeraArrayValue).elements', 'items'],
        ['VeraScene', 'asParts', '(v as VeraArrayValue).elements', 'items'],
        ['VeraScene', 'decodeScene', '(value as VeraArrayValue).elements', 'iteration'],
        ['VeraStateCarry', 'carryState', 'fresh.fields', 'forEach'],
        ['VeraStateCarry', 'carryState', 'old.fields', 'get'],
        ['VeraStateCarry', 'carryState', 'old.elements', 'length/every/index', 3],
        ['VeraStateCarry', 'carryState', 'fresh.elements', 'length/index', 2],
        ['VeraStateCarry', 'fitsShape', 'value.fields', 'size/has', 2],
        ['VeraSearchBenchmark', 'p2Ownership', 'original.fields', 'borrowed array lookup'],
        ['VeraSearchBenchmark', 'p2Ownership', 'fresh.fields', 'fresh array lookup'],
        ['VeraSearchBenchmark', 'p2Ownership', 'fresh.fields', 'distinct backing assertion'],
        ['VeraSearchBenchmark', 'p2Ownership', 'original.fields', 'distinct backing assertion'],
        ['VeraSearchBenchmark', 'p2Ownership', 'freshArray.elements', 'distinct backing assertion'],
        ['VeraSearchBenchmark', 'p2Ownership', 'originalArray.elements', 'distinct backing assertion'],
        ['VeraSearchBenchmark', 'p2Ownership', 'root.fields', 'borrowed map alias'],
        ['VeraSearchBenchmark', 'p2Ownership', 'values.elements', 'borrowed array alias'],
        ['VeraSearchBenchmark', 'p2Ownership', 'root.fields', 'execution identity assertion'],
        ['VeraSearchBenchmark', 'p2Ownership', 'values.elements', 'execution identity assertion'],
        ['VeraSearchBenchmark', 'p2Ownership', 'result.fields', 'result number lookup'],
        ['VeraSearchBenchmark', 'p2Ownership', 'result.fields', 'result array lookup'],
        ['VeraSearchBenchmark', 'p2Ownership', 'resultArray.elements', 'result identity assertion'],
        ['VeraSearchBenchmark', 'p2Ownership', 'result.fields', 'distinct alias backing assertion'],
        ['VeraSearchBenchmark', 'p2Ownership', 'result.fields', 'alias map size assertion'],
        ['VeraSearchBenchmark', 'p2Ownership', 'root.fields', 'rollback identity assertion'],
        ['VeraSearchBenchmark', 'p2Ownership', 'values.elements', 'rollback identity assertion'],
        ['VeraSearchBenchmark', 'p2Ownership', 'result.fields', 'rollback distinct alias backing assertion'],
        ['VeraSearchBenchmark', 'p2Ownership', 'result.fields', 'rollback alias map size assertion'],
        ['VeraSearchBenchmark', 'p2Ownership', 'result.fields', 'rollback result number assertion'],
        ['VeraSearchBenchmark', 'p2Ownership', 'result.fields', 'rollback result array assertion'],
        ['VeraSearchBenchmark', 'p2Ownership', 'values.elements', 'rollback shared backing assertion']
      ],
      readers: [
        ['VeraSearchBenchmark', 'p2Ownership', `function p2Ownership(runId: string, module: BytecodeModule, seed: string): boolean {
          let scopes: string[] = ['public-old-root-map-array-backing-n-first-tail-length-mutate-rollback',
            'public-fresh-root-distinct-map-shared-array-backing-n-first-tail-length-rollback',
            'public-pure-alias-before-pop-root-map-array-backing-n-first-tail-length',
            'public-accepted-fresh-root-no-clone-next-turn-map-array-backing-n-first-tail-length-mutate-rollback']
          let correct = true
          for (let i = 0; i < scopes.length; i++) {
            let pure = i === 2
            let alias = i === 1 || pure
            let crossTurn = i === 3
            let mode = pure ? 'journal-pure' : 'JOURNAL'
            let prepared: P2Prepared | null = null
            let record: P2LogRecord = { event: 'ownership', checkScope: scopes[i], workload: 0,
              mode: mode, outcome: 'failed', ownershipAliasCorrectnessChecked: 0 }
            try {
              let one = new VeraNumberValue(1)
              let work = new P2Work(0, 0, module, seed, [new P2Call(alias ? 'aliasMutate' : 'mutate', 5, one)], pure)
              prepared = new P2Prepared(work, mode)
              let setupCorrect = true
              if (crossTurn) {
                let original = prepared.root as VeraObjectValue
                let originalArray = original.fields.get('values') as VeraArrayValue
                prepared.scope = prepared.vm.beginTurn(prepared.tx, prepared.root)
                prepared.result = prepared.vm.execute('fresh', [prepared.root, one])
                let fresh = prepared.result as VeraObjectValue
                let freshArray = fresh.fields.get('values') as VeraArrayValue
                let counters = prepared.vm.safetyDiagnostics()
                setupCorrect = fresh !== original && fresh.fields !== original.fields && freshArray !== originalArray &&
                  freshArray.elements !== originalArray.elements && counters.journalReservations === 0 &&
                  counters.journalUndoRecords === 0 && prepared.host.hostReservations === 0
                p2Accept(prepared)
                prepared.root = prepared.result
                prepared.tx = new Object()
              }
              if (!(prepared.root instanceof VeraObjectValue)) { throw new Error('P2_OWNERSHIP') }
              let root = prepared.root
              let fields = root.fields
              let values = fields.get('values')
              let n = fields.get('n')
              if (!(values instanceof VeraArrayValue) || !(n instanceof VeraNumberValue)) { throw new Error('P2_OWNERSHIP') }
              let elements = values.elements
              let first = elements[0]
              let tail = elements[elements.length - 1]
              if (!(first instanceof VeraNumberValue) || !(tail instanceof VeraNumberValue)) { throw new Error('P2_OWNERSHIP') }
              let oldLength = crossTurn ? 2 : 2048
              let oldN = crossTurn ? 1 : 0
              let oldFirst = crossTurn ? 2 : 0
              let oldTail = crossTurn ? 0 : 2047
              setupCorrect = setupCorrect && fields.size === 2 && n.value === oldN && first.value === oldFirst &&
                tail.value === oldTail && elements.length === oldLength
              prepared.scope = prepared.vm.beginTurn(prepared.tx, root)
              let executionOutcome = 'ok'
              try {
                prepared.result = pure ? prepared.vm.executePure('aliasMutate', [root, one])
                  : prepared.vm.execute(alias ? 'aliasMutate' : 'mutate', [root, one])
              } catch (e) { executionOutcome = p2Code(e as Object) }
              record.executionOutcome = executionOutcome
              let counters = prepared.vm.safetyDiagnostics()
              record.journalReservations = counters.journalReservations
              record.journalUndoRecords = counters.journalUndoRecords
              record.hostReservations = prepared.host.hostReservations
              let expectedUndo = pure ? 0 : 3
              let reservationsExpected = counters.journalReservations === expectedUndo &&
                counters.journalUndoRecords === expectedUndo && prepared.host.hostReservations === 0
              record.reservationExpectationsMet = reservationsExpected ? 1 : 0
              let result = prepared.result
              let resultN: RuntimeValue = NULL_VALUE
              let executionCorrect = executionOutcome === (pure ? 'pure' : 'ok') && prepared.root === root &&
                root.fields === fields && fields.size === 2 && fields.get('values') === values && values.elements === elements
              if (pure) {
                executionCorrect = executionCorrect && fields.get('n') === n && n.value === oldN &&
                  elements.length === oldLength && elements[0] === first && first.value === oldFirst &&
                  elements[oldLength - 1] === tail && tail.value === oldTail
              } else {
                if (!(result instanceof VeraObjectValue)) { throw new Error('P2_OWNERSHIP') }
                resultN = result.fields.get('n') as RuntimeValue
                let resultArray = result.fields.get('values')
                executionCorrect = executionCorrect && resultN instanceof VeraNumberValue && resultN !== n &&
                  resultN.value === oldN + 1 && n.value === oldN && first.value === oldFirst && tail.value === oldTail &&
                  resultArray instanceof VeraArrayValue && resultArray === values && resultArray.elements === elements &&
                  elements[0] instanceof VeraNumberValue && (elements[0] as VeraNumberValue).value === oldFirst + 1 &&
                  elements[elements.length - 1] === one && one.value === 1
                if (alias) {
                  executionCorrect = executionCorrect && result !== root && result.fields !== fields && result.fields.size === 2 &&
                    fields.get('n') === n && n.value === oldN && elements.length === oldLength
                } else {
                  executionCorrect = executionCorrect && result === root && elements.length === oldLength + 1 &&
                    elements[oldLength - 1] === tail && tail.value === oldTail
                }
              }
              let rolledBack = p2Rollback(prepared)
              record.rollbackSucceeded = rolledBack ? 1 : 0
              let restored = prepared.root === root && root.fields === fields && fields.size === 2 && fields.get('n') === n &&
                n.value === oldN && fields.get('values') === values && values.elements === elements &&
                elements.length === oldLength && elements[0] === first && first.value === oldFirst &&
                elements[oldLength - 1] === tail && tail.value === oldTail
              record.rootRestored = restored ? 1 : 0
              let resultRestored = true
              if (alias && !pure) {
                resultRestored = result instanceof VeraObjectValue && result !== root && result.fields !== fields &&
                  result.fields.size === 2 && result.fields.get('n') === resultN && resultN instanceof VeraNumberValue &&
                  resultN.value === 1 && result.fields.get('values') === values && values.elements === elements
              }
              record.ownershipAliasCorrectnessChecked = 1
              if (setupCorrect && executionCorrect && rolledBack && restored && resultRestored && reservationsExpected) {
                record.outcome = 'ok'
              }
            } catch (e) { record.outcome = p2Code(e as Object) }
            finally {
              if (prepared !== null && prepared.scope !== null) {
                record.rollbackSucceeded = p2Rollback(prepared) ? 1 : 0
                if (prepared.scope !== null) {
                  try { prepared.scope.discard() } catch (_e) {}
                  prepared.scope = null
                }
                record.outcome = 'failed'
              }
            }
            if (record.outcome !== 'ok') { correct = false }
            p2Log(runId, record)
          }
          return correct
        }`, 'Read-only borrowed graph aliases and identity/value/size assertions; VM execution and settlement use existing APIs']
      ]},
    A: {meaning: 'Graph storage writes, including initialization; freshness is an allocation attribute, not class B',
      future: 'Constructors must register wrapper AND backing storage allocation before publishing; no borrowed storage exemption',
      constructors: [
        ['VeraArrayValue', 'constructor(e: RuntimeValue[])',
          'super(); if (!arrayBirths.has(e)) { arrayBirths.set(e, 0) } this.elements = e;'],
        ['VeraObjectValue', 'constructor(identity: string, fields: Map<string, RuntimeValue>)',
          'super(); this.classIdentity = identity; if (!objectBirths.has(fields)) { objectBirths.set(fields, 0) } this.fields = fields;'],
        ['FunctionValue', 'constructor(name: string, captures: Cell[])', 'super(); this.name = name; this.captures = captures;'],
        ['ExternalFunctionValue', 'constructor(mod: string, name: string)', 'super(); this.module = mod; this.funcName = name;']
      ],
      fresh: [
        ['VeraUi', 'viewNode', `function viewNode(type: string, fields: Array<[string, RuntimeValue]>): VeraObjectValue {
          let map = new Map<string, RuntimeValue>()
          map.set('type', new VeraStringValue(type))
          for (let pair of fields) { map.set(pair[0], pair[1]) }
          return freshObjectValue('std/ui:View', map)
        }`, 'Fresh map/wrapper; field values, including children arrays, are borrowed aliases, not deep copies'],
        ['VeraGfx', 'pointerValue', `export function pointerValue(phase: string, id: number, x: number, y: number): RuntimeValue {
          let fields = new Map<string, RuntimeValue>()
          fields.set('phase', new VeraStringValue(phase))
          fields.set('id', new VeraNumberValue(id))
          fields.set('x', new VeraNumberValue(x))
          fields.set('y', new VeraNumberValue(y))
          return freshObjectValue(GFX_POINTER, fields)
        }`, 'Fresh map/wrapper/scalars per event'],
        ['VeraScene', 'sceneEventValue', `export function sceneEventValue(kind: string, bodyId: string, other: string,
            x: number, y: number, z: number, speed: number, bodies: string[], values: number[]): RuntimeValue {
          let fields = new Map<string, RuntimeValue>()
          fields.set('kind', new VeraStringValue(kind))
          fields.set('body', new VeraStringValue(bodyId))
          fields.set('other', new VeraStringValue(other))
          fields.set('x', new VeraNumberValue(x))
          fields.set('y', new VeraNumberValue(y))
          fields.set('z', new VeraNumberValue(z))
          fields.set('speed', new VeraNumberValue(speed))
          let ids: RuntimeValue[] = []
          for (let b of bodies) { ids.push(new VeraStringValue(b)) }
          let nums: RuntimeValue[] = []
          for (let v of values) { nums.push(new VeraNumberValue(v)) }
          fields.set('bodies', freshArrayValue(ids))
          fields.set('values', freshArrayValue(nums))
          return freshObjectValue(SCENE_EVENT, fields)
        }`, 'Fresh map/wrapper/arrays/scalars; input primitive arrays are copied'],
        ['VeraStateCarry', 'carryState', `export function carryState(fresh: RuntimeValue, old: RuntimeValue,
            shapes: Map<string, string[]> | null = null): RuntimeValue {
          if (fresh instanceof VeraObjectValue && old instanceof VeraObjectValue) {
            let fields: Map<string, RuntimeValue> = new Map<string, RuntimeValue>()
            fresh.fields.forEach((value: RuntimeValue, name: string) => {
              let before = old.fields.get(name)
              fields.set(name, before === undefined ? value : carryState(value, before, shapes))
            })
            return freshObjectValue(fresh.classIdentity, fields)
          }
          if (fresh instanceof VeraArrayValue && old instanceof VeraArrayValue) {
            if (old.elements.length === 0) { return fresh }
            if (!old.elements.every((e: RuntimeValue): boolean => fitsShape(e, shapes))) { return fresh }
            if (fresh.elements.length === 0) { return old }
            return sameKind(fresh.elements[0], old.elements[0]) ? old : fresh
          }
          return sameKind(fresh, old) ? old : fresh
        }`, 'Fresh object maps/wrappers recursively; whole accepted old arrays and same-kind scalars alias; fallback fresh values alias'],
        ['VeraGfx', 'GfxShapeValue', `export class GfxShapeValue extends VeraObjectValue {
          op: GfxOp
          constructor(op: GfxOp) { super(GFX_SHAPE, freshObjectValue(GFX_SHAPE, new Map<string, RuntimeValue>()).fields); this.op = op }
        }`, 'Fresh empty map; host GfxOp payload is outside graph-slot coverage'],
        ['VeraScene', 'SceneThingValue', `export class SceneThingValue extends VeraObjectValue {
          thing: SceneThing
          constructor(thing: SceneThing) { super(SCENE_THING, freshObjectValue(SCENE_THING, new Map<string, RuntimeValue>()).fields); this.thing = thing }
        }`, 'Fresh empty map; host SceneThing payload is outside graph-slot coverage']
      ]},
    B: {meaning: 'VM slots, closure cells and authoritative retained state roots; destination lifetime determines tracking',
      destinations: ['cellBirths: Cell destination epoch, not assigned value age',
        'arrayBirths/objectBirths: backing destination epoch, not wrapper age',
        'turnBoundary/pureBoundary: independent mutating-turn and pure-call allocation boundaries'],
      globals: 'No global/module mutable slots: compiler bindings are function locals/captures; function/external caches are pinned by the Interpreter guard',
      constructors: [
        ['Cell', 'constructor(v: RuntimeValue)', 'cellBirths.set(this, nextAllocationSerial()); this.value = v;']
      ],
      roots: [
        ['runtime/AppActor.ets', 'AppActor', 'currentState', 'initialize/restoreState/seeded -> handler candidates -> persist/snapshot -> reconcileState -> dispose'],
        ['runtime/StateManager.ets', 'StateManager', 'working', 'initialState -> load -> beginTurn/setWorkingState -> commitTurn/rollbackTurn -> reload; close fences but retains root until manager collection'],
        ['runtime/StateManager.ets', 'ManagedStateTransaction', 'originalRoot', 'beginTurn retains alias until accept/rollback; no deep snapshot implied'],
        ['vera/VeraLiveWidget.ets', 'WidgetSession', 'state', 'saved decode/init -> restore/refresh/tap candidates -> encodedState; session lifetime'],
        ['vera/VeraWorldPlay.ets', 'WorldPlay', 'state', 'playWorld init -> constructor alias -> handle replacement; bounded play lifetime'],
        ['vera/VeraSurfacePlay.ets', 'playSurface', 'state', 'init -> local handler replacements; bounded play lifetime'],
        ['vera/VeraMovingPart.ets', 'appMovingPart', 'start', 'saved decode/init -> branch-local state aliases; bounded probe lifetime']
      ]},
    C: {meaning: 'Host deferred effects, registries and publication; authoritative state roots are B',
      publication: 'Turn acceptance publishes deferred host intents; failed turns discard them; production cutover remains inactive',
      gaps: [
        'Conservative AST/type-aware review inventory, not semantic proof or ArkTS typechecking',
        'Opaque platform/any/structural/reflection flows with no visible protected origin are not a whole-program alias analysis',
        'Ordered owner/site expressions retain duplicates; control contexts are pinned for retained-root files, not full control-flow/lifecycle semantics',
        'GfxOp/SceneThing host payloads and deferred effects are outside graph-slot ownership',
        'Retained array cycles are tested without serialization; mutually recursive object carry is not made cycle-safe',
        'Allocation/journal/pure mechanisms are opt-in tests only; production rollback/publication integration remains deferred'
      ]}
  }
  const printer = ts.createPrinter({removeComments: true, newLine: ts.NewLineKind.LineFeed})
  const parse = (name, text) => ts.createSourceFile(name, text, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS)
  const print = node => printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile())
  const tokens = text => {
    const scanner = ts.createScanner(ts.ScriptTarget.ES2020, true, ts.LanguageVariant.Standard, text)
    const out = []
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
      out.push([token, scanner.getTokenText()])
    }
    return JSON.stringify(out)
  }
  const canonical = text => tokens(print(parse('review.ts', text)))
  const reviewedArkUiBodies = [
    ['build', `{
      if (this.thumbnail) {
        Stack() { this.card() }
        .width(THUMB_SIDE).height(THUMB_SIDE).clip(true).hitTestBehavior(HitTestMode.Transparent)
      } else {
        Column({ space: 12 }) {
          this.card()
          Text(this.note())
            .fontSize(12).fontColor(this.error.length > 0 ? app.warningInk : app.inkMuted)
            .textAlign(TextAlign.Center).constraintSize({ maxWidth: 300 })
          Row({ space: 8 }) {
            ForEach([2, 3, 4], (d: number) => {
              Text(d === 2 ? '2×2' : d === 3 ? '2×4' : '4×4')
                .fontSize(12).padding({ left: 12, right: 12, top: 6, bottom: 6 }).borderRadius(14)
                .fontColor(this.dimension === d ? app.onPrimary : app.inkStrong)
                .backgroundColor(this.dimension === d ? app.primary : app.surface)
                .onClick(() => { this.dimension = d; this.restart() })
            }, (d: number) => d.toString())
          }
        }
        .width('100%').height('100%').justifyContent(FlexAlign.Center).backgroundColor(app.background)
      }
    }`],
    ['card', `{
      Stack() {
        if (this.coverNodes().length > 0) {
          CardView({
            nodes: this.coverNodes(), fill: true, dimension: this.dimension,
            frameKey: this.frame.token + this.dimension.toString() + this.seq.toString(),
            preset: this.frame.preset, primary: this.frame.primary,
            onTap: (action: string, value: number): void => { this.tap(action, value) },
            onPoint: (handler: string, x: number, y: number): void => { this.tapPicture(handler, x, y) }
          })
        }
        Column({ space: 6 }) {
          if (this.frame.live) {
            CardView({
              nodes: this.restNodes(), dimension: this.dimension,
              frameKey: this.frame.token + this.dimension.toString() + this.seq.toString(),
              preset: this.frame.preset, primary: this.frame.primary,
              onTap: (action: string, value: number): void => { this.tap(action, value) },
              onSwitch: (handler: string, on: boolean): void => { this.tapSwitch(handler, on) },
              onPoint: (handler: string, x: number, y: number): void => { this.tapPicture(handler, x, y) }
            })
          }
          if (this.coverNodes().length > 0) { OpenStrip() }
        }
        .width('100%').height('100%')
        .padding(this.coverNodes().length > 0 ? { left: CARD_PADDING, right: CARD_PADDING, top: CARD_PADDING, bottom: 0 } : CARD_PADDING)
        .justifyContent(this.coverNodes().length > 0 ? FlexAlign.End : FlexAlign.Center)
        .linearGradient({ angle: 180, colors: coverScrim(this.frame.background, this.overCover() ? this.frame.veil : 0) })
        .hitTestBehavior(this.coverNodes().length > 0 ? HitTestMode.Transparent : HitTestMode.Default)
      }
      .width(this.dimension === 2 ? CARD_SIDE : CARD_WIDE_WIDTH)
      .height(this.dimension === 2 ? CARD_SIDE : this.dimension === 3 ? CARD_WIDE_HEIGHT : CARD_BIG_HEIGHT)
      .backgroundColor(this.frame.background).borderRadius(20).clip(true)
      .shadow(this.thumbnail ? { radius: 0 } : { radius: 8, color: '#26000000', offsetY: 2 })
      .scale(this.thumbnail ? { x: THUMB_SIDE / CARD_SIDE, y: THUMB_SIDE / CARD_SIDE } : { x: 1, y: 1 })
      .hitTestBehavior(this.thumbnail ? HitTestMode.None : HitTestMode.Default)
    }`]
  ]
  const reviewSource = (name, text) => {
    if (name !== 'components/WidgetPreview.ets') return text
    const scanner = ts.createScanner(ts.ScriptTarget.ES2020, true, ts.LanguageVariant.Standard, text)
    const parts = []
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
      parts.push([scanner.getTokenText(), scanner.getTokenPos(), scanner.getTextPos()])
    }
    const headers = parts.filter((part, index) => part[0] === 'struct' &&
      parts[index - 1]?.[0] === 'export' && parts[index + 1]?.[0] === 'WidgetPreview' && parts[index + 2]?.[0] === '{')
    assert.equal(headers.length, 1, 'external inventory: reviewed ArkUI struct')
    const edits = [[headers[0][1], headers[0][2], 'class ']]
    for (const [name, body] of reviewedArkUiBodies) {
      const starts = parts.flatMap((part, index) => part[0] === name && parts[index + 1]?.[0] === '(' &&
        parts[index + 2]?.[0] === ')' && parts[index + 3]?.[0] === '{' ? [index + 3] : [])
      assert.equal(starts.length, 1, 'external inventory: reviewed ArkUI method ' + name)
      const start = starts[0]
      let end = start, depth = 1
      while (depth && ++end < parts.length) {
        if (parts[end][0] === '{') depth++
        if (parts[end][0] === '}') depth--
      }
      assert.equal(depth, 0, 'external inventory: reviewed ArkUI body ' + name)
      assert.equal(tokens(text.slice(parts[start][1], parts[end][2])), tokens(body),
        'external inventory: reviewed ArkUI body changed ' + name)
      edits.push([parts[start][2], parts[end][1], ' '.repeat(parts[end][1] - parts[start][2])])
    }
    for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) text = text.slice(0, start) + replacement + text.slice(end)
    return text
  }
  const signature = node => [
    ...(node.modifiers || []).map(print), node.name ? print(node.name) : 'constructor',
    ...(node.typeParameters || []).map(print), '(', ...node.parameters.map(print), ')', node.type ? print(node.type) : ''
  ].join(' ')
  const sorted = entries => entries.map(entry => JSON.stringify(entry)).sort()
  const syntaxCache = new Map(), libraryCache = new Map(), fileCache = new Map()
  let previousProgram
  const expectedAccesses = ownership.D.accesses.flatMap(([file, owner, expression, use, count = 1]) =>
    Array.from({length: count}, () => [file, owner, tokens(expression)]))
  assert.equal(expectedAccesses.length, 46)
  const inventory = input => {
    assert(input.size <= 512, 'external inventory: file bound')
    const virtual = name => path.join(root, name.replace(/\.ets$/, '.ts'))
    const dependencies = new Map()
    const trees = new Map([...input].map(([name, text]) => {
      assert(text.length <= 1024 * 1024, 'external inventory: source bound')
      let cached = syntaxCache.get(name)
      if (cached?.text !== text) {
        const tree = parse(virtual(name), reviewSource(name, text)), relative = new Set()
        const collect = node => {
          if (ts.isStringLiteral(node) && node.text.startsWith('.')) relative.add(node.text)
          ts.forEachChild(node, collect)
        }
        collect(tree)
        cached = {text, tree, relative: [...relative]}
        syntaxCache.set(name, cached)
      }
      dependencies.set(virtual(name), cached.relative)
      return [virtual(name), cached.tree]
    }))
    const options = {target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.Preserve, strict: true, noEmit: true, types: [], noResolve: true}
    const host = ts.createCompilerHost(options)
    const original = host.getSourceFile.bind(host), readFile = host.readFile.bind(host), exists = host.fileExists.bind(host)
    const library = name => path.dirname(name) === path.dirname(ts.getDefaultLibFilePath(options)) &&
      /^lib\..*\.d\.ts$/.test(path.basename(name))
    host.getSourceFile = (name, ...args) => {
      if (trees.has(name)) return trees.get(name)
      if (!library(name)) return undefined
      if (!libraryCache.has(name)) libraryCache.set(name, original(name, ...args))
      return libraryCache.get(name)
    }
    host.fileExists = name => trees.has(name) || (library(name) && exists(name))
    host.readFile = name => library(name) ? readFile(name) : undefined
    host.writeFile = () => { throw Error('external inventory: read only') }
    const candidates = (name, containing) => {
      if (!name.startsWith('.')) return []
      const base = path.resolve(path.dirname(containing), name.replace(/\.ets$/, '.ts'))
      return /\.(ts|tsx)$/.test(base) ? [base] : [base + '.ts', base + '.tsx', path.join(base, 'index.ts'), path.join(base, 'index.tsx')]
    }
    host.resolveModuleNames = (names, containing) => names.map(name => {
      const resolvedFileName = candidates(name, containing).find(file => trees.has(file))
      return resolvedFileName ? {resolvedFileName, extension: resolvedFileName.endsWith('.tsx') ? ts.Extension.Tsx : ts.Extension.Ts} : undefined
    })
    const program = ts.createProgram([...trees.keys()], options, host, previousProgram)
    previousProgram = program
    assert.deepEqual(program.getOptionsDiagnostics().map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [],
      'external inventory: TypeScript options')
    const checker = program.getTypeChecker()
    const vmTree = trees.get(virtual(interpreter))
    assert(vmTree && vmTree.parseDiagnostics.length === 0, 'external inventory: interpreter parse')
    const symbols = new Set(), runtimeSymbols = new Set()
    for (const name of classes) {
      const nodes = vmTree.statements.filter(n => ts.isClassDeclaration(n) && n.name?.text === name)
      assert.equal(nodes.length, 1, 'external inventory: class ' + name)
      const symbol = checker.getSymbolAtLocation(nodes[0].name)
      runtimeSymbols.add(symbol)
      if (graphClasses.includes(name)) symbols.add(symbol)
    }
    const sensitive = (type, tracked = symbols, seen = new Set(), depth = 0) => {
      if (!type || seen.has(type)) return false
      assert(depth < 32, 'external inventory: type depth')
      seen.add(type)
      if (tracked.has(type.symbol)) return true
      if (type.isUnionOrIntersection()) return type.types.some(t => sensitive(t, tracked, seen, depth + 1))
      if (type.flags & ts.TypeFlags.TypeParameter) return sensitive(checker.getBaseConstraintOfType(type), tracked, seen, depth + 1)
      if (type.flags & ts.TypeFlags.Object) {
        if (type.objectFlags & ts.ObjectFlags.Reference) {
          if (checker.getTypeArguments(type).some(t => sensitive(t, tracked, seen, depth + 1))) return true
        }
        if (type.objectFlags & ts.ObjectFlags.ClassOrInterface) {
          return (type.getBaseTypes() || []).some(t => sensitive(t, tracked, seen, depth + 1))
        }
      }
      return false
    }
    const storageOwners = new Set()
    for (const [file, owner] of ownership.B.roots) {
      const declaration = trees.get(virtual(file)).statements.find(node => ts.isClassDeclaration(node) && node.name?.text === owner)
      if (declaration) storageOwners.add(checker.getSymbolAtLocation(declaration.name))
    }
    const interfaceOwners = new Set()
    const interfaces = [...trees.values()].flatMap(tree => tree.statements.filter(ts.isInterfaceDeclaration))
    for (let pass = 0; pass <= interfaces.length; pass++) {
      let added = false
      for (const declaration of interfaces) {
        const symbol = checker.getSymbolAtLocation(declaration.name)
        if (interfaceOwners.has(symbol)) continue
        if (declaration.members.some(member => ts.isPropertySignature(member) &&
            (sensitive(checker.getTypeAtLocation(member), runtimeSymbols) ||
             sensitive(checker.getTypeAtLocation(member), interfaceOwners)))) {
          interfaceOwners.add(symbol)
          added = true
        }
      }
      if (!added) break
      assert(pass < interfaces.length, 'external inventory: interface origin bound')
    }
    const changed = new Set([...new Set([...sources.keys(), ...input.keys()])]
      .filter(file => sources.get(file) !== input.get(file)).map(virtual))
    let globalChange = false
    for (const file of changed) {
      const tree = trees.get(file)
      const name = path.relative(root, file).split(path.sep).join('/')
      const before = sources.has(name) ? parse(file, sources.get(name)) : undefined
      const augmented = node => ts.isModuleDeclaration(node) || ts.forEachChild(node, augmented)
      if (!tree || !ts.isExternalModule(tree) || (before && !ts.isExternalModule(before)) ||
          augmented(tree) || (before && augmented(before))) { globalChange = true; break }
    }
    if (globalChange) for (const file of trees.keys()) changed.add(file)
    for (let pass = 0; pass < trees.size; pass++) {
      let added = false
      for (const [file] of trees) {
        if (changed.has(file)) continue
        if (dependencies.get(file).some(name => candidates(name, file).some(candidate => changed.has(candidate)))) {
          changed.add(file)
          added = true
        }
      }
      if (!added) break
    }
    const accesses = [], imports = [], constructors = [], fresh = [], rootsFound = [], surfaces = new Map(), ownerOrigins = new Map()
    let visited = 0
    for (const [file] of input) {
      if (file === interpreter) continue
      const cached = fileCache.get(file)
      if (cached && !changed.has(virtual(file)) && cached.text === input.get(file)) {
        accesses.push(...cached.accesses)
        imports.push(...cached.imports)
        fresh.push(...cached.fresh)
        rootsFound.push(...cached.rootsFound)
        if (cached.entries.length) surfaces.set(file, cached.entries)
        if (cached.ownerEntries.length) ownerOrigins.set(file, cached.ownerEntries)
        continue
      }
      const starts = [accesses.length, imports.length, fresh.length, rootsFound.length]
      const tree = trees.get(virtual(file)), entries = [], roots = new Set(), ownerEntries = [], ownerRoots = new Set()
      const add = (node, owner, kind) => {
        const seen = kind === 'owner origin' ? ownerRoots : roots
        const sites = kind === 'owner origin' ? ownerEntries : entries
        let top = node
        while (top.parent && ts.isExpression(top.parent)) top = top.parent
        if (ts.isVariableDeclaration(top.parent) || ts.isPropertyDeclaration(top.parent) || ts.isBindingElement(top.parent)) top = top.parent
        for (let ancestor = top; ancestor; ancestor = ancestor.parent) if (seen.has(ancestor)) return
        seen.add(top)
        const context = []
        for (let parent = top.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
          if (ts.isIfStatement(parent)) context.push(['if', print(parent.expression),
             top.pos >= parent.expression.pos && top.end <= parent.expression.end ? 'condition' :
               top.pos >= parent.thenStatement.pos && top.end <= parent.thenStatement.end ? 'then' : 'else'])
          else if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) context.push(['loop', print(parent.initializer), print(parent.expression)])
          else if (ts.isWhileStatement(parent) || ts.isDoStatement(parent)) context.push(['loop', print(parent.expression)])
          else if (ts.isForStatement(parent)) context.push(['for', parent.condition ? print(parent.condition) : ''])
          else if (ts.isConditionalExpression(parent)) context.push(['conditional', print(parent.condition)])
          else if (ts.isCaseClause(parent)) context.push(['case', print(parent.expression)])
          else if (ts.isTryStatement(parent)) context.push(['try', top.pos >= parent.tryBlock.pos && top.end <= parent.tryBlock.end ?
            'body' : parent.catchClause && top.pos >= parent.catchClause.pos && top.end <= parent.catchClause.end ? 'catch' : 'finally'])
        }
        sites.push([owner, print(top), context])
      }
      const visit = (node, owner = '<module>') => {
        assert(++visited <= 1500000, 'external inventory: AST node bound')
        if (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node)) owner = node.name?.text || '<anonymous>'
        if (ts.isMethodDeclaration(node)) owner += '.' + print(node.name)
        if (ts.isConstructorDeclaration(node)) owner += '.constructor'
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
          const text = print(node)
          if (/VeraInterpreter/.test(text)) imports.push([file, tokens(text)])
          if (ts.isExportDeclaration(node) && node.moduleSpecifier && /VeraInterpreter/.test(text)) {
            assert.fail('external inventory: interpreter re-export requires review')
          }
        }
        for (const [module, name] of ownership.A.fresh) {
          if (file === 'vera/' + module + '.ets' && owner === name &&
              (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))) fresh.push([module, name, canonical(print(node))])
        }
        if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) ||
            ts.isMethodSignature(node) || ts.isFunctionTypeNode(node)) && node.parameters) {
          const sig = checker.getSignatureFromDeclaration(node)
          if (sig && (sensitive(checker.getReturnTypeOfSignature(sig), runtimeSymbols) ||
              node.parameters.some(p => sensitive(checker.getTypeAtLocation(p), runtimeSymbols)))) {
            entries.push([owner, 'signature', signature(node)])
          }
        }
        if ((ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)) && ts.isIdentifier(node.name)) {
          for (const [rootFile, rootOwner, name] of ownership.B.roots) {
            if (file === rootFile && owner === rootOwner && node.name.text === name) {
              assert(sensitive(checker.getTypeAtLocation(node), runtimeSymbols), 'external inventory: root type')
              rootsFound.push([file, owner, name])
            }
          }
        }
        if ((ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) &&
            sensitive(checker.getTypeAtLocation(node), runtimeSymbols)) {
          entries.push([owner, 'root', print(node)])
        }
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
          const type = checker.getTypeAtLocation(node.expression)
          const name = ts.isPropertyAccessExpression(node) ? node.name.text :
            ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : ''
          if ((name === 'elements' || name === 'fields') && sensitive(type)) {
            accesses.push([path.basename(file, '.ets'), owner, tokens(print(node))])
          }
          if (sensitive(type, storageOwners) || sensitive(type, interfaceOwners)) {
            assert(ts.isPropertyAccessExpression(node) || ts.isStringLiteral(node.argumentExpression),
              'external inventory: computed protected owner access in ' + file + ':' + owner)
            if (sensitive(type, interfaceOwners) || ownership.B.roots.some(([rootFile, rootOwner, rootName]) =>
                rootFile === file && (ts.isPropertyAccessExpression(node) ? node.name.text : node.argumentExpression.text) === rootName)) {
              add(node, owner, 'owner access')
            }
          }
          if (sensitive(type, runtimeSymbols)) add(node, owner, 'access')
        }
        if (ts.isExpression(node) && !ts.isTypeNode(node.parent) && !ts.isHeritageClause(node.parent) && node.parent?.name !== node &&
            !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
          const type = checker.getTypeAtLocation(node)
          if (node.kind === ts.SyntaxKind.ThisKeyword && sensitive(type, storageOwners)) {
            assert((ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) &&
              node.parent.expression === node, 'external inventory: retained root owner escape in ' + file + ':' + owner)
          }
          if (sensitive(type, interfaceOwners)) add(node, owner, 'interface origin')
           if (node.kind !== ts.SyntaxKind.ThisKeyword && sensitive(type, storageOwners)) {
             add(node, owner, 'owner origin')
             if (ts.isAsExpression(node.parent) || ts.isTypeAssertionExpression(node.parent) || ts.isBindingElement(node.parent)) {
               add(node, owner, 'owner assertion')
             }
           }
          if (sensitive(type, runtimeSymbols)) add(node, owner, 'read/escape')
        }
        ts.forEachChild(node, child => visit(child, owner))
      }
      visit(tree)
      if (entries.length || ownerEntries.length || imports.some(([name]) => name === file)) {
        assert.equal(tree.parseDiagnostics.length, 0, 'external inventory: protected consumer parse ' + file)
      }
      if (entries.length) surfaces.set(file, entries)
      if (ownerEntries.length) ownerOrigins.set(file, ownerEntries)
      if (input === sources) fileCache.set(file, {text: input.get(file), entries, ownerEntries,
        accesses: accesses.slice(starts[0]), imports: imports.slice(starts[1]),
        fresh: fresh.slice(starts[2]), rootsFound: rootsFound.slice(starts[3])})
    }
    for (const kind of ['A', 'B']) {
      for (const [name] of ownership[kind].constructors) {
        const cls = vmTree.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === name)
        const ctors = cls.members.filter(ts.isConstructorDeclaration)
        assert.equal(ctors.length, 1, 'external inventory: constructor ' + name)
        constructors.push([kind, name, canonical(print(ctors[0]))])
      }
    }
    return {accesses, imports, constructors, fresh, rootsFound, surfaces, ownerOrigins}
  }
  const reviewedImports = [
    ['runtime/AppActor.ets', "import { VirtualMachine, deserializeVbc2, RuntimeValue, VeraNumberValue, encodeRuntimeValue, decodeRuntimeValue } from '../vera/VeraInterpreter'"],
    ['runtime/InProcessHost.ets', "import { RuntimeValue, VeraNumberValue, VeraStringValue, VeraBooleanValue } from '../vera/VeraInterpreter'"],
    ['runtime/shared/StatePort.ets', "import type { RuntimeValue } from '../../vera/VeraInterpreter'"],
    ['runtime/StateFormat.ets', "import { RuntimeValue, encodeRuntimeValue, decodeRuntimeValue } from '../vera/VeraInterpreter'"],
    ['runtime/StateManager.ets', "import type { RuntimeValue } from '../vera/VeraInterpreter'"],
    ['vera/VeraBudget.ets', "import { BytecodeModule } from './VeraInterpreter'"],
    ['vera/VeraCompiler.ets', "import { Instruction, BytecodeFunction, BytecodeModule } from './VeraInterpreter'"],
    ['vera/VeraGfx.ets', "import { RuntimeValue, VeraNumberValue, VeraStringValue, VeraBooleanValue, VeraArrayValue, VeraObjectValue, RuntimeTrap, freshObjectValue } from './VeraInterpreter'"],
    ['vera/VeraLiveWidget.ets', "import { VirtualMachine, deserializeVbc2, encodeRuntimeValue, decodeRuntimeValue, RuntimeValue, VeraNumberValue, VeraStringValue, VeraBooleanValue } from './VeraInterpreter'"],
    ['vera/VeraMovingPart.ets', "import { VirtualMachine, deserializeVbc2, decodeRuntimeValue, RuntimeValue, VeraNumberValue } from './VeraInterpreter'"],
    ['vera/VeraScene.ets', "import { RuntimeValue, VeraNumberValue, VeraStringValue, VeraBooleanValue, VeraArrayValue, VeraObjectValue, RuntimeTrap, freshArrayValue, freshObjectValue } from './VeraInterpreter'"],
    ['vera/VeraSearchBenchmark.ets', "import { VirtualMachine, BytecodeModule, RuntimeValue, RuntimeTrap, VeraNumberValue, VeraStringValue, VeraBooleanValue, VeraObjectValue, VeraArrayValue, NULL_VALUE, VmSafetyTurnScope, VmHostSafetyScope, deserializeVbc2, encodeRuntimeValue, decodeRuntimeValue } from './VeraInterpreter'"],
    ['vera/VeraSmoke.ets', "import { VirtualMachine, deserializeVbc2, RuntimeValue, RuntimeTrap, VeraNumberValue, VeraStringValue, VeraBooleanValue } from './VeraInterpreter'"],
    ['vera/VeraSourceFind.ets', "import { VirtualMachine, deserializeVbc2, VeraStringValue } from './VeraInterpreter'"],
    ['vera/VeraStateCarry.ets', "import { RuntimeValue, VeraNumberValue, VeraStringValue, VeraBooleanValue, VeraArrayValue, VeraObjectValue, freshObjectValue } from './VeraInterpreter'"],
    ['vera/VeraSurfacePlay.ets', "import { VirtualMachine, deserializeVbc2, RuntimeValue, RuntimeTrap, VeraNumberValue } from './VeraInterpreter'"],
    ['vera/VeraUi.ets', "import { RuntimeValue, VeraNumberValue, VeraStringValue, VeraBooleanValue, VeraNullValue, VeraArrayValue, VeraObjectValue, freshArrayValue, freshObjectValue, NULL_VALUE, HostEnvironment, VmHostSafetyScope, RuntimeTrap, } from './VeraInterpreter'"],
    ['vera/VeraWidgetRefine.ets', "import { VirtualMachine, deserializeVbc2, decodeRuntimeValue } from './VeraInterpreter'"],
    ['vera/VeraWorldPlay.ets', "import { VirtualMachine, deserializeVbc2, RuntimeValue, RuntimeTrap, VeraNumberValue, BytecodeModule, encodeRuntimeValue } from './VeraInterpreter'"]
  ].map(([file, text]) => [file, canonical(text)])
  const reviewedSurfaces = new Map()
  let reviewedFile, reviewedOwner
  for (const line of String.raw`
runtime/AppActor.ets
@AppActorTurnCall
["root","readonly args: RuntimeValue[];"]
@AppActorTurnCallbacks
["signature","constructor ( call: AppActorTurnCall ) RuntimeValue"]
@AppActorTurnCoordinator.runTurn
["calls.length === 0",[["if","calls.length === 0","condition"]]]
["admitted = calls.map((call: AppActorTurnCall): AppActorTurnCall => {\n    return { entry: call.entry, args: call.args.slice(), useState: call.useState };\n})",[]]
["admitted",[["loop","let call","admitted"],["try","body"],["try","body"]]]
["args = call.useState ? [this.state.getWorkingState()].concat(call.args) : call.args",[["loop","let call","admitted"],["try","body"],["try","body"]]]
["value = this.vm.execute(call.entry, args)",[["loop","let call","admitted"],["try","body"],["try","body"]]]
["this.state.setWorkingState(tx, value)",[["loop","let call","admitted"],["try","body"],["try","body"]]]
@AppActorTurnCoordinator.publishOwned
["this.executePure(call)",[]]
@AppActorTurnCoordinator.pure
["signature","pure ( call: AppActorTurnCall ) RuntimeValue"]
["this.executePure(call)",[["try","body"]]]
@AppActorTurnCoordinator.executePure
["signature","private executePure ( call: AppActorTurnCall ) RuntimeValue"]
["root = this.state.getWorkingState()",[]]
["scope = this.vm.beginTurn(new Object(), root)",[]]
["result = this.vm.executePure(call.entry, call.useState ? [root].concat(call.args) : call.args)",[["try","body"]]]
["result",[["try","body"]]]
@AppActor
["root","private currentState: RuntimeValue | null = null;"]
@AppActor.ready
["!this.disposed && !this.cancelled && this.vm !== null && this.currentState !== null",[]]
@AppActor.initialize
["this.currentState = null",[]]
["this.currentState = this.restoreState()",[["try","body"]]]
["this.currentState === null",[["if","this.currentState === null","condition"],["try","body"]]]
["this.currentState = this.seeded(this.vm!.execute('init'))",[["if","this.currentState === null","then"],["try","body"]]]
@AppActor.reconcileState
["restored = this.restoreState()",[["if","changed","then"]]]
["restored !== null",[["if","restored !== null","condition"],["if","changed","then"]]]
["this.currentState = restored",[["if","restored !== null","then"],["if","changed","then"]]]
@AppActor.snapshot
["JSON.stringify(encodeRuntimeValue(this.currentState!))",[]]
@AppActor.saveNow
["encoded = JSON.stringify(encodeRuntimeValue(this.currentState!))",[["try","body"]]]
@AppActor.dispose
["this.currentState = null",[]]
@AppActor.view
["nodes = decodeVeraUi(this.vm!.execute('view', [this.currentState!]))",[]]
@AppActor.draw
["decodeGfx(this.vm!.execute(entry, [this.currentState!]))",[]]
@AppActor.buildScene
["decodeScene(this.vm!.execute(entry, [this.currentState!]))",[]]
@AppActor.dispatch
["signature","dispatch ( action: string payload: RuntimeValue persist: boolean = true kind: string = 'HANDLER' skipIfSame: boolean = false ) void"]
["before = this.currentState!",[["try","body"]]]
["beforeCode = skipIfSame ? this.stateCode(before) : ''",[["try","body"]]]
["this.currentState = this.vm!.execute(action, [before, payload])",[["try","body"]]]
["skipIfSame && this.stateCode(this.currentState!) === beforeCode",[["if","skipIfSame && this.stateCode(this.currentState!) === beforeCode","condition"],["try","body"]]]
@AppActor.runWidgetRefresh
["this.currentState = this.vm!.execute('widgetRefresh', [this.currentState!])",[["try","body"]]]
@AppActor.frameHandlers
["this.currentState = this.vm!.execute(action, [this.currentState!, new VeraNumberValue(elapsed)])",[["loop","let action","actions"],["try","body"]]]
@AppActor.move
["signature","move ( action: string payload: RuntimeValue ) void"]
["this.currentState = this.vm!.execute(action, [this.currentState!, payload])",[["try","body"]]]
@AppActor.stateCode
["signature","private stateCode ( state: RuntimeValue ) string"]
["JSON.stringify(encodeRuntimeValue(state))",[]]
@AppActor.seeded
["signature","private seeded ( fresh: RuntimeValue ) RuntimeValue"]
["fresh",[["if","this.seedState.length === 0 || this.mode === 'PREVIEW'","then"]]]
["carried = carryState(fresh, decodeRuntimeValue(JSON.parse(this.seedState) as Object), this.vm!.classShapes())",[["try","body"]]]
["this.vm!.execute('view', [carried])",[["try","body"]]]
["carried",[["try","body"]]]
["fresh",[["try","catch"]]]
@AppActor.restoreState
["signature","private restoreState ( ) RuntimeValue | null"]
["decodeRuntimeValue(JSON.parse(encoded) as Object)",[["try","body"]]]
runtime/InProcessHost.ets
@HostActor
["signature","dispatch ( action: string payload: RuntimeValue persist?: boolean kind?: string skipIfSame?: boolean ) void | Promise<void>"]
["signature","move ( action: string payload: RuntimeValue ) void | Promise<void>"]
@InProcessHost.payload
["signature","private payload ( payload: InputPayload ) RuntimeValue"]
["new VeraNumberValue(payload.num)",[["case","'NUMBER'"]]]
["new VeraStringValue(payload.str)",[["case","'STRING'"]]]
["new VeraBooleanValue(payload.bool)",[["case","'BOOLEAN'"]]]
["pointerValue(payload.phase, payload.id, payload.x, payload.y)",[["case","'POINTER'"]]]
["sceneEventValue(scene.kind, scene.body, scene.other, scene.x, scene.y, scene.z, scene.speed, scene.bodies, scene.values)",[["case","'SCENE'"]]]
["new VeraNumberValue(0)",[]]
@InProcessHost.runTurn
["actor.dispatch(entry.input!.action, this.payload(entry.input!.payload), entry.input!.persist, entry.input!.kind, entry.input!.skipIfSame || false)",[["case","'INPUT'"]]]
["actor.dispatch(entry.tick!.action, new VeraNumberValue(entry.tick!.elapsed), true, 'TICK')",[["case","'TICK'"]]]
["actor.dispatch(effect.handler, new VeraStringValue(entry.text), true, 'EFFECT_RESULT')",[["case","'EFFECT_RESULT'"]]]
["attempt<void>(() => chain(actor.move(entry.input!.action, this.payload(entry.input!.payload)), () => {\n    if (entry.inputSeq !== undefined) {\n        record.appliedSeq = Math.max(record.appliedSeq, entry.inputSeq!);\n    }\n    if (this.disposed || entry.input!.draws.length === 0) {\n        return;\n    }\n    return this.surfaceRender(record, entry.input!.draws, actor.viewDue(this.now()), this.now() - started);\n}), (error: Error): void => {\n    actor.clearEffects();\n    this.report(record, 'move', error.message);\n})",[["case","'MOVE'"]]]
runtime/shared/StatePort.ets
@StateRollbackGuard
["signature","beginTurn ( tx: StateTransaction root: RuntimeValue ) StateRollbackScope"]
@StatePort
["signature","getWorkingState ( ) RuntimeValue"]
["signature","setWorkingState ( tx: StateTransaction value: RuntimeValue ) void"]
runtime/StateFormat.ets
@DecodedStateFile
["root","value: RuntimeValue;"]
@encodeStateFile
["signature","export encodeStateFile ( meta: StateMetadata value: RuntimeValue ) string"]
["payload = canonicalPayload(encodeRuntimeValue(value))",[["try","body"]]]
@decodeStateFile
["decodeRuntimeValue(decoded.value)",[]]
runtime/StateManager.ets
@StateManagerOptions
["root","initialState: RuntimeValue;"]
@ManagedStateTransaction
["root","readonly originalRoot: RuntimeValue;"]
@ManagedStateTransaction.constructor
["signature","constructor ( id: number commitClass: CommitClass source: StateTurnSource root: RuntimeValue dirty: boolean ) "]
["this.originalRoot = root",[]]
@StateManager
["root","private working: RuntimeValue;"]
@StateManager.constructor
["typeof options.appId !== 'string' || options.appId.split('/').length !== 2 ||\n    options.appId.split('/').some((part: string) => part.length === 0 || part === '.' ||\n        part === '..' || /[\\u0000-\\u001f\\\\]/.test(part)) ||\n    typeof options.stamp !== 'string' || options.stamp.indexOf('\\u0000') >= 0 ||\n    !Number.isSafeInteger(options.stateMaxBytes) || options.stateMaxBytes <= 0 ||\n    options.stateMaxBytes >= 16 * 1024 * 1024 ||\n    ['PREVIEW', 'LIVE_EPHEMERAL', 'LIVE_PERSISTENT'].indexOf(options.mode) < 0 ||\n    (options.journalMode !== undefined && options.journalMode !== 'JOURNAL') ||\n    (options.vmGeneration !== undefined && !validCounter(options.vmGeneration))",[["if","typeof options.appId !== 'string' || options.appId.split('/').length !== 2 ||\n    options.appId.split('/').some((part: string) => part.length === 0 || part === '.' ||\n        part === '..' || /[\\u0000-\\u001f\\\\]/.test(part)) ||\n    typeof options.stamp !== 'string' || options.stamp.indexOf('\\u0000') >= 0 ||\n    !Number.isSafeInteger(options.stateMaxBytes) || options.stateMaxBytes <= 0 ||\n    options.stateMaxBytes >= 16 * 1024 * 1024 ||\n    ['PREVIEW', 'LIVE_EPHEMERAL', 'LIVE_PERSISTENT'].indexOf(options.mode) < 0 ||\n    (options.journalMode !== undefined && options.journalMode !== 'JOURNAL') ||\n    (options.vmGeneration !== undefined && !validCounter(options.vmGeneration))","condition"]]]
["this.safety = options.vmJournal !== false",[]]
["this.safety && (!options.rollbackGuard ||\n    options.rollbackGuard.coverage !== 'GRAPH_SLOTS_DEFERRED_INTENTS')",[["if","this.safety && (!options.rollbackGuard ||\n    options.rollbackGuard.coverage !== 'GRAPH_SLOTS_DEFERRED_INTENTS')","condition"]]]
["options.mode === 'LIVE_PERSISTENT' && !options.storage && !options.storageFactory",[["if","options.mode === 'LIVE_PERSISTENT' && !options.storage && !options.storageFactory","condition"]]]
["this.appId = options.appId",[]]
["this.stamp = options.stamp",[]]
["this.mode = options.mode",[]]
["this.stateMaxBytes = options.stateMaxBytes",[]]
["this.working = options.initialState",[]]
["this.generation = options.vmGeneration === undefined ? 0 : options.vmGeneration",[]]
["this.policy = options.policy === undefined ? new CommitPolicy() : options.policy",[]]
["this.guard = options.rollbackGuard",[]]
["this.factory = options.storageFactory",[]]
["this.lostRecoveryAuthority = options.lostRecoveryAuthority",[]]
["this.storage = options.storage === undefined ? null : options.storage",[]]
["clock = options.now",[]]
["this.sleeper = options.sleep === undefined ? (ms: number): Promise<void> => new Promise<void>((resolve: () => void) => { setTimeout(resolve, ms); }) : options.sleep",[]]
["this.diagnostic = options.diagnostic",[]]
@StateManager.encode
["text = encodeStateFile({\n    appId: this.appId, schemaVersion: 1, vmGeneration: this.generation,\n    revision: this.revision, stamp: this.stamp\n}, this.working)",[]]
@StateManager.decode
["signature","private decode ( encoded: string generation: number revision: number ) RuntimeValue"]
["decodeStateFile(assembleStateFile({\n    appId: this.appId, schemaVersion: 1, vmGeneration: generation,\n    revision: revision, stamp: this.stamp\n}, encoded), this.appId).value",[]]
@StateManager.installLoad
["root = this.working",[["try","body"]]]
["decoded = this.decode(result.encodedState, generation, revision)",[["if","result.kind === 'READY' && result.stamp === this.stamp","then"],["try","body"]]]
["root = decoded",[["if","!preserve","then"],["if","result.kind === 'READY' && result.stamp === this.stamp","then"],["try","body"]]]
["this.working = root",[["try","body"]]]
@StateManager.beginTurn
["tx = new ManagedStateTransaction(this.sequence, commitClass, source, this.working, this.dirty)",[]]
["tx.scope = (this.guard as StateRollbackGuard).beginTurn(tx, this.working)",[["if","this.safety","then"],["try","body"]]]
@StateManager.getWorkingState
["signature","getWorkingState ( ) RuntimeValue"]
["this.working",[]]
@StateManager.setWorkingState
["signature","setWorkingState ( tx: StateTransaction value: RuntimeValue ) void"]
["this.working !== value",[["if","this.working !== value","condition"]]]
["this.working = value",[]]
@StateManager.proveNoMutation
["turn.rootReplaced || this.working !== turn.originalRoot",[["if","turn.rootReplaced || this.working !== turn.originalRoot","condition"]]]
@StateManager.refuseTurn
["this.working = tx.originalRoot",[["if","this.safety","then"],["try","body"]]]
@StateManager.confirmCommit
["this.decode(loaded.encodedState, this.generation, result.revision)",[["try","body"],["try","catch"]]]
vera/VeraGfx.ets
@GfxShapeValue.constructor
["signature","constructor ( op: GfxOp ) "]
"super(GFX_SHAPE, freshObjectValue(GFX_SHAPE, new Map<string, RuntimeValue>()).fields)"
@asNum
["signature","asNum ( args: RuntimeValue[] i: number fallback: number = 0 ) number"]
"i >= args.length"
"v = args[i]"
"v instanceof VeraNumberValue"
"(v as VeraNumberValue).value"
@asStr
["signature","asStr ( args: RuntimeValue[] i: number fallback: string = '' ) string"]
"i >= args.length"
"v = args[i]"
"v instanceof VeraStringValue"
"(v as VeraStringValue).value"
@asBool
["signature","asBool ( args: RuntimeValue[] i: number fallback: boolean = false ) boolean"]
"i >= args.length"
"v = args[i]"
"v instanceof VeraBooleanValue"
"(v as VeraBooleanValue).value"
@asNumbers
["signature","asNumbers ( args: RuntimeValue[] i: number ) number[]"]
"i >= args.length"
"v = args[i]"
"!(v instanceof VeraArrayValue)"
"items = (v as VeraArrayValue).elements"
"items.length > MAX_GFX_POINTS"
"new RuntimeTrap('R0028', 'a polyline or polygon holds at most ' + (MAX_GFX_POINTS / 2).toString() +\n    ' points; got ' + Math.floor(items.length / 2).toString())"
"items"
"item instanceof VeraNumberValue"
"out.push((item as VeraNumberValue).value)"
@asStrings
["signature","asStrings ( args: RuntimeValue[] i: number ) string[]"]
"i >= args.length"
"v = args[i]"
"!(v instanceof VeraArrayValue)"
"(v as VeraArrayValue).elements"
"item instanceof VeraStringValue"
"out.push((item as VeraStringValue).value)"
@holding
["signature","holding ( o: GfxOp children: GfxOp[] ) RuntimeValue"]
"shape(o)"
@shapesIn
["signature","shapesIn ( value: RuntimeValue ) GfxOp[]"]
"!(value instanceof VeraArrayValue)"
"(value as VeraArrayValue).elements"
"item instanceof GfxShapeValue"
"out.push((item as GfxShapeValue).op)"
@shape
["signature","shape ( op: GfxOp ) RuntimeValue"]
"new GfxShapeValue(op)"
@invokeStdGfx
["signature","export invokeStdGfx ( name: string args: RuntimeValue[] ) RuntimeValue"]
"o = op(name, asStr(args, round ? 5 : 4))"
"o.x = asNum(args, 0)"
"o.y = asNum(args, 1)"
"o.w = asNum(args, 2)"
"o.h = asNum(args, 3)"
"o.r = round ? asNum(args, 4) : 0"
"shape(o)"
"o = op('circle', asStr(args, 3))"
"o.x = asNum(args, 0)"
"o.y = asNum(args, 1)"
"o.r = asNum(args, 2)"
"shape(o)"
"o = op('arc', asStr(args, 6))"
"o.x = asNum(args, 0)"
"o.y = asNum(args, 1)"
"o.r = asNum(args, 2)"
"o.start = asNum(args, 3)"
"o.sweep = asNum(args, 4)"
"o.lineWidth = asNum(args, 5)"
"shape(o)"
"o = op('sector', asStr(args, 5))"
"o.x = asNum(args, 0)"
"o.y = asNum(args, 1)"
"o.r = asNum(args, 2)"
"o.start = asNum(args, 3)"
"o.sweep = asNum(args, 4)"
"shape(o)"
"o = op('line', asStr(args, 5))"
"o.x = asNum(args, 0)"
"o.y = asNum(args, 1)"
"o.w = asNum(args, 2)"
"o.h = asNum(args, 3)"
"o.lineWidth = asNum(args, 4)"
"shape(o)"
"o = op('polyline', asStr(args, 2))"
"o.points = asNumbers(args, 0)"
"o.lineWidth = asNum(args, 1)"
"shape(o)"
"o = op('polygon', asStr(args, 1))"
"o.points = asNumbers(args, 0)"
"shape(o)"
"o = op('path', asStr(args, 1))"
"o.text = asStr(args, 0)"
"shape(o)"
"o = op('strokePath', asStr(args, 2))"
"o.text = asStr(args, 0)"
"o.lineWidth = asNum(args, 1)"
"shape(o)"
"o = op('text', asStr(args, 4))"
"o.x = asNum(args, 0)"
"o.y = asNum(args, 1)"
"o.size = asNum(args, 2)"
"align = asStr(args, 3)"
"o.text = asStr(args, 5)"
"o.bold = asBool(args, 6)"
"shape(o)"
"o.x = asNum(args, 0)"
"o.y = asNum(args, 1)"
"o.start = asNum(args, 2)"
"o.r = asNum(args, 3, 1)"
"o.size = Math.max(0, Math.min(1, asNum(args, 4, 1)))"
"holding(o, args.length > 5 ? shapesIn(args[5]) : [])"
"numbers.push(gradientNumber(asNum(args, i)))"
"colours = asStrings(args, n).map((c: string): string => c.replace(/[|:]/g, ''))"
"new VeraStringValue((name === 'linear' ? 'lin:' : 'rad:') + numbers.join(',') + ':' + colours.join('|'))"
"o.fx = asStr(args, 0)"
"o.sweep = asNum(args, 1)"
"o.x = asNum(args, 2)"
"o.y = asNum(args, 3)"
"holding(o, args.length > 4 ? shapesIn(args[4]) : [])"
"o.w = copies(asNum(args, 0))"
"o.h = copies(asNum(args, 1))"
"o.x = asNum(args, 2)"
"o.y = asNum(args, 3)"
"holding(o, args.length > 4 ? shapesIn(args[4]) : [])"
"direction = asStr(args, 0)"
"speed = asStr(args, 1)"
"holding(o, args.length > 2 ? shapesIn(args[2]) : [])"
"o = op('fx', asStr(args, 1))"
"o.lineWidth = Math.max(0, asNum(args, 0))"
"holding(o, args.length > 2 ? shapesIn(args[2]) : [])"
"o = op('fx', asStr(args, 3))"
"o.w = asNum(args, 0)"
"o.h = asNum(args, 1)"
"o.lineWidth = Math.max(0, asNum(args, 2))"
"holding(o, args.length > 4 ? shapesIn(args[4]) : [])"
"o.lineWidth = Math.max(0, asNum(args, 0))"
"holding(o, args.length > 1 ? shapesIn(args[1]) : [])"
"mode = asStr(args, 0)"
"holding(o, args.length > 1 ? shapesIn(args[1]) : [])"
"a = Math.max(0, Math.min(1, asNum(args, 3, 1)))"
"text = '#' + hex2(asNum(args, 0)) + hex2(asNum(args, 1)) + hex2(asNum(args, 2))"
"new VeraStringValue(a >= 1 ? text : text + hex2(a * 255))"
"dx = asNum(args, 2) - asNum(args, 0)"
"dy = asNum(args, 3) - asNum(args, 1)"
"new VeraNumberValue(Math.sqrt(dx * dx + dy * dy))"
"px = asNum(args, 0)"
"py = asNum(args, 1)"
"x = asNum(args, 2)"
"y = asNum(args, 3)"
"new VeraBooleanValue(px >= x && py >= y && px <= x + asNum(args, 4) && py <= y + asNum(args, 5))"
@pointerValue
["signature","export pointerValue ( phase: string id: number x: number y: number ) RuntimeValue"]
"fields = new Map<string, RuntimeValue>()"
"fields.set('phase', new VeraStringValue(phase))"
"fields.set('id', new VeraNumberValue(id))"
"fields.set('x', new VeraNumberValue(x))"
"fields.set('y', new VeraNumberValue(y))"
"freshObjectValue(GFX_POINTER, fields)"
@decodeGfx
["signature","export decodeGfx ( value: RuntimeValue ) GfxOp[]"]
"ops = shapesIn(value)"
vera/VeraLiveWidget.ets
@WidgetSession
["root","private state: RuntimeValue;"]
@WidgetSession.constructor
["this.state = saved.length > 0 ? decodeRuntimeValue(JSON.parse(saved) as Object) : this.vm.execute('init')",[]]
@WidgetSession.encodedState
["JSON.stringify(encodeRuntimeValue(this.state))",[]]
@WidgetSession.restoreTap
["this.state = decodeRuntimeValue(JSON.parse(encoded) as Object)",[]]
@WidgetSession.clockDrivers
["signature","private clockDrivers ( state: RuntimeValue ) ClockDriver[]"]
["view = this.vm.execute('view', [state])",[["try","body"]]]
["walk(decodeVeraUi(view))",[["try","body"]]]
@WidgetSession.settle
["current = this.state",[]]
["drivers = this.clockDrivers(current)",[]]
["last = JSON.stringify(encodeRuntimeValue(current))",[]]
["clocks.see(encodeRuntimeValue(current) as Object)",[]]
["drivers = this.clockDrivers(current)",[["if","step > 0 && step % SETTLE_REASK_STEPS === 0","then"],["for","step < SETTLE_MAX_STEPS && !rested && this.work < SETTLE_MAX_WORK"],["try","body"]]]
["current = this.vm.execute(driver.handler, [current, new VeraNumberValue(SETTLE_STEP_MS)])",[["if","driver.interval === 0","then"],["loop","let driver","drivers"],["for","step < SETTLE_MAX_STEPS && !rested && this.work < SETTLE_MAX_WORK"],["try","body"]]]
["current = this.vm.execute(driver.handler, [current, new VeraNumberValue(driver.interval)])",[["loop","due >= driver.interval"],["loop","let driver","drivers"],["for","step < SETTLE_MAX_STEPS && !rested && this.work < SETTLE_MAX_WORK"],["try","body"]]]
["tree = encodeRuntimeValue(current) as Object",[["for","step < SETTLE_MAX_STEPS && !rested && this.work < SETTLE_MAX_WORK"],["try","body"]]]
["this.state = current",[["if","rested","then"],["try","body"]]]
@WidgetSession.frame
["roots = decodeVeraUi(this.vm.execute('widget', this.hasSize ? [this.state, new VeraNumberValue(size.dimension)] : [this.state]))",[]]
["ops = decodeGfx(this.vm.execute(node.label, [this.state]))",[]]
@WidgetSession.refresh
["next = this.vm.execute('widgetRefresh', [this.state])",[["try","body"]]]
["this.state = next",[["try","body"]]]
@WidgetSession.answer
["next = this.vm.execute(handler, [this.state, new VeraStringValue(text)])",[["try","body"]]]
["this.state = next",[["try","body"]]]
@WidgetSession.tap
["next = this.vm.execute(action, [this.state, new VeraNumberValue(value)])",[["try","body"]]]
["this.state = next",[["try","body"]]]
@WidgetSession.tapSwitch
["next = this.vm.execute(handler, [this.state, new VeraBooleanValue(on)])",[["try","body"]]]
["this.state = next",[["try","body"]]]
@WidgetSession.tapSurface
["down = this.vm.execute(handler, [this.state, pointerValue('down', 0, x, y)])",[["try","body"]]]
["up = this.vm.execute(handler, [down, pointerValue('up', 0, x, y)])",[["try","body"]]]
["this.state = up",[["try","body"]]]
vera/VeraMovingPart.ets
@appMovingPart
["start: RuntimeValue = saved.length > 0 ? decodeRuntimeValue(JSON.parse(saved) as Object) : vm.execute('init')",[["try","body"]]]
["tree = decodeVeraUi(vm.execute('view', [start]))",[["try","body"]]]
["state = start",[["for","way < 2 + presses.length"],["loop","let picture","pictures"],["try","body"]]]
["state = vm.execute(picture.value, [vm.execute(picture.value, [state, pointerValue('down', 0, x, y)]), pointerValue('up', 0, x, y)])",[["if","way === 1","then"],["try","body"],["for","way < 2 + presses.length"],["loop","let picture","pictures"],["try","body"]]]
["state = vm.execute(press.action, [state, new VeraNumberValue(press.eventValue)])",[["if","way > 1","then"],["if","way === 1","else"],["try","body"],["for","way < 2 + presses.length"],["loop","let picture","pictures"],["try","body"]]]
["looks: GfxOp[][] = [decodeGfx(vm.execute(picture.label, [state]))]",[["try","body"],["for","way < 2 + presses.length"],["loop","let picture","pictures"],["try","body"]]]
["state = vm.execute(picture.action, [state, new VeraNumberValue(PART_STEP_MS)])",[["for","step <= PART_STEPS"],["try","body"],["for","way < 2 + presses.length"],["loop","let picture","pictures"],["try","body"]]]
["looks.push(decodeGfx(vm.execute(picture.label, [state])))",[["if","step % PART_EVERY === 0","then"],["for","step <= PART_STEPS"],["try","body"],["for","way < 2 + presses.length"],["loop","let picture","pictures"],["try","body"]]]
vera/VeraScene.ets
@SceneThingValue.constructor
["signature","constructor ( thing: SceneThing ) "]
"super(SCENE_THING, freshObjectValue(SCENE_THING, new Map<string, RuntimeValue>()).fields)"
@asNum
["signature","asNum ( args: RuntimeValue[] i: number what: string ) number"]
"i >= args.length"
"v = args[i]"
"v instanceof VeraNumberValue"
"finite((v as VeraNumberValue).value, what)"
@asStr
["signature","asStr ( args: RuntimeValue[] i: number ) string"]
"i >= args.length"
"v = args[i]"
"v instanceof VeraStringValue"
"(v as VeraStringValue).value"
@asBool
["signature","asBool ( args: RuntimeValue[] i: number ) boolean"]
"i >= args.length"
"v = args[i]"
"v instanceof VeraBooleanValue"
"(v as VeraBooleanValue).value"
@asNumbers
["signature","asNumbers ( args: RuntimeValue[] i: number what: string most: number ) number[]"]
"v = i < args.length ? args[i] : null"
"!(v instanceof VeraArrayValue)"
"items = (v as VeraArrayValue).elements"
"items.length > most"
"new RuntimeTrap('R0029', 'scene: ' + what + ' holds at most ' + most.toString() + ' numbers; got ' + items.length.toString())"
"items"
"!(item instanceof VeraNumberValue)"
"out.push(finite((item as VeraNumberValue).value, what))"
@asParts
["signature","asParts ( args: RuntimeValue[] i: number groupId: string ) SceneThing[]"]
"v = i < args.length ? args[i] : null"
"!(v instanceof VeraArrayValue)"
"items = (v as VeraArrayValue).elements"
"items.length < 1 || items.length > MAX_GROUP_PARTS"
"new RuntimeTrap('R0029', where + ' holds 1 to ' + MAX_GROUP_PARTS.toString() + ' parts; got ' + items.length.toString())"
"items"
"!(item instanceof SceneThingValue)"
"t = (item as SceneThingValue).thing"
@asId
["signature","asId ( args: RuntimeValue[] i: number fn: string ) string"]
"id = asStr(args, i)"
@asBody
["signature","asBody ( args: RuntimeValue[] fn: string ) SceneThing"]
"v = args.length > 0 ? args[0] : null"
"!(v instanceof SceneThingValue)"
"t = (v as SceneThingValue).thing"
@body
["signature","body ( kind: string args: RuntimeValue[] ) SceneThing"]
"t.id = asId(args, 0, kind)"
"t.x = asNum(args, 1, 'x')"
"t.y = asNum(args, 2, 'y')"
"t.z = asNum(args, 3, 'z')"
@wrap
["signature","wrap ( t: SceneThing ) RuntimeValue"]
"new SceneThingValue(t)"
@invokeStdScene
["signature","export invokeStdScene ( name: string args: RuntimeValue[] ) RuntimeValue"]
"t = body('box', args)"
"t.w = positive(asNum(args, 4, 'w'), 'w')"
"t.h = positive(asNum(args, 5, 'h'), 'h')"
"t.d = positive(asNum(args, 6, 'd'), 'd')"
"t.color = asStr(args, 7)"
"wrap(t)"
"t = body('sphere', args)"
"r = positive(asNum(args, 4, 'r'), 'r')"
"t.color = asStr(args, 5)"
"wrap(t)"
"t = body('cylinder', args)"
"r = positive(asNum(args, 4, 'r'), 'r')"
"t.h = positive(asNum(args, 5, 'h'), 'h')"
"t.color = asStr(args, 6)"
"wrap(t)"
"t = body('shape', args)"
"points = asNumbers(args, 4, 'points', 2 * MAX_SHAPE_POINTS)"
"t.color = asStr(args, 5)"
"wrap(t)"
"t = body('hull', args)"
"points = asNumbers(args, 4, 'points', 3 * MAX_SHAPE_POINTS)"
"t.color = asStr(args, 5)"
"wrap(t)"
"t = body('group', args)"
"t.parts = asParts(args, 4, t.id)"
"wrap(t)"
"t = body('die', args)"
"s = positive(asNum(args, 4, 'size'), 'size')"
"t.color = asStr(args, 5)"
"wrap(t)"
"t.w = positive(asNum(args, 0, 'width'), 'width')"
"t.d = positive(asNum(args, 1, 'depth'), 'depth')"
"t.color = asStr(args, 2)"
"wrap(t)"
"t.color = asStr(args, 0)"
"wrap(t)"
"t.color = asStr(args, 0)"
"t.stars = Math.round(Math.max(0, Math.min(MAX_SKY_STARS, asNum(args, 1, 'stars'))))"
"wrap(t)"
"t.x = asNum(args, 0, 'x')"
"t.y = asNum(args, 1, 'y')"
"t.z = asNum(args, 2, 'z')"
"t.lookX = asNum(args, 3, 'lookX')"
"t.lookY = asNum(args, 4, 'lookY')"
"t.lookZ = asNum(args, 5, 'lookZ')"
"t.orbitCamera = asBool(args, 6)"
"wrap(t)"
"t = asBody(args, 'loose')"
"t.mass = positive(asNum(args, 1, 'mass'), 'mass')"
"wrap(t)"
"t = asBody(args, 'kick')"
"k.trigger = asNum(args, 1, 'trigger')"
"k.vx = asNum(args, 2, 'vx')"
"k.vy = asNum(args, 3, 'vy')"
"k.vz = asNum(args, 4, 'vz')"
"k.spin = asNum(args, 5, 'spin')"
"wrap(t)"
"t = asBody(args, 'orbit')"
"o.centre = asStr(args, 1)"
"o.radius = asNum(args, 2, 'radius')"
"o.periodS = asNum(args, 3, 'periodS')"
"o.phaseDeg = asNum(args, 4, 'phaseDeg')"
"wrap(t)"
"t = asBody(args, 'spin')"
"t.spinPeriodS = asNum(args, 1, 'periodS')"
"wrap(t)"
"t = asBody(args, 'turn')"
"t.rx = asNum(args, 1, 'rx')"
"t.ry = asNum(args, 2, 'ry')"
"t.rz = asNum(args, 3, 'rz')"
"wrap(t)"
"t = asBody(args, 'thick')"
"h = asNum(args, 1, 'h')"
"wrap(t)"
"t = asBody(args, 'glow')"
"wrap(t)"
"t = asBody(args, 'paint')"
"pattern = asStr(args, 1)"
"t.color2 = asStr(args, 2)"
"wrap(t)"
"t = asBody(args, 'rings')"
"inner = positive(asNum(args, 1, 'inner'), 'inner')"
"outer = asNum(args, 2, 'outer')"
"t.ringColor = asStr(args, 3)"
"wrap(t)"
"t = asBody(args, 'mark')"
"c = asStr(args, 1)"
"wrap(t)"
"t = asBody(args, 'trail')"
"wrap(t)"
"t = asBody(args, 'bounce')"
"t.restitution = Math.max(0, Math.min(1, asNum(args, 1, 'restitution')))"
"t.friction = Math.max(0, Math.min(1, asNum(args, 2, 'friction')))"
"wrap(t)"
"t = asBody(args, 'path')"
"points = asNumbers(args, 1, 'points', 2 * MAX_PATH_POINTS)"
"speed = asNum(args, 2, 'speed')"
"route.loop = asBool(args, 3)"
"wrap(t)"
"t = asBody(args, 'wander')"
"roam.radius = positive(asNum(args, 1, 'radius'), 'radius')"
"roam.speed = asNum(args, 2, 'speed')"
"wrap(t)"
"t = asBody(args, 'player')"
"p.speed = positive(asNum(args, 1, 'speed'), 'speed')"
"p.action = asStr(args, 2)"
"wrap(t)"
"t = asBody(args, 'follow')"
"f.distance = positive(asNum(args, 1, 'distance'), 'distance')"
"f.height = asNum(args, 2, 'height')"
"wrap(t)"
"t.id = asId(args, 0, 'zone')"
"t.x = asNum(args, 1, 'x')"
"t.z = asNum(args, 2, 'z')"
"r = positive(asNum(args, 3, 'r'), 'r')"
"t.color = asStr(args, 4)"
"wrap(t)"
"t = asBody(args, 'swing')"
"w.deg = asNum(args, 1, 'deg')"
"w.periodS = positive(asNum(args, 2, 'periodS'), 'periodS')"
"w.phaseDeg = asNum(args, 3, 'phaseDeg')"
"wrap(t)"
@sceneEventValue
["signature","export sceneEventValue ( kind: string bodyId: string other: string x: number y: number z: number speed: number bodies: string[] values: number[] ) RuntimeValue"]
"fields = new Map<string, RuntimeValue>()"
"fields.set('kind', new VeraStringValue(kind))"
"fields.set('body', new VeraStringValue(bodyId))"
"fields.set('other', new VeraStringValue(other))"
"fields.set('x', new VeraNumberValue(x))"
"fields.set('y', new VeraNumberValue(y))"
"fields.set('z', new VeraNumberValue(z))"
"fields.set('speed', new VeraNumberValue(speed))"
"ids.push(new VeraStringValue(b))"
"nums.push(new VeraNumberValue(v))"
"fields.set('bodies', freshArrayValue(ids))"
"fields.set('values', freshArrayValue(nums))"
"freshObjectValue(SCENE_EVENT, fields)"
@decodeScene
["signature","export decodeScene ( value: RuntimeValue ) WorldSpec"]
"!(value instanceof VeraArrayValue)"
"(value as VeraArrayValue).elements"
"!(item instanceof SceneThingValue)"
"t = (item as SceneThingValue).thing"
vera/VeraSmoke.ets
@plainValue
["signature","plainValue ( kind: string ) RuntimeValue"]
"new VeraNumberValue(1)"
"pointerValue('down', 0, 12, 12)"
"sceneEventValue('tap', '', '', 0, 0, 0, 0, [], [])"
"new VeraBooleanValue(true)"
"new VeraStringValue('12')"
@drawSurfaces
["signature","drawSurfaces ( vm: VirtualMachine node: VeraUiNode state: RuntimeValue ) void"]
"decodeGfx(vm.execute(node.label, [state]))"
"decodeScene(vm.execute(node.label, [state]))"
"drawSurfaces(vm, child, state)"
@smokeRun
"state = vm.execute('init')"
"roots = decodeVeraUi(vm.execute('view', [state]))"
"drawSurfaces(vm, root, state)"
"verdict = vm.execute('expect', [state])"
"!(verdict instanceof VeraBooleanValue) || !verdict.value"
"before = state"
"state = vm.execute(name, [state, plainValue(compiled.handlers.get(name)!)])"
"state = before"
"decodeVeraUi(vm.execute('view', [state]))"
"drawSurfaces(vm, root, state)"
vera/VeraSourceFind.ets
@sourceShownError
"state = vm.execute('init')"
"state = vm.execute(handler, [state, new VeraStringValue(sample)])"
"screen = screenText(decodeVeraUi(vm.execute('view', [state])))"
vera/VeraStateCarry.ets
@carryState
["signature","export carryState ( fresh: RuntimeValue old: RuntimeValue shapes: Map<string, string[]> | null = null ) RuntimeValue"]
"fresh instanceof VeraObjectValue && old instanceof VeraObjectValue"
"fields: Map<string, RuntimeValue> = new Map<string, RuntimeValue>()"
"fresh.fields.forEach((value: RuntimeValue, name: string) => {\n    let before = old.fields.get(name);\n    fields.set(name, before === undefined ? value : carryState(value, before, shapes));\n})"
"freshObjectValue(fresh.classIdentity, fields)"
"fresh instanceof VeraArrayValue && old instanceof VeraArrayValue"
"old.elements.length === 0"
"fresh"
"!old.elements.every((e: RuntimeValue): boolean => fitsShape(e, shapes))"
"fresh"
"fresh.elements.length === 0"
"old"
"sameKind(fresh.elements[0], old.elements[0]) ? old : fresh"
"sameKind(fresh, old) ? old : fresh"
@fitsShape
["signature","fitsShape ( value: RuntimeValue shapes: Map<string, string[]> | null ) boolean"]
"!(value instanceof VeraObjectValue) || shapes === null"
"fields = shapes.get(value.classIdentity)"
"fields === undefined || fields.length !== value.fields.size"
"fields.every((name: string): boolean => value.fields.has(name))"
@sameKind
["signature","sameKind ( a: RuntimeValue b: RuntimeValue ) boolean"]
"a instanceof VeraNumberValue"
"b instanceof VeraNumberValue"
"a instanceof VeraStringValue"
"b instanceof VeraStringValue"
"a instanceof VeraBooleanValue"
"b instanceof VeraBooleanValue"
"a instanceof VeraArrayValue"
"b instanceof VeraArrayValue"
"a instanceof VeraObjectValue"
"b instanceof VeraObjectValue && a.classIdentity === b.classIdentity"
vera/VeraSurfacePlay.ets
@playSurface
["state = vm.execute('init')",[["try","body"]]]
["decodeVeraUi(vm.execute('view', [state]))",[["loop","let root","decodeVeraUi(vm.execute('view', [state]))"],["try","body"]]]
["vm.execute(name, [state, value])",[["try","body"]]]
["ops = decodeGfx(vm.execute(s.label, [state]))",[["try","body"]]]
["state = handle(s.value, pointerValue(t.phase, t.id, t.x * w, t.y * h))",[["loop","let t","touches"],["for","frame <= PLAY_FRAMES"],["try","body"]]]
["state = handle(s.action, new VeraNumberValue(PLAY_STEP_MS))",[["if","s.action.length > 0","then"],["for","frame <= PLAY_FRAMES"],["try","body"]]]
["drawn = decodeGfx(vm.execute(s.label, [state]))",[["for","frame <= PLAY_FRAMES"],["try","body"]]]
["decodeVeraUi(vm.execute('view', [state]))",[["loop","let root","decodeVeraUi(vm.execute('view', [state]))"],["if","pressButtons && s.action.length > 0 && !changed","then"],["try","body"]]]
["state = handle(b.action, new VeraNumberValue(b.eventValue))",[["loop","let b","buttons.slice(0, PRESSED_BUTTONS)"],["if","pressButtons && s.action.length > 0 && !changed","then"],["try","body"]]]
["before = fingerprint(decodeGfx(vm.execute(s.label, [state])))",[["loop","let b","buttons.slice(0, PRESSED_BUTTONS)"],["if","pressButtons && s.action.length > 0 && !changed","then"],["try","body"]]]
["state = handle(s.action, new VeraNumberValue(PLAY_STEP_MS))",[["for","more <= FRAMES_AFTER_PRESS && !changed"],["loop","let b","buttons.slice(0, PRESSED_BUTTONS)"],["if","pressButtons && s.action.length > 0 && !changed","then"],["try","body"]]]
["drawn = fingerprint(decodeGfx(vm.execute(s.label, [state])))",[["for","more <= FRAMES_AFTER_PRESS && !changed"],["loop","let b","buttons.slice(0, PRESSED_BUTTONS)"],["if","pressButtons && s.action.length > 0 && !changed","then"],["try","body"]]]
vera/VeraUi.ets
@asString
["signature","asString ( v: RuntimeValue ) string"]
"v instanceof VeraStringValue"
"(v as VeraStringValue).value"
@asNum
["signature","asNum ( v: RuntimeValue ) number"]
"v instanceof VeraNumberValue"
"(v as VeraNumberValue).value"
@asWhole
["signature","asWhole ( v: RuntimeValue ) number"]
"n = asNum(v)"
@asBool
["signature","asBool ( v: RuntimeValue ) boolean"]
"v instanceof VeraBooleanValue"
"(v as VeraBooleanValue).value"
@asArray
["signature","asArray ( v: RuntimeValue ) VeraArrayValue"]
"v instanceof VeraArrayValue"
"v as VeraArrayValue"
@argString
["signature","argString ( args: RuntimeValue[] i: number fallback: string = '' ) string"]
"i >= args.length"
"asString(args[i])"
@argNum
["signature","argNum ( args: RuntimeValue[] i: number fallback: number = 0 ) number"]
"i >= args.length"
"asNum(args[i])"
@argBool
["signature","argBool ( args: RuntimeValue[] i: number fallback: boolean = true ) boolean"]
"i >= args.length"
"asBool(args[i])"
@argArray
["signature","argArray ( args: RuntimeValue[] i: number ) VeraArrayValue"]
"i >= args.length"
"freshArrayValue([])"
"asArray(args[i])"
@viewNode
["signature","viewNode ( type: string fields: Array<[\n    string,\n    RuntimeValue\n]> ) VeraObjectValue"]
"map = new Map<string, RuntimeValue>()"
"map.set('type', new VeraStringValue(type))"
"fields"
"map.set(pair[0], pair[1])"
"freshObjectValue('std/ui:View', map)"
@containerNode
["signature","containerNode ( type: string args: RuntimeValue[] ) RuntimeValue"]
"viewNode(type, [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['children', argArray(args, 1)],\n])"
@invokeStdTime
["signature","invokeStdTime ( name: string args: RuntimeValue[] ) RuntimeValue"]
"new VeraNumberValue(now.getTime())"
"new VeraNumberValue(Math.floor(now.getTime() / 1000))"
"new VeraNumberValue(Math.floor((now.getTime() - now.getTimezoneOffset() * 60000) / 86400000))"
"new VeraNumberValue(((now.getHours() * 60 + now.getMinutes()) * 60 + now.getSeconds()) * 1000 +\n    now.getMilliseconds())"
"new VeraNumberValue(now.getHours())"
"new VeraNumberValue(now.getMinutes())"
"new VeraNumberValue(now.getDay())"
"new VeraNumberValue(now.getDate())"
"new VeraNumberValue(now.getMonth() + 1)"
"new VeraNumberValue(now.getFullYear())"
@asNumberArg
["signature","asNumberArg ( v: RuntimeValue ) number"]
"v instanceof VeraNumberValue"
"(v as VeraNumberValue).value"
@invokeStdMath
["signature","invokeStdMath ( name: string args: RuntimeValue[] ) RuntimeValue"]
"new VeraNumberValue(Math.PI)"
"new VeraNumberValue(Math.sqrt(asNumberArg(args[0])))"
"new VeraNumberValue(Math.sin(asNumberArg(args[0])))"
"new VeraNumberValue(Math.cos(asNumberArg(args[0])))"
"new VeraNumberValue(Math.atan2(asNumberArg(args[0]), asNumberArg(args[1])))"
"new VeraNumberValue(Math.pow(asNumberArg(args[0]), asNumberArg(args[1])))"
"new VeraNumberValue(Math.floor(asNumberArg(args[0])))"
"new VeraNumberValue(Math.round(asNumberArg(args[0])))"
"new VeraNumberValue(Math.ceil(asNumberArg(args[0])))"
"new VeraNumberValue(Math.abs(asNumberArg(args[0])))"
"new VeraNumberValue(Math.min(asNumberArg(args[0]), asNumberArg(args[1])))"
"new VeraNumberValue(Math.max(asNumberArg(args[0]), asNumberArg(args[1])))"
"x = asNum(args[0]) | 0"
"new VeraNumberValue(x | 0)"
"seed = asNum(args[0]) | 0"
"bound = Math.floor(asNum(args[1]))"
"new VeraNumberValue(Math.abs(seed) % bound)"
@invokeStdStrings
["signature","invokeStdStrings ( name: string args: RuntimeValue[] ) RuntimeValue"]
"new VeraNumberValue(scalars(asString(args[0])).length)"
"chars = scalars(asString(args[0]))"
"start = asWhole(args[1])"
"end = asWhole(args[2])"
"new VeraStringValue(chars.slice(start, end).join(''))"
"new VeraBooleanValue(asString(args[0]).indexOf(asString(args[1])) >= 0)"
"new VeraBooleanValue(asString(args[0]).startsWith(asString(args[1])))"
"new VeraBooleanValue(asString(args[0]).endsWith(asString(args[1])))"
"text = asString(args[0])"
"from = asString(args[1])"
"to = asString(args[2])"
"new VeraStringValue(text)"
"new VeraStringValue(out)"
"text = asString(args[0])"
"sep = asString(args[1])"
"parts.push(new VeraStringValue(ch))"
"freshArrayValue(parts)"
"parts.push(new VeraStringValue(text.substring(i)))"
"parts.push(new VeraStringValue(text.substring(i, hit)))"
"freshArrayValue(parts)"
"text = asString(args[0]).replace(/\\s/g, '')"
"new VeraNumberValue(asNum(args[1]))"
"new VeraNumberValue(parseFloat(text))"
"new VeraStringValue(asString(args[0]).toUpperCase())"
"new VeraStringValue(asString(args[0]).toLowerCase())"
"chars = scalars(asString(args[0]))"
"new VeraStringValue(chars.slice(start, end).join(''))"
@UiHostEnvironment.invoke
["signature","invoke ( module: string name: string args: RuntimeValue[] awaited: boolean ) RuntimeValue"]
"value = this.invokeValue(module, name, args, awaited)"
"value"
@UiHostEnvironment.invokeValue
["signature","private invokeValue ( module: string name: string args: RuntimeValue[] awaited: boolean ) RuntimeValue"]
"invokeStdTime(name, args)"
"invokeStdMath(name, args)"
"invokeStdStrings(name, args)"
"this.queueSdk(args)"
"invokeStdGfx(name, args)"
"invokeStdScene(name, args)"
"containerNode('column', args)"
"containerNode('row', args)"
"containerNode('card', args)"
"containerNode('scroll', args)"
"containerNode('canvas', args)"
"viewNode('transform', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['series', argArray(args, 1)],\n    ['numberValue', new VeraNumberValue(argNum(args, 2))],\n    ['minimum', new VeraNumberValue(argNum(args, 3))],\n    ['children', argArray(args, 4)],\n])"
"viewNode('column', [\n    ['style', new VeraStringValue('default')],\n    ['children', argArray(args, 3)],\n])"
"viewNode('layers', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['minimum', new VeraNumberValue(argNum(args, 1))],\n    ['maximum', new VeraNumberValue(argNum(args, 2))],\n    ['children', argArray(args, 3)],\n])"
"viewNode('motion', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['numberValue', new VeraNumberValue(argNum(args, 1))],\n    ['children', argArray(args, 2)],\n])"
"viewNode('text', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['text', new VeraStringValue(argString(args, 1))],\n])"
"viewNode('spacer', [\n    ['style', new VeraStringValue(argString(args, 0))],\n])"
"viewNode('image', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['src', new VeraStringValue(argString(args, 1))],\n    ['alt', new VeraStringValue(argString(args, 2))],\n])"
"viewNode('path', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['commands', new VeraStringValue(argString(args, 1))],\n    ['spinPeriodMs', new VeraNumberValue(argNum(args, 2))],\n    ['action', new VeraStringValue(argString(args, 3))],\n    ['value', new VeraNumberValue(argNum(args, 4))],\n])"
"viewNode('field', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['label', new VeraStringValue(argString(args, 1))],\n    ['value', new VeraStringValue(argString(args, 2))],\n    ['action', new VeraStringValue(argString(args, 3))],\n    ['keyboardType', new VeraStringValue(argString(args, 4))],\n    ['required', new VeraBooleanValue(argBool(args, 5, false))],\n    ['requiredMessage', new VeraStringValue(argString(args, 6))],\n    ['minLength', new VeraNumberValue(argNum(args, 7, 0))],\n    ['minLengthMessage', new VeraStringValue(argString(args, 8))],\n    ['maxLength', new VeraNumberValue(argNum(args, 9, -1))],\n    ['maxLengthMessage', new VeraStringValue(argString(args, 10))],\n    ['pattern', new VeraStringValue(argString(args, 11))],\n    ['patternMessage', new VeraStringValue(argString(args, 12))],\n    ['email', new VeraBooleanValue(argBool(args, 13, false))],\n    ['emailMessage', new VeraStringValue(argString(args, 14))],\n])"
"viewNode(name === 'Toggle' ? 'toggle' : 'checkbox', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['label', new VeraStringValue(argString(args, 1))],\n    ['checked', new VeraBooleanValue(argBool(args, 2))],\n    ['action', new VeraStringValue(argString(args, 3))],\n])"
"viewNode('slider', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['label', new VeraStringValue(argString(args, 1))],\n    ['value', new VeraNumberValue(argNum(args, 2))],\n    ['minimum', new VeraNumberValue(argNum(args, 3))],\n    ['maximum', new VeraNumberValue(argNum(args, 4))],\n    ['action', new VeraStringValue(argString(args, 5))],\n])"
"viewNode('select', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['label', new VeraStringValue(argString(args, 1))],\n    ['options', argArray(args, 2)],\n    ['value', new VeraNumberValue(argNum(args, 3))],\n    ['action', new VeraStringValue(argString(args, 4))],\n])"
"viewNode('tabs', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['options', argArray(args, 1)],\n    ['value', new VeraNumberValue(argNum(args, 2))],\n    ['action', new VeraStringValue(argString(args, 3))],\n    ['children', argArray(args, 4)],\n])"
"viewNode('grid', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['columns', new VeraNumberValue(argNum(args, 1))],\n    ['children', argArray(args, 2)],\n])"
"viewNode('listitem', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['text', new VeraStringValue(argString(args, 1))],\n    ['label', new VeraStringValue(argString(args, 2))],\n    ['value', new VeraStringValue(argString(args, 3))],\n    ['action', new VeraStringValue(argString(args, 4))],\n    ['eventValue', new VeraNumberValue(argNum(args, 5))],\n    ['enabled', new VeraBooleanValue(argBool(args, 6))],\n    ['icon', new VeraStringValue(argString(args, 7))],\n])"
"viewNode('surface', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['minimum', new VeraNumberValue(argNum(args, 1))],\n    ['maximum', new VeraNumberValue(argNum(args, 2))],\n    ['label', new VeraStringValue(argString(args, 3))],\n    ['action', new VeraStringValue(argString(args, 4))],\n    ['value', new VeraStringValue(argString(args, 5))],\n])"
"viewNode('world', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['minimum', new VeraNumberValue(argNum(args, 1))],\n    ['label', new VeraStringValue(argString(args, 2))],\n    ['action', new VeraStringValue(argString(args, 3))],\n])"
"viewNode('ticker', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['tickerId', new VeraStringValue(argString(args, 1))],\n    ['minimum', new VeraNumberValue(argNum(args, 2))],\n    ['checked', new VeraBooleanValue(argBool(args, 3))],\n    ['action', new VeraStringValue(argString(args, 4))],\n])"
"viewNode('divider', [\n    ['style', new VeraStringValue(argString(args, 0))],\n])"
"viewNode('backhandler', [\n    ['action', new VeraStringValue(argString(args, 0))],\n])"
"viewNode('progress', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['label', new VeraStringValue(argString(args, 1))],\n    ['value', new VeraNumberValue(argNum(args, 2))],\n    ['maximum', new VeraNumberValue(argNum(args, 3))],\n])"
"viewNode('progressring', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['label', new VeraStringValue(argString(args, 1))],\n    ['value', new VeraNumberValue(argNum(args, 2))],\n    ['maximum', new VeraNumberValue(argNum(args, 3))],\n    ['text', new VeraStringValue(argString(args, 4))],\n])"
"viewNode('button', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['text', new VeraStringValue(argString(args, 1))],\n    ['action', new VeraStringValue(argString(args, 2))],\n    ['value', new VeraNumberValue(argNum(args, 3))],\n    ['enabled', new VeraBooleanValue(argBool(args, 4))],\n])"
"viewNode('cell', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['text', new VeraStringValue(argString(args, 1))],\n    ['action', new VeraStringValue(argString(args, 2))],\n    ['value', new VeraNumberValue(argNum(args, 3))],\n    ['enabled', new VeraBooleanValue(argBool(args, 4))],\n])"
"viewNode('apptheme', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['value', new VeraStringValue(argString(args, 1))],\n    ['children', argArray(args, 2)],\n])"
"viewNode('hero', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['label', new VeraStringValue(argString(args, 1))],\n    ['text', new VeraStringValue(argString(args, 2))],\n    ['value', new VeraStringValue(argString(args, 3))],\n    ['children', argArray(args, 4)],\n])"
"viewNode('adaptivecolumns', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['minimum', new VeraNumberValue(argNum(args, 1))],\n    ['children', argArray(args, 2)],\n])"
"viewNode('header', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['text', new VeraStringValue(argString(args, 1))],\n    ['label', new VeraStringValue(argString(args, 2))],\n    ['value', new VeraStringValue(argString(args, 3))],\n    ['icon', new VeraStringValue(argString(args, 4))],\n])"
"viewNode('section', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['text', new VeraStringValue(argString(args, 1))],\n    ['label', new VeraStringValue(argString(args, 2))],\n    ['children', argArray(args, 3)],\n])"
"viewNode('sectionheader', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['text', new VeraStringValue(argString(args, 1))],\n    ['label', new VeraStringValue(argString(args, 2))],\n    ['value', new VeraStringValue(argString(args, 3))],\n])"
"viewNode('listgroup', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['text', new VeraStringValue(argString(args, 1))],\n    ['children', argArray(args, 2)],\n])"
"viewNode('banner', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['text', new VeraStringValue(argString(args, 1))],\n    ['label', new VeraStringValue(argString(args, 2))],\n    ['value', new VeraStringValue(argString(args, 3))],\n    ['action', new VeraStringValue(argString(args, 4))],\n    ['icon', new VeraStringValue(argString(args, 5))],\n])"
"viewNode('emptystate', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['text', new VeraStringValue(argString(args, 1))],\n    ['label', new VeraStringValue(argString(args, 2))],\n    ['value', new VeraStringValue(argString(args, 3))],\n    ['action', new VeraStringValue(argString(args, 4))],\n    ['icon', new VeraStringValue(argString(args, 5))],\n])"
"viewNode('stat', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['label', new VeraStringValue(argString(args, 1))],\n    ['text', new VeraStringValue(argString(args, 2))],\n    ['value', new VeraStringValue(argString(args, 3))],\n    ['icon', new VeraStringValue(argString(args, 4))],\n])"
"viewNode('tilegrid', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['children', argArray(args, 1)],\n])"
"viewNode('tile', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['columns', new VeraNumberValue(argNum(args, 1))],\n    ['label', new VeraStringValue(argString(args, 2))],\n    ['text', new VeraStringValue(argString(args, 3))],\n    ['value', new VeraStringValue(argString(args, 4))],\n    ['icon', new VeraStringValue(argString(args, 5))],\n])"
"viewNode('metricgroup', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['columns', new VeraNumberValue(argNum(args, 1))],\n    ['children', argArray(args, 2)],\n])"
"viewNode('numbertext', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['numberValue', new VeraNumberValue(argNum(args, 1))],\n    ['prefix', new VeraStringValue(argString(args, 2))],\n    ['suffix', new VeraStringValue(argString(args, 3))],\n    ['minimumDigits', new VeraNumberValue(argNum(args, 4))],\n    ['decimals', new VeraNumberValue(argNum(args, 5, -1))],\n])"
"viewNode('clocktext', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['numberValue', new VeraNumberValue(argNum(args, 1))],\n    ['prefix', new VeraStringValue(argString(args, 2))],\n    ['suffix', new VeraStringValue(argString(args, 3))],\n])"
"viewNode('numberstat', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['label', new VeraStringValue(argString(args, 1))],\n    ['numberValue', new VeraNumberValue(argNum(args, 2))],\n    ['prefix', new VeraStringValue(argString(args, 3))],\n    ['suffix', new VeraStringValue(argString(args, 4))],\n    ['minimumDigits', new VeraNumberValue(argNum(args, 5))],\n    ['value', new VeraStringValue(argString(args, 6))],\n    ['icon', new VeraStringValue(argString(args, 7))],\n    ['decimals', new VeraNumberValue(argNum(args, 8, -1))],\n])"
"viewNode('numberfield', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['label', new VeraStringValue(argString(args, 1))],\n    ['numberValue', new VeraNumberValue(argNum(args, 2))],\n    ['minimum', new VeraNumberValue(argNum(args, 3))],\n    ['maximum', new VeraNumberValue(argNum(args, 4))],\n    ['action', new VeraStringValue(argString(args, 5))],\n    ['step', new VeraNumberValue(argNum(args, 6, 1))],\n])"
"viewNode('timefield', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['label', new VeraStringValue(argString(args, 1))],\n    ['numberValue', new VeraNumberValue(argNum(args, 2))],\n    ['action', new VeraStringValue(argString(args, 3))],\n])"
"viewNode('datefield', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['label', new VeraStringValue(argString(args, 1))],\n    ['numberValue', new VeraNumberValue(argNum(args, 2))],\n    ['action', new VeraStringValue(argString(args, 3))],\n])"
"viewNode('numberlistitem', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['text', new VeraStringValue(argString(args, 1))],\n    ['label', new VeraStringValue(argString(args, 2))],\n    ['numberValue', new VeraNumberValue(argNum(args, 3))],\n    ['prefix', new VeraStringValue(argString(args, 4))],\n    ['suffix', new VeraStringValue(argString(args, 5))],\n    ['minimumDigits', new VeraNumberValue(argNum(args, 6))],\n    ['action', new VeraStringValue(argString(args, 7))],\n    ['eventValue', new VeraNumberValue(argNum(args, 8))],\n    ['enabled', new VeraBooleanValue(argBool(args, 9))],\n    ['icon', new VeraStringValue(argString(args, 10))],\n    ['decimals', new VeraNumberValue(argNum(args, 11, -1))],\n])"
"containerNode('actionbar', args)"
"viewNode('timeline', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['text', new VeraStringValue(argString(args, 1))],\n    ['children', argArray(args, 2)],\n])"
"viewNode('timelineitem', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['text', new VeraStringValue(argString(args, 1))],\n    ['label', new VeraStringValue(argString(args, 2))],\n    ['value', new VeraStringValue(argString(args, 3))],\n    ['action', new VeraStringValue(argString(args, 4))],\n    ['eventValue', new VeraNumberValue(argNum(args, 5))],\n    ['enabled', new VeraBooleanValue(argBool(args, 6))],\n    ['icon', new VeraStringValue(argString(args, 7))],\n])"
"viewNode('table', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['options', argArray(args, 1)],\n    ['columns', new VeraNumberValue(argNum(args, 2))],\n    ['children', argArray(args, 3)],\n])"
"viewNode('tablerow', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['options', argArray(args, 1)],\n])"
"viewNode('kvgroup', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['columns', new VeraNumberValue(argNum(args, 1))],\n    ['children', argArray(args, 2)],\n])"
"viewNode('kvitem', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['label', new VeraStringValue(argString(args, 1))],\n    ['text', new VeraStringValue(argString(args, 2))],\n    ['value', new VeraStringValue(argString(args, 3))],\n])"
"viewNode('icon', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['icon', new VeraStringValue(argString(args, 1))],\n])"
"viewNode('iconbutton', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['icon', new VeraStringValue(argString(args, 1))],\n    ['label', new VeraStringValue(argString(args, 2))],\n    ['action', new VeraStringValue(argString(args, 3))],\n    ['value', new VeraNumberValue(argNum(args, 4))],\n    ['enabled', new VeraBooleanValue(argBool(args, 5))],\n])"
"viewNode('badge', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['text', new VeraStringValue(argString(args, 1))],\n    ['icon', new VeraStringValue(argString(args, 2))],\n])"
"viewNode('timer', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['numberValue', new VeraNumberValue(argNum(args, 1))],\n    ['checked', new VeraBooleanValue(argBool(args, 2, false))],\n])"
"viewNode('skeleton', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['minimum', new VeraNumberValue(argNum(args, 1))],\n    ['maximum', new VeraNumberValue(argNum(args, 2))],\n    ['checked', new VeraBooleanValue(argBool(args, 3, false))],\n])"
"viewNode('spinner', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['label', new VeraStringValue(argString(args, 1))],\n])"
"viewNode('snackbar', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['text', new VeraStringValue(argString(args, 1))],\n    ['value', new VeraStringValue(argString(args, 2))],\n    ['action', new VeraStringValue(argString(args, 3))],\n])"
"viewNode('sparkline', [\n    ['style', new VeraStringValue(argString(args, 0))],\n    ['series', argArray(args, 1)],\n    ['maximum', new VeraNumberValue(argNum(args, 2))],\n    ['label', new VeraStringValue(argString(args, 3))],\n    ['bars', new VeraBooleanValue(argBool(args, 4, false))],\n    ['series2', argArray(args, 5)],\n    ['series2Style', new VeraStringValue(argString(args, 6))],\n    ['seriesLabel', new VeraStringValue(argString(args, 7))],\n    ['series2Label', new VeraStringValue(argString(args, 8))],\n    ['categories', argArray(args, 9)],\n    ['minimum', new VeraNumberValue(argNum(args, 10, 0))],\n])"
"asBool(args[0])"
"args[1]"
"viewNode('spacer', [['style', new VeraStringValue('none')]])"
"new VeraStringValue(formatVeraNumber(asNum(args[0]), -1, 1))"
"new VeraStringValue(formatVeraNumber(asNum(args[0]), asNum(args[1]), 1))"
"new VeraStringValue(formatVeraDuration(asNum(args[0])))"
"new VeraStringValue(formatVeraClock(asNum(args[0])))"
"new VeraStringValue(formatVeraDate(asNum(args[0])))"
"new VeraStringValue(asBool(args[0]) ? 'true' : 'false')"
@UiHostEnvironment.queueSdk
["signature","private queueSdk ( args: RuntimeValue[] ) RuntimeValue"]
"target = asString(args[0]).trim()"
"pairs = asArray(args[1]).elements"
"pairs.length % 2 !== 0"
"new RuntimeTrap('R0027', 'sdk.call parameters are name and value in pairs; got ' + pairs.length.toString() + ' items')"
"i + 1 < pairs.length"
"key = asString(pairs[i]).trim()"
"asString(pairs[i + 1])"
"values.set(key, asString(pairs[i + 1]))"
"mode = args.length > 3 ? asString(args[3]) : 'background'"
"handler = safety ? asString(args[2]) : ''"
"effect = new HostEffect(id, 'sdk', 'call', values, safety ? handler : asString(args[2]))"
"new VeraNumberValue(id)"
@decodeVeraUi
["signature","export decodeVeraUi ( value: RuntimeValue ) VeraUiNode[]"]
"value instanceof VeraObjectValue"
"[decodeNode(value as VeraObjectValue, 0)]"
@decodeNode
["signature","decodeNode ( obj: VeraObjectValue depth: number ) VeraUiNode"]
"obj.fields.entries()"
"key: string = entry[0]"
"v: RuntimeValue = entry[1]"
"v instanceof VeraStringValue"
"node.kind = (v as VeraStringValue).value"
"v instanceof VeraStringValue"
"node.style = (v as VeraStringValue).value"
"v instanceof VeraStringValue"
"node.text = (v as VeraStringValue).value"
"v instanceof VeraStringValue"
"node.source = (v as VeraStringValue).value"
"v instanceof VeraStringValue"
"node.alt = (v as VeraStringValue).value"
"v instanceof VeraStringValue"
"node.action = (v as VeraStringValue).value"
"v instanceof VeraStringValue"
"node.label = (v as VeraStringValue).value"
"v instanceof VeraStringValue"
"node.tickerId = (v as VeraStringValue).value"
"v instanceof VeraStringValue"
"node.commands = (v as VeraStringValue).value"
"v instanceof VeraStringValue"
"node.prefix = (v as VeraStringValue).value"
"v instanceof VeraStringValue"
"node.icon = (v as VeraStringValue).value"
"v instanceof VeraStringValue"
"node.suffix = (v as VeraStringValue).value"
"v instanceof VeraNumberValue"
"node.eventValue = (v as VeraNumberValue).value"
"v instanceof VeraStringValue"
"node.value = (v as VeraStringValue).value"
"v instanceof VeraNumberValue"
"node.eventValue = (v as VeraNumberValue).value"
"v instanceof VeraNumberValue"
"node.numberValue = (v as VeraNumberValue).value"
"v instanceof VeraNumberValue"
"node.minimumDigits = (v as VeraNumberValue).value"
"v instanceof VeraNumberValue"
"node.decimals = (v as VeraNumberValue).value"
"v instanceof VeraNumberValue"
"node.step = (v as VeraNumberValue).value"
"v instanceof VeraNumberValue"
"node.spinPeriodMs = (v as VeraNumberValue).value"
"v instanceof VeraNumberValue"
"node.columns = (v as VeraNumberValue).value"
"v instanceof VeraNumberValue"
"node.minimum = (v as VeraNumberValue).value"
"v instanceof VeraNumberValue"
"node.maximum = (v as VeraNumberValue).value"
"v instanceof VeraBooleanValue"
"node.checked = (v as VeraBooleanValue).value"
"v instanceof VeraBooleanValue"
"node.enabled = (v as VeraBooleanValue).value"
"v instanceof VeraBooleanValue"
"node.bars = (v as VeraBooleanValue).value"
"v instanceof VeraArrayValue"
"(v as VeraArrayValue).elements"
"o instanceof VeraStringValue"
"opts.push((o as VeraStringValue).value)"
"v instanceof VeraArrayValue"
"(v as VeraArrayValue).elements"
"n instanceof VeraNumberValue"
"nums.push((n as VeraNumberValue).value)"
"v instanceof VeraArrayValue"
"(v as VeraArrayValue).elements"
"n instanceof VeraNumberValue"
"nums2.push((n as VeraNumberValue).value)"
"v instanceof VeraStringValue"
"node.series2Style = (v as VeraStringValue).value"
"v instanceof VeraStringValue"
"node.seriesLabel = (v as VeraStringValue).value"
"v instanceof VeraStringValue"
"node.series2Label = (v as VeraStringValue).value"
"v instanceof VeraArrayValue"
"(v as VeraArrayValue).elements"
"c instanceof VeraStringValue"
"cats.push((c as VeraStringValue).value)"
"v instanceof VeraStringValue"
"node.keyboardType = (v as VeraStringValue).value"
"v instanceof VeraBooleanValue"
"node.required = (v as VeraBooleanValue).value"
"v instanceof VeraStringValue"
"node.requiredMessage = (v as VeraStringValue).value"
"v instanceof VeraNumberValue"
"node.minLength = (v as VeraNumberValue).value"
"v instanceof VeraStringValue"
"node.minLengthMessage = (v as VeraStringValue).value"
"v instanceof VeraNumberValue"
"node.maxLength = (v as VeraNumberValue).value"
"v instanceof VeraStringValue"
"node.maxLengthMessage = (v as VeraStringValue).value"
"v instanceof VeraStringValue"
"node.pattern = (v as VeraStringValue).value"
"v instanceof VeraStringValue"
"node.patternMessage = (v as VeraStringValue).value"
"v instanceof VeraBooleanValue"
"node.email = (v as VeraBooleanValue).value"
"v instanceof VeraStringValue"
"node.emailMessage = (v as VeraStringValue).value"
"v instanceof VeraArrayValue"
"(v as VeraArrayValue).elements"
"child instanceof VeraObjectValue"
"node.children.push(decodeNode(child as VeraObjectValue, depth + 1))"
vera/VeraSearchBenchmark.ets
@P2Host.invoke
["signature","invoke ( module: string name: string args: RuntimeValue[] awaited: boolean ) RuntimeValue"]
"NULL_VALUE"
"new VeraNumberValue(1700000000000)"
"new VeraNumberValue(1700000000)"
"new VeraNumberValue(19675)"
"new VeraNumberValue(43200000)"
"new VeraNumberValue(12)"
"new VeraNumberValue(0)"
"new VeraNumberValue(2)"
"new VeraNumberValue(14)"
"new VeraNumberValue(11)"
"new VeraNumberValue(2023)"
"super.invoke(module, name, args, awaited)"
@P2Call
["root","input: RuntimeValue | null;"]
@P2Call.constructor
["signature","constructor ( entry: string kind: number input: RuntimeValue | null = null ) "]
"this.input = input"
@P2Prepared
["root","root: RuntimeValue;"]
["root","result: RuntimeValue = NULL_VALUE;"]
"result: RuntimeValue = NULL_VALUE;"
["root","args: RuntimeValue[][] = [];"]
@P2Prepared.constructor
"this.root = work.seed.length === 0 ? NULL_VALUE : decodeRuntimeValue(JSON.parse(work.seed) as Object)"
"args: RuntimeValue[] = call.kind === 0 ? [] : [this.root]"
"call.input !== null"
"args.push(decodeRuntimeValue(encodeRuntimeValue(call.input)))"
"this.args.push(args)"
@p2Execute
"prepared.scope = prepared.vm.beginTurn(prepared.tx, prepared.root)"
"state = prepared.root"
"prepared.args[i][0] = state"
"prepared.result = mode === 'journal-pure' && work.pure\n    ? prepared.vm.executePure(call.entry, prepared.args[i]) : prepared.vm.execute(call.entry, prepared.args[i])"
"state = prepared.result"
@p2Fingerprint
"JSON.stringify([encodeRuntimeValue(prepared.root), encodeRuntimeValue(prepared.result), effects])"
@p2Validate
"work.pure && JSON.stringify(encodeRuntimeValue(prepared.root)) !== work.seed"
"decodeVeraUi(prepared.result).length === 0"
"decodeGfx(prepared.result)"
"decodeScene(prepared.result)"
@p2Diagnostics
"rootBefore = JSON.stringify(encodeRuntimeValue(prepared.root))"
"unchanged = rootBefore === JSON.stringify(encodeRuntimeValue(prepared.root))"
@p2ReturnedState
["signature","p2ReturnedState ( work: P2Work value: RuntimeValue record: P2LogRecord ) boolean"]
"payload = canonicalPayload(encodeRuntimeValue(value))"
"decoded = decodeRuntimeValue(JSON.parse(payload) as Object)"
"record.stateRoundTripEqual = canonicalPayload(encodeRuntimeValue(decoded)) === payload ? 1 : 0"
"before = JSON.stringify(encodeRuntimeValue(value))"
"scope = vm.beginTurn(new Object(), value)"
"roots = decodeVeraUi(vm.executePure('view', [value]))"
"before !== JSON.stringify(encodeRuntimeValue(value)) || host.pendingEffects.length !== 0"
@p2Transitions
"prepared.scope = prepared.vm.beginTurn(prepared.tx, prepared.root)"
"state = prepared.root"
"prepared.args[i][0] = state"
"input = state"
"inputBefore = call.kind === 5 ? JSON.stringify(encodeRuntimeValue(input)) : ''"
"prepared.result = mode === 'journal-pure' && work.pure\n    ? prepared.vm.executePure(call.entry, prepared.args[i]) : prepared.vm.execute(call.entry, prepared.args[i])"
"inputAfter = JSON.stringify(encodeRuntimeValue(input))"
"result = JSON.stringify(encodeRuntimeValue(prepared.result))"
"prepared.result === input ? 1 : 0"
"!p2ReturnedState(work, prepared.result, record)"
"state = prepared.result"
@p2Ownership
"one = new VeraNumberValue(1)"
"work = new P2Work(0, 0, module, seed, [new P2Call(alias ? 'aliasMutate' : 'mutate', 5, one)], pure)"
"original = prepared.root as VeraObjectValue"
"originalArray = original.fields.get('values') as VeraArrayValue"
"prepared.scope = prepared.vm.beginTurn(prepared.tx, prepared.root)"
"prepared.result = prepared.vm.execute('fresh', [prepared.root, one])"
"fresh = prepared.result as VeraObjectValue"
"freshArray = fresh.fields.get('values') as VeraArrayValue"
"setupCorrect = fresh !== original && fresh.fields !== original.fields && freshArray !== originalArray &&\n    freshArray.elements !== originalArray.elements && counters.journalReservations === 0 &&\n    counters.journalUndoRecords === 0 && prepared.host.hostReservations === 0"
"prepared.root = prepared.result"
"!(prepared.root instanceof VeraObjectValue)"
"root = prepared.root"
"fields = root.fields"
"values = fields.get('values')"
"n = fields.get('n')"
"!(values instanceof VeraArrayValue) || !(n instanceof VeraNumberValue)"
"elements = values.elements"
"first = elements[0]"
"tail = elements[elements.length - 1]"
"!(first instanceof VeraNumberValue) || !(tail instanceof VeraNumberValue)"
"setupCorrect = setupCorrect && fields.size === 2 && n.value === oldN && first.value === oldFirst &&\n    tail.value === oldTail && elements.length === oldLength"
"prepared.scope = prepared.vm.beginTurn(prepared.tx, root)"
"prepared.result = pure ? prepared.vm.executePure('aliasMutate', [root, one])\n    : prepared.vm.execute(alias ? 'aliasMutate' : 'mutate', [root, one])"
"result = prepared.result"
"resultN: RuntimeValue = NULL_VALUE"
"executionCorrect = executionOutcome === (pure ? 'pure' : 'ok') && prepared.root === root &&\n    root.fields === fields && fields.size === 2 && fields.get('values') === values && values.elements === elements"
"executionCorrect = executionCorrect && fields.get('n') === n && n.value === oldN &&\n    elements.length === oldLength && elements[0] === first && first.value === oldFirst &&\n    elements[oldLength - 1] === tail && tail.value === oldTail"
"!(result instanceof VeraObjectValue)"
"resultN = result.fields.get('n') as RuntimeValue"
"resultArray = result.fields.get('values')"
"executionCorrect = executionCorrect && resultN instanceof VeraNumberValue && resultN !== n &&\n    resultN.value === oldN + 1 && n.value === oldN && first.value === oldFirst && tail.value === oldTail &&\n    resultArray instanceof VeraArrayValue && resultArray === values && resultArray.elements === elements &&\n    elements[0] instanceof VeraNumberValue && (elements[0] as VeraNumberValue).value === oldFirst + 1 &&\n    elements[elements.length - 1] === one && one.value === 1"
"executionCorrect = executionCorrect && result !== root && result.fields !== fields && result.fields.size === 2 &&\n    fields.get('n') === n && n.value === oldN && elements.length === oldLength"
"executionCorrect = executionCorrect && result === root && elements.length === oldLength + 1 &&\n    elements[oldLength - 1] === tail && tail.value === oldTail"
"restored = prepared.root === root && root.fields === fields && fields.size === 2 && fields.get('n') === n &&\n    n.value === oldN && fields.get('values') === values && values.elements === elements &&\n    elements.length === oldLength && elements[0] === first && first.value === oldFirst &&\n    elements[oldLength - 1] === tail && tail.value === oldTail"
"resultRestored = result instanceof VeraObjectValue && result !== root && result.fields !== fields &&\n    result.fields.size === 2 && result.fields.get('n') === resultN && resultN instanceof VeraNumberValue &&\n    resultN.value === 1 && result.fields.get('values') === values && values.elements === elements"
@p2Settlement
"before = JSON.stringify(encodeRuntimeValue(prepared.root))"
"restored = before === JSON.stringify(encodeRuntimeValue(prepared.root)) && prepared.host.pendingEffects.length === 0"
@p2HostDeadline
"vm.execute('probe')"
@p2NodeInput
["signature","p2NodeInput ( node: VeraUiNode ) RuntimeValue | null"]
"new VeraStringValue('12')"
"new VeraBooleanValue(!node.checked)"
"new VeraNumberValue(16)"
"sceneEventValue('tap', '', '', 0, 0, 0, 0, [], [])"
"new VeraNumberValue(Math.max(16, node.minimum))"
"new VeraNumberValue(node.minimum)"
"new VeraNumberValue(720)"
"new VeraNumberValue(19675)"
"new VeraNumberValue(0)"
"new VeraNumberValue(node.eventValue)"
@p2SavedWork
"seed = JSON.stringify(encodeRuntimeValue(decodeRuntimeValue(JSON.parse(corpus.saved) as Object)))"
"seed = JSON.stringify(encodeRuntimeValue(prepared.result))"
"pureCalls.push(new P2Call('widget', 2, p2Arity(corpus.module, 'widget') === 2 ? new VeraNumberValue(2) : null))"
"!eligible || input === null || handlers.length >= 4 || p2Arity(corpus.module, entry) !== 2"
"handlers.push(new P2Call(entry, 5, input))"
"addHandler(node.action, p2NodeInput(node), node.enabled && (node.kind !== 'ticker' ||\n    (node.checked && node.minimum > 0 && node.tickerId.length > 0)))"
"addHandler(node.value, pointerValue('down', 0, 12, 12), node.enabled)"
"roots = decodeVeraUi(prepared.result)"
@runVmSafetyBenchmark
"seed = JSON.stringify(encodeRuntimeValue(initial.result))"
"one = new VeraNumberValue(1)"
"works: P2Work[] = [init,\n    new P2Work(1, 0, module, seed, [new P2Call('mutate', 5, one)], false),\n    new P2Work(2, 0, module, seed, [new P2Call('fresh', 5, one)], false),\n    new P2Work(3, 0, module, seed, [new P2Call('fresh', 5, one), new P2Call('mutate', 5, one)], false),\n    new P2Work(4, 0, module, seed, [new P2Call('view', 1)], true),\n    new P2Work(5, 0, module, seed, [new P2Call('widget', 2, new VeraNumberValue(2))], true),\n    new P2Work(6, 0, module, seed, [new P2Call('draw', 3)], true),\n    new P2Work(7, 0, module, seed, [new P2Call('buildScene', 4)], true),\n    new P2Work(8, 0, module, seed, [new P2Call('pressure', 5, new VeraNumberValue(8192))], false),\n    new P2Work(9, 0, module, seed, [new P2Call('deferred', 5, one)], false)]"
vera/VeraWidgetRefine.ets
@checkTaps
"decodeVeraUi(vm.execute('view', [decodeRuntimeValue(JSON.parse(branch.encodedState()) as Object)]))"
@deadPicture
"walk(decodeVeraUi(vm.execute('view', [decodeRuntimeValue(JSON.parse(state) as Object)])))"
@checkRefresh
"decodeVeraUi(vm.execute('view', [decodeRuntimeValue(JSON.parse(session.encodedState()) as Object)]))"
vera/VeraWorldPlay.ets
@fingerprint
["signature","fingerprint ( state: RuntimeValue ) string"]
["JSON.stringify(encodeRuntimeValue(state))",[]]
@WorldPlay
["root","state: RuntimeValue;"]
@WorldPlay.constructor
["signature","constructor ( node: VeraUiNode state: RuntimeValue vm: VirtualMachine host: UiHostEnvironment module: BytecodeModule ) "]
["this.state = state",[]]
@WorldPlay.handle
["signature","handle ( name: string value: RuntimeValue when: string ) number"]
["before = fingerprint(this.state)",[]]
["this.state = this.vm.execute(name, [this.state, value])",[["try","body"]]]
["fingerprint(this.state) !== before",[["if","fingerprint(this.state) !== before","condition"]]]
@WorldPlay.rebuild
["value = this.vm.execute(this.build, [this.state])",[["try","body"]]]
["next = decodeScene(value)",[["try","body"]]]
@WorldPlay.deliver
["before = fingerprint(this.state)",[["loop","queue.length > 0 && n < EVENTS_PER_FRAME"]]]
["steps = this.handle(this.event, sceneEventValue(e.kind, e.body, e.other, e.x, e.y, e.z, e.speed, e.bodies, e.values), 'in ' + this.event + ' (the event \"' + e.kind + '\" at frame ' + frame.toString() + ')')",[["loop","queue.length > 0 && n < EVENTS_PER_FRAME"]]]
["isDiceSettle && fingerprint(this.state) !== before",[["if","isDiceSettle && fingerprint(this.state) !== before","condition"],["loop","queue.length > 0 && n < EVENTS_PER_FRAME"]]]
@WorldPlay.play
["decodeVeraUi(this.vm.execute('view', [this.state]))",[["loop","let root","decodeVeraUi(this.vm.execute('view', [this.state]))"]]]
["this.handle(b.action, new VeraNumberValue(b.eventValue), 'in ' + b.action + ' (the button \"' + b.text + '\")')",[["if","input.kind === 'button'","then"],["loop","let input","inputs"],["for","frame <= WORLD_PLAY_FRAMES"]]]
["this.handle(this.event, sceneEventValue('tap', input.body, '', p[0], p[1], p[2], 0, [], []), 'in ' + this.event + ' (a tap on ' + (input.body.length > 0 ? 'body \"' + input.body + '\"' : 'empty space') +\n    ' at frame ' + frame.toString() + ')')",[["if","input.kind === 'tap'","then"],["loop","let input","inputs"],["for","frame <= WORLD_PLAY_FRAMES"]]]
["this.handle(this.event, sceneEventValue('swipe', input.body, '', d[0], 0, d[2], 3, [], []), 'in ' + this.event + ' (a swipe of body \"' + input.body + '\" at frame ' + frame.toString() + ')')",[["if","input.kind === 'tap'","else"],["loop","let input","inputs"],["for","frame <= WORLD_PLAY_FRAMES"]]]
@WorldPlay.steerAt
["this.handle(this.event, sceneEventValue('action', p.id, '', at[0], at[1], at[2], 0, [], []), 'in ' + this.event + ' (the player\\'s button \"' + (p.player as ScenePlayer).action + '\" at frame ' + frame.toString() + ')')",[["if","frame === STICK_FROM + STICK_AHEAD / 2 && (p.player as ScenePlayer).action.length > 0 && this.event.length > 0","then"],["if","frame === STICK_FROM + STICK_AHEAD + STICK_RIGHT","else"],["if","frame === STICK_FROM + STICK_AHEAD","else"],["if","frame === STICK_FROM","else"]]]
@playWorld
["state = vm.execute('init')",[["try","body"]]]
["decodeVeraUi(vm.execute('view', [state]))",[["loop","let root","decodeVeraUi(vm.execute('view', [state]))"],["try","body"]]]
["play = new WorldPlay(world as VeraUiNode, state, vm, host, module)",[]]
`.trim().split('\n')) {
    if (line.startsWith('@')) reviewedOwner = line.slice(1)
    else if (/^[a-z].*\.ets$/.test(line)) {
      reviewedFile = line
      assert(!reviewedSurfaces.has(line), 'external inventory: duplicate baseline file')
      reviewedSurfaces.set(line, [])
    } else {
      const site = JSON.parse(line)
      reviewedSurfaces.get(reviewedFile).push([reviewedOwner, ...(typeof site === 'string' ? [site] : site)])
    }
  }
  const reviewedOwnerOrigins = new Map()
  let originFile
  for (const line of String.raw`
components/WidgetPreview.ets
["WidgetPreview.restart","this.session = null",[]]
["WidgetPreview.restart","session = new WidgetSession(this.vbc2, 'preview', seed)",[["try","body"],["loop","let seed","seeds"]]]
["WidgetPreview.restart","this.frame = session.frame('', this.title, '', this.dimension)",[["try","body"],["loop","let seed","seeds"]]]
["WidgetPreview.restart","this.session = session",[["try","body"],["loop","let seed","seeds"]]]
["WidgetPreview.run","this.session === null || this.busy",[["if","this.session === null || this.busy","condition"]]]
["WidgetPreview.run","session = this.session!",[]]
["WidgetPreview.run","before = session.encodedState()",[]]
["WidgetPreview.run","session !== this.session",[["if","session !== this.session","condition"],["try","body"]]]
["WidgetPreview.run","session.restoreTap(result.state, result.rested)",[["try","body"]]]
["WidgetPreview.run","session.answer(result.handlers[0], await sourceFetch(params))",[["if","result.handlers.length > 0","then"],["try","body"]]]
["WidgetPreview.run","session !== this.session",[["if","session !== this.session","condition"],["try","body"]]]
["WidgetPreview.run","this.frame = session.frame('', this.title, '', this.dimension)",[["try","body"]]]
["WidgetPreview.run","session === this.session",[["if","session === this.session","condition"],["try","catch"]]]
["WidgetPreview.run","this.session = new WidgetSession(this.vbc2, 'preview', before)",[["if","session === this.session","then"],["try","catch"]]]
runtime/InProcessHost.ets
["InProcessHost.createActor","actor = this.actorFactory === null ? new AppActor(callbacks, record) :\n    this.actorFactory!(callbacks, record)",[]]
runtime/StateManager.ets
["StateManager.notifyIdle","this.pending !== 0 || this.active !== null",[["if","this.pending !== 0 || this.active !== null","condition"]]]
["StateManager.whenIdle","this.pending !== 0 || this.active !== null",[["loop","this.pending !== 0 || this.active !== null"]]]
["StateManager.captureWorkingSnapshot","this.active !== null || this.exclusive !== 0",[["if","this.active !== null || this.exclusive !== 0","condition"]]]
["StateManager.load","this.active !== null || this.pending !== 0 || this.phase !== 'NEW'",[["if","this.active !== null || this.pending !== 0 || this.phase !== 'NEW'","condition"]]]
["StateManager.publishGeneration","this.active !== null || this.pending !== 0 || this.needsReload",[["if","this.active !== null || this.pending !== 0 || this.needsReload","condition"]]]
["StateManager.beginTurn","this.closing || ['IMMEDIATE', 'THROTTLED', 'VOLATILE'].indexOf(commitClass) < 0 ||\n    ['INIT', 'CARRY', 'INPUT', 'EFFECT_RESULT', 'TICK', 'SURFACE', 'MOVE'].indexOf(source) < 0 ||\n    this.active !== null || this.exclusive !== 0 ||\n    (this.pending !== 0 && (this.pending !== 1 || !this.captureInFlight)) ||\n    (commitClass === 'IMMEDIATE' && this.pending !== 0)",[["if","this.closing || ['IMMEDIATE', 'THROTTLED', 'VOLATILE'].indexOf(commitClass) < 0 ||\n    ['INIT', 'CARRY', 'INPUT', 'EFFECT_RESULT', 'TICK', 'SURFACE', 'MOVE'].indexOf(source) < 0 ||\n    this.active !== null || this.exclusive !== 0 ||\n    (this.pending !== 0 && (this.pending !== 1 || !this.captureInFlight)) ||\n    (commitClass === 'IMMEDIATE' && this.pending !== 0)","condition"]]]
["StateManager.beginTurn","tx = new ManagedStateTransaction(this.sequence, commitClass, source, this.working, this.dirty)",[]]
["StateManager.beginTurn","this.active = tx",[]]
["StateManager.beginTurn","tx.scope = (this.guard as StateRollbackGuard).beginTurn(tx, this.working)",[["if","this.safety","then"],["try","body"]]]
["StateManager.beginTurn","tx",[["try","body"]]]
["StateManager.beginTurn","this.active = null",[["try","catch"]]]
["StateManager.transaction","this.active === null || this.active !== tx || this.active.settling",[["if","this.active === null || this.active !== tx || this.active.settling","condition"]]]
["StateManager.transaction","this.active",[]]
["StateManager.setWorkingState","turn = this.transaction(tx)",[]]
["StateManager.setWorkingState","turn.possibleMutation = true",[]]
["StateManager.setWorkingState","turn.rootReplaced = true",[["if","this.working !== value","then"]]]
["StateManager.markEffects","turn = this.transaction(tx)",[]]
["StateManager.markEffects","turn.hasEffects = true",[]]
["StateManager.proveNoMutation","turn = this.transaction(tx)",[]]
["StateManager.proveNoMutation","turn.rootReplaced || this.working !== turn.originalRoot",[["if","turn.rootReplaced || this.working !== turn.originalRoot","condition"]]]
["StateManager.proveNoMutation","turn.possibleMutation = false",[]]
["StateManager.rollbackTurn","turn = this.transaction(tx)",[]]
["StateManager.rollbackTurn","this.abandonTurn(turn)",[["if","this.isFaulted()","then"]]]
["StateManager.rollbackTurn","this.refuseTurn(turn, this.needsReload)",[]]
["StateManager.finishTurn","this.active = null",[]]
["StateManager.finishTurn","tx.scope !== null",[["if","tx.scope !== null","condition"],["try","body"]]]
["StateManager.finishTurn","tx.scope.accept()",[["if","tx.scope !== null","then"],["try","body"]]]
["StateManager.refuseTurn","tx.scope === null",[["if","tx.scope === null","condition"],["if","this.safety","then"],["try","body"]]]
["StateManager.refuseTurn","tx.scope.rollback()",[["if","this.safety","then"],["try","body"]]]
["StateManager.refuseTurn","this.working = tx.originalRoot",[["if","this.safety","then"],["try","body"]]]
["StateManager.refuseTurn","tx.possibleMutation && !stale",[["if","tx.possibleMutation && !stale","condition"],["if","this.safety","else"],["try","body"]]]
["StateManager.refuseTurn","tx.hasEffects = false",[["try","finally"]]]
["StateManager.refuseTurn","this.active = null",[["try","finally"]]]
["StateManager.refuseTurn","(tx.source === 'INIT' || tx.source === 'CARRY') && this.published && !stale",[["if","(tx.source === 'INIT' || tx.source === 'CARRY') && this.published && !stale","condition"]]]
["StateManager.abandonTurn","tx.hasEffects = false",[]]
["StateManager.abandonTurn","this.active = null",[]]
["StateManager.abandonTurn","tx.scope !== null",[["if","tx.scope !== null","condition"],["try","body"]]]
["StateManager.abandonTurn","tx.scope.discard()",[["if","tx.scope !== null","then"],["try","body"]]]
["StateManager.commitTurn","turn = this.transaction(tx)",[]]
["StateManager.commitTurn","this.abandonTurn(turn)",[["if","this.isFaulted()","then"],["if","this.isFaulted() || this.needsReload","then"]]]
["StateManager.commitTurn","this.refuseTurn(turn, true)",[["if","this.isFaulted()","else"],["if","this.isFaulted() || this.needsReload","then"]]]
["StateManager.commitTurn","effective = this.policy.effective(turn.commitClass, turn.hasEffects)",[["try","body"]]]
["StateManager.commitTurn","this.refuseTurn(turn, false)",[["try","catch"]]]
["StateManager.commitTurn","turn.settling = true",[]]
["StateManager.commitTurn","this.finishTurn(turn)",[["if","this.mode !== 'LIVE_PERSISTENT'","then"]]]
["StateManager.commitTurn","this.abandonTurn(turn)",[["try","catch"],["if","effective !== 'IMMEDIATE'","then"]]]
["StateManager.commitTurn","this.finishTurn(turn)",[["if","effective !== 'IMMEDIATE'","then"]]]
["StateManager.commitTurn","this.abandonTurn(turn)",[["if","this.isFaulted()","then"],["if","this.isFaulted() || this.needsReload","then"]]]
["StateManager.commitTurn","this.refuseTurn(turn, true)",[["if","this.isFaulted()","else"],["if","this.isFaulted() || this.needsReload","then"]]]
["StateManager.commitTurn","this.refuseTurn(turn, false)",[["if","this.phase === 'DEGRADED'","then"]]]
["StateManager.commitTurn","(turn.source === 'INIT' || turn.source === 'CARRY') && !turn.hasEffects &&\n    !turn.originalDirty && this.snapshot !== null",[["if","(turn.source === 'INIT' || turn.source === 'CARRY') && !turn.hasEffects &&\n    !turn.originalDirty && this.snapshot !== null","condition"]]]
["StateManager.commitTurn","this.finishTurn(turn)",[["if","equal","then"],["if","(turn.source === 'INIT' || turn.source === 'CARRY') && !turn.hasEffects &&\n    !turn.originalDirty && this.snapshot !== null","then"]]]
["StateManager.commitTurn","result = await this.save('IMMEDIATE', turn)",[]]
["StateManager.save","turn === null && this.active !== null",[["if","turn === null && this.active !== null","condition"]]]
["StateManager.save","turn === null && (!this.dirty || this.blockedPayloadSeq === this.dirtySeq)",[["if","turn === null && (!this.dirty || this.blockedPayloadSeq === this.dirtySeq)","condition"]]]
["StateManager.save","turn !== null",[["if","turn !== null","condition"],["if","!validCounter(this.revision + 1)","then"]]]
["StateManager.save","this.abandonTurn(turn)",[["if","turn !== null","then"],["if","!validCounter(this.revision + 1)","then"]]]
["StateManager.save","turn === null",[["if","turn === null","condition"],["if","bytes.byteLength > this.stateMaxBytes","then"],["try","body"]]]
["StateManager.save","await this.handleRefusal(result, turn, reason)",[["if","bytes.byteLength > this.stateMaxBytes","then"],["try","body"]]]
["StateManager.save","turn === null",[["if","turn === null","condition"],["try","catch"]]]
["StateManager.save","await this.handleRefusal(result, turn, reason)",[["try","catch"]]]
["StateManager.save","turn !== null",[["if","turn !== null","condition"],["try","catch"]]]
["StateManager.save","this.abandonTurn(turn)",[["if","turn !== null","then"],["try","catch"]]]
["StateManager.save","this.captureInFlight = turn === null",[]]
["StateManager.save","turn !== null",[["if","turn !== null","condition"],["if","this.isTerminal()","then"]]]
["StateManager.save","this.abandonTurn(turn)",[["if","turn !== null","then"],["if","this.isTerminal()","then"]]]
["StateManager.save","await this.handleRefusal(result, turn, reason)",[["if","result.status !== 'COMMITTED'","then"]]]
["StateManager.save","turn !== null",[["if","turn !== null","condition"]]]
["StateManager.save","this.abandonTurn(turn)",[["if","this.isFaulted()","then"],["if","turn !== null","then"]]]
["StateManager.save","this.finishTurn(turn)",[["if","this.isFaulted()","else"],["if","turn !== null","then"]]]
["StateManager.handleRefusal","turn !== null",[["if","turn !== null","condition"],["if","this.isTerminal()","then"]]]
["StateManager.handleRefusal","this.abandonTurn(turn)",[["if","turn !== null","then"],["if","this.isTerminal()","then"]]]
["StateManager.handleRefusal","turn !== null",[["if","turn !== null","condition"],["if","this.lostRecoveryPending","then"]]]
["StateManager.handleRefusal","this.abandonTurn(turn)",[["if","turn !== null","then"],["if","this.lostRecoveryPending","then"]]]
["StateManager.handleRefusal","turn !== null",[["if","turn !== null","condition"],["if","result.status === 'COMMIT_UNCERTAIN' || result.status === 'FENCED_COMMIT'","then"]]]
["StateManager.handleRefusal","this.abandonTurn(turn)",[["if","turn !== null","then"],["if","result.status === 'COMMIT_UNCERTAIN' || result.status === 'FENCED_COMMIT'","then"]]]
["StateManager.handleRefusal","turn !== null",[["if","turn !== null","condition"]]]
["StateManager.handleRefusal","this.refuseTurn(turn, stale)",[["if","turn !== null","then"]]]
["StateManager.handleRefusal","this.active === null && !this.isFaulted()",[["if","this.active === null && !this.isFaulted()","condition"],["if","reason === 'FINAL'","else"],["if","stale","then"]]]
["StateManager.checkpointIfDue","this.pending !== 0 || this.active !== null ||\n    !this.policy.checkpointDue(now, this.lastCommit, this.dirty ? this.dirtySince : this.lastProbe)",[["if","this.pending !== 0 || this.active !== null ||\n    !this.policy.checkpointDue(now, this.lastCommit, this.dirty ? this.dirtySince : this.lastProbe)","condition"]]]
["StateManager.checkpoint","this.active !== null || this.pending !== 0",[["if","this.active !== null || this.pending !== 0","condition"]]]
["StateManager.finalSave","this.active !== null",[["if","this.active !== null","condition"]]]
["StateManager.finalSave","this.active !== null",[["if","this.active !== null","condition"]]]
["StateManager.reloadAfterExternalWrite","this.active !== null",[["if","this.active !== null","condition"]]]
["StateManager.checkOnResume","this.active !== null",[["if","this.active !== null","condition"]]]
["StateManager.preparePromotion","this.mode === 'LIVE_PERSISTENT' || this.active !== null || this.pending !== 0",[["if","this.mode === 'LIVE_PERSISTENT' || this.active !== null || this.pending !== 0","condition"]]]
["StateManager.close","this.active !== null",[["if","this.active !== null","condition"]]]
vera/LiveFormService.ets
["liveFrame","session = new WidgetSession(version.vbc2, version.id, saved)",[["try","body"]]]
["liveFrame","frame = session.frame(projectId, project.name, project.icon, dimension)",[["try","body"]]]
["liveFrame","store.saveState(projectId, version.id, veraStateStamp(version.vbc2), session.encodedState())",[["if","frame.live && saved.length === 0","then"],["try","body"]]]
["answerSource","session",[["if","requests.length === 0","then"]]]
["answerSource","target = now === loaded ? session : new WidgetSession(vbc2, versionId, now)",[]]
["answerSource","target.answer(requests[0].handler, text)",[]]
["answerSource","target",[]]
["liveFormTap","session = new WidgetSession(version.vbc2, version.id, saved)",[["try","body"]]]
["liveFormTap","shown = session.frame(projectId, project.name, project.icon, dimension)",[["try","body"]]]
["liveFormTap","requests = atPoint ?\n    session.tapSurface(shown, params['token'] as string, params['handler'] as string, params['x'] as number, params['y'] as number) :\n    atSwitch ? session.tapSwitch(shown, params['token'] as string, params['handler'] as string, params['on'] as boolean) :\n        session.tap(shown, params['token'] as string, params['handler'] as string, params['value'] as number)",[["try","body"]]]
["liveFormTap","session = await answerSource(session, requests, saved, projectId, version.id, version.vbc2, fetchSource)",[["try","body"]]]
["liveFormTap","frame = session.frame(projectId, project.name, project.icon, formBindings.dimensionFor(formId))",[["try","body"]]]
["liveFormTap","store.saveState(projectId, version.id, veraStateStamp(version.vbc2), session.encodedState())",[["try","body"]]]
["liveFormRefresh","session = new WidgetSession(version.vbc2, version.id, loaded)",[["try","body"]]]
["liveFormRefresh","!session.refreshes()",[["if","!session.refreshes()","condition"],["try","body"]]]
["liveFormRefresh","session = await answerSource(session, session.refresh(), loaded, projectId, version.id, version.vbc2, fetchSource)",[["try","body"]]]
["liveFormRefresh","frame = session.frame(projectId, project.name, project.icon, formBindings.dimensionFor(formId))",[["try","body"]]]
["liveFormRefresh","store.saveState(projectId, version.id, stamp, session.encodedState())",[["try","body"]]]
vera/VeraLiveWidget.ets
["runPreviewTap","session = new WidgetSession(request.vbc2, 'preview', request.state)",[["try","body"]]]
["runPreviewTap","shown = session.frame('', request.title, '', request.dimension)",[["try","body"]]]
["runPreviewTap","requests: SourceRequest[] = request.kind === 'picture' ? session.tapSurface(shown, request.token, request.handler, request.x, request.y) :\n    request.kind === 'switch' ? session.tapSwitch(shown, request.token, request.handler, request.on) :\n        session.tap(shown, request.token, request.handler, request.value)",[["try","body"]]]
["runPreviewTap","result.state = session.encodedState()",[["try","body"]]]
["runPreviewTap","result.rested = session.lastTapRested",[["try","body"]]]
["sameCard","frame = new WidgetSession(vbc2, 'compare', seed).frame('', '', '')",[["try","body"]]]
vera/VeraWidgetRefine.ets
["widgetProblem","session = new WidgetSession(vbc2, 'validation', saved)",[]]
["widgetProblem","frames = session.dimensions().map((dimension: number): LiveFrame => session.frame('project', 'App', '', dimension))",[]]
["widgetProblem","state = session.encodedState()",[]]
["widgetProblem","glance ? (movingSceneError(frames[0].nodes) || movingPartError(vbc2, state, frames[0].nodes) || backgroundError(frames[0].nodes) ||\n    coverTextError(frames, session.takesSize()) ||\n    deadPicture(vbc2, state, frames[0].nodes) ||\n    unseenTouch(vbc2, state, frames[0], memo)) : ''",[]]
["TapMemo.tap","branch.restoreTap(before.state, before.rested)",[["if","before !== undefined","then"]]]
["TapMemo.tap","this.done.set(key, new TappedFrom(branch.encodedState(), branch.lastTapRested, requests))",[]]
["checkTaps","branch.frame('project', 'App', '', dimension)",[]]
["checkTaps","decodeVeraUi(vm.execute('view', [decodeRuntimeValue(JSON.parse(branch.encodedState()) as Object)]))",[]]
["checkTaps","branch.answer(request.handler, 'error: the source is not reached while checking')",[["loop","let request","requests"]]]
["checkTaps","drawsInApp(branch)",[]]
["checkTaps","branch = new WidgetSession(vbc2, 'validation', state)",[]]
["checkTaps","current = branch.frame('project', 'App', '', dimension)",[["for","pass < 2"]]]
["checkTaps","problem = tapped(handler, (): SourceRequest[] => pass === 0 ?\n    memo.tap(key, branch, (): SourceRequest[] => run(branch, current, pass)) : run(branch, current, pass), branch)",[["for","pass < 2"]]]
["checkTaps","problem = twice(switchKey(item.action), item.action, (node: CardNode): boolean => isSwitch(node) && node.action === item.action, (branch: WidgetSession, current: LiveFrame, pass: number): SourceRequest[] => branch.tapSwitch(current, current.token, item.action, pass === 0))",[["loop","let item","collectNodes(nodes, isSwitch)"]]]
["checkTaps","problem = twice(touchKey(picture.pointer, picture.w / 2, picture.h / 2), picture.pointer, (node: CardNode): boolean => node.kind === 'surface' && node.pointer === picture.pointer, (branch: WidgetSession, current: LiveFrame, pass: number): SourceRequest[] => branch.tapSurface(current, current.token, picture.pointer, picture.w / 2, picture.h / 2))",[["loop","let picture","collectNodes(nodes, (node: CardNode): boolean => node.kind === 'surface' && node.pointer.length > 0)"]]]
["checkTaps","problem = twice(buttonKey(button.action, button.value), button.action, (node: CardNode): boolean => isButton(node) && node.action === button.action && node.value === button.value, (branch: WidgetSession, current: LiveFrame, pass: number): SourceRequest[] => branch.tap(current, current.token, button.action, button.value))",[["loop","let button","collectNodes(nodes, isButton)"]]]
["stuckButton","branch = new WidgetSession(vbc2, 'validation', state)",[]]
["stuckButton","current = branch.frame('project', 'App', '', dimension)",[]]
["stuckButton","memo.tap(buttonKey(button.action, button.value), branch, (): SourceRequest[] => branch.tap(current, current.token, button.action, button.value))",[["try","body"]]]
["stuckButton","branch.lastTapRested",[["if","branch.lastTapRested","condition"]]]
["stuckButton","after = branch.frame('project', 'App', '', dimension)",[]]
["unseenTouch","drawnBefore = drawnPictures(new WidgetSession(vbc2, 'validation', state).frame('project', 'App', '', frame.dimension).nodes)",[]]
["unseenTouch","branch = new WidgetSession(vbc2, 'validation', state)",[["loop","let at","TOUCH_POINTS"],["loop","let picture","still"]]]
["unseenTouch","before = branch.frame('project', 'App', '', frame.dimension)",[["loop","let at","TOUCH_POINTS"],["loop","let picture","still"]]]
["unseenTouch","memo.tap(touchKey(picture.pointer, x, y), branch, (): SourceRequest[] => branch.tapSurface(before, before.token, picture.pointer, x, y))",[["try","body"],["loop","let at","TOUCH_POINTS"],["loop","let picture","still"]]]
["unseenTouch","after = branch.frame('project', 'App', '', frame.dimension)",[["loop","let at","TOUCH_POINTS"],["loop","let picture","still"]]]
["checkRefresh","session = new WidgetSession(vbc2, 'validation', saved)",[]]
["checkRefresh","!session.refreshes()",[["if","!session.refreshes()","condition"]]]
["checkRefresh","session.refresh()",[["loop","let request","session.refresh()"],["for","run < 2"]]]
["checkRefresh","session.answer(request.handler, 'error: the source is not reached while checking')",[["loop","let request","session.refresh()"],["for","run < 2"]]]
["checkRefresh","session.frame('project', 'App', '')",[["for","run < 2"]]]
["checkRefresh","decodeVeraUi(vm.execute('view', [decodeRuntimeValue(JSON.parse(session.encodedState()) as Object)]))",[["for","run < 2"]]]
["checkRefresh","states.push(session.encodedState())",[["for","run < 2"]]]
vera/VeraWorldPlay.ets
["playWorld","play = new WorldPlay(world as VeraUiNode, state, vm, host, module)",[]]
["playWorld","play.travel = TRAVEL_KINDS.indexOf(travel) >= 0 ? travel : 'none'",[]]
["playWorld","verdict = play.play()",[["try","body"]]]
["playWorld","verdict = e instanceof PlayStop ? (e as PlayStop).message : play.trap(e as Error, play.build, 'while it was played').message",[["try","catch"]]]
["playWorld","report.slowestSteps = play.slowest",[["if","report !== null","then"]]]
["playWorld","report.slowestMs = predictWorkMs(play.slowest)",[["if","report !== null","then"]]]
["playWorld","report.bodies = play.spec !== null ? (play.spec as WorldSpec).bodies.length : 0",[["if","report !== null","then"]]]
["playWorld","report.kicks = play.kicks",[["if","report !== null","then"]]]
["playWorld","report.settledAfterKick = play.settledAfterKick",[["if","report !== null","then"]]]
["playWorld","report.settledRead = play.settledRead",[["if","report !== null","then"]]]
["playWorld","report.stateChanged = play.stateChanged",[["if","report !== null","then"]]]
["playWorld","report.hitEvents = play.hitEvents",[["if","report !== null","then"]]]
["playWorld","report.hitStepsMax = play.hitStepsMax",[["if","report !== null","then"]]]
["playWorld","report.playerMoved = play.playerMoved",[["if","report !== null","then"]]]
["playWorld","report.enterEvents = play.enterEvents",[["if","report !== null","then"]]]
`.trim().split('\n').map(line => line.trim()).filter(Boolean)) {
    if (line.endsWith('.ets')) {
      originFile = line
      assert(!reviewedOwnerOrigins.has(line), 'external inventory: duplicate owner baseline file')
      reviewedOwnerOrigins.set(line, [])
    } else reviewedOwnerOrigins.get(originFile).push(JSON.parse(line))
  }
  const globalsParser = `parse(): Application {
    let start = this.current().span
    let imports: ImportDeclaration[] = []
    let declarations: Declaration[] = []
    while (!this.atEnd() && this.diagnostics.length < MAX_SYNTAX_ERRORS) {
      let before = this.pos
      try {
        if (this.check('import')) { imports.push(this.parseImport()); continue }
        if (this.check('annotation')) {
          let ann = this.advance()
          declarations.push(this.parseClass(ann.text))
          continue
        }
        if (this.check('class')) { declarations.push(this.parseClass(null)); continue }
        if (this.check('async')) { declarations.push(this.parseFunction()); continue }
        if (this.check('function')) { declarations.push(this.parseFunction()); continue }
        this.error('expected import, class, or function declaration')
      } catch (e) {
        if (!(e instanceof CompileError)) throw e as Error
        this.record(e)
        if (this.pos === before) this.advance()
        while (!this.atEnd() && !this.atDeclarationStart()) this.advance()
      }
    }
    if (this.diagnostics.length > 0) throw new CompileError(this.diagnostics)
    return new Application(this.span(start), imports, declarations)
  }`
  const globalsParserNode = parse('globals.ts', 'class Parser { ' + globalsParser + ' }').statements[0].members[0]
  const guard = input => {
    const compiler = parse('compiler.ts', input.get('vera/VeraCompiler.ets'))
    const parser = compiler.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'Parser')
    const methods = parser?.members.filter(node => ts.isMethodDeclaration(node) && node.name?.text === 'parse')
    assert.equal(methods?.length, 1, 'external inventory: globals parser')
    assert.equal(canonical(print(methods[0])), canonical(print(globalsParserNode)),
      'external inventory: compiler excludes mutable top-level declarations')
    for (const [module, name, text] of ownership.D.readers) {
      const tree = parse('reader.ts', input.get('vera/' + module + '.ets'))
      const readers = tree.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
      assert.equal(readers.length, 1, 'external inventory: reviewed reader ' + module + ':' + name)
      assert.equal(canonical(print(readers[0])), canonical(text),
        'external inventory: reviewed reader body changed ' + module + ':' + name)
    }
    const actual = inventory(input)
    assert.deepEqual([...actual.ownerOrigins.keys()].sort(), [...reviewedOwnerOrigins.keys()].sort(),
      'external inventory: storage owner origin files changed')
    for (const [file, sites] of actual.ownerOrigins) {
      const expected = reviewedOwnerOrigins.get(file)
      for (let index = 0; index < Math.max(sites.length, expected.length); index++) {
        assert.deepEqual(sites[index], expected[index], 'external inventory: ordered storage owner origin ' + file + ':' + index)
      }
    }
    assert.deepEqual(sorted(actual.accesses), sorted(expectedAccesses), 'external inventory: 46 reviewed direct graph accesses')
    assert.deepEqual(sorted(actual.imports), sorted(reviewedImports), 'external inventory: protected imports changed')
    assert.deepEqual(sorted(actual.constructors), sorted(['A', 'B'].flatMap(kind =>
      ownership[kind].constructors.map(([name, sig, body]) => {
        const node = parse('ctor.ts', `class Review { ${sig} { ${body} } }`).statements[0].members[0]
        return [kind, name, canonical(print(node))]
      }))), 'external inventory: constructor ownership/signatures changed')
    assert.deepEqual(sorted(actual.fresh), sorted(ownership.A.fresh.map(([file, name, text]) => [file, name, canonical(text)])),
      'external inventory: fresh construction changed')
    assert.deepEqual(sorted(actual.rootsFound), sorted(ownership.B.roots.map(entry => entry.slice(0, 3))),
      'external inventory: retained roots changed')
    assert.deepEqual([...actual.surfaces.keys()].sort(), [...reviewedSurfaces.keys()].sort(),
      'external inventory: protected consumer files changed')
    for (const [file, entries] of actual.surfaces) {
      const contextual = file.startsWith('runtime/') || ownership.B.roots.some(([name]) => name === file)
      const sites = entries.map(([owner, expression, context]) =>
        expression === 'signature' || expression === 'root' || contextual ? [owner, expression, context] : [owner, expression])
      const expected = reviewedSurfaces.get(file)
      for (let index = 0; index < Math.max(sites.length, expected.length); index++) {
        assert.deepEqual(sites[index], expected[index], 'external inventory: ordered owner/site ' + file + ':' + index)
      }
    }
  }
  guard(sources)
  const replace = (file, before, after) => {
    const text = sources.get(file)
    assert.equal(text.split(before).length, 2, 'external probe anchor: ' + before)
    return new Map(sources).set(file, text.replace(before, after))
  }
  const reject = (name, file, before, after) => assert.throws(() => guard(replace(file, before, after)), /external inventory:/, name)
  const arrayFile = 'vera/VeraGfx.ets', arrayAnchor = 'let items = (v as VeraArrayValue).elements'
  reject('new elements push', arrayFile, arrayAnchor, arrayAnchor + '; items.push(v)')
  reject('borrowed graph alias', arrayFile, arrayAnchor, arrayAnchor + '; let borrowed = items; borrowed.reverse()')
  reject('borrowed graph read escape', arrayFile, arrayAnchor, arrayAnchor + '; let borrowed = items')
  reject('destructured graph alias', arrayFile, arrayAnchor, 'let {elements: items} = v as VeraArrayValue; items.pop()')
  reject('cast erased Object.assign', arrayFile, arrayAnchor, arrayAnchor + '; Object.assign(items as Object, {length: 0})')
  reject('destructured cast erased Object.assign', arrayFile, arrayAnchor,
    arrayAnchor + '; let {elements: erased} = (v as Object as {elements: Object}); Object.assign(erased, {length: 0})')
  reject('fields.set on borrowed object', 'vera/VeraUi.ets', 'for (let entry of obj.fields.entries()) {',
    'obj.fields.set("type", obj); for (let entry of obj.fields.entries()) {')
  reject('computed graph mutation', arrayFile, arrayAnchor, arrayAnchor + '; (v as VeraArrayValue)["elements"][0] = v')
  reject('new Cell import', arrayFile, 'RuntimeTrap, freshObjectValue }', 'RuntimeTrap, freshObjectValue, Cell }')
  reject('new Cell allocation', arrayFile, arrayAnchor, arrayAnchor + '; new Cell(v)')
  reject('new function metadata consumer', arrayFile, 'RuntimeTrap, freshObjectValue }', 'RuntimeTrap, freshObjectValue, FunctionValue }')
  reject('Cell write using import type', 'runtime/shared/StatePort.ets', 'import type { RuntimeValue }',
    'import type { RuntimeValue, Cell }')
  reject('destructured erased retained root', 'runtime/AppActor.ets', 'ready(): boolean {',
    'ready(): boolean { let {currentState: opaque} = this as Object as {currentState: Object}; Object.assign(opaque, {fields: new Map()});')
  reject('new root graph consumer without new imports', 'runtime/AppActor.ets', 'ready(): boolean {',
    'ready(): boolean { (this.currentState as Object as {elements: Object[]}).elements.push({});')
  reject('new function graph consumer without new imports', 'vera/VeraUi.ets',
    'function decodeNode(obj: VeraObjectValue, depth: number): VeraUiNode {',
    'function extraConsumer(obj: VeraObjectValue): void { Object.assign(obj, {fields: new Map()}) }\nfunction decodeNode(obj: VeraObjectValue, depth: number): VeraUiNode {')
  reject('erased constructor signature', interpreter, 'constructor(e: RuntimeValue[])', 'constructor(e: Object)')
  reject('fresh map replaced with borrowed map', 'vera/VeraStateCarry.ets',
    'let fields: Map<string, RuntimeValue> = new Map<string, RuntimeValue>()', 'let fields = old.fields')
  reject('protected interface erasure', 'runtime/StateManager.ets', 'constructor(options: StateManagerOptions) {',
    'constructor(options: StateManagerOptions) { let erased: Object = options; Object.assign((erased as {initialState: Object}).initialState, {fields: new Map()});')
  reject('computed retained root concatenation', 'runtime/AppActor.ets', 'ready(): boolean {',
    'ready(): boolean { Object.assign(this["current" + "State"], {fields: new Map()});')
  reject('computed retained root variable', 'runtime/AppActor.ets', 'ready(): boolean {',
    'ready(): boolean { let key="currentState"; Object.assign(this[key], {fields: new Map()});')
  reject('retained root unreachable assignment', 'runtime/StateManager.ets', 'this.working = value',
    'if (false) { this.working = value }')
  reject('duplicate retained root execute', 'runtime/AppActor.ets', 'this.currentState = this.vm!.execute(action, [before, payload])',
    'this.currentState = this.vm!.execute(action, [before, payload]); this.currentState = this.vm!.execute(action, [before, payload])')

  const actorAnchor = "let actor = record.actor!\n    switch (entry.kind) {"
  reject('visible storage owner Object.assign', 'runtime/InProcessHost.ets', actorAnchor,
    "let actor = record.actor!\n    if (actor instanceof AppActor) { Object.assign(actor, {currentState: null}); }\n    switch (entry.kind) {")
  reject('visible storage owner erased alias', 'runtime/InProcessHost.ets', actorAnchor,
    "let actor = record.actor!\n    if (actor instanceof AppActor) { let erased: Object=actor; Object.assign((erased as {currentState:Object}).currentState,{fields:new Map()}); }\n    switch (entry.kind) {")
  reject('visible storage owner inferred alias', 'runtime/InProcessHost.ets', actorAnchor,
    "let actor = record.actor!\n    if (actor instanceof AppActor) { let alias=actor; Object.assign(alias, {currentState: null}); }\n    switch (entry.kind) {")
  reject('Cell constructor remains pinned as B', interpreter, 'constructor(v: RuntimeValue) { cellBirths.set(this, nextAllocationSerial()); this.value = v; }',
    'constructor(v: RuntimeValue) { cellBirths.set(this, nextAllocationSerial()); this.value = v; this.value = v; }')
  reject('reviewed ArkUI owner erasure', 'components/WidgetPreview.ets', 'let session = this.session!',
    'let session = this.session!; let erased: Object = session; Object.assign(erased, {state: null})')
  reject('reviewed ArkUI builder mutation', 'components/WidgetPreview.ets', 'Stack() {\n        this.card()',
    'Stack() {\n        Object.assign(this.session, {state: null}); this.card()')
  const newFile = text => new Map(sources).set('vera/ExternalInventoryProbe.ets', text)
  assert.throws(() => guard(newFile("import { Cell } from './VeraInterpreter'")), /external inventory:/, 'new protected import/file')
  assert.throws(() => guard(newFile(`import { VeraArrayValue } from './VeraInterpreter'
    function consume(v: VeraArrayValue): void { v.elements.push(v) }`)), /external inventory:/, 'new graph consumer/file')
  assert.throws(() => guard(newFile(`import { FunctionValue } from './VeraInterpreter'
    function consume(v: FunctionValue): void { v.captures[0].value = v; v.name = 'changed' }`)),
  /external inventory:/, 'Cell/function metadata write')
  assert.throws(() => guard(newFile(`import type { StateManagerOptions } from '../runtime/StateManager'
    function consume(options: StateManagerOptions): void {
      let erased: Object = options;
      Object.assign((erased as {initialState: Object}).initialState, {fields: new Map()});
    }`)), /external inventory:/, 'new interface consumer without interpreter import')
  const barrelProbe = new Map(sources)
    .set('vera/ExternalInventoryBarrel/index.ets', "export type { StateManagerOptions } from '../../runtime/StateManager'")
    .set('vera/ExternalInventoryProbe.ets', `import type { StateManagerOptions } from './ExternalInventoryBarrel'
      function consume(options: StateManagerOptions): void {
        let erased: Object = options;
        Object.assign((erased as {initialState: Object}).initialState, {fields: new Map()});
      }`)
  assert.throws(() => guard(barrelProbe), /external inventory:/, 'new barrel interface consumer')
  assert.throws(() => guard(newFile(`import { AppActor } from '../runtime/AppActor'
    function consume(actor: AppActor): void { let erased: Object = actor; Object.assign(erased, {currentState: null}) }`)),
  /external inventory:/, 'new storage owner consumer without interpreter import')

  for (const module of ['VeraUi', 'VeraGfx', 'VeraScene', 'VeraStateCarry']) {
    const file = 'vera/' + module + '.ets', text = sources.get(file)
    for (const [kind, helper] of [
      ['graph', 'function extraMutation(value: VeraArrayValue): void { value.elements.pop() }'],
      ['Cell', "function extraMutation(cell: import('./VeraInterpreter').Cell, value: RuntimeValue): void { cell.value = value }"]
    ]) {
      const probe = new Map(sources).set(file, text + '\n' + helper)
      const sites = inventory(probe).surfaces.get(file)
      const mutation = kind === 'graph' ? 'value.elements.pop()' : 'cell.value = value'
      assert(sites.some(([owner, expression]) => owner === 'extraMutation' && expression === mutation),
        module + ' inventories the mutation body, not only its added signature')
      assert.throws(() => guard(probe), /external inventory:/,
        module + ' appended ' + kind + ' mutation without changing protected imports')
    }
  }
  reject('compiler mutable global bypass', 'vera/VeraCompiler.ets',
    "this.error('expected import, class, or function declaration')",
    "this.advance(); continue")

  guard(newFile('function benign(value: {fields: number[], elements: string[]}): void { value.fields.push(1); value.elements.push("safe") }'))
  guard(newFile('@Component struct UnrelatedArkUi { build() { Column() { Text("safe") } } }'))
  guard(replace(arrayFile, 'expected number argument', 'expected numeric argument'))
  guard(replace(arrayFile, arrayAnchor, 'let items = ( v as VeraArrayValue ).elements'))
  console.log('external-graph inventory: 46 accesses; A/B/C/D ownership; ordered owner/sites, storage-owner origins, retained-root contexts and read-only ownership body pin; cross-file graph/Cell rejection and benign probes ok (review guard, not semantic proof)')
}
externalGraphChecks()

function allocationProvenanceChecks() {
  const {VeraArrayValue, VeraObjectValue, VeraStringValue, VeraNumberValue, freshArrayValue, freshObjectValue, NULL_VALUE} = loadVera('VeraInterpreter')
  const {pointerValue, GfxShapeValue} = loadVera('VeraGfx')
  const {sceneEventValue, SceneThingValue} = loadVera('VeraScene')
  const safeVm = (module, host = new UiHostEnvironment(), limit = 0) =>
    new VirtualMachine(module, host, 100000, {now: () => 0, deadlineMs: 1000}, {journalMaxEntries: limit})
  const splitModule = deserializeVbc2(compileVeraSource(`import * as strings from "std/strings"
    function split(text: string, separator: string): string[] {
      let parts: string[] = strings.split(text, separator);
      parts.push("tail");
      parts[0] = "head";
      return parts;
    }
    function push(parts: string[]): string[] { parts.push("next"); return parts; }`).vbc2)
  for (const pure of [false, true]) {
    for (const [text, separator, expected] of [['a,b', ',', ['head', 'b', 'tail']], ['a😀', '', ['head', '😀', 'tail']]]) {
      const machine = safeVm(splitModule), scope = machine.beginTurn({}, NULL_VALUE)
      const args = [new VeraStringValue(text), new VeraStringValue(separator)]
      const result = pure ? machine.executePure('split', args) : machine.execute('split', args)
      assert.deepEqual(result.elements.map(value => value.value), expected,
        'actual UiHostEnvironment split backing is fresh in pure/zero-capacity execution')
      const before = plain(result)
      assert.throws(() => machine.executePure('push', [result]), error => error.trapCode === 'R-PURE',
        'split result is old at a subsequent pure boundary even in the same turn')
      scope.rollback()
      assert.deepEqual(plain(result), before)
      const next = machine.beginTurn({}, result)
      assert.throws(() => machine.execute('push', [result]), error => error.trapCode === 'R-JOURNAL',
        'surviving split backing is old at the next turn boundary')
      next.rollback()
      assert.deepEqual(plain(result), before)
    }
  }
  const moduleFor = operations => deserializeVbc2(JSON.stringify(['VBC2', ['mutate'], [
    ['mutate', 1, 2, false, [['load-external', 'probe', 'make'], ['load-local', 0], ['call', 1, false],
      ['store-local', 1], ['load-local', 1], ...operations, ['load-local', 1], ['return']]]
  ]]))
  class AllocationHost extends UiHostEnvironment {
    constructor(make) { super(); this.make = make }
    invoke(module, name, args, awaited) {
      return module === 'probe' ? this.make(args[0], this) : super.invoke(module, name, args, awaited)
    }
  }
  const push = [['push-string', 'tail'], ['array-push'], ['pop']]
  const field = name => [['push-number', 99], ['store-field', name]]
  const descendant = [['load-field', 'children'], ['push-string', 'tail'], ['array-push'], ['pop']]
  for (const pure of [false, true]) {
    for (const [name, make, operations, check] of [
      ['host array', () => freshArrayValue([]), push, value => assert.equal(value.elements.length, 1)],
      ['decoded array', () => decodeRuntimeValue(['a', [['s', 'first']]]), push, value => assert.equal(value.elements.length, 2)],
      ['decoded object', () => decodeRuntimeValue(['o', 'Point', [['x', ['n', 1]]]]), field('x'), value => assert.equal(value.fields.get('x').value, 99)],
      ['pointer', () => pointerValue('down', 1, 2, 3), field('x'), value => assert.equal(value.fields.get('x').value, 99)],
      ['gfx subclass backing', () => { const value = new GfxShapeValue({}); value.fields.set('x', new VeraNumberValue(1)); return value },
        field('x'), value => assert.equal(value.fields.get('x').value, 99)],
      ['scene subclass backing', () => { const value = new SceneThingValue({}); value.fields.set('x', new VeraNumberValue(1)); return value },
        field('x'), value => assert.equal(value.fields.get('x').value, 99)],
      ['scene event', () => sceneEventValue('tap', '', '', 0, 0, 0, 0, [], []), field('x'), value => assert.equal(value.fields.get('x').value, 99)],
      ['scene event array', () => sceneEventValue('tap', '', '', 0, 0, 0, 0, [], []).fields.get('bodies'), push, value => assert.equal(value.elements.length, 1)],
      ['scene event values', () => sceneEventValue('tap', '', '', 0, 0, 0, 0, [], []).fields.get('values'), push, value => assert.equal(value.elements.length, 1)],
      ['UI object', (_value, host) => host.invoke('std/ui', 'Text', [new VeraStringValue('body'), new VeraStringValue('text')], false),
        field('text'), value => assert.equal(value.fields.get('text').value, 99)],
      ['UI optional array', (_value, host) => host.invoke('std/ui', 'Column', [new VeraStringValue('default')], false),
        descendant, value => assert.equal(value.fields.get('children').elements.length, 1)],
      ['carried object', value => carryState(freshObjectValue('Point', new Map([['x', new VeraNumberValue(0)]])), value),
        field('x'), value => assert.equal(value.fields.get('x').value, 99)]
    ]) {
      const input = freshObjectValue('Point', new Map([['x', new VeraNumberValue(1)]]))
      const machine = safeVm(moduleFor(operations), new AllocationHost(make)), scope = machine.beginTurn({}, input)
      const result = pure ? machine.executePure('mutate', [input]) : machine.execute('mutate', [input])
      check(result)
      assert.equal(input.fields.get('x').value, 1, name + ' does not mutate input')
      scope.accept()
    }
  }
  for (const [name, create, operations, observed] of [
    ['borrowed array backing', old => new VeraArrayValue(old.elements), push, old => old],
    ['decoded array backing', old => new VeraArrayValue(old.elements), push, old => old],
    ['borrowed object backing', old => new VeraObjectValue('Point', old.fields), field('x'), old => old],
    ['fresh object with old descendant', old => freshObjectValue('Parent', new Map([['children', old]])), descendant, old => old],
    ['UI node with old descendant', (old, host) => host.invoke('std/ui', 'Column', [new VeraStringValue('default'), old], false), descendant, old => old],
    ['carry with old descendant', old => carryState(freshObjectValue('Parent', new Map([['children', freshArrayValue([])]])),
      freshObjectValue('Parent', new Map([['children', old]]))), descendant, old => old]
  ]) {
    for (const mode of ['pure', 'overflow', 'rollback']) {
      const old = name.includes('object backing') ? freshObjectValue('Point', new Map([['x', new VeraNumberValue(1)]])) :
        name === 'decoded array backing' ? decodeRuntimeValue(['a', [['s', 'old']]]) : freshArrayValue([new VeraStringValue('old')])
      const before = plain(observed(old)), backing = old.fields || old.elements
      const machine = safeVm(moduleFor(operations), new AllocationHost(create), mode === 'rollback' ? 1 : 0)
      const scope = machine.beginTurn({}, old)
      if (mode === 'rollback') {
        machine.execute('mutate', [old])
        assert.notDeepEqual(plain(observed(old)), before, name + ' writes are journaled, not silently skipped')
      } else {
        assert.throws(() => mode === 'pure' ? machine.executePure('mutate', [old]) : machine.execute('mutate', [old]),
          error => error.trapCode === (mode === 'pure' ? 'R-PURE' : 'R-JOURNAL'), name)
        assert.deepEqual(plain(observed(old)), before, name + ' rejects before modification')
      }
      scope.rollback()
      assert.deepEqual(plain(observed(old)), before)
      assert.strictEqual(old.fields || old.elements, backing, name + ' rollback retains backing identity')
    }
  }
  for (const make of [() => new GfxShapeValue({}), () => new SceneThingValue({})]) {
    const value = make(), alias = new VeraObjectValue(value.classIdentity, value.fields)
    assert.strictEqual(alias.fields, value.fields, 'subclass aliases preserve backing identity')
  }
  for (const source of ['let shared: number = 0; function init(): number { return shared; }',
    'import * as strings from "std/strings"; let shared: string[] = []; function init(): number { return 0; }']) {
    assert.throws(() => compileVeraSource(source), error => Array.isArray(error.diagnostics) &&
      error.diagnostics.some(diagnostic => diagnostic.code === 'E1001' && diagnostic.message.includes('expected import, class, or function')),
    'compiler rejects mutable global/module slots')
  }
  console.log('allocation provenance: UiHost split, fresh host/decoded storage, retained backing/descendants and compiler globals ok')
}
allocationProvenanceChecks()

{
  const {VeraArrayValue, VeraObjectValue, VeraNumberValue, VeraStringValue, VeraBooleanValue, NULL_VALUE} = loadVera('VeraInterpreter')
  const {pointerValue} = loadVera('VeraGfx')
  const {sceneEventValue} = loadVera('VeraScene')
  const object = (identity, entries) => new VeraObjectValue(identity, new Map(entries))
  const oldNumber = new VeraNumberValue(7), freshNumber = new VeraNumberValue(0)
  const oldEntry = object('Entry', [['amount', oldNumber]])
  const oldList = new VeraArrayValue([oldEntry]), freshList = new VeraArrayValue([])
  const added = new VeraArrayValue([]), changed = new VeraBooleanValue(false)
  const oldNested = object('Nested', [['n', oldNumber]])
  const freshNested = object('Nested', [['n', freshNumber]])
  const prior = object('State', [['entries', oldList], ['nested', oldNested], ['changed', new VeraStringValue('old')],
    ['removed', oldNumber]])
  const fresh = object('State', [['entries', freshList], ['nested', freshNested], ['added', added], ['changed', changed]])
  const oldSlots = [...prior.fields], freshSlots = [...fresh.fields], oldElements = [...oldList.elements]
  const result = carryState(fresh, prior)
  const second = carryState(fresh, prior)
  assert.notStrictEqual(result, fresh)
  assert.notStrictEqual(result, prior)
  assert.notStrictEqual(result.fields, fresh.fields)
  assert.notStrictEqual(result.fields, prior.fields)
  assert.notStrictEqual(result.fields, second.fields)
  assert.strictEqual(result.fields.get('entries'), oldList, 'accepted arrays alias the whole old graph')
  assert.strictEqual(result.fields.get('entries').elements[0], oldEntry)
  assert.strictEqual(result.fields.get('added'), added, 'new fields retain fresh aliases')
  assert.strictEqual(result.fields.get('changed'), changed, 'kind mismatch retains fresh alias')
  assert.equal(result.fields.has('removed'), false)
  const nested = result.fields.get('nested')
  assert.notStrictEqual(nested, oldNested)
  assert.notStrictEqual(nested, freshNested)
  assert.notStrictEqual(nested.fields, oldNested.fields)
  assert.notStrictEqual(nested.fields, freshNested.fields)
  assert.strictEqual(nested.fields.get('n'), oldNumber, 'same-kind scalar retains old identity')
  assert.deepEqual([...prior.fields], oldSlots)
  assert.deepEqual([...fresh.fields], freshSlots)
  assert.deepEqual(oldList.elements, oldElements)
  assert.strictEqual(carryState(freshNumber, oldNumber), oldNumber)
  assert.strictEqual(carryState(changed, oldNumber), changed)
  assert.strictEqual(carryState(NULL_VALUE, oldNumber), NULL_VALUE)
  assert.strictEqual(carryState(freshList, new VeraArrayValue([])), freshList)
  const mismatchList = new VeraArrayValue([changed])
  assert.strictEqual(carryState(mismatchList, oldList), mismatchList)
  const shapes = new Map([['Entry', ['amount']]])
  assert.strictEqual(carryState(freshList, oldList, shapes), oldList)
  assert.strictEqual(carryState(freshList, oldList, new Map([['Entry', ['amount', 'extra']]])), freshList)
  const cycle = new VeraArrayValue([])
  cycle.elements.push(cycle)
  assert.strictEqual(carryState(freshList, cycle), cycle, 'array cycle is retained without serialization/traversal')
  const cyclicEntry = object('Entry', [])
  cyclicEntry.fields.set('self', cyclicEntry)
  const cyclicList = new VeraArrayValue([cyclicEntry])
  assert.strictEqual(carryState(freshList, cyclicList, new Map([['Entry', ['self']]])), cyclicList,
    'shape checks remain shallow for retained cyclic array entries')
  const cyclicState = object('State', [['entries', cyclicList]])
  const cyclicCarried = carryState(object('State', [['entries', freshList]]), cyclicState)
  assert.strictEqual(cyclicCarried.fields.get('entries'), cyclicList)
  assert.strictEqual(cyclicEntry.fields.get('self'), cyclicEntry)
  const p1 = pointerValue('down', 1, 2, 3), p2 = pointerValue('down', 1, 2, 3)
  assert.notStrictEqual(p1, p2)
  assert.notStrictEqual(p1.fields, p2.fields)
  for (const [name, value] of p1.fields) assert.notStrictEqual(value, p2.fields.get(name))
  const bodies = ['body'], values = [4]
  const e1 = sceneEventValue('hit', 'a', 'b', 1, 2, 3, 4, bodies, values)
  const e2 = sceneEventValue('hit', 'a', 'b', 1, 2, 3, 4, bodies, values)
  assert.notStrictEqual(e1.fields, e2.fields)
  for (const name of ['bodies', 'values']) {
    assert.notStrictEqual(e1.fields.get(name), e2.fields.get(name))
    assert.notStrictEqual(e1.fields.get(name).elements, e2.fields.get(name).elements)
  }
  bodies[0] = 'changed'; values[0] = 99
  assert.equal(e1.fields.get('bodies').elements[0].value, 'body')
  assert.equal(e1.fields.get('values').elements[0].value, 4)
  const host = new UiHostEnvironment(), children = new VeraArrayValue([])
  const node1 = host.invoke('std/ui', 'Column', [new VeraStringValue('default'), children], false)
  const node2 = host.invoke('std/ui', 'Column', [new VeraStringValue('default'), children], false)
  assert.notStrictEqual(node1.fields, node2.fields)
  assert.strictEqual(node1.fields.get('children'), children, 'viewNode fresh map retains borrowed children')
  assert.strictEqual(node2.fields.get('children'), children)
}

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
      if (name === '@kit.ArkTS') return {util: {TextEncoder: class {encodeInto(text) {return new TextEncoder().encode(text)}}}}
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
