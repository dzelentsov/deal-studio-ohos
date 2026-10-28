// agent/VeraAgent.ets and agent/VeraBuildRoute.ets without the network: a host that replays recorded sketches and Jev
// answers (tools/vera-harness/compose/) through runAgent -- streamed plan, previews, assembly, compile, first run -- and
// the route's order between the agent and the blocks. The blocks have no network here, so they answer scratch, except
// where a canned section pick stands in for Jev's.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {loadVera} = require('./source-loader')
const {needsOf, asPlan} = require('./needs-lib')
const {AgentHost} = loadVera('agent/AgentHost')
const {AgentRequest, runAgent} = loadVera('agent/VeraAgent')
const route = loadVera('agent/VeraBuildRoute')

const fixture = (label, file) => fs.readFileSync(path.join(__dirname, 'compose', label, file), 'utf8')

// The sketch arrives in pieces, as DeepSeek streams it; Jev answers with the recorded body.
function replayHost(label, {jev = fixture(label, 'jev-answer.json'), cancelled = () => false} = {}) {
  const host = new AgentHost()
  const seen = {status: [], previews: 0, plans: 0, jev: 0}
  host.askPlan = async (system, user, onText) => {
    seen.plans++
    assert.match(system, /JSON plan/)
    const text = asPlan(fixture(label, 'sketch.json'))
    for (let i = 40; i < text.length; i += 40) onText(text.slice(0, i))
    return text
  }
  host.askJev = async body => { seen.jev++; JSON.parse(body); return jev }
  host.status = s => seen.status.push(s)
  host.preview = vbc2 => { assert.ok(vbc2.length > 0); seen.previews++ }
  host.cancelled = cancelled
  return {host, seen}
}

const request = (prompt, widget = false) => Object.assign(new AgentRequest(), {prompt, widget})

;(async () => {
  // Served: a checked program, previews while the plan streamed, and the plan in words for a generation.
  {
    const {host, seen} = replayHost('tip')
    const r = await runAgent(request('tip calculator'), host)
    assert.ok(r.vbc2.length > 0, r.note)
    assert.equal(r.errors, '')
    assert.ok(r.source.includes('function view('))
    assert.ok(seen.previews > 0 && r.previews === seen.previews && r.firstPreviewMs >= 0)
    assert.equal(seen.plans, 1)
    assert.equal(seen.jev, 1)
    assert.deepEqual(seen.status, ['Composing...'])
    assert.match(r.plan, /^A sketch of this app/)
    assert.match(r.note, /^composed: /)
    // Every stage has a party and a time, and what they add up to is no more than the run took.
    assert.ok(r.stages.every(st => ['Model', 'Jev', 'Search', 'Phone', 'You'].includes(st.who) && st.ms >= 50 && st.name.length > 0))
    assert.ok(r.stages.reduce((n, st) => n + st.ms, 0) <= r.ms + r.stages.length, 'stages ' + JSON.stringify(r.stages) + ' in ' + r.ms)
  }
  // A widget says so in its status and is assembled as one.
  {
    const {host, seen} = replayHost('egg')
    const r = await runAgent(request('egg timer', true), host)
    assert.ok(r.vbc2.length > 0, r.note)
    assert.deepEqual(seen.status, ['Sketching the widget...'])
  }
  // Jev does not answer, twice: nothing served by the agent, but the plan is kept for the route's wider holes.
  {
    const {host, seen} = replayHost('tip', {jev: ''})
    const r = await runAgent(request('tip calculator'), host)
    assert.equal(r.vbc2, '')
    assert.equal(r.note, 'Jev did not answer twice')
    assert.equal(seen.jev, 2)
    assert.match(r.plan, /^A sketch of this app/)
  }
  // Jev answers the second time: served.
  {
    const {host} = replayHost('tip')
    const answer = host.askJev
    let calls = 0
    host.askJev = async body => ++calls === 1 ? '' : answer(body)
    const r = await runAgent(request('tip calculator'), host)
    assert.ok(r.vbc2.length > 0, r.note)
    assert.equal(calls, 2)
  }
  // A plan that cannot be used is asked for again with what was wrong quoted, then once with thinking on.
  {
    const {host} = replayHost('tip')
    const good = asPlan(fixture('tip', 'sketch.json'))
    const asks = []
    const replies = ['not json at all', null, good]
    host.askPlan = async (system, user, onText, think) => { asks.push({user, think}); return replies.shift() }
    const r = await runAgent(request('tip calculator'), host)
    assert.ok(r.vbc2.length > 0, r.note)
    assert.equal(r.composed.planTries, 3)
    assert.deepEqual(asks.map(a => a.think), [false, false, true])
    assert.match(asks[1].user, /could not be used: it was not one JSON object in the form asked for: not json at all/)
    assert.match(asks[2].user, /could not be used: there was no answer/)
    const none = replayHost('tip').host
    none.askPlan = async () => 'nope'
    const r2 = await runAgent(request('tip calculator'), none)
    assert.equal(r2.note, 'no usable plan after 3 tries')
  }

  // A need the plan says a ready-made section handles: Jev's section joins the composition's own parts, its content
  // filled by the host (here the catalogue's defaults), and the program is served. Sections alone make a screen too.
  for (const [label, kind, own] of [['sections-tipping', 'key_facts', true], ['sections-beach', 'checklist', false]]) {
    const {host} = replayHost(label)
    let asked = null
    host.fillBlocks = async request => { asked = request; return loadVera('agent/AgentHost').defaultBlockFill(request) }
    const r = await runAgent(request(label), host)
    assert.ok(r.vbc2.length > 0, label + ': ' + r.note)
    assert.deepEqual(r.blocks, [kind])
    assert.deepEqual(asked.kinds, [kind])
    assert.ok(asked.offset > 0)
    assert.ok(asked.compose(r.blockFill.values).includes('function view('))
    assert.match(r.note, new RegExp('sections ' + kind))
    assert.equal(/composed: 0 inputs/.test(r.note), !own, label)
  }
  // Real data with no search: the host refuses the sections, and nothing is served.
  {
    const {host} = replayHost('sections-tipping')
    host.fillBlocks = async () => Object.assign(new (loadVera('SectionFill').BlockFill)(), {failed: 'sections need real data and no search is available'})
    const r = await runAgent(request('tipping'), host)
    assert.equal(r.vbc2, '')
    assert.match(r.note, /no search is available/)
  }

  // The custom section: what nothing else does, written as one block into the program the rest makes, checked like
  // any block, the failing lines quoted back for a repair; a phone call it makes up, or an answer it cannot give, is
  // never served.
  {
    const {CustomRequest, writeSection, parseSection} = loadVera('agent/AgentCustom')
    const c = loadVera('VeraCompose')
    const comp = c.readComposition(fixture('tip', 'jev-answer.json'), c.parseSketch(fixture('tip', 'sketch.json')))
    const section = (functions, view) => '<classes>\n</classes>\n<fields>\nc_count: number = 0\n</fields>\n<functions>\n' + functions +
      '\n</functions>\n<view>\n' + view + '\n</view>'
    const good = section('function c_bump(state: AppState, value: number): AppState {\n  return {c_count: state.c_count + 1__PASSTHROUGH__};\n}',
      'sections.push(ui.Section("content", "", "", [ui.Button("primary", "Count " + ui.numberToString(state.c_count), "c_bump", 0, true)]));')
    const broken = good.replace('state.c_count + 1', 'state.c_cuont + 1')
    const asks = []
    const run = async replies => {
      const request = Object.assign(new CustomRequest(), {needs: ['a counter'], prompt: 'tip calculator with a counter',
        compose: s => c.assembleProgram(comp, [], s)})
      asks.length = 0
      return writeSection(request, 'LANGUAGE', async (system, user, budget, think) => { asks.push({system, user, budget, think}); return replies.shift() })
    }
    assert.equal(parseSection('no tags'), null)
    assert.equal(parseSection(good).stateFields[0].name, 'c_count')
    let r = await run([good])
    assert.ok(r.section !== null && r.attempts === 1, r.failed)
    assert.match(asks[0].system, /^LANGUAGE/)
    assert.match(asks[0].user, /The program so far/)
    assert.match(c.assembleProgram(comp, [], r.section), /return \{c_count: state\.c_count \+ 1, /)
    r = await run([broken, good])
    assert.ok(r.section !== null && r.attempts === 2, r.failed)
    assert.match(asks[1].user, /It failed:[\s\S]*c_cuont/)
    r = await run([good.replace('return {', 'sdk.call("x/y", [], "c_bump");\n  return {'), good])
    assert.equal(r.attempts, 2)
    assert.match(asks[1].user, /sdk\.call/)
    // Compiles and runs, but Jev does not read it as doing a need: asked for again, saying which; still not, the best one is
    // served and only what it misses is reported.
    {
      const {verifyRequest, undone} = loadVera('agent/AgentCustom')
      const request = Object.assign(new CustomRequest(), {needs: ['a counter', 'a photo'], prompt: 'p', compose: s => c.assembleProgram(comp, [], s)})
      const body = JSON.parse(verifyRequest(request, good))
      assert.deepEqual(Object.keys(body.questions), ['does.0', 'does.1'])
      assert.match(body.state, /c_bump/)
      const said = (a, b) => JSON.stringify({answers: {'does.0': {probabilities: {yes: a, no: 1 - a}}, 'does.1': {probabilities: {yes: b, no: 1 - b}}}})
      assert.deepEqual(undone(request, said(0.9, 0.2)), ['a photo'])
      assert.deepEqual(undone(request, ''), [])
      request.verify = async () => said(0.9, 0.2)
      const users = []
      const partial = await writeSection(request, 'L', async (system, user) => { users.push(user); return good })
      assert.ok(partial.section !== null)
      assert.deepEqual(partial.missed, ['a photo'])
      assert.match(partial.failed, /does not do: a photo/)
      assert.equal(partial.attempts, 4)
      assert.match(users[1], /it does not do: a photo/)
      assert.match(body.state, /saved and restored by the phone between visits/)
      let reads = [said(0.9, 0.2), said(0.9, 0.8)]
      request.verify = async () => reads.shift()
      const second = await writeSection(request, 'L', async () => good)
      assert.ok(second.section !== null)
      assert.equal(second.attempts, 2)
    }
    // A need declined on its own is reported as the writer said and not asked for again; the section serves the others.
    {
      const request = Object.assign(new CustomRequest(), {needs: ['a counter', 'a photo'], prompt: 'p', compose: s => c.assembleProgram(comp, [], s)})
      let n = 0
      const part = await writeSection(request, 'L', async () => { n++; return good + '\n<cannot need="a photo">This phone gives apps no camera here.</cannot>' })
      assert.ok(part.section !== null); assert.equal(n, 1)
      assert.deepEqual(part.missed, ['a photo'])
      assert.equal(part.declined.get('a photo'), 'This phone gives apps no camera here.')
    }
    r = await run(['<cannot>it needs the camera</cannot>'])
    assert.equal(r.section, null)
    assert.equal(r.cannot, 'it needs the camera')
    assert.match(r.failed, /cannot: it needs the camera/)
    assert.equal(asks.length, 1)
    // The quick tries and their repairs fail: one more, thinking, with a larger budget; then it is refused.
    r = await run([broken, broken, broken, broken])
    assert.equal(r.section, null)
    assert.equal(r.attempts, 4)
    assert.deepEqual(asks.map(a => a.think), [false, false, false, true])
    assert.ok(asks[3].budget > asks[0].budget)
    r = await run([broken, broken, broken, good])
    assert.ok(r.section !== null && r.thought)
  }

  // Questions: Jev keeps only those a default cannot stand in for; the person's answer, when it differs from the
  // default the plan was drawn for, has the plan drawn again with it; no answer is the default.
  {
    const {blockingRequest, blockingOf, askBlocking} = loadVera('agent/AgentQuestions')
    const c = loadVera('VeraCompose')
    const sketch = c.parseSketch(JSON.stringify({title: 'Converter', inputs: [], values: [], questions: [
      {id: 'units', ask: 'Which units?', options: ['km to miles', 'kg to pounds'], default: 0},
      {id: 'look', ask: 'Which colour?', options: ['blue', 'green'], default: 1},
      {id: 'bad', ask: 'One option only?', options: ['only']}]}))
    assert.equal(sketch.questions.length, 2)
    assert.equal(sketch.questions[1].fallback, 1)
    const body = JSON.parse(blockingRequest('a converter', sketch.questions))
    assert.deepEqual(Object.keys(body.questions), ['blocking.0', 'blocking.1'])
    const jev = (a, b) => async () => JSON.stringify({answers: {'blocking.0': {probabilities: {ask: a, skip: 1 - a}}, 'blocking.1': {probabilities: {ask: b, skip: 1 - b}}}})
    assert.deepEqual(blockingOf(await jev(0.9, 0.1)(), sketch.questions).map(q => q.id), ['units'])
    assert.deepEqual(blockingOf('', sketch.questions), [])
    const shown = []
    let log = []
    let settled = await askBlocking('a converter', sketch.questions, jev(0.9, 0.1), async q => { shown.push(q); return 1 }, log)
    assert.equal(shown.length, 1)
    assert.equal(shown[0].fallback, 0)
    assert.match(settled, /Which units\? kg to pounds/)
    assert.equal(log[0].changed, true)
    log = []
    assert.equal(await askBlocking('a converter', sketch.questions, jev(0.9, 0.1), async () => null, log), '')
    assert.match(log[0].answer, /km to miles \(default\)/)
    // Words the person typed are their own answer, none of the options: the plan is drawn again with them; only blanks are the default.
    log = []
    settled = await askBlocking('a converter', sketch.questions, jev(0.9, 0.1), async () => '  feet to metres ', log)
    assert.match(settled, /Which units\? feet to metres$/)
    assert.equal(log[0].changed, true)
    assert.equal(log[0].answer, 'feet to metres (typed)')
    log = []
    assert.equal(await askBlocking('a converter', sketch.questions, jev(0.9, 0.1), async () => '   ', log), '')
    assert.match(log[0].answer, /km to miles \(default\)/)
    // Through the agent: an answer that differs draws the plan again, with the answer in the request.
    const {host} = replayHost('tip')
    const plans = []
    const askPlan = host.askPlan
    host.askPlan = async (system, user, onText) => {
      plans.push(user)
      if (plans.length === 1) return JSON.stringify(needsOf(Object.assign(JSON.parse(fixture('tip', 'sketch.json')), {questions: [{id: 'q', ask: 'Split it?', options: ['yes', 'no'], default: 0}]}), false))
      return askPlan(system, user, onText)
    }
    const askJev = host.askJev
    host.askJev = async b => JSON.parse(b).questions['blocking.0'] ? jev(0.9, 0)() : askJev(b)
    host.ask = async () => { await new Promise(resolve => setTimeout(resolve, 60)); return 1 }
    const r = await runAgent(request('tip calculator'), host)
    assert.equal(plans.length, 2)
    assert.match(plans[1], /The person was asked, and answered:\n- Split it\? no/)
    assert.equal(r.composed.replanned, true)
    assert.ok(r.vbc2.length > 0, r.note)
    assert.equal(r.asked.length, 1)
    // The time the person took to answer is theirs: measured apart, to be said apart from what the app took.
    assert.ok(r.asked[0].waitedMs >= 50, 'waited ' + r.asked[0].waitedMs)
    assert.equal(r.waitedMs(), r.asked[0].waitedMs)
    assert.ok(r.waitedMs() <= r.ms, 'the wait is part of the run')
    // No question: no wait.
    assert.equal((await runAgent(request('tip calculator'), replayHost('tip').host)).waitedMs(), 0)
  }

  // The route: a served agent ends it.
  const routeRequest = prompt => Object.assign(new route.RouteRequest(), {agent: request(prompt)})
  {
    const {host} = replayHost('tip')
    const o = await route.buildScreen(routeRequest('tip calculator'), host)
    assert.equal(o.kind, route.OUTCOME_AGENT)
  }
  // The agent refuses and there is no model to write the whole screen: the screen is not built, with what the agent said.
  {
    const {host} = replayHost('tip', {jev: ''})
    const o = await route.buildScreen(routeRequest('tip calculator'), host)
    assert.equal(o.kind, route.OUTCOME_NOT_BUILT)
    assert.match(o.reason, /^agent: /)
  }
  {
    const {deepseek} = loadVera('DeepSeekEngine')
    const {settings} = loadVera('SettingsStore')
    settings.getSelectorKey = () => 'test-key'
    settings.hasExaKey = () => false
    let o
    // Something the phone does that nothing here can: the agent serves the rest of its screen with the writer's own
    // sentence as a notice in its place; the blocks are not needed.
    const egg = JSON.parse(fixture('egg', 'jev-answer.json'))
    const effectKey = Object.keys(egg.answers).find(k => k.startsWith('effect.'))
    egg.answers[effectKey] = {choice: 'unavailable', confidence: 0.95}
    {
      const {host} = replayHost('egg', {jev: JSON.stringify(egg)})
      host.language = 'VERA-L'
      const asked = []
      host.askCode = async (system, user) => { asked.push(user); return '<cannot>This phone gives apps no way to vibrate here.</cannot>' }
      o = await route.buildScreen(routeRequest('egg timer that vibrates'), host)
      assert.equal(o.kind, route.OUTCOME_AGENT, o.agent.note)
      assert.equal(asked.length, 1)
      assert.match(o.agent.source, /ui\.InsetBanner\("warning", "Not available on this phone", "This phone gives apps no way to vibrate here\."/)
      assert.match(o.agent.note, /reported on the screen/)
      assert.ok(o.agent.screen.slots.some(s => s.phone && s.fill === 'reported'))
    }
  }
  // Something the phone does that no effect is: the agent leaves it to its section, shown the phone's functions found
  // for it; the section may call only those, and a target it makes up is sent back for a repair.
  {
    const egg = JSON.parse(fixture('egg', 'jev-answer.json'))
    egg.answers[Object.keys(egg.answers).find(k => k.startsWith('effect.'))] = {choice: 'unavailable', confidence: 0.95}
    const alarm = 'com.huawei.hmos.clock/entry/EntryAbility/CreateAlarm'
    const found = JSON.stringify({results: [{kind: 'registry', description: 'creates an alarm',
      call: 'sdk.call("' + alarm + '", ["hour", "7", "minute", "30"], "yourHandlerName", "background")'}]})
    const calling = target => '<classes>\n</classes>\n<fields>\nc_said: string = ""\n</fields>\n<functions>\n' +
      'function c_set(state: AppState, v: number): AppState {\n  sdk.call("' + target + '", ["hour", "7", "minute", "30"], "c_answer", "background");\n' +
      '  return {c_said: "Setting the alarm..."__PASSTHROUGH__};\n}\n' +
      'function c_answer(state: AppState, value: string): AppState {\n  return {c_said: value__PASSTHROUGH__};\n}\n</functions>\n' +
      '<view>\nsections.push(ui.Section("content", "", "", [ui.Button("primary", "Set alarm", "c_set", 0, true), ui.Text("body", state.c_said)]));\n</view>'
    const phoneHost = (replies, lookup) => {
      const {host} = replayHost('egg', {jev: JSON.stringify(egg)})
      const jevPlan = host.askJev
      host.language = 'VERA-L'
      const seen = {systems: [], users: [], lookups: []}
      host.askCode = async (system, user) => { seen.systems.push(system); seen.users.push(user); return replies.length > 1 ? replies.shift() : replies[0] }
      host.lookup = async need => { seen.lookups.push(need); return lookup }
      host.askJev = async body => JSON.parse(body).questions['does.0'] ?
        JSON.stringify({answers: {'does.0': {probabilities: {yes: 0.9, no: 0.1}}}}) : jevPlan(body)
      return {host, seen}
    }
    let {host, seen} = phoneHost([calling(alarm)], found)
    let r = await runAgent(request('egg timer that sets an alarm'), host)
    assert.ok(r.vbc2.length > 0, r.note)
    assert.ok(r.source.includes(alarm))
    assert.equal(seen.lookups.length, 1)
    assert.match(seen.users[0], /Phone functions found/)
    assert.match(seen.systems[0], /calling ONLY targets from/)
    // A need worded as something to do inside the app that the app cannot do is not refused when a function found does the nearest thing.
    assert.match(seen.systems[0], /is not refused if a function found does the nearest useful thing/)
    assert.match(seen.systems[0], /say in a line on the screen what it does instead/)
    assert.doesNotMatch(seen.systems[0], /\bmap\b/i, 'the rule names no request of the test sets')
    assert.ok(r.screen.slots.some(s => s.phone && s.fill === 'hole'), require('util').inspect(r.screen.slots.map(s => s.id + ':' + s.fill + (s.phone ? ':phone' : ''))))
    // A made-up target is sent back, named; the repair that calls the one found is served.
    ;({host, seen} = phoneHost([calling('com.example/clock/Main/SetAlarm'), calling(alarm)], found))
    r = await runAgent(request('egg timer that sets an alarm'), host)
    assert.ok(r.vbc2.length > 0, r.note)
    assert.equal(r.custom.attempts, 2)
    assert.match(seen.users[1], /calls "com\.example\/clock\/Main\/SetAlarm", which is not one of the phone functions found/)
    // Nothing found: no phone calls at all; a section that keeps calling is not served, and the rest of the screen is,
    // with a notice saying it could not be built.
    ;({host, seen} = phoneHost([calling(alarm)], JSON.stringify({results: []})))
    r = await runAgent(request('egg timer that sets an alarm'), host)
    assert.match(seen.systems[0], /never calls sdk\.call/)
    assert.doesNotMatch(seen.systems[0], /nearest useful thing/, 'with no phone function found there is nothing to fall back on')
    assert.doesNotMatch(seen.users[0], /Phone functions found/)
    assert.match(r.note, /calls sdk\.call, which it never may/)
    assert.doesNotMatch(r.source, new RegExp(alarm))
    assert.match(r.source, /ui\.InsetBanner\("warning", "Part of this app could not be built"/)
  }
  // Nothing narrower serves: the whole screen is one hole, written against the sketch and read by Jev against everything
  // it says the screen does, before any generation.
  {
    const screen = '<classes>\n</classes>\n<fields>\nc_bill: number = 50\nc_pct: number = 15\n</fields>\n<functions>\n' +
      'function c_setBill(state: AppState, v: number): AppState {\n  return {c_bill: v__PASSTHROUGH__};\n}\n</functions>\n<view>\n' +
      'sections.push(ui.Section("content", "", "", [ui.Text("body", "Tip: " + ui.numberToString(state.c_bill * state.c_pct / 100))]));\n</view>'
    const wholeHost = (jevDoes, reply = screen) => {
      const {host, seen} = replayHost('tip', {jev: ''})
      const sketchJev = host.askJev
      host.language = 'VERA-L'
      const asks = []
      host.askCode = async (system, user, budget) => { asks.push({user, budget}); return reply }
      host.askJev = async body => {
        const q = JSON.parse(body).questions
        if (!q || !q['does.0']) return sketchJev(body)
        const answers = {}
        for (const k of Object.keys(q)) answers[k] = {probabilities: {yes: jevDoes, no: 1 - jevDoes}}
        return JSON.stringify({answers})
      }
      return {host, asks, seen}
    }
    let {host, asks} = wholeHost(0.9)
    let o = await route.buildScreen(routeRequest('tip calculator', false), host)
    assert.equal(o.kind, route.OUTCOME_AGENT, o.agent.note)
    assert.match(o.agent.source, /c_bill/)
    assert.ok(o.agent.vbc2.length > 0)
    assert.equal(o.agent.whole.attempts, 1)
    assert.match(o.agent.note, /whole screen written in 1 attempt/)
    assert.equal(asks.length, 1)
    assert.ok(asks[0].budget > 3000)
    assert.match(asks[0].user, /your section is the whole screen/)
    assert.ok(o.agent.screen.slots.length > 1 && o.agent.screen.slots.every(s => s.fill === 'hole'))
    assert.match(o.agent.source, /ui\.Header\(/)
    // The screen is one written section, and the record says so: a section can be added beside it.
    assert.deepEqual(o.agent.record.kinds(), ['custom'])
    // Written whole, with no notice: the plan's subtitle stays.
    assert.notEqual(o.agent.screen.globals.get('__SUPPORTING__'), '')
    assert.equal(o.agent.screen.globals.get('__SUPPORTING__'), JSON.parse(fixture('tip', 'sketch.json')).subtitle)
    assert.equal(loadVera('VeraComposition').composeFrom(o.agent.record), o.agent.source)
    // Jev does not read it as doing what the sketch says: not built.
    ;({host} = wholeHost(0.2))
    o = await route.buildScreen(routeRequest('tip calculator', false), host)
    assert.equal(o.kind, route.OUTCOME_NOT_BUILT)
    assert.match(o.agent.note, /whole screen: custom section does not do/)
    // Switched off: not built, without asking the writer.
    route.setWholeScreenEnabled(false)
    ;({host, asks} = wholeHost(0.9))
    o = await route.buildScreen(routeRequest('tip calculator', false), host)
    assert.equal(o.kind, route.OUTCOME_NOT_BUILT)
    assert.equal(asks.length, 0)
    route.setWholeScreenEnabled(true)
  }
  // An assembled program that does not compile is repaired by SEARCH/REPLACE edits to it, checked again; edits that do
  // not apply are asked for once more, and what still fails is said.
  {
    const {repairProgram, checkProgram} = loadVera('agent/AgentRepair')
    const broken = 'import * as ui from "std/ui"\n@jsonable\nclass AppState { n: number; }\nfunction init(): AppState { return {n: 0}; }\n' +
      'function bump(state: AppState, v: number): AppState { return {n: state.n + "1"}; }\n' +
      'function view(state: AppState): ui.View { return ui.AppTheme("clean", "", [ui.Section("content", "", "", [ui.Text("body", ui.numberToString(state.n))])]); }'
    const errors = checkProgram(broken)
    assert.notEqual(errors, '')
    const edit = '<<<<<<< SEARCH\nfunction bump(state: AppState, v: number): AppState { return {n: state.n + "1"}; }\n=======\n' +
      'function bump(state: AppState, v: number): AppState { return {n: state.n + 1}; }\n>>>>>>> REPLACE'
    const asked = []
    let r = await repairProgram(broken, errors, 'a counter', 'VERA-L', async (system, user, budget) => { asked.push({user, budget}); return edit })
    assert.equal(r.failed, '')
    assert.equal(r.rounds, 1)
    assert.match(r.source, /state\.n \+ 1\}/)
    assert.ok(r.vbc2.length > 0)
    assert.match(asked[0].user, /^The program:\n/)
    assert.match(asked[0].user, /SEARCH/)
    const replies = ['<<<<<<< SEARCH\nno such line\n=======\nx\n>>>>>>> REPLACE', edit]
    r = await repairProgram(broken, errors, 'a counter', 'VERA-L', async () => replies.shift())
    assert.equal(r.rounds, 2)
    assert.equal(r.failed, '')
    r = await repairProgram(broken, errors, 'a counter', 'VERA-L', async () => 'no edits here')
    assert.equal(r.source, '')
    assert.notEqual(r.failed, '')
  }
  // Every program served is settled the same way (settleProgram): checked, repaired by edits when a model can be asked, and its
  // bytecode only when it passes. A program that compiles but stops when it draws, or draws nothing, is not served as it is.
  {
    const {settleProgram} = loadVera('agent/AgentRepair')
    const {AgentHost} = loadVera('agent/AgentHost')
    const program = expr => 'import * as ui from "std/ui"\n@jsonable\nclass AppState { n: number; }\nfunction init(): AppState { return {n: 4}; }\n' +
      'function view(state: AppState): ui.View { return ui.AppTheme("clean", "", [ui.Section("content", "", "", [ui.Text("body", ' + expr + ')])]); }'
    const good = program('ui.numberToString(state.n)'), traps = program('ui.numberToString(16 / (state.n - 4))')
    const fix = '<<<<<<< SEARCH\n16 / (state.n - 4)\n=======\n16 / (state.n + 4)\n>>>>>>> REPLACE'
    const hostWith = (ask, language = 'VERA-L') => { const h = new AgentHost(); h.language = language; h.askCode = ask; return h }
    let r = await settleProgram(good, 'a counter', hostWith(null))
    assert.equal(r.errors, ''); assert.ok(r.vbc2.length > 0); assert.equal(r.note, ''); assert.equal(r.repair, null)
    // It stops when it draws and nothing can be asked: not served, and nothing compiled to serve.
    r = await settleProgram(traps, 'a counter', hostWith(null))
    assert.match(r.errors, /division by zero/); assert.equal(r.vbc2, ''); assert.equal(r.repair, null)
    r = await settleProgram(traps, 'a counter', hostWith(async () => fix, ''))
    assert.match(r.errors, /division by zero/, 'no language, no repair')
    // Edits that fix it are served, with the round counted; edits that do not leave what still fails.
    let asked = 0
    r = await settleProgram(traps, 'a counter', hostWith(async () => { asked++; return fix }))
    assert.equal(r.errors, ''); assert.match(r.source, /state\.n \+ 4/); assert.ok(r.vbc2.length > 0)
    assert.equal(r.note, '; repaired by edits in 1 round(s)'); assert.equal(asked, 1); assert.equal(r.repair.rounds, 1)
    r = await settleProgram(traps, 'a counter', hostWith(async () => 'no edits here'))
    assert.match(r.errors, /division by zero/); assert.equal(r.vbc2, ''); assert.match(r.note, /^; repair: /)
    // A screen with nothing on it is a mistake too; a plan's preview with a slot open is not checked for it.
    const empty = 'import * as ui from "std/ui"\n@jsonable\nclass AppState { n: number; }\nfunction init(): AppState { return {n: 0}; }\n' +
      'function view(state: AppState): ui.View { return ui.AppTheme("clean", "", []); }'
    r = await settleProgram(empty, 'a counter', hostWith(null))
    assert.match(r.errors, /drew an empty screen/); assert.equal(r.vbc2, '')
    assert.equal(loadVera('VeraSmoke').smokeRun(loadVera('VeraCompiler').compileVeraSource(empty), false), '')
  }
  // What a section is said to do is read against the screen: a claim it does not meet goes back to the plan to be written.
  {
    const {claimsUndone, putBack} = loadVera('agent/AgentClaims')
    const P = loadVera('ScreenPlan')
    const said = (...yes) => JSON.stringify({answers: Object.fromEntries(yes.map((y, i) => ['does.' + i, {probabilities: {yes: y, no: 1 - y}}]))})
    let body = null
    const missing = await claimsUndone(['calendar button', 'a map'], 'prompt', 'SOURCE', async b => { body = JSON.parse(b); return said(0.9, 0.1) })
    assert.deepEqual(missing, ['a map'])
    assert.match(body.state, /SOURCE/); assert.deepEqual(Object.keys(body.questions), ['does.0', 'does.1'])
    assert.deepEqual(await claimsUndone([], 'p', 's', async () => { throw new Error('asked for nothing') }), [])
    assert.deepEqual(await claimsUndone(['x'], 'p', 's', async () => ''), [])
    const plan = new P.ScreenPlan()
    putBack(plan, ['a map'])
    assert.deepEqual(plan.toWrite().map(x => x.need), ['a map'])
  }
  // What one hole of a request learned is not asked again by the next: a phone need it said it cannot do is reported as
  // it said, and a lookup is made once.
  {
    const {writeHole} = loadVera('agent/AgentHole')
    const P = loadVera('ScreenPlan')
    const host = new (loadVera('agent/AgentHost').AgentHost)()
    host.language = 'VERA-L'
    let writes = 0, lookups = 0
    host.askCode = async () => { writes++; return '<cannot>This phone does not let apps set alarms.</cannot>' }
    host.lookup = async () => { lookups++; return JSON.stringify({results: []}) }
    const recorded = []
    host.onHole = r => recorded.push(r)
    const plan = () => {
      const p = new P.ScreenPlan()
      p.components.push(new P.PlanComponent(P.FILL_PART, null, new Map()))
      p.addToWrite('a', 'set an alarm (the person taps Set)', true)
      p.globals.set('__SUPPORTING__', 'Set an alarm that rings every day')
      return p
    }
    const first = plan()
    await writeHole(first, 'alarm', [], host)
    assert.equal(writes, 1)
    // A notice says it cannot be done: the subtitle that promised it is gone, whether the writer said so or an earlier hole had.
    assert.equal(first.globals.get('__SUPPORTING__'), '')
    const second = plan()
    const r = await writeHole(second, 'alarm', [], host)
    assert.equal(second.globals.get('__SUPPORTING__'), '')
    assert.equal(writes, 1)
    assert.equal(lookups, 1)
    assert.equal(r.cannot, 'This phone does not let apps set alarms.')
    assert.equal(second.slots[0].fill, P.FILL_REPORTED)
    const whole = new P.ScreenPlan()
    whole.addToWrite('a', 'set an alarm (the person taps Set)', true)
    assert.match((await writeHole(whole, 'alarm', [], host)).failed, /known from an earlier hole/)
    assert.equal(writes, 1)
    // Several needs refused together are written apart: the one that can be done is not lost with the one that cannot, and the
    // refusal of the group is not remembered as the refusal of each.
    {
      const section = '<classes>\n</classes>\n<fields>\nc_n: number = 0\n</fields>\n<functions>\nfunction c_go(state: AppState, v: number): AppState {\n  return {c_n: state.c_n + 1__PASSTHROUGH__};\n}\n</functions>\n<view>\nsections.push(ui.Section("content", "", "", [ui.Button("primary", "Go", "c_go", 0, true)]));\n</view>'
      const h = new (loadVera('agent/AgentHost').AgentHost)()
      h.language = 'VERA-L'
      const sawNeeds = []
      h.askCode = async (system, user) => {
        const needs = user.split('The section must do:\n- ')[1].split('\n\n')[0].split('\n- ')
        sawNeeds.push(needs.length)
        return needs.length > 1 ? '<cannot>cannot do all of it</cannot>' : (needs[0] === 'doable' ? section : '<cannot>not on this phone</cannot>')
      }
      h.lookup = async () => JSON.stringify({results: []})
      const p = new P.ScreenPlan()
      p.components.push(new P.PlanComponent(P.FILL_PART, null, new Map()))
      p.addToWrite('a', 'doable', true)
      p.addToWrite('b', 'not doable', true)
      await writeHole(p, 'x', [], h)
      assert.deepEqual(sawNeeds, [2, 1, 1])
      assert.equal(p.slots[0].fill, P.FILL_HOLE)
      assert.equal(p.slots[1].fill, P.FILL_REPORTED)
      assert.equal(h.cannot.has('doable'), false)
      assert.equal(h.cannot.get('not doable'), 'not on this phone')
    }
    // Each hole is recorded with how it ended, for the report of what recurs (hole-report.py).
    assert.deepEqual(recorded.map(r => r.outcome), ['reported', 'known'])
    assert.deepEqual(recorded[0].needs, ['set an alarm (the person taps Set)'])
    assert.deepEqual(recorded[0].phone, [true])
    assert.equal(recorded[0].why, 'This phone does not let apps set alarms.')
  }
  // Nothing asked for: not built, no model call; the caller decides what to do with that.
  {
    const {host, seen} = replayHost('tip')
    const o = await route.buildScreen(new route.RouteRequest(), host)
    assert.equal(o.kind, route.OUTCOME_NOT_BUILT)
    assert.equal(seen.plans, 0)
  }
  // Cancelled before it starts: nothing is asked.
  {
    const {host, seen} = replayHost('tip', {cancelled: () => true})
    const o = await route.buildScreen(routeRequest('tip calculator'), host)
    assert.equal(o.kind, route.OUTCOME_CANCELLED)
    assert.equal(seen.plans, 0)
  }
  console.log('agent-check: ok')
})().catch(e => { console.error(e); process.exit(1) })
