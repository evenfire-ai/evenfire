'use client'

import React, { useEffect, useState } from 'react'
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
// The two budgets are not interchangeable: when a rollout fails, the HCC is the
// one that writes the verdict — DeploymentReady=False with the rollout numbers
// — at the END of its budget. If this timeout expired first, or at the same
// moment, the operator would be shown a bare "timed out" instead of the
// diagnosis that was about to arrive, and would have to go dig it out of the
// CRD by hand. Giving up before the system has finished answering is the
// difference between an actionable failure and a shrug.
// Exported so the tests drive fake timers off THESE values instead of keeping
// their own copy: a duplicated budget silently stops testing the real one the
// first time either side changes.
export const POLL_INTERVAL_MS = 3_000
export const POLL_TIMEOUT_MS = 180_000

// The `reason` the HCC stamps on DeploymentReady=False ONLY when the readiness
// poll has exhausted its budget — the terminal, actionable failure. Every other
// False (notably `WaitingForReplicas`) is a transitory rollout state. Must match
// host-context-controller/src/reconciler.ts.
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
      // A `False` DeploymentReady is NOT automatically a failure. The HCC writes
      // `False` with reason `WaitingForReplicas` synchronously right after the
      // rollout starts — the normal transitory state of EVERY rollout — and only
      // escalates to the terminal reason `RolloutIncomplete` once its readiness
      // poll exhausts its budget (host-context-controller reconciler.ts). Treating
      // the transitory `False` as failure would abort almost every successful
      // rotation on the first poll, seconds before the new pod goes Ready. So only
      // the terminal verdict counts as failure; any other non-True state
      // (WaitingForReplicas, Unknown) means "still rolling out" — keep polling
      // until success, the terminal failure, or the bounded timeout. This mirrors
      // the `reason === 'RolloutIncomplete'` discriminator the e2e helpers already
      // use (assertRolloutNeverSucceeds).
      if (fresh.status === 'False' && fresh.reason === ROLLOUT_INCOMPLETE_REASON) {
        setPhase('failed')
        setPhaseMessage(fresh.message || 'The connector rollout did not complete.')
      }
    }

    const id = setInterval(() => {
      if (Date.now() - startedAt >= POLL_TIMEOUT_MS) {
        clearInterval(id)
        if (!cancelled) {
          setPhase('timeout')
          setPhaseMessage(
            `The rollout did not finish within ${Math.round(POLL_TIMEOUT_MS / 1000)}s. Run ` +
              `"kubectl get mcpserver ${serverName} -o yaml" to see the current DeploymentReady ` +
              'condition, or try the rotation again.'
          )
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
  }

  const busy = phase === 'saving' || phase === 'rotating'
  const restartTargets = rotationAffected.length > 0 ? rotationAffected.join(', ') : serverName

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
            Rotating credentials — waiting for {restartTargets} to restart with the new value.
            {phaseMessage ? ` ${phaseMessage}` : ''}
          </div>
        ) : null}

        {phase === 'success' ? (
          <div className="cu-banner cu-banner--ok" role="status">
            Credentials rotated. {restartTargets} restarted and is serving the new credential.
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
