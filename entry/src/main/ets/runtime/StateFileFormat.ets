import { cryptoFramework } from '@kit.CryptoArchitectureKit'
import { util } from '@kit.ArkTS'

export const STATE_HEADER_WINDOW_BYTES: number = 1024
export const STATE_FIELD_ORDER: string = 'TAGGED_INSERTION_ORDER'

export class StateFormatError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export interface StateMetadata {
  appId: string
  schemaVersion: number
  vmGeneration: number
  revision: number
  stamp: string
}

export interface StateHeader {
  format: number
  appId: string
  schemaVersion: number
  vmGeneration: number
  revision: number
  payloadLength: number
  payloadHash: string
}

export interface StateHeaderRead {
  kind: 'READY' | 'NEED_MORE'
  header?: StateHeader
  stamp?: string
  payloadOffset?: number
}

export interface DecodedStateData {
  format: 'FORMAT2' | 'LEGACY'
  header?: StateHeader
  stamp: string
  vmGeneration: number
  revision: number
  encodedState: string
  value: Object
  ignoreBackup: boolean
}

function corrupted(message: string): never {
  throw new StateFormatError('STATE_CORRUPTED', message)
}

function validCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER
}

function validateMetadata(meta: StateMetadata): void {
  if (typeof meta.appId !== 'string' || meta.appId.length === 0 ||
      !Number.isSafeInteger(meta.schemaVersion) || meta.schemaVersion < 1 ||
      !validCounter(meta.vmGeneration) || !validCounter(meta.revision) ||
      typeof meta.stamp !== 'string' || meta.stamp.indexOf('\u0000') >= 0) {
    corrupted('Invalid state metadata')
  }
}

export function canonicalPayload(value: Object): string {
  return canonicalValue(value, new Set<Object>())
}

function canonicalValue(value: Object, active: Set<Object>): string {
  if (value === null) { return 'null' }
  if (typeof value === 'string' || typeof value === 'boolean') { return JSON.stringify(value) }
  if (typeof value === 'number' && Number.isFinite(value)) { return JSON.stringify(value) }
  if (typeof value !== 'object' || active.has(value)) {
    throw new StateFormatError('STATE_VALIDATION_FAILED', 'Unsupported or cyclic payload')
  }
  active.add(value)
  let parts: string[] = []
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) { parts.push(canonicalValue(value[i], active)) }
  } else {
    if (value instanceof Date || value instanceof Map || value instanceof Set || value instanceof ArrayBuffer ||
        ArrayBuffer.isView(value)) {
      throw new StateFormatError('STATE_VALIDATION_FAILED', 'Payload must contain only JSON values')
    }
    let record = value as Record<string, Object>
    for (let key of Object.keys(record).sort()) {
      parts.push(JSON.stringify(key) + ':' + canonicalValue(record[key], active))
    }
  }
  active.delete(value)
  return Array.isArray(value) ? '[' + parts.join(',') + ']' : '{' + parts.join(',') + '}'
}

function validateValue(raw: Object): void {
  if (!Array.isArray(raw)) { corrupted('Invalid tagged state') }
  let parts = raw as Object[]
  let tag = parts[0]
  if (tag === 'z' && parts.length === 1) { return }
  if (parts.length === 2) {
    if (tag === 'n' && typeof parts[1] === 'number' && Number.isFinite(parts[1])) { return }
    if (tag === 's' && typeof parts[1] === 'string') { return }
    if (tag === 'b' && typeof parts[1] === 'boolean') { return }
    if (tag === 'a' && Array.isArray(parts[1])) {
      for (let item of parts[1] as Object[]) { validateValue(item) }
      return
    }
  }
  if (tag === 'o' && parts.length === 3 && typeof parts[1] === 'string' && Array.isArray(parts[2])) {
    let names = new Set<string>()
    for (let entry of parts[2] as Object[]) {
      if (!Array.isArray(entry)) { corrupted('Invalid object entry') }
      let pair = entry as Object[]
      if (pair.length !== 2 || typeof pair[0] !== 'string' || names.has(pair[0] as string)) {
        corrupted('Invalid or duplicate object field')
      }
      names.add(pair[0] as string)
      validateValue(pair[1])
    }
    return
  }
  corrupted('Invalid tagged state')
}

export function validateEncodedState(payload: string): Object {
  try {
    let value = JSON.parse(payload) as Object
    validateValue(value)
    return value
  } catch (_error) {
    throw new StateFormatError('STATE_VALIDATION_FAILED', 'Invalid serialized state payload')
  }
}

export function statePayloadBytes(payload: string): Uint8Array {
  return payload.length === 0 ? new Uint8Array(0) : new util.TextEncoder().encodeInto(payload)
}

export function statePayloadHash(stamp: string, payload: Uint8Array): string {
  if (typeof stamp !== 'string' || stamp.indexOf('\u0000') >= 0) { corrupted('Invalid state stamp') }
  try {
    let digest = cryptoFramework.createMd('SHA256')
    digest.updateSync({ data: statePayloadBytes(stamp + '\u0000') })
    digest.updateSync({ data: payload })
    let hex = ''
    for (let byte of digest.digestSync().data) { hex += byte.toString(16).padStart(2, '0') }
    return 'sha256:' + hex
  } catch (error) {
    throw error as Error
  }
}

export function assembleStateFile(meta: StateMetadata, payload: string): string {
  validateMetadata(meta)
  try {
    validateEncodedState(payload)
    let quoted = false
    for (let i = 0; i < payload.length; i++) {
      let c = payload[i]
      if (quoted && c === '\\') { i++ }
      else if (c === '"') { quoted = !quoted }
      else if (!quoted && /[\t\n\r ]/.test(c)) { throw new Error('Noncanonical whitespace') }
    }
  } catch (_error) {
    throw new StateFormatError('STATE_VALIDATION_FAILED', 'Invalid serialized state payload')
  }
  let bytes = statePayloadBytes(payload)
  return '{"format":2,"appId":' + JSON.stringify(meta.appId) +
    ',"schemaVersion":' + meta.schemaVersion.toString() +
    ',"vmGeneration":' + meta.vmGeneration.toString() +
    ',"revision":' + meta.revision.toString() +
    ',"payloadLength":' + bytes.byteLength.toString() +
    ',"payloadHash":' + JSON.stringify(statePayloadHash(meta.stamp, bytes)) +
    ',"stamp":' + JSON.stringify(meta.stamp) + ',"value":' + payload + '}'
}

class HeaderScanner {
  position: number = 0
  text: string
  complete: boolean
  constructor(text: string, complete: boolean) { this.text = text; this.complete = complete }
  space(): void {
    while (this.position < this.text.length && /[\t\n\r ]/.test(this.text[this.position])) { this.position++ }
  }
  need(): never {
    if (this.complete) { corrupted('Truncated state header') }
    throw new StateFormatError('HEADER_INCOMPLETE', 'State header needs a full read')
  }
  character(expected: string): void {
    this.space()
    if (this.position === this.text.length) { this.need() }
    if (this.text[this.position++] !== expected) { corrupted('Invalid state header order') }
  }
  scalar(): Object {
    this.space()
    let start = this.position
    if (start === this.text.length) { this.need() }
    if (this.text[this.position] === '"') {
      this.position++
      let closed = false
      while (this.position < this.text.length) {
        let c = this.text[this.position++]
        if (c === '\\') { this.position++ }
        else if (c === '"') { closed = true; break }
      }
      if (!closed) { this.need() }
    } else {
      while (this.position < this.text.length && !/[,}\t\n\r ]/.test(this.text[this.position])) { this.position++ }
      if (this.position === this.text.length && !this.complete) { this.need() }
    }
    try { return JSON.parse(this.text.slice(start, this.position)) as Object }
    catch (_error) { return corrupted('Invalid state header value') }
  }
}

export function readStateHeader(text: string, complete: boolean = false): StateHeaderRead {
  let scanner = new HeaderScanner(text, complete)
  let names = ['format', 'appId', 'schemaVersion', 'vmGeneration', 'revision', 'payloadLength', 'payloadHash', 'stamp']
  let fields: Record<string, Object> = {}
  try {
    scanner.character('{')
    for (let i = 0; i < names.length; i++) {
      if (i > 0) { scanner.character(',') }
      if (scanner.scalar() !== names[i]) { corrupted('Invalid state header order') }
      scanner.character(':')
      fields[names[i]] = scanner.scalar()
    }
    scanner.character(',')
    if (scanner.scalar() !== 'value') { corrupted('Missing state payload') }
    scanner.character(':')
    scanner.space()
  } catch (error) {
    if ((error as StateFormatError).code === 'HEADER_INCOMPLETE') { return { kind: 'NEED_MORE' } }
    throw error as Error
  }
  let meta: StateMetadata = {
    appId: fields['appId'] as string, schemaVersion: fields['schemaVersion'] as number,
    vmGeneration: fields['vmGeneration'] as number, revision: fields['revision'] as number,
    stamp: fields['stamp'] as string
  }
  validateMetadata(meta)
  if (fields['format'] !== 2 || !Number.isSafeInteger(fields['payloadLength']) ||
      (fields['payloadLength'] as number) < 0 || typeof fields['payloadHash'] !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(fields['payloadHash'] as string)) { corrupted('Invalid state header') }
  let header: StateHeader = {
    format: 2, appId: meta.appId, schemaVersion: meta.schemaVersion,
    vmGeneration: meta.vmGeneration, revision: meta.revision,
    payloadLength: fields['payloadLength'] as number, payloadHash: fields['payloadHash'] as string
  }
  return { kind: 'READY', header: header, stamp: meta.stamp, payloadOffset: scanner.position }
}

export function validateStateFile(text: string, appId: string, schemaVersion: number = 1): DecodedStateData {
  try {
    let raw = JSON.parse(text) as Record<string, Object>
    if (raw === null || Array.isArray(raw) || typeof raw !== 'object') { corrupted('Invalid state file') }
    if (Object.keys(raw).indexOf('format') < 0) {
      if (typeof raw['stamp'] !== 'string' || (raw['stamp'] as string).indexOf('\u0000') >= 0) {
        corrupted('Invalid legacy stamp')
      }
      validateValue(raw['value'])
      return {
        format: 'LEGACY', stamp: raw['stamp'] as string, vmGeneration: 0, revision: 0,
        encodedState: canonicalPayload(raw['value']), value: raw['value'], ignoreBackup: true
      }
    }
    let read = readStateHeader(text, true)
    let header = read.header as StateHeader
    if (Object.keys(raw).length !== 9 || header.appId !== appId || header.schemaVersion !== schemaVersion) {
      corrupted('State identity or schema mismatch')
    }
    let end = text.length
    while (end > 0 && /[\t\n\r ]/.test(text[end - 1])) { end-- }
    let payload = text.slice(read.payloadOffset as number, end - 1)
    let bytes = statePayloadBytes(payload)
    if (bytes.byteLength !== header.payloadLength || statePayloadHash(read.stamp as string, bytes) !== header.payloadHash) {
      corrupted('State payload integrity mismatch')
    }
    let encoded = JSON.parse(payload) as Object
    validateValue(encoded)
    return {
      format: 'FORMAT2', header: header, stamp: read.stamp as string,
      vmGeneration: header.vmGeneration, revision: header.revision,
      encodedState: payload, value: encoded, ignoreBackup: false
    }
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError) { return corrupted('Invalid state file') }
    throw error as Error
  }
}
