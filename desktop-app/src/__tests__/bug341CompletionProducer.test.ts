import { expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { AppService } from '../appService'
import type { TaskProgressStreamEvent } from '../types'

const completedFixture = JSON.parse(
  readFileSync(
    new URL(
      '../../ui/src/hooks/domain/__tests__/__fixtures__/bug341TaskProgressCompleted.json',
      import.meta.url
    ),
    'utf8'
  )
)

it('captures an actual native completion event from AppService', async () => {
  // Same setup seam as appService.progress.test.ts. The upstream transport
  // supplies done; only AppService decides what the renderer receives.
  const service = new AppService() as any
  service.sessionToken = 'fixture-session-token'
  service.me = { id: 7, teamId: 'team-1' }
  service.rpcTokenManager = {
    getOrIssue: vi
      .fn()
      .mockResolvedValue({ token: 'fixture-rpc-token', scopes: ['host:activity:read'] }),
    clear: vi.fn(),
  }
  service.rpcClient = {
    openTaskProgressStream: async (
      _token: string,
      _host: string,
      taskId: string,
      onEvent: (input: unknown) => void
    ) => {
      onEvent({ event: 'waiting', data: { taskId } })
      onEvent({ event: 'open', data: { taskId, hostRef: 'agent-x' } })
      onEvent({ event: 'done', data: { taskId } })
    },
  }
  const events: TaskProgressStreamEvent[] = []
  const closed = new Promise<void>(resolve => {
    service.startTaskProgressStream(
      'fixture-stream',
      7,
      'agent-x',
      'fixture-completion',
      ['agent-x'],
      (event: TaskProgressStreamEvent) => {
        events.push(event)
        if (event.type === 'closed') resolve()
      }
    )
  })
  try {
    await closed
    expect(events.map(event => event.type)).toEqual(['waiting', 'open', 'terminal', 'closed'])
    expect(events[2]).toEqual(completedFixture)
    const outputPath = process.env.BUG341_COMPLETION_OUTPUT ?? process.env.BUG341_TERMINAL_OUTPUT
    if (outputPath) writeFileSync(outputPath, JSON.stringify(events[2]))
  } finally {
    service.stopTaskProgressStream('fixture-stream')
  }
}, 3000)
