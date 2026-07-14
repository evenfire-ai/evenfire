import { describe, expect, it } from 'vitest'
import {
  ObjectStorageClient,
  ScopeConstraintError,
} from '../../../src/workflow/objectStorageClient'

describe('ObjectStorageClient', () => {
  describe('scope constraint enforcement', () => {
    it('rejects key that does not start with recipe name', async () => {
      const client = new ObjectStorageClient(
        { accessKey: 'test', secretKey: 'test' },
        { bucket: 'souls', key: 'other-recipe/SOUL.md', provider: 's3' }
      )

      await expect(client.download('my-recipe')).rejects.toThrow(ScopeConstraintError)
    })

    it('rejects key with recipe name but missing trailing slash', async () => {
      const client = new ObjectStorageClient(
        { accessKey: 'test', secretKey: 'test' },
        { bucket: 'souls', key: 'my-recipeSneaky/SOUL.md', provider: 's3' }
      )

      await expect(client.download('my-recipe')).rejects.toThrow(ScopeConstraintError)
    })

    it('error message includes recipe name and key', async () => {
      const client = new ObjectStorageClient(
        { accessKey: 'test', secretKey: 'test' },
        { bucket: 'souls', key: 'evil/SOUL.md', provider: 's3' }
      )

      try {
        await client.download('my-recipe')
        expect.fail('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ScopeConstraintError)
        const scErr = err as ScopeConstraintError
        expect(scErr.context.recipeName).toBe('my-recipe')
        expect(scErr.context.key).toBe('evil/SOUL.md')
      }
    })
  })
})
