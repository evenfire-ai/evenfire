import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { ApprovalMode } from '../../../src/types'
import {
  type HostApprovalModeTransport,
  type HostApprovalModeView,
  getHostApprovalModeSnapshot,
  readHostApprovalMode,
  selectHostApprovalMode,
  snapshotFromSessionRead,
  subscribeHostApprovalMode,
} from '../lib/hostApprovalModeStore'

export interface UseHostApprovalModeResult extends HostApprovalModeView {
  selectMode: (mode: ApprovalMode) => Promise<boolean>
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
        const session = await window.clerum.rpc.loadSessionMessages(agent, agent, id, [agent])
        const snapshot = snapshotFromSessionRead(session)
        if (!snapshot) throw new Error('session approval mode missing')
        return snapshot
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
  return { ...view, selectMode }
}
