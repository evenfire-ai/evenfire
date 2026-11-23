import { describe, expect, it } from 'vitest'
import type { NativeToolConfig } from '../../../interfaces'
import { NativeToolRegistry, knownNativeToolNames } from '../../nativeToolRegistry'
import { GIT_READ_DEFINITION } from '../definition'

const base: NativeToolConfig = {
  workspacePath: '/tmp',
  shellTimeout: 5000,
  toolTimeout: 60000,
  toolProgressInterval: 30000,
  httpAllowlist: [],
  envAllowlist: ['PATH'],
  memoryMaxSize: 1048576,
}
const available = {
  available: true as const,
  gitPath: '/usr/bin/git',
  version: [2, 39, 5] as const,
}

function names(config: NativeToolConfig): string[] {
  return new NativeToolRegistry(config, 'conv').listDefinitions().map(d => d.name)
}

describe('git_read registration', () => {
  it('registers git_read only when the probe found git', () => {
    expect(names(base)).not.toContain('git_read')
    expect(names({ ...base, gitRead: { available: false, reason: 'absent' } })).not.toContain(
      'git_read'
    )
    expect(names({ ...base, gitRead: available })).toContain('git_read')
  })

  it('registers the definition as designed', () => {
    const registry = new NativeToolRegistry({ ...base, gitRead: available }, 'conv')
    const tool = registry.get('git_read')!
    expect(tool.description()).toBe(GIT_READ_DEFINITION.description)
    expect(tool.parametersSchema()).toEqual(GIT_READ_DEFINITION.parameters)
    expect(tool.requiresApproval()).toBe(true)
    expect(tool.requiresSanitization()).toBe(true)
  })

  it('a GFS caller root binds git_read to the caller root, re-verified on every call', () => {
    const registry = new NativeToolRegistry(
      { ...base, gitRead: available },
      'conv',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { deliveryAvailable: true, callerIdentity: 'caller', callerWorkspacePath: '/srv/users/a' }
    )
    const tool = registry.get('git_read') as unknown as {
      options: { root: string; verifyCallerRoot: boolean }
    }
    expect(tool.options.root).toBe('/srv/users/a')
    expect(tool.options.verifyCallerRoot).toBe(true)
  })

  it('approval configs may name git_read whether or not this config registers it', () => {
    expect(knownNativeToolNames(base)).toContain('git_read')
    expect(knownNativeToolNames(base)).toContain('shell_exec')
  })
})
