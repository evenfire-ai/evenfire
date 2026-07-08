/**
 * Adapter: bridges ObjectStorageClient (concrete S3 client) to ObjectStorageReader interface.
 *
 * ObjectStorageClient.download(recipeName) → Buffer (uses internal bucket/key)
 * ObjectStorageReader.download(bucket, key) → string | null (interface contract)
 *
 * The adapter resolves credentials from K8s Secret at construction time
 * and creates per-request ObjectStorageClient instances.
 * */
import type { ObjectStorageReader } from './modelConfigHandler'
import { ObjectStorageClient, type StorageCredentials } from './objectStorageClient'

export class ObjectStorageAdapter implements ObjectStorageReader {
  constructor(private readonly credentials: StorageCredentials) {}

  async download(bucket: string, key: string): Promise<string | null> {
    // Derive provider from endpoint pattern (default to s3)
    const provider = 's3' as const

    const client = new ObjectStorageClient(this.credentials, {
      bucket,
      key,
      provider,
    })

    // ObjectStorageClient.download() requires recipeName for scope constraint.
    // The key format is "{recipeName}/SOUL.md" — extract recipeName from prefix.
    const slashIndex = key.indexOf('/')
    // slashIndex === -1: no prefix at all; slashIndex === 0: empty prefix (e.g. "/SOUL.md")
    // — both are invalid and would bypass the recipe-scope constraint in download().
    if (slashIndex <= 0) return null
    const recipeName = key.substring(0, slashIndex)

    try {
      const buffer = await client.download(recipeName)
      return buffer.toString('utf-8')
    } catch {
      return null
    }
  }
}
