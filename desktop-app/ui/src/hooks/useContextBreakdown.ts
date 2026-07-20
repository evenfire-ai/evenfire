import { useCallback, useRef, useState } from 'react'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext/types'
import type { TaskKey } from '@contexts/AgentTaskTrackerContext/types'
import { type ContextBreakdownLite, useChatStore } from './useChatStore'

/**
 * On-demand context-window breakdown, keyed by `makeTaskKey(agentRef, chatId)`.
 *
 * Deliberately SEPARATE from the `SessionStateLite` poll: the breakdown is an
 * ephemeral per-turn snapshot that only matters while the popover is open, so we
 * fetch it lazily when the user opens the chip (refetch on-open) instead of
 * paying for it on every session poll. A short TTL collapses repeated open/close
 * cycles into a single network round-trip, and an in-flight ref de-dups
 * concurrent opens for the same chat.
 */

/** How long a fetched breakdown is considered fresh before a re-open refetches. */
const BREAKDOWN_TTL_MS = 15_000

interface BreakdownEntry {
  breakdown: ContextBreakdownLite | null
  fetchedAt: number
}

export interface UseContextBreakdownResult {
  /** Latest breakdown for a chat, or `undefined` if never fetched. `null` means
   *  fetched-but-no-snapshot (cold session / not owned) — render "—" / hide. */
  getBreakdown: (agentRef: string, chatId: string) => ContextBreakdownLite | null | undefined
  /** True while a fetch for this chat is in flight. */
  isLoading: (agentRef: string, chatId: string) => boolean
  /**
   * Fetch (or refetch if stale) the breakdown for a chat. Call on popover open.
   *
   * Pass `{ force: true }` to bypass the fresh/TTL short-circuit and re-probe
   * immediately — used when a turn completes and a snapshot the mount probe
   * missed may now exist (a cached `null` verdict must not suppress that
   * re-probe). The in-flight de-dup is always honoured.
   */
  fetchContextBreakdown: (
    agentRef: string,
    chatId: string,
    options?: { force?: boolean }
  ) => Promise<void>
}

export function useContextBreakdown(): UseContextBreakdownResult {
  const { getContextBreakdown } = useChatStore()
  const [breakdownByTaskKey, setBreakdownByTaskKey] = useState<Record<TaskKey, BreakdownEntry>>({})
  // Keys with an in-flight request — avoids duplicate fetches on rapid re-open.
  const inFlightRef = useRef<Set<TaskKey>>(new Set())
  const [loadingKeys, setLoadingKeys] = useState<Record<TaskKey, boolean>>({})

  const getBreakdown = useCallback(
    (agentRef: string, chatId: string) =>
      breakdownByTaskKey[makeTaskKey(agentRef, chatId)]?.breakdown,
    [breakdownByTaskKey]
  )

  const isLoading = useCallback(
    (agentRef: string, chatId: string) => Boolean(loadingKeys[makeTaskKey(agentRef, chatId)]),
    [loadingKeys]
  )

  const fetchContextBreakdown = useCallback(
    async (agentRef: string, chatId: string, options?: { force?: boolean }) => {
      if (!agentRef || !chatId) return
      const key = makeTaskKey(agentRef, chatId)
      if (inFlightRef.current.has(key)) return

      // Skip the network call when we have a fresh-enough result — unless the
      // caller forces a re-probe (turn completed; a snapshot may now exist that
      // the mount probe cached as `null`).
      if (!options?.force) {
        const existing = breakdownByTaskKey[key]
        if (existing && Date.now() - existing.fetchedAt < BREAKDOWN_TTL_MS) return
      }

      inFlightRef.current.add(key)
      setLoadingKeys(prev => ({ ...prev, [key]: true }))
      try {
        // The agent IS the hostRef for desktop chats (mirrors loadSessionMessages,
        // which is called as `loadSessionMessages(agentRef, agentRef, chatId)`).
        const result = await getContextBreakdown(agentRef, agentRef, chatId)
        setBreakdownByTaskKey(prev => ({
          ...prev,
          [key]: { breakdown: result.breakdown, fetchedAt: Date.now() },
        }))
      } catch (error) {
        // A breakdown fetch must never break the chat surface — log and leave the
        // last-known value (or "never fetched") in place; the chip just won't update.
        console.warn('[useContextBreakdown] fetch failed (ignored):', error)
      } finally {
        inFlightRef.current.delete(key)
        setLoadingKeys(prev => {
          const next = { ...prev }
          delete next[key]
          return next
        })
      }
    },
    [breakdownByTaskKey, getContextBreakdown]
  )

  return { getBreakdown, isLoading, fetchContextBreakdown }
}
