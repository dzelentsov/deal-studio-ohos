import { chats, ChatSummary } from '../vera/ChatStore'
import { formatUsd } from '../vera/VeraChatStats'
import { app, DangerButton } from '../components/AppStyle'
import { SymbolGlyphModifier } from '@kit.ArkUI'
import { AppRouteParams } from '../vera/AppNavigation'

/** The saved chats, newest first, with a way to start another. */
@Component
export struct ChatListPage {
  params: AppRouteParams = new AppRouteParams()

  @Consume('navPathStack') pathStack: NavPathStack

  @State list: ChatSummary[] = []

  aboutToAppear(): void {
    let context = this.getUIContext().getHostContext()
    if (context === undefined) { throw new Error('Chat list host context is unavailable') }
    chats.init(context.filesDir)
    this.reload()
  }

  // A chat is saved while it is open, so coming back from one shows its new title and count.
  destinationShown(): void {
    this.reload()
  }

  private reload(): void {
    this.list = chats.list()
  }

  private open(id: string): void {
    let nav = new AppRouteParams()
    nav.chatId = id
    this.pathStack.pushPath({ name: 'chat', param: nav })
  }

  private describe(c: ChatSummary): string {
    let parts: string[] = [new Date(c.updatedAt).toLocaleString(), c.messages.toString() + ' messages']
    if (c.widgets > 0) { parts.push(c.widgets.toString() + (c.widgets === 1 ? ' widget' : ' widgets')) }
    if (c.costUsd > 0) { parts.push('~' + formatUsd(c.costUsd)) }
    return parts.join(' · ')
  }

  build() {
    NavDestination() {
      Column() {
        if (this.list.length === 0) {
          Column() {
            Text('No chats yet').fontSize(18).fontColor(app.inkMuted).margin({ top: 120 })
            Text('Tap New chat to start one').fontSize(14).fontColor(app.inkDisabled).margin({ top: 8 })
          }.width('100%').alignItems(HorizontalAlign.Center)
        } else {
          List({ space: 12 }) {
            ForEach(this.list, (c: ChatSummary) => {
              ListItem() {
                Column({ space: 4 }) {
                  Text(c.title.length > 0 ? c.title : '(untitled)')
                    .fontSize(17).fontWeight(FontWeight.Medium)
                    .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
                  Text(this.describe(c)).fontSize(12).fontColor(app.inkMuted)
                }
                .width('100%')
                .alignItems(HorizontalAlign.Start)
                .padding(14)
                .backgroundColor(app.surface)
                .borderRadius(12)
                .shadow({ radius: 2, color: '#10000000', offsetY: 1 })
                .onClick(() => { this.open(c.id) })
              }
              .swipeAction({
                end: {
                  builder: () => { this.deleteButton(c.id) }
                }
              })
            }, (c: ChatSummary) => c.id)
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 8 })
        }
      }
      .width('100%')
      .height('100%')
    }
    .title('Chats')
    .backgroundColor(app.background)
    .onShown(() => { this.destinationShown() })
    .toolbarConfiguration([{
      value: 'New chat',
      symbolIcon: new SymbolGlyphModifier($r('sys.symbol.plus')),
      status: ToolbarItemStatus.NORMAL,
      action: () => { this.open('') }
    }])
  }

  @LocalBuilder
  deleteButton(id: string) {
    Row() {
      Button('Delete')
        .attributeModifier(new DangerButton())
        .height('100%')
        .onClick(() => {
          chats.remove(id)
          this.reload()
        })
    }.height('100%').padding({ left: 8 })
  }
}
