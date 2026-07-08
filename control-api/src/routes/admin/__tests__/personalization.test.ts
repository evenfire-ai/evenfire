import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

// vi.mock specifier is resolved RELATIVE TO THIS TEST FILE (routes/admin/__tests__/),
// so we need three "../" to reach src/middleware/. The route file at routes/admin/
// imports it as "../../middleware/...", which resolves to the same canonical module.
// Vitest matches mocks by canonical path, not by string equality.
vi.mock('../../../middleware/controlUIAuth.js', () => ({
  requireAuthForControlUI: (req: any, _res: any, next: any) => {
    req.adminAuth = { sub: 'test-admin', jti: 'test-jti' }
    next()
  },
}))

// Import AFTER vi.mock so the mocked middleware wires up.
const { createAdminPersonalizationRouter } = await import('../personalization.js')

describe('admin personalization route', () => {
  function buildApp(gateway: any) {
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    app.use('/api/v1', createAdminPersonalizationRouter(gateway as any))
    return app
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('GET /admin/hosts/:hostRef/personalization', () => {
    it('returns the four fields and resourceVersion for an existing host', async () => {
      const gateway = {
        getResource: vi.fn().mockResolvedValue({
          metadata: { name: 'foo', resourceVersion: '12345' },
          spec: {
            personalization: {
              enabled: true,
              identity: 'I am Clerum.',
              soul: 'Be helpful.',
              agents: 'Use tools.',
              user: 'User context.',
            },
          },
        }),
      }
      const app = buildApp(gateway)
      const res = await request(app).get('/api/v1/admin/hosts/foo/personalization')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        identity: 'I am Clerum.',
        soul: 'Be helpful.',
        agents: 'Use tools.',
        user: 'User context.',
        resourceVersion: '12345',
      })
    })

    it('returns empty strings for missing personalization fields', async () => {
      const gateway = {
        getResource: vi.fn().mockResolvedValue({
          metadata: { name: 'foo', resourceVersion: '1' },
          spec: {},
        }),
      }
      const app = buildApp(gateway)
      const res = await request(app).get('/api/v1/admin/hosts/foo/personalization')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        identity: '',
        soul: '',
        agents: '',
        user: '',
        resourceVersion: '1',
      })
    })

    it('returns 500 when Kubernetes returns a host without resourceVersion', async () => {
      const gateway = {
        getResource: vi.fn().mockResolvedValue({
          metadata: { name: 'foo' },
          spec: {},
        }),
      }
      const app = buildApp(gateway)
      const res = await request(app).get('/api/v1/admin/hosts/foo/personalization')
      expect(res.status).toBe(500)
      expect(res.body.error).toMatch(/resourceVersion/)
    })

    it('returns 404 when host CRD does not exist', async () => {
      const gateway = {
        getResource: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error('not found'), { code: 404 })),
      }
      const app = buildApp(gateway)
      const res = await request(app).get('/api/v1/admin/hosts/missing/personalization')
      expect(res.status).toBe(404)
    })
  })

  describe('PUT /admin/hosts/:hostRef/personalization', () => {
    function existingHost(rv = '10') {
      return {
        metadata: {
          annotations: { 'meta.helm.sh/release-name': 'clerum' },
          labels: { 'app.kubernetes.io/managed-by': 'Helm' },
          name: 'foo',
          namespace: 'mcp-host',
          resourceVersion: rv,
        },
        spec: {
          host: 'foo',
          contextRef: 'ctx',
          secretRef: 'sec',
          personalization: {
            enabled: true,
            identity: 'old-id',
            soul: 'old-soul',
            agents: 'old-agents',
            user: 'old-user',
          },
        },
      }
    }

    it('updates all four fields and returns new resourceVersion', async () => {
      const replaceMock = vi.fn().mockResolvedValue({
        metadata: { name: 'foo', resourceVersion: '11' },
      })
      const gateway = {
        getResource: vi.fn().mockResolvedValue(existingHost('10')),
        replaceHost: replaceMock,
      }
      const app = buildApp(gateway)
      const res = await request(app).put('/api/v1/admin/hosts/foo/personalization').send({
        identity: 'new-id',
        soul: 'new-soul',
        agents: 'new-agents',
        user: 'new-user',
        resourceVersion: '10',
      })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ resourceVersion: '11' })
      const replaced = replaceMock.mock.calls[0][0]
      expect(replaced.spec.personalization).toEqual({
        enabled: true,
        identity: 'new-id',
        soul: 'new-soul',
        agents: 'new-agents',
        user: 'new-user',
      })
      expect(replaced.metadata.resourceVersion).toBe('10')
    })

    it('preserves existing labels and annotations on host replace', async () => {
      const replaceMock = vi.fn().mockResolvedValue({
        metadata: { resourceVersion: '11' },
      })
      const gateway = {
        getResource: vi.fn().mockResolvedValue(existingHost('10')),
        replaceHost: replaceMock,
      }
      const app = buildApp(gateway)
      await request(app)
        .put('/api/v1/admin/hosts/foo/personalization')
        .send({ identity: 'new-id', resourceVersion: '10' })
      expect(replaceMock.mock.calls[0][0].metadata).toMatchObject({
        annotations: { 'meta.helm.sh/release-name': 'clerum' },
        labels: { 'app.kubernetes.io/managed-by': 'Helm' },
        name: 'foo',
        namespace: 'mcp-host',
        resourceVersion: '10',
      })
    })

    it('preserves omitted fields by reading current values', async () => {
      const replaceMock = vi.fn().mockResolvedValue({
        metadata: { resourceVersion: '11' },
      })
      const gateway = {
        getResource: vi.fn().mockResolvedValue(existingHost('10')),
        replaceHost: replaceMock,
      }
      const app = buildApp(gateway)
      await request(app)
        .put('/api/v1/admin/hosts/foo/personalization')
        .send({ identity: 'only-id', resourceVersion: '10' })
      const replaced = replaceMock.mock.calls[0][0]
      expect(replaced.spec.personalization).toEqual({
        enabled: true,
        identity: 'only-id',
        soul: 'old-soul',
        agents: 'old-agents',
        user: 'old-user',
      })
    })

    it('defaults enabled=true when personalization was previously unset', async () => {
      const replaceMock = vi.fn().mockResolvedValue({
        metadata: { resourceVersion: '2' },
      })
      const gateway = {
        getResource: vi.fn().mockResolvedValue({
          metadata: { name: 'foo', namespace: 'mcp-host', resourceVersion: '1' },
          spec: { host: 'foo', contextRef: 'c', secretRef: 's' },
        }),
        replaceHost: replaceMock,
      }
      const app = buildApp(gateway)
      await request(app)
        .put('/api/v1/admin/hosts/foo/personalization')
        .send({ identity: 'x', resourceVersion: '1' })
      expect(replaceMock.mock.calls[0][0].spec.personalization.enabled).toBe(true)
    })

    it('preserves enabled=false when admin previously disabled it', async () => {
      const replaceMock = vi.fn().mockResolvedValue({
        metadata: { resourceVersion: '11' },
      })
      const gateway = {
        getResource: vi.fn().mockResolvedValue({
          metadata: { name: 'foo', namespace: 'mcp-host', resourceVersion: '10' },
          spec: {
            host: 'foo',
            contextRef: 'ctx',
            secretRef: 'sec',
            personalization: {
              enabled: false,
              identity: 'old-id',
              soul: 'old-soul',
              agents: 'old-agents',
              user: 'old-user',
            },
          },
        }),
        replaceHost: replaceMock,
      }
      const app = buildApp(gateway)
      await request(app)
        .put('/api/v1/admin/hosts/foo/personalization')
        .send({ identity: 'new-id', resourceVersion: '10' })
      expect(replaceMock.mock.calls[0][0].spec.personalization.enabled).toBe(false)
    })

    it('returns 400 when resourceVersion is missing', async () => {
      const gateway = {
        getResource: vi.fn().mockResolvedValue(existingHost()),
        replaceHost: vi.fn(),
      }
      const app = buildApp(gateway)
      const res = await request(app)
        .put('/api/v1/admin/hosts/foo/personalization')
        .send({ identity: 'x' })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/resourceVersion/)
    })

    it('returns 400 when the body contains unknown fields', async () => {
      const gateway = {
        getResource: vi.fn().mockResolvedValue(existingHost()),
        replaceHost: vi.fn(),
      }
      const app = buildApp(gateway)
      const res = await request(app)
        .put('/api/v1/admin/hosts/foo/personalization')
        .send({ enabled: false, identity: 'x', resourceVersion: '10' })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/unknown field/)
      expect(gateway.getResource).not.toHaveBeenCalled()
    })

    it('returns 413 when a single field exceeds 64 KiB', async () => {
      const gateway = {
        getResource: vi.fn().mockResolvedValue(existingHost()),
        replaceHost: vi.fn(),
      }
      const app = buildApp(gateway)
      const justOver = 'x'.repeat(64 * 1024 + 1)
      const res = await request(app)
        .put('/api/v1/admin/hosts/foo/personalization')
        .send({ soul: justOver, resourceVersion: '10' })
      expect(res.status).toBe(413)
      expect(res.body.error).toMatch(/soul/)
    })

    it('accepts a single field at exactly 64 KiB (boundary)', async () => {
      const replaceMock = vi.fn().mockResolvedValue({ metadata: { resourceVersion: '11' } })
      const gateway = {
        getResource: vi.fn().mockResolvedValue(existingHost()),
        replaceHost: replaceMock,
      }
      const app = buildApp(gateway)
      const res = await request(app)
        .put('/api/v1/admin/hosts/foo/personalization')
        .send({ identity: 'x'.repeat(64 * 1024), resourceVersion: '10' })
      expect(res.status).toBe(200)
    })

    it('returns 409 when resourceVersion mismatches', async () => {
      const gateway = {
        getResource: vi.fn().mockResolvedValue(existingHost('10')),
        replaceHost: vi.fn().mockRejectedValue(Object.assign(new Error('conflict'), { code: 409 })),
      }
      const app = buildApp(gateway)
      const res = await request(app)
        .put('/api/v1/admin/hosts/foo/personalization')
        .send({ identity: 'x', resourceVersion: '9' })
      expect(res.status).toBe(409)
    })

    it('returns 404 when the host does not exist', async () => {
      const gateway = {
        getResource: vi.fn().mockRejectedValue(Object.assign(new Error('nf'), { code: 404 })),
        replaceHost: vi.fn(),
      }
      const app = buildApp(gateway)
      const res = await request(app)
        .put('/api/v1/admin/hosts/missing/personalization')
        .send({ identity: 'x', resourceVersion: '1' })
      expect(res.status).toBe(404)
    })

    it('logs an audit entry on success without leaking content', async () => {
      const auditSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const gateway = {
        getResource: vi.fn().mockResolvedValue(existingHost('10')),
        replaceHost: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '11' } }),
      }
      const app = buildApp(gateway)
      await request(app)
        .put('/api/v1/admin/hosts/foo/personalization')
        .send({ identity: 'secret-content', resourceVersion: '10' })
      const auditCall = auditSpy.mock.calls.find(
        args => typeof args[0] === 'string' && args[0].includes('personalization_updated')
      )
      expect(auditCall).toBeTruthy()
      const json = String(auditCall![1] ?? '')
      expect(json).not.toContain('secret-content')
      expect(json).toContain('foo')
      expect(json).toContain('mcp-host') // namespace included for observability
      auditSpy.mockRestore()
    })
  })
})
