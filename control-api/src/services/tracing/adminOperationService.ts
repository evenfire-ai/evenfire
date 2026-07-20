import { randomUUID } from 'crypto'
import type { DbClient } from '../../db.js'
import {
  ADMINISTRATIVE_INTENT_ANNOTATION,
  ADMINISTRATIVE_INTENT_GENERATION_ANNOTATION,
} from './adminOperationConstants.js'
import { AdministrativeEventService } from './administrativeEvents.js'
import type {
  AdministrativeEventInputV1,
  AdministrativeServerBindingV1,
  ControlApiLocalAdministrativePrincipalV1,
  TracingServiceDependencies,
} from './contracts.js'
import { canonicalTracingEnvironment } from './environment.js'

export type HostAdministrativeAction = 'create' | 'update' | 'config' | 'delete'
export type HostAdministrativeOutcome = 'succeeded' | 'failed'

type HostAdministrativeIntentAttribution = {
  operatorSub: string
  requestId: string | null
  environment: string
  tenantId: string | null
  teamId: string | null
  identityIssuer: string | null
  operatorUserId: string | null
  resourceAud: string | null
  effectiveScopes: string[]
  tokenExchangeId: string | null
  authorizationDecision: AdministrativeServerBindingV1['authorizationDecision']
  decisionActorSub: string | null
}

export type HostAdministrativeIntent = {
  operationId: string
  action: HostAdministrativeAction
  targetRef: string
  namespace: string
  operatorSub: string
  requestId: string | null
}

const CONTROL_API_HOST_ADMINISTRATIVE_PRINCIPAL = {
  kind: 'control_api_local',
  sourceService: 'control-api',
  serviceSub: 'host-administration',
  credentialId: 'control-api-local',
  allowedKinds: ['intent', 'linked_outcome'],
} as const satisfies ControlApiLocalAdministrativePrincipalV1

export interface AdministrativeIntentLookup {
  findHostIntent(input: {
    operationId: string
    targetRef: string
    namespace: string
  }): Promise<HostAdministrativeIntentAttribution | null>
  findHostIntents(
    inputs: readonly {
      operationId: string
      targetRef: string
      namespace: string
    }[]
  ): Promise<ReadonlyMap<string, HostAdministrativeIntentAttribution>>
}

export function administrativeIntentLookupKey(input: {
  operationId: string
  targetRef: string
  namespace: string
}): string {
  return `${input.operationId}:${input.namespace}:${input.targetRef}`
}

export class PostgresAdministrativeIntentLookup implements AdministrativeIntentLookup {
  constructor(private readonly db: DbClient) {}

  async findHostIntent(input: { operationId: string; targetRef: string; namespace: string }) {
    return (await this.findHostIntents([input])).get(administrativeIntentLookupKey(input)) ?? null
  }

  async findHostIntents(
    inputs: readonly {
      operationId: string
      targetRef: string
      namespace: string
    }[]
  ) {
    if (inputs.length === 0) return new Map()
    const result = await this.db.query(
      `WITH requested AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(
           operation_id uuid, target_ref text, namespace text
         )
       )
       SELECT events.operation_id::text, events.target_ref, events.namespace,
              events.operator_sub, events.request_id, events.environment,
              stream.tenant_id, events.team_id, events.identity_issuer,
              events.operator_user_id::text, events.resource_aud,
              events.effective_scopes, events.token_exchange_id::text,
              events.authorization_decision, events.decision_actor_sub
         FROM administrative_events events
         JOIN governed_event_stream stream
           ON stream.event_family = 'administrative'
          AND stream.event_id = events.event_id
         JOIN requested
           ON requested.operation_id = events.operation_id
          AND requested.target_ref = events.target_ref
          AND requested.namespace = events.namespace
        WHERE events.operation_id IS NOT NULL
          AND events.event_kind = 'intent'
          AND events.action = 'host_mutation'
          AND events.target_type = 'host'
        ORDER BY events.operation_id`,
      [
        JSON.stringify(
          inputs.map(input => ({
            operation_id: input.operationId,
            target_ref: input.targetRef,
            namespace: input.namespace,
          }))
        ),
      ]
    )
    const found = new Map<string, HostAdministrativeIntentAttribution>()
    for (const row of result.rows as Array<Record<string, unknown>>) {
      if (typeof row.operator_sub !== 'string' || typeof row.environment !== 'string') continue
      const key = administrativeIntentLookupKey({
        operationId: String(row.operation_id),
        targetRef: String(row.target_ref),
        namespace: String(row.namespace),
      })
      found.set(key, {
        operatorSub: row.operator_sub,
        requestId: typeof row.request_id === 'string' ? row.request_id : null,
        environment: row.environment,
        tenantId: typeof row.tenant_id === 'string' ? row.tenant_id : null,
        teamId: typeof row.team_id === 'string' ? row.team_id : null,
        identityIssuer: typeof row.identity_issuer === 'string' ? row.identity_issuer : null,
        operatorUserId: typeof row.operator_user_id === 'string' ? row.operator_user_id : null,
        resourceAud: typeof row.resource_aud === 'string' ? row.resource_aud : null,
        effectiveScopes: Array.isArray(row.effective_scopes)
          ? row.effective_scopes.map(String)
          : [],
        tokenExchangeId: typeof row.token_exchange_id === 'string' ? row.token_exchange_id : null,
        authorizationDecision:
          row.authorization_decision === 'allow' ||
          row.authorization_decision === 'deny' ||
          row.authorization_decision === 'require_approval' ||
          row.authorization_decision === 'not_applicable'
            ? row.authorization_decision
            : null,
        decisionActorSub:
          typeof row.decision_actor_sub === 'string' ? row.decision_actor_sub : null,
      })
    }
    return found
  }
}

export class ControlApiAdministrativeOperationService {
  private readonly events: AdministrativeEventService
  private readonly now: () => Date
  private readonly newOperationId: () => string
  private readonly environment = canonicalTracingEnvironment()

  constructor(
    dependencies: TracingServiceDependencies & {
      newOperationId?: () => string
    }
  ) {
    this.events = new AdministrativeEventService(dependencies)
    this.now = dependencies.now ?? (() => new Date())
    this.newOperationId = dependencies.newOperationId ?? randomUUID
  }

  async persistHostIntent(input: {
    action: HostAdministrativeAction
    namespace: string
    name: string
    operatorSub: string
    requestId: string | null
  }): Promise<HostAdministrativeIntent> {
    const operationId = this.newOperationId()
    const intent: HostAdministrativeIntent = {
      operationId,
      action: input.action,
      namespace: input.namespace,
      targetRef: `${input.namespace}/${input.name}`,
      operatorSub: input.operatorSub,
      requestId: input.requestId,
    }
    await this.events.append(
      CONTROL_API_HOST_ADMINISTRATIVE_PRINCIPAL,
      this.binding(intent, 'attempted'),
      this.input(intent, 'intent', 'attempted')
    )
    return intent
  }

  async persistHostOutcome(
    intent: HostAdministrativeIntent,
    outcome: HostAdministrativeOutcome,
    reasonCode: string
  ): Promise<void> {
    await this.events.append(
      CONTROL_API_HOST_ADMINISTRATIVE_PRINCIPAL,
      this.binding(intent, outcome),
      this.input(intent, 'linked_outcome', outcome, reasonCode)
    )
  }

  private binding(
    intent: HostAdministrativeIntent,
    outcome: 'attempted' | HostAdministrativeOutcome
  ): AdministrativeServerBindingV1 {
    return {
      action: 'host_mutation',
      outcome,
      operatorSub: intent.operatorSub,
      operationId: intent.operationId,
      relatedRunId: null,
      requestId: intent.requestId,
      targetType: 'host',
      targetRef: intent.targetRef,
      environment: this.environment,
      tenantId: null,
      teamId: null,
      namespace: intent.namespace,
      sourceAuditRef: null,
    }
  }

  private input(
    intent: HostAdministrativeIntent,
    kind: AdministrativeEventInputV1['kind'],
    outcome: string,
    reasonCode = outcome
  ): AdministrativeEventInputV1 {
    return {
      kind,
      sourceEventId: `control-api:host:${intent.action}:${intent.operationId}:${kind}:${outcome}`,
      occurredAt: this.now().toISOString(),
      reasonCode,
      sourceStatusRef: `host:${intent.targetRef}`,
      payload: {
        resource_class: 'Host',
        status: outcome,
      },
    }
  }
}

export function stripAdministrativeIntentAnnotation<
  T extends { annotations?: Record<string, string> },
>(metadata: T | undefined): T | undefined {
  if (
    !metadata?.annotations ||
    (!(ADMINISTRATIVE_INTENT_ANNOTATION in metadata.annotations) &&
      !(ADMINISTRATIVE_INTENT_GENERATION_ANNOTATION in metadata.annotations))
  ) {
    return metadata
  }
  const {
    [ADMINISTRATIVE_INTENT_ANNOTATION]: _ignoredId,
    [ADMINISTRATIVE_INTENT_GENERATION_ANNOTATION]: _ignoredGeneration,
    ...annotations
  } = metadata.annotations
  return { ...metadata, annotations }
}

export function withAdministrativeIntentAnnotation(
  annotations: Record<string, string> | undefined,
  intent: HostAdministrativeIntent,
  expectedGeneration: number
): Record<string, string> {
  return {
    ...(annotations ?? {}),
    [ADMINISTRATIVE_INTENT_ANNOTATION]: intent.operationId,
    [ADMINISTRATIVE_INTENT_GENERATION_ANNOTATION]: String(expectedGeneration),
  }
}
