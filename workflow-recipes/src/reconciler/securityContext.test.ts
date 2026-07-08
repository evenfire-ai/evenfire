import { describe, expect, it } from 'vitest'
import { buildWithOverrides } from './securityContext'

describe('securityContext.buildWithOverrides', () => {
  // ─── Minimal Level ─────────────────────────────────────────────────

  it('minimal: sets runAsNonRoot: false (allows root) (2.8a)', () => {
    const result = buildWithOverrides('minimal')
    expect(result.container.runAsNonRoot).toBe(false)
  })

  it('minimal: drops ALL capabilities (2.8b)', () => {
    const result = buildWithOverrides('minimal')
    expect(result.container.capabilities.drop).toEqual(['ALL'])
  })

  it('minimal: sets allowPrivilegeEscalation: false (2.8c)', () => {
    const result = buildWithOverrides('minimal')
    expect(result.container.allowPrivilegeEscalation).toBe(false)
  })

  it('minimal: does NOT set readOnlyRootFilesystem', () => {
    const result = buildWithOverrides('minimal')
    expect(result.container.readOnlyRootFilesystem).toBe(false)
  })

  it('minimal: has no podSecurityContext or podSpec', () => {
    const result = buildWithOverrides('minimal')
    expect(result.podSecurityContext).toBeUndefined()
    expect(result.podSpec).toBeUndefined()
  })

  // ─── Standard Level ────────────────────────────────────────────────

  it('standard: includes readOnlyRootFilesystem: true (2.8d)', () => {
    const result = buildWithOverrides('standard')
    expect(result.container.readOnlyRootFilesystem).toBe(true)
  })

  it('standard: enforces runAsNonRoot: true (2.8e)', () => {
    const result = buildWithOverrides('standard')
    expect(result.container.runAsNonRoot).toBe(true)
    expect(result.container.allowPrivilegeEscalation).toBe(false)
    expect(result.container.capabilities.drop).toEqual(['ALL'])
  })

  it('standard: has no podSecurityContext or podSpec', () => {
    const result = buildWithOverrides('standard')
    expect(result.podSecurityContext).toBeUndefined()
    expect(result.podSpec).toBeUndefined()
  })

  // ─── Strict Level ──────────────────────────────────────────────────

  it("strict: includes PodSecurity labels 'restricted' (2.8f)", () => {
    const result = buildWithOverrides('strict')
    expect(result.podLabels?.['pod-security.kubernetes.io/enforce']).toBe('restricted')
    expect(result.podLabels?.['pod-security.kubernetes.io/enforce-version']).toBe('latest')
  })

  it('strict: returns podSecurityContext with runAsUser/runAsGroup/fsGroup: 65534 (2.8k)', () => {
    const result = buildWithOverrides('strict')
    expect(result.podSecurityContext?.runAsUser).toBe(65534)
    expect(result.podSecurityContext?.runAsGroup).toBe(65534)
    expect(result.podSecurityContext?.fsGroup).toBe(65534)
  })

  it('strict: returns automountServiceAccountToken: false (2.8l)', () => {
    const result = buildWithOverrides('strict')
    expect(result.podSpec?.automountServiceAccountToken).toBe(false)
  })

  it('strict: inherits all standard properties', () => {
    const result = buildWithOverrides('strict')
    expect(result.container.runAsNonRoot).toBe(true)
    expect(result.container.readOnlyRootFilesystem).toBe(true)
    expect(result.container.allowPrivilegeEscalation).toBe(false)
    expect(result.container.capabilities.drop).toEqual(['ALL'])
  })

  // ─── Cross-cutting ─────────────────────────────────────────────────

  it('ALL levels include seccompProfile RuntimeDefault (2.8j)', () => {
    for (const level of ['minimal', 'standard', 'strict'] as const) {
      const result = buildWithOverrides(level)
      expect(result.container.seccompProfile).toEqual({ type: 'RuntimeDefault' })
    }
  })

  it('throws for unknown isolation level (2.8g)', () => {
    // @ts-expect-error testing invalid input
    expect(() => buildWithOverrides('unknown')).toThrow('Unknown isolation level')
  })

  it('output is K8s-API-compatible (no extra fields) (2.8h)', () => {
    const result = buildWithOverrides('minimal')
    const keys = Object.keys(result.container)
    expect(keys).toContain('runAsNonRoot')
    expect(keys).toContain('allowPrivilegeEscalation')
    expect(keys).toContain('capabilities')
    expect(keys).toContain('seccompProfile')
  })

  it('does not mutate across calls (2.8i)', () => {
    const r1 = buildWithOverrides('strict')
    const r2 = buildWithOverrides('strict')
    r1.container.runAsNonRoot = false
    expect(r2.container.runAsNonRoot).toBe(true)
  })

  // ─── Per-Workload Security Overrides (GAP 15) ─────────────────────

  it('runAsUser sets podSecurityContext.runAsUser', () => {
    const result = buildWithOverrides('minimal', { runAsUser: 70 })
    expect(result.podSecurityContext?.runAsUser).toBe(70)
  })

  it('runAsUser forces runAsNonRoot: true on container', () => {
    const result = buildWithOverrides('minimal', { runAsUser: 70 })
    expect(result.container.runAsNonRoot).toBe(true)
  })

  it('runAsGroup sets podSecurityContext.runAsGroup', () => {
    const result = buildWithOverrides('minimal', { runAsGroup: 70 })
    expect(result.podSecurityContext?.runAsGroup).toBe(70)
  })

  it('fsGroup sets podSecurityContext.fsGroup', () => {
    const result = buildWithOverrides('minimal', { fsGroup: 70 })
    expect(result.podSecurityContext?.fsGroup).toBe(70)
  })

  it('all overrides combined', () => {
    const result = buildWithOverrides('minimal', { runAsUser: 70, runAsGroup: 70, fsGroup: 70 })
    expect(result.container.runAsNonRoot).toBe(true)
    expect(result.podSecurityContext?.runAsUser).toBe(70)
    expect(result.podSecurityContext?.runAsGroup).toBe(70)
    expect(result.podSecurityContext?.fsGroup).toBe(70)
  })

  it('overrides work with each isolation level', () => {
    for (const level of ['minimal', 'standard', 'strict'] as const) {
      const result = buildWithOverrides(level, { runAsUser: 999 })
      expect(result.podSecurityContext?.runAsUser).toBe(999)
      expect(result.container.runAsNonRoot).toBe(true)
    }
  })

  it('strict level overrides merge with existing podSecurityContext', () => {
    const result = buildWithOverrides('strict', { runAsUser: 70, fsGroup: 70 })
    expect(result.podSecurityContext?.runAsUser).toBe(70)
    expect(result.podSecurityContext?.fsGroup).toBe(70)
    // runAsGroup not overridden, keeps strict default
    expect(result.podSecurityContext?.runAsGroup).toBe(65534)
  })

  it('addCapabilities adds capabilities back after DROP ALL', () => {
    const result = buildWithOverrides('minimal', { addCapabilities: ['CHOWN', 'FOWNER'] })
    expect(result.container.capabilities.drop).toEqual(['ALL'])
    expect(result.container.capabilities.add).toEqual(['CHOWN', 'FOWNER'])
    expect(result.container.allowPrivilegeEscalation).toBe(false)
    expect(result.container.seccompProfile).toEqual({ type: 'RuntimeDefault' })
  })

  it('rejects denied privilege-boundary capabilities', () => {
    ;['SETUID', 'SETGID', 'SYS_CHROOT', 'KILL', 'AUDIT_WRITE'].forEach(cap => {
      expect(() => buildWithOverrides('minimal', { addCapabilities: [cap] })).toThrow(
        new RegExp(cap)
      )
    })
  })

  it('empty addCapabilities array has no effect', () => {
    const result = buildWithOverrides('minimal', { addCapabilities: [] })
    expect(result.container.capabilities.add).toBeUndefined()
  })

  it('empty overrides object has no effect', () => {
    const without = buildWithOverrides('minimal')
    const withEmpty = buildWithOverrides('minimal', {})
    expect(withEmpty).toEqual(without)
  })

  it('undefined overrides has no effect', () => {
    const without = buildWithOverrides('standard')
    const withUndef = buildWithOverrides('standard', undefined)
    expect(withUndef).toEqual(without)
  })
})
