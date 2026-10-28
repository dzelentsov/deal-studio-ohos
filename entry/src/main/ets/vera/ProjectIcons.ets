export function projectIconResource(icon: string): Resource {
  switch (icon) {
    case '\uD83D\uDCF1': return $r('app.media.project_icon_phone')
    case '\uD83C\uDFAE': return $r('app.media.project_icon_game')
    case '\uD83D\uDCCA': return $r('app.media.project_icon_chart')
    case '\uD83E\uDDEE': return $r('app.media.project_icon_abacus')
    case '\uD83C\uDFAF': return $r('app.media.project_icon_target')
    case '\uD83D\uDCDD': return $r('app.media.project_icon_memo')
    case '\uD83D\uDD27': return $r('app.media.project_icon_wrench')
    case '\uD83C\uDFA8': return $r('app.media.project_icon_palette')
    case '\uD83C\uDF0D': return $r('app.media.project_icon_globe')
    case '\u26A1': return $r('app.media.project_icon_lightning')
    default: return $r('app.media.project_icon_phone')
  }
}

export function projectShortcutIconResource(icon: string): Resource {
  switch (icon) {
    case '\uD83D\uDCF1': return $r('app.media.project_icon_phone_72')
    case '\uD83C\uDFAE': return $r('app.media.project_icon_game_72')
    case '\uD83D\uDCCA': return $r('app.media.project_icon_chart_72')
    case '\uD83E\uDDEE': return $r('app.media.project_icon_abacus_72')
    case '\uD83C\uDFAF': return $r('app.media.project_icon_target_72')
    case '\uD83D\uDCDD': return $r('app.media.project_icon_memo_72')
    case '\uD83D\uDD27': return $r('app.media.project_icon_wrench_72')
    case '\uD83C\uDFA8': return $r('app.media.project_icon_palette_72')
    case '\uD83C\uDF0D': return $r('app.media.project_icon_globe_72')
    case '\u26A1': return $r('app.media.project_icon_lightning_72')
    default: return $r('app.media.project_icon_phone_72')
  }
}
