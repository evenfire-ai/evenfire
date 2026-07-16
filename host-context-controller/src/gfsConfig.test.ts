import { afterEach, describe, expect, it } from 'vitest'
import { gfsDefaultFactoryConfig } from './gfsConfig'

const GFS_ENV_KEYS = Object.keys(process.env).filter(k => k.startsWith('CONTEXT_MAPPER_GFS'))

afterEach(() => {
  for (const k of GFS_ENV_KEYS) delete process.env[k]
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
  })

  it('fails loud on an invalid image pull policy (no silent default)', () => {
    process.env.CONTEXT_MAPPER_GFSC_IMAGE_PULL_POLICY = 'bogus'
    expect(() => gfsDefaultFactoryConfig()).toThrow(/Always\|IfNotPresent\|Never/)
  })

  it('validates and passes through the optional GKE kube-dns service CIDR', () => {
    process.env.CONTEXT_MAPPER_NODELOCAL_DNS_CIDR = '203.0.113.10/32'
    expect(gfsDefaultFactoryConfig().nodeLocalDnsCidr).toBe('203.0.113.10/32')

    process.env.CONTEXT_MAPPER_NODELOCAL_DNS_CIDR = '203.0.113.0/24'
    expect(() => gfsDefaultFactoryConfig()).toThrow(/expected \/32 CIDR/)
  })
})
