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
