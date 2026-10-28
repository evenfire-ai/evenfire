import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, Empty, Flex, Listy, Tag, Typography } from 'antd'
import type { WorkflowRunArtifact } from '../../../src/types'

type WorkflowRunArtifactActionsProps = {
  workflow: {
    namespace: string
    name: string
    label: string
    runId: string
    requestedAt?: number
  }
}

type RunArtifacts = {
  runId: string
  artifacts: WorkflowRunArtifact[]
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function WorkflowRunArtifactActions({ workflow }: WorkflowRunArtifactActionsProps) {
  const [runArtifacts, setRunArtifacts] = useState<RunArtifacts | null>(null)
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const loadArtifacts = useCallback(async () => {
    setLoading(true)
    setMessage(null)
    try {
      const result = await window.clerum.workflows.listRunArtifacts(
        workflow.namespace,
        workflow.name,
        workflow.runId
      )
      setRunArtifacts({ runId: workflow.runId, artifacts: result.artifacts || [] })
    } catch (error) {
      setRunArtifacts(null)
      setMessage(`Could not load workflow artifacts: ${getErrorMessage(error)}`)
    } finally {
      setLoading(false)
    }
  }, [workflow.name, workflow.namespace, workflow.runId])

  useEffect(() => {
    void loadArtifacts()
  }, [loadArtifacts])

  async function downloadArtifact(artifact: WorkflowRunArtifact) {
    if (!runArtifacts) return
    setDownloading(artifact.name)
    setMessage(null)
    try {
      const result = await window.clerum.workflows.downloadRunArtifact(
        workflow.namespace,
        workflow.name,
        runArtifacts.runId,
        artifact.name
      )
      setMessage(`Saved ${result.filename} to Downloads.`)
    } catch (error) {
      setMessage(`Could not download ${artifact.name}: ${getErrorMessage(error)}`)
    } finally {
      setDownloading(null)
    }
  }

  return (
    <Card
      size="small"
      aria-label={`${workflow.label} artifacts`}
      data-testid="workflow-chat-artifacts"
    >
      <Flex align="center" justify="space-between" gap="small" wrap>
        <Typography.Text strong>Workflow results</Typography.Text>
        {runArtifacts ? <Tag data-testid="workflow-chat-run-id">Results ready</Tag> : null}
        <Button type="text" onClick={() => void loadArtifacts()} disabled={loading}>
          {loading ? 'Checking...' : 'Refresh'}
        </Button>
      </Flex>
      {runArtifacts?.artifacts.length ? (
        <Listy
          items={runArtifacts.artifacts}
          rowKey="name"
          virtual={false}
          itemRender={artifact => (
            <Flex align="center" justify="space-between">
              <Typography.Text>{artifact.name}</Typography.Text>
              <Button
                data-testid="workflow-chat-artifact-download"
                loading={downloading === artifact.name}
                onClick={() => void downloadArtifact(artifact)}
              >
                {downloading === artifact.name ? 'Downloading...' : `Download ${artifact.name}`}
              </Button>
            </Flex>
          )}
        />
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            loading ? 'Checking workflow results...' : 'No downloadable workflow results yet.'
          }
        />
      )}
      {message ? (
        <Alert type={message.startsWith('Saved ') ? 'success' : 'error'} title={message} />
      ) : null}
    </Card>
  )
}
