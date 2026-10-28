/**
 * The plan of a new screen as the model writes it when it knows nothing of how the screen will be built: the needs of the
 * request, in words, by what each does and whose data it is -- never by the part or the section of the catalogue that will do it.
 * NeedsChoose.ets chooses those; sketchFrom here turns the plan and the choices into the Sketch the composer reads
 * (VeraCompose.ets), so everything after the plan is as it was.
 *
 * The prompt names no section and no part. What it does say of a countdown, a stopwatch and entries is what the person sees,
 * which a part and a section of the catalogue both give.
 */

import { Sketch, parseSketch } from './VeraCompose'

export const NEED_FIGURE: string = 'figure'
export const NEED_COUNTDOWN: string = 'countdown'
export const NEED_STOPWATCH: string = 'stopwatch'
export const NEED_ENTRIES: string = 'entries'
export const NEED_CONTENT: string = 'content'
export const NEED_ACTION: string = 'action'
export const NEED_OTHER: string = 'other'
const NEED_TYPES: string[] = [NEED_FIGURE, NEED_COUNTDOWN, NEED_STOPWATCH, NEED_ENTRIES, NEED_CONTENT, NEED_ACTION, NEED_OTHER]

/** The moments an action can be tied to, for the choice of what does a need (NeedsChoose.ets). */
export const ON_END: string = 'countdown_end'
export const ON_ADDED: string = 'entry_added'
export const ON_TAP: string = 'row_tap'
export const ON_BUTTON: string = 'button'
export const ON_TIME: string = 'time'
const ON_MOMENTS: string[] = [ON_END, ON_ADDED, ON_TAP, ON_BUTTON, ON_TIME, 'other']

/**
 * The numbers a screen's time and entries give a formula, under names that mean the same whoever gives them. The composer
 * reads them under its own (right-hand) names.
 */
const QUANTITIES: string[][] = [['clock.remaining', 'remaining'], ['clock.elapsed', 'elapsed'], ['clock.duration', 'duration'],
  ['entries.count', 'entryCount'], ['entries.total', 'entryTotal']]

export class Need {
  /** One of NEED_TYPES. */
  type: string = NEED_OTHER
  /** The need's own words: what it is, for the question of what does it. */
  words: string = ''
  /** The need as the composer's plan holds it (VeraCompose.ets's parseSketch reads these fields): a figure, a countdown, ... */
  raw: Record<string, Object> = {}
  /** For an action: the moment it is tied to. */
  on: string = ''
  /** For a figure: the quantities it reads (clock.remaining, entries.count, ...). */
  reads: string[] = []
  /** For a countdown: the id the plan says sets its length. */
  length: string = ''
  /** For content and an action: the words of the request that ask for it, as the model quoted them. */
  from: string = ''
}

export class NeedsPlan {
  /** Title, eyebrow, subtitle, inputs, constants, questions: as the composer's plan has them. */
  base: Record<string, Object> = {}
  needs: Need[] = []
}

/**
 * What the model is asked. The rules are the composer's own for numbers, times and units: they are what keeps a formula
 * checkable, and they do not depend on who does the work.
 */
export const NEEDS_PROMPT: string =
  'You turn a request for a small phone app into a JSON plan of what the app needs. Write no code. Answer with one JSON object:\n' +
  '{"title": short app title, "eyebrow": 1-3 word label in capitals, "subtitle": one short line,\n' +
  ' "inputs": [{"id": camelCase, "label": shown label, "kind": "amount" | "percent" | "count" | "choice" | "toggle" | "text" | "time",\n' +
  '   "measure": "money" | "percent" | "count" | "seconds" | "minutes" | "number", "min": number, "max": number, "value": starting number, "unit": the currency or unit the request uses, or "",\n' +
  '   "options": only for choice: [{"label": shown text, "value": the number the option stands for, such as a length of time}];\n' +
  '   a choice\'s own "value" is the index of the starting option}],\n' +
  ' "constants": [{"id": camelCase, "label": what it is, "value": number, "measure": as for inputs}],\n' +
  ' "needs": [one object for each thing the app shows or does beyond inputs and constants, in the order the screen shows them, each of one type:\n' +
  '   {"type": "figure", "id": camelCase, "label": shown label, "means": what the number is, in plain words,\n' +
  '    "format": "money" | "percent" | "count" | "seconds" | "minutes" | "time_of_day" | "fraction" | "plain", "unit": as for inputs,\n' +
  '    "decimals": for a plain number, how many digits after the point to show, 0 to 6, only when one digit would lose what matters,\n' +
  '    "shown": false for every figure that only feeds another figure and is not what the request names, however informative it looks; otherwise leave it out,\n' +
  '    "formula": how it is worked out, as an expression over the ids of inputs, constants, the figures before it and the quantities below,\n' +
  '    with numbers, + - * / %, parentheses and floor, ceil, round, abs, min, max, pow, sqrt,\n' +
  '    "example": {"given": {each id or quantity the formula needs, directly or through the figures before it: a sample number},\n' +
  '    "result": the number the formula gives for them}},\n' +
  '   {"type": "countdown", "label": what is being timed, "length": the id of the input, constant or figure that sets how long it runs},\n' +
  '   {"type": "stopwatch", "label": what is being timed},\n' +
  '   {"type": "entries", "label": what the entries are, "fields": what each entry holds, up to 4: [{"id": camelCase, "label": shown label,\n' +
  '    "kind": "text" | "number" | "time" | "toggle", "measure": for a number, as for inputs, "unit": as for inputs, "value": starting value,\n' +
  '    "decimals": for a plain number, as for a figure}] (no fields when adding an entry takes only a tap)},\n' +
  '   {"type": "content", "what": in plain words everything the need involves: what it lists or shows, what the person does with it, what the phone does,\n' +
  '    "from": the words of the request that ask for it, copied exactly},\n' +
  '   {"type": "action", "id": camelCase, "when": the moment, "what": what the phone does, "asked": true if the request asks for it, false if you add it,\n' +
  '    "on": "countdown_end" | "entry_added" | "row_tap" | "button" | "time" | "other",\n' +
  '    "from": the words of the request that ask for it, copied exactly},\n' +
  '   {"type": "other", "what": a few words}],\n' +
  ' "questions": [at most 2, usually none: {"id": camelCase, "ask": a short question for the person, "options": 2 to 4 short answers,\n' +
  '   "default": the index of the answer this plan assumes}]}\n' +
  'What each type brings with it, so it is never listed again: a countdown, start, stop and reset buttons and the time left; ' +
  'a stopwatch, start, stop and reset buttons and the time passed; entries, a form with its fields, an add button, the list of entries ' +
  'with their fields and the time each was added, a way to remove one, and how many there are and what their first number adds up to; ' +
  'when the phone does something as an entry is added, that entry shows what the phone answered. ' +
  'The quantities a figure may read: entries.count and entries.total (the first number field of the entries added up) when there are entries; ' +
  'clock.remaining, clock.elapsed and clock.duration, in seconds, when there is a countdown; clock.elapsed, in seconds, when there is a stopwatch. ' +
  'The app keeps its state between visits.\n' +
  'Rules: inputs are only what the person sets once for the whole screen; what each entry holds goes in its fields. ' +
  'content is what the app starts with, written for the request: items, places, steps, facts or figures that anyone could look up or suggest. ' +
  'What the person keeps themselves -- their notes, entries, records, contacts or messages -- is never content: it starts empty, and is entries. ' +
  'Everything a need brings -- its items, its buttons, what the phone does from them, its counts -- belongs to that need alone: ' +
  'it is never also an input, a figure, an action or an other. ' +
  'A time of day (an input or field of kind time, a figure of format time_of_day) is minutes since midnight, 07:30 being 450; ' +
  'a length of time, such as time left or a pace, is never a time of day. constants are fixed numbers the app needs and the person does not set. ' +
  'figures are every number the request asks to show, in an order where each can be worked out from inputs, constants, the quantities above ' +
  'and the figures before it, in one step: two numbers added, subtracted, multiplied or divided, a percent of a number, one number as a percent ' +
  'of another, a number rounded up, or one number divided by another and rounded up. A number that takes more steps gets a figure for each step ' +
  'before it. A progress bar is a figure with format fraction. A formula gives its figure in the figure\'s format: seconds or minutes as the format says, ' +
  'minutes since midnight for time_of_day, 0 to 100 for percent, 0 to 1 for fraction; in a formula a choice\'s id stands for its chosen option\'s value. ' +
  'A length of time is in seconds, option values, constants and figures included (it is shown as m:ss); only a number the person types in minutes is in minutes, ' +
  'and its measure says so. ' +
  'actions are things the phone does outside this screen, one per action: a detail of an action, such as its reminder or its repeat, belongs in that action, ' +
  'and showing something on this screen is never an action; every number an action needs, such as how many minutes before a reminder goes off, is an input, ' +
  'a field or a constant (a reminder whose lead time the request does not name is a constant of 0 minutes, so it goes off at the start), and every time of day ' +
  'it needs, such as when it starts, is a time input or a time field, even when the request does not name it. ' +
  'other lists everything the request asks for that no type above covers; it is empty only when nothing is left out. Leaving a requested feature out of the plan is wrong. ' +
  'Keep to what the request asks for: no inputs, figures or actions it does not need. ' +
  'Where the request gives a number for something the person sets (a length of time, an amount, a count), that input starts at it, ' +
  'and a choice among several values has that one among its options and starts on it. ' +
  'A countdown or a stopwatch is for a length of time the person starts and watches run: a reminder, an alarm or a notification is an action ' +
  'the phone does at its time, never a countdown, and the time left until it is not shown unless the request asks for it. ' +
  'entries are only records the person keeps and adds to; items the request names for the person to tick off or read are content, ' +
  'never also entries. What is written for the request (content) shows its own progress and counts: no figure counts its items, ' +
  'and entries.count and entries.total are only for entries the person adds. ' +
  'A need that only helps fill in another need, such as a list of choices for a field, belongs to that need and is not a need of its own. ' +
  'Labels are short: three words at most. ' +
  'When the request does not say which place, person, thing or period it is about and what the app shows depends on it, that goes first in questions ' +
  '(not units, looks or anything a default does well): the app is made for the answer, and the person is not made to type it into the app for ' +
  'content the app has to look up. ' +
  'A number of hours or days is measure number with its unit written in unit (hours, days): measure seconds or minutes is only for a number counted in seconds or minutes. ' +
  'The screen shows what the request names; the steps worked out on the way to it are shown: false. ' +
  'A content or action need is written only when the request itself asks for it, in words you can quote: a note, a tip, an example, ' +
  'a reminder or a notification the request does not name is not written, however useful it would be. ' +
  'Use the numbers the request gives; where it gives none, pick sensible ones. ' +
  'questions are only for what the request leaves out and no sensible choice can stand in for, because the answer changes ' +
  'what the app is (which two units a converter is between, which kind of thing a tracker keeps); never for a number, a ' +
  'label, a look or anything a default does well. The plan is drawn for each question\'s default answer.'

function text(o: Record<string, Object>, key: string): string {
  let v = o[key]
  return typeof v === 'string' ? (v as string).trim() : ''
}

/** The quantities of QUANTITIES a formula (or the sample numbers of its example) names. */
function quantitiesIn(raw: Record<string, Object>): string[] {
  let found: string[] = []
  let formula = text(raw, 'formula')
  for (let q of QUANTITIES) { if (formula.indexOf(q[0]) >= 0 && found.indexOf(q[0]) < 0) { found.push(q[0]) } }
  return found
}

/** A formula, or the names of an example's sample numbers, with the quantities under the composer's own names. */
function composerNames(s: string): string {
  let out = s
  for (let q of QUANTITIES) { out = out.split(q[0]).join(q[1]) }
  return out
}

/** The plan from the model's reply, or null when it is not one. */
export function parseNeedsPlan(reply: string): NeedsPlan | null {
  let start = reply.indexOf('{')
  let end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) { return null }
  let o: Record<string, Object>
  try {
    o = JSON.parse(reply.substring(start, end + 1)) as Record<string, Object>
  } catch (_e) {
    return null
  }
  let plan = new NeedsPlan()
  let keep: string[] = ['title', 'eyebrow', 'subtitle', 'inputs', 'constants', 'questions']
  for (let key of keep) { if (o[key] !== undefined) { plan.base[key] = o[key] } }
  let needs = o['needs']
  if (!Array.isArray(needs)) { return plan }
  for (let item of needs as Object[]) {
    if (item === null || typeof item !== 'object') { continue }
    let raw = item as Record<string, Object>
    let type = text(raw, 'type')
    if (NEED_TYPES.indexOf(type) < 0) { continue }
    let need = new Need()
    need.type = type
    need.raw = raw
    if (type === NEED_FIGURE) {
      need.words = text(raw, 'label') + (text(raw, 'means').length > 0 ? ' (' + text(raw, 'means') + ')' : '')
      need.reads = quantitiesIn(raw)
    } else if (type === NEED_COUNTDOWN || type === NEED_STOPWATCH || type === NEED_ENTRIES) {
      need.words = text(raw, 'label')
      need.length = text(raw, 'length')
    } else if (type === NEED_ACTION) {
      need.words = text(raw, 'when') + ': ' + text(raw, 'what')
      need.on = ON_MOMENTS.indexOf(text(raw, 'on')) >= 0 ? text(raw, 'on') : 'other'
      need.from = text(raw, 'from')
    } else {
      need.words = text(raw, 'what')
      if (type === NEED_CONTENT) { need.from = text(raw, 'from') }
    }
    plan.needs.push(need)
  }
  return plan
}

/** The first need of a type, or null. One countdown, one stopwatch and one list of entries make a screen: a second is left to `other`. */
export function needOf(plan: NeedsPlan, type: string): Need | null {
  for (let n of plan.needs) { if (n.type === type) { return n } }
  return null
}

/**
 * The composer's plan for this one: each need as its own field. A need the choices give to a section of the catalogue is
 * a `ready` need (NeedsChoose.ets puts Jev's answer for it where readComposition looks); the others are as the plan wrote them.
 * Null when the composer cannot read the result.
 */
export function sketchFrom(plan: NeedsPlan): Sketch | null {
  let o: Record<string, Object> = {}
  Object.keys(plan.base).forEach((key: string) => { o[key] = plan.base[key] })
  let values: Object[] = []
  let events: Object[] = []
  let ready: Object[] = []
  let other: Object[] = []
  for (let n of plan.needs) {
    let r: Record<string, Object> = {}
    Object.keys(n.raw).forEach((key: string) => { r[key] = n.raw[key] })
    if (n.type === NEED_FIGURE) {
      r['formula'] = composerNames(text(r, 'formula'))
      let example = r['example']
      if (example !== null && example !== undefined && typeof example === 'object') {
        let e = example as Record<string, Object>
        let given = e['given']
        if (given !== null && given !== undefined && typeof given === 'object') {
          let g = given as Record<string, Object>
          let renamed: Record<string, Object> = {}
          Object.keys(g).forEach((key: string) => { renamed[composerNames(key)] = g[key] })
          let e2: Record<string, Object> = {}
          Object.keys(e).forEach((key: string) => { e2[key] = e[key] })
          e2['given'] = renamed
          r['example'] = e2
        }
      }
      values.push(r)
    } else if (n.type === NEED_COUNTDOWN || n.type === NEED_STOPWATCH) {
      // One clock per screen: a second is left to the part's own rule in parseSketch (a stopwatch beside a countdown is `other`).
      if (n.type === NEED_COUNTDOWN && o['countdown'] === undefined) { o['countdown'] = r }
      else if (n.type === NEED_STOPWATCH && o['stopwatch'] === undefined) { o['stopwatch'] = r }
      else { other.push('a second ' + (n.type === NEED_COUNTDOWN ? 'countdown' : 'stopwatch') + ': ' + n.words) }
    } else if (n.type === NEED_ENTRIES) {
      if (o['list'] === undefined) { o['list'] = r } else { other.push('a second list of entries: ' + n.words) }
    } else if (n.type === NEED_CONTENT) {
      ready.push(n.words)
    } else if (n.type === NEED_ACTION) {
      events.push(r)
    } else {
      other.push(n.words)
    }
  }
  o['values'] = values
  o['events'] = events
  o['ready'] = ready
  o['other'] = other
  return parseSketch(JSON.stringify(o))
}

const STOP_WORDS: string[] = ['the', 'and', 'for', 'with', 'that', 'this', 'when', 'from', 'your', 'you', 'are', 'its', 'has', 'have', 'will',
  'all', 'any', 'can', 'each', 'every', 'into', 'then', 'than', 'what', 'who', 'how', 'out', 'one', 'new', 'get', 'set', 'per']

/** Spaces and punctuation, ASCII and the wide forms Chinese and Japanese write: what separates words in any script. */
const BREAKS: RegExp = /[\s!-/:-@[-`{-~ -¿ -⁯　-〿！-／：-＠［-｀｛-･]+/
/**
 * Scripts written without spaces between words (Chinese, Japanese kana, Thai, Lao, Myanmar, Khmer): there a run between two breaks is a
 * whole clause, so it is compared by its pairs of characters instead.
 */
const UNSPACED: RegExp = /[㐀-鿿豈-﫿぀-ヿ฀-໿က-႟ក-៿]/

/** Lower case, the wide forms as the narrow ones, every run of breaks one space. */
function plain(sentence: string): string {
  return sentence.normalize('NFKC').toLowerCase().split(BREAKS).filter((w: string): boolean => w.length > 0).join(' ')
}

/**
 * The words of a sentence that carry its meaning: lower case, three letters or more, not one of the small ones; in a script written
 * without spaces, each pair of characters (a single character when that is all there is).
 */
function meaningWords(sentence: string): string[] {
  let found: string[] = []
  let add = (w: string): void => { if (found.indexOf(w) < 0) { found.push(w) } }
  for (let w of plain(sentence).split(' ')) {
    if (w.length === 0) { continue }
    if (UNSPACED.test(w)) {
      if (w.length === 1) { add(w) }
      for (let i = 0; i + 1 < w.length; i++) { add(w.substring(i, i + 2)) }
    } else if (w.length >= 3 && STOP_WORDS.indexOf(w) < 0) {
      add(w)
    }
  }
  return found
}

/**
 * Whether the words a need quotes from the request are in it: the quote as it stands, in any language, or at least half of its meaning
 * words are the request's own (a plural or a longer form of one counts). A quote that is not from the request is a need the model made
 * up; one with nothing to compare (no meaning words) cannot be judged, and stays.
 */
export function asksFor(request: string, quote: string): boolean {
  let q = plain(quote)
  if (q.length === 0) { return false }
  if (plain(request).indexOf(q) >= 0) { return true }
  let words = meaningWords(quote)
  if (words.length === 0) { return true }
  let have = meaningWords(request)
  let same = (a: string, b: string): boolean => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)))
  let found = words.filter((w: string): boolean => have.some((h: string): boolean => same(w, h))).length
  return found * 2 >= words.length
}

/**
 * The needs the request does not ask for, taken out of the plan: a content or action need whose quote is not the request's (one with no
 * quote stays). The
 * inputs and figures such an action needed are left with nothing that reads them, and the composer leaves them out.
 * Returns the words of each need dropped.
 */
export function dropUnasked(plan: NeedsPlan, request: string): string[] {
  let dropped: string[] = []
  let kept: Need[] = []
  for (let n of plan.needs) {
    // A need with no quote at all cannot be judged and stays: the check is for what the model made up and signed with words not the request's.
    if ((n.type === NEED_CONTENT || n.type === NEED_ACTION) && n.from.length > 0 && !asksFor(request, n.from)) {
      dropped.push(n.words.length > 60 ? n.words.substring(0, 60) + '...' : n.words)
    } else {
      kept.push(n)
    }
  }
  plan.needs = kept
  return dropped
}
