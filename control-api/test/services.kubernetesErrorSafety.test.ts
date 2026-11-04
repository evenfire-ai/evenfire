import { describe, expect, it, vi } from 'vitest'
import { ApiException } from '@kubernetes/client-node'
import pino from 'pino'
import { admissionDenialMessage } from '../src/http/k8sError.js'
import { rootLogger, serializeLogError } from '../src/observability/logger.js'
import { captureSecretForCleanup } from '../src/services/secretCleanup.js'
import { SecretReadError } from '../src/services/secretRead.js'
import { controlApiForbiddenRead } from './helpers/secretReadFailure.js'

const status = (code: number, message: string) =>
  JSON.stringify({ kind: 'Status', apiVersion: 'v1', status: 'Failure', message, code })

const vapDenial = () =>
  new ApiException(
    403,
    'Forbidden',
    status(
      403,
      "workflowrecipes.clerum.io \"r1\" is forbidden: ValidatingAdmissionPolicy 'workflowrecipe-namespace-allowlist' with binding 'workflowrecipe-namespace-allowlist' denied request: Only the workflow-recipes controller may set WorkflowRecipe ownerReferences."
    ),
    { 'audit-id': 'a1b2' }
  )

describe('admissionDenialMessage', () => {
  it('returns the Status message of a ValidatingAdmissionPolicy denial', () => {
    expect(admissionDenialMessage(vapDenial())).toContain(
      'Only the workflow-recipes controller may set WorkflowRecipe ownerReferences.'
    )
  })

  it('returns the Status message of a validating webhook denial', () => {
    const err = new ApiException(
      403,
      'Forbidden',
      status(403, 'admission webhook "validate.example.io" denied the request: bad label'),
      {}
    )
    expect(admissionDenialMessage(err)).toBe(
      'admission webhook "validate.example.io" denied the request: bad label'
    )
  })

  it('returns null for an RBAC 403, which names the ServiceAccount', () => {
    expect(admissionDenialMessage(controlApiForbiddenRead('s1', 'mcp-host'))).toBeNull()
  })

  it('returns null for an admission-shaped message on a status other than 403', () => {
    const err = new ApiException(
      422,
      'Invalid',
      status(422, "ValidatingAdmissionPolicy 'p' with binding 'b' denied request: invalid"),
      {}
    )
    expect(admissionDenialMessage(err)).toBeNull()
  })
})

describe('serializeLogError', () => {
  it('logs a K8s ApiException as its name, status and Status message, without headers', () => {
    const err = controlApiForbiddenRead('s1', 'mcp-host')
    // Witness: the producer really embeds the headers in its message.
    expect(err.message).toContain('5f0c7a4e-secret-read')

    const serialized = JSON.stringify(serializeLogError(err))

    expect(serialized).toContain('"status":403')
    expect(serialized).toContain('cannot get resource')
    expect(serialized).not.toContain('5f0c7a4e-secret-read')
    expect(serialized).not.toContain('audit-id')
  })

  it('keeps the standard serialization for any other error', () => {
    const err = new TypeError('boom')
    expect(serializeLogError(err)).toEqual(pino.stdSerializers.err(err))
  })

  it('is the `err` serializer of the root logger, inherited by its children', () => {
    const serializers = (child: unknown) =>
      (child as Record<symbol, Record<string, unknown>>)[pino.symbols.serializersSym]
    expect(serializers(rootLogger).err).toBe(serializeLogError)
    expect(serializers(rootLogger.child({ module: 'x' })).err).toBe(serializeLogError)
  })
})

describe('captureSecretForCleanup', () => {
  const logger = { error: vi.fn() } as unknown as Parameters<typeof captureSecretForCleanup>[3]

  it('reports an apiserver read failure as read-failed carrying the SecretReadError', async () => {
    const gateway = {
      getSecret: vi.fn(async () => Promise.reject(controlApiForbiddenRead('c1', 'mcp-server'))),
    }
    const capture = await captureSecretForCleanup(gateway, 'c1', 'mcp-server', logger)
    expect(capture.status).toBe('read-failed')
    expect((capture as { error: unknown }).error).toBeInstanceOf(SecretReadError)
    expect(gateway.getSecret).toHaveBeenCalledWith('c1', 'mcp-server')
  })

  it('reports an error that is not an apiserver failure as read-failed too', async () => {
    const parseError = new SyntaxError('Unexpected token < in JSON')
    const gateway = { getSecret: vi.fn(async () => Promise.reject(parseError)) }
    const capture = await captureSecretForCleanup(gateway, 'c1', 'mcp-server', logger)
    expect(capture).toEqual({ status: 'read-failed', name: 'c1', error: parseError })
    expect(gateway.getSecret).toHaveBeenCalledOnce()
  })
})
