import { formBindingData } from '@kit.FormKit'
import { store, STATE_MAX_BYTES } from './ProjectStore'
import { formBindings } from './FormBindings'
import { FormProjectStateReader, ProjectCommittedReadOnlyPort } from './ProjectStateMigration'
import { StateIo, LoadResult } from '../runtime/StateIo'
import { statePayloadBytes } from '../runtime/StateFileFormat'
import { LiveFrame, WidgetSession, compactFrame } from './VeraLiveWidget'
import { veraStateStamp } from './VeraStateStamp'
import { StateLifecycleDiag } from '../runtime/trace/StageTrace'

class FormCommittedStateIo implements ProjectCommittedReadOnlyPort {
  private io: StateIo

  constructor(root: string) {
    this.io = new StateIo(root, { directoryFsync: 'REQUIRED' })
  }

  readCommittedReadOnly(appId: string, expectedStamp: string): LoadResult {
    const operation = StateLifecycleDiag.operation()
    const started = StateLifecycleDiag.now()
    StateLifecycleDiag.emit('FORM', 'READ_BEGIN', operation)
    try {
      const result = this.io.readCommittedReadOnly(appId, expectedStamp)
      StateLifecycleDiag.emit('FORM', 'READ_END', operation, result.kind, StateLifecycleDiag.elapsed(started),
        undefined, result.matchingStamp)
      return result
    } catch (error) {
      StateLifecycleDiag.emit('FORM', 'READ_END', operation, 'REJECTED', StateLifecycleDiag.elapsed(started))
      throw error as Error
    }
  }
}

export function liveFrame(projectId: string, dimension: number = 2): LiveFrame {
  let fallback = new LiveFrame()
  fallback.projectId = projectId
  fallback.dimension = dimension
  if (projectId.length === 0) { fallback.status = 'Tap to choose an app'; return fallback }
  let project = store.getProject(projectId)
  if (project === null) {
    fallback.title = 'App removed'
    fallback.projectId = ''
    return fallback
  }
  fallback.title = project.name
  fallback.icon = project.icon
  let version = store.getLatestVersion(projectId)
  if (version === null || version.vbc2.length === 0) { fallback.status = 'Open project'; return fallback }
  try {
    let reader = new FormProjectStateReader(new FormCommittedStateIo(store.stateRoot()))
    let stamp = veraStateStamp(version.vbc2)
    let result = reader.loadStateResult(projectId, version.id, stamp)
    if (result.kind !== 'READY' || result.stamp !== stamp || !result.encodedState) {
      fallback.status = result.kind === 'UNAVAILABLE' || result.kind === 'LOST' ?
        result.code || 'Committed state unavailable; open app' : 'Open app to initialize state'
      return fallback
    }
    if (statePayloadBytes(result.encodedState).byteLength > STATE_MAX_BYTES) { throw new Error('PROJECT_READ_LIMIT') }
    let session = new WidgetSession(version.vbc2, version.id, result.encodedState, store.runtimeFlags())
    return session.frame(projectId, project.name, project.icon, dimension)
  } catch (e) {
    fallback.status = (e as Error).message
    console.error('VERA-FORM render: ' + fallback.status)
    return fallback
  }
}

export function liveBinding(projectId: string, formId: string = ''): formBindingData.FormBindingData {
  let frame = liveFrame(projectId, formId.length > 0 ? formBindings.dimensionFor(formId) : 2)
  frame.formId = formId
  return formBindingData.createFormBindingData(compactFrame(frame))
}

export async function liveFormTap(formId: string, message: string): Promise<formBindingData.FormBindingData> {
  let frame = liveFrame(formBindings.projectFor(formId), formBindings.dimensionFor(formId))
  frame.formId = formId
  try {
    let params = JSON.parse(message) as Record<string, Object>
    if (params !== null && typeof params['seq'] === 'string') { frame.seq = params['seq'] as string }
  } catch (_error) {}
  frame.status = 'Open app to interact; widget actions unavailable'
  return formBindingData.createFormBindingData(compactFrame(frame))
}

export class LiveRefresh {
  binding: formBindingData.FormBindingData
  ran: boolean = false
  constructor(binding: formBindingData.FormBindingData) { this.binding = binding }
}

export async function liveFormRefresh(formId: string): Promise<LiveRefresh> {
  return new LiveRefresh(liveBinding(formBindings.projectFor(formId), formId))
}
