import { createRoot } from 'react-dom/client'
import { SidebarNav } from '@components/SidebarNav'
import { AgentTitleSelector } from '@components/agents/AgentTitleSelector'
import { FleetBoard } from '@components/agents/FleetBoard'
import '../../../../ui/src/styles.css'
import '../../../../ui/src/styles/tokens.css'
import { FixtureProvider, useFixture } from './adapter'

function Renderer() {
  const state = useFixture()
  return (
    <div className="app-frame">
      <SidebarNav
        navItem={state.nav}
        collapsed={false}
        compactMode={false}
        compactMenuOpen={false}
        onCompactMenuOpenChange={() => undefined}
        activeSandboxUiApp={null}
        availableSandboxUiApps={[]}
        onCollapsedChange={() => undefined}
        onNewChat={state.create}
        onOpenSandboxUiApp={() => undefined}
        onSelect={item => {
          if (item === 'agents' || item === 'chat') state.navigate(item)
        }}
        onOpenFilesSection={() => undefined}
        onOpenPreviewSection={() => undefined}
        pushToast={() => undefined}
      />
      <main>
        {state.nav === 'agents' ? (
          <FleetBoard />
        ) : (
          <>
            <AgentTitleSelector
              ariaLabel="Switch chat agent"
              emptyLabel="Choose agent"
              options={state.seed.refs.map(id => ({ id, label: state.seed.names[id] ?? id }))}
              selectedId={state.selected ?? ''}
              selectedLabel={state.seed.names[state.selected ?? ''] ?? state.selected ?? ''}
              onSelectAgent={state.select}
              onOpenRoute={ref => state.select(ref)}
            />
            <textarea data-testid="chat-input" aria-label="Agent message composer" />
          </>
        )}
      </main>
    </div>
  )
}
createRoot(document.getElementById('root')!).render(
  <FixtureProvider>
    <Renderer />
  </FixtureProvider>
)
