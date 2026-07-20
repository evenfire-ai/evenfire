import { describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../src/db.js'
import {
  PostgresAdministrativeIntentLookup,
  administrativeIntentLookupKey,
} from '../src/services/tracing/adminOperationService.js'

describe('PostgresAdministrativeIntentLookup', () => {
  it('reads tenant attribution from the canonical governed event stream', async () => {
    const operationId = '11111111-1111-4111-8111-111111111111'
    const input = {
      operationId,
      targetRef: 'mcp-host/chatllm',
      namespace: 'mcp-host',
    }
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          operation_id: operationId,
          target_ref: input.targetRef,
          namespace: input.namespace,
          operator_sub: 'operator-1',
          request_id: 'request-1',
          environment: 'test',
          tenant_id: 'tenant-1',
          team_id: 'team-1',
          identity_issuer: 'https://issuer.example.test',
          operator_user_id: '22222222-2222-4222-8222-222222222222',
          resource_aud: 'control-api',
          effective_scopes: ['host:write'],
          token_exchange_id: '33333333-3333-4333-8333-333333333333',
          authorization_decision: 'allow',
          decision_actor_sub: 'operator-1',
        },
      ],
      rowCount: 1,
    })

    const found = await new PostgresAdministrativeIntentLookup({
      query,
    } as unknown as DbClient).findHostIntents([input])

    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('JOIN governed_event_stream stream')
    expect(sql).toContain("stream.event_family = 'administrative'")
    expect(sql).toContain('stream.tenant_id')
    expect(sql).not.toContain('events.tenant_id')
    expect(parameters).toEqual([
      JSON.stringify([
        {
          operation_id: operationId,
          target_ref: input.targetRef,
          namespace: input.namespace,
        },
      ]),
    ])
    expect(found.get(administrativeIntentLookupKey(input))).toEqual({
      operatorSub: 'operator-1',
      requestId: 'request-1',
      environment: 'test',
      tenantId: 'tenant-1',
      teamId: 'team-1',
      identityIssuer: 'https://issuer.example.test',
      operatorUserId: '22222222-2222-4222-8222-222222222222',
      resourceAud: 'control-api',
      effectiveScopes: ['host:write'],
      tokenExchangeId: '33333333-3333-4333-8333-333333333333',
      authorizationDecision: 'allow',
      decisionActorSub: 'operator-1',
    })
  })
})
