import { useContext, useLayoutEffect, useRef, useState } from 'react'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext/types'
import { ChatListContext } from '@contexts/ChatListContext'
import { Tabs, type TabsRef, Typography } from 'antd'
import { ChatStateBadge } from '@components/agents/ChatStateBadge'
import type { WorkspaceTab } from '@lib/workspaceTabs.types'
import type { WorkspaceTabStripProps } from './types'

export const WORKSPACE_TABS_ID = 'workspace-tabs'

type DropSide = 'before' | 'after'
type DropTarget = { id: string; side: DropSide }

/** Which half of the target tab the cursor is over — the insertion side for the drop. */
function sideFromEvent(event: React.DragEvent<HTMLElement>, target: HTMLElement): DropSide {
  const rect = target.getBoundingClientRect()
  return event.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
}

/** The selected tab and chat surface are controlled by Evenfire's workspace store. */
export function WorkspaceTabStrip({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onReorder,
  panelId,
}: WorkspaceTabStripProps) {
  const chatList = useContext(ChatListContext)
  const tabsRef = useRef<TabsRef | null>(null)
  const stripRef = useRef<HTMLDivElement | null>(null)
  const draggingIdRef = useRef<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  // Set only for a keyboard close of the active tab. Pointer close leaves focus
  // with the pointer and must not move it to another tab.
  const focusAfterActiveCloseRef = useRef(false)

  const tabIndexFromTarget = (target: EventTarget | null): number => {
    if (!(target instanceof Element)) return -1
    const tabControl = target.closest<HTMLElement>('[role="tab"]')
    if (!tabControl) return -1
    return Array.from(
      tabsRef.current?.nativeElement?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []
    ).indexOf(tabControl)
  }

  const clearDrag = () => {
    draggingIdRef.current = null
    setDraggingId(null)
    setDropTarget(null)
  }

  // Restore focus after an active tab close and connect AntD's selected tab to
  // the app-owned chat surface. AntD Tabs exposes internal pane relationships;
  // this strip deliberately keeps route content mounted in App, so its empty
  // internal panes are hidden and the actual surface owns the active relation.
  useLayoutEffect(() => {
    const root = tabsRef.current?.nativeElement
    const tabControls = Array.from(root?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])
    for (const control of tabControls) control.removeAttribute('aria-controls')

    if (panelId && activeTabId) {
      const activeIndex = tabs.findIndex(tab => tab.id === activeTabId)
      const activeControl = tabControls[activeIndex]
      if (activeControl) activeControl.setAttribute('aria-controls', panelId)
    }

    for (const [index, closeButton] of Array.from(
      root?.querySelectorAll<HTMLButtonElement>('.ant-tabs-tab-remove') ?? []
    ).entries()) {
      const tab = tabs[index]
      if (!tab) continue
      closeButton.setAttribute('aria-label', `Close ${tab.title}`)
      closeButton.setAttribute('title', `Close ${tab.title}`)
    }

    if (!focusAfterActiveCloseRef.current) return
    focusAfterActiveCloseRef.current = false
    const nextActive = root?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    ;(nextActive ?? stripRef.current)?.focus()
  }, [activeTabId, panelId, tabs])

  const handleCloseCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.detail !== 0 || activeTabId === null) return
    const target = event.target
    if (!(target instanceof Element)) return
    const closeButton = target.closest('button')
    const tabControl = closeButton?.parentElement?.querySelector<HTMLElement>('[role="tab"]')
    const index = tabControl ? tabIndexFromTarget(tabControl) : -1
    if (index >= 0 && tabs[index]?.id === activeTabId) {
      focusAfterActiveCloseRef.current = true
    }
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    const targetIndex = tabIndexFromTarget(event.target)
    const targetTab = tabs[targetIndex]
    if (!targetTab) {
      clearDrag()
      return
    }
    event.preventDefault()
    const tabControl = (event.target as Element).closest<HTMLElement>('[role="tab"]')
    const targetNode = tabControl?.parentElement ?? tabControl
    const fromId = event.dataTransfer.getData('text/plain') || draggingIdRef.current
    const side = targetNode ? sideFromEvent(event, targetNode) : 'before'
    clearDrag()
    if (!fromId || fromId === targetTab.id) return
    const fromIndex = tabs.findIndex(tab => tab.id === fromId)
    if (fromIndex < 0) return
    // The reducer's `toIndex` is the final index without the dragged tab. Removing
    // a left-side source shifts the target index left by one.
    const targetAdjusted = targetIndex - (fromIndex < targetIndex ? 1 : 0)
    onReorder(fromId, side === 'after' ? targetAdjusted + 1 : targetAdjusted)
  }

  return (
    <div
      aria-label="Workspace tabs"
      onClickCapture={handleCloseCapture}
      onDragEnd={clearDrag}
      onDragOver={event => {
        const targetIndex = tabIndexFromTarget(event.target)
        const targetTab = tabs[targetIndex]
        if (!targetTab) {
          setDropTarget(null)
          return
        }
        event.preventDefault()
        if (!draggingId || targetTab.id === draggingId) {
          setDropTarget(null)
          return
        }
        const tabControl = (event.target as Element).closest<HTMLElement>('[role="tab"]')
        const targetNode = tabControl?.parentElement ?? tabControl
        setDropTarget({
          id: targetTab.id,
          side: targetNode ? sideFromEvent(event, targetNode) : 'before',
        })
      }}
      onDragStart={event => {
        const index = tabIndexFromTarget(event.target)
        const tab = tabs[index]
        if (!tab) return
        event.dataTransfer.setData('text/plain', tab.id)
        event.dataTransfer.effectAllowed = 'move'
        draggingIdRef.current = tab.id
        setDraggingId(tab.id)
      }}
      onDrop={handleDrop}
      onKeyDownCapture={event => {
        if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
        const index = tabIndexFromTarget(event.target)
        const tab = tabs[index]
        if (!tab) return
        event.preventDefault()
        event.stopPropagation()
        onReorder(tab.id, index + (event.key === 'ArrowLeft' ? -1 : 1))
      }}
      ref={stripRef}
      role="toolbar"
      tabIndex={-1}
    >
      <Tabs
        activeKey={activeTabId ?? ''}
        hideAdd
        id={panelId ? WORKSPACE_TABS_ID : undefined}
        items={tabs.map(tab => {
          const sessionState =
            tab.kind === 'chat' && tab.chat?.agentRef && tab.chat?.chatId
              ? chatList?.sessionStateByChatKey[makeTaskKey(tab.chat.agentRef, tab.chat.chatId)]
              : undefined
          return {
            key: tab.id,
            closable: true,
            closeIcon: <span aria-hidden="true">×</span>,
            label: (
              <span
                aria-label={tab.title}
                data-workspace-dragging={draggingId === tab.id ? 'true' : undefined}
                data-workspace-drop-side={dropTarget?.id === tab.id ? dropTarget.side : undefined}
                draggable
              >
                {tab.kind === 'chat' ? (
                  <ChatStateBadge sessionState={sessionState} unreadTerminal={false} />
                ) : null}
                <Typography.Text ellipsis title={tab.title}>
                  {tab.title}
                </Typography.Text>
              </span>
            ),
            children: null,
          }
        })}
        locale={{ removeAriaLabel: 'Close tab' }}
        onChange={tabId => onSelect(tabId)}
        onTabClick={tabId => {
          // Ant Design only calls onChange when the selected key changes. The
          // existing app-tab contract also uses a click on the current tab to
          // recover a crashed or newly available embedded app.
          if (tabId === activeTabId) onSelect(tabId)
        }}
        onEdit={(key, action) => {
          if (action !== 'remove' || typeof key !== 'string') return
          onClose(key)
        }}
        ref={tabsRef}
        size="small"
        // Keep Ant Design's editable-card interactions while presenting the same flat line
        // treatment as Settings, whose tabs do not need per-tab close controls.
        styles={{
          body: { display: 'none' },
          indicator: { visibility: 'visible' },
          item: { background: 'transparent', border: 0, borderRadius: 0 },
        }}
        type="editable-card"
      />
    </div>
  )
}
