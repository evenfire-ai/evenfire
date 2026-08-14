import type { RegistryEntry } from '@lib/api'

export type RegistryInstallFormProps = {
  entry: RegistryEntry
  onCancel: () => void
  onInstalled: () => void
  onViewConnectors?: () => void
}
