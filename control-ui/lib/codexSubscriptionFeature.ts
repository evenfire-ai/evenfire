import { getCodexSubscriptionConnection } from './codexSubscription'

export type CodexSubscriptionCapability = {
  enabled: boolean
}

const DISABLED_CAPABILITY: CodexSubscriptionCapability = { enabled: false }

function isDisabledCapabilityError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const status = (error as { status?: unknown }).status
  const code = (error as { code?: unknown }).code
  return status === 404 || code === 'disabled'
}

/**
 * Control UI default is off. Capability is proven only by a successful
 * Control API connection read — never by a browser-manipulable env var.
 */
export async function loadCodexSubscriptionCapability(): Promise<CodexSubscriptionCapability> {
  try {
    await getCodexSubscriptionConnection()
    return { enabled: true }
  } catch (error) {
    if (isDisabledCapabilityError(error)) return DISABLED_CAPABILITY
    return DISABLED_CAPABILITY
  }
}

export function isCodexSubscriptionUiEnabled(
  capability: CodexSubscriptionCapability | null | undefined
): boolean {
  return capability?.enabled === true
}
