// The needs plan (NeedsPlan.ets): the plan the model writes without knowing the parts or the catalogue, and the Sketch the composer
// reads from it. Every recorded sketch is turned into a needs plan and back: the composer must read the same plan. No network.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {loadVera} = require('./source-loader')
const c = loadVera('VeraCompose')
const np = loadVera('NeedsPlan')

const dir = path.join(__dirname, 'compose')
const labels = fs.readdirSync(dir).filter(l => fs.existsSync(path.join(dir, l, 'sketch.json')))
assert.ok(labels.length >= 10, 'recorded sketches: ' + labels.length)

const {needsOf} = require('./needs-lib')

// What the composer reads of a Sketch: all of it that the later stages look at, as plain data.
const view = s => JSON.parse(JSON.stringify(s, (k, v) => typeof v === 'number' && Number.isNaN(v) ? 'NaN' : v instanceof Map ? [...v] : v))

for (const label of labels) {
  const text = fs.readFileSync(path.join(dir, label, 'sketch.json'), 'utf8')
  const was = c.parseSketch(text)
  assert.ok(was, label + ': the recorded sketch parses')
  const plan = np.parseNeedsPlan(JSON.stringify(needsOf(JSON.parse(text))))
  assert.ok(plan, label + ': the needs plan parses')
  const now = np.sketchFrom(plan)
  assert.ok(now, label + ': the composer reads the plan')
  // Needs are in the order the screen shows them, so what the composer keeps in lists keeps its order inside each list.
  assert.deepEqual(view(now), view(was), label + ': the same plan for the composer')
}
console.log('needs-plan: ' + labels.length + ' recorded sketches survive the round trip')

// The prompt names neither a part nor a section of the catalogue.
for (const word of ['READY', 'ready-made', 'section', 'catalogue', 'entryCount', 'entryTotal', 'part ']) {
  assert.ok(!np.NEEDS_PROMPT.includes(word), 'the needs prompt does not say "' + word + '"')
}
// What the prompt asks for where the first phone run went wrong: a number the request gives is the starting value, a reminder is
// not a countdown, what is written for the request keeps its own counts, labels are short.
for (const rule of [/shown": false for every figure that only feeds another figure/, /steps worked out on the way to it are shown: false/, /that input starts at it/, /never a countdown/, /no figure counts its items/, /three words at most/, /does not say which place, person, thing or period it is about/, /measure seconds or minutes is only for a number counted in seconds or minutes/]) {
  assert.match(np.NEEDS_PROMPT, rule)
}
assert.ok(np.NEEDS_PROMPT.includes('entries.count') && np.NEEDS_PROMPT.includes('clock.remaining'))

// A figure's quantities are found, and an action keeps its moment.
{
  const plan = np.parseNeedsPlan(JSON.stringify({title: 'T', needs: [
    {type: 'entries', label: 'Meals', fields: []},
    {type: 'figure', id: 'avg', label: 'Average', means: 'mean', format: 'plain', formula: 'entries.total / entries.count'},
    {type: 'action', id: 'ping', when: 'when the countdown ends', what: 'beep', on: 'countdown_end'},
    {type: 'action', id: 'odd', when: 'x', what: 'y', on: 'nonsense'},
    {type: 'nonsense', what: 'dropped'}]}))
  assert.deepEqual(plan.needs.map(n => n.type), ['entries', 'figure', 'action', 'action'])
  assert.deepEqual([...plan.needs[1].reads].sort(), ['entries.count', 'entries.total'])
  assert.equal(plan.needs[2].on, 'countdown_end')
  assert.equal(plan.needs[3].on, 'other')
  const sketch = np.sketchFrom(plan)
  assert.equal(sketch.values[0].formula, 'entryTotal / entryCount')
  assert.equal(sketch.list.label, 'Meals')
}
// A second clock or list is not made twice: it goes to `other`, as the composer's own plan does.
{
  const sketch = np.sketchFrom(np.parseNeedsPlan(JSON.stringify({title: 'T', needs: [
    {type: 'countdown', label: 'A', length: 'x'}, {type: 'countdown', label: 'B', length: 'x'}, {type: 'stopwatch', label: 'C'},
    {type: 'entries', label: 'L1'}, {type: 'entries', label: 'L2'}]})))
  assert.equal(sketch.countdown, 'A')
  assert.ok(sketch.other.some(o => /second countdown/.test(o)) && sketch.other.some(o => /second list/.test(o)))
}
// Not a plan: nothing to read.
assert.equal(np.parseNeedsPlan('no json'), null)
assert.equal(np.parseNeedsPlan('{"title": '), null)
console.log('needs-plan-check ok')
// A length of time in words, for what a section is told.
{
  const {lengthWords} = loadVera('VeraCompose')
  assert.equal(lengthWords(7200), '2 hours'); assert.equal(lengthWords(3600), '1 hour'); assert.equal(lengthWords(900), '15 minutes')
  assert.equal(lengthWords(60), '1 minute'); assert.equal(lengthWords(90), '90 seconds'); assert.equal(lengthWords(45), '45 seconds')
}
console.log('needs-plan lengths ok')

// What the request asks for: a quote counts when half its meaning words are the request's.
{
  assert.equal(np.asksFor('10 minute meditation timer with a bell at the end', 'a bell at the end'), true)
  assert.equal(np.asksFor('10 minute meditation timer with a bell at the end', 'plays a bell when time is up'), true, 'a paraphrase that keeps the bell')
  assert.equal(np.asksFor('mood diary', 'sends a daily reminder to log the mood'), false, 'a reminder nobody named')
  assert.equal(np.asksFor('daily medicine reminders', 'reminders every day'), true, 'plural and word order')
  assert.equal(np.asksFor('packing checklist', ''), false, 'an empty quote is not the request\'s')
  // Any language: the quote as it stands, then words, or pairs of characters in a script written without spaces. These quotes were
  // dropped as "not in the request" on the phone, every one copied from it (the requests as typed, typos and all).
  const trip = '旅行计划：我们一家三口要去西湖玩一天，班忙计划行程。可以追问： 粘贴攻略链接， 结合达模型+攻略链接给用户计划行程。'
  assert.equal(np.asksFor(trip, '计划行程'), true, 'Chinese, copied')
  assert.equal(np.asksFor(trip, '粘贴攻略链接，结合达模型+攻略链接给用户计划行程'), true, 'Chinese, copied across punctuation')
  assert.equal(np.asksFor('宝马护理：我宝宝发烧了，37。5度。帮我城建宝宝发热护理卡片与服务', '宝宝发热护理卡片'), true, 'Chinese, inside a clause')
  assert.equal(np.asksFor('除妖：帮我创建一张吃药卡，提醒我每天吃药', '提醒我每天吃药'), true, 'Chinese, the reminder')
  assert.equal(np.asksFor('做一个喝水记录应用，每小时提醒我喝水', '每小时提醒喝水'), true, 'Chinese, not copied exactly')
  assert.equal(np.asksFor('做一个喝水记录应用，每小时提醒我喝水', '每天写一条励志名言'), false, 'Chinese, made up')
  assert.equal(np.asksFor('Таймер на 10 минут, напомни выпить воду', 'напомни выпить воду'), true, 'Russian, copied')
  assert.equal(np.asksFor('Таймер на 10 минут, напомни выпить воду', 'показывай мотивационную цитату'), false, 'Russian, made up')
  assert.equal(np.asksFor('水分補給を記録して、毎時間リマインドして', '毎時間リマインド'), true, 'Japanese')
  assert.equal(np.asksFor('Remind me at 7 to take pills', 'at 7'), true, 'nothing to compare but copied')
  assert.equal(np.asksFor('mood diary', 'at 9'), true, 'nothing to compare: cannot be judged, stays')
  const plan = np.parseNeedsPlan(JSON.stringify({title: 'T', needs: [
    {type: 'content', what: 'a short note', from: 'a short note about doctors'},
    {type: 'content', what: 'items to pack', from: 'packing checklist'},
    {type: 'action', id: 'a', when: 'each day', what: 'sends a reminder', from: ''},
    {type: 'figure', id: 'f', label: 'F', formula: '1'}]}))
  const dropped = np.dropUnasked(plan, 'beach packing checklist')
  assert.equal(dropped.length, 1)
  assert.deepEqual(plan.needs.map(n => n.type), ['content', 'action', 'figure'], 'a need with no quote cannot be judged and stays')
  assert.equal(plan.needs[0].words, 'items to pack')
}
// A figure that is a step is worked out and not shown.
{
  const comp = (() => {
    const sketchJson = JSON.parse(fs.readFileSync(path.join(dir, 'mortgage', 'sketch.json'), 'utf8'))
    const body = fs.readFileSync(path.join(dir, 'mortgage', 'jev-answer.json'), 'utf8')
    const sketch = c.parseSketch(JSON.stringify(sketchJson))
    return c.readComposition(body, sketch, false)
  })()
  const step = comp.sketch.values.find(v => comp.bindings.has(v.id))
  const label = step.label
  assert.ok(c.assembleProgram(comp).includes('"' + label + '"'), 'shown by default')
  step.hidden = true
  const source = c.assembleProgram(comp)
  assert.ok(!source.includes('"' + label + '"'), 'a hidden figure is not shown')
  assert.equal(np.parseNeedsPlan(JSON.stringify({title: 'T', needs: [{type: 'figure', id: 'x', label: 'X', shown: false, formula: '1'}]})) && np.sketchFrom(np.parseNeedsPlan(JSON.stringify({title: 'T', needs: [{type: 'figure', id: 'x', label: 'X', shown: false, formula: '1'}]}))).values[0].hidden, true)
}
console.log('needs-plan quotes and hidden figures ok')

// A text cut to its limit is cut at the end of a word, and no small word is left hanging.
{
  const {cutAtWord, escapeForVeraString} = loadVera('VeraTemplateContent')
  assert.equal(cutAtWord('Nanjing Road Pedestrian Street', 28), 'Nanjing Road Pedestrian')
  assert.equal(cutAtWord('Lujiazui skyline and Shanghai', 28), 'Lujiazui skyline')
  assert.equal(cutAtWord('Yu Garden', 28), 'Yu Garden', 'short enough: as it is')
  assert.equal(cutAtWord('Pneumonoultramicroscopicsilicovolcanoconiosis', 28), 'Pneumonoultramicroscopicsili', 'one long word: cut where it is')
  assert.equal(cutAtWord('Old Town and the Harbour Quarter walk', 20), 'Old Town', 'the small words left at the cut go too')
  assert.equal(escapeForVeraString('A "very" long place name that goes on', 12), 'A \\"very\\"')
}
// What the model is told of a figure it writes: a time of day is not a number.
{
  const comp = c.readComposition(fs.readFileSync(path.join(dir, 'mortgage', 'jev-answer.json'), 'utf8'), c.parseSketch(JSON.stringify({title: 'T',
    inputs: [{id: 'a', label: 'A', kind: 'count', min: 0, max: 9, value: 1}],
    values: [{id: 'leave', label: 'Leave', means: 'when to leave', format: 'time_of_day', formula: 'a * 2', example: {given: {a: 1}, result: 2}}]})), false)
  assert.ok(comp.custom.some(t => /^the figure "Leave": when to leave \(a time of day: show it as hh:mm/.test(t)), comp.custom.join(' / '))
  assert.ok(comp.custom.some(t => /\(the plan works it out as a \* 2; for a = 1 that is 2\)$/.test(t)), 'the plan\'s own formula goes with it: ' + comp.custom.join(' / '))
}
console.log('needs-plan words and forms ok')
