import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../logger'
import { VisualInputError } from '../visualInput/policy'
import { type GfscReadClient, buildGfsReadTools } from './gfs'
import { GfscHttpError } from './gfsClient'
import { GfsDownloadError } from './gfsContentDownload'
import { GfsDownloadStore, GfsDownloadStoreError } from './gfsDownloadStore'

const target = { drive: 'main', resourceId: 'a'.repeat(32) }
const warningMessage = 'GFS workspace download failed'
// Synthetic private-looking data verifies omission, without real grants or user data.
const privateDetail =
  'unit-only-server-detail /unit-only/storage.csv https://unit-only.invalid/body'

function harness() {
  const download = vi.fn<NonNullable<GfscReadClient['download']>>()
  const client = {
    accessible: vi.fn(),
    list: vi.fn(),
    read: vi.fn(),
    download,
    stat: vi.fn(),
    resolve: vi.fn(),
  } satisfies GfscReadClient
  const tool = buildGfsReadTools(client, {
    referencedFiles: new Map(),
    // The injected download never touches this uninitialized store or these paths.
    downloadStore: new GfsDownloadStore('/unit-only-host-workspace'),
    callerIdentity: 'unit-only-caller',
    callerWorkspacePath: '/unit-only-host-workspace/caller',
  }).find(item => item.name === 'clerum__gfs_download')!
  return { tool, download }
}

beforeEach(() => {
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GFS download failure diagnostics', () => {
  it('logs only the normalized public target and HTTP prefix, preserving the redacted failure', async () => {
    const { tool, download } = harness()
    const error = Object.assign(new Error(`gfsc 403: ${privateDetail}`), {
      name: 'unit-only-private-error-name',
      code: 'unit-only-private-error-code',
      body: privateDetail,
      headers: { authorization: 'unit-only-http-identity' },
    })
    download.mockRejectedValue(error)

    const result = await tool.execute(
      {
        drive: 'main_1',
        resourceId: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
        content: privateDetail,
        url: 'https://unit-only.invalid/body',
        headers: error.headers,
      },
      '/unit-only-output-path'
    )

    expect(result).toEqual({ success: false, error: 'GFS read failed (gfsc 403: forbidden)' })
    expect(vi.mocked(logger.warn).mock.calls).toEqual([
      [
        {
          component: 'GfsDownload',
          drive: 'main_1',
          resourceId: target.resourceId,
          httpStatus: 403,
          errorClass: 'Error',
        },
        warningMessage,
      ],
    ])
  })

  it('uses a typed HTTP status independently of private message content', async () => {
    const { tool, download } = harness()
    const error = new GfscHttpError(403, privateDetail)
    error.message = privateDetail
    download.mockRejectedValue(error)

    const result = await tool.execute(target, '/unit-only-output-path')

    expect(result).toEqual({ success: false, error: 'GFS read failed' })
    expect(vi.mocked(logger.warn).mock.calls).toEqual([
      [
        { component: 'GfsDownload', ...target, httpStatus: 403, errorClass: 'GfscHttpError' },
        warningMessage,
      ],
    ])
  })

  it.each([
    { drive: 'main/private', resourceId: 'gfs://main/private' },
    { drive: 'a'.repeat(65), resourceId: '/unit-only/private/path' },
    { drive: 'main\n', resourceId: `${target.resourceId}\n` },
  ])('omits unsafe or unbounded target identifiers: %j', async args => {
    const { tool, download } = harness()
    download.mockRejectedValue(new Error(`gfsc 403: ${privateDetail}`))

    await tool.execute(args, '/unit-only-output-path')

    expect(vi.mocked(logger.warn).mock.calls).toEqual([
      [{ component: 'GfsDownload', httpStatus: 403, errorClass: 'Error' }, warningMessage],
    ])
  })

  it('does not trust arbitrary status, name or code fields, or an HTTP phrase inside the body', async () => {
    const { tool, download } = harness()
    download.mockRejectedValue(
      Object.assign(new Error(`unit-only-body mentioning gfsc 403: ${privateDetail}`), {
        status: 403,
        name: 'GfscHttpError',
        code: privateDetail,
      })
    )

    await tool.execute(target, '/unit-only-output-path')

    expect(vi.mocked(logger.warn).mock.calls).toEqual([
      [{ component: 'GfsDownload', ...target, errorClass: 'Error' }, warningMessage],
    ])
  })

  it.each([99, 600])('omits an out-of-range typed HTTP status (%i)', async status => {
    const { tool, download } = harness()
    download.mockRejectedValue(new GfscHttpError(status, privateDetail))

    await tool.execute(target, '/unit-only-output-path')

    expect(vi.mocked(logger.warn).mock.calls).toEqual([
      [{ component: 'GfsDownload', ...target, errorClass: 'GfscHttpError' }, warningMessage],
    ])
  })

  it.each([
    [new GfsDownloadError('invalid_response'), 'GfsDownloadError'],
    [new GfsDownloadStoreError('workspace_unavailable'), 'GfsDownloadStoreError'],
    [new VisualInputError('invalid_response'), 'VisualInputError'],
  ] as const)(
    'retains the known error class without exposing the error object: %s',
    async (error, errorClass) => {
      const { tool, download } = harness()
      download.mockRejectedValue(error)

      const result = await tool.execute(target, '/unit-only-output-path')

      expect(result).toEqual({ success: false, error: error.message })
      expect(vi.mocked(logger.warn).mock.calls).toEqual([
        [{ component: 'GfsDownload', ...target, errorClass }, warningMessage],
      ])
    }
  )

  it('keeps a pinned version conflict as the existing stale receipt', async () => {
    const { tool, download } = harness()
    download.mockRejectedValue(new GfsDownloadError('version_conflict'))

    const result = await tool.execute({ ...target, expectedVersion: 7 }, '/unit-only-output-path')

    expect(result.success).toBe(true)
    expect(JSON.parse(result.content!)).toEqual({
      availability: 'stale',
      ...target,
      expectedVersion: 7,
    })
    expect(vi.mocked(logger.warn).mock.calls).toEqual([
      [{ component: 'GfsDownload', ...target, errorClass: 'GfsDownloadError' }, warningMessage],
    ])
  })

  it('does not copy fields from a non-Error thrown value', async () => {
    const { tool, download } = harness()
    download.mockRejectedValue({ message: privateDetail, status: 403, code: privateDetail })

    await tool.execute(target, '/unit-only-output-path')

    expect(vi.mocked(logger.warn).mock.calls).toEqual([
      [{ component: 'GfsDownload', ...target, errorClass: 'unknown' }, warningMessage],
    ])
  })

  it('does not warn on a successful workspace transfer', async () => {
    const { tool, download } = harness()
    download.mockResolvedValue({
      id: 'unit-download',
      source: {
        kind: 'gfs',
        ...target,
        gfsUri: `gfs://main/${target.resourceId}`,
        name: 'unit.csv',
        version: 7,
      },
      path: '.gfs-downloads/unit-download/source',
      sizeBytes: 1,
      sha256: 'a'.repeat(64),
      expiresAt: '2026-10-09T00:00:00.000Z',
    })

    const result = await tool.execute(target, '/unit-only-output-path')

    expect(result.success).toBe(true)
    expect(JSON.parse(result.content!).delivery).toBe('workspace_file')
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
