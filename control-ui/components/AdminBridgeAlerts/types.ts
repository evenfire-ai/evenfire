import type { ControlAdminBridgeStatus } from '@lib/api'

export type AdminBridgeAlertKind = 'email' | 'member'

export type AdminBridgeAlertState = {
  kind: AdminBridgeAlertKind
  status: ControlAdminBridgeStatus
}
