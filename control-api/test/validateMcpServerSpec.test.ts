import { describe, expect, it, vi } from 'vitest'
import {
  validateMcpServerSpec,
  validateMcpServerSpecPreflight,
} from '../src/http/validateMcpServerSpec.js'

describe('validateMcpServerSpec', () => {
  it('returns empty array for a valid minimal spec', () => {
    const errors = validateMcpServerSpec({
      image: 'my-server:latest',
      transport: { type: 'streamableHttp' },
    })
    expect(errors).toEqual([])
  })

  describe('egressBindings', () => {
    it('accepts exact-host and public-web egress bindings', () => {
      const errors = validateMcpServerSpec({
        egressBindings: [
          { dns: 'api.example.com', port: 443, protocol: 'TCP' },
          { egressClass: 'public-web' },
        ],
      })

      expect(errors).toEqual([])
    })

    // ── issue #299 Phase 2 — provider mode admission (G-E parity matrix) ──
    describe('provider mode (G-E parity)', () => {
      const check = (binding: unknown) => validateMcpServerSpec({ egressBindings: [binding] })

      it('accepts a provider binding (categories from registry)', () => {
        expect(
          check({
            egressClass: 'provider',
            dns: 'api.github.com',
            port: 443,
            provider: { name: 'github' },
          })
        ).toEqual([])
      })
      it('accepts a provider binding with explicit categories', () => {
        expect(
          check({
            egressClass: 'provider',
            dns: 'api.github.com',
            port: 443,
            provider: { name: 'github', categories: ['api'] },
          })
        ).toEqual([])
      })
      it('accepts an unknown provider name (open string, catalog-checked at reconcile)', () => {
        expect(
          check({
            egressClass: 'provider',
            dns: 'api.example.com',
            port: 443,
            provider: { name: 'newco' },
          })
        ).toEqual([])
      })
      it('rejects a provider binding with no provider object', () => {
        expect(check({ egressClass: 'provider', dns: 'api.github.com', port: 443 })).toContainEqual(
          expect.objectContaining({ field: 'spec.egressBindings[0].provider' })
        )
      })
      it('rejects a provider binding with no dns', () => {
        expect(
          check({ egressClass: 'provider', port: 443, provider: { name: 'github' } })
        ).toContainEqual(expect.objectContaining({ field: 'spec.egressBindings[0].dns' }))
      })
      it('rejects a provider binding that declares cidr', () => {
        expect(
          check({
            egressClass: 'provider',
            dns: 'api.github.com',
            cidr: '1.2.3.0/24',
            port: 443,
            provider: { name: 'github' },
          })
        ).toContainEqual(expect.objectContaining({ field: 'spec.egressBindings[0].cidr' }))
      })
      it('rejects a provider object on a non-provider binding', () => {
        expect(
          check({
            egressClass: 'exact-host',
            dns: 'api.github.com',
            port: 443,
            provider: { name: 'github' },
          })
        ).toContainEqual(
          expect.objectContaining({
            field: 'spec.egressBindings[0].provider',
            message: expect.stringContaining('egressClass'),
          })
        )
      })
      it('rejects an unknown egressClass', () => {
        expect(check({ egressClass: 'weird' })).toContainEqual(
          expect.objectContaining({ field: 'spec.egressBindings[0].egressClass' })
        )
      })
      it('rejects an uppercase provider name (pattern)', () => {
        expect(
          check({
            egressClass: 'provider',
            dns: 'api.github.com',
            port: 443,
            provider: { name: 'GitHub' },
          })
        ).toContainEqual(expect.objectContaining({ field: 'spec.egressBindings[0].provider.name' }))
      })
      it('rejects two bindings sharing the same (dns, port) — H4', () => {
        const errors = validateMcpServerSpec({
          egressBindings: [
            { dns: 'api.github.com', port: 443 },
            {
              egressClass: 'provider',
              dns: 'api.github.com',
              port: 443,
              provider: { name: 'github' },
            },
          ],
        })
        expect(errors).toContainEqual(
          expect.objectContaining({ message: expect.stringContaining('duplicate (dns, port)') })
        )
      })
    })

    it('rejects more than 20 egress bindings before Kubernetes', () => {
      const errors = validateMcpServerSpec({
        egressBindings: Array.from({ length: 21 }, (_, index) => ({
          dns: `api-${index}.example.com`,
          port: 443,
          protocol: 'TCP',
        })),
      })

      expect(errors).toContainEqual(
        expect.objectContaining({
          field: 'spec.egressBindings',
          message: expect.stringContaining('at most 20'),
        })
      )
    })

    it('rejects public-web bindings that smuggle exact-host fields', () => {
      const errors = validateMcpServerSpec({
        egressBindings: [{ egressClass: 'public-web', dns: 'api.example.com', port: 443 }],
      })

      expect(errors).toContainEqual(
        expect.objectContaining({
          field: 'spec.egressBindings[0]',
          message: expect.stringContaining('must not declare dns'),
        })
      )
    })

    it('rejects remote MCP specs without egress bindings before Kubernetes', () => {
      const missing = validateMcpServerSpec({
        remote: { baseUrl: 'https://api.vendor.example/mcp' },
      })
      const empty = validateMcpServerSpec({
        remote: { baseUrl: 'https://api.vendor.example/mcp' },
        egressBindings: [],
      })

      expect(missing).toContainEqual({
        field: 'spec.egressBindings',
        message: 'remote MCP servers must declare at least one egressBinding',
      })
      expect(empty).toContainEqual({
        field: 'spec.egressBindings',
        message: 'remote MCP servers must declare at least one egressBinding',
      })
    })

    it('rejects exact-host dns values that target internal or metadata hostnames', () => {
      const errors = validateMcpServerSpec({
        egressBindings: [
          { dns: 'metadata.goog', port: 443 },
          { dns: 'api.internal', port: 443 },
          { dns: 'kubernetes.default.svc', port: 443 },
        ],
      })

      expect(errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'spec.egressBindings[0].dns' }),
          expect.objectContaining({ field: 'spec.egressBindings[1].dns' }),
          expect.objectContaining({ field: 'spec.egressBindings[2].dns' }),
        ])
      )
    })

    it('preflights cidr bindings against the public IPv4 allow rules', () => {
      const valid = validateMcpServerSpec({
        egressBindings: [{ cidr: '8.8.8.8/32', port: 443 }],
      })
      expect(valid).toEqual([])

      const invalid = validateMcpServerSpec({
        egressBindings: [
          { cidr: '10.0.0.0/8', port: 443 },
          { cidr: '203.0.113.1/32', port: 443 },
          { cidr: '2001:db8::/32', port: 443 },
          { cidr: '8.8.8.1/24', port: 443 },
        ],
      })

      expect(invalid).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'spec.egressBindings[0].cidr' }),
          expect.objectContaining({ field: 'spec.egressBindings[1].cidr' }),
          expect.objectContaining({ field: 'spec.egressBindings[2].cidr' }),
          expect.objectContaining({ field: 'spec.egressBindings[3].cidr' }),
        ])
      )
    })

    it('preflight resolves each exact-host DNS name once and accepts public IPv4 answers', async () => {
      const resolveDns = vi.fn(async () => ['93.184.216.34'])
      const errors = await validateMcpServerSpecPreflight(
        {
          egressBindings: [
            { dns: 'api.example.com', port: 443 },
            { dns: 'api.example.com', port: 80 },
          ],
        },
        { resolveDns }
      )

      expect(errors).toEqual([])
      expect(resolveDns).toHaveBeenCalledTimes(1)
      expect(resolveDns).toHaveBeenCalledWith('api.example.com')
    })

    it('preflight rejects unresolved and blocked or mixed exact-host DNS answers', async () => {
      const resolveDns = vi.fn(async (hostname: string) => {
        if (hostname === 'unresolved.example.com') return []
        if (hostname === 'metadata.example.com') return ['169.254.169.254']
        return ['93.184.216.34', '10.0.0.5']
      })

      const errors = await validateMcpServerSpecPreflight(
        {
          egressBindings: [
            { dns: 'unresolved.example.com', port: 443 },
            { dns: 'metadata.example.com', port: 443 },
            { dns: 'mixed.example.com', port: 443 },
            { egressClass: 'public-web' },
          ],
        },
        { resolveDns }
      )

      expect(errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'spec.egressBindings[0].dns',
            message: expect.stringContaining('did not resolve'),
          }),
          expect.objectContaining({
            field: 'spec.egressBindings[1].dns',
            message: expect.stringContaining('169.254.169.254'),
          }),
          expect.objectContaining({
            field: 'spec.egressBindings[2].dns',
            message: expect.stringContaining('10.0.0.5'),
          }),
        ])
      )
      expect(resolveDns).not.toHaveBeenCalledWith(expect.stringContaining('public-web'))
    })
  })

  it('returns empty array for an empty spec', () => {
    const errors = validateMcpServerSpec({})
    expect(errors).toEqual([])
  })

  // ── imagePullPolicy: platform-controlled ─────────────────────────────────────

  describe('imagePullPolicy', () => {
    it('rejects imagePullPolicy when set', () => {
      const errors = validateMcpServerSpec({ imagePullPolicy: 'Always' })
      expect(errors).toHaveLength(1)
      expect(errors[0].field).toBe('spec.imagePullPolicy')
      expect(errors[0].message).toContain('platform-controlled')
    })

    it('rejects imagePullPolicy even with valid value', () => {
      const errors = validateMcpServerSpec({ imagePullPolicy: 'IfNotPresent' })
      expect(errors).toHaveLength(1)
    })
  })

  // ── Security: runAsUser ─────────────────────────────────────────────────────

  describe('security.runAsUser', () => {
    it('allows runAsUser >= 1', () => {
      const errors = validateMcpServerSpec({ security: { runAsUser: 1000 } })
      expect(errors).toEqual([])
    })

    it('rejects runAsUser = 0 (root)', () => {
      const errors = validateMcpServerSpec({ security: { runAsUser: 0 } })
      expect(errors).toHaveLength(1)
      expect(errors[0].field).toBe('spec.security.runAsUser')
      expect(errors[0].message).toContain('must be >= 1')
    })

    it('rejects negative runAsUser', () => {
      const errors = validateMcpServerSpec({ security: { runAsUser: -1 } })
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toContain('-1')
    })
  })

  // ── Security: Linux capabilities ────────────────────────────────────────────

  describe('security.addCapabilities', () => {
    it('allows safe capabilities', () => {
      const errors = validateMcpServerSpec({
        security: {
          addCapabilities: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE', 'NET_BIND_SERVICE'],
        },
      })
      expect(errors).toEqual([])
    })

    it('rejects privilege-boundary capabilities', () => {
      const deniedCapabilities = ['SETUID', 'SETGID', 'SYS_CHROOT', 'KILL', 'AUDIT_WRITE']
      const errors = validateMcpServerSpec({
        security: { addCapabilities: deniedCapabilities },
      })
      expect(errors).toHaveLength(1)
      deniedCapabilities.forEach(cap => {
        expect(errors[0].message).toContain(cap)
      })
    })

    it('rejects SYS_ADMIN', () => {
      const errors = validateMcpServerSpec({ security: { addCapabilities: ['SYS_ADMIN'] } })
      expect(errors).toHaveLength(1)
      expect(errors[0].field).toBe('spec.security.addCapabilities')
      expect(errors[0].message).toContain('SYS_ADMIN')
    })

    it('rejects multiple capabilities outside the default-allowed set at once', () => {
      const errors = validateMcpServerSpec({
        security: { addCapabilities: ['SYS_ADMIN', 'NET_ADMIN', 'SYS_PTRACE'] },
      })
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toContain('SYS_ADMIN')
      expect(errors[0].message).toContain('NET_ADMIN')
      expect(errors[0].message).toContain('SYS_PTRACE')
    })

    it('performs case-insensitive capability check', () => {
      const errors = validateMcpServerSpec({ security: { addCapabilities: ['sys_admin'] } })
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toContain('sys_admin')
    })

    it('rejects unknown capabilities instead of relying only on a forbidden list', () => {
      const errors = validateMcpServerSpec({ security: { addCapabilities: ['SYS_NICE'] } })
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toContain('SYS_NICE')
    })
  })

  // ── Environment variables ───────────────────────────────────────────────────

  describe('env vars', () => {
    it('allows safe env vars', () => {
      const errors = validateMcpServerSpec({
        env: [
          { name: 'MY_API_KEY', value: 'secret' },
          { name: 'NODE_ENV', value: 'production' },
        ],
      })
      expect(errors).toEqual([])
    })

    it('rejects LD_PRELOAD', () => {
      const errors = validateMcpServerSpec({ env: [{ name: 'LD_PRELOAD', value: '/evil.so' }] })
      expect(errors).toHaveLength(1)
      expect(errors[0].field).toBe('spec.env')
      expect(errors[0].message).toContain('LD_PRELOAD')
    })

    it('rejects KUBECONFIG', () => {
      const errors = validateMcpServerSpec({
        env: [{ name: 'KUBECONFIG', value: '/etc/kubernetes/admin.conf' }],
      })
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toContain('KUBECONFIG')
    })

    it('rejects multiple dangerous env vars at once', () => {
      const errors = validateMcpServerSpec({
        env: [
          { name: 'PATH', value: '/evil' },
          { name: 'LD_LIBRARY_PATH', value: '/evil' },
        ],
      })
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toContain('PATH')
      expect(errors[0].message).toContain('LD_LIBRARY_PATH')
    })

    it('performs case-insensitive env var check', () => {
      const errors = validateMcpServerSpec({ env: [{ name: 'path', value: '/evil' }] })
      expect(errors).toHaveLength(1)
    })
  })

  // ── Resource limits ─────────────────────────────────────────────────────────

  describe('resource limits', () => {
    it('allows CPU within limits', () => {
      const errors = validateMcpServerSpec({ resources: { limits: { cpu: '2000m' } } })
      expect(errors).toEqual([])
    })

    it('rejects CPU exceeding 4000m', () => {
      const errors = validateMcpServerSpec({ resources: { limits: { cpu: '8000m' } } })
      expect(errors).toHaveLength(1)
      expect(errors[0].field).toBe('spec.resources.limits.cpu')
      expect(errors[0].message).toContain('8000m')
    })

    it('rejects CPU exceeding limit in cores (8 = 8000m)', () => {
      const errors = validateMcpServerSpec({ resources: { limits: { cpu: '8' } } })
      expect(errors).toHaveLength(1)
    })

    it('allows memory within limits', () => {
      const errors = validateMcpServerSpec({ resources: { limits: { memory: '4Gi' } } })
      expect(errors).toEqual([])
    })

    it('rejects memory exceeding 8Gi', () => {
      const errors = validateMcpServerSpec({ resources: { limits: { memory: '16Gi' } } })
      expect(errors).toHaveLength(1)
      expect(errors[0].field).toBe('spec.resources.limits.memory')
      expect(errors[0].message).toContain('16Gi')
    })

    it('handles memory in Mi notation', () => {
      const errors = validateMcpServerSpec({ resources: { limits: { memory: '4096Mi' } } })
      expect(errors).toEqual([])
    })

    it('rejects memory in Mi exceeding limit', () => {
      const errors = validateMcpServerSpec({ resources: { limits: { memory: '16384Mi' } } })
      expect(errors).toHaveLength(1)
    })
  })

  // ── Multiple errors at once ─────────────────────────────────────────────────

  it('collects multiple errors from different fields', () => {
    const errors = validateMcpServerSpec({
      imagePullPolicy: 'Always',
      security: { runAsUser: 0, addCapabilities: ['SYS_ADMIN'] },
      env: [{ name: 'KUBECONFIG', value: '/evil' }],
      resources: { limits: { cpu: '8000m', memory: '16Gi' } },
    })
    // imagePullPolicy + runAsUser + addCapabilities + env + cpu + memory = 6 errors
    expect(errors.length).toBeGreaterThanOrEqual(5)
    const fields = errors.map(e => e.field)
    expect(fields).toContain('spec.imagePullPolicy')
    expect(fields).toContain('spec.security.runAsUser')
    expect(fields).toContain('spec.security.addCapabilities')
    expect(fields).toContain('spec.env')
  })
})

describe('plugin image allowlist pre-check (2.3)', () => {
  const opts = {
    allowedImagePrefixes: ['registry.evenfire.ai/', 'clerum/'],
    enforceImageAllowlist: true,
  }

  it('enforce: local disallowed image → spec.image error', () => {
    const errors = validateMcpServerSpec({ image: 'docker.io/evil/x:1' }, opts)
    expect(errors.some(e => e.field === 'spec.image')).toBe(true)
  })
  it('enforce: local allowed image → no image error', () => {
    const errors = validateMcpServerSpec({ image: 'registry.evenfire.ai/a/x:1' }, opts)
    expect(errors.some(e => e.field === 'spec.image')).toBe(false)
  })
  it('audit (enforce off): disallowed image → no image error', () => {
    const errors = validateMcpServerSpec(
      { image: 'docker.io/evil/x:1' },
      { allowedImagePrefixes: ['registry.evenfire.ai/'], enforceImageAllowlist: false }
    )
    expect(errors.some(e => e.field === 'spec.image')).toBe(false)
  })
  it('enforce: remote-mode spec is exempt even with a disallowed image', () => {
    const errors = validateMcpServerSpec(
      {
        image: 'docker.io/evil/x:1',
        remote: { baseUrl: 'https://x.example.com/mcp' },
        egressBindings: [{ dns: 'x.example.com', port: 443, protocol: 'TCP' }],
      },
      opts
    )
    expect(errors.some(e => e.field === 'spec.image')).toBe(false)
  })
  it('enforce: missing image → no image-allowlist error (no-op)', () => {
    const errors = validateMcpServerSpec({ egressBindings: [] }, opts)
    expect(errors.some(e => e.field === 'spec.image')).toBe(false)
  })
})
