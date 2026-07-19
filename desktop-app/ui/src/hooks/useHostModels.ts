import { useCallback, useEffect, useRef, useState } from 'react'
import { type HostModelsResult, useChatStore } from './useChatStore'

/**
 * A model selection is OPTIMISTIC (R2 "Option A"): the UI reflects the choice at
 * once, then the `POST /model` write is attempted. The outcome splits three ways:
 *
 *   - 200               → persisted server-side; clear any pending for the chat.
 *   - 403 model_not_allowed → a real allowlist rejection; revert + surface error.
 *   - anything else     → the host is suspended / unreachable (connection error,
 *                         5xx, wake-eligible 503); KEEP the optimistic UI, record
 *                         the model as pending, and swallow+log — the next send
 *                         wakes the host and applies it (piggyback).
 *
 * The 403 vs transport split is done on the error MESSAGE, not an HTTP status:
 * Electron IPC serializes errors down to their message string, so the status set
 * on the `ApiError` in `rpcProxyClient` does NOT cross the bridge. Only the
 * allowlist rejection embeds the `model_not_allowed` token in that message
 * (rpcProxyClient keys off the body's `error` code, not the status) — every other
 * failure, including a host-access 403, is treated as host-unavailable.
 */

/**
 * Per-session model selection state for one `(agentRef, chatId)` pair (R2 model
 * selector). Sibling of `useContextBreakdown`: the agent IS the hostRef for
 * desktop chats.
 *
 * `data` is:
 *   - `undefined` while the first fetch is in flight (selector hides — no flash),
 *   - `null` when the host predates the endpoint or the fetch failed (the bridge
 *     resolves 404/501 to `null`, and any error is swallowed to `null`) — the
 *     selector stays hidden rather than surfacing a noisy error (R2.6),
 *   - the model list + current selection otherwise.
 *
 * A model-list fetch or a failed set must never break the chat surface, so
 * fetch errors are swallowed and set errors surface only as inline copy.
 */

/** Token embedded in the rejection message when a model is outside the allowlist. */
const MODEL_NOT_ALLOWED = 'model_not_allowed'

export interface UseHostModelsResult {
  data: HostModelsResult | null | undefined
  loading: boolean
  saving: boolean
  /** Inline error from the last `selectModel` (e.g. a 403 model_not_allowed). */
  error: string | null
  /** Applies the model to the session. Resolves `true` on success. */
  selectModel: (model: string) => Promise<boolean>
  clearError: () => void
}

export function useHostModels(agentRef: string, chatId: string): UseHostModelsResult {
  const {
    getHostModels,
    setHostModel,
    setPendingModel,
    clearPendingModel,
    getPendingModel,
    setPreChatModel,
    getPreChatModel,
  } = useChatStore()
  const [data, setData] = useState<HostModelsResult | null | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Monotonic guard: a stale response for a previous chat must not overwrite the
  // current selection after a fast chat switch.
  const requestSeqRef = useRef(0)
  // Latest-value mirror of `data` so `selectModel` can capture the pre-optimistic
  // selection for revert without listing `data` in its deps (which would rebuild
  // the callback on every fetch). Same pattern used across the controllers.
  const dataRef = useRef(data)
  dataRef.current = data

  useEffect(() => {
    // `chatId` is OPTIONAL (R2 new-chat composer): with no chat yet we still fetch
    // the host-level model list so the selector can render before the first send.
    // Only the agent (== hostRef) is required to resolve the list.
    if (!agentRef) {
      setData(undefined)
      return
    }
    const seq = ++requestSeqRef.current
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const result = await getHostModels(agentRef, chatId)
        if (seq !== requestSeqRef.current) return
        // Reflect any locally-held (unpersisted) selection the server hasn't yet
        // applied: a PRE-CHAT pick (no chatId) or a PENDING pick recorded while the
        // host was suspended. The server's persisted `sessionModel` always wins;
        // the local slot only fills in when the server has none, so the chip keeps
        // showing the user's choice across a refetch/remount (e.g. the pre-chat →
        // first-chat transition) instead of flashing back to the host default.
        if (result && !result.sessionModel) {
          const localModel = chatId ? getPendingModel(agentRef, chatId) : getPreChatModel(agentRef)
          if (localModel) {
            setData({ ...result, sessionModel: localModel })
            return
          }
        }
        setData(result)
      } catch (err) {
        if (seq !== requestSeqRef.current) return
        // Never break the chat surface — hide the selector and log (mirrors
        // useContextBreakdown's swallow policy).
        console.warn('[useHostModels] fetch failed (ignored):', err)
        setData(null)
      } finally {
        if (seq === requestSeqRef.current) setLoading(false)
      }
    })()
  }, [agentRef, chatId, getHostModels, getPendingModel, getPreChatModel])

  const clearError = useCallback(() => setError(null), [])

  const selectModel = useCallback(
    async (model: string): Promise<boolean> => {
      if (!agentRef || !model) return false
      // PRE-CHAT (no chatId yet): there is no session to `POST /model` for, so the
      // pick is held locally keyed by agent. It creates NO stray chat; the send
      // path migrates it to the new chat's pending slot and piggybacks it on the
      // first message. Reflect it optimistically so the chip updates at once.
      if (!chatId) {
        setPreChatModel(agentRef, model)
        setData(prev =>
          prev ? { ...prev, sessionModel: model, sessionModelBlocked: undefined } : prev
        )
        return true
      }
      // Same monotonic guard as the fetch effect, applied to the WRITE path: the
      // component is mounted un-keyed, so a POST started for chat A can resolve
      // after a fast switch to chat B. Without this, chat A's accepted model
      // would overwrite chat B's `sessionModel` and clear its blocked-model
      // notice. Capture the seq now; a stale resolution is dropped silently
      // (the server selection is unaffected and self-corrects on next fetch).
      const seq = requestSeqRef.current
      // Capture the FULL pre-optimistic snapshot so a real rejection can revert
      // to it — both the selection and the blocked-model notice, which the
      // optimistic set below clears.
      const previousSelection = dataRef.current?.sessionModel ?? null
      const previousBlocked = dataRef.current?.sessionModelBlocked
      setSaving(true)
      setError(null)
      // Optimistic: reflect the choice immediately (R2 "Option A"). Clearing
      // `sessionModelBlocked` dismisses the stale "reverted to default" notice.
      setData(prev =>
        prev ? { ...prev, sessionModel: model, sessionModelBlocked: undefined } : prev
      )
      try {
        const result = await setHostModel(agentRef, chatId, model)
        if (seq !== requestSeqRef.current) return false
        // Persisted server-side — reconcile to the canonical model the runtime
        // echoed and drop any pending piggyback for this chat.
        setData(prev =>
          prev ? { ...prev, sessionModel: result.model, sessionModelBlocked: undefined } : prev
        )
        clearPendingModel(agentRef, chatId)
        return true
      } catch (err) {
        // Stale after a fast chat-switch: intentionally drop this pending too —
        // the selection was for a chat the user navigated away from, so we do
        // NOT record a piggyback for it (the closure still holds the old chatId).
        if (seq !== requestSeqRef.current) return false
        const message = err instanceof Error ? err.message : String(err)
        if (message.includes(MODEL_NOT_ALLOWED)) {
          // Real allowlist rejection (host was reachable): revert the optimistic
          // UI to the FULL pre-optimistic snapshot (selection + blocked notice)
          // and surface the error. NOT a wake case — record no pending.
          setData(prev =>
            prev
              ? { ...prev, sessionModel: previousSelection, sessionModelBlocked: previousBlocked }
              : prev
          )
          setError('That model is no longer allowed — selection unchanged.')
          return false
        }
        // Host unavailable (suspended / transport / 5xx): keep the optimistic UI
        // and record the model as pending so the next message send carries it and
        // wakes the host. Swallow + log, mirroring the fetch path's policy.
        console.warn(
          '[useHostModels] set failed; host likely suspended — keeping optimistic selection, will piggyback on next send:',
          err
        )
        setPendingModel(agentRef, chatId, model)
        return true
      } finally {
        // Always clear the transient saving flag — it is a single UI-local
        // boolean, and gating it on the seq would leave it stuck true on the
        // post-switch instance (which reuses this hook), disabling the menu.
        setSaving(false)
      }
    },
    [agentRef, chatId, setHostModel, setPendingModel, clearPendingModel, setPreChatModel]
  )

  return { data, loading, saving, error, selectModel, clearError }
}
