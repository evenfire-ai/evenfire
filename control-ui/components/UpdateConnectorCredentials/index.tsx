'use client'

import React, { useEffect, useRef, useState } from 'react'
import { DataTable, SimpleEditDialog, TableViewport } from '@clerum/frontend-components'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { useToast } from '@components/Toast'
import { Button, Field, FormSection, TextInput } from '@components/ui'
import { CLOCK_SKEW_TOLERANCE_MS } from '@constants/connectorCredentials'
import {
  createMcpSecret,
  getMcpServers,
  getRegistryCredentialSchema,
  updateMcpSecret,
} from '@lib/api'
import type { UpdateConnectorCredentialsProps } from './types'
import { useRolloutWait } from './useRolloutWait'

export {
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  ROLLOUT_INCOMPLETE_REASON,
  CLOCK_SKEW_TOLERANCE_MS,
} from '@constants/connectorCredentials'

// The aggregate validation alert's id. Rejected inputs point at it through
// `aria-describedby`, so a screen reader announces WHY a field is invalid from
// the field itself instead of only when the operator happens to reach the
// banner at the bottom of the form.
const VALIDATION_ERROR_ID = 'mcp-cred-validation-error'

// Kubernetes permits Secret keys that overlap Object.prototype, including
// __proto__, constructor, and toString. Credential drafts and request payloads
// therefore cannot be ordinary objects: reading an untouched key must mean
// "absent", never an inherited method or prototype value.
type CredentialMap = Record<string, string>

function emptyCredentialMap(): CredentialMap {
  return Object.create(null) as CredentialMap
}

function ownCredentialValue(credentials: CredentialMap, secretKey: string): string | undefined {
  return Object.hasOwn(credentials, secretKey) ? credentials[secretKey] : undefined
}

function withCredentialValue(
  credentials: CredentialMap,
  secretKey: string,
  value: string
): CredentialMap {
  const next = emptyCredentialMap()
  for (const key of Object.keys(credentials)) {
    next[key] = credentials[key]
  }
  next[secretKey] = value
  return next
}

/** Stable per-key input id, shared by the label's `htmlFor` and the
 *  post-submit focus lookup. */
function inputId(secretKey: string): string {
  return `mcp-cred-${secretKey}`
}

function buildConfirmMessage(secretName: string, affected: string[] | null): string {
  if (affected === null) {
    return `This rotates the credential value(s) you entered in Secret "${secretName}" and restarts any connector that references it.`
  }
  if (affected.length === 0) {
    return `This rotates the credential value(s) you entered in Secret "${secretName}". No connector currently references this Secret, so nothing will restart.`
  }
  return `This rotates the credential value(s) you entered in Secret "${secretName}" and restarts: ${affected.join(', ')}.`
}

export function UpdateConnectorCredentials({
  serverName,
  envSecret,
  surface = 'rotate',
  recipeOwned = false,
  registryCredentialSource,
  perKeyEditing = false,
  onBusyChange,
}: UpdateConnectorCredentialsProps) {
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()

  const busyCallback = useRef(onBusyChange)
  busyCallback.current = onBusyChange
  const [confirming, setConfirming] = useState(false)
  const confirmLock = useRef(false)
  const writeLock = useRef(false)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [draft, setDraft] = useState<CredentialMap>(emptyCredentialMap)
  const [validationError, setValidationError] = useState('')
  // The secretKeys the last submit rejected. Drives per-input `aria-invalid` /
  // `aria-describedby`, so the aggregate alert is not the ONLY way to learn
  // which fields are wrong — assistive technology gets the association on the
  // control itself.
  const [invalidKeys, setInvalidKeys] = useState<string[]>([])
  // Best-effort preview of "who restarts", shown in the pre-save confirm
  // dialog (requisito 5). The authoritative list only exists after the PUT
  // (Fase 1 regla 9) — this mirrors the server's own
  // `spec.envSecret.name === thisSecret` filter against the live connector
  // list so the operator sees the same answer before committing.
  const [previewAffected, setPreviewAffected] = useState<string[] | null>(null)

  const [rotationCutoff, setRotationCutoff] = useState<string | null>(null)
  const { phase, phaseMessage, setPhase, setPhaseMessage } = useRolloutWait({
    serverName,
    cutoff: rotationCutoff,
  })
  const [rotationAffected, setRotationAffected] = useState<string[]>([])
  // Labels use the same Kubernetes-valid key namespace as drafts. Keep this
  // map prototype-safe as well, because Marketplace schemas may contain keys
  // such as `constructor` or `__proto__`.
  const [credentialLabels, setCredentialLabels] = useState<CredentialMap>(emptyCredentialMap)
  // Latches the form onto rotate semantics after a successful create, so a
  // stale `surface` prop cannot leave "set" copy on a Secret that now exists.
  const [secretCreated, setSecretCreated] = useState(false)
  // Latches the form onto set semantics when a rotate PUT 404s.
  const [recreateRequired, setRecreateRequired] = useState(false)
  // Which operation is actually in flight / just completed. Captured at submit
  // time and used for the in-flight and success banners.
  const [submittedMode, setSubmittedMode] = useState<'set' | 'rotate'>('rotate')
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

  useEffect(() => {
    if (!registryCredentialSource) {
      setCredentialLabels(emptyCredentialMap())
      return
    }

    let cancelled = false
    void getRegistryCredentialSchema(
      registryCredentialSource.name,
      registryCredentialSource.version
    )
      .then(schema => {
        if (cancelled) return
        const labels = emptyCredentialMap()
        for (const key of schema.keys) labels[key.name] = key.label || key.name
        setCredentialLabels(labels)
      })
      .catch(() => {
        if (!cancelled) setCredentialLabels(emptyCredentialMap())
      })

    return () => {
      cancelled = true
    }
  }, [registryCredentialSource])

  useEffect(() => {
    busyCallback.current?.(
      editingKey !== null || confirming || phase === 'saving' || phase === 'rotating'
    )
    return () => busyCallback.current?.(false)
  }, [editingKey, confirming, phase])

  // "The Secret is missing and this screen would have to create it." Two
  // sources feed it, and `secretCreated` gates BOTH — not just the `surface`
  // prop. That latch flips the moment a create succeeds, and the Secret it
  // created exists from then on, whether the form got here from a stale
  // `surface` prop or from a rotate PUT that 404'd (`recreateRequired`).
  const secretMissing = !secretCreated && (recreateRequired || surface === 'set')
  // Ownership is the can-create invariant, and it is NOT derived from the
  // observed condition — see the `recipeOwned` prop doc.
  const mode: 'set' | 'rotate' = secretMissing && !recipeOwned ? 'set' : 'rotate'

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

  // A WorkflowRecipe-owned connector whose Secret is missing: the Secret name
  // belongs to the recipe, and HCC never creates a Deployment for
  // managed:false, so a create here would both cross an ownership boundary and
  // never converge.
  if (surface === 'recipe-owned' || (recipeOwned && secretMissing)) {
    return (
      <FormSection title="Update credentials">
        <p className="cu-muted">
          This connector&apos;s credentials are managed by its WorkflowRecipe. Add the Secret
          through the recipe&apos;s secrets, not here.
        </p>
      </FormSection>
    )
  }

  function updateField(secretKey: string, value: string) {
    setDraft(prev => withCredentialValue(prev, secretKey, value))
    if (validationError) setValidationError('')
    // The alert the inputs point at is about to disappear, so the association
    // has to go with it — a dangling aria-describedby is worse than none.
    if (invalidKeys.length > 0) setInvalidKeys([])
  }

  /** Rejects a submit: shows the aggregate alert, marks the offending inputs,
   *  and moves focus to the first one so the repair is reachable without
   *  hunting for it. `keys` may be empty (rotate mode's "at least one" rule
   *  blames no single field); focus then lands on the first input. */
  function rejectSubmit(message: string, keys: string[]) {
    setValidationError(message)
    setInvalidKeys(keys)
    const focusKey = keys[0] ?? envSecret!.keys[0]?.secretKey
    if (!focusKey) return
    const target = document.getElementById(inputId(focusKey))
    if (target instanceof HTMLElement) target.focus()
  }

  async function handleSubmit(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (writeLock.current || confirmLock.current || phase === 'saving' || phase === 'rotating')
      return

    const data = emptyCredentialMap()
    for (const key of envSecret!.keys) {
      if (editingKey !== null && key.secretKey !== editingKey) continue
      const value = ownCredentialValue(draft, key.secretKey)
      if (typeof value === 'string' && value.trim() !== '') data[key.secretKey] = value
    }
    if (mode === 'set') {
      // Every declared key is required. HCC validates each key and answers
      // SecretMissingKey if any is absent, so a partial create would just swap
      // one broken state for another while this screen reported success.
      const missing = envSecret!.keys
        .map(k => k.secretKey)
        .filter(secretKey => !(data[secretKey] && data[secretKey].trim()))
      if (missing.length > 0) {
        rejectSubmit(`Enter every credential value. Missing: ${missing.join(', ')}.`, missing)
        return
      }
    } else if (Object.keys(data).length === 0) {
      // No single field is at fault here — the rule is "at least one" — so
      // nothing is marked invalid; focus just returns to the top of the form.
      rejectSubmit('Enter at least one credential value to rotate.', [])
      return
    }
    setValidationError('')
    setInvalidKeys([])

    confirmLock.current = true
    setConfirming(true)
    const confirmed =
      editingKey !== null ||
      (await confirm(
        mode === 'set'
          ? {
              title: 'Set credentials',
              message: `This creates Secret "${envSecret!.name}" and starts ${serverName}.`,
              confirmLabel: 'Set & start',
            }
          : {
              title: 'Rotate credentials',
              message: buildConfirmMessage(envSecret!.name, previewAffected),
              confirmLabel: 'Rotate & restart',
              tone: 'danger',
            }
      ))
    confirmLock.current = false
    setConfirming(false)
    if (!confirmed) return
    writeLock.current = true

    // Captured BEFORE the PUT fires — the correlation anchor the poll below
    // uses to tell "this rotation's" DeploymentReady from a stale prior one.
    //
    // `lastTransitionTime` is stamped by the Kubernetes API server's clock,
    // while this cutoff is the browser's. If the browser runs slightly ahead of
    // the server (ordinary NTP skew), a genuinely fresh condition could carry a
    // timestamp just *before* this cutoff and be wrongly discarded, wedging the
    // UI until the 180s timeout. Back the anchor off by a small tolerance so
    // clock skew can't hide the rotation's own outcome.
    const cutoff = new Date(Date.now() - CLOCK_SKEW_TOLERANCE_MS).toISOString()
    setPhase('saving')
    setPhaseMessage('')
    setSubmittedMode(mode)
    try {
      if (mode === 'set') {
        try {
          await createMcpSecret(envSecret!.name, data)
        } catch (postError) {
          // The Secret may have appeared between page load and submit. Retry as
          // a merge-patch without inspecting status: control-api answers a bare
          // 500 for AlreadyExists, not reliably 409.
          try {
            await updateMcpSecret(envSecret!.name, data)
          } catch (putError) {
            throw (putError as { status?: number })?.status === 404 ? postError : putError
          }
        }
        setSecretCreated(true)
        // POST returns no affectedConnectors, so fall back to the best-effort
        // preview for the "who else restarts" note.
        setRotationAffected(previewAffected ?? [])
      } else {
        try {
          const result = await updateMcpSecret(envSecret!.name, data)
          setRotationAffected(result.affectedConnectors)
        } catch (putError) {
          // The Secret is gone. Do NOT silently POST: rotate mode may hold only
          // one of several declared keys. Demand every key instead.
          if ((putError as { status?: number })?.status === 404) {
            setRecreateRequired(true)
            setSecretCreated(false)
            setPhase('idle')
            setEditingKey(null)
            setValidationError('This Secret no longer exists. Enter every key to recreate it.')
            return
          }
          throw putError
        }
      }
      setDraft(emptyCredentialMap())
      setEditingKey(null)
      setRotationCutoff(cutoff)
      setPhase('rotating')
    } catch (e) {
      setPhase('failed')
      setPhaseMessage(e instanceof Error ? e.message : 'Failed to save credentials')
      showToast(mode === 'set' ? 'Failed to set credentials.' : 'Failed to rotate credentials.', {
        tone: 'error',
      })
    } finally {
      writeLock.current = false
    }
  }

  function resetToIdle() {
    setPhase('idle')
    setPhaseMessage('')
    setRotationCutoff(null)
    setRotationAffected([])
  }

  const busy = confirming || phase === 'saving' || phase === 'rotating'
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
      title={mode === 'set' ? 'Set credentials' : 'Update credentials'}
      description={
        mode === 'set' ? (
          <>
            This connector needs credentials before it can start. Values are write-only — this
            screen never shows a stored credential, only key names.
          </>
        ) : perKeyEditing ? (
          <>
            Rotate a key to replace its value in Secret <code>{envSecret.name}</code>. Existing
            values are never displayed.
          </>
        ) : (
          <>
            Rotate values stored in Secret <code>{envSecret.name}</code>. Values are write-only —
            this screen never shows a stored credential, only key names.
          </>
        )
      }
    >
      {confirmDialog}

      <SimpleEditDialog
        open={editingKey !== null && mode === 'rotate'}
        title={`Rotate ${editingKey === null ? 'credential' : (ownCredentialValue(credentialLabels, editingKey) ?? editingKey)}`}
        description={buildConfirmMessage(envSecret.name, previewAffected)}
        pending={phase === 'saving'}
        error={validationError || (phase === 'failed' ? phaseMessage : undefined)}
        isDirty={editingKey !== null && Boolean(ownCredentialValue(draft, editingKey))}
        isValid={editingKey !== null && Boolean(ownCredentialValue(draft, editingKey)?.trim())}
        saveLabel="Rotate"
        onCancel={() => {
          if (writeLock.current) return
          setEditingKey(null)
          setDraft(emptyCredentialMap())
          setValidationError('')
          resetToIdle()
        }}
        onSave={() => void handleSubmit()}
      >
        {editingKey !== null ? (
          <Field label="New value" htmlFor={inputId(editingKey)} required>
            <TextInput
              id={inputId(editingKey)}
              type="password"
              autoComplete="new-password"
              placeholder="Enter new value"
              value={ownCredentialValue(draft, editingKey) ?? ''}
              onChange={event => updateField(editingKey, event.target.value)}
              disabled={phase === 'saving'}
              required
            />
          </Field>
        ) : null}
      </SimpleEditDialog>

      <TableViewport className="cu-table-wrap">
        <DataTable className="eft-table cu-table cu-credential-key-table">
          <thead>
            <tr>
              <th>Secret key</th>
              <th>Env var</th>
              {perKeyEditing && mode === 'rotate' ? (
                <th className="cu-table__cell-actions">Actions</th>
              ) : null}
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
                {perKeyEditing && mode === 'rotate' ? (
                  <td className="cu-table__cell-actions">
                    <Button
                      size="sm"
                      aria-label={`Rotate ${ownCredentialValue(credentialLabels, k.secretKey) ?? k.secretKey}`}
                      disabled={busy}
                      onClick={() => {
                        resetToIdle()
                        setValidationError('')
                        setInvalidKeys([])
                        setDraft(emptyCredentialMap())
                        setEditingKey(k.secretKey)
                      }}
                    >
                      Rotate
                    </Button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </DataTable>
      </TableViewport>

      {/* `noValidate`: the browser's own required-field bubble would fire
          before handleSubmit and replace the aggregate message that actually
          NAMES the missing keys. The `required` attributes below are kept for
          their programmatic semantics. */}
      <form
        className={
          perKeyEditing && mode === 'rotate'
            ? 'cu-connector-credentials-status'
            : 'cu-connector-credentials-form cu-form-stack'
        }
        onSubmit={handleSubmit}
        noValidate
      >
        {(!perKeyEditing || mode === 'set') &&
          envSecret.keys.map(k => {
            const isInvalid = invalidKeys.includes(k.secretKey)
            return (
              <Field
                key={k.secretKey}
                htmlFor={inputId(k.secretKey)}
                label={ownCredentialValue(credentialLabels, k.secretKey) ?? k.secretKey}
                required={mode === 'set'}
              >
                <TextInput
                  id={inputId(k.secretKey)}
                  type="password"
                  autoComplete="new-password"
                  placeholder={mode === 'set' ? 'Required' : 'Leave blank to keep current value'}
                  value={ownCredentialValue(draft, k.secretKey) ?? ''}
                  onChange={e => updateField(k.secretKey, e.target.value)}
                  disabled={busy}
                  required={mode === 'set'}
                  aria-required={mode === 'set' || undefined}
                  invalid={isInvalid}
                  aria-invalid={isInvalid || undefined}
                  aria-describedby={isInvalid ? VALIDATION_ERROR_ID : undefined}
                />
              </Field>
            )
          })}

        {validationError && editingKey === null ? (
          <div className="cu-banner cu-banner--error" role="alert" id={VALIDATION_ERROR_ID}>
            {validationError}
          </div>
        ) : null}

        {phase === 'rotating' ? (
          <div className="cu-banner cu-banner--info" role="status">
            {submittedMode === 'set'
              ? `Setting credentials — waiting for ${serverName} to start.`
              : `Rotating credentials — waiting for ${serverName} to restart with the new value.`}
            {phaseMessage ? ` ${phaseMessage}` : ''}
          </div>
        ) : null}

        {phase === 'success' ? (
          <div className="cu-banner cu-banner--ok" role="status">
            {submittedMode === 'set'
              ? `Credentials set. ${serverName} started and is serving the new credential.`
              : `Credentials rotated. ${serverName} restarted and is serving the new credential.`}
            {otherAffectedNote}
          </div>
        ) : null}

        {phase === 'failed' && editingKey === null ? (
          <div className="cu-banner cu-banner--error" role="alert">
            {submittedMode === 'set'
              ? `Could not set credentials: ${phaseMessage}`
              : `Rotation failed: ${phaseMessage}`}
          </div>
        ) : null}

        {phase === 'timeout' ? (
          <div className="cu-banner cu-banner--warning" role="alert">
            {phaseMessage}{' '}
            {submittedMode === 'set'
              ? 'You can also try setting the credentials again.'
              : 'You can also try the rotation again.'}
          </div>
        ) : null}

        {!perKeyEditing || mode === 'set' ? (
          <div className="cu-create-actions">
            {phase === 'success' || phase === 'failed' || phase === 'timeout' ? (
              <Button type="button" onClick={resetToIdle}>
                {phase === 'success'
                  ? 'Done'
                  : submittedMode === 'set'
                    ? 'Try again'
                    : 'Rotate again'}
              </Button>
            ) : (
              <Button type="submit" variant="primary" disabled={busy}>
                {phase === 'saving'
                  ? 'Saving…'
                  : phase === 'rotating'
                    ? submittedMode === 'set'
                      ? 'Starting…'
                      : 'Rotating…'
                    : mode === 'set'
                      ? 'Set credentials'
                      : 'Rotate credentials'}
              </Button>
            )}
          </div>
        ) : null}
      </form>
    </FormSection>
  )
}
