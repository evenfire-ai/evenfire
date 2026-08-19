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

export type DesktopShortcutHost = {
  webContents: ShortcutWebContents
  once(event: 'closed', listener: () => void): unknown
}

/**
 * Editing chords belong to Chromium/the active app, even if a future command
 * definition accidentally reuses one. Keep this guard independent of DOM
 * focus because before-input-event intentionally does not inspect renderer DOM.
 */
export function isStandardEditingShortcut(
  input: DesktopShortcutInput,
  platform: DesktopShortcutPlatform
): boolean {
  if (input.type !== 'keyDown' || input.isComposing || input.alt) return false
  const key = input.key.toLowerCase()
  const mod = platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
  if (mod && ['a', 'c', 'v', 'x', 'z'].includes(key)) return true
  if (platform !== 'darwin' && mod && key === 'y') return true
  if (
    platform === 'darwin' &&
    mod &&
    ['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'backspace'].includes(key)
  ) {
    return true
  }
  return (
    platform !== 'darwin' &&
    ((input.control && !input.meta && !input.shift && key === 'insert') ||
      (!input.control && !input.meta && input.shift && ['delete', 'insert'].includes(key)))
  )
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
  const platform = route.platform ?? platformFromNode(process.platform)
  if (isStandardEditingShortcut(input, platform)) return false
  const command = matchDesktopCommand(input, platform, route.source)
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

export function wireHostDesktopShortcutRouting(host: DesktopShortcutHost): void {
  const dispose = wireDesktopShortcutRouting({
    source: 'host',
    sourceWebContents: host.webContents,
    trustedRenderer: host.webContents,
  })
  host.once('closed', dispose)
}
