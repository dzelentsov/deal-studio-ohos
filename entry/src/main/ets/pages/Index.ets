import { Project, store } from '../vera/ProjectStore'
import { consent } from '../vera/VeraConsentStore'
import { refreshForms } from '../vera/FormUpdater'

const ICONS: string[] = ['📱', '🎮', '📊', '🧮', '🎯', '📝', '🔧', '🎨', '🌍', '⚡']

class ProjectNavParams {
  projectId: string = ''
}

@Entry
@Component
struct Index {
  @State projects: Project[] = []
  @State showCreate: boolean = false
  @State newName: string = ''
  @State selectedIcon: string = '📱'

  aboutToAppear(): void {
    let context = this.getUIContext().getHostContext()
    if (context === undefined) { throw new Error('Project library host context is unavailable') }
    store.init(context.filesDir)
    consent.init(context.filesDir)
    this.reload()
  }

  onPageShow(): void {
    this.reload()
  }

  private reload(): void {
    this.projects = store.listProjects()
  }

  build() {
    Navigation() {
      if (this.projects.length === 0 && !this.showCreate) {
        Column() {
          Text('No projects yet').fontSize(18).fontColor('#999999').margin({ top: 120 })
          Text('Tap + to create your first VERA app').fontSize(14).fontColor('#BBBBBB').margin({ top: 8 })
        }.width('100%').alignItems(HorizontalAlign.Center)
      } else {
        List({ space: 12 }) {
          ForEach(this.projects, (p: Project) => {
            ListItem() {
              Row() {
                Text(p.icon).fontSize(36).margin({ right: 14 })
                Column() {
                  Text(p.name).fontSize(17).fontWeight(FontWeight.Medium)
                  Text(new Date(p.createdAt).toLocaleDateString())
                    .fontSize(13).fontColor('#999999').margin({ top: 2 })
                }
                .alignItems(HorizontalAlign.Start)
                .layoutWeight(1)

                Text('>').fontSize(18).fontColor('#CCCCCC')
              }
              .width('100%')
              .padding(14)
              .backgroundColor('#FFFFFF')
              .borderRadius(12)
              .shadow({ radius: 2, color: '#10000000', offsetY: 1 })
              .onClick(() => {
                let nav = new ProjectNavParams()
                nav.projectId = p.id
                this.getUIContext().getRouter().pushUrl({ url: 'pages/ProjectPage', params: nav })
                  .catch((e: Error): void => { console.error('Navigate to project failed: ' + e.message) })
              })
            }
            .swipeAction({
              end: {
                builder: () => { this.deleteAction(p.id) }
              }
            })
          }, (p: Project) => p.id)
        }
        .width('100%')
        .padding({ left: 16, right: 16, top: 8 })
      }

      if (this.showCreate) {
        Column() {
          Column() {
            Text('New Project').fontSize(20).fontWeight(FontWeight.Bold).margin({ bottom: 16 })

            TextInput({ placeholder: 'Project name', text: this.newName })
              .onChange((value: string) => { this.newName = value })
              .width('100%')
              .height(44)
              .margin({ bottom: 16 })

            Text('Icon').fontSize(14).fontColor('#666666').margin({ bottom: 8 })
            Row() {
              ForEach(ICONS, (icon: string) => {
                Text(icon)
                  .fontSize(28)
                  .padding(6)
                  .backgroundColor(this.selectedIcon === icon ? '#E0E8FF' : '#00000000')
                  .borderRadius(8)
                  .onClick(() => { this.selectedIcon = icon })
              }, (icon: string) => icon)
            }.width('100%').justifyContent(FlexAlign.SpaceAround)

            Row({ space: 12 }) {
              Button('Cancel')
                .type(ButtonType.Normal)
                .backgroundColor('#E0E0E0')
                .fontColor('#333333')
                .layoutWeight(1)
                .onClick(() => { this.showCreate = false })
              Button('Create')
                .type(ButtonType.Normal)
                .layoutWeight(1)
                .enabled(this.newName.trim().length > 0)
                .onClick(() => { this.doCreate() })
            }
            .width('100%')
            .margin({ top: 20 })
          }
          .width('90%')
          .padding(24)
          .backgroundColor('#FFFFFF')
          .borderRadius(16)
          .shadow({ radius: 8, color: '#30000000' })
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .backgroundColor('#50000000')
        .position({ x: 0, y: 0 })
        .onClick(() => { this.showCreate = false })
      }
    }
    .title('VERA')
    .titleMode(NavigationTitleMode.Full)
    .menus([{
      value: 'Chat',
      icon: 'resources/base/media/startIcon.png',
      action: () => { this.getUIContext().getRouter().pushUrl({ url: 'pages/ChatListPage' })
        .catch((e: Error): void => { console.error('Navigate to chats failed: ' + e.message) }) }
    }, {
      value: '',
      icon: 'resources/base/media/startIcon.png',
      action: () => { this.showCreate = true; this.newName = ''; this.selectedIcon = '📱' }
    }])
    .toolbarConfiguration([{
      value: 'Chat',
      status: ToolbarItemStatus.NORMAL,
      action: () => { this.getUIContext().getRouter().pushUrl({ url: 'pages/ChatListPage' })
        .catch((e: Error): void => { console.error('Navigate to chats failed: ' + e.message) }) }
    }, {
      value: 'New Project',
      status: ToolbarItemStatus.NORMAL,
      action: () => { this.showCreate = true; this.newName = ''; this.selectedIcon = '📱' }
    }])
  }

  @Builder
  deleteAction(id: string) {
    Row() {
      Button('Delete')
        .backgroundColor('#FF3B30')
        .fontColor('#FFFFFF')
        .height('100%')
        .onClick(() => {
          store.deleteProject(id)
          this.reload()
          refreshForms()
        })
    }.height('100%').padding({ left: 8 })
  }

  private doCreate(): void {
    let name = this.newName.trim()
    if (name.length === 0) { return }
    let project = store.createProject(name, this.selectedIcon)
    this.showCreate = false
    this.reload()
    refreshForms()
    let nav = new ProjectNavParams()
    nav.projectId = project.id
    this.getUIContext().getRouter().pushUrl({ url: 'pages/ProjectPage', params: nav })
      .catch((e: Error): void => { console.error('Navigate to project failed: ' + e.message) })
  }
}
