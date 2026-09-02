export type WindowControlAction = 'close' | 'minimize' | 'toggleMaximize'

export type WindowControlsPlatform = 'linux' | 'mac' | 'windows'

export type WindowControlsState = {
  fullscreen: boolean
  maximized: boolean
}
