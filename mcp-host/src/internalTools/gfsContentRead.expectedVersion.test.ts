/**
 * #666 — `expectedVersion` binds a structured file reference to the version it
 * was taken at: a different metadata snapshot fails before any content request.
 */
import { describe, expect, it, vi } from 'vitest'
import { VisualInputBudget } from '../visualInput/policy'
import { readGfsContent } from './gfsContentRead'

const FILE_ID = '1234567890abcdef1234567890abcdef'
const FILE_URI = `gfs://main/${FILE_ID}`
const READ_ARGS = { drive: 'main', resourceId: FILE_ID }
const SENTINEL = Buffer.from('SENTINEL-666-gfs-version')

function harness(version: number) {
  const request = vi.fn(async (path: string, _init: RequestInit, _deadlineMs: number) => {
    if (!path.includes('/content?'))
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            resourceId: FILE_ID,
            rid: FILE_ID,
            drive: 'main',
            gfsUri: FILE_URI,
            kind: 'file',
            name: 'notes.txt',
            version,
            bytes: SENTINEL.length,
          },
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    return new Response(new Uint8Array(SENTINEL), {
      headers: {
        'x-gfs-uri': FILE_URI,
        'x-gfs-version': String(version),
        'content-length': String(SENTINEL.length),
      },
    })
  })
  const contentRequests = () =>
    request.mock.calls.filter(([path]) => path.includes('/content?')).length
  const metadataRequests = () =>
    request.mock.calls.filter(([path]) => !path.includes('/content?')).length
  return { request, contentRequests, metadataRequests, budget: new VisualInputBudget() }
}

describe('readGfsContent expectedVersion (#666)', () => {
  it.each([3, 0])('returns the bytes when the snapshot is at version %i', async version => {
    const { request, contentRequests, budget } = harness(version)
    const result = await readGfsContent(request, READ_ARGS, { budget, expectedVersion: version })
    expect(result.bytes.equals(SENTINEL)).toBe(true)
    expect(result.source).toMatchObject({ gfsUri: FILE_URI, version })
    expect(contentRequests()).toBe(1)
    result.reservation.release()
    expect(budget.residentBytes).toBe(0)
  })

  it.each([
    [3, 4],
    [3, 0],
    [0, 1],
  ])(
    'fails with version_conflict before requesting content (snapshot v%i, expected v%i)',
    async (version, expectedVersion) => {
      const { request, contentRequests, metadataRequests, budget } = harness(version)
      await expect(
        readGfsContent(request, READ_ARGS, { budget, expectedVersion })
      ).rejects.toMatchObject({ code: 'version_conflict' })
      // Witness: the metadata snapshot was read, and the decision was made on it.
      expect(metadataRequests()).toBe(1)
      expect(contentRequests()).toBe(0)
      expect(budget.readBytes).toBe(0)
      expect(budget.residentBytes).toBe(0)
    }
  )

  it('reads any version when no expectedVersion is given', async () => {
    const { request, contentRequests, budget } = harness(7)
    const result = await readGfsContent(request, READ_ARGS, { budget })
    expect(result.source.version).toBe(7)
    expect(contentRequests()).toBe(1)
    result.reservation.release()
  })
})
