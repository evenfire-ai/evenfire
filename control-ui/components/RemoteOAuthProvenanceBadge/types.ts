import type { RemoteOAuthCatalogView } from '@lib/oauthInstall.types'

export type RemoteOAuthProvenanceBadgeProps = Pick<
  Extract<RemoteOAuthCatalogView, { valid: true }>,
  'trusted' | 'publisher' | 'block'
>
