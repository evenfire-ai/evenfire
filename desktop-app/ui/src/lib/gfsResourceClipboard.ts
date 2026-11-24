import type { GfsCopyToast, GfsCopyToastOptions } from './gfsResourceClipboard.types'

function defaultDeepLinkErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not copy the EvenDrive link'
}

/** Copy the shareable EvenDrive deep link for a `gfs://` URI and report the outcome. */
export async function copyGfsDeepLink(
  uri: string,
  pushToast: GfsCopyToast | undefined,
  options: GfsCopyToastOptions = {}
): Promise<void> {
  try {
    const result = await window.clerum.gfs.copyDeepLink?.(uri)
    if (!result?.url) throw new Error('Shareable EvenDrive links are unavailable in this version')
    pushToast?.('Shareable EvenDrive link copied', 'success')
  } catch (error) {
    pushToast?.((options.formatError ?? defaultDeepLinkErrorMessage)(error), 'error')
  }
}

/** Copy a resource's `gfs://` identifier (its route) and report the outcome. */
export async function copyGfsResourceId(
  uri: string,
  kind: 'file' | 'directory',
  pushToast: GfsCopyToast | undefined,
  options: GfsCopyToastOptions = {}
): Promise<void> {
  const resourceType = kind === 'directory' ? 'folder' : 'file'
  const resourceTypeTitle = kind === 'directory' ? 'Folder' : 'File'
  try {
    await navigator.clipboard.writeText(uri)
    pushToast?.(`${resourceTypeTitle} ID copied`, 'success')
  } catch (error) {
    const message =
      options.formatError?.(error) ??
      `Could not copy the ${resourceType} ID: ${
        error instanceof Error ? error.message : 'clipboard is unavailable'
      }`
    pushToast?.(message, 'error')
  }
}
