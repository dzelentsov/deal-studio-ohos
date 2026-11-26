import { formBindingData, formProvider } from '@kit.FormKit'
import { store, STATE_MAX_BYTES } from './ProjectStore'
import { LiveFrame, WidgetSession, compactFrame } from './VeraLiveWidget'
import { veraStateStamp } from './VeraStateStamp'
import { formBindings } from './FormBindings'
import { liveBinding } from './LiveFormService'

export function buildFormBinding(): formBindingData.FormBindingData {
  let projects = store.listProjects()
  let arr: Record<string, string>[] = []
  for (let p of projects) {
    let item: Record<string, string> = {}
    item['id'] = p.id
    item['name'] = p.name
    item['icon'] = p.icon
    arr.push(item)
  }
  let obj: Record<string, Object> = {}
  obj['count'] = arr.length
  obj['hasProjects'] = arr.length > 0
  obj['projects'] = arr
  return formBindingData.createFormBindingData(obj)
}

class CardReadIdentity {
  projectId: string
  formId: string
  dimension: number
  private exists: boolean
  private createdAt: number
  private name: string
  private icon: string
  private versionId: string
  private bytecode: string

  constructor(projectId: string, formId: string) {
    this.projectId = projectId
    this.formId = formId
    this.dimension = formId.length > 0 ? formBindings.dimensionFor(formId) : 2
    let project = projectId.length > 0 ? store.getProject(projectId) : null
    let version = project !== null ? store.getLatestVersion(projectId) : null
    this.exists = project !== null
    this.createdAt = project !== null ? project.createdAt : 0
    this.name = project !== null ? project.name : ''
    this.icon = project !== null ? project.icon : ''
    this.versionId = version !== null ? version.id : ''
    this.bytecode = version !== null ? version.vbc2 : ''
  }

  current(): boolean {
    if (this.formId.length > 0 && (formBindings.projectFor(this.formId) !== this.projectId ||
        formBindings.dimensionFor(this.formId) !== this.dimension)) { return false }
    let project = this.projectId.length > 0 ? store.getProject(this.projectId) : null
    if ((project !== null) !== this.exists) { return false }
    if (project === null) { return true }
    let version = store.getLatestVersion(this.projectId)
    return project.createdAt === this.createdAt && project.name === this.name && project.icon === this.icon &&
      (version !== null ? version.id : '') === this.versionId &&
      (version !== null ? version.vbc2 : '') === this.bytecode
  }
}

export async function mainLiveBinding(projectId: string, formId: string = ''): Promise<formBindingData.FormBindingData> {
  let identity = new CardReadIdentity(projectId, formId)
  let frame = new LiveFrame()
  frame.projectId = projectId
  frame.dimension = formId.length > 0 ? formBindings.dimensionFor(formId) : 2
  frame.formId = formId
  try {
    let project = projectId.length > 0 ? store.getProject(projectId) : null
    if (projectId.length === 0) {
      frame.status = 'Tap to choose an app'
    } else if (project === null) {
      frame.title = 'App removed'
      frame.projectId = ''
    } else {
      frame.title = project.name
      frame.icon = project.icon
      let version = store.getLatestVersion(projectId)
      if (version === null || version.vbc2.length === 0) {
        frame.status = 'Open project'
      } else {
        let flags = store.runtimeFlags()
        let saved = await store.loadState(projectId, version.id, veraStateStamp(version.vbc2), STATE_MAX_BYTES)
        if (!identity.current()) { throw new Error('Widget refresh superseded') }
        if (saved.length === 0) {
          frame.status = 'Open app to initialize state'
        } else {
          frame = new WidgetSession(version.vbc2, version.id, saved, flags)
            .frame(projectId, project.name, project.icon, frame.dimension)
          frame.formId = formId
        }
      }
    }
  } catch (error) {
    frame.status = (error as Error).message
    console.warn('VERA-FORM main render: ' + frame.status)
  }
  if (!identity.current()) { throw new Error('Widget refresh superseded') }
  return formBindingData.createFormBindingData(compactFrame(frame))
}

class CardRefreshGeneration {
  request: number
  publication: Promise<void> = Promise.resolve()

  constructor(request: number) { this.request = request }
}

let cardRefreshes: Map<string, CardRefreshGeneration> = new Map<string, CardRefreshGeneration>()
let cardRefreshRequest: number = 0
let activeCardRefreshes: number = 0

function beginCardRefresh(): number {
  activeCardRefreshes += 1
  return ++cardRefreshRequest
}

function endCardRefresh(): void {
  activeCardRefreshes -= 1
  if (activeCardRefreshes === 0) { cardRefreshes.clear() }
}

async function updateCardById(formId: string, live: boolean, projectId: string, mainProcess: boolean,
    request: number): Promise<void> {
  let previous = cardRefreshes.get(formId)
  if (previous !== undefined && previous.request > request) { return }
  let generation = new CardRefreshGeneration(request)
  if (previous !== undefined) { generation.publication = previous.publication }
  cardRefreshes.set(formId, generation)
  let identity = new CardReadIdentity(projectId, formId)
  if (!identity.current()) { return }
  let data = live ? (mainProcess ? await mainLiveBinding(projectId, formId) : liveBinding(projectId, formId)) : buildFormBinding()
  let publication = generation.publication.then(async (): Promise<void> => {
    if (cardRefreshes.get(formId) !== generation || !identity.current()) { return }
    await formProvider.updateForm(formId, data)
  })
  generation.publication = publication.catch((): void => {})
  await publication
}

export async function refreshForms(excludeFormId: string = ''): Promise<void> {
  let request = beginCardRefresh()
  try {
    let infos = await formProvider.getPublishedRunningFormInfos()
    for (let info of infos) {
      if (info.formId === excludeFormId) { continue }
      try {
        if (info.formName !== 'widget' && info.formName !== 'live') { continue }
        await updateCardById(info.formId, info.formName === 'live', formBindings.projectFor(info.formId), true, request)
      } catch (e) { console.warn('VERA-FORM refresh: ' + (e as Error).message) }
    }
  } catch (e) { console.warn('VERA-FORM list: ' + (e as Error).message) }
  finally { endCardRefresh() }
}

/** Redraws this project's own live cards (and no other card) from its saved state; `excludeFormId` is already drawn. */
export async function refreshProjectCards(projectId: string, excludeFormId: string = '', mainProcess: boolean = false): Promise<void> {
  let request = beginCardRefresh()
  try {
    for (let formId of formBindings.formsFor(projectId)) {
      if (formId === excludeFormId) { continue }
      try {
        await updateCardById(formId, true, projectId, mainProcess, request)
      } catch (e) { console.warn('VERA-FORM refresh ' + formId + ': ' + (e as Error).message) }
    }
  } finally { endCardRefresh() }
}

/** How often a running app's saves may redraw its cards: a ticker saves every second, a card needs nothing like that. */
export const CARD_REFRESH_MS: number = 5000

let refreshTimer: number = -1
let pendingProjects: Set<string> = new Set<string>()
/**
 * A running app saved its state: its cards are redrawn, at most once per CARD_REFRESH_MS, and only when it has any. The
 * last save in a burst is never lost. A project with no card costs one read of the bindings and nothing else.
 */
export function scheduleCardRefresh(projectId: string): void {
  if (projectId.length === 0 || formBindings.formsFor(projectId).length === 0) { return }
  pendingProjects.add(projectId)
  if (refreshTimer >= 0) { return }
  refreshTimer = setTimeout(() => {
    refreshTimer = -1
    let projects = Array.from(pendingProjects)
    pendingProjects.clear()
    for (let id of projects) { refreshProjectCards(id, '', true) }
  }, CARD_REFRESH_MS)
}
