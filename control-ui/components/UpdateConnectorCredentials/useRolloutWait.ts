'use client'

import { useEffect, useRef, useState } from 'react'
import {
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  ROLLOUT_INCOMPLETE_REASON,
} from '@constants/connectorCredentials'
import { getMcpServer } from '@lib/api'
import type { McpServerCondition } from '@lib/api'
import type { RolloutWaitOptions, RotationPhase } from './types'

/**
 * Returns the McpServer's DeploymentReady condition ONLY if it transitioned
 * strictly after `cutoffIso` — the instant captured client-side right before
 * the rotation PUT was sent. A condition timestamped at or before the PUT is
 * the rollout's PREVIOUS state (e.g. the old pod staying Ready while the HCC
 * has not reconciled the new Secret yet); treating a stale True as success
 * would report a rotation that never happened (issue #223 plan, Fase 3 §6).
 */
function findFreshDeploymentReady(
  conditions: McpServerCondition[] | undefined,
  cutoffIso: string
): McpServerCondition | undefined {
  const condition = conditions?.find(c => c.type === 'DeploymentReady')
  if (!condition) return undefined
  const isFresh = new Date(condition.lastTransitionTime).getTime() > new Date(cutoffIso).getTime()
  return isFresh ? condition : undefined
}

export function useRolloutWait({
  serverName,
  cutoff,
  expectedUid,
  expectedGeneration,
}: RolloutWaitOptions) {
  const [phase, setPhase] = useState<RotationPhase>('idle')
  const [phaseMessage, setPhaseMessage] = useState('')
  const rolloutIncompleteMessage = useRef<string | null>(null)

  // Poll THIS connector's own McpServer CRD until DeploymentReady resolves,
  // fails, or the bounded timeout expires. Success is NEVER declared from the
  // PUT's 200 alone (Fase 3 §4 corolario vinculante).
  useEffect(() => {
    if (phase !== 'rotating' || !cutoff) return
    let cancelled = false
    const startedAt = Date.now()
    // Each rotation gets a clean slate: a diagnostic left over from a previous
    // attempt must never be reported as THIS rotation's failure.
    rolloutIncompleteMessage.current = null

    async function poll() {
      let latest: Awaited<ReturnType<typeof getMcpServer>>
      try {
        latest = await getMcpServer(serverName)
      } catch (e) {
        if (cancelled) return
        // A transient read failure resolves nothing either way — surface it
        // but keep polling until the bounded cap below fires.
        setPhaseMessage(
          `Could not check rollout status (${e instanceof Error ? e.message : 'request failed'}). Retrying…`
        )
        return
      }
      if (cancelled) return
      if (expectedUid !== undefined) {
        if (
          latest.metadata?.uid !== expectedUid ||
          (expectedGeneration !== undefined &&
            latest.metadata?.generation !== undefined &&
            latest.metadata.generation !== expectedGeneration)
        ) {
          cancelled = true
          clearInterval(id)
          setPhase('failed')
          setPhaseMessage(
            'The connector changed during verification. Refresh to check its current state.'
          )
          return
        }
        if (latest.metadata?.generation !== expectedGeneration) return
      }
      const fresh = findFreshDeploymentReady(latest.status?.conditions, cutoff!)
      if (expectedGeneration !== undefined && fresh?.observedGeneration !== expectedGeneration)
        return
      if (!fresh) return
      if (fresh.status === 'True') {
        cancelled = true
        clearInterval(id)
        setPhase('success')
        return
      }
      // NO `False` DeploymentReady is a failure verdict for this UI — not even
      // `RolloutIncomplete`:
      //
      //  - `WaitingForReplicas` is the normal transitory state of EVERY rollout,
      //    written synchronously right after the PUT. Treating it as failure
      //    would abort almost every successful rotation on the first poll.
      //  - `RolloutIncomplete` means the HCC exhausted ITS 120s readiness budget
      //    (host-context-controller reconciler.ts, pollReadiness 24×5s) — but the
      //    HCC keeps observing past that verdict (post-terminal re-poll) and
      //    corrects the condition to True when a slow pod converges. Latching
      //    failure here would discard the ~60s of budget this poll still holds
      //    and report a deterministic false negative for any rollout converging
      //    between 120s and 180s — the exact bug of issue #223.
      //
      // So the ONLY outcomes are: a fresh True (success, above), or this poll's
      // own bounded timeout — which reports `failed` with the preserved HCC
      // diagnostic if RolloutIncomplete was seen, `timeout` otherwise.
      if (fresh.status === 'False' && fresh.reason === ROLLOUT_INCOMPLETE_REASON) {
        rolloutIncompleteMessage.current =
          fresh.message || 'The connector rollout did not complete.'
        // Keep the operator informed instead of silently spinning: the rollout
        // has outlived the controller's own budget but is still being observed.
        setPhaseMessage(
          "The rollout is taking longer than the controller's readiness budget — still verifying…"
        )
      }
    }

    const id = setInterval(() => {
      if (Date.now() - startedAt >= POLL_TIMEOUT_MS) {
        clearInterval(id)
        if (!cancelled) {
          cancelled = true
          if (rolloutIncompleteMessage.current !== null) {
            // The HCC diagnosed the rollout (RolloutIncomplete) and never
            // corrected it to True within our budget: a real failure, reported
            // with the controller's own rollout numbers — never degraded to a
            // bare "timed out".
            setPhase('failed')
            setPhaseMessage(rolloutIncompleteMessage.current)
          } else {
            // No verdict either way inside the budget — an inconclusive
            // timeout, distinct from a diagnosed failure.
            setPhase('timeout')
            // Diagnostic only. The "what to try next" sentence is mode-specific
            // and is appended by the timeout banner from `submittedMode`.
            setPhaseMessage(
              `The rollout did not finish within ${Math.round(POLL_TIMEOUT_MS / 1000)}s. Run ` +
                `"kubectl get mcpserver ${serverName} -o yaml" to see the current DeploymentReady ` +
                'condition.'
            )
          }
        }
        return
      }
      void poll()
    }, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [phase, cutoff, serverName, expectedUid, expectedGeneration])

  return { phase, phaseMessage, setPhase, setPhaseMessage }
}
