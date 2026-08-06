import { Suspense } from 'react'
import { IdentityProviderCallbackClient } from './IdentityProviderCallbackClient'

export default function IdentityProviderCallbackPage() {
  return (
    <Suspense fallback={null}>
      <IdentityProviderCallbackClient />
    </Suspense>
  )
}
