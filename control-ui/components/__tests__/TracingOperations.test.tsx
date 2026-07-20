import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { getTracingOperationsSnapshot } from '@lib/governedTrace'
import type { TracingOperationsSnapshot } from '@lib/governedTrace'
import { TracingOperations } from '../GovernedTraceSurface/TracingOperations'

vi.mock('next/navigation', () => ({
  usePathname: () => '/traces/operations',
}))
vi.mock('recharts', () => ({
  Bar: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null,
  Cell: () => null,
  ReferenceLine: () => null,
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}))
vi.mock('@lib/governedTrace', () => ({
  getTracingOperationsSnapshot: vi.fn(),
}))

const mockGetSnapshot = vi.mocked(getTracingOperationsSnapshot)
const SNAPSHOT: TracingOperationsSnapshot = {
  generatedAt: '2026-07-13T12:00:00.000Z',
  instanceStartedAt: '2026-07-13T11:00:00.000Z',
  scope: 'control-api-instance',
  health: 'warning',
  limits: {
    bodyBytes: 524_288,
    eventsPerRequest: 100,
    maxInFlight: 32,
    ingestPoolMax: 4,
    readPoolMax: 3,
    poolConnectionTimeoutMs: 2_000,
    ingestStatementTimeoutMs: 5_000,
    readStatementTimeoutMs: 2_000,
    recentErrorSeconds: 300,
  },
  ingestion: {
    acceptedEvents: 120,
    replayedEvents: 4,
    rejectedEvents: 3,
    conflictingEvents: 1,
    admissionRequests: 124,
    admissionRejected: 3,
    inFlight: 2,
  },
  pools: [
    {
      name: 'ingest',
      active: 2,
      idle: 1,
      waiting: 1,
      rejectedSinceRestart: 0,
      statementTimeoutsSinceRestart: 0,
    },
    {
      name: 'read',
      active: 1,
      idle: 1,
      waiting: 0,
      rejectedSinceRestart: 0,
      statementTimeoutsSinceRestart: 0,
    },
  ],
  errors: [
    {
      reason: 'body_too_large',
      message: 'Tracing request exceeded 512 KiB and was rejected.',
      severity: 'warning',
      countSinceRestart: 3,
      lastOccurredAt: '2026-07-13T11:59:30.000Z',
      relatedSetting: '512 KiB hard ceiling (not ENV-configurable)',
      effectiveValue: 524_288,
      operatorAction: 'Reduce payload fields or split the request; do not raise the hard ceiling.',
    },
  ],
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden })
}

beforeEach(() => {
  setDocumentHidden(false)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.clearAllTimers()
  vi.useRealTimers()
  setDocumentHidden(false)
})

describe('TracingOperations', () => {
  it('renders current health, two bounded charts, effective limits, and canonical errors', async () => {
    mockGetSnapshot.mockResolvedValue(SNAPSHOT)
    render(<TracingOperations />)

    expect(screen.getByText('Loading tracing health…')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Tracing health warning')).toBeInTheDocument())
    expect(screen.getByRole('status')).toHaveTextContent(
      'Recent tracing rejection or current pressure needs review.'
    )

    expect(screen.queryByRole('navigation', { name: 'Trace sections' })).toBeNull()
    expect(screen.getByRole('group', { name: 'Tracing operations summary' })).toHaveTextContent(
      'Accepted events120'
    )
    expect(screen.getByRole('group', { name: 'Tracing operations summary' })).toHaveTextContent(
      'Rejected requests3 / 124 total'
    )
    expect(screen.getAllByRole('img')).toHaveLength(2)
    expect(
      screen.getByRole('img', {
        name: /Current event processing outcomes: Accepted events 120, Replayed events 4, Rejected events 3, Conflicting events 1/,
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('img', { name: /Current tracing pipeline pressure:/ })
    ).toBeInTheDocument()
    expect(screen.getByText('Event processing outcomes')).toBeInTheDocument()
    expect(screen.getByText('100% ceiling')).toBeInTheDocument()
    expect(
      screen.getByText('Tracing request exceeded 512 KiB and was rejected.')
    ).toBeInTheDocument()
    expect(screen.getByText('Effective value: 512 KiB')).toBeInTheDocument()
    expect(screen.getByText('TRACING_MAX_IN_FLIGHT')).toBeInTheDocument()
    expect(screen.getByText('TRACING_OPERATIONS_RECENT_ERROR_SECONDS')).toBeInTheDocument()
  })

  it('shows unavailable without inventing healthy or zero values when the first read fails', async () => {
    mockGetSnapshot.mockRejectedValue(new Error('control-api unavailable'))
    render(<TracingOperations />)

    const unavailable = await screen.findByRole('alert')
    expect(unavailable).toHaveTextContent('Tracing health unavailable')
    expect(unavailable).toHaveTextContent('No zero or healthy state is inferred')
    expect(
      screen.queryByRole('group', { name: 'Tracing operations summary' })
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Accepted events')).not.toBeInTheDocument()
  })

  it('preserves the last successful snapshot as visibly stale after a refresh failure', async () => {
    mockGetSnapshot
      .mockResolvedValueOnce(SNAPSHOT)
      .mockRejectedValueOnce(new Error('later failure'))
    render(<TracingOperations />)
    await screen.findByText('Tracing health warning')

    fireEvent.click(screen.getByRole('button', { name: 'Refresh tracing health' }))

    await waitFor(() => expect(screen.getByText('Tracing health stale')).toBeInTheDocument())
    expect(screen.getByText(/Last known state was warning/)).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Tracing operations summary' })).toHaveTextContent(
      'Accepted events120'
    )
  })

  it('keeps polling single-flight and pauses while the document is hidden', async () => {
    vi.useFakeTimers()
    let resolveFirst!: (snapshot: TracingOperationsSnapshot) => void
    mockGetSnapshot
      .mockImplementationOnce(
        () =>
          new Promise<TracingOperationsSnapshot>(resolve => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValue(SNAPSHOT)
    render(<TracingOperations />)
    await flush()
    expect(mockGetSnapshot).toHaveBeenCalledTimes(1)

    await act(async () => vi.advanceTimersByTime(30_000))
    expect(mockGetSnapshot).toHaveBeenCalledTimes(1)
    await act(async () => resolveFirst(SNAPSHOT))
    await flush()

    setDocumentHidden(true)
    document.dispatchEvent(new Event('visibilitychange'))
    await act(async () => vi.advanceTimersByTime(30_000))
    expect(mockGetSnapshot).toHaveBeenCalledTimes(1)

    setDocumentHidden(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(mockGetSnapshot).toHaveBeenCalledTimes(2)
  })

  it('queues one refresh when the tab becomes visible before an aborted request settles', async () => {
    let rejectFirst!: (error: Error) => void
    let resolveSecond!: (snapshot: TracingOperationsSnapshot) => void
    mockGetSnapshot
      .mockImplementationOnce(
        () =>
          new Promise<TracingOperationsSnapshot>((_resolve, reject) => {
            rejectFirst = reject
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<TracingOperationsSnapshot>(resolve => {
            resolveSecond = resolve
          })
      )
    render(<TracingOperations />)
    await flush()
    expect(mockGetSnapshot).toHaveBeenCalledTimes(1)

    setDocumentHidden(true)
    document.dispatchEvent(new Event('visibilitychange'))
    setDocumentHidden(false)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(mockGetSnapshot).toHaveBeenCalledTimes(1)

    rejectFirst(new DOMException('Aborted', 'AbortError'))
    await waitFor(() => expect(mockGetSnapshot).toHaveBeenCalledTimes(2))
    expect(screen.getByText('Loading tracing health…')).toBeInTheDocument()
    resolveSecond(SNAPSHOT)
    expect(await screen.findByText('Tracing health warning')).toBeInTheDocument()
  })

  it('aborts an outstanding snapshot request when the page unmounts', async () => {
    let observedSignal: AbortSignal | undefined
    mockGetSnapshot.mockImplementation(signal => {
      observedSignal = signal
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    })
    const { unmount } = render(<TracingOperations />)
    await flush()

    unmount()

    expect(observedSignal?.aborted).toBe(true)
  })
})
