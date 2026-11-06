-- Removes what an earlier head of the user access foundation change left in a
-- control-api database: its trigger functions (and, through CASCADE, their
-- triggers and expression indexes), its tables, its indexes on existing tables
-- and the migration receipts it recorded. The current head's migration runner
-- refuses to start on such a database until this has run.
--
-- Run it once, as the owner of the control-api schema, with that schema first
-- in search_path, while no control-api, migration Job or trace-maintenance
-- process is running. It keeps the current 0131_user_access_foundation and
-- 0132_legacy_password_security_epoch_backfill receipts: the session-table DDL
-- is identical in every head, and 0132 is idempotent if it runs again.
--
-- See docs/deploy/user-access-foundation-upgrade.md#databases-that-ran-an-earlier-head-of-this-change

BEGIN;

DO $$
DECLARE
  earlier_function regprocedure;
BEGIN
  FOR earlier_function IN
    SELECT fn.oid::regprocedure
      FROM pg_proc fn
      JOIN pg_namespace fn_ns ON fn_ns.oid = fn.pronamespace
     WHERE fn_ns.nspname = current_schema()
       AND (fn.proname LIKE 'authorization\_bump\_%' ESCAPE '\'
         OR fn.proname LIKE 'authorization\_prelock\_%' ESCAPE '\'
         OR fn.proname = 'catalog_utf8_bytes')
  LOOP
    EXECUTE format('DROP FUNCTION %s CASCADE', earlier_function);
  END LOOP;
END
$$;

DROP TABLE IF EXISTS
  authorization_catalog_environment,
  authorization_catalog_revision,
  authorization_catalog_writer_components,
  authorization_resource_revisions,
  authorization_team_revisions,
  authorization_user_revisions,
  invitation_delivery_commands,
  operational_catalog_source_state,
  operational_relationships_staging,
  operational_resource_index,
  operational_resource_index_staging,
  operational_resource_relationships
  CASCADE;

DROP INDEX IF EXISTS
  authorization_resource_revisions_updated_idx,
  gfs_grants_subject_resource_catalog_idx,
  gfs_shares_subject_resource_catalog_idx,
  invitation_delivery_commands_authorized_idx,
  invitation_delivery_commands_invitation_idx,
  notification_team_catalog_idx,
  notification_user_catalog_idx,
  operational_relationship_catalog_target_idx,
  operational_relationship_catalog_utf8_target_idx,
  operational_relationship_generation_idx,
  operational_relationship_source_idx,
  operational_relationship_staging_identity_idx,
  operational_relationship_target_idx,
  operational_resource_source_idx,
  operational_resource_staging_identity_idx,
  team_agents_catalog_utf8_idx,
  team_contexts_catalog_utf8_idx,
  team_workflow_triggers_catalog_key_idx,
  team_workflow_triggers_catalog_utf8_idx,
  team_workflow_triggers_recipe_team_idx,
  user_agents_catalog_utf8_idx,
  user_contexts_catalog_utf8_idx,
  user_workflow_triggers_catalog_key_idx,
  user_workflow_triggers_catalog_utf8_idx,
  user_workflow_triggers_recipe_user_idx,
  workflow_approval_team_catalog_idx,
  workflow_approval_user_catalog_idx,
  workflow_runs_actor_catalog_idx,
  workflow_runs_team_catalog_idx,
  workflow_runs_usage_team_catalog_idx;

DELETE FROM schema_migrations
 WHERE substring(version from '^[0-9a-f]{4}_(.+)$') = ANY (ARRAY[
         'user_access_foundation',
         'invitation_delivery_commands',
         'catalog_utf8_ordering',
         'composable_catalog_revisions',
         'gfs_catalog_revision_components',
         'legacy_password_security_epoch_backfill',
         'user_access_foundation_definer_temp_shadow_hardening',
         'authorization_revision_delete_compatibility'
       ])
   AND version <> ALL (ARRAY[
         '0131_user_access_foundation',
         '0132_legacy_password_security_epoch_backfill'
       ]);

COMMIT;
