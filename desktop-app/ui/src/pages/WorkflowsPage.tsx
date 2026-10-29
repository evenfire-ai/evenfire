import { useCallback, useState } from 'react'
import {
  Alert,
  Button as AntButton,
  Card,
  Empty,
  Flex,
  Modal,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { TableColumnsType } from 'antd'
import { IconWorkflows } from '@components/SidebarNav/icons'
import type { WorkflowRunArtifact, WorkflowRunListItem } from '../../../src/types'
import { InputContractForm } from '../components/InputContractForm'
import { useAuthContext } from '../contexts/AuthContext'
import { useWorkflowController, useWorkflowRecentRuns } from '../hooks/domain/useWorkflowController'
import { formatRelativeTime } from '../lib/format'
import { workflowStatusPillTone } from '../lib/workflowStatus'
import type { WorkflowSummary } from '../workflows.types'

function workflowKey(wf: WorkflowSummary): string {
  return `${wf.namespace}/${wf.name}`
}

function hasContractInputs(
  contract: { properties?: Record<string, unknown> } | null | undefined
): boolean {
  return Boolean(contract && Object.keys(contract.properties ?? {}).length > 0)
}

function workflowStatusColor(status: string | null | undefined): string | undefined {
  const tone = workflowStatusPillTone(status)
  if (tone === 'success') return 'green'
  if (tone === 'danger') return 'red'
  return undefined
}

/** Compact latest-run summary; query and artifact behavior stay with the existing hook. */
function RecentRunsCell({ wf }: { wf: WorkflowSummary }) {
  const { setStatus } = useAuthContext()
  const recent = useWorkflowRecentRuns(wf)
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null)

  const handleDownload = useCallback(
    async (run: WorkflowRunListItem, artifact: WorkflowRunArtifact) => {
      const key = `${run.id}:${artifact.name}`
      setDownloadingKey(key)
      try {
        const result = await window.clerum.workflows.downloadRunArtifact(
          wf.namespace,
          wf.name,
          run.id,
          artifact.name
        )
        setStatus(`Saved ${result.filename || artifact.name} to Downloads.`, 'success', undefined, {
          global: false,
          toast: true,
        })
      } catch (error) {
        setStatus(
          `Download failed: ${error instanceof Error ? error.message : String(error)}`,
          'error'
        )
      } finally {
        setDownloadingKey(null)
      }
    },
    [setStatus, wf.name, wf.namespace]
  )

  if (recent.loading) return <Spin size="small" aria-label="Loading recent runs" />
  const run = recent.latestRun
  if (!run) {
    return (
      <Typography.Text type="secondary">
        {recent.error ? 'Failed to load runs' : 'No runs yet'}
      </Typography.Text>
    )
  }

  const when = run.startedAt ?? run.triggeredAt
  return (
    <Flex vertical gap="small">
      <Flex align="center" gap="small" wrap>
        <Tag color={workflowStatusColor(run.phase)}>{run.phase}</Tag>
        <Typography.Text type="secondary">
          {when ? formatRelativeTime(when) : 'Pending'}
        </Typography.Text>
        {recent.runCount > 1 ? (
          <Typography.Text type="secondary">· {recent.runCount} runs</Typography.Text>
        ) : null}
      </Flex>
      {run.artifacts && run.artifacts.length > 0 ? (
        <Flex wrap gap="small" aria-label="Latest run artifacts">
          {run.artifacts.map(artifact => {
            const key = `${run.id}:${artifact.name}`
            return (
              <AntButton
                key={artifact.name}
                htmlType="button"
                disabled={downloadingKey === key}
                onClick={() => void handleDownload(run, artifact)}
                size="small"
                type="link"
              >
                {downloadingKey === key ? 'Downloading…' : artifact.name}
              </AntButton>
            )
          })}
        </Flex>
      ) : null}
    </Flex>
  )
}

function WorkflowActionsCell({
  wf,
  pendingTriggerKey,
  triggerModalOpen,
  onTrigger,
}: {
  wf: WorkflowSummary
  pendingTriggerKey: string | null
  triggerModalOpen: boolean
  onTrigger: () => void
}) {
  const recent = useWorkflowRecentRuns(wf)
  const rowKey = workflowKey(wf)
  const isTriggering = pendingTriggerKey === rowKey
  const anotherPending = pendingTriggerKey !== null && !isTriggering

  return (
    <Flex gap="small" wrap>
      <AntButton
        htmlType="button"
        type="primary"
        disabled={!wf.triggerableByUser || anotherPending || triggerModalOpen}
        loading={isTriggering}
        onClick={onTrigger}
        size="small"
        title={
          wf.triggerableByUser
            ? 'Trigger recipe'
            : 'This recipe does not declare an on-demand user trigger'
        }
      >
        Trigger
      </AntButton>
      <AntButton
        htmlType="button"
        type="text"
        loading={recent.refreshing}
        onClick={() => void recent.refresh()}
        size="small"
      >
        Refresh
      </AntButton>
    </Flex>
  )
}

export function WorkflowsPage() {
  const { setStatus } = useAuthContext()
  const {
    workflowsLoading: loading,
    workflows,
    selectedWorkflowInputContract,
    workflowInputValues,
    setWorkflowInputValues,
    workflowTriggerLoading,
    workflowsError: error,
    handleSelectWorkflow,
    handleTriggerWorkflow,
  } = useWorkflowController({ setStatus })

  // Which workflow's Trigger modal is open (a recipe with an input contract).
  // This state remains page-owned; Ant Design only renders the dialog.
  const [triggerModalWorkflow, setTriggerModalWorkflow] = useState<WorkflowSummary | null>(null)
  const [pendingTriggerKey, setPendingTriggerKey] = useState<string | null>(null)

  const handleTrigger = useCallback(
    async (wf: WorkflowSummary) => {
      if (!wf.triggerableByUser) return
      setPendingTriggerKey(workflowKey(wf))
      let contract: Awaited<ReturnType<typeof handleSelectWorkflow>>
      try {
        // Read the recipe detail so the modal binds to the controller's input state.
        contract = await handleSelectWorkflow(wf)
      } catch (error) {
        // A failed read must not look like a contract-less recipe and trigger without inputs.
        setPendingTriggerKey(null)
        setStatus(
          `Trigger failed: ${error instanceof Error ? error.message : String(error)}`,
          'error'
        )
        return
      }
      if (hasContractInputs(contract)) {
        setPendingTriggerKey(null)
        setTriggerModalWorkflow(wf)
        return
      }
      try {
        await handleTriggerWorkflow(wf.namespace, wf.name, {})
      } finally {
        setPendingTriggerKey(null)
      }
    },
    [handleSelectWorkflow, handleTriggerWorkflow, setStatus]
  )

  const confirmModalTrigger = useCallback(() => {
    const wf = triggerModalWorkflow
    setTriggerModalWorkflow(null)
    if (!wf) return
    // The controller reads the current edited input values from its existing owner.
    setPendingTriggerKey(workflowKey(wf))
    void handleTriggerWorkflow(wf.namespace, wf.name).finally(() => setPendingTriggerKey(null))
  }, [triggerModalWorkflow, handleTriggerWorkflow])

  const columns: TableColumnsType<WorkflowSummary> = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (_value, wf) => (
        <Flex align="center" gap="small">
          <IconWorkflows aria-hidden="true" />
          <Typography.Text strong>{wf.name}</Typography.Text>
        </Flex>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (_value, wf) => (
        <Tag color={workflowStatusColor(wf.status)}>{wf.status || 'Unknown'}</Tag>
      ),
    },
    {
      title: 'Recent Runs',
      key: 'recent-runs',
      render: (_value, wf) => <RecentRunsCell wf={wf} />,
    },
    {
      title: 'Actions',
      key: 'actions',
      align: 'right',
      render: (_value, wf) => (
        <WorkflowActionsCell
          wf={wf}
          pendingTriggerKey={pendingTriggerKey}
          triggerModalOpen={triggerModalWorkflow !== null}
          onTrigger={() => void handleTrigger(wf)}
        />
      ),
    },
  ]

  const hasRows = workflows.length > 0

  return (
    <section className="page">
      <header>
        <Typography.Title level={2}>Plugins</Typography.Title>
        <Typography.Paragraph type="secondary">
          View deployed recipes, see their recent runs, and trigger them.
        </Typography.Paragraph>
      </header>

      <div className="page-layout">
        {error ? <Alert type="error" showIcon role="alert" title={error} /> : null}
        <Card aria-label="Plugins">
          {loading && !hasRows ? (
            <Spin tip="Fetching plugins…" />
          ) : !hasRows ? (
            <Empty description="No recipes are deployed in this cluster." />
          ) : (
            <Table<WorkflowSummary>
              columns={columns}
              dataSource={workflows}
              rowKey={workflowKey}
              size="small"
              pagination={false}
              className="mcp-servers-data-table"
            />
          )}
        </Card>
      </div>

      {triggerModalWorkflow && selectedWorkflowInputContract ? (
        <Modal
          title={<Typography.Title level={4}>Trigger {triggerModalWorkflow.name}</Typography.Title>}
          open
          okText={workflowTriggerLoading ? 'Triggering…' : 'Trigger'}
          cancelText="Cancel"
          confirmLoading={workflowTriggerLoading}
          onCancel={() => setTriggerModalWorkflow(null)}
          onOk={confirmModalTrigger}
        >
          <InputContractForm
            schema={selectedWorkflowInputContract}
            values={workflowInputValues}
            onChange={setWorkflowInputValues}
            disabled={workflowTriggerLoading}
          />
        </Modal>
      ) : null}
    </section>
  )
}
