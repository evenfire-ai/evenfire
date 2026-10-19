// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { ChatPage } from '../ChatPage'

const onSelectAgent = vi.fn()
let agentNames: string[] = []
let selectedAgent: string | null = null
let heldAgentRefs: string[] = []
let keepFocusedChat = false
const agentLastActiveByAgent: Record<string, string | null> = {
  'host-a': '2026-10-15T12:00:00.000Z',
  'host-b': '2026-10-15T11:00:00.000Z',
  'host-c': '2026-10-15T10:00:00.000Z',
}
const navigationReads: Array<{ selectedAgent: string | null; heldAgentRefs: string[] }> = []

vi.mock('@hooks/domain/useAgentsDataController', () => ({
  useAgentsDataController: () => ({ agentNames, loading: false, error: null }),
}))
vi.mock('@contexts/NavigationContext', () => ({
  useNavigationContext: () => {
    navigationReads.push({ selectedAgent, heldAgentRefs })
    return { selectedAgent, heldAgentRefs, keepFocusedChat, handleSelectChatAgent: onSelectAgent }
  },
}))
vi.mock('@contexts/AgentActivityContext', () => ({
  useAgentActivityContext: () => ({ agentLastActiveByAgent }),
}))
vi.mock('@components/agents/AgentWorkspace', () => ({ AgentWorkspace: () => null }))

const scrollContainerRef = { current: null }

afterEach(() => {
  cleanup()
  agentNames = []
  selectedAgent = null
  heldAgentRefs = []
  keepFocusedChat = false
  navigationReads.length = 0
  vi.clearAllMocks()
})

describe('ChatPage auto-select skips held Hosts', () => {
  it('T-H1-1: picks the next unheld Host when the most recent one is held', () => {
    agentNames = ['host-a', 'host-b', 'host-c']
    heldAgentRefs = ['host-a']

    render(<ChatPage scrollContainerRef={scrollContainerRef} />)

    expect(onSelectAgent).toHaveBeenCalledTimes(1)
    expect(onSelectAgent).toHaveBeenCalledWith('host-b', { selectLatest: false })
  })

  it('T-H1-2: selects nothing once the selection is cleared and every Host is held', () => {
    agentNames = ['host-a', 'host-b']
    const { rerender } = render(<ChatPage scrollContainerRef={scrollContainerRef} />)
    // Liveness witness: the effect is live and made the first auto-selection.
    expect(onSelectAgent).toHaveBeenCalledTimes(1)
    expect(onSelectAgent).toHaveBeenCalledWith('host-a', { selectLatest: false })

    selectedAgent = 'host-a'
    rerender(<ChatPage scrollContainerRef={scrollContainerRef} />)
    selectedAgent = null
    heldAgentRefs = ['host-a', 'host-b']
    rerender(<ChatPage scrollContainerRef={scrollContainerRef} />)

    // Liveness witness: the re-render with the cleared selection happened.
    expect(navigationReads.at(-1)).toEqual({
      selectedAgent: null,
      heldAgentRefs: ['host-a', 'host-b'],
    })
    expect(onSelectAgent).toHaveBeenCalledTimes(1)
  })

  it('T-R1H1-3: selects no Host while the focused chat is kept, and selects one once it is not', () => {
    agentNames = ['host-a', 'host-b']
    keepFocusedChat = true
    const { rerender } = render(<ChatPage scrollContainerRef={scrollContainerRef} />)
    expect(onSelectAgent).not.toHaveBeenCalled()

    keepFocusedChat = false
    rerender(<ChatPage scrollContainerRef={scrollContainerRef} />)

    // Liveness witness: the same effect selects as soon as the flag clears.
    expect(onSelectAgent).toHaveBeenCalledTimes(1)
    expect(onSelectAgent).toHaveBeenCalledWith('host-a', { selectLatest: false })
  })
})
