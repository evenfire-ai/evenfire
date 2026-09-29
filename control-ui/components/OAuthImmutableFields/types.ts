import type { OAuthImmutableFields as OAuthImmutableValues } from '@lib/oauthInstall'

export type OAuthImmutableFieldsProps = {
  oauth: OAuthImmutableValues
  // Name of the Secret holding the OAuth client credential. When provided the
  // panel names it in the credential-rotation notice; null falls back to a
  // generic phrasing.
  credentialSecretName?: string | null
}
