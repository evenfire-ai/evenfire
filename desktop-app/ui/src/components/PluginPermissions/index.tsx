import { useCallback, useState } from 'react'
import { Alert, Button, Card, Empty, Flex, Spin, Table, Tabs, Tag, Typography } from 'antd'
import { usePluginPermissionsController } from '@hooks/domain/usePluginPermissionsController'

type PluginPermissionsController = ReturnType<typeof usePluginPermissionsController>

function formatTimestamp(value: string | null): string {
  if (!value) return 'Never'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return 'Unknown'
  return parsed.toLocaleString()
}

function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case 'allowed':
      return 'Shared'
    case 'granted':
      return 'Granted'
    case 'denied':
      return 'Denied'
    case 'revoked':
      return 'Revoked'
    case 'revoked_mid_flight':
      return 'Revoked mid-request'
    case 'rate_limited':
      return 'Rate limited'
    default:
      return 'Error'
  }
}

function PluginActivity({ controller }: { controller: PluginPermissionsController }) {
  const activityItems = controller.activity.map((entry, index) => ({
    key: `${entry.ts}-${entry.capability}-${index}`,
    when: formatTimestamp(entry.ts),
    plugin: entry.pluginId.split('/').pop(),
    requested: entry.capability,
    result: outcomeLabel(entry.outcome),
  }))

  if (controller.activity.length === 0) {
    return (
      <Empty description="No plugin activity recorded yet." image={Empty.PRESENTED_IMAGE_SIMPLE}>
        <Typography.Text type="secondary">
          Requests a plugin makes will be listed here.
        </Typography.Text>
      </Empty>
    )
  }

  return (
    <Flex vertical gap="small">
      <Table
        columns={[
          { title: 'When', dataIndex: 'when', key: 'when' },
          { title: 'Plugin', dataIndex: 'plugin', key: 'plugin' },
          { title: 'Requested', dataIndex: 'requested', key: 'requested' },
          {
            title: 'Result',
            dataIndex: 'result',
            key: 'result',
            render: result => <Tag>{result}</Tag>,
          },
        ]}
        dataSource={activityItems}
        pagination={false}
        rowKey="key"
        size="small"
      />
      <Flex justify="flex-end">
        <Button
          disabled={controller.clearingActivity || controller.revoking}
          htmlType="button"
          onClick={() => controller.clearActivity().catch(() => undefined)}
        >
          Clear activity log
        </Button>
      </Flex>
    </Flex>
  )
}

/**
 * Settings → Plugin permissions (spec §11).
 *
 * The controller remains the owner of IPC-backed grants, activity, and
 * mutations. This component only renders those values and dispatches actions.
 */
export function PluginPermissions() {
  const controller = usePluginPermissionsController()
  const [view, setView] = useState<'grants' | 'activity'>('grants')
  const [expanded, setExpanded] = useState<string | null>(null)
  const onTabChange = useCallback((key: string) => setView(key as 'grants' | 'activity'), [])
  const pluginItems = controller.groups.map(group => ({
    key: group.pluginId,
    plugin: group.pluginTitle,
    permissions: group.capabilities.map(grant => grant.title).join(' · '),
    lastUsed: formatTimestamp(group.lastUsedAt),
    actions: group,
  }))
  const errorAlert = controller.error ? (
    <Alert showIcon type="error" title={controller.error} />
  ) : null
  const grantsContent = controller.loading ? (
    <Spin description="Loading permissions…">
      <Typography.Text>Reading what each plugin is allowed to see.</Typography.Text>
    </Spin>
  ) : controller.groups.length === 0 ? (
    <Empty
      description="No plugin has been granted access to your information."
      image={Empty.PRESENTED_IMAGE_SIMPLE}
    >
      <Typography.Text type="secondary">
        When a plugin asks for something, you will see a prompt naming exactly what it wants.
      </Typography.Text>
    </Empty>
  ) : (
    <section aria-label="Plugin grants">
      <Table
        columns={[
          {
            title: 'Plugin',
            dataIndex: 'plugin',
            key: 'plugin',
            render: (_value, item) => (
              <Button
                aria-expanded={expanded === item.actions.pluginId}
                htmlType="button"
                onClick={() =>
                  setExpanded(current =>
                    current === item.actions.pluginId ? null : item.actions.pluginId
                  )
                }
                type="link"
                aria-controls={
                  expanded === item.actions.pluginId
                    ? `plugin-capabilities-${encodeURIComponent(item.actions.pluginId)}`
                    : undefined
                }
              >
                {item.plugin}
              </Button>
            ),
          },
          { title: 'Permissions', dataIndex: 'permissions', key: 'permissions' },
          { title: 'Last used', dataIndex: 'lastUsed', key: 'lastUsed' },
          {
            title: 'Actions',
            key: 'actions',
            align: 'right',
            render: (_value, item) => (
              <Button
                danger
                disabled={controller.revoking || controller.clearingActivity}
                htmlType="button"
                onClick={() => controller.revoke(item.actions.pluginId).catch(() => undefined)}
              >
                Revoke all
              </Button>
            ),
          },
        ]}
        dataSource={pluginItems}
        expandable={{
          expandedRowKeys: expanded ? [expanded] : [],
          expandedRowRender: item => (
            <Flex
              vertical
              gap="middle"
              id={`plugin-capabilities-${encodeURIComponent(item.actions.pluginId)}`}
            >
              {item.actions.capabilities.map(grant => (
                <Flex vertical gap="small" key={`${grant.pluginId}:${grant.capability}`}>
                  <Typography.Text strong>{grant.title}</Typography.Text>
                  <Typography.Paragraph>{grant.dataDescription}</Typography.Paragraph>
                  <Typography.Text type="secondary">
                    Granted {formatTimestamp(grant.grantedAt)}
                  </Typography.Text>
                  <Button
                    danger
                    disabled={controller.revoking || controller.clearingActivity}
                    htmlType="button"
                    onClick={() =>
                      controller.revoke(grant.pluginId, grant.capability).catch(() => undefined)
                    }
                  >
                    Revoke
                  </Button>
                </Flex>
              ))}
            </Flex>
          ),
          showExpandColumn: false,
        }}
        pagination={false}
        rowKey="key"
        size="small"
      />
    </section>
  )
  return (
    <Card
      title={
        <Flex vertical gap="small">
          <Typography.Title id="settings-plugin-permissions" level={3}>
            Plugin permissions
          </Typography.Title>
          <Typography.Text type="secondary">
            Plugins can only see what you have explicitly allowed. Revoking takes effect
            immediately, even while a plugin is open.
          </Typography.Text>
        </Flex>
      }
    >
      <Tabs
        aria-label="Plugin permission views"
        activeKey={view}
        destroyOnHidden
        items={[
          {
            key: 'grants',
            label: 'Permissions',
            children: (
              <Flex vertical gap="middle">
                {errorAlert}
                {grantsContent}
              </Flex>
            ),
          },
          {
            key: 'activity',
            label: 'Activity',
            children: (
              <Flex vertical gap="middle">
                {errorAlert}
                <PluginActivity controller={controller} />
              </Flex>
            ),
          },
        ]}
        onChange={onTabChange}
      />
    </Card>
  )
}
