import { Project, ProjectSummary, store } from '../vera/ProjectStore'
import { versionCountText } from '../vera/ProjectText'
import { SymbolGlyphModifier } from '@kit.ArkUI'
import { projectOperations, ProjectOperationStatus } from '../vera/ProjectOperations'
import { consent } from '../vera/VeraConsentStore'
import { refreshForms } from '../vera/FormUpdater'
import { projectIconResource } from '../vera/ProjectIcons'
import { common } from '@kit.AbilityKit'
import { app, PrimaryButton, QuietButton, DangerButton } from '../components/AppStyle'
import { AppRouteParams } from '../vera/AppNavigation'

const ICONS: string[] = ['📱', '🎮', '📊', '🧮', '🎯', '📝', '🔧', '🎨', '🌍', '⚡']

/** A project and what its row shows of it. */
class ProjectRow {
  project: Project = new Project()
  summary: ProjectSummary = new ProjectSummary()
}

@Component
export struct Index {
  params: AppRouteParams = new AppRouteParams()
  private backgroundPending: boolean = false

  @Consume('navPathStack') pathStack: NavPathStack

  @State projects: ProjectRow[] = []
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

  destinationShown(): void {
    this.reload()
  }

  /** Newest work first: by when a project's latest version was saved, or when it was made if it has none. */
  private reload(): void {
    let rows: ProjectRow[] = []
    for (let project of store.listProjects()) {
      let row = new ProjectRow()
      row.project = project
      row.summary = store.summaryOf(project)
      rows.push(row)
    }
    rows.sort((a: ProjectRow, b: ProjectRow): number => b.summary.updatedAt - a.summary.updatedAt)
    this.projects = rows
  }

  private openChats(): void {
    this.pathStack.pushPath({ name: 'chatList', param: new AppRouteParams() })
  }

  private openCreate(): void {
    this.showCreate = true
    this.newName = ''
    this.selectedIcon = '📱'
  }

  private async backgroundAbility(): Promise<void> {
    if (this.backgroundPending) { return }
    this.backgroundPending = true
    try {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext
      if (context === undefined) { return }
      await context.moveAbilityToBackground()
    } catch (e) {
      console.error('Move ability to background failed: ' + (e as Error).message)
    } finally {
      this.backgroundPending = false
    }
  }

  build() {
    NavDestination() {
      if (this.projects.length === 0) {
        Column() {
          Text('No projects yet').fontSize(18).fontColor(app.inkMuted).margin({ top: 120 })
          Text('Tap New Project to create your first VERA app').fontSize(14).fontColor(app.inkDisabled).margin({ top: 8 })
        }.width('100%').alignItems(HorizontalAlign.Center)
      } else {
        List({ space: 12 }) {
          ForEach(this.projects, (row: ProjectRow) => {
            ListItem() {
              this.projectRow(row)
            }
            .swipeAction({
              end: {
                builder: () => { this.deleteAction(row.project.id) }
              }
            })
          }, (row: ProjectRow) => row.project.id)
        }
        .width('100%')
        .padding({ left: 16, right: 16, top: 8 })
      }
    }
    .title('VERA')
    .backgroundColor(app.background)
    .hideBackButton(true)
    .onShown(() => { this.destinationShown() })
    .onBackPressed(() => {
      this.backgroundAbility()
      return true
    })
    .menus([{
      value: 'Chat',
      symbolIcon: new SymbolGlyphModifier($r('sys.symbol.ellipsis_message')),
      action: () => { this.openChats() }
    }, {
      value: 'New Project',
      symbolIcon: new SymbolGlyphModifier($r('sys.symbol.plus')),
      action: () => { this.openCreate() }
    }])
    .toolbarConfiguration([{
      value: 'Chat',
      symbolIcon: new SymbolGlyphModifier($r('sys.symbol.ellipsis_message')),
      status: ToolbarItemStatus.NORMAL,
      action: () => { this.openChats() }
    }, {
      value: 'New Project',
      symbolIcon: new SymbolGlyphModifier($r('sys.symbol.plus')),
      status: ToolbarItemStatus.NORMAL,
      action: () => { this.openCreate() }
    }])
    .overlay(() => { this.createOverlay() })
  }

  @LocalBuilder
  createOverlay() {
    Stack() {
      if (this.showCreate) {
        this.createDialog()
      }
    }
    .width('100%')
    .height('100%')
    .hitTestBehavior(this.showCreate ? HitTestMode.Default : HitTestMode.Transparent)
  }

  /** One project: what it is (the request it began as), how much work is in it, and when it was last worked on. */
  @LocalBuilder
  projectRow(row: ProjectRow) {
    Row() {
      Image(projectIconResource(row.project.icon))
        .width(44).height(44).objectFit(ImageFit.Contain).margin({ right: 14 })
      Column({ space: 2 }) {
        Text(row.project.name).fontSize(17).fontWeight(FontWeight.Medium).maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        if (row.summary.request.length > 0) {
          Text(row.summary.request).fontSize(13).fontColor(app.inkSoft).maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        Text(versionCountText(row.summary.versions) + ' · ' + new Date(row.summary.updatedAt).toLocaleDateString())
          .fontSize(12).fontColor(app.inkMuted)
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)

      SymbolGlyph($r('sys.symbol.chevron_right')).fontSize(18).fontColor([app.inkDisabled])
    }
    .width('100%')
    .padding(14)
    .backgroundColor(app.surface)
    .borderRadius(12)
    .shadow({ radius: 2, color: '#10000000', offsetY: 1 })
    .onClick(() => {
      let nav = new AppRouteParams()
      nav.projectId = row.project.id
      this.pathStack.pushPath({ name: 'project', param: nav })
    })
    // A swipe is not a thing anyone is told about: the press that opens a menu is.
    .bindContextMenu(() => { this.rowMenu(row.project.id) }, ResponseType.LongPress)
  }

  @LocalBuilder
  rowMenu(id: string) {
    Menu() {
      MenuItem({ content: 'Delete project', symbolStartIcon: new SymbolGlyphModifier($r('sys.symbol.trash')) })
        .onClick(() => { this.confirmDelete(id) })
    }
  }

  @LocalBuilder
  createDialog() {
    Column() {
      Column() {
        Text('New Project').fontSize(20).fontWeight(FontWeight.Bold).margin({ bottom: 16 })

        TextInput({ placeholder: 'Project name', text: this.newName })
          .onChange((value: string) => { this.newName = value })
          .width('100%')
          .height(44)
          .margin({ bottom: 16 })

        Text('Icon').fontSize(14).fontColor(app.inkSoft).margin({ bottom: 8 })
        Flex({ wrap: FlexWrap.Wrap, justifyContent: FlexAlign.Center }) {
          ForEach(ICONS, (icon: string) => {
            Image(projectIconResource(icon))
              .width(40)
              .height(40)
              .objectFit(ImageFit.Contain)
              .padding(6)
              .backgroundColor(this.selectedIcon === icon ? app.primaryFill : '#00000000')
              .borderRadius(8)
              .onClick(() => { this.selectedIcon = icon })
          }, (icon: string) => icon)
        }.width('100%')

        Row({ space: 12 }) {
          Button('Cancel')
            .attributeModifier(new QuietButton())
            .layoutWeight(1)
            .onClick(() => { this.showCreate = false })
          Button('Create')
            .attributeModifier(new PrimaryButton())
            .layoutWeight(1)
            .enabled(this.newName.trim().length > 0)
            .onClick(() => { this.doCreate() })
        }
        .width('100%')
        .margin({ top: 20 })
      }
      .width('90%')
      .padding(24)
      .backgroundColor(app.surface)
      .borderRadius(16)
      .shadow({ radius: 8, color: '#30000000' })
      // A tap inside the card is the card's, not a tap on the dimming behind it.
      .onClick(() => {})
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .backgroundColor('#50000000')
    .onClick(() => { this.showCreate = false })
  }

  @LocalBuilder
  deleteAction(id: string) {
    Row() {
      Button('Delete')
        .attributeModifier(new DangerButton())
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
        fontColor: app.danger,
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
    let nav = new AppRouteParams()
    nav.projectId = project.id
    this.pathStack.pushPath({ name: 'project', param: nav })
  }
}
