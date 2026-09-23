import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  type HostModelSelectionTransport,
  type HostModelSelectionView,
  clearHostModelSelectionError,
  getHostModelSelectionSnapshot,
  loadHostModels,
  markHostModelSelectionChanged,
  selectHostModel,
  subscribeHostModelSelection,
} from '../lib/hostModelSelectionStore'
import { useChatStore } from './useChatStore'

/**
 * Per-session model selection for one `(agentRef, chatId)` pair (R2 model
 * selector). A thin subscription over the shared
 * {@link ../lib/hostModelSelectionStore}: the chip, the composer image guard and
 * the send path all read the same entry, so an optimistic pick is immediately
 * enforced everywhere without a new provider tree.
 *
 * A selection is OPTIMISTIC (R2 "Option A"): the UI reflects the choice at once,
 * then the `POST /model` write is attempted. The outcome splits four ways:
 *
 *   - 200                           → persisted server-side; clear the intent.
 *   - 409 model_selection_conflict  → another writer moved the session selection;
 *                                     keep the last confirmed state, refetch, and
 *                                     block images until the authoritative read lands.
 *   - 403 model_not_allowed         → a real allowlist rejection; drop the intent
 *                                     and surface the inline error.
 *   - anything else                 → the host is suspended / unreachable
 *                                     (connection error, 5xx, wake-eligible 503);
 *                                     KEEP the optimistic UI, record the model as
 *                                     pending, and swallow+log — the next send
 *                                     wakes the host and applies it (piggyback).
 *
 * The transport split is done on the error MESSAGE, not an HTTP status: Electron
 * IPC serializes errors down to their message string, so the status set on the
 * `ApiError` in `rpcProxyClient` does NOT cross the bridge. Both terminal
 * rejections embed their token in that message.
 */

export interface UseHostModelsResult extends HostModelSelectionView {
  refresh: () => Promise<void>
  /** Applies the model to the session. Resolves `true` when usable next send. */
  selectModel: (model: string) => Promise<boolean>
  clearError: () => void
}

export function useHostModels(agentRef: string, chatId: string): UseHostModelsResult {
  const { getHostModels, setHostModel } = useChatStore()
  const selectionChatId = chatId || null

  const transport = useMemo<HostModelSelectionTransport>(
    () => ({
      getHostModels: (hostRef: string, id: string) => getHostModels(hostRef, id),
      setHostModel: (hostRef: string, id: string, model: string, expectedRevision?: number) =>
        setHostModel(hostRef, id, model, expectedRevision),
    }),
    [getHostModels, setHostModel]
  )

  const subscribe = useCallback(
    (listener: () => void) => subscribeHostModelSelection(agentRef, selectionChatId, listener),
    [agentRef, selectionChatId]
  )
  const getSnapshot = useCallback(
    () => getHostModelSelectionSnapshot(agentRef, selectionChatId),
    [agentRef, selectionChatId]
  )
  const view = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  useEffect(() => {
    if (!agentRef) return
    void loadHostModels(transport, agentRef, selectionChatId)
  }, [transport, agentRef, selectionChatId, view.scopeGeneration])

  useEffect(() => {
    const validUntil = view.imageInput.validUntil
    if (!validUntil || view.imageInput.state !== 'supported') return
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      const remaining = Date.parse(validUntil) - Date.now()
      if (remaining <= 0) {
        markHostModelSelectionChanged(agentRef, selectionChatId)
        return
      }
      timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647))
    }
    schedule()
    return () => clearTimeout(timer)
  }, [agentRef, selectionChatId, view.imageInput.state, view.imageInput.validUntil])

  const selectModel = useCallback(
    (model: string) => selectHostModel(transport, agentRef, selectionChatId, model),
    [transport, agentRef, selectionChatId]
  )
  const refresh = useCallback(() => {
    if (getHostModelSelectionSnapshot(agentRef, selectionChatId).loading) return Promise.resolve()
    return loadHostModels(transport, agentRef, selectionChatId, { force: true })
  }, [transport, agentRef, selectionChatId])
  useEffect(() => {
    const onFocus = () => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])
  const clearError = useCallback(
    () => clearHostModelSelectionError(agentRef, selectionChatId),
    [agentRef, selectionChatId]
  )

  return { ...view, selectModel, clearError, refresh }
}
