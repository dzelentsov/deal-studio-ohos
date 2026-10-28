import { Project, Version, VersionMetrics, store } from '../vera/ProjectStore'
import { refreshForms } from '../vera/FormUpdater'
import { projectIconResource } from '../vera/ProjectIcons'
import { projectOperations, ProjectOperationStatus, ProjectShortcutState } from '../vera/ProjectOperations'
import { common } from '@kit.AbilityKit'

class RunVersionParams {
  projectId: string = ''
  versionId: string = ''
  vbc2: string = ''
}

class GenerateNavParams {
  projectId: string = ''
  baseVersionId: string = ''
}

@Entry
@Component
struct ProjectPage {
  @State project: Project | null = null
  @State versions: Version[] = []
  @State projectId: string = ''
  @State projectOperationPending: boolean = false
  @State shortcutOperation: string = ''
  @State shortcutState: ProjectShortcutState = ProjectShortcutState.Unknown
  private shortcutRefreshGeneration: number = 0
  private pageVisible: boolean = true
  private returningToIndex: boolean = false
  @State viewedSource: string = ''
  @State viewedVersionNumber: number = 0
  @State viewedMetricsVersion: Version | null = null
  @State viewedMetricsNumber: number = 0
  // Shown beside the source: the request a version came from is the thing you
  // actually need when deciding whether to refine it or start again.
  @State viewedPrompt: string = ''

  aboutToAppear(): void {
    this.pageVisible = true
    let params = this.getUIContext().getRouter().getParams() as Record<string, string>
    if (params !== null && params !== undefined) {
      this.projectId = params['projectId'] || ''
    }
  }

  onPageShow(): void {
    this.pageVisible = true
    this.returningToIndex = false
    this.reload()
  }

  onPageHide(): void {
    this.pageVisible = false
    this.shortcutRefreshGeneration++
    this.shortcutState = ProjectShortcutState.Unknown
  }

  private reload(): void {
    if (this.projectId.length === 0) { return }
    this.project = store.getProject(this.projectId)
    this.versions = store.listVersions(this.projectId)
    if (this.project === null) {
      this.shortcutRefreshGeneration++
      this.shortcutState = ProjectShortcutState.Unknown
      this.returnToIndex()
      return
    }
    this.refreshShortcutState()
  }

  private returnToIndex(): void {
    if (!this.pageVisible || this.returningToIndex) { return }
    try {
      this.returningToIndex = true
      this.getUIContext().getRouter().back({ url: 'pages/Index' })
    } catch (e) {
      this.returningToIndex = false
      console.error('Return to projects failed: ' + (e as Error).message)
    }
  }

  private async refreshShortcutState(): Promise<void> {
    const generation = ++this.shortcutRefreshGeneration
    const projectId = this.projectId
    this.shortcutState = ProjectShortcutState.Unknown
    if (!this.pageVisible || this.projectOperationPending || this.project === null) { return }
    const state = await projectOperations.getShortcutState(projectId)
    if (generation !== this.shortcutRefreshGeneration || projectId !== this.projectId ||
        this.projectOperationPending) { return }
    if (store.getProject(projectId) === null) { this.reload(); return }
    this.shortcutState = state
  }

  private shortcutButtonLabel(): string {
    if (this.shortcutOperation === 'add') { return 'Adding…' }
    if (this.shortcutOperation === 'remove') { return 'Removing…' }
    if (this.shortcutState === ProjectShortcutState.Present) { return 'Remove shortcut' }
    if (this.shortcutState === ProjectShortcutState.Absent) { return 'Add shortcut' }
    return this.shortcutState === ProjectShortcutState.Failed ? 'Check shortcut' : 'Checking shortcut…'
  }

  build() {
    Navigation() {
      Column() {
        if (this.project !== null) {
          Row() {
            Image(projectIconResource(this.project!.icon))
              .width(56).height(56).objectFit(ImageFit.Contain).margin({ right: 16 })
            Column() {
              Text(this.project!.name).fontSize(22).fontWeight(FontWeight.Bold)
              Text(this.versions.length.toString() + ' version' + (this.versions.length !== 1 ? 's' : ''))
                .fontSize(14).fontColor('#999999').margin({ top: 4 })
            }.alignItems(HorizontalAlign.Start).layoutWeight(1)
          }
          .width('100%')
          .padding(16)

          Row({ space: 10 }) {
            Button('Generate')
              .type(ButtonType.Normal)
              .layoutWeight(1)
              .onClick(() => { this.openGenerate('') })
            Button('Run')
              .type(ButtonType.Normal)
              .layoutWeight(1)
              .enabled(this.latestRunnableIndex() >= 0)
              .onClick(() => { this.runLatest() })
            Button(this.shortcutButtonLabel())
              .type(ButtonType.Normal)
              .fontSize(14)
              .enabled(!this.projectOperationPending && this.shortcutState !== ProjectShortcutState.Unknown)
              .onClick(() => {
                if (this.shortcutState === ProjectShortcutState.Present) { this.unpinFromHome() }
                else if (this.shortcutState === ProjectShortcutState.Absent) { this.pinToHome() }
                else { this.refreshShortcutState() }
              })
          }
          .width('100%')
          .padding({ left: 16, right: 16, bottom: 12 })

          if (this.versions.length > 0 && this.latestRunnableIndex() !== 0) {
            Text(this.runSelectionNote())
              .fontSize(12)
              .fontColor('#B25000')
              .width('100%')
              .padding({ left: 16, right: 16, bottom: 12 })
          }

          Divider().color('#EEEEEE')

          List({ space: 1 }) {
            ForEach(this.versions, (v: Version, index: number) => {
              ListItem() {
                Column() {
                  Column() {
                    Row() {
                      Text('v' + (this.versions.length - index).toString())
                        .fontSize(15).fontWeight(FontWeight.Medium)
                      if (v.vbc2.length === 0) {
                        Text('needs compile')
                          .fontSize(11)
                          .fontColor('#FF9500')
                          .backgroundColor('#FFF3E0')
                          .borderRadius(4)
                          .padding({ left: 6, right: 6, top: 2, bottom: 2 })
                          .margin({ left: 8 })
                      }
                    }
                    if (v.note.length > 0) {
                      Text(v.note).fontSize(13).fontColor('#666666').margin({ top: 2 })
                        .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
                    }
                    Text(new Date(v.createdAt).toLocaleString())
                      .fontSize(12).fontColor('#AAAAAA').margin({ top: 2 })
                  }
                  .alignItems(HorizontalAlign.Start)
                  .width('100%')

                  Row({ space: 6 }) {
                    Button('Run')
                      .type(ButtonType.Normal)
                      .height(32)
                      .fontSize(13)
                      .layoutWeight(1)
                      .enabled(v.vbc2.length > 0)
                      .onClick(() => { this.runVersion(v) })
                    Button('Refine')
                      .type(ButtonType.Normal)
                      .height(32)
                      .fontSize(13)
                      .layoutWeight(1)
                      .backgroundColor('#E0E0E0')
                      .fontColor('#333333')
                      .onClick(() => { this.openGenerate(v.id) })
                    Button('Src')
                      .type(ButtonType.Normal)
                      .height(32)
                      .fontSize(13)
                      .layoutWeight(1)
                      .backgroundColor('#EEEEEE')
                      .fontColor('#666666')
                      .onClick(() => { this.viewSource(v, this.versions.length - index) })
                    Button('Metrics')
                      .type(ButtonType.Normal)
                      .height(32)
                      .fontSize(13)
                      .layoutWeight(1)
                      .backgroundColor('#EEEEEE')
                      .fontColor('#666666')
                      .onClick(() => { this.viewMetrics(v, this.versions.length - index) })
                  }
                  .width('100%')
                  .margin({ top: 8 })
                }
                .width('100%')
                .padding(14)
                .backgroundColor('#FFFFFF')
              }
              .swipeAction({
                end: {
                  builder: () => { this.deleteVersionAction(v) }
                }
              })
            }, (v: Version) => v.id)
          }
          .width('100%')
          .layoutWeight(1)
        }

        if (this.viewedSource.length > 0) {
          this.sourceOverlay()
        }
        if (this.viewedMetricsVersion !== null) {
          this.metricsOverlay()
        }
      }.width('100%').height('100%')
    }
    .title(this.project !== null ? this.project!.name : 'Project')
    .titleMode(NavigationTitleMode.Mini)
  }

  @Builder
  deleteVersionAction(v: Version) {
    Row() {
      Button('Delete')
        .backgroundColor('#FF3B30')
        .fontColor('#FFFFFF')
        .height('100%')
        .enabled(!this.projectOperationPending)
        .onClick(() => { this.confirmDeleteVersion(v) })
    }.height('100%').padding({ left: 8 })
  }

  private confirmDeleteVersion(v: Version): void {
    let versions = store.listVersions(v.projectId)
    let index = -1
    for (let i = 0; i < versions.length; i++) {
      if (versions[i].id === v.id) { index = i; break }
    }
    if (index < 0) { this.reload(); return }
    let lastVersion = versions.length === 1
    let shortcutWarning = this.shortcutState === ProjectShortcutState.Present ?
      ' Its desktop shortcut will also be removed.' : ' Any desktop shortcut will also be removed.'
    let message = lastVersion ?
      'This is the only remaining version. Deleting it will also delete the mini-app and all its saved program data.' +
        shortcutWarning + ' This cannot be undone.' :
      'Delete v' + (versions.length - index).toString() + ' and its saved program data? This cannot be undone.'
    this.getUIContext().showAlertDialog({
      title: lastVersion ? 'Delete mini-app?' : 'Delete version?',
      message: message,
      primaryButton: {
        value: 'Cancel',
        action: () => {}
      },
      secondaryButton: {
        value: 'Delete',
        fontColor: '#FF3B30',
        action: () => { this.doDeleteVersion(v) }
      }
    })
  }

  private async doDeleteVersion(v: Version): Promise<void> {
    if (this.projectOperationPending) {
      return;
    }
    this.projectOperationPending = true
    let context = (): common.UIAbilityContext => this.getUIContext().getHostContext() as common.UIAbilityContext
    const status = await projectOperations.deleteVersion(context, v.projectId, v.id)
    this.projectOperationPending = false
    if (status === ProjectOperationStatus.ProjectDeletedShortcutRemovalFailed) {
      this.showProjectMessage('Mini-application was deleted, but its shortcut cannot be removed.')
    }
    this.reload()
    refreshForms();
    if (status === ProjectOperationStatus.ProjectDeleted || status === ProjectOperationStatus.NotFound ||
        status === ProjectOperationStatus.ProjectDeletedShortcutRemovalFailed) {
      this.returnToIndex()
    } else if (status !== ProjectOperationStatus.Success) {
      this.showProjectMessage('Cannot delete version.')
    }
  }

  private latestRunnableIndex(): number {
    for (let i = 0; i < this.versions.length; i++) {
      if (this.versions[i].vbc2.length > 0) { return i }
    }
    return -1
  }

  private runSelectionNote(): string {
    let index = this.latestRunnableIndex()
    if (index < 0) { return 'Run is unavailable: no version has compiled code.' }
    return 'Run will launch v' + (this.versions.length - index).toString() +
      ', the latest compiled version. Newer versions need compilation.'
  }

  private runLatest(): void {
    let index = this.latestRunnableIndex()
    if (index < 0) { return }
    this.runVersion(this.versions[index])
  }

  private runVersion(v: Version): void {
    if (v.vbc2.length === 0) { return }
    let p = new RunVersionParams()
    p.projectId = v.projectId
    p.versionId = v.id
    p.vbc2 = v.vbc2
    this.getUIContext().getRouter().pushUrl({ url: 'pages/RunnerPage', params: p })
      .catch((e: Error): void => { console.error('Navigate to runner failed: ' + e.message) })
  }

  private openGenerate(baseVersionId: string): void {
    let p = new GenerateNavParams()
    p.projectId = this.projectId
    p.baseVersionId = baseVersionId
    this.getUIContext().getRouter().pushUrl({ url: 'pages/GeneratePage', params: p })
      .catch((e: Error): void => { console.error('Navigate to generation failed: ' + e.message) })
  }

  private viewSource(v: Version, versionNumber: number): void {
    this.viewedVersionNumber = versionNumber
    this.viewedSource = v.source
    this.viewedPrompt = v.prompt
  }

  private viewMetrics(v: Version, versionNumber: number): void {
    this.viewedMetricsNumber = versionNumber
    this.viewedMetricsVersion = v
  }

  private metricCount(value: number): string {
    return value >= 0 ? value.toLocaleString() : 'No data'
  }

  private metricTime(value: number): string {
    if (value < 0) { return 'No data' }
    return value < 1000 ? value.toString() + ' ms' : (value / 1000).toFixed(1) + ' s'
  }

  @Builder
  metricCell(label: string, value: string, note: string) {
    Column() {
      Column({ space: 2 }) {
        Text(label).fontSize(10).fontColor('#888888').maxLines(1)
        Text(value).fontSize(17).fontWeight(FontWeight.Bold).fontColor('#222222')
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(note).fontSize(10).fontColor('#999999').maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .alignItems(HorizontalAlign.Start)
      .padding(10)
    }
    .layoutWeight(1)
    .alignItems(HorizontalAlign.Start)
    .backgroundColor('#FFFFFF')
    .borderRadius(8)
  }

  @Builder
  metricSection(title: string, badge: string, color: string) {
    Column({ space: 6 }) {
      Row({ space: 8 }) {
        Text(title).fontSize(13).fontWeight(FontWeight.Bold).fontColor(color).layoutWeight(1)
        Text(badge)
          .fontSize(10)
          .fontColor(color)
          .border({ width: 1, color: color, radius: 6 })
          .padding({ left: 6, right: 6, top: 2, bottom: 2 })
      }
      .width('100%')
      Divider().strokeWidth(2).color(color)
    }
    .width('100%')
    .padding({ top: 6 })
  }

  @Builder
  metricsDashboard(metrics: VersionMetrics) {
    Column({ space: 10 }) {
      Column({ space: 4 }) {
        Text(metrics.provider.length > 0 ? metrics.provider : 'Provider: No data')
          .fontSize(14).fontWeight(FontWeight.Bold).fontColor('#222222')
        Text(metrics.model.length > 0 ? metrics.model : 'Model: No data')
          .fontSize(12).fontColor('#666666').wordBreak(WordBreak.BREAK_ALL)
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)

      this.metricSection('Accepted result', 'Saved snapshot', '#2F6FEB')
      Row({ space: 8 }) {
        this.metricCell('Total time', this.metricTime(metrics.elapsedMs), 'generation and refinements')
        this.metricCell('Estimated cost', metrics.estimatedUsd >= 0 ? '~$' + metrics.estimatedUsd.toFixed(6) : 'No data',
          metrics.partial ? 'measured portion only' : 'all measured model calls')
      }
      .width('100%')
      .alignItems(VerticalAlign.Top)
      Row({ space: 8 }) {
        this.metricCell('Runs', this.metricCount(metrics.runs), 'generation and refinements')
        this.metricCell('Model attempts', this.metricCount(metrics.attempts), 'including failed retries')
      }
      .width('100%')
      .alignItems(VerticalAlign.Top)

      this.metricSection('Token usage', metrics.partial ? 'Partial' : 'Measured', '#1F9D4C')
      Row({ space: 8 }) {
        this.metricCell('Input', this.metricCount(metrics.inputTokens), 'rules, request, old code')
        this.metricCell('Cached', this.metricCount(metrics.cacheHitTokens), 'included in input')
      }
      .width('100%')
      .alignItems(VerticalAlign.Top)
      Row({ space: 8 }) {
        this.metricCell('Output', this.metricCount(metrics.outputTokens), 'program and reasoning')
      }
      .width('100%')

      Column({ space: 6 }) {
        Text(metrics.partial ? 'Partial metrics' : 'About these metrics')
          .fontSize(12).fontWeight(FontWeight.Medium).fontColor(metrics.partial ? '#B25000' : '#555555')
        Text('Work toward the accepted result in this session, including retries. ' +
          'Excludes the base version and later unsuccessful changes.')
          .fontSize(11).fontColor('#666666')
        Text('Measured usage only, not complete billing. Stage timings and individual attempts were not saved.')
          .fontSize(11).fontColor('#888888')
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  metricsOverlay() {
    if (this.viewedMetricsVersion !== null) {
      Column() {
        Row() {
          Text('Version ' + this.viewedMetricsNumber.toString() + ' · Metrics')
            .fontSize(18).fontWeight(FontWeight.Bold)
          Blank()
          Button('Close')
            .height(36)
            .fontSize(13)
            .type(ButtonType.Normal)
            .onClick(() => { this.viewedMetricsVersion = null; this.viewedMetricsNumber = 0 })
        }
        .width('100%')
        .margin({ bottom: 10 })

        Scroll() {
          Column() {
            Column() {
              if (this.viewedMetricsVersion!.metrics !== null) {
                this.metricsDashboard(this.viewedMetricsVersion!.metrics!)
              } else {
                Column({ space: 6 }) {
                  Text('No saved metrics')
                    .fontSize(17).fontWeight(FontWeight.Bold).fontColor('#222222')
                  Text('Metrics were not saved for this version')
                    .fontSize(13).fontColor('#888888')
                }
                .alignItems(HorizontalAlign.Start)
                .padding(12)
              }
            }
            .padding(12)
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)
        }
        .layoutWeight(1)
        .width('100%')
        .align(Alignment.Top)
        .scrollBar(BarState.Off)
        .backgroundColor('#F5F7FA')
        .borderRadius(10)
      }
      .width('90%')
      .height('80%')
      .padding(18)
      .backgroundColor('#FFFFFF')
      .borderRadius(14)
      .shadow({ radius: 10, color: '#40000000' })
      .position({ x: '5%', y: '10%' })
    }
  }

  private pinToHome(): void {
    this.setPinnedState(true)
  }

  private unpinFromHome(): void {
    this.setPinnedState(false)
  }

  private async setPinnedState(pin: boolean): Promise<void> {
    if (this.projectOperationPending) { return }
    this.projectOperationPending = true
    this.shortcutOperation = pin ? 'add' : 'remove'
    let context = (): common.UIAbilityContext => this.getUIContext().getHostContext() as common.UIAbilityContext

    const status = pin ? await projectOperations.pinProject(context, this.projectId) :
      await projectOperations.unpinProject(context, this.projectId)
    this.shortcutOperation = ''
    this.projectOperationPending = false
    this.reload()
    if (status === ProjectOperationStatus.NotFound) {
      this.returnToIndex()
    } else if (status !== ProjectOperationStatus.Success) {
      this.showProjectMessage(pin ? 'Cannot add shortcut.' : 'Cannot delete shortcut.')
    }
  }

  private showProjectMessage(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message: message })
    } catch (e) {
      console.error('Show project message failed: ' + (e as Error).message)
    }
  }

  @Builder
  sourceOverlay() {
    if (this.viewedSource.length > 0) {
      Column() {
        Row() {
          Text('Version ' + this.viewedVersionNumber.toString()).fontSize(18).fontWeight(FontWeight.Bold)
          Blank()
          Button('Close')
            .height(36)
            .fontSize(13)
            .type(ButtonType.Normal)
            .onClick(() => { this.viewedSource = ''; this.viewedPrompt = ''; this.viewedVersionNumber = 0 })
        }
        .width('100%')
        .margin({ bottom: 10 })

        Scroll() {
          Column() {
            if (this.viewedPrompt.length > 0) {
              Text('Version request')
                .fontSize(12).fontColor('#888888').width('100%').margin({ bottom: 4 })
              Text(this.viewedPrompt)
                .fontSize(14)
                .fontColor('#222222')
                .width('100%')
                .padding(10)
                .backgroundColor('#F3F6FA')
                .borderRadius(8)
                .margin({ bottom: 12 })
                .copyOption(CopyOptions.LocalDevice)
            }
            Text('Source')
              .fontSize(12).fontColor('#888888').width('100%').margin({ bottom: 4 })
            Text(this.viewedSource)
              .fontSize(12)
              .fontColor('#333333')
              .width('100%')
          }
          .width('100%')
        }
        .layoutWeight(1)
        .width('100%')
      }
      .width('90%')
      .height('80%')
      .padding(18)
      .backgroundColor('#FFFFFF')
      .borderRadius(14)
      .shadow({ radius: 10, color: '#40000000' })
      .position({ x: '5%', y: '10%' })
    }
  }
}
