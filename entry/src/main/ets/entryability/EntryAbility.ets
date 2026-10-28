import UIAbility from '@ohos.app.ability.UIAbility'
import Want from '@ohos.app.ability.Want'
import AbilityConstant from '@ohos.app.ability.AbilityConstant'
import contextConstant from '@ohos.app.ability.contextConstant'
import window from '@ohos.window'
import routerApi from '@ohos.router'
import hilog from '@ohos.hilog'
import { refreshForms } from '../vera/FormUpdater'
import { store } from '../vera/ProjectStore'
import { settings } from '../vera/SettingsStore'
import { requestCalendarPermissions, requestMicrophonePermission } from '../vera/VeraPermissions'
import { runProbe } from '../vera/IntentProbe'
import { runSdkProbe, requestSdkSearch } from '../vera/VeraSdkProbe'
import { requestBenchmark } from '../vera/VeraSearchBenchmark'
import { requestSdkEval } from '../vera/VeraSdkEval'
import { requestUiEval } from '../vera/VeraUiEval'
import { requestUiAb } from '../vera/VeraUiAb'
import { setComposeEnabled, setComposePlanEnabled, setCustomSectionsEnabled } from '../vera/VeraCompose'
import { setRouteOrder, routeOrder, setWholeScreenEnabled } from '../vera/agent/VeraBuildRoute'
import { loadCatalogFile } from '../vera/VeraCatalogFile'
import { startPowerKeyProbe } from '../vera/PowerKeyProbe'
import { enableTemplateSelect, disableTemplateSelect } from '../vera/VeraTemplateSelectFlag'

const DOMAIN = 0x0000

class ProjectNavParams {
  projectId: string = ''
}

class RunProjectNavParams {
  projectId: string = ''
  versionId: string = ''
  vbc2: string = ''
  shortcutMode: string = ''
  launchError: string = ''
}

class LaunchRoute {
  kind: string = 'home'
  projectId: string = ''
  revision: number = 0
}

export default class EntryAbility extends UIAbility {
  private pendingRoute: LaunchRoute | null = null
  private lastDestination: LaunchRoute | null = null
  private launchRevision: number = 0
  private contentReady: boolean = false
  private windowStageGeneration: number = 0
  private activeWindowStage: window.WindowStage | null = null
  private routeDrainGeneration: number = -1
  private isolatedRoot: boolean = false
  private rootNeedsReset: boolean = false
  private normalLayoutFullScreen: boolean = false

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, 'VERA', 'EntryAbility onCreate')
    try {
      this.context.setOnNewWantSkipScenarios(
        contextConstant.Scenarios.SCENARIO_MOVE_MISSION_TO_FRONT |
        contextConstant.Scenarios.SCENARIO_SHOW_ABILITY |
        contextConstant.Scenarios.SCENARIO_BACK_TO_CALLER_ABILITY_WITH_RESULT
      ).catch((e: Error): void => {
        hilog.error(DOMAIN, 'VERA', 'Configure resume launch handling failed: ' + e.message)
      })
    } catch (e) {
      hilog.error(DOMAIN, 'VERA', 'Configure resume launch handling failed: ' + (e as Error).message)
    }
    // Before anything can be generated or compiled: the vocabulary a program is
    // allowed to use must not change underneath a program that is being written.
    loadCatalogFile(this.context.filesDir)
    startPowerKeyProbe()
    this.extractApiKey(want)
    this.extractSelectorKey(want)
    this.extractExaKey(want)
    this.extractReasoningEffort(want)
    this.extractServerUrl(want)
    this.extractProjectId(want)
    this.extractProbe(want)
    this.extractSdkProbe(want)
    this.extractSdkSearchProbe(want)
    this.extractBenchmark(want)
    this.extractSdkEval(want)
    this.extractUiEval(want)
    this.extractUiAb(want)
    this.extractCompose(want)
    this.extractTemplateSelect(want)
  }

  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, 'VERA', 'EntryAbility onNewWant')
    this.extractApiKey(want)
    this.extractSelectorKey(want)
    this.extractExaKey(want)
    this.extractReasoningEffort(want)
    this.extractServerUrl(want)
    this.extractProjectId(want)
    this.extractProbe(want)
    this.extractSdkProbe(want)
    this.extractSdkSearchProbe(want)
    this.extractBenchmark(want)
    this.extractSdkEval(want)
    this.extractUiEval(want)
    this.extractUiAb(want)
    this.extractCompose(want)
    this.extractTemplateSelect(want)
    this.navigateToProject()
  }

  /**
   * Accepts the DeepSeek key as a launch parameter, so it never has to be typed
   * on the phone:
   *
   *   hdc shell aa start -a EntryAbility -b com.vera.probe.dyn \
   *     --ps deepseekKey sk-...
   *
   * The key itself is never logged -- only the fact that one arrived.
   */
  private extractApiKey(want: Want): void {
    if (want.parameters === null || want.parameters === undefined) { return }
    let params = want.parameters as Record<string, Object>
    let key = params['deepseekKey']
    if (key === null || key === undefined || typeof key !== 'string') { return }
    let text = (key as string).trim()
    if (text.length === 0) { return }
    settings.init(this.context.filesDir)
    settings.setApiKey(text)
    hilog.info(DOMAIN, 'VERA', 'DeepSeek API key updated from launch parameter')
  }

  /**
   * The TypeSafe key for the intent selection step, given the same way:
   *     --ps typesafeKey ...
   *
   * Optional: without it every intent in the catalogue goes into the prompt.
   */
  /**
   * The Exa key for the chat's web search, given the same way:
   *     --ps exaKey ...
   *
   * Optional: without it the chat assistant has no search tool. Never logged.
   */
  private extractExaKey(want: Want): void {
    if (want.parameters === null || want.parameters === undefined) { return }
    let params = want.parameters as Record<string, Object>
    let key = params['exaKey']
    if (key === null || key === undefined || typeof key !== 'string') { return }
    let text = (key as string).trim()
    if (text.length === 0) { return }
    settings.init(this.context.filesDir)
    settings.setExaKey(text)
    hilog.info(DOMAIN, 'VERA', 'Exa key updated from launch parameter')
  }

  /**
   * How hard the model reasons before a generation, given the same way:
   *     --ps reasoningEffort low
   *
   * DeepSeek has three levels, low, high and max; it accepts other names as
   * aliases (minimal = low; medium, xhigh = high; ultra = max), and its own
   * default is high. `default` goes back to the app's own,
   * DEFAULT_REASONING_EFFORT. Kept across restarts, like the keys, so a
   * benchmark can switch it without a rebuild.
   */
  private extractReasoningEffort(want: Want): void {
    if (want.parameters === null || want.parameters === undefined) { return }
    let params = want.parameters as Record<string, Object>
    let value = params['reasoningEffort']
    if (value === null || value === undefined || typeof value !== 'string') { return }
    let text = (value as string).trim()
    if (text.length === 0) { return }
    settings.init(this.context.filesDir)
    settings.setReasoningEffort(text === 'default' ? '' : text)
    hilog.info(DOMAIN, 'VERA', 'reasoning effort set to ' + settings.getReasoningEffort())
  }

  private extractSelectorKey(want: Want): void {
    if (want.parameters === null || want.parameters === undefined) { return }
    let params = want.parameters as Record<string, Object>
    let key = params['typesafeKey']
    if (key === null || key === undefined || typeof key !== 'string') { return }
    let text = (key as string).trim()
    if (text.length === 0) { return }
    settings.init(this.context.filesDir)
    settings.setSelectorKey(text)
    hilog.info(DOMAIN, 'VERA', 'TypeSafe key updated from launch parameter')
  }

  /**
   * Where vera-server lives, given the same way as the key:
   *     --ps veraServer http://host:port
   */
  private extractServerUrl(want: Want): void {
    if (want.parameters === null || want.parameters === undefined) { return }
    let params = want.parameters as Record<string, Object>
    let url = params['veraServer']
    if (url === null || url === undefined || typeof url !== 'string') { return }
    let text = (url as string).trim()
    if (text.length === 0) { return }
    settings.init(this.context.filesDir)
    settings.setServerUrl(text)
    hilog.info(DOMAIN, 'VERA', 'vera-server address updated from launch parameter')
  }

  /**
   * Development only: calls one intent named on the command line, so a
   * candidate row can be tried before it is written into the catalogue. See
   * IntentProbe.ets for what it takes and why it lives here.
   *
   * Reachable only from a launch parameter, so only from a shell on the device.
   */
  private extractProbe(want: Want): void {
    if (want.parameters === null || want.parameters === undefined) { return }
    let params = want.parameters as Record<string, Object>
    let target = params['probeTarget']
    if (target === null || target === undefined || typeof target !== 'string') { return }
    let payload = params['probeParams']
    let mode = params['probeMode']
    runProbe((target as string).trim(),
      payload !== null && payload !== undefined && typeof payload === 'string' ? (payload as string) : '',
      mode !== null && mode !== undefined && typeof mode === 'string' ? (mode as string) : 'background')
  }

  /**
   * Development only, same shape as extractProbe: calls one sdk.call target
   * directly against VeraSdkBackend.ets's ADAPTERS, so a new adapter can be
   * tried without going through a real generation. See VeraSdkProbe.ets.
   *
   * Reachable only from a launch parameter, so only from a shell on the device.
   */
  private extractSdkProbe(want: Want): void {
    if (want.parameters === null || want.parameters === undefined) { return }
    let params = want.parameters as Record<string, Object>
    let target = params['probeSdkTarget']
    if (target === null || target === undefined || typeof target !== 'string') { return }
    let payload = params['probeSdkParams']
    runSdkProbe((target as string).trim(),
      payload !== null && payload !== undefined && typeof payload === 'string' ? (payload as string) : '')
  }

  /**
   * Development only: runs find_sdk_function's own search (both token and
   * embedding) for one `need` string, so a ranking change can be checked
   * without a real generation. Only sets a flag here, same reasoning as
   * extractBenchmark -- embedding search needs the SDK corpus cache already
   * warm, which only happens inside GeneratePage.ets's own resource
   * loading. See VeraSdkProbe.ets.
   */
  private extractSdkSearchProbe(want: Want): void {
    if (want.parameters === null || want.parameters === undefined) { return }
    let params = want.parameters as Record<string, Object>
    let need = params['probeSdkSearch']
    if (need === null || need === undefined || typeof need !== 'string') { return }
    requestSdkSearch((need as string).trim())
  }

  /**
   * Development only, same shape as extractProbe: requests the search
   * timing benchmark (VeraSearchBenchmark.ets) on this launch --
   *
   *   hdc shell aa start -a EntryAbility -b com.vera.probe.dyn \
   *     --ps veraBenchmark 1
   *
   * Only sets a flag here, not run directly: the benchmark needs both
   * corpus caches already warm, which only happens inside
   * GeneratePage.ets's own resource loading, not at this point.
   * GeneratePage.ensureEmbeddingsReady() is what actually calls
   * runSearchBenchmark(), once ready.
   */
  private extractBenchmark(want: Want): void {
    if (want.parameters === null || want.parameters === undefined) { return }
    let params = want.parameters as Record<string, Object>
    let flag = params['veraBenchmark']
    if (flag === null || flag === undefined) { return }
    requestBenchmark()
    hilog.info(DOMAIN, 'VERA', 'VERA-BENCH requested from launch parameter')
  }

  /**
   * Development only: dumps find_sdk_function's token and embedding rankings
   * for the gold `need` strings (VeraSdkEval.ets). Sets a flag here, same as
   * extractBenchmark; GeneratePage.ets runs it once the embedding caches are warm.
   *
   *   hdc shell aa start -a EntryAbility -b com.vera.probe.dyn --ps veraSdkEval 1
   */
  private extractSdkEval(want: Want): void {
    if (want.parameters === null || want.parameters === undefined) { return }
    let params = want.parameters as Record<string, Object>
    let flag = params['veraSdkEval']
    if (flag === null || flag === undefined) { return }
    requestSdkEval()
    hilog.info(DOMAIN, 'VERA', 'VERA-SDKEVAL requested from launch parameter')
  }

  /**
   * Development only: scores the UI component selector on the gold prompts
   * (VeraUiEval.ets). Sets a flag; GeneratePage.ets runs it once the embedding
   * index is warm.
   *
   *   hdc shell aa start -a EntryAbility -b com.vera.probe.dyn --ps veraUiEval 1
   */
  private extractUiEval(want: Want): void {
    if (want.parameters === null || want.parameters === undefined) { return }
    let params = want.parameters as Record<string, Object>
    let flag = params['veraUiEval']
    if (flag === null || flag === undefined) { return }
    requestUiEval()
    hilog.info(DOMAIN, 'VERA', 'VERA-UI-EVAL requested from launch parameter')
  }

  /** Development only: `--ps veraUiAb 1` compares the UI selection modes (VeraUiAb.ets). */
  private extractUiAb(want: Want): void {
    if (want.parameters === null || want.parameters === undefined) { return }
    let params = want.parameters as Record<string, Object>
    let flag = params['veraUiAb']
    if (flag === null || flag === undefined) { return }
    requestUiAb()
    hilog.info(DOMAIN, 'VERA', 'VERA-UI-AB requested from launch parameter')
  }

  private extractCompose(want: Want): void {
    if (want.parameters === null || want.parameters === undefined) { return }
    let params = want.parameters as Record<string, Object>
    let flag = params['veraCompose']
    if (flag !== null && flag !== undefined) {
      let text = String(flag).trim()
      setComposeEnabled(!(text === '0' || text === 'false' || text === 'off'))
      hilog.info(DOMAIN, 'VERA', 'VERA-COMPOSE ' + text + ' from launch parameter')
    }
    let plan = params['veraComposePlan']
    if (plan !== null && plan !== undefined) {
      let text = String(plan).trim()
      setComposePlanEnabled(!(text === '0' || text === 'false' || text === 'off'))
      hilog.info(DOMAIN, 'VERA', 'VERA-COMPOSE plan ' + text + ' from launch parameter')
    }
    let custom = params['veraCustom']
    if (custom !== null && custom !== undefined) {
      let text = String(custom).trim()
      setCustomSectionsEnabled(!(text === '0' || text === 'false' || text === 'off'))
      hilog.info(DOMAIN, 'VERA', 'VERA-COMPOSE custom sections ' + text + ' from launch parameter')
    }
    let order = params['veraOrder']
    if (order !== null && order !== undefined) {
      setRouteOrder(String(order).trim())
      hilog.info(DOMAIN, 'VERA', 'VERA-ROUTE order ' + routeOrder() + ' from launch parameter')
    }
    let whole = params['veraWhole']
    if (whole !== null && whole !== undefined) {
      let text = String(whole).trim()
      setWholeScreenEnabled(!(text === '0' || text === 'false' || text === 'off'))
      hilog.info(DOMAIN, 'VERA', 'VERA-ROUTE whole screen ' + text + ' from launch parameter')
    }
  }

  /**
   * The Jev template path is on by default (VeraTemplateSelectFlag.ets); `--ps veraTemplateSelect 0`
   * switches it off for this session so a generation can be compared with the plain path. It also
   * needs the TypeSafe key (extractSelectorKey); without it generation goes straight to the model.
   */
  private extractTemplateSelect(want: Want): void {
    if (want.parameters === null || want.parameters === undefined) { return }
    let params = want.parameters as Record<string, Object>
    let flag = params['veraTemplateSelect']
    if (flag === null || flag === undefined) { return }
    let text = String(flag).trim()
    if (text === '0' || text === 'false' || text === 'off') {
      disableTemplateSelect()
      hilog.info(DOMAIN, 'VERA', 'VERA-TEMPLATE-SELECT disabled from launch parameter')
    } else {
      enableTemplateSelect()
      hilog.info(DOMAIN, 'VERA', 'VERA-TEMPLATE-SELECT enabled from launch parameter')
    }
  }

  private extractProjectId(want: Want): void {
    if (want.parameters !== null && want.parameters !== undefined) {
      let params = want.parameters as Record<string, Object>
      let id = params['projectId']
      if (typeof id === 'string' && id.trim().length > 0) {
        this.queueRoute(params['launchMode'] === 'runLatest' ? 'shortcut' : 'project', id.trim())
        hilog.info(DOMAIN, 'VERA', 'Launch with projectId: ' + id.trim())
        return
      }
    }
    let homeAction = want.action === 'action.system.home'
    let homeEntity = want.entities !== null && want.entities !== undefined &&
      want.entities.indexOf('entity.system.home') >= 0
    let emptyAction = want.action === null || want.action === undefined || want.action.length === 0
    let emptyEntities = want.entities === null || want.entities === undefined || want.entities.length === 0
    let emptyParameters = want.parameters === null || want.parameters === undefined ||
      Object.keys(want.parameters).length === 0
    if (homeAction || homeEntity || (emptyAction && emptyEntities && emptyParameters)) {
      this.queueRoute('home', '')
    }
  }

  private queueRoute(kind: string, projectId: string): void {
    let request = new LaunchRoute()
    request.kind = kind
    request.projectId = projectId
    request.revision = ++this.launchRevision
    this.pendingRoute = request
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    hilog.info(DOMAIN, 'VERA', 'EntryAbility onWindowStageCreate')
    this.contentReady = false
    let generation = ++this.windowStageGeneration
    this.activeWindowStage = windowStage
    this.routeDrainGeneration = -1
    this.isolatedRoot = false
    this.rootNeedsReset = false
    this.normalLayoutFullScreen = false
    if (this.pendingRoute === null && this.lastDestination !== null) {
      this.queueRoute(this.lastDestination.kind, this.lastDestination.projectId)
    }
    try {
      this.normalLayoutFullScreen = windowStage.getMainWindowSync().getWindowProperties().isLayoutFullScreen
    } catch (e) {
      hilog.error(DOMAIN, 'VERA', 'Read normal window layout failed: ' + (e as Error).message)
    }
    try {
      requestCalendarPermissions(this.context).then((): void => {
        if (generation !== this.windowStageGeneration) { return }
        requestMicrophonePermission(this.context).catch((e: Error): void => {
          hilog.error(DOMAIN, 'VERA', 'Microphone permission request failed: ' + e.message)
        })
      }).catch((e: Error): void => {
        hilog.error(DOMAIN, 'VERA', 'Calendar permission request failed: ' + e.message)
      })
    } catch (e) {
      hilog.error(DOMAIN, 'VERA', 'Permission request failed: ' + (e as Error).message)
    }
    try {
      windowStage.loadContent('pages/Index', (err): void => {
        if (generation !== this.windowStageGeneration) { return }
        if (err?.code) {
          hilog.error(DOMAIN, 'VERA', 'loadContent failed')
          return
        }
        hilog.info(DOMAIN, 'VERA', 'loadContent ok')
        setTimeout(() => {
          if (generation !== this.windowStageGeneration) { return }
          this.contentReady = true
          this.navigateToProject()
        }, 100)
      })
    } catch (e) {
      hilog.error(DOMAIN, 'VERA', 'loadContent failed: ' + (e as Error).message)
    }
  }

  private routeIsCurrent(generation: number, revision: number): boolean {
    return this.contentReady && this.activeWindowStage !== null &&
      generation === this.windowStageGeneration && revision === this.launchRevision
  }

  private async applyWindowMode(mainWindow: window.Window, isolated: boolean,
    generation: number, revision: number): Promise<void> {
    if (!this.routeIsCurrent(generation, revision)) { return }
    try {
      await mainWindow.setWindowLayoutFullScreen(isolated ? true : this.normalLayoutFullScreen)
    } catch (e) {
      hilog.error(DOMAIN, 'VERA', 'Set window layout failed: ' + (e as Error).message)
    }
    if (!this.routeIsCurrent(generation, revision)) { return }
    try {
      if (isolated) {
        await mainWindow.setWindowSystemBarEnable([])
      } else {
        await mainWindow.setWindowSystemBarEnable(['status', 'navigation'])
      }
    } catch (e) {
      hilog.error(DOMAIN, 'VERA', 'Set window system bars failed: ' + (e as Error).message)
    }
    if (!this.routeIsCurrent(generation, revision)) { return }
  }

  private navigateToProject(): void {
    let generation = this.windowStageGeneration
    if (!this.contentReady || this.activeWindowStage === null || this.pendingRoute === null ||
      this.routeDrainGeneration === generation) { return }
    this.routeDrainGeneration = generation
    this.drainRoutes(this.activeWindowStage, generation).catch((e: Error): void => {
      hilog.error(DOMAIN, 'VERA', 'Route drain failed: ' + e.message)
    }).finally((): void => {
      if (generation !== this.windowStageGeneration) { return }
      this.routeDrainGeneration = -1
      if (this.pendingRoute !== null) { this.navigateToProject() }
    })
  }

  private async drainRoutes(windowStage: window.WindowStage, generation: number): Promise<void> {
    while (this.contentReady && generation === this.windowStageGeneration && this.pendingRoute !== null) {
      let request = this.pendingRoute
      try {
        let mainWindow = windowStage.getMainWindowSync()
        let ui = mainWindow.getUIContext()
        let router = ui.getRouter()
        let options: routerApi.RouterOptions = { url: 'pages/Index' }
        let isolated = request.kind === 'shortcut'
        let replaceRoot = request.kind !== 'project' || this.isolatedRoot || this.rootNeedsReset
        let missingProject = false
        if (request.kind !== 'home') {
          store.init(this.context.filesDir)
          let project = store.getProject(request.projectId)
          missingProject = project === null
          if (isolated) {
            let p = new RunProjectNavParams()
            p.shortcutMode = 'true'
            if (project === null) {
              p.launchError = 'Mini-app no longer exists.'
            } else {
              p.projectId = request.projectId
              let version = store.getLatestRunnableVersion(request.projectId)
              if (version === null) {
                p.launchError = 'Run is unavailable: no version has compiled code.'
              } else {
                p.versionId = version.id
                p.vbc2 = version.vbc2
              }
            }
            options = { url: 'pages/RunnerPage', params: p }
          } else if (project !== null) {
            let p = new ProjectNavParams()
            p.projectId = request.projectId
            options = { url: 'pages/ProjectPage', params: p }
          } else {
            replaceRoot = true
          }
        }
        if (!this.routeIsCurrent(generation, request.revision)) { continue }
        if (replaceRoot) {
          this.rootNeedsReset = true
          await router.replaceUrl(options, routerApi.RouterMode.Standard)
          if (!this.routeIsCurrent(generation, request.revision)) { continue }
          router.clear()
        } else {
          await router.pushUrl(options, routerApi.RouterMode.Standard)
          if (!this.routeIsCurrent(generation, request.revision)) { continue }
        }
        await this.applyWindowMode(mainWindow, isolated, generation, request.revision)
        if (!this.routeIsCurrent(generation, request.revision)) { continue }
        this.isolatedRoot = isolated
        this.rootNeedsReset = false
        this.lastDestination = request
        this.pendingRoute = null
        if (missingProject && !isolated) {
          ui.getPromptAction().showToast({ message: 'Mini-app no longer exists.' })
        }
      } catch (e) {
        hilog.error(DOMAIN, 'VERA', 'Navigate launch route failed: ' + (e as Error).message)
        if (!this.routeIsCurrent(generation, request.revision)) { continue }
        this.pendingRoute = null
      }
    }
  }

  private invalidateWindowStage(): void {
    this.windowStageGeneration++
    this.contentReady = false
    this.activeWindowStage = null
    this.routeDrainGeneration = -1
    if (this.pendingRoute === null && this.lastDestination !== null) {
      this.queueRoute(this.lastDestination.kind, this.lastDestination.projectId)
    }
  }

  onDestroy(): void {
    this.invalidateWindowStage()
    this.launchRevision++
    this.pendingRoute = null
    this.lastDestination = null
    hilog.info(DOMAIN, 'VERA', 'EntryAbility onDestroy')
  }

  onWindowStageDestroy(): void {
    this.invalidateWindowStage()
    hilog.info(DOMAIN, 'VERA', 'EntryAbility onWindowStageDestroy')
  }

  onForeground(): void {
    hilog.info(DOMAIN, 'VERA', 'EntryAbility onForeground')
    refreshForms()
  }

  onBackground(): void {
    hilog.info(DOMAIN, 'VERA', 'EntryAbility onBackground')
  }
}
