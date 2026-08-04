import { describe, expect, it } from 'vitest'
import {
  buildDockerLoginCommand,
  buildDockerPushCommand,
  buildDockerTagCommand,
  buildImageCoordinate,
  buildPushCoordinate,
  deriveDockerconfigjson,
  resolveDockerCredential,
} from '../PublisherView/dockerCredential'

describe('dockerCredential helpers', () => {
  it('builds a docker login command with -u _ and the key as -p', () => {
    expect(buildDockerLoginCommand('registry.evenfire.ai', 'efrk_secret')).toBe(
      'docker login registry.evenfire.ai -u _ -p efrk_secret'
    )
  })

  it('builds the push coordinate template', () => {
    expect(buildPushCoordinate('registry.evenfire.ai', 'acme')).toBe(
      'registry.evenfire.ai/acme/<name>:<tag>'
    )
  })

  it('strips the leading @ from an org-scoped coordinate', () => {
    // resolvePublishScope() returns `scope` already prefixed as `@<org>`, but a
    // Docker repo path must not contain '@' (it is the digest delimiter), so the
    // coordinate the user copies must be `registry/<org>/…`, not `registry/@<org>/…`.
    expect(buildPushCoordinate('registry.evenfire.ai', '@acme')).toBe(
      'registry.evenfire.ai/acme/<name>:<tag>'
    )
  })

  it('derives dockerconfigjson with username _, password key, and base64 auth', () => {
    const json = deriveDockerconfigjson('registry.evenfire.ai', 'efrk_secret')
    const parsed = JSON.parse(json)
    const entry = parsed.auths['registry.evenfire.ai']
    expect(entry.username).toBe('_')
    expect(entry.password).toBe('efrk_secret')
    expect(entry.auth).toBe(btoa('_:efrk_secret'))
  })

  it('resolveDockerCredential prefers the server dockerconfigjson + registry when present', () => {
    const out = resolveDockerCredential({
      id: 'k',
      key: 'efrk_x',
      key_prefix: 'efrk_',
      scopes: [],
      expires_at: null,
      dockerconfigjson: '{"auths":{}}',
      registry: 'reg.example.com',
    })
    expect(out.registry).toBe('reg.example.com')
    expect(out.dockerconfigjson).toBe('{"auths":{}}')
  })

  it('resolveDockerCredential derives when the server omits the fields (pre-wiring)', () => {
    const out = resolveDockerCredential({
      id: 'k',
      key: 'efrk_x',
      key_prefix: 'efrk_',
      scopes: [],
      expires_at: null,
    })
    expect(out.registry).toBe('registry.evenfire.ai')
    expect(JSON.parse(out.dockerconfigjson).auths['registry.evenfire.ai'].password).toBe('efrk_x')
  })

  it('builds a per-entry image coordinate, dropping the @ from the namespace', () => {
    expect(buildImageCoordinate('registry.evenfire.ai', '@acme', 'my-connector', '1.2.0')).toBe(
      'registry.evenfire.ai/acme/my-connector:1.2.0'
    )
  })

  it('generates docker tag and push commands from the entry name + org scope', () => {
    expect(buildDockerTagCommand('registry.evenfire.ai', '@acme', 'my-connector', '1.2.0')).toBe(
      'docker tag <local-image> registry.evenfire.ai/acme/my-connector:1.2.0'
    )
    expect(buildDockerPushCommand('registry.evenfire.ai', '@acme', 'my-connector', '1.2.0')).toBe(
      'docker push registry.evenfire.ai/acme/my-connector:1.2.0'
    )
  })
})
