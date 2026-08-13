import type { WebContents } from 'electron'
import {
  type DesktopCommandSource,
  type DesktopShortcutInput,
  type DesktopShortcutPlatform,
  matchDesktopCommand,
  platformFromNode,
} from './desktopCommands.js'

type ShortcutEvent = { preventDefault(): void }
type ShortcutWebContents = Pick<
  WebContents,
  'focus' | 'id' | 'isDestroyed' | 'isFocused' | 'on' | 'removeListener' | 'send'
>

export type DesktopShortcutRoute = {
  source: DesktopCommandSource
  sourceWebContents: ShortcutWebContents
  trustedRenderer: ShortcutWebContents
  platform?: DesktopShortcutPlatform
  isCurrentSource?: () => boolean
}

export function routeDesktopShortcut(
  route: DesktopShortcutRoute,
  event: ShortcutEvent,
  input: DesktopShortcutInput
): boolean {
  if (
    route.sourceWebContents.isDestroyed() ||
    route.trustedRenderer.isDestroyed() ||
    !route.sourceWebContents.isFocused() ||
    (route.isCurrentSource && !route.isCurrentSource())
  ) {
    return false
  }
  const command = matchDesktopCommand(
    input,
    route.platform ?? platformFromNode(process.platform),
    route.source
  )
  if (!command) return false
  event.preventDefault()
  if (route.source === 'sandbox' && !route.trustedRenderer.isFocused()) {
    route.trustedRenderer.focus()
  }
  route.trustedRenderer.send('shortcuts:command', {
    commandId: command.id,
    source: route.source,
  })
  return true
}

export function wireDesktopShortcutRouting(route: DesktopShortcutRoute): () => void {
  const listener = (event: Electron.Event, input: Electron.Input) => {
    routeDesktopShortcut(route, event, input)
  }
  route.sourceWebContents.on('before-input-event', listener)
  return () => route.sourceWebContents.removeListener('before-input-event', listener)
}
