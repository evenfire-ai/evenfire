import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { WorkspaceTabStrip } from '../../../ui/src/components/WorkspaceTabStrip'
import {
  closeWorkspaceTab,
  createEmptyWorkspaceTabsState,
  openAppTab,
  openFilesTab,
  reorderWorkspaceTab,
  selectWorkspaceTab,
} from '../../../ui/src/lib/workspaceTabs'

let state = createEmptyWorkspaceTabsState()
let selectionCount = 0
let fileSequence = 0
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

function setFilesTabCount(count: number) {
  while (state.tabs.length > 0) {
    state = closeWorkspaceTab(state, state.tabs.at(-1)!.id)
  }
  for (let index = 0; index < count; index += 1) {
    const sequence = fileSequence++
    state = openFilesTab(state, {
      id: `files-${sequence}`,
      path: `gfs://main/${sequence.toString(16).padStart(32, '0')}`,
    })
  }
  if (state.tabs.length > 0) state = selectWorkspaceTab(state, state.tabs[0]!.id)
  render()
}

function selectTab(index: number) {
  const tab = state.tabs[index]
  if (!tab) throw new Error(`No workspace tab at index ${index}`)
  state = selectWorkspaceTab(state, tab.id)
  render()
}

Object.assign(window, {
  workspaceTabsFixture: {
    setTabCount,
    setFilesTabCount,
    selectTab,
    selectionCount: () => selectionCount,
  },
})
if (document.documentElement.dataset.filesCount !== undefined) {
  setFilesTabCount(Number(document.documentElement.dataset.filesCount))
} else {
  setTabCount(4)
}
