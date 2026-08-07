import { createHash, randomUUID } from 'node:crypto'
import type { DbClient } from '../../db.js'
import type { LlmUsageEvent, UsageSourceKind } from '../usageEvents.js'
import type { WorkflowRunBinding } from '../workflowRunBindingRepository.js'
import { pendingGovernedAgentRunEventFromEnvelope } from './agentRunEvents.js'
import {
  type PendingGovernedEvent,
  appendGovernedEventBatchInTransaction,
  canonicalPayloadSha256,
  normalizeIsoTimestamp,
} from './append.js'
import type { PendingAgentRunEventEnvelopeV1 } from './contracts.js'
import { DirectRunBindingConflictError } from './directRunAttributionBindingService.js'
import { canonicalTracingEnvironment } from './environment.js'

export type UsageProjectionContext = {
  recipeNamespace: string
  recipeName: string
  hostRef: string
  environment?: string
}

type UsageProjectionDependencies = {
  now?: () => Date
  newEventId?: () => string
  appendBatch?: (
    db: DbClient,
    events: readonly [PendingGovernedEvent<'agent_run'>, ...PendingGovernedEvent<'agent_run'>[]]
  ) => Promise<unknown>
}

type TokenUsagePayload = {
  request_ref: string
  provider: string
  model: string
  source_kind: UsageSourceKind
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cache_tokens_reported: boolean
  iteration?: number
  prompt_bridge?: {
    invocation_id: string
    attempt_generation: number
    target_ref: string
    fallback_used: boolean
    attempt_count: number
    provider_attempt_id: string
    provider_attempt_index: number
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function actorId(binding: WorkflowRunBinding): string | null {
  return binding.actorType === 'user' || binding.actorType === 'admin' ? binding.actorId : null
}

function tokenUsagePayload(usage: LlmUsageEvent): TokenUsagePayload {
  return {
    request_ref: sha256(usage.request_id.toLowerCase()),
    provider: usage.provider,
    model: usage.model,
    source_kind: usage.source_kind,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_tokens: usage.cache_read_tokens,
    cache_write_tokens: usage.cache_write_tokens,
    cache_tokens_reported: usage.cache_tokens_reported,
    ...(usage.iteration === null ? {} : { iteration: usage.iteration }),
    ...(usage.prompt_bridge_metadata?.invocation_id &&
    usage.prompt_bridge_metadata.attempt_generation !== undefined &&
    usage.prompt_bridge_metadata.provider_attempt_id &&
    usage.prompt_bridge_metadata.provider_attempt_index !== undefined
      ? {
          prompt_bridge: {
            invocation_id: usage.prompt_bridge_metadata.invocation_id,
            attempt_generation: usage.prompt_bridge_metadata.attempt_generation,
            target_ref: usage.prompt_bridge_metadata.target_ref,
            fallback_used: usage.prompt_bridge_metadata.fallback_used,
            attempt_count: usage.prompt_bridge_metadata.attempt_count,
            provider_attempt_id: usage.prompt_bridge_metadata.provider_attempt_id!,
            provider_attempt_index: usage.prompt_bridge_metadata.provider_attempt_index!,
          },
        }
      : {}),
  }
}

type NonWorkflowRunBinding = {
  runId: string
  sessionId: string | null
  rootSpanId: string
  origin: 'direct_chat' | 'channel_event' | 'api'
  actorMedium: 'desktop' | 'channel' | 'api' | 'unknown'
  identityIssuer: string | null
  actorHumanSub: string | null
  agentSub: string
  teamId: string | null
  userId: string | null
  recipeNamespace: string | null
  recipeName: string | null
  hostRef: string
}

type TokenUsageEnvelopeBinding = {
  runId: string
  sessionId: string | null
  spanId: string
  parentSpanId: string
  origin: 'workflow_runtime' | 'direct_chat' | 'channel_event' | 'api'
  identityIssuer: string | null
  actorHumanSub: string | null
  agentSub: string
  actorMedium: 'workflow' | 'desktop' | 'channel' | 'api' | 'unknown'
  approvalRequestId: string | null
  teamId: string | null
  userId: string | null
  recipeNamespace: string | null
  recipeName: string | null
  hostRef: string
}

function pendingTokenUsageEvent(input: {
  usage: LlmUsageEvent
  binding: TokenUsageEnvelopeBinding
  canonicalBinding: Record<string, unknown>
  environment: string
  now: () => Date
  newEventId: () => string
}): PendingGovernedEvent<'agent_run'> {
  const sourceEventId = input.usage.request_id.toLowerCase()
  const occurredAt = normalizeIsoTimestamp(input.usage.ts, 'usage.ts')
  const ingestedAt = input.now().toISOString()
  const payload = tokenUsagePayload(input.usage)
  const canonical = {
    family: 'agent_run',
    sourceService: 'mcp-host',
    sourceKind: 'mcp_host_runtime',
    sourceEventId,
    occurredAt,
    eventType: 'token_usage',
    binding: input.canonicalBinding,
    payload,
  }
  const envelope: PendingAgentRunEventEnvelopeV1<TokenUsagePayload> = {
    eventId: input.newEventId(),
    schemaVersion: 1,
    sourceKind: 'mcp_host_runtime',
    sourceService: 'mcp-host',
    sourceEventId,
    runId: input.binding.runId,
    sessionId: input.binding.sessionId,
    spanId: input.binding.spanId,
    parentSpanId: input.binding.parentSpanId,
    origin: input.binding.origin,
    eventType: 'token_usage',
    outcome: 'succeeded',
    identityIssuer: input.binding.identityIssuer,
    actorHumanSub: input.binding.actorHumanSub,
    actorMedium: input.binding.actorMedium,
    agentSub: input.binding.agentSub,
    resourceAud: null,
    effectiveScopes: [],
    decision: 'not_applicable',
    decisionSourceKind: null,
    decisionSourceRef: null,
    decisionActorSub: null,
    approvalRequestId: input.binding.approvalRequestId,
    tokenExchangeId: null,
    hostRef: input.binding.hostRef,
    recipeNamespace: input.binding.recipeNamespace,
    recipeName: input.binding.recipeName,
    teamId: input.binding.teamId,
    userId: input.binding.userId,
    durationMs: null,
    payload,
    payloadSha256: canonicalPayloadSha256(canonical),
    occurredAt,
    ingestedAt,
  }
  return pendingGovernedAgentRunEventFromEnvelope(envelope, {
    environment: input.environment,
    tenantId: null,
  })
}

function pendingWorkflowUsageEvent(
  usage: LlmUsageEvent,
  binding: WorkflowRunBinding,
  context: UsageProjectionContext,
  now: () => Date,
  newEventId: () => string
): PendingGovernedEvent<'agent_run'> {
  const environment = context.environment ?? canonicalTracingEnvironment()
  const runId = usage.run_id?.toLowerCase()
  if (!runId || binding.runId.toLowerCase() !== runId) {
    throw new Error(`accepted workflow usage ${usage.request_id} has no trusted run binding`)
  }
  if (
    binding.recipeNamespace !== context.recipeNamespace ||
    binding.recipeName !== context.recipeName ||
    usage.host_ref !== context.hostRef
  ) {
    throw new Error(
      `accepted workflow usage ${usage.request_id} does not match its submitter binding`
    )
  }

  const rootSpanId = sha256(`workflow-run:${runId}:root`)
  const spanId = sha256(`workflow-run:${runId}:token-usage:${usage.request_id.toLowerCase()}`)
  const humanActorId = actorId(binding)
  const teamId = binding.usageTeamId ?? binding.teamId
  return pendingTokenUsageEvent({
    usage,
    environment,
    now,
    newEventId,
    binding: {
      runId,
      sessionId: null,
      spanId,
      parentSpanId: rootSpanId,
      origin: 'workflow_runtime',
      identityIssuer: null,
      actorHumanSub: humanActorId,
      agentSub: `workflow-recipe:${binding.recipeNamespace}/${binding.recipeName}`,
      actorMedium: 'workflow',
      approvalRequestId: binding.approvalRequestId,
      teamId,
      userId: humanActorId,
      recipeNamespace: binding.recipeNamespace,
      recipeName: binding.recipeName,
      hostRef: context.hostRef,
    },
    canonicalBinding: {
      runId,
      spanId,
      parentSpanId: rootSpanId,
      recipeNamespace: binding.recipeNamespace,
      recipeName: binding.recipeName,
      teamId,
      actorHumanSub: humanActorId,
      hostRef: context.hostRef,
    },
  })
}

/**
 * SDK-only calls have no workflow run, but they still need a governed,
 * invocation-anchored usage event. The server-issued invocation UUID is used
 * as the run identity for this direct API lane; it is never supplied by the
 * workload and is already bound to the recipe JWT and attempt receipt.
 */
function pendingSdkOnlyUsageEvent(
  usage: LlmUsageEvent,
  context: UsageProjectionContext,
  now: () => Date,
  newEventId: () => string
): PendingGovernedEvent<'agent_run'> {
  const metadata = usage.prompt_bridge_metadata
  const invocationId = metadata?.invocation_id
  if (!invocationId) {
    throw new Error(`accepted SDK-only usage ${usage.request_id} has no invocation binding`)
  }
  return pendingTokenUsageEvent({
    usage,
    environment: context.environment ?? canonicalTracingEnvironment(),
    now,
    newEventId,
    binding: {
      runId: invocationId,
      sessionId: null,
      spanId: sha256(`plugin-sdk:${invocationId}:token-usage:${usage.request_id.toLowerCase()}`),
      parentSpanId: sha256(`plugin-sdk:${invocationId}:root`),
      origin: 'api',
      identityIssuer: 'control-api',
      actorHumanSub: null,
      agentSub: `plugin-workload-sdk:${context.recipeNamespace}/${context.recipeName}`,
      actorMedium: 'api',
      approvalRequestId: null,
      teamId: null,
      userId: null,
      recipeNamespace: context.recipeNamespace,
      recipeName: context.recipeName,
      hostRef: context.hostRef,
    },
    canonicalBinding: {
      invocationId,
      attemptGeneration: metadata.attempt_generation,
      recipeNamespace: context.recipeNamespace,
      recipeName: context.recipeName,
      hostRef: context.hostRef,
    },
  })
}

function pendingSubmitterUsageEvent(
  usage: LlmUsageEvent,
  binding: NonWorkflowRunBinding,
  context: UsageProjectionContext,
  now: () => Date,
  newEventId: () => string
): PendingGovernedEvent<'agent_run'> | null {
  const environment = context.environment ?? canonicalTracingEnvironment()
  if (usage.source_kind === 'workflow') {
    throw new Error(`workflow usage ${usage.request_id} requires workflow binding projection`)
  }
  const runId = usage.run_id?.toLowerCase()
  if (!runId || runId !== binding.runId || binding.hostRef !== context.hostRef) return null

  const rootSpanId = binding.rootSpanId
  const spanId = sha256(`usage-run:${runId}:token-usage:${usage.request_id.toLowerCase()}`)
  const origin = binding.origin
  const actorMedium = binding.actorMedium
  const agentSub = binding.agentSub
  return pendingTokenUsageEvent({
    usage,
    environment,
    now,
    newEventId,
    binding: {
      runId,
      sessionId: binding.sessionId,
      spanId,
      parentSpanId: rootSpanId,
      origin,
      identityIssuer: binding.identityIssuer,
      actorHumanSub: binding.actorHumanSub,
      agentSub,
      actorMedium,
      approvalRequestId: null,
      teamId: binding.teamId,
      userId: binding.userId,
      recipeNamespace: binding.recipeNamespace,
      recipeName: binding.recipeName,
      hostRef: context.hostRef,
    },
    canonicalBinding: {
      runId,
      spanId,
      parentSpanId: rootSpanId,
      teamId: binding.teamId,
      actorHumanSub: binding.actorHumanSub,
      hostRef: context.hostRef,
      origin,
      actorMedium,
    },
  })
}

type DirectAttributionBinding = {
  runId: string
  hostRef: string
  sessionId: string
  origin: NonWorkflowRunBinding['origin']
  identityIssuer: string
  actorHumanSub: string
  userId: string | null
  teamId: string | null
}

function optionalText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function actorMediumForOrigin(
  origin: NonWorkflowRunBinding['origin']
): NonWorkflowRunBinding['actorMedium'] {
  if (origin === 'direct_chat') return 'desktop'
  if (origin === 'channel_event') return 'channel'
  return 'api'
}

function conflictingOptionalValue(left: string | null, right: string | null): boolean {
  return left !== null && right !== null && left !== right
}

function mergeNonWorkflowBinding(input: {
  runId: string
  root: NonWorkflowRunBinding | null
  direct: DirectAttributionBinding | null
  context: UsageProjectionContext
}): NonWorkflowRunBinding | null {
  const { runId, root, direct, context } = input
  if (!root && !direct) return null

  if (direct && direct.hostRef !== context.hostRef) {
    throw new DirectRunBindingConflictError()
  }
  if (!root && direct) {
    return {
      runId,
      sessionId: direct.sessionId,
      rootSpanId: sha256(`host-run:${runId}:root`),
      origin: direct.origin,
      actorMedium: actorMediumForOrigin(direct.origin),
      identityIssuer: direct.identityIssuer,
      actorHumanSub: direct.actorHumanSub,
      agentSub: `mcp-host:${direct.hostRef}`,
      teamId: direct.teamId,
      userId: direct.userId,
      recipeNamespace: context.recipeNamespace,
      recipeName: context.recipeName,
      hostRef: direct.hostRef,
    }
  }
  if (!root) return null
  if (!direct) return root

  if (
    root.hostRef !== direct.hostRef ||
    root.sessionId !== direct.sessionId ||
    root.origin !== direct.origin ||
    conflictingOptionalValue(root.identityIssuer, direct.identityIssuer) ||
    conflictingOptionalValue(root.actorHumanSub, direct.actorHumanSub) ||
    conflictingOptionalValue(root.userId, direct.userId) ||
    conflictingOptionalValue(root.teamId, direct.teamId)
  ) {
    throw new DirectRunBindingConflictError()
  }

  return {
    ...root,
    identityIssuer: direct.identityIssuer,
    actorHumanSub: direct.actorHumanSub,
    userId: direct.userId,
    teamId: direct.teamId,
  }
}

export async function projectAcceptedUsageEvents(
  db: DbClient,
  acceptedEvents: readonly LlmUsageEvent[],
  workflowBindings: ReadonlyMap<string, WorkflowRunBinding>,
  context: UsageProjectionContext,
  dependencies: UsageProjectionDependencies = {}
): Promise<number> {
  const now = dependencies.now ?? (() => new Date())
  const newEventId = dependencies.newEventId ?? randomUUID
  const appendBatch = dependencies.appendBatch ?? appendGovernedEventBatchInTransaction
  const pending: PendingGovernedEvent<'agent_run'>[] = []
  const nonWorkflowRunIds = [
    ...new Set(
      acceptedEvents
        .filter(usage => usage.source_kind !== 'workflow' && usage.run_id)
        .map(usage => usage.run_id!.toLowerCase())
    ),
  ]
  const rootResult =
    nonWorkflowRunIds.length === 0
      ? { rows: [] }
      : await db.query(
          `WITH requested AS (
             SELECT unnest($1::uuid[]) AS run_id
           )
           SELECT requested.run_id::text,
                  root.session_id AS root_session_id,
                  root.span_id AS root_span_id,
                  root.origin AS root_origin,
                  root.actor_medium AS root_actor_medium,
                  root.identity_issuer AS root_identity_issuer,
                  root.actor_human_sub AS root_actor_human_sub,
                  root.agent_sub AS root_agent_sub,
                  root.team_id::text AS root_team_id,
                  root.user_id::text AS root_user_id,
                  root.recipe_namespace AS root_recipe_namespace,
                  root.recipe_name AS root_recipe_name,
                  root.host_ref AS root_host_ref,
                  direct.host_ref AS binding_host_ref,
                  direct.session_id AS binding_session_id,
                  direct.origin AS binding_origin,
                  direct.identity_issuer AS binding_identity_issuer,
                  direct.actor_human_sub AS binding_actor_human_sub,
                  direct.user_id::text AS binding_user_id,
                  direct.team_id::text AS binding_team_id
             FROM requested
             LEFT JOIN LATERAL (
               SELECT session_id, span_id, origin, actor_medium, identity_issuer,
                      actor_human_sub, agent_sub, team_id, user_id,
                      recipe_namespace, recipe_name, host_ref
                 FROM agent_run_events
                WHERE event_type = 'run_start'
                  AND source_kind = 'mcp_host_runtime'
                  AND run_id = requested.run_id
                  AND host_ref = $2
                ORDER BY occurred_at ASC, event_id ASC
                LIMIT 1
             ) root ON TRUE
             LEFT JOIN governed_run_attribution_bindings direct
               ON direct.run_id = requested.run_id`,
          [nonWorkflowRunIds, context.hostRef]
        )
  const nonWorkflowBindings = new Map<string, NonWorkflowRunBinding>()
  for (const row of rootResult.rows as Array<Record<string, unknown>>) {
    const runId = String(row.run_id).toLowerCase()
    const rootOrigin = optionalText(row.root_origin)
    const root =
      row.root_span_id !== null &&
      row.root_span_id !== undefined &&
      rootOrigin !== null &&
      ['direct_chat', 'channel_event', 'api'].includes(rootOrigin)
        ? {
            runId,
            sessionId: optionalText(row.root_session_id),
            rootSpanId: String(row.root_span_id),
            origin: rootOrigin as NonWorkflowRunBinding['origin'],
            actorMedium: String(
              row.root_actor_medium ?? 'unknown'
            ) as NonWorkflowRunBinding['actorMedium'],
            identityIssuer: optionalText(row.root_identity_issuer),
            actorHumanSub: optionalText(row.root_actor_human_sub),
            agentSub: String(row.root_agent_sub),
            teamId: optionalText(row.root_team_id),
            userId: optionalText(row.root_user_id),
            recipeNamespace: optionalText(row.root_recipe_namespace),
            recipeName: optionalText(row.root_recipe_name),
            hostRef: String(row.root_host_ref),
          }
        : null
    const directOrigin = optionalText(row.binding_origin)
    const direct =
      row.binding_host_ref !== null &&
      row.binding_host_ref !== undefined &&
      directOrigin !== null &&
      ['direct_chat', 'channel_event', 'api'].includes(directOrigin)
        ? {
            runId,
            hostRef: String(row.binding_host_ref),
            sessionId: String(row.binding_session_id),
            origin: directOrigin as DirectAttributionBinding['origin'],
            identityIssuer: String(row.binding_identity_issuer),
            actorHumanSub: String(row.binding_actor_human_sub),
            userId: optionalText(row.binding_user_id),
            teamId: optionalText(row.binding_team_id),
          }
        : null
    const merged = mergeNonWorkflowBinding({ runId, root, direct, context })
    if (merged) nonWorkflowBindings.set(runId, merged)
  }

  for (const usage of acceptedEvents) {
    if (usage.source_kind === 'plugin_workload_sdk') {
      pending.push(pendingSdkOnlyUsageEvent(usage, context, now, newEventId))
      continue
    }
    if (usage.source_kind === 'workflow') {
      const runId = usage.run_id?.toLowerCase()
      const binding = runId ? workflowBindings.get(runId) : undefined
      if (!binding) {
        throw new Error(`accepted workflow usage ${usage.request_id} has no trusted run binding`)
      }
      pending.push(pendingWorkflowUsageEvent(usage, binding, context, now, newEventId))
      continue
    }

    const runId = usage.run_id?.toLowerCase()
    const binding = runId ? nonWorkflowBindings.get(runId) : undefined
    const submitterEvent = binding
      ? pendingSubmitterUsageEvent(usage, binding, context, now, newEventId)
      : null
    if (submitterEvent) pending.push(submitterEvent)
  }

  if (pending.length === 0) return 0
  await appendBatch(
    db,
    pending as [PendingGovernedEvent<'agent_run'>, ...PendingGovernedEvent<'agent_run'>[]]
  )
  return pending.length
}
