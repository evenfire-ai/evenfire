/**
 * S3-compatible object storage client for SOUL.md delivery.
 *
 * WRC downloads SOUL.md at reconciliation time (using its own RBAC access to
 * `clerum-storage-credentials`) and creates a ConfigMap in sandbox-recipes.
 * The coordinator Pod mounts this ConfigMap.
 * */
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { Readable } from 'stream'

export interface StorageRef {
  bucket: string
  key: string
  provider: 's3' | 'gcs' | 'spaces' | 'minio'
  endpoint?: string
  region?: string
}

export interface StorageCredentials {
  accessKey: string
  secretKey: string
}

export class ObjectStorageClient {
  private readonly s3Client: S3Client

  constructor(
    private readonly credentials: StorageCredentials,
    private readonly storageRef: StorageRef
  ) {
    const endpoint = this.resolveEndpoint(storageRef)
    this.s3Client = new S3Client({
      region: storageRef.region ?? 'us-east-1',
      endpoint,
      credentials: {
        accessKeyId: credentials.accessKey,
        secretAccessKey: credentials.secretKey,
      },
      forcePathStyle: storageRef.provider === 'minio',
    })
  }

  // SEC-03: cap matches mcp-host MAX_SOUL_BYTES — prevents OOM during download
  // and avoids exceeding etcd's 1 MiB ConfigMap limit.
  private static readonly MAX_DOWNLOAD_BYTES = 64 * 1024

  async download(recipeName: string): Promise<Buffer> {
    this.enforceScopeConstraint(recipeName, this.storageRef.key)

    const command = new GetObjectCommand({
      Bucket: this.storageRef.bucket,
      Key: this.storageRef.key,
    })

    const response = await this.s3Client.send(command)

    if (!response.Body) {
      throw new Error(`Object storage returned empty body for key: ${this.storageRef.key}`)
    }

    try {
      return await this.streamToBuffer(
        response.Body as Readable,
        ObjectStorageClient.MAX_DOWNLOAD_BYTES
      )
    } finally {
      this.s3Client.destroy()
    }
  }

  private enforceScopeConstraint(recipeName: string, key: string): void {
    const requiredPrefix = `${recipeName}/`
    if (!key.startsWith(requiredPrefix)) {
      throw new ScopeConstraintError(
        `SOUL.md key '${key}' must start with '${requiredPrefix}'. ` +
          `This prevents cross-recipe data access.`,
        { recipeName, key, requiredPrefix }
      )
    }
  }

  private resolveEndpoint(ref: StorageRef): string | undefined {
    if (ref.endpoint) {
      // Security I-03 fix: validate endpoint to prevent SSRF — the endpoint field comes
      // from the CRD spec and could be attacker-controlled in a compromised cluster.
      let parsed: URL
      try {
        parsed = new URL(ref.endpoint)
      } catch {
        throw new Error(`Invalid storage endpoint URL: "${ref.endpoint}"`)
      }
      // Minio supports http for internal use; external providers must use HTTPS.
      if (ref.provider !== 'minio' && parsed.protocol !== 'https:') {
        throw new Error(
          `Storage endpoint must use HTTPS for provider "${ref.provider}": ${ref.endpoint}`
        )
      }
      // Block well-known SSRF targets: metadata services, cluster-internal DNS, loopback.
      const h = parsed.hostname.toLowerCase()
      if (
        h === 'localhost' ||
        h === '0.0.0.0' ||
        h === '127.0.0.1' ||
        h === '::1' ||
        h.startsWith('::ffff:127.') ||
        h.endsWith('.svc.cluster.local') ||
        h === 'metadata.google.internal' || // GCP IMDS
        h === '169.254.169.254' || // AWS/Azure IMDS
        h === '100.100.100.200' || // Alibaba Cloud IMDS
        h.startsWith('169.254.') || // entire link-local range
        // RFC1918 private IPv4 ranges
        h.startsWith('10.') ||
        h.startsWith('192.168.') ||
        (/^172\./.test(h) &&
          (() => {
            const o = parseInt(h.split('.')[1], 10)
            return o >= 16 && o <= 31
          })()) ||
        // IPv6 unique-local (fc00::/7)
        /^f[cd][0-9a-f]{2}:/i.test(h)
      ) {
        throw new Error(`Storage endpoint targets a disallowed internal address: ${ref.endpoint}`)
      }
      return ref.endpoint
    }
    if (ref.provider === 'spaces') return `https://${ref.region ?? 'nyc3'}.digitaloceanspaces.com`
    if (ref.provider === 'gcs') return 'https://storage.googleapis.com'
    return undefined // AWS S3 default
  }

  // Enforce the size cap before full buffering to keep object downloads bounded.
  private async streamToBuffer(stream: Readable, maxBytes: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let total = 0
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > maxBytes) {
          stream.destroy()
          reject(new Error(`SOUL.md exceeds maximum size (limit: ${maxBytes} bytes)`))
          return
        }
        chunks.push(chunk)
      })
      stream.on('end', () => resolve(Buffer.concat(chunks)))
      stream.on('error', reject)
    })
  }
}

export class ScopeConstraintError extends Error {
  constructor(
    message: string,
    public readonly context: Record<string, string>
  ) {
    super(message)
    this.name = 'ScopeConstraintError'
  }
}
