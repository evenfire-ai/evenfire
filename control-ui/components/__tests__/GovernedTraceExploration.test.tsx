import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { getGovernedTraceEvents } from '@lib/governedTrace'
import { GovernedEventExplorer } from '../GovernedTraceSurface/GovernedEventExplorer'

const navigation = vi.hoisted(() => ({
  pathname: '/traces/administrative',
  replace: vi.fn(),
  searchParams: new URLSearchParams(),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ replace: navigation.replace }),
  useSearchParams: () => navigation.searchParams,
}))
vi.mock('@lib/api', () => ({
  getAdminUsers: vi.fn().mockResolvedValue({ items: [] }),
  getControlAdmins: vi.fn().mockResolvedValue({
    admins: [
      {
        id: 'control-admin-1',
        username: 'admin',
        email: null,
        status: 'active',
        lastLoginAt: null,
        createdAt: '2026-07-14T10:00:00.000Z',
      },
    ],
    invitations: [],
  }),
}))
vi.mock('@lib/governedTrace', () => ({
  getGovernedTraceEvents: vi.fn(),
}))
vi.mock('../GovernedTraceSurface/InfrastructureCostQueryView', () => ({
  InfrastructureCostQueryView: () => <div>Cost query preserved</div>,
}))
vi.mock('../GovernedTraceSurface/InfrastructureOperationalSnapshot', () => ({
  InfrastructureOperationalSnapshot: () => <div>Operational snapshot preserved</div>,
}))

const mockGetEvents = vi.mocked(getGovernedTraceEvents)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, reject, resolve }
}

const BASE_EVENT = {
  streamSequence: '40',
  schemaVersion: 1,
  occurredAt: '2026-07-14T11:00:00.000Z',
  ingestedAt: '2026-07-14T11:00:01.000Z',
  correlationRef: 'operation-1',
  sessionId: null,
  actorKind: 'human',
  actorSub: 'operator-sub-1',
  serviceOrAgentSub: 'control-api',
  initiatingHumanSub: 'operator-sub-1',
  decisionActorSub: 'operator-sub-1',
  actingAgentSub: null,
  resourceAud: 'control-api://admin',
  effectiveScopes: ['admin:write'],
  authorizationDecision: 'allow',
  tokenExchangeId: 'exchange-reference-1',
  outcome: 'succeeded',
  recipeNamespace: null,
  recipeName: null,
  hostRef: null,
  payload: {},
}

const ADMIN_EVENT = {
  ...BASE_EVENT,
  eventFamily: 'administrative' as const,
  eventId: 'admin-event-1',
  eventType: 'permission_grant',
  targetType: 'agent',
  targetRef: 'agent-1',
  operatorUserId: 'user-1',
  operatorPrincipalId: 'user-1',
  operatorPrincipalKind: 'platform_user' as const,
  operatorDisplayName: 'Alice Operator',
  delegatedActorSub: 'agent-sub-1',
  sourceKind: 'control_plane',
  sourceService: 'control-api',
  serviceSub: 'service:control-api',
  targetUserId: 'user-2',
  targetUserSub: 'target-sub-2',
  targetUserDisplayName: 'Bob Target',
  payload: {
    resource_class: 'agent_access',
    status: 'granted',
  },
}

const INFRA_EVENT = {
  ...BASE_EVENT,
  eventFamily: 'infrastructure_telemetry' as const,
  eventId: 'infra-event-1',
  eventType: 'workload.capacity.observed',
  targetType: 'Deployment',
  targetRef: 'control-api',
  telemetryType: 'capacity_sample',
  reasonCode: 'scheduled_sample',
  sourceService: 'host-context-controller',
  controller: 'host-context-controller',
  clusterName: 'minikube-branch',
  namespace: 'control-plane',
  workloadKind: 'Deployment',
  workloadRef: 'control-api',
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  navigation.pathname = '/traces/administrative'
  navigation.searchParams = new URLSearchParams()
})

describe('GovernedEventExplorer', () => {
  it('renders clickable administrative events and both operator and target humans', async () => {
    navigation.searchParams = new URLSearchParams({
      operatorUserId: 'user-1',
      action: 'permission_grant',
    })
    mockGetEvents.mockResolvedValue({
      events: [ADMIN_EVENT],
      nextCursor: null,
      capturedHighWatermark: '40',
    })

    render(
      <GovernedEventExplorer
        family="administrative"
        subtitle="Administrative changes"
        title="Administrative"
      />
    )

    await waitFor(() => expect(screen.getByText('Permission grant')).toBeInTheDocument())
    expect(mockGetEvents).toHaveBeenCalledWith(
      '/api/v1/admin/tracing/events',
      expect.objectContaining({
        action: 'permission_grant',
        families: ['administrative'],
        operatorUserId: 'user-1',
        order: 'latest',
      }),
      expect.any(AbortSignal)
    )
    expect(screen.getByRole('link', { name: 'Permission grant' })).toHaveAttribute(
      'href',
      '/traces/administrative/admin-event-1'
    )
    expect(screen.getByText('Agent access')).toBeInTheDocument()
    expect(screen.getByText('Permission / approval changes').nextElementSibling).toHaveTextContent(
      '1'
    )
    expect(screen.getByRole('link', { name: 'Alice Operator' })).toHaveAttribute(
      'href',
      '/users-and-teams/users/user-1'
    )
    expect(screen.getByText('Verified platform user')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Bob Target' })).toHaveAttribute(
      'href',
      '/users-and-teams/users/user-2'
    )
  })

  it('offers control administrators as server-backed operator filters', async () => {
    mockGetEvents.mockResolvedValue({
      events: [ADMIN_EVENT],
      nextCursor: null,
      capturedHighWatermark: '40',
    })

    render(
      <GovernedEventExplorer
        family="administrative"
        subtitle="Administrative changes"
        title="Administrative"
      />
    )

    await screen.findByText('Permission grant')
    fireEvent.click(screen.getByRole('button', { name: 'Filter Operator' }))
    fireEvent.click(await screen.findByRole('option', { name: 'admin' }))

    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith(
        '/traces/administrative?window=24h&operatorUserId=control-admin-1',
        { scroll: false }
      )
    )
  })

  it('renders a clickable infrastructure workload and sends scope filters to the server', async () => {
    navigation.pathname = '/traces/infrastructure'
    navigation.searchParams = new URLSearchParams({
      clusterName: 'minikube-branch',
      workloadRef: 'control-api',
    })
    mockGetEvents.mockResolvedValue({
      events: [INFRA_EVENT],
      nextCursor: null,
      capturedHighWatermark: '41',
    })

    render(
      <GovernedEventExplorer
        family="infrastructure_telemetry"
        subtitle="Persisted infrastructure telemetry"
        title="Infrastructure"
      />
    )

    await waitFor(() => expect(screen.getByText('capacity_sample')).toBeInTheDocument())
    expect(mockGetEvents).toHaveBeenCalledWith(
      '/api/v1/admin/tracing/events',
      expect.objectContaining({
        clusterName: 'minikube-branch',
        families: ['infrastructure_telemetry'],
        workloadRef: 'control-api',
      }),
      expect.any(AbortSignal)
    )
    expect(screen.getByRole('link', { name: 'control-api' })).toHaveAttribute(
      'href',
      '/traces/infrastructure/infra-event-1'
    )
    expect(screen.getByText('Operational snapshot preserved')).toBeInTheDocument()
    expect(screen.getByText('Cost query preserved')).toBeInTheDocument()
  })

  it('labels a local Control UI event as non-delegated instead of unavailable', async () => {
    mockGetEvents.mockResolvedValue({
      events: [
        {
          ...ADMIN_EVENT,
          operatorPrincipalId: 'admin-1',
          operatorPrincipalKind: 'control_admin',
          operatorDisplayName: 'Control Operator',
          delegatedActorSub: null,
          actingAgentSub: null,
          sourceKind: 'control_api_local',
          teamId: 'team-1',
          targetTeamDisplayName: 'Operations',
          payload: { resource_class: 'workflow_approval_target', status: 'granted' },
          targetUserId: null,
          targetUserSub: null,
          targetUserDisplayName: null,
        },
      ],
      nextCursor: null,
      capturedHighWatermark: '42',
    })

    render(
      <GovernedEventExplorer
        family="administrative"
        subtitle="Administrative changes"
        title="Administrative"
      />
    )

    await waitFor(() => expect(screen.getByText('Control Operator')).toBeInTheDocument())
    expect(screen.getByText('Not delegated (local Control UI action)')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Target team · Operations' })).toHaveAttribute(
      'href',
      '/users-and-teams/teams/team-1'
    )
    expect(screen.queryByText('Unavailable')).not.toBeInTheDocument()
  })

  it('shows a non-human permission target without mislabeling it as a user', async () => {
    mockGetEvents.mockResolvedValue({
      events: [
        {
          ...ADMIN_EVENT,
          targetUserId: null,
          targetUserSub: null,
          targetUserDisplayName: null,
          payload: {
            resource_class: 'gfs_folder_grant',
            status: 'granted',
            target_principal_kind: 'host',
            target_principal_ref: 'host:1st:mcp-host/chatllm',
          },
        },
      ],
      nextCursor: null,
      capturedHighWatermark: '42',
    })

    render(
      <GovernedEventExplorer
        family="administrative"
        subtitle="Administrative changes"
        title="Administrative"
      />
    )

    await waitFor(() =>
      expect(screen.getByText('Target Host · host:1st:mcp-host/chatllm')).toBeInTheDocument()
    )
    expect(screen.queryByText('Service or resource-level change')).not.toBeInTheDocument()
  })

  it('ignores stale load-more results after the governed event order changes', async () => {
    const stalePage = deferred<Awaited<ReturnType<typeof getGovernedTraceEvents>>>()
    mockGetEvents.mockImplementation((_path, query) => {
      if (query.cursor === 'old-cursor') return stalePage.promise
      if (query.cursor === 'new-cursor') {
        return Promise.resolve({
          events: [
            {
              ...ADMIN_EVENT,
              eventId: 'oldest-more',
              targetRef: 'new-order-more',
            },
          ],
          nextCursor: null,
          capturedHighWatermark: '43',
        })
      }
      if (query.order === 'oldest') {
        return Promise.resolve({
          events: [
            {
              ...ADMIN_EVENT,
              eventId: 'oldest-base',
              targetRef: 'new-order-base',
            },
          ],
          nextCursor: 'new-cursor',
          capturedHighWatermark: '42',
        })
      }
      return Promise.resolve({
        events: [
          {
            ...ADMIN_EVENT,
            eventId: 'latest-base',
            targetRef: 'old-order-base',
          },
        ],
        nextCursor: 'old-cursor',
        capturedHighWatermark: '41',
      })
    })

    render(
      <GovernedEventExplorer
        family="administrative"
        subtitle="Administrative changes"
        title="Administrative"
      />
    )

    await screen.findByText(content => content.includes('old-order-base'))
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Occurred ascending' }))

    await screen.findByText(content => content.includes('new-order-base'))
    stalePage.resolve({
      events: [
        {
          ...ADMIN_EVENT,
          eventId: 'stale-more',
          targetRef: 'stale-old-order-row',
        },
      ],
      nextCursor: 'stale-cursor',
      capturedHighWatermark: '41',
    })

    await waitFor(() => {
      expect(
        screen.queryByText(content => content.includes('stale-old-order-row'))
      ).not.toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))

    await waitFor(() => {
      expect(mockGetEvents).toHaveBeenLastCalledWith(
        '/api/v1/admin/tracing/events',
        expect.objectContaining({
          cursor: 'new-cursor',
          order: 'oldest',
        })
      )
    })
    expect(
      await screen.findByText(content => content.includes('new-order-more'))
    ).toBeInTheDocument()
  })
})
