/**
 * Resolve one namespace-qualified Context reference to its canonical metadata.name identity.
 * Both arguments are static SQL fragments owned by the caller; request data remains in binds.
 */
export function canonicalContextLogicalIdSql(
  environmentExpression: string,
  referenceExpression: string
): string {
  return `(SELECT MIN(identity_candidate.canonical_id)
             FROM (
               SELECT canonical_resource.logical_id AS canonical_id
                 FROM operational_resource_index canonical_resource
                WHERE canonical_resource.environment_id = ${environmentExpression}
                  AND canonical_resource.resource_type = 'context'
                  AND canonical_resource.logical_id = ${referenceExpression}
               UNION ALL
               SELECT alias_relationship.source_id AS canonical_id
                 FROM operational_resource_relationships alias_relationship
                 JOIN operational_resource_index alias_source
                   ON alias_source.environment_id = alias_relationship.environment_id
                  AND alias_source.resource_type = 'context'
                  AND alias_source.logical_id = alias_relationship.source_id
                  AND alias_source.provider_uid = alias_relationship.source_provider_uid
                WHERE alias_relationship.environment_id = ${environmentExpression}
                  AND alias_relationship.source_type = 'context'
                  AND alias_relationship.relationship_type = 'context_identity_alias'
                  AND alias_relationship.target_type = 'context'
                  AND alias_relationship.target_id = ${referenceExpression}
             ) identity_candidate
            HAVING COUNT(DISTINCT identity_candidate.canonical_id) = 1)`
}
