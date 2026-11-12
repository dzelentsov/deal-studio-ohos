// The game route (agent/AgentSurface.ets) with a mocked model: which requests ask the question, how the answer is read,
// that a game is written on a ui.Surface and served only once it compiles and plays, that a broken one is repaired by
// edits against the play check, that a "no" goes on to the agent, and that the guide's own example plays.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {loadVera} = require('./source-loader')
const S = loadVera('agent/AgentSurface')
const {AgentHost} = loadVera('agent/AgentHost')
const route = loadVera('agent/VeraBuildRoute')
const {AgentRequest} = loadVera('agent/VeraAgent')
const {compileVeraSource} = loadVera('VeraCompiler')
const {playSurface} = loadVera('VeraSurfacePlay')

const rawfile = name => fs.readFileSync(path.join(__dirname, '../../entry/src/main/resources/rawfile', name), 'utf8').replace(/\r\n/g, '\n')
const guide = rawfile('vera-surface-skill.txt')
const language = rawfile('vera-skill.txt')
const example = guide.slice(guide.indexOf('--- EXAMPLE ---') + '--- EXAMPLE ---'.length, guide.indexOf('--- END EXAMPLE ---')).trim()

// The guide's example is the program the model copies its structure from: it must compile, run and play.
assert.equal(S.checkSurfaceProgram(example), '', 'the guide\'s example compiles, runs once and plays')
const catchSource = fs.readFileSync(path.join(__dirname, 'examples/surface-catch.vera'), 'utf8').replace(/\r\n/g, '\n')
assert.equal(example.trim(), catchSource.slice(catchSource.indexOf('@jsonable')).trim(),
'the guide carries examples/surface-catch.vera as it is (regenerate the rawfile when the example changes)')

// The gate: game words ask, everything else goes straight to the agent.
for (const p of ['neon arkanoid', 'tank battle', 'a snake game', 'bouncing balls with gravity', 'a drawing pad for kids', 'fireworks animation'])
  assert.ok(S.looksLikeSurface(p), p + ' is asked about')
for (const p of ['a to-do list', 'tic-tac-toe', 'water reminder every 2 hours', 'split the bill between friends', 'pomodoro timer'])
  assert.ok(!S.looksLikeSurface(p), p + ' is not asked about')
for (const p of ['帮我做一个小时候红白机风格的坦克大战', '霓虹打砖块', '贪吃蛇小游戏', '儿童画板'])
  assert.ok(S.looksLikeSurface(p), p + ' is asked about')
for (const p of ['帮我创建一张吃药卡，提醒我每天吃药', '西湖一日游', '成绩和绩点计算器'])
  assert.ok(!S.looksLikeSurface(p), p + ' is not asked about')

// Reading the answer.
assert.equal(S.parseSurfaceBrief('{"surface": true, "title": "T", "design": "D"}').design, 'D')
assert.equal(S.parseSurfaceBrief('noise {"surface": false, "title": "", "design": ""} noise').kind, S.SURFACE_NONE)
assert.equal(S.parseSurfaceBrief('{"surface": true, "title": "T", "design": ""}'), null, 'a game with no design is not an answer')
assert.equal(S.parseSurfaceBrief('not json'), null)

// The language: the catalogue is the surface's few components and std/gfx, the guide replaces the screen-composition advice.
const system = S.surfaceLanguage(language, guide)
assert.ok(system.includes('ui.Surface(style, width, height, draw, frame, pointer)') && system.includes('gfx.polygon(points, color)'))
assert.ok(system.includes('FULL-CANVAS APPS') && system.includes('Clock -- time.') && system.includes('Syntax rules:'))
assert.ok(!system.includes('ui.Hero(') && !system.includes('Use ui.Hero when'), 'no catalogue or advice for screens of sections')
assert.ok(!system.includes('{{UI_CATALOG}}'))
assert.equal(S.sourceIn('```vera\nabc\n```\ntrailing'), 'abc')
assert.equal(S.sourceIn('abc'), 'abc')

// The play check refuses a surface that never moves, one that traps mid-game, and a program with no surface.
const still = example.replace('if (state.phase !== "playing") {\n    if (p.phase !== "down") {', 'if (true) {\n    if (true) {')
assert.match(playSurface(compileVeraSource(still)), /nothing on the surface changed/, 'a game that never starts is refused')
const trapping = example.replace('let dt: number = math.min(elapsedMs, 50) / 1000;',
  'let dt: number = math.min(elapsedMs, 50) / 1000;\n  if (state.stars.length() > 1) { let none: Star[] = []; dt = none[1].y; }')
assert.match(playSurface(compileVeraSource(trapping)), /^\d+:1 R\d+ The program compiled, but stopped in onFrame at frame \d+/, 'a trap mid-game says where')
assert.match(playSurface(compileVeraSource('@jsonable class AppState { n: number; }\nfunction init(): AppState { return {n: 0}; }\n' +
  'function view(state: AppState): ui.View { return ui.AppTheme("clean", "", [ui.Text("body", "hi"), ui.Text("body", "there")]); }')),
/draws no ui.Surface/)

// The route, with a mocked model.
function mockHost(answers) {
  const h = new AgentHost()
  h.language = language
  h.surfaceGuide = guide
  h.calls = {plan: [], code: []}
  h.askPlan = async (systemPrompt, user) => {
    h.calls.plan.push(systemPrompt === S.SURFACE_CLASSIFY_PROMPT ? 'surface' : 'needs')
    if (systemPrompt !== S.SURFACE_CLASSIFY_PROMPT) h.calls.needsUser = user
    return systemPrompt === S.SURFACE_CLASSIFY_PROMPT ? answers.brief : null
  }
  h.askCode = async (systemPrompt, user, budget, think) => {
    h.calls.code.push({think, repair: user.includes('SEARCH'), system: systemPrompt})
    return answers.code.shift() ?? null
  }
  return h
}
const request = prompt => Object.assign(new route.RouteRequest(), {agent: Object.assign(new AgentRequest(), {prompt})})
const brief = JSON.stringify({surface: true, title: 'Star Catch', design: 'Catch falling stars with a basket you drag.'})

;(async () => {
  // A game: designed, written, checked, served without the agent.
  let host = mockHost({brief, code: ['```vera\n' + example + '\n```']})
  let outcome = await route.buildScreen(request('a game where I catch falling stars'), host)
  assert.equal(outcome.kind, route.OUTCOME_AGENT, 'the game is served')
  assert.equal(outcome.agent.source, example)
  assert.ok(outcome.agent.vbc2.length > 0)
  assert.deepEqual(host.calls.plan, ['surface'], 'the agent\'s plan is never drawn for a game')
  assert.equal(host.calls.code.length, 1)
  assert.ok(host.calls.code[0].system.includes('FULL-CANVAS APPS'), 'the writer is shown the guide')
  assert.match(outcome.agent.note, /written in 1 attempt\(s\), 0 repair round\(s\)/)

  // A game written with a mistake is repaired by edits against the play check.
  const broken = example.replace('let dt: number = math.min(elapsedMs, 50) / 1000;', 'let dt: number = math.min(elapsedMs, 50) / 1000 + nope;')
  const edit = '<<<<<<< SEARCH\n  let dt: number = math.min(elapsedMs, 50) / 1000 + nope;\n=======\n  let dt: number = math.min(elapsedMs, 50) / 1000;\n>>>>>>> REPLACE'
  host = mockHost({brief, code: [broken, edit]})
  outcome = await route.buildScreen(request('a game where I catch falling stars'), host)
  assert.equal(outcome.kind, route.OUTCOME_AGENT, 'the repaired game is served')
  assert.equal(outcome.agent.source, example)
  assert.match(outcome.agent.note, /1 repair round/)

  // Nothing that plays: written twice (the second with thinking), then not built, and the agent is not asked.
  host = mockHost({brief, code: [still, 'no edits', 'no edits', still, 'no edits', 'no edits']})
  outcome = await route.buildScreen(request('a game where I catch falling stars'), host)
  assert.equal(outcome.kind, route.OUTCOME_NOT_BUILT)
  assert.match(outcome.reason, /not built \(.*\) in 2 attempt/)
  assert.deepEqual(host.calls.code.filter(c => !c.repair).map(c => c.think), [false, true], 'the second program is written with thinking on')
  assert.deepEqual(host.calls.plan, ['surface'])

  // The model says it is not a game: the agent builds it, as before.
  host = mockHost({brief: JSON.stringify({surface: false, title: '', design: ''}), code: []})
  const told = request('score keeper for a board game')
  outcome = await route.buildScreen(told, host)
  assert.equal(told.agent.sceneAllowed, false, 'a "no" keeps the plan from making a scene')
  assert.deepEqual(host.calls.plan.slice(0, 2), ['surface', 'needs'], 'a "no" goes on to the agent\'s plan')
  assert.ok(host.calls.code.every(c => !c.system.includes('FULL-CANVAS APPS')), 'and the game writer is not asked')

  // Part of the screen is drawn: the agent builds it, and its plan is told of the scene.
  host = mockHost({brief: JSON.stringify({surface: 'part', title: '', design: '', scene: 'a roulette wheel the ball lands on'}), code: []})
  outcome = await route.buildScreen(request('virtual casino roulette: bets and the bank are forms, with the wheel and ball animated'), host)
  assert.deepEqual(host.calls.plan.slice(0, 2), ['surface', 'needs'], 'a part goes on to the agent\'s plan')
  assert.match(host.calls.needsUser, /need of type scene: a roulette wheel the ball lands on/)
  assert.ok(host.calls.code.every(c => !c.system.includes('FULL-CANVAS APPS')), 'and the game writer is not asked')

  // No game words: not even asked. No guide on the host, or switched off: not asked either.
  host = mockHost({brief, code: []})
  await route.buildScreen(request('a to-do list'), host)
  assert.equal(host.calls.plan[0], 'needs')
  host = mockHost({brief, code: []}); host.surfaceGuide = ''
  await route.buildScreen(request('tank battle'), host)
  assert.equal(host.calls.plan[0], 'needs')
  S.setSurfaceRouteEnabled(false)
  host = mockHost({brief, code: []})
  await route.buildScreen(request('tank battle'), host)
  assert.equal(host.calls.plan[0], 'needs')
  S.setSurfaceRouteEnabled(true)

  // A chat widget is never a game screen.
  host = mockHost({brief, code: []})
  await route.buildScreen(Object.assign(new route.RouteRequest(), {agent: Object.assign(new AgentRequest(), {prompt: 'tank battle', widget: true})}), host)
  assert.equal(host.calls.plan[0], 'needs')

  console.log('surface-route-check ok')
})().catch(e => { console.error(e); process.exit(1) })
