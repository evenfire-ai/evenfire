'use client'

import { Suspense, useEffect, useMemo, useRef } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { Button } from '@components/Button'
import { buildEvenfireDesktopAppLink } from '@lib/desktopAppLinks'

function OpenDesktopAppContent() {
  const params = useParams<{ recipeNs: string; recipeName: string }>()
  const searchParams = useSearchParams()
  const attemptedOpenRef = useRef(false)
  const deepLink = useMemo(
    () =>
      buildEvenfireDesktopAppLink({
        recipeNs: params.recipeNs,
        recipeName: params.recipeName,
        path: searchParams.get('path') || '/',
        teamId: searchParams.get('team') || undefined,
      }),
    [params.recipeName, params.recipeNs, searchParams]
  )

  useEffect(() => {
    if (!deepLink || attemptedOpenRef.current) return
    attemptedOpenRef.current = true
    window.location.href = deepLink
  }, [deepLink])

  return (
    <main className="center-page">
      <section className="page-card">
        <div className="stack-tight">
          <p className="eyebrow">Evenfire Desktop</p>
          <h1 className="page-title page-title--large">Open {params.recipeName}</h1>
          <p className="body-copy">
            {deepLink
              ? 'Evenfire should open this app automatically. Use the button if your browser asks for confirmation.'
              : 'This app link is invalid or incomplete.'}
          </p>
        </div>

        <Button
          disabled={!deepLink}
          onClick={() => {
            if (deepLink) window.location.href = deepLink
          }}
        >
          Open in Evenfire
        </Button>

        {deepLink ? (
          <p className="body-copy">
            If nothing happens, make sure the Evenfire desktop app is installed and try again.
          </p>
        ) : null}
      </section>
    </main>
  )
}

export default function OpenDesktopAppPage() {
  return (
    <Suspense
      fallback={
        <main className="center-page">
          <section className="page-card">
            <h1 className="page-title page-title--large">Open in Evenfire</h1>
            <p className="body-copy">Preparing the desktop app link...</p>
          </section>
        </main>
      }
    >
      <OpenDesktopAppContent />
    </Suspense>
  )
}
