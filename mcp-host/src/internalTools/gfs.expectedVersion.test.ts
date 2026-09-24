/**
 * #666 — `clerum__gfs_read` with `expectedVersion`. The tool runs over the real
 * `readGfsContent` behind an HTTP double, so the version decision is the one
 * production makes.
 */
import { describe, expect, it, vi } from 'vitest'
import { type GfscReadClient, type ReferencedFilePins, buildGfsReadTools } from './gfs'
import { readGfsContent } from './gfsContentRead'

const FILE_ID = '1234567890abcdef1234567890abcdef'
const FILE_URI = `gfs://main/${FILE_ID}`
const SENTINEL = 'SENTINEL-666-gfs-read-version'

function harness(
  snapshotVersion: number,
  contentVersion = snapshotVersion,
  referencedFiles: ReferencedFilePins = new Map(),
  contentUri = FILE_URI
) {
  const bytes = Buffer.from(SENTINEL)
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
            version: snapshotVersion,
            bytes: bytes.length,
          },
        })
      )
    return new Response(new Uint8Array(bytes), {
      headers: { 'x-gfs-uri': contentUri, 'x-gfs-version': String(contentVersion) },
    })
  })
  const read = vi.fn<GfscReadClient['read']>((args, options) =>
    readGfsContent(request, args, options ?? {})
  )
  const client: GfscReadClient = {
    accessible: vi.fn(),
    list: vi.fn(),
    read,
    stat: vi.fn(),
    resolve: vi.fn(),
  }
  const tool = buildGfsReadTools(client, { referencedFiles }).find(
    t => t.name === 'clerum__gfs_read'
  )!
  const contentRequests = () =>
    request.mock.calls.filter(([path]) => path.includes('/content?')).length
  return { client, referencedFiles, tool, read, request, contentRequests }
}

describe('clerum__gfs_read expectedVersion (#666)', () => {
  it('declares expectedVersion as an optional non-negative integer', () => {
    const { tool } = harness(3)
    expect(tool.parameters).toMatchObject({
      required: ['drive', 'resourceId'],
      properties: { expectedVersion: { type: 'integer', minimum: 0 } },
    })
  })

  it('reads the file when it is still at the expected version', async () => {
    const { tool, read, contentRequests } = harness(3)
    const result = await tool.execute(
      { drive: 'main', resourceId: FILE_ID, expectedVersion: 3 },
      ''
    )
    expect(result).toMatchObject({ success: true, content: SENTINEL })
    expect(read.mock.calls[0]![0]).toEqual({ drive: 'main', resourceId: FILE_ID })
    expect(read.mock.calls[0]![1]).toMatchObject({ expectedVersion: 3 })
    expect(contentRequests()).toBe(1)
  })

  it('answers a typed stale result without content when the file changed', async () => {
    const { tool, request, contentRequests } = harness(4)
    const result = await tool.execute(
      { drive: 'main', resourceId: FILE_ID, expectedVersion: 3 },
      ''
    )
    expect(result.success).toBe(true)
    expect(JSON.parse(result.content as string)).toEqual({
      availability: 'stale',
      drive: 'main',
      resourceId: FILE_ID,
      expectedVersion: 3,
    })
    // Witness: the metadata snapshot was requested; the content never was.
    expect(request).toHaveBeenCalledTimes(1)
    expect(contentRequests()).toBe(0)
    expect(result.content).not.toContain(SENTINEL)
  })

  it('answers stale when the content version moves during an expected-version read', async () => {
    const { tool, contentRequests } = harness(3, 4)
    const result = await tool.execute(
      { drive: 'main', resourceId: FILE_ID, expectedVersion: 3 },
      ''
    )
    // Witness: the content request was made, and its header decided the answer.
    expect(contentRequests()).toBe(1)
    expect(JSON.parse(result.content as string)).toMatchObject({ availability: 'stale' })
  })

  it('keeps the failed result for a version conflict when no version was expected', async () => {
    const { tool, read, contentRequests } = harness(3, 4)
    const result = await tool.execute({ drive: 'main', resourceId: FILE_ID }, '')
    expect(contentRequests()).toBe(1)
    expect(result).toEqual({ success: false, error: 'GFS read failed (version_conflict)' })
    expect(read.mock.calls[0]![1]).not.toHaveProperty('expectedVersion')
  })

  it.each([-1, 1.5, '3', null])('rejects expectedVersion %j before reading', async value => {
    const { tool, read } = harness(3)
    // Control: a valid expectedVersion reaches the client.
    await tool.execute({ drive: 'main', resourceId: FILE_ID, expectedVersion: 3 }, '')
    expect(read).toHaveBeenCalledTimes(1)
    const result = await tool.execute(
      { drive: 'main', resourceId: FILE_ID, expectedVersion: value },
      ''
    )
    expect(result).toEqual({
      success: false,
      error: 'expectedVersion must be a non-negative integer.',
    })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('answers identity_mismatch, not stale, when the content names another resource', async () => {
    const { tool, contentRequests } = harness(3, 3, new Map(), `gfs://main/${'f'.repeat(32)}`)
    const result = await tool.execute(
      { drive: 'main', resourceId: FILE_ID, expectedVersion: 3 },
      ''
    )
    // Witness: the content request was made, and its header decided the answer.
    expect(contentRequests()).toBe(1)
    expect(result).toEqual({ success: false, error: 'GFS read failed (identity_mismatch)' })
  })
})

describe('clerum__gfs_read pinned by a file reference of the message (#666)', () => {
  const pinned = (version: number, currentVersion?: number): ReferencedFilePins =>
    new Map([
      [`main/${FILE_ID}`, { version, ...(currentVersion === undefined ? {} : { currentVersion }) }],
    ])

  it('reads the referenced version when the model omits expectedVersion', async () => {
    const { tool, read, contentRequests } = harness(3, 3, pinned(3))
    const result = await tool.execute({ drive: 'main', resourceId: FILE_ID }, '')
    expect(result).toMatchObject({ success: true, content: SENTINEL })
    expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0]![1]).toMatchObject({ expectedVersion: 3 })
    expect(contentRequests()).toBe(1)
  })

  it('reads the referenced version when the model passes it', async () => {
    const { tool, read } = harness(3, 3, pinned(3))
    const result = await tool.execute(
      { drive: 'main', resourceId: FILE_ID, expectedVersion: 3 },
      ''
    )
    expect(result).toMatchObject({ success: true, content: SENTINEL })
    expect(read.mock.calls[0]![1]).toMatchObject({ expectedVersion: 3 })
  })

  it('matches the pin for a dashed, upper-case resourceId', async () => {
    const { tool, read } = harness(3, 3, pinned(3))
    const dashed = `${FILE_ID.slice(0, 8)}-${FILE_ID.slice(8)}`.toUpperCase()
    await tool.execute({ drive: 'main', resourceId: dashed }, '')
    expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0]![1]).toMatchObject({ expectedVersion: 3 })
  })

  it('reads the current_version of a stale reference when the model passes it', async () => {
    const { tool, read, contentRequests } = harness(4, 4, pinned(3, 4))
    const result = await tool.execute(
      { drive: 'main', resourceId: FILE_ID, expectedVersion: 4 },
      ''
    )
    expect(result).toMatchObject({ success: true, content: SENTINEL })
    expect(read.mock.calls[0]![1]).toMatchObject({ expectedVersion: 4 })
    expect(contentRequests()).toBe(1)
  })

  it('answers stale for a stale reference read without expectedVersion', async () => {
    const { tool, read, contentRequests } = harness(4, 4, pinned(3, 4))
    const result = await tool.execute({ drive: 'main', resourceId: FILE_ID }, '')
    // Witness: the read ran at the referenced version and the snapshot decided.
    expect(read.mock.calls[0]![1]).toMatchObject({ expectedVersion: 3 })
    expect(JSON.parse(result.content as string)).toEqual({
      availability: 'stale',
      drive: 'main',
      resourceId: FILE_ID,
      expectedVersion: 3,
    })
    expect(contentRequests()).toBe(0)
  })

  it('refuses any other version without reading, naming the referenced version', async () => {
    const { tool, read } = harness(3, 3, pinned(3))
    const result = await tool.execute(
      { drive: 'main', resourceId: FILE_ID, expectedVersion: 5 },
      ''
    )
    expect(result).toEqual({
      success: false,
      error:
        'This file is referenced in the current message at version 3. Omit expectedVersion or pass 3.',
    })
    expect(read).not.toHaveBeenCalled()
  })

  it('refuses any other version of a stale reference, naming both versions', async () => {
    const { tool, read } = harness(4, 4, pinned(3, 4))
    const result = await tool.execute(
      { drive: 'main', resourceId: FILE_ID, expectedVersion: 2 },
      ''
    )
    expect(result).toEqual({
      success: false,
      error:
        'This file is referenced in the current message at version 3. Omit expectedVersion or pass 3, or pass its current_version 4 to read the current file.',
    })
    expect(read).not.toHaveBeenCalled()
  })

  it('lets stat report a newer live version and still reads the referenced one', async () => {
    const { client, referencedFiles, tool, read } = harness(3, 3, pinned(3))
    vi.mocked(client.stat).mockResolvedValue({
      resourceId: FILE_ID,
      drive: 'main',
      gfsUri: FILE_URI,
      kind: 'file',
      name: 'notes.txt',
      version: 4,
      bytes: SENTINEL.length,
    } as Awaited<ReturnType<GfscReadClient['stat']>>)
    const stat = buildGfsReadTools(client, { referencedFiles }).find(
      t => t.name === 'clerum__gfs_stat'
    )!

    const statResult = await stat.execute({ drive: 'main', resourceId: FILE_ID }, '')
    expect(client.stat).toHaveBeenCalledTimes(1)
    expect(JSON.parse(statResult.content as string)).toMatchObject({ version: 4 })

    // Witness that stat left the pin intact: the read still asks for version 3.
    await tool.execute({ drive: 'main', resourceId: FILE_ID }, '')
    expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0]![1]).toMatchObject({ expectedVersion: 3 })
  })

  it('leaves a file the message did not reference unpinned', async () => {
    const other = new Map([[`main/${'e'.repeat(32)}`, { version: 9 }]])
    const { tool, read } = harness(3, 3, other)
    const result = await tool.execute({ drive: 'main', resourceId: FILE_ID }, '')
    expect(result).toMatchObject({ success: true, content: SENTINEL })
    expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0]![1]).not.toHaveProperty('expectedVersion')
  })
})
