/**
 * Saved chats: one JSON file per chat under {filesDir}/vera/chats, listed
 * newest first. A chat keeps its messages, each widget's bytecode and the
 * numbers behind every turn, so reopening it shows the same conversation, the
 * same widgets and the same stats.
 *
 * A widget's own state (a timer's setting, a tick box) is saved by VeraPreview
 * under the key `chat-<chatId>/<messageId>`, in the same place a project's
 * program state goes; remove() clears that too.
 */

import fs from '@ohos.file.fs'
import { AttemptStat, costOf } from './VeraChatStats'

export class StoredMessage {
  id: number = 0
  role: string = 'user'
  before: string = ''
  after: string = ''
  appDescription: string = ''
  appState: string = 'none'
  vbc2: string = ''
  source: string = ''
  originalRequest: string = ''
  parentMessageId: number = 0
  /** Historical truncation metadata. New requests are never truncated. */
  cutFrom: number = 0
  update: boolean = false
  error: string = ''
  chatMs: number = 0
  chatTtftMs: number = 0
  chatInput: number = 0
  chatCached: number = 0
  chatOutput: number = 0
  searches: number = 0
  searchMs: number = 0
  widgetMs: number = 0
  attempts: AttemptStat[] = []
  /**
   * Experiment only (experiment/jev-template-select branch): what
   * tryTemplateSelectForChat (ChatPage.ets) decided for this message, kept
   * here because hilog's ring buffer does not survive a busy widget's own
   * logging and gets overwritten within seconds -- this persists instead.
   */
  templatePick: string = ''
}

export class StoredChat {
  id: string = ''
  title: string = ''
  createdAt: number = 0
  updatedAt: number = 0
  nextId: number = 1
  messages: StoredMessage[] = []
}

/** What the list of chats shows. */
export class ChatSummary {
  id: string = ''
  title: string = ''
  updatedAt: number = 0
  messages: number = 0
  costUsd: number = 0
  widgets: number = 0
}

function ensureDir(path: string): void {
  try { fs.mkdirSync(path, true) } catch (_e) {}
}

function readText(path: string): string {
  try {
    let stat = fs.statSync(path)
    if (stat.size === 0) { return '' }
    return fs.readTextSync(path)
  } catch (_e) {
    return ''
  }
}

function writeText(path: string, content: string): void {
  let file: fs.File | null = null
  let failed = false
  try {
    file = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC)
    fs.writeSync(file.fd, content)
  } catch (e) {
    failed = true
    throw e as Error
  } finally {
    if (file !== null) {
      try {
        fs.closeSync(file)
      } catch (e) {
        if (!failed) { throw e as Error }
      }
    }
  }
}

function str(obj: Record<string, Object>, key: string): string {
  let v = obj[key]
  return typeof v === 'string' ? v as string : ''
}

function num(obj: Record<string, Object>, key: string): number {
  let v = obj[key]
  return typeof v === 'number' ? v as number : 0
}

function parseAttempt(raw: Object): AttemptStat {
  let o = raw as Record<string, Object>
  let a = new AttemptStat()
  a.attempt = num(o, 'attempt')
  a.ttftMs = num(o, 'ttftMs')
  a.thinkMs = num(o, 'thinkMs')
  a.genMs = num(o, 'genMs')
  a.compileMs = num(o, 'compileMs')
  a.inputTokens = num(o, 'inputTokens')
  a.cachedTokens = num(o, 'cachedTokens')
  a.outputTokens = num(o, 'outputTokens')
  a.success = o['success'] === true
  a.verdict = str(o, 'verdict')
  return a
}

function parseMessage(raw: Object): StoredMessage {
  let o = raw as Record<string, Object>
  let m = new StoredMessage()
  m.id = num(o, 'id')
  m.role = str(o, 'role') || 'user'
  m.before = str(o, 'before')
  m.after = str(o, 'after')
  m.appDescription = str(o, 'appDescription')
  m.appState = str(o, 'appState') || 'none'
  m.vbc2 = str(o, 'vbc2')
  m.source = str(o, 'source')
  m.originalRequest = str(o, 'originalRequest')
  m.parentMessageId = num(o, 'parentMessageId')
  m.cutFrom = num(o, 'cutFrom')
  m.update = o['update'] === true
  m.error = str(o, 'error')
  m.chatMs = num(o, 'chatMs')
  m.chatTtftMs = num(o, 'chatTtftMs')
  m.chatInput = num(o, 'chatInput')
  m.chatCached = num(o, 'chatCached')
  m.chatOutput = num(o, 'chatOutput')
  m.searches = num(o, 'searches')
  m.searchMs = num(o, 'searchMs')
  m.widgetMs = num(o, 'widgetMs')
  m.templatePick = str(o, 'templatePick')
  let attempts = o['attempts'] as Object[]
  if (attempts !== null && attempts !== undefined) {
    for (let a of attempts) { m.attempts.push(parseAttempt(a)) }
  }
  return m
}

function parseChat(text: string): StoredChat | null {
  try {
    let o = JSON.parse(text) as Record<string, Object>
    let c = new StoredChat()
    c.id = str(o, 'id')
    c.title = str(o, 'title')
    c.createdAt = num(o, 'createdAt')
    c.updatedAt = num(o, 'updatedAt')
    c.nextId = num(o, 'nextId') || 1
    let messages = o['messages'] as Object[]
    if (messages !== null && messages !== undefined) {
      for (let m of messages) { c.messages.push(parseMessage(m)) }
    }
    return c.id.length > 0 ? c : null
  } catch (_e) {
    return null
  }
}

export function chatCost(c: StoredChat): number {
  let usd = 0
  for (let m of c.messages) {
    usd = usd + costOf(m.chatInput, m.chatCached, m.chatOutput)
    for (let a of m.attempts) { usd = usd + costOf(a.inputTokens, a.cachedTokens, a.outputTokens) }
  }
  return usd
}

export class ChatStore {
  private root: string = ''
  private base: string = ''

  init(filesDir: string): void {
    this.base = filesDir + '/vera'
    this.root = this.base + '/chats'
    ensureDir(this.root)
  }

  private path(id: string): string { return this.root + '/' + id + '.json' }

  newId(): string {
    return Date.now().toString(36) + Math.floor(Math.random() * 0xFFFFFF).toString(36)
  }

  /** The key VeraPreview saves a chat widget's state under. */
  stateKey(chatId: string, messageId: number): string {
    return 'chat-' + chatId + '/' + messageId.toString()
  }

  save(chat: StoredChat): void {
    if (this.root.length === 0 || chat.id.length === 0) { return }
    chat.updatedAt = Date.now()
    try {
      writeText(this.path(chat.id), JSON.stringify(chat))
    } catch (e) {
      console.error('VERA-CHAT save failed: ' + (e as Error).message)
    }
  }

  load(id: string): StoredChat | null {
    let text = readText(this.path(id))
    return text.length === 0 ? null : parseChat(text)
  }

  remove(id: string): void {
    try { fs.unlinkSync(this.path(id)) } catch (_e) {}
    try { fs.rmdirSync(this.base + '/chat-' + id) } catch (_e) {}
  }

  list(): ChatSummary[] {
    let out: ChatSummary[] = []
    let files: string[] = []
    try { files = fs.listFileSync(this.root) } catch (_e) { return out }
    for (let file of files) {
      if (!file.endsWith('.json')) { continue }
      let chat = parseChat(readText(this.root + '/' + file))
      if (chat === null) { continue }
      let s = new ChatSummary()
      s.id = chat!.id
      s.title = chat!.title
      s.updatedAt = chat!.updatedAt
      s.messages = chat!.messages.length
      s.costUsd = chatCost(chat!)
      for (let m of chat!.messages) { if (m.vbc2.length > 0) { s.widgets++ } }
      out.push(s)
    }
    out.sort((a: ChatSummary, b: ChatSummary): number => b.updatedAt - a.updatedAt)
    return out
  }
}

export const chats: ChatStore = new ChatStore()
