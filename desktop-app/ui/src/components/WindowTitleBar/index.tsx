import React from 'react'
import { joinClasses } from '@lib/classNames'
import type { WindowControlAction, WindowControlsPlatform, WindowControlsState } from './types'

const DEFAULT_WINDOW_CONTROLS_STATE: WindowControlsState = {
  fullscreen: false,
  maximized: false,
}

const MAC_CONTROL_ORDER: WindowControlAction[] = ['close', 'minimize', 'toggleMaximize']
const DESKTOP_CONTROL_ORDER: WindowControlAction[] = ['minimize', 'toggleMaximize', 'close']

export function resolveWindowControlsPlatform(platform: string): WindowControlsPlatform {
  const normalized = platform.toLowerCase()
  if (normalized.includes('mac')) return 'mac'
  if (normalized.includes('win')) return 'windows'
  return 'linux'
}

function controlLabel(action: WindowControlAction, state: WindowControlsState): string {
  if (action === 'close') return 'Close window'
  if (action === 'minimize') return 'Minimize window'
  return state.fullscreen || state.maximized ? 'Restore window' : 'Maximize window'
}

function controlClassName(action: WindowControlAction): string {
  return joinClasses('window-control-button', `window-control-button--${action}`)
}

function getWindowControlsApi() {
  return window.evenfire?.window
}

export function WindowTitleBar() {
  const [controlsState, setControlsState] = React.useState<WindowControlsState>(
    DEFAULT_WINDOW_CONTROLS_STATE
  )
  const platform = resolveWindowControlsPlatform(window.navigator.platform || '')
  const controlOrder = platform === 'mac' ? MAC_CONTROL_ORDER : DESKTOP_CONTROL_ORDER

  React.useEffect(() => {
    const controlsApi = getWindowControlsApi()
    let mounted = true

    void controlsApi
      ?.getControlsState()
      .then(state => {
        if (mounted) setControlsState(state)
      })
      .catch(() => {
        if (mounted) setControlsState(DEFAULT_WINDOW_CONTROLS_STATE)
      })

    const removeListener = controlsApi?.onControlsStateChange(nextState => {
      setControlsState(nextState)
    })

    return () => {
      mounted = false
      removeListener?.()
    }
  }, [])

  const runControl = React.useCallback((action: WindowControlAction) => {
    const controlsApi = getWindowControlsApi()
    if (action === 'close') {
      void controlsApi?.close()
      return
    }
    if (action === 'minimize') {
      void controlsApi?.minimize()
      return
    }
    void controlsApi?.toggleMaximize()
  }, [])

  return (
    <header
      className={`window-titlebar window-titlebar--platform-${platform}`}
      data-platform={platform}
    >
      <div className="window-titlebar__controls" aria-label="Window controls">
        {controlOrder.map(action => (
          <button
            key={action}
            type="button"
            aria-label={controlLabel(action, controlsState)}
            className={controlClassName(action)}
            onClick={() => runControl(action)}
          >
            <span
              aria-hidden="true"
              className={joinClasses(
                'window-control-icon',
                `window-control-icon--${action}`,
                action === 'toggleMaximize' &&
                  (controlsState.fullscreen || controlsState.maximized) &&
                  'window-control-icon--restore'
              )}
            />
          </button>
        ))}
      </div>
    </header>
  )
}

export type { WindowControlAction, WindowControlsPlatform, WindowControlsState } from './types'
