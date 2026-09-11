import { beforeEach, describe, expect, it, vi } from 'vitest'
import { assertGfsFixtureCleaned } from '../../../tests/e2e/gfsFixtureCleanupAssertions'
import { cleanupGfsFixture } from '../../../tests/e2e/gfsResourceFixtures'

const { gfsWriterPodMock, kubectlOutMock, runControlPostgresSqlMock } = vi.hoisted(() => ({
  gfsWriterPodMock: vi.fn(() => 'gfsc-writer-test'),
  kubectlOutMock: vi.fn(() => ''),
  runControlPostgresSqlMock: vi.fn(),
}))

vi.mock('../../../tests/e2e/gfsFixtureCore', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../tests/e2e/gfsFixtureCore')>()),
  gfsWriterPod: gfsWriterPodMock,
  kubectlOut: kubectlOutMock,
  runControlPostgresSql: runControlPostgresSqlMock,
}))

const FIXTURE = 'e2e-gfs-v2-replace-cleanup'
const RESOURCE_ID = '70243f08-ba1d-45a6-b341-138a05bde79d'
const RESOURCE_RID = RESOURCE_ID.replaceAll('-', '')
const GENERATION = 'c85020b1-1111-4111-8111-111111111111'
const CURRENT_BLOB_KEY = `${RESOURCE_RID}/${GENERATION}`
const SUPERSEDED_GENERATION = 'd95020b1-2222-4222-8222-222222222222'
const SUPERSEDED_BLOB_KEY = `${RESOURCE_RID}/${SUPERSEDED_GENERATION}`

describe('GFS E2E fixture blob cleanup', () => {
  beforeEach(() => {
    gfsWriterPodMock.mockClear()
    kubectlOutMock.mockReset().mockReturnValue('')
    runControlPostgresSqlMock.mockReset()
  })

  it('removes the published generation and its superseded legacy flat blob before dropping their manifests', () => {
    runControlPostgresSqlMock
      .mockReturnValueOnce(
        `${RESOURCE_ID}|${CURRENT_BLOB_KEY}|${RESOURCE_RID}|legacy_flat|deleting\n`
      )
      .mockReturnValueOnce('')

    cleanupGfsFixture(FIXTURE)

    expect(kubectlOutMock).toHaveBeenCalledWith(
      [
        '-n',
        'gfs',
        'exec',
        'gfsc-writer-test',
        '--',
        'rm',
        '-f',
        `/data/gfs/.generations/${CURRENT_BLOB_KEY}`,
      ],
      20_000
    )
    expect(kubectlOutMock).toHaveBeenCalledWith(
      ['-n', 'gfs', 'exec', 'gfsc-writer-test', '--', 'rm', '-f', `/data/gfs/${RESOURCE_RID}`],
      20_000
    )
    const mutationSql = String(runControlPostgresSqlMock.mock.calls[1]?.[0] ?? '')
    expect(mutationSql).toContain('BEGIN;')
    expect(mutationSql).toContain('DELETE FROM gfs_blob_manifests')
    expect(mutationSql).toContain("WHERE state = 'deleting'")
    expect(mutationSql).toContain(`'${RESOURCE_RID}'`)
    expect(mutationSql).toContain('UPDATE gfs_resources')
    expect(mutationSql).toContain('COMMIT;')
  })

  it('rejects a generation key owned by another resource before deleting bytes or metadata', () => {
    const foreignKey = `${'a'.repeat(32)}/${GENERATION}`
    runControlPostgresSqlMock.mockReturnValue(`${RESOURCE_ID}|${foreignKey}|||\n`)

    expect(() => cleanupGfsFixture(FIXTURE)).toThrow('does not belong to resource')
    expect(kubectlOutMock).not.toHaveBeenCalled()
    expect(runControlPostgresSqlMock).toHaveBeenCalledOnce()
  })

  it('removes an exact superseded immutable generation recorded by the fixture ledger', () => {
    runControlPostgresSqlMock
      .mockReturnValueOnce(
        `${RESOURCE_ID}|${CURRENT_BLOB_KEY}|${SUPERSEDED_BLOB_KEY}|generation|deleting\n`
      )
      .mockReturnValueOnce('')

    cleanupGfsFixture(FIXTURE)

    expect(kubectlOutMock).toHaveBeenCalledWith(
      [
        '-n',
        'gfs',
        'exec',
        'gfsc-writer-test',
        '--',
        'rm',
        '-f',
        `/data/gfs/.generations/${SUPERSEDED_BLOB_KEY}`,
      ],
      20_000
    )
    const mutationSql = String(runControlPostgresSqlMock.mock.calls[1]?.[0] ?? '')
    expect(mutationSql).toContain(`'${SUPERSEDED_BLOB_KEY}'`)
  })

  it('never races production by deleting a staged or committed manifest', () => {
    runControlPostgresSqlMock.mockReturnValue(
      `${RESOURCE_ID}|${CURRENT_BLOB_KEY}|${CURRENT_BLOB_KEY}|generation|staged\n`
    )

    expect(() => cleanupGfsFixture(FIXTURE)).toThrow('invalid GFS fixture blob manifest row')
    expect(kubectlOutMock).not.toHaveBeenCalled()
    expect(runControlPostgresSqlMock).toHaveBeenCalledOnce()
  })

  it('retains fixture metadata when an exact physical cleanup fails', () => {
    runControlPostgresSqlMock.mockReturnValue(
      `${RESOURCE_ID}|${CURRENT_BLOB_KEY}|${RESOURCE_RID}|legacy_flat|deleting\n`
    )
    kubectlOutMock.mockImplementationOnce(() => {
      throw new Error('simulated unlink failure')
    })

    expect(() => cleanupGfsFixture(FIXTURE)).toThrow(`failed to fully clean GFS fixture ${FIXTURE}`)
    expect(runControlPostgresSqlMock).toHaveBeenCalledOnce()
  })

  it('proves fixture manifests, legacy bytes, and the generation directory are all absent', () => {
    runControlPostgresSqlMock.mockReturnValue(`0|0|0|0|${RESOURCE_ID}\n`)

    assertGfsFixtureCleaned(FIXTURE)

    expect(kubectlOutMock).toHaveBeenCalledWith([
      '-n',
      'gfs',
      'exec',
      'gfsc-writer-test',
      '--',
      'test',
      '!',
      '-e',
      `/data/gfs/${RESOURCE_RID}`,
    ])
    expect(kubectlOutMock).toHaveBeenCalledWith([
      '-n',
      'gfs',
      'exec',
      'gfsc-writer-test',
      '--',
      'test',
      '!',
      '-e',
      `/data/gfs/.generations/${RESOURCE_RID}`,
    ])
  })

  it('rejects leftover blob-manifest authority even when resources are tombstoned', () => {
    runControlPostgresSqlMock.mockReturnValue(`0|0|0|1|${RESOURCE_ID}\n`)

    expect(() => assertGfsFixtureCleaned(FIXTURE)).toThrow(
      `GFS fixture ${FIXTURE} leaked active resources, authority, or blob manifests: 0|0|0|1`
    )
    expect(kubectlOutMock).not.toHaveBeenCalled()
  })
})
