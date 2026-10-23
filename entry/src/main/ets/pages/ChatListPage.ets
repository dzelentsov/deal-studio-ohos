import { chats, ChatSummary } from '../vera/ChatStore'
import { formatUsd } from '../vera/VeraChatStats'

class ChatNavParams {
  chatId: string = ''
}

/** The saved chats, newest first, with a way to start another. */
@Entry
@Component
struct ChatListPage {
  @State list: ChatSummary[] = []

  aboutToAppear(): void {
    let context = this.getUIContext().getHostContext()
    if (context === undefined) { throw new Error('Chat list host context is unavailable') }
    chats.init(context.filesDir)
    this.reload()
  }

  // A chat is saved while it is open, so coming back from one shows its new title and count.
  onPageShow(): void {
    this.reload()
  }

  private reload(): void {
    this.list = chats.list()
  }

  private open(id: string): void {
    let nav = new ChatNavParams()
    nav.chatId = id
    this.getUIContext().getRouter().pushUrl({ url: 'pages/ChatPage', params: nav })
      .catch((e: Error): void => { console.error('Navigate to chat failed: ' + e.message) })
  }

  private describe(c: ChatSummary): string {
    let parts: string[] = [new Date(c.updatedAt).toLocaleString(), c.messages.toString() + ' messages']
    if (c.widgets > 0) { parts.push(c.widgets.toString() + (c.widgets === 1 ? ' widget' : ' widgets')) }
    if (c.costUsd > 0) { parts.push('~' + formatUsd(c.costUsd)) }
    return parts.join(' · ')
  }

  build() {
    Navigation() {
      Column() {
        if (this.list.length === 0) {
          Column() {
            Text('No chats yet').fontSize(18).fontColor('#999999').margin({ top: 120 })
            Text('Tap New chat to start one').fontSize(14).fontColor('#BBBBBB').margin({ top: 8 })
          }.width('100%').alignItems(HorizontalAlign.Center)
        } else {
          List({ space: 12 }) {
            ForEach(this.list, (c: ChatSummary) => {
              ListItem() {
                Column({ space: 4 }) {
                  Text(c.title.length > 0 ? c.title : '(untitled)')
                    .fontSize(17).fontWeight(FontWeight.Medium)
                    .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
                  Text(this.describe(c)).fontSize(12).fontColor('#999999')
                }
                .width('100%')
                .alignItems(HorizontalAlign.Start)
                .padding(14)
                .backgroundColor('#FFFFFF')
                .borderRadius(12)
                .shadow({ radius: 2, color: '#10000000', offsetY: 1 })
                .onClick(() => { this.open(c.id) })
              }
              .swipeAction({
                end: {
                  builder: () => { this.deleteAction(c.id) }
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
    .titleMode(NavigationTitleMode.Mini)
    .toolbarConfiguration([{
      value: 'New chat',
      status: ToolbarItemStatus.NORMAL,
      action: () => { this.getUIContext().getRouter().pushUrl({ url: 'pages/ChatPage' })
        .catch((e: Error): void => { console.error('Navigate to chat failed: ' + e.message) }) }
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
          chats.remove(id)
          this.reload()
        })
    }.height('100%').padding({ left: 8 })
  }
}
