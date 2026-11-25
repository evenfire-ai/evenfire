/**
 * The Approvals tab's display state and the Host-changed notice (spec §6.5),
 * named after the spec §7 A3 rows they settle: R8 (the Host check), R9s (T26),
 * R18 (T27) and R25 (T31).
 *
 * Host objects are control-api's Host shape from test/fixtures/contextResource
 * (spec A6, Fixtures). A load's data is the `host` of a `/detail` answer; a
 * write's is the stored Host its PUT answered, or its re-read.
 *
 * The notice crosses browser tabs on a `BroadcastChannel`. Under vitest's jsdom
 * environment the constructor is Node 24's global one (jsdom has none), so no
 * polyfill is needed: like a browser, Node delivers a message to every other
 * channel of that name, after the current task, and never to the channel that
 * posted it. A test stands for another document either with a second instance
 * of this module (its own listeners and its own channel) or with a raw channel.
 * A delivery is asynchronous, so a "not heard" assertion is made only after a
 * later message to the same channel has been heard: a channel hears messages
 * in the order they were posted.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { materializeHostResource } from '../../test/fixtures/contextResource'
import type { HostResource } from '../api'
import {
  __resetHostApprovalDisplayForTests,
  createApprovalTabState,
  notifyHostChanged,
  subscribeHostChanged,
} from '../hostApprovalDisplay'

/** The channel's name, written out: Control UI tabs of different builds must agree on it. */
const CHANNEL = 'control-ui-host-approval-changed'

type ApprovalBlock = Record<string, unknown>

/**
 * Agent `name` at version `rv`, as control-api returns it. `approval` is its
 * `spec.approval`, omitted when undefined; `model` is its `spec.model.name`.
 */
function host(
  name: string,
  rv: string,
  approval?: ApprovalBlock | null,
  model = 'claude-sonnet-4-6'
): HostResource {
  return materializeHostResource(
    {
      metadata: { name },
      spec: {
        host: name,
        contextRef: 'ctx-a',
        secretRef: `${name}-llm`,
        channels: [],
        model: { provider: 'claude', name: model },
      },
    },
    {
      metadata: { resourceVersion: rv },
      spec: approval === undefined ? {} : { approval },
    }
  )
}

/** Another document's copy of this module: its own listeners and its own channel. */
async function openAnotherDocument(): Promise<typeof import('../hostApprovalDisplay')> {
  vi.resetModules()
  const other = await import('../hostApprovalDisplay')
  // The same instance would share this document's listeners and pass with no channel.
  expect(other.notifyHostChanged).not.toBe(notifyHostChanged)
  return other
}

/** A raw channel standing for another document; `heard` is what it received. */
function openWitness(): { channel: BroadcastChannel; heard: unknown[] } {
  const channel = new BroadcastChannel(CHANNEL)
  const heard: unknown[] = []
  channel.onmessage = event => heard.push(event.data)
  return { channel, heard }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  __resetHostApprovalDisplayForTests()
})

describe('approval tab display state', () => {
  it('T26 the newest load epoch wins', () => {
    const tab = createApprovalTabState('foo')
    const v1 = host('foo', 'rv-1', { modeCeiling: 'auto' }, 'model-1')
    const v2 = host('foo', 'rv-2', { modeCeiling: 'manual' }, 'model-2')
    const v3 = host('foo', 'rv-3', { modeCeiling: 'allow_all' }, 'model-3')
    const v4 = host('foo', 'rv-4', { modeCeiling: 'auto', tools: { shell_exec: true } }, 'model-4')

    // The newer load lands first; the older one lands after it.
    const older = tab.startLoad()
    const newer = tab.startLoad()
    expect(tab.applyLoad(newer, v2)).toBe(true)
    expect(tab.applyLoad(older, v1)).toBe(false)
    expect(tab.snapshot()).toEqual(v2)

    // The older load lands first, while the newer one is still in flight.
    const third = tab.startLoad()
    const fourth = tab.startLoad()
    expect(tab.applyLoad(third, v3)).toBe(false)
    expect(tab.snapshot()).toEqual(v2)
    expect(tab.applyLoad(fourth, v4)).toBe(true)
    expect(tab.snapshot()).toEqual(v4)
  })

  it('a load token from another tab state is refused', () => {
    // Task 21a may make a new state when a kept instance comes back to an
    // agent; a load of the old state must not count as the new state's newest.
    const before = createApprovalTabState('foo')
    const after = createApprovalTabState('foo')
    const v1 = host('foo', 'rv-1', { modeCeiling: 'auto' })
    const fromBefore = before.startLoad()
    const fromAfter = after.startLoad()

    expect(after.applyLoad(fromBefore, v1)).toBe(false)
    expect(after.snapshot()).toBeNull()
    expect(after.applyLoad(fromAfter, v1)).toBe(true)
    expect(after.snapshot()).toEqual(v1)
  })

  it('a load for another Host is ignored', () => {
    const tab = createApprovalTabState('foo')
    const foo = host('foo', 'rv-1', { modeCeiling: 'auto', tools: { http_request: false } })
    const bar = host('bar', 'rv-9', { modeCeiling: 'allow_all', tools: { http_request: true } })

    // The newest epoch, so only the Host can refuse it.
    const load = tab.startLoad()
    expect(tab.applyLoad(load, bar)).toBe(false)
    expect(tab.snapshot()).toBeNull()
    // The same token with foo's data applies: the refusal was the Host's alone,
    // and it changed nothing, not even the token's standing.
    expect(tab.applyLoad(load, foo)).toBe(true)
    expect(tab.snapshot()).toEqual(foo)

    // Once foo's data is shown, bar's still does not replace it.
    const shown = tab.snapshot()
    expect(tab.applyLoad(tab.startLoad(), bar)).toBe(false)
    expect(tab.snapshot()).toBe(shown)
  })

  it('a write for another Host is refused and records nothing', () => {
    const tab = createApprovalTabState('foo')
    const fooAuto = host('foo', 'rv-1', { modeCeiling: 'auto', tools: { http_request: false } })

    // Refused before the first load lands: had it been recorded, the ceiling
    // group would keep bar's value when this load, started before it, lands.
    const first = tab.startLoad()
    expect(tab.applyWrite('ceiling', host('bar', 'rv-9', { modeCeiling: 'manual' }))).toBe(false)
    expect(tab.applyLoad(first, fooAuto)).toBe(true)
    expect(tab.snapshot()).toEqual(fooAuto)

    // Refused while foo's data is shown: nothing changes.
    const shown = tab.snapshot()
    expect(tab.applyWrite('tools', host('bar', 'rv-9', { tools: { http_request: true } }))).toBe(
      false
    )
    expect(tab.snapshot()).toBe(shown)

    // foo's own write applies, to its group only.
    expect(
      tab.applyWrite(
        'ceiling',
        host('foo', 'rv-2', { modeCeiling: 'manual', tools: { http_request: true } })
      )
    ).toBe(true)
    expect(tab.snapshot()).toEqual(
      host('foo', 'rv-1', { modeCeiling: 'manual', tools: { http_request: false } })
    )
  })

  it('T27 a load started before a tools write keeps the tools group and updates the ceiling group', () => {
    const tab = createApprovalTabState('foo')
    const first = tab.startLoad()
    expect(
      tab.applyLoad(
        first,
        host(
          'foo',
          'rv-1',
          {
            modeCeiling: 'auto',
            defaultPolicy: 'channel_users',
            tools: { http_request: false },
            shellClassifierModel: 'judge-1',
          },
          'model-1'
        )
      )
    ).toBe(true)

    // A refresh starts, then the per-tool save settles. Its answer is the
    // stored Host after its PUT: the admin's tools, and every other key as
    // its fresh read found them (another writer had raised the ceiling and
    // removed the policy).
    const refresh = tab.startLoad()
    expect(
      tab.applyWrite(
        'tools',
        host(
          'foo',
          'rv-3',
          {
            modeCeiling: 'allow_all',
            tools: { http_request: true, system_info: true },
            shellClassifierModel: 'judge-3',
          },
          'model-3'
        )
      )
    ).toBe(true)
    // It seeds the tools group only: tools, and the policy it stored (none).
    expect(tab.snapshot()).toEqual(
      host(
        'foo',
        'rv-1',
        {
          modeCeiling: 'auto',
          tools: { http_request: true, system_info: true },
          shellClassifierModel: 'judge-1',
        },
        'model-1'
      )
    )

    // The refresh lands. Its read may have come after the PUT and after
    // another change (json_transform here); the tab cannot tell, so the tools
    // group keeps the save's values. The ceiling and every key outside the
    // tools group come from the refresh.
    expect(
      tab.applyLoad(
        refresh,
        host(
          'foo',
          'rv-4',
          {
            modeCeiling: 'manual',
            defaultPolicy: 'cli_only',
            tools: { http_request: true, system_info: true, json_transform: false },
            shellClassifierModel: 'judge-4',
          },
          'model-4'
        )
      )
    ).toBe(true)
    expect(tab.snapshot()).toEqual(
      host(
        'foo',
        'rv-4',
        {
          modeCeiling: 'manual',
          tools: { http_request: true, system_info: true },
          shellClassifierModel: 'judge-4',
        },
        'model-4'
      )
    )

    // A load started after the save settled takes every key, tools included.
    const newest = host(
      'foo',
      'rv-5',
      {
        modeCeiling: 'manual',
        defaultPolicy: 'cli_only',
        tools: { json_transform: false },
        shellClassifierModel: 'judge-5',
      },
      'model-5'
    )
    expect(tab.applyLoad(tab.startLoad(), newest)).toBe(true)
    expect(tab.snapshot()).toEqual(newest)
  })

  it('R18 two writes of different groups each keep their own values, in either order', () => {
    const shown = host(
      'foo',
      'rv-1',
      { modeCeiling: 'auto', tools: { http_request: false }, shellClassifierModel: 'judge-1' },
      'model-1'
    )
    // A load started before both writes, landing after both.
    const pending = host(
      'foo',
      'rv-6',
      {
        modeCeiling: 'allow_all',
        tools: { json_transform: false },
        shellClassifierModel: 'judge-6',
      },
      'model-6'
    )
    const settled = host(
      'foo',
      'rv-6',
      { modeCeiling: 'manual', tools: { http_request: true }, shellClassifierModel: 'judge-6' },
      'model-6'
    )

    // The per-tool PUT was applied first and the switch's second, but the
    // switch's answer arrives first. The per-tool answer holds the older ceiling.
    const a = createApprovalTabState('foo')
    expect(a.applyLoad(a.startLoad(), shown)).toBe(true)
    const aPending = a.startLoad()
    expect(
      a.applyWrite(
        'ceiling',
        host('foo', 'rv-3', { modeCeiling: 'manual', tools: { http_request: true } })
      )
    ).toBe(true)
    expect(a.snapshot()).toEqual(
      host(
        'foo',
        'rv-1',
        { modeCeiling: 'manual', tools: { http_request: false }, shellClassifierModel: 'judge-1' },
        'model-1'
      )
    )
    expect(
      a.applyWrite(
        'tools',
        host('foo', 'rv-2', { modeCeiling: 'auto', tools: { http_request: true } })
      )
    ).toBe(true)
    expect(a.snapshot()).toEqual(
      host(
        'foo',
        'rv-1',
        { modeCeiling: 'manual', tools: { http_request: true }, shellClassifierModel: 'judge-1' },
        'model-1'
      )
    )
    expect(a.applyLoad(aPending, pending)).toBe(true)
    expect(a.snapshot()).toEqual(settled)

    // The switch's PUT was applied first; the per-tool PUT met its 409 and was
    // applied second, and its answer arrives first. The switch's answer holds
    // the older tools.
    const b = createApprovalTabState('foo')
    expect(b.applyLoad(b.startLoad(), shown)).toBe(true)
    const bPending = b.startLoad()
    expect(
      b.applyWrite(
        'tools',
        host('foo', 'rv-3', { modeCeiling: 'manual', tools: { http_request: true } })
      )
    ).toBe(true)
    expect(b.snapshot()).toEqual(
      host(
        'foo',
        'rv-1',
        { modeCeiling: 'auto', tools: { http_request: true }, shellClassifierModel: 'judge-1' },
        'model-1'
      )
    )
    expect(
      b.applyWrite(
        'ceiling',
        host('foo', 'rv-2', { modeCeiling: 'manual', tools: { http_request: false } })
      )
    ).toBe(true)
    expect(b.snapshot()).toEqual(
      host(
        'foo',
        'rv-1',
        { modeCeiling: 'manual', tools: { http_request: true }, shellClassifierModel: 'judge-1' },
        'model-1'
      )
    )
    expect(b.applyLoad(bPending, pending)).toBe(true)
    expect(b.snapshot()).toEqual(settled)
  })

  it('only a tools write decides whether the block exists, whatever a load started before it says', () => {
    // A first save on an inheriting agent creates the block. A refresh that
    // read before the PUT must not make the agent look inheriting again.
    const tab = createApprovalTabState('foo')
    expect(tab.applyLoad(tab.startLoad(), host('foo', 'rv-1', undefined, 'model-1'))).toBe(true)
    const refresh = tab.startLoad()
    expect(
      tab.applyWrite(
        'tools',
        host('foo', 'rv-2', { defaultPolicy: 'cli_only', tools: { http_request: true } }, 'model-2')
      )
    ).toBe(true)
    expect(tab.snapshot()).toEqual(
      host('foo', 'rv-1', { defaultPolicy: 'cli_only', tools: { http_request: true } }, 'model-1')
    )
    // Another admin raises the ceiling, and "Set to Manual now" writes into
    // the new block. The refresh still has not landed.
    expect(
      tab.applyWrite(
        'ceiling',
        host(
          'foo',
          'rv-4',
          { modeCeiling: 'manual', defaultPolicy: 'cli_only', tools: { http_request: true } },
          'model-4'
        )
      )
    ).toBe(true)
    const bothGroups = {
      modeCeiling: 'manual',
      defaultPolicy: 'cli_only',
      tools: { http_request: true },
    }
    expect(tab.snapshot()).toEqual(host('foo', 'rv-1', bothGroups, 'model-1'))
    expect(tab.applyLoad(refresh, host('foo', 'rv-5', undefined, 'model-5'))).toBe(true)
    expect(tab.snapshot()).toEqual(host('foo', 'rv-5', bothGroups, 'model-5'))

    // The absence of a block is a value too: a tools write that stored none
    // (a save never does today) shows none, and the ceiling has no place.
    const other = createApprovalTabState('foo')
    const shown = host('foo', 'rv-1', { modeCeiling: 'auto', tools: { http_request: false } })
    expect(other.applyLoad(other.startLoad(), shown)).toBe(true)
    const older = other.startLoad()
    expect(other.applyWrite('tools', host('foo', 'rv-2', null))).toBe(true)
    expect(other.snapshot()).toEqual(host('foo', 'rv-1'))
    expect(other.applyLoad(older, host('foo', 'rv-3', { modeCeiling: 'manual', tools: {} }))).toBe(
      true
    )
    expect(other.snapshot()).toEqual(host('foo', 'rv-3'))

    // A ceiling write does not decide it. The switch wrote into a block that
    // was created elsewhere after this load read, so on that load the ceiling
    // has no place, and the load says whether there is a block.
    const third = createApprovalTabState('foo')
    const before = third.startLoad()
    expect(
      third.applyWrite(
        'ceiling',
        host('foo', 'rv-2', { modeCeiling: 'manual', tools: { http_request: true } })
      )
    ).toBe(true)
    expect(third.applyLoad(before, host('foo', 'rv-1', undefined))).toBe(true)
    expect(third.snapshot()).toEqual(host('foo', 'rv-1'))
  })

  it('snapshot() is null until a load lands, and a write settled before it keeps its group', () => {
    const tab = createApprovalTabState('foo')
    expect(tab.snapshot()).toBeNull()

    // "Set to Manual now" runs during the first load, on a cluster whose older
    // CRD prunes modeCeiling: an absent ceiling is Manual, and counts as stored.
    const first = tab.startLoad()
    expect(
      tab.applyWrite(
        'ceiling',
        host('foo', 'rv-2', { defaultPolicy: 'channel_users', tools: { http_request: false } })
      )
    ).toBe(true)
    expect(tab.snapshot()).toBeNull()

    // The first load, started before the switch settled, lands with the old ceiling.
    expect(
      tab.applyLoad(
        first,
        host('foo', 'rv-1', { modeCeiling: 'auto', tools: { http_request: true } }, 'model-1')
      )
    ).toBe(true)
    expect(tab.snapshot()).toEqual(
      host('foo', 'rv-1', { tools: { http_request: true } }, 'model-1')
    )

    // A load started after the switch settled takes the ceiling.
    const newest = host('foo', 'rv-3', { modeCeiling: 'allow_all', tools: {} }, 'model-3')
    expect(tab.applyLoad(tab.startLoad(), newest)).toBe(true)
    expect(tab.snapshot()).toEqual(newest)
  })
})

describe('Host-changed notice', () => {
  it('T31 a notice posted in one document reaches a listener in another', async () => {
    expect(typeof BroadcastChannel, 'Node 24 provides BroadcastChannel under jsdom').toBe(
      'function'
    )
    const other = await openAnotherDocument()
    const witness = openWitness()
    try {
      const here = vi.fn()
      const there = vi.fn()
      subscribeHostChanged('foo', here)
      // The other document only listens: subscribing opens its channel.
      other.subscribeHostChanged('foo', there)

      notifyHostChanged('foo')
      expect(here, "this document's tabs hear it at once").toHaveBeenCalledTimes(1)
      await vi.waitFor(() => expect(there).toHaveBeenCalledTimes(1))
      // The payload names the agent, and only the agent.
      await vi.waitFor(() => expect(witness.heard).toEqual([{ host: 'foo' }]))
    } finally {
      witness.channel.close()
      other.__resetHostApprovalDisplayForTests()
    }
  })

  it('a notice for another Host is ignored', async () => {
    const other = await openAnotherDocument()
    try {
      const fooHere = vi.fn()
      const barHere = vi.fn()
      const fooThere = vi.fn()
      const barThere = vi.fn()
      subscribeHostChanged('foo', fooHere)
      subscribeHostChanged('bar', barHere)
      other.subscribeHostChanged('foo', fooThere)
      other.subscribeHostChanged('bar', barThere)

      notifyHostChanged('bar')
      expect(barHere).toHaveBeenCalledTimes(1)
      expect(fooHere).not.toHaveBeenCalled()

      // foo's notice is posted after bar's, so once the other document hears
      // foo, it has heard bar too.
      notifyHostChanged('foo')
      await vi.waitFor(() => expect(fooThere).toHaveBeenCalled())
      expect(fooThere).toHaveBeenCalledTimes(1)
      expect(barThere).toHaveBeenCalledTimes(1)
      expect(fooHere).toHaveBeenCalledTimes(1)
    } finally {
      other.__resetHostApprovalDisplayForTests()
    }
  })

  it("a notice reaches this document's listeners once: its own channel does not echo it", async () => {
    const other = await openAnotherDocument()
    try {
      const here = vi.fn()
      const marker = vi.fn()
      subscribeHostChanged('foo', here)
      subscribeHostChanged('marker', marker)

      notifyHostChanged('foo')
      expect(here).toHaveBeenCalledTimes(1)
      // Posted after our notice: once it is heard here, an echo of our own
      // notice would have been heard already.
      other.notifyHostChanged('marker')
      await vi.waitFor(() => expect(marker).toHaveBeenCalledTimes(1))
      expect(here).toHaveBeenCalledTimes(1)
    } finally {
      other.__resetHostApprovalDisplayForTests()
    }
  })

  it('a notice heard from another document is not posted again', async () => {
    const remote = new BroadcastChannel(CHANNEL)
    const sends = vi.spyOn(BroadcastChannel.prototype, 'postMessage')
    try {
      const heard = vi.fn()
      subscribeHostChanged('foo', heard)
      remote.postMessage({ host: 'foo' })
      await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(1))
      // A re-post would make two browser tabs load each other forever.
      expect(sends.mock.contexts).toEqual([remote])
    } finally {
      remote.close()
    }
  })

  it('a listener that throws is reported, and the other listeners and documents still hear', async () => {
    const reported = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const witness = openWitness()
    try {
      const failure = new Error('a listener failed')
      const throwing = vi.fn(() => {
        throw failure
      })
      const after = vi.fn()
      subscribeHostChanged('foo', throwing)
      subscribeHostChanged('foo', after)

      expect(() => notifyHostChanged('foo')).not.toThrow()
      expect(throwing).toHaveBeenCalledTimes(1)
      expect(after, 'the listener after it').toHaveBeenCalledTimes(1)
      expect(reported.mock.calls).toEqual([[expect.stringContaining('listener'), failure]])
      await vi.waitFor(() => expect(witness.heard).toEqual([{ host: 'foo' }]))
    } finally {
      witness.channel.close()
    }
  })

  it('an unsubscribed listener hears no more notices', () => {
    const kept = vi.fn()
    const dropped = vi.fn()
    subscribeHostChanged('foo', kept)
    const unsubscribe = subscribeHostChanged('foo', dropped)

    notifyHostChanged('foo')
    unsubscribe()
    notifyHostChanged('foo')
    expect(dropped).toHaveBeenCalledTimes(1)
    expect(kept).toHaveBeenCalledTimes(2)
  })

  it('outside a browser, or without BroadcastChannel, a notice reaches this document only', () => {
    const sends = vi.spyOn(BroadcastChannel.prototype, 'postMessage')

    // Server rendering: no window, so no channel.
    vi.stubGlobal('window', undefined)
    const onServer = vi.fn()
    subscribeHostChanged('foo', onServer)
    notifyHostChanged('foo')
    expect(onServer).toHaveBeenCalledTimes(1)
    expect(sends).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
    __resetHostApprovalDisplayForTests()

    // A browser without BroadcastChannel.
    vi.stubGlobal('BroadcastChannel', undefined)
    const noChannel = vi.fn()
    expect(() => subscribeHostChanged('foo', noChannel)).not.toThrow()
    expect(() => notifyHostChanged('foo')).not.toThrow()
    expect(noChannel).toHaveBeenCalledTimes(1)
  })

  it('the test reset forgets every listener and closes the channel', async () => {
    const before = vi.fn()
    subscribeHostChanged('foo', before)
    const closes = vi.spyOn(BroadcastChannel.prototype, 'close')
    __resetHostApprovalDisplayForTests()
    expect(closes).toHaveBeenCalledTimes(1)
    closes.mockRestore()

    // The next notice opens a new channel: posting on the closed one would throw.
    const witness = openWitness()
    try {
      const after = vi.fn()
      subscribeHostChanged('foo', after)
      notifyHostChanged('foo')
      expect(before).not.toHaveBeenCalled()
      expect(after).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => expect(witness.heard).toEqual([{ host: 'foo' }]))
    } finally {
      witness.channel.close()
    }
  })
})
