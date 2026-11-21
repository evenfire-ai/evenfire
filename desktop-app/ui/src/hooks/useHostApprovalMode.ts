import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { ApprovalMode } from '../../../src/types'
import {
  type HostApprovalModeTransport,
  type HostApprovalModeView,
  clearHostApprovalModeSaveFailure,
  getHostApprovalModeSnapshot,
  readHostApprovalMode,
  refreshHostApprovalModeLimit,
  selectHostApprovalMode,
  snapshotFromSessionRead,
  subscribeHostApprovalMode,
} from '../lib/hostApprovalModeStore'

export interface UseHostApprovalModeResult extends HostApprovalModeView {
  selectMode: (mode: ApprovalMode) => Promise<boolean>
  /** Forget this chat's failed pick once the user has seen it. */
  clearSaveFailure: () => void
  /** Re-read the Host's limit for this chat; the picker calls it as it opens. */
  refreshLimit: () => Promise<void>
  /** The store's current view of this chat, read outside a render. */
  readView: () => HostApprovalModeView
}

function isApprovalMode(value: unknown): value is ApprovalMode {
  return value === 'manual' || value === 'auto' || value === 'allow_all'
}

export function useHostApprovalMode(
  agentRef: string,
  chatId: string | null
): UseHostApprovalModeResult {
  const transport = useMemo<HostApprovalModeTransport>(
    () => ({
      setApprovalMode: async (agent, id, mode) => {
        const result = await window.clerum.rpc.setApprovalMode(agent, agent, id, mode)
        const previous = readHostApprovalMode(agent, id)
        return {
          approvalMode: result.approvalMode,
          modeCeiling: result.modeCeiling,
          channelCap: result.channelCap,
          effectiveApprovalMode: result.effectiveApprovalMode,
          shellClassifierAvailable: previous.shellClassifierAvailable,
        }
      },
      readSessionApproval: async (agent, id) => {
        // One turn is enough: the approval fields are session state.
        const session = await window.clerum.rpc.loadSessionMessages(agent, agent, id, [agent], {
          limit: 1,
        })
        const snapshot = snapshotFromSessionRead(session)
        if (!snapshot) throw new Error('session approval mode missing')
        return snapshot
      },
      // The ceiling is Host-wide, so any one session of the Host carries it.
      // Read past the chat list's catalog cache: the point is a fresh value.
      readHostModeCeiling: async agent => {
        const catalog = await window.clerum.rpc.listSessions(agent, undefined, {
          agent,
          limit: 1,
        })
        const ceiling = catalog.items[0]?.modeCeiling
        return isApprovalMode(ceiling) ? ceiling : null
      },
    }),
    []
  )

  const subscribe = useCallback(
    (listener: () => void) => subscribeHostApprovalMode(agentRef, chatId, listener),
    [agentRef, chatId]
  )
  const getSnapshot = useCallback(
    () => getHostApprovalModeSnapshot(agentRef, chatId),
    [agentRef, chatId]
  )
  const view = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const selectMode = useCallback(
    (mode: ApprovalMode) => selectHostApprovalMode(transport, agentRef, chatId, mode),
    [transport, agentRef, chatId]
  )
  const clearSaveFailure = useCallback(
    () => clearHostApprovalModeSaveFailure(agentRef, chatId),
    [agentRef, chatId]
  )
  const refreshLimit = useCallback(
    () => refreshHostApprovalModeLimit(transport, agentRef, chatId),
    [transport, agentRef, chatId]
  )
  const readView = useCallback(() => readHostApprovalMode(agentRef, chatId), [agentRef, chatId])
  return { ...view, selectMode, clearSaveFailure, refreshLimit, readView }
}
