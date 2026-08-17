import {
  GFS_E2E_DRIVE,
  UUID_RE,
  assertFixtureName,
  firstDataLine,
  gfsWriterPod,
  kubectlOut,
  ridOf,
  runControlPostgresSql,
  splitSqlRow,
  sqlLiteral,
} from './gfsFixtureCore'

export function assertGfsFixtureCleaned(name: string): void {
  assertFixtureName(name)
  const row = firstDataLine(
    runControlPostgresSql(`
      WITH fixture_resources AS (
        SELECT resource_id, kind, deleted_at
          FROM gfs_resources
         WHERE drive = ${sqlLiteral(GFS_E2E_DRIVE)}
           AND (path_cache = ${sqlLiteral(`/${name}`)} OR path_cache LIKE ${sqlLiteral(`/${name}/%`)})
      )
      SELECT
        COUNT(*) FILTER (WHERE deleted_at IS NULL)::text || '|' ||
        (SELECT COUNT(*) FROM gfs_grants
          WHERE resource_id IN (SELECT resource_id FROM fixture_resources))::text || '|' ||
        (SELECT COUNT(*) FROM gfs_shares
          WHERE resource_id IN (SELECT resource_id FROM fixture_resources))::text || '|' ||
        (SELECT COUNT(*) FROM gfs_blob_manifests
          WHERE resource_id IN (SELECT resource_id FROM fixture_resources))::text || '|' ||
        COALESCE(array_to_string(array_agg(resource_id::text) FILTER (WHERE kind = 'file'), ','), '')
        FROM fixture_resources;
    `)
  )
  const [activeResources, grants, shares, blobManifests, fileIds = ''] = splitSqlRow(row)
  if (activeResources !== '0' || grants !== '0' || shares !== '0' || blobManifests !== '0') {
    throw new Error(
      `GFS fixture ${name} leaked active resources, authority, or blob manifests: ${activeResources}|${grants}|${shares}|${blobManifests}`
    )
  }
  for (const resourceId of fileIds.split(',').filter(value => UUID_RE.test(value))) {
    const rid = ridOf(resourceId)
    kubectlOut(['-n', 'gfs', 'exec', gfsWriterPod(), '--', 'test', '!', '-e', `/data/gfs/${rid}`])
    kubectlOut([
      '-n',
      'gfs',
      'exec',
      gfsWriterPod(),
      '--',
      'test',
      '!',
      '-e',
      `/data/gfs/.generations/${rid}`,
    ])
  }
}
