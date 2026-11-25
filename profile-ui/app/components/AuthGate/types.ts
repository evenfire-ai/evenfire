import type { ReactNode } from 'react'
import type { OidcReturnTo } from '@constants/oidc'

export type AuthGateProps = {
  children: ReactNode
  /** Passed to the sign-in panel so an OIDC sign-in comes back to this page. */
  returnTo?: OidcReturnTo
}
