import { afterEach, describe, expect, it } from 'vitest'
import { gfsDefaultFactoryConfig } from './gfsConfig'

const GFS_ENV_KEYS = Object.keys(process.env).filter(k => k.startsWith('CONTEXT_MAPPER_GFS'))

afterEach(() => {
  for (const k of GFS_ENV_KEYS) delete process.env[k]
  delete process.env.GFS_SYNC_COPY_MAX_OBJECTS
  delete process.env.GFS_SYNC_COPY_MAX_BYTES
  delete process.env.GFS_SYNC_COPY_TIMEOUT_MS
  delete process.env.GFS_MAX_WRITE_BODY_BYTES
  for (const key of Object.keys(process.env).filter(k =>
    k.startsWith('CONTEXT_MAPPER_GFSC_UPLOAD_')
  )) {
    delete process.env[key]
  }
  delete process.env.CONTEXT_MAPPER_GFSC_IMAGE_PULL_POLICY
  delete process.env.CONTEXT_MAPPER_NODELOCAL_DNS_CIDR
})

describe('gfsDefaultFactoryConfig', () => {
  it('produces spec-aligned defaults (gfs namespace, port 8087, drive main, gfs-controller aud)', () => {
    const c = gfsDefaultFactoryConfig()
    expect(c.gfsNamespace).toBe('gfs')
    expect(c.gfscPort).toBe(8087)
    expect(c.driveName).toBe('main')
    expect(c.tokenAudience).toBe('gfs-controller')
    expect(c.postgresPort).toBe(5432)
    expect(c.postgresPodLabels).toEqual({ app: 'control-postgres' })
    expect(c.gfscImagePullPolicy).toBe('IfNotPresent')
    expect(c.nodeLocalDnsCidr).toBe('')
    expect(c.pgSecretName).toBe('gfs-controller-db')
    expect(c.readerPgSecretName).toBe('gfs-controller-reader-db')
    expect(c.syncCopyMaxObjects).toBeUndefined()
    expect(c.syncCopyMaxBytes).toBeUndefined()
    expect(c.syncCopyTimeoutMs).toBeUndefined()
    expect(c.maxWriteBodyBytes).toBeUndefined()
    expect(c.uploadV2Enabled).toBeUndefined()
  })

  it('passes synchronous copy limits through verbatim, including explicit empty values', () => {
    process.env.GFS_SYNC_COPY_MAX_OBJECTS = '2500'
    process.env.GFS_SYNC_COPY_MAX_BYTES = ''
    process.env.GFS_SYNC_COPY_TIMEOUT_MS = '45000'
    process.env.GFS_MAX_WRITE_BODY_BYTES = '25165824'

    const c = gfsDefaultFactoryConfig()
    expect(c.syncCopyMaxObjects).toBe('2500')
    expect(c.syncCopyMaxBytes).toBe('')
    expect(c.syncCopyTimeoutMs).toBe('45000')
    expect(c.maxWriteBodyBytes).toBe('25165824')
  })

  it('maps the exact private-infra upload profile to writer-owned gfsc settings', () => {
    Object.assign(process.env, {
      CONTEXT_MAPPER_GFSC_UPLOAD_V2_ENABLED: 'true',
      CONTEXT_MAPPER_GFSC_UPLOAD_PROTOCOL_MAX_FILE_BYTES: '1073741824',
      CONTEXT_MAPPER_GFSC_UPLOAD_PRODUCT_MAX_FILE_BYTES: '209715200',
      CONTEXT_MAPPER_GFSC_UPLOAD_MAX_FILE_BYTES: '209715200',
      CONTEXT_MAPPER_GFSC_UPLOAD_PREFERRED_CHUNK_BYTES: '8388608',
      CONTEXT_MAPPER_GFSC_UPLOAD_MAX_CHUNK_BYTES: '16777216',
      CONTEXT_MAPPER_GFSC_UPLOAD_MIN_PART_BYTES: '1048576',
      CONTEXT_MAPPER_GFSC_UPLOAD_MAX_PART_COUNT: '1024',
      CONTEXT_MAPPER_GFSC_UPLOAD_SESSION_TTL_MS: '86400000',
      CONTEXT_MAPPER_GFSC_UPLOAD_COMPLETED_RECEIPT_TTL_MS: '86400000',
      CONTEXT_MAPPER_GFSC_UPLOAD_STALE_PART_LEASE_MS: '600000',
      CONTEXT_MAPPER_GFSC_UPLOAD_MAX_ACTIVE_PER_SUBJECT: '2',
      CONTEXT_MAPPER_GFSC_UPLOAD_MAX_ACTIVE_GLOBAL: '8',
      CONTEXT_MAPPER_GFSC_UPLOAD_MAX_CONCURRENT_PARTS_PER_SESSION: '4',
      CONTEXT_MAPPER_GFSC_UPLOAD_MAX_CONCURRENT_PART_STREAMS_GLOBAL: '16',
      CONTEXT_MAPPER_GFSC_UPLOAD_INSTABILITY_FAILURE_THRESHOLD: '3',
      CONTEXT_MAPPER_GFSC_UPLOAD_MAX_CONCURRENT_FINALIZATIONS: '1',
      CONTEXT_MAPPER_GFSC_UPLOAD_MIN_FREE_BYTES: '10737418240',
      CONTEXT_MAPPER_GFSC_UPLOAD_PART_TIMEOUT_MS: '300000',
      CONTEXT_MAPPER_GFSC_UPLOAD_FINALIZE_TIMEOUT_MS: '600000',
    })
    const c = gfsDefaultFactoryConfig()
    expect(c).toMatchObject({
      uploadV2Enabled: 'true',
      uploadProtocolMaxFileBytes: '1073741824',
      uploadProductMaxFileBytes: '209715200',
      uploadMaxFileBytes: '209715200',
      uploadPreferredChunkBytes: '8388608',
      uploadMaxChunkBytes: '16777216',
      uploadMinPartBytes: '1048576',
      uploadMaxPartCount: '1024',
      uploadSessionTtlMs: '86400000',
      uploadCompletedReceiptTtlMs: '86400000',
      uploadStalePartLeaseMs: '600000',
      uploadMaxActivePerSubject: '2',
      uploadMaxActiveGlobal: '8',
      uploadMaxConcurrentPartsPerSession: '4',
      uploadMaxConcurrentPartStreamsGlobal: '16',
      uploadInstabilityFailureThreshold: '3',
      uploadMaxConcurrentFinalizations: '1',
      uploadMinFreeBytes: '10737418240',
      uploadPartTimeoutMs: '300000',
      uploadFinalizeTimeoutMs: '600000',
    })
  })

  it('fails loud on an invalid image pull policy (no silent default)', () => {
    process.env.CONTEXT_MAPPER_GFSC_IMAGE_PULL_POLICY = 'bogus'
    expect(() => gfsDefaultFactoryConfig()).toThrow(/Always\|IfNotPresent\|Never/)
  })

  it('validates and passes through the optional GKE kube-dns service CIDR', () => {
    process.env.CONTEXT_MAPPER_NODELOCAL_DNS_CIDR = '203.0.113.10/32'
    expect(gfsDefaultFactoryConfig().nodeLocalDnsCidr).toBe('203.0.113.10/32')

    process.env.CONTEXT_MAPPER_NODELOCAL_DNS_CIDR = '203.0.113.10/24'
    expect(() => gfsDefaultFactoryConfig()).toThrow(/expected \/32 CIDR/)
  })
})
