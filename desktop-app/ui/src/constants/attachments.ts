export const COMPOSER_MAX_IMAGE_ATTACHMENTS = 3
export const COMPOSER_MAX_IMAGE_BYTES = 3 * 1024 * 1024
export const COMPOSER_ACCEPT_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png'] as const

/** Keep in sync with `@clerum/llm-providers` `LLM_IMAGE_INPUT_UNSUPPORTED_IDS`. */
export const COMPOSER_IMAGE_UNSUPPORTED_PROVIDERS = [
  'zai',
  'codex-subscription',
  'grok-subscription',
] as const

const COMPOSER_IMAGE_UNSUPPORTED_LABELS: Record<
  (typeof COMPOSER_IMAGE_UNSUPPORTED_PROVIDERS)[number],
  string
> = {
  zai: 'Z.AI',
  'codex-subscription': 'OpenAI Codex Subscription',
  'grok-subscription': 'xAI Grok Subscription',
}

export function composerProviderSupportsImageInput(provider: string | null | undefined): boolean {
  if (!provider) return true
  return !(COMPOSER_IMAGE_UNSUPPORTED_PROVIDERS as readonly string[]).includes(provider)
}

export function composerImageUnsupportedMessage(provider: string | null | undefined): string {
  const label =
    provider && provider in COMPOSER_IMAGE_UNSUPPORTED_LABELS
      ? COMPOSER_IMAGE_UNSUPPORTED_LABELS[
          provider as (typeof COMPOSER_IMAGE_UNSUPPORTED_PROVIDERS)[number]
        ]
      : 'this provider'
  return `Image attachments are not supported for agents running on ${label} yet. Switch this agent to a provider with image input support before attaching images.`
}

/** @deprecated Use composerImageUnsupportedMessage(activeLlmProvider). */
export const ZAI_IMAGE_ATTACHMENT_UNSUPPORTED_MESSAGE = composerImageUnsupportedMessage('zai')
