/**
 * Own-SDK credential wiring + the "never via the baseURL arm" regression (R4).
 *
 * The two own-SDK drivers `require()` their SDK synchronously inside the builder
 * — a lazy load `vi.mock` does NOT intercept — so the credential/config wiring
 * is extracted into pure helpers (`buildVertexClientOptions` /
 * `buildBedrockClientConfig`) that these tests exercise directly, no SDK
 * needed. This locks:
 *   - Vertex credentials are built IN MEMORY from the service-account JSON and
 *     handed to the SDK — never via a GOOGLE_APPLICATION_CREDENTIALS file;
 *   - Bedrock config carries region + the injected key pair;
 *   - vertex/bedrock descriptors carry NO baseURL, so makeProvider can never
 *     route them through the OpenAI-compatible arm.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { descriptorFor } from '../../registryCore'
import { buildBedrockClientConfig } from '../bedrockConverse'
import { buildVertexClientOptions } from '../googleGenerative'

const VALID_SA = JSON.stringify({
  client_email: 'svc@proj.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
  project_id: 'proj-from-json',
})

describe('buildVertexClientOptions — in-memory credentials, no file', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS
    process.env.VERTEX_PROJECT_ID = 'proj-env'
    process.env.VERTEX_LOCATION = 'europe-west1'
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  it('builds vertexai options with in-memory credentials (never a key file)', () => {
    const opts = buildVertexClientOptions({ 'vertex-service-account-json': VALID_SA })
    expect(opts.vertexai).toBe(true)
    expect(opts.project).toBe('proj-env')
    expect(opts.location).toBe('europe-west1')
    // Credentials come from the JSON, in memory — no file path anywhere.
    expect(opts.googleAuthOptions.credentials).toEqual({
      client_email: 'svc@proj.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
    })
    // The builder must NOT set the ADC file env var.
    expect(process.env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined()
  })

  it('falls back to the JSON project_id when VERTEX_PROJECT_ID is unset', () => {
    delete process.env.VERTEX_PROJECT_ID
    const opts = buildVertexClientOptions({ 'vertex-service-account-json': VALID_SA })
    expect(opts.project).toBe('proj-from-json')
  })

  it('defaults location to us-central1', () => {
    delete process.env.VERTEX_LOCATION
    const opts = buildVertexClientOptions({ 'vertex-service-account-json': VALID_SA })
    expect(opts.location).toBe('us-central1')
  })

  it('throws on malformed JSON without echoing the secret', () => {
    let thrown: Error | null = null
    try {
      buildVertexClientOptions({ 'vertex-service-account-json': '{not json — sekret' })
    } catch (e) {
      thrown = e as Error
    }
    expect(thrown?.message).toBe('vertex: service-account JSON is not valid JSON')
    expect(thrown?.message).not.toContain('sekret')
  })

  it('throws when client_email/private_key are missing', () => {
    expect(() =>
      buildVertexClientOptions({
        'vertex-service-account-json': JSON.stringify({ project_id: 'p' }),
      })
    ).toThrow(/missing client_email\/private_key/)
  })

  it('throws when no project id is resolvable', () => {
    delete process.env.VERTEX_PROJECT_ID
    const noProject = JSON.stringify({ client_email: 'a', private_key: 'b' })
    expect(() => buildVertexClientOptions({ 'vertex-service-account-json': noProject })).toThrow(
      /VERTEX_PROJECT_ID is required/
    )
  })

  it('throws when the JSON slot is absent', () => {
    expect(() => buildVertexClientOptions({})).toThrow(/missing service-account JSON/)
  })
})

describe('buildBedrockClientConfig — region + key pair', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    process.env.AWS_REGION = 'us-east-1'
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  it('builds config with region and the injected credentials', () => {
    const cfg = buildBedrockClientConfig({
      'aws-access-key-id': 'AKIA',
      'aws-secret-access-key': 'shh',
    })
    expect(cfg).toEqual({
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIA', secretAccessKey: 'shh' },
    })
  })

  it('throws when AWS_REGION is unset', () => {
    delete process.env.AWS_REGION
    expect(() =>
      buildBedrockClientConfig({ 'aws-access-key-id': 'AKIA', 'aws-secret-access-key': 'shh' })
    ).toThrow(/AWS_REGION is required/)
  })

  it('throws when a key slot is missing', () => {
    expect(() => buildBedrockClientConfig({ 'aws-access-key-id': 'AKIA' })).toThrow(
      /missing AWS access-key-id/
    )
  })
})

describe('own-SDK arms never route through the baseURL (OpenAI-compatible) arm', () => {
  it('vertex/bedrock descriptors carry NO baseURL (structurally cannot hit the compat arm)', () => {
    expect(descriptorFor('vertex').baseURL).toBeUndefined()
    expect(descriptorFor('bedrock').baseURL).toBeUndefined()
    // The OpenAI-compatible providers DO carry one — proving the discriminator.
    expect(descriptorFor('zai').baseURL).toBeTruthy()
    expect(descriptorFor('bailian').baseURL).toBeTruthy()
  })
})
