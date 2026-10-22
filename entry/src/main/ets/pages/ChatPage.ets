import { KeyboardAvoidMode } from '@ohos.arkui.UIContext'
import common from '@ohos.app.ability.common'
import { VeraPreview } from '../components/VeraPreview'
import { loadRawfileText } from '../vera/LlamaEngine'
import { logMark, logStep, initTrace } from '../vera/VeraTiming'
import { settings } from '../vera/SettingsStore'
import { consent } from '../vera/VeraConsentStore'
import { describeCatalogForPrompt } from '../vera/VeraUiCatalog'
import { ensureCapabilities } from '../vera/VeraCapabilities'
import { modelSupportNote } from '../vera/VeraEmbeddings'
import { WidgetBuildContext, WidgetReference, recentWidgetConversation } from '../vera/VeraWidgetContext'
import { loadCatalogFile } from '../vera/VeraCatalogFile'
import { ChatTurn, ParsedReply, MiniApp, parseReply, chatReply, buildMiniApp } from '../vera/VeraChat'
import { AttemptStat, ReplyStats, costOf, formatUsd, formatMs, speedOf } from '../vera/VeraChatStats'
import { chats, StoredChat, StoredMessage } from '../vera/ChatStore'
import { store } from '../vera/ProjectStore'
import { compileVeraSource } from '../vera/VeraCompiler'
import { buildFromTemplates, TemplateBuild, BUILD_SCRATCH, BUILD_COMPLETE, BUILD_CANCELLED } from '../vera/VeraTemplatePipeline'
import { templateSelectEnabled } from '../vera/VeraTemplateSelectFlag'

const APP_NONE: string = 'none'
const APP_DESCRIBING: string = 'describing'
const APP_BUILDING: string = 'building'
const APP_READY: string = 'ready'
const APP_FAILED: string = 'failed'
const SCROLL_EVERY_MS: number = 150

/**
 * One chat message. Observed, so a reply can grow while it streams and a
 * widget can arrive in it later without the list rebuilding the row: a rebuilt
 * row would throw away the running widget and its state.
 */
@Observed
class ChatMessage {
  id: number = 0
  role: string = 'user'
  /** Text before the widget, or all of it when there is no widget. */
  before: string = ''
  /** Text after the widget. */
  after: string = ''
  appDescription: string = ''
  appState: string = APP_NONE
  vbc2: string = ''
  /** While building: a static picture of the program written so far (VeraWidgetPreview). Never saved. */
  previewVbc2: string = ''
  /** While building: what the builder is doing, shown in the bubble. Never saved. */
  buildStatus: string = ''
  /** Added under the streamed text by this page, so the next streamed piece does not wipe it. */
  beforeNote: string = ''
  source: string = ''
  originalRequest: string = ''
  parentMessageId: number = 0
  cutFrom: number = 0
  update: boolean = false
  /** Latest renderer values are reference data, never a revision's initial state. */
  latestState: string = ''
  error: string = ''
  // What the turn cost, in the same terms the Generate screen uses.
  chatMs: number = 0
  chatTtftMs: number = 0
  chatInput: number = 0
  chatCached: number = 0
  chatOutput: number = 0
  searches: number = 0
  searchMs: number = 0
  widgetMs: number = 0
  attempts: AttemptStat[] = []
  /** Experiment only (experiment/jev-template-select branch): see tryTemplateSelectForChat. */
  templatePick: string = ''
}

/** Everything a set of messages cost, summed. */
class Tally {
  ms: number = 0
  llmMs: number = 0
  deviceMs: number = 0
  searchMs: number = 0
  searches: number = 0
  input: number = 0
  cached: number = 0
  output: number = 0
  widgets: number = 0
  attempts: number = 0
  cost: number = 0
}

function tallyOf(messages: ChatMessage[]): Tally {
  let t = new Tally()
  for (let m of messages) {
    t.ms = t.ms + m.chatMs + m.searchMs + m.widgetMs
    t.llmMs = t.llmMs + m.chatMs
    t.searchMs = t.searchMs + m.searchMs
    t.searches = t.searches + m.searches
    t.input = t.input + m.chatInput
    t.cached = t.cached + m.chatCached
    t.output = t.output + m.chatOutput
    t.cost = t.cost + costOf(m.chatInput, m.chatCached, m.chatOutput)
    if (m.vbc2.length > 0) { t.widgets++ }
    for (let a of m.attempts) {
      t.llmMs = t.llmMs + a.genMs
      t.deviceMs = t.deviceMs + a.compileMs
      t.input = t.input + a.inputTokens
      t.cached = t.cached + a.cachedTokens
      t.output = t.output + a.outputTokens
      t.attempts++
      t.cost = t.cost + costOf(a.inputTokens, a.cachedTokens, a.outputTokens)
    }
  }
  return t
}

@Component
struct StatCell {
  @Prop label: string = ''
  @Prop value: string = ''
  @Prop note: string = ''

  build() {
    // Two nodes on purpose: the outer one owns the width, the inner one the
    // padding, so a padded node with a layout weight cannot outgrow its parent.
    Column() {
      Column({ space: 2 }) {
        Text(this.label).fontSize(10).fontColor('#888888').maxLines(1)
        Text(this.value).fontSize(17).fontWeight(FontWeight.Bold).fontColor('#222222')
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(this.note).fontSize(10).fontColor('#999999').maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .alignItems(HorizontalAlign.Start)
      .padding(10)
    }
    .layoutWeight(1)
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .backgroundColor('#FFFFFF')
    .borderRadius(8)
  }
}

/** The numbers for a set of messages, laid out like the Generate screen's metrics pane. */
@Component
struct StatsPanel {
  @Prop tally: Tally = new Tally()
  @Prop attempts: AttemptStat[] = []
  @Prop heading: string = ''
  /** The <<app: ...>> line this reply handed to the widget builder; empty when it built none. */
  @Prop widgetLine: string = ''
  /** Length of the line before it was cut; 0 when it was not. */
  @Prop widgetCutFrom: number = 0
  @Prop widgetUpdate: boolean = false

  private fresh(): number {
    let f = this.tally.input - this.tally.cached
    return f > 0 ? f : 0
  }

  private cacheNote(): string {
    if (this.tally.cached === 0 || this.tally.input === 0) { return 'nothing reused' }
    return 'reused by DeepSeek, ' + Math.round(this.tally.cached * 100 / this.tally.input).toString() + '%'
  }

  build() {
    Column({ space: 8 }) {
      if (this.heading.length > 0) {
        Text(this.heading).fontSize(11).fontColor('#888888').width('100%')
      }
      if (this.widgetLine.length > 0) {
        Column({ space: 4 }) {
          Text(this.widgetUpdate ? 'Widget request (change to the previous widget)' : 'Widget request')
            .fontSize(10).fontColor('#888888')
          if (this.widgetCutFrom > 0) {
            Text('Cut to ' + this.widgetLine.length.toString() + ' of ' + this.widgetCutFrom.toString() + ' characters')
              .fontSize(10).fontColor('#C62828')
          }
          Text(this.widgetLine).fontSize(12).fontColor('#333333').fontFamily('monospace')
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .padding(10)
        .backgroundColor('#FFFFFF')
        .borderRadius(8)
      }
      Row({ space: 8 }) {
        StatCell({ label: 'Time', value: formatMs(this.tally.ms),
          note: this.tally.attempts > 0 ? 'reply and widget' : 'reply' }).layoutWeight(1)
        StatCell({ label: 'Cost', value: '~' + formatUsd(this.tally.cost),
          note: 'incl. failed attempts' }).layoutWeight(1)
      }.width('100%')
      Row({ space: 8 }) {
        StatCell({ label: 'LLM wall', value: formatMs(this.tally.llmMs), note: 'all calls' }).layoutWeight(1)
        StatCell({ label: 'On device', value: formatMs(this.tally.deviceMs), note: 'compiler only' }).layoutWeight(1)
      }.width('100%')
      Row({ space: 8 }) {
        StatCell({ label: 'Input', value: this.tally.input.toString() + ' toks',
          note: 'rules, history, request' }).layoutWeight(1)
        StatCell({ label: 'Cached', value: this.tally.cached.toString() + ' toks', note: this.cacheNote() }).layoutWeight(1)
      }.width('100%')
      Row({ space: 8 }) {
        StatCell({ label: 'Fresh', value: this.fresh().toString() + ' toks',
          note: 'input at full price' }).layoutWeight(1)
        StatCell({ label: 'Output', value: this.tally.output.toString() + ' toks',
          note: 'text and programs' }).layoutWeight(1)
      }.width('100%')
      if (this.tally.searches > 0) {
        Row({ space: 8 }) {
          StatCell({ label: 'Web search', value: this.tally.searches.toString() + ' calls',
            note: formatMs(this.tally.searchMs) + ' in all' }).layoutWeight(1)
          StatCell({ label: 'Widgets', value: this.tally.widgets.toString(),
            note: this.tally.attempts.toString() + ' build attempts' }).layoutWeight(1)
        }.width('100%')
      } else if (this.tally.attempts > 0) {
        Row({ space: 8 }) {
          StatCell({ label: 'Widgets', value: this.tally.widgets.toString(),
            note: this.tally.attempts.toString() + ' build attempts' }).layoutWeight(1)
        }.width('100%')
      }
      ForEach(this.attempts, (a: AttemptStat) => {
        Column({ space: 8 }) {
          Row({ space: 8 }) {
            Text('#' + a.attempt.toString()).fontSize(13).fontWeight(FontWeight.Bold)
            Text(a.success ? '✓' : '✗ ' + a.verdict)
              .fontSize(11)
              .fontColor(a.success ? '#2E7D32' : '#C62828')
              .backgroundColor(a.success ? '#E8F8E8' : '#FFECEC')
              .padding({ left: 8, right: 8, top: 3, bottom: 3 })
              .borderRadius(6)
              .maxLines(2)
          }.width('100%')
          Row({ space: 8 }) {
            StatCell({ label: 'Wait', value: a.ttftMs > 0 ? formatMs(a.ttftMs) : '—',
              note: 'until first token' }).layoutWeight(1)
            if (a.thinkMs > 0) {
              StatCell({ label: 'Think', value: formatMs(a.thinkMs), note: 'reasoning' }).layoutWeight(1)
            }
            StatCell({ label: 'Write', value: formatMs(Math.max(0, a.genMs - a.ttftMs - a.thinkMs)),
              note: 'streaming code' }).layoutWeight(1)
          }.width('100%').alignItems(VerticalAlign.Top)
          Row({ space: 8 }) {
            StatCell({ label: 'Compile', value: a.compileMs > 0 ? formatMs(a.compileMs) : '—',
              note: 'on device' }).layoutWeight(1)
            StatCell({ label: 'Speed', value: speedOf(a), note: 'output after the wait' }).layoutWeight(1)
          }.width('100%').alignItems(VerticalAlign.Top)
          Row({ space: 8 }) {
            StatCell({ label: 'Preview', value: a.previewMs > 0 ? formatMs(a.previewMs) : '—',
              note: 'picture before handlers' }).layoutWeight(1)
            StatCell({ label: 'Lead', value: a.previewMs > 0 ? formatMs(Math.max(0, a.genMs - a.previewMs)) : '—',
              note: 'shown before done' }).layoutWeight(1)
          }.width('100%').alignItems(VerticalAlign.Top)
        }
        .width('100%')
        .padding(10)
        .backgroundColor('#FFFFFF')
        .borderRadius(8)
      })
    }
    .width('100%')
    .padding(10)
    .backgroundColor('#F5F7FA')
    .borderRadius(10)
  }
}

@Component
struct MessageBubble {
  @ObjectLink msg: ChatMessage
  @Prop showStats: boolean = false
  @Prop chatId: string = ''
  @State showCode: boolean = false

  build() {
    Column({ space: 8 }) {
      if (this.msg.before.length > 0) {
        Text(this.msg.before)
          .fontSize(16)
          .fontColor(this.msg.role === 'user' ? '#FFFFFF' : '#1A1A1A')
          .padding({ left: 12, right: 12, top: 8, bottom: 8 })
          .backgroundColor(this.msg.role === 'user' ? '#2F6BFF' : '#FFFFFF')
          .borderRadius(14)
          .constraintSize({ maxWidth: '85%' })
          .copyOption(CopyOptions.LocalDevice)
      }
      if (this.msg.appState === APP_DESCRIBING) {
        Text('Planning a widget...')
          .fontSize(13)
          .fontColor('#666666')
          .padding(12)
          .backgroundColor('#FFFFFF')
          .borderRadius(14)
      } else if (this.msg.appState === APP_BUILDING && this.msg.previewVbc2.length === 0) {
        Row({ space: 8 }) {
          LoadingProgress().width(18).height(18)
          Text(this.msg.buildStatus.length > 0 ? this.msg.buildStatus : 'Building a widget...')
            .fontSize(13).fontColor('#666666').layoutWeight(1)
        }
        .padding(12)
        .backgroundColor('#FFFFFF')
        .borderRadius(14)
      } else if (this.msg.appState === APP_FAILED) {
        Text('The widget could not be built: ' + this.msg.error.substring(0, 240))
          .fontSize(12)
          .fontColor('#B3261E')
          .padding(10)
          .backgroundColor('#FFECEC')
          .borderRadius(10)
          .copyOption(CopyOptions.LocalDevice)
      }
      // One branch for the preview and the finished widget, so the same
      // renderer is handed the finished program in place instead of a new one
      // appearing where the picture was.
      if (this.msg.appState === APP_READY || (this.msg.appState === APP_BUILDING && this.msg.previewVbc2.length > 0)) {
        VeraPreview({ previewOnly: this.msg.appState !== APP_READY,
          vbc2: this.msg.appState === APP_READY ? this.msg.vbc2 : this.msg.previewVbc2, embedded: true,
          persistKey: this.chatId.length > 0 ? chats.stateKey(this.chatId, this.msg.id) : '',
          onStateSnapshot: (encoded: string): void => { this.msg.latestState = encoded } })
          .width('100%')
          .borderRadius(14)
          .clip(true)
          .backgroundColor('#FFFFFF')
          .opacity(this.msg.appState === APP_READY ? 1 : 0.6)
        if (this.msg.appState === APP_BUILDING) {
          Row({ space: 8 }) {
            LoadingProgress().width(14).height(14)
            Text(this.msg.buildStatus.length > 0 ? this.msg.buildStatus : 'Finishing the widget...')
              .fontSize(12).fontColor('#888888').layoutWeight(1)
          }
          .width('100%')
          .padding({ left: 4, right: 4 })
        }
      }
      if (this.msg.after.length > 0) {
        Text(this.msg.after)
          .fontSize(16)
          .fontColor('#1A1A1A')
          .padding({ left: 12, right: 12, top: 8, bottom: 8 })
          .backgroundColor('#FFFFFF')
          .borderRadius(14)
          .constraintSize({ maxWidth: '85%' })
          .copyOption(CopyOptions.LocalDevice)
      }
      if (this.showStats && this.msg.role === 'assistant' && this.msg.chatInput + this.msg.attempts.length > 0) {
        StatsPanel({ tally: tallyOf([this.msg]), attempts: this.msg.attempts, heading: 'This reply',
          widgetLine: this.msg.appDescription, widgetCutFrom: this.msg.cutFrom, widgetUpdate: this.msg.update })
      }
      // Experiment only (experiment/jev-template-select branch): survives
      // hilog's ring buffer getting overwritten by a busy widget's own
      // logging -- see ChatMessage.templatePick and tryTemplateSelectForChat.
      if (this.showStats && this.msg.templatePick.length > 0) {
        Text('Jev: ' + this.msg.templatePick)
          .fontSize(11)
          .fontColor('#8A6D00')
          .padding({ left: 12, right: 12, top: 2, bottom: 6 })
      }
      // The program behind the widget, next to the numbers about how it was
      // built. Collapsed by default: a whole program would push the next
      // message out of view.
      if (this.showStats && this.msg.role === 'assistant' && this.msg.source.length > 0) {
        Column({ space: 6 }) {
          Row() {
            Text('Widget code').fontSize(13).fontColor('#666666').layoutWeight(1)
            Text(this.showCode ? 'Hide' : 'Show').fontSize(13).fontColor('#2F6BFF')
          }
          .width('100%')
          .onClick(() => { this.showCode = !this.showCode })
          if (this.showCode) {
            Scroll() {
              Text(this.msg.source)
                .fontSize(11)
                .fontFamily('monospace')
                .fontColor('#1A1A1A')
                .width('100%')
                .copyOption(CopyOptions.LocalDevice)
            }
            .width('100%')
            .constraintSize({ maxHeight: 420 })
            .scrollBar(BarState.Auto)
          }
        }
        .width('100%')
        .padding(10)
        .backgroundColor('#FFFFFF')
        .borderRadius(10)
      }
    }
    .width('100%')
    .alignItems(this.msg.role === 'user' ? HorizontalAlign.End : HorizontalAlign.Start)
  }
}

@Entry
@Component
struct ChatPage {
  @State messages: ChatMessage[] = []
  @State draft: string = ''
  @State busy: boolean = false
  @State status: string = ''
  @State showStats: boolean = false
  @State chatId: string = ''
  @State title: string = ''
  private createdAt: number = 0
  private scroller: Scroller = new Scroller()
  private skillPrompt: string = ''
  private resourcesReady: Promise<void> | null = null
  private nextId: number = 1
  private lastScrollAt: number = 0
  /** Widget builds run one at a time: the DeepSeek engine has a single generation in flight. */
  private buildQueue: Promise<void> = Promise.resolve()
  /** The composed template a completion started from, kept for when the model cannot finish it. */
  private chatFallback: TemplateBuild | null = null

  private hostContext(): common.Context {
    let context = this.getUIContext().getHostContext()
    if (context === undefined) {
      this.status = 'Chat host context is unavailable'
      throw new Error(this.status)
    }
    return context
  }

  aboutToAppear(): void {
    let dir = this.hostContext().filesDir
    settings.init(dir)
    consent.init(dir)
    // The store VeraPreview saves a widget's state in, and the chats themselves.
    store.init(dir)
    chats.init(dir)
    initTrace(dir)
    this.getUIContext().setKeyboardAvoidMode(KeyboardAvoidMode.RESIZE)
    let params = this.getUIContext().getRouter().getParams() as Record<string, string>
    if (params !== null && params !== undefined && (params['chatId'] || '').length > 0) {
      this.openChat(params['chatId'])
    }
    this.loadResources().catch((_e: Error): void => {})
  }

  aboutToDisappear(): void {
    this.persist()
  }

  onPageShow(): void {
    if (!settings.hasApiKey()) {
      this.status = 'No DeepSeek API key yet (see CLAUDE.md)'
    } else if (this.status.startsWith('No DeepSeek')) {
      this.status = ''
    }
  }

  /** Brings a saved chat back. A widget that was still building when it was closed cannot be resumed. */
  private openChat(id: string): void {
    let saved = chats.load(id)
    if (saved === null) { return }
    this.chatId = saved!.id
    this.title = saved!.title
    this.createdAt = saved!.createdAt
    this.nextId = saved!.nextId
    let restored: ChatMessage[] = []
    for (let m of saved!.messages) {
      let msg = new ChatMessage()
      msg.id = m.id
      msg.role = m.role
      msg.before = m.before
      msg.after = m.after
      msg.appDescription = m.appDescription
      msg.appState = m.appState
      msg.vbc2 = m.vbc2
      msg.source = m.source
      msg.originalRequest = m.originalRequest
      msg.parentMessageId = m.parentMessageId
      msg.cutFrom = m.cutFrom
      msg.update = m.update
      msg.error = m.error
      msg.chatMs = m.chatMs
      msg.chatTtftMs = m.chatTtftMs
      msg.chatInput = m.chatInput
      msg.chatCached = m.chatCached
      msg.chatOutput = m.chatOutput
      msg.searches = m.searches
      msg.searchMs = m.searchMs
      msg.widgetMs = m.widgetMs
      msg.attempts = m.attempts
      msg.templatePick = m.templatePick
      if (msg.appState === APP_DESCRIBING || msg.appState === APP_BUILDING) {
        msg.appState = APP_FAILED
        msg.error = 'The chat was closed while this widget was still being built.'
      }
      restored.push(msg)
    }
    this.messages = restored
  }

  /** Writes the chat down. Called whenever something finishes, and on leaving. */
  private persist(): void {
    if (this.messages.length === 0) { return }
    if (this.chatId.length === 0) {
      this.chatId = chats.newId()
      this.createdAt = Date.now()
    }
    let chat = new StoredChat()
    chat.id = this.chatId
    chat.title = this.title
    chat.createdAt = this.createdAt
    chat.nextId = this.nextId
    for (let m of this.messages) {
      let sm = new StoredMessage()
      sm.id = m.id
      sm.role = m.role
      sm.before = m.before
      sm.after = m.after
      sm.appDescription = m.appDescription
      sm.appState = m.appState
      sm.vbc2 = m.vbc2
      sm.source = m.source
      sm.originalRequest = m.originalRequest
      sm.parentMessageId = m.parentMessageId
      sm.cutFrom = m.cutFrom
      sm.update = m.update
      sm.error = m.error
      sm.chatMs = m.chatMs
      sm.chatTtftMs = m.chatTtftMs
      sm.chatInput = m.chatInput
      sm.chatCached = m.chatCached
      sm.chatOutput = m.chatOutput
      sm.searches = m.searches
      sm.searchMs = m.searchMs
      sm.widgetMs = m.widgetMs
      sm.attempts = m.attempts
      sm.templatePick = m.templatePick
      chat.messages.push(sm)
    }
    chats.save(chat)
  }

  private async loadResources(): Promise<void> {
    if (this.resourcesReady === null) {
      this.resourcesReady = (async (): Promise<void> => {
        try {
          let context = this.hostContext()
          let capabilities = ensureCapabilities(context)
          loadCatalogFile(context.filesDir)
          let skill = await loadRawfileText(context.resourceManager, 'vera-skill.txt')
          let widget = await loadRawfileText(context.resourceManager, 'vera-widget.txt')
          if (skill.trim().length === 0 || widget.trim().length === 0) {
            throw new Error('Widget prompt resources are empty.')
          }
          this.skillPrompt = skill
            .replace('{{UI_CATALOG}}', describeCatalogForPrompt())
            .replace('{{UI_TOOL_NOTE}}\n', '') + widget
          await capabilities
          let note = modelSupportNote()
          if (note.length > 0 && this.status.length === 0) { this.status = note }
        } catch (e) {
          this.status = 'Failed to load resources: ' + (e as Error).message
          throw e as Error
        }
      })()
    }
    await this.resourcesReady!
  }

  private scrollDown(force: boolean = false): void {
    let now = Date.now()
    if (!force && now - this.lastScrollAt < SCROLL_EVERY_MS) { return }
    this.lastScrollAt = now
    setTimeout(() => { this.scroller.scrollEdge(Edge.Bottom) }, 60)
  }

  private history(): ChatTurn[] {
    let turns: ChatTurn[] = []
    for (let m of this.messages) {
      let text = m.before
      if (m.appDescription.length > 0 && m.role === 'assistant') {
        text = text + '\n[widget messageId=' + m.id.toString() + ', status=' + m.appState + ': ' + m.appDescription + ']'
      }
      if (m.after.length > 0) { text = text + '\n' + m.after }
      if (text.trim().length === 0) { continue }
      let t = new ChatTurn()
      t.messageId = m.id
      t.role = m.role
      t.text = text.trim()
      turns.push(t)
    }
    return turns
  }

  /** Capture scalar values before the reply or a queued build can change them. */
  private referenceSnapshots(): WidgetReference[] {
    let references: WidgetReference[] = []
    for (let msg of this.messages) {
      if (msg.role !== 'assistant' || msg.appState !== APP_READY) { continue }
      let ref = new WidgetReference()
      ref.messageId = msg.id
      ref.source = msg.source
      ref.originalRequest = msg.originalRequest
      ref.brief = msg.appDescription
      ref.latestState = msg.latestState
      references.push(ref)
    }
    return references
  }

  /** Stream visible text. A widget already handed to the builder keeps its state. */
  private apply(msg: ChatMessage, parsed: ParsedReply): void {
    msg.before = parsed.before + msg.beforeNote
    msg.after = parsed.after
    // A failure the builder already reported (startWidget, run while the reply
    // was still streaming, found no such widget) stands: the description in a
    // later chunk must not turn it back into "describing".
    let builderFailed = msg.appState === APP_FAILED && parsed.error.length === 0
    if (msg.appState === APP_BUILDING || msg.appState === APP_READY || builderFailed) {
      this.scrollDown()
      return
    }
    if (parsed.error.length > 0) {
      msg.appState = APP_FAILED
      msg.error = parsed.error
      msg.appDescription = ''
    } else if (parsed.describing || parsed.appDescription.length > 0) {
      msg.appState = APP_DESCRIBING
    }
    this.scrollDown()
  }

  private async send(): Promise<void> {
    let text = this.draft.trim()
    if (text.length === 0 || this.busy) { return }
    let references = this.referenceSnapshots()
    this.draft = ''
    this.busy = true
    let mine = new ChatMessage()
    mine.id = this.nextId++
    mine.role = 'user'
    mine.before = text
    if (this.title.length === 0) {
      this.title = text.length > 48 ? text.substring(0, 48) + '...' : text
    }
    this.messages = [...this.messages, mine]
    let turns = this.history()
    let context = new WidgetBuildContext()
    context.currentRequest = text
    context.originalRequest = text
    context.recentConversation = recentWidgetConversation(turns)
    let reply = new ChatMessage()
    reply.id = this.nextId++
    reply.role = 'assistant'
    this.messages = [...this.messages, reply]
    this.scrollDown(true)
    this.status = 'Thinking...'
    let stats = new ReplyStats()
    let started = false
    let sawText = false
    logMark('chat-send', 'chars=' + text.length.toString())
    try {
      let capsStartedAt = Date.now()
      await ensureCapabilities(this.hostContext())
      logStep('ensure-capabilities', capsStartedAt)
      let raw = await chatReply(turns, (soFar: string): void => {
        if (!sawText) { sawText = true; logMark('chat-first-text') }
        if (this.status === 'Thinking...') { this.status = '' }
        let parsed = parseReply(soFar)
        this.apply(reply, parsed)
        // A JSON marker is complete and final the moment its >> arrives -- a
        // second one would be an error either way -- so the build starts
        // while the rest of the reply is still being written.
        if (!started && parsed.structured && parsed.error.length === 0 && parsed.appDescription.length > 0) {
          started = true
          console.info('VERA-CHAT widget started before the reply ended, at ' + soFar.length.toString() + ' chars')
          this.startWidget(reply, parsed, references, context)
        }
      }, (status: string): void => {
        this.status = status.length > 0 ? status : 'Thinking...'
      }, stats, (verified: string): void => { context.verifiedSearchResults.push(verified) })
      logMark('chat-reply-done')
      console.info('VERA-CHAT reply: ' + raw)
      let parsed = parseReply(raw, true)
      this.apply(reply, parsed)
      if (started && parsed.error.length > 0) {
        // The rest of the reply broke the marker (a second one, say). The
        // build already under way is dropped when it finishes.
        reply.appState = APP_FAILED
        reply.error = parsed.error
      } else if (!started && parsed.error.length === 0 && parsed.appDescription.length > 0) {
        this.startWidget(reply, parsed, references, context)
      }
    } catch (e) {
      this.status = (e as Error).message
      if (reply.appState === APP_DESCRIBING) {
        reply.appState = APP_FAILED
        reply.error = 'The reply ended before the widget request was complete.'
      }
      // A reply that never started is not worth an empty row.
      if (reply.before.length === 0 && reply.appState === APP_NONE) {
        this.messages = this.messages.filter((m: ChatMessage): boolean => m.id !== reply.id)
      }
    }
    reply.chatMs = stats.ms
    reply.chatTtftMs = stats.ttftMs
    reply.chatInput = stats.inputTokens
    reply.chatCached = stats.cachedTokens
    reply.chatOutput = stats.outputTokens
    reply.searches = stats.searches
    reply.searchMs = stats.searchMs
    this.busy = false
    this.scrollDown(true)
    this.persist()
  }

  /** Resolve the widget a marker asks for and hand it to the builder. */
  private startWidget(reply: ChatMessage, parsed: ParsedReply, references: WidgetReference[],
      context: WidgetBuildContext): void {
    context.brief = parsed.appDescription
    if (parsed.mode === 'refine' || parsed.update) {
      let target: WidgetReference | undefined = parsed.update ? references[references.length - 1] :
        references.find((ref: WidgetReference): boolean => ref.messageId === parsed.targetMessageId)
      if (target === undefined) {
        reply.appState = APP_FAILED
        reply.error = 'The selected widget is unavailable. Specify an existing widget.'
        return
      }
      context.parentMessageId = target.messageId
      context.source = target.source
      context.originalRequest = target.originalRequest.length > 0 ? target.originalRequest : target.brief
      context.latestState = target.latestState
      if (target.source.length === 0) {
        reply.beforeNote = '\nThis older widget has no saved source. I will recreate it from its description.'
        reply.before = parsed.before + reply.beforeNote
      }
    }
    reply.appDescription = parsed.appDescription
    reply.cutFrom = 0
    reply.update = parsed.update || parsed.mode === 'refine'
    reply.appState = APP_BUILDING
    logMark('widget-queued')
    this.queueBuild(reply, context)
  }

  private queueBuild(msg: ChatMessage, context: WidgetBuildContext): void {
    this.buildQueue = this.buildQueue.then(async (): Promise<void> => {
      // The rest of the reply invalidated the marker while this waited.
      if (msg.appState === APP_FAILED) { return }
      let startedAt = Date.now()
      logMark('widget-build-start')
      let sawPreview = false
      try {
        await this.loadResources()
        logStep('load-resources', startedAt)
        // The Jev template path (on by default, see VeraTemplateSelectFlag.ets). Never attempted on a
        // refine (context.source non-empty): a revision asked for a change to an existing widget, not
        // a generic replacement.
        this.chatFallback = null
        if (templateSelectEnabled() && settings.hasSelectorKey() && context.source.length > 0) {
          msg.templatePick = 'skipped (refine)'
        }
        if (templateSelectEnabled() && settings.hasSelectorKey() && context.source.length === 0) {
          let handled = await this.tryTemplateSelectForChat(msg, context)
          if (handled === 'done') {
            msg.widgetMs = Date.now() - startedAt
            this.status = ''
            this.scrollDown(true)
            this.persist()
            return
          }
        }
        let app: MiniApp = await buildMiniApp(this.skillPrompt, context, (s: string): void => {
          if (msg.buildStatus !== s) { msg.buildStatus = s }
        }, '', (_s: string): void => {}, (vbc2: string): void => {
          if (msg.appState !== APP_BUILDING) { return }
          if (!sawPreview) { sawPreview = true; logMark('widget-preview') }
          msg.previewVbc2 = vbc2
          this.scrollDown(true)
        })
        msg.attempts = app.stats
        if (msg.appState === APP_FAILED) {
          // Invalidated while it was being built: keep the numbers, not the widget.
        } else if (app.error.length === 0 && app.vbc2.length > 0) {
          msg.vbc2 = app.vbc2
          msg.source = app.source
          msg.originalRequest = context.originalRequest
          msg.parentMessageId = context.parentMessageId
          msg.appState = APP_READY
          logMark('widget-ready')
        } else if (this.chatFallback !== null) {
          // The model could not finish the composed screen; the screen itself still works.
          let fallback: TemplateBuild = this.chatFallback!
          msg.templatePick = msg.templatePick + ' -- the model could not finish it, showing the template'
          msg.vbc2 = fallback.vbc2
          msg.source = fallback.source
          msg.originalRequest = context.originalRequest
          msg.parentMessageId = context.parentMessageId
          msg.appState = APP_READY
        } else {
          msg.error = app.error
          msg.appState = APP_FAILED
        }
      } catch (e) {
        msg.error = (e as Error).message
        msg.appState = APP_FAILED
      }
      msg.widgetMs = Date.now() - startedAt
      // After appState: the renderer has already been handed the finished program.
      msg.previewVbc2 = ''
      msg.buildStatus = ''
      this.scrollDown(true)
      this.persist()
    })
  }

  /**
   * The Jev template path for a widget request (VeraTemplatePipeline.ets). Answers 'done' when a
   * composed screen that compiles, runs and covers the request became the widget (msg is already
   * filled in), 'complete' when the composition is the right base but the model has to finish it
   * (context.source now holds it, and chatFallback keeps it for when the model cannot), and 'none'
   * when the widget has to be built from scratch, with msg and context untouched.
   */
  private async tryTemplateSelectForChat(msg: ChatMessage, context: WidgetBuildContext): Promise<string> {
    let prompt = context.brief.length > 0 ? context.brief : context.currentRequest
    let build: TemplateBuild = await buildFromTemplates(prompt, 'deepseek', (s: string): void => { this.status = s },
      (): boolean => false)
    if (build.action === BUILD_SCRATCH || build.action === BUILD_CANCELLED) {
      msg.templatePick = build.note + ' (generated normally)'
      return 'none'
    }
    if (build.action === BUILD_COMPLETE) {
      msg.templatePick = build.note + ' (completing)'
      context.source = build.source
      context.brief = prompt + '\n\nThe program provided is a ready-made screen for this request. Keep its layout and ' +
        'theme, and edit it so that everything the request asks for works.'
      this.chatFallback = build
      this.status = build.status
      return 'complete'
    }
    msg.templatePick = 'composed: ' + build.note
    msg.vbc2 = build.vbc2
    msg.source = build.source
    msg.originalRequest = context.originalRequest
    msg.parentMessageId = context.parentMessageId
    msg.appState = APP_READY
    msg.attempts = []
    this.status = build.status
    return 'done'
  }

  build() {
    Navigation() {
      Column() {
        // The same numbers the Generate screen shows for a program, for the
        // whole chat; each reply carries its own underneath when this is on.
        Row() {
          Text(this.title.length > 0 ? this.title : 'New chat')
            .fontSize(13).fontColor('#666666').maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis }).layoutWeight(1)
          Text('Stats').fontSize(13).fontColor('#666666').margin({ right: 8 })
          Toggle({ type: ToggleType.Switch, isOn: this.showStats })
            .onChange((on: boolean) => { this.showStats = on })
        }
        .width('100%')
        .padding({ left: 16, right: 12, top: 4, bottom: 4 })

        List({ space: 10, scroller: this.scroller }) {
          if (this.showStats && this.messages.length > 0) {
            ListItem() {
              StatsPanel({ tally: tallyOf(this.messages), attempts: [], heading: 'Whole chat' })
            }
          }
          ForEach(this.messages, (m: ChatMessage) => {
            ListItem() {
              MessageBubble({ msg: m, showStats: this.showStats, chatId: this.chatId })
            }
          }, (m: ChatMessage) => m.id.toString())
        }
        .layoutWeight(1)
        .width('100%')
        .padding({ left: 12, right: 12, top: 8, bottom: 8 })
        .scrollBar(BarState.Off)

        if (this.status.length > 0) {
          Text(this.status).fontSize(12).fontColor('#888888').width('100%').padding({ left: 16, right: 16, bottom: 4 })
        }

        Row({ space: 8 }) {
          TextInput({ placeholder: 'Message', text: this.draft })
            .onChange((value: string) => {
              this.draft = value
              // The key can arrive while this page is open, and onPageShow does not fire for that.
              if (this.status.startsWith('No DeepSeek') && settings.hasApiKey()) { this.status = '' }
            })
            .onSubmit(() => { this.send() })
            .layoutWeight(1)
            .height(44)
          Button('Send')
            .type(ButtonType.Normal)
            .borderRadius(10)
            .enabled(!this.busy && this.draft.trim().length > 0)
            .onClick(() => { this.send() })
        }
        .width('100%')
        .padding({ left: 12, right: 12, top: 6, bottom: 10 })
        .backgroundColor('#FFFFFF')
      }
      .width('100%')
      .height('100%')
      .backgroundColor('#F3F4F7')
    }
    .title('Chat')
    .titleMode(NavigationTitleMode.Mini)
  }
}
