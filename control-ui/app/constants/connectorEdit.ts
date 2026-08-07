export const CONNECTOR_EDIT_DEFAULT_TAB = 'egress'

export const CONNECTOR_EDIT_TABS = ['egress', 'credentials'] as const

export type ConnectorEditTab = (typeof CONNECTOR_EDIT_TABS)[number]

export const CONNECTOR_EDIT_TAB_LABELS: Record<ConnectorEditTab, string> = {
  egress: 'External Egress',
  credentials: 'Credentials',
}
