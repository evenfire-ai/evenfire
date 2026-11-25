import type { OidcReturnTo } from '@constants/oidc'

export type LoginPanelProps = {
  description?: string
  /** The page to come back to after an OIDC sign-in, sent with the OIDC start form. */
  returnTo?: OidcReturnTo
}
