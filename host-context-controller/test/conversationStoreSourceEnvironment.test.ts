import { describe, expect, it } from 'vitest'
import { projectConversationStoreSourceEnvironment } from '../src/conversationStoreSourceEnvironment'

const source = (data: Record<string, string>) => ({
  metadata: { name: 'runtime-config', uid: 'config-uid', resourceVersion: '1' },
  data,
})

describe('admitted source environment is a frozen named projection', () => {
  it('sorts named key refs without copying values and supports mutable product values', () => {
    const first = projectConversationStoreSourceEnvironment(
      source({ Z_PRODUCT: 'one', A_PRODUCT: 'two' }),
      'runtime-config'
    )
    expect(first).toEqual([
      {
        name: 'A_PRODUCT',
        valueFrom: { configMapKeyRef: { name: 'runtime-config', key: 'A_PRODUCT' } },
      },
      {
        name: 'Z_PRODUCT',
        valueFrom: { configMapKeyRef: { name: 'runtime-config', key: 'Z_PRODUCT' } },
      },
    ])
    expect(
      projectConversationStoreSourceEnvironment(
        source({ A_PRODUCT: 'changed', Z_PRODUCT: 'later' }),
        'runtime-config'
      )
    ).toEqual(first)
    expect(JSON.stringify(first)).not.toContain('one')
  })
  it('reserves the storage and identity bindings for explicit controller values', () => {
    expect(
      projectConversationStoreSourceEnvironment(
        source({
          CLERUM_HOST_UID: 'tenant',
          CLERUM_PVC_UID: 'tenant',
          CLERUM_SESSION_STORE: 'memory',
          CLERUM_CANONICAL_STORE_CONTRACT: 'canonical',
        }),
        'runtime-config'
      )
    ).toEqual([])
  })
  it.each([
    'NODE_OPTIONS',
    'NODE_PATH',
    'PATH',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'S6_SERVICES_GRACETIME',
    'ENV',
    'GLIBC_TUNABLES',
    'PUID',
  ])('%s cannot enter a newly admitted environment', name => {
    expect(() =>
      projectConversationStoreSourceEnvironment(source({ [name]: 'configured' }), 'runtime-config')
    ).toThrow('SourceEnvironmentUnsafe')
  })
  it('fails closed on absent/native-stale ConfigMap metadata', () => {
    expect(() => projectConversationStoreSourceEnvironment({ data: {} }, 'runtime-config')).toThrow(
      'SourceEnvironmentUnverified'
    )
    expect(() =>
      projectConversationStoreSourceEnvironment(
        { ...source({}), metadata: { ...source({}).metadata, deletionTimestamp: new Date() } },
        'runtime-config'
      )
    ).toThrow('SourceEnvironmentUnverified')
  })
})
