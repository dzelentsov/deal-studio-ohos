import { Project, store } from '../vera/ProjectStore'
import { projectOperations, ProjectOperationStatus } from '../vera/ProjectOperations'
import { consent } from '../vera/VeraConsentStore'
import { refreshForms } from '../vera/FormUpdater'
import { projectIconResource } from '../vera/ProjectIcons'
import { common } from '@kit.AbilityKit'

const ICONS: string[] = ['📱', '🎮', '📊', '🧮', '🎯', '📝', '🔧', '🎨', '🌍', '⚡']

class ProjectNavParams {
  projectId: string = ''
}

@Entry
@Component
struct Index {
  @State projects: Project[] = []
  @State showCreate: boolean = false
  @State deletionPending: boolean = false
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
                Image(projectIconResource(p.icon))
                  .width(44).height(44).objectFit(ImageFit.Contain).margin({ right: 14 })
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
            Flex({ wrap: FlexWrap.Wrap, justifyContent: FlexAlign.Center }) {
              ForEach(ICONS, (icon: string) => {
                Image(projectIconResource(icon))
                  .width(40)
                  .height(40)
                  .objectFit(ImageFit.Contain)
                  .padding(6)
                  .backgroundColor(this.selectedIcon === icon ? '#E0E8FF' : '#00000000')
                  .borderRadius(8)
                  .onClick(() => { this.selectedIcon = icon })
              }, (icon: string) => icon)
            }.width('100%')

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
        .enabled(!this.deletionPending)
        .onClick(() => { this.confirmDelete(id) })
    }.height('100%').padding({ left: 8 })
  }

  private confirmDelete(id: string): void {
    let project = store.getProject(id)
    if (project === null) { return }
    this.getUIContext().showAlertDialog({
      title: 'Delete mini-app?',
      message: 'Delete "' + project.name + '" and all its saved versions and data? This cannot be undone.',
      primaryButton: {
        value: 'Cancel',
        action: () => {}
      },
      secondaryButton: {
        value: 'Delete',
        fontColor: '#FF3B30',
        action: () => { this.doDelete(id) }
      }
    })
  }

  private async doDelete(id: string): Promise<void> {
    if (this.deletionPending) { return }
    this.deletionPending = true
    let context = (): common.UIAbilityContext => this.getUIContext().getHostContext() as common.UIAbilityContext
    const status = await projectOperations.deleteProject(context, id)
    this.deletionPending = false
    this.reload()
    refreshForms()
    if (status !== ProjectOperationStatus.Success) {
      const message = status === ProjectOperationStatus.ProjectDeletedShortcutRemovalFailed ?
        'Mini-application was deleted, but its shortcut cannot be removed.' : 'Error deleting mini-app.'
      try {
        this.getUIContext().getPromptAction().showToast({ message: message })
      } catch (toastError) {
        console.error('Show deletion error failed: ' + (toastError as Error).message)
      }
    }
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
