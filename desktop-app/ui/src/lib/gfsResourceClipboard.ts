import type { GfsBrowserChild } from '@hooks/domain/useGfsBrowserController'

export type GfsResourceToast = (message: string, tone: 'success' | 'error') => void

export function sameGfsResourceBinding(
  current: GfsBrowserChild | undefined,
  clicked: GfsBrowserChild
): boolean {
  return Boolean(
    current &&
    current.resourceId === clicked.resourceId &&
    current.gfsUri === clicked.gfsUri &&
    current.kind === clicked.kind &&
    current.parentResourceId === clicked.parentResourceId
  )
}

/** The one clipboard effect owner for Files, Preview and the sidebar action. */
export async function copyGfsResourceId(
  uri: string,
  kind: GfsBrowserChild['kind'],
  pushToast: GfsResourceToast
): Promise<void> {
  const resourceType = kind === 'directory' ? 'folder' : 'file'
  const resourceTypeTitle = kind === 'directory' ? 'Folder' : 'File'
  try {
    await navigator.clipboard.writeText(uri)
    pushToast(`${resourceTypeTitle} ID copied`, 'success')
  } catch (clipboardError) {
    const message =
      clipboardError instanceof Error ? clipboardError.message : 'clipboard is unavailable'
    pushToast(`Could not copy the ${resourceType} ID: ${message}`, 'error')
  }
}
