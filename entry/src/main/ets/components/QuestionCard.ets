import { app } from './AppStyle'

/**
 * A blocking question from the agent (agent/AgentQuestions.ets): the question, its answers as buttons, the one the plan
 * was drawn for marked and first in focus, and a field for an answer of the person's own when none of them is it (which
 * medicine, which city). Used by the Generate screen above the preview and by the chat in the bubble of the widget being built.
 */
@Component
export struct QuestionCard {
  @Prop question: string = ''
  @Prop options: string[] = []
  @Prop fallback: number = 0
  @State typed: string = ''
  @State composing: boolean = false
  private inputController: TextInputController = new TextInputController()
  private disposed: boolean = false
  onPick: (index: number) => void = (_index: number): void => {}
  onTyped: (text: string) => void = (_text: string): void => {}

  aboutToAppear(): void {
    this.disposed = false
  }

  aboutToDisappear(): void {
    this.disposed = true
    this.composing = false
  }

  private changeAnswer(value: string, previewText?: PreviewText): void {
    if (this.disposed) { return }
    this.typed = value
    this.composing = previewText !== undefined && previewText.value.length > 0
  }

  private finishAnswer(value: string): void {
    if (this.disposed) { return }
    this.typed = value
    this.composing = false
  }

  private submitAnswer(value: string): void {
    if (this.disposed) { return }
    this.finishAnswer(value)
    this.answer()
  }

  private answer(): void {
    if (this.disposed || this.composing) { return }
    const text = this.typed.trim()
    if (text.length > 0) { this.onTyped(text) }
  }

  build() {
    Column({ space: 10 }) {
      Text(this.question)
        .fontSize(15)
        .fontWeight(FontWeight.Medium)
        .fontColor(app.inkStrong)
        .width('100%')
      Flex({ wrap: FlexWrap.Wrap }) {
        ForEach(this.options, (option: string, index: number) => {
          Button(index === this.fallback ? option + ' (suggested)' : option)
            .type(ButtonType.Capsule)
            .fontSize(14)
            .fontColor(index === this.fallback ? app.onPrimary : app.primaryInk)
            .backgroundColor(index === this.fallback ? app.primary : app.primaryFill)
            .margin({ right: 8, bottom: 8 })
            .onClick(() => { this.onPick(index) })
        }, (option: string, index: number) => index.toString() + option)
      }
      .width('100%')
      Row({ space: 8 }) {
        TextInput({ placeholder: 'Or type your own answer', text: this.typed, controller: this.inputController })
          .onChange((value: string, previewText?: PreviewText) => { this.changeAnswer(value, previewText) })
          .onEditChange((editing: boolean) => {
            if (!editing && !this.disposed) { this.finishAnswer(this.inputController.getText()) }
          })
          .onSubmit((_key: EnterKeyType, event: SubmitEvent) => { this.submitAnswer(event.text) })
          .enterKeyType(EnterKeyType.Done)
          .fontSize(14)
          .height(40)
          .layoutWeight(1)
          .backgroundColor(app.surface)
        // Only once there is something typed: a grey Answer beside the empty field read as the card's own button, dead
        // while the answer the plan was drawn for sat filled above it, and it cut the field's hint short.
        if (this.typed.trim().length > 0) {
          Button('Answer')
            .type(ButtonType.Capsule)
            .backgroundColor(app.primary)
            .fontColor(app.onPrimary)
            .fontSize(14)
            .height(40)
            .enabled(!this.composing)
            .onClick(() => { this.answer() })
        }
      }
      .width('100%')
    }
    .width('100%')
    .padding(12)
    .backgroundColor(app.primaryFill)
    .borderRadius(12)
  }
}
