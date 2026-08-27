import { describe, expect, it } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import { preserveServiceAssignedFields, serviceMatchesDesired } from '../utils'
import { asApiserverService } from './asApiserverService'

function desiredService(overrides: Partial<k8s.V1Service> = {}): k8s.V1Service {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: 'svc', namespace: 'ns', labels: { app: 'svc' } },
    spec: {
      selector: { app: 'svc' },
      ports: [{ name: 'http', port: 8080 }],
    },
    ...overrides,
  }
}

function merged(desired: k8s.V1Service, existing: k8s.V1Service): k8s.V1Service {
  return preserveServiceAssignedFields(
    {
      ...desired,
      metadata: { ...desired.metadata, resourceVersion: existing.metadata?.resourceVersion },
    },
    existing
  )
}

describe('serviceMatchesDesired', () => {
  it('CMP-1: server defaults and omitted targetPort=port compare equal', () => {
    const desired = desiredService()
    const existing = asApiserverService(desired)
    expect(existing.spec?.ports?.[0]?.targetPort).toBe(8080)
    expect(serviceMatchesDesired(merged(desired, existing), existing)).toBe(true)
  })

  it('CMP-2: label diff and a desired annotation are not equivalent', () => {
    const existing = desiredService()
    const labelDrift = desiredService({
      metadata: { name: 'svc', namespace: 'ns', labels: { app: 'other' } },
    })
    expect(serviceMatchesDesired(merged(labelDrift, existing), existing)).toBe(false)

    const annotated = desiredService({
      metadata: {
        name: 'svc',
        namespace: 'ns',
        labels: { app: 'svc' },
        annotations: { 'clerum.io/note': 'added' },
      },
    })
    expect(serviceMatchesDesired(merged(annotated, existing), existing)).toBe(false)
  })

  it('CMP-3: named versus numeric targetPort is a mismatch', () => {
    const desired = desiredService({
      spec: {
        selector: { app: 'svc' },
        ports: [{ name: 'http', port: 8080, targetPort: 'http' }],
      },
    })
    const existing = desiredService({
      spec: {
        selector: { app: 'svc' },
        ports: [{ name: 'http', port: 8080, targetPort: 8080 }],
      },
    })
    expect(serviceMatchesDesired(merged(desired, existing), existing)).toBe(false)
  })

  it('CMP-4: reordered ports are not sorted and compare unequal', () => {
    const desired = desiredService({
      spec: {
        selector: { app: 'svc' },
        ports: [
          { name: 'http', port: 8080 },
          { name: 'desktop', port: 3000 },
        ],
      },
    })
    const existing = desiredService({
      spec: {
        selector: { app: 'svc' },
        ports: [
          { name: 'desktop', port: 3000 },
          { name: 'http', port: 8080 },
        ],
      },
    })
    expect(serviceMatchesDesired(merged(desired, existing), existing)).toBe(false)
  })

  it('CMP-5: missing spec or undefined shapes fail open to write', () => {
    const desired = desiredService()
    expect(serviceMatchesDesired(desired, { metadata: { name: 'svc' } })).toBe(false)
    expect(serviceMatchesDesired(desired, undefined as unknown as k8s.V1Service)).toBe(false)
  })

  it('CMP-6: a well-formed Service is equal to itself', () => {
    const desired = desiredService()
    const existing = asApiserverService(desired)
    expect(serviceMatchesDesired(desired, desired)).toBe(true)
    expect(serviceMatchesDesired(existing, existing)).toBe(true)
  })
})
