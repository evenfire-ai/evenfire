import type { QueryClient } from '@tanstack/react-query'
import { GFS_DRIVE_MAIN } from '@constants/gfsBrowser'
import { desktopQueryKeys, isGfsSessionGeneration } from '@hooks/domain/queryKeys'

/**
 * Names already listed in a folder's cached children, for the numbered-name
 * ladders of moves and uploads. Empty when the folder was never listed: the
 * server's conflict answer stays authoritative either way.
 */
export function readCachedGfsChildNames(
  queryClient: QueryClient,
  scope: string | null,
  generation: number | null,
  folderId: string,
  drive: string = GFS_DRIVE_MAIN
): Set<string> {
  if (!scope || !isGfsSessionGeneration(generation)) return new Set()
  const cached = queryClient.getQueryData<{ pages?: Array<{ items?: Array<{ name: string }> }> }>(
    desktopQueryKeys.gfsChildren(scope, folderId, drive, generation)
  )
  return new Set((cached?.pages ?? []).flatMap(page => page.items?.map(item => item.name) ?? []))
}
