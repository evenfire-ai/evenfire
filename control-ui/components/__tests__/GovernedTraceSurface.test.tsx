import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  getGovernedTraceEvents,
  getInfrastructureCostScopes,
  getInfrastructureTraceCosts,
  isTraceCostsUnavailable,
} from '@lib/governedTrace'
import { GovernedTraceSurface } from '../GovernedTraceSurface'

const navigation = vi.hoisted(() => ({
  pathname: '/traces/infrastructure',
  replace: vi.fn(),
  router: null as null | { replace: ReturnType<typeof vi.fn> },
  searchParams: new URLSearchParams(),
}))
navigation.router = { replace: navigation.replace }

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => navigation.router,
  useSearchParams: () => navigation.searchParams,
}))
vi.mock('recharts', () => ({
  Bar: () => null,
  BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null,
  Legend: () => null,
  ReferenceLine: () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}))
vi.mock('@lib/governedTrace', () => ({
  getGovernedTraceEvents: vi.fn(),
  getInfrastructureCostScopes: vi.fn(),
  getInfrastructureTraceCosts: vi.fn(),
  isTraceCostsUnavailable: vi.fn(error => (error as { status?: number }).status === 501),
}))

const mockGetEvents = vi.mocked(getGovernedTraceEvents)
const mockGetCostScopes = vi.mocked(getInfrastructureCostScopes)
const mockGetCosts = vi.mocked(getInfrastructureTraceCosts)
const mockIsCostsUnavailable = vi.mocked(isTraceCostsUnavailable)

const EVENT = {
  streamSequence: '12',
  eventFamily: 'agent_run' as const,
  eventId: 'event-12',
  schemaVersion: 1,
  occurredAt: '2026-07-11T10:00:00.000Z',
  ingestedAt: '2026-07-11T10:00:01.000Z',
  correlationRef: 'run-12',
  sessionId: 'session-12',
  actorKind: 'human',
  actorSub: 'user-1',
  serviceOrAgentSub: 'agent-1',
  initiatingHumanSub: 'user-1',
  decisionActorSub: null,
  actingAgentSub: 'agent-1',
  resourceAud: 'mcp://host-1',
  effectiveScopes: ['tools:read'],
  authorizationDecision: 'allow',
  tokenExchangeId: 'exchange-1',
  eventType: 'tool_call',
  outcome: 'succeeded',
  targetType: 'tool',
  targetRef: 'search',
  recipeNamespace: 'sandbox-recipes',
  recipeName: 'research',
  hostRef: 'chatllm',
  payload: { tool_name: 'search', raw_prompt: 'must not render' },
}

const COST_RESPONSE = {
  period: 'week' as const,
  periodStartUtc: '2026-07-06',
  periodEndUtc: '2026-07-13',
  dimensions: {
    cloudProvider: 'gcp' as const,
    cloudProjectId: 'project-1',
    clusterLocation: 'europe-west1',
    clusterName: 'cluster-1',
    environment: 'test',
    namespace: 'control-plane',
    workloadKind: 'Deployment',
    workloadRef: 'control-api',
    currency: 'USD',
  },
  requestedCapacity: {
    period: 'week' as const,
    periodStartUtc: '2026-07-06',
    periodEndUtc: '2026-07-13',
    sourceDailyVersionHash: 'a'.repeat(64),
    dailyVersionVector: [{ utcDay: '2026-07-10', id: 'estimate-v2', rollupVersion: 2 }],
    publicationState: 'provisional' as const,
    completenessStatus: 'partial' as const,
    grossAmount: '10.000000000',
    creditsAmount: '1.000000000',
    netAmount: '9.000000000',
    overheadAmount: '2.000000000',
    unallocatedAmount: '0.500000000',
    unsupportedAmount: '0.250000000',
    valuationKind: 'estimated' as const,
    selectedBasis: 'requested_capacity' as const,
    asOfUtc: '2026-07-11T01:00:00.000Z',
    billingExportWatermark: null,
    billingLagHours: null,
    billingFreshnessStatus: 'not_applicable' as const,
    components: [
      {
        componentKey: 'cpu',
        resourceClass: 'cpu',
        allocationBucket: null,
        unitHours: '24.000000000',
        priceSnapshotId: 'price-1',
        providerService: null,
        providerSku: null,
        billingViewVersion: null,
        sourceRowCount: null,
        sourceSha256: 'b'.repeat(64),
        billingExportWatermark: null,
        grossAmount: '6.000000000',
        creditsAmount: '0.000000000',
        netAmount: '6.000000000',
        priceSourceRef: 'pricing-export:2026-07-10:cpu',
        priceEffectiveFrom: '2026-07-10T00:00:00.000Z',
        priceUnitPrice: '0.031611000',
      },
    ],
  },
  gcpRequestAllocation: {
    period: 'week' as const,
    periodStartUtc: '2026-07-06',
    periodEndUtc: '2026-07-13',
    sourceDailyVersionHash: 'c'.repeat(64),
    dailyVersionVector: [{ utcDay: '2026-07-10', id: 'billed-v2', rollupVersion: 2 }],
    publicationState: 'finalized' as const,
    completenessStatus: 'complete' as const,
    grossAmount: '12.000000000',
    creditsAmount: '0.000000000',
    netAmount: '12.000000000',
    overheadAmount: '1.000000000',
    unallocatedAmount: '2.000000000',
    unsupportedAmount: '0.000000000',
    valuationKind: 'billed' as const,
    selectedBasis: 'gcp_request_allocation' as const,
    asOfUtc: '2026-07-11T01:00:00.000Z',
    billingExportWatermark: '2026-07-11T00:00:00.000Z',
    billingLagHours: 1,
    billingFreshnessStatus: 'fresh' as const,
    components: [
      {
        componentKey: 'unallocated',
        resourceClass: 'allocation_bucket',
        allocationBucket: 'kube:unallocated',
        unitHours: null,
        priceSnapshotId: null,
        providerService: 'GKE',
        providerSku: 'compute',
        billingViewVersion: 'v1',
        sourceRowCount: 1,
        sourceSha256: 'd'.repeat(64),
        billingExportWatermark: '2026-07-11T00:00:00.000Z',
        grossAmount: '2.000000000',
        creditsAmount: '0.000000000',
        netAmount: '2.000000000',
      },
    ],
  },
  variance: {
    netAmount: '3.000000000',
    billedBasis: 'gcp_request_allocation' as const,
    estimateBasis: 'requested_capacity' as const,
  },
}

const COST_SCOPE_CATALOG = {
  scopes: [
    {
      dimensions: COST_RESPONSE.dimensions,
      firstUtcDay: '2026-07-01',
      lastUtcDay: '2026-07-11',
      availableValuations: ['estimated', 'billed'] as const,
      latestAsOfUtc: '2026-07-11T01:00:00.000Z',
      billingExportWatermark: '2026-07-11T00:00:00.000Z',
      billingLagHours: 1,
    },
  ],
  truncated: false,
}

function renderSurface(detail = false) {
  return render(
    <GovernedTraceSurface
      detail={detail}
      family="agent_run"
      readPath="/api/v1/admin/tracing/runs"
      subtitle="Test trace surface"
      title="Run replay"
    />
  )
}

function renderInfrastructureSurface(catalog = COST_SCOPE_CATALOG) {
  mockGetCostScopes.mockResolvedValue(catalog)
  return render(
    <GovernedTraceSurface
      family="infrastructure_telemetry"
      readPath="/api/v1/admin/tracing/events"
      subtitle="Infrastructure facts"
      title="Infrastructure telemetry"
    />
  )
}

function fillCostQuery() {
  fireEvent.change(screen.getByLabelText(/Time range/), { target: { value: 'week' } })
  fireEvent.change(screen.getByLabelText(/^Date/), { target: { value: '2026-07-11' } })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  navigation.pathname = '/traces/infrastructure'
  navigation.searchParams = new URLSearchParams()
})

describe('GovernedTraceSurface', () => {
  it('shows a loading state before the canonical read resolves', () => {
    mockGetEvents.mockReturnValue(new Promise(() => {}))
    renderSurface()
    expect(screen.getByText('Loading governed events…')).toBeInTheDocument()
  })

  it('renders released event fields without rendering raw payload values', async () => {
    mockGetEvents.mockResolvedValue({
      events: [EVENT],
      nextCursor: null,
      capturedHighWatermark: '12',
    })
    renderSurface()

    await waitFor(() => expect(screen.getByText('tool_call')).toBeInTheDocument())
    expect(screen.getByText('Released fields only')).toBeInTheDocument()
    expect(screen.queryByText('must not render')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'tool_call' })).toHaveAttribute(
      'href',
      '/traces/workflows/sandbox-recipes/research/runs/run-12'
    )
    const summary = screen.getByRole('group', { name: 'Loaded trace summary' })
    expect(summary).toHaveTextContent('Loaded events1')
    expect(summary).toHaveTextContent('Matching filter1')
    expect(summary).toHaveTextContent('Adverse outcomes0')
    expect(summary).toHaveTextContent('Time windowLast 24 hours')
  })

  it('shows an empty state for an empty canonical page', async () => {
    mockGetEvents.mockResolvedValue({ events: [], nextCursor: null, capturedHighWatermark: '0' })
    renderSurface()
    await waitFor(() => expect(screen.getByText(/No governed events match/)).toBeInTheDocument())
  })

  it('shows a read failure without inventing an empty result', async () => {
    mockGetEvents.mockRejectedValue(new Error('403 Forbidden'))
    renderSurface()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('403 Forbidden'))
  })

  it('uses the returned cursor when loading the next page', async () => {
    mockGetEvents
      .mockResolvedValueOnce({
        events: [EVENT],
        nextCursor: 'cursor-2',
        capturedHighWatermark: '20',
      })
      .mockResolvedValueOnce({
        events: [{ ...EVENT, eventId: 'event-13', streamSequence: '13' }],
        nextCursor: null,
        capturedHighWatermark: '20',
      })
    renderSurface()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Load more' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() =>
      expect(mockGetEvents).toHaveBeenLastCalledWith(
        '/api/v1/admin/tracing/runs',
        expect.objectContaining({
          cursor: 'cursor-2',
          families: ['agent_run'],
          order: 'latest',
          occurredFrom: expect.any(String),
          occurredTo: expect.any(String),
        })
      )
    )
  })

  it('restores the bounded time window from the URL and keeps changes shareable', async () => {
    navigation.pathname = '/traces'
    navigation.searchParams = new URLSearchParams({ window: '30d' })
    mockGetEvents.mockResolvedValue({ events: [], nextCursor: null, capturedHighWatermark: '0' })
    renderSurface()

    await waitFor(() => expect(mockGetEvents).toHaveBeenCalledTimes(1))
    expect(screen.getByLabelText('Trace time window')).toHaveValue('30d')
    const initialQuery = mockGetEvents.mock.calls[0]?.[1]
    expect(
      new Date(initialQuery?.occurredTo ?? '').getTime() -
        new Date(initialQuery?.occurredFrom ?? '').getTime()
    ).toBe(30 * 24 * 60 * 60 * 1000)

    fireEvent.change(screen.getByLabelText('Trace time window'), { target: { value: '7d' } })

    await waitFor(() => expect(mockGetEvents).toHaveBeenCalledTimes(2))
    expect(navigation.replace).toHaveBeenCalledWith('/traces?window=7d', { scroll: false })
    const latestQuery = mockGetEvents.mock.calls[1]?.[1]
    expect(latestQuery).toMatchObject({ families: ['agent_run'], order: 'latest' })
    expect(
      new Date(latestQuery?.occurredTo ?? '').getTime() -
        new Date(latestQuery?.occurredFrom ?? '').getTime()
    ).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it('keeps the server event order in the replay timeline', async () => {
    mockGetEvents.mockResolvedValue({
      events: [
        { ...EVENT, eventId: 'first', eventType: 'run_start' },
        { ...EVENT, eventId: 'second', eventType: 'run_end' },
      ],
      nextCursor: null,
      capturedHighWatermark: '13',
    })
    renderSurface(true)

    await waitFor(() =>
      expect(screen.getByLabelText('Ordered governed events')).toBeInTheDocument()
    )
    const items = screen.getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('run_start')
    expect(items[1]).toHaveTextContent('run_end')
    const summary = screen.getByRole('group', { name: 'Loaded trace summary' })
    expect(summary).toHaveTextContent('Loaded events2')
    expect(summary).toHaveTextContent('Terminal outcomesucceeded')
    expect(summary).toHaveTextContent('Observed duration0.0s')
  })

  it('shows the human user, MCP host, session, and approval decision actor separately', async () => {
    mockGetEvents.mockResolvedValue({
      events: [
        {
          ...EVENT,
          eventId: 'approval-event',
          eventType: 'workflow_approval_decision',
          initiatingHumanSub: 'requester-1',
          decisionActorSub: 'approver-1',
        },
      ],
      nextCursor: null,
      capturedHighWatermark: '13',
    })
    renderSurface(true)

    await waitFor(() => expect(screen.getByText('Decision actor')).toBeInTheDocument())
    expect(screen.getByText('Human user')).toBeInTheDocument()
    expect(screen.getByText('MCP host')).toBeInTheDocument()
    expect(screen.getByText('Session ID')).toBeInTheDocument()
    expect(screen.getByText('requester-1')).toBeInTheDocument()
    expect(screen.getByText('approver-1')).toBeInTheDocument()
    expect(screen.getByText('chatllm')).toBeInTheDocument()
    expect(screen.getByText('session-12')).toBeInTheDocument()
  })

  it('matches a replay event by its session ID', async () => {
    mockGetEvents.mockResolvedValue({
      events: [EVENT],
      nextCursor: null,
      capturedHighWatermark: '12',
    })
    renderSurface()

    await waitFor(() => expect(screen.getByText('tool_call')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Filter loaded governed events'), {
      target: { value: 'session-12' },
    })

    expect(screen.getByRole('group', { name: 'Loaded trace summary' })).toHaveTextContent(
      'Matching filter1'
    )
  })

  it('loads persisted workload scopes without manually probing cost dimensions', async () => {
    mockGetEvents.mockResolvedValue({ events: [], nextCursor: null, capturedHighWatermark: '0' })
    renderInfrastructureSurface()

    await waitFor(() => expect(screen.getByText(/No governed events match/)).toBeInTheDocument())
    await waitFor(() => expect(screen.getByLabelText(/Workload/)).toHaveValue('0'))
    expect(screen.getByRole('button', { name: 'View costs' })).toBeEnabled()
    expect(screen.queryByLabelText(/Cloud project/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Cluster location/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Currency/)).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Selected workload metadata' })).toHaveTextContent(
      'project-1'
    )
    expect(screen.getByRole('status')).toHaveTextContent('Cost evidence limitations')
    expect(screen.getByRole('status')).toHaveTextContent(
      'They do not claim measured CPU or memory utilization'
    )
    expect(screen.getByText('Connect GCP billing evidence')).toBeInTheDocument()
    expect(screen.getByText('GCP export · 1h lag')).toBeInTheDocument()
    expect(mockGetCostScopes).toHaveBeenCalledOnce()
    expect(mockGetCosts).not.toHaveBeenCalled()
  })

  it('restores shareable infrastructure cost filters from the canonical URL', async () => {
    navigation.searchParams = new URLSearchParams({
      costScope: JSON.stringify(COST_RESPONSE.dimensions),
      costPeriod: 'month',
      costDate: '2026-07-11',
      costValuation: 'variance',
    })
    mockGetEvents.mockResolvedValue({ events: [], nextCursor: null, capturedHighWatermark: '0' })

    renderInfrastructureSurface()

    await waitFor(() => expect(screen.getByLabelText(/Workload/)).toHaveValue('0'))
    expect(screen.getByLabelText(/Time range/)).toHaveValue('month')
    expect(screen.getByLabelText(/^Date/)).toHaveValue('2026-07-11')
    expect(screen.getByLabelText(/Cost view/)).toHaveValue('variance')
  })

  it('persists changed infrastructure cost filters without replacing the canonical route', async () => {
    mockGetEvents.mockResolvedValue({ events: [], nextCursor: null, capturedHighWatermark: '0' })
    renderInfrastructureSurface()

    await waitFor(() => expect(screen.getByLabelText(/Workload/)).toHaveValue('0'))
    navigation.replace.mockClear()
    fireEvent.change(screen.getByLabelText(/Time range/), { target: { value: 'week' } })

    expect(navigation.replace).toHaveBeenCalledOnce()
    const [href, options] = navigation.replace.mock.calls[0]!
    const url = new URL(href, 'http://control-ui.test')
    expect(url.pathname).toBe('/traces/infrastructure')
    expect(url.searchParams.get('costPeriod')).toBe('week')
    expect(url.searchParams.get('costValuation')).toBe('estimated')
    expect(url.searchParams.get('costScope')).toBe(JSON.stringify(COST_RESPONSE.dimensions))
    expect(options).toEqual({ scroll: false })
  })

  it('explains missing GCP billed evidence and how to connect it', async () => {
    mockGetEvents.mockResolvedValue({ events: [], nextCursor: null, capturedHighWatermark: '0' })
    renderInfrastructureSurface({
      scopes: [
        {
          ...COST_SCOPE_CATALOG.scopes[0],
          availableValuations: ['estimated'] as const,
          billingExportWatermark: null,
          billingLagHours: null,
        },
      ],
      truncated: false,
    })

    const limitation = await screen.findByText(/GCP billed costs and variance are unavailable/)
    expect(limitation).toBeInTheDocument()
    fireEvent.click(screen.getByText('Connect GCP billing evidence'))
    expect(
      screen.getByText(/Pricing data export and Detailed Usage Cost export/)
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Do not upload or store a service-account JSON key/)
    ).toBeInTheDocument()
    expect(screen.getByText(/Do not grant Billing Account Viewer/)).toBeInTheDocument()
  })

  it('reports unavailable persisted cost evidence instead of exposing manual dimensions', async () => {
    mockGetEvents.mockResolvedValue({ events: [], nextCursor: null, capturedHighWatermark: '0' })
    renderInfrastructureSurface({ scopes: [], truncated: false })

    expect(
      await screen.findByText(/No persisted infrastructure cost data is available/)
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View costs' })).toBeDisabled()
    expect(screen.queryByLabelText(/Cloud project/)).not.toBeInTheDocument()
    expect(
      screen.getByText(/GCP billed data requires Billing Export activation/)
    ).toBeInTheDocument()
    expect(mockGetCosts).not.toHaveBeenCalled()
  })

  it('turns released infrastructure evidence into an operator workload snapshot', async () => {
    mockGetEvents.mockResolvedValue({
      events: [
        {
          ...EVENT,
          eventFamily: 'infrastructure_telemetry',
          eventId: 'telemetry-1',
          eventType: 'usage_sample',
          outcome: 'succeeded',
          targetRef: 'control-plane/control-api',
          payload: {
            namespace: 'control-plane',
            workload_kind: 'Deployment',
            desired_replicas: 3,
            ready_replicas: 2,
            interval_start: '2026-07-11T09:59:00.000Z',
            interval_end: '2026-07-11T10:00:00.000Z',
            cpu_request_cores: 1,
            cpu_usage_core_seconds: 75,
            memory_request_bytes: 1024 ** 3,
            memory_usage_byte_seconds: 90 * 1024 ** 3,
          },
        },
      ],
      nextCursor: null,
      capturedHighWatermark: '12',
    })
    renderInfrastructureSurface()

    const snapshot = await screen.findByRole('region', {
      name: 'Infrastructure operational snapshot',
    })
    expect(snapshot).toHaveTextContent('control-plane/control-api')
    expect(snapshot).toHaveTextContent('Investigate')
    expect(snapshot).toHaveTextContent('Ready 2 / 3')
    expect(snapshot).toHaveTextContent('CPU 1.25 / 1.00 cores · 125%')
    expect(snapshot).toHaveTextContent('Memory 1.50 / 1.00 GiB · 150%')
    expect(snapshot).toHaveTextContent(
      '1 replica not ready · CPU at 125% of request · Memory at 150% of request'
    )
    expect(screen.getByRole('img', { name: /Capacity pressure/ })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Filter loaded governed events'), {
      target: { value: 'no-match' },
    })
    expect(snapshot).toHaveTextContent('No workload capacity evidence')
  })

  it('keeps the newest workload evidence authoritative while backfilling older fields', async () => {
    mockGetEvents.mockResolvedValue({
      events: [
        {
          ...EVENT,
          streamSequence: '14',
          eventFamily: 'infrastructure_telemetry',
          eventId: 'telemetry-newest',
          eventType: 'usage_sample',
          occurredAt: '2026-07-11T10:05:00.000Z',
          outcome: 'succeeded',
          targetRef: 'control-plane/control-api',
          payload: {
            cluster_name: 'cluster-current',
            namespace: 'control-plane',
            workload_kind: 'Deployment',
            desired_replicas: 3,
            ready_replicas: 3,
            interval_start: '2026-07-11T10:04:00.000Z',
            interval_end: '2026-07-11T10:05:00.000Z',
            cpu_request_cores: 1,
            cpu_usage_core_seconds: 30,
            memory_request_bytes: 1024 ** 3,
            memory_usage_byte_seconds: 30 * 1024 ** 3,
          },
        },
        {
          ...EVENT,
          streamSequence: '13',
          eventFamily: 'infrastructure_telemetry',
          eventId: 'telemetry-older',
          eventType: 'reconcile_outcome',
          occurredAt: '2026-07-11T10:00:00.000Z',
          outcome: 'failed',
          targetRef: 'control-plane/control-api',
          payload: {
            environment: 'test',
            cluster_name: 'cluster-stale',
            desired_replicas: 3,
            ready_replicas: 2,
            interval_start: '2026-07-11T09:59:00.000Z',
            interval_end: '2026-07-11T10:00:00.000Z',
            cpu_request_cores: 1,
            cpu_usage_core_seconds: 75,
            memory_request_bytes: 1024 ** 3,
            memory_usage_byte_seconds: 90 * 1024 ** 3,
          },
        },
      ],
      nextCursor: null,
      capturedHighWatermark: '14',
    })
    renderInfrastructureSurface()

    const snapshot = await screen.findByRole('region', {
      name: 'Infrastructure operational snapshot',
    })
    expect(snapshot).toHaveTextContent('Ready 3 / 3')
    expect(snapshot).toHaveTextContent('cluster-current')
    expect(snapshot).toHaveTextContent('Nominal')
    expect(snapshot).not.toHaveTextContent('Investigate')
    expect(within(snapshot).getByText(/usage_sample · succeeded/)).toBeInTheDocument()
  })

  it('does not regress the workload snapshot when an older cursor page is appended', async () => {
    mockGetEvents
      .mockResolvedValueOnce({
        events: [
          {
            ...EVENT,
            streamSequence: '14',
            eventFamily: 'infrastructure_telemetry',
            eventId: 'telemetry-newest',
            eventType: 'usage_sample',
            outcome: 'succeeded',
            targetRef: 'control-plane/control-api',
            payload: { desired_replicas: 4, ready_replicas: 4 },
          },
        ],
        nextCursor: 'older-page',
        capturedHighWatermark: '14',
      })
      .mockResolvedValueOnce({
        events: [
          {
            ...EVENT,
            streamSequence: '9',
            eventFamily: 'infrastructure_telemetry',
            eventId: 'telemetry-older',
            eventType: 'reconcile_outcome',
            outcome: 'failed',
            targetRef: 'control-plane/control-api',
            payload: { desired_replicas: 4, ready_replicas: 1 },
          },
        ],
        nextCursor: null,
        capturedHighWatermark: '14',
      })
    renderInfrastructureSurface()

    const snapshot = await screen.findByRole('region', {
      name: 'Infrastructure operational snapshot',
    })
    expect(snapshot).toHaveTextContent('Ready 4 / 4')
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))

    await waitFor(() => expect(mockGetEvents).toHaveBeenCalledTimes(2))
    expect(snapshot).toHaveTextContent('Ready 4 / 4')
    expect(snapshot).toHaveTextContent('Nominal')
    expect(snapshot).not.toHaveTextContent('Investigate')
    expect(within(snapshot).getByText(/usage_sample · succeeded/)).toBeInTheDocument()
  })

  it('queries infrastructure costs with explicit period anchor and required dimensions', async () => {
    mockGetEvents.mockResolvedValue({ events: [], nextCursor: null, capturedHighWatermark: '0' })
    mockGetCosts.mockResolvedValue(COST_RESPONSE)
    renderInfrastructureSurface()

    await waitFor(() => expect(screen.getByLabelText(/Workload/)).toHaveValue('0'))
    fillCostQuery()
    fireEvent.click(screen.getByRole('button', { name: 'View costs' }))

    await waitFor(() =>
      expect(mockGetCosts).toHaveBeenCalledWith({
        period: 'week',
        anchorDate: '2026-07-11',
        valuation: 'estimated',
        basis: 'requested_capacity',
        cloudProvider: 'gcp',
        cloudProjectId: 'project-1',
        clusterLocation: 'europe-west1',
        clusterName: 'cluster-1',
        environment: 'test',
        namespace: 'control-plane',
        workloadKind: 'Deployment',
        workloadRef: 'control-api',
        currency: 'USD',
      })
    )
    expect(screen.getByText('Estimated requested capacity')).toBeInTheDocument()
    expect(screen.getAllByText('GCP billed')).not.toHaveLength(0)
    expect(screen.getAllByText('Variance')).not.toHaveLength(0)
    expect(screen.getByText('Provisional / partial')).toBeInTheDocument()
    expect(screen.getByText('Final / complete')).toBeInTheDocument()
    expect(screen.getAllByText('requested_capacity')).toHaveLength(2)
    expect(screen.getAllByText('gcp_request_allocation')).toHaveLength(2)
    expect(screen.getAllByText('Net cost')).toHaveLength(2)
    expect(screen.getByRole('region', { name: 'Infrastructure cost results' })).toBeInTheDocument()
    expect(screen.getAllByText('Period coverage')).toHaveLength(2)
    expect(screen.getAllByText('1 / 7 days')).toHaveLength(2)
    expect(screen.getByText('Net difference')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /Net cost comparison/ })).toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: 'Historical cost run-rate forecast' })
    ).toBeInTheDocument()
    expect(screen.getByText('Historical run-rate forecast')).toBeInTheDocument()
    expect(screen.getByText('Provisioned pattern')).toBeInTheDocument()
    expect(screen.getByText('GCP billed pattern')).toBeInTheDocument()
    expect(screen.getByText('7-day projection')).toBeInTheDocument()
    expect(screen.getByText('30-day projection')).toBeInTheDocument()
    expect(screen.getByText(/This extrapolates persisted daily patterns/)).toBeInTheDocument()
    expect(screen.getByText('Variance rate')).toBeInTheDocument()
    expect(screen.getByText(/33\.33%/)).toBeInTheDocument()
    expect(screen.getByText('1h')).toBeInTheDocument()
    expect(screen.getByText('kube:unallocated')).toBeInTheDocument()
    expect(screen.getByText('pricing-export:2026-07-10:cpu')).toBeInTheDocument()
    expect(screen.getByText(/0.031611000 per vCPU hour/)).toBeInTheDocument()
    expect(screen.queryByText(/actual/i)).not.toBeInTheDocument()
  })

  it('keeps stale billed evidence visible for audit but excludes it from forecasts and variance', async () => {
    mockGetEvents.mockResolvedValue({ events: [], nextCursor: null, capturedHighWatermark: '0' })
    mockGetCosts.mockResolvedValue({
      ...COST_RESPONSE,
      gcpRequestAllocation: {
        ...COST_RESPONSE.gcpRequestAllocation,
        billingLagHours: 120,
        billingFreshnessStatus: 'stale',
      },
      variance: undefined,
    })
    renderInfrastructureSurface({
      ...COST_SCOPE_CATALOG,
      scopes: [
        {
          ...COST_SCOPE_CATALOG.scopes[0],
          billingLagHours: 120,
        },
      ],
    })

    await waitFor(() => expect(screen.getByLabelText(/Workload/)).toHaveValue('0'))
    fillCostQuery()
    fireEvent.click(screen.getByRole('button', { name: 'View costs' }))

    expect(await screen.findByText('Final / complete / stale import')).toBeInTheDocument()
    expect(screen.getByText(/delayed by 120 hours/)).toBeInTheDocument()
    expect(screen.queryByText('GCP billed pattern')).not.toBeInTheDocument()
    expect(screen.queryByText('Net difference')).not.toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /Net cost comparison/ })).not.toBeInTheDocument()
  })

  it('shows an infrastructure cost error after a submitted query fails', async () => {
    mockGetEvents.mockResolvedValue({ events: [], nextCursor: null, capturedHighWatermark: '0' })
    mockGetCosts.mockRejectedValue({ status: 501 })
    mockIsCostsUnavailable.mockReturnValue(true)
    renderInfrastructureSurface()

    await waitFor(() => expect(screen.getByLabelText(/Workload/)).toHaveValue('0'))
    fillCostQuery()
    fireEvent.click(screen.getByRole('button', { name: 'View costs' }))

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Infrastructure cost read support is unavailable in this Control API.'
      )
    )
  })
})
