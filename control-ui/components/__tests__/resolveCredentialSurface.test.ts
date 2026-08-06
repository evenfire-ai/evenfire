import { describe, expect, it } from 'vitest'
import { resolveCredentialSurface } from '@components/UpdateConnectorCredentials/resolveCredentialSurface'
import type { McpServerCondition } from '@lib/api'

function condition(overrides: Partial<McpServerCondition> = {}): McpServerCondition {
  return {
    type: 'SecretResolved',
    status: 'False',
    reason: 'SecretNotFound',
    message: 'Secret "x-credentials" not found in namespace "mcp-server"',
    lastTransitionTime: '2026-08-06T04:48:48.564Z',
    ...overrides,
  }
}

describe('resolveCredentialSurface', () => {
  it('returns "set" when the Secret does not exist on a managed connector', () => {
    expect(resolveCredentialSurface([condition()], { managed: true })).toBe('set')
  })

  // The load-bearing case: SecretMissingKey means the Secret EXISTS but lacks a
  // key, which the PUT merge-patch already handles. An implementation matching
  // only type+status (what McpServerTable does for its badge) would wrongly
  // return 'set' here and POST into an AlreadyExists.
  it('returns "rotate" when the Secret exists but is missing a key', () => {
    expect(
      resolveCredentialSurface([condition({ reason: 'SecretMissingKey' })], { managed: true })
    ).toBe('rotate')
  })

  // Pins the `type` clause on its own. Every other fixture is a SecretResolved
  // condition, so deleting `c.type === 'SecretResolved'` from the predicate left
  // the whole suite green: a DeploymentReady=False/SecretNotFound (or any other
  // condition type reusing that reason) would then be read as a missing Secret
  // and send the operator to the create form.
  it('returns "rotate" when SecretNotFound is carried by a different condition type', () => {
    expect(
      resolveCredentialSurface([condition({ type: 'Ready', reason: 'SecretNotFound' })], {
        managed: true,
      })
    ).toBe('rotate')
  })

  // Pins the `status` clause on its own. The clean-resolution fixture below
  // changes `status` AND `reason` together, so the `reason` clause alone kept it
  // green; this one varies ONLY the status.
  it('returns "rotate" when SecretResolved holds SecretNotFound at status Unknown', () => {
    expect(resolveCredentialSurface([condition({ status: 'Unknown' })], { managed: true })).toBe(
      'rotate'
    )
  })

  it('returns "rotate" when the Secret resolves cleanly', () => {
    expect(
      resolveCredentialSurface([condition({ status: 'True', reason: 'SecretResolved' })], {})
    ).toBe('rotate')
  })

  it('returns "rotate" when there are no conditions', () => {
    expect(resolveCredentialSurface([], {})).toBe('rotate')
    expect(resolveCredentialSurface(undefined, undefined)).toBe('rotate')
  })

  // WRC-owned connectors reach the same SecretNotFound condition, but their
  // Secret belongs to the recipe (PUT guards it, POST does not) and HCC never
  // creates a Deployment for them, so the success poll could never converge.
  it('returns "recipe-owned" for a WRC-owned connector whose Secret is missing', () => {
    expect(resolveCredentialSurface([condition()], { managed: false })).toBe('recipe-owned')
  })

  // The managed check applies ONLY when the Secret is missing: rotation that
  // works today on a WRC-owned connector must not be taken away.
  it('returns "rotate" for a WRC-owned connector whose Secret resolves', () => {
    expect(
      resolveCredentialSurface([condition({ status: 'True', reason: 'SecretResolved' })], {
        managed: false,
      })
    ).toBe('rotate')
  })
})
