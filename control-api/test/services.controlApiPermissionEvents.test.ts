import { beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
import { runWithAdministrativeRequestContext } from '../src/services/tracing/adminOperationContext.js'
import { assertSafeEventPayload } from '../src/services/tracing/append.js'
import { appendControlApiPermissionEventsInTransaction } from '../src/services/tracing/controlApiPermissionEvents.js'

const eventAppender = vi.hoisted(() => ({ appendMany: vi.fn() }))

vi.mock('../src/services/tracing/administrativeEvents.js', () => ({
  AdministrativeEventService: class {
    appendManyInTransaction = eventAppender.appendMany
  },
}))

const ADMIN_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const TEAM_ID = '33333333-3333-4333-8333-333333333333'

describe('appendControlApiPermissionEventsInTransaction', () => {
  const db = { query: vi.fn() }

  beforeEach(() => {
    eventAppender.appendMany.mockReset()
    eventAppender.appendMany.mockResolvedValue([])
  })

  it('binds each affected principal to one governed event and preserves admin request authority', async () => {
    await runWithAdministrativeRequestContext(
      { operatorSub: ADMIN_ID, requestId: 'request-1' },
      () =>
        appendControlApiPermissionEventsInTransaction(db, {
          operatorSub: ADMIN_ID,
          operationId: '44444444-4444-4444-8444-444444444444',
          dependencies: {
            now: () => new Date('2026-07-14T12:00:00.000Z'),
            newEventId: () => '55555555-5555-4555-8555-555555555555',
          },
          changes: [
            {
              action: 'grant',
              resourceClass: 'agent_access',
              resourceRef: 'agent:chatllm',
              subject: { kind: 'user', id: USER_ID },
            },
            {
              action: 'revoke',
              resourceClass: 'workflow_approval_target',
              resourceRef: 'workflow_approval_target:sandbox-recipes/example',
              subject: { kind: 'team', id: TEAM_ID },
              namespace: 'sandbox-recipes',
            },
            {
              action: 'grant',
              resourceClass: 'gfs_folder_grant',
              resourceRef: 'gfs://main/folder-1',
              subject: {
                kind: 'service',
                id: 'host:1st:mcp-host/chatllm',
                principalKind: 'host',
              },
            },
          ],
        })
    )

    expect(eventAppender.appendMany).toHaveBeenCalledOnce()
    const [, principal, entries] = eventAppender.appendMany.mock.calls[0]!
    expect(principal).toEqual(
      expect.objectContaining({
        kind: 'control_api_local',
        sourceService: 'control-api',
        serviceSub: 'access-administration',
      })
    )
    expect(entries).toEqual([
      expect.objectContaining({
        binding: expect.objectContaining({
          action: 'permission_grant',
          authorizationDecision: 'allow',
          decisionActorSub: ADMIN_ID,
          operatorSub: ADMIN_ID,
          operatorUserId: ADMIN_ID,
          requestId: 'request-1',
          identityIssuer: config.adminJwtIssuer,
          resourceAud: config.adminJwtAudience,
          targetHumanSub: USER_ID,
          targetUserId: USER_ID,
          teamId: null,
        }),
        input: expect.objectContaining({
          occurredAt: '2026-07-14T12:00:00.000Z',
          payload: expect.objectContaining({
            resource_class: 'agent_access',
          }),
        }),
      }),
      expect.objectContaining({
        binding: expect.objectContaining({
          action: 'permission_revoke',
          namespace: 'sandbox-recipes',
          targetHumanSub: null,
          targetUserId: null,
          teamId: TEAM_ID,
        }),
        input: expect.objectContaining({
          payload: expect.objectContaining({
            resource_class: 'workflow_approval_target',
          }),
        }),
      }),
      expect.objectContaining({
        binding: expect.objectContaining({
          targetHumanSub: null,
          targetUserId: null,
          teamId: null,
        }),
        input: expect.objectContaining({
          payload: expect.objectContaining({
            target_principal_kind: 'host',
            target_principal_ref: 'host:1st:mcp-host/chatllm',
          }),
        }),
      }),
    ])
    for (const entry of entries) {
      expect(() => assertSafeEventPayload(entry.input.payload)).not.toThrow()
    }
  })

  it('uses the platform-session authority for an external authenticated manager', async () => {
    await appendControlApiPermissionEventsInTransaction(db, {
      operatorSub: USER_ID,
      operationId: '66666666-6666-4666-8666-666666666666',
      changes: [
        {
          action: 'grant',
          resourceClass: 'team_membership',
          resourceRef: `team_membership:${TEAM_ID}:role:member`,
          subject: { kind: 'user', id: ADMIN_ID },
        },
      ],
    })

    const [, , entries] = eventAppender.appendMany.mock.calls[0]!
    expect(entries[0].binding).toEqual(
      expect.objectContaining({
        identityIssuer: config.jwtIssuer,
        operatorSub: USER_ID,
        operatorUserId: USER_ID,
        requestId: null,
        resourceAud: config.jwtAudience,
        targetHumanSub: ADMIN_ID,
        targetUserId: ADMIN_ID,
      })
    )
  })

  it('records WRC as a technical principal without coercing its subject into a user UUID', async () => {
    const internalPrincipal = {
      kind: 'wrc_internal_control',
      sourceService: 'workflow-recipes',
      serviceSub: 'wrc-provisioner',
      credentialId: 'wrc-jti-1',
      allowedKinds: ['linked_outcome', 'service_action'],
    } as const

    await appendControlApiPermissionEventsInTransaction(db, {
      operatorSub: 'wrc-provisioner',
      internalPrincipal,
      changes: [
        {
          action: 'revoke',
          resourceClass: 'plugin_workload_sdk_access',
          resourceRef: 'plugin_workload_sdk:sandbox-recipes/example:promptBridge',
          subject: { kind: 'service', id: 'promptBridge' },
          namespace: 'sandbox-recipes',
        },
      ],
    })

    const [, principal, entries] = eventAppender.appendMany.mock.calls[0]!
    expect(principal).toBe(internalPrincipal)
    expect(entries[0].binding).toEqual(
      expect.objectContaining({
        operatorSub: 'wrc-provisioner',
        operatorUserId: null,
        identityIssuer: 'wrc',
        resourceAud: 'control-api',
        decisionActorSub: 'wrc-provisioner',
      })
    )
  })

  it('fails closed when an internal principal does not match operatorSub', async () => {
    await expect(
      appendControlApiPermissionEventsInTransaction(db, {
        operatorSub: 'different-service',
        internalPrincipal: {
          kind: 'wrc_internal_control',
          sourceService: 'workflow-recipes',
          serviceSub: 'wrc-provisioner',
          credentialId: 'wrc-jti-1',
          allowedKinds: ['linked_outcome', 'service_action'],
        },
        changes: [
          {
            action: 'revoke',
            resourceClass: 'plugin_workload_sdk_access',
            resourceRef: 'plugin_workload_sdk:sandbox-recipes/example:promptBridge',
            subject: { kind: 'service', id: 'promptBridge' },
          },
        ],
      })
    ).rejects.toThrow(/principal does not match operatorSub/)
    expect(eventAppender.appendMany).not.toHaveBeenCalled()
  })

  it('does not append a synthetic event when the mutation produced no diff', async () => {
    await expect(
      appendControlApiPermissionEventsInTransaction(db, {
        operatorSub: ADMIN_ID,
        changes: [],
      })
    ).resolves.toBeNull()
    expect(eventAppender.appendMany).not.toHaveBeenCalled()
  })

  it('keeps large permission replacements atomic while respecting append batch limits', async () => {
    const changes = Array.from({ length: 101 }, (_, index) => ({
      action: 'grant' as const,
      resourceClass: 'workflow_trigger_access',
      resourceRef: 'workflow_recipe:sandbox-recipes/example',
      subject: {
        kind: 'user' as const,
        id: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
      },
    }))

    await appendControlApiPermissionEventsInTransaction(db, {
      operatorSub: ADMIN_ID,
      operationId: '77777777-7777-4777-8777-777777777777',
      changes,
    })

    expect(eventAppender.appendMany).toHaveBeenCalledTimes(2)
    expect(eventAppender.appendMany.mock.calls[0]?.[2]).toHaveLength(100)
    expect(eventAppender.appendMany.mock.calls[1]?.[2]).toHaveLength(1)
    expect(eventAppender.appendMany.mock.calls[1]?.[2]?.[0]?.input.sourceEventId).toBe(
      'control-api:permission:77777777-7777-4777-8777-777777777777:100'
    )
  })
})
