export interface MainWindowNavigationContents {
  on(
    event: 'will-navigate',
    listener: (event: { preventDefault(): void }, url: string) => void
  ): unknown
  getURL(): string
}

/**
 * The workspace tabs live only in renderer memory, so any renderer-initiated
 * cross-document navigation of the main window (an anchor, `location`, a file
 * dropped outside a drop zone) wipes them. The initial loadURL/loadFile and a
 * main-initiated webContents.reload() never emit will-navigate, so blocking
 * every will-navigate costs nothing in production.
 *
 * Dev keeps exactly one exception: `location.reload()` emits will-navigate with
 * the current document URL, and Vite's full reload relies on it. That URL is
 * indistinguishable from an `<a href="">`, which is why prod allows nothing.
 */
export function shouldBlockMainWindowNavigation(input: {
  url: string
  currentUrl: string
  devUrl: string
}): boolean {
  if (!input.devUrl) return true
  return input.url !== input.currentUrl
}

export function wireMainWindowNavigationGuard(
  contents: MainWindowNavigationContents,
  devUrl: string
): void {
  contents.on('will-navigate', (event, url) => {
    if (shouldBlockMainWindowNavigation({ url, currentUrl: contents.getURL(), devUrl })) {
      event.preventDefault()
    }
  })
}
