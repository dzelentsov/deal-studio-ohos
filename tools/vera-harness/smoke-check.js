// VeraSmoke: the first run of a program before it is served, and the runtime errors it reports.
//
//   node tools/vera-harness/smoke-check.js
'use strict'
const assert = require('node:assert')
const {loadVera} = require('./source-loader')
const {compileVeraSource} = loadVera('VeraCompiler')
const {smokeRun} = loadVera('VeraSmoke')
const {VirtualMachine, deserializeVbc2, BytecodeModule, BytecodeFunction, Instruction, RuntimeTrap,
  VeraNumberValue, VeraArrayValue, VeraObjectValue, Cell, FunctionValue, HostEnvironment, EmptyHostEnvironment,
  freshArrayValue, freshObjectValue, decodeRuntimeValue, NULL_VALUE} = loadVera('VeraInterpreter')
const {quoteDiagnostics} = loadVera('VeraRepair')

const program = (handlers, rows) => `@jsonable
class AppState {
  items: string[];
  name: string;
}

function init(): AppState {
  let none: string[] = [];
  return {items: none, name: ""};
}

function setName(state: AppState, value: string): AppState {
  return {items: state.items, name: value};
}

function add(state: AppState, ignored: number): AppState {
  let out: string[] = [];
  for (let s: string of state.items) { out.push(s); }
  out.push(state.name);
  return {items: out, name: ""};
}
${handlers}
function view(state: AppState): ui.View {
  let rows: ui.View[] = [];
  let i: number = state.items.length() - 1;
  while (i >= 0) {
    rows.push(ui.Text("default", state.items[i]));
${rows}
  }
  return ui.AppTheme("clean", "", [ui.Column("default", rows)]);
}
`

// A list loop that never counts down: fine while empty, stuck at the first item -- found, with both lines.
{
  const source = program('', '')
  const found = smokeRun(compileVeraSource(source))
  const loop = source.split('\n').findIndex(l => l.includes('while (i >= 0)')) + 1
  assert.ok(found.startsWith(`${loop + 1}:1 R0022 The program compiled, but stopped drawing the screen after setName, add: array length limit reached`), found)
  assert.ok(found.includes(`inside the loop at line ${loop}, which never stopped`), found)
  assert.ok(found.endsWith(`\n${loop}:1 R0022 the loop it was in`), found)
  assert.match(quoteDiagnostics(source, found), new RegExp(`${loop} \\|   while \\(i >= 0\\) \\{`))
}

// The same loop counting down runs; a handler that traps on the made-up value (an index the list lacks) is set aside.
{
  const pick = `
function pick(state: AppState, index: number): AppState {
  return {items: state.items, name: state.items[index]};
}
`
  assert.equal(smokeRun(compileVeraSource(program(pick, '    i = i - 1;'))), '')
}

// A handler that never ends is reported where it runs.
{
  const spin = `
function spin(state: AppState, ignored: number): AppState {
  let n: number = 0;
  while (n < 1) { n = n * 2; }
  return state;
}
`
  assert.match(smokeRun(compileVeraSource(program(spin, '    i = i - 1;'))), /R0017 The program compiled, but stopped in spin after .*: execution exceeded .* inside the loop at line \d+, which never stopped or does too much work/)
}

// A program whose expect(state) returns false at the initial state is sent back as a repair.
{
  const src = `@jsonable
class AppState { bmi: number; }

function init(): AppState { return {bmi: -68.3}; }

function expect(state: AppState): boolean { return state.bmi > 0 && state.bmi < 60; }

function view(state: AppState): ui.View {
  return ui.AppTheme("clean", "", [ui.Column("default", [ui.Text("default", "BMI")])]);
}
`
  const found = smokeRun(compileVeraSource(src))
  assert.ok(found.startsWith('The program compiled, but its own expectation was not met at the initial state (function expect returned false)'), found)
}

// The same program with a correct initial value passes: expect must not false-fail.
{
  const src = `@jsonable
class AppState { bmi: number; }

function init(): AppState { return {bmi: 24.2}; }

function expect(state: AppState): boolean { return state.bmi > 0 && state.bmi < 60; }

function view(state: AppState): ui.View {
  return ui.AppTheme("clean", "", [ui.Column("default", [ui.Text("default", "BMI")])]);
}
`
  assert.equal(smokeRun(compileVeraSource(src)), '')
}

// Bytecode from before lines were kept still runs, and its traps say what they did without a line.
{
  const vbc2 = JSON.parse(compileVeraSource(program('', '')).vbc2)
  for (const fn of vbc2[2]) fn.length = 5
  const vm = new VirtualMachine(deserializeVbc2(JSON.stringify(vbc2)))
  assert.ok(vm.execute('init'))
}

const budgetInstruction = (op, fields = {}) => Object.assign(new Instruction(op), fields)
const budgetFunction = (name, instructions, lines = instructions.map((_, i) => i + 1)) =>
  new BytecodeFunction(name, 0, 0, false, instructions, lines)
const budgetModule = (...functions) => new BytecodeModule(functions, functions.map(fn => fn.name))
const budgetStraight = (name, count, line = 100) => budgetFunction(name,
  Array.from({length: count}, (_, i) => budgetInstruction(i === count - 1 ? 'return' : 'push-null')),
  Array.from({length: count}, (_, i) => line + i))
const budgetTrap = (run, code, message, line, loopLine = 0) => {
  let caught
  assert.throws(run, error => {
    caught = error
    assert.ok(error instanceof RuntimeTrap)
    assert.equal(error.trapCode, code)
    assert.match(error.message, message)
    if (line !== undefined) assert.equal(error.line, line)
    assert.equal(error.loopLine, loopLine)
    return true
  })
  return caught
}
const budgetHostFunction = (name = 'host', awaited = false) => budgetFunction(name, [
  budgetInstruction('load-external', {module: 'test/budget', name: 'invoke'}),
  budgetInstruction('call', {awaited}),
  budgetInstruction('return')
], [51, 52, 53])

{
  const module = budgetModule(budgetStraight('two', 2), budgetStraight('three', 3))
  for (const create of [
    () => new VirtualMachine(module, undefined, 2),
    () => new VirtualMachine(module, undefined, 2, undefined),
    () => new VirtualMachine(module, undefined, 2, null)
  ]) {
    const vm = create()
    assert.equal(vm.stepsExecuted(), 0)
    assert.strictEqual(vm.execute('two'), NULL_VALUE)
    assert.equal(vm.stepsExecuted(), 2)
    budgetTrap(() => vm.execute('three'), 'R0017', /execution exceeded 2 steps/, 101)
    assert.equal(vm.stepsExecuted(), 3)
    assert.strictEqual(vm.execute('two'), NULL_VALUE)
    assert.equal(vm.stepsExecuted(), 2)
  }
  const vm = new VirtualMachine(module, undefined, 2, {now: () => 0})
  assert.strictEqual(vm.execute('two'), NULL_VALUE)
  assert.equal(vm.stepsExecuted(), 2)
  budgetTrap(() => vm.execute('three'), 'R-BUDGET', /execution exceeded 2 steps/, 102)
  assert.equal(vm.stepsExecuted(), 3)
  assert.strictEqual(vm.execute('two'), NULL_VALUE)
  assert.equal(vm.stepsExecuted(), 2)
}

{
  for (const op of ['load-function', 'make-closure']) {
    const call = name => budgetInstruction(op, {name, functionName: name})
    const module = budgetModule(
      budgetFunction('outer', [call('inner'), budgetInstruction('call'), budgetInstruction('return')], [101, 102, 103]),
      budgetFunction('inner', [call('leaf'), budgetInstruction('call'), budgetInstruction('return')], [201, 202, 203]),
      budgetFunction('leaf', [budgetInstruction('push-number', {numValue: 42}), budgetInstruction('return')], [301, 302])
    )
    for (const budget of [null, {now: () => 0}]) {
      const vm = new VirtualMachine(module, undefined, 8, budget)
      assert.equal(vm.execute('outer').value, 42)
      assert.equal(vm.stepsExecuted(), 8)
      assert.equal(vm.execute('leaf').value, 42)
      assert.equal(vm.stepsExecuted(), 2)
      assert.equal(vm.execute('inner').value, 42)
      assert.equal(vm.stepsExecuted(), 5)
    }
    for (const [limit, line] of [[4, 301], [6, 203], [7, 103]]) {
      const vm = new VirtualMachine(module, undefined, limit, {now: () => 0})
      budgetTrap(() => vm.execute('outer'), 'R-BUDGET', new RegExp(`execution exceeded ${limit} steps`), line)
      assert.equal(vm.stepsExecuted(), limit + 1)
      assert.equal(vm.execute('leaf').value, 42)
      assert.equal(vm.stepsExecuted(), 2)
    }
  }
}

{
  for (const count of [2, 1023, 1024, 1025, 2048, 2049]) {
    const samples = []
    const vm = new VirtualMachine(budgetModule(budgetStraight('main', count)), undefined, count, {
      now: () => { samples.push(vm.stepsExecuted()); return 0 }
    })
    assert.strictEqual(vm.execute('main'), NULL_VALUE)
    assert.equal(vm.stepsExecuted(), count)
    assert.deepEqual(samples, [0, ...[1024, 2048].filter(step => step <= count), count])
    samples.length = 0
    assert.strictEqual(vm.execute('main'), NULL_VALUE)
    assert.deepEqual(samples, [0, ...[1024, 2048].filter(step => step <= count), count])
  }
  for (const stop of [1024, 2048]) {
    const samples = []
    const vm = new VirtualMachine(budgetModule(budgetStraight('main', 2050)), undefined, 2050, {
      now: () => { samples.push(vm.stepsExecuted()); return vm.stepsExecuted() >= stop ? 10 : 0 }, deadlineMs: 10
    })
    budgetTrap(() => vm.execute('main'), 'R-BUDGET', /execution exceeded 10 ms deadline/, 100 + stop - 1)
    assert.equal(vm.stepsExecuted(), stop)
    assert.deepEqual(samples, [0, ...[1024, 2048].filter(step => step <= stop)])
  }
  const samples = []
  const outer = budgetFunction('outer', [
    ...Array.from({length: 510}, () => budgetInstruction('push-null')),
    budgetInstruction('load-function', {name: 'inner'}), budgetInstruction('call'), budgetInstruction('return')
  ])
  const module = budgetModule(outer, budgetStraight('inner', 513, 2000))
  const vm = new VirtualMachine(module, undefined, 1026, {
    now: () => { samples.push(vm.stepsExecuted()); return 0 }
  })
  assert.strictEqual(vm.execute('outer'), NULL_VALUE)
  assert.equal(vm.stepsExecuted(), 1026)
  assert.deepEqual(samples, [0, 1024, 1026])
  const timed = new VirtualMachine(module, undefined, 1026, {
    now: () => timed.stepsExecuted() >= 1024 ? 10 : 0, deadlineMs: 10
  })
  budgetTrap(() => timed.execute('outer'), 'R-BUDGET', /10 ms deadline.*in inner, line 2511/, 2511)
  assert.equal(timed.stepsExecuted(), 1024)
  const cappedSamples = []
  const capped = new VirtualMachine(budgetModule(budgetStraight('main', 1025)), undefined, 1023, {
    now: () => { cappedSamples.push(capped.stepsExecuted()); return 0 }
  })
  budgetTrap(() => capped.execute('main'), 'R-BUDGET', /execution exceeded 1023 steps/, 1123)
  assert.equal(capped.stepsExecuted(), 1024)
  assert.deepEqual(cappedSamples, [0])
}

{
  for (const [elapsed, expired] of [[999, false], [1000, true]]) {
    let reads = 0
    const vm = new VirtualMachine(budgetModule(budgetStraight('main', 2)), undefined, 2, {
      now: () => reads++ === 0 ? 40 : 40 + elapsed
    })
    if (expired) budgetTrap(() => vm.execute('main'), 'R-BUDGET', /execution exceeded 1000 ms deadline/, 101)
    else assert.strictEqual(vm.execute('main'), NULL_VALUE)
    assert.equal(reads, 2)
    assert.equal(vm.stepsExecuted(), 2)
  }
  let reads = 0
  let calls = 0
  const vm = new VirtualMachine(budgetModule(budgetHostFunction()), {invoke() { calls++; return NULL_VALUE }}, 3, {
    now: () => { reads++; return 0 }, deadlineMs: 0
  })
  budgetTrap(() => vm.execute('host'), 'R-BUDGET', /execution exceeded 0 ms deadline/, 51)
  assert.equal(vm.stepsExecuted(), 0)
  assert.equal(reads, 1)
  assert.equal(calls, 0)
  budgetTrap(() => vm.execute('host'), 'R-BUDGET', /execution exceeded 0 ms deadline/, 51)
  assert.equal(vm.stepsExecuted(), 0)
  assert.equal(reads, 2)
  const zeroSteps = new VirtualMachine(budgetModule(budgetStraight('main', 2)), undefined, 0, {now: () => 0})
  budgetTrap(() => zeroSteps.execute('main'), 'R-BUDGET', /execution exceeded 0 steps/, 100)
  assert.equal(zeroSteps.stepsExecuted(), 1)
}

{
  for (const awaited of [false, true]) {
    const events = []
    const result = new VeraNumberValue(42)
    const vm = new VirtualMachine(budgetModule(budgetHostFunction('host', awaited)), {
      invoke(module, name, args, actualAwaited) {
        events.push(['host', vm.stepsExecuted()])
        assert.equal(module, 'test/budget')
        assert.equal(name, 'invoke')
        assert.deepEqual(args, [])
        assert.equal(actualAwaited, awaited)
        return result
      }
    }, 3, {now: () => { events.push(['clock', vm.stepsExecuted()]); return 0 }})
    assert.strictEqual(vm.execute('host'), result)
    assert.equal(vm.stepsExecuted(), 3)
    assert.deepEqual(events, [['clock', 0], ['clock', 2], ['host', 2], ['clock', 2], ['clock', 3]])
  }
  let calls = 0
  let reads = 0
  const before = new VirtualMachine(budgetModule(budgetHostFunction()), {invoke() { calls++; return NULL_VALUE }}, 3, {
    now: () => reads++ === 0 ? 0 : 10, deadlineMs: 10
  })
  budgetTrap(() => before.execute('host'), 'R-BUDGET', /10 ms deadline/, 52)
  assert.equal(before.stepsExecuted(), 2)
  assert.equal(reads, 2)
  assert.equal(calls, 0)
  for (const throws of [false, true]) {
    let time = 0
    let finished = false
    let calls = 0
    const samples = []
    const hostError = new Error('host failed after completing its work')
    const vm = new VirtualMachine(budgetModule(budgetHostFunction()), {
      invoke() {
        calls++
        time = 10000
        assert.equal(vm.stepsExecuted(), 2)
        assert.deepEqual(samples, [[0, 0], [2, 0]])
        finished = true
        if (throws) throw hostError
        return NULL_VALUE
      }
    }, 3, {now: () => { samples.push([vm.stepsExecuted(), time]); return time }, deadlineMs: 10})
    const error = budgetTrap(() => vm.execute('host'), 'R-BUDGET', /10 ms deadline/, 52)
    assert.notStrictEqual(error, hostError)
    assert.equal(calls, 1)
    assert.equal(finished, true)
    assert.equal(vm.stepsExecuted(), 2)
    assert.deepEqual(samples, [[0, 0], [2, 0], [2, 10000]])
  }
  for (const error of [new Error('plain host failure'), new RuntimeTrap('HOST', 'host runtime failure')]) {
    let fail = true
    const vm = new VirtualMachine(budgetModule(budgetHostFunction()), {
      invoke() { if (fail) throw error; return NULL_VALUE }
    }, 3, {now: () => 0})
    assert.throws(() => vm.execute('host'), actual => actual === error)
    assert.equal(vm.stepsExecuted(), 2)
    if (error instanceof RuntimeTrap) {
      assert.equal(error.line, 52)
      assert.match(error.message, /in host, line 52/)
    }
    fail = false
    assert.strictEqual(vm.execute('host'), NULL_VALUE)
    assert.equal(vm.stepsExecuted(), 3)
  }
}

{
  const invalidClocks = [NaN, Infinity, -Infinity, -1, undefined, null, '0', false, {}]
  for (const value of invalidClocks) {
    for (const stage of ['entry', 'sample', 'before-host', 'after-host', 'exit', 'error']) {
      let reads = 0
      let calls = 0
      const targetRead = stage === 'entry' ? 1 : stage === 'after-host' ? 3 : 2
      const fn = stage === 'sample' ? budgetStraight('main', 1025) :
        stage.includes('host') ? budgetHostFunction('main') : stage === 'error' ?
          budgetFunction('main', [budgetInstruction('pop')], [91]) : budgetStraight('main', 2)
      const vm = new VirtualMachine(budgetModule(fn, budgetStraight('good', 2)), {
        invoke() { calls++; return NULL_VALUE }
      }, 2000, {now: () => ++reads === targetRead ? value : 0})
      const line = stage === 'entry' ? fn.lines[0] : stage === 'sample' ? 1123 :
        stage.includes('host') ? 52 : stage === 'error' ? 91 : 101
      budgetTrap(() => vm.execute('main'), 'R-BUDGET', /clock must be finite, nonnegative and monotonic/, line)
      assert.equal(vm.stepsExecuted(), stage === 'entry' ? 0 : stage === 'sample' ? 1024 : stage === 'error' ? 1 : 2)
      assert.equal(reads, targetRead)
      assert.equal(calls, stage === 'after-host' ? 1 : 0)
      assert.strictEqual(vm.execute('good'), NULL_VALUE)
      assert.equal(vm.stepsExecuted(), 2)
    }
  }
  for (const [name, times, line, steps] of [
    ['main', [10, 9], 101, 2], ['host', [10, 9], 52, 2], ['host', [10, 11, 10], 52, 2],
    ['sample', [10, 9], 1123, 1024]
  ]) {
    const vm = new VirtualMachine(budgetModule(budgetStraight('main', 2), budgetHostFunction(), budgetStraight('sample', 1025)),
      {invoke() { return NULL_VALUE }}, 2000, {now: () => times.shift()})
    budgetTrap(() => vm.execute(name), 'R-BUDGET', /clock must be finite, nonnegative and monotonic/, line)
    assert.equal(vm.stepsExecuted(), steps)
    assert.deepEqual(times, [])
  }
  let time = 10
  const vm = new VirtualMachine(budgetModule(budgetStraight('main', 2)), undefined, 2, {now: () => time})
  assert.strictEqual(vm.execute('main'), NULL_VALUE)
  time = 9
  budgetTrap(() => vm.execute('main'), 'R-BUDGET', /clock must be finite, nonnegative and monotonic/, 100)
  assert.equal(vm.stepsExecuted(), 0)
  time = 10
  assert.strictEqual(vm.execute('main'), NULL_VALUE)
  assert.equal(vm.stepsExecuted(), 2)
}

{
  const module = budgetModule(budgetStraight('main', 2))
  for (const now of [undefined, null, 0, 'clock', false, {}]) {
    budgetTrap(() => new VirtualMachine(module, undefined, 2, {now}), 'R-BUDGET', /clock must be a function/, 0)
  }
  let reads = 0
  const now = () => { reads++; return 0 }
  for (const deadlineMs of [-1, NaN, Infinity, -Infinity, null, '1000', true, {}]) {
    budgetTrap(() => new VirtualMachine(module, undefined, 2, {now, deadlineMs}),
      'R-BUDGET', /deadlineMs must be finite and nonnegative/, 0)
  }
  for (const maxSteps of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null]) {
    budgetTrap(() => new VirtualMachine(module, undefined, maxSteps, {now}),
      'R-BUDGET', /maxSteps must be a nonnegative safe integer/, 0)
  }
  assert.equal(reads, 0)
  for (const maxSteps of [2, Number.MAX_SAFE_INTEGER]) {
    const vm = new VirtualMachine(module, undefined, maxSteps, {now, deadlineMs: 0.5})
    assert.strictEqual(vm.execute('main'), NULL_VALUE)
    assert.equal(vm.stepsExecuted(), 2)
  }
  for (const maxSteps of [2.5, Infinity]) {
    const vm = new VirtualMachine(module, undefined, maxSteps, null)
    assert.strictEqual(vm.execute('main'), NULL_VALUE)
    assert.equal(vm.stepsExecuted(), 2)
  }
  let clockReads = 0
  let configReads = 0
  let deadlineReads = 0
  const ticks = [0, 9, 10, 20, 30, 39]
  const config = {
    get now() { configReads++; return () => { clockReads++; return ticks.shift() } },
    get deadlineMs() { deadlineReads++; return 10 }
  }
  const vm = new VirtualMachine(module, undefined, 2, config)
  assert.equal(clockReads, 0)
  assert.equal(configReads, 1)
  assert.equal(deadlineReads, 1)
  Object.defineProperties(config, {
    now: {value: () => assert.fail('budget clock must be copied at construction')},
    deadlineMs: {value: 0}
  })
  assert.strictEqual(vm.execute('main'), NULL_VALUE)
  budgetTrap(() => vm.execute('main'), 'R-BUDGET', /execution exceeded 10 ms deadline/, 101)
  assert.equal(vm.stepsExecuted(), 2)
  assert.strictEqual(vm.execute('main'), NULL_VALUE)
  assert.equal(vm.stepsExecuted(), 2)
  assert.equal(clockReads, 6)
  assert.equal(configReads, 1)
  assert.equal(deadlineReads, 1)
  assert.deepEqual(ticks, [])
}

{
  let time = 0
  let tick = 0
  const module = budgetModule(budgetStraight('good', 2), budgetStraight('long', 3),
    budgetFunction('trap', [budgetInstruction('push-null'), budgetInstruction('ensure-not-null')], [81, 82]))
  const vm = new VirtualMachine(module, undefined, 2, {now: () => { time += tick; return time }, deadlineMs: 10})
  assert.equal(vm.stepsExecuted(), 0)
  for (const name of ['good', 'trap', 'long', 'missing', 'deadline', 'good', 'trap', 'good']) {
    if (name === 'good') assert.strictEqual(vm.execute(name), NULL_VALUE)
    if (name === 'trap') budgetTrap(() => vm.execute(name), 'R0018', /ensure-not-null failed.*line 82/, 82)
    if (name === 'long') budgetTrap(() => vm.execute(name), 'R-BUDGET', /execution exceeded 2 steps/, 102)
    if (name === 'missing') budgetTrap(() => vm.execute(name), 'R0001', /entry function not found: missing/, 0)
    if (name === 'deadline') {
      tick = 10
      budgetTrap(() => vm.execute('good'), 'R-BUDGET', /execution exceeded 10 ms deadline/, 101)
      tick = 0
    }
    assert.equal(vm.stepsExecuted(), name === 'missing' ? 0 : name === 'long' ? 3 : 2)
  }
}

{
  const module = budgetModule(
    budgetFunction('outer', [budgetInstruction('load-function', {name: 'inner'}),
      budgetInstruction('call'), budgetInstruction('return')], [61, 62, 63]),
    budgetFunction('inner', [budgetInstruction('push-null'), budgetInstruction('ensure-not-null')], [81, 82]),
    budgetStraight('good', 2)
  )
  for (const expired of [false, true]) {
    let time = 0
    let reads = 0
    const vm = new VirtualMachine(module, undefined, 10, {
      now: () => { reads++; return expired && vm.stepsExecuted() === 4 ? time + 10 : time }, deadlineMs: 10
    })
    const error = budgetTrap(() => vm.execute('outer'), expired ? 'R-BUDGET' : 'R0018',
      expired ? /execution exceeded 10 ms deadline/ : /ensure-not-null failed/, 82)
    assert.match(error.message, /in inner, line 82/)
    assert.doesNotMatch(error.message, /in outer/)
    assert.equal(vm.stepsExecuted(), 4)
    assert.equal(reads, expired ? 2 : 4)
    time = 20
    assert.strictEqual(vm.execute('good'), NULL_VALUE)
    assert.equal(vm.stepsExecuted(), 2)
  }
}

{
  for (const hostThrows of [false, true]) {
    let reenter = true
    let calls = 0
    let innerError
    const samples = []
    const outer = budgetFunction('outer', [
      budgetInstruction('load-external', {module: 'test/budget', name: 'invoke'}), budgetInstruction('call'),
      budgetInstruction('load-external', {module: 'test/budget', name: 'invoke'}), budgetInstruction('call'),
      budgetInstruction('return')
    ], [51, 52, 53, 54, 55])
    const vm = new VirtualMachine(budgetModule(outer, budgetStraight('good', 2)), {
      invoke() {
        calls++
        if (reenter) {
          innerError = budgetTrap(() => vm.execute('good'), 'R-BUDGET', /reentrant execution is not allowed/, 52)
          assert.equal(vm.stepsExecuted(), 2)
          const repeated = budgetTrap(() => vm.execute('missing'), 'R-BUDGET', /reentrant execution is not allowed/, 52)
          assert.strictEqual(repeated, innerError)
          assert.equal(vm.stepsExecuted(), 2)
          if (hostThrows) throw new Error('host swallowed reentry and threw something else')
        }
        return NULL_VALUE
      }
    }, 5, {now: () => { samples.push(vm.stepsExecuted()); return 0 }})
    const outerError = budgetTrap(() => vm.execute('outer'), 'R-BUDGET', /reentrant execution is not allowed/, 52)
    assert.strictEqual(outerError, innerError)
    assert.equal(vm.stepsExecuted(), 2)
    assert.equal(calls, 1)
    assert.deepEqual(samples, [0, 2])
    assert.strictEqual(vm.execute('good'), NULL_VALUE)
    assert.equal(vm.stepsExecuted(), 2)
    reenter = false
    assert.strictEqual(vm.execute('outer'), NULL_VALUE)
    assert.equal(vm.stepsExecuted(), 5)
    assert.equal(calls, 3)
  }
}

{
  for (const lines of [[71, 72, 73], []]) {
    const loop = budgetFunction('loop', [budgetInstruction('push-null'), budgetInstruction('pop'),
      budgetInstruction('jump', {target: 0})], lines)
    const vm = new VirtualMachine(budgetModule(loop), undefined, 4, {now: () => 0})
    const error = budgetTrap(() => vm.execute('loop'), 'R-BUDGET', /execution exceeded 4 steps/,
      lines.length ? 72 : -1, lines.length ? 71 : 0)
    assert.equal(vm.stepsExecuted(), 5)
    if (lines.length) assert.match(error.message, /in loop, line 72, inside the loop at line 71/)
    else assert.doesNotMatch(error.message, /in loop|line/)
  }
  const source = `function inner(): number {
  let n: number = 0;
  while (n < 1) { n = n * 2; }
  return n;
}
function outer(): number { return inner(); }
`
  const module = deserializeVbc2(compileVeraSource(source).vbc2)
  for (const budget of [null, {now: () => 0}]) {
    const vm = new VirtualMachine(module, undefined, 50, budget)
    const error = budgetTrap(() => vm.execute('outer'), budget === null ? 'R0017' : 'R-BUDGET',
      /execution exceeded 50 steps.*in inner, line 3/, 3, 3)
    assert.match(error.message, /inside the loop at line 3/)
    assert.equal(vm.stepsExecuted(), 51)
  }
}

{
  for (const [stage, targetRead, steps, line, hostCalls] of [
    ['entry', 1, 0, 100, 0],
    ['sample', 2, 1024, 1123, 0],
    ['before-host', 2, 2, 52, 0],
    ['after-host', 3, 2, 52, 1],
    ['host-error', 3, 2, 52, 1],
    ['exit', 2, 2, 101, 0]
  ]) {
    for (const fault of ['throw-error', 'throw-trap', 'throw-undefined', 'reenter']) {
      let reads = 0
      let calls = 0
      let failures = 0
      let reentryError
      const clockError = fault === 'throw-error' ? new Error('clock threw once') :
        fault === 'throw-trap' ? new RuntimeTrap('CLOCK', 'clock trap thrown once') : undefined
      const hostError = new Error('host threw before clock failed')
      const fn = stage === 'sample' ? budgetStraight('main', 1025) :
        stage.includes('host') ? budgetHostFunction('main') : budgetStraight('main', 2)
      const vm = new VirtualMachine(budgetModule(fn, budgetStraight('good', 2)), {
        invoke() {
          calls++
          if (stage === 'host-error') throw hostError
          return NULL_VALUE
        }
      }, 2000, {
        now: () => {
          reads++
          if (reads === targetRead) {
            failures++
            if (fault !== 'reenter') throw clockError
            reentryError = budgetTrap(() => vm.execute('good'), 'R-BUDGET',
              /reentrant execution is not allowed/, stage === 'entry' ? 0 : line)
            assert.equal(vm.stepsExecuted(), steps)
          }
          return 0
        }
      })
      const error = budgetTrap(() => vm.execute('main'), 'R-BUDGET',
        fault === 'reenter' ? /reentrant execution is not allowed/ : /budget clock failed/, line)
      assert.equal(vm.stepsExecuted(), steps)
      assert.equal(reads, targetRead)
      assert.equal(calls, hostCalls)
      assert.equal(failures, 1)
      assert.notStrictEqual(error, hostError)
      if (fault === 'reenter') assert.strictEqual(error, reentryError)
      else assert.notStrictEqual(error, clockError)
      assert.match(error.message, new RegExp(`in main, line ${line}`))
      assert.strictEqual(vm.execute('good'), NULL_VALUE)
      assert.equal(vm.stepsExecuted(), 2)
      assert.equal(reads, targetRead + 2)
      assert.equal(calls, hostCalls)
      assert.equal(failures, 1)
    }
  }
}

{
  let time = 0
  let argumentReads = 0
  const events = []
  const value = new VeraNumberValue(42)
  const fn = new BytecodeFunction('main', 1, 1, false, [
    budgetInstruction('load-local', {slot: 0}), budgetInstruction('return')
  ], [701, 702])
  const args = [NULL_VALUE]
  Object.defineProperty(args, 0, {get() {
    argumentReads++
    events.push(['argument', vm.stepsExecuted(), time])
    time += 2000
    return value
  }})
  const vm = new VirtualMachine(budgetModule(fn), undefined, 2, {
    now: () => { events.push(['clock', vm.stepsExecuted(), time]); return time }
  })
  budgetTrap(() => vm.execute('main', args), 'R-BUDGET', /execution exceeded 1000 ms deadline/, 702)
  assert.equal(vm.stepsExecuted(), 2)
  assert.equal(argumentReads, 1)
  assert.deepEqual(events, [['clock', 0, 0], ['argument', 0, 0], ['clock', 2, 2000]])
  assert.strictEqual(vm.execute('main', [value]), value)
  assert.equal(vm.stepsExecuted(), 2)
  assert.equal(argumentReads, 1)
  assert.deepEqual(events.slice(3), [['clock', 0, 2000], ['clock', 2, 2000]])
}

{
  let reads = 0
  let argumentReads = 0
  const fn = new BytecodeFunction('main', 1, 1, false, [
    budgetInstruction('load-local', {slot: 0}), budgetInstruction('return')
  ], [801, 802])
  const args = [NULL_VALUE]
  Object.defineProperty(args, 0, {get() { argumentReads++; return NULL_VALUE }})
  const vm = new VirtualMachine(budgetModule(fn), undefined, 2, {
    now: () => { if (++reads === 1) throw new Error('initial clock failed'); return 0 }
  })
  budgetTrap(() => vm.execute('main', args), 'R-BUDGET', /budget clock failed.*in main, line 801/, 801)
  assert.equal(vm.stepsExecuted(), 0)
  assert.equal(reads, 1)
  assert.equal(argumentReads, 0)
  assert.strictEqual(vm.execute('main', args), NULL_VALUE)
  assert.equal(vm.stepsExecuted(), 2)
  assert.equal(reads, 3)
  assert.equal(argumentReads, 1)
}

const ji = budgetInstruction
const jfn = (name, code, locals = 2) => new BytecodeFunction(name, locals, locals, false, code, code.map((_, i) => i + 1))
const jl = slot => ji('load-local', {slot})
const jn = n => ji('push-number', {numValue: n})
const jret = [ji('push-null'), ji('return')]
const jpush = [jl(0), jl(1), ji('array-push'), ji('pop'), ...jret]
const jindex = [jl(0), jn(0), jl(1), ji('store-index'), ...jret]
const jfield = [jl(0), jl(1), ji('store-field', {name: 'x'}), ...jret]
const journalModule = budgetModule(
  jfn('push', jpush), jfn('index', jindex), jfn('field', jfield),
  jfn('pop', [jl(0), ji('array-pop'), ji('return')]),
  jfn('call', [jl(0), jl(1), ji('call', {count: 1}), ji('return')]),
  jfn('closure', [jl(0), ji('store-local', {slot: 1}),
    ji('make-closure', {functionName: 'capture', captures: [1]}), ji('return')]),
  jfn('capture', [jl(0), ji('store-capture', {slot: 0}), ji('load-capture', {slot: 0}), ji('return')]),
  jfn('fresh', [ji('make-array'), ji('store-local', {slot: 0}), ...jpush]),
  jfn('array', [ji('make-array'), ji('return')]),
  jfn('trap', [ji('push-null'), ji('ensure-not-null'), ji('return')]),
  budgetHostFunction('host'), budgetStraight('good', 2), budgetStraight('long', 7)
)
const jvm = (host, limit = 65536, module = journalModule, maxSteps = 1000, now = () => 0) =>
  new VirtualMachine(module, host, maxSteps, {now}, {journalMode: 'JOURNAL', journalMaxEntries: limit})
const jt = (run, code) => budgetTrap(run, code, /./)
const jnum = n => new VeraNumberValue(n)
class JournalHost extends HostEnvironment {
  constructor() { super(); this.queue = []; this.id = 0; this.permission = false; this.pure = false; this.invalid = false }
  beginSafetyTurn(reserve) {
    if (this.invalid) throw new Error('invalid host')
    this.reserve = reserve
    const queue = this.queue.slice(), id = this.id, permission = this.permission
    return {
      accept: () => {},
      rollback: () => { this.queue.splice(0, this.queue.length, ...queue); this.id = id; this.permission = permission },
      discard: () => { this.invalid = true }
    }
  }
  setSafetyPure(pure) { this.pure = pure }
  invoke() {
    if (this.action) return this.action()
    this.reserve()
    this.queue.push(++this.id)
    this.permission = true
    return jnum(this.id)
  }
}
{
  jt(() => new VirtualMachine(journalModule, undefined, 10, null, {}), 'R-JOURNAL')
  jt(() => new VirtualMachine(journalModule, undefined, 10, {now: () => 0}, {journalMode: 'COPY_IMMEDIATE'}), 'R-JOURNAL')
  for (const limit of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    jt(() => jvm(undefined, limit), 'R-JOURNAL')
  }
  const unknown = jvm(new class extends HostEnvironment { invoke() { return NULL_VALUE } }())
  jt(() => unknown.beginTurn({}, NULL_VALUE), 'R-JOURNAL')
  const vm = jvm()
  assert.equal(vm.coverage, 'GRAPH_SLOTS_DEFERRED_INTENTS')
  jt(() => vm.execute('good'), 'R-JOURNAL')
  jt(() => vm.beginTurn({}, NULL_VALUE), 'R-JOURNAL')
  assert.strictEqual(new VirtualMachine(journalModule).executePure('good'), NULL_VALUE)
}
{
  const vm = jvm(), one = jnum(1), two = jnum(2)
  const arr = freshArrayValue([one]), backing = arr.elements
  const obj = freshObjectValue('State', new Map([['first', arr], ['x', one], ['last', arr]])), fields = obj.fields
  arr.elements.push(obj, arr)
  const scope = vm.beginTurn({}, obj)
  for (let i = 0; i < 3; i++) {
    vm.execute('push', [arr, two]); vm.execute('index', [new VeraArrayValue(backing), two])
    vm.execute('field', [new VeraObjectValue('Other', fields), arr]); vm.execute('pop', [arr])
  }
  assert.strictEqual(arr.elements[0], two)
  assert.strictEqual(obj.fields.get('x'), arr)
  scope.rollback()
  assert.strictEqual(arr.elements, backing)
  assert.deepEqual(arr.elements, [one, obj, arr])
  assert.strictEqual(obj.fields, fields)
  assert.deepEqual([...fields], [['first', arr], ['x', one], ['last', arr]])
  const accepted = vm.beginTurn({}, obj)
  vm.execute('index', [arr, two]); accepted.accept()
  assert.strictEqual(backing[0], two)
  const next = vm.beginTurn({}, obj)
  vm.execute('index', [arr, one]); next.rollback()
  assert.strictEqual(backing[0], two)
}
{
  const vm = jvm(), initial = freshArrayValue([])
  const make = vm.beginTurn({}, initial)
  const closure = vm.execute('closure', [initial]); make.accept()
  const cell = closure.captures[0]
  const scope = vm.beginTurn({}, initial)
  const created = vm.execute('array')
  vm.execute('push', [created, jnum(3)])
  vm.execute('call', [closure, created]); vm.execute('call', [closure, jnum(8)])
  assert.equal(cell.value.value, 8)
  scope.rollback()
  assert.strictEqual(cell.value, initial)
  const pure = vm.beginTurn({}, initial)
  jt(() => vm.executePure('call', [closure, freshArrayValue([])]), 'R-PURE')
  assert.strictEqual(cell.value, initial)
  pure.rollback()
  const local = vm.beginTurn({}, initial)
  assert.strictEqual(vm.executePure('fresh', [NULL_VALUE, jnum(1)]), NULL_VALUE)
  local.accept()
  const nested = jfn('localCapture', [ji('load-function', {name: 'closure'}), jl(0), ji('call', {count: 1}),
    jl(1), ji('call', {count: 1}), ji('return')])
  const pureVm = jvm(undefined, 0, budgetModule(...journalModule.functions, nested))
  const pureScope = pureVm.beginTurn({}, initial), assigned = freshArrayValue([])
  assert.strictEqual(pureVm.executePure('localCapture', [initial, assigned]), assigned)
  pureScope.accept()
}
{
  const vm = jvm(), root = freshArrayValue([])
  const scope = vm.beginTurn({}, root)
  const closure = vm.execute('closure', [root])
  jt(() => vm.executePure('call', [closure, jnum(7)]), 'R-PURE')
  assert.strictEqual(closure.captures[0].value, root)
  scope.rollback()
  for (const [op, value] of [['push', freshArrayValue([])], ['index', freshArrayValue([NULL_VALUE])],
    ['pop', freshArrayValue([NULL_VALUE])], ['field', freshObjectValue('S', new Map([['x', NULL_VALUE]]))]]) {
    const s = vm.beginTurn({}, value)
    jt(() => vm.executePure(op, [value, jnum(2)]), 'R-PURE')
    s.rollback()
  }
}
{
  for (const op of ['push', 'index', 'field', 'pop']) {
    const vm = jvm(undefined, 1), one = jnum(1), two = jnum(2)
    const root = op === 'field' ? freshObjectValue('S', new Map([['x', one]])) : freshArrayValue([one, one])
    const scope = vm.beginTurn({}, root)
    vm.execute(op, [root, two])
    const before = root.fields ? [...root.fields] : root.elements.slice()
    jt(() => vm.execute(op, [root, jnum(3)]), 'R-JOURNAL')
    assert.deepEqual(root.fields ? [...root.fields] : root.elements, before)
    jt(() => vm.execute('good'), 'R-JOURNAL')
    jt(() => scope.accept(), 'R-JOURNAL')
    scope.rollback()
    assert.deepEqual(root.fields ? [...root.fields] : root.elements, root.fields ? [['x', one]] : [one, one])
  }
  const cell = new Cell(jnum(1)), closure = new FunctionValue('capture', [cell]), vm = jvm(undefined, 0)
  const scope = vm.beginTurn({}, closure)
  jt(() => vm.execute('call', [closure, freshArrayValue([])]), 'R-JOURNAL')
  assert.equal(cell.value.value, 1)
  scope.rollback()
}
{
  const vm = jvm(), root = freshArrayValue([]), tx = {}
  const scope = vm.beginTurn(tx, root)
  vm.execute('push', [root, NULL_VALUE]); scope.discard()
  jt(() => vm.execute('good'), 'R-JOURNAL')
  jt(() => scope.rollback(), 'R-JOURNAL')
  jt(() => vm.beginTurn({}, root), 'R-JOURNAL')
  for (const action of ['accept', 'rollback']) {
    const vm = jvm(), tx = {}, scope = vm.beginTurn(tx, root)
    scope[action]()
    jt(() => scope[action](), 'R-JOURNAL')
  }
  const stale = jvm(), old = stale.beginTurn(tx, root)
  old.accept()
  jt(() => stale.beginTurn(tx, root), 'R-JOURNAL')
  for (const action of ['accept', 'rollback', 'discard']) {
    for (const receiver of ['foreign', 'detached']) {
      const a = jvm(), b = jvm(), sa = a.beginTurn({}, root), sb = b.beginTurn({}, root)
      const settle = sa[action]
      jt(() => receiver === 'foreign' ? settle.call(sb) : settle(), 'R-JOURNAL')
      assert.strictEqual(b.execute('good'), NULL_VALUE)
      jt(() => sa.accept(), 'R-JOURNAL')
      sb.rollback(); sa.rollback()
      const again = a.beginTurn({}, root)
      jt(() => sa.rollback(), 'R-JOURNAL')
      jt(() => again.accept(), 'R-JOURNAL')
      again.rollback()
    }
  }
}
{
  const host = new JournalHost(), vm = jvm(host, 2), root = freshArrayValue([])
  const scope = vm.beginTurn({}, root)
  assert.equal(vm.execute('host').value, 1)
  vm.execute('push', [root, NULL_VALUE])
  jt(() => vm.execute('host'), 'R-JOURNAL')
  assert.deepEqual(host.queue, [1]); assert.equal(host.id, 1)
  scope.rollback()
  assert.deepEqual(host.queue, []); assert.equal(host.id, 0); assert.equal(host.permission, false)
  const accept = vm.beginTurn({}, root)
  vm.execute('host'); accept.accept()
  assert.deepEqual(host.queue, [1])
  const pure = vm.beginTurn({}, root)
  jt(() => vm.executePure('host'), 'R-PURE')
  assert.equal(host.pure, false); assert.deepEqual(host.queue, [1])
  pure.rollback()
  const discard = vm.beginTurn({}, root)
  discard.discard(); assert.equal(host.invalid, true)
}
{
  for (const factory of [() => freshArrayValue([]), () => decodeRuntimeValue(['a', []])]) {
    const host = new JournalHost(), vm = jvm(host)
    host.action = () => factory()
    const nested = jfn('nested', [ji('load-function', {name: 'host'}), ji('call'),
      ji('push-number', {numValue: 9}), ji('array-push'), ji('return')])
    const machine = jvm(host, 0, budgetModule(nested, budgetHostFunction('host')))
    const s = machine.beginTurn({}, NULL_VALUE)
    assert.equal(machine.executePure('nested').value, 1)
    s.accept()
    const born = vm.beginTurn({}, NULL_VALUE)
    const value = vm.execute('host')
    jt(() => vm.executePure('push', [value, NULL_VALUE]), 'R-PURE')
    born.rollback()
  }
  for (const object of [false, true]) {
    const host = new JournalHost(), backing = object ? new Map([['x', NULL_VALUE]]) : [NULL_VALUE]
    host.action = () => object ? new VeraObjectValue('S', backing) : new VeraArrayValue(backing)
    const nested = jfn('nested', [ji('load-function', {name: 'host'}), ji('call'),
      ...(object ? [ji('push-null'), ji('store-field', {name: 'x'})] : [jn(0), ji('push-null'), ji('store-index')]), ...jret])
    const vm = jvm(host, 0, budgetModule(nested, budgetHostFunction('host')))
    const s = vm.beginTurn({}, NULL_VALUE)
    jt(() => vm.executePure('nested'), 'R-PURE')
    s.rollback()
  }
}
{
  for (const operation of ['execute', 'executePure', 'beginTurn', 'accept', 'rollback', 'discard', 'reserve']) {
    const host = new JournalHost(), vm = jvm(host), root = freshArrayValue([])
    const scope = vm.beginTurn({}, root)
    host.action = () => {
      try {
        if (operation === 'execute' || operation === 'executePure') vm[operation]('good')
        else if (operation === 'beginTurn') vm.beginTurn({}, root)
        else if (operation === 'reserve') { host.reserve(); host.reserve() }
        else scope[operation]()
      } catch (_) {}
      return NULL_VALUE
    }
    if (operation === 'reserve') {
      jt(() => vm.executePure('host'), 'R-PURE')
    } else jt(() => vm.execute('host'), 'R-JOURNAL')
    scope.rollback()
  }
}
{
  for (const failure of ['trap', 'steps', 'deadline', 'host']) {
    const host = new JournalHost(), root = freshArrayValue([NULL_VALUE])
    let time = 0
    const vm = jvm(host, 100, journalModule, failure === 'steps' ? 6 : 1000, () => time)
    const scope = vm.beginTurn({}, root)
    vm.execute('index', [root, jnum(3)])
    if (failure === 'deadline') { host.action = () => { time += 1001; return NULL_VALUE } }
    if (failure === 'host') { host.action = () => { host.reserve(); host.queue.push(1); throw new Error('host failure') } }
    if (failure === 'trap') jt(() => vm.execute('trap'), 'R0018')
    else if (failure === 'steps') jt(() => vm.execute('long'), 'R-BUDGET')
    else if (failure === 'deadline') jt(() => vm.execute('host'), 'R-BUDGET')
    else assert.throws(() => vm.execute('host'), /host failure/)
    scope.rollback()
    assert.deepEqual(root.elements, [NULL_VALUE]); assert.deepEqual(host.queue, [])
  }
}

{
  const vm = jvm(undefined, 0), scope = vm.beginTurn({}, NULL_VALUE)
  const value = vm.execute('array')
  vm.execute('push', [value, jnum(1)])
  jt(() => vm.executePure('push', [new VeraArrayValue(value.elements), jnum(2)]), 'R-PURE')
  assert.equal(value.elements.length, 1)
  scope.rollback()
  const objectVm = jvm(), objectScope = objectVm.beginTurn({}, NULL_VALUE)
  const object = freshObjectValue('S', new Map([['x', NULL_VALUE]]))
  objectVm.execute('field', [object, jnum(1)])
  jt(() => objectVm.executePure('field', [new VeraObjectValue('Alias', object.fields), jnum(2)]), 'R-PURE')
  assert.equal(object.fields.get('x').value, 1)
  objectScope.rollback()
  for (const factory of [() => freshObjectValue('S', new Map([['x', NULL_VALUE]])),
    () => decodeRuntimeValue(['o', 'S', [['x', ['z']]]])]) {
    const host = new JournalHost()
    host.action = factory
    const fn = jfn('make', [ji('load-function', {name: 'host'}), ji('call'), jl(0),
      ji('store-field', {name: 'x'}), ...jret])
    const vm = jvm(host, 0, budgetModule(fn, budgetHostFunction('host'))), s = vm.beginTurn({}, NULL_VALUE)
    assert.strictEqual(vm.executePure('make', [jnum(3)]), NULL_VALUE)
    s.accept()
  }
  for (const phase of ['entry', 'exit', 'host']) {
    let armed = false, reads = 0
    const host = new JournalHost()
    const vm = jvm(host, 10, journalModule, 1000, () => {
      if (armed && ++reads === (phase === 'entry' ? 1 : phase === 'exit' ? 2 : 3)) {
        try { vm.execute('good') } catch (_) {}
      }
      return 0
    })
    const s = vm.beginTurn({}, NULL_VALUE)
    armed = true
    jt(() => vm.execute(phase === 'host' ? 'host' : 'good'), 'R-JOURNAL')
    armed = false
    s.rollback()
    assert.deepEqual(host.queue, [])
  }
}
{
  for (const phase of ['begin', 'accept', 'rollback', 'discard', 'pure-on', 'pure-off']) {
    for (const swallowed of [false, true]) {
      const host = new JournalHost(), vm = jvm(host)
      let active = true, scope
      const callback = () => {
        if (!active) return
        if (!swallowed) throw new Error('hook failed')
        try { vm.execute('good') } catch (_) {}
      }
      const begin = host.beginSafetyTurn.bind(host)
      host.beginSafetyTurn = reserve => {
        const result = begin(reserve)
        if (phase === 'begin') callback()
        for (const method of ['accept', 'rollback', 'discard']) {
          const original = result[method]
          result[method] = () => { original(); if (phase === method) callback() }
        }
        return result
      }
      host.setSafetyPure = pure => {
        host.pure = pure
        if (phase === (pure ? 'pure-on' : 'pure-off')) callback()
      }
      if (phase === 'begin') jt(() => vm.beginTurn({}, NULL_VALUE), 'R-JOURNAL')
      else {
        scope = vm.beginTurn({}, NULL_VALUE)
        if (phase.startsWith('pure')) {
          if (!swallowed && phase === 'pure-on') assert.throws(() => vm.executePure('good'), /hook failed/)
          else jt(() => vm.executePure('good'), swallowed ? 'R-JOURNAL' : 'R-PURE')
          assert.equal(host.pure, false)
          active = false
          scope.rollback()
        } else {
          jt(() => scope[phase](), 'R-JOURNAL')
          jt(() => vm.beginTurn({}, NULL_VALUE), 'R-JOURNAL')
        }
      }
    }
  }
  const unsupported = jvm(new class extends HostEnvironment {
    beginSafetyTurn() { return {accept() {}, rollback() {}, discard() {}} }
    invoke() { return NULL_VALUE }
  }())
  const s = unsupported.beginTurn({}, NULL_VALUE)
  jt(() => unsupported.executePure('good'), 'R-PURE')
  s.rollback()
}
{
  for (const [op, root, expected] of [
    ['index', freshArrayValue([]), 'R0009'], ['pop', freshArrayValue([]), 'R0023'],
    ['field', freshObjectValue('S', new Map()), 'R0010'],
    ['push', freshArrayValue(Array(4096).fill(NULL_VALUE)), 'R0022']
  ]) {
    const vm = jvm(undefined, 0), scope = vm.beginTurn({}, root)
    jt(() => vm.executePure(op, [root, NULL_VALUE]), expected)
    scope.rollback()
  }
  const inputs = [NULL_VALUE], map = new Map([['x', NULL_VALUE]])
  const arr = freshArrayValue(inputs), obj = freshObjectValue('S', map)
  assert.notStrictEqual(arr.elements, inputs); assert.notStrictEqual(obj.fields, map)
  const host = new JournalHost()
  host.action = () => obj
  const fn = jfn('make', [ji('load-function', {name: 'host'}), ji('call'), jl(0),
    ji('store-field', {name: 'x'}), ...jret])
  const vm = jvm(host, 0, budgetModule(fn, budgetHostFunction('host'))), s = vm.beginTurn({}, NULL_VALUE)
  jt(() => vm.executePure('make', [jnum(3)]), 'R-PURE')
  s.rollback()
}

{
  const vm = jvm(), initial = jnum(0), last = jnum(1), root = freshArrayValue([initial])
  const s = vm.beginTurn({}, root)
  for (let i = 0; i < 65536; i++) vm.execute('index', [root, last])
  jt(() => vm.execute('index', [root, jnum(2)]), 'R-JOURNAL')
  assert.strictEqual(root.elements[0], last)
  s.rollback()
  assert.strictEqual(root.elements[0], initial)
}
{
  const host = new JournalHost(), vm = jvm(host), root = freshArrayValue([])
  const begin = host.beginSafetyTurn.bind(host)
  host.beginSafetyTurn = reserve => {
    const scope = begin(reserve)
    scope.rollback = () => { try { vm.execute('good') } catch (_) {} }
    return scope
  }
  const scope = vm.beginTurn({}, root)
  host.action = () => { host.reserve(); throw new Error('unreachable') }
  jt(() => vm.executePure('host'), 'R-PURE')
  jt(() => scope.rollback(), 'R-PURE')
  jt(() => vm.beginTurn({}, root), 'R-PURE')
}
{
  const source = `@jsonable
class AppState { items: number[]; count: number; }
function init(): AppState { return {items: [1, 2], count: 0}; }
function mutate(state: AppState): AppState {
  state.items.push(3);
  state.items[0] = 7;
  state.items.pop();
  state.count = 9;
  return state;
}
function local(): number {
  let values: number[] = [];
  values.push(4);
  values[0] = 5;
  return values.pop();
}
function indirect(state: AppState): AppState { return mutate(state); }
`
  const vm = jvm(undefined, 100, deserializeVbc2(compileVeraSource(source).vbc2))
  const init = vm.beginTurn({}, NULL_VALUE), root = vm.execute('init')
  init.accept()
  const array = root.fields.get('items'), backing = array.elements
  const turn = vm.beginTurn({}, root)
  vm.execute('mutate', [root]); vm.execute('mutate', [root])
  assert.equal(root.fields.get('count').value, 9)
  turn.rollback()
  assert.strictEqual(array.elements, backing)
  assert.deepEqual(backing.map(v => v.value), [1, 2])
  assert.equal(root.fields.get('count').value, 0)
  const pure = vm.beginTurn({}, root)
  assert.equal(vm.executePure('local').value, 5)
  jt(() => vm.executePure('indirect', [root]), 'R-PURE')
  assert.deepEqual(backing.map(v => v.value), [1, 2])
  pure.rollback()
}

{
  const {ExternalFunctionValue, encodeRuntimeValue} = loadVera('VeraInterpreter')
  const refs = budgetModule(
    jfn('functionRef', [ji('load-function', {name: 'good'}), ji('return')], 0),
    jfn('externalRef', [ji('load-external', {module: 'std/strings', name: 'trim'}), ji('return')], 0),
    jfn('same', [jl(0), jl(1), ji('binary', {operator: '==='}), ji('return')]),
    budgetStraight('good', 2))
  const vm = jvm(undefined, 0, refs)
  const cold = vm.beginTurn({}, NULL_VALUE)
  const fn = vm.executePure('functionRef'), external = vm.executePure('externalRef')
  assert(fn instanceof FunctionValue && external instanceof ExternalFunctionValue)
  assert.deepEqual(fn.captures, [])
  assert.equal(fn.name, 'good')
  assert.deepEqual([external.module, external.funcName], ['std/strings', 'trim'])
  for (const value of [fn, external]) jt(() => encodeRuntimeValue(value), 'R0024')
  cold.rollback()
  const warm = vm.beginTurn({}, NULL_VALUE)
  assert.strictEqual(vm.executePure('functionRef'), fn)
  assert.strictEqual(vm.executePure('externalRef'), external)
  for (const value of [fn, external]) assert.equal(vm.executePure('same', [value, value]).value, true)
  assert.equal(vm.executePure('same', [fn, new FunctionValue('good', [])]).value, false)
  assert.equal(vm.executePure('same', [external, new ExternalFunctionValue('std/strings', 'trim')]).value, false)
  warm.accept()
  const calls = vm.beginTurn({}, NULL_VALUE)
  assert.strictEqual(vm.executePure('good'), NULL_VALUE)
  assert.strictEqual(vm.executePure('good'), NULL_VALUE)
  assert.equal(vm.stepsExecuted(), 2)
  calls.rollback()
  console.log('P3 D cache lifecycle: cold pure inserts survive rollback, zero captures, stable warm identity, unsaveable functions; ' +
    'cache writes occur, but no VM opcode mutates interned metadata; escaped closure Cells remain B')
}

{
  const {retainedSources, synchronousPathChecks} = require('./gfx-check')
  synchronousPathChecks(retainedSources(), [
    {file: 'vera/VeraInterpreter.ets', owner: 'Frame.constructor', reachability: 'VM synchronous',
      cost: 'Allocates localCount Cells and fresh stack/pc/locals per call; no localCount cap here',
      budget: 'Entry sample precedes frame allocation; nested frames share budget; allocation cannot be interrupted',
      evidence: ['this.locals = []', 'for (let i: number = 0; i < fn.localCount; i++) { this.locals.push(new Cell(i < args.length ? args[i] : NULL_VALUE)) }']},
    {file: 'vera/VeraInterpreter.ets', owner: 'VirtualMachine.take', reachability: 'VM synchronous',
      cost: 'Copies count stack references into fresh host-call argument array, then pops them',
      budget: 'No inner sampling during this loop; instruction-boundary sampling and later host precheck include its elapsed cost',
      evidence: ['let result: RuntimeValue[] = []', 'for (let i = start; i < frame.stack.length; i++) { result.push(frame.stack[i]) }']},
    {file: 'vera/VeraInterpreter.ets', owner: 'VirtualMachine.runFrame', reachability: 'VM synchronous',
      cost: 'string-symbols expands a whole string into scalar wrappers and a copied array within one instruction',
      budget: 'One maxSteps unit does not bound scalar work; no inner deadline sample during Array.from or allocation',
      evidence: ['for (let ch of Array.from(v.value)) { chars.push(new VeraStringValue(ch)) }', 'frame.stack.push(freshArrayValue(chars))']},
    {file: 'vera/VeraUi.ets', owner: 'decodeNode', reachability: 'outside VM',
      cost: 'Depth limited to 8; field/child breadth and series/category copies remain input-proportional without a total node cap',
      budget: 'Post-view decode is caller wall time outside interpreter entry/exit samples; depth cap is not a work cap',
      evidence: ["if (depth > 8) { throw new RuntimeTrap('R0021', 'view tree too deep (max 8)') }", 'node.children.push(decodeNode(child as VeraObjectValue, depth + 1))']},
    {file: 'vera/VeraUi.ets', owner: 'invokeStdStrings', reachability: 'VM synchronous',
      cost: 'Scalar scans, search, replace growth and split allocations are input/output-proportional with no explicit size cap',
      budget: 'Host pre/post elapsed sampling, no inner time checks or hard preemption',
      evidence: ['let chars = scalars(asString(args[0]))', 'return freshArrayValue(parts)']},
    {file: 'vera/VeraUi.ets', owner: 'UiHostEnvironment.queueSdk', reachability: 'VM synchronous',
      cost: 'Trims strings, scans name/value pairs, allocates Map/order and joins names before effect reservation',
      budget: 'Host elapsed time includes preparation; journal cap limits queued effects, not pair/string sizes',
      evidence: ['let pairs = asArray(args[1]).elements', "effect.rawParams = order.join(' ')"]},
    {file: 'vera/VeraUi.ets', owner: 'UiHostEnvironment.invokeValue', reachability: 'VM synchronous',
      cost: 'Dispatches time/math/strings/sdk/gfx/scene/ui only; sdk queues data rather than executing adapters',
      budget: 'Renderer physics waits and asynchronous model/search are not dispatch targets',
      evidence: ["if (module === 'std/sdk') { return this.queueSdk(args) }", "if (module === 'std/scene') { return invokeStdScene(name, args) }"]},
    {file: 'vera/VeraInterpreter.ets', owner: 'encodeRuntimeValue', reachability: 'outside VM',
      cost: 'Recursive full graph traversal and tagged allocation; sharing duplicated, cycles not handled here',
      budget: 'Persistence caller cost, not a VM rollback-copy or interpreter deadline proof',
      evidence: ['let items: Object[] = []', 'for (let e of (value as VeraArrayValue).elements) { items.push(encodeRuntimeValue(e)) }']},
    {file: 'vera/VeraInterpreter.ets', owner: 'decodeRuntimeValue', reachability: 'outside VM',
      cost: 'Recursive tagged input traversal and fresh graph/backing allocation',
      budget: 'Codec caller cost outside VM entry sampling; source/provenance guard covers factory paths, not size/preemption',
      evidence: ['return freshArrayValue(items)', 'return freshObjectValue(parts[1] as string, fields)']}
  ])
  const {UiHostEnvironment} = loadVera('VeraUi')
  const {VeraStringValue} = loadVera('VeraInterpreter')
  const str = text => new VeraStringValue(text)
  for (const [module, name, args] of [
    ['std/strings', 'split', [str('a,b,c'), str(',')]],
    ['std/gfx', 'linear', [jnum(0), jnum(0), jnum(1), jnum(1), freshArrayValue([str('red'), str('blue')])]],
    ['std/scene', 'shape', [str('triangle'), jnum(0), jnum(0), jnum(0), freshArrayValue([0, 0, 1, 0, 0, 1].map(jnum)), str('red')]],
    ['std/sdk', 'call', [str('test.target'), freshArrayValue([str('name'), str('value')]), str('done')]]
  ]) {
    const host = new UiHostEnvironment(), events = []
    const fn = jfn('sync', [ji('load-external', {module, name}), ...args.map((_, i) => jl(i)),
      ji('call', {count: args.length}), ji('return')], args.length)
    let time = 0, finished = false
    const invoke = host.invoke.bind(host)
    host.invoke = (...values) => {
      const result = invoke(...values)
      finished = true
      time += 1001
      return result
    }
    const vm = jvm(host, 10, budgetModule(fn), 100, () => { events.push(time); return time })
    const turn = vm.beginTurn({}, NULL_VALUE)
    host.effectsAllowed = true
    jt(() => vm.execute('sync', args), 'R-BUDGET')
    assert.equal(finished, true, module + ' finished synchronously before refusal')
    assert.deepEqual(events.slice(0, 3), [0, 0, 1001])
    turn.rollback()
    assert.deepEqual(host.pendingEffects, [])
    assert.equal(host.effectsAllowed, false)
  }
}

{
  const fs = require('node:fs')
  const path = require('node:path')
  const loaderRequire = require('node:module').createRequire(require.resolve('./source-loader'))
  const ts = require(process.env.VERA_TYPESCRIPT_PATH || loaderRequire.resolve('typescript'))
  const file = path.resolve(__dirname, '../../entry/src/main/ets/vera/VeraInterpreter.ets')
  assert.equal(path.join(require('./source-loader').sourceRoot, 'vera/VeraInterpreter.ets'), file)
  const source = fs.readFileSync(file, 'utf8')
  const protectedClasses = new Set(['RuntimeValue', 'VeraNumberValue', 'VeraStringValue', 'VeraBooleanValue',
    'VeraNullValue', 'VeraArrayValue', 'VeraObjectValue', 'Cell', 'FunctionValue', 'ExternalFunctionValue', 'Frame'])
  const mutationOpcodes = new Set(['array-push', 'array-pop', 'store-index', 'store-field', 'store-local', 'store-capture'])
  const signatureText = (node, print) => [
    ...(node.modifiers || []).map(print),
    node.name ? print(node.name) : 'constructor',
    ...(node.typeParameters || []).map(print),
    '(', ...node.parameters.map(print), ')', node.type ? print(node.type) : ''
  ].join(' ')
  const safetyPins = {
    nextAllocationSerial: '1162cab4eaa11d551c6113338809780afad7c7cb8e3869532dbca82e4549b0ec',
    freshArrayValue: 'df370ad02bec83e9b8fd6fb32198b1f50f0bf40c41b5aa628ff366ebbd53d6d9',
    freshObjectValue: 'bb154a00fae52d0e4d588f2f76fac6a33b0973f2978fdd136535d7595eb011e9',
    VmTurnToken: '057909eed92e42d4747c1c54a64b361ead6542d160ad45ca6ce0f87e63dfd32c',
    EmptyVmHostSafetyScope: '3d936bb8bb50eb7bc73718f6c88bca153bdcebe6fcda78a78e0390b1c93ab035',
    VmSafetyTurnScopeRecord: 'da8a53beb9a22b6fd9851b4dbbfb8798d7397b20a55014b8c0d9b1aafef0f98e',
    VmUndoRecord: '980a917f7ae6a2f2e77419edcba233e927b4b2dba6cf612e1b1a66bed3cb1c1b',
    HostEnvironment: 'f15c0abe952ffc5abafd268ed277e0605fc3d5d071d1c91d088a0fe87700ca94',
    'EmptyHostEnvironment.beginSafetyTurn': 'dfb3ab7652e884cb26e00b6ed151d896c860a350caeee2344e4b2b5ae58a325e',
    'EmptyHostEnvironment.setSafetyPure': '67cc84fd2e9323962aba8c231f016c63af6c89d26ef61dd7cc80d10abf977892',
    'VirtualMachine.constructor': '978b799795116ea71babc499cbc6a9bb323c824169c16d8295a9c3fd8877546f',
    'VirtualMachine.failSafety': 'f3d4b9d581bc4abff518b7ea21f8b378ca5c5b8c7e1a29eed74c472a14f7023e',
    'VirtualMachine.checkSafety': '0ea2b0195de9bed0e2445b9d0c26fb7edb03044c8f6a41ad23edf22e6c2bdff5',
    'VirtualMachine.beginTurn': '1554f687753fd5916aa8961bc741f0bace2debcdeda3594fb5ff3bbcf299fd08',
    'VirtualMachine.settleTurn': 'ff0d5a69f1eb8f70e9e7ac7eca1d861f1116bc88163a8ed2513ea687e139d1d1',
    'VirtualMachine.reserveHost': 'ea3a54df434c10601045ce4281a58b70cb0881462b055e99c6abb18b2501f789',
    'VirtualMachine.reserveJournal': 'cf0b1f82ba08e7710870b2aa2d287a46b69d38305f7328a21a037adcbe92835a',
    'VirtualMachine.reserveWrite': 'ab89fb6e68ab4285b0e913924f16de3ad49fdc35602b8fa56e492216f7d669e8',
    'VirtualMachine.storeCell': '60c660f5592fa938e35ed639a8e7c9b57a8625ba9e588ee9e0ff67c9819601eb',
    'VirtualMachine.executePure': 'f1d7a87857d4c99f1080119bfe484f07953db1a947067e536bf332619dc873dc',
    'VirtualMachine.executeSafety': '462f567bc759e94a2612757053a257e77a82989ea274fc93fe3fd7071905e9a9'
  }
  const bodyHash = text => require('node:crypto').createHash('sha256').update(text).digest('hex')
  const inventory = text => {
    assert.ok(text.length <= 256 * 1024, 'mutation inventory: source size bound')
    const filename = file + '.ts'
    const options = {target: ts.ScriptTarget.ES2020, strict: true, noEmit: true, types: [], noResolve: true}
    const parsed = ts.createSourceFile(filename, text, options.target, true, ts.ScriptKind.TS)
    assert.equal(parsed.parseDiagnostics.length, 0, 'mutation inventory: parse diagnostics')
    assert.equal(parsed.referencedFiles.length + parsed.typeReferenceDirectives.length, 0,
      'mutation inventory: external references are outside interpreter scope')
    assert.ok(!parsed.statements.some(node => ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) ||
      ts.isExportDeclaration(node) || ts.isModuleDeclaration(node)), 'mutation inventory: module surface changed')
    const host = ts.createCompilerHost(options)
    const original = host.getSourceFile.bind(host)
    host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => name === filename ?
      parsed :
      original(name, languageVersion, onError, shouldCreateNewSourceFile)
    const program = ts.createProgram([filename], options, host)
    assert.equal(program.getOptionsDiagnostics().length, 0, 'mutation inventory: TypeScript library configuration')
    const tree = program.getSourceFile(filename)
    const checker = program.getTypeChecker()
    const symbols = new Set()
    const storageOwners = new Set()
    for (const name of [...protectedClasses, 'VmUndoRecord', 'VirtualMachine']) {
      const declarations = tree.statements.filter(n => ts.isClassDeclaration(n) && n.name?.text === name)
      assert.equal(declarations.length, 1, `mutation inventory: class ${name}`)
      const target = protectedClasses.has(name) || name === 'VmUndoRecord' ? symbols : storageOwners
      target.add(checker.getSymbolAtLocation(declarations[0].name))
    }
    const sensitive = (type, depth = 0, seen = new Set(), tracked = symbols) => {
      if (!type || seen.has(type)) return false
      assert.ok(depth < 32, 'mutation inventory: type depth bound')
      seen.add(type)
      if (tracked.has(type.symbol)) return true
      if (type.isUnionOrIntersection()) return type.types.some(t => sensitive(t, depth + 1, seen, tracked))
      if (type.flags & ts.TypeFlags.TypeParameter) return sensitive(checker.getBaseConstraintOfType(type), depth + 1, seen, tracked)
      if (type.flags & ts.TypeFlags.Object) {
        if (type.objectFlags & ts.ObjectFlags.Reference) {
          if (checker.getTypeArguments(type).some(t => sensitive(t, depth + 1, seen, tracked))) return true
        }
        if (type.objectFlags & ts.ObjectFlags.ClassOrInterface) {
          return (type.getBaseTypes() || []).some(t => sensitive(t, depth + 1, seen, tracked))
        }
      }
      return false
    }
    const printer = ts.createPrinter({removeComments: true, newLine: ts.NewLineKind.LineFeed})
    const print = node => printer.printNode(ts.EmitHint.Unspecified, node, tree)
    const entries = []
    const roots = new Set()
    const add = (node, owner, opcode) => {
      let root = node
      while (root.parent && ts.isExpression(root.parent)) root = root.parent
      if (ts.isVariableDeclaration(root.parent) || ts.isPropertyDeclaration(root.parent)) root = root.parent
      if (roots.has(root)) return
      roots.add(root)
      entries.push([owner + (opcode ? ':' + opcode : ''), ts.SyntaxKind[root.parent.kind], print(root)])
    }
    let visited = 0
    const visit = (node, owner = '<module>', opcode = '') => {
      assert.ok(++visited <= 50000, 'mutation inventory: node bound')
      if (ts.isClassDeclaration(node)) {
        owner = node.name.text
        if (protectedClasses.has(owner)) {
          entries.push(['class', owner, print(node)])
          return
        }
      }
      if (ts.isFunctionDeclaration(node)) owner = node.name.text
      if (ts.isMethodDeclaration(node)) owner += '.' + print(node.name)
      if (ts.isConstructorDeclaration(node)) owner += '.constructor'
      if (ts.isCaseClause(node)) {
        assert.ok(ts.isStringLiteral(node.expression), 'mutation inventory: nonliteral opcode')
        opcode = node.expression.text
        const dispatch = node.parent.parent
        assert.ok(ts.isSwitchStatement(dispatch), 'mutation inventory: case without switch')
        entries.push([owner, 'opcode', opcode, print(dispatch.expression)])
        if (owner === 'VirtualMachine.runFrame' && mutationOpcodes.has(opcode)) {
          const loopBody = dispatch.parent
          const loop = loopBody.parent
          assert.ok(ts.isBlock(loopBody) && ts.isWhileStatement(loop) && loop.statement === loopBody &&
            ts.isBlock(loop.parent) && ts.isMethodDeclaration(loop.parent.parent) &&
            loop.parent.parent.body === loop.parent, 'mutation inventory: mutation dispatcher control flow changed')
          entries.push([owner, 'mutation-case', print(node)])
        }
      }
      if (owner === 'VirtualMachine.callInst' && ts.isMethodDeclaration(node)) {
        entries.push(['safety-pin', owner, bodyHash(print(node))])
      }
      if (Object.hasOwn(safetyPins, owner) && (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node) ||
          ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node))) {
        entries.push(['safety-pin', owner, bodyHash(print(node))])
        return
      }
      if (ts.isDefaultClause(node)) entries.push([owner, 'opcode', '<default>', print(node.parent.parent.expression)])
      if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isConstructorDeclaration(node)) && node.body) {
        const signature = checker.getSignatureFromDeclaration(node)
        const protectedSignature = sensitive(checker.getReturnTypeOfSignature(signature)) || node.parameters.some(p =>
          sensitive(checker.getTypeAtLocation(p)))
        if (protectedSignature) {
          entries.push(['signature', owner, signatureText(node, print)])
        }
      }
      if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const receiver = checker.getTypeAtLocation(node.expression)
        assert.equal(receiver.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown), 0,
          `mutation inventory: opaque property access in ${owner}`)
      }
      if (ts.isPropertyDeclaration(node) && owner === 'VirtualMachine') {
        entries.push(['vm-field', print(node.name), bodyHash(print(node))])
      }
      if (ts.isIdentifier(node) && node.text === 'allocationSerial') add(node, owner, opcode)
      if (ts.isPropertyDeclaration(node) && sensitive(checker.getTypeAtLocation(node))) add(node, owner, opcode)
      if (ts.isExpression(node) && node.parent?.name !== node &&
          !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
        const type = checker.getTypeAtLocation(node)
        if (sensitive(type, 0, new Set(), storageOwners)) {
          assert.ok((ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) &&
            node.parent.expression === node, `mutation inventory: storage owner escape in ${owner}`)
        }
        if (sensitive(type)) add(node, owner, opcode)
      }
      ts.forEachChild(node, child => visit(child, owner, opcode))
    }
    visit(tree)
    return entries
  }
  const tokens = text => {
    const scanner = ts.createScanner(ts.ScriptTarget.ES2020, true, ts.LanguageVariant.Standard, text)
    const result = []
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
      result.push([token, scanner.getTokenText()])
    }
    return JSON.stringify(result)
  }
  const expected = []
  const allow = (owner, context, ...expressions) => {
    for (const expression of expressions) expected.push([owner, context, tokens(expression),
      ...(context === 'opcode' ? [tokens(owner === 'decodeInstruction' ? 'op' : 'inst.op')] : [])])
  }
  const construction = ts.createSourceFile('construction.ts', `
export abstract class RuntimeValue {
  constructor() { valueBirths.set(this, nextAllocationSerial()) }
}
export class VeraNumberValue extends RuntimeValue { value: number; constructor(v: number) { super(); this.value = v; } }
export class VeraStringValue extends RuntimeValue { value: string; constructor(v: string) { super(); this.value = v; } }
export class VeraBooleanValue extends RuntimeValue { value: boolean; constructor(v: boolean) { super(); this.value = v; } }
export class VeraNullValue extends RuntimeValue {}
export class VeraArrayValue extends RuntimeValue {
  elements: RuntimeValue[]
  constructor(e: RuntimeValue[]) {
    super()
    if (!arrayBirths.has(e)) { arrayBirths.set(e, 0) }
    this.elements = e
  }
}
export class VeraObjectValue extends RuntimeValue {
  classIdentity: string
  fields: Map<string, RuntimeValue> = new Map<string, RuntimeValue>()
  constructor(identity: string, fields: Map<string, RuntimeValue>) {
    super()
    this.classIdentity = identity
    if (!objectBirths.has(fields)) { objectBirths.set(fields, 0) }
    this.fields = fields
  }
}
export class Cell { value: RuntimeValue; constructor(v: RuntimeValue) { cellBirths.set(this, nextAllocationSerial()); this.value = v; } }
export class FunctionValue extends RuntimeValue {
  name: string
  captures: Cell[]
  constructor(name: string, captures: Cell[]) { super(); this.name = name; this.captures = captures; }
}
export class ExternalFunctionValue extends RuntimeValue {
  module: string
  funcName: string
  constructor(mod: string, name: string) { super(); this.module = mod; this.funcName = name; }
}
class Frame {
  stack: RuntimeValue[] = []
  locals: Cell[]
  pc: number = 0
  fn: BytecodeFunction
  captures: Cell[]
  constructor(fn: BytecodeFunction, captures: Cell[], args: RuntimeValue[]) {
    this.fn = fn
    this.captures = captures
    this.locals = []
    for (let i: number = 0; i < fn.localCount; i++) {
      this.locals.push(new Cell(i < args.length ? args[i] : NULL_VALUE))
    }
  }
}`, ts.ScriptTarget.ES2020, true)
  const printer = ts.createPrinter({removeComments: true, newLine: ts.NewLineKind.LineFeed})
  for (const node of construction.statements) {
    allow('class', node.name.text, printer.printNode(ts.EmitHint.Unspecified, node, construction))
  }
  const opcodes = ['push-number', 'push-string', 'push-boolean', 'push-null', 'load-local', 'store-local',
    'load-capture', 'store-capture', 'load-function', 'load-external', 'pop', 'duplicate', 'unary', 'binary',
    'jump', 'jump-if-false', 'call', 'return', 'make-array', 'array-push', 'array-pop', 'length',
    'string-symbols', 'ensure-not-null', 'load-index', 'store-index', 'make-object', 'load-field',
    'store-field', 'make-closure']
  for (const opcode of opcodes) {
    allow('VirtualMachine.runFrame', 'opcode', opcode)
    allow('decodeInstruction', 'opcode', opcode)
  }
  allow('decodeInstruction', 'opcode', 'push-int', '<default>')
  allow('<module>', 'VariableDeclarationList', 'NULL_VALUE: VeraNullValue = new VeraNullValue()')
  allow('decodeRuntimeValue', 'ExpressionStatement',
    'fields.set(pair[0] as string, decodeRuntimeValue(pair[1]))', 'items.push(decodeRuntimeValue(e))')
  allow('decodeRuntimeValue', 'ReturnStatement', 'freshArrayValue(items)',
    'new VeraBooleanValue(parts[1] as boolean)', 'new VeraNumberValue(parts[1] as number)',
    'freshObjectValue(parts[1] as string, fields)', 'new VeraStringValue(parts[1] as string)', 'NULL_VALUE')
  allow('decodeRuntimeValue', 'VariableDeclarationList', 'fields = new Map<string, RuntimeValue>()')
  allow('encodeRuntimeValue', 'ExpressionStatement',
    'entries.push([entry[0], encodeRuntimeValue(entry[1])] as Object)', 'items.push(encodeRuntimeValue(e))')
  allow('encodeRuntimeValue', 'ForOfStatement', '(value as VeraArrayValue).elements', 'obj.fields')
  allow('encodeRuntimeValue', 'IfStatement', ...['Array', 'Boolean', 'Null', 'Number', 'Object', 'String']
    .map(name => `value instanceof Vera${name}Value`))
  allow('encodeRuntimeValue', 'ReturnStatement', "['b', (value as VeraBooleanValue).value] as Object",
    "['n', (value as VeraNumberValue).value] as Object", "['o', obj.classIdentity, entries] as Object",
    "['s', (value as VeraStringValue).value] as Object")
  allow('encodeRuntimeValue', 'ThrowStatement',
    "new RuntimeTrap('R0024', 'value cannot be saved: ' + formatRuntimeValue(value))")
  allow('encodeRuntimeValue', 'VariableDeclarationList', 'obj = value as VeraObjectValue')
  allow('formatRuntimeValue', 'ExpressionStatement', "entries.push(entry[0] + ': ' + formatRuntimeValue(entry[1]))")
  allow('formatRuntimeValue', 'ForOfStatement', 'value.fields')
  allow('formatRuntimeValue', 'IfStatement', 'value instanceof ExternalFunctionValue', 'value instanceof FunctionValue',
    ...['Array', 'Boolean', 'Null', 'Number', 'Object', 'String'].map(name => `value instanceof Vera${name}Value`))
  allow('formatRuntimeValue', 'ReturnStatement',
    "'[' + value.elements.map((e: RuntimeValue) => formatRuntimeValue(e)).join(', ') + ']'",
    "value.value ? 'true' : 'false'", 'value.value.toString()', 'value.value')
  allow('formatRuntimeValue', 'TemplateSpan', 'value.funcName', 'value.module', 'value.name')
  for (const [method, kind] of [['asArray', 'Array'], ['asBoolean', 'Boolean'], ['asNumber', 'Number'], ['asObject', 'Object']]) {
    allow('VirtualMachine.' + method, 'IfStatement', `!(v instanceof Vera${kind}Value)`)
    allow('VirtualMachine.' + method, 'ReturnStatement', kind === 'Array' || kind === 'Object' ?
      `v as Vera${kind}Value` : `(v as Vera${kind}Value).value`)
  }
  allow('VirtualMachine.binary', 'IfStatement', 'left instanceof VeraStringValue && right instanceof VeraStringValue')
  allow('VirtualMachine.binary', 'ReturnStatement', 'new VeraBooleanValue(!this.equal(left, right))',
    'new VeraBooleanValue(this.asBoolean(left) && this.asBoolean(right))',
    'new VeraBooleanValue(this.asBoolean(left) || this.asBoolean(right))',
    'new VeraBooleanValue(this.compareNum(op, a, b))', 'new VeraBooleanValue(this.compareStr(op, left.value, right.value))',
    'new VeraBooleanValue(this.equal(left, right))', ...['-', '*', '/', '%', '+'].map(op => `new VeraNumberValue(a ${op} b)`),
    'new VeraStringValue(left.value + right.value)')
  allow('VirtualMachine.binary', 'VariableDeclarationList', 'a = this.asNumber(left)', 'b = this.asNumber(right)')
  allow('VirtualMachine.callInst', 'ExpressionStatement', 'frame.stack.push(result)',
    'frame.stack.push(this.host.invoke(callee.module, callee.funcName, args, inst.awaited))',
    'frame.stack.push(this.run(new Frame(fn, callee.captures, args)))')
  allow('VirtualMachine.callInst', 'IfStatement', 'callee instanceof ExternalFunctionValue', 'callee instanceof FunctionValue')
  allow('VirtualMachine.callInst', 'TemplateSpan', 'callee.name')
  allow('VirtualMachine.callInst', 'VariableDeclarationList', 'args = this.take(frame, inst.count)',
    'callee = this.pop(frame)', 'fn = this.functions.get(callee.name)',
    'result = this.host.invoke(callee.module, callee.funcName, args, inst.awaited)')
  allow('VirtualMachine.cell', 'IfStatement', 'idx < 0 || idx >= vals.length')
  allow('VirtualMachine.cell', 'ReturnStatement', 'vals[idx]')
  allow('VirtualMachine.equal', 'IfStatement', 'a instanceof ExternalFunctionValue && b instanceof ExternalFunctionValue',
    'a instanceof FunctionValue && b instanceof FunctionValue', 'a instanceof VeraBooleanValue && b instanceof VeraBooleanValue',
    'a instanceof VeraNullValue || b instanceof VeraNullValue', 'a instanceof VeraNumberValue && b instanceof VeraNumberValue',
    'a instanceof VeraStringValue && b instanceof VeraStringValue')
  allow('VirtualMachine.equal', 'ReturnStatement', 'a === b', 'a === b',
    'a instanceof VeraNullValue && b instanceof VeraNullValue', 'a.value === b.value', 'a.value === b.value', 'a.value === b.value')
  allow('VirtualMachine.execute', 'ReturnStatement', 'this.executeSafety(entry, args, false)',
    'this.executeBudgeted(entry, args)', 'this.run(new Frame(fn, [], args))')
  allow('VirtualMachine.executeBudgeted', 'ExpressionStatement', 'this.budgetFrame = new Frame(fn, [], args)', 'this.budgetFrame = null')
  allow('VirtualMachine.executeBudgeted', 'ReturnStatement', 'result')
  allow('VirtualMachine.executeBudgeted', 'VariableDeclarationList', 'result = this.run(this.budgetFrame)')
  allow('VirtualMachine.failBudget', 'ExpressionStatement',
    'locateTrap(this.budgetFailure, this.budgetFrame.fn, Math.max(0, this.budgetFrame.pc - 1))')
  allow('VirtualMachine.failBudget', 'IfStatement', 'this.budgetFrame !== null')
  allow('VirtualMachine.index', 'VariableDeclarationList', 'i = this.asNumber(v)')
  allow('VirtualMachine.indexValue', 'IfStatement', 'idx < 0 || idx >= arr.elements.length')
  allow('VirtualMachine.indexValue', 'ReturnStatement', 'arr.elements[idx]')
  allow('VirtualMachine.pop', 'IfStatement', 'v == undefined')
  allow('VirtualMachine.pop', 'ReturnStatement', 'v')
  allow('VirtualMachine.pop', 'VariableDeclarationList', 'v = frame.stack.pop()')
  allow('VirtualMachine.run', 'ExpressionStatement', 'locateTrap(error, frame.fn, frame.pc - 1)',
    'this.budgetFrame = frame', 'this.budgetFrame = previousFrame')
  allow('VirtualMachine.run', 'ReturnStatement', 'this.runFrame(frame)')
  allow('VirtualMachine.run', 'VariableDeclarationList', 'previousFrame = this.budgetFrame')
  const runAllow = (opcode, context, ...expressions) => allow('VirtualMachine.runFrame:' + opcode, context, ...expressions)
  const mutationCases = ts.createSourceFile('mutation-cases.ts', `switch (inst.op) {
    case 'store-local':
      this.storeCell(this.cell(frame.locals, inst.slot), this.pop(frame))
      break
    case 'store-capture':
      this.storeCell(this.cell(frame.captures, inst.slot), this.pop(frame))
      break
    case 'array-push': {
      let v = this.pop(frame)
      let arr = this.asArray(this.pop(frame))
      if (arr.elements.length >= 4096) {
        throw new RuntimeTrap('R0022', 'array length limit reached (4096)')
      }
      if (this.reserveWrite(arrayBirths.get(arr.elements) || 0)) {
        let record = new VmUndoRecord('push')
        record.array = arr.elements
        record.length = arr.elements.length
        this.journal.push(record)
      }
      arr.elements.push(v)
      frame.stack.push(new VeraNumberValue(arr.elements.length))
      break
    }
    case 'array-pop': {
      let arr = this.asArray(this.pop(frame))
      if (arr.elements.length === 0) {
        throw new RuntimeTrap('R0023', 'pop from an empty array')
      }
      if (this.reserveWrite(arrayBirths.get(arr.elements) || 0)) {
        let record = new VmUndoRecord('pop')
        record.array = arr.elements
        record.index = arr.elements.length - 1
        record.value = arr.elements[record.index]
        this.journal.push(record)
      }
      frame.stack.push(arr.elements.pop() as RuntimeValue)
      break
    }
    case 'store-index': {
      let v = this.pop(frame)
      let idx = this.index(this.pop(frame))
      let arr = this.asArray(this.pop(frame))
      this.indexValue(arr, idx)
      if (this.reserveWrite(arrayBirths.get(arr.elements) || 0)) {
        let record = new VmUndoRecord('index')
        record.array = arr.elements
        record.index = idx
        record.value = arr.elements[idx]
        this.journal.push(record)
      }
      arr.elements[idx] = v
      break
    }
    case 'store-field': {
      let v = this.pop(frame)
      let obj = this.asObject(this.pop(frame))
      if (!obj.fields.has(inst.name)) { throw new RuntimeTrap('R0010', \`missing field \${inst.name}\`) }
      if (this.reserveWrite(objectBirths.get(obj.fields) || 0)) {
        let record = new VmUndoRecord('field')
        record.fields = obj.fields
        record.key = inst.name
        record.value = obj.fields.get(inst.name) as RuntimeValue
        this.journal.push(record)
      }
      obj.fields.set(inst.name, v)
      break
    }
  }`, ts.ScriptTarget.ES2020, true)
  assert.equal(mutationCases.parseDiagnostics.length, 0)
  assert.equal(mutationCases.statements[0].caseBlock.clauses.length, mutationOpcodes.size)
  for (const node of mutationCases.statements[0].caseBlock.clauses) {
    allow('VirtualMachine.runFrame', 'mutation-case', printer.printNode(ts.EmitHint.Unspecified, node, mutationCases))
  }
  runAllow('array-pop', 'ExpressionStatement', 'frame.stack.push(arr.elements.pop() as RuntimeValue)')
  runAllow('array-pop', 'IfStatement', 'arr.elements.length === 0')
  runAllow('array-pop', 'VariableDeclarationList', 'arr = this.asArray(this.pop(frame))')
  runAllow('array-push', 'ExpressionStatement', 'arr.elements.push(v)', 'frame.stack.push(new VeraNumberValue(arr.elements.length))')
  runAllow('array-push', 'IfStatement', 'arr.elements.length >= 4096')
  runAllow('array-push', 'VariableDeclarationList', 'arr = this.asArray(this.pop(frame))', 'v = this.pop(frame)')
  runAllow('binary', 'ExpressionStatement', 'frame.stack.push(this.binary(inst.operator, l, r))')
  runAllow('binary', 'VariableDeclarationList', 'l = this.pop(frame)', 'r = this.pop(frame)')
  runAllow('call', 'ExpressionStatement', 'this.callInst(frame, inst)')
  runAllow('duplicate', 'ExpressionStatement', 'frame.stack.push(frame.stack[frame.stack.length - 1])')
  runAllow('ensure-not-null', 'ExpressionStatement', 'frame.stack.push(v)')
  runAllow('ensure-not-null', 'IfStatement', 'v instanceof VeraNullValue')
  runAllow('ensure-not-null', 'VariableDeclarationList', 'v = this.pop(frame)')
  runAllow('jump-if-false', 'ExpressionStatement', 'frame.pc = inst.target')
  runAllow('jump-if-false', 'IfStatement', '!this.asBoolean(this.pop(frame))')
  runAllow('jump', 'ExpressionStatement', 'frame.pc = inst.target')
  runAllow('length', 'ExpressionStatement', 'frame.stack.push(new VeraNumberValue(v.elements.length))',
    'frame.stack.push(new VeraNumberValue(v.value.length))')
  runAllow('length', 'IfStatement', 'v instanceof VeraArrayValue', 'v instanceof VeraStringValue')
  runAllow('length', 'VariableDeclarationList', 'v = this.pop(frame)')
  runAllow('load-capture', 'ExpressionStatement', 'frame.stack.push(this.cell(frame.captures, inst.slot).value)')
  runAllow('load-external', 'ExpressionStatement', 'frame.stack.push(val)', 'this.externalValues.set(key, val)',
    'val = new ExternalFunctionValue(inst.module, inst.name)')
  runAllow('load-external', 'IfStatement', 'val == undefined')
  runAllow('load-external', 'VariableDeclarationList', 'val = this.externalValues.get(key)')
  runAllow('load-field', 'ExpressionStatement', 'frame.stack.push(v)')
  runAllow('load-field', 'IfStatement', 'v == undefined')
  runAllow('load-field', 'VariableDeclarationList', 'obj = this.asObject(this.pop(frame))', 'v = obj.fields.get(inst.name)')
  runAllow('load-function', 'ExpressionStatement', 'frame.stack.push(val)', 'this.functionValues.set(inst.name, val)',
    'val = new FunctionValue(inst.name, [])')
  runAllow('load-function', 'IfStatement', 'val == undefined')
  runAllow('load-function', 'VariableDeclarationList', 'val = this.functionValues.get(inst.name)')
  runAllow('load-index', 'ExpressionStatement', 'frame.stack.push(this.indexValue(arr, idx))')
  runAllow('load-index', 'VariableDeclarationList', 'arr = this.asArray(this.pop(frame))', 'idx = this.index(this.pop(frame))')
  runAllow('load-local', 'ExpressionStatement', 'frame.stack.push(this.cell(frame.locals, inst.slot).value)')
  runAllow('make-array', 'ExpressionStatement', 'frame.stack.push(freshArrayValue(this.take(frame, inst.count)))')
  runAllow('make-closure', 'ExpressionStatement', 'caps.push(this.cell(frame.captures, -c - 1))',
    'caps.push(this.cell(frame.locals, c))', 'frame.stack.push(new FunctionValue(inst.functionName, caps))')
  runAllow('make-object', 'ExpressionStatement', 'fields.set(inst.fields[i], vals[i])',
    'frame.stack.push(freshObjectValue(inst.classIdentity, fields))')
  runAllow('make-object', 'VariableDeclarationList', 'fields = new Map<string, RuntimeValue>()',
    'vals = this.take(frame, inst.fields.length)')
  runAllow('pop', 'ExpressionStatement', 'this.pop(frame)')
  runAllow('push-boolean', 'ExpressionStatement', 'frame.stack.push(new VeraBooleanValue(inst.boolValue))')
  runAllow('push-null', 'ExpressionStatement', 'frame.stack.push(NULL_VALUE)')
  runAllow('push-number', 'ExpressionStatement', 'frame.stack.push(new VeraNumberValue(inst.numValue))')
  runAllow('push-string', 'ExpressionStatement', 'frame.stack.push(new VeraStringValue(inst.value))')
  runAllow('return', 'ReturnStatement', 'this.pop(frame)')
  runAllow('store-capture', 'ExpressionStatement', 'this.storeCell(this.cell(frame.captures, inst.slot), this.pop(frame))')
  runAllow('store-field', 'ExpressionStatement', 'obj.fields.set(inst.name, v)')
  runAllow('store-field', 'IfStatement', '!obj.fields.has(inst.name)')
  runAllow('store-field', 'VariableDeclarationList', 'obj = this.asObject(this.pop(frame))', 'v = this.pop(frame)')
  runAllow('store-index', 'ExpressionStatement', 'arr.elements[idx] = v', 'this.indexValue(arr, idx)')
  runAllow('store-index', 'VariableDeclarationList', 'arr = this.asArray(this.pop(frame))',
    'idx = this.index(this.pop(frame))', 'v = this.pop(frame)')
  runAllow('store-local', 'ExpressionStatement', 'this.storeCell(this.cell(frame.locals, inst.slot), this.pop(frame))')
  runAllow('string-symbols', 'ExpressionStatement', 'chars.push(new VeraStringValue(ch))',
    'frame.stack.push(freshArrayValue(chars))')
  runAllow('string-symbols', 'ForOfStatement', 'Array.from(v.value)')
  runAllow('string-symbols', 'IfStatement', '!(v instanceof VeraStringValue)')
  runAllow('string-symbols', 'VariableDeclarationList', 'v = this.pop(frame)')
  runAllow('unary', 'ExpressionStatement', 'frame.stack.push(this.unary(inst.operator, this.pop(frame)))')
  allow('VirtualMachine.runFrame', 'ExpressionStatement', 'frame.pc += 1')
  allow('VirtualMachine.runFrame', 'VariableDeclarationList', 'inst = frame.fn.instructions[frame.pc]')
  allow('VirtualMachine.runFrame', 'WhileStatement', 'frame.pc < frame.fn.instructions.length')
  allow('VirtualMachine.take', 'ExpressionStatement', 'result.push(frame.stack[i])', 'this.pop(frame)')
  allow('VirtualMachine.take', 'ForStatement', 'i < frame.stack.length')
  allow('VirtualMachine.take', 'IfStatement', 'frame.stack.length < count')
  allow('VirtualMachine.take', 'ReturnStatement', 'result')
  allow('VirtualMachine.take', 'VariableDeclarationList', 'start = frame.stack.length - count')
  allow('VirtualMachine.take', 'WhileStatement', 'frame.stack.length > start')
  allow('VirtualMachine.unary', 'IfStatement', 'value instanceof VeraNumberValue')
  allow('VirtualMachine.unary', 'ReturnStatement', 'new VeraBooleanValue(!this.asBoolean(value))', 'new VeraNumberValue(-value.value)')
  allow('VirtualMachine', 'ClassDeclaration', 'private budgetFrame: Frame | null = null;',
    'private externalValues: Map<string, ExternalFunctionValue> = new Map<string, ExternalFunctionValue>();',
    'private functionValues: Map<string, FunctionValue> = new Map<string, FunctionValue>();')
  allow('<module>', 'VariableDeclarationList',
    'valueBirths: WeakMap<RuntimeValue, number> = new WeakMap<RuntimeValue, number>()',
    'cellBirths: WeakMap<Cell, number> = new WeakMap<Cell, number>()',
    'arrayBirths: WeakMap<RuntimeValue[], number> = new WeakMap<RuntimeValue[], number>()',
    'objectBirths: WeakMap<Map<string, RuntimeValue>, number> = new WeakMap<Map<string, RuntimeValue>, number>()')
  allow('VirtualMachine', 'ClassDeclaration', 'private journal: VmUndoRecord[] = [];')
  allow('VirtualMachine.safetyDiagnostics', 'PropertyAssignment', 'this.journal.length', 'allocationSerial')
  for (const [opcode, kind] of [['array-push', 'push'], ['array-pop', 'pop'], ['store-index', 'index'], ['store-field', 'field']]) {
    runAllow(opcode, 'VariableDeclarationList', `record = new VmUndoRecord('${kind}')`)
    runAllow(opcode, 'ExpressionStatement', 'this.journal.push(record)')
  }
  for (const opcode of ['array-push', 'array-pop', 'store-index']) {
    runAllow(opcode, 'IfStatement', 'this.reserveWrite(arrayBirths.get(arr.elements) || 0)')
    runAllow(opcode, 'ExpressionStatement', 'record.array = arr.elements')
  }
  runAllow('array-push', 'ExpressionStatement', 'record.length = arr.elements.length')
  runAllow('array-pop', 'ExpressionStatement', 'record.index = arr.elements.length - 1', 'record.value = arr.elements[record.index]')
  runAllow('store-index', 'ExpressionStatement', 'record.value = arr.elements[idx]', 'record.index = idx')
  runAllow('store-field', 'IfStatement', 'this.reserveWrite(objectBirths.get(obj.fields) || 0)')
  runAllow('store-field', 'ExpressionStatement', 'record.fields = obj.fields',
    'record.value = obj.fields.get(inst.name) as RuntimeValue', 'record.key = inst.name')
  const sorted = entries => entries.map(entry => JSON.stringify(entry)).sort()
  for (const [owner, signature] of [
    ['EmptyHostEnvironment.invoke', 'invoke(module: string, name: string, _args: RuntimeValue[], _awaited: boolean): RuntimeValue'],
    ['VirtualMachine.execute', 'execute(entry: string, args: RuntimeValue[] = []): RuntimeValue'],
    ['VirtualMachine.executeBudgeted', 'private executeBudgeted(entry: string, args: RuntimeValue[]): RuntimeValue'],
    ['VirtualMachine.run', 'private run(frame: Frame): RuntimeValue'],
    ['VirtualMachine.runFrame', 'private runFrame(frame: Frame): RuntimeValue'],
    ['VirtualMachine.callInst', 'private callInst(frame: Frame, inst: Instruction): void'],
    ['VirtualMachine.unary', 'private unary(op: string, value: RuntimeValue): RuntimeValue'],
    ['VirtualMachine.binary', 'private binary(op: string, left: RuntimeValue, right: RuntimeValue): RuntimeValue'],
    ['VirtualMachine.equal', 'private equal(a: RuntimeValue, b: RuntimeValue): boolean'],
    ['VirtualMachine.pop', 'private pop(frame: Frame): RuntimeValue'],
    ['VirtualMachine.take', 'private take(frame: Frame, count: number): RuntimeValue[]'],
    ['VirtualMachine.asNumber', 'private asNumber(v: RuntimeValue): number'],
    ['VirtualMachine.asBoolean', 'private asBoolean(v: RuntimeValue): boolean'],
    ['VirtualMachine.asArray', 'private asArray(v: RuntimeValue): VeraArrayValue'],
    ['VirtualMachine.asObject', 'private asObject(v: RuntimeValue): VeraObjectValue'],
    ['VirtualMachine.index', 'private index(v: RuntimeValue): number'],
    ['VirtualMachine.indexValue', 'private indexValue(arr: VeraArrayValue, idx: number): RuntimeValue'],
    ['VirtualMachine.cell', 'private cell(vals: Cell[], idx: number): Cell'],
    ['formatRuntimeValue', 'export function formatRuntimeValue(value: RuntimeValue): string'],
    ['encodeRuntimeValue', 'export function encodeRuntimeValue(value: RuntimeValue): Object'],
    ['decodeRuntimeValue', 'export function decodeRuntimeValue(raw: Object): RuntimeValue']
  ]) {
    const declaration = ts.createSourceFile('signature.ts', owner.startsWith('VirtualMachine.') ||
      owner.startsWith('EmptyHostEnvironment.') ? `class Signature { ${signature} {} }` : `${signature} {}`,
    ts.ScriptTarget.ES2020, true)
    assert.equal(declaration.parseDiagnostics.length, 0)
    const node = ts.isClassDeclaration(declaration.statements[0]) ? declaration.statements[0].members[0] : declaration.statements[0]
    allow('signature', owner, signatureText(node, part => printer.printNode(ts.EmitHint.Unspecified, part, declaration)))
  }
  expected.push(['safety-pin', 'VirtualMachine.callInst', tokens('f15207a99dfc492f8d83cf457926bf1ef88db16768305af9a260abcb31f61fc0')])
  for (const [owner, hash] of Object.entries(safetyPins)) expected.push(['safety-pin', owner, tokens(hash)])
  const vmFields = ts.createSourceFile('vm-fields.ts', `class Fields {
    private functions: Map<string, BytecodeFunction> = new Map<string, BytecodeFunction>()
    private functionValues: Map<string, FunctionValue> = new Map<string, FunctionValue>()
    private externalValues: Map<string, ExternalFunctionValue> = new Map<string, ExternalFunctionValue>()
    private host: HostEnvironment
    private maxSteps: number
    private steps: number = 0
    private budgetNow: (() => number) | null = null
    private budgetDeadlineMs: number = 1000
    private budgetStartedAt: number = -1
    private budgetLastNow: number = -1
    private budgetActive: boolean = false
    private budgetFailure: RuntimeTrap | null = null
    private budgetFrame: Frame | null = null
    readonly coverage: 'GRAPH_SLOTS_DEFERRED_INTENTS' = 'GRAPH_SLOTS_DEFERRED_INTENTS'
    private safetyEnabled: boolean = false
    private journalLimit: number = 65536
    private journalCount: number = 0
    private journal: VmUndoRecord[] = []
    private turnBoundary: number = -1
    private pureBoundary: number = -1
    private safetyExecuting: boolean = false
    private safetySettling: boolean = false
    private safetyInvalid: boolean = false
    private safetyViolations: number = 0
    private safetyFailed: boolean = false
    private safetyFailure: RuntimeTrap | null = null
    private turnToken: VmTurnToken | null = null
    private usedTransactions: WeakSet<Object> = new WeakSet<Object>()
  }`, ts.ScriptTarget.ES2020, true)
  for (const field of vmFields.statements[0].members) {
    expected.push(['vm-field', field.name.text, tokens(bodyHash(printer.printNode(ts.EmitHint.Unspecified, field, vmFields)))])
  }
  allow('<module>', 'VariableDeclarationList', 'allocationSerial: number = 0')
  const wanted = sorted(expected)
  const lifecycle = {
    cache: {class: 'D', decision: 'Lazy map inserts occur, including pure calls and rollback; capture-free immutable callable metadata remains interned for VM lifetime. Stable identity preserves function equality; no rollback of cache entries is required'},
    cells: {class: 'B', decision: 'Escaped pre-existing Cells are observable slots and journal by destination age, even when assigned a fresh value'},
    scratch: {class: 'D', decision: 'Fresh Frame stack/pc/locals and per-top-level budget counters are execution scratch, not rollback state; captured Cells are excluded from this exemption'},
    born: {class: 'A', decision: 'Private WeakMaps track wrapper/backing/Cell birth serials; borrowed backings stay old; fresh factories copy and mark backing stores. No public born property is required'}
  }
  assert.deepEqual(Object.values(lifecycle).map(item => item.class), ['D', 'B', 'D', 'A'])
  const cacheProof = text => {
    const tree = ts.createSourceFile('cache-proof.ts', text, ts.ScriptTarget.ES2020, true)
    const cases = new Map()
    const visit = node => {
      if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression) &&
          ['load-function', 'load-external'].includes(node.expression.text) &&
          node.parent.parent.expression.getText(tree) === 'inst.op') cases.set(node.expression.text,
        printer.printNode(ts.EmitHint.Unspecified, node, tree))
      ts.forEachChild(node, visit)
    }
    visit(tree)
    const approved = ts.createSourceFile('cache-approved.ts', `switch (op) {
      case 'load-function': {
        let val = this.functionValues.get(inst.name)
        if (val == undefined) {
          val = new FunctionValue(inst.name, [])
          this.functionValues.set(inst.name, val)
        }
        frame.stack.push(val)
        break
      }
      case 'load-external': {
        let key = \`\${inst.module}::\${inst.name}\`
        let val = this.externalValues.get(key)
        if (val == undefined) {
          val = new ExternalFunctionValue(inst.module, inst.name)
          this.externalValues.set(key, val)
        }
        frame.stack.push(val)
        break
      }
    }`, ts.ScriptTarget.ES2020, true)
    for (const node of approved.statements[0].caseBlock.clauses) assert.equal(cases.get(node.expression.text),
      printer.printNode(ts.EmitHint.Unspecified, node, approved), 'mutation inventory: D cache lifecycle/zero captures')
  }
  const guard = text => {
    cacheProof(text)
    const actual = sorted(inventory(text).map(([owner, context, expression, dispatch]) =>
      [owner, context, tokens(expression), ...(dispatch ? [tokens(dispatch)] : [])]))
    const remaining = [...wanted]
    const extra = []
    for (const entry of actual) {
      const index = remaining.indexOf(entry)
      if (index < 0) extra.push(entry)
      else remaining.splice(index, 1)
    }
    assert.deepEqual({missing: remaining, extra}, {missing: [], extra: []},
      'mutation inventory: protected interpreter surface changed; review required')
  }
  guard(source)
  const replace = (before, after) => {
    assert.equal(source.split(before).length, 2, `mutation probe anchor: ${before}`)
    return source.replace(before, after)
  }
  const reject = (name, before, after) => assert.throws(() => guard(replace(before, after)),
    /mutation inventory:/, name)
  reject('new graph mutation opcode', "case 'array-push': {", "case 'array-clear': {\nthis.asArray(this.pop(frame)).elements.length = 0; break; }\ncase 'array-push': {")
  reject('extra mutation in existing opcode', 'arr.elements.push(v)', 'arr.elements.push(v); arr.elements.reverse()')
  reject('repeated approved mutation', 'arr.elements.push(v)',
    'for (let repeat = 0; repeat < 2; repeat++) { arr.elements.push(v) }')
  reject('conditional approved mutation', 'arr.elements.push(v)', 'if (false) { arr.elements.push(v) }')
  reject('reordered approved mutation', 'arr.elements.push(v)\n          frame.stack.push(new VeraNumberValue(arr.elements.length))',
    'frame.stack.push(new VeraNumberValue(arr.elements.length))\n          arr.elements.push(v)')
  reject('wrapped mutation dispatcher', 'switch (inst.op) {', 'for (let repeat = 0; repeat < 2; repeat++) switch (inst.op) {')
  reject('erased destructured frame alias', 'private checkBudget(): void {',
    'private checkBudget(): void {\nlet {budgetFrame: opaque} = this as Object as {budgetFrame: Object | null}; if (opaque !== null) Object.assign(opaque, {locals: []});')
  reject('storage owner alias', 'private checkBudget(): void {',
    'private checkBudget(): void {\nlet alias = this; Object.assign(alias, {budgetFrame: null});')
  reject('destructured storage owner alias', 'private checkBudget(): void {',
    'private checkBudget(): void {\nlet {budgetFrame: opaque} = this; if (opaque !== null) Object.assign(opaque, {locals: []});')
  reject('storage owner escape', 'private checkBudget(): void {',
    'private checkBudget(): void {\nObject.assign(this, {budgetFrame: null});')
  reject('storage alias', 'arr.elements.push(v)', 'let alias = arr.elements; alias.push(v)')
  reject('destructured storage alias', 'arr.elements.push(v)', 'let {elements: alias} = arr; alias.push(v)')
  reject('erased storage alias escape', 'arr.elements.push(v)', 'leak(arr.elements as Object); arr.elements.push(v)')
  reject('unknown storage property', 'arr.elements.push(v)', 'arr.elements.constructor; arr.elements.push(v)')
  reject('object storage mutator', 'obj.fields.set(inst.name, v)', 'obj.fields.clear(); obj.fields.set(inst.name, v)')
  reject('object storage alias escape', 'obj.fields.set(inst.name, v)',
    'let alias = obj.fields; leak(alias); obj.fields.set(inst.name, v)')
  reject('computed storage assignment', 'arr.elements.push(v)', 'arr["elements"][0] = v; arr.elements.push(v)')
  reject('compound storage assignment', 'arr.elements.push(v)', 'arr.elements.length += 1; arr.elements.push(v)')
  reject('storage deletion', 'arr.elements.push(v)', 'delete arr.elements[0]; arr.elements.push(v)')
  reject('reflective storage mutation', 'arr.elements.push(v)',
    'Object.defineProperty(arr.elements, "0", {value: v}); arr.elements.push(v)')
  reject('cell write outside store cases', 'return vals[idx]', 'vals[idx].value = NULL_VALUE; return vals[idx]')
  reject('cell alias write', 'return vals[idx]', 'let alias = vals[idx]; alias.value = NULL_VALUE; return vals[idx]')
  reject('wrapper metadata write', 'return v as VeraArrayValue', 'v.elements = []; return v as VeraArrayValue')
  reject('function metadata write', 'let fn = this.functions.get(callee.name)',
    'callee.name = "other"; let fn = this.functions.get(callee.name)')
  reject('external function metadata write', 'let result = this.host.invoke(callee.module, callee.funcName, args, inst.awaited)',
    'callee.funcName = "other"; let result = this.host.invoke(callee.module, callee.funcName, args, inst.awaited)')
  reject('capture storage alias', 'frame.stack.push(this.run(new Frame(fn, callee.captures, args)))',
    'let alias = callee.captures; alias.pop(); frame.stack.push(this.run(new Frame(fn, callee.captures, args)))')
  reject('interned function captures a frame Cell', 'new FunctionValue(inst.name, [])', 'new FunctionValue(inst.name, [frame.locals[0]])')
  reject('interned function metadata modified', 'this.functionValues.set(inst.name, val)', 'val.name = "changed"; this.functionValues.set(inst.name, val)')
  reject('wrapper birth mark removed', 'valueBirths.set(this, nextAllocationSerial())', 'nextAllocationSerial()')
  reject('Cell birth mark removed', 'cellBirths.set(this, nextAllocationSerial())', 'nextAllocationSerial()')
  reject('construction-only write changed', 'this.elements = e', 'this.elements = []')
  reject('pure boundary reused from turn', 'this.pureBoundary = pure ? allocationSerial : -1',
    'this.pureBoundary = pure ? this.turnBoundary : -1')
  reject('provenance borrowing promoted', 'arrayBirths.set(e, 0)', 'arrayBirths.set(e, nextAllocationSerial())')
  reject('fresh allocation does not copy', 'let backing = elements.slice()', 'let backing = elements')
  reject('fresh object does not copy', 'let backing = new Map<string, RuntimeValue>(fields)', 'let backing = fields')
  reject('capacity reserved after increment', 'this.journalCount >= this.journalLimit', 'this.journalCount > this.journalLimit')
  reject('pure check disabled', 'born <= this.pureBoundary', 'born < 0')
  reject('journal ordering changed', 'this.reserveJournal()\n    return true', 'return true\n    this.reserveJournal()')
  reject('reverse replay changed', 'let i = this.journal.length - 1; i >= 0; i--', 'let i = 0; i < this.journal.length; i++')
  reject('undo corrupts map order', 'this.fields.set(this.key, this.value)',
    'this.fields.delete(this.key); this.fields.set(this.key, this.value)')
  reject('host reservation bypasses capacity', 'this.reserveJournal()\n  }', 'this.journalCount += 1\n  }')
  reject('global allocation serial reset', 'private checkBudget(): void {',
    'private checkBudget(): void { allocationSerial = 0;')
  reject('new journal field write outside replay', 'private checkBudget(): void {',
    'private checkBudget(): void { this.journal[0].array.length = 0;')
  reject('turn token literal restored', 'let token: VmTurnToken = new VmTurnToken()', 'let token: Object = {}')
  reject('turn token record changed', 'class VmTurnToken {}', 'class VmTurnToken { active: boolean = true }')
  reject('empty host scope no longer safe', 'class EmptyVmHostSafetyScope implements VmHostSafetyScope {\n  accept(): void {}',
    'class EmptyVmHostSafetyScope implements VmHostSafetyScope {\n  accept(): void { throw new Error("unsafe") }')
  for (const action of ['accept', 'rollback', 'discard']) {
    reject(`scope ${action} callback rebound`, `this.${action} = callbacks.${action}`,
      `this.${action} = (): void => { settle(this, '${action}') }`)
    reject(`scope ${action} callback loses receiver`, `${action}(): void { settle(this, '${action}') }`,
      `${action}(): void { settle(callbacks, '${action}') }`)
    reject(`scope ${action} callback uses foreign settlement`, `${action}(): void { settle(this, '${action}') }`,
      `${action}(): void { this.settle(this, '${action}') }`)
    reject(`scope ${action} callback expression restored`, `this.${action} = callbacks.${action}`,
      `this.${action} = function(): void { settle(this, '${action}') }`)
  }
  reject('scope callback action changed',
    "class VmSafetyTurnCallbacks implements VmSafetyTurnScope {\n      accept(): void { settle(this, 'accept') }",
    "class VmSafetyTurnCallbacks implements VmSafetyTurnScope {\n      accept(): void { settle(this, 'rollback') }")
  reject('scope receiver validation removed', "if (receiver !== scope) { throw this.failSafety('R-JOURNAL', 'foreign safety scope receiver') }", '')
  reject('explicit scope record bypassed', 'new VmSafetyTurnScopeRecord(settle)',
    '{ accept(): void {}, rollback(): void {}, discard(): void {} }')
  reject('catch Error typing removed', 'throw e as Error', 'throw e')
  reject('safety disabled by field initializer', 'private safetyEnabled: boolean = false', 'private safetyEnabled: boolean = true')
  reject('sticky host failure unchecked', 'if (this.safetyEnabled) { this.checkSafety() }\n          this.checkBudget()',
    'this.checkBudget()')
  reject('protected signature erased', 'private asArray(v: RuntimeValue): VeraArrayValue',
    'private asArray(v: Object): VeraArrayValue')
  reject('opcode dispatcher changed', 'switch (inst.op)', 'switch (inst.name)')
  guard(source + '\nfunction inventoryBenign(n: number): number { const extra = [n]; extra.push(1); return extra.length; }\n')
  guard(replace('invalid unary operand', 'invalid unary argument'))
  guard(replace('arr.elements.push(v)', 'arr.elements.push( v )'))
}

console.log('smoke-check: ok')
