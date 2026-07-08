'use client'

import { useCallback, useEffect, useState } from 'react'
import { type OrgGrant, createOrgGrant, listOrgGrants, revokeOrgGrant } from '../../lib/api'
import { useConfirmDialog } from '../ConfirmDialog'
import { useToast } from '../Toast'
import { Button } from '../ui'
import { RetryBanner } from './RetryBanner'

const GRANT_ERROR_MESSAGES: Record<string, string> = {
  grantee_not_found: 'No org found with that slug. Check the grantee’s exact org name.',
  self_grant: 'You can’t grant access to your own org.',
  plugin_public: 'This plugin is public — everyone can already install it, so no grant is needed.',
  grantee_reserved: 'That org name is reserved and can’t receive grants.',
  plugin_not_found: 'This plugin no longer exists in the registry.',
}

function grantErrorMessage(err: unknown): string {
  const code = (err as { code?: string }).code
  return (code && GRANT_ERROR_MESSAGES[code]) || 'Could not create the grant. Please try again.'
}

export function ShareAccessPanel({ entryName, orgScope }: { entryName: string; orgScope: string }) {
  const pluginName = entryName.startsWith('@') ? entryName : `@${orgScope}/${entryName}`
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()
  const [grants, setGrants] = useState<OrgGrant[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [granteeOrg, setGranteeOrg] = useState('')
  const [submitting, setSubmitting] = useState(false)
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

  async function handleGrant(e: React.FormEvent) {
    e.preventDefault()
    const slug = granteeOrg.trim()
    if (!slug || submitting) return
    setSubmitting(true)
    setFormError('')
    try {
      await createOrgGrant({ pluginName, granteeOrg: slug })
      showToast(`Shared ${pluginName} with @${slug}.`, { tone: 'success' })
      setGranteeOrg('')
      await load()
    } catch (err) {
      setFormError(grantErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRevoke(grant: OrgGrant) {
    const ok = await confirm({
      title: 'Revoke access',
      message: `Revoke @${grant.granteeOrg}’s access to ${grant.pluginName}? They will no longer be able to install it.`,
      confirmLabel: 'Revoke',
      tone: 'danger',
    })
    if (!ok) return
    try {
      await revokeOrgGrant(grant.id)
      showToast(`Revoked @${grant.granteeOrg}.`, { tone: 'success' })
    } catch (err) {
      const status = (err as { status?: number }).status
      showToast(status === 404 ? 'Grant was already revoked.' : 'Could not revoke the grant.', {
        tone: status === 404 ? 'info' : 'error',
      })
    }
    await load()
  }

  return (
    <div className="cu-card__body">
      <form className="cu-form-inline" onSubmit={handleGrant}>
        <div className="cu-field">
          <label htmlFor={`grantee-${pluginName}`}>Grantee org slug</label>
          <input
            id={`grantee-${pluginName}`}
            className="cu-input"
            value={granteeOrg}
            onChange={e => setGranteeOrg(e.target.value.trim())}
            placeholder="acme-labs"
            autoComplete="off"
          />
          <span className="cu-field__hint">
            Grants pull &amp; install of every version of <code>{pluginName}</code> to that org.
          </span>
        </div>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={submitting || !granteeOrg.trim()}
        >
          {submitting ? 'Granting…' : 'Grant access'}
        </Button>
      </form>
      {formError ? (
        <p className="cu-field__error" role="alert">
          {formError}
        </p>
      ) : null}

      {loading ? (
        <p>Loading grants…</p>
      ) : loadError ? (
        <RetryBanner message="Could not load grants." onRetry={() => void load()} />
      ) : grants.length === 0 ? (
        <p className="cu-muted-note--compact">Not shared with any org yet.</p>
      ) : (
        <ul className="cu-grant-list">
          {grants.map(g => (
            <li key={g.id} className="cu-grant-list__row">
              <span>
                <code>@{g.granteeOrg}</code>
              </span>
              <Button type="button" variant="danger" size="sm" onClick={() => void handleRevoke(g)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      {confirmDialog}
    </div>
  )
}
