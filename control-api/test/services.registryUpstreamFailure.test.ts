import { describe, expect, it } from 'vitest'
import {
  type RegistryUpstreamStep,
  classifyRegistryUpstreamFailure,
} from '../src/services/registryUpstreamFailure.js'
import {
  APISERVER_LEAK_MARKERS,
  apiserverError,
  connectionRefused,
  expectNoApiserverText,
} from './helpers/apiserverErrors.js'

const registryContent = { source: 'registry', entry: '@acme/weather', version: '1.4.0' } as const

const secretCreate: RegistryUpstreamStep = {
  verb: 'create',
  kind: 'Secret',
  name: 'mcp-weather-creds',
  namespace: 'mcp-host',
  content: { source: 'operator' },
}
const secretUpdate: RegistryUpstreamStep = { ...secretCreate, verb: 'update' }
const mcpServerCreate: RegistryUpstreamStep = {
  verb: 'create',
  kind: 'McpServer',
  name: 'mcp-weather',
  namespace: 'mcp-host',
  content: registryContent,
}
const contextUpdate: RegistryUpstreamStep = {
  verb: 'update',
  kind: 'Context',
  name: 'default',
  namespace: 'contexts',
  content: registryContent,
}
const hostRead: RegistryUpstreamStep = {
  verb: 'read',
  kind: 'Host',
  name: 'host-a',
  namespace: 'hosts',
}

function classify(err: unknown, step: RegistryUpstreamStep) {
  const failure = classifyRegistryUpstreamFailure(err, step)
  expectNoApiserverText(failure.body)
  return failure
}

describe('classifyRegistryUpstreamFailure', () => {
  it.each([
    [403, mcpServerCreate, 'create McpServer "mcp-weather" in namespace "mcp-host"'],
    [401, hostRead, 'read Host "host-a" in namespace "hosts"'],
  ] as const)('maps a %i to a 502 naming control-api access', (status, step, subject) => {
    const failure = classify(apiserverError(status), step)
    expect(failure.status).toBe(502)
    expect(failure.body).toEqual({
      error: 'registry_upstream_failed',
      message:
        `control-api could not ${subject}: the Kubernetes API server rejected the request ` +
        `from control-api's own ServiceAccount (HTTP ${status}): an RBAC rule or an ` +
        `admission policy denied it. Your session is not the cause.`,
      resourceType: step.kind === 'Host' ? 'host' : 'mcp-server',
      resourceName: step.name,
      namespace: step.namespace,
    })
    expect(failure.upstreamStatus).toBe(status)
    expect(failure.severity).toBe('error')
    // Witness that the Status body was parsed: its message reaches the log field.
    expect(failure.upstreamReason).toContain(APISERVER_LEAK_MARKERS.statusMessage)
  })

  it('maps a 409 on a create to "already exists"', () => {
    const failure = classify(apiserverError(409), secretCreate)
    expect(failure.status).toBe(409)
    expect(failure.body.error).toBe('registry_upstream_rejected')
    expect(failure.body.message).toBe(
      'Secret "mcp-weather-creds" already exists in namespace "mcp-host". ' +
        'Uninstall it or choose another name.'
    )
    expect(failure.body.resourceType).toBe('secret')
    expect(failure.severity).toBe('warn')
  })

  it('maps a 409 on an update to "changed while this request was running"', () => {
    const failure = classify(apiserverError(409), contextUpdate)
    expect(failure.status).toBe(409)
    expect(failure.body.error).toBe('registry_upstream_rejected')
    expect(failure.body.message).toBe(
      'Context "default" in namespace "contexts" changed while this request was running. Retry.'
    )
    expect(failure.body.resourceType).toBe('context')
  })

  it('maps a 422 on operator content to the invalid-object message with filtered fields', () => {
    const failure = classify(
      apiserverError(422, {
        causes: [{ field: 'data[API_KEY]' }, { field: 'data[bad key]' }, { field: 42 }],
      }),
      secretCreate
    )
    expect(failure.status).toBe(422)
    expect(failure.body.error).toBe('registry_upstream_rejected')
    expect(failure.body.message).toBe(
      'the Kubernetes API server rejected Secret "mcp-weather-creds" in namespace "mcp-host" ' +
        'as invalid (HTTP 422; fields: data[API_KEY]).'
    )
    expect(failure.invalidFields).toEqual(['data[API_KEY]'])
    expect(failure.severity).toBe('warn')
  })

  it('maps a 422 on registry content to the catalog-mismatch message, deduped and capped at 5', () => {
    const failure = classify(
      apiserverError(422, {
        causes: [
          { field: 'spec.image' },
          { field: 'spec.image' },
          { field: '<script>' },
          { field: 'spec.port' },
          { field: 'spec.env[0].name' },
          { field: 'metadata.labels' },
          { field: 'spec.transport' },
          { field: 'spec.extra' },
        ],
      }),
      mcpServerCreate
    )
    expect(failure.status).toBe(422)
    expect(failure.invalidFields).toEqual([
      'spec.image',
      'spec.port',
      'spec.env[0].name',
      'metadata.labels',
      'spec.transport',
    ])
    expect(failure.body.message).toBe(
      'the Kubernetes API server rejected the McpServer "mcp-weather" spec that control-api ' +
        'built from registry entry @acme/weather@1.4.0 (HTTP 422; fields: spec.image, ' +
        'spec.port, spec.env[0].name, metadata.labels, spec.transport). Your request is not ' +
        "the cause: the catalog entry and this cluster's McpServer definition or admission " +
        'policy disagree.'
    )
    expect(failure.body.message).not.toContain('<script>')
    expect(failure.severity).toBe('error')
  })

  it('omits the field list of a 422 whose Status names no usable field', () => {
    const failure = classify(apiserverError(422), contextUpdate)
    expect(failure.status).toBe(422)
    expect(failure.invalidFields).toEqual([])
    expect(failure.body.message).toContain('registry entry @acme/weather@1.4.0 (HTTP 422).')
  })

  it('maps a 413 on operator content to the credentials-size message', () => {
    const failure = classify(apiserverError(413), secretUpdate)
    expect(failure.status).toBe(413)
    expect(failure.body.error).toBe('registry_upstream_rejected')
    expect(failure.body.message).toBe(
      'the credentials for "mcp-weather-creds" exceed the size the Kubernetes API server ' +
        'accepts (HTTP 413).'
    )
  })

  it.each([
    ['a read', hostRead, 'Host "host-a" not found in namespace "hosts".', 'host'],
    [
      'a named update',
      contextUpdate,
      'Context "default" not found in namespace "contexts".',
      'context',
    ],
  ] as const)('maps a 404 on %s to "not found"', (_label, step, message, resourceType) => {
    const failure = classify(apiserverError(404), step)
    expect(failure.status).toBe(404)
    expect(failure.body).toEqual({
      error: 'registry_upstream_rejected',
      message,
      resourceType,
      resourceName: step.name,
      namespace: step.namespace,
    })
  })

  it.each([
    [
      '404 on a create',
      404,
      mcpServerCreate,
      'create McpServer "mcp-weather" in namespace "mcp-host"',
    ],
    [
      '404 on an operator-content update',
      404,
      secretUpdate,
      'update Secret "mcp-weather-creds" in namespace "mcp-host"',
    ],
    ['409 on a read', 409, hostRead, 'read Host "host-a" in namespace "hosts"'],
    ['422 on a read', 422, hostRead, 'read Host "host-a" in namespace "hosts"'],
    [
      '413 on registry content',
      413,
      mcpServerCreate,
      'create McpServer "mcp-weather" in namespace "mcp-host"',
    ],
    ['400', 400, contextUpdate, 'update Context "default" in namespace "contexts"'],
    ['429', 429, secretCreate, 'create Secret "mcp-weather-creds" in namespace "mcp-host"'],
    ['500', 500, mcpServerCreate, 'create McpServer "mcp-weather" in namespace "mcp-host"'],
  ] as const)('maps a %s to a 503 naming the status', (_label, status, step, subject) => {
    const failure = classify(apiserverError(status), step)
    expect(failure.status).toBe(503)
    expect(failure.body.error).toBe('registry_upstream_failed')
    expect(failure.body.message).toBe(
      `control-api could not ${subject}: the Kubernetes API server returned HTTP ${status}.`
    )
    expect(failure.upstreamStatus).toBe(status)
    expect(failure.severity).toBe('error')
  })

  it('maps a refused connection to a 503 "could not be reached"', () => {
    const failure = classify(connectionRefused(), secretCreate)
    expect(failure.status).toBe(503)
    expect(failure.body.message).toBe(
      'control-api could not create Secret "mcp-weather-creds" in namespace "mcp-host": ' +
        'the Kubernetes API server could not be reached.'
    )
    expect(failure.upstreamStatus).toBeNull()
    expect(failure.upstreamReason).toBe('ECONNREFUSED')
    expect(JSON.stringify(failure.body)).not.toContain('10.96.0.1')
  })

  it('maps an aborted request to a 503 "could not be reached"', () => {
    const abort = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
    const failure = classify(abort, hostRead)
    expect(failure.status).toBe(503)
    expect(failure.upstreamReason).toBe('AbortError')
  })

  it('rethrows an error that is not an apiserver or transport failure unchanged', () => {
    const plain = new Error('bug in control-api')
    expect(() => classifyRegistryUpstreamFailure(plain, secretCreate)).toThrow(plain)
  })

  it('rethrows control-api synthetic errors that carry a status and a string code', () => {
    const synthetic = Object.assign(new Error('Context identity is unavailable'), {
      statusCode: 503,
      code: 'context_identity_unavailable',
    })
    let thrown: unknown
    try {
      classifyRegistryUpstreamFailure(synthetic, contextUpdate)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBe(synthetic)
  })
})
