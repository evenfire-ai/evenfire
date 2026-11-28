import { createContext, useContext, useEffect, useState } from 'react'
import type { PropsWithChildren } from 'react'

export type Seed = {
  names: Record<string, string>
  refs: string[]
  sessions: Array<{ agentRef: string; id: string; title: string }>
}
type Event = { action: string; ref: string; id?: string }
type State = {
  seed: Seed
  nav: 'agents' | 'chat'
  selected: string | null
  active: string | null
  navigate: (nav: 'agents' | 'chat') => void
  select: (ref: string, options?: { chatId?: string }) => void
  create: () => void
}
declare global {
  interface Window {
    __identitySeed: Seed
    __identityControl: { events: Event[]; refresh: (names: Record<string, string>) => void }
  }
}
const Context = createContext<State | null>(null)
export const useFixture = () => {
  const state = useContext(Context)
  if (!state) throw new Error('Identity fixture provider missing')
  return state
}
const events: Event[] = []
export function FixtureProvider({ children }: PropsWithChildren) {
  const [seed, setSeed] = useState(window.__identitySeed)
  const [nav, setNav] = useState<'agents' | 'chat'>('agents')
  const [selected, setSelected] = useState<string | null>(null)
  const [active, setActive] = useState<string | null>(null)
  useEffect(() => {
    window.__identityControl = {
      events,
      refresh: names => setSeed(current => ({ ...current, names })),
    }
    // This is the test bridge boundary; the components themselves are production code.
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        access: {
          refreshCatalog: async () => ({ agentNames: seed.refs, agentDisplayByName: seed.names }),
        },
      },
    })
  }, [seed])
  return (
    <Context.Provider
      value={{
        seed,
        nav,
        selected,
        active,
        navigate: setNav,
        select: (ref, options) => {
          events.push({ action: 'select', ref, id: options?.chatId })
          setSelected(ref)
          setActive(options?.chatId ?? null)
          if (options?.chatId) setNav('chat')
        },
        create: () => {
          if (!selected) throw new Error('New chat without selected agent')
          events.push({ action: 'create', ref: selected })
          setActive(null)
          setNav('chat')
        },
      }}
    >
      {children}
    </Context.Provider>
  )
}
const hydrate = async () => undefined
export function useAgentsDataController() {
  const { seed } = useFixture()
  return {
    agentNames: seed.refs,
    agentDisplayByName: seed.names,
    userAgentNames: seed.refs,
    teamAgentNames: [],
  }
}
export function useTeamsDataController() {
  return { teams: [], teamDirectory: {}, ensureHydrated: hydrate }
}
export function useMcpServersDataController() {
  const { seed } = useFixture()
  return {
    agentMcpServerCountByAgent: Object.fromEntries(seed.refs.map(ref => [ref, 0])),
    agentMcpServersByAgent: {},
    mcpServerMappingUnavailableMessage: 'fixture mapping unavailable',
  }
}
export function useNavigationContext() {
  const state = useFixture()
  return {
    selectedAgent: state.selected,
    handleSelectChatAgent: state.select,
    handleOpenAgentWorkspace: (ref: string) => {
      state.select(ref)
    },
  }
}
export function useAuthContext() {
  return {
    busy: false,
    me: { id: 'fixture-user', name: 'Fixture User' },
    handleLogout: () => undefined,
  }
}
export function useAgentActivityContext() {
  return { agentLastActiveByAgent: {} }
}
export function useChatListContext() {
  const { seed, active } = useFixture()
  return {
    activeChatId: active,
    latestChatSessions: seed.sessions,
    latestChatSessionsLoading: false,
    sessionStateByChatKey: {},
  }
}
export function useAgentChatActionsContext() {
  const { create } = useFixture()
  return { handleCreateChat: create }
}
