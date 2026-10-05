import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { EXECUTION_INPUT_MAX_BYTES, receiveExecutionInput } from './receiveInput'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function root() {
  const dir = await mkdtemp(join(tmpdir(), 'pr932-input-'))
  dirs.push(dir)
  return dir
}
function digest(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('private operation input receiver', () => {
  it('streams exact arbitrary bytes into one read-only file and removes staging', async () => {
    const dir = await root()
    const bytes = Buffer.from([0, 255, 128, 1, 2, 3])
    await receiveExecutionInput(
      Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]),
      dir,
      bytes.length,
      digest(bytes),
      1000
    )
    expect(await readFile(join(dir, 'source'))).toEqual(bytes)
    expect((await stat(join(dir, 'source'))).mode & 0o777).toBe(0o444)
    expect(await readdir(dir)).toEqual(['source'])
  })
  it('accepts an exact empty input without inventing file content', async () => {
    const dir = await root()
    const bytes = Buffer.alloc(0)
    await receiveExecutionInput(Readable.from([]), dir, 0, digest(bytes), 1000)
    expect((await readFile(join(dir, 'source'))).length).toBe(0)
  })
  it.each(['short', 'long', 'wrong-digest'] as const)(
    'refuses %s input before publication and removes staging',
    async mode => {
      const dir = await root()
      const bytes = Buffer.from('public original')
      const body =
        mode === 'short'
          ? bytes.subarray(1)
          : mode === 'long'
            ? Buffer.concat([bytes, Buffer.from('x')])
            : bytes
      const expected =
        mode === 'wrong-digest' ? digest(Buffer.from('different public original')) : digest(bytes)
      await expect(
        receiveExecutionInput(Readable.from([body]), dir, bytes.length, expected, 1000)
      ).rejects.toThrow('mismatch')
      expect(await readdir(dir)).toEqual([])
    }
  )
  it('preserves an existing published input when the same operation is replayed', async () => {
    const dir = await root()
    const original = Buffer.from('published public input')
    await writeFile(join(dir, 'source'), original)
    const bytes = Buffer.from('replacement')
    await expect(
      receiveExecutionInput(Readable.from([bytes]), dir, bytes.length, digest(bytes), 1000)
    ).rejects.toThrow()
    expect(await readFile(join(dir, 'source'))).toEqual(original)
    expect(await readdir(dir)).toEqual(['source'])
  })
  it('rejects a symlink root and out-of-bound contracts without creating files', async () => {
    const dir = await root()
    const target = await root()
    await symlink(target, join(dir, 'link'))
    const bytes = Buffer.from('public')
    await expect(
      receiveExecutionInput(
        Readable.from([bytes]),
        join(dir, 'link'),
        bytes.length,
        digest(bytes),
        1000
      )
    ).rejects.toThrow('directory')
    for (const size of [-1, 1.5, EXECUTION_INPUT_MAX_BYTES + 1]) {
      await expect(
        receiveExecutionInput(Readable.from([bytes]), target, size, digest(bytes), 1000)
      ).rejects.toThrow('contract')
    }
    expect(await readdir(target)).toEqual([])
  })
  it('terminates stalled input within its deadline and publishes no file', async () => {
    const dir = await root()
    const neverEnds = new Readable({ read() {} })
    await expect(
      receiveExecutionInput(neverEnds, dir, 1, digest(Buffer.from('x')), 25)
    ).rejects.toThrow()
    expect(await readdir(dir)).toEqual([])
  })
})
