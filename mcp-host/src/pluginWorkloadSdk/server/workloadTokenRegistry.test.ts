import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadWorkloadTokenRegistryFromDir,
  loadWorkloadTokenRegistryFromPair,
} from './workloadTokenRegistry.js'

describe('loadWorkloadTokenRegistryFromPair', () => {
  it('binds a trimmed token to the caller ref', () => {
    const registry = loadWorkloadTokenRegistryFromPair('  secret-token  ', 'api')
    expect(registry.get('secret-token')).toBe('api')
  })
})

describe('loadWorkloadTokenRegistryFromDir', () => {
  it('returns an empty registry for a missing directory', () => {
    expect(loadWorkloadTokenRegistryFromDir('/does/not/exist')).toEqual(new Map())
  })

  it('keeps the first caller when two files contain the same token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pwsdk-tokens-'))
    writeFileSync(join(dir, 'caller-api'), 'shared-token\n')
    writeFileSync(join(dir, 'caller-worker'), 'shared-token\n')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const registry = loadWorkloadTokenRegistryFromDir(dir)
    expect(registry.size).toBe(1)
    expect(registry.get('shared-token')).toBe('api')
    expect(errorSpy).toHaveBeenCalledOnce()
    errorSpy.mockRestore()
  })
})
