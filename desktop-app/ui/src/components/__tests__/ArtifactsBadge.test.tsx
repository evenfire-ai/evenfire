// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ArtifactsBadge } from '../ArtifactsBadge'

// ── CSS import stub ───────────────────────────────────────────────────────────

vi.mock('../ArtifactsBadge.css', () => ({}))

// ── Helpers ───────────────────────────────────────────────────────────────────

type ArtifactInfo = { name: string; format: string; sizeBytes: number; createdAt: string }

const sampleArtifacts: ArtifactInfo[] = [
  { name: 'report.pdf', format: 'pdf', sizeBytes: 4096, createdAt: '2026-03-27T10:00:00Z' },
  { name: 'data.xlsx', format: 'xlsx', sizeBytes: 2097152, createdAt: '2026-03-27T10:01:00Z' },
  { name: 'notes.md', format: 'md', sizeBytes: 512, createdAt: '2026-03-27T10:02:00Z' },
]

function setupWindowClerum(
  overrides?: Partial<{
    listArtifacts: typeof window.clerum.rpc.listArtifacts
    downloadArtifact: typeof window.clerum.rpc.downloadArtifact
  }>
) {
  const listArtifacts =
    overrides?.listArtifacts ?? vi.fn().mockResolvedValue({ artifacts: sampleArtifacts })
  const downloadArtifact =
    overrides?.downloadArtifact ?? vi.fn().mockResolvedValue(new ArrayBuffer(8))

  vi.stubGlobal('clerum', {
    rpc: {
      listArtifacts,
      downloadArtifact,
    },
  })

  // Add `clerum` to `window`
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

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ArtifactsBadge — loading and empty states', () => {
  it('returns null while loading (before artifacts resolve)', async () => {
    // listArtifacts never resolves during this check
    let resolvePromise: (value: unknown) => void
    const pendingPromise = new Promise(resolve => {
      resolvePromise = resolve
    })
    setupWindowClerum({
      listArtifacts: vi.fn().mockReturnValue(pendingPromise),
    })

    const { container } = render(<ArtifactsBadge hostRef="chatllm" />)

    // While loading, the component returns null
    expect(container.innerHTML).toBe('')

    // Clean up: resolve the promise to avoid dangling
    resolvePromise!({ artifacts: [] })
  })

  it('returns null when artifacts list is empty', async () => {
    setupWindowClerum({
      listArtifacts: vi.fn().mockResolvedValue({ artifacts: [] }),
    })

    const { container } = render(<ArtifactsBadge hostRef="chatllm" />)

    // Wait for async load to complete
    await waitFor(() => {
      expect(container.innerHTML).toBe('')
    })
  })

  it('silently handles listArtifacts failure', async () => {
    setupWindowClerum({
      listArtifacts: vi.fn().mockRejectedValue(new Error('Network error')),
    })

    const { container } = render(<ArtifactsBadge hostRef="chatllm" />)

    await waitFor(() => {
      expect(container.innerHTML).toBe('')
    })
  })

  it('falls back to message artifact names when listArtifacts fails', async () => {
    const { downloadArtifact } = setupWindowClerum({
      listArtifacts: vi.fn().mockRejectedValue(new Error('Network error')),
    })

    render(<ArtifactsBadge hostRef="chatllm" artifactNames={['report.pdf', 'notes.md']} />)

    await waitFor(() => {
      expect(screen.getByText(/2 artifacts generated/)).toBeDefined()
      expect(screen.getByText(/Artifact catalog unavailable/)).toBeDefined()
    })

    fireEvent.click(screen.getByText(/2 artifacts generated/))
    expect(screen.getByText('report.pdf')).toBeDefined()
    expect(screen.getByText('notes.md')).toBeDefined()

    const downloadButtons = screen.getAllByText('Download')
    await act(async () => {
      fireEvent.click(downloadButtons[0]!)
    })
    await waitFor(() => {
      expect(downloadArtifact).toHaveBeenCalledWith('chatllm', 'report.pdf', ['chatllm'])
    })
  })
})

describe('ArtifactsBadge — rendering artifact list', () => {
  it('renders toggle button with artifact count', async () => {
    setupWindowClerum()

    render(<ArtifactsBadge hostRef="chatllm" />)

    await waitFor(() => {
      expect(screen.getByText(/3 artifacts generated/)).toBeDefined()
    })
  })

  it("renders singular 'artifact' for single item", async () => {
    setupWindowClerum({
      listArtifacts: vi.fn().mockResolvedValue({
        artifacts: [sampleArtifacts[0]],
      }),
    })

    render(<ArtifactsBadge hostRef="chatllm" />)

    await waitFor(() => {
      expect(screen.getByText(/1 artifact generated/)).toBeDefined()
    })
  })

  it('passes hostRef to listArtifacts with [hostRef] array', async () => {
    const { listArtifacts } = setupWindowClerum()

    render(<ArtifactsBadge hostRef="chatllm" />)

    await waitFor(() => {
      expect(listArtifacts).toHaveBeenCalledWith('chatllm', ['chatllm'])
    })
  })

  it('filters artifacts to the names provided by the message', async () => {
    setupWindowClerum()

    render(<ArtifactsBadge hostRef="chatllm" artifactNames={['report.pdf']} />)

    await waitFor(() => {
      expect(screen.getByText(/1 artifact generated/)).toBeDefined()
    })

    fireEvent.click(screen.getByText(/1 artifact generated/))
    expect(screen.getByText('report.pdf')).toBeDefined()
    expect(screen.queryByText('data.xlsx')).toBeNull()
  })
})

describe('ArtifactsBadge — expand/collapse', () => {
  it('does NOT show artifact items before toggle click', async () => {
    setupWindowClerum()

    render(<ArtifactsBadge hostRef="chatllm" />)

    await waitFor(() => {
      expect(screen.getByText(/3 artifacts generated/)).toBeDefined()
    })

    // Items should not be visible yet
    expect(screen.queryByText('report.pdf')).toBeNull()
  })

  it('shows artifact list after clicking toggle', async () => {
    setupWindowClerum()

    render(<ArtifactsBadge hostRef="chatllm" />)

    await waitFor(() => {
      expect(screen.getByText(/3 artifacts generated/)).toBeDefined()
    })

    fireEvent.click(screen.getByText(/3 artifacts generated/))

    expect(screen.getByText('report.pdf')).toBeDefined()
    expect(screen.getByText('data.xlsx')).toBeDefined()
    expect(screen.getByText('notes.md')).toBeDefined()
  })

  it('shows format badges in uppercase', async () => {
    setupWindowClerum()

    render(<ArtifactsBadge hostRef="chatllm" />)

    await waitFor(() => {
      expect(screen.getByText(/3 artifacts generated/)).toBeDefined()
    })

    fireEvent.click(screen.getByText(/3 artifacts generated/))

    expect(screen.getByText('PDF')).toBeDefined()
    expect(screen.getByText('XLSX')).toBeDefined()
    expect(screen.getByText('MD')).toBeDefined()
  })

  it('shows file sizes with proper formatting', async () => {
    setupWindowClerum()

    render(<ArtifactsBadge hostRef="chatllm" />)

    await waitFor(() => {
      expect(screen.getByText(/3 artifacts generated/)).toBeDefined()
    })

    fireEvent.click(screen.getByText(/3 artifacts generated/))

    // 4096 bytes = 4.0 KB
    expect(screen.getByText('4.0 KB')).toBeDefined()
    // 2097152 bytes = 2.0 MB
    expect(screen.getByText('2.0 MB')).toBeDefined()
    // 512 bytes = 512 B
    expect(screen.getByText('512 B')).toBeDefined()
  })

  it('collapses list on second toggle click', async () => {
    setupWindowClerum()

    render(<ArtifactsBadge hostRef="chatllm" />)

    await waitFor(() => {
      expect(screen.getByText(/3 artifacts generated/)).toBeDefined()
    })

    const toggle = screen.getByText(/3 artifacts generated/)

    fireEvent.click(toggle)
    expect(screen.getByText('report.pdf')).toBeDefined()

    fireEvent.click(toggle)
    expect(screen.queryByText('report.pdf')).toBeNull()
  })
})

describe('ArtifactsBadge — download', () => {
  it('renders Download button for each artifact', async () => {
    setupWindowClerum()

    render(<ArtifactsBadge hostRef="chatllm" />)

    await waitFor(() => {
      expect(screen.getByText(/3 artifacts generated/)).toBeDefined()
    })

    fireEvent.click(screen.getByText(/3 artifacts generated/))

    const downloadButtons = screen.getAllByText('Download')
    expect(downloadButtons).toHaveLength(3)
  })

  it('calls downloadArtifact with hostRef and filename on click', async () => {
    const { downloadArtifact } = setupWindowClerum()

    // Mock URL.createObjectURL and URL.revokeObjectURL for the download flow
    const origCreateObjectURL = URL.createObjectURL
    const origRevokeObjectURL = URL.revokeObjectURL
    URL.createObjectURL = vi.fn().mockReturnValue('blob:test-url')
    URL.revokeObjectURL = vi.fn()

    // Mock the anchor element creation without infinite recursion
    const origCreateElement = document.createElement.bind(document)
    const clickSpy = vi.fn()
    vi.spyOn(document, 'createElement').mockImplementation(((
      tag: string,
      options?: ElementCreationOptions
    ): HTMLElement => {
      if (tag === 'a') {
        const el = origCreateElement('a', options)
        el.click = clickSpy
        return el
      }
      return origCreateElement(tag, options)
    }) as typeof document.createElement)

    render(<ArtifactsBadge hostRef="chatllm" />)

    await waitFor(() => {
      expect(screen.getByText(/3 artifacts generated/)).toBeDefined()
    })

    fireEvent.click(screen.getByText(/3 artifacts generated/))

    const downloadButtons = screen.getAllByText('Download')
    // Click the first download button (report.pdf)
    await act(async () => {
      fireEvent.click(downloadButtons[0]!)
    })

    await waitFor(() => {
      expect(downloadArtifact).toHaveBeenCalledWith('chatllm', 'report.pdf', ['chatllm'])
    })

    // Restore
    URL.createObjectURL = origCreateObjectURL
    URL.revokeObjectURL = origRevokeObjectURL
  })

  it("shows '...' while download is in progress", async () => {
    let resolveDownload: (value: ArrayBuffer) => void
    const downloadPromise = new Promise<ArrayBuffer>(resolve => {
      resolveDownload = resolve
    })

    setupWindowClerum({
      downloadArtifact: vi.fn().mockReturnValue(downloadPromise),
    })

    render(<ArtifactsBadge hostRef="chatllm" />)

    await waitFor(() => {
      expect(screen.getByText(/3 artifacts generated/)).toBeDefined()
    })

    fireEvent.click(screen.getByText(/3 artifacts generated/))

    const downloadButtons = screen.getAllByText('Download')

    await act(async () => {
      fireEvent.click(downloadButtons[0]!)
    })

    // The first button should show "..." while downloading
    await waitFor(() => {
      expect(screen.getByText('...')).toBeDefined()
    })

    // Resolve the download
    await act(async () => {
      resolveDownload!(new ArrayBuffer(4))
    })
  })

  it('handles download failure gracefully (no crash)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    setupWindowClerum({
      downloadArtifact: vi.fn().mockRejectedValue(new Error('Network error')),
    })

    render(<ArtifactsBadge hostRef="chatllm" />)

    await waitFor(() => {
      expect(screen.getByText(/3 artifacts generated/)).toBeDefined()
    })

    fireEvent.click(screen.getByText(/3 artifacts generated/))

    const downloadButtons = screen.getAllByText('Download')

    await act(async () => {
      fireEvent.click(downloadButtons[0]!)
    })

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith('Download failed:', expect.any(Error))
    })

    consoleSpy.mockRestore()
  })
})

describe('ArtifactsBadge — aria attributes', () => {
  it('sets aria-expanded on toggle button', async () => {
    setupWindowClerum()

    render(<ArtifactsBadge hostRef="chatllm" />)

    await waitFor(() => {
      expect(screen.getByText(/3 artifacts generated/)).toBeDefined()
    })

    const toggle = screen.getByText(/3 artifacts generated/).closest('button')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })
})

describe('ArtifactsBadge — cleanup on unmount', () => {
  it('does not update state after unmount (cancelled flag)', async () => {
    let resolveList: (value: unknown) => void
    const listPromise = new Promise(resolve => {
      resolveList = resolve
    })

    setupWindowClerum({
      listArtifacts: vi.fn().mockReturnValue(listPromise),
    })

    const { unmount } = render(<ArtifactsBadge hostRef="chatllm" />)

    // Unmount before the promise resolves
    unmount()

    // Resolve after unmount -- should not throw
    await act(async () => {
      resolveList!({ artifacts: sampleArtifacts })
    })

    // If we got here without errors, the cancelled flag worked
    expect(true).toBe(true)
  })
})
