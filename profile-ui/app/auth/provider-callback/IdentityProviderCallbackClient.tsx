'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@components/AuthContext'

function safeNextPath(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/'
  return value
}

export function IdentityProviderCallbackClient() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { completeIdentityProviderLogin } = useAuth()
  const startedRef = useRef(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    const providerError = searchParams.get('error') || ''
    if (providerError) {
      setError(searchParams.get('errorMessage') || 'Microsoft sign-in could not be completed.')
      return
    }
    const code = searchParams.get('code') || ''
    if (!code) {
      setError('Microsoft did not return a login code.')
      return
    }
    void completeIdentityProviderLogin(code)
      .then(() => router.replace(safeNextPath(searchParams.get('next'))))
      .catch(nextError => {
        setError(nextError instanceof Error ? nextError.message : 'Microsoft login failed')
      })
  }, [completeIdentityProviderLogin, router, searchParams])

  return (
    <main className="center-page">
      <section className="page-card cu-provider-callback">
        <img src="/brand/microsoft.svg" alt="Microsoft" width={21} height={21} />
        <h1 className="page-title">Microsoft sign-in</h1>
        <p className="body-copy">{error || 'Completing sign-in...'}</p>
        {error ? (
          <button type="button" className="cu-btn" onClick={() => router.replace('/')}>
            Back to sign in
          </button>
        ) : null}
      </section>
    </main>
  )
}
