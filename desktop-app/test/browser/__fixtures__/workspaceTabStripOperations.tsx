import { StrictMode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { WorkspaceTabStrip } from '../../../ui/src/components/WorkspaceTabStrip'
import {
  createEmptyWorkspaceTabsState,
  openAppTab,
  openFilesTab,
  selectWorkspaceTab,
} from '../../../ui/src/lib/workspaceTabs'

// R6-L2 only: real producers and the same StrictMode boundary as renderer main.tsx.
let state = createEmptyWorkspaceTabsState()
const count = Number(document.documentElement.dataset.tabCount ?? 4)
for (let index = 0; index < count; index += 1) {
  const id = `operation-${index}`
  state =
    document.documentElement.dataset.tabKind === 'app'
      ? openAppTab(state, { id, appRef: 'example/app', title: `Focus ${index}` })
      : openFilesTab(state, { id, path: `gfs://main/${index.toString(16).padStart(32, '0')}` })
}
state = selectWorkspaceTab(state, 'operation-0')
const root = createRoot(document.getElementById('workspace-fixture')!)
flushSync(() =>
  root.render(
    <StrictMode>
      <WorkspaceTabStrip
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        onSelect={() => {
          throw new Error('Unexpected operations fixture selection')
        }}
        onClose={() => {
          throw new Error('Unexpected operations fixture close')
        }}
        onReorder={() => {
          throw new Error('Unexpected operations fixture reorder')
        }}
      />
    </StrictMode>
  )
)
