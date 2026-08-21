import type {
  CodexCatalogSyncView,
  CodexConnectionStatus,
  CodexDeviceStartView,
  CodexSubscriptionConnectionView,
} from '@lib/codexSubscription'

export type CodexSubscriptionUiStatus =
  | 'disconnected'
  | 'connecting'
  | 'device-pending'
  | 'connected'
  | 'reauth-required'
  | 'revoking'
  | 'unavailable'

export type CodexSubscriptionConnectionProps = {
  initialConnection?: CodexSubscriptionConnectionView | null
}

export type CodexSubscriptionViewState = {
  uiStatus: CodexSubscriptionUiStatus
  connection: CodexSubscriptionConnectionView | null
  device: CodexDeviceStartView | null
  sync: CodexCatalogSyncView | null
  failureClass: string | null
}

export function mapConnectionStatus(status: CodexConnectionStatus): CodexSubscriptionUiStatus {
  if (status === 'reauth_required') return 'reauth-required'
  if (status === 'connecting') return 'connecting'
  if (status === 'connected') return 'connected'
  if (status === 'revoked') return 'disconnected'
  return 'disconnected'
}

export function statusLabel(status: CodexSubscriptionUiStatus): string {
  switch (status) {
    case 'connected':
      return 'Connected'
    case 'connecting':
      return 'Connecting'
    case 'device-pending':
      return 'Device code pending'
    case 'reauth-required':
      return 'Reauthorization required'
    case 'revoking':
      return 'Revoking'
    case 'unavailable':
      return 'Unavailable'
    default:
      return 'Disconnected'
  }
}

export function statusTagClass(status: CodexSubscriptionUiStatus): string {
  switch (status) {
    case 'connected':
      return 'cu-llm-config__block-tag'
    case 'connecting':
    case 'device-pending':
      return 'cu-llm-config__block-tag cu-llm-config__block-tag--warning'
    case 'reauth-required':
    case 'unavailable':
      return 'cu-llm-config__block-tag cu-llm-config__block-tag--danger'
    default:
      return 'cu-llm-config__block-tag cu-llm-config__block-tag--muted'
  }
}
