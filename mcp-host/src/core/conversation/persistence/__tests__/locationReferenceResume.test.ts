/**
 * A folder reference survives a cold restart while its turn waits for an
 * approval. "Pod A" persists the approval through the real store, the worker
 * stops, and "Pod B" rehydrates it from the same SQLite file and approves, so
 * nothing from Pod A's memory reaches the resumed turn.
 *
 * - Without a saved context (the fallback branch) the turn re-runs and the
 *   turn-context block is rebuilt from the persisted source message.
 * - With a saved context (every production producer) the frozen messages are
 *   sent as they are, block included.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildGfsLocationReference } from '@clerum/gfs-interaction-policy'
import views from '../../../../agent/__tests__/fixtures/gfsc-resolve-views.json'
import {
  referencedFoldersForTurnContext,
  resolveMessageReferences,
} from '../../../../agent/fileReferenceResolver'
import { sourceMessageForResume } from '../../../../agent/sourceMessageForResume'
import { AgentStateMachine } from '../../../../agent/stateMachine'
import { config as appConfig } from '../../../../config'
import { TaskLifecycle } from '../../../../lifecycle/taskLifecycle'
import { MessageQueue } from '../../../../queue/messageQueue'
import type { IncomingMessage } from '../../../../server'
import { buildTurnContextBlock } from '../../../orchestration/turnContext'
import { type ChatMessage, FinishReason } from '../../../types'
import { ConversationManager } from '../../conversation'
import { SqliteColdStartLoader } from '../sqliteColdStartLoader'
import { makeSqliteStore } from './testHelpers'

const RID = '00000000000000000000000000000001'
const USER = '66666666-6666-4666-8666-666666666666'
const SESSION_KEY = `${USER}:rpc:agent:default`
const CONTENT = 'create the report in this folder'
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 }

async function admittedMessage(): Promise<IncomingMessage> {
  const built = buildGfsLocationReference({
    drive: 'main',
    resourceId: RID,
    gfsUri: `gfs://main/${RID}`,
    name: 'Folder-1',
  })
  if (!built.ok) throw new Error(built.message)
  const resolved = await resolveMessageReferences([], [built.value], {
    resolve: async () => views.directory['1'],
  })
  if (!resolved.ok) throw new Error(`fixture resolution failed: ${resolved.failure}`)
  return {
    content: CONTENT,
    channelType: 'rpc',
    channelId: 'agent',
    sender: USER,
    timestamp: new Date().toISOString(),
    messageId: 'msg-folder-resume',
    hostRef: 'chatllm',
    locationReferences: [built.value],
    locationReferenceResolutions: resolved.locationResolutions,
  }
}

const folderLine = (referenceId: string) =>
  `referenced_folder: id="${referenceId}" name="Folder-1" source=gfs drive="main" resourceId="${RID}" availability=available`

function lastUserText(messages: ChatMessage[]): string {
  return [...messages].reverse().find(m => m.role === 'user')?.content ?? ''
}

describe('folder reference across a cold restart', () => {
  let dbPath: string
  const saved = {
    promptCacheEnabled: appConfig.promptCacheEnabled,
    dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
  }

  beforeEach(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-folder-resume-')), 'state.db')
    Object.assign(appConfig, { promptCacheEnabled: false, dynamicToolsEnabled: false })
  })

  afterEach(() => {
    Object.assign(appConfig, saved)
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  })

  async function suspendOnPodA(message: IncomingMessage, contextSnapshot: ChatMessage[]) {
    const podA = makeSqliteStore({ dbPath, cacheSize: 4 })
    const manager = new ConversationManager(podA.store)
    const conv = await manager.getOrCreate(SESSION_KEY, {
      userId: USER,
      channelType: 'rpc',
      channelId: 'agent',
      source: 'rpc',
    })
    await manager.startTurn(conv, CONTENT, 'task-folder-resume')
    await manager.suspendForApproval(conv, {
      request_id: 'req-folder-resume',
      tool_name: 'internal__missing_tool',
      tool_call_id: 'tc-folder-resume',
      parameters: {},
      description: 'approve the gated call',
      context_snapshot: contextSnapshot,
      sourceMessage: sourceMessageForResume(message),
      task_budget: {
        elapsedActiveMs: 0,
        iterationsUsed: 1,
        durationMs: 86400000,
        maxIterations: 1000,
      },
    })
    await podA.shutdown()
  }

  async function approveOnPodB() {
    const podB = makeSqliteStore({ dbPath, cacheSize: 4 })
    const providerCalls: ChatMessage[][] = []
    const agent = new AgentStateMachine(new MessageQueue(), new TaskLifecycle(), {
      autoStart: false,
    })
    agent.setLLMProvider({
      getProviderType: () => 'openai',
      classifyError: () => {
        throw new Error('Unexpected provider failure')
      },
      completeSingleTurn: async () => {
        throw new Error('Unexpected non-tool completion')
      },
      completeSingleTurnWithTools: async (messages: ChatMessage[]) => {
        providerCalls.push(structuredClone(messages))
        return { content: 'done', tool_calls: null, usage, finish_reason: FinishReason.Stop }
      },
    } as never)
    agent.setMcpManager({ getAllTools: () => [], callTool: async () => ({}) } as never)
    agent.setConversationStore(podB.store)
    agent.setColdStartLoader(new SqliteColdStartLoader(podB.store))
    try {
      await agent.bootstrap()
      // Witness: the approval came back from disk, not from Pod A's memory.
      expect(agent.getPendingApprovals()).toEqual([
        expect.objectContaining({ requestId: 'req-folder-resume' }),
      ])
      await expect(
        agent.handleApproval(USER, 'req-folder-resume', false, 'rpc', 'agent')
      ).resolves.toEqual({ success: true })
      await vi.waitFor(() => expect(providerCalls.length).toBeGreaterThan(0), { timeout: 5000 })
      return providerCalls
    } finally {
      await podB.shutdown()
    }
  }

  it('T-H5: rebuilds the folder line from the persisted message when no context was saved', async () => {
    const message = await admittedMessage()
    await suspendOnPodA(message, [])

    const providerCalls = await approveOnPodB()

    const text = lastUserText(providerCalls[0]!)
    expect(text.startsWith('<turn-context>')).toBe(true)
    expect(text.split('\n')).toContain(folderLine(message.locationReferences![0]!.id))
    expect(text.endsWith(CONTENT)).toBe(true)
  })

  it('T-H5b: sends the saved context, folder line included, exactly as it was frozen', async () => {
    const message = await admittedMessage()
    const block = buildTurnContextBlock({
      date: new Date('2026-11-21T10:00:00Z'),
      channel: { type: 'rpc', sender: USER },
      referencedFolders: referencedFoldersForTurnContext(message.locationReferenceResolutions),
    })
    const frozenUser = `${block}${CONTENT}`
    await suspendOnPodA(message, [
      { role: 'user', content: frozenUser },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc-folder-resume', name: 'internal__missing_tool', arguments: {} }],
      },
    ])

    const providerCalls = await approveOnPodB()

    const firstUser = providerCalls[0]!.find(m => m.role === 'user')
    expect(firstUser?.content).toBe(frozenUser)
    expect(providerCalls[0]!.filter(m => m.content?.includes('referenced_folder:')).length).toBe(1)
  })
})
