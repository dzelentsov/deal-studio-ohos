import UIAbility from '@ohos.app.ability.UIAbility'
import Want from '@ohos.app.ability.Want'
import AbilityConstant from '@ohos.app.ability.AbilityConstant'
import window from '@ohos.window'
import hilog from '@ohos.hilog'
import { refreshForms } from '../vera/FormUpdater'
import { settings } from '../vera/SettingsStore'
import { requestCalendarPermissions, requestMicrophonePermission } from '../vera/VeraPermissions'
import { runProbe } from '../vera/IntentProbe'
import { runSdkProbe, requestSdkSearch } from '../vera/VeraSdkProbe'
import { requestBenchmark } from '../vera/VeraSearchBenchmark'
import { requestSdkEval } from '../vera/VeraSdkEval'
import { requestUiEval } from '../vera/VeraUiEval'
import { requestUiAb } from '../vera/VeraUiAb'
import { loadCatalogFile } from '../vera/VeraCatalogFile'
import { startPowerKeyProbe } from '../vera/PowerKeyProbe'
import { enableTemplateSelect, disableTemplateSelect } from '../vera/VeraTemplateSelectFlag'

const DOMAIN = 0x0000

class ProjectNavParams {
  projectId: string = ''
}

export default class EntryAbility extends UIAbility {
  private pendingProjectId: string = ''

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, 'VERA', 'EntryAbility onCreate')
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
    this.extractTemplateSelect(want)
    if (this.pendingProjectId.length > 0) {
      this.navigateToProject()
    }
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
      if (id !== null && id !== undefined && typeof id === 'string') {
        this.pendingProjectId = id as string
        hilog.info(DOMAIN, 'VERA', 'Launch with projectId: ' + this.pendingProjectId)
      }
    }
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    hilog.info(DOMAIN, 'VERA', 'EntryAbility onWindowStageCreate')
    // READ_CALENDAR, WRITE_CALENDAR and MICROPHONE are user_grant and so cannot
    // come from the signature. Asked here, not in the middle of a handler.
    requestCalendarPermissions(this.context).then((): Promise<void> => {
      return requestMicrophonePermission(this.context)
    })
    windowStage.loadContent('pages/Index', (err): void => {
      if (err?.code) {
        hilog.error(DOMAIN, 'VERA', 'loadContent failed')
        return
      }
      hilog.info(DOMAIN, 'VERA', 'loadContent ok')
      if (this.pendingProjectId.length > 0) {
        setTimeout(() => { this.navigateToProject() }, 100)
      }
    })
  }

  private navigateToProject(): void {
    if (this.pendingProjectId.length === 0) { return }
    let projectId = this.pendingProjectId
    this.pendingProjectId = ''
    try {
      let p = new ProjectNavParams()
      p.projectId = projectId
      this.context.windowStage.getMainWindowSync().getUIContext().getRouter()
        .pushUrl({ url: 'pages/ProjectPage', params: p })
        .catch((e: Error): void => {
          hilog.error(DOMAIN, 'VERA', 'Navigate to project failed: ' + e.message)
        })
    } catch (e) {
      hilog.error(DOMAIN, 'VERA', 'Navigate to project failed: ' + (e as Error).message)
    }
  }

  onDestroy(): void {
    hilog.info(DOMAIN, 'VERA', 'EntryAbility onDestroy')
  }

  onWindowStageDestroy(): void {
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
