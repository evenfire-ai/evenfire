'use client'

import React, { useEffect, useRef, useState } from 'react'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { useToast } from '@components/Toast'
import { Button, Field, FormSection, TextInput } from '@components/ui'
import { getMcpServer, getMcpServers, updateMcpSecret } from '@lib/api'
import type { McpServerCondition } from '@lib/api'
import type { RotationPhase, UpdateConnectorCredentialsProps } from './types'

// This timeout MUST stay strictly greater than the HCC's own readiness budget
// (host-context-controller reconciler.ts: pollReadiness, 24 attempts × 5s =
// 120s), plus room for the SecretInformer round-trip and one poll interval.
//
// The two budgets are not interchangeable, and the slack between them is
// load-bearing in BOTH directions:
//
//  - When a rollout fails, the HCC writes the diagnosis — DeploymentReady=False
//    reason=RolloutIncomplete with the rollout numbers — at the END of its
//    budget. If this timeout expired first, the operator would see a bare
//    "timed out" instead of the diagnosis that was about to arrive.
//  - When a rollout is merely SLOW (a loaded cluster, a long image pull), the
//    HCC exhausts its 120s budget and writes RolloutIncomplete before the pod
//    goes Ready — and then its post-terminal re-poll (reconciler.ts,
//    performReconcile) arms one more window and CORRECTS the condition to
//    True/ReplicasAvailable once the Deployment converges. The ~60s this
//    timeout outlives the HCC budget is precisely the observation slack in
//    which that correction lands. Latching failure the moment RolloutIncomplete
//    appears would throw that slack away and report a deterministic false
//    negative for any rotation converging between 120s and 180s (issue #223).
//
// Exported so the tests drive fake timers off THESE values instead of keeping
// their own copy: a duplicated budget silently stops testing the real one the
// first time either side changes.
export const POLL_INTERVAL_MS = 3_000
export const POLL_TIMEOUT_MS = 180_000

// The `reason` the HCC stamps on DeploymentReady=False when ITS readiness poll
// has exhausted its budget. Terminal for that poll window — but NOT
// irreversible: the HCC's post-terminal re-poll keeps observing and rewrites
// the condition to True/ReplicasAvailable if the Deployment converges later.
// For this UI it therefore means "keep the diagnostic, keep polling until OUR
// budget expires", never "stop and declare failure". Every other False
// (notably `WaitingForReplicas`) is a transitory rollout state with no
// diagnostic value. Must match host-context-controller/src/reconciler.ts.
export const ROLLOUT_INCOMPLETE_REASON = 'RolloutIncomplete'

// Slack subtracted from the client-side cutoff to absorb clock skew between the
// browser and the Kubernetes API server (which stamps lastTransitionTime). Must
// stay well under a real rollout's duration so a stale condition is still
// excluded. 5s comfortably covers ordinary NTP drift.
export const CLOCK_SKEW_TOLERANCE_MS = 5_000

function buildConfirmMessage(secretName: string, affected: string[] | null): string {
  if (affected === null) {
    return `This rotates the credential value(s) you entered in Secret "${secretName}" and restarts any connector that references it.`
  }
  if (affected.length === 0) {
    return `This rotates the credential value(s) you entered in Secret "${secretName}". No connector currently references this Secret, so nothing will restart.`
  }
  return `This rotates the credential value(s) you entered in Secret "${secretName}" and restarts: ${affected.join(', ')}.`
}

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

export function UpdateConnectorCredentials({
  serverName,
  envSecret,
}: UpdateConnectorCredentialsProps) {
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()

  const [draft, setDraft] = useState<Record<string, string>>({})
  const [validationError, setValidationError] = useState('')
  // Best-effort preview of "who restarts", shown in the pre-save confirm
  // dialog (requisito 5). The authoritative list only exists after the PUT
  // (Fase 1 regla 9) — this mirrors the server's own
  // `spec.envSecret.name === thisSecret` filter against the live connector
  // list so the operator sees the same answer before committing.
  const [previewAffected, setPreviewAffected] = useState<string[] | null>(null)

  const [phase, setPhase] = useState<RotationPhase>('idle')
  const [phaseMessage, setPhaseMessage] = useState('')
  const [rotationCutoff, setRotationCutoff] = useState<string | null>(null)
  const [rotationAffected, setRotationAffected] = useState<string[]>([])
  // The HCC's most recent RolloutIncomplete diagnostic, kept across polls (a
  // ref, not state: it only matters at the timeout boundary, so it must not
  // re-render or re-fire the poll effect). Seeing RolloutIncomplete never
  // latches failure — the HCC re-polls post-terminal and can still correct the
  // condition to True for a slow pod — but the diagnostic is preserved so that
  // if OUR budget expires without a True, the operator gets the HCC's rollout
  // numbers instead of a bare "timed out".
  const rolloutIncompleteMessage = useRef<string | null>(null)

  useEffect(() => {
    if (!envSecret) return
    let cancelled = false
    getMcpServers()
      .then(({ items }) => {
        if (cancelled) return
        const names = (items || [])
          .filter(item => {
            const candidate = item.spec?.envSecret as { name?: unknown } | undefined
            return Boolean(candidate) && candidate?.name === envSecret.name
          })
          .map(item => item.metadata?.name)
          .filter((n): n is string => typeof n === 'string')
          .sort((a, b) => a.localeCompare(b))
        setPreviewAffected(names)
      })
      .catch(() => {
        // Best-effort preview only. A failure here just falls back to the
        // generic (unnamed) confirm message — the authoritative list always
        // arrives from the PUT response once the operator confirms and saves.
        if (!cancelled) setPreviewAffected(null)
      })
    return () => {
      cancelled = true
    }
  }, [envSecret])

  // Poll THIS connector's own McpServer CRD until DeploymentReady resolves,
  // fails, or the bounded timeout expires. Success is NEVER declared from the
  // PUT's 200 alone (Fase 3 §4 corolario vinculante).
  useEffect(() => {
    if (phase !== 'rotating' || !rotationCutoff) return
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
      const fresh = findFreshDeploymentReady(latest.status?.conditions, rotationCutoff!)
      if (!fresh) return
      if (fresh.status === 'True') {
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
            setPhaseMessage(
              `The rollout did not finish within ${Math.round(POLL_TIMEOUT_MS / 1000)}s. Run ` +
                `"kubectl get mcpserver ${serverName} -o yaml" to see the current DeploymentReady ` +
                'condition, or try the rotation again.'
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
  }, [phase, rotationCutoff, serverName])

  if (!envSecret) {
    return (
      <FormSection title="Update credentials">
        <p className="cu-muted">
          This connector has no Kubernetes Secret configured for credentials — there is nothing to
          rotate here.
        </p>
      </FormSection>
    )
  }

  function updateField(secretKey: string, value: string) {
    setDraft(prev => ({ ...prev, [secretKey]: value }))
    if (validationError) setValidationError('')
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (phase === 'saving' || phase === 'rotating') return

    const data: Record<string, string> = {}
    for (const key of envSecret!.keys) {
      const value = draft[key.secretKey]
      if (value && value.trim() !== '') data[key.secretKey] = value
    }
    if (Object.keys(data).length === 0) {
      setValidationError('Enter at least one credential value to rotate.')
      return
    }
    setValidationError('')

    const confirmed = await confirm({
      title: 'Rotate credentials',
      message: buildConfirmMessage(envSecret!.name, previewAffected),
      confirmLabel: 'Rotate & restart',
      tone: 'danger',
    })
    if (!confirmed) return

    // Captured BEFORE the PUT fires — the correlation anchor the poll below
    // uses to tell "this rotation's" DeploymentReady from a stale prior one.
    //
    // `lastTransitionTime` is stamped by the Kubernetes API server's clock,
    // while this cutoff is the browser's. If the browser runs slightly ahead of
    // the server (ordinary NTP skew), a genuinely fresh condition could carry a
    // timestamp just *before* this cutoff and be wrongly discarded, wedging the
    // UI until the 180s timeout. Back the anchor off by a small tolerance so
    // clock skew can't hide the rotation's own outcome. The window we widen is
    // harmless: a truly stale condition predates the PUT by the full rollout,
    // far more than this margin.
    const cutoff = new Date(Date.now() - CLOCK_SKEW_TOLERANCE_MS).toISOString()
    setPhase('saving')
    setPhaseMessage('')
    try {
      const result = await updateMcpSecret(envSecret!.name, data)
      setDraft({})
      setRotationAffected(result.affectedConnectors)
      setRotationCutoff(cutoff)
      setPhase('rotating')
    } catch (e) {
      setPhase('failed')
      setPhaseMessage(e instanceof Error ? e.message : 'Failed to rotate credentials')
      showToast('Failed to rotate credentials.', { tone: 'error' })
    }
  }

  function resetToIdle() {
    setPhase('idle')
    setPhaseMessage('')
    setRotationCutoff(null)
    setRotationAffected([])
    rolloutIncompleteMessage.current = null
  }

  const busy = phase === 'saving' || phase === 'rotating'
  // The poll above verifies ONLY this connector's own DeploymentReady, via
  // getMcpServer(serverName). A shared Secret can be referenced by other
  // connectors too (result.affectedConnectors); the HCC restarts them as well,
  // but this screen never observes THEIR rollout. So the success banner asserts
  // the new credential is being served only for the connector it actually
  // verified (serverName), and names the rest as rolling out separately rather
  // than claiming an unobserved success for them.
  const otherAffected = rotationAffected.filter(name => name !== serverName)
  const otherAffectedNote =
    otherAffected.length === 0
      ? ''
      : ` ${otherAffected.length === 1 ? 'Another connector' : 'Other connectors'} sharing this Secret roll${
          otherAffected.length === 1 ? 's' : ''
        } out separately: ${otherAffected.join(', ')}.`

  return (
    <FormSection
      title="Update credentials"
      description={
        <>
          Rotate values stored in Secret <code>{envSecret.name}</code>. Values are write-only — this
          screen never shows a stored credential, only key names.
        </>
      }
    >
      {confirmDialog}

      <div className="cu-table-wrap">
        <table className="cu-table">
          <thead>
            <tr>
              <th>Secret key</th>
              <th>Env var</th>
            </tr>
          </thead>
          <tbody>
            {envSecret.keys.map(k => (
              <tr key={k.secretKey}>
                <td>
                  <code>{k.secretKey}</code>
                </td>
                <td>
                  <code>{k.envVar}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form className="cu-form-stack" onSubmit={handleSubmit}>
        {envSecret.keys.map(k => (
          <Field key={k.secretKey} htmlFor={`mcp-cred-${k.secretKey}`} label={k.secretKey}>
            <TextInput
              id={`mcp-cred-${k.secretKey}`}
              type="password"
              autoComplete="new-password"
              placeholder="Leave blank to keep current value"
              value={draft[k.secretKey] || ''}
              onChange={e => updateField(k.secretKey, e.target.value)}
              disabled={busy}
            />
          </Field>
        ))}

        {validationError ? (
          <div className="cu-banner cu-banner--error" role="alert">
            {validationError}
          </div>
        ) : null}

        {phase === 'rotating' ? (
          <div className="cu-banner cu-banner--info" role="status">
            Rotating credentials — waiting for {serverName} to restart with the new value.
            {phaseMessage ? ` ${phaseMessage}` : ''}
          </div>
        ) : null}

        {phase === 'success' ? (
          <div className="cu-banner cu-banner--ok" role="status">
            Credentials rotated. {serverName} restarted and is serving the new credential.
            {otherAffectedNote}
          </div>
        ) : null}

        {phase === 'failed' ? (
          <div className="cu-banner cu-banner--error" role="alert">
            Rotation failed: {phaseMessage}
          </div>
        ) : null}

        {phase === 'timeout' ? (
          <div className="cu-banner cu-banner--warning" role="alert">
            {phaseMessage}
          </div>
        ) : null}

        <div className="cu-create-actions">
          {phase === 'success' || phase === 'failed' || phase === 'timeout' ? (
            <Button type="button" onClick={resetToIdle}>
              {phase === 'success' ? 'Done' : 'Rotate again'}
            </Button>
          ) : (
            <Button type="submit" variant="primary" disabled={busy}>
              {phase === 'saving'
                ? 'Saving…'
                : phase === 'rotating'
                  ? 'Rotating…'
                  : 'Rotate credentials'}
            </Button>
          )}
        </div>
      </form>
    </FormSection>
  )
}
