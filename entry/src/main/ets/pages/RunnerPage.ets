import { VeraPreview } from '../components/VeraPreview'
import { store } from '../vera/ProjectStore'
import { consent } from '../vera/VeraConsentStore'

@Entry
@Component
struct RunnerPage {
  @State vbc2: string = ''
  @State error: string = ''
  // projectId and versionId were already being passed here and ignored; they are
  // what lets a program opened from the library remember its state.
  @State persistKey: string = ''
  // Whether the running program currently has a ui.BackHandler in its tree,
  // and the signal that tells VeraPreview to act on the system back gesture.
  // See VeraPreview's backPressSignal/onBackHandlerChanged for the other half.
  @State hasBackHandler: boolean = false
  @State backPressSignal: number = 0

  aboutToAppear(): void {
    let params = this.getUIContext().getRouter().getParams() as Record<string, string>
    if (params === null || params === undefined) { this.error = 'No parameters'; return }
    let vbc2 = params['vbc2'] || ''
    if (vbc2.length === 0) { this.error = 'No VBC2 bytecode'; return }
    this.vbc2 = vbc2
    let projectId = params['projectId'] || ''
    let versionId = params['versionId'] || ''
    if (projectId.length > 0 && versionId.length > 0) {
      this.persistKey = projectId + '/' + versionId
      let context = this.getUIContext().getHostContext()
      if (context === undefined) {
        this.error = 'Runner host context is unavailable'
        this.vbc2 = ''
        return
      }
      store.init(context.filesDir)
      consent.init(context.filesDir)
    }
  }

  // The page-level hook for the hardware/system back gesture. If the running
  // program currently has a ui.BackHandler, hand it to VeraPreview and
  // swallow the gesture (true); otherwise let the system do its own thing (false).
  onBackPress(): boolean {
    if (this.hasBackHandler) { this.backPressSignal += 1; return true }
    return false
  }

  build() {
    Navigation() {
      Column() {
        if (this.error.length > 0) {
          Text(this.error)
            .fontSize(14)
            .fontColor('#CC0000')
            .padding(16)
            .width('100%')
            .backgroundColor('#FFECEC')
        }
        if (this.vbc2.length > 0) {
          VeraPreview({
            vbc2: this.vbc2, persistKey: this.persistKey,
            backPressSignal: this.backPressSignal,
            onBackHandlerChanged: (active: boolean) => { this.hasBackHandler = active },
          })
        }
      }.width('100%').height('100%')
    }
    .title('App')
    .titleMode(NavigationTitleMode.Mini)
  }
}
