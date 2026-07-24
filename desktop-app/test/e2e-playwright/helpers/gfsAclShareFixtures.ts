import {
  UUID_RE,
  runControlPostgresSql,
  sqlLiteral,
} from '../../../../tests/e2e/gfsUiFixtures'

/**
 * Named setup precondition: shares may target users/teams, never managed Host
 * subjects. Keeping one real source share makes the E2E prove both halves of
 * the Copy ACL contract: the source row is unchanged and no destination row is
 * cloned.
 */
export function seedIssue797SourceShare(resourceId: string, shareUserId: string): string {
  if (!UUID_RE.test(resourceId) || !UUID_RE.test(shareUserId)) {
    throw new Error('issue #797 source share requires UUID resource and user subjects')
  }
  const shareId = runControlPostgresSql(`
    INSERT INTO gfs_shares (
      drive, resource_id, subject_type, subject_id, permissions,
      include_descendants, created_by
    )
    VALUES (
      'main', ${sqlLiteral(resourceId)}::uuid, 'user', ${sqlLiteral(shareUserId)},
      ARRAY['read']::text[], true, 'e2e:issue-797-source-share'
    )
    ON CONFLICT (drive, resource_id, subject_type, subject_id)
    DO UPDATE SET
      permissions = EXCLUDED.permissions,
      include_descendants = EXCLUDED.include_descendants,
      created_by = EXCLUDED.created_by
    RETURNING id::text;
  `)
    .split('\n')
    .map(line => line.trim())
    .find(line => UUID_RE.test(line))
  if (!shareId) throw new Error('failed to seed issue #797 source user share')
  return shareId
}

/** Canonical JSONB rows for every direct grant/share under a resource tree. */
export function getGfsTreeAclShareRows(rootId: string): string[] {
  if (!UUID_RE.test(rootId)) throw new Error(`invalid GFS root id: ${rootId}`)
  return runControlPostgresSql(`
    WITH RECURSIVE tree AS (
      SELECT resource_id FROM gfs_resources
       WHERE drive = 'main' AND resource_id = ${sqlLiteral(rootId)}::uuid
         AND deleted_at IS NULL
      UNION ALL
      SELECT child.resource_id FROM gfs_resources child
        JOIN tree ON child.parent_resource_id = tree.resource_id
       WHERE child.drive = 'main' AND child.deleted_at IS NULL
    ), acl_rows AS (
      SELECT 'grant'::text AS row_kind, id::text AS row_id,
             jsonb_build_object('kind', 'grant', 'row', to_jsonb(g))::text AS row_json
        FROM gfs_grants g WHERE resource_id IN (SELECT resource_id FROM tree)
      UNION ALL
      SELECT 'share'::text AS row_kind, id::text AS row_id,
             jsonb_build_object('kind', 'share', 'row', to_jsonb(s))::text AS row_json
        FROM gfs_shares s WHERE resource_id IN (SELECT resource_id FROM tree)
    )
    SELECT row_json FROM acl_rows ORDER BY row_kind, row_id;
  `)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('{') && line.endsWith('}'))
}
