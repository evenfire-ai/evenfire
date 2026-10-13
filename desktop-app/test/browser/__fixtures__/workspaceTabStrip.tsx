import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { WorkspaceTabStrip } from '../../../ui/src/components/WorkspaceTabStrip'
import {
  closeWorkspaceTab,
  createEmptyWorkspaceTabsState,
  openAppTab,
  reorderWorkspaceTab,
  selectWorkspaceTab,
} from '../../../ui/src/lib/workspaceTabs'

let state = createEmptyWorkspaceTabsState()
let selectionCount = 0
const root = createRoot(document.getElementById('workspace-fixture')!)

function render() {
  flushSync(() => {
    root.render(
      <WorkspaceTabStrip
        activeTabId={state.activeTabId}
        tabs={state.tabs}
        onClose={id => {
          state = closeWorkspaceTab(state, id)
          render()
        }}
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
    )
  })
}

function setTabCount(count: number) {
  while (state.tabs.length > count) {
    state = closeWorkspaceTab(state, state.tabs.at(-1)!.id)
  }
  while (state.tabs.length < count) {
    const index = state.tabs.length
    state = openAppTab(state, {
      id: `focus-${index}`,
      appRef: 'example/app',
      title: `Focus ${index}`,
    })
  }
  state = selectWorkspaceTab(state, 'focus-0')
  render()
}

Object.assign(window, {
  workspaceTabsFixture: { setTabCount, selectionCount: () => selectionCount },
})
setTabCount(4)
