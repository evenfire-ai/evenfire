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
