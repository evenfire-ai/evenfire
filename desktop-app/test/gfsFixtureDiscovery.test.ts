import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  discoverManagedGfsAgent,
  discoverManagedGfsAgents,
} from './e2e-playwright/helpers/gfsFixtures'

const execFileSyncMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}))

describe('discoverManagedGfsAgents', () => {
  const context = 'clerum-codex-gfs-fixture-test'
  let secretRows: string

  beforeEach(() => {
    process.env.E2E_K8S_CONTEXT = context
    secretRows =
      'host:1st:mcp-host/agent-a\tuid-a\t1\n' +
      'host:1st:mcp-host/agent-b\tuid-b\t2\n' +
      'host:1st:mcp-host/incomplete\t\t\n'
    execFileSyncMock.mockImplementation((_command: string, args: string[]) => {
      const resourceIndex = args.indexOf('get') + 1
      const resource = args[resourceIndex]
      if (resource === 'secrets') {
        return secretRows
      }
      if (resource === 'hosts' && args[resourceIndex + 1] === 'agent-a') {
        return 'uid-a\t1\t\t'
      }
      if (resource === 'hosts' && args[resourceIndex + 1] === 'agent-b') {
        return 'uid-b\t2\t\t'
      }
      throw new Error(`unexpected kubectl call: ${args.join(' ')}`)
    })
  })

  afterEach(() => {
    delete process.env.E2E_K8S_CONTEXT
    execFileSyncMock.mockReset()
  })

  it('reads only annotated Secret metadata and returns two active exact-subject hosts', () => {
    expect(discoverManagedGfsAgents()).toEqual([
      { name: 'agent-a', namespace: 'mcp-host', subjectId: '1st:mcp-host/agent-a' },
      { name: 'agent-b', namespace: 'mcp-host', subjectId: '1st:mcp-host/agent-b' },
    ])

    const calls = execFileSyncMock.mock.calls
    expect(calls).toHaveLength(3)
    for (const [command, args] of calls) {
      expect(command).toBe('kubectl')
      expect(args.slice(0, 2)).toEqual(['--context', context])
    }

    const secretArgs = calls[0]![1] as string[]
    const outputArg = secretArgs.find(value => value.startsWith('go-template='))
    expect(outputArg).toContain('{{with .metadata.annotations}}')
    expect(outputArg).toContain('clerum.io/gfs-token-expected-subject')
    expect(secretArgs).not.toContain('json')
  })

  it('keeps the single-agent read regression independent from the two-agent Copy gate', () => {
    secretRows = 'host:1st:mcp-host/agent-a\tuid-a\t1\n'

    expect(discoverManagedGfsAgent()).toEqual({
      name: 'agent-a',
      namespace: 'mcp-host',
      subjectId: '1st:mcp-host/agent-a',
    })
  })
})
