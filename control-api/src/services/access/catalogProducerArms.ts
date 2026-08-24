import { CatalogProducerContractError } from './catalogProducerErrors.js'

export type BoundedKeyArm = Readonly<{
  sql: string
  orderBy?: string
  duplicateCapable?: boolean
  hasValidUntil?: boolean
}>

/** PostgreSQL expression equivalent to the catalog's unsigned UTF-8 byte order. */
export function catalogTextOrderSql(expression: string): string {
  return `catalog_utf8_bytes((${expression})::text)`
}

export function catalogTextAfterSql(left: string, right: string): string {
  return `${catalogTextOrderSql(left)} > ${catalogTextOrderSql(right)}`
}

/** Builds the static, bounded SQL envelope for producer source arms. */
export function boundedKeyUnionSql(arms: readonly (string | BoundedKeyArm)[]): string {
  if (arms.length === 0) throw new CatalogProducerContractError('key_arms_missing')
  const names = arms.map((_, index) => `source_${index}`)
  const sources = arms
    .map((arm, index) => {
      const definition = typeof arm === 'string' ? { sql: arm } : arm
      const after = `arm_after_${index}`
      const sourceSql = definition.sql.replaceAll('$2', `${after}.after_key`).replaceAll(
        '$7',
        `CASE WHEN POSITION('/' IN ${after}.after_key) > 0
                THEN SPLIT_PART(${after}.after_key, '/', 2) ELSE '' END`
      )
      const orderBy = definition.orderBy ?? 'logical_id'
      // `cursor_id` is the reserved alias for a native UUID column. PostgreSQL UUID ordering is
      // byte-equivalent to UTF-8 ordering of canonical UUID text and keeps the bounded index scan.
      const orderExpression = orderBy === 'cursor_id' ? orderBy : catalogTextOrderSql(orderBy)
      return `${names[index]} AS MATERIALIZED (
          SELECT '${names[index]}'::text AS source_arm, bounded_arm.logical_id,
                 ${definition.hasValidUntil ? 'bounded_arm.valid_until' : 'NULL::timestamptz'}
                   AS valid_until
            FROM (
              SELECT COALESCE(NULLIF($8::jsonb ->> '${names[index]}', ''), $2) AS after_key
               WHERE $9::jsonb IS NULL OR $9::jsonb ? '${names[index]}'
            ) ${after}
            CROSS JOIN LATERAL (${sourceSql}) bounded_arm
          ORDER BY ${orderExpression}
          LIMIT $4
        )`
    })
    .join(',\n')
  const union = names
    .map(
      (name, index) => `SELECT '${name}'::text AS source_arm,
                       COALESCE((
                         SELECT jsonb_agg(jsonb_build_object(
                           'logical_id', logical_id,
                           'valid_until', valid_until
                         ) ORDER BY ${catalogTextOrderSql('logical_id')})
                           FROM ${name}
                       ), '[]'::jsonb) AS source_rows,
                       ${
                         (typeof arms[index] === 'string' ? false : arms[index].duplicateCapable)
                           ? `(SELECT COUNT(*) FROM ${name}) >= $4`
                           : 'FALSE'
                       } AS source_saturated
                 WHERE $9::jsonb IS NULL OR $9::jsonb ? '${name}'`
    )
    .join('\nUNION ALL\n')
  return `WITH ${sources}
    SELECT source_arm, source_rows, source_saturated
      FROM (${union}) bounded_sources
     WHERE $1::uuid IS NOT NULL AND $2::text IS NOT NULL AND $3::text IS NOT NULL
       AND $5::text IS NOT NULL AND $6::text IS NOT NULL AND $7::text IS NOT NULL
     ORDER BY ${catalogTextOrderSql('source_arm')}`
}
