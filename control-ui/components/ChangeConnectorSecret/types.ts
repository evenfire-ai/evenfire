import type { AttachConnectorCredentialsProps } from '@components/AttachConnectorCredentials/types'
import type { EnvSecret } from '@lib/api'

export type ChangeConnectorSecretProps = Omit<
  AttachConnectorCredentialsProps,
  'registryCredentialSource'
> & {
  reference: EnvSecret
  onCancel: () => void
}
