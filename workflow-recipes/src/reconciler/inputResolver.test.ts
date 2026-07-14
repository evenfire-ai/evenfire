import { describe, expect, it } from 'vitest'
import { extractSchemaDefaults, resolve } from './inputResolver'

describe('inputResolver.resolve', () => {
  it('should apply schema defaults when no inputs provided (2.5a)', () => {
    const schema = { properties: { replicas: { type: 'number', default: 1 } } }
    const result = resolve({}, schema)
    expect(result).toEqual({ replicas: 1 })
  })

  it('should let inputs override schema defaults (2.5b)', () => {
    const schema = { properties: { replicas: { type: 'number', default: 1 } } }
    const result = resolve({ replicas: 3 }, schema)
    expect(result).toEqual({ replicas: 3 })
  })

  it('should let profile override inputs (2.5c)', () => {
    const result = resolve({ replicas: 3 }, undefined, { prod: { replicas: 5 } }, 'prod')
    expect(result).toEqual({ replicas: 5 })
  })

  it('should follow full precedence chain: defaults << inputs << profiles (2.5d)', () => {
    const schema = {
      properties: {
        replicas: { type: 'number', default: 1 },
        port: { type: 'number', default: 8080 },
      },
    }
    const result = resolve({ replicas: 3 }, schema, { prod: { replicas: 5 } }, 'prod')
    expect(result).toEqual({ replicas: 5, port: 8080 })
  })

  it('should throw descriptive error for missing profile (2.5e)', () => {
    expect(() => resolve({}, undefined, { dev: {} }, 'staging')).toThrow('staging')
    expect(() => resolve({}, undefined, { dev: {} }, 'staging')).toThrow('Available: [dev]')
  })

  it('should handle empty inputs and no schema', () => {
    expect(resolve({})).toEqual({})
  })

  it('should handle undefined schema gracefully', () => {
    expect(resolve({ key: 'value' }, undefined)).toEqual({ key: 'value' })
  })

  it('should handle schema with no properties', () => {
    expect(resolve({}, { type: 'object' })).toEqual({})
  })

  it('should not apply profile when activeProfile is undefined', () => {
    const result = resolve({ x: 1 }, undefined, { prod: { x: 10 } }, undefined)
    expect(result).toEqual({ x: 1 })
  })

  it('should not apply profile when profiles is undefined', () => {
    const result = resolve({ x: 1 }, undefined, undefined, 'prod')
    expect(result).toEqual({ x: 1 })
  })

  it('should merge multiple keys from different layers', () => {
    const schema = { properties: { a: { default: 1 }, b: { default: 2 } } }
    const result = resolve({ c: 3 }, schema, { prod: { d: 4 } }, 'prod')
    expect(result).toEqual({ a: 1, b: 2, c: 3, d: 4 })
  })

  it('should handle null values in inputs', () => {
    const schema = { properties: { x: { default: 'default' } } }
    const result = resolve({ x: null }, schema)
    expect(result.x).toBeNull()
  })

  it('should handle array values', () => {
    const result = resolve({ tags: ['a', 'b'] })
    expect(result.tags).toEqual(['a', 'b'])
  })

  it('should handle nested objects in inputs', () => {
    const result = resolve({ config: { nested: true } })
    expect(result.config).toEqual({ nested: true })
  })

  it('should apply computed values as highest priority (2.5r)', () => {
    const schema = { properties: { replicas: { type: 'number', default: 1 } } }
    const result = resolve({ replicas: 3 }, schema, { prod: { replicas: 5 } }, 'prod', {
      replicas: 10,
    })
    expect(result).toEqual({ replicas: 10 })
  })

  it('should merge computed values with other layers', () => {
    const result = resolve({ a: 1 }, undefined, undefined, undefined, { b: 2 })
    expect(result).toEqual({ a: 1, b: 2 })
  })

  it('should handle multiple schema defaults', () => {
    const schema = {
      properties: {
        replicas: { default: 1 },
        memory: { default: '256Mi' },
        cpu: { default: '100m' },
        port: { type: 'number' }, // no default
      },
    }
    const defaults = extractSchemaDefaults(schema)
    expect(defaults).toEqual({ replicas: 1, memory: '256Mi', cpu: '100m' })
    expect(defaults).not.toHaveProperty('port')
  })
})

describe('inputResolver.extractSchemaDefaults', () => {
  it('should extract defaults from JSON Schema properties (2.5p)', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string', default: 'redis' },
        port: { type: 'number', default: 6379 },
        debug: { type: 'boolean' },
      },
    }
    const defaults = extractSchemaDefaults(schema)
    expect(defaults).toEqual({ name: 'redis', port: 6379 })
    expect(defaults).not.toHaveProperty('debug')
  })

  it('should return empty object for undefined schema', () => {
    expect(extractSchemaDefaults(undefined)).toEqual({})
  })

  it('should return empty object for schema without properties', () => {
    expect(extractSchemaDefaults({ type: 'object' })).toEqual({})
  })
})
