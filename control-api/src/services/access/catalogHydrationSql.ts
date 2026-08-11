export const USER_HYDRATION_SQL = `
  WITH requested AS (SELECT UNNEST($2::text[]) AS logical_id)
  SELECT u.id::text AS logical_id,
         COALESCE(NULLIF(u.name, ''), u.email, u.id::text) AS display_name,
         NULL::text AS provider_uid,
         COALESCE(arr.revision, 1)::text AS resource_revision,
         jsonb_build_array(jsonb_build_object(
           'kind', 'direct',
           'grant_id', 'users:' || u.id::text
         )) AS paths,
         '[]'::jsonb AS relationships,
         NULL::timestamptz AS valid_until
    FROM requested requested
    JOIN users u ON u.id::text = requested.logical_id AND u.id = $1
    LEFT JOIN authorization_resource_revisions arr
      ON arr.environment_id = $3 AND arr.resource_type = 'user'
     AND arr.resource_id = u.id::text
   ORDER BY u.id::text`

export const TEAM_HYDRATION_SQL = `
  WITH requested AS (SELECT UNNEST($2::text[]) AS logical_id)
  SELECT team.id::text AS logical_id,
         team.name AS display_name,
         NULL::text AS provider_uid,
         COALESCE(arr.revision, 1)::text AS resource_revision,
         jsonb_build_array(jsonb_build_object(
           'kind', 'team',
           'grant_id', 'team_members:' || membership.team_id || ':' || membership.user_id,
           'team_id', membership.team_id,
           'current_role', membership.role
         )) AS paths,
         jsonb_build_array(jsonb_build_object(
           'type', 'membership',
           'targetResourceId', 'user:' || membership.user_id
         )) AS relationships,
         NULL::timestamptz AS valid_until
    FROM requested requested
    JOIN teams team ON team.id::text = requested.logical_id
    JOIN team_members membership
      ON membership.team_id = team.id AND membership.user_id = $1
     AND membership.status = 'active'
    LEFT JOIN authorization_resource_revisions arr
      ON arr.environment_id = $3 AND arr.resource_type = 'team'
     AND arr.resource_id = team.id::text
   ORDER BY team.id::text`

export const SIMPLE_OPERATIONAL_HYDRATION_SQL = `
  WITH requested AS MATERIALIZED (
    SELECT UNNEST($2::text[]) AS logical_id
  ), resources AS MATERIALIZED (
    SELECT resource.logical_id, resource.display_name, resource.provider_uid,
           resource.resource_type, COALESCE(revision.revision, 1)::text AS resource_revision
      FROM requested requested
      JOIN operational_resource_index resource
        ON resource.environment_id = $3
       AND resource.resource_type = $4
       AND resource.logical_id = requested.logical_id
       AND resource.enabled = TRUE AND resource.deleted_at IS NULL
      LEFT JOIN authorization_resource_revisions revision
        ON revision.environment_id = resource.environment_id
       AND revision.resource_type = resource.resource_type
       AND revision.resource_id = resource.logical_id
  ), paths AS MATERIALIZED (
    SELECT * FROM (
      SELECT resource.logical_id, 'direct'::text AS kind,
             'user_agents:' || access_grant.user_id || ':' || access_grant.agent_name AS grant_id,
             NULL::uuid AS team_id, NULL::text AS current_role
        FROM resources resource
        JOIN user_agents access_grant
          ON $4::text = 'host'
         AND resource.logical_id = $5::text || '/' || access_grant.agent_name
       WHERE access_grant.user_id = $1
      UNION ALL
      SELECT resource.logical_id, 'team',
             'team_agents:' || access_grant.team_id || ':' || access_grant.agent_name,
             access_grant.team_id, membership.role
        FROM resources resource
        JOIN team_agents access_grant
          ON $4::text = 'host'
         AND resource.logical_id = $5::text || '/' || access_grant.agent_name
        JOIN team_members membership
          ON membership.team_id = access_grant.team_id AND membership.user_id = $1
         AND membership.status = 'active'
      UNION ALL
      SELECT resource.logical_id, 'direct',
             'user_contexts:' || access_grant.user_id || ':' || access_grant.context_id,
             NULL, NULL
        FROM resources resource
        JOIN user_contexts access_grant
          ON $4::text = 'context'
         AND resource.logical_id = $6::text || '/' || access_grant.context_id
       WHERE access_grant.user_id = $1
      UNION ALL
      SELECT resource.logical_id, 'team',
             'team_contexts:' || access_grant.team_id || ':' || access_grant.context_id,
             access_grant.team_id, membership.role
        FROM resources resource
        JOIN team_contexts access_grant
          ON $4::text = 'context'
         AND resource.logical_id = $6::text || '/' || access_grant.context_id
        JOIN team_members membership
          ON membership.team_id = access_grant.team_id AND membership.user_id = $1
         AND membership.status = 'active'
      UNION ALL
      SELECT resource.logical_id, 'direct',
             'user_workflow_triggers:' || access_grant.user_id || ':' ||
               access_grant.recipe_namespace || '/' || access_grant.recipe_name,
             NULL, NULL
        FROM resources resource
        JOIN user_workflow_triggers access_grant
          ON $4::text IN ('workflow_recipe', 'sandbox_app')
         AND resource.logical_id = access_grant.recipe_namespace || '/' || access_grant.recipe_name
       WHERE access_grant.user_id = $1
      UNION ALL
      SELECT resource.logical_id, 'team',
             'team_workflow_triggers:' || access_grant.team_id || ':' ||
               access_grant.recipe_namespace || '/' || access_grant.recipe_name,
             access_grant.team_id, membership.role
        FROM resources resource
        JOIN team_workflow_triggers access_grant
          ON $4::text IN ('workflow_recipe', 'sandbox_app')
         AND resource.logical_id = access_grant.recipe_namespace || '/' || access_grant.recipe_name
        JOIN team_members membership
          ON membership.team_id = access_grant.team_id AND membership.user_id = $1
         AND membership.status = 'active'
    ) all_paths
    ORDER BY logical_id, kind, team_id NULLS FIRST, grant_id
    LIMIT $7
  ), relationships AS MATERIALIZED (
    SELECT DISTINCT relationship.source_id AS logical_id,
           relationship.relationship_type, relationship.target_type,
           relationship.target_id, relationship.relationship_instance_id,
           relationship.behavior_attributes, relationship.source_type,
           relationship.source_provider_uid, relationship.source_resource_version
      FROM operational_resource_relationships relationship
      JOIN resources resource
        ON relationship.environment_id = $3
       AND (
         (relationship.source_type = resource.resource_type
          AND relationship.source_id = resource.logical_id)
         OR (relationship.target_type = resource.resource_type
          AND relationship.target_id = resource.logical_id)
       )
    ORDER BY logical_id, relationship_type, target_type, target_id,
             relationship_instance_id
    LIMIT $8
  )
  SELECT resource.logical_id, resource.display_name, resource.provider_uid,
         resource.resource_revision,
         COALESCE((
           SELECT jsonb_agg(to_jsonb(path) ORDER BY path.kind,
                            path.team_id NULLS FIRST, path.grant_id)
             FROM paths path WHERE path.logical_id = resource.logical_id
         ), '[]'::jsonb) AS paths,
         COALESCE((
           SELECT jsonb_agg(to_jsonb(relationship) ORDER BY relationship.relationship_type,
                            relationship.target_type, relationship.target_id,
                            relationship.relationship_instance_id)
             FROM relationships relationship
            WHERE relationship.logical_id = resource.logical_id
               OR relationship.target_id = resource.logical_id
         ), '[]'::jsonb) AS relationships,
         (SELECT COUNT(*) FROM paths) AS total_path_rows,
         (SELECT COUNT(*) FROM relationships) AS total_relationship_rows,
         NULL::timestamptz AS valid_until
    FROM resources resource
   ORDER BY resource.logical_id`

export const DERIVED_OPERATIONAL_HYDRATION_SQL = `
  WITH requested AS MATERIALIZED (
    SELECT UNNEST($2::text[]) AS logical_id
  ), resources AS MATERIALIZED (
    SELECT resource.logical_id, resource.display_name, resource.provider_uid,
           resource.resource_type, COALESCE(revision.revision, 1)::text AS resource_revision
      FROM requested requested
      JOIN operational_resource_index resource
        ON resource.environment_id = $3
       AND resource.resource_type = $4
       AND resource.logical_id = requested.logical_id
       AND resource.enabled = TRUE AND resource.deleted_at IS NULL
      LEFT JOIN authorization_resource_revisions revision
        ON revision.environment_id = resource.environment_id
       AND revision.resource_type = resource.resource_type
       AND revision.resource_id = resource.logical_id
  ), direct_edges AS MATERIALIZED (
    SELECT relationship.*
      FROM operational_resource_relationships relationship
      JOIN resources resource
        ON relationship.environment_id = $3
       AND relationship.target_type = resource.resource_type
       AND relationship.target_id = resource.logical_id
       AND relationship.relationship_type = CASE
             WHEN $4::text = 'mcp_server' THEN 'includes_mcp_server'
             ELSE 'mounts_shared_filesystem'
           END
  ), host_edges AS MATERIALIZED (
    SELECT relationship.*
      FROM operational_resource_relationships relationship
     WHERE $4::text = 'mcp_server'
       AND relationship.environment_id = $3
       AND relationship.relationship_type = 'uses_context'
       AND relationship.target_type = 'context'
       AND relationship.target_id IN (SELECT source_id FROM direct_edges)
  ), paths AS MATERIALIZED (
    SELECT * FROM (
      SELECT edge.target_id AS logical_id, 'direct'::text AS kind,
             'user_contexts:' || access_grant.user_id || ':' || access_grant.context_id || ':' ||
               edge.relationship_instance_id AS grant_id,
             NULL::uuid AS team_id, NULL::text AS current_role,
             'context'::text AS source_type, edge.source_id,
             edge.source_provider_uid, edge.relationship_instance_id AS edge_instance,
             edge.behavior_attributes AS edge_behavior,
             NULL::text AS host_source_id, NULL::text AS host_provider_uid,
             NULL::text AS host_edge_instance, NULL::jsonb AS host_edge_behavior
        FROM direct_edges edge
        JOIN user_contexts access_grant
          ON edge.source_id = $6::text || '/' || access_grant.context_id
       WHERE access_grant.user_id = $1
      UNION ALL
      SELECT edge.target_id, 'team',
             'team_contexts:' || access_grant.team_id || ':' || access_grant.context_id || ':' ||
               edge.relationship_instance_id,
             access_grant.team_id, membership.role, 'context', edge.source_id,
             edge.source_provider_uid, edge.relationship_instance_id,
             edge.behavior_attributes, NULL, NULL, NULL, NULL
        FROM direct_edges edge
        JOIN team_contexts access_grant
          ON edge.source_id = $6::text || '/' || access_grant.context_id
        JOIN team_members membership
          ON membership.team_id = access_grant.team_id AND membership.user_id = $1
         AND membership.status = 'active'
      UNION ALL
      SELECT mcp_edge.target_id, 'direct',
             'user_agents:' || access_grant.user_id || ':' || access_grant.agent_name || ':' ||
               host_edge.relationship_instance_id || ':' || mcp_edge.relationship_instance_id,
             NULL, NULL, 'host', mcp_edge.source_id, mcp_edge.source_provider_uid,
             mcp_edge.relationship_instance_id, mcp_edge.behavior_attributes,
             host_edge.source_id, host_edge.source_provider_uid,
             host_edge.relationship_instance_id, host_edge.behavior_attributes
        FROM direct_edges mcp_edge
        JOIN host_edges host_edge ON host_edge.target_id = mcp_edge.source_id
        JOIN user_agents access_grant
          ON $4::text = 'mcp_server'
         AND host_edge.source_id = $5::text || '/' || access_grant.agent_name
       WHERE access_grant.user_id = $1
      UNION ALL
      SELECT mcp_edge.target_id, 'team',
             'team_agents:' || access_grant.team_id || ':' || access_grant.agent_name || ':' ||
               host_edge.relationship_instance_id || ':' || mcp_edge.relationship_instance_id,
             access_grant.team_id, membership.role, 'host', mcp_edge.source_id,
             mcp_edge.source_provider_uid, mcp_edge.relationship_instance_id,
             mcp_edge.behavior_attributes, host_edge.source_id,
             host_edge.source_provider_uid, host_edge.relationship_instance_id,
             host_edge.behavior_attributes
        FROM direct_edges mcp_edge
        JOIN host_edges host_edge ON host_edge.target_id = mcp_edge.source_id
        JOIN team_agents access_grant
          ON $4::text = 'mcp_server'
         AND host_edge.source_id = $5::text || '/' || access_grant.agent_name
        JOIN team_members membership
          ON membership.team_id = access_grant.team_id AND membership.user_id = $1
         AND membership.status = 'active'
    ) all_paths
    ORDER BY logical_id, kind, team_id NULLS FIRST, grant_id
    LIMIT $7
  ), relationships AS MATERIALIZED (
    SELECT * FROM direct_edges
    UNION ALL
    SELECT * FROM host_edges
    ORDER BY source_type, source_id, relationship_type, target_type, target_id,
             relationship_instance_id
    LIMIT $8
  )
  SELECT resource.logical_id, resource.display_name, resource.provider_uid,
         resource.resource_revision,
         COALESCE((
           SELECT jsonb_agg(to_jsonb(path) ORDER BY path.kind,
                            path.team_id NULLS FIRST, path.grant_id)
             FROM paths path WHERE path.logical_id = resource.logical_id
         ), '[]'::jsonb) AS paths,
         COALESCE((
           SELECT jsonb_agg(to_jsonb(relationship) ORDER BY relationship.source_type,
                            relationship.source_id, relationship.relationship_type,
                            relationship.target_type, relationship.target_id,
                            relationship.relationship_instance_id)
             FROM relationships relationship
            WHERE relationship.target_id = resource.logical_id
               OR relationship.target_id IN (
                    SELECT edge.source_id FROM direct_edges edge
                     WHERE edge.target_id = resource.logical_id
                  )
         ), '[]'::jsonb) AS relationships,
         (SELECT COUNT(*) FROM paths) AS total_path_rows,
         (SELECT COUNT(*) FROM relationships) AS total_relationship_rows,
         NULL::timestamptz AS valid_until
    FROM resources resource
   ORDER BY resource.logical_id`

export const WORKFLOW_RUN_HYDRATION_SQL = `
  WITH requested AS MATERIALIZED (SELECT UNNEST($2::uuid[]) AS id),
  resources AS MATERIALIZED (
    SELECT run.*, COALESCE(revision.revision, 1)::text AS resource_revision
      FROM requested requested
      JOIN workflow_runs run ON run.run_id = requested.id
      LEFT JOIN authorization_resource_revisions revision
        ON revision.environment_id = $3 AND revision.resource_type = 'workflow_run'
       AND revision.resource_id = run.run_id::text
  ), paths AS MATERIALIZED (
    SELECT * FROM (
      SELECT run.run_id::text AS logical_id, 'direct'::text AS kind,
             'workflow_runs:user:' || run.run_id AS grant_id,
             NULL::uuid AS team_id, NULL::text AS current_role
        FROM resources run
        JOIN user_workflow_triggers access_grant
          ON access_grant.user_id = $1
         AND access_grant.recipe_namespace = run.recipe_namespace
         AND access_grant.recipe_name = run.recipe_name
       WHERE run.actor_type = 'user' AND run.actor_id = $1
         AND run.team_id IS NULL AND run.usage_team_id IS NULL
      UNION ALL
      SELECT run.run_id::text, 'team',
             'workflow_runs:team:' || membership.team_id || ':' || run.run_id,
             membership.team_id, membership.role
        FROM resources run
        JOIN team_members membership
          ON (membership.team_id = run.team_id OR membership.team_id::text = run.usage_team_id)
         AND membership.user_id = $1::uuid AND membership.status = 'active'
        JOIN team_workflow_triggers access_grant
          ON access_grant.team_id = membership.team_id
         AND access_grant.recipe_namespace = run.recipe_namespace
         AND access_grant.recipe_name = run.recipe_name
    ) all_paths
    ORDER BY logical_id, kind, team_id NULLS FIRST, grant_id
    LIMIT $4
  )
  SELECT run.run_id::text AS logical_id,
         run.recipe_namespace || '/' || run.recipe_name || ' ' || run.run_id::text AS display_name,
         NULL::text AS provider_uid, run.resource_revision,
         COALESCE((
           SELECT jsonb_agg(to_jsonb(path) ORDER BY path.kind,
                            path.team_id NULLS FIRST, path.grant_id)
             FROM paths path WHERE path.logical_id = run.run_id::text
         ), '[]'::jsonb) AS paths,
         jsonb_build_array(jsonb_build_object(
           'type', 'recipe',
           'targetResourceId', 'workflow_recipe:' || run.recipe_namespace || '/' || run.recipe_name
         )) AS relationships,
         (SELECT COUNT(*) FROM paths) AS total_path_rows,
         1::bigint AS total_relationship_rows,
         NULL::timestamptz AS valid_until
    FROM resources run
   ORDER BY run.run_id::text`

export const WORKFLOW_APPROVAL_HYDRATION_SQL = `
  WITH requested AS MATERIALIZED (SELECT UNNEST($2::uuid[]) AS id),
  resources AS MATERIALIZED (
    SELECT approval.*, COALESCE(revision.revision, 1)::text AS resource_revision
      FROM requested requested
      JOIN workflow_approval_requests approval ON approval.id = requested.id
      LEFT JOIN authorization_resource_revisions revision
        ON revision.environment_id = $3 AND revision.resource_type = 'workflow_approval'
       AND revision.resource_id = approval.id::text
     WHERE approval.status = 'pending' AND approval.expires_at > NOW()
  ), paths AS MATERIALIZED (
    SELECT * FROM (
      SELECT approval.id::text AS logical_id, 'direct'::text AS kind,
             'workflow_approvals:user:' || approval.id AS grant_id,
             NULL::uuid AS team_id, NULL::text AS current_role
        FROM resources approval
        JOIN user_workflow_triggers access_grant
          ON access_grant.user_id = $1
         AND access_grant.recipe_namespace = approval.recipe_namespace
         AND access_grant.recipe_name = approval.recipe_name
       WHERE approval.target_user_id = $1
      UNION ALL
      SELECT approval.id::text, 'team',
             'workflow_approvals:team:' || membership.team_id || ':' || approval.id,
             membership.team_id, membership.role
        FROM resources approval
        JOIN team_members membership
          ON membership.team_id = approval.target_team_id
         AND membership.user_id = $1::uuid AND membership.status = 'active'
        JOIN team_workflow_triggers access_grant
          ON access_grant.team_id = membership.team_id
         AND access_grant.recipe_namespace = approval.recipe_namespace
         AND access_grant.recipe_name = approval.recipe_name
    ) all_paths
    ORDER BY logical_id, kind, team_id NULLS FIRST, grant_id
    LIMIT $4
  )
  SELECT approval.id::text AS logical_id,
         approval.recipe_namespace || '/' || approval.recipe_name || ' approval' AS display_name,
         NULL::text AS provider_uid, approval.resource_revision,
         COALESCE((
           SELECT jsonb_agg(to_jsonb(path) ORDER BY path.kind,
                            path.team_id NULLS FIRST, path.grant_id)
             FROM paths path WHERE path.logical_id = approval.id::text
         ), '[]'::jsonb) AS paths,
         jsonb_build_array(jsonb_build_object(
           'type', 'recipe',
           'targetResourceId', 'workflow_recipe:' || approval.recipe_namespace || '/' ||
             approval.recipe_name
         )) AS relationships,
         (SELECT COUNT(*) FROM paths) AS total_path_rows,
         1::bigint AS total_relationship_rows,
         approval.expires_at AS valid_until
    FROM resources approval
   ORDER BY approval.id::text`

export const NOTIFICATION_HYDRATION_SQL = `
  WITH requested AS MATERIALIZED (SELECT UNNEST($2::uuid[]) AS id),
  resources AS MATERIALIZED (
    SELECT notification.*, COALESCE(revision.revision, 1)::text AS resource_revision
      FROM requested requested
      JOIN notification_deliveries notification ON notification.id = requested.id
      LEFT JOIN authorization_resource_revisions revision
        ON revision.environment_id = $3 AND revision.resource_type = 'notification'
       AND revision.resource_id = notification.id::text
     WHERE notification.expires_at IS NULL OR notification.expires_at > NOW()
  ), paths AS MATERIALIZED (
    SELECT * FROM (
      SELECT notification.id::text AS logical_id, 'direct'::text AS kind,
             'notifications:user:' || notification.id AS grant_id,
             NULL::uuid AS team_id, NULL::text AS current_role
        FROM resources notification
       WHERE notification.audience->>'userId' = $1::text
      UNION ALL
      SELECT notification.id::text, 'team',
             'notifications:team:' || membership.team_id || ':' || notification.id,
             membership.team_id, membership.role
        FROM resources notification
        JOIN team_members membership
          ON membership.team_id::text = notification.audience->>'teamId'
         AND membership.user_id = $1::uuid AND membership.status = 'active'
    ) all_paths
    ORDER BY logical_id, kind, team_id NULLS FIRST, grant_id
    LIMIT $4
  )
  SELECT notification.id::text AS logical_id,
         notification.event_type AS display_name,
         NULL::text AS provider_uid, notification.resource_revision,
         COALESCE((
           SELECT jsonb_agg(to_jsonb(path) ORDER BY path.kind,
                            path.team_id NULLS FIRST, path.grant_id)
             FROM paths path WHERE path.logical_id = notification.id::text
         ), '[]'::jsonb) AS paths,
         CASE WHEN notification.audience ? 'teamId'
           THEN jsonb_build_array(jsonb_build_object(
             'type', 'team',
             'targetResourceId', 'team:' || (notification.audience->>'teamId')
           ))
           ELSE '[]'::jsonb
         END AS relationships,
         (SELECT COUNT(*) FROM paths) AS total_path_rows,
         CASE WHEN notification.audience ? 'teamId' THEN 1 ELSE 0 END::bigint
           AS total_relationship_rows,
         notification.expires_at AS valid_until
    FROM resources notification
   ORDER BY notification.id::text`

export const GFS_HYDRATION_SQL = `
  WITH requested AS MATERIALIZED (SELECT UNNEST($2::uuid[]) AS id),
  resources AS MATERIALIZED (
    SELECT resource.*, COALESCE(revision.revision, 1)::text AS resource_revision
      FROM requested requested
      JOIN gfs_resources resource
        ON resource.resource_id = requested.id AND resource.deleted_at IS NULL
      LEFT JOIN authorization_resource_revisions revision
        ON revision.environment_id = $3 AND revision.resource_type = 'gfs_resource'
       AND revision.resource_id = resource.resource_id::text
  ), paths AS MATERIALIZED (
    SELECT * FROM (
      SELECT access_grant.resource_id::text AS logical_id,
             CASE WHEN access_grant.subject_type = 'user' THEN 'direct' ELSE 'team' END AS kind,
             'gfs_grants:' || access_grant.id AS grant_id,
             CASE WHEN access_grant.subject_type = 'team' THEN membership.team_id ELSE NULL END AS team_id,
             membership.role AS current_role, access_grant.permissions, access_grant.drive
        FROM resources resource
        JOIN gfs_grants access_grant ON access_grant.resource_id = resource.resource_id
        LEFT JOIN team_members membership
          ON access_grant.subject_type = 'team'
         AND membership.team_id::text = access_grant.subject_id
         AND membership.user_id = $1::uuid AND membership.status = 'active'
       WHERE (access_grant.subject_type = 'user' AND access_grant.subject_id = $1::text)
          OR (access_grant.subject_type = 'team' AND membership.team_id IS NOT NULL)
      UNION ALL
      SELECT share.resource_id::text,
             CASE WHEN share.subject_type = 'user' THEN 'direct' ELSE 'team' END,
             'gfs_shares:' || share.id,
             CASE WHEN share.subject_type = 'team' THEN membership.team_id ELSE NULL END,
             membership.role, share.permissions, share.drive
        FROM resources resource
        JOIN gfs_shares share ON share.resource_id = resource.resource_id
        LEFT JOIN team_members membership
          ON share.subject_type = 'team' AND membership.team_id::text = share.subject_id
         AND membership.user_id = $1::uuid AND membership.status = 'active'
       WHERE (share.subject_type = 'user' AND share.subject_id = $1::text)
          OR (share.subject_type = 'team' AND membership.team_id IS NOT NULL)
    ) all_paths
    ORDER BY logical_id, kind, team_id NULLS FIRST, grant_id
    LIMIT $4
  )
  SELECT resource.resource_id::text AS logical_id, resource.name AS display_name,
         NULL::text AS provider_uid, resource.resource_revision,
         COALESCE((
           SELECT jsonb_agg(to_jsonb(path) ORDER BY path.kind,
                            path.team_id NULLS FIRST, path.grant_id)
             FROM paths path WHERE path.logical_id = resource.resource_id::text
         ), '[]'::jsonb) AS paths,
         CASE WHEN resource.parent_resource_id IS NOT NULL
           THEN jsonb_build_array(jsonb_build_object(
             'type', 'parent',
             'targetResourceId', 'gfs_resource:' || resource.parent_resource_id
           ))
           ELSE '[]'::jsonb
         END AS relationships,
         (SELECT COUNT(*) FROM paths) AS total_path_rows,
         CASE WHEN resource.parent_resource_id IS NULL THEN 0 ELSE 1 END::bigint
           AS total_relationship_rows,
         NULL::timestamptz AS valid_until
    FROM resources resource
   ORDER BY resource.resource_id::text`
