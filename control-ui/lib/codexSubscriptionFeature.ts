import { loadSubscriptionCapabilities } from './subscriptionCapabilities'

export type CodexSubscriptionCapability = {
  enabled: boolean
  error?: string
}

export function isDisabledCapabilityError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const status = (error as { status?: unknown }).status
  const code = (error as { code?: unknown }).code
  return status === 404 || code === 'disabled'
}

export async function loadCodexSubscriptionCapability(): Promise<CodexSubscriptionCapability> {
  const capabilities = await loadSubscriptionCapabilities()
  return { enabled: capabilities.providers['codex-subscription'].enabled }
}

export function isCodexSubscriptionUiEnabled(
  capability: CodexSubscriptionCapability | null | undefined
): boolean {
  return capability?.enabled === true
}
