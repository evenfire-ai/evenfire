import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import {
  getGovernedAdministrativeEventDetail,
  getGovernedInfrastructureEventDetail,
} from '@lib/governedTrace'
import { AdministrativeEventDetail } from '../GovernedTraceSurface/AdministrativeEventDetail'
import { InfrastructureEventDetail } from '../GovernedTraceSurface/InfrastructureEventDetail'

vi.mock('@lib/governedTrace', () => ({
  getGovernedAdministrativeEventDetail: vi.fn(),
  getGovernedInfrastructureEventDetail: vi.fn(),
}))

const mockGetAdministrativeDetail = vi.mocked(getGovernedAdministrativeEventDetail)
const mockGetInfrastructureDetail = vi.mocked(getGovernedInfrastructureEventDetail)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('governed event details', () => {
  it('renders the complete released administrative attribution and RFC 8693 axes', async () => {
    mockGetAdministrativeDetail.mockResolvedValue({
      eventId: 'admin-event-1',
      occurredAt: '2026-07-14T11:00:00.000Z',
      ingestedAt: '2026-07-14T11:00:01.000Z',
      action: 'resource_mutation',
      outcome: 'succeeded',
      operatorHuman: {
        status: 'verified',
        principalKind: 'platform_user',
        principalId: 'user-1',
        subject: 'operator-sub-1',
        userId: 'user-1',
        displayName: 'Alice Operator',
        identityIssuer: 'https://issuer.example',
      },
      delegatedActor: { subject: 'agent-sub-1' },
      evidenceProducer: {
        sourceKind: 'control_plane',
        sourceService: 'control-api',
        serviceSub: 'service:control-api',
      },
      authorization: {
        resourceAud: 'control-api://admin',
        effectiveScopes: ['admin:write', 'users:write'],
        tokenExchangeId: 'exchange-reference-1',
        decision: 'allow',
        decisionActorSub: 'operator-sub-1',
        approvalRequestId: 'approval-1',
        operationId: 'operation-1',
        requestId: 'request-1',
        relatedRunId: 'run-1',
      },
      context: {
        environment: 'minikube',
        namespace: 'control-plane',
        deploymentRef: 'control-api',
        teamId: 'team-1',
        teamDisplayName: 'Operations',
      },
      provenance: {
        sourceAuditRef: 'audit-1',
        sourceAdapterKind: 'rest',
        sourceAdapterVersion: 'v1',
        codeDigest: 'a'.repeat(64),
        configDigest: 'b'.repeat(64),
        policyDigest: 'c'.repeat(64),
        authorizationRef: 'authorization-1',
        effectRef: 'effect-1',
        preStateDigest: 'd'.repeat(64),
        postStateDigest: 'e'.repeat(64),
        payloadSha256: 'f'.repeat(64),
      },
      targetResource: { type: 'resource', ref: 'user-2' },
      targetHuman: {
        status: 'verified',
        principalKind: 'platform_user',
        principalId: 'user-2',
        subject: 'target-sub-2',
        userId: 'user-2',
        displayName: 'Bob Target',
        identityIssuer: 'https://issuer.example',
      },
      safeFields: { approval_state: 'approved' },
    })

    render(<AdministrativeEventDetail eventId="admin-event-1" />)

    await waitFor(() => expect(screen.getByText('Provenance chain')).toBeInTheDocument())
    expect(screen.getByText('Control API')).toBeInTheDocument()
    expect(screen.getAllByText('Principal: Platform user')).toHaveLength(2)
    expect(screen.getByText('Subject: operator-sub-1')).toBeInTheDocument()
    expect(screen.getByText('Platform user ID: user-1')).toBeInTheDocument()
    expect(screen.getByText('Kind: control_plane')).toBeInTheDocument()
    expect(screen.getByText('Service subject: service:control-api')).toBeInTheDocument()
    expect(screen.getByText('control-api://admin')).toBeInTheDocument()
    expect(screen.getByText('admin:write, users:write')).toBeInTheDocument()
    expect(screen.getByText('exchange-reference-1')).toBeInTheDocument()
    expect(screen.getByText('approval-1')).toBeInTheDocument()
    expect(screen.getByText('Stored details and provenance')).toBeInTheDocument()
    expect(screen.getByText('audit-1')).toBeInTheDocument()
    expect(screen.getByText('authorization-1')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Bob Target' })).toHaveAttribute(
      'href',
      '/users-and-teams/users/user-2'
    )
    expect(document.body.textContent).not.toContain('Bearer forbidden-token-sentinel')
  })

  it('renders persisted infrastructure source, scope, capacity, usage, and correlation facts', async () => {
    mockGetInfrastructureDetail.mockResolvedValue({
      eventId: 'infra-event-1',
      occurredAt: '2026-07-14T11:00:00.000Z',
      ingestedAt: '2026-07-14T11:00:01.000Z',
      telemetryType: 'capacity_sample',
      outcome: 'succeeded',
      reasonCode: 'scheduled_sample',
      triggerKind: 'periodic_sample',
      source: {
        sourceKind: 'infrastructure_controller',
        sourceService: 'host-context-controller',
        controller: 'host-context-controller',
        sourceOccurrenceId: 'occurrence-1',
        sourceAdapterKind: 'kubernetes_watch',
        sourceAdapterVersion: 'v1',
      },
      scope: {
        environment: 'minikube',
        clusterName: 'minikube-branch',
        namespace: 'control-plane',
        workloadKind: 'Deployment',
        workloadRef: 'control-api',
        kubernetesKind: 'Deployment',
        kubernetesName: 'control-api',
        kubernetesUid: 'uid-1',
        metadataGeneration: '7',
      },
      correlation: {
        operationId: 'operation-1',
        runId: 'run-1',
        authorizationRef: 'authorization-1',
        effectRef: 'effect-1',
      },
      interval: {
        start: '2026-07-14T10:55:00.000Z',
        end: '2026-07-14T11:00:00.000Z',
      },
      capacity: {
        desiredReplicas: 2,
        observedReplicas: 2,
        readyReplicas: 2,
        cpuRequestCores: '0.5',
        cpuLimitCores: '1',
        memoryRequestBytes: '536870912',
        memoryLimitBytes: '1073741824',
      },
      usage: {
        cpuUsageCoreSeconds: '12.5',
        memoryUsageByteSeconds: '1048576000',
      },
      integrity: {
        codeDigest: 'a'.repeat(64),
        configDigest: 'b'.repeat(64),
        policyDigest: 'c'.repeat(64),
        preStateDigest: 'd'.repeat(64),
        postStateDigest: 'e'.repeat(64),
        payloadSha256: 'f'.repeat(64),
      },
      safeFields: { pricing_basis: 'requested_capacity' },
    })

    render(<InfrastructureEventDetail eventId="infra-event-1" />)

    await waitFor(() => expect(screen.getByText('Source and object scope')).toBeInTheDocument())
    expect(screen.getByText('infrastructure_controller')).toBeInTheDocument()
    expect(screen.getByText('minikube')).toBeInTheDocument()
    expect(screen.getByText('periodic_sample')).toBeInTheDocument()
    expect(screen.getByText('occurrence-1')).toBeInTheDocument()
    expect(screen.getByText('kubernetes_watch / v1')).toBeInTheDocument()
    expect(screen.getByText('minikube-branch / control-plane')).toBeInTheDocument()
    expect(screen.getAllByText('operation-1').length).toBeGreaterThan(0)
    expect(screen.getByText('Capacity and sampling inputs')).toBeInTheDocument()
    expect(screen.getByText('12.5')).toBeInTheDocument()
    expect(screen.getByText('1048576000')).toBeInTheDocument()
    expect(screen.getByText('Stored integrity evidence')).toBeInTheDocument()
    expect(screen.getByText('f'.repeat(64))).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('private-key-sentinel')
  })

  it('renders a new local Control UI event with verified admin authority and no false gaps', async () => {
    mockGetAdministrativeDetail.mockResolvedValue({
      eventId: 'admin-event-2',
      occurredAt: '2026-07-14T11:00:00.000Z',
      ingestedAt: '2026-07-14T11:00:01.000Z',
      action: 'permission_grant',
      outcome: 'committed',
      operatorHuman: {
        status: 'verified',
        principalKind: 'control_admin',
        principalId: 'admin-1',
        subject: 'admin-1',
        userId: null,
        displayName: 'Control Operator',
        identityIssuer: 'control-api',
      },
      delegatedActor: { subject: null },
      evidenceProducer: {
        sourceKind: 'control_api_local',
        sourceService: 'control-api',
        serviceSub: 'control-api',
      },
      authorization: {
        resourceAud: 'control-ui',
        effectiveScopes: [],
        tokenExchangeId: null,
        decision: 'allow',
        decisionActorSub: 'admin-1',
        approvalRequestId: null,
        operationId: 'operation-2',
        requestId: null,
        relatedRunId: null,
      },
      context: {
        environment: 'minikube',
        namespace: 'sandbox-recipes',
        deploymentRef: null,
        teamId: null,
        teamDisplayName: null,
      },
      provenance: {
        sourceAuditRef: 'audit-2',
        sourceAdapterKind: null,
        sourceAdapterVersion: null,
        codeDigest: null,
        configDigest: null,
        policyDigest: null,
        authorizationRef: null,
        effectRef: null,
        preStateDigest: null,
        postStateDigest: null,
        payloadSha256: 'f'.repeat(64),
      },
      targetResource: { type: 'permission', ref: 'workflow_recipe:test/example' },
      targetHuman: {
        status: 'unavailable',
        principalKind: 'system',
        principalId: null,
        subject: null,
        userId: null,
        displayName: null,
        identityIssuer: null,
      },
      safeFields: {
        resource_class: 'gfs_folder_grant',
        status: 'grant_configured',
        detail_ref: 'gfs_permissions/read.write',
        target_principal_kind: 'host',
        target_principal_ref: 'host:1st:mcp-host/chatllm',
      },
    })

    render(<AdministrativeEventDetail eventId="admin-event-2" />)

    await waitFor(() => expect(screen.getByText('Control Operator')).toBeInTheDocument())
    expect(screen.getByText('Principal: Control UI administrator')).toBeInTheDocument()
    expect(screen.getByText('Not delegated (local Control UI action)')).toBeInTheDocument()
    expect(screen.getByText('control-ui')).toBeInTheDocument()
    expect(screen.getByText('No delegated scopes (administrator role)')).toBeInTheDocument()
    expect(screen.getByText('allow')).toBeInTheDocument()
    expect(screen.getByText('Control Operator · admin-1')).toBeInTheDocument()
    expect(screen.getByText('Read, Write')).toBeInTheDocument()
    expect(screen.getByText('Target principal')).toBeInTheDocument()
    expect(screen.getByText(/Target Host:/)).toBeInTheDocument()
    expect(screen.getAllByText('host:1st:mcp-host/chatllm')).toHaveLength(2)
    expect(document.body.textContent).not.toContain('Not recorded by legacy producer')
  })
})
