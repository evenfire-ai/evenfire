import { type GfsPreviewResource, gfsResourceOpenTarget } from './gfsPreview'

type GfsNavigationResolution = Awaited<ReturnType<Window['clerum']['gfs']['resolveForNavigation']>>

export interface ChatLinkActivationDeps {
  beginUserNavigationIntent: () => number
  isNavigationIntentCurrent: (sequence: number) => boolean
  openPreviewSection: (preview: GfsPreviewResource) => void
  openFilesSection: (path: string | null) => void
  pushToast: (message: string, tone: 'error') => void
  resolveForNavigation: (uri: string) => Promise<GfsNavigationResolution>
  openUrl: (url: string) => Promise<void>
}

export type ChatLinkActivation = (href: string) => Promise<void>

export const CHAT_GFS_LINK_UNAVAILABLE_MESSAGE = 'Could not open this EvenDrive location'

function linkScheme(href: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(href)
  return match ? match[1]!.toLowerCase() : null
}

/**
 * Routes a chat link the renderer already canonicalised. Never rejects: the
 * caller fires it from a click handler and has nothing to do with a failure.
 *
 * Deliberately no "is the chat still mounted" check: closing the chat while an
 * EvenDrive resolve is in flight still opens it, because the click was explicit
 * and nothing navigated since.
 */
export function createChatLinkActivation(deps: ChatLinkActivationDeps): ChatLinkActivation {
  return async href => {
    const scheme = linkScheme(href)
    if (scheme === 'gfs') {
      const sequence = deps.beginUserNavigationIntent()
      let resolution: GfsNavigationResolution
      try {
        resolution = await deps.resolveForNavigation(href)
      } catch {
        // The bridge is specified never to reject; if it does, the user still
        // gets the same "could not open" feedback as any other failed resolve.
        resolution = { status: 'unavailable' }
      }
      if (!deps.isNavigationIntentCurrent(sequence)) return
      if (resolution.status === 'superseded') return
      if (resolution.status === 'unavailable') {
        deps.pushToast(CHAT_GFS_LINK_UNAVAILABLE_MESSAGE, 'error')
        return
      }
      const target = gfsResourceOpenTarget(resolution.resource)
      if (target.kind === 'preview') deps.openPreviewSection(target.preview)
      else deps.openFilesSection(target.gfsUri)
      return
    }
    if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') {
      deps.beginUserNavigationIntent()
      try {
        await deps.openUrl(href)
      } catch {
        // The system browser or mail client failing to launch (or the bridge
        // being absent, which throws synchronously) has no in-app recovery.
      }
    }
  }
}
