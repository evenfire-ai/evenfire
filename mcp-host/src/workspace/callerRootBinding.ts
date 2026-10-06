import type { IncomingMessage } from '../server/types'
import type { ScopedWorkspaceProvider } from './scopedWorkspace'

export interface CallerRootBinding {
  root?: string
  failureCode?: 'EACCES' | 'EEXIST' | 'EIO' | 'ENOENT' | 'ENOSPC' | 'ENOTDIR' | 'EPERM' | 'EROFS'
}

function bindingFailureCode(error: unknown): CallerRootBinding['failureCode'] {
  const code = (error as NodeJS.ErrnoException)?.code
  if (
    code === 'EACCES' ||
    code === 'EEXIST' ||
    code === 'EIO' ||
    code === 'ENOENT' ||
    code === 'ENOSPC' ||
    code === 'ENOTDIR' ||
    code === 'EPERM' ||
    code === 'EROFS'
  ) {
    return code
  }
  return undefined
}

/**
 * Derive a verified caller root without turning filesystem degradation into a
 * fake system identity or shared-root fallback. Unexpected programming errors
 * propagate; only concrete caller-root creation/access failures return undefined.
 */
export function resolveCallerRootBinding(
  provider: ScopedWorkspaceProvider | null | undefined,
  sourceMessage?: Pick<IncomingMessage, 'sender' | 'channelType'> | null
): CallerRootBinding {
  if (!provider) return {}
  try {
    return { root: provider.forSource(sourceMessage).userRootPath }
  } catch (error) {
    const failureCode = bindingFailureCode(error)
    if (failureCode === undefined) throw error
    return { failureCode }
  }
}
