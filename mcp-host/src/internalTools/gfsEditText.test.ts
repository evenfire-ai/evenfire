// Partial edits of a text file in GFS: in order, each to the result of the
// previous one, with the version the model read, and a diff built from the
// edits. Nothing is written unless every edit matches as it must.
import { describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { VisualInputError } from '../visualInput/policy'
import { EDIT_SCOPE_SENTENCE, type GfscWriteClient, buildGfsEditTools } from './gfs'

function fakeClient(bytes: Buffer, version = 7) {
  const release = vi.fn()
  const client = {
    read: vi.fn(async () => ({
      source: {
        kind: 'gfs',
        drive: 'main',
        resourceId: 'rid',
        gfsUri: 'gfs://main/rid',
        version,
        name: 'f.md',
      },
      bytes,
      reservation: { release },
    })),
    write: vi.fn(async () => ({ version: version + 1 })),
  } as unknown as GfscWriteClient
  return { client, release }
}

function edit(client: GfscWriteClient, args: Record<string, unknown>) {
  return buildGfsEditTools(client)[0]!.execute(
    { drive: 'main', resourceId: 'rid', ifMatch: 7, ...args },
    ''
  )
}

function written(client: GfscWriteClient): string {
  return (vi.mocked(client.write).mock.calls.at(-1)![0] as { content: string }).content
}

describe('clerum__gfs_edit_text', () => {
  it('changes one paragraph of a 10 KB file and leaves the bytes around it as they were', async () => {
    const before = 'a'.repeat(5000) + '\nThe old paragraph.\n' + 'b'.repeat(5000)
    const { client, release } = fakeClient(Buffer.from(before))
    const result = await edit(client, {
      edits: [{ oldText: 'The old paragraph.', newText: 'The new paragraph.' }],
    })
    expect(result.success, result.error).toBe(true)
    expect(written(client)).toBe(before.replace('The old paragraph.', 'The new paragraph.'))
    expect(vi.mocked(client.write).mock.calls[0]![0]).toMatchObject({
      ifMatch: 7,
      drive: 'main',
      resourceId: 'rid',
    })
    const body = JSON.parse(result.content!)
    expect(body).toMatchObject({ version: 8, bytesBefore: before.length, truncated: false })
    expect(body.diff).toContain('@@ edit 0 line 2')
    expect(body.diff).toContain('-The old paragraph.')
    expect(body.diff).toContain('+The new paragraph.')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('returns the diff without writing on a dry run', async () => {
    const { client } = fakeClient(Buffer.from('one two'))
    const result = await edit(client, { edits: [{ oldText: 'two', newText: '2' }], dryRun: true })
    expect(client.read).toHaveBeenCalledTimes(1)
    expect(JSON.parse(result.content!).diff).toContain('+2')
    expect(client.write).not.toHaveBeenCalled()
  })

  it('writes nothing when an edit matches zero or two times, and names the edit and the count', async () => {
    const { client } = fakeClient(Buffer.from('x y x'))
    const none = await edit(client, { edits: [{ oldText: 'z', newText: 'q' }] })
    expect(none.error).toBe(
      'edit 0 matched 0 times; it must match exactly once. Nothing was written'
    )
    const two = await edit(client, {
      edits: [
        { oldText: 'y', newText: 'Y' },
        { oldText: 'x', newText: 'q' },
      ],
    })
    expect(two.error).toBe(
      'edit 1 matched 2 times; it must match exactly once. Nothing was written'
    )
    expect(client.write).not.toHaveBeenCalled()
    expect(client.read).toHaveBeenCalledTimes(2)
  })

  it('applies each edit to the result of the previous one', async () => {
    const { client } = fakeClient(Buffer.from('alpha'))
    const result = await edit(client, {
      edits: [
        { oldText: 'alpha', newText: 'alpha beta' },
        { oldText: 'beta', newText: 'gamma' },
      ],
    })
    expect(result.success, result.error).toBe(true)
    expect(written(client)).toBe('alpha gamma')
  })

  it('counts each match on the intermediate text', async () => {
    const { client } = fakeClient(Buffer.from('a b'))
    const refused = await edit(client, {
      edits: [
        { oldText: 'a', newText: 'b' },
        { oldText: 'b', newText: 'c' },
      ],
    })
    expect(refused.error).toBe(
      'edit 1 matched 2 times; it must match exactly once. Nothing was written'
    )
    expect(client.write).not.toHaveBeenCalled()
    const all = await edit(client, {
      edits: [
        { oldText: 'a', newText: 'b' },
        { oldText: 'b', newText: 'c', replaceAll: true },
      ],
    })
    expect(all.success, all.error).toBe(true)
    expect(written(client)).toBe('c c')
  })

  it('refuses replaceAll with no match, and replaces every match otherwise', async () => {
    const { client } = fakeClient(Buffer.from('k k'))
    const none = await edit(client, { edits: [{ oldText: 'z', newText: 'q', replaceAll: true }] })
    expect(none.error).toBe(
      'edit 0 matched 0 times; it must match at least once. Nothing was written'
    )
    expect(client.write).not.toHaveBeenCalled()
    await edit(client, { edits: [{ oldText: 'k', newText: 'K', replaceAll: true }] })
    expect(written(client)).toBe('K K')
  })

  it('reports a stale version as the read does, and writes nothing', async () => {
    const { client } = fakeClient(Buffer.from('x'))
    vi.mocked(client.read).mockRejectedValueOnce(new VisualInputError('version_conflict'))
    const result = await edit(client, { edits: [{ oldText: 'x', newText: 'y' }] })
    expect(result.success).toBe(false)
    expect(result.error).toBe(new VisualInputError('version_conflict').message)
    expect(client.write).not.toHaveBeenCalled()
    expect(vi.mocked(client.read).mock.calls[0]![1]).toMatchObject({ expectedVersion: 7 })
  })

  it('refuses a file that is not text', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types/>')
    const { client, release } = fakeClient(await zip.generateAsync({ type: 'nodebuffer' }))
    const result = await edit(client, { edits: [{ oldText: 'Types', newText: 'X' }] })
    expect(result.error).toMatch(/^not_a_text_file: /)
    expect(client.write).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('keeps a byte order mark and CRLF line endings', async () => {
    const before = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('line one\r\nline two\r\n'),
    ])
    const { client } = fakeClient(before)
    await edit(client, { edits: [{ oldText: 'two', newText: '2' }] })
    const after = Buffer.from(written(client), 'utf8')
    expect(after.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    expect(after.subarray(3).toString()).toBe('line one\r\nline 2\r\n')
  })

  it('refuses edits past its limits before reading, and names the shell and sourcePath route', async () => {
    const { client } = fakeClient(Buffer.from('x'))
    for (const edits of [
      [],
      Array.from({ length: 51 }, () => ({ oldText: 'x', newText: 'y' })),
      [{ oldText: 'x'.repeat(4097), newText: 'y' }],
      [{ oldText: 'x', newText: 'y'.repeat(65_537) }],
      [{ oldText: '', newText: 'y' }],
    ]) {
      const result = await edit(client, { edits })
      expect(result.success).toBe(false)
      expect(result.error).toContain(EDIT_SCOPE_SENTENCE)
    }
    expect(client.read).not.toHaveBeenCalled()
    // Witness: an edit within the limits reads the file.
    await edit(client, { edits: [{ oldText: 'x', newText: 'y' }] })
    expect(client.read).toHaveBeenCalledTimes(1)
  })
})
