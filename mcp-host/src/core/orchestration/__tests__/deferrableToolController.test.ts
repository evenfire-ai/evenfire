import { describe, expect, it, vi } from 'vitest'
import { logger } from '../../../logger'
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

describe('Codex presentation without access limits', () => {
  const native = Array.from({ length: 36 }, (_, i) => tool(`native_${i}`)).concat(NATIVE_TOOLS)
  const names = new Set(native.map(t => t.name))
  function controller(mode: 'auto' | 'direct' | 'discovery', latch = makeLatch(), bytes = 32_768) {
    return new DeferrableToolController(
      new DefaultLoopController(),
      names,
      {
        dynamicToolsEnabled: true,
        dynamicToolsThreshold: 60,
        codexMode: mode,
        codexToolDiscoveryBytes: bytes,
      },
      latch
    )
  }

  it('logs live direct counts without serializing schemas or repeating unchanged measurements', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    // The serialization spy proves direct mode never evaluates the schema byte threshold.
    const serializeSchema = vi.fn(() => ({ type: 'object' }))
    const mcp = { ...tool('server__read'), parameters: { toJSON: serializeSchema } }
    const ctl = controller('direct')
    const all = [...native, mcp]
    try {
      expect(await ctl.refreshTools(all)).toBe(all)
      expect(info).toHaveBeenCalledExactlyOnceWith(
        {
          component: 'tool-presentation',
          mode: 'direct',
          strategy: 'direct',
          nativeCount: native.length,
          mcpCount: 1,
          presentedCount: all.length,
          deferredCount: 0,
        },
        'Tool presentation selected'
      )
      expect(await ctl.refreshTools(all)).toBe(all)
      expect(info).toHaveBeenCalledTimes(1)
      expect(await ctl.refreshTools(native)).toBe(native)
      expect(info).toHaveBeenCalledTimes(2)
      expect(info).toHaveBeenLastCalledWith(
        {
          component: 'tool-presentation',
          mode: 'direct',
          strategy: 'direct',
          nativeCount: native.length,
          mcpCount: 0,
          presentedCount: native.length,
          deferredCount: 0,
        },
        'Tool presentation selected'
      )
      expect(serializeSchema).not.toHaveBeenCalled()
    } finally {
      info.mockRestore()
    }
  })

  it.each([0, 1, 32, 33, 83, 150, 250])(
    'direct retains every native and MCP for %i MCP',
    async n => {
      const all = [...native, ...mcpTools(n)]
      expect(await controller('direct').refreshTools(all)).toEqual(all)
    }
  )

  it.each([83, 150, 250])(
    'auto emits byte-identical native+bridge definitions for %i MCP',
    async n => {
      const all = [...native, ...mcpTools(n)]
      const out = await controller('auto').refreshTools(all)
      expect(JSON.stringify(out)).toBe(JSON.stringify(native))
      expect(out.length).toBeGreaterThan(32)
      expect(all.length).toBe(native.length + n)
    }
  )

  it.each([60, 61])('auto changes strategy only above the count threshold: %i', async count => {
    const all = [...native, ...mcpTools(count)]
    const result = await controller('auto', makeLatch(), 1_000_000).refreshTools(all)
    expect(result).toEqual(count === 60 ? all : native)
  })

  it('auto changes strategy only above the exact UTF-8 byte threshold', async () => {
    const deferred = [{ ...tool('server__read'), description: 'Información' }]
    const bytes = Buffer.byteLength(JSON.stringify(deferred), 'utf8')
    const all = [...native, ...deferred]
    expect(await controller('auto', makeLatch(), bytes).refreshTools(all)).toEqual(all)
    expect(await controller('auto', makeLatch(), bytes - 1).refreshTools(all)).toEqual(native)
  })

  it('auto detects late connections and ignores a legacy false latch', async () => {
    const latch = makeLatch()
    latch.set(false)
    const ctl = controller('auto', latch)
    expect(await ctl.refreshTools(native)).toEqual(native)
    expect(await ctl.refreshTools([...native, ...mcpTools(1)])).toHaveLength(native.length + 1)
    expect(await ctl.refreshTools([...native, ...mcpTools(250)])).toEqual(native)
    expect(latch.get()).toBe(false)
  })

  it('explicit discovery remains stable from cold start through connection and removal', async () => {
    const ctl = controller('discovery')
    for (const n of [0, 1, 250, 0]) {
      expect(await ctl.refreshTools([...native, ...mcpTools(n)])).toEqual(native)
    }
  })

  it('auto optimizes a large schema even when the count is below threshold', async () => {
    const large = { ...tool('server__large'), description: 'x'.repeat(4096) }
    expect(await controller('auto', makeLatch(), 1024).refreshTools([...native, large])).toEqual(
      native
    )
  })

  it('provider switch uses current presentation without changing legacy latch', async () => {
    const latch = makeLatch()
    latch.set(true)
    const all = [...native, ...mcpTools(1)]
    expect(await controller('direct', latch).refreshTools(all)).toEqual(all)
    expect(await controller('auto', latch).refreshTools(all)).toEqual(all)
    expect(await controller('discovery', latch).refreshTools(all)).toEqual(native)
    expect(latch.get()).toBe(true)
  })
})
