import { describe, expect, it } from 'vitest'
import {
  REGISTRY_OPERATION_ID_ANNOTATION,
  REGISTRY_SPEC_DIGEST_ANNOTATION,
  type RegistryMutationDesired,
  type RegistryResourceSnapshot,
  classifyRegistryAssociationReadback,
  classifyRegistryMutationReadback,
  registrySpecDigest,
} from '../src/services/registryMutation.js'

const operationId = 'operation-current'
const before: RegistryResourceSnapshot = {
  metadata: {
    uid: 'uid-server-a',
    resourceVersion: 'opaque-before',
    labels: { 'clerum.io/managed-by': 'control-api', 'clerum.io/server-mode': 'local' },
    annotations: { 'clerum.io/catalog-id': 'entry', 'clerum.io/catalog-version': '1.0.0' },
  },
  spec: { image: 'plugin:old', transport: { port: 3000 } },
}
const desiredSpec = { image: 'plugin:new', transport: { port: 3000 }, egressBindings: [] }
const desired: RegistryMutationDesired = {
  spec: desiredSpec,
  metadata: {
    labels: before.metadata?.labels,
    annotations: {
      ...before.metadata?.annotations,
      [REGISTRY_OPERATION_ID_ANNOTATION]: operationId,
      [REGISTRY_SPEC_DIGEST_ANNOTATION]: registrySpecDigest(desiredSpec),
    },
  },
  specDigest: registrySpecDigest(desiredSpec),
}

function current(overrides: Partial<RegistryResourceSnapshot>): RegistryResourceSnapshot {
  return {
    metadata: { ...before.metadata, ...(overrides.metadata ?? {}) },
    spec: overrides.spec ?? before.spec,
  }
}

describe('registry mutation readback classifier', () => {
  it('canonicalizes object key order but preserves array order', () => {
    expect(registrySpecDigest({ b: 2, a: { d: 4, c: 3 }, ignored: undefined })).toBe(
      registrySpecDigest({ a: { c: 3, d: 4 }, b: 2 })
    )
    expect(registrySpecDigest({ values: ['a', 'b'] })).not.toBe(
      registrySpecDigest({ values: ['b', 'a'] })
    )
  })

  it('keeps a stable unchanged prior object ambiguous until the caller fences it', () => {
    expect(
      classifyRegistryMutationReadback({
        before,
        desired,
        current: current({}),
        operationId,
      })
    ).toBe('ambiguous')
  })

  it('keeps a stable unchanged association ambiguous until the caller fences it', () => {
    expect(
      classifyRegistryAssociationReadback({
        before,
        current: current({}),
        isCommitted: spec => spec.image === 'plugin:new',
      })
    ).toBe('ambiguous')
  })

  it('requires the current operation identity, desired digest, labels and an advanced RV', () => {
    expect(
      classifyRegistryMutationReadback({
        before,
        desired,
        current: current({
          metadata: {
            resourceVersion: 'opaque-after',
            annotations: desired.metadata.annotations,
          },
          spec: desiredSpec,
        }),
        operationId,
      })
    ).toBe('committed')

    expect(
      classifyRegistryMutationReadback({
        before,
        desired,
        current: current({
          metadata: {
            resourceVersion: 'opaque-after',
            annotations: desired.metadata.annotations,
            labels: { ...before.metadata?.labels, 'clerum.io/server-mode': 'remote' },
          },
          spec: desiredSpec,
        }),
        operationId,
      })
    ).toBe('ambiguous')
  })

  it('rejects a replacement UID even when it copied the complete current intent', () => {
    expect(
      classifyRegistryMutationReadback({
        before,
        desired,
        current: {
          metadata: {
            ...before.metadata,
            uid: 'uid-server-replacement',
            resourceVersion: 'opaque-after',
            annotations: desired.metadata.annotations,
            labels: desired.metadata.labels,
          },
          spec: desiredSpec,
        },
        operationId,
      })
    ).toBe('ambiguous')
  })

  it.each([
    ['different UID', { metadata: { uid: 'uid-server-b' }, spec: desiredSpec }],
    ['different operation', { metadata: { resourceVersion: 'opaque-after' }, spec: desiredSpec }],
    [
      'different spec',
      {
        metadata: { resourceVersion: 'opaque-after', annotations: desired.metadata.annotations },
        spec: { image: 'plugin:other' },
      },
    ],
    ['missing current identity', { metadata: { uid: undefined }, spec: desiredSpec }],
  ])('returns ambiguous for %s', (_label, overrides) => {
    const metadata = {
      ...before.metadata,
      ...overrides.metadata,
      ...(overrides.metadata?.resourceVersion
        ? {}
        : { [REGISTRY_OPERATION_ID_ANNOTATION]: 'other-operation' }),
    }
    expect(
      classifyRegistryMutationReadback({
        before,
        desired,
        current: current({ metadata, spec: overrides.spec }),
        operationId,
      })
    ).toBe('ambiguous')
  })
})
