import { describe, expect, it } from 'vitest'
import {
  eagerMcpHostPodTokenGenerationDrift,
  eagerMcpHostRequiresTokenRoll,
} from './pluginWorkloadSdkProvisioner'

describe('eager mcp-host token roll predicates', () => {
  it('rolls only on this-pass scope or binding remint', () => {
    expect(eagerMcpHostRequiresTokenRoll({ reminted: true, reason: 'scope' })).toBe(true)
    expect(eagerMcpHostRequiresTokenRoll({ reminted: true, reason: 'binding' })).toBe(true)
    expect(eagerMcpHostRequiresTokenRoll({ reminted: true, reason: 'ttl' })).toBe(false)
    expect(eagerMcpHostRequiresTokenRoll({ reminted: false })).toBe(false)
    expect(eagerMcpHostRequiresTokenRoll(undefined)).toBe(false)
  })

  it('rolls a leftover pod when the Secret generation residue drifted', () => {
    expect(
      eagerMcpHostPodTokenGenerationDrift({ reminted: false, tokenGeneration: '2' }, '1')
    ).toBe(true)
    expect(
      eagerMcpHostPodTokenGenerationDrift({ reminted: false, tokenGeneration: '2' }, undefined)
    ).toBe(true)
    expect(
      eagerMcpHostPodTokenGenerationDrift({ reminted: false, tokenGeneration: '2' }, '2')
    ).toBe(false)
    expect(eagerMcpHostPodTokenGenerationDrift({ reminted: false }, '1')).toBe(false)
    expect(eagerMcpHostPodTokenGenerationDrift(undefined, '1')).toBe(false)
  })
})
