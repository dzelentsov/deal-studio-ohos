import { Project, Version, store } from '../vera/ProjectStore'
import { refreshForms } from '../vera/FormUpdater'

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
  @State viewedSource: string = ''
  // Shown beside the source: the request a version came from is the thing you
  // actually need when deciding whether to refine it or start again.
  @State viewedPrompt: string = ''

  aboutToAppear(): void {
    let params = this.getUIContext().getRouter().getParams() as Record<string, string>
    if (params !== null && params !== undefined) {
      this.projectId = params['projectId'] || ''
    }
    this.reload()
  }

  onPageShow(): void {
    this.reload()
  }

  private reload(): void {
    if (this.projectId.length === 0) { return }
    this.project = store.getProject(this.projectId)
    this.versions = store.listVersions(this.projectId)
  }

  build() {
    Navigation() {
      Column() {
        if (this.project !== null) {
          Row() {
            Text(this.project!.icon).fontSize(48).margin({ right: 16 })
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
              .enabled(this.versions.length > 0 && this.versions[0].vbc2.length > 0)
              .onClick(() => { this.runLatest() })
            Button('Pin')
              .type(ButtonType.Normal)
              .fontSize(14)
              .onClick(() => { this.pinToHome() })
          }
          .width('100%')
          .padding({ left: 16, right: 16, bottom: 12 })

          Divider().color('#EEEEEE')

          List({ space: 1 }) {
            ForEach(this.versions, (v: Version, index: number) => {
              ListItem() {
                Row() {
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
                  .layoutWeight(1)

                  Column({ space: 8 }) {
                    if (v.vbc2.length > 0) {
                      Button('Run')
                        .type(ButtonType.Normal)
                        .height(32)
                        .fontSize(13)
                        .onClick(() => { this.runVersion(v) })
                    }
                    Button('Refine')
                      .type(ButtonType.Normal)
                      .height(32)
                      .fontSize(13)
                      .backgroundColor('#E0E0E0')
                      .fontColor('#333333')
                      .onClick(() => { this.openGenerate(v.id) })
                    Button('Src')
                      .type(ButtonType.Normal)
                      .height(32)
                      .fontSize(13)
                      .backgroundColor('#EEEEEE')
                      .fontColor('#666666')
                      .onClick(() => { this.viewSource(v) })
                  }
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
        .onClick(() => {
          store.deleteVersion(v.projectId, v.id)
          this.reload()
          refreshForms()
        })
    }.height('100%').padding({ left: 8 })
  }

  private runLatest(): void {
    if (this.versions.length === 0) { return }
    this.runVersion(this.versions[0])
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

  private viewSource(v: Version): void {
    this.viewedSource = v.source
    this.viewedPrompt = v.prompt
  }

  private pinToHome(): void {
    console.info('Shortcut pinning requires system API — not available for non-system apps')
  }

  @Builder
  sourceOverlay() {
    if (this.viewedSource.length > 0) {
      Column() {
        Row() {
          Text('Version').fontSize(18).fontWeight(FontWeight.Bold)
          Blank()
          Button('Close')
            .height(36)
            .fontSize(13)
            .type(ButtonType.Normal)
            .onClick(() => { this.viewedSource = ''; this.viewedPrompt = '' })
        }
        .width('100%')
        .margin({ bottom: 10 })

        if (this.viewedPrompt.length > 0) {
          Text('Prompt')
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

        Scroll() {
          Text(this.viewedSource)
            .fontSize(12)
            .fontColor('#333333')
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
