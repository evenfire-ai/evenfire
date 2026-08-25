import { describe, expect, it } from 'vitest'
import {
  REGISTRY_OPERATION_ID_ANNOTATION,
  REGISTRY_SPEC_DIGEST_ANNOTATION,
  type RegistryMutationDesired,
  type RegistryResourceSnapshot,
  classifyCreatedRegistryMutationReadback,
  classifyRegistryMutationReadback,
  classifySecretMutationReadback,
  registrySecretDataDigest,
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

  it('classifies a stable unchanged prior object as not committed', () => {
    expect(
      classifyRegistryMutationReadback({
        before,
        desired,
        current: current({}),
        operationId,
      })
    ).toBe('not-committed')
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

describe('credential mutation readback classifier', () => {
  const beforeSecret = {
    metadata: {
      uid: 'uid-credential-a',
      resourceVersion: '7',
      annotations: { 'clerum.io/registry-operation-id': 'previous-operation' },
    },
  }

  it('classifies a matching readback as a desired candidate, never as a commit receipt', () => {
    expect(
      classifySecretMutationReadback({
        before: beforeSecret,
        current: {
          metadata: {
            uid: beforeSecret.metadata.uid,
            resourceVersion: '8',
            annotations: { 'clerum.io/registry-operation-id': operationId },
          },
        },
        operationId,
        operationAnnotationKey: 'clerum.io/registry-operation-id',
        expectedDataDigest: registrySecretDataDigest(undefined),
      })
    ).toBe('desired')
  })

  it('keeps a same-UID metadata race ambiguous even when data and marker match', () => {
    const expectedAnnotations = {
      'clerum.io/registry-operation-id': operationId,
    }
    expect(
      classifySecretMutationReadback({
        before: beforeSecret,
        current: {
          metadata: {
            uid: beforeSecret.metadata.uid,
            resourceVersion: '8',
            annotations: { ...expectedAnnotations, 'concurrent.example/trace': 'writer-b' },
          },
          stringData: { field: 'expected' },
        },
        operationId,
        operationAnnotationKey: 'clerum.io/registry-operation-id',
        expectedDataDigest: registrySecretDataDigest(undefined, { field: 'expected' }),
        expectedMetadata: { annotations: expectedAnnotations },
      })
    ).toBe('ambiguous')
  })

  it('keeps a delete-and-recreated object ambiguous even when it copies the operation marker', () => {
    expect(
      classifySecretMutationReadback({
        before: beforeSecret,
        current: {
          metadata: {
            uid: 'uid-credential-replacement',
            resourceVersion: '1',
            annotations: { 'clerum.io/registry-operation-id': operationId },
          },
        },
        operationId,
        operationAnnotationKey: 'clerum.io/registry-operation-id',
      })
    ).toBe('ambiguous')
  })

  it('does not turn an absent marker or a missing read into no-commit', () => {
    expect(
      classifySecretMutationReadback({
        before: beforeSecret,
        current: {
          metadata: {
            uid: beforeSecret.metadata.uid,
            resourceVersion: '8',
            annotations: { 'clerum.io/registry-operation-id': 'other-operation' },
          },
        },
        operationId,
        operationAnnotationKey: 'clerum.io/registry-operation-id',
      })
    ).toBe('ambiguous')
    expect(
      classifySecretMutationReadback({
        before: undefined,
        current: null,
        operationId,
        operationAnnotationKey: 'clerum.io/registry-operation-id',
      })
    ).toBe('ambiguous')
  })
})

describe('created resource readback classifier', () => {
  const desiredSpec = { image: 'example:new', transport: { port: 3000 } }
  const desired = {
    spec: desiredSpec,
    metadata: {
      labels: { 'clerum.io/managed-by': 'control-api' },
      annotations: {
        [REGISTRY_OPERATION_ID_ANNOTATION]: operationId,
        [REGISTRY_SPEC_DIGEST_ANNOTATION]: registrySpecDigest(desiredSpec),
      },
    },
    specDigest: registrySpecDigest(desiredSpec),
  }

  it('requires operation identity, exact intent digest, and server identity', () => {
    expect(
      classifyCreatedRegistryMutationReadback({
        current: {
          metadata: {
            uid: 'uid-created',
            resourceVersion: '1',
            labels: desired.metadata.labels,
            annotations: desired.metadata.annotations,
          },
          spec: desiredSpec,
        },
        desired,
        operationId,
      })
    ).toBe('committed')
    expect(
      classifyCreatedRegistryMutationReadback({
        current: {
          metadata: {
            uid: 'uid-created',
            resourceVersion: '1',
            labels: desired.metadata.labels,
            annotations: {
              ...desired.metadata.annotations,
              [REGISTRY_OPERATION_ID_ANNOTATION]: 'other',
            },
          },
          spec: desiredSpec,
        },
        desired,
        operationId,
      })
    ).toBe('ambiguous')
  })
})
