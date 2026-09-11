import { describe, expect, it } from 'vitest'
import { PRE_DEPLOY_ANNOTATION } from './mcpDelegation'
import {
  HASH_EXCLUDED_ANNOTATIONS,
  SPEC_HASH_ANNOTATION,
  computeSpecHash,
  specHashUnchanged,
  stampSpecHash,
} from './specHash'

describe('computeSpecHash', () => {
  it('is stable across object key ordering (canonical)', () => {
    const a = { spec: { replicas: 1, selector: { matchLabels: { app: 'x' } } } }
    const b = { spec: { selector: { matchLabels: { app: 'x' } }, replicas: 1 } }
    expect(computeSpecHash(a)).toBe(computeSpecHash(b))
  })

  it('ignores volatile server-managed fields (resourceVersion/uid/generation/creationTimestamp/managedFields/status)', () => {
    const desired = {
      metadata: { name: 'app', namespace: 'ns', labels: { a: 'b' } },
      spec: { replicas: 1 },
    }
    const fromServer = {
      metadata: {
        name: 'app',
        namespace: 'ns',
        labels: { a: 'b' },
        resourceVersion: '12345',
        uid: 'abc-uid',
        generation: 598,
        creationTimestamp: '2026-06-19T00:00:00Z',
        managedFields: [{ manager: 'node-fetch' }],
      },
      spec: { replicas: 1 },
      status: { observedGeneration: 597, readyReplicas: 1 },
    }
    expect(computeSpecHash(desired)).toBe(computeSpecHash(fromServer))
  })

  it('ignores the spec-hash annotation itself (no self-reference)', () => {
    const base = { metadata: { name: 'app', annotations: { keep: 'yes' } }, spec: { replicas: 1 } }
    const stamped = {
      metadata: { name: 'app', annotations: { keep: 'yes', [SPEC_HASH_ANNOTATION]: 'deadbeef' } },
      spec: { replicas: 1 },
    }
    expect(computeSpecHash(stamped)).toBe(computeSpecHash(base))
  })

  it('changes when the spec changes', () => {
    const a = { spec: { replicas: 1, template: { spec: { containers: [{ image: 'nginx:1' }] } } } }
    const b = { spec: { replicas: 1, template: { spec: { containers: [{ image: 'nginx:2' }] } } } }
    expect(computeSpecHash(a)).not.toBe(computeSpecHash(b))
  })

  it('changes when a managed label/annotation changes', () => {
    const a = { metadata: { labels: { 'clerum.io/recipe': 'r1' } }, spec: { replicas: 1 } }
    const b = { metadata: { labels: { 'clerum.io/recipe': 'r2' } }, spec: { replicas: 1 } }
    expect(computeSpecHash(a)).not.toBe(computeSpecHash(b))
  })

  // Issue #413: WRC step 7b injects `pre-deploy: "true"` and step 9a omits it, for
  // the SAME McpServer in the SAME pass. If the hash counted this annotation the two
  // manifests would never converge and the idempotency gate would fire a replace
  // twice every pass forever. Excluding it makes 7b and 9a hash identically.
  it('ignores the pre-deploy handshake annotation (7b/9a convergence)', () => {
    const nineA = {
      metadata: { name: 'srv', namespace: 'mcp-server', labels: { 'clerum.io/recipe': 'r1' } },
      spec: { transport: 'stdio' },
    }
    const sevenB = {
      metadata: {
        name: 'srv',
        namespace: 'mcp-server',
        labels: { 'clerum.io/recipe': 'r1' },
        annotations: { [PRE_DEPLOY_ANNOTATION]: 'true' },
      },
      spec: { transport: 'stdio' },
    }
    expect(computeSpecHash(sevenB)).toBe(computeSpecHash(nineA))
  })

  it('keeps HASH_EXCLUDED_ANNOTATIONS in sync with PRE_DEPLOY_ANNOTATION', () => {
    expect(HASH_EXCLUDED_ANNOTATIONS).toContain(PRE_DEPLOY_ANNOTATION)
  })
})

describe('stampSpecHash', () => {
  it('writes the hash into metadata.annotations and is idempotent', () => {
    const manifest = { metadata: { name: 'app' }, spec: { replicas: 1 } } as Record<string, unknown>
    const h1 = stampSpecHash(manifest)
    const annotations = (manifest.metadata as { annotations?: Record<string, string> }).annotations
    expect(annotations?.[SPEC_HASH_ANNOTATION]).toBe(h1)
    // stamping again must not fold the previous hash into the new one
    const h2 = stampSpecHash(manifest)
    expect(h2).toBe(h1)
  })

  it('preserves existing annotations', () => {
    const manifest = {
      metadata: { name: 'app', annotations: { existing: 'kept' } },
      spec: { replicas: 1 },
    } as Record<string, unknown>
    stampSpecHash(manifest)
    const annotations = (manifest.metadata as { annotations?: Record<string, string> }).annotations
    expect(annotations?.existing).toBe('kept')
    expect(annotations?.[SPEC_HASH_ANNOTATION]).toBeDefined()
  })
})

describe('specHashUnchanged', () => {
  it('returns true when the existing object carries the same stamped hash', () => {
    const desired = { metadata: { name: 'app' }, spec: { replicas: 1 } } as Record<string, unknown>
    stampSpecHash(desired)
    const hash = (desired.metadata as { annotations: Record<string, string> }).annotations[
      SPEC_HASH_ANNOTATION
    ]
    const existing = { metadata: { annotations: { [SPEC_HASH_ANNOTATION]: hash } } }
    expect(specHashUnchanged(desired, existing)).toBe(true)
  })

  it('returns false when the existing object has a different hash', () => {
    const desired = { metadata: { name: 'app' }, spec: { replicas: 2 } } as Record<string, unknown>
    stampSpecHash(desired)
    const existing = { metadata: { annotations: { [SPEC_HASH_ANNOTATION]: 'different' } } }
    expect(specHashUnchanged(desired, existing)).toBe(false)
  })

  it('returns false when the existing object has no hash annotation (pre-upgrade object)', () => {
    const desired = { metadata: { name: 'app' }, spec: { replicas: 1 } } as Record<string, unknown>
    stampSpecHash(desired)
    expect(specHashUnchanged(desired, { metadata: {} })).toBe(false)
    expect(specHashUnchanged(desired, null)).toBe(false)
  })
})
