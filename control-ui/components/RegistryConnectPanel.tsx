'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  type RegistryRecoveryError,
  disconnectRegistryConnection,
  getRegistryConnection,
  recoverRegistryConnection,
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
  | {
      kind: 'connecting'
      deploymentId?: string
      requestedOrgName?: string
      authEnabled?: boolean
      recoveryError?: RegistryRecoveryError
    }
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

  // GET returns one of six states (registryConnect.ts): disconnected | pending |
  // connecting | approved | rejected | connected. The reducer maps each to
  // exactly one View. `connecting` means the registry auto-approved the request
  // and the inline claim did not land yet — it is finished by pressing "Finish
  // connecting" (handleRecover), never by pasting a token; under auto-approval no
  // operator ever issues one. `approved` keeps its original meaning: an operator
  // approved and a human must paste the token they were given out of band —
  // A1's claim token only becomes redeemable once the registry poll flips
  // pending → approved.
  const load = useCallback(async () => {
    try {
      const s = await getRegistryConnection()
      if (s.state === 'connected')
        setView({ kind: 'connected', org: s.org, authEnabled: s.authEnabled })
      else if (s.state === 'connecting')
        setView({
          kind: 'connecting',
          deploymentId: s.deploymentId,
          requestedOrgName: s.requestedOrgName,
          authEnabled: s.authEnabled,
          recoveryError: s.recoveryError,
        })
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
      else if (s.state === 'disconnected') setView({ kind: 'request' })
      else {
        // Exhaustiveness guard. The old default was `{kind:'request'}`, which
        // renders the registration FORM for any unrecognised state — and
        // re-registering deletes the deployment keypair. A new state must be a
        // compile error here, never a data-loss path.
        const never: never = s.state
        void never
        setView({ kind: 'error' })
      }
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
    // The registry requires a dot-TLD (isValidContactEmail). Failing that check
    // server-side costs one of ~5 daily registration attempts per IP, so spend
    // it only on an address that can succeed.
    if (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@.]{2,}$/.test(email.trim())) {
      setFormError('Enter a full contact email such as ops@example.com.')
      return
    }
    setBusy(true)
    try {
      const s = await requestRegistryConnection({
        requestedOrgName: orgName.trim(),
        contactEmail: email.trim(),
      })
      // The request endpoint can now settle three ways: the registry auto-claims
      // the deployment inline (connected), auto-approves but the inline claim did
      // not land (connecting — finished via handleRecover), or an operator must
      // approve it by hand (pending, the original claim-token flow).
      if (s.state === 'connected') {
        setView({ kind: 'connected', org: s.org, authEnabled: s.authEnabled })
        showToast(`Connected to @${s.org}.`, { tone: 'success' })
      } else if (s.state === 'connecting') {
        setView({
          kind: 'connecting',
          deploymentId: s.deploymentId,
          requestedOrgName: s.requestedOrgName,
          authEnabled: s.authEnabled,
        })
        showToast('Registered — finishing the connection.', { tone: 'success' })
      } else {
        setView({
          kind: 'pending',
          deploymentId: s.deploymentId,
          requestedOrgName: s.requestedOrgName,
        })
        showToast('Registration requested — an Evenfire operator must approve it.', {
          tone: 'success',
        })
      }
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === 'already_connected') await load()
      else if (code === 'recovery_in_progress') await load()
      else if (code === 'org_blocklisted')
        setFormError('That organization name is not available. Try a different one.')
      else if (code === 'org_name_taken')
        setFormError(
          'That organization name is already taken. Try a different one. Registration attempts are limited to about 5 per day, so choose carefully.'
        )
      else if (code === 'registration_capacity')
        setFormError('The registry is not accepting new registrations right now. Try again later.')
      else if (code === 'rate_limited')
        setFormError('Too many registration attempts from this network. Try again later.')
      else if (code === 'invalid_contact_email')
        setFormError(
          'That contact email is not a valid address. Use a full address such as ops@example.com.'
        )
      else if (code === 'jti_replayed')
        setFormError('That registration attempt could not be completed. Try again.')
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
      else if (code === 'connection_superseded')
        // Terminal, not retryable: the registry already burned this one-time
        // token and the credentials it returned could not be saved here.
        setFormError(
          'This deployment can no longer authenticate: its one-time credentials were issued but never stored. Disconnect, then register again with a different organization name.'
        )
      else if (code === 'not_pending')
        await load() // server state moved on — re-sync
      else setFormError('Could not complete the claim. Try again shortly.')
    } finally {
      setBusy(false)
    }
  }

  // Finish an auto-approved connection whose inline claim failed. Explicit
  // user action: recovery rotates a claim token at the registry, so it must
  // never fire from a passive render.
  async function handleRecover() {
    setFormError(null)
    setBusy(true)
    try {
      const s = await recoverRegistryConnection()
      if (s.state === 'connected') {
        setView({ kind: 'connected', org: s.org, authEnabled: s.authEnabled })
        showToast(`Connected to @${s.org}.`, { tone: 'success' })
      } else {
        await load()
        setFormError('Still finishing the connection. Try again in a moment.')
      }
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === 'already_claimed' || code === 'connection_superseded')
        setFormError(
          'This deployment can no longer authenticate: its one-time credentials were issued but never stored. Disconnect, then register again with a different organization name.'
        )
      else if (code === 'deployment_suspended')
        setFormError('This deployment has been suspended by Evenfire. Contact support.')
      else if (code === 'client_unavailable')
        setFormError('This deployment can no longer authenticate. Contact support.')
      else if (code === 'not_recoverable') await load()
      else setFormError('Could not finish connecting. Try again shortly.')
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

  // From the `connecting` view: with re-registration blocked server-side by
  // recovery_in_progress, this DELETE is now the ONLY remaining path that can
  // destroy a recoverable deployment — it deletes the keypair and permanently
  // squats the org name at the registry. Route it through the same confirm
  // dialog as handleDisconnect instead of a bare button.
  async function handleStartOverFromConnecting() {
    const ok = await confirm({
      title: 'Start over',
      message:
        'Starting over deletes this deployment’s stored registry credentials. The organization name will be lost permanently and this deployment cannot be recovered afterwards — you would need to register again under a different name. This cannot be undone.',
      confirmLabel: 'Start over',
      tone: 'danger',
    })
    if (!ok) return
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

          {view.kind === 'connecting' ? (
            <div className="cu-form-stack">
              <p className="cu-banner">
                Registration approved
                {view.requestedOrgName ? ` for @${view.requestedOrgName}` : ''}. Finishing the
                connection — no operator approval is needed.
              </p>
              {view.recoveryError === 'already_claimed' ||
              view.recoveryError === 'connection_superseded' ? (
                <p className="cu-banner cu-banner--warn">
                  This deployment can no longer authenticate: its one-time credentials were issued
                  but never stored. Disconnect, then register again with a different organization
                  name.
                </p>
              ) : null}
              {view.recoveryError === 'deployment_suspended' ? (
                <p className="cu-banner cu-banner--warn">
                  This deployment has been suspended by Evenfire. Contact support.
                </p>
              ) : null}
              {formError ? <p className="cu-banner cu-banner--warn">{formError}</p> : null}
              <div className="cu-form-inline">
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void handleRecover()}
                >
                  {busy ? 'Finishing…' : 'Finish connecting'}
                </Button>
                {/* Gated by confirm(), not a bare Disconnect: with re-registration
                    blocked by recovery_in_progress, this is the only remaining path
                    that can delete a recoverable deployment's keypair and squat its
                    org name. */}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void handleStartOverFromConnecting()}
                >
                  Start over
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
