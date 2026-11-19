import { describe, expect, it } from 'vitest'
import type { WorkflowCallerContext } from '../../core/tools/workflowShared'
import type { Task } from '../../queue/types'
import type { IncomingMessage } from '../../server/types'
import {
  PERSONAL_CONNECTOR_CONVERSATION_TYPES,
  chooseConnectorPrincipal,
} from '../connectorPrincipal'

const UUID = '22222222-2222-4222-8222-222222222222'

function makeTask(message: Partial<IncomingMessage> | undefined): Task {
  return {
    id: 'task-1',
    source: 'channel',
    sourceMessage: message
      ? {
          sender: 'teams-user-1',
          content: 'hi',
          channelType: 'teams',
          channelId: 'chan-1',
          messageId: 'msg-1',
          timestamp: new Date().toISOString(),
          hostRef: 'test-host',
          ...message,
        }
      : undefined,
    priority: 'normal',
    status: 'pending',
    conversationHistory: [],
    createdAt: new Date(),
  }
}

function identity(medium: 'telegram' | 'slack' | 'teams', providerChannelType?: string | null) {
  return { medium, providerUserId: 'p-1', providerChannelId: 'c-1', providerChannelType }
}

const rpcTask = (sender: string) => makeTask({ channelType: 'rpc', sender })
const teamsTask = (type: string) =>
  makeTask({ channelType: 'teams', providerIdentity: identity('teams', type) })
const telegramTask = (type: string) =>
  makeTask({
    channelType: 'telegram',
    sender: '516801777',
    providerIdentity: identity('telegram', type),
  })
const telegramTaskWithoutIdentity = () => makeTask({ channelType: 'telegram', sender: '516801777' })
const emailTask = () => makeTask({ channelType: 'email', sender: 'a@b.c' })

describe('chooseConnectorPrincipal', () => {
  it('exposes the exact allowlist', () => {
    expect(PERSONAL_CONNECTOR_CONVERSATION_TYPES).toEqual({
      teams: 'personal',
      slack: 'im',
      telegram: 'private',
    })
  })
  it('uses sender for rpc tasks', () => {
    expect(
      chooseConnectorPrincipal(rpcTask('11111111-1111-4111-8111-111111111111'), undefined)
    ).toEqual({
      userId: '11111111-1111-4111-8111-111111111111',
    })
    expect(chooseConnectorPrincipal(rpcTask(''), undefined)).toEqual({})
  })
  it('uses the resolved user for an allowlisted 1:1 conversation', () => {
    expect(chooseConnectorPrincipal(teamsTask('personal'), { targetUserId: UUID })).toEqual({
      userId: UUID,
    })
    expect(
      chooseConnectorPrincipal(
        makeTask({ channelType: 'slack', providerIdentity: identity('slack', 'im') }),
        { targetUserId: UUID }
      )
    ).toEqual({ userId: UUID })
    expect(chooseConnectorPrincipal(telegramTask('private'), { targetUserId: UUID })).toEqual({
      userId: UUID,
    })
  })
  it('withholds with not_direct_message outside the allowlist even when resolved', () => {
    expect(chooseConnectorPrincipal(teamsTask('groupChat'), { targetUserId: UUID })).toEqual({
      denial: 'not_direct_message',
    })
    expect(chooseConnectorPrincipal(telegramTask('personal'), { targetUserId: UUID })).toEqual({
      denial: 'not_direct_message',
    })
    expect(chooseConnectorPrincipal(teamsTask('Personal'), { targetUserId: UUID })).toEqual({
      denial: 'not_direct_message',
    })
    expect(chooseConnectorPrincipal(teamsTask(' personal'), { targetUserId: UUID })).toEqual({
      denial: 'not_direct_message',
    })
    expect(
      chooseConnectorPrincipal(
        makeTask({ channelType: 'teams', providerIdentity: identity('teams', null) }),
        { targetUserId: UUID }
      )
    ).toEqual({ denial: 'not_direct_message' })
  })
  it('withholds with unverified when the allowlisted conversation did not resolve', () => {
    expect(chooseConnectorPrincipal(teamsTask('personal'), null)).toEqual({ denial: 'unverified' })
    expect(chooseConnectorPrincipal(teamsTask('personal'), undefined)).toEqual({
      denial: 'unverified',
    })
    expect(chooseConnectorPrincipal(teamsTask('personal'), { targetUserId: '' })).toEqual({
      denial: 'unverified',
    })
  })
  it('withholds for a channel task without providerIdentity (cron)', () => {
    expect(chooseConnectorPrincipal(telegramTaskWithoutIdentity(), undefined)).toEqual({
      denial: 'not_direct_message',
    })
  })
  it('gives email and missing source messages neither a principal nor a denial', () => {
    expect(chooseConnectorPrincipal(emailTask(), undefined)).toEqual({})
    expect(
      chooseConnectorPrincipal({ ...rpcTask('u'), sourceMessage: undefined }, undefined)
    ).toEqual({})
  })
  it('never returns both fields and never leaks sender into userId for channel tasks', () => {
    const contexts: Array<WorkflowCallerContext | null | undefined> = [
      undefined,
      null,
      { targetUserId: '' },
      { targetUserId: UUID },
    ]
    const tasks = [
      rpcTask('u'),
      teamsTask('personal'),
      teamsTask('groupChat'),
      telegramTask('private'),
      telegramTaskWithoutIdentity(),
      emailTask(),
    ]
    for (const t of tasks) {
      for (const c of contexts) {
        const r = chooseConnectorPrincipal(t, c)
        expect(Object.keys(r).length).toBeLessThanOrEqual(1)
        if (t.sourceMessage?.channelType !== 'rpc' && r.userId) expect(r.userId).toBe(UUID)
      }
    }
  })
})
