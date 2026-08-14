import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AppService } from '../appService.js'
import { __setChatStoreBaseDirForTests } from '../chatStoreBinding.js'

// R1-M4 (desktop-app): cover the producer-side fallback branch of Decision #6 —
// `agentDisplayByName[name]` is filled total over `agentNames`, falling back to
// the identifier whenever the wire entry carries no usable `displayName`. Two
// under-tested inputs exercise it:
//   (a) an agent with NO `displayName` field at all (pre-display API build), and
//   (b) an agent with `displayName: ''` (empty string → the `candidate &&`
//       guard treats it as absent).
// The catalog is derived from the real producer (AppService.refreshAccessCatalog,
// T1) rather than a hand-built map, so the assertion certifies the producer's own
// output, not the author's idea of it.

const ME = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'test@clerum.io',
  name: 'Test User',
  picture: null,
  teamId: '00000000-0000-4000-8000-0000000000aa',
  teamName: 'Test Team',
  role: 'member',
}

describe('AppService.refreshAccessCatalog — agentDisplayByName fallback (R1-M4)', () => {
  let chatStoreBaseDir: string

  beforeEach(async () => {
    chatStoreBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clerum-app-service-display-'))
    __setChatStoreBaseDirForTests(chatStoreBaseDir)
  })

  afterEach(async () => {
    __setChatStoreBaseDirForTests(null)
    await fs.rm(chatStoreBaseDir, { recursive: true, force: true })
  })

  it('falls back to the identifier for an agent with no displayName and for displayName: ""', async () => {
    const service = new AppService() as any
    service.sessionToken = 'session-token'
    service.me = ME
    service.rpcTokenManager = {
      getOrIssue: vi.fn().mockResolvedValue({ token: 'rpc-token' }),
      clear: vi.fn(),
    }
    service.authClient = {
      getMe: vi.fn().mockResolvedValue(ME),
      getMyContexts: vi.fn().mockResolvedValue({ contextIds: [] }),
      getMyAgents: vi.fn().mockResolvedValue({
        agentNames: ['no-display', 'empty-display', 'with-display'],
        agents: [
          // (a) pre-display build: the wire entry has no displayName field.
          { name: 'no-display', mcpServers: [] },
          // (b) displayName present but empty → treated as absent by the guard.
          { name: 'empty-display', displayName: '', mcpServers: [] },
          // Control: a real display maps through so the fallback is distinguishable.
          { name: 'with-display', displayName: 'With Display Host', mcpServers: [] },
        ],
      }),
      getTeamContexts: vi.fn().mockResolvedValue({ contextIds: [] }),
      getTeamAgents: vi.fn().mockResolvedValue({ agentNames: [], agents: [] }),
    }

    const catalog = await service.refreshAccessCatalog()

    // The map is total over agentNames — no undefined lookups.
    expect(Object.keys(catalog.agentDisplayByName).sort()).toEqual([
      'empty-display',
      'no-display',
      'with-display',
    ])
    // (a) no displayName → id.
    expect(catalog.agentDisplayByName['no-display']).toBe('no-display')
    // (b) displayName: '' → id (empty string must NOT survive as the display).
    expect(catalog.agentDisplayByName['empty-display']).toBe('empty-display')
    // Control: a genuine display is preserved.
    expect(catalog.agentDisplayByName['with-display']).toBe('With Display Host')
  })
})
