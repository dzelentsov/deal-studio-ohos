import { RuntimeValue, encodeRuntimeValue, decodeRuntimeValue } from '../vera/VeraInterpreter'
import {
  StateFormatError, StateMetadata, StateHeader, assembleStateFile, canonicalPayload,
  validateEncodedState, validateStateFile
} from './StateFileFormat'

export {
  STATE_HEADER_WINDOW_BYTES, STATE_FIELD_ORDER, StateFormatError, StateMetadata, StateHeader,
  StateHeaderRead, DecodedStateData, canonicalPayload, statePayloadBytes, statePayloadHash,
  assembleStateFile, readStateHeader, validateEncodedState, validateStateFile
} from './StateFileFormat'

export interface DecodedStateFile {
  format: 'FORMAT2' | 'LEGACY'
  header?: StateHeader
  stamp: string
  vmGeneration: number
  revision: number
  encodedState: string
  value: RuntimeValue
  ignoreBackup: boolean
}

export function encodeStateFile(meta: StateMetadata, value: RuntimeValue): string {
  let payload: string
  try {
    payload = canonicalPayload(encodeRuntimeValue(value))
    validateEncodedState(payload)
  } catch (_error) {
    throw new StateFormatError('STATE_VALIDATION_FAILED', 'State cannot be serialized')
  }
  return assembleStateFile(meta, payload)
}

export function decodeStateFile(text: string, appId: string, schemaVersion: number = 1): DecodedStateFile {
  let decoded = validateStateFile(text, appId, schemaVersion)
  return {
    format: decoded.format, header: decoded.header, stamp: decoded.stamp,
    vmGeneration: decoded.vmGeneration, revision: decoded.revision,
    encodedState: decoded.encodedState, value: decodeRuntimeValue(decoded.value),
    ignoreBackup: decoded.ignoreBackup
  }
}
