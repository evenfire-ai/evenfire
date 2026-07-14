import { describe, expect, it } from 'vitest'
import { assertChannelsNamespace } from '../src/startupGuards.js'

/**
 * Boot guard: a per-tenant control-api (pod namespace ≠ 'control-plane') must
 * NOT start with the bare default 'channels' namespace — it must be set to
 * 'channels-<slug>' so CommunicationChannels land in the right tenant namespace.
 *
 * The guard is a pure function so it can be unit-tested without any I/O.
 * The boot path calls it after reading /var/run/secrets/kubernetes.io/serviceaccount/namespace.
 *
 * Cases:
 *   (a) tenant pod + bare 'channels'          → throws
 *   (b) tenant pod + 'channels-acme'          → ok
 *   (c) single-cluster pod + 'channels'       → ok
 *   (d) no SA file (dev, empty podNamespace)  → ok (no throw)
 */
describe('assertChannelsNamespace', () => {
  it('(a) throws when tenant pod namespace is set and channels-ns is bare "channels"', () => {
    expect(() => assertChannelsNamespace('control-plane-acme', 'channels')).toThrow(
      /CONTROL_API_COMMUNICATION_CHANNELS_NAMESPACE must be channels-<slug>/
    )
    expect(() => assertChannelsNamespace('control-plane-acme', 'channels')).toThrow(
      /got 'channels'/
    )
  })

  it('(b) does NOT throw when tenant pod namespace is set and channels-ns is tenant-scoped', () => {
    expect(() => assertChannelsNamespace('control-plane-acme', 'channels-acme')).not.toThrow()
  })

  it('(c) does NOT throw for single-cluster pod namespace "control-plane" with bare "channels"', () => {
    expect(() => assertChannelsNamespace('control-plane', 'channels')).not.toThrow()
  })

  it('(d) does NOT throw when pod namespace is empty (no SA file / dev mode)', () => {
    expect(() => assertChannelsNamespace('', 'channels')).not.toThrow()
    expect(() => assertChannelsNamespace('', 'channels-anything')).not.toThrow()
  })

  it('throws only for the exact bare "channels" value — a prefixed value like "channels-x" is fine', () => {
    expect(() => assertChannelsNamespace('control-plane-tenant1', 'channels-tenant1')).not.toThrow()
    expect(() =>
      assertChannelsNamespace('control-plane-tenant1', 'channels-completely-different')
    ).not.toThrow()
  })

  it('error message names both the pod namespace and the misconfigured channels namespace', () => {
    let thrown: Error | undefined
    try {
      assertChannelsNamespace('control-plane-acme', 'channels')
    } catch (e) {
      thrown = e as Error
    }
    expect(thrown).toBeDefined()
    expect(thrown!.message).toContain('control-plane-acme')
    expect(thrown!.message).toContain("got 'channels'")
  })
})
