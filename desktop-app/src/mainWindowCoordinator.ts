import type { App } from 'electron'
import { QuitAdmissionClosedError } from './appService.js'

export function isQuitAdmissionClosedError(error: unknown): boolean {
  return error instanceof QuitAdmissionClosedError
}

export function retryPendingExternalLogoutAfterQuitCancellation(
  cancelQuitPreparation: () => void,
  applyPendingLogout: () => Promise<boolean>,
  onApplied: () => void,
  onFailure: (error: unknown) => void
): void {
  cancelQuitPreparation()
  void applyPendingLogout().then(applied => {
    if (applied) onApplied()
  }, onFailure)
}

type MainWindowHandle = {
  isDestroyed: () => boolean
}

type MainWindowCoordinatorOptions<TWindow extends MainWindowHandle> = {
  createWindow: () => Promise<void>
  focusWindow: () => void
  getWindow: () => TWindow | null
}

export function createMainWindowCoordinator<TWindow extends MainWindowHandle>(
  options: MainWindowCoordinatorOptions<TWindow>
) {
  let creationPromise: Promise<void> | null = null

  const ensureWindow = async (): Promise<void> => {
    const currentWindow = options.getWindow()
    if (currentWindow && !currentWindow.isDestroyed()) {
      options.focusWindow()
      return
    }

    if (!creationPromise) {
      creationPromise = options.createWindow().finally(() => {
        creationPromise = null
      })
    }

    await creationPromise
    options.focusWindow()
  }

  return { ensureWindow }
}

export function createRetryableInitializer(initialize: () => Promise<unknown>) {
  let initialized = false
  let initializationPromise: Promise<void> | null = null

  const ensureInitialized = async (): Promise<void> => {
    if (initialized) return
    if (!initializationPromise) {
      initializationPromise = initialize()
        .then(() => {
          initialized = true
        })
        .finally(() => {
          initializationPromise = null
        })
    }
    await initializationPromise
  }

  return { ensureInitialized }
}

export function registerQuitDrain(
  app: Pick<App, 'on' | 'quit'>,
  prepareForQuit: () => Promise<void>,
  cancelQuitPreparation: () => void,
  reportPreparationFailure: (error: unknown) => void = () => {}
): void {
  let quitDrainStarted = false
  let quitDrainComplete = false

  const reopenQuitAttempt = (): void => {
    if (!quitDrainStarted || !quitDrainComplete) return
    quitDrainStarted = false
    quitDrainComplete = false
    cancelQuitPreparation()
  }

  app.on('browser-window-created', (_event, window) => {
    window.webContents.on('will-prevent-unload', event => {
      if (!quitDrainComplete) return

      // Electron's defaultPrevented flag records whether another listener
      // allowed the page to unload. Window destruction is not reliable at this
      // point, so use the event outcome to detect a still-active page veto.
      setImmediate(() => {
        if (!event.defaultPrevented) reopenQuitAttempt()
      })
    })
  })

  app.on('before-quit', event => {
    if (quitDrainComplete) {
      // Another before-quit listener can still veto the resumed app.quit().
      setImmediate(() => {
        if (event.defaultPrevented) reopenQuitAttempt()
      })
      return
    }

    event.preventDefault()
    if (quitDrainStarted) return

    quitDrainStarted = true
    const resumeQuit = () => {
      setImmediate(() => {
        quitDrainComplete = true
        app.quit()
      })
    }
    void prepareForQuit().then(resumeQuit, error => {
      try {
        reportPreparationFailure(error)
      } catch {
        // Failure reporting must never prevent the best-effort quit path.
      }
      resumeQuit()
    })
  })

  app.on('will-quit', event => {
    if (!quitDrainComplete) return
    setImmediate(() => {
      if (event.defaultPrevented) reopenQuitAttempt()
    })
  })
}
