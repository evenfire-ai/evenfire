import type { WebContents } from 'electron'

// Renderers the main process opens for content it does not trust, such as the
// chat's diagram drawing window. Their pages load from the app's own files, so
// their URL would pass as trusted; their messages never reach an IPC handler.
const untrustedSenders = new WeakSet<WebContents>()

export function markUntrustedIpcSender(contents: WebContents): void {
  untrustedSenders.add(contents)
}

export function isUntrustedIpcSender(sender: WebContents | null | undefined): boolean {
  return Boolean(sender) && untrustedSenders.has(sender as WebContents)
}
