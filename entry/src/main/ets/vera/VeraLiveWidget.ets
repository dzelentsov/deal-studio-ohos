import { VirtualMachine, deserializeVbc2, encodeRuntimeValue, decodeRuntimeValue, RuntimeValue,
  VeraNumberValue, VeraStringValue, VeraBooleanValue } from './VeraInterpreter'
import { UiHostEnvironment, VeraUiNode, decodeVeraUi, formatVeraNumber } from './VeraUi'
import { CATALOG } from './VeraUiCatalog'
import { resolveTheme, pathFill, toneInk, toneEdge, toneFill, buttonFill, buttonInk, textWeight, textInk } from './VeraTheme'
import { iconPath } from './VeraIcons'
import { MOTION_PRESETS } from './VeraMotion'
import { veraStateStamp, stateDigest } from './VeraStateStamp'
import { SOURCE_TARGET } from './VeraSource'
import { decodeGfx, encodeGfxOps, pointerValue, GfxOp } from './VeraGfx'
import { driftSlices } from './GfxPaint'
import type { ProjectRuntimeFlags } from './ProjectStore'
import { CardNode, LiveFrame, compactFrame, CardSize, cardSize, CARD_DIMENSIONS, CARD_MAX_MOTIONS, CARD_MAX_PICTURES, CARD_MAX_SHAPES,
  CARD_MAX_TIMERS, TOUCH_ACTION, pictureCovers, splitCover, OPEN_STRIP, CARD_PADDING } from '../widget/CardModel'
import { cardTextSize, cardTextFamily, cardLetterSpacing, cardGap, CARD_PANEL_PAD, cardPanelFill } from './CardStyle'
export { CardNode, LiveFrame, compactFrame, compactNode, normalizeNodes, CardSize, cardSize, CARD_DIMENSIONS, TOUCH_ACTION } from '../widget/CardModel'

export const LIVE_MAX_DEPTH: number = 4
export const LIVE_MAX_TEXT: number = 256
// A shape's path data (a drum with its jingles is about 300); the whole frame is still held to LIVE_MAX_JSON.
export const LIVE_MAX_COMMANDS: number = 600
/** The Motion presets a card plays: every one, as stages (VeraMotion.motionStages). */
export const CARD_MOTIONS: string[] = MOTION_PRESETS
export const LIVE_MAX_MOTIONS: number = CARD_MAX_MOTIONS
/** Pictures on a card (ui.Surface or ui.Sparkline, drawn once for the frame), of a few dozen shapes each; the frame's own size budget counts the rest. */
export const LIVE_MAX_SURFACES: number = CARD_MAX_PICTURES
/** Moving parts (gfx.moving) in one card picture: each is a layer of its own, and a card has five pictures in all. */
export const LIVE_MAX_PARTS: number = 3
/** Drifts (gfx.drift) on a card: each is a Swiper of up to eight slices of its own (CardView). */
export const LIVE_MAX_DRIFTS: number = 2
/** After a tap the app's frame handlers run in steps of this many ms (a card has no frames of its own)... */
export const SETTLE_STEP_MS: number = 33
/**
 * ...for at most this many steps (20 s: a wheel takes 4 or 5, a 10 s countdown and the launch after it 14), and the state they reach is kept only
 * once this many steps in a row change nothing.
 */
export const SETTLE_MAX_STEPS: number = 600
export const SETTLE_CALM_STEPS: number = 3
/**
 * A state whose only changing fields are clocks (each step adds the same to them: an animation's time, for the twinkle of stars or a flame)
 * for this many steps (1 s) by the end of the budget is at rest: the clock never stops, what it animates has.
 */
export const SETTLE_CLOCK_CALM_STEPS: number = 30
/**
 * ...and from this step on (10 s) such a state is taken at once rather than at the end of the budget: a motion at a steady speed (a rocket
 * rising) looks like a clock too, and most are over by then. On the phone it halved what a tap on a never-resting scene cost (365 ms).
 */
export const SETTLE_CLOCK_EARLY_STEPS: number = 300
/** How often, in steps, the view is asked again what runs (a tap may have started a ticker that the next tick stops). */
export const SETTLE_REASK_STEPS: number = 5
/**
 * The most work settling may do, whatever the steps: a tap runs in the form extension, which the system stops when it is busy for long.
 * Counted, not timed, so a tap comes to rest or not the same on every device and at any load: the check in a TaskPool worker, the
 * card in the form extension and the preview in the app agree (a wall-clock limit let a busy form extension leave a wheel spinning
 * that the check had seen land). The work is the VM steps the handlers and the views run plus the characters of the state encoded
 * each step (encoding was most of a step's cost on the phone: SETTLE_MAX_STEPS). A state not at rest by then is left as the tap left it.
 * About 2 s on the phone at worst. Measured there (2026-11-12): a frame handler heavy on VM steps did 1000000 of this work in 309 ms on
 * the card (form extension) and 291 ms in the app's TaskPool worker; a state of 5500 characters, where encoding is most of the work, did
 * it in 22 ms, and a light wheel that never stops (600 steps, 110000) in 29 ms. A wheel that lands is about 5000.
 */
export const SETTLE_MAX_WORK: number = 6000000
/** A ticker runs at most this often, in ms, as the app runs it (VeraPreview.startTimer): an interval of 1 is not a thousand ticks a second. */
export const SETTLE_MIN_TICK_MS: number = 16
export const LIVE_MAX_SHAPES: number = CARD_MAX_SHAPES
/**
 * What one card picture paints, every copy of a gfx.repeat counted: its 60 shapes are what the frame carries, and a repeat is carried once, so
 * this keeps what the render service paints for a redraw within reach (a 12 x 12 sheet of bubble wrap of two shapes a bubble is 289).
 */
export const LIVE_MAX_DRAWN: number = 400
/** Timers a card runs (ui.Timer, the platform's own TextTimer). */
export const LIVE_MAX_TIMERS: number = CARD_MAX_TIMERS

export const LIVE_ROW_GAP: number = 6
export const PICTURE_SIDE_MIN: number = 40
export const LIVE_MAX_STEPS: number = 100000
// UTF-16 length capped conservatively: even non-ASCII JSON remains small on the wire.
export const LIVE_MAX_JSON: number = 8000

/** The gap a column or row puts between its children (the card's own, 6 or 8, unless the node set one). */
function gapOf(node: CardNode, fallback: number): number { return node.gap !== undefined ? node.gap : fallback }
function padOf(node: CardNode): number { return node.pad !== undefined ? node.pad : 0 }

/** The inner width of a 2x2 card, in vp: what a text wraps in when nothing says the card is wider. */
const LIVE_INNER_WIDTH: number = cardSize(2).width
const LIVE_ROW_SPACE: number = 8

/**
 * About how tall a node draws, in vp, in `width` vp of room: a text of a few words is a line, a longer one wraps (at most two lines, as the card
 * draws it; about 0.55 em a character), a row shares its width among its children. What is left of the card for a picture is what these leave.
 */
function nodeHeight(node: CardNode, pictureSide: number, width: number = LIVE_INNER_WIDTH): number {
  // A cover picture is the card's background (CardModel.splitCover): it takes no room from the rest.
  if (coverPicture(node)) { return 0 }
  if (node.kind === 'motion' && node.children.length === 1 && coverPicture(node.children[0])) { return 0 }
  if (node.kind === 'surface' || node.kind === 'drift') { return Math.min(pictureSide * 1.1, pictureSide * node.h / node.w) }
  if (node.kind === 'path' || node.kind === 'icon') { return node.size }
  if (node.kind === 'iconbutton') { return node.size }
  if (node.kind === 'badge') { return 22 }
  if (node.kind === 'toggle' || node.kind === 'checkbox') { return 24 }
  if (node.kind === 'progress') { return 30 }
  if (node.kind === 'ring') { return node.size + (node.text.length > 0 ? 16 : 0) }
  if (node.kind === 'button') { return 40 }
  if (node.kind === 'divider') { return 1 }
  if (node.kind === 'spacer') { return 4 }
  if (node.kind === 'row') {
    let tallest = 0
    let share = (width - 2 * padOf(node) - LIVE_ROW_SPACE * Math.max(0, node.children.length - 1)) / Math.max(1, node.children.length)
    for (let child of node.children) { tallest = Math.max(tallest, nodeHeight(child, pictureSide, share)) }
    return tallest + 2 * padOf(node)
  }
  if (node.kind === 'layers') {
    let tallest = 0
    for (let child of node.children) { tallest = Math.max(tallest, nodeHeight(child, pictureSide, width)) }
    return tallest
  }
  if (node.kind === 'column' || node.kind === 'motion') {
    return stackHeight(node.children, pictureSide, gapOf(node, LIVE_ROW_GAP), width - 2 * padOf(node)) + 2 * padOf(node)
  }
  // A figure is one line (it shrinks to fit); a text wraps to at most two.
  let lines = node.kind === 'numbertext' ? 1 : Math.max(1, Math.min(2, Math.ceil(node.text.length * 0.55 * node.size / Math.max(20, width))))
  return lines * node.size * 1.25
}

function stackHeight(nodes: CardNode[], pictureSide: number, gap: number = LIVE_ROW_GAP, width: number = LIVE_INNER_WIDTH): number {
  let total = 0
  for (let node of nodes) { total += nodeHeight(node, pictureSide, width) }
  return total + Math.max(0, nodes.length - 1) * gap
}

/**
 * '' when the widget's cover pictures (ui.Surface style "cover") can be drawn as the card's background: at most one, and only where
 * CardModel.splitCover takes it out of the tree -- in the widget's columns, or alone in a ui.Motion there -- not in a row, a ui.Layers or a
 * ui.Motion with more in it, where it would have to share the card. Else why not, said for the model.
 */
export function coverError(nodes: CardNode[]): string {
  let covers = 0
  let misplaced = false
  let walk = (list: CardNode[], placed: boolean): void => {
    for (let node of list) {
      if (coverPicture(node)) {
        covers++
        if (!placed) { misplaced = true }
        // The layers of one cover picture split at its moving parts are that one picture.
        if (node.kind === 'layers') { continue }
      }
      // A ui.Motion goes with the cover only when the cover is all it holds (CardModel.coverHolder): one around a column that holds the
      // cover is not taken out, and the cover would be drawn in the column instead of under the card.
      walk(node.children, placed && (node.kind === 'column' ||
        (node.kind === 'motion' && node.children.length === 1 && coverPicture(node.children[0]))))
    }
  }
  walk(nodes, true)
  if (covers > 1) { return 'a widget has at most one ui.Surface of style "cover": it is the whole card\'s background' }
  if (misplaced) {
    return 'a ui.Surface of style "cover" is the whole card\'s background: put it in the widget\'s column (or alone in a ui.Motion), not in a row or a ui.Layers'
  }
  return ''
}

/**
 * Why a widget nests too deep, said so the model can fix it: a bare "exceeds depth 4" came back three times in nine failed answers
 * of a run of toy widgets, and the next answer nested as deep. The levels are counted from the widget's root below its ui.AppTheme.
 */
function depthMessage(kind: string): string {
  return 'widget exceeds depth ' + LIVE_MAX_DEPTH.toString() + ' (' + kind + ' nested more than ' + LIVE_MAX_DEPTH.toString() +
    ' levels below the widget\'s root, its ui.AppTheme not counted): the root column is level 1, a row or column in it level 2, ' +
    'what is in that row level 3. Flatten it: put texts, figures and buttons straight in the root column or in one row, drop columns ' +
    'that only wrap one thing, and do not put a ui.Motion around a row'
}

/** About how tall the widget draws on the card, in vp (its picture, if it has one, at the side it was given). */
export function widgetHeight(frame: LiveFrame): number {
  let side = 0
  let pictures = allPictures(frame.nodes, [])
  if (pictures.length > 0) { side = pictures[0].size }
  return stackHeight(frame.nodes, side, LIVE_ROW_GAP, cardSize(frame.dimension).width) + openStripRoom(frame.nodes)
}

/**
 * Over a cover picture, the share of the card's height, from its bottom, that the rest of the widget and the strip that opens the app
 * take (LiveCard lays them out at the bottom): the veil under them (CardModel.coverScrim). 0 without a cover picture or with nothing over it.
 */
function veilShare(frame: LiveFrame): number {
  let split = splitCover(frame.nodes)
  if (split.cover === null || split.rest.length === 0) { return 0 }
  let card = cardSize(frame.dimension)
  let pictures = allPictures(split.rest, [])
  let rest = stackHeight(split.rest, pictures.length > 0 ? pictures[0].size : 0, LIVE_ROW_GAP, card.width)
  let share = (rest + LIVE_ROW_GAP + OPEN_STRIP) / (card.height + 2 * CARD_PADDING)
  return Math.round(100 * Math.min(1, share)) / 100
}

/** Over a cover picture the strip that opens the app takes the card's bottom padding and a little more (CardModel.OPEN_STRIP). */
function openStripRoom(nodes: CardNode[]): number {
  return splitCover(nodes).cover !== null ? OPEN_STRIP - CARD_PADDING : 0
}

/** A cover picture, or the layers it was split into at its moving parts: the card's background. */
function coverPicture(node: CardNode): boolean {
  return (node.kind === 'surface' || (node.kind === 'layers' && node.parts === true)) && pictureCovers(node.style)
}

/** The pictures that share the card's room with the rest: a cover picture lies under it all instead. */
function allPictures(nodes: CardNode[], out: CardNode[]): CardNode[] {
  for (let node of nodes) {
    if ((node.kind === 'surface' && !pictureCovers(node.style)) || (node.kind === 'drift' && node.cover !== true)) { out.push(node) }
    allPictures(node.children, out)
  }
  return out
}

/**
 * How many pictures a node puts side by side: a row adds its children's, a Layers (one over another) or a column, Motion, Stat or
 * Sparkline (one under another) takes the most of any child.
 */
function picturesAcross(node: CardNode): number {
  if (node.kind === 'surface') { return pictureCovers(node.style) ? 0 : 1 }
  if (node.kind === 'drift') { return node.cover === true ? 0 : 1 }
  let most = 0
  let sum = 0
  for (let child of node.children) {
    let across = picturesAcross(child)
    most = Math.max(most, across)
    sum += across
  }
  return node.kind === 'row' ? sum : most
}

/** The widest a picture may be so the pictures of a row, at any depth under it, share the card's width: its inner width less the gaps. */
function widthLimit(nodes: CardNode[], size: CardSize): number {
  let limit = size.pictureMax
  for (let node of nodes) {
    if (node.kind === 'row') {
      let count = picturesAcross(node)
      if (count > 1) { limit = Math.min(limit, Math.floor((size.width - LIVE_ROW_SPACE * (count - 1)) / count)) }
    }
    limit = Math.min(limit, widthLimit(node.children, size))
  }
  return limit
}


/**
 * The side the pictures are drawn at, in vp: the largest, up to the size's pictureMax and what their rows' width allows, with which everything
 * else still fits the card's height. Below PICTURE_SIDE_MIN there is no room: the widget has too much else on it. 0 when it has no picture.
 */
export function pictureRoom(frame: LiveFrame): number {
  if (allPictures(frame.nodes, []).length === 0) { return 0 }
  let size = cardSize(frame.dimension)
  for (let side = widthLimit(frame.nodes, size); side > 0; side--) {
    if (stackHeight(frame.nodes, side, LIVE_ROW_GAP, size.width) + openStripRoom(frame.nodes) <= size.height) { return side }
  }
  return 1
}

/** A live source call widgetRefresh made, for the card to make: its parameters and the handler its answer goes to. */
export class SourceRequest {
  params: Map<string, string>
  handler: string
  constructor(params: Map<string, string>, handler: string) { this.params = params; this.handler = handler }
}

/** The shapes of a ui.Sparkline on a card: 100 by 36 units, a line through the series (or a bar for each value), a second series in a quieter colour. */
function sparkOps(series: number[], series2: number[], maximum: number, bars: boolean): GfxOp[] {
  const width = 100
  const height = 36
  const pad = 3
  let top = maximum > 0 ? maximum : 0
  if (top <= 0) {
    for (let v of series) { top = Math.max(top, v) }
    for (let v of series2) { top = Math.max(top, v) }
  }
  if (!(top > 0)) { top = 1 }
  let ops: GfxOp[] = []
  let line = (values: number[], colour: string, widthPx: number): void => {
    if (values.length === 0) { return }
    let points: number[] = []
    for (let i = 0; i < values.length; i++) {
      points.push(values.length > 1 ? pad + i * (width - 2 * pad) / (values.length - 1) : width / 2)
      points.push(height - pad - Math.max(0, Math.min(1, values[i] / top)) * (height - 2 * pad))
    }
    let o = new GfxOp()
    o.kind = 'polyline'; o.points = points; o.lineWidth = widthPx; o.color = colour
    ops.push(o)
  }
  if (bars) {
    let slot = width / Math.max(1, series.length)
    for (let i = 0; i < series.length; i++) {
      let h = Math.max(1, Math.max(0, Math.min(1, series[i] / top)) * (height - 2 * pad))
      let o = new GfxOp()
      o.kind = 'rect'; o.x = i * slot + slot * 0.19; o.y = height - pad - h; o.w = slot * 0.62; o.h = h; o.color = 'accent'
      ops.push(o)
    }
    return ops
  }
  line(series2, 'muted', 2)
  line(series, 'accent', 2.6)
  if (series.length > 0) {
    let end = new GfxOp()
    end.kind = 'circle'
    end.x = series.length > 1 ? width - pad : width / 2
    end.y = height - pad - Math.max(0, Math.min(1, series[series.length - 1] / top)) * (height - 2 * pad)
    end.r = 3; end.color = 'accent'
    ops.push(end)
  }
  return ops
}

/** A handler that moves a state on with the time: a ui.Surface frame function (interval 0, every step) or a running ui.Ticker's. */
class ClockDriver {
  handler: string
  interval: number
  constructor(handler: string, interval: number) { this.handler = handler; this.interval = interval }
}

/**
 * The fields of a state from one step to the next: see() says whether nothing but clocks changed -- numbers that grew by the same amount as
 * at the step before -- while everything else stayed as it was.
 */
class StateClocks {
  private values: Map<string, string> = new Map<string, string>()
  private numbers: Map<string, number> = new Map<string, number>()
  private steps: Map<string, number> = new Map<string, number>()

  /** `encoded` is the state as encodeRuntimeValue wrote it. */
  see(encoded: Object): boolean {
    let fields = Array.isArray(encoded) && (encoded as Object[]).length > 2 && Array.isArray((encoded as Object[])[2]) ? (encoded as Object[])[2] as Object[] : []
    let onlyClocks = this.values.size > 0 || this.numbers.size > 0
    for (let entry of fields) {
      if (!Array.isArray(entry) || (entry as Object[]).length < 2) { continue }
      let name = String((entry as Object[])[0])
      let value = (entry as Object[])[1]
      let isNumber = Array.isArray(value) && (value as Object[])[0] === 'n' && typeof (value as Object[])[1] === 'number'
      // A number is compared as a number; anything else as its text, written only for what is not a number.
      let text = isNumber ? '' : JSON.stringify(value)
      if (isNumber) {
        let now = (value as Object[])[1] as number
        let before = this.numbers.get(name)
        let step = before !== undefined ? now - before : 0
        let stepBefore = this.steps.get(name)
        let clock = step !== 0 && stepBefore !== undefined && Math.abs(step - stepBefore) <= 1e-6 * Math.max(1, Math.abs(step))
        if (step !== 0 && !clock) { onlyClocks = false }
        this.numbers.set(name, now)
        this.steps.set(name, step)
      } else {
        if (this.values.has(name) && this.values.get(name) !== text) { onlyClocks = false }
        this.values.set(name, text)
      }
    }
    return onlyClocks
  }
}

function slowest(drivers: ClockDriver[]): number {
  let most = 0
  for (let driver of drivers) { most = Math.max(most, driver.interval) }
  return most
}

export class WidgetSession {
  private host: UiHostEnvironment = new UiHostEnvironment()
  private vm: VirtualMachine
  private state: RuntimeValue
  private bytecode: string
  private versionId: string
  private hasWidget: boolean = false
  private hasRefresh: boolean = false
  /** widget(state, size: number): the program asked for the card's size too. */
  private hasSize: boolean = false
  /** Whether what the last tap started came to rest on the card (settle); true when there was nothing to run. */
  lastTapRested: boolean = true
  /** What the settle under way has done so far (SETTLE_MAX_WORK). */
  private work: number = 0

  private readOnly: boolean = false

  constructor(vbc2: string, versionId: string, saved: string, readOnlyFlags: ProjectRuntimeFlags | null = null) {
    this.bytecode = vbc2
    this.versionId = versionId
    this.readOnly = readOnlyFlags !== null
    if (this.readOnly && saved.length === 0) { throw new Error('Open app to initialize state') }
    if (readOnlyFlags !== null && !readOnlyFlags.vmJournal) {
      throw new Error('Read-only widget rendering requires VM safety; open app')
    }
    let module = deserializeVbc2(vbc2)
    this.hasWidget = module.functions.some((fn): boolean => fn.name === 'widget')
    this.hasRefresh = module.functions.some((fn): boolean => fn.name === 'widgetRefresh')
    this.hasSize = module.functions.some((fn): boolean => fn.name === 'widget' && fn.parameterCount === 2)
    this.vm = readOnlyFlags === null ? new VirtualMachine(module, this.host, LIVE_MAX_STEPS) :
      new VirtualMachine(module, this.host, LIVE_MAX_STEPS, { now: (): number => Date.now(), deadlineMs: 1000 },
        { journalMode: readOnlyFlags.journalMode })
    this.state = saved.length > 0 ? decodeRuntimeValue(JSON.parse(saved) as Object) : this.vm.execute('init')
  }

  private executeRead(entry: string, args: RuntimeValue[]): RuntimeValue {
    if (!this.readOnly) { return this.vm.execute(entry, args) }
    let scope = this.vm.beginTurn(new Object(), this.state)
    try {
      let result = this.vm.executePure(entry, args)
      scope.accept()
      return result
    } catch (error) {
      scope.rollback()
      throw error as Error
    }
  }

  private assertMutable(): void {
    if (this.readOnly) { throw new Error('Open app to interact; widget actions unavailable') }
  }

  encodedState(): string { return JSON.stringify(encodeRuntimeValue(this.state)) }

  /** Puts the session where a tap from the same state got to before, settling included (VeraWidgetRefine's TapMemo), as if it had just run. */
  restoreTap(encoded: string, rested: boolean): void {
    this.assertMutable()
    this.state = decodeRuntimeValue(JSON.parse(encoded) as Object)
    this.lastTapRested = rested
  }

  /**
   * What moves the app's state on with the time, as its view now asks: the ui.Surface frame functions (about 60 a second) and the ui.Ticker
   * handlers that are running, with their intervals. Asked again as the state goes on, since a tap often starts a ticker (a countdown).
   */
  private clockDrivers(state: RuntimeValue): ClockDriver[] {
    let drivers: ClockDriver[] = []
    let view: RuntimeValue
    try {
      view = this.vm.execute('view', [state])
    } catch (e) {
      this.work += this.vm.stepsExecuted()
      return []
    }
    this.work += this.vm.stepsExecuted()
    try {
      let walk = (nodes: VeraUiNode[]): void => {
        for (let node of nodes) {
          if (node.kind === 'surface' && node.action.length > 0) { drivers.push(new ClockDriver(node.action, 0)) }
          if (node.kind === 'ticker' && node.checked && node.action.length > 0 && node.minimum > 0) {
            drivers.push(new ClockDriver(node.action, Math.max(SETTLE_MIN_TICK_MS, node.minimum)))
          }
          walk(node.children)
        }
      }
      walk(decodeVeraUi(view))
    } catch (e) {
      return []
    }
    return drivers
  }

  /**
   * What a tap started, finished: a card has no frames or tickers, so a wheel set spinning by a tap would spin for ever and its Spin button
   * stay off, and a countdown started by a tap would never reach its launch (found on the phone). The app's frame handlers and running tickers
   * run on the state in SETTLE_STEP_MS steps of its clock, as the app would run them (a ticker of 200 ms every sixth step or so), and the state
   * they reach is kept once it stops changing. What they ask of the phone (a tick's vibration, a sound) is dropped, as the card can do none of
   * it, and never answered. A state that does not come to rest within SETTLE_MAX_STEPS -- a game that plays on, a clock that counts -- is left
   * as the tap left it, so the card never plays a game on for the person; so is one whose step traps, and one not at rest after SETTLE_MAX_WORK.
   */
  private settle(): void {
    let started = Date.now()
    this.work = 0
    let current = this.state
    let drivers = this.clockDrivers(current)
    this.lastTapRested = true
    if (drivers.length === 0) { return }
    let owed = new Map<string, number>()
    let last = JSON.stringify(encodeRuntimeValue(current))
    let calm = 0
    let clocks = new StateClocks()
    clocks.see(encodeRuntimeValue(current) as Object)
    let clockCalm = 0
    let step = 0
    let rested = false
    this.host.effectsAllowed = true
    try {
      for (; step < SETTLE_MAX_STEPS && !rested && this.work < SETTLE_MAX_WORK; step++) {
        // What runs may change with the state: a ticker started or stopped. Asked again every few steps, not every one (a view is not free).
        if (step > 0 && step % SETTLE_REASK_STEPS === 0) { drivers = this.clockDrivers(current) }
        for (let driver of drivers) {
          this.host.pendingEffects = []
          if (driver.interval === 0) {
            current = this.vm.execute(driver.handler, [current, new VeraNumberValue(SETTLE_STEP_MS)])
            this.work += this.vm.stepsExecuted()
            continue
          }
          let due = (owed.has(driver.handler) ? owed.get(driver.handler)! : 0) + SETTLE_STEP_MS
          while (due >= driver.interval) {
            current = this.vm.execute(driver.handler, [current, new VeraNumberValue(driver.interval)])
            this.work += this.vm.stepsExecuted()
            due -= driver.interval
          }
          owed.set(driver.handler, due)
        }
        // One encoding a step serves both: the state as a whole, and its fields one by one (encoding is most of a step's cost).
        let tree = encodeRuntimeValue(current) as Object
        let encoded = JSON.stringify(tree)
        this.work += encoded.length
        calm = encoded === last ? calm + 1 : 0
        last = encoded
        clockCalm = clocks.see(tree) ? clockCalm + 1 : 0
        // A ticker slower than the calm window would look like rest between its ticks: wait out the slowest one too.
        rested = calm >= Math.max(SETTLE_CALM_STEPS, Math.ceil(slowest(drivers) / SETTLE_STEP_MS) + 1) ||
          (step + 1 >= SETTLE_CLOCK_EARLY_STEPS && clockCalm >= SETTLE_CLOCK_CALM_STEPS)
      }
      // Only its clocks still going, everything they animate still for a second: what the tap started is over.
      if (!rested && clockCalm >= SETTLE_CLOCK_CALM_STEPS) { rested = true }
      if (rested) { this.state = current }
      this.lastTapRested = rested
    } catch (e) {
      this.lastTapRested = false
      // A step that traps does not count: the state stays as the tap left it.
    } finally {
      this.host.effectsAllowed = false
      this.host.pendingEffects = []
    }
    console.info('VERA-WIDGET settle ' + (rested ? 'rested' : 'left as tapped') + ' steps=' + step.toString() + ' work=' + this.work.toString() + ' ms=' + (Date.now() - started).toString())
  }

  frame(projectId: string, title: string, icon: string, dimension: number = 2): LiveFrame {
    let size = cardSize(dimension)
    let frame = new LiveFrame()
    frame.projectId = projectId
    frame.title = title
    frame.icon = icon
    frame.versionId = this.versionId
    frame.dimension = size.dimension
    if (!this.hasWidget) { frame.status = 'Open app'; return frame }
    this.host.effectsAllowed = false
    let roots = decodeVeraUi(this.executeRead('widget', this.hasSize ? [this.state, new VeraNumberValue(size.dimension)] : [this.state]))
    if (roots.length !== 1) { throw new Error('widget must return one root') }
    let root = roots[0]
    let theme = resolveTheme(root.kind === 'apptheme' ? root.style : 'clean',
      root.kind === 'apptheme' ? root.value : '', false)
    frame.background = theme.background
    frame.preset = root.kind === 'apptheme' ? root.style : 'clean'
    frame.primary = root.kind === 'apptheme' ? root.value : ''
    let count = 0
    let motions = 0
    let surfaces = 0
    let drifts = 0
    let timers = 0
    // The nodes a component is expanded into (a Stat, a Sparkline) are made, counted and depth-checked like the ones the program wrote.
    let make = (kind: string, key: string, depth: number, slot: number): CardNode => {
      count += 1
      if (count > size.maxNodes) { throw new Error('widget exceeds ' + size.maxNodes.toString() + ' nodes') }
      if (depth > LIVE_MAX_DEPTH) { throw new Error(depthMessage(kind)) }
      let made = new CardNode()
      made.kind = kind
      made.key = key
      made.slot = slot
      return made
    }
    let iconOf = (name: string): string => {
      let commands = iconPath(name)
      if (commands.length === 0) { throw new Error('unknown icon "' + name + '"') }
      return commands
    }
    let statOf = (item: CardNode, node: VeraUiNode, depth: number, key: string, slot: number, figure: string): void => {
      item.kind = 'column'
      item.gap = 2
      let kids: CardNode[] = []
      // With an icon the caption sits beside it in a row (one level deeper); without, it is a text of the column's own. A Stat
      // in a row of the widget's column has no level left for that row: there it is drawn without its icon rather than refused,
      // since the model cannot see the levels a Stat takes (a fish tank's two NumberStats in a row failed every answer on it).
      if (node.icon.length > 0 && depth + 2 <= LIVE_MAX_DEPTH) {
        let head = make('row', key + '.h', depth + 1, slot)
        head.gap = 4
        head.align = 'joined'
        let glyph = make('icon', key + '.hi', depth + 2, slot)
        glyph.commands = iconOf(node.icon)
        glyph.size = 12
        glyph.color = toneInk(theme, node.style, theme.inkMuted)
        head.children.push(glyph)
        if (node.label.length > 0) {
          let label = make('text', key + '.hl', depth + 2, slot)
          label.text = node.label
          label.size = cardTextSize('caption')
          label.color = theme.inkMuted
          head.children.push(label)
        }
        kids.push(head)
      } else if (node.label.length > 0) {
        let label = make('text', key + '.hl', depth + 1, slot)
        label.text = node.label
        label.size = cardTextSize('caption')
        label.color = theme.inkMuted
        kids.push(label)
      }
      let big = make('numbertext', key + '.f', depth + 1, slot)
      big.text = figure
      // A Stat's figure is smaller than a lone metric (24, not 30): two of them side by side have to leave room between them.
      big.size = 24
      big.color = toneInk(theme, node.style, theme.ink)
      let weight = textWeight(theme, 'metric')
      if (weight !== 400) { big.weight = weight }
      let family = cardTextFamily(theme, 'metric')
      if (family.length > 0) { big.family = family }
      kids.push(big)
      if (node.value.length > 0) {
        let line = make('text', key + '.s', depth + 1, slot)
        line.text = node.value
        line.size = cardTextSize('caption')
        line.color = theme.inkSoft
        kids.push(line)
      }
      item.children = kids
    }
    // A touch on any part of a scene plays all its movements: the slots of its Motions, on it and on everything in it (CardView).
    let linkScene = (item: CardNode): void => {
      let slots: number[] = []
      let gather = (nodes: CardNode[]): void => {
        for (let child of nodes) {
          if (child.kind === 'motion' && child.slot >= 0) { slots.push(child.slot) }
          gather(child.children)
        }
      }
      gather(item.children)
      let link = (nodes: CardNode[]): void => {
        for (let child of nodes) {
          child.links = slots
          link(child.children)
        }
      }
      if (slots.length > 0) { item.links = slots; link(item.children) }
    }
    /**
     * A picture with moving parts (gfx.moving) as a scene: the card cannot move a part of one canvas, so the picture is split where its
     * parts are into layers of the same box, one over another -- what is still under them, each part in a Motion of its own that turns
     * about the part's pivot, and what is still over them -- and the card plays each layer by itself. The layers are pictures, counted
     * against the card's five; the picture's pointer goes on the bottom one, and a touch anywhere plays every part.
     */
    let splitParts = (item: CardNode, ops: GfxOp[], depth: number, key: string): void => {
      let parts = ops.filter((o: GfxOp): boolean => o.kind === 'moving')
      let strips = ops.filter((o: GfxOp): boolean => o.kind === 'drift')
      if (drifts + strips.length > LIVE_MAX_DRIFTS) {
        throw new Error('a widget has at most ' + LIVE_MAX_DRIFTS.toString() + ' gfx.drift')
      }
      if (parts.length > LIVE_MAX_PARTS) {
        throw new Error('a card picture has at most ' + LIVE_MAX_PARTS.toString() + ' gfx.moving parts; this one has ' + parts.length.toString())
      }
      if (parts.length > 0 && item.slot >= 0) {
        throw new Error('a picture with gfx.moving parts moves them itself: do not put it in a ui.Motion (its parts would move twice)')
      }
      // Its layers are a level below the picture, and a part's picture one more below its Motion; a drift's strip is a layer itself.
      if (depth + (parts.length > 0 ? 2 : 1) > LIVE_MAX_DEPTH) {
        if (parts.length === 0) {
          throw new Error('a picture with gfx.drift is drawn as layers, a level deeper than the picture: put it in the widget\'s column ' +
            'or in a row in it, not deeper')
        }
        throw new Error('a picture with gfx.moving parts is drawn as layers, two levels deeper than the picture: put it directly in the ' +
          'widget\'s column, not in a row or column inside it')
      }
      let cover = pictureCovers(item.style)
      let w = item.w
      let h = item.h
      let pointer = item.pointer
      surfaces -= 1
      item.kind = 'layers'
      item.parts = true
      item.ops = ''
      item.pointer = ''
      item.pic = -1
      let layers: CardNode[] = []
      let picture = (shapes: GfxOp[], layerKey: string, layerDepth: number, slot: number): CardNode => {
        surfaces += 1
        if (surfaces > LIVE_MAX_SURFACES) {
          throw new Error('a widget has at most ' + LIVE_MAX_SURFACES.toString() + ' pictures, and a picture with moving parts is one for what is ' +
            'still under them, one for each part and one for what is over them: use fewer parts or pictures')
        }
        let layer = make('surface', layerKey, layerDepth, slot)
        layer.ops = encodeGfxOps(shapes)
        layer.w = w
        layer.h = h
        layer.pic = surfaces - 1
        layer.style = layers.length === 0 ? (cover ? 'cover' : 'default') : (cover ? 'cover clear' : 'clear')
        if (layers.length === 0) { layer.pointer = pointer }
        return layer
      }
      let still: GfxOp[] = []
      let flush = (): void => {
        if (still.length === 0) { return }
        layers.push(picture(still, key + '.l' + layers.length.toString(), depth + 1, -1))
        still = []
      }
      // A picture that starts with a drift or a moving part still has a still bottom layer, its background, to take its touches: else
      // the part would carry the picture's background and turn it with itself.
      if (ops.length > 0 && (ops[0].kind === 'drift' || ops[0].kind === 'moving')) { layers.push(picture([], key + '.l0', depth + 1, -1)) }
      for (let o of ops) {
        if (o.kind === 'drift') {
          flush()
          drifts += 1
          let strip = make('drift', key + '.d' + layers.length.toString(), depth + 1, -1)
          strip.style = o.fx
          strip.value = driftSlices(o.text)
          strip.ops = encodeGfxOps([o])
          strip.w = w
          strip.h = h
          strip.pic = drifts - 1
          if (cover) { strip.cover = true }
          layers.push(strip)
          continue
        }
        if (o.kind !== 'moving') { still.push(o); continue }
        flush()
        if (CARD_MOTIONS.indexOf(o.fx) < 0) { throw new Error('gfx.moving style "' + o.fx + '" does not play on a card: use ' + CARD_MOTIONS.join(', ')) }
        if (!Number.isFinite(o.sweep)) { throw new Error('gfx.moving trigger must be a number (this one is not: a square root of a negative number?)') }
        motions += 1
        if (motions > LIVE_MAX_MOTIONS) { throw new Error('a widget has at most ' + LIVE_MAX_MOTIONS.toString() + ' movements (ui.Motion and gfx.moving)') }
        let motion = make('motion', key + '.m' + layers.length.toString(), depth + 1, motions - 1)
        motion.style = o.fx
        motion.trigger = o.sweep
        motion.px = Math.round(1000 * o.x / w) / 1000
        motion.py = Math.round(1000 * o.y / h) / 1000
        motion.children = [picture(o.children, key + '.p' + layers.length.toString(), depth + 2, motions - 1)]
        layers.push(motion)
      }
      flush()
      item.children = layers
      linkScene(item)
    }
    // What a ui.Surface's draw function returns for the state, run once per frame for each picture: drawsParts looks at it before
    // project draws it. A failed run is not kept, so project runs it again and says why.
    let drawings = new Map<VeraUiNode, GfxOp[]>()
    let drawingOf = (node: VeraUiNode): GfxOp[] => {
      let known = drawings.get(node)
      if (known !== undefined) { return known }
      let ops = decodeGfx(this.executeRead(node.label, [this.state]))
      drawings.set(node, ops)
      return ops
    }
    // Whether a ui.Surface's drawing has moving parts: then a ui.Motion around it is dropped (project), since the parts move by themselves
    // and the two levels it takes are the ones the parts' layers need. A drift alone keeps its Motion: it slides, the Motion moves it all.
    let drawsParts = (node: VeraUiNode): boolean => {
      if (node.kind !== 'surface' || node.label.length === 0) { return false }
      try {
        return drawingOf(node).some((o: GfxOp): boolean => o.kind === 'moving')
      } catch (e) {
        return false
      }
    }
    let project = (node: VeraUiNode, depth: number, key: string, motionSlot: number): CardNode => {
      if (node.kind === 'motion' && node.children.length === 1 && drawsParts(node.children[0])) {
        return project(node.children[0], depth, key, motionSlot)
      }
      count += 1
      if (count > size.maxNodes) { throw new Error('widget exceeds ' + size.maxNodes.toString() + ' nodes') }
      if (depth > LIVE_MAX_DEPTH) { throw new Error(depthMessage(node.kind)) }
      let spec = CATALOG.find((entry): boolean => entry.nodeKind === node.kind)
      if (spec === undefined || !spec.card) { throw new Error('Not card-safe: ' + node.kind) }
      if (node.kind === 'apptheme' && key !== '0') { throw new Error('AppTheme must be the widget root') }
      let item = new CardNode()
      item.key = key
      item.kind = node.kind
      item.text = node.kind === 'numbertext' ? node.prefix + formatVeraNumber(node.numberValue, node.decimals, node.minimumDigits) + node.suffix : node.text
      if (item.text.length > LIVE_MAX_TEXT) { throw new Error('widget text exceeds 256 characters') }
      if (node.kind === 'path') {
        if (node.commands.length > LIVE_MAX_COMMANDS) { throw new Error('widget shape exceeds ' + LIVE_MAX_COMMANDS.toString() + ' characters') }
        item.commands = node.commands
      }
      if (node.kind === 'motion') {
        motions += 1
        if (motions > LIVE_MAX_MOTIONS) { throw new Error('a widget has at most ' + LIVE_MAX_MOTIONS.toString() + ' ui.Motion') }
        if (CARD_MOTIONS.indexOf(node.style) < 0) {
          throw new Error('ui.Motion style "' + node.style + '" does not play on a card: use ' + CARD_MOTIONS.join(', '))
        }
        if (!Number.isFinite(node.numberValue)) { throw new Error('ui.Motion trigger must be a number') }
        item.style = node.style
        item.trigger = node.numberValue
      }
      item.slot = node.kind === 'motion' ? motions - 1 : motionSlot
      if (node.kind === 'surface') {
        surfaces += 1
        if (surfaces > LIVE_MAX_SURFACES) { throw new Error('a widget has at most ' + LIVE_MAX_SURFACES.toString() + ' ui.Surface') }
        if (node.action.length > 0) {
          throw new Error('a card has no frames: leave the frame handler of ui.Surface empty (""), the picture is drawn once for each state')
        }
        if (node.label.length === 0) { throw new Error('ui.Surface needs the name of its draw function') }
        if (!(node.minimum > 0) || !(node.maximum > 0)) { throw new Error('ui.Surface width and height must be above 0') }
        let ops = drawingOf(node)
        let shapes = 0
        let drawn = 0
        for (let o of ops) { shapes += o.count; drawn += o.drawn }
        if (shapes > LIVE_MAX_SHAPES) {
          throw new Error('a card picture has at most ' + LIVE_MAX_SHAPES.toString() + ' shapes; this one has ' + shapes.toString() +
            '. Many of the same (bubbles, bricks, stars, dots in a grid) is one gfx.repeat(columns, rows, dx, dy, [the shapes of one]), ' +
            'which counts its shapes once; draw only what differs from copy to copy (a popped bubble) over it, or show fewer')
        }
        if (drawn > LIVE_MAX_DRAWN) {
          throw new Error('a card picture paints at most ' + LIVE_MAX_DRAWN.toString() + ' shapes, every copy of a gfx.repeat counted; this one ' +
            'paints ' + drawn.toString() + ': use fewer copies or fewer shapes in each')
        }
        let nested = (list: GfxOp[], top: boolean): boolean =>
          list.some((o: GfxOp): boolean => (!top && (o.kind === 'moving' || o.kind === 'drift')) || nested(o.children, false))
        if (nested(ops, true)) {
          throw new Error('gfx.moving and gfx.drift must be among the shapes the draw function returns, not inside a gfx.group, an effect or each other')
        }
        item.ops = encodeGfxOps(ops)
        item.w = node.minimum
        item.h = node.maximum
        item.pointer = node.value
        item.pic = surfaces - 1
        item.style = node.style
        if (ops.some((o: GfxOp): boolean => o.kind === 'moving' || o.kind === 'drift')) { splitParts(item, ops, depth, key) }
      }
      item.action = node.action
      item.value = node.eventValue
      item.enabled = node.enabled
      item.color = node.kind === 'path' ? pathFill(theme, node.style) : theme.inkStrong
      item.fill = theme.surface
      if (node.kind === 'path') { item.size = 64 }
      if (node.kind === 'timer') {
        timers += 1
        if (timers > LIVE_MAX_TIMERS) { throw new Error('a widget has at most ' + LIVE_MAX_TIMERS.toString() + ' ui.Timer') }
        if (!Number.isFinite(node.numberValue)) { throw new Error('ui.Timer millis must be a number') }
        item.val = node.numberValue
        item.max = node.checked ? 1 : 0
        item.pic = timers - 1
      }
      if (node.kind === 'text' || node.kind === 'numbertext' || node.kind === 'timer') {
        // The theme's roles, with the card's sizes (CardStyle): the app's text styles reach the card instead of being flattened to three sizes.
        item.size = cardTextSize(node.style)
        item.color = textInk(theme, node.style)
        let weight = textWeight(theme, node.style)
        if (weight !== 400) { item.weight = weight }
        let family = cardTextFamily(theme, node.style)
        if (family.length > 0) { item.family = family }
        let spacing = cardLetterSpacing(theme, node.style)
        if (spacing !== 0) { item.spacing = spacing }
      }
      if (node.kind === 'button') {
        item.fill = buttonFill(theme, node.style)
        item.color = buttonInk(theme, node.style)
        if (theme.radiusControl !== 10) { item.radius = theme.radiusControl }
      }
      if (node.kind === 'divider') { item.color = theme.line }
      if (node.kind === 'column' || node.kind === 'row') {
        let gap = cardGap(node.kind, node.style)
        if (gap !== (node.kind === 'row' ? 8 : 6)) { item.gap = gap }
        // A column is centred on a card unless it says 'end'; a row is spread evenly unless it says 'split', 'end' or 'joined'.
        if (node.style === 'end' || (node.kind === 'row' && (node.style === 'split' || node.style === 'joined'))) { item.align = node.style }
        let panel = cardPanelFill(theme, node.style)
        if (panel.length > 0) {
          item.panel = panel
          item.pad = CARD_PANEL_PAD
          item.radius = theme.radiusControl
        }
      }
      if (node.kind === 'progressring') { item.kind = 'ring' }
      if (node.kind === 'metricgroup') { item.kind = node.columns > 1 ? 'row' : 'column' }
      if (node.kind === 'icon') {
        item.commands = iconOf(node.icon)
        item.size = cardTextSize('heading')
        item.color = toneInk(theme, node.style, theme.inkStrong)
      }
      if (node.kind === 'iconbutton') {
        item.commands = iconOf(node.icon)
        item.size = 36
        item.fill = node.style === 'quiet' ? '#00000000' : node.style === 'secondary' ? theme.secondaryFill : buttonFill(theme, node.style)
        item.color = node.style === 'quiet' || node.style === 'secondary' ? theme.secondaryInk : theme.onPrimary
      }
      if (node.kind === 'badge') {
        item.commands = node.icon.length > 0 ? iconOf(node.icon) : ''
        item.color = toneInk(theme, node.style, theme.inkSoft)
        item.fill = toneFill(theme, node.style, theme.surface)
        item.radius = theme.radiusSmall
      }
      if (node.kind === 'toggle' || node.kind === 'checkbox') {
        // A switch: its label, on or off (val 1 or 0), the colour it is on in and the colour it is off in, and the check mark's path for a box.
        item.text = node.label
        item.val = node.checked ? 1 : 0
        item.color = theme.primary
        item.fill = theme.lineStrong
        item.ink = theme.ink
        if (node.kind === 'checkbox') { item.commands = iconOf('check') }
      }
      if (node.kind === 'progress' || node.kind === 'progressring') {
        item.text = node.label
        item.val = node.eventValue
        item.max = node.maximum > 0 ? node.maximum : 100
        item.color = toneEdge(theme, node.style, theme.primary)
        item.fill = theme.lineSoft
        item.ink = theme.inkStrong
        if (node.kind === 'progressring') {
          item.sub = node.text.length > 0 ? node.text : Math.round(100 * node.eventValue / item.max).toString() + '%'
          item.size = 52
        }
      }
      if (node.kind === 'stat') { statOf(item, node, depth, key, motionSlot, node.text) }
      if (node.kind === 'numberstat') {
        statOf(item, node, depth, key, motionSlot, node.prefix + formatVeraNumber(node.numberValue, node.decimals, node.minimumDigits) + node.suffix)
      }
      if (node.kind === 'sparkline') {
        item.kind = 'column'
        item.gap = 2
        let kids: CardNode[] = []
        if (node.label.length > 0) {
          let label = make('text', key + '.l', depth + 1, motionSlot)
          label.text = node.label
          label.size = cardTextSize('caption')
          label.color = theme.inkSoft
          kids.push(label)
        }
        surfaces += 1
        if (surfaces > LIVE_MAX_SURFACES) { throw new Error('a widget has at most ' + LIVE_MAX_SURFACES.toString() + ' pictures (ui.Surface or ui.Sparkline)') }
        if (node.series.length > 30 && node.bars) { throw new Error('a card sparkline with bars has at most 30 values') }
        let chart = make('surface', key + '.c', depth + 1, motionSlot)
        chart.ops = encodeGfxOps(sparkOps(node.series, node.series2, node.maximum, node.bars))
        chart.w = 100
        chart.h = 36
        chart.pic = surfaces - 1
        kids.push(chart)
        item.children = kids
      }
      if (node.kind !== 'stat' && node.kind !== 'numberstat' && node.kind !== 'sparkline' && !(item.parts === true)) {
        item.children = node.children.map((child: VeraUiNode, index: number): CardNode => project(child, depth + 1, key + '.' + index.toString(), item.slot))
      }
      // A touch on any part of the scene plays all its movements: the stick swings and the drum answers.
      if (node.kind === 'layers') { linkScene(item) }
      return item
    }
    // The theme wrapper consumes no layout level but is still validated and counted.
    let tree = project(root, root.kind === 'apptheme' ? 0 : 1, '0', -1)
    frame.nodes = root.kind === 'apptheme' ? tree.children : [tree]
    let coverProblem = coverError(frame.nodes)
    if (coverProblem.length > 0) { throw new Error(coverProblem) }
    let side = pictureRoom(frame)
    for (let picture of allPictures(frame.nodes, [])) { picture.size = Math.max(PICTURE_SIDE_MIN, Math.min(size.pictureMax, side)) }
    frame.veil = veilShare(frame)
    // Rejects taps from an older frame or state. A digest, not the state itself: the token is in the card's data, which has
    // a size budget, and in every key of its layout, so it must not grow with the app's data.
    frame.token = this.versionId + ':' + veraStateStamp(this.bytecode) + ':' + stateDigest(this.encodedState())
    frame.live = true
    // The budget is the size of what goes into the binding: the compact frame (CardModel.compactFrame), not every default field.
    if (JSON.stringify(compactFrame(frame)).length > LIVE_MAX_JSON) { throw new Error('widget binding exceeds size budget') }
    return frame
  }

  /** widget(state, size: number): the program draws differently for the card's size. */
  takesSize(): boolean { return this.hasSize }

  /** The sizes the widget is drawn at differently: every card size when it takes the size, else only 2x2 (the others draw the same, centred). */
  dimensions(): number[] { return this.hasSize ? CARD_DIMENSIONS.slice() : [2] }

  /** The program has widgetRefresh: the card's periodic update brings its state up to date with the clock. */
  refreshes(): boolean { return this.hasRefresh }

  /**
   * widgetRefresh, as a tap runs a handler: the state is kept only when it returns. The one call it may make is its live source
   * (Vera.Source.fetch, a GET the program was generated with): returned for the card to make, the answer going to `answer`.
   * Any other phone effect is refused.
   */
  refresh(): SourceRequest[] {
    this.assertMutable()
    let requests: SourceRequest[] = []
    if (!this.hasRefresh) { return requests }
    this.host.effectsAllowed = true
    this.host.pendingEffects = []
    try {
      let next = this.vm.execute('widgetRefresh', [this.state])
      requests = this.sourceRequests('widgetRefresh asked for a phone action')
      this.state = next
    } finally {
      this.host.effectsAllowed = false
      this.host.pendingEffects = []
    }
    return requests
  }

  /** A source's answer to its handler, as the app delivers one: handler(state, answer). No phone effects. */
  answer(handler: string, text: string): void {
    this.assertMutable()
    this.host.effectsAllowed = true
    this.host.pendingEffects = []
    try {
      let next = this.vm.execute(handler, [this.state, new VeraStringValue(text)])
      if (this.host.pendingEffects.length > 0) { throw new Error(handler + ' asked for a phone action') }
      this.state = next
    } finally {
      this.host.effectsAllowed = false
      this.host.pendingEffects = []
    }
  }

  /** A button's handler; its live source call (Vera.Source.fetch), if it makes one, is returned for the card to make. */
  tap(frame: LiveFrame, token: string, action: string, value: number): SourceRequest[] {
    this.assertMutable()
    if (!frame.live || token !== frame.token) { throw new Error('Widget changed; tap again') }
    // A touch on a ui.Motion that has nothing of its own to run: no handler, only a new frame, in which the movement plays.
    if (action === TOUCH_ACTION) { return [] }
    let allowed = (nodes: CardNode[]): boolean => nodes.some((node: CardNode): boolean =>
      ((node.kind === 'button' || node.kind === 'path' || node.kind === 'iconbutton') && node.enabled && node.action.length > 0 && node.action === action && node.value === value) || allowed(node.children))
    if (!Number.isFinite(value) || !allowed(frame.nodes)) { throw new Error('Action is not available on this widget') }
    this.host.effectsAllowed = true
    this.host.pendingEffects = []
    try {
      let next = this.vm.execute(action, [this.state, new VeraNumberValue(value)])
      let requests = this.sourceRequests('Open app to continue: phone action required')
      this.state = next
      this.settleAfter(requests)
      return requests
    } finally {
      this.host.effectsAllowed = false
      this.host.pendingEffects = []
    }
  }

  /**
   * A tap on a toggle or a checkbox: the program's handler, told whether it is now on (as the app's switch tells it). Like a button, one
   * state change; the answer is the next frame.
   */
  tapSwitch(frame: LiveFrame, token: string, handler: string, on: boolean): SourceRequest[] {
    this.assertMutable()
    if (!frame.live || token !== frame.token) { throw new Error('Widget changed; tap again') }
    let found = (nodes: CardNode[]): boolean => nodes.some((node: CardNode): boolean =>
      ((node.kind === 'toggle' || node.kind === 'checkbox') && node.enabled && node.action.length > 0 && node.action === handler) || found(node.children))
    if (!found(frame.nodes)) { throw new Error('Action is not available on this widget') }
    this.host.effectsAllowed = true
    this.host.pendingEffects = []
    try {
      let next = this.vm.execute(handler, [this.state, new VeraBooleanValue(on)])
      let requests = this.sourceRequests('Open app to continue: phone action required')
      this.state = next
      this.settleAfter(requests)
      return requests
    } finally {
      this.host.effectsAllowed = false
      this.host.pendingEffects = []
    }
  }

  /**
   * A tap on the picture: the handler the program named for pointers, told the finger went down and came up at x, y (in the
   * picture's own units), as the app's surface tells it. One state change, made together; a card has no moves.
   */
  tapSurface(frame: LiveFrame, token: string, handler: string, x: number, y: number): SourceRequest[] {
    this.assertMutable()
    if (!frame.live || token !== frame.token) { throw new Error('Widget changed; tap again') }
    let found = (nodes: CardNode[]): boolean => nodes.some((node: CardNode): boolean =>
      (node.kind === 'surface' && node.pointer.length > 0 && node.pointer === handler) || found(node.children))
    if (!Number.isFinite(x) || !Number.isFinite(y) || !found(frame.nodes)) { throw new Error('Action is not available on this widget') }
    this.host.effectsAllowed = true
    this.host.pendingEffects = []
    try {
      let down = this.vm.execute(handler, [this.state, pointerValue('down', 0, x, y)])
      let up = this.vm.execute(handler, [down, pointerValue('up', 0, x, y)])
      let requests = this.sourceRequests('Open app to continue: phone action required')
      this.state = up
      this.settleAfter(requests)
      return requests
    } finally {
      this.host.effectsAllowed = false
      this.host.pendingEffects = []
    }
  }

  /** settle, unless the tap is waiting for its live source: its answer, not the frames, finishes it. */
  private settleAfter(requests: SourceRequest[]): void {
    if (requests.length === 0) { this.settle() }
  }

  /** The effects collected, when every one is a call to the program's live source; else `refused` is thrown. */
  private sourceRequests(refused: string): SourceRequest[] {
    let requests: SourceRequest[] = []
    for (let effect of this.host.pendingEffects) {
      if (effect.rawTarget !== SOURCE_TARGET || effect.resultHandler.length === 0) { throw new Error(refused) }
      requests.push(new SourceRequest(effect.values, effect.resultHandler))
    }
    return requests
  }
}

/** A tap on the widget preview, as the card gets it: a button's (value), a switch's (on) or a picture's (x, y). */
export class PreviewTapRequest {
  vbc2: string = ''
  state: string = ''
  title: string = ''
  dimension: number = 2
  /** 'button', 'switch' or 'picture'. */
  kind: string = 'button'
  token: string = ''
  handler: string = ''
  value: number = 0
  on: boolean = false
  x: number = 0
  y: number = 0
}

/** What the tap left: the state, whether it came to rest, and its live source call (handler and parameters), if it made one. */
export class PreviewTapResult {
  state: string = ''
  rested: boolean = true
  error: string = ''
  handlers: string[] = []
  params: string[][][] = []
}

/**
 * A tap on the app's widget preview, run where it cannot hang the app (agent/WidgetCheckTask: a TaskPool worker): the session is made
 * again from the program and the state, as the card makes it (LiveFormService), the tap played to rest, and what it left handed back.
 */
export function runPreviewTap(request: PreviewTapRequest): PreviewTapResult {
  let result = new PreviewTapResult()
  try {
    let session = new WidgetSession(request.vbc2, 'preview', request.state)
    let shown = session.frame('', request.title, '', request.dimension)
    let requests: SourceRequest[] = request.kind === 'picture' ? session.tapSurface(shown, request.token, request.handler, request.x, request.y) :
      request.kind === 'switch' ? session.tapSwitch(shown, request.token, request.handler, request.on) :
      session.tap(shown, request.token, request.handler, request.value)
    result.state = session.encodedState()
    result.rested = session.lastTapRested
    for (let call of requests) {
      result.handlers.push(call.handler)
      let pairs: string[][] = []
      call.params.forEach((value: string, key: string): void => { pairs.push([key, value]) })
      result.params.push(pairs)
    }
  } catch (e) {
    result.error = (e as Error).message
  }
  return result
}

/**
 * Whether two programs' widgets draw the same card over the same data: what is on it, its colours and sizes, not the
 * frame's token. A widget that cannot be drawn is not the same as one that can.
 */
export function sameCard(before: string, after: string, seed: string): boolean {
  let draw = (vbc2: string): string => {
    try {
      let frame = new WidgetSession(vbc2, 'compare', seed).frame('', '', '')
      return frame.live ? JSON.stringify(frame.nodes) + frame.background : ''
    } catch (_e) {
      return ''
    }
  }
  let a = draw(before)
  return a.length > 0 && a === draw(after)
}
