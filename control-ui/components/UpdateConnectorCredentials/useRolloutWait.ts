'use client'

import { useEffect, useRef, useState } from 'react'
import {
  DEPLOYMENT_READY_CONDITION,
  EGRESS_PROXY_VALUES_VALID_CONDITION,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  ROLLOUT_INCOMPLETE_REASON,
} from '@constants/connectorCredentials'
import { getMcpServer } from '@lib/api'
import type { McpServerCondition } from '@lib/api'
import type { RolloutFailureKind, RolloutWaitOptions, RotationPhase } from './types'

/**
 * Returns the condition of `type` ONLY if it transitioned strictly after
 * `cutoffIso` — the instant captured client-side right before the rotation PUT
 * was sent. A condition timestamped at or before the PUT is the resource's
 * PREVIOUS state (e.g. the old pod staying Ready while the HCC has not
 * reconciled the new Secret yet); treating a stale True as success would report
 * a rotation that never happened, and treating a stale refusal as this write's
 * verdict would blame the new value for an old one.
 */
function findFreshCondition(
  conditions: McpServerCondition[] | undefined,
  type: string,
  cutoffIso: string
): McpServerCondition | undefined {
  const condition = conditions?.find(c => c.type === type)
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
  const [phase, setPhaseState] = useState<RotationPhase>('idle')
  const [phaseMessage, setPhaseMessage] = useState('')
  const [failureKind, setFailureKind] = useState<RolloutFailureKind | null>(null)
  const rolloutIncompleteMessage = useRef<string | null>(null)

  // The diagnosis belongs to the transition that produced it: every phase
  // change clears it, and the one branch that diagnoses a failure (the
  // egress-proxy refusal below) sets it again right after its own
  // `setPhase('failed')`. A caller raising `failed` for its own reasons —
  // or starting a new attempt — therefore can never inherit a stale
  // refusal verdict from a previous write.
  function setPhase(next: RotationPhase) {
    setFailureKind(null)
    setPhaseState(next)
  }

  // Poll THIS connector's own McpServer CRD until DeploymentReady resolves, the
  // egress-proxy preflight refuses the new value, or the bounded timeout
  // expires. Success is NEVER declared from the PUT's 200 alone (Fase 3 §4
  // corolario vinculante).
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
      const conditions = latest.status?.conditions
      // A fresh egress-proxy refusal is a TERMINAL verdict for this write, and
      // it is checked BEFORE DeploymentReady on purpose: the blocking reconcile
      // never writes DeploymentReady, so any True still on the CRD belongs to
      // the PREVIOUS rollout. Waiting for it would spin to the 180s timeout and
      // then report under a stale DeploymentReady=True, hiding that the new
      // value sits outside the egress-proxy class and was refused outright.
      const refusal = findFreshCondition(conditions, EGRESS_PROXY_VALUES_VALID_CONDITION, cutoff!)
      if (
        refusal?.status === 'False' &&
        (expectedGeneration === undefined || refusal.observedGeneration === expectedGeneration)
      ) {
        cancelled = true
        clearInterval(id)
        setPhase('failed')
        // After `setPhase`, which clears any earlier diagnosis: this failure
        // is the refusal, and callers key their "correct the value" banner
        // off this discriminator instead of re-reading the message text.
        setFailureKind('egress-refused')
        // The HCC authors this message from placeholder/source/context names
        // only, so it carries no value bytes. Nothing else from the
        // condition is shown, matching every other failure path here.
        setPhaseMessage(
          refusal.message ||
            `The egress-proxy image refused a credential value (${refusal.reason}).`
        )
        return
      }
      const fresh = findFreshCondition(conditions, DEPLOYMENT_READY_CONDITION, cutoff!)
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

  return { phase, phaseMessage, failureKind, setPhase, setPhaseMessage }
}
