export type WorkflowTriggerGrantKind = 'direct' | 'team'

type WorkflowTriggerGrantAlias = 'access_grant' | 'uwt' | 'twt'

/** Catalog paths and live authorization must bind the same trigger grant. */
export function workflowTriggerGrantIdentitySql(
  kind: WorkflowTriggerGrantKind,
  alias: WorkflowTriggerGrantAlias
): string {
  return kind === 'direct'
    ? `'user_workflow_triggers:' || ${alias}.user_id || ':' ||
       ${alias}.recipe_namespace || '/' || ${alias}.recipe_name`
    : `'team_workflow_triggers:' || ${alias}.team_id || ':' ||
       ${alias}.recipe_namespace || '/' || ${alias}.recipe_name`
}
