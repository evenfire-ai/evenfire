import path from 'node:path'

export type SystemIconWindow = {
  isDestroyed(): boolean
  setIcon(icon: string): void
}

export type AdaptiveSystemIconOptions = {
  assetsDirectory: string
  getAllWindows(): SystemIconWindow[]
  onThemeUpdated(listener: () => void): void
  onWindowCreated(listener: (window: SystemIconWindow) => void): void
  platform: NodeJS.Platform
  setDockIcon?(icon: string): void
  shouldUseDarkColors(): boolean
}

export function resolveSystemIconPath(assetsDirectory: string, darkMode: boolean): string {
  return path.join(assetsDirectory, darkMode ? 'icon-dark.png' : 'icon-light.png')
}

export function installAdaptiveSystemIcon(options: AdaptiveSystemIconOptions): void {
  const supportsWindowIcons = options.platform === 'win32' || options.platform === 'linux'
  const supportsDockIcon = options.platform === 'darwin' && Boolean(options.setDockIcon)

  const iconPath = () =>
    resolveSystemIconPath(options.assetsDirectory, options.shouldUseDarkColors())

  const applyToWindow = (window: SystemIconWindow) => {
    if (supportsWindowIcons && !window.isDestroyed()) {
      window.setIcon(iconPath())
    }
  }

  const apply = () => {
    if (supportsDockIcon) {
      options.setDockIcon?.(iconPath())
      return
    }
    if (supportsWindowIcons) {
      options.getAllWindows().forEach(applyToWindow)
    }
  }

  if (supportsWindowIcons) {
    options.onWindowCreated(applyToWindow)
  }
  if (supportsWindowIcons || supportsDockIcon) {
    options.onThemeUpdated(apply)
    apply()
  }
}
