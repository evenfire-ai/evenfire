import { useCallback, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  TeamDirectoryEntry,
  TeamDirectoryResult,
  TeamMember,
  TeamSummary,
} from '../../../../src/types'
import { desktopQueryKeys } from './queryKeys'

const EMPTY_TEAMS: TeamSummary[] = []
const EMPTY_MEMBERS: TeamMember[] = []
const EMPTY_DIRECTORY: Record<string, TeamDirectoryEntry> = {}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function buildTeamDirectoryMap(directory: TeamDirectoryResult | undefined) {
  if (!directory) return EMPTY_DIRECTORY
  const nextMap: Record<string, TeamDirectoryEntry> = {}
  for (const item of directory.items) {
    nextMap[item.team.id] = item
  }
  return nextMap
}

function teamDirectoryError(
  directory: TeamDirectoryResult | undefined,
  error: unknown
): string | null {
  if (error) return toErrorMessage(error)
  if (!directory?.restoreFailed) return null
  const { message, attemptedTeamId, currentTeamId: landedTeamId } = directory.restoreFailed
  return `Session left on team ${landedTeamId} after failing to restore ${attemptedTeamId}. Please log in again. (${message})`
}

export function useTeamsDataController() {
  const queryClient = useQueryClient()
  const initialLastUpdatedAtRef = useRef(Date.now())
  const directoryQuery = useQuery({
    queryKey: desktopQueryKeys.teamsDirectory,
    queryFn: () => window.clerum.team.directory(),
    enabled: false,
  })

  const fetchDirectory = useCallback(
    async (loadDirectory: () => Promise<TeamDirectoryResult>) => {
      try {
        await queryClient.fetchQuery({
          queryKey: desktopQueryKeys.teamsDirectory,
          queryFn: loadDirectory,
          staleTime: 0,
        })
      } catch {
        // Query state already records the error for consumers.
      }
    },
    [queryClient]
  )

  const refresh = useCallback(async () => {
    await fetchDirectory(() => window.clerum.team.directory())
  }, [fetchDirectory])

  const refreshInitialDirectory = useCallback(async () => {
    await fetchDirectory(() => window.clerum.team.initialDirectory())
  }, [fetchDirectory])

  const ensureHydrated = useCallback(async () => {
    const queryState = queryClient.getQueryState(desktopQueryKeys.teamsDirectory)
    if (queryState?.fetchStatus === 'fetching') {
      return
    }
    await refreshInitialDirectory()
  }, [queryClient, refreshInitialDirectory])

  const reset = useCallback(() => {
    queryClient.removeQueries({ queryKey: desktopQueryKeys.teamsDirectory })
    initialLastUpdatedAtRef.current = Date.now()
  }, [queryClient])

  const teamDirectory = useMemo(
    () => buildTeamDirectoryMap(directoryQuery.data),
    [directoryQuery.data]
  )
  const currentTeamId = directoryQuery.data?.currentTeamId || ''

  return useMemo(
    () => ({
      loading: directoryQuery.fetchStatus === 'fetching' || directoryQuery.status === 'pending',
      error: teamDirectoryError(directoryQuery.data, directoryQuery.error),
      teams: directoryQuery.data?.items.map(item => item.team) ?? EMPTY_TEAMS,
      teamMembers: currentTeamId
        ? (teamDirectory[currentTeamId]?.members ?? EMPTY_MEMBERS)
        : EMPTY_MEMBERS,
      teamDirectory,
      teamDirectoryHydrated:
        directoryQuery.status === 'success' || directoryQuery.status === 'error',
      truncated: Boolean(directoryQuery.data?.truncated),
      currentTeamId,
      lastUpdatedAt: directoryQuery.dataUpdatedAt || initialLastUpdatedAtRef.current,
      refresh,
      refreshInitialDirectory,
      ensureHydrated,
      reset,
    }),
    [
      currentTeamId,
      directoryQuery.data,
      directoryQuery.dataUpdatedAt,
      directoryQuery.error,
      directoryQuery.fetchStatus,
      directoryQuery.status,
      ensureHydrated,
      refresh,
      refreshInitialDirectory,
      reset,
      teamDirectory,
    ]
  )
}
