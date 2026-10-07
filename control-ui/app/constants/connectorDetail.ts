export const CONNECTOR_DETAIL_DEFAULT_TAB = 'configuration'

export const CONNECTOR_DETAIL_TABS = ['configuration', 'runtime'] as const

export type ConnectorDetailTab = (typeof CONNECTOR_DETAIL_TABS)[number]

export const CONNECTOR_DETAIL_TAB_LABELS: Record<ConnectorDetailTab, string> = {
  configuration: 'Configuration',
  runtime: 'Runtime status',
}
