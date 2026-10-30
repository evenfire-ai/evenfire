'use client'

import { useEffect, useRef, useState } from 'react'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { ExistingConnectorSecretFields } from '@components/ExistingConnectorSecretFields'
import { useToast } from '@components/Toast'
import { useRolloutWait } from '@components/UpdateConnectorCredentials/useRolloutWait'
import { Button, FormSection } from '@components/ui'
import {
  CredentialAttachError,
  buildAttachPayload,
  changeConnectorSecretReference,
  sameCredentialSpec,
  validateCredentialAttach,
} from '@lib/connectorCredentials'
import type {
  AttachedCredentials,
  ExistingCredentialSelection,
} from '@lib/connectorCredentials.types'
import type { ChangeConnectorSecretProps } from './types'

export function ChangeConnectorSecret({
  serverName,
  server,
  reference,
  blockedReason,
  onBusyChange,
  onSpecSaved,
  onFinished,
  onCancel,
}: ChangeConnectorSecretProps) {
  const { confirm, confirmDialog } = useConfirmDialog()
  const { showToast } = useToast()
  const [selection, setSelection] = useState<ExistingCredentialSelection>({
    rows: [],
    ready: false,
  })
  const [submitting, setSubmitting] = useState(false)
  const [saved, setSaved] = useState<AttachedCredentials | null>(null)
  const [error, setError] = useState('')
  const [refreshRequired, setRefreshRequired] = useState(false)
  const lock = useRef(false)
  const mounted = useRef(true)
  const completed = useRef(false)
  const callbacks = useRef({ onBusyChange, onFinished, onSpecSaved })
  callbacks.current = { onBusyChange, onFinished, onSpecSaved }
  const { phase, phaseMessage, setPhase, setPhaseMessage } = useRolloutWait({
    serverName,
    cutoff: saved?.cutoff ?? null,
    expectedUid: saved?.server.metadata?.uid,
    expectedGeneration: saved?.server.metadata?.generation,
  })
  const locked = submitting || Boolean(saved) || refreshRequired
  const valid =
    selection.ready &&
    Boolean(selection.secret) &&
    !validateCredentialAttach(
      'use-existing',
      selection.secret?.name ?? '',
      selection.rows,
      server,
      selection.secret,
      { storedKeysOnly: true }
    )
  const changed =
    valid &&
    !sameCredentialSpec(
      reference,
      buildAttachPayload(selection.secret!.name, selection.rows).reference
    )

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    callbacks.current.onBusyChange?.(locked)
    return () => callbacks.current.onBusyChange?.(false)
  }, [locked])
  useEffect(() => {
    if (phase !== 'success' || completed.current) return
    completed.current = true
    showToast(`Assigned Secret changed. ${serverName} is ready.`, { tone: 'success' })
    callbacks.current.onFinished()
  }, [phase, serverName, showToast])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (lock.current || locked || blockedReason || !changed) return
    lock.current = true
    setSubmitting(true)
    setError('')
    try {
      const accepted = await confirm({
        title: 'Change assigned Secret',
        confirmLabel: 'Assign and restart',
        message: `Change ${serverName} from Secret "${reference.name}" to "${selection.secret!.name}" and restart it? Secret values stay unchanged. Other connectors keep their current assignments.`,
      })
      if (!accepted || !mounted.current) return
      const result = await changeConnectorSecretReference({ serverName, server, selection })
      if (!mounted.current) return
      setSaved(result)
      callbacks.current.onSpecSaved(result.server)
      if (!result.server.metadata?.uid || !Number.isInteger(result.server.metadata.generation)) {
        setPhase('timeout')
        setPhaseMessage('Rollout identity is unavailable.')
      } else setPhase('rotating')
    } catch (error) {
      if (!mounted.current) return
      // A known verification/conflict error carries its own recovery message;
      // anything else stays generic. Either way no shared Secret was touched.
      const known = error instanceof CredentialAttachError
      setError(
        known
          ? `${error.message} Secret values were not changed.`
          : 'The assignment could not be completed or verified. Refresh credentials to review the connector before trying again. Secret values were not changed.'
      )
      setRefreshRequired(true)
    } finally {
      lock.current = false
      if (mounted.current) setSubmitting(false)
    }
  }

  return (
    <FormSection
      title="Change assigned Secret"
      description="Choose reusable credentials and map stored keys. This changes only this connector’s assignment."
    >
      {confirmDialog}
      <form className="cu-connector-credentials-form cu-secret-assignment-form" onSubmit={submit}>
        <p>
          Currently assigned: <code>{reference.name}</code>
        </p>
        {server.spec?.remote ? (
          <p className="cu-muted">
            Remote credentials use existing authentication header placeholders. Keep their
            environment variable names; assigning a Secret does not add headers.
          </p>
        ) : null}
        {blockedReason ? (
          <p role="status" className="cu-banner cu-banner--warn">
            {blockedReason}
          </p>
        ) : null}
        <ExistingConnectorSecretFields
          server={server}
          initialReference={reference}
          disabled={locked}
          onChange={setSelection}
        />
        {error ? (
          <p role="alert" className="cu-banner cu-banner--error">
            {error}
          </p>
        ) : null}
        {phase === 'rotating' ? (
          <p role="status">
            Assignment saved. Waiting for {serverName} to become ready… {phaseMessage}
          </p>
        ) : null}
        {phase === 'failed' || phase === 'timeout' ? (
          <p role="alert">
            Assignment saved, but readiness could not be verified. Refresh to check status.{' '}
            {phaseMessage}
          </p>
        ) : null}
        <div className="cu-create-actions">
          {saved || refreshRequired ? (
            <Button onClick={onFinished}>
              {phase === 'rotating' ? 'Check credentials later' : 'Refresh credentials'}
            </Button>
          ) : (
            <>
              <Button variant="ghost" disabled={submitting} onClick={onCancel}>
                Cancel assignment change
              </Button>
              <Button
                type="submit"
                variant="primary"
                loading={submitting}
                disabled={Boolean(blockedReason) || !changed || submitting}
              >
                Assign and restart
              </Button>
            </>
          )}
        </div>
      </form>
    </FormSection>
  )
}
