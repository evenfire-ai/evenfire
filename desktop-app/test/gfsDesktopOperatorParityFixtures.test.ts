import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GfsOperatorLinkGeneration } from './e2e-playwright/gfsDesktopOperatorParityContract'
import { GfsDesktopOperatorJourney } from './e2e-playwright/helpers/gfsDesktopOperatorParityFixtures'

const runControlPostgresSqlMock = vi.hoisted(() => vi.fn())
const cleanupGfsFixtureMock = vi.hoisted(() => vi.fn())

vi.mock('../../tests/e2e/gfsFixtureCore', () => ({
  UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  firstDataLine: (output: string) =>
    output
      .split('\n')
      .map(line => line.trim())
      .find(line => line.length > 0 && !/^\(\d+ rows?\)$/.test(line)) ?? '',
  kubectlOut: vi.fn(),
  runControlPostgresSql: runControlPostgresSqlMock,
  splitSqlRow: (row: string) => row.split('|').map(value => value.trim()),
  sqlLiteral: (value: string) => `'${value.replace(/'/g, "''")}'`,
}))

vi.mock('../../tests/e2e/gfsResourceFixtures', () => ({
  cleanupGfsFixture: cleanupGfsFixtureMock,
}))

const DESKTOP_USER_ID = '5a50453e-04d1-4403-8473-23013eaa56c7'
const CONTROL_ADMIN_ID = 'ef72208d-783a-4574-9181-440a6764fa27'
const LINEAGE_ID = 'd4d2c593-6932-488e-844c-c5852b910783'
const FIRST_GENERATION_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_GENERATION_ID = '22222222-2222-4222-8222-222222222222'
const environment = {
  E2E_GFS_OPERATOR_RUN_ID: 'fixture-contract',
  CONTROL_UI_BASE_URL: 'http://127.0.0.1:45101',
  CONTROL_API_BASE_URL: 'http://127.0.0.1:45102',
  EXTERNAL_REST_API_BASE_URL: 'http://127.0.0.1:45103',
  RPC_PROXY_BASE_URL: 'http://127.0.0.1:45104',
}
const originalEnvironment = new Map<string, string | undefined>()

function generation(overrides: Partial<GfsOperatorLinkGeneration> = {}): GfsOperatorLinkGeneration {
  return {
    id: FIRST_GENERATION_ID,
    lineageId: LINEAGE_ID,
    generation: 1,
    predecessorId: null,
    state: 'revoked',
    desktopUserId: DESKTOP_USER_ID,
    controlAdminId: CONTROL_ADMIN_ID,
    source: 'initial_setup',
    createdByControlAdminId: CONTROL_ADMIN_ID,
    rowVersion: 2,
    revokedAt: '2026-08-11T09:00:00.000Z',
    revokedByType: 'control_admin',
    revokedById: CONTROL_ADMIN_ID,
    revokedByControlAdminId: CONTROL_ADMIN_ID,
    revokedByDesktopUserId: null,
    revocationReason: 'control_ui_revoke',
    ...overrides,
  }
}

function createJourney(): GfsDesktopOperatorJourney {
  const journey = new GfsDesktopOperatorJourney(
    {} as never,
    { project: { outputDir: '/private/tmp/gfs-operator-fixture-contract' } } as never
  )
  journey.operatorLink = {
    desktopUserId: DESKTOP_USER_ID,
    controlAdminId: CONTROL_ADMIN_ID,
    source: 'initial_setup',
  }
  return journey
}

describe('GFS Desktop operator generation evidence fixture', () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(environment)) {
      originalEnvironment.set(key, process.env[key])
      process.env[key] = value
    }
    runControlPostgresSqlMock.mockReset()
    cleanupGfsFixtureMock.mockReset()
  })

  afterEach(() => {
    for (const key of Object.keys(environment)) {
      const original = originalEnvironment.get(key)
      if (original === undefined) delete process.env[key]
      else process.env[key] = original
    }
    originalEnvironment.clear()
  })

  it('counts active authority separately from retained revoked history', () => {
    runControlPostgresSqlMock.mockReturnValue('0\n')

    expect(createJourney().countActiveLinks()).toBe(0)

    const sql = String(runControlPostgresSqlMock.mock.calls[0]?.[0])
    expect(sql).toContain("AND state = 'active'")
    expect(sql).toMatch(/^\s*SELECT/m)
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i)
  })

  it('reads immutable history in generation order and validates the active successor', () => {
    const first = generation()
    const successor = generation({
      id: SECOND_GENERATION_ID,
      generation: 2,
      predecessorId: FIRST_GENERATION_ID,
      state: 'active',
      rowVersion: 1,
      revokedAt: null,
      revokedByType: null,
      revokedById: null,
      revokedByControlAdminId: null,
      revocationReason: null,
    })
    runControlPostgresSqlMock.mockReturnValue(
      `\n${JSON.stringify(first)}\n${JSON.stringify(successor)}\n`
    )

    expect(
      createJourney().assertGenerationChain({
        activeCount: 1,
        revokedCount: 1,
      })
    ).toEqual([first, successor])

    const sql = String(runControlPostgresSqlMock.mock.calls[0]?.[0])
    expect(sql).toContain('ORDER BY generation ASC, id ASC')
    expect(sql).toContain("'predecessorId', predecessor_id::text")
    expect(sql).toContain("'revokedByControlAdminId', revoked_by_control_admin_id::text")
    expect(sql).toMatch(/^\s*SELECT/m)
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i)
  })

  it('reads each governed lifecycle event for the exact pair and source without collapsing retries', () => {
    const createdEvent = {
      eventId: '33333333-3333-4333-8333-333333333333',
      action: 'permission_grant',
      outcome: 'committed',
      operatorSub: CONTROL_ADMIN_ID,
      targetRef: `gfs_desktop_operator_link:${DESKTOP_USER_ID}:${CONTROL_ADMIN_ID}`,
      sourceAuditRef: 'gfs_desktop_operator_link_source:initial_setup',
      status: 'linked',
      detailRef: `event:link.created;desktop_user_id:${DESKTOP_USER_ID};control_admin_id:${CONTROL_ADMIN_ID};source:initial_setup;lineage_id:${LINEAGE_ID};generation:1`,
      requestId: 'request-1',
      operationId: null,
    }
    const revokedEvent = {
      ...createdEvent,
      eventId: '44444444-4444-4444-8444-444444444444',
      action: 'permission_revoke',
      status: 'unlinked',
      detailRef: `event:link.revoked;desktop_user_id:${DESKTOP_USER_ID};control_admin_id:${CONTROL_ADMIN_ID};source:initial_setup;lineage_id:${LINEAGE_ID};generation:1;reason:control_ui_revoke`,
      requestId: 'request-2',
    }
    runControlPostgresSqlMock.mockReturnValue(
      `\n${JSON.stringify(createdEvent)}\n${JSON.stringify(revokedEvent)}\n`
    )

    expect(createJourney().readLinkLifecycleEvents()).toEqual([createdEvent, revokedEvent])

    const sql = String(runControlPostgresSqlMock.mock.calls[0]?.[0])
    expect(sql).toContain(`target_ref = '${createdEvent.targetRef}'`)
    expect(sql).toContain(`source_audit_ref = '${createdEvent.sourceAuditRef}'`)
    expect(sql).toContain('ORDER BY occurred_at ASC, event_id ASC')
    expect(sql).toMatch(/^\s*SELECT/m)
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i)
  })
})
