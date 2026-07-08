import { useCallback, useMemo, useState } from 'react'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AccessCatalog } from '../../../../src/types'
import { getSharedFilesDirectoryKey } from '../../lib/sharedFiles'
import { desktopQueryKeys } from './queryKeys'
import type {
  SharedFileDirEntry,
  SharedFilesDirectoryState,
  SharedFilesListState,
  SharedFilesystemSummary,
} from './useContextsDataController.types'

const EMPTY_STRING_LIST: string[] = []

type SharedFileDirectorySpec = {
  contextId: string
  filesystemName: string
  path: string
  directoryKey: string
}

type SharedFilesQueryResult<TData> = {
  fetchStatus?: string
  status?: string
  error?: unknown
  data?: TData
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function addUnique(values: string[], value: string): string[] {
  return values.includes(value) ? values : [...values, value]
}

function addUniqueDirectorySpec(
  values: SharedFileDirectorySpec[],
  next: SharedFileDirectorySpec
): SharedFileDirectorySpec[] {
  return values.some(
    value =>
      value.contextId === next.contextId &&
      value.filesystemName === next.filesystemName &&
      value.path === next.path
  )
    ? values
    : [...values, next]
}

function sharedFilesListState(
  query: SharedFilesQueryResult<{ items?: SharedFilesystemSummary[] }> | undefined
): SharedFilesListState {
  return {
    loading: query?.fetchStatus === 'fetching',
    loaded: query?.status === 'success' || query?.status === 'error',
    error: query?.error ? toErrorMessage(query.error) : null,
    items:
      query?.data && typeof query.data === 'object' && 'items' in query.data
        ? ((query.data as { items?: SharedFilesystemSummary[] }).items ?? null)
        : null,
  }
}

function sharedFilesDirectoryState(
  query: SharedFilesQueryResult<{ entries?: SharedFileDirEntry[]; truncated?: boolean }> | undefined
): SharedFilesDirectoryState {
  const data = query?.data
  return {
    loading: query?.fetchStatus === 'fetching',
    loaded: query?.status === 'success' || query?.status === 'error',
    error: query?.error ? toErrorMessage(query.error) : null,
    entries: data?.entries ?? [],
    truncated: Boolean(data?.truncated),
  }
}

export function useContextsDataController() {
  const queryClient = useQueryClient()
  const [trackedSharedFileContextIds, setTrackedSharedFileContextIds] = useState<string[]>([])
  const [trackedSharedFileDirectories, setTrackedSharedFileDirectories] = useState<
    SharedFileDirectorySpec[]
  >([])

  const catalogQuery = useQuery({
    queryKey: desktopQueryKeys.accessCatalog,
    queryFn: () => window.clerum.access.refreshCatalog(),
    enabled: false,
  })

  const sharedFileListQueries = useQueries({
    queries: trackedSharedFileContextIds.map(contextId => ({
      queryKey: desktopQueryKeys.sharedFilesList(contextId),
      queryFn: () => window.clerum.sharedFiles.listAttached(contextId),
      enabled: false,
    })),
  })

  const sharedFileDirectoryQueries = useQueries({
    queries: trackedSharedFileDirectories.map(spec => ({
      queryKey: desktopQueryKeys.sharedFilesDirectory(
        spec.contextId,
        spec.filesystemName,
        spec.path
      ),
      queryFn: () =>
        window.clerum.sharedFiles.listDirectory(spec.contextId, spec.filesystemName, spec.path),
      enabled: false,
    })),
  })

  const refreshWithCatalog = useCallback(
    async (catalogInput: AccessCatalog | Promise<AccessCatalog>) => {
      try {
        await queryClient.fetchQuery({
          queryKey: desktopQueryKeys.accessCatalog,
          queryFn: () => Promise.resolve(catalogInput),
          staleTime: 0,
        })
      } catch {
        // Query state already records the error for consumers.
      }
    },
    [queryClient]
  )

  const refresh = useCallback(async () => {
    try {
      await queryClient.fetchQuery({
        queryKey: desktopQueryKeys.accessCatalog,
        queryFn: () => window.clerum.access.refreshCatalog(),
        staleTime: 0,
      })
    } catch {
      // Query state already records the error for consumers.
    }
  }, [queryClient])

  const refreshSharedFiles = useCallback(
    async (contextId: string) => {
      const normalizedContextId = contextId.trim()
      if (!normalizedContextId) return
      setTrackedSharedFileContextIds(previous => addUnique(previous, normalizedContextId))
      try {
        await queryClient.fetchQuery({
          queryKey: desktopQueryKeys.sharedFilesList(normalizedContextId),
          queryFn: () => window.clerum.sharedFiles.listAttached(normalizedContextId),
          staleTime: 0,
        })
      } catch {
        // Query state already records the error for consumers.
      }
    },
    [queryClient]
  )

  const loadSharedFilesDirectory = useCallback(
    async (
      contextId: string,
      filesystemName: string,
      path: string,
      options: { force?: boolean } = {}
    ) => {
      const normalizedContextId = contextId.trim()
      const normalizedFilesystemName = filesystemName.trim()
      const normalizedPath = path || '/'
      if (!normalizedContextId || !normalizedFilesystemName) return

      const queryKey = desktopQueryKeys.sharedFilesDirectory(
        normalizedContextId,
        normalizedFilesystemName,
        normalizedPath
      )
      const queryState = queryClient.getQueryState(queryKey)
      if (
        !options.force &&
        (queryState?.fetchStatus === 'fetching' || queryState?.status === 'success')
      ) {
        return
      }

      const directoryKey = getSharedFilesDirectoryKey(normalizedFilesystemName, normalizedPath)
      setTrackedSharedFileDirectories(previous =>
        addUniqueDirectorySpec(previous, {
          contextId: normalizedContextId,
          filesystemName: normalizedFilesystemName,
          path: normalizedPath,
          directoryKey,
        })
      )

      try {
        await queryClient.fetchQuery({
          queryKey,
          queryFn: () =>
            window.clerum.sharedFiles.listDirectory(
              normalizedContextId,
              normalizedFilesystemName,
              normalizedPath
            ),
          staleTime: options.force ? 0 : Infinity,
        })
      } catch {
        // Query state already records the error for consumers.
      }
    },
    [queryClient]
  )

  const reset = useCallback(() => {
    setTrackedSharedFileContextIds([])
    setTrackedSharedFileDirectories([])
    queryClient.removeQueries({ queryKey: desktopQueryKeys.accessCatalog })
    queryClient.removeQueries({ queryKey: ['desktop-app', 'shared-files'] })
  }, [queryClient])

  const sharedFilesByContext = useMemo(() => {
    const next: Record<string, SharedFilesListState> = {}
    trackedSharedFileContextIds.forEach((contextId, index) => {
      next[contextId] = sharedFilesListState(sharedFileListQueries[index])
    })
    return next
  }, [sharedFileListQueries, trackedSharedFileContextIds])

  const sharedFileDirectoriesByContext = useMemo(() => {
    const next: Record<string, Record<string, SharedFilesDirectoryState>> = {}
    trackedSharedFileDirectories.forEach((spec, index) => {
      next[spec.contextId] = {
        ...(next[spec.contextId] ?? {}),
        [spec.directoryKey]: sharedFilesDirectoryState(sharedFileDirectoryQueries[index]),
      }
    })
    return next
  }, [sharedFileDirectoryQueries, trackedSharedFileDirectories])

  return useMemo(
    () => ({
      loading: catalogQuery.fetchStatus === 'fetching' || catalogQuery.status === 'pending',
      error: catalogQuery.error ? toErrorMessage(catalogQuery.error) : null,
      accessCatalog: catalogQuery.data ?? null,
      contextIds: catalogQuery.data?.contextIds ?? EMPTY_STRING_LIST,
      userContextIds: catalogQuery.data?.userContextIds ?? EMPTY_STRING_LIST,
      teamContextIds: catalogQuery.data?.teamContextIds ?? EMPTY_STRING_LIST,
      sharedFilesByContext,
      sharedFileDirectoriesByContext,
      refresh,
      refreshSharedFiles,
      loadSharedFilesDirectory,
      refreshWithCatalog,
      reset,
    }),
    [
      catalogQuery.data,
      catalogQuery.error,
      catalogQuery.fetchStatus,
      catalogQuery.status,
      loadSharedFilesDirectory,
      refresh,
      refreshSharedFiles,
      refreshWithCatalog,
      reset,
      sharedFileDirectoriesByContext,
      sharedFilesByContext,
    ]
  )
}
