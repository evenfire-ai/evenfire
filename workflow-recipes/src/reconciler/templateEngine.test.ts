import { describe, expect, it } from 'vitest'
import {
  type TemplateContext,
  TemplateInjectionError,
  UnresolvedTemplateError,
  resolve,
} from './templateEngine'

function makeContext(overrides: Partial<TemplateContext> = {}): TemplateContext {
  return {
    inputs: { name: 'redis', port: 6379, host: 'localhost' },
    workloads: new Map([
      ['db', { host: 'db.mcp-server.svc.cluster.local', port: '5432' }],
      ['cache', { host: 'cache.mcp-server.svc.cluster.local', port: '6379' }],
    ]),
    resources: new Map<string, Record<string, string>>([
      ['db-secret', { password: 's3cret', username: 'admin' }],
      ['app-config', { LOG_LEVEL: 'info' }],
    ]),
    computed: { db_url: 'postgres://db:5432/app', replica_count: '3' },
    ...overrides,
  }
}

describe('templateEngine.resolve', () => {
  // ─── Basic Syntax (2.6a-e) ─────────────────────────────────────────

  it('should resolve inputs.name (2.6a)', () => {
    expect(resolve('{{inputs.name}}', makeContext())).toBe('redis')
  })

  it('should resolve workload-id:host (2.6b)', () => {
    expect(resolve('{{db:host}}', makeContext())).toBe('db.mcp-server.svc.cluster.local')
  })

  it('should resolve workload-id:port (2.6c)', () => {
    expect(resolve('{{db:port}}', makeContext())).toBe('5432')
  })

  it('should resolve resource-id:KEY (2.6d)', () => {
    expect(resolve('{{db-secret:password}}', makeContext())).toBe('s3cret')
  })

  it('should resolve computed.name (2.6e)', () => {
    expect(resolve('{{computed.db_url}}', makeContext())).toBe('postgres://db:5432/app')
  })

  // ─── Error Handling (2.6f) ─────────────────────────────────────────

  it('should throw UnresolvedTemplateError for missing ref (2.6f)', () => {
    expect(() => resolve('{{inputs.missing}}', makeContext())).toThrow(UnresolvedTemplateError)
  })

  it('should throw UnresolvedTemplateError for unknown workload', () => {
    expect(() => resolve('{{unknown:host}}', makeContext())).toThrow(UnresolvedTemplateError)
  })

  it('should throw UnresolvedTemplateError for unknown resource key', () => {
    expect(() => resolve('{{db-secret:nonexistent}}', makeContext())).toThrow(
      UnresolvedTemplateError
    )
  })

  it('should throw UnresolvedTemplateError for inherited resource keys', () => {
    expect(() => resolve('{{app-config:toString}}', makeContext())).toThrow(UnresolvedTemplateError)
  })

  // ─── Injection Prevention (2.6g-h) ─────────────────────────────────

  it('should block __proto__ injection (2.6g)', () => {
    expect(() => resolve('{{inputs.__proto__}}', makeContext())).toThrow(TemplateInjectionError)
  })

  it('should block constructor injection (2.6h)', () => {
    expect(() => resolve('{{inputs.constructor}}', makeContext())).toThrow(TemplateInjectionError)
  })

  it('should block prototype injection', () => {
    expect(() => resolve('{{inputs.prototype}}', makeContext())).toThrow(TemplateInjectionError)
  })

  it('should block __defineGetter__ injection', () => {
    expect(() => resolve('{{inputs.__defineGetter__}}', makeContext())).toThrow(
      TemplateInjectionError
    )
  })

  it('should block colon-separated injection', () => {
    expect(() => resolve('{{__proto__:host}}', makeContext())).toThrow(TemplateInjectionError)
  })

  // ─── Complex Patterns (2.6i-r) ─────────────────────────────────────

  it('should resolve multiple refs in one string', () => {
    const result = resolve('postgres://{{db:host}}:{{db:port}}/app', makeContext())
    expect(result).toBe('postgres://db.mcp-server.svc.cluster.local:5432/app')
  })

  it('should handle string with no templates', () => {
    expect(resolve('plain text', makeContext())).toBe('plain text')
  })

  it('should handle empty string', () => {
    expect(resolve('', makeContext())).toBe('')
  })

  it('should resolve numeric input values as strings', () => {
    expect(resolve('port={{inputs.port}}', makeContext())).toBe('port=6379')
  })

  it('should resolve whitespace-padded refs', () => {
    expect(resolve('{{ inputs.name }}', makeContext())).toBe('redis')
  })

  it('should resolve mixed inputs, workloads, and resources in one string', () => {
    const result = resolve(
      '{{inputs.name}} at {{cache:host}}:{{cache:port}} with {{app-config:LOG_LEVEL}}',
      makeContext()
    )
    expect(result).toBe('redis at cache.mcp-server.svc.cluster.local:6379 with info')
  })

  it('should resolve resource with multiple keys', () => {
    const result = resolve('{{db-secret:username}}:{{db-secret:password}}', makeContext())
    expect(result).toBe('admin:s3cret')
  })

  it('should handle context with no inputs', () => {
    expect(() => resolve('{{inputs.name}}', { inputs: undefined })).toThrow(UnresolvedTemplateError)
  })
})
