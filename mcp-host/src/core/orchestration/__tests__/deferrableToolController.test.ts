import { describe, expect, it, vi } from 'vitest'
import type { LoopController } from '../../interfaces'
import type { ToolDefinition } from '../../types'
import { DeferrableToolController, type LatchStore } from '../deferrableToolController'
import { DefaultLoopController } from '../loopConfig'

/** Fresh in-memory latch store (stands in for the session-scoped Conversation
 * field in production). */
function makeLatch(): LatchStore {
  let v: boolean | undefined
  return {
    get: () => v,
    set: value => {
      v = value
    },
  }
}

function tool(name: string): ToolDefinition {
  return { name, description: `${name} desc`, parameters: { type: 'object', properties: {} } }
}

// Natives include the 3 bridge tools (they ARE native).
const NATIVE_NAMES = new Set([
  'shell_exec',
  'file_read',
  'clerum__tool_search',
  'clerum__tool_describe',
  'clerum__tool_call',
])

function mcpTools(n: number): ToolDefinition[] {
  return Array.from({ length: n }, (_, i) => tool(`server__tool_${i}`))
}

const NATIVE_TOOLS = [...NATIVE_NAMES].map(tool)

describe('DeferrableToolController', () => {
  it('passthrough when the flag is OFF (no swap even over threshold)', async () => {
    const ctl = new DeferrableToolController(
      new DefaultLoopController(),
      NATIVE_NAMES,
      {
        dynamicToolsEnabled: false,
        dynamicToolsThreshold: 2,
      },
      makeLatch()
    )
    const upstream = [...NATIVE_TOOLS, ...mcpTools(100)]
    const out = await ctl.refreshTools(upstream)
    expect(out).toEqual(upstream)
  })

  it('passthrough when deferrable count is AT or UNDER threshold', async () => {
    const ctl = new DeferrableToolController(
      new DefaultLoopController(),
      NATIVE_NAMES,
      {
        dynamicToolsEnabled: true,
        dynamicToolsThreshold: 5,
      },
      makeLatch()
    )
    const upstream = [...NATIVE_TOOLS, ...mcpTools(5)] // 5 deferrable, not > 5
    const out = await ctl.refreshTools(upstream)
    expect(out).toEqual(upstream)
  })

  it('swaps to natives + bridges only when ON and over threshold', async () => {
    const ctl = new DeferrableToolController(
      new DefaultLoopController(),
      NATIVE_NAMES,
      {
        dynamicToolsEnabled: true,
        dynamicToolsThreshold: 5,
      },
      makeLatch()
    )
    const upstream = [...NATIVE_TOOLS, ...mcpTools(10)]
    const out = await ctl.refreshTools(upstream)
    const names = out.map(t => t.name).sort()
    expect(names).toEqual([...NATIVE_NAMES].sort())
    // No deferrable MCP tool survives.
    expect(out.some(t => t.name.startsWith('server__'))).toBe(false)
    // Bridge tools (contain `__` but are native) DO survive.
    expect(names).toContain('clerum__tool_call')
  })

  it('LATCHES bridgeActive: a later turn with fewer deferrable tools does NOT flip the decision', async () => {
    const ctl = new DeferrableToolController(
      new DefaultLoopController(),
      NATIVE_NAMES,
      {
        dynamicToolsEnabled: true,
        dynamicToolsThreshold: 5,
      },
      makeLatch()
    )
    // Turn 1: over threshold → latches bridgeActive = true.
    const out1 = await ctl.refreshTools([...NATIVE_TOOLS, ...mcpTools(10)])
    expect(out1.some(t => t.name.startsWith('server__'))).toBe(false)
    // Turn 2: now UNDER threshold (a server disconnected) → decision must NOT
    // flip; still swaps. tools[] stays byte-stable.
    const out2 = await ctl.refreshTools([...NATIVE_TOOLS, ...mcpTools(1)])
    expect(out2.map(t => t.name).sort()).toEqual([...NATIVE_NAMES].sort())
  })

  it('LATCHES passthrough: a later turn that crosses the threshold does NOT engage the swap', async () => {
    const ctl = new DeferrableToolController(
      new DefaultLoopController(),
      NATIVE_NAMES,
      {
        dynamicToolsEnabled: true,
        dynamicToolsThreshold: 5,
      },
      makeLatch()
    )
    // Turn 1: under threshold → latches bridgeActive = false (passthrough).
    const out1 = await ctl.refreshTools([...NATIVE_TOOLS, ...mcpTools(2)])
    expect(out1.some(t => t.name.startsWith('server__'))).toBe(true)
    // Turn 2: now WAY over threshold (a late server connected) → must stay
    // passthrough, no mid-session mutation.
    const out2 = await ctl.refreshTools([...NATIVE_TOOLS, ...mcpTools(50)])
    expect(out2.some(t => t.name.startsWith('server__'))).toBe(true)
    expect(out2.length).toBe(NATIVE_TOOLS.length + 50)
  })

  it('delegates refreshTools first (composes over an inner controller that mutates the list)', async () => {
    // Inner controller that drops one MCP tool — DeferrableToolController must
    // post-process whatever the delegate returns, not the raw currentTools.
    const inner: LoopController = {
      shouldAccept: () => true,
      onTextRejected: () => null,
      beforeTool: () => 'proceed',
      onExhaustion: () => '',
      refreshTools: vi.fn(async (tools: ToolDefinition[]) =>
        tools.filter(t => t.name !== 'server__tool_0')
      ),
    }
    const ctl = new DeferrableToolController(
      inner,
      NATIVE_NAMES,
      {
        dynamicToolsEnabled: true,
        dynamicToolsThreshold: 5,
      },
      makeLatch()
    )
    const out = await ctl.refreshTools([...NATIVE_TOOLS, ...mcpTools(10)])
    expect(inner.refreshTools).toHaveBeenCalledOnce()
    // Swap still produces natives only; the inner drop does not change that.
    expect(out.map(t => t.name).sort()).toEqual([...NATIVE_NAMES].sort())
  })

  it('delegates the non-refresh hooks to the inner controller', () => {
    const inner = new DefaultLoopController()
    const acceptSpy = vi.spyOn(inner, 'shouldAccept')
    const beforeToolSpy = vi.spyOn(inner, 'beforeTool')
    const ctl = new DeferrableToolController(
      inner,
      NATIVE_NAMES,
      {
        dynamicToolsEnabled: true,
        dynamicToolsThreshold: 5,
      },
      makeLatch()
    )
    ctl.shouldAccept('text', 0)
    ctl.beforeTool('shell_exec', {})
    expect(acceptSpy).toHaveBeenCalledWith('text', 0)
    expect(beforeToolSpy).toHaveBeenCalledWith('shell_exec', {})
  })

  it('latch is SESSION-scoped: a fresh controller (next task) reuses the latched decision', async () => {
    // A new TaskExecutor builds a new controller per task, but the latch lives
    // on the session-scoped store, so the decision must persist across tasks.
    const latch = makeLatch()
    const config = { dynamicToolsEnabled: true, dynamicToolsThreshold: 5 }

    // Task 1: over threshold → latches bridgeActive = true on the shared store.
    const ctlA = new DeferrableToolController(
      new DefaultLoopController(),
      NATIVE_NAMES,
      config,
      latch
    )
    const outA = await ctlA.refreshTools([...NATIVE_TOOLS, ...mcpTools(10)])
    expect(outA.some(t => t.name.startsWith('server__'))).toBe(false)
    expect(latch.get()).toBe(true)

    // Task 2: a BRAND NEW controller, now under threshold (servers dropped
    // between turns). It must NOT recompute — the shared latch keeps swapping.
    const ctlB = new DeferrableToolController(
      new DefaultLoopController(),
      NATIVE_NAMES,
      config,
      latch
    )
    const outB = await ctlB.refreshTools([...NATIVE_TOOLS, ...mcpTools(1)])
    expect(outB.map(t => t.name).sort()).toEqual([...NATIVE_NAMES].sort())
  })
})
