import type { CatalogFamily } from './catalogContracts.js'
import { boundedKeyUnionSql } from './catalogProducerSupport.js'

export const CATALOG_KEY_SQL: Readonly<Record<CatalogFamily, string>> = Object.freeze({
  user: boundedKeyUnionSql([
    `SELECT u.id::text AS logical_id
       FROM users u
      WHERE u.id = $1 AND u.id::text > $2`,
  ]),
  team: boundedKeyUnionSql([
    `SELECT tm.team_id::text AS logical_id
       FROM team_members tm
      WHERE tm.user_id = $1 AND tm.status = 'active' AND tm.team_id::text > $2`,
  ]),
  host: boundedKeyUnionSql([
    {
      sql: `SELECT $5::text || '/' || ua.agent_name AS logical_id, ua.agent_name AS source_key
              FROM user_agents ua
             WHERE ua.user_id = $1 AND ua.agent_name > $7`,
      orderBy: 'source_key',
    },
    {
      sql: `SELECT $5::text || '/' || ta.agent_name AS logical_id, ta.agent_name AS source_key
              FROM team_agents ta
              JOIN team_members tm ON tm.team_id = ta.team_id
             WHERE tm.user_id = $1 AND tm.status = 'active' AND ta.agent_name > $7`,
      orderBy: 'source_key',
    },
  ]),
  context: boundedKeyUnionSql([
    {
      sql: `SELECT $6::text || '/' || uc.context_id AS logical_id, uc.context_id AS source_key
              FROM user_contexts uc
             WHERE uc.user_id = $1 AND uc.context_id > $7`,
      orderBy: 'source_key',
    },
    {
      sql: `SELECT $6::text || '/' || tc.context_id AS logical_id, tc.context_id AS source_key
              FROM team_contexts tc
              JOIN team_members tm ON tm.team_id = tc.team_id
             WHERE tm.user_id = $1 AND tm.status = 'active' AND tc.context_id > $7`,
      orderBy: 'source_key',
    },
  ]),
  mcp_server: boundedKeyUnionSql([
    `SELECT edge.target_id AS logical_id
       FROM user_contexts uc
       JOIN operational_resource_relationships edge
         ON edge.environment_id = $3
        AND edge.source_type = 'context'
        AND edge.source_id = $6::text || '/' || uc.context_id
        AND edge.relationship_type = 'includes_mcp_server'
        AND edge.target_type = 'mcp_server'
      WHERE uc.user_id = $1 AND edge.target_id > $2`,
    `SELECT edge.target_id AS logical_id
       FROM team_contexts tc
       JOIN team_members tm ON tm.team_id = tc.team_id
       JOIN operational_resource_relationships edge
         ON edge.environment_id = $3
        AND edge.source_type = 'context'
        AND edge.source_id = $6::text || '/' || tc.context_id
        AND edge.relationship_type = 'includes_mcp_server'
        AND edge.target_type = 'mcp_server'
      WHERE tm.user_id = $1 AND tm.status = 'active' AND edge.target_id > $2`,
    `SELECT mcp_edge.target_id AS logical_id
       FROM user_agents ua
       JOIN operational_resource_relationships host_edge
         ON host_edge.environment_id = $3
        AND host_edge.source_type = 'host'
        AND host_edge.source_id = $5::text || '/' || ua.agent_name
        AND host_edge.relationship_type = 'uses_context'
        AND host_edge.target_type = 'context'
       JOIN operational_resource_relationships mcp_edge
         ON mcp_edge.environment_id = $3
        AND mcp_edge.source_type = 'context'
        AND mcp_edge.source_id = host_edge.target_id
        AND mcp_edge.relationship_type = 'includes_mcp_server'
        AND mcp_edge.target_type = 'mcp_server'
      WHERE ua.user_id = $1 AND mcp_edge.target_id > $2`,
    `SELECT mcp_edge.target_id AS logical_id
       FROM team_agents ta
       JOIN team_members tm ON tm.team_id = ta.team_id
       JOIN operational_resource_relationships host_edge
         ON host_edge.environment_id = $3
        AND host_edge.source_type = 'host'
        AND host_edge.source_id = $5::text || '/' || ta.agent_name
        AND host_edge.relationship_type = 'uses_context'
        AND host_edge.target_type = 'context'
       JOIN operational_resource_relationships mcp_edge
         ON mcp_edge.environment_id = $3
        AND mcp_edge.source_type = 'context'
        AND mcp_edge.source_id = host_edge.target_id
        AND mcp_edge.relationship_type = 'includes_mcp_server'
        AND mcp_edge.target_type = 'mcp_server'
      WHERE tm.user_id = $1 AND tm.status = 'active' AND mcp_edge.target_id > $2`,
  ]),
  workflow_recipe: boundedKeyUnionSql([
    {
      sql: `SELECT uwt.recipe_namespace || '/' || uwt.recipe_name AS logical_id
              FROM user_workflow_triggers uwt
             WHERE uwt.user_id = $1
               AND (uwt.recipe_namespace || '/' || uwt.recipe_name) > $2`,
      orderBy: 'logical_id',
    },
    {
      sql: `SELECT twt.recipe_namespace || '/' || twt.recipe_name AS logical_id
              FROM team_workflow_triggers twt
              JOIN team_members tm ON tm.team_id = twt.team_id
             WHERE tm.user_id = $1 AND tm.status = 'active'
               AND (twt.recipe_namespace || '/' || twt.recipe_name) > $2`,
      orderBy: 'logical_id',
    },
  ]),
  workflow_run: boundedKeyUnionSql([
    `SELECT wr.run_id::text AS logical_id
       FROM workflow_runs wr
       JOIN user_workflow_triggers uwt
         ON uwt.user_id = $1
        AND uwt.recipe_namespace = wr.recipe_namespace
        AND uwt.recipe_name = wr.recipe_name
      WHERE wr.actor_type = 'user' AND wr.actor_id = $1
        AND wr.team_id IS NULL AND wr.usage_team_id IS NULL
        AND wr.run_id::text > $2`,
    `SELECT wr.run_id::text AS logical_id
       FROM workflow_runs wr
       JOIN team_members tm
         ON tm.team_id = wr.team_id AND tm.user_id = $1 AND tm.status = 'active'
       JOIN team_workflow_triggers twt
         ON twt.team_id = tm.team_id
        AND twt.recipe_namespace = wr.recipe_namespace
        AND twt.recipe_name = wr.recipe_name
      WHERE wr.run_id::text > $2`,
    `SELECT wr.run_id::text AS logical_id
       FROM workflow_runs wr
       JOIN team_members tm
         ON tm.team_id::text = wr.usage_team_id
        AND tm.user_id = $1::uuid AND tm.status = 'active'
       JOIN team_workflow_triggers twt
         ON twt.team_id = tm.team_id
        AND twt.recipe_namespace = wr.recipe_namespace
        AND twt.recipe_name = wr.recipe_name
      WHERE wr.usage_team_id IS NOT NULL AND wr.run_id::text > $2`,
  ]),
  workflow_approval: boundedKeyUnionSql([
    `SELECT war.id::text AS logical_id
       FROM workflow_approval_requests war
       JOIN user_workflow_triggers uwt
         ON uwt.user_id = $1
        AND uwt.recipe_namespace = war.recipe_namespace
        AND uwt.recipe_name = war.recipe_name
      WHERE war.target_user_id = $1 AND war.status = 'pending'
        AND war.expires_at > NOW() AND war.id::text > $2`,
    `SELECT war.id::text AS logical_id
       FROM workflow_approval_requests war
       JOIN team_members tm
         ON tm.team_id = war.target_team_id AND tm.user_id = $1 AND tm.status = 'active'
       JOIN team_workflow_triggers twt
         ON twt.team_id = tm.team_id
        AND twt.recipe_namespace = war.recipe_namespace
        AND twt.recipe_name = war.recipe_name
      WHERE war.status = 'pending' AND war.expires_at > NOW() AND war.id::text > $2`,
  ]),
  notification: boundedKeyUnionSql([
    `SELECT nd.id::text AS logical_id
       FROM notification_deliveries nd
      WHERE nd.audience->>'userId' = $1::text
        AND (nd.expires_at IS NULL OR nd.expires_at > NOW())
        AND nd.id::text > $2`,
    `SELECT nd.id::text AS logical_id
       FROM notification_deliveries nd
       JOIN team_members tm
         ON tm.team_id::text = nd.audience->>'teamId'
        AND tm.user_id = $1::uuid AND tm.status = 'active'
      WHERE (nd.expires_at IS NULL OR nd.expires_at > NOW()) AND nd.id::text > $2`,
  ]),
  gfs_resource: boundedKeyUnionSql([
    `SELECT g.resource_id::text AS logical_id
       FROM gfs_grants g
       JOIN gfs_resources resource
         ON resource.resource_id = g.resource_id AND resource.deleted_at IS NULL
      WHERE g.subject_type = 'user' AND g.subject_id = $1::text
        AND g.resource_id::text > $2`,
    `SELECT g.resource_id::text AS logical_id
       FROM gfs_grants g
       JOIN team_members tm
         ON tm.team_id::text = g.subject_id
        AND tm.user_id = $1::uuid AND tm.status = 'active'
       JOIN gfs_resources resource
         ON resource.resource_id = g.resource_id AND resource.deleted_at IS NULL
      WHERE g.subject_type = 'team' AND g.resource_id::text > $2`,
    `SELECT share.resource_id::text AS logical_id
       FROM gfs_shares share
       JOIN gfs_resources resource
         ON resource.resource_id = share.resource_id AND resource.deleted_at IS NULL
      WHERE share.subject_type = 'user' AND share.subject_id = $1::text
        AND share.resource_id::text > $2`,
    `SELECT share.resource_id::text AS logical_id
       FROM gfs_shares share
       JOIN team_members tm
         ON tm.team_id::text = share.subject_id
        AND tm.user_id = $1::uuid AND tm.status = 'active'
       JOIN gfs_resources resource
         ON resource.resource_id = share.resource_id AND resource.deleted_at IS NULL
      WHERE share.subject_type = 'team' AND share.resource_id::text > $2`,
  ]),
  shared_filesystem: boundedKeyUnionSql([
    `SELECT edge.target_id AS logical_id
       FROM user_contexts uc
       JOIN operational_resource_relationships edge
         ON edge.environment_id = $3
        AND edge.source_type = 'context'
        AND edge.source_id = $6::text || '/' || uc.context_id
        AND edge.relationship_type = 'mounts_shared_filesystem'
        AND edge.target_type = 'shared_filesystem'
      WHERE uc.user_id = $1 AND edge.target_id > $2`,
    `SELECT edge.target_id AS logical_id
       FROM team_contexts tc
       JOIN team_members tm ON tm.team_id = tc.team_id
       JOIN operational_resource_relationships edge
         ON edge.environment_id = $3
        AND edge.source_type = 'context'
        AND edge.source_id = $6::text || '/' || tc.context_id
        AND edge.relationship_type = 'mounts_shared_filesystem'
        AND edge.target_type = 'shared_filesystem'
      WHERE tm.user_id = $1 AND tm.status = 'active' AND edge.target_id > $2`,
  ]),
  sandbox_app: boundedKeyUnionSql([
    `SELECT edge.target_id AS logical_id
       FROM user_workflow_triggers uwt
       JOIN operational_resource_relationships edge
         ON edge.environment_id = $3
        AND edge.source_type = 'workflow_recipe'
        AND edge.source_id = uwt.recipe_namespace || '/' || uwt.recipe_name
        AND edge.relationship_type = 'exposes_sandbox_app'
        AND edge.target_type = 'sandbox_app'
      WHERE uwt.user_id = $1 AND edge.target_id > $2`,
    `SELECT edge.target_id AS logical_id
       FROM team_workflow_triggers twt
       JOIN team_members tm ON tm.team_id = twt.team_id
       JOIN operational_resource_relationships edge
         ON edge.environment_id = $3
        AND edge.source_type = 'workflow_recipe'
        AND edge.source_id = twt.recipe_namespace || '/' || twt.recipe_name
        AND edge.relationship_type = 'exposes_sandbox_app'
        AND edge.target_type = 'sandbox_app'
      WHERE tm.user_id = $1 AND tm.status = 'active' AND edge.target_id > $2`,
  ]),
})
