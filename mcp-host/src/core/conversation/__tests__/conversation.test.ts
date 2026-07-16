import { beforeEach, describe, expect, it } from 'vitest'
import { type SessionKey, serializeSessionKey } from '../../../session/types'
import { ConversationError } from '../../errors'
import { ConversationState, PendingApproval } from '../../types'
import { ConversationManager } from '../conversation'

describe('ConversationManager — state machine', () => {
  let manager: ConversationManager

  beforeEach(() => {
    manager = new ConversationManager()
  })

  it('should create a new conversation in Idle state (Risk 5.1)', async () => {
    const conv = await manager.getOrCreate('user-1')

    expect(conv.state).toBe(ConversationState.Idle)
    expect(conv.user_id).toBe('user-1')
    expect(conv.turns).toHaveLength(0)
    expect(conv.auto_approved_tools.size).toBe(0)
  })

  it('should return the same conversation for the same userId', async () => {
    const conv1 = await manager.getOrCreate('user-1')
    const conv2 = await manager.getOrCreate('user-1')

    expect(conv1).toBe(conv2)
    expect(conv1.id).toBe(conv2.id)
  })

  it('should roundtrip: create → startTurn → completeTurn → message history (Risk 5.1)', async () => {
    const conv = await manager.getOrCreate('user-1')

    // Start turn: Idle → Processing
    const turn = await manager.startTurn(conv, 'Hello world', 'test-task')
    expect(conv.state).toBe(ConversationState.Processing)
    expect(turn.number).toBe(1)
    expect(turn.user_input).toBe('Hello world')

    // Complete turn: Processing → Idle
    await manager.completeTurn(conv, 'Hello! How can I help?')
    expect(conv.state).toBe(ConversationState.Idle)
    expect(conv.turns[0].response).toBe('Hello! How can I help?')
    expect(conv.turns[0].completed_at).toBeDefined()

    // Build message history
    const messages = manager.buildMessageHistory(conv)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toEqual({ role: 'user', content: 'Hello world' })
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: 'Hello! How can I help?',
    })
  })

  it('should throw on startTurn when not Idle (Risk 5.2)', async () => {
    const conv = await manager.getOrCreate('user-1')
    await manager.startTurn(conv, 'First message', 'test-task')

    // Already Processing — cannot start another turn
    await expect(manager.startTurn(conv, 'Second message', 'test-task')).rejects.toThrow(
      ConversationError
    )
  })

  it('should throw on completeTurn when not Processing', async () => {
    const conv = await manager.getOrCreate('user-1')

    // Idle — cannot complete a turn that hasn't started
    await expect(manager.completeTurn(conv, 'response')).rejects.toThrow(ConversationError)
  })

  it('recordSessionUsage mirrors token totals in RAM and OR-accumulates cacheTokensReported', async () => {
    const conv = await manager.getOrCreate('user-1')

    // First call: provider without cache info (cache_* undefined).
    manager.recordSessionUsage(conv, { input_tokens: 10, output_tokens: 4 })
    expect(conv.input_tokens).toBe(10)
    expect(conv.output_tokens).toBe(4)
    expect(conv.cache_read_tokens).toBe(0)
    expect(conv.cache_write_tokens).toBe(0)
    expect(conv.cacheTokensReported).toBeUndefined()

    // Second call: provider that reports cache (defined, even if 0) flips the flag.
    manager.recordSessionUsage(conv, {
      input_tokens: 5,
      output_tokens: 2,
      cache_read_tokens: 7,
      cache_write_tokens: 0,
    })
    expect(conv.input_tokens).toBe(15)
    expect(conv.output_tokens).toBe(6)
    expect(conv.cache_read_tokens).toBe(7)
    expect(conv.cache_write_tokens).toBe(0)
    expect(conv.cacheTokensReported).toBe(true)
  })

  it('recordSessionUsage clamps malformed provider figures (negative / NaN / float) to safe integers', async () => {
    const conv = await manager.getOrCreate('user-1')
    manager.recordSessionUsage(conv, {
      input_tokens: -10,
      output_tokens: Number.NaN,
      cache_read_tokens: 4.9,
      cache_write_tokens: -3,
    })
    expect(conv.input_tokens).toBe(0) // negative → 0
    expect(conv.output_tokens).toBe(0) // NaN → 0
    expect(conv.cache_read_tokens).toBe(4) // float → truncated
    expect(conv.cache_write_tokens).toBe(0) // negative → 0
    // cache fields were DEFINED (even though garbage) → provider reports cache
    expect(conv.cacheTokensReported).toBe(true)
  })

  it('recordSessionUsage attributes to the in-flight turn while Processing', async () => {
    const conv = await manager.getOrCreate('user-1')
    await manager.startTurn(conv, 'hi', 'task-1') // → Processing, turn 1
    manager.recordSessionUsage(conv, { input_tokens: 100, output_tokens: 40, cache_read_tokens: 5 })
    manager.recordSessionUsage(conv, { input_tokens: 50, output_tokens: 20 })
    const turn = conv.turns[conv.turns.length - 1]
    expect(turn.input_tokens).toBe(150)
    expect(turn.output_tokens).toBe(60)
    expect(turn.cache_read_tokens).toBe(5)
    // session total accumulates in parallel
    expect(conv.input_tokens).toBe(150)
  })

  it('recordSessionUsage leaves per-turn cache undefined when the provider omits it', async () => {
    const conv = await manager.getOrCreate('user-1')
    await manager.startTurn(conv, 'hi', 'task-1')
    // OpenAI-style: no cache fields reported
    manager.recordSessionUsage(conv, { input_tokens: 20, output_tokens: 8 })
    const turn = conv.turns[conv.turns.length - 1]
    expect(turn.input_tokens).toBe(20)
    expect(turn.cache_read_tokens).toBeUndefined()
    expect(turn.cache_write_tokens).toBeUndefined()
  })

  it('recordSessionUsage does NOT attribute to a turn when idle (e.g. operator /compact)', async () => {
    const conv = await manager.getOrCreate('user-1')
    await manager.startTurn(conv, 'hi', 'task-1')
    manager.recordSessionUsage(conv, { input_tokens: 10, output_tokens: 4 }) // Processing → turn
    await manager.completeTurn(conv, 'done') // → Idle
    manager.recordSessionUsage(conv, { input_tokens: 99, output_tokens: 9 }) // Idle → not the turn
    const turn = conv.turns[conv.turns.length - 1]
    expect(turn.input_tokens).toBe(10) // unchanged by the idle call
    expect(conv.input_tokens).toBe(109) // session counts both
  })

  it('recordContextBreakdown stores buckets with provisional Σbuckets total + capturedAtTurn (F1.3)', async () => {
    const conv = await manager.getOrCreate('user-1')
    await manager.startTurn(conv, 'hi', 'task-1') // turns.length = 1
    manager.recordContextBreakdown(conv, {
      buckets: { messages: 100, systemTools: 30, metaContext: 10, systemPrompt: 5 },
      maxTokens: 100000,
    })
    expect(conv.contextBreakdown).toBeDefined()
    expect(conv.contextBreakdown!.buckets).toEqual({
      messages: 100,
      systemTools: 30,
      metaContext: 10,
      systemPrompt: 5,
    })
    expect(conv.contextBreakdown!.totalInputTokens).toBe(145) // Σbuckets, provisional
    expect(conv.contextBreakdown!.maxTokens).toBe(100000)
    expect(conv.contextBreakdown!.capturedAtTurn).toBe(1)
  })

  it('the usage sink finalizes the provisional total with the authoritative input_tokens (F1.3b / #8)', async () => {
    // Mirror the taskExecutor sink: recordSessionUsage + finalize breakdown.
    const conv = await manager.getOrCreate('user-1')
    await manager.startTurn(conv, 'hi', 'task-1')
    manager.recordContextBreakdown(conv, {
      buckets: { messages: 100, systemTools: 30, metaContext: 10, systemPrompt: 5 },
      maxTokens: 100000,
    })
    expect(conv.contextBreakdown!.totalInputTokens).toBe(145) // provisional

    const sink = (usage: { input_tokens: number; output_tokens: number }) => {
      manager.recordSessionUsage(conv, usage)
      if (conv.contextBreakdown && usage.input_tokens > 0) {
        conv.contextBreakdown.totalInputTokens = usage.input_tokens
      }
    }
    sink({ input_tokens: 1234, output_tokens: 50 })

    expect(conv.contextBreakdown!.totalInputTokens).toBe(1234) // exact, same call
    expect(conv.contextBreakdown!.buckets.messages).toBe(100) // buckets untouched
  })
})

describe('ConversationManager — approval transitions', () => {
  let manager: ConversationManager

  beforeEach(() => {
    manager = new ConversationManager()
  })

  it('should transition Processing → AwaitingApproval → Processing on approve', async () => {
    const conv = await manager.getOrCreate('user-1')
    await manager.startTurn(conv, 'Delete files', 'test-task')

    const approval: PendingApproval = {
      request_id: 'req-1',
      tool_name: 'shell_exec',
      parameters: { command: 'rm -rf' },
      description: 'Dangerous command',
      tool_call_id: 'tc_1',
      context_snapshot: [],
    }

    // Suspend: Processing → AwaitingApproval
    await manager.suspendForApproval(conv, approval)
    expect(conv.state).toBe(ConversationState.AwaitingApproval)
    expect(conv.pending_approval).toBe(approval)

    // Approve: AwaitingApproval → Processing
    await manager.approve(conv, false)
    expect(conv.state).toBe(ConversationState.Processing)
  })

  it('should add MCP server prefix to auto_approved_tools on any approval', async () => {
    const conv = await manager.getOrCreate('user-1')
    await manager.startTurn(conv, 'Insert data', 'test-task')

    await manager.suspendForApproval(conv, {
      request_id: 'req-1',
      tool_name: 'mongodb-server__insert_many',
      parameters: { collection: 'test' },
      description: 'MongoDB insert',
      tool_call_id: 'tc_1',
      context_snapshot: [],
    })

    // Approve without alwaysApprove — should still add server prefix
    await manager.approve(conv, false)
    expect(conv.auto_approved_tools.has('mongodb-server')).toBe(true)
    // Individual tool name should NOT be in the set (only server prefix)
    expect(conv.auto_approved_tools.has('mongodb-server__insert_many')).toBe(false)
  })

  it('should add both server prefix and tool name on alwaysApprove for MCP tool', async () => {
    const conv = await manager.getOrCreate('user-2')
    await manager.startTurn(conv, 'List tables', 'test-task')

    await manager.suspendForApproval(conv, {
      request_id: 'req-2',
      tool_name: 'airtable-server__list_tables',
      parameters: {},
      description: 'Airtable list',
      tool_call_id: 'tc_2',
      context_snapshot: [],
    })

    await manager.approve(conv, true)
    expect(conv.auto_approved_tools.has('airtable-server')).toBe(true)
    expect(conv.auto_approved_tools.has('airtable-server__list_tables')).toBe(true)
  })

  it('should NOT add server prefix for non-MCP tools (no __ separator)', async () => {
    const conv = await manager.getOrCreate('user-3')
    await manager.startTurn(conv, 'Run shell', 'test-task')

    await manager.suspendForApproval(conv, {
      request_id: 'req-3',
      tool_name: 'shell_exec',
      parameters: { command: 'ls' },
      description: 'Shell command',
      tool_call_id: 'tc_3',
      context_snapshot: [],
    })

    // Non-MCP tool: approve adds wildcard "*" for "approve once, run all" within this turn
    await manager.approve(conv, false)
    expect(conv.auto_approved_tools.has('*')).toBe(true)
    expect(conv.auto_approved_tools.has('shell_exec')).toBe(false) // individual tool NOT added without alwaysApprove
  })

  it('should transition AwaitingApproval → Idle on deny, clearing pending approval', async () => {
    const conv = await manager.getOrCreate('user-1')
    await manager.startTurn(conv, 'Delete files', 'test-task')

    await manager.suspendForApproval(conv, {
      request_id: 'req-1',
      tool_name: 'shell_exec',
      parameters: {},
      description: 'Test',
      tool_call_id: 'tc_1',
      context_snapshot: [],
    })

    // Deny: AwaitingApproval → Idle
    await manager.deny(conv)
    expect(conv.state).toBe(ConversationState.Idle)
    expect(conv.pending_approval).toBeUndefined()
  })
})

describe('ConversationManager — session key routing', () => {
  let manager: ConversationManager

  beforeEach(() => {
    manager = new ConversationManager()
  })

  it('should isolate conversations by session key', async () => {
    const keyTelegram: SessionKey = {
      userId: 'alice',
      channelType: 'telegram',
      channelId: 'chat-1',
    }
    const keySlack: SessionKey = { userId: 'alice', channelType: 'slack', channelId: 'C1' }

    const conv1 = await manager.getOrCreate(serializeSessionKey(keyTelegram))
    const conv2 = await manager.getOrCreate(serializeSessionKey(keySlack))

    expect(conv1.id).not.toBe(conv2.id)
  })

  it('should return the same conversation for the same session key', async () => {
    const key: SessionKey = {
      userId: 'alice',
      channelType: 'telegram',
      channelId: 'chat-1',
      threadId: 'topic-42',
    }
    const serialized = serializeSessionKey(key)

    const conv1 = await manager.getOrCreate(serialized)
    const conv2 = await manager.getOrCreate(serialized)

    expect(conv1.id).toBe(conv2.id)
  })

  it('should isolate threads within the same channel', async () => {
    const key1 = serializeSessionKey({
      userId: 'alice',
      channelType: 'slack',
      channelId: 'C1',
      threadId: 't1',
    })
    const key2 = serializeSessionKey({
      userId: 'alice',
      channelType: 'slack',
      channelId: 'C1',
      threadId: 't2',
    })

    const conv1 = await manager.getOrCreate(key1)
    const conv2 = await manager.getOrCreate(key2)

    expect(conv1.id).not.toBe(conv2.id)
  })
})

describe('ConversationManager — approve-once wildcard lifecycle', () => {
  let manager: ConversationManager

  beforeEach(() => {
    manager = new ConversationManager()
  })

  it("approve() adds wildcard '*' to auto_approved_tools", async () => {
    const conv = await manager.getOrCreate('user-wc-1')
    await manager.startTurn(conv, 'Do something', 'test-task')

    await manager.suspendForApproval(conv, {
      request_id: 'req-wc-1',
      tool_name: 'shell_exec',
      parameters: { command: 'echo hi' },
      description: 'Shell',
      tool_call_id: 'tc_wc_1',
      context_snapshot: [],
    })

    await manager.approve(conv, false)
    expect(conv.auto_approved_tools.has('*')).toBe(true)
  })

  it("startTurn() clears the wildcard '*'", async () => {
    const conv = await manager.getOrCreate('user-wc-2')

    // Turn 1: approve to get wildcard
    await manager.startTurn(conv, 'First message', 'test-task')
    await manager.suspendForApproval(conv, {
      request_id: 'req-wc-2',
      tool_name: 'shell_exec',
      parameters: {},
      description: 'Shell',
      tool_call_id: 'tc_wc_2',
      context_snapshot: [],
    })
    await manager.approve(conv, false)
    expect(conv.auto_approved_tools.has('*')).toBe(true)

    // Complete turn 1, then start turn 2
    await manager.completeTurn(conv, 'Done')
    await manager.startTurn(conv, 'Second message', 'test-task')

    // Wildcard should be cleared
    expect(conv.auto_approved_tools.has('*')).toBe(false)
  })

  it('after approve + startTurn, wildcard is gone but MCP server-prefix approvals persist', async () => {
    const conv = await manager.getOrCreate('user-wc-3')

    // Turn 1: approve an MCP tool
    await manager.startTurn(conv, 'Use database', 'test-task')
    await manager.suspendForApproval(conv, {
      request_id: 'req-wc-3',
      tool_name: 'mongodb-server__find',
      parameters: { collection: 'test' },
      description: 'MongoDB find',
      tool_call_id: 'tc_wc_3',
      context_snapshot: [],
    })
    await manager.approve(conv, false)

    // Both wildcard and server prefix should be present
    expect(conv.auto_approved_tools.has('*')).toBe(true)
    expect(conv.auto_approved_tools.has('mongodb-server')).toBe(true)

    // Complete turn 1, start turn 2
    await manager.completeTurn(conv, 'Found results')
    await manager.startTurn(conv, 'Another query', 'test-task')

    // Wildcard gone, but server-prefix persists across turns
    expect(conv.auto_approved_tools.has('*')).toBe(false)
    expect(conv.auto_approved_tools.has('mongodb-server')).toBe(true)
  })
})

describe('cancelTurn (BUG-9)', () => {
  it('prevents cancelled user_input from leaking into next LLM call', async () => {
    const cm = new ConversationManager()
    const conv = await cm.getOrCreate('user-1')

    await cm.startTurn(conv, 'give me a 3000-word essay', 'test-task')
    cm.cancelTurn(conv)
    await cm.startTurn(conv, 'how much is 12 - 32', 'test-task')

    const history = cm.buildMessageHistory(conv)

    // Expected: clean user→assistant→user alternation, no consecutive user messages
    expect(history).toEqual([
      { role: 'user', content: 'give me a 3000-word essay' },
      { role: 'assistant', content: '[Task cancelled by user before completion]' },
      { role: 'user', content: 'how much is 12 - 32' },
    ])
  })

  it('resets state to Idle (parity with failTurn for state)', async () => {
    const cm = new ConversationManager()
    const conv = await cm.getOrCreate('user-1')
    await cm.startTurn(conv, 'anything', 'test-task')
    cm.cancelTurn(conv)

    expect(conv.state).toBe(ConversationState.Idle)
    expect(conv.pending_approval).toBeUndefined()
  })

  it('works from AwaitingApproval state', async () => {
    const cm = new ConversationManager()
    const conv = await cm.getOrCreate('user-1')
    await cm.startTurn(conv, 'use a tool', 'test-task')
    await cm.suspendForApproval(conv, {
      request_id: 'r1',
      tool_name: 't',
      tool_call_id: 'c1',
      parameters: {},
      description: '',
      context_snapshot: [],
    })

    cm.cancelTurn(conv)

    expect(conv.state).toBe(ConversationState.Idle)
    expect(conv.pending_approval).toBeUndefined()
    const lastTurn = conv.turns[conv.turns.length - 1]
    expect(lastTurn.response).toBe('[Task cancelled by user before completion]')
  })

  it('cancelTurnBySessionKey is no-op on unknown session key', () => {
    const cm = new ConversationManager()
    expect(() => cm.cancelTurnBySessionKey('nonexistent')).not.toThrow()
  })

  it('cancelTurnBySessionKey resolves to cancelTurn for known key', async () => {
    const cm = new ConversationManager()
    const conv = await cm.getOrCreate('sess-1')
    await cm.startTurn(conv, 'hi', 'test-task')
    cm.cancelTurnBySessionKey('sess-1')
    expect(conv.state).toBe(ConversationState.Idle)
    const last = conv.turns[conv.turns.length - 1]
    expect(last.response).toBe('[Task cancelled by user before completion]')
  })
})

describe('ConversationManager.clearPendingApproval', () => {
  it('removes pending_approval without mutating turn history', async () => {
    const cm = new ConversationManager()
    const conv = await cm.getOrCreate('session-clear-1')

    await cm.startTurn(conv, 'Do something requiring approval', 'test-task')
    await cm.suspendForApproval(conv, {
      request_id: 'r1',
      tool_name: 'shell_exec',
      tool_call_id: 'c1',
      parameters: { command: 'rm -rf' },
      description: 'Dangerous command',
      context_snapshot: [],
    })

    const turnCountBefore = conv.turns.length
    expect(conv.pending_approval).toBeDefined()

    await cm.clearPendingApproval('session-clear-1')

    expect(conv.pending_approval).toBeUndefined()
    // Turn history is unchanged — no denial message appended
    expect(conv.turns.length).toBe(turnCountBefore)
  })

  it('is safe for unknown sessionKey (no throw)', async () => {
    const cm = new ConversationManager()
    await expect(cm.clearPendingApproval('nonexistent-session')).resolves.toBeUndefined()
  })

  it('is idempotent on already-cleared conversation', async () => {
    const cm = new ConversationManager()
    const conv = await cm.getOrCreate('session-clear-2')

    conv.pending_approval = {
      request_id: 'r1',
      tool_name: 'shell_exec',
      tool_call_id: 'c1',
      parameters: {},
      description: 'test',
      context_snapshot: [],
    }

    await cm.clearPendingApproval('session-clear-2')
    await cm.clearPendingApproval('session-clear-2') // second call — no-op

    expect(conv.pending_approval).toBeUndefined()
  })
})
