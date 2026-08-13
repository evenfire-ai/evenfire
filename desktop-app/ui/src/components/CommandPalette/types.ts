import type { DesktopCommandId, DesktopShortcutPlatform } from '../../../../src/desktopCommands'

export type CommandPaletteProps = {
  platform: DesktopShortcutPlatform
  isEligible: (commandId: DesktopCommandId) => boolean
  onClose: () => void
  onExecute: (commandId: DesktopCommandId) => void
}
