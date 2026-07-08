'use client'

import { Suspense, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Button } from '@components/Button'
import { FormField } from '@components/FormField'
import { TextInput } from '@components/TextInput'
import { createDesktopAuthorization } from '@lib/api'

function DesktopSetupContent() {
  const searchParams = useSearchParams()
  const email = useMemo(
    () =>
      String(searchParams.get('email') || '')
        .trim()
        .toLowerCase(),
    [searchParams]
  )
  const [password, setPassword] = useState('')
  const [authorizationToken, setAuthorizationToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('Enter your password to authorize this desktop app setup.')

  async function handleAuthorize() {
    setBusy(true)
    setError('')
    try {
      const result = await createDesktopAuthorization(password)
      setAuthorizationToken(result.authorizationToken)
      setStatus('Authorization token created. Continue setup in the desktop app.')
      const deepLink = `evenfire://desktop-setup?email=${encodeURIComponent(email)}&authorizationToken=${encodeURIComponent(result.authorizationToken)}`
      window.location.href = deepLink
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : 'Failed to authorize desktop setup.'
      )
    } finally {
      setBusy(false)
    }
  }

  async function copyToken() {
    if (!authorizationToken) return
    await navigator.clipboard.writeText(authorizationToken)
    setStatus('Authorization token copied.')
  }

  return (
    <main className="center-page">
      <section className="page-card">
        <div className="stack-tight">
          <p className="eyebrow">Evenfire Desktop</p>
          <h1 className="page-title page-title--large">Set up desktop app</h1>
          <p className="body-copy">{status}</p>
        </div>

        {email ? (
          <div className="invite-card">
            <strong>Email</strong>
            <div className="body-copy">{email}</div>
          </div>
        ) : null}

        {error ? <div className="message message--error">{error}</div> : null}

        {!authorizationToken ? (
          <div className="stack">
            <FormField label="Password">
              <TextInput
                type="password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                placeholder="Your password"
              />
            </FormField>
            <Button onClick={handleAuthorize} disabled={busy || !email || !password}>
              Authorize desktop setup
            </Button>
          </div>
        ) : (
          <div className="stack">
            <div className="token-card token-box">{authorizationToken}</div>
            <Button onClick={copyToken}>Copy authorization token</Button>
          </div>
        )}
      </section>
    </main>
  )
}

export default function DesktopSetupPage() {
  return (
    <Suspense
      fallback={
        <main className="center-page">
          <section className="page-card">
            <h1 className="page-title page-title--large">Set up desktop app</h1>
            <p className="body-copy">Loading...</p>
          </section>
        </main>
      }
    >
      <DesktopSetupContent />
    </Suspense>
  )
}
