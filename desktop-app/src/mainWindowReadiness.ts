export type RendererNavigationReadinessEvent = {
  isMainFrame: boolean
  isSameDocument: boolean
}

export function shouldResetRendererReadinessForNavigation(
  details: RendererNavigationReadinessEvent
): boolean {
  return details.isMainFrame && !details.isSameDocument
}
