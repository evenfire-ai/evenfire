// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorkflowRunArtifactActions } from '../WorkflowRunArtifactActions'

function installWorkflowHarness() {
  const runs = vi.fn(async () => ({
    items: [
      {
        id: 'old-run',
        phase: 'Succeeded',
        triggeredAt: '2026-05-25T23:50:00Z',
        startedAt: '2026-05-25T23:50:01Z',
        completedAt: '2026-05-25T23:50:05Z',
        message: null,
        actor: null,
        executionRef: null,
        source: 'live',
      },
      {
        id: 'run-1',
        phase: 'Succeeded',
        triggeredAt: '2026-05-26T00:00:00Z',
        startedAt: '2026-05-26T00:00:01Z',
        completedAt: '2026-05-26T00:00:05Z',
        message: null,
        actor: null,
        executionRef: null,
        source: 'live',
      },
    ],
    count: 1,
  }))
  const listRunArtifacts = vi.fn(async (_namespace: string, _name: string, runId: string) => ({
    artifacts:
      runId === 'run-1'
        ? [
            {
              name: 'due-diligence-result.json',
              format: 'json',
              sizeBytes: 1200,
              createdAt: '2026-05-26T00:00:05Z',
            },
          ]
        : [
            {
              name: 'stale-result.json',
              format: 'json',
              sizeBytes: 500,
              createdAt: '2026-05-25T23:50:05Z',
            },
          ],
  }))
  const downloadRunArtifact = vi.fn(async () => ({
    saved: true,
    filePath: '/Users/test/Downloads/due-diligence-result.json',
    filename: 'due-diligence-result.json',
  }))
  const rpcDownloadArtifact = vi.fn()

  Object.defineProperty(window, 'clerum', {
    configurable: true,
    writable: true,
    value: {
      workflows: {
        runs,
        listRunArtifacts,
        downloadRunArtifact,
      },
      rpc: {
        downloadArtifact: rpcDownloadArtifact,
      },
    },
  })

  return { runs, listRunArtifacts, downloadRunArtifact, rpcDownloadArtifact }
}

describe('WorkflowRunArtifactActions', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    delete (window as { clerum?: unknown }).clerum
  })

  it('loads artifacts for the chat-created run id and downloads through workflow API', async () => {
    const harness = installWorkflowHarness()
    render(
      <WorkflowRunArtifactActions
        workflow={{
          namespace: 'sandbox-recipes',
          name: 'due-diligence',
          label: 'Due Diligence',
          runId: 'run-1',
        }}
      />
    )

    expect((await screen.findByTestId('workflow-chat-run-id')).textContent).toContain(
      'Results ready'
    )
    const download = await screen.findByRole('button', {
      name: 'Download due-diligence-result.json',
    })
    fireEvent.click(download)

    await waitFor(() =>
      expect(harness.downloadRunArtifact).toHaveBeenCalledWith(
        'sandbox-recipes',
        'due-diligence',
        'run-1',
        'due-diligence-result.json'
      )
    )
    expect(await screen.findByText('Saved due-diligence-result.json to Downloads.')).toBeTruthy()
    expect(harness.runs).not.toHaveBeenCalled()
    expect(harness.rpcDownloadArtifact).not.toHaveBeenCalled()
  })

  it('uses the chat-created run id when workflow_trigger returned it', async () => {
    const harness = installWorkflowHarness()
    render(
      <WorkflowRunArtifactActions
        workflow={{
          namespace: 'sandbox-recipes',
          name: 'due-diligence',
          label: 'Due Diligence',
          runId: 'run-1',
        }}
      />
    )

    expect((await screen.findByTestId('workflow-chat-run-id')).textContent).toContain(
      'Results ready'
    )
    expect(harness.runs).not.toHaveBeenCalled()
    expect(harness.listRunArtifacts).toHaveBeenCalledWith(
      'sandbox-recipes',
      'due-diligence',
      'run-1'
    )
  })
})
