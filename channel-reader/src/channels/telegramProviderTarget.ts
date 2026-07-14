import type { ProviderTargetIdentity } from '../types'

export function withTelegramBotIdentity(
  target: ProviderTargetIdentity,
  botId: number | null,
  botUsernameLower: string
): ProviderTargetIdentity {
  return {
    ...target,
    ...(botId != null ? { providerBotId: String(botId) } : {}),
    ...(botUsernameLower ? { providerBotUsername: botUsernameLower } : {}),
  }
}
