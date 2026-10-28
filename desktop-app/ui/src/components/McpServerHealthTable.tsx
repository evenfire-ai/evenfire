import type { HTMLAttributes } from 'react'
import { useMemo, useState } from 'react'
import { ReloadOutlined } from '@ant-design/icons'
import { Button as AntButton, Collapse, Empty, Flex, Table, Tag, Typography } from 'antd'
import type { TableColumnsType } from 'antd'
import { formatMcpServerDisplayName } from '@lib/format'
import {
  type McpServerUiLabel,
  type MergedMcpServerRow,
  mergeAgentHealth,
} from '../../../src/mcpServerHealth'
import type { AgentWithMcpServers, HostRuntimeStatus } from '../../../src/types'
import type { ConnectorActionInput } from '../hooks/domain/useConnectorsController'
import type {
  McpServerConnectorAction,
  McpServerHealthTableProps,
} from './McpServerHealthTable.types'

const LABEL_TEXT: Record<McpServerUiLabel, string> = {
  running: 'Running',
  degraded: 'Degraded',
  failed: 'Failed',
  starting: 'Starting',
  disabled: 'Disabled',
  unknown: 'Unknown',
  stale: 'Stale',
}

const REASON_HINT: Record<string, string> = {
  auth_failed: 'Check the API key used when this server was installed.',
  upstream_4xx: 'Upstream rejected the request.',
  upstream_5xx: 'Upstream server error.',
  network: 'Could not reach the upstream host.',
  handshake: 'MCP protocol error after connect.',
  timeout: 'Upstream did not respond in time.',
  not_ready: 'Deployment not ready yet; retrying.',
  unknown: '',
}

const ATTENTION_LABELS: ReadonlySet<McpServerUiLabel> = new Set(['failed', 'degraded', 'stale'])

function statusColor(label: McpServerUiLabel): string | undefined {
  if (label === 'running') return 'green'
  if (label === 'failed') return 'red'
  if (label === 'degraded' || label === 'stale') return 'orange'
  if (label === 'starting') return 'blue'
  return undefined
}

function McpHealthRows({
  rows,
  showActions,
  connectorActions,
  onAuthorize,
  onDisconnect,
}: {
  rows: MergedMcpServerRow[]
  showActions: boolean
  connectorActions?: Map<string, McpServerConnectorAction>
  onAuthorize?: (input: ConnectorActionInput) => void
  onDisconnect?: (input: ConnectorActionInput) => void
}) {
  const columns: TableColumnsType<MergedMcpServerRow> = [
    {
      title: 'MCP Server Name',
      key: 'name',
      render: (_value, row) => {
        const hint = row.reason ? (REASON_HINT[row.reason] ?? '') : row.message || ''
        return (
          <Flex align="center" gap="small" wrap>
            <Typography.Text strong title={hint || undefined}>
              {formatMcpServerDisplayName(row.name)}
            </Typography.Text>
            {ATTENTION_LABELS.has(row.label) ? <Tag color="orange">Needs attention</Tag> : null}
          </Flex>
        )
      },
    },
    {
      title: 'Status',
      key: 'status',
      align: showActions ? undefined : 'right',
      render: (_value, row) => <Tag color={statusColor(row.label)}>{LABEL_TEXT[row.label]}</Tag>,
    },
  ]

  if (showActions) {
    columns.push({
      title: 'Actions',
      key: 'actions',
      align: 'right',
      render: (_value, row) => {
        const action = connectorActions?.get(row.name)
        if (!action) return null
        const disconnecting = action.authorized
        return (
          <AntButton
            htmlType="button"
            type={disconnecting ? 'text' : 'primary'}
            danger={disconnecting}
            disabled={action.busy}
            loading={action.busy}
            onClick={event => {
              event.stopPropagation()
              if (disconnecting) onDisconnect?.(action.actionInput)
              else onAuthorize?.(action.actionInput)
            }}
            onKeyDown={event => event.stopPropagation()}
            size="small"
          >
            {disconnecting ? 'Disconnect' : 'Authorize'}
          </AntButton>
        )
      },
    })
  }

  return (
    <Table<MergedMcpServerRow>
      columns={columns}
      dataSource={rows}
      rowKey="name"
      size="small"
      pagination={false}
      onRow={row =>
        ({
          'data-testid': `mcp-health-row-${row.name}`,
          'data-label': row.label,
          'data-reason': row.reason ?? '',
        }) as unknown as HTMLAttributes<HTMLTableRowElement>
      }
    />
  )
}

export function McpServerHealthTable({
  hostRef,
  mcpServerNames,
  status,
  now,
  onRefresh,
  refreshing,
  defaultExpanded = false,
  alwaysExpanded = false,
  connectorActions,
  onAuthorize,
  onDisconnect,
}: McpServerHealthTableProps) {
  const showActions = connectorActions !== undefined
  const [expanded, setExpanded] = useState(defaultExpanded)
  const isExpanded = alwaysExpanded || expanded

  const table = useMemo(() => {
    const agent: AgentWithMcpServers = {
      name: hostRef,
      contextRef: null,
      mcpServers: mcpServerNames.map(name => ({ name })),
    }
    return mergeAgentHealth(agent, status, now ?? Date.now())
  }, [hostRef, mcpServerNames, status, now])

  const summary = useMemo(() => {
    let attention = 0
    for (const row of table.rows) {
      if (ATTENTION_LABELS.has(row.label)) attention += 1
    }
    return { total: table.rows.length, attention }
  }, [table.rows])

  const refreshButton = onRefresh ? (
    <AntButton
      htmlType="button"
      type="text"
      size="small"
      icon={<ReloadOutlined aria-hidden="true" />}
      onClick={event => {
        // Refresh remains independent from the Collapse header toggle.
        event.stopPropagation()
        void onRefresh()
      }}
      disabled={refreshing}
      loading={refreshing}
      aria-label="Refresh connector status"
      title="Refresh connector status"
      data-testid="mcp-health-refresh"
    />
  ) : null

  if (table.rows.length === 0) {
    return (
      <Flex vertical gap="small" data-testid="mcp-health-empty">
        {!alwaysExpanded ? (
          <Flex align="center" justify="space-between">
            <Typography.Title level={5}>Connectors</Typography.Title>
            {refreshButton}
          </Flex>
        ) : null}
        <Empty description="No connectors configured for this agent." />
      </Flex>
    )
  }

  const rows = (
    <div id="mcp-health-rows">
      <McpHealthRows
        rows={table.rows}
        showActions={showActions}
        connectorActions={connectorActions}
        onAuthorize={onAuthorize}
        onDisconnect={onDisconnect}
      />
    </div>
  )

  return (
    <div
      data-testid="mcp-health-table"
      data-expanded={isExpanded ? 'true' : 'false'}
      aria-label={`Connector health for ${hostRef}`}
    >
      {alwaysExpanded ? (
        rows
      ) : (
        <Collapse
          size="small"
          destroyOnHidden
          activeKey={isExpanded ? ['connectors'] : []}
          onChange={keys => setExpanded(keys.length > 0)}
          items={[
            {
              key: 'connectors',
              label: (
                <Flex align="center" gap="small" wrap>
                  <span
                    data-testid="mcp-health-toggle"
                    aria-expanded={isExpanded}
                    aria-controls="mcp-health-rows"
                  >
                    Connectors
                  </span>
                  <Flex align="center" gap="small" data-testid="mcp-health-summary">
                    <Typography.Text>
                      {summary.total} server{summary.total === 1 ? '' : 's'}
                    </Typography.Text>
                    {summary.attention > 0 ? (
                      <Tag color="orange" data-testid="mcp-health-summary-attention">
                        {summary.attention} need{summary.attention === 1 ? 's' : ''} attention
                      </Tag>
                    ) : null}
                  </Flex>
                  {table.unknownFallback ? (
                    <Typography.Text type="secondary" data-testid="mcp-health-unknown-fallback">
                      Awaiting live status
                    </Typography.Text>
                  ) : null}
                </Flex>
              ),
              extra: refreshButton,
              children: isExpanded ? rows : null,
            },
          ]}
        />
      )}
    </div>
  )
}
