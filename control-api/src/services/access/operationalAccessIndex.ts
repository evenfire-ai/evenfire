import { type DbClient, pool, withTransaction } from '../../db.js'
import { runAccessDatabaseQuery } from './accessDatabaseQuery.js'
import type { AccessExecutionBudget } from './accessExecutionBudget.js'
import type {
  OperationalObjectProjection,
  OperationalRelationshipRecord,
  OperationalResourceRecord,
  OperationalSourceFamily,
} from './operationalAccessProjection.js'

export type OperationalSourceStatus = 'current' | 'relisting' | 'unavailable'

export type OperationalSourceState = Readonly<{
  environmentId: string
  sourceFamily: OperationalSourceFamily
  generation: number
  stagingGeneration: number | null
  resourceVersion: string | null
  status: OperationalSourceStatus
  safeErrorCode: string | null
}>

export class OperationalSourceStateError extends Error {
  constructor(readonly code: 'stale_generation' | 'source_not_current' | 'source_unavailable') {
    super(`Operational access source state error: ${code}`)
    this.name = 'OperationalSourceStateError'
  }
}

type TransactionRunner = <T>(work: (db: DbClient) => Promise<T>) => Promise<T>

function numberValue(value: unknown): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new OperationalSourceStateError('source_unavailable')
  }
  return result
}

function sourceState(row: unknown): OperationalSourceState {
  const value = row as Record<string, unknown>
  const status = String(value.status)
  if (!['current', 'relisting', 'unavailable'].includes(status)) {
    throw new OperationalSourceStateError('source_unavailable')
  }
  return Object.freeze({
    environmentId: String(value.environment_id),
    sourceFamily: String(value.source_family) as OperationalSourceFamily,
    generation: numberValue(value.generation),
    stagingGeneration:
      value.staging_generation === null || value.staging_generation === undefined
        ? null
        : numberValue(value.staging_generation),
    resourceVersion: typeof value.resource_version === 'string' ? value.resource_version : null,
    status: status as OperationalSourceStatus,
    safeErrorCode: typeof value.safe_error_code === 'string' ? value.safe_error_code : null,
  })
}

function resourcePayload(value: OperationalResourceRecord, generation: number) {
  return {
    environment_id: value.environmentId,
    resource_type: value.resourceType,
    logical_id: value.logicalId,
    source_family: value.sourceFamily,
    source_generation: generation,
    provider_uid: value.providerUid,
    provider_resource_version: value.providerResourceVersion,
    display_name: value.displayName,
    enabled: value.enabled,
    deleted_at: value.deletedAt,
    observed_generation: value.observedGeneration,
    content_bytes: value.contentBytes,
  }
}

function relationshipPayload(value: OperationalRelationshipRecord, generation: number) {
  return {
    environment_id: value.environmentId,
    source_type: value.sourceType,
    source_id: value.sourceId,
    relationship_type: value.relationshipType,
    target_type: value.targetType,
    target_id: value.targetId,
    relationship_instance_id: value.relationshipInstanceId,
    behavior_attributes: value.behaviorAttributes,
    source_family: value.sourceFamily,
    source_provider_uid: value.sourceProviderUid,
    source_resource_version: value.sourceResourceVersion,
    source_generation: generation,
    observed_generation: value.observedGeneration,
    content_bytes: value.contentBytes,
  }
}

export class OperationalAccessIndex {
  constructor(
    private readonly readDb: DbClient = pool,
    private readonly transaction: TransactionRunner = withTransaction
  ) {}

  private async query(
    db: DbClient,
    budget: AccessExecutionBudget,
    text: string,
    values: unknown[] = []
  ) {
    return runAccessDatabaseQuery(db, budget, text, values)
  }

  private async configureTransaction(db: DbClient, budget: AccessExecutionBudget): Promise<void> {
    await this.query(db, budget, `SELECT set_config('statement_timeout', $1, true)`, [
      `${budget.statementTimeoutMs()}ms`,
    ])
  }

  async beginRelist(input: {
    environmentId: string
    sourceFamily: OperationalSourceFamily
    budget: AccessExecutionBudget
  }): Promise<number> {
    return this.transaction(async db => {
      await this.configureTransaction(db, input.budget)
      const result = await this.query(
        db,
        input.budget,
        `WITH source_state AS (
           INSERT INTO operational_catalog_source_state(
             environment_id, source_family, generation, staging_generation,
             status, safe_error_code, updated_at
           )
           VALUES($1, $2, 1, 2, 'relisting', NULL, NOW())
           ON CONFLICT (environment_id, source_family) DO UPDATE
             SET generation = operational_catalog_source_state.generation + 1,
                 staging_generation = operational_catalog_source_state.generation + 2,
                 status = 'relisting',
                 safe_error_code = NULL,
                 updated_at = NOW()
           RETURNING staging_generation
         ), cleared_relationships AS (
           DELETE FROM operational_relationships_staging
            WHERE environment_id = $1
              AND source_family = $2
           RETURNING 1
         ), cleared_resources AS (
           DELETE FROM operational_resource_index_staging
            WHERE environment_id = $1
              AND source_family = $2
           RETURNING 1
         )
         SELECT staging_generation FROM source_state`,
        [input.environmentId, input.sourceFamily]
      )
      return numberValue((result.rows[0] as Record<string, unknown>).staging_generation)
    })
  }

  async stageRelistPage(input: {
    environmentId: string
    sourceFamily: OperationalSourceFamily
    stagingGeneration: number
    projections: readonly OperationalObjectProjection[]
    budget: AccessExecutionBudget
  }): Promise<void> {
    const resources = input.projections.flatMap(projection =>
      projection.resources.map(value => resourcePayload(value, input.stagingGeneration))
    )
    const relationships = input.projections.flatMap(projection =>
      projection.relationships.map(value => relationshipPayload(value, input.stagingGeneration))
    )
    await this.transaction(async db => {
      await this.configureTransaction(db, input.budget)
      const result = await this.query(
        db,
        input.budget,
        `WITH valid_generation AS (
           SELECT 1
             FROM operational_catalog_source_state
            WHERE environment_id = $1
              AND source_family = $2
              AND status = 'relisting'
              AND staging_generation = $3
            FOR UPDATE
         ), resource_rows AS (
           SELECT value
             FROM jsonb_array_elements($4::jsonb) AS value
            WHERE EXISTS (SELECT 1 FROM valid_generation)
         ), inserted_resources AS (
           INSERT INTO operational_resource_index_staging(
             environment_id, resource_type, logical_id, source_family, source_generation,
             provider_uid, provider_resource_version, display_name, enabled, deleted_at,
             observed_generation, content_bytes, observed_at
           )
           SELECT value->>'environment_id', value->>'resource_type', value->>'logical_id',
                  value->>'source_family', (value->>'source_generation')::bigint,
                  value->>'provider_uid', value->>'provider_resource_version',
                  value->>'display_name', (value->>'enabled')::boolean,
                  (value->>'deleted_at')::timestamptz,
                  (value->>'observed_generation')::bigint,
                  (value->>'content_bytes')::bigint, NOW()
             FROM resource_rows
           ON CONFLICT (
             environment_id, source_family, source_generation, resource_type, logical_id
           ) DO UPDATE
             SET source_family = EXCLUDED.source_family,
                 source_generation = EXCLUDED.source_generation,
                 provider_uid = EXCLUDED.provider_uid,
                 provider_resource_version = EXCLUDED.provider_resource_version,
                 display_name = EXCLUDED.display_name,
                 enabled = EXCLUDED.enabled,
                 deleted_at = EXCLUDED.deleted_at,
                 observed_generation = EXCLUDED.observed_generation,
                 content_bytes = EXCLUDED.content_bytes,
                 observed_at = NOW()
           RETURNING 1
         ), relationship_rows AS (
           SELECT value
             FROM jsonb_array_elements($5::jsonb) AS value
            WHERE EXISTS (SELECT 1 FROM valid_generation)
         ), inserted_relationships AS (
           INSERT INTO operational_relationships_staging(
             environment_id, source_type, source_id, relationship_type, target_type, target_id,
             relationship_instance_id, behavior_attributes, source_family, source_provider_uid,
             source_resource_version, source_generation, observed_generation, content_bytes,
             observed_at
           )
           SELECT value->>'environment_id', value->>'source_type', value->>'source_id',
                  value->>'relationship_type', value->>'target_type', value->>'target_id',
                  value->>'relationship_instance_id', value->'behavior_attributes',
                  value->>'source_family', value->>'source_provider_uid',
                  value->>'source_resource_version', (value->>'source_generation')::bigint,
                  (value->>'observed_generation')::bigint,
                  (value->>'content_bytes')::bigint, NOW()
             FROM relationship_rows
           ON CONFLICT (
             environment_id, source_family, source_generation,
             source_type, source_id, relationship_type,
             target_type, target_id, relationship_instance_id
           ) DO UPDATE
             SET behavior_attributes = EXCLUDED.behavior_attributes,
                 source_family = EXCLUDED.source_family,
                 source_provider_uid = EXCLUDED.source_provider_uid,
                 source_resource_version = EXCLUDED.source_resource_version,
                 source_generation = EXCLUDED.source_generation,
                 observed_generation = EXCLUDED.observed_generation,
                 content_bytes = EXCLUDED.content_bytes,
                 observed_at = NOW()
           RETURNING 1
         )
         SELECT EXISTS (SELECT 1 FROM valid_generation) AS valid`,
        [
          input.environmentId,
          input.sourceFamily,
          input.stagingGeneration,
          JSON.stringify(resources),
          JSON.stringify(relationships),
        ]
      )
      if (!(result.rows[0] as { valid?: boolean } | undefined)?.valid) {
        throw new OperationalSourceStateError('stale_generation')
      }
    })
  }

  async promoteRelist(input: {
    environmentId: string
    sourceFamily: OperationalSourceFamily
    stagingGeneration: number
    resourceVersion: string
    budget: AccessExecutionBudget
  }): Promise<void> {
    await this.transaction(async db => {
      await this.configureTransaction(db, input.budget)
      const locked = await this.query(
        db,
        input.budget,
        `SELECT staging_generation
           FROM operational_catalog_source_state
          WHERE environment_id = $1 AND source_family = $2
            AND status = 'relisting'
          FOR UPDATE`,
        [input.environmentId, input.sourceFamily]
      )
      if (
        numberValue((locked.rows[0] as Record<string, unknown> | undefined)?.staging_generation) !==
        input.stagingGeneration
      ) {
        throw new OperationalSourceStateError('stale_generation')
      }
      await this.query(
        db,
        input.budget,
        `DELETE FROM operational_resource_relationships
          WHERE environment_id = $1 AND source_family = $2`,
        [input.environmentId, input.sourceFamily]
      )
      await this.query(
        db,
        input.budget,
        `DELETE FROM operational_resource_index
          WHERE environment_id = $1 AND source_family = $2`,
        [input.environmentId, input.sourceFamily]
      )
      await this.query(
        db,
        input.budget,
        `INSERT INTO operational_resource_index(
           environment_id, resource_type, logical_id, source_family, source_generation,
           provider_uid, provider_resource_version, display_name, enabled, deleted_at,
           observed_generation, content_bytes, observed_at
         )
         SELECT environment_id, resource_type, logical_id, source_family, source_generation,
                provider_uid, provider_resource_version, display_name, enabled, deleted_at,
                observed_generation, content_bytes, observed_at
           FROM operational_resource_index_staging
          WHERE environment_id = $1 AND source_family = $2
            AND source_generation = $3`,
        [input.environmentId, input.sourceFamily, input.stagingGeneration]
      )
      await this.query(
        db,
        input.budget,
        `INSERT INTO operational_resource_relationships(
           environment_id, source_type, source_id, relationship_type, target_type, target_id,
           relationship_instance_id, behavior_attributes, source_family, source_provider_uid,
           source_resource_version, source_generation, observed_generation, content_bytes,
           observed_at
         )
         SELECT environment_id, source_type, source_id, relationship_type, target_type, target_id,
                relationship_instance_id, behavior_attributes, source_family, source_provider_uid,
                source_resource_version, source_generation, observed_generation, content_bytes,
                observed_at
           FROM operational_relationships_staging
          WHERE environment_id = $1 AND source_family = $2
            AND source_generation = $3`,
        [input.environmentId, input.sourceFamily, input.stagingGeneration]
      )
      await this.query(
        db,
        input.budget,
        `DELETE FROM operational_relationships_staging
          WHERE environment_id = $1 AND source_family = $2`,
        [input.environmentId, input.sourceFamily]
      )
      await this.query(
        db,
        input.budget,
        `DELETE FROM operational_resource_index_staging
          WHERE environment_id = $1 AND source_family = $2`,
        [input.environmentId, input.sourceFamily]
      )
      await this.query(
        db,
        input.budget,
        `UPDATE operational_catalog_source_state
            SET generation = $3,
                staging_generation = NULL,
                resource_version = $4,
                status = 'current',
                last_success_at = NOW(),
                safe_error_code = NULL,
                updated_at = NOW()
          WHERE environment_id = $1 AND source_family = $2`,
        [input.environmentId, input.sourceFamily, input.stagingGeneration, input.resourceVersion]
      )
    })
  }

  async applyWatchProjection(input: {
    environmentId: string
    sourceFamily: OperationalSourceFamily
    resourceVersion: string
    projection: OperationalObjectProjection
    deleted: boolean
    budget: AccessExecutionBudget
  }): Promise<number> {
    return this.transaction(async db => {
      await this.configureTransaction(db, input.budget)
      const locked = await this.query(
        db,
        input.budget,
        `SELECT generation, status
           FROM operational_catalog_source_state
          WHERE environment_id = $1 AND source_family = $2
          FOR UPDATE`,
        [input.environmentId, input.sourceFamily]
      )
      const state = locked.rows[0] as Record<string, unknown> | undefined
      if (!state || state.status !== 'current') {
        throw new OperationalSourceStateError('source_not_current')
      }
      const generation = numberValue(state.generation) + 1
      await this.query(
        db,
        input.budget,
        `DELETE FROM operational_resource_relationships
          WHERE environment_id = $1 AND source_family = $2
            AND (
              source_provider_uid = $3
              OR (source_type = $4 AND source_id = $5)
            )`,
        [
          input.environmentId,
          input.sourceFamily,
          input.projection.providerUid,
          input.projection.rootType,
          input.projection.rootId,
        ]
      )
      await this.query(
        db,
        input.budget,
        `DELETE FROM operational_resource_index
          WHERE environment_id = $1 AND source_family = $2
            AND (
              provider_uid = $3
              OR provider_uid LIKE $3 || ':%'
              OR logical_id = $4
            )`,
        [
          input.environmentId,
          input.sourceFamily,
          input.projection.providerUid,
          input.projection.rootId,
        ]
      )
      if (!input.deleted) {
        await this.insertCurrentProjection(db, input.budget, input.projection, generation)
      }
      await this.query(
        db,
        input.budget,
        `UPDATE operational_catalog_source_state
            SET generation = $3,
                resource_version = $4,
                last_success_at = NOW(),
                safe_error_code = NULL,
                updated_at = NOW()
          WHERE environment_id = $1 AND source_family = $2`,
        [input.environmentId, input.sourceFamily, generation, input.resourceVersion]
      )
      return generation
    })
  }

  private async insertCurrentProjection(
    db: DbClient,
    budget: AccessExecutionBudget,
    projection: OperationalObjectProjection,
    generation: number
  ): Promise<void> {
    const resources = projection.resources.map(value => resourcePayload(value, generation))
    const relationships = projection.relationships.map(value =>
      relationshipPayload(value, generation)
    )
    await this.query(
      db,
      budget,
      `WITH resource_rows AS (
         SELECT value FROM jsonb_array_elements($1::jsonb) AS value
       ), inserted_resources AS (
         INSERT INTO operational_resource_index(
           environment_id, resource_type, logical_id, source_family, source_generation,
           provider_uid, provider_resource_version, display_name, enabled, deleted_at,
           observed_generation, content_bytes, observed_at
         )
         SELECT value->>'environment_id', value->>'resource_type', value->>'logical_id',
                value->>'source_family', (value->>'source_generation')::bigint,
                value->>'provider_uid', value->>'provider_resource_version',
                value->>'display_name', (value->>'enabled')::boolean,
                (value->>'deleted_at')::timestamptz,
                (value->>'observed_generation')::bigint,
                (value->>'content_bytes')::bigint, NOW()
           FROM resource_rows
         RETURNING 1
       ), relationship_rows AS (
         SELECT value FROM jsonb_array_elements($2::jsonb) AS value
       )
       INSERT INTO operational_resource_relationships(
         environment_id, source_type, source_id, relationship_type, target_type, target_id,
         relationship_instance_id, behavior_attributes, source_family, source_provider_uid,
         source_resource_version, source_generation, observed_generation, content_bytes,
         observed_at
       )
       SELECT value->>'environment_id', value->>'source_type', value->>'source_id',
              value->>'relationship_type', value->>'target_type', value->>'target_id',
              value->>'relationship_instance_id', value->'behavior_attributes',
              value->>'source_family', value->>'source_provider_uid',
              value->>'source_resource_version', (value->>'source_generation')::bigint,
              (value->>'observed_generation')::bigint,
              (value->>'content_bytes')::bigint, NOW()
         FROM relationship_rows`,
      [JSON.stringify(resources), JSON.stringify(relationships)]
    )
  }

  async markSourceState(input: {
    environmentId: string
    sourceFamily: OperationalSourceFamily
    status: Extract<OperationalSourceStatus, 'relisting' | 'unavailable'>
    safeErrorCode: string
    budget: AccessExecutionBudget
  }): Promise<void> {
    await this.transaction(async db => {
      await this.configureTransaction(db, input.budget)
      await this.query(
        db,
        input.budget,
        `INSERT INTO operational_catalog_source_state(
           environment_id, source_family, generation, status,
           last_error_at, safe_error_code, updated_at
         )
         VALUES($1, $2, 1, $3, NOW(), $4, NOW())
         ON CONFLICT (environment_id, source_family) DO UPDATE
           SET generation = operational_catalog_source_state.generation + 1,
               staging_generation = NULL,
               status = EXCLUDED.status,
               last_error_at = NOW(),
               safe_error_code = EXCLUDED.safe_error_code,
               updated_at = NOW()`,
        [input.environmentId, input.sourceFamily, input.status, input.safeErrorCode]
      )
    })
  }

  async recordWatchBookmark(input: {
    environmentId: string
    sourceFamily: OperationalSourceFamily
    resourceVersion: string
    budget: AccessExecutionBudget
  }): Promise<void> {
    await this.transaction(async db => {
      await this.configureTransaction(db, input.budget)
      const result = await this.query(
        db,
        input.budget,
        `UPDATE operational_catalog_source_state
            SET resource_version = $3,
                last_success_at = NOW(),
                updated_at = NOW()
          WHERE environment_id = $1
            AND source_family = $2
            AND status = 'current'`,
        [input.environmentId, input.sourceFamily, input.resourceVersion]
      )
      if ((result.rowCount ?? 0) !== 1) {
        throw new OperationalSourceStateError('source_not_current')
      }
    })
  }

  async loadSourceStates(input: {
    environmentId: string
    sourceFamilies: readonly OperationalSourceFamily[]
    budget: AccessExecutionBudget
  }): Promise<readonly OperationalSourceState[]> {
    if (input.sourceFamilies.length === 0) return []
    const result = await this.query(
      this.readDb,
      input.budget,
      `SELECT environment_id, source_family, generation, staging_generation,
              resource_version, status, safe_error_code
         FROM operational_catalog_source_state
        WHERE environment_id = $1
          AND source_family = ANY($2::text[])
        ORDER BY source_family`,
      [input.environmentId, input.sourceFamilies]
    )
    return Object.freeze(result.rows.map(sourceState))
  }
}
