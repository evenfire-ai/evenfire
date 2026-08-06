'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { IconX } from '@components/icons'
import { type OrgGrant, createOrgGrant, listOrgGrants, revokeOrgGrant } from '@lib/api'
import { useConfirmDialog } from '../../ConfirmDialog'
import { SectionLoadingSkeleton } from '../../SectionLoadingSkeleton'
import { useToast } from '../../Toast'
import { Button } from '../../ui'
import { RetryBanner } from '../RetryBanner'
import type { GrantAccessModalProps } from './types'

const GRANT_ERROR_MESSAGES: Record<string, string> = {
  grantee_not_found: 'No org found with that slug. Check the grantee\u2019s exact org name.',
  self_grant: 'You can\u2019t grant access to your own org.',
  plugin_public:
    'This plugin is public \u2014 everyone can already install it, so no grant is needed.',
  grantee_reserved: 'That org name is reserved and can\u2019t receive grants.',
  plugin_not_found: 'This plugin no longer exists in the registry.',
}

function grantErrorMessage(err: unknown): string {
  const code = (err as { code?: string }).code
  return (code && GRANT_ERROR_MESSAGES[code]) || 'Could not create the grant. Please try again.'
}

export function GrantAccessModal({
  entryName,
  orgScope,
  opener,
  onClose,
}: GrantAccessModalProps): React.JSX.Element {
  const pluginName = entryName.startsWith('@') ? entryName : `@${orgScope}/${entryName}`
  const titleId = useId()
  const descriptionId = useId()
  const inputId = useId()
  const openerRef = useRef<HTMLElement | null>(opener ?? null)

  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()
  const [grants, setGrants] = useState<OrgGrant[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [granteeOrg, setGranteeOrg] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [confirmingRevoke, setConfirmingRevoke] = useState(false)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [formError, setFormError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const { grants: rows } = await listOrgGrants(pluginName)
      setGrants(rows.filter(g => g.pluginName === pluginName))
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [pluginName])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !submitting && !revokingId && !confirmingRevoke) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [confirmingRevoke, onClose, revokingId, submitting])

  useEffect(() => {
    return () => openerRef.current?.focus()
  }, [])

  const busy = submitting || revokingId != null || confirmingRevoke
  const trimmed = granteeOrg.trim()
  const canSubmit = trimmed.length > 0 && !busy

  async function handleGrant() {
    if (!canSubmit) return
    setSubmitting(true)
    setFormError('')
    try {
      await createOrgGrant({ pluginName, granteeOrg: trimmed })
      showToast(`Shared ${pluginName} with @${trimmed}.`, { tone: 'success' })
      setGranteeOrg('')
      await load()
    } catch (err) {
      setFormError(grantErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRevoke(grant: OrgGrant) {
    setConfirmingRevoke(true)
    let ok = false
    try {
      ok = await confirm({
        title: 'Revoke access',
        message: `Revoke @${grant.granteeOrg}\u2019s access to ${grant.pluginName}? They will no longer be able to install it.`,
        confirmLabel: 'Revoke',
        tone: 'danger',
      })
    } finally {
      setConfirmingRevoke(false)
    }
    if (!ok) return
    setRevokingId(grant.id)
    try {
      await revokeOrgGrant(grant.id)
      showToast(`Revoked @${grant.granteeOrg}.`, { tone: 'success' })
    } catch (err) {
      const status = (err as { status?: number }).status
      showToast(status === 404 ? 'Grant was already revoked.' : 'Could not revoke the grant.', {
        tone: status === 404 ? 'info' : 'error',
      })
    } finally {
      setRevokingId(null)
    }
    await load()
  }

  return (
    <div
      className="cu-modal-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <section
        className="cu-modal-panel cu-modal-panel--share-access"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="cu-modal-panel__head">
          <div className="cu-modal-panel__title-group">
            <h3 id={titleId} className="cu-modal-panel__title">
              Grant access
            </h3>
            <p className="cu-modal-panel__eyebrow">
              Sharing <code>{pluginName}</code>
            </p>
          </div>
          <Button
            className="cu-btn--icon"
            variant="ghost"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
          >
            <IconX width={18} height={18} />
          </Button>
        </header>

        <p id={descriptionId} className="cu-modal-copy">
          Let another org pull and install every version of <code>{pluginName}</code>. Grants are
          revocable from this dialog.
        </p>

        <div className="cu-share-access-form" role="group" aria-label="Grant access to an org">
          <div className="cu-field cu-field--compact">
            <label htmlFor={inputId}>Grantee org slug</label>
            <div className="cu-share-access-form__row">
              <input
                id={inputId}
                className="cu-input"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                placeholder="acme-labs"
                disabled={busy}
                value={granteeOrg}
                onChange={event => {
                  setGranteeOrg(event.target.value)
                  if (formError) setFormError('')
                }}
                onKeyDown={event => {
                  if (event.key === 'Enter' && canSubmit) {
                    event.preventDefault()
                    void handleGrant()
                  }
                }}
              />
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={!canSubmit}
                onClick={() => void handleGrant()}
              >
                {submitting ? 'Granting\u2026' : 'Grant access'}
              </Button>
            </div>
            <span className="cu-field__hint">
              Use the org’s exact slug — grants are scoped to <code>{pluginName}</code>.
            </span>
          </div>
          {formError ? (
            <p className="cu-field__error" role="alert">
              {formError}
            </p>
          ) : null}
        </div>

        <div className="cu-modal-panel__body cu-share-access-list">
          <div className="cu-share-access-list__head">
            <span className="cu-share-access-list__title">Currently shared with</span>
            <span className="cu-share-access-list__count">
              {loading ? '\u2026' : grants.length}
            </span>
          </div>
          {loading ? (
            <SectionLoadingSkeleton
              className="cu-section-loading-skeleton--compact"
              label="Loading grants"
              rows={2}
            />
          ) : loadError ? (
            <RetryBanner message="Could not load grants." onRetry={() => void load()} />
          ) : grants.length === 0 ? (
            <p className="cu-muted-note--compact">Not shared with any org yet.</p>
          ) : (
            <ul className="cu-grant-list">
              {grants.map(g => {
                const isRevoking = revokingId === g.id
                return (
                  <li key={g.id} className="cu-grant-list__row">
                    <span className="cu-grant-list__org">
                      <code>@{g.granteeOrg}</code>
                    </span>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      disabled={busy}
                      onClick={() => void handleRevoke(g)}
                    >
                      {isRevoking ? 'Revoking\u2026' : 'Revoke'}
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <footer className="cu-modal-panel__foot">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Close
          </Button>
        </footer>
      </section>
      {confirmDialog}
    </div>
  )
}
