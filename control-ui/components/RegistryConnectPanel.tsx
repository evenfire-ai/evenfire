'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  disconnectRegistryConnection,
  getRegistryConnection,
  requestRegistryConnection,
  submitRegistryClaim,
} from '../lib/api'
import { useConfirmDialog } from './ConfirmDialog'
import { TablePanelHeader } from './TablePanelHeader'
import { useToast } from './Toast'
import { Button, TextInput } from './ui'

type View =
  | { kind: 'loading' }
  | { kind: 'request' }
  | { kind: 'pending'; deploymentId?: string; requestedOrgName?: string }
  | { kind: 'approved'; deploymentId?: string; requestedOrgName?: string }
  | { kind: 'rejected'; requestedOrgName?: string }
  | { kind: 'connected'; org?: string; authEnabled?: boolean }
  | { kind: 'not-self-hosted' }
  | { kind: 'error' }

export default function RegistryConnectPanel() {
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()
  const [view, setView] = useState<View>({ kind: 'loading' })
  // request-form fields
  const [orgName, setOrgName] = useState('')
  const [email, setEmail] = useState('')
  // claim-entry field (used only in the `approved` view)
  const [claimToken, setClaimToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // GET returns one of five states (registryConnect.ts): disconnected | pending |
  // approved | rejected | connected. The reducer maps each to exactly one View —
  // `approved` (not `pending`) carries the claim-entry form, because A1's claim
  // token only becomes redeemable once the registry poll flips pending → approved.
  const load = useCallback(async () => {
    try {
      const s = await getRegistryConnection()
      if (s.state === 'connected')
        setView({ kind: 'connected', org: s.org, authEnabled: s.authEnabled })
      else if (s.state === 'approved')
        setView({
          kind: 'approved',
          deploymentId: s.deploymentId,
          requestedOrgName: s.requestedOrgName,
        })
      else if (s.state === 'rejected')
        setView({ kind: 'rejected', requestedOrgName: s.requestedOrgName })
      else if (s.state === 'pending')
        setView({
          kind: 'pending',
          deploymentId: s.deploymentId,
          requestedOrgName: s.requestedOrgName,
        })
      else setView({ kind: 'request' }) // disconnected
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === 'not_self_hosted') setView({ kind: 'not-self-hosted' })
      else setView({ kind: 'error' })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function handleRequest() {
    setFormError(null)
    if (!orgName.trim() || !email.trim()) {
      setFormError('Organization name and contact email are required.')
      return
    }
    setBusy(true)
    try {
      const s = await requestRegistryConnection({
        requestedOrgName: orgName.trim(),
        contactEmail: email.trim(),
      })
      // A fresh request always lands pending — the operator must approve it before
      // the claim token is usable, so we go to the waiting view (not claim-entry).
      setView({
        kind: 'pending',
        deploymentId: s.deploymentId,
        requestedOrgName: s.requestedOrgName,
      })
      showToast('Registration requested — an Evenfire operator must approve it.', {
        tone: 'success',
      })
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === 'already_connected') await load()
      else if (code === 'org_blocklisted')
        setFormError('That organization name is not available. Try a different one.')
      else setFormError('Could not request registration. Try again shortly.')
    } finally {
      setBusy(false)
    }
  }

  // Redeem the one-time claim token — only reachable from the `approved` view.
  async function handleClaim() {
    setFormError(null)
    if (!claimToken.trim()) {
      setFormError('Paste the claim token from your Evenfire operator.')
      return
    }
    setBusy(true)
    try {
      const { org } = await submitRegistryClaim({ claimToken: claimToken.trim() })
      setClaimToken('')
      setView({ kind: 'connected', org })
      showToast(`Connected to @${org}.`, { tone: 'success' })
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === 'claim_expired')
        setFormError('That claim token has expired. Ask your operator to re-issue it.')
      else if (code === 'claim_rejected')
        setFormError('That claim token was rejected. Check it and try again.')
      else if (code === 'not_pending')
        await load() // server state moved on — re-sync
      else setFormError('Could not complete the claim. Try again shortly.')
    } finally {
      setBusy(false)
    }
  }

  // From the terminal `rejected` view: drop the dead request row (DELETE) so the
  // operator can submit a fresh one. Best-effort — land on the request form either way.
  async function handleStartOver() {
    setBusy(true)
    try {
      await disconnectRegistryConnection()
    } catch {
      /* best-effort — the next GET reports disconnected once the row is gone */
    } finally {
      setBusy(false)
    }
    setClaimToken('')
    setFormError(null)
    setView({ kind: 'request' })
  }

  async function handleDisconnect() {
    const ok = await confirm({
      title: 'Disconnect from the Evenfire Registry',
      message:
        'This deletes this deployment’s stored registry credentials. It will stop publishing and pulling private images until you connect again. This cannot be undone.',
      confirmLabel: 'Disconnect',
      tone: 'danger',
    })
    if (!ok) return
    try {
      await disconnectRegistryConnection()
      showToast('Disconnected from the Evenfire Registry.', { tone: 'success' })
    } catch {
      showToast('Could not disconnect.', { tone: 'error' })
    }
    setView({ kind: 'request' })
  }

  return (
    <section>
      <div className="cu-card cu-card--viewport-fill">
        <TablePanelHeader
          title="Connect to Evenfire Registry"
          actions={
            view.kind === 'connected' ? (
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={() => void handleDisconnect()}
              >
                Disconnect
              </Button>
            ) : null
          }
        />

        <div className="cu-card__body">
          {view.kind === 'loading' ? <p>Loading…</p> : null}

          {view.kind === 'not-self-hosted' ? (
            <p className="cu-banner">
              This deployment is managed by Evenfire and is connected to the registry automatically
              — there is nothing to configure here.
            </p>
          ) : null}

          {view.kind === 'error' ? (
            <p className="cu-banner cu-banner--warn">
              Could not load the connection status.{' '}
              <Button type="button" variant="ghost" size="sm" onClick={() => void load()}>
                Retry
              </Button>
            </p>
          ) : null}

          {view.kind === 'request' ? (
            <div className="cu-form-stack">
              <p>
                Register this Evenfire deployment with the Evenfire Registry to publish MCP entries
                and push/pull images. After you request, an Evenfire operator approves it and gives
                you a one-time claim token to finish connecting.
              </p>
              {formError ? <p className="cu-banner cu-banner--warn">{formError}</p> : null}
              <div className="cu-field">
                <label htmlFor="rc-org-name">Organization name</label>
                <TextInput
                  id="rc-org-name"
                  value={orgName}
                  onChange={e => setOrgName(e.target.value)}
                  placeholder="acme"
                />
              </div>
              <div className="cu-field">
                <label htmlFor="rc-contact-email">Contact email</label>
                <TextInput
                  id="rc-contact-email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="ops@acme.io"
                />
              </div>
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() => void handleRequest()}
              >
                {busy ? 'Requesting…' : 'Request registration'}
              </Button>
            </div>
          ) : null}

          {view.kind === 'pending' ? (
            <div className="cu-form-stack">
              <p className="cu-banner">
                Registration requested
                {view.requestedOrgName ? ` for @${view.requestedOrgName}` : ''}. Waiting for an
                Evenfire operator to approve it. Once approved, you’ll receive a one-time claim
                token to finish connecting — check back here after your operator confirms.
              </p>
              <div className="cu-form-inline">
                <Button type="button" variant="ghost" size="sm" onClick={() => void load()}>
                  Refresh status
                </Button>
              </div>
            </div>
          ) : null}

          {view.kind === 'approved' ? (
            <div className="cu-form-stack">
              <p className="cu-banner cu-banner--ok">
                Request approved{view.requestedOrgName ? ` for @${view.requestedOrgName}` : ''}.
                Paste the one-time claim token your Evenfire operator gave you to finish connecting.
              </p>
              {formError ? <p className="cu-banner cu-banner--warn">{formError}</p> : null}
              <div className="cu-field">
                <label htmlFor="rc-claim-token">Claim token</label>
                <TextInput
                  id="rc-claim-token"
                  value={claimToken}
                  onChange={e => setClaimToken(e.target.value)}
                  placeholder="paste claim token"
                />
              </div>
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() => void handleClaim()}
              >
                {busy ? 'Connecting…' : 'Complete connection'}
              </Button>
            </div>
          ) : null}

          {view.kind === 'rejected' ? (
            <div className="cu-form-stack">
              <p className="cu-banner cu-banner--warn">
                Request rejected{view.requestedOrgName ? ` for @${view.requestedOrgName}` : ''}.
                Your registration request was not approved. You can start over with a new request.
              </p>
              <div className="cu-form-inline">
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void handleStartOver()}
                >
                  {busy ? 'Starting over…' : 'Start over'}
                </Button>
              </div>
            </div>
          ) : null}

          {view.kind === 'connected' ? (
            <p className="cu-banner cu-banner--ok">
              Connected to the Evenfire Registry{view.org ? ` as @${view.org}` : ''}. This
              deployment can now publish entries and push/pull images.
            </p>
          ) : null}

          {view.kind === 'connected' && view.authEnabled === false ? (
            <p className="cu-banner cu-banner--info" role="status">
              To create and manage API keys for programmatic publishing, enable registry
              authentication: set <code>CLERUM_REGISTRY_AUTH_ENABLED=true</code> and restart
              control-api. See the &quot;connect to registry&quot; guide for details.
            </p>
          ) : null}
        </div>
      </div>
      {confirmDialog}
    </section>
  )
}
