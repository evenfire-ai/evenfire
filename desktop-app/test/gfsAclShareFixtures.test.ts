import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getGfsTreeAclShareRows,
  seedIssue797SourceShare,
} from './e2e-playwright/helpers/gfsAclShareFixtures'

const runControlPostgresSqlMock = vi.hoisted(() => vi.fn())

vi.mock('../../tests/e2e/gfsUiFixtures', () => ({
  UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  runControlPostgresSql: runControlPostgresSqlMock,
  sqlLiteral: (value: string) => `'${value.replace(/'/g, "''")}'`,
}))

describe('issue #797 GFS ACL/share fixture evidence', () => {
  beforeEach(() => runControlPostgresSqlMock.mockReset())

  it('seeds the named source share for a user, never a Host subject', () => {
    runControlPostgresSqlMock.mockReturnValue('d4d2c593-6932-488e-844c-c5852b910783\n')

    expect(
      seedIssue797SourceShare(
        '5a50453e-04d1-4403-8473-23013eaa56c7',
        'ef72208d-783a-4574-9181-440a6764fa27'
      )
    ).toBe('d4d2c593-6932-488e-844c-c5852b910783')

    const sql = String(runControlPostgresSqlMock.mock.calls[0]?.[0])
    expect(sql).toContain("'user', 'ef72208d-783a-4574-9181-440a6764fa27'")
    expect(sql).toContain("ARRAY['read']::text[], true")
    expect(sql).not.toContain("'host'")
  })

  it('returns stable full-row JSON evidence for both grants and shares', () => {
    const rows = [
      '{"kind":"grant","row":{"id":"grant-1"}}',
      '{"kind":"share","row":{"id":"share-1"}}',
    ]
    runControlPostgresSqlMock.mockReturnValue(`\n${rows.join('\n')}\n`)

    expect(getGfsTreeAclShareRows('5a50453e-04d1-4403-8473-23013eaa56c7')).toEqual(rows)
    const sql = String(runControlPostgresSqlMock.mock.calls[0]?.[0])
    expect(sql).toContain("jsonb_build_object('kind', 'grant', 'row', to_jsonb(g))")
    expect(sql).toContain("jsonb_build_object('kind', 'share', 'row', to_jsonb(s))")
    expect(sql).toContain('ORDER BY row_kind, row_id')
  })

  it('rejects an invalid root before querying PostgreSQL', () => {
    expect(() => getGfsTreeAclShareRows('not-a-resource-id')).toThrow('invalid GFS root id')
    expect(runControlPostgresSqlMock).not.toHaveBeenCalled()
  })
})
