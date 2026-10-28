import { useMemo } from 'react'
import { ApiOutlined } from '@ant-design/icons'
import { Alert, Button as AntButton, Card, Empty, Flex, Spin, Table, Tag, Typography } from 'antd'
import type { TableColumnsType } from 'antd'
import {
  authenticationLabel,
  connectorScopeLabel,
  scopeCaption,
  statusPresentation,
} from '@lib/connectorPresentation'
import { type ConnectorRow, deriveConnectorRows } from '@lib/connectorRows'
import { formatMcpServerDisplayName } from '@lib/format'
import { useNavigationContext } from '../contexts/NavigationContext'
import { useAgentsDataController } from '../hooks/domain/useAgentsDataController'
import {
  type ConnectorActionInput,
  isActionableConnector,
  useConnectorsController,
} from '../hooks/domain/useConnectorsController'
import { clickableRowProps } from '../lib/clickableRowProps'

export function McpServersPage() {
  const { loading, error, actionError, agents, pendingKey, authorize, disconnect } =
    useConnectorsController()
  const { agentDisplayByName } = useAgentsDataController()
  const { handleOpenAgentWorkspace } = useNavigationContext()

  const rows = useMemo(() => deriveConnectorRows(agents), [agents])
  const columns: TableColumnsType<ConnectorRow> = [
    {
      title: 'Connector',
      key: 'connector',
      render: (_value, row) => (
        <Flex align="center" gap="small">
          <ApiOutlined aria-hidden="true" />
          <Typography.Text strong>{formatMcpServerDisplayName(row.connector.name)}</Typography.Text>
          {row.connector.provider ? (
            <Typography.Text type="secondary">· {row.connector.provider}</Typography.Text>
          ) : null}
        </Flex>
      ),
    },
    {
      title: 'Agent',
      key: 'agent',
      render: (_value, row) => {
        const displayName = agentDisplayByName[row.agentName] ?? row.agentName
        return <Tag aria-label={`Agent ${displayName}`}>{displayName}</Tag>
      },
    },
    {
      title: 'Scope',
      key: 'scope',
      render: (_value, row) => (
        <Tag title={scopeCaption(row.connector) ?? undefined}>
          {connectorScopeLabel(row.connector)}
        </Tag>
      ),
    },
    {
      title: 'Authentication',
      key: 'authentication',
      render: (_value, row) => {
        const authentication = authenticationLabel(row.connector)
        return authentication ? <Tag>{authentication}</Tag> : null
      },
    },
    {
      title: 'Status',
      key: 'status',
      render: (_value, row) => {
        const presentation = statusPresentation(row.connector.status)
        const color =
          presentation.tone === 'success'
            ? 'green'
            : presentation.tone === 'warning'
              ? 'orange'
              : undefined
        return <Tag color={color}>{presentation.label}</Tag>
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      align: 'right',
      render: (_value, row) => {
        if (!isActionableConnector(row.connector)) return null
        const busy = pendingKey === row.grantKey
        const actionInput: ConnectorActionInput = {
          agentName: row.agentName,
          contextRef: row.contextRef,
          connector: row.connector,
        }
        const authorized = row.connector.status === 'authorized'
        return (
          <AntButton
            htmlType="button"
            type={authorized ? 'text' : 'primary'}
            danger={authorized}
            disabled={busy}
            loading={busy}
            onClick={event => {
              // Keep row navigation separate from connector grant actions.
              event.stopPropagation()
              if (authorized) void disconnect(actionInput)
              else void authorize(actionInput)
            }}
            onKeyDown={event => event.stopPropagation()}
            size="small"
          >
            {authorized ? 'Disconnect' : 'Authorize'}
          </AntButton>
        )
      },
    },
  ]
  const hasRows = rows.length > 0

  return (
    <section className="page">
      <header>
        <Typography.Title level={2}>Connectors</Typography.Title>
        <Typography.Paragraph type="secondary">
          Review the connectors available across your agents, authorize the ones that require setup,
          and disconnect the ones you no longer want.
        </Typography.Paragraph>
      </header>

      <div className="page-layout">
        {(actionError ?? error) ? (
          <Alert type="error" showIcon role="alert" title={actionError ?? error} />
        ) : null}
        <Card aria-label="Connectors">
          {loading && !hasRows ? (
            <Spin tip="Fetching your connectors…" />
          ) : !hasRows ? (
            <Empty description="No agents with connectors are available for your account yet." />
          ) : (
            <Table<ConnectorRow>
              data-testid="mcp-servers-table"
              columns={columns}
              dataSource={rows}
              rowKey="renderKey"
              size="small"
              pagination={false}
              onRow={row => ({
                ...clickableRowProps(() => handleOpenAgentWorkspace(row.agentName, 'mcp-servers'), {
                  ariaLabel: `Open connectors for agent ${row.agentName}`,
                }),
              })}
            />
          )}
        </Card>
      </div>
    </section>
  )
}
