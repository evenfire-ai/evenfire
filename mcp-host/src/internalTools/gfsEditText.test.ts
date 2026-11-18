// Partial edits of a text file in GFS: in order, each to the result of the
// previous one, with the version the model read, and a diff built from the
// edits. Nothing is written unless every edit matches as it must.
import { describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { VisualInputError } from '../visualInput/policy'
import { EDIT_SCOPE_SENTENCE, type GfscWriteClient, buildGfsEditTools } from './gfs'
import { GFS_FILE_LIMITS } from './gfsFilePolicy'

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
    // The gfsc envelope the Host receives for a replaced file.
    write: vi.fn(async () => ({ ok: true, data: { resourceId: 'rid', version: version + 1 } })),
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

  it('refuses an edit that would make the file larger than a GFS file may be, and writes nothing', async () => {
    const newText = 'x'.repeat(65_536)
    const fit = Math.floor(GFS_FILE_LIMITS.maxFileBytes / newText.length)
    const over = fakeClient(Buffer.from('a'.repeat(fit + 1)))
    const refused = await edit(over.client, {
      edits: [{ oldText: 'a', newText, replaceAll: true }],
    })
    expect(refused.error).toBe(
      `edit 0 would make the file ${(fit + 1) * newText.length} bytes, above the ${GFS_FILE_LIMITS.maxFileBytes}-byte limit of a GFS file. Nothing was written`
    )
    expect(over.client.read).toHaveBeenCalledTimes(1)
    expect(over.client.write).not.toHaveBeenCalled()
    expect(over.release).toHaveBeenCalledTimes(1)
    // Witness: one match fewer fits within the limit and is written.
    const within = fakeClient(Buffer.from('a'.repeat(fit)))
    const written = await edit(within.client, {
      edits: [{ oldText: 'a', newText, replaceAll: true }],
    })
    expect(written.success, written.error).toBe(true)
    expect(within.client.write).toHaveBeenCalledTimes(1)
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

describe('clerum__gfs_edit_text with many matches', () => {
  const BOUND_REFUSAL = 'matched more than 10000 times'

  it('refuses a replaceAll that matches more than 10,000 times, on a dry run and for real', async () => {
    // 2 MiB with 1,048,576 matches.
    const text = 'a,'.repeat(1_048_576)
    const dry = fakeClient(Buffer.from(text))
    const preview = await edit(dry.client, {
      edits: [{ oldText: ',', newText: ';', replaceAll: true }],
      dryRun: true,
    })
    expect(preview.success).toBe(false)
    expect(preview.error).toBe(
      `edit 0 ${BOUND_REFUSAL}; this tool is ${EDIT_SCOPE_SENTENCE}. Nothing was written`
    )
    const real = fakeClient(Buffer.from(text))
    const refused = await edit(real.client, {
      edits: [{ oldText: ',', newText: ';', replaceAll: true }],
    })
    expect(refused.error).toContain(BOUND_REFUSAL)
    // Witness: the file was read, and the release ran, before the refusal.
    expect(real.client.read).toHaveBeenCalledTimes(1)
    expect(real.release).toHaveBeenCalledTimes(1)
    expect(real.client.write).not.toHaveBeenCalled()
  })

  it('applies a replaceAll that matches exactly 10,000 times', async () => {
    const text = 'x,'.repeat(10_000)
    const { client } = fakeClient(Buffer.from(text))
    const result = await edit(client, {
      edits: [{ oldText: ',', newText: '; ', replaceAll: true }],
    })
    expect(result.success, result.error).toBe(true)
    expect(client.write).toHaveBeenCalledTimes(1)
    const expected = 'x; '.repeat(10_000)
    expect(written(client)).toBe(expected)
    expect(JSON.parse(result.content!)).toMatchObject({
      bytesBefore: text.length,
      bytesAfter: expected.length,
    })
  })

  it('names the bound without replaceAll above 10,000 matches, and the exact count below it', async () => {
    const many = fakeClient(Buffer.from('a,'.repeat(20_000)))
    const refused = await edit(many.client, { edits: [{ oldText: ',', newText: ';' }] })
    expect(refused.error).toContain(`edit 0 ${BOUND_REFUSAL}`)
    expect(many.client.write).not.toHaveBeenCalled()
    const seven = fakeClient(Buffer.from('a,'.repeat(7)))
    expect((await edit(seven.client, { edits: [{ oldText: ',', newText: ';' }] })).error).toBe(
      'edit 0 matched 7 times; it must match exactly once. Nothing was written'
    )
  })

  it('reports the line of the first match in the diff', async () => {
    const { client } = fakeClient(Buffer.from('one\ntwo\nthree\nfour target\nfive target\n'))
    const result = await edit(client, {
      edits: [{ oldText: 'target', newText: 'goal', replaceAll: true }],
      dryRun: true,
    })
    expect(JSON.parse(result.content!).diff).toContain('@@ edit 0 line 4\n')
    const lines = 1024 * 1024
    const deep = fakeClient(Buffer.from('\n'.repeat(lines) + 'end'))
    const last = await edit(deep.client, {
      edits: [{ oldText: 'end', newText: 'END' }],
      dryRun: true,
    })
    expect(JSON.parse(last.content!).diff).toContain(`@@ edit 0 line ${lines + 1}\n`)
  })

  it('writes replacement text literally, with no replacement patterns', async () => {
    const { client } = fakeClient(Buffer.from('cost: 5, cost: 6'))
    const result = await edit(client, {
      edits: [{ oldText: 'cost', newText: '$&-$1-$$', replaceAll: true }],
    })
    expect(result.success, result.error).toBe(true)
    expect(written(client)).toBe('$&-$1-$$: 5, $&-$1-$$: 6')
  })
})
