import { describe, expect, it, vi } from 'vitest'
import { ObjectStorageAdapter } from '../../../src/workflow/objectStorageAdapter'

// Mock the ObjectStorageClient module to avoid real S3 calls
vi.mock('../../../src/workflow/objectStorageClient', () => {
  return {
    ObjectStorageClient: vi.fn().mockImplementation((_creds, _ref) => ({
      download: vi
        .fn()
        .mockResolvedValue(Buffer.from('# SOUL Override\nYou are a helpful assistant.')),
    })),
  }
})

describe('ObjectStorageAdapter', () => {
  const creds = { accessKey: 'test-key', secretKey: 'test-secret' }

  it('implements ObjectStorageReader interface (download returns string)', async () => {
    const adapter = new ObjectStorageAdapter(creds)
    const result = await adapter.download('my-bucket', 'test-recipe/SOUL.md')
    expect(typeof result).toBe('string')
    expect(result).toContain('SOUL Override')
  })

  it('extracts recipeName from key prefix for scope constraint', async () => {
    const { ObjectStorageClient } = await import('../../../src/workflow/objectStorageClient')
    const adapter = new ObjectStorageAdapter(creds)
    await adapter.download('bucket', 'my-recipe/SOUL.md')

    // ObjectStorageClient was constructed with the correct storageRef
    expect(ObjectStorageClient).toHaveBeenCalledWith(
      creds,
      expect.objectContaining({ bucket: 'bucket', key: 'my-recipe/SOUL.md' })
    )
  })

  it('returns null when key has no slash (invalid format)', async () => {
    const adapter = new ObjectStorageAdapter(creds)
    const result = await adapter.download('bucket', 'invalid-key-no-slash')
    expect(result).toBeNull()
  })

  it('returns null when ObjectStorageClient.download throws', async () => {
    const { ObjectStorageClient } = await import('../../../src/workflow/objectStorageClient')
    ;(ObjectStorageClient as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      download: vi.fn().mockRejectedValue(new Error('ScopeConstraintError')),
    }))

    const adapter = new ObjectStorageAdapter(creds)
    const result = await adapter.download('bucket', 'wrong-recipe/SOUL.md')
    expect(result).toBeNull()
  })

  it('converts Buffer to UTF-8 string', async () => {
    const { ObjectStorageClient } = await import('../../../src/workflow/objectStorageClient')
    const unicodeContent = '# SOUL con acentos: café, niño, señor'
    ;(ObjectStorageClient as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      download: vi.fn().mockResolvedValue(Buffer.from(unicodeContent, 'utf-8')),
    }))

    const adapter = new ObjectStorageAdapter(creds)
    const result = await adapter.download('bucket', 'recipe/SOUL.md')
    expect(result).toBe(unicodeContent)
  })
})
