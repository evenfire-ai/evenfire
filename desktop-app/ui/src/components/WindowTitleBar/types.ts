import type React from 'react'

export type WindowControlAction = 'close' | 'minimize' | 'toggleMaximize'

export type WindowControlsPlatform = 'linux' | 'mac' | 'windows'

export type WindowControlsState = {
  fullscreen: boolean
  maximized: boolean
}

export type WindowTitleBarProps = {
  actions?: React.ReactNode
  actionsRef?: React.Ref<HTMLDivElement>
}

export type TitlebarActionsPortalProps = {
  children: React.ReactNode
  container: HTMLDivElement | null
}
