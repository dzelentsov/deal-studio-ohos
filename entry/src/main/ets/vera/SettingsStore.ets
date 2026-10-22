/**
 * Device-local settings: the DeepSeek API key and the model to call.
 *
 * The key is written by EntryAbility from a launch parameter, so it never has
 * to be typed on the phone:
 *
 *   hdc shell aa start -a EntryAbility -b com.vera.probe.dyn \
 *     --ps deepseekKey sk-...
 *
 * It lives in the app sandbox ({filesDir}/vera/settings.json), not in the HAP
 * and not in this repository. Only maskedKey() is ever shown or logged.
 */

import fs from '@ohos.file.fs'

export const DEFAULT_DEEPSEEK_BASE_URL: string = 'https://api.deepseek.com'
export const DEFAULT_DEEPSEEK_MODEL: string = 'deepseek-flash'
/**
 * reasoning_effort when none is set. On the generation benchmark (5 prompts x 3
 * runs) 'low' cut reasoning from 185k to 124k tokens and total time by a fifth
 * against the API's default, with the same first-attempt compile rate once the
 * compiler's assignment check was fixed.
 */
export const DEFAULT_REASONING_EFFORT: string = 'low'

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

export class SettingsStore {
  private root: string = ''
  private apiKey: string = ''
  private model: string = DEFAULT_DEEPSEEK_MODEL
  private baseUrl: string = DEFAULT_DEEPSEEK_BASE_URL
  /**
   * Where vera-server lives, for the Server generation mode.
   *
   * There is no default. It used to be one person's machine written into the
   * source -- a bare address that meant nothing to anyone else and had no
   * business in a shared repository. Supply it the way the key is supplied and
   * it is remembered; leave it out and Server mode simply says it is not
   * configured.
   */
  private serverUrl: string = ''
  /**
   * The TypeSafe key, for the step that picks which intents a request needs.
   *
   * Supplied like the others -- `--ps typesafeKey ...` -- and optional in a way
   * the DeepSeek key is not: without it the whole intent catalogue goes into
   * the prompt, which is what happened before there was a selection step.
   */
  private selectorKey: string = ''
  /**
   * The Exa key, for the chat's web search. Supplied like the others,
   * `--ps exaKey ...`; without it the assistant simply has no search tool.
   */
  private exaKey: string = ''
  /**
   * DeepSeek's reasoning_effort for requests with thinking on; '' means
   * DEFAULT_REASONING_EFFORT. Supplied as `--ps reasoningEffort high` (EntryAbility).
   */
  private reasoningEffort: string = ''
  private loaded: boolean = false

  init(filesDir: string): void {
    this.root = filesDir + '/vera'
    try { fs.mkdirSync(this.root, true) } catch (_e) {}
    this.load()
  }

  isReady(): boolean { return this.root.length > 0 }

  private path(): string { return this.root + '/settings.json' }

  private load(): void {
    let text = readText(this.path())
    if (text.length > 0) {
      try {
        let obj = JSON.parse(text) as Record<string, Object>
        this.apiKey = (obj['apiKey'] as string) || ''
        this.model = (obj['model'] as string) || DEFAULT_DEEPSEEK_MODEL
        this.baseUrl = (obj['baseUrl'] as string) || DEFAULT_DEEPSEEK_BASE_URL
        this.serverUrl = (obj['serverUrl'] as string) || ''
        this.selectorKey = (obj['selectorKey'] as string) || ''
        this.exaKey = (obj['exaKey'] as string) || ''
        this.reasoningEffort = (obj['reasoningEffort'] as string) || ''
      } catch (_e) {}
    }
    this.loaded = true
  }

  private save(): void {
    if (this.root.length === 0) { return }
    let obj: Record<string, Object> = {}
    obj['apiKey'] = this.apiKey
    obj['model'] = this.model
    obj['baseUrl'] = this.baseUrl
    obj['serverUrl'] = this.serverUrl
    obj['selectorKey'] = this.selectorKey
    obj['exaKey'] = this.exaKey
    obj['reasoningEffort'] = this.reasoningEffort
    try { writeText(this.path(), JSON.stringify(obj)) } catch (_e) {}
  }

  getApiKey(): string {
    if (!this.loaded) { this.load() }
    return this.apiKey
  }

  hasApiKey(): boolean { return this.getApiKey().length > 0 }

  getServerUrl(): string {
    if (!this.loaded) { this.load() }
    return this.serverUrl
  }

  hasServerUrl(): boolean { return this.getServerUrl().length > 0 }

  setServerUrl(url: string): void {
    if (!this.loaded) { this.load() }
    this.serverUrl = url
    this.save()
  }

  getSelectorKey(): string {
    if (!this.loaded) { this.load() }
    return this.selectorKey
  }

  hasSelectorKey(): boolean { return this.getSelectorKey().length > 0 }

  getExaKey(): string {
    if (!this.loaded) { this.load() }
    return this.exaKey
  }

  hasExaKey(): boolean { return this.getExaKey().length > 0 }

  getReasoningEffort(): string {
    if (!this.loaded) { this.load() }
    return this.reasoningEffort.length > 0 ? this.reasoningEffort : DEFAULT_REASONING_EFFORT
  }

  setReasoningEffort(effort: string): void {
    if (!this.loaded) { this.load() }
    this.reasoningEffort = effort.trim()
    this.save()
  }

  setExaKey(key: string): void {
    if (!this.loaded) { this.load() }
    this.exaKey = key.trim()
    this.save()
  }

  setSelectorKey(key: string): void {
    if (!this.loaded) { this.load() }
    this.selectorKey = key.trim()
    this.save()
  }

  setApiKey(key: string): void {
    this.apiKey = key.trim()
    this.save()
  }

  getModel(): string {
    if (!this.loaded) { this.load() }
    return this.model.length > 0 ? this.model : DEFAULT_DEEPSEEK_MODEL
  }

  setModel(model: string): void {
    this.model = model.trim()
    this.save()
  }

  getBaseUrl(): string {
    if (!this.loaded) { this.load() }
    return this.baseUrl.length > 0 ? this.baseUrl : DEFAULT_DEEPSEEK_BASE_URL
  }

  /** 'sk-...abcd' — enough to tell whether the key arrived, useless if leaked. */
  maskedKey(): string {
    let key = this.getApiKey()
    if (key.length === 0) { return '(no key)' }
    if (key.length <= 7) { return 'sk-...' }
    return key.substring(0, 3) + '...' + key.substring(key.length - 4)
  }
}

export const settings: SettingsStore = new SettingsStore()
