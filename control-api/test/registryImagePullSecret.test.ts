import { describe, expect, it } from 'vitest'
import {
  EVENFIRE_REGISTRY_PULL_SECRET_NAME,
  imageRefHost,
  registryHostFromUrl,
  shouldAttachEvenfirePullSecret,
} from '../src/routes/admin/registryImagePullSecret.js'

describe('EVENFIRE_REGISTRY_PULL_SECRET_NAME', () => {
  it('is the frozen pull-secret name', () => {
    expect(EVENFIRE_REGISTRY_PULL_SECRET_NAME).toBe('evenfire-registry-pull')
  })
})

describe('registryHostFromUrl', () => {
  it('returns the host (no port) for a plain https registry URL', () => {
    expect(registryHostFromUrl('https://registry.evenfire.ai')).toBe('registry.evenfire.ai')
  })
  it('keeps the :port for an in-cluster registry URL', () => {
    expect(registryHostFromUrl('http://registry-api.registry.svc.cluster.local:8085')).toBe(
      'registry-api.registry.svc.cluster.local:8085'
    )
  })
  it('returns null for an empty or whitespace string', () => {
    expect(registryHostFromUrl('')).toBeNull()
    expect(registryHostFromUrl('   ')).toBeNull()
  })
  it('returns null for an unparseable URL', () => {
    expect(registryHostFromUrl('not a url')).toBeNull()
  })
})

describe('imageRefHost', () => {
  it('parses the evenfire host from a tagged bare ref', () => {
    expect(imageRefHost('registry.evenfire.ai/acme/forecast:1.2.3')).toBe('registry.evenfire.ai')
  })
  it('parses the evenfire host from a digest-pinned bare ref', () => {
    expect(imageRefHost('registry.evenfire.ai/acme/forecast@sha256:abc123')).toBe(
      'registry.evenfire.ai'
    )
  })
  it('parses a GCP Artifact Registry host', () => {
    expect(
      imageRefHost('us-central1-docker.pkg.dev/${GCP_PROJECT}/clerum/airtable-mcp:latest')
    ).toBe('us-central1-docker.pkg.dev')
  })
  it('parses a host that carries an explicit port', () => {
    expect(imageRefHost('registry-api.registry.svc.cluster.local:8085/org/name:tag')).toBe(
      'registry-api.registry.svc.cluster.local:8085'
    )
  })
  it('treats a docker-hub org/name (no dot/colon in first segment) as no host', () => {
    expect(imageRefHost('mongodb/mongodb-mcp-server:latest')).toBeNull()
    expect(imageRefHost('clerum/airtable-mcp:1.0.0')).toBeNull()
  })
  it('recognizes a dotless host that carries a port (pins the colon branch)', () => {
    // A registry host with no dot but an explicit :port (e.g. the dev-mode
    // sanctioned http://localhost:8085 registry) is a host solely by the ':'
    // rule — this case fails if the colon branch of imageRefHost is dropped.
    expect(imageRefHost('localhost:5000/org/img:tag')).toBe('localhost:5000')
    expect(imageRefHost('localhost:8085/acme/forecast:1.0.0')).toBe('localhost:8085')
  })
  it('treats a bare single-segment ref (no slash) as no host even with a tag colon', () => {
    expect(imageRefHost('nginx:latest')).toBeNull()
    expect(imageRefHost('nginx')).toBeNull()
  })
  it('returns null for empty/whitespace input', () => {
    expect(imageRefHost('')).toBeNull()
    expect(imageRefHost('   ')).toBeNull()
  })
})

describe('shouldAttachEvenfirePullSecret', () => {
  const EVENFIRE = 'https://registry.evenfire.ai'
  it('is true for a local evenfire-hosted image', () => {
    expect(
      shouldAttachEvenfirePullSecret({
        isLocal: true,
        image: 'registry.evenfire.ai/acme/forecast:1.2.3',
        registryUrl: EVENFIRE,
      })
    ).toBe(true)
  })
  it('is false for a local GCP-AR image', () => {
    expect(
      shouldAttachEvenfirePullSecret({
        isLocal: true,
        image: 'us-central1-docker.pkg.dev/p/r/airtable:1.0',
        registryUrl: EVENFIRE,
      })
    ).toBe(false)
  })
  it('is false for a local docker-hub image', () => {
    expect(
      shouldAttachEvenfirePullSecret({
        isLocal: true,
        image: 'mongodb/mongodb-mcp-server:latest',
        registryUrl: EVENFIRE,
      })
    ).toBe(false)
  })
  it('is false for a remote entry even with an evenfire imageRef', () => {
    expect(
      shouldAttachEvenfirePullSecret({
        isLocal: false,
        image: 'registry.evenfire.ai/acme/forecast:1.2.3',
        registryUrl: EVENFIRE,
      })
    ).toBe(false)
  })
  it('is false when the registry URL is unconfigured (empty)', () => {
    expect(
      shouldAttachEvenfirePullSecret({
        isLocal: true,
        image: 'registry.evenfire.ai/acme/forecast:1.2.3',
        registryUrl: '',
      })
    ).toBe(false)
  })
  it('is false for a non-string image', () => {
    expect(
      shouldAttachEvenfirePullSecret({ isLocal: true, image: undefined, registryUrl: EVENFIRE })
    ).toBe(false)
    expect(
      shouldAttachEvenfirePullSecret({ isLocal: true, image: 42, registryUrl: EVENFIRE })
    ).toBe(false)
  })
  it('matches an in-cluster registry host when configured that way', () => {
    expect(
      shouldAttachEvenfirePullSecret({
        isLocal: true,
        image: 'registry-api.registry.svc.cluster.local:8085/org/name:tag',
        registryUrl: 'http://registry-api.registry.svc.cluster.local:8085',
      })
    ).toBe(true)
  })
  it('matches a dotless host:port registry (pins the colon branch end-to-end)', () => {
    // Dev-mode allows http://localhost:8085; a local plugin image on that host
    // must still attach the pull secret, which only works if imageRefHost
    // recognizes the dotless-but-colon-bearing host.
    expect(
      shouldAttachEvenfirePullSecret({
        isLocal: true,
        image: 'localhost:5000/org/img:tag',
        registryUrl: 'http://localhost:5000',
      })
    ).toBe(true)
  })
})
