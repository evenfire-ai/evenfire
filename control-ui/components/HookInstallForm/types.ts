import type { RegistryEntry } from '@lib/api'

export type HookInstallFormProps = {
  entry: RegistryEntry
  onCancel: () => void
  // Called with the created LlmHook CR name after a successful install.
  onInstalled: (hookName: string) => void
}
