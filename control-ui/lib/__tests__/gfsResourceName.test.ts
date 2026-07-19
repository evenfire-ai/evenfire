import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { GFS_RESOURCE_NAME_MAX_LENGTH, normalizeGfsResourceName } from '../gfsResourceName'

const HASH_LENGTH = 12
const EXTENSION_MAX_LENGTH = 48

function expectedShortName(name: string): string {
  const normalized = name.normalize('NFC')
  const lastDot = normalized.lastIndexOf('.')
  const extension =
    lastDot > 0 && lastDot !== normalized.length - 1 ? normalized.slice(lastDot) : ''
  const safeExtension = extension.length <= EXTENSION_MAX_LENGTH ? extension : ''
  const base = safeExtension ? normalized.slice(0, -safeExtension.length) : normalized
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, HASH_LENGTH)
  const suffix = `-${hash}${safeExtension}`
  const maxBaseLength = GFS_RESOURCE_NAME_MAX_LENGTH - suffix.length
  const truncatedBase = base.slice(0, maxBaseLength).replace(/[\s._-]+$/g, '')
  const safeBase = truncatedBase || base.slice(0, maxBaseLength)

  return `${safeBase}${suffix}`
}

describe('normalizeGfsResourceName', () => {
  it('keeps regular GFS resource names unchanged', async () => {
    await expect(normalizeGfsResourceName('report.txt')).resolves.toBe('report.txt')
  })

  it('shortens oversized names with a deterministic SHA suffix', async () => {
    const raw = `operator-${'very-long-'.repeat(32)}report.txt`
    const shortened = await normalizeGfsResourceName(raw)

    expect(shortened).toBe(expectedShortName(raw))
    expect(shortened).toHaveLength(GFS_RESOURCE_NAME_MAX_LENGTH)
    expect(shortened).toMatch(/-[0-9a-f]{12}\.txt$/)
  })

  it('keeps distinct oversized names distinct after truncation', async () => {
    const first = `operator-${'a'.repeat(270)}.txt`
    const second = `operator-${'a'.repeat(269)}b.txt`

    await expect(normalizeGfsResourceName(first)).resolves.not.toBe(
      await normalizeGfsResourceName(second)
    )
  })

  it.each(['..', '../secret.md', 'folder\\secret.md', 'bad\u0000name.md'])(
    'rejects unsafe path-like name %j',
    async name => {
      await expect(normalizeGfsResourceName(name)).rejects.toThrow(
        'File and folder names cannot contain path separators or control characters.'
      )
    }
  )
})
