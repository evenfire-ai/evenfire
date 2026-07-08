'use client'

import React, { useEffect, useState } from 'react'
import {
  type WorkflowApprovalMediumAccount,
  getAdminUserWorkflowApprovalMediums,
  preferAdminUserWorkflowApprovalMedium,
  revokeAdminUserWorkflowApprovalMedium,
} from '../lib/workflowApprovalMediums'
import { useConfirmDialog } from './ConfirmDialog'
import { useToast } from './Toast'
import { UserApprovalMediumsTable } from './UserApprovalMediumsTable'
import { IconRefresh } from './icons'

type Props = {
  userId: string
  legacySlackHandles: string[]
  legacyTelegramIds: string[]
}

export function UserApprovalMediumsPanel({ userId, legacySlackHandles, legacyTelegramIds }: Props) {
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()
  const [items, setItems] = useState<WorkflowApprovalMediumAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    setLoading(true)
    setError('')
    try {
      const media = await getAdminUserWorkflowApprovalMediums(userId)
      setItems(media.items ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load approval DM bindings')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [userId])

  async function prefer(accountId: string) {
    setBusy(true)
    setError('')
    try {
      await preferAdminUserWorkflowApprovalMedium(userId, accountId)
      await load()
      showToast('Preferred approval DM updated.', { tone: 'success' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update preferred approval DM')
    } finally {
      setBusy(false)
    }
  }

  async function revoke(accountId: string) {
    const account = items.find(item => item.id === accountId)
    const shouldRevoke = await confirm({
      title: 'Revoke Approval DM',
      message: `Revoke ${account?.medium || 'this'} approval DM${account?.providerUserId ? ` for ${account.providerUserId}` : ''}?`,
      confirmLabel: 'Revoke',
      tone: 'danger',
    })
    if (!shouldRevoke) return

    setBusy(true)
    setError('')
    try {
      await revokeAdminUserWorkflowApprovalMedium(userId, accountId)
      await load()
      showToast('Approval DM revoked.', { tone: 'success' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to revoke approval DM')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="cu-form-stack">
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '0.5rem',
        }}
      >
        <div>
          <p className="cu-section-title" style={{ marginBottom: '0.25rem' }}>
            Verified approval DMs
          </p>
          <p className="cu-muted" style={{ fontSize: '0.875rem', margin: 0 }}>
            Telegram and Slack bindings are verified by the user through the approval reader.
          </p>
        </div>
        <button
          type="button"
          className="cu-btn cu-btn--icon cu-btn--ghost"
          onClick={() => void load()}
          disabled={loading || busy}
          aria-label="Reload approval DMs"
          title="Reload"
        >
          <IconRefresh width={16} height={16} />
        </button>
      </div>

      {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}

      {(legacySlackHandles.length > 0 || legacyTelegramIds.length > 0) && (
        <div className="cu-banner cu-banner--warning">
          Legacy profile Slack handles and Telegram IDs are contact metadata only. Approval DM
          verification now requires the channel-scoped approval setup for each provider.
        </div>
      )}

      <UserApprovalMediumsTable
        items={items}
        loading={loading}
        busy={busy}
        onPrefer={accountId => void prefer(accountId)}
        onRevoke={accountId => void revoke(accountId)}
      />
      {confirmDialog}
    </div>
  )
}
