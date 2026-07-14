// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MessageArtifactActions } from '../MessageArtifactActions'

function setupWindowClerum(
  overrides?: Partial<{
    listArtifacts: typeof window.clerum.rpc.listArtifacts
    downloadArtifact: typeof window.clerum.rpc.downloadArtifact
  }>
) {
  const listArtifacts = overrides?.listArtifacts ?? vi.fn().mockResolvedValue({ artifacts: [] })
  const downloadArtifact =
    overrides?.downloadArtifact ?? vi.fn().mockResolvedValue(new TextEncoder().encode('<html/>'))

  Object.defineProperty(window, 'clerum', {
    value: {
      rpc: {
        listArtifacts,
        downloadArtifact,
      },
    },
    writable: true,
    configurable: true,
  })

  return { listArtifacts, downloadArtifact }
}

describe('MessageArtifactActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:artifact-test'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders nothing when content has no artifact filenames', () => {
    setupWindowClerum()
    const { container } = render(
      <MessageArtifactActions hostRef="chatllm" content="No files here." />
    )
    expect(container.innerHTML).toBe('')
  })

  it('renders Download button when content filename exists in artifact catalog', async () => {
    setupWindowClerum({
      listArtifacts: vi.fn().mockResolvedValue({
        artifacts: [
          {
            name: 'report.pdf',
            format: 'pdf',
            sizeBytes: 128000,
            createdAt: '2026-05-08T00:00:00.000Z',
          },
        ],
      }),
    })

    render(
      <MessageArtifactActions
        hostRef="chatllm"
        content="The report is ready: report.pdf. Download when convenient."
      />
    )

    await waitFor(() => {
      expect(screen.getByText('Generated files')).toBeTruthy()
      expect(screen.getByText('PDF')).toBeTruthy()
      expect(
        screen.getByText((_, node) =>
          Boolean(
            node?.classList.contains('message-artifact-meta') &&
            node.textContent?.replace(/\s+/g, ' ').trim() === 'PDF · 125 KB'
          )
        )
      ).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Download report.pdf' })).toBeTruthy()
    })
  })

  it('renders Preview button for confirmed HTML artifacts and opens inline preview', async () => {
    const downloadArtifact = vi
      .fn()
      .mockResolvedValue(new TextEncoder().encode('<html><body>Hello</body></html>'))
    setupWindowClerum({
      listArtifacts: vi.fn().mockResolvedValue({
        artifacts: [
          {
            name: 'output.html',
            format: 'html',
            sizeBytes: 2048,
            createdAt: '2026-05-08T00:00:00.000Z',
          },
        ],
      }),
      downloadArtifact,
    })

    render(<MessageArtifactActions hostRef="chatllm" content="Generated artifact: output.html" />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Preview output.html' })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Preview output.html' }))

    await waitFor(() => {
      expect(screen.getByText('Artifact preview: output.html')).toBeTruthy()
    })
    expect(downloadArtifact).toHaveBeenCalledWith('chatllm', 'output.html', ['chatllm'])
  })

  it('falls back to message filenames when listArtifacts fails', async () => {
    const { downloadArtifact } = setupWindowClerum({
      listArtifacts: vi.fn().mockRejectedValue(new Error('catalog unavailable')),
    })

    render(<MessageArtifactActions hostRef="chatllm" content="Possible artifact: report.pdf" />)

    await waitFor(() => {
      expect(screen.getByText('Generated files')).toBeTruthy()
      expect(screen.getByText(/Artifact catalog is unavailable right now\./)).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Download report.pdf' })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Download report.pdf' }))
    await waitFor(() => {
      expect(downloadArtifact).toHaveBeenCalledWith('chatllm', 'report.pdf', ['chatllm'])
    })
  })

  it('does not render actions for filenames missing from artifact catalog', async () => {
    setupWindowClerum({
      listArtifacts: vi.fn().mockResolvedValue({
        artifacts: [
          {
            name: 'report.pdf',
            format: 'pdf',
            sizeBytes: 1024,
            createdAt: '2026-05-08T00:00:00.000Z',
          },
        ],
      }),
    })

    render(
      <MessageArtifactActions hostRef="chatllm" content="Artifacts: report.pdf, missing.csv" />
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Download report.pdf' })).toBeTruthy()
    })
    expect(screen.queryByRole('button', { name: 'Download missing.csv' })).toBeNull()
  })

  it('downloads every listed artifact from the Download all action', async () => {
    const downloadArtifact = vi.fn().mockResolvedValue(new TextEncoder().encode('file'))
    setupWindowClerum({
      listArtifacts: vi.fn().mockResolvedValue({
        artifacts: [
          {
            name: 'report.pdf',
            format: 'pdf',
            sizeBytes: 1024,
            createdAt: '2026-05-08T00:00:00.000Z',
          },
          {
            name: 'report.md',
            format: 'md',
            sizeBytes: 2048,
            createdAt: '2026-05-08T00:00:00.000Z',
          },
        ],
      }),
      downloadArtifact,
    })

    render(
      <MessageArtifactActions
        hostRef="chatllm"
        content="Generated files: report.pdf and report.md"
      />
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Download all' })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Download all' }))

    await waitFor(() => {
      expect(downloadArtifact).toHaveBeenCalledWith('chatllm', 'report.pdf', ['chatllm'])
      expect(downloadArtifact).toHaveBeenCalledWith('chatllm', 'report.md', ['chatllm'])
    })
  })

  it('resolves pptx and png filenames through the existing mcp-host artifact catalog', async () => {
    const downloadArtifact = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer)
    setupWindowClerum({
      listArtifacts: vi.fn().mockResolvedValue({
        artifacts: [
          {
            name: 'deck.pptx',
            format: 'pptx',
            sizeBytes: 4096,
            createdAt: '2026-05-08T00:00:00.000Z',
          },
          {
            name: 'chart.png',
            format: 'png',
            sizeBytes: 2048,
            createdAt: '2026-05-08T00:00:00.000Z',
          },
        ],
      }),
      downloadArtifact,
    })

    render(
      <MessageArtifactActions hostRef="chatllm" content="Generated: deck.pptx and chart.png" />
    )

    await waitFor(() => {
      expect(screen.getByText('Generated files')).toBeTruthy()
      expect(
        screen.getByText((_, node) =>
          Boolean(
            node?.classList.contains('message-artifact-meta') &&
            node.textContent?.includes('Presentation')
          )
        )
      ).toBeTruthy()
      expect(
        screen.getByText((_, node) =>
          Boolean(
            node?.classList.contains('message-artifact-meta') &&
            node.textContent?.includes('PNG image')
          )
        )
      ).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Download deck.pptx' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Download chart.png' })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Download deck.pptx' }))
    fireEvent.click(screen.getByRole('button', { name: 'Download chart.png' }))

    await waitFor(() => {
      expect(downloadArtifact).toHaveBeenCalledWith('chatllm', 'deck.pptx', ['chatllm'])
      expect(downloadArtifact).toHaveBeenCalledWith('chatllm', 'chart.png', ['chatllm'])
    })
  })

  it('renders markdown preview for .md artifacts', async () => {
    const markdownContent = '# Title\n\n- one\n- two'
    setupWindowClerum({
      listArtifacts: vi.fn().mockResolvedValue({
        artifacts: [
          {
            name: 'report.md',
            format: 'md',
            sizeBytes: 128,
            createdAt: '2026-05-08T00:00:00.000Z',
          },
        ],
      }),
      downloadArtifact: vi.fn().mockResolvedValue(new TextEncoder().encode(markdownContent)),
    })

    render(<MessageArtifactActions hostRef="chatllm" content="Generated: report.md" />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Preview report.md' })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Preview report.md' }))
    await waitFor(() => {
      expect(screen.getByText('Title')).toBeTruthy()
      expect(screen.getByText('one')).toBeTruthy()
    })
  })

  it('does not offer inline preview for .pdf artifacts', async () => {
    setupWindowClerum({
      listArtifacts: vi.fn().mockResolvedValue({
        artifacts: [
          {
            name: 'report.pdf',
            format: 'pdf',
            sizeBytes: 2048,
            createdAt: '2026-05-08T00:00:00.000Z',
          },
        ],
      }),
      downloadArtifact: vi.fn().mockResolvedValue(new Uint8Array([37, 80, 68, 70]).buffer),
    })

    render(<MessageArtifactActions hostRef="chatllm" content="Generated: report.pdf" />)

    await waitFor(() => {
      expect(screen.getByText('report.pdf')).toBeTruthy()
    })
    expect(screen.queryByRole('button', { name: 'Preview report.pdf' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Download report.pdf' })).toBeTruthy()
  })
})
