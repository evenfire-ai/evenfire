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
