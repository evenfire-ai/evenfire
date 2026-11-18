'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { PROFILE_ROUTES } from '@constants/routes'

// The root URL is the signed-out login landing and the /?inviteToken= entry
// (handled by ProfileAppFrame before this page mounts). Signed-in users land
// on the Social channels section.
function RootLandingRedirect() {
  const router = useRouter()

  useEffect(() => {
    router.replace(PROFILE_ROUTES.channels.root)
  }, [router])

  return null
}

export default function Page() {
  return (
    <AuthGate>
      <RootLandingRedirect />
    </AuthGate>
  )
}
