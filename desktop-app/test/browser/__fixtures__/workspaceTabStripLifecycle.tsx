import { Profiler, StrictMode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { WorkspaceTabStrip } from '../../../ui/src/components/WorkspaceTabStrip'
import {
  createEmptyWorkspaceTabsState,
  openFilesTab,
  reorderWorkspaceTab,
  selectWorkspaceTab,
} from '../../../ui/src/lib/workspaceTabs'

let state = createEmptyWorkspaceTabsState()
let selectionCount = 0
let root = createRoot(document.getElementById('workspace-fixture')!)

function render() {
  flushSync(() => {
    root.render(
      <StrictMode>
        <Profiler id="workspace-tabs" onRender={() => window.tabOverflowObserve?.('commit')}>
          <WorkspaceTabStrip
            tabs={state.tabs}
            activeTabId={state.activeTabId}
            onClose={() => {}}
            onReorder={(id, index) => {
              state = reorderWorkspaceTab(state, id, index)
              render()
            }}
            onSelect={id => {
              selectionCount += 1
              state = selectWorkspaceTab(state, id)
              render()
            }}
          />
        </Profiler>
      </StrictMode>
    )
  })
}

function setFilesTabCount(count: number) {
  state = createEmptyWorkspaceTabsState()
  for (let index = 0; index < count; index += 1) {
    state = openFilesTab(state, {
      id: `cost-files-${index}`,
      path: `gfs://main/${index.toString(16).padStart(32, '0')}`,
    })
  }
  if (count > 0) state = selectWorkspaceTab(state, state.tabs[0]!.id)
  render()
}

Object.assign(window, {
  workspaceTabLifecycle: {
    setFilesTabCount,
    select(index: number) {
      state = selectWorkspaceTab(state, state.tabs[index]!.id)
      render()
    },
    reorder() {
      state = reorderWorkspaceTab(state, state.tabs[0]!.id, state.tabs.length - 1)
      render()
    },
    rerender: render,
    selectionCount: () => selectionCount,
    unmount() {
      flushSync(() => root.unmount())
    },
    remount() {
      root = createRoot(document.getElementById('workspace-fixture')!)
      render()
    },
  },
})
setFilesTabCount(Number(document.documentElement.dataset.filesCount ?? 40))

declare global {
  interface Window {
    tabOverflowObserve?: (kind: string, data?: Record<string, unknown>) => void
    workspaceTabLifecycle: {
      setFilesTabCount(count: number): void
      select(index: number): void
      reorder(): void
      rerender(): void
      selectionCount(): number
      unmount(): void
      remount(): void
    }
  }
}
