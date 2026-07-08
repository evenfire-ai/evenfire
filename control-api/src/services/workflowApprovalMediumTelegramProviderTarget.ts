export type TelegramProviderTarget = {
  hostRef: string
  communicationChannelNamespace: string
  communicationChannelName: string
  providerBotId?: string | null
  providerBotUsername?: string | null
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const normalized = String(value).trim()
  return normalized ? normalized : null
}

export function normalizeProviderTarget(value: unknown): TelegramProviderTarget | null {
  const target = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const hostRef = optionalString(target.hostRef)
  const communicationChannelNamespace = optionalString(target.communicationChannelNamespace)
  const communicationChannelName = optionalString(target.communicationChannelName)
  if (!hostRef || !communicationChannelNamespace || !communicationChannelName) return null
  if (
    hostRef.length > 256 ||
    communicationChannelNamespace.length > 256 ||
    communicationChannelName.length > 256
  ) {
    return null
  }
  return {
    hostRef,
    communicationChannelNamespace,
    communicationChannelName,
    providerBotId: optionalString(target.providerBotId),
    providerBotUsername: optionalString(target.providerBotUsername),
  }
}

function providerTargetKey(target: TelegramProviderTarget): string {
  return [
    target.hostRef,
    target.communicationChannelNamespace,
    target.communicationChannelName,
    target.providerBotId ?? '',
    target.providerBotUsername ?? '',
  ].join('\0')
}

export function dedupeProviderTargets(targets: TelegramProviderTarget[]): TelegramProviderTarget[] {
  const seen = new Set<string>()
  const deduped: TelegramProviderTarget[] = []
  for (const target of targets) {
    const key = providerTargetKey(target)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(target)
  }
  return deduped
}

export function normalizeProviderTargets(value: unknown): TelegramProviderTarget[] {
  if (!Array.isArray(value)) return []
  if (value.length > 20) {
    console.warn(
      `[WorkflowApprovalMedium] Telegram providerTargets capped at 20 entries; received ${value.length}`
    )
  }
  const targets: TelegramProviderTarget[] = []
  for (const candidate of value.slice(0, 20)) {
    const target = normalizeProviderTarget(candidate)
    if (!target) continue
    targets.push(target)
  }
  return dedupeProviderTargets(targets)
}
