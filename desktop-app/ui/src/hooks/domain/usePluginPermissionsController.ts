import { useCallback, useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PluginAuditEntryView, PluginGrantView } from '../../../../src/pluginSdkProtocol'
import { desktopQueryKeys } from './queryKeys'

const ACTIVITY_LIMIT = 200

export type PluginPermissionGroup = {
  pluginId: string
  pluginTitle: string
  capabilities: PluginGrantView[]
  /** Most recent `lastUsedAt` across the plugin's grants, for the summary row. */
  lastUsedAt: string | null
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Settings → Plugin permissions (spec §11).
 *
 * Grants and audit entries both come from the main process over IPC rather than
 * from the network, but they are still server-state-shaped (owned elsewhere,
 * refetched, invalidated after a mutation), so they follow the same TanStack
 * Query pattern as every other data section in this app.
 */
export function usePluginPermissionsController() {
  const queryClient = useQueryClient()

  const grantsQuery = useQuery({
    queryKey: desktopQueryKeys.pluginGrants,
    queryFn: () => window.clerum.pluginSdk.listGrants(),
  })

  const activityQuery = useQuery({
    queryKey: desktopQueryKeys.pluginActivity(ACTIVITY_LIMIT),
    queryFn: () => window.clerum.pluginSdk.activity(ACTIVITY_LIMIT),
  })

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: desktopQueryKeys.pluginGrants })
    void queryClient.invalidateQueries({
      queryKey: desktopQueryKeys.pluginActivity(ACTIVITY_LIMIT),
    })
  }, [queryClient])

  const revokeMutation = useMutation({
    mutationFn: ({ pluginId, capability }: { pluginId: string; capability?: string }) =>
      window.clerum.pluginSdk.revoke(pluginId, capability),
    onSuccess: invalidate,
  })

  const clearActivityMutation = useMutation({
    mutationFn: () => window.clerum.pluginSdk.clearActivity(),
    onSuccess: invalidate,
  })

  /** One row per plugin; capabilities nested underneath. */
  const groups = useMemo<PluginPermissionGroup[]>(() => {
    const byPlugin = new Map<string, PluginPermissionGroup>()
    for (const grant of grantsQuery.data ?? []) {
      const existing = byPlugin.get(grant.pluginId)
      if (existing) {
        existing.capabilities.push(grant)
        if (grant.lastUsedAt && (!existing.lastUsedAt || grant.lastUsedAt > existing.lastUsedAt)) {
          existing.lastUsedAt = grant.lastUsedAt
        }
        continue
      }
      byPlugin.set(grant.pluginId, {
        pluginId: grant.pluginId,
        pluginTitle: grant.pluginTitle,
        capabilities: [grant],
        lastUsedAt: grant.lastUsedAt,
      })
    }
    return [...byPlugin.values()].sort((a, b) => a.pluginTitle.localeCompare(b.pluginTitle))
  }, [grantsQuery.data])

  const activity = useMemo<PluginAuditEntryView[]>(
    () => activityQuery.data ?? [],
    [activityQuery.data]
  )

  return {
    groups,
    activity,
    loading: grantsQuery.isPending || activityQuery.isPending,
    error: grantsQuery.error
      ? toErrorMessage(grantsQuery.error)
      : activityQuery.error
        ? toErrorMessage(activityQuery.error)
        : null,
    revoking: revokeMutation.isPending,
    revoke: (pluginId: string, capability?: string) =>
      revokeMutation.mutateAsync({ pluginId, ...(capability ? { capability } : {}) }),
    clearActivity: () => clearActivityMutation.mutateAsync(),
    refresh: invalidate,
  }
}
