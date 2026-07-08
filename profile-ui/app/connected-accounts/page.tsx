'use client'

import { useEffect, useState } from 'react'
import { AuthGate } from '@components/AuthGate'
import { Button } from '@components/Button'
import { ProfileShell } from '@components/ProfileShell'
import { useToast } from '@components/Toast'
import { isSilentApiError } from '@lib/api'
import {
  listConnectedAccounts,
  revokeConnectedAccount,
  type ConnectedAccount,
} from '@lib/connectedAccounts'

type LoadState = 'loading' | 'ready' | 'error'

function ConnectedAccountsContent() {
  const { showToast } = useToast()
  const [state, setState] = useState<LoadState>('loading')
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  async function load() {
    setState('loading')
    try {
      setAccounts(await listConnectedAccounts())
      setState('ready')
    } catch (err) {
      if (!isSilentApiError(err)) setState('error')
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function revoke(a: ConnectedAccount) {
    const key = `${a.recipeName}/${a.oauthClientId}`
    setBusy(key)
    try {
      await revokeConnectedAccount(a)
      showToast('Access revoked.', { tone: 'success' })
      await load()
    } catch (err) {
      if (!isSilentApiError(err)) showToast('Could not revoke access.', { tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <ProfileShell currentRoute="connectedAccounts">
      <div className="profile-page">
        <header className="header-row">
          <div>
            <h1 className="page-title">Connected Accounts</h1>
            <div className="small-plus muted">
              Third-party accounts you have connected to plugins. Revoke any time.
            </div>
          </div>
        </header>

        {state === 'loading' && <div className="message message--plain">Loading...</div>}
        {state === 'error' && (
          <div className="message message--error">Could not load connected accounts.</div>
        )}

        {state === 'ready' && (
          <section className="section">
            <h2 className="section-title">Connected accounts</h2>
            <p className="small muted">
              Apps you have connected a third-party account to. Background access lets the app act
              on your behalf even when you are not using it; revoke any time.
            </p>
            {accounts.length === 0 ? (
              <div className="muted">No connected accounts.</div>
            ) : (
              <div className="stack">
                {accounts.map(a => {
                  const key = `${a.recipeName}/${a.oauthClientId}`
                  return (
                    <div key={key} className="member-row">
                      <div className="member-summary">
                        <div>
                          <div>
                            <strong>{a.recipeName}</strong>
                          </div>
                          <div className="small muted">
                            {a.provider}
                            {a.background ? ' · background access' : ''}
                          </div>
                        </div>
                        <Button
                          variant="danger"
                          disabled={busy === key}
                          onClick={() => void revoke(a)}
                        >
                          {busy === key ? 'Revoking…' : 'Revoke'}
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        )}
      </div>
    </ProfileShell>
  )
}

export default function ConnectedAccountsPage() {
  return (
    <AuthGate>
      <ConnectedAccountsContent />
    </AuthGate>
  )
}
