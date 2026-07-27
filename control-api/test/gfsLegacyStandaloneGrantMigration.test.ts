import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  LEGACY_STANDALONE_SUBJECT_KEY,
  applyReviewedLegacyGrantMigration,
  buildLegacyGrantMigrationReport,
  validateReviewedLegacyGrantMapping,
} from '../src/gfs/legacyStandaloneGrantMigration.js'
import { createGfsRouter } from '../src/routes/gfs/index.js'
import { listLegacyStandaloneGrants } from '../src/routes/gfs/legacyStandaloneGrants.js'

const SOURCE_ID = '10000000-0000-4000-8000-000000000001'
const RESOURCE_ID = '20000000-0000-4000-8000-000000000001'
const SOURCE_GRANT = {
  id: SOURCE_ID,
  drive: 'main',
  resourceId: RESOURCE_ID,
  permissions: ['write', 'read'],
  inherit: true,
}
const HOST_A = {
  name: 'agent-a',
  namespace: 'mcp-host',
  displayName: 'Agent A',
  active: true,
  gfsSubject: { type: 'host', id: '1st:mcp-host/agent-a' },
}
const HOST_B = {
  name: 'agent-b',
  namespace: 'mcp-host',
  displayName: 'Agent B',
  active: true,
  gfsSubject: { type: 'host', id: '1st:mcp-host/agent-b' },
}

function makeApi(hosts = [HOST_A, HOST_B]) {
  return {
    getLegacyGrants: vi.fn(async () => ({
      sourceSubject: LEGACY_STANDALONE_SUBJECT_KEY,
      grants: [SOURCE_GRANT],
    })),
    getTrustedHostDirectory: vi.fn(async () => ({ agents: hosts })),
    putGrant: vi.fn(async () => ({ ok: true, status: 200 })),
  }
}

async function reviewedMapping(api: ReturnType<typeof makeApi>, targets: string[]) {
  const report = await buildLegacyGrantMigrationReport(api)
  return {
    ...report.mappingTemplate,
    mappings: [{ sourceGrantId: SOURCE_ID, targets }],
  }
}

describe('legacy standalone GFS grant migration', () => {
  it('registers the authenticated legacy inventory endpoint exactly once', () => {
    const router = createGfsRouter() as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>
    }
    const registrations = router.stack.filter(
      layer =>
        layer.route?.path === '/gfs/grants/legacy-standalone' &&
        layer.route.methods.get === true
    )

    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.route).toMatchObject({
      path: '/gfs/grants/legacy-standalone',
      methods: { get: true },
    })
  })

  it('reports deterministic legacy grants and valid candidates without inferring assignments', async () => {
    const api = makeApi([
      HOST_B,
      { ...HOST_A, active: false },
      HOST_A,
      {
        name: 'standalone',
        namespace: 'mcp-host',
        displayName: 'Standalone',
        active: true,
        gfsSubject: { type: 'host', id: '1st:mcp-host/standalone' },
      },
    ])
    const report = await buildLegacyGrantMigrationReport(api)

    expect(report.sourceGrants).toEqual([{ ...SOURCE_GRANT, permissions: ['read', 'write'] }])
    expect(report.validIndividualHostCandidates.map(item => item.name)).toEqual(['agent-a', 'agent-b'])
    expect(report.mappingTemplate.mappings).toEqual([{ sourceGrantId: SOURCE_ID, targets: [] }])
    expect(api.putGrant).not.toHaveBeenCalled()
  })

  it('requires an explicit exact canonical Host mapping and preserves the source row', async () => {
    const api = makeApi()
    const mapping = await reviewedMapping(api, ['host:1st:mcp-host/agent-a'])
    api.getLegacyGrants.mockClear()
    api.getTrustedHostDirectory.mockClear()

    const result = await applyReviewedLegacyGrantMigration(api, mapping)

    expect(api.getLegacyGrants).toHaveBeenCalledTimes(1)
    expect(api.getTrustedHostDirectory).toHaveBeenCalledTimes(1)
    expect(api.putGrant).toHaveBeenCalledWith({
      drive: 'main',
      resourceId: RESOURCE_ID,
      subject: { type: 'host', id: '1st:mcp-host/agent-a' },
      permissions: ['read', 'write'],
      inherit: true,
    })
    expect(result).toMatchObject({
      allApprovedIndividualGrantsSucceeded: true,
      legacyGrantsDeleted: false,
      sources: [{ legacyGrantPreserved: true, readyForRetirement: true }],
    })
  })

  it('reports partial failure and supports an idempotent retry through the same audited API', async () => {
    const api = makeApi()
    const mapping = await reviewedMapping(api, [
      'host:1st:mcp-host/agent-a',
      'host:1st:mcp-host/agent-b',
    ])
    let failB = true
    api.putGrant.mockImplementation(async body => ({
      ok: !(failB && JSON.stringify(body).includes('agent-b')),
      status: failB && JSON.stringify(body).includes('agent-b') ? 503 : 200,
    }))

    const first = await applyReviewedLegacyGrantMigration(api, mapping)
    expect(first.sources[0]).toMatchObject({
      legacyGrantPreserved: true,
      readyForRetirement: false,
    })
    expect(api.putGrant).toHaveBeenCalledTimes(2)

    failB = false
    api.putGrant.mockClear()
    const retry = await applyReviewedLegacyGrantMigration(api, mapping)
    expect(api.putGrant).toHaveBeenCalledTimes(2)
    expect(retry).toMatchObject({
      allApprovedIndividualGrantsSucceeded: true,
      legacyGrantsDeleted: false,
    })
  })

  it('rejects a stale trusted directory before any apply request', async () => {
    const api = makeApi()
    const mapping = await reviewedMapping(api, ['host:1st:mcp-host/agent-a'])
    api.getTrustedHostDirectory.mockResolvedValue({ agents: [HOST_B] })

    await expect(applyReviewedLegacyGrantMigration(api, mapping)).rejects.toThrow(
      'trusted_host_directory_changed'
    )
    expect(api.putGrant).not.toHaveBeenCalled()
  })

  it('rejects duplicate targets and broad or sentinel subjects', async () => {
    const api = makeApi()
    const report = await buildLegacyGrantMigrationReport(api)
    const duplicate = {
      ...report.mappingTemplate,
      mappings: [{
        sourceGrantId: SOURCE_ID,
        targets: ['host:1st:mcp-host/agent-a', 'host:1st:mcp-host/agent-a'],
      }],
    }
    expect(() => validateReviewedLegacyGrantMapping(report, duplicate)).toThrow(
      'mapping_target_duplicate'
    )

    for (const target of [
      LEGACY_STANDALONE_SUBJECT_KEY,
      'team:all-agents',
      'host:1st:mcp-host/all-agents',
    ]) {
      expect(() => validateReviewedLegacyGrantMapping(report, {
        ...report.mappingTemplate,
        mappings: [{ sourceGrantId: SOURCE_ID, targets: [target] }],
      })).toThrow('mapping_target_not_current_trusted_host')
    }
  })

  it('uses a bounded read-only query for inventory and no direct grant-row SQL in apply', async () => {
    const query = vi.fn(async () => ({ rows: [
      {
        id: SOURCE_ID,
        drive: 'main',
        resource_id: RESOURCE_ID,
        permissions: ['write', 'read'],
        inherit: true,
      },
    ] }))
    await expect(listLegacyStandaloneGrants({ query })).resolves.toEqual([
      { ...SOURCE_GRANT, permissions: ['read', 'write'] },
    ])
    expect(query.mock.calls[0][0]).toMatch(/^SELECT[\s\S]+WHERE subject_type = 'host'/)
    expect(query.mock.calls[0][0]).toContain('LIMIT $2')
    expect(query.mock.calls[0][1]).toEqual(['1st:mcp-host/standalone', 1001])

    const script = await readFile(new URL('../../scripts/gfs-legacy-standalone-grants.mjs', import.meta.url), 'utf8')
    expect(script).not.toMatch(/INSERT\s+INTO|UPDATE\s+gfs_grants|DELETE\s+FROM/i)
    expect(script).toContain("'/api/v1/gfs/grants'")
  })

  it('rejects legacy inventory when the bounded query detects row 1001', async () => {
    const query = vi.fn(async () => ({
      rows: Array.from({ length: 1001 }, (_, index) => ({ id: String(index) })),
    }))

    await expect(listLegacyStandaloneGrants({ query })).rejects.toThrow(
      'legacy_grant_report_limit_exceeded'
    )
    expect(query).toHaveBeenCalledWith(expect.stringContaining('LIMIT $2'), [
      '1st:mcp-host/standalone',
      1001,
    ])
  })

  it('fails closed instead of copying or silently reducing forbidden legacy permissions', async () => {
    for (const permission of ['delete', 'manage_acl', 'share']) {
      const api = makeApi()
      api.getLegacyGrants.mockResolvedValue({
        sourceSubject: LEGACY_STANDALONE_SUBJECT_KEY,
        grants: [{ ...SOURCE_GRANT, permissions: ['read', permission] }],
      })

      await expect(buildLegacyGrantMigrationReport(api)).rejects.toThrow(
        'legacy_grant_permissions_forbidden'
      )
      expect(api.putGrant).not.toHaveBeenCalled()
    }
  })
})
