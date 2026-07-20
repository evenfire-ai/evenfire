import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  canonicalTracingClusterLocation,
  canonicalTracingClusterName,
  canonicalTracingEnvironment,
} from '../src/services/tracing/environment.js'

const ORIGINAL_ENV = { ...process.env }

function resetEnv(): void {
  process.env = { ...ORIGINAL_ENV }
  delete process.env.TRACING_ENVIRONMENT
  delete process.env.TRACING_CLUSTER_NAME
  delete process.env.TRACING_CLUSTER_LOCATION
  delete process.env.KUBERNETES_CLUSTER_NAME
  delete process.env.KUBERNETES_CLUSTER_LOCATION
}

describe('canonical governed tracing environment', () => {
  beforeEach(resetEnv)
  afterEach(resetEnv)

  it('uses explicit tracing dimensions when configured', () => {
    process.env.NODE_ENV = 'production'
    process.env.TRACING_ENVIRONMENT = 'prod-eu'
    process.env.TRACING_CLUSTER_NAME = 'gke-prod-1'
    process.env.TRACING_CLUSTER_LOCATION = 'europe-west1'

    expect(canonicalTracingEnvironment()).toBe('prod-eu')
    expect(canonicalTracingClusterName()).toBe('gke-prod-1')
    expect(canonicalTracingClusterLocation()).toBe('europe-west1')
  })

  it('keeps local test defaults explicit without using unknown cluster dimensions', () => {
    process.env.NODE_ENV = 'test'

    expect(canonicalTracingEnvironment()).toBe('test')
    expect(canonicalTracingClusterName()).toBe('local-cluster')
    expect(canonicalTracingClusterLocation()).toBe('')
  })

  it('fails closed in production when required tracing dimensions are missing', () => {
    process.env.NODE_ENV = 'production'

    expect(() => canonicalTracingEnvironment()).toThrow(
      'Missing required governed tracing environment variable: TRACING_ENVIRONMENT'
    )
    expect(() => canonicalTracingClusterName()).toThrow(
      'Missing required governed tracing environment variable: TRACING_CLUSTER_NAME or KUBERNETES_CLUSTER_NAME'
    )
    expect(() => canonicalTracingClusterLocation()).toThrow(
      'Missing required governed tracing environment variable: TRACING_CLUSTER_LOCATION or KUBERNETES_CLUSTER_LOCATION'
    )
  })
})
