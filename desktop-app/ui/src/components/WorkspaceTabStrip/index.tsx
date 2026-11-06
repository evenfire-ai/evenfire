import { useContext, useLayoutEffect, useRef, useState } from 'react'
import { LeftOutlined, RightOutlined } from '@ant-design/icons'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext/types'
import { ChatListContext } from '@contexts/ChatListContext'
import { Button, Tabs } from 'antd'
import { ChatStateBadge } from '@components/agents/ChatStateBadge'
import type { WorkspaceTab } from '@lib/workspaceTabs.types'
import type { WorkspaceTabStripProps } from './types'
import { useWorkspaceTabOverflow } from './useWorkspaceTabOverflow'

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
  const stripRef = useRef<HTMLDivElement | null>(null)
  const draggingIdRef = useRef<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [focusedTabId, setFocusedTabId] = useState<string | null>(activeTabId)
  const keyboardFocusPendingRef = useRef(false)
  const previousProjectedActiveRef = useRef(activeTabId)
  const { scrollerRef, hasOverflow, leftButtonProps, rightButtonProps, requestFocusReveal } =
    useWorkspaceTabOverflow({ tabs, activeTabId, stripRef })
  // Keyboard close transfers focus from a removed control to a surviving tab.
  // Pointer close leaves focus with the pointer and must not force a transfer.
  const focusAfterKeyboardCloseRef = useRef(false)

  const tabIndexFromTarget = (target: EventTarget | null): number => {
    if (!(target instanceof Element)) return -1
    const tabControl = target.closest<HTMLElement>('[role="tab"]')
    const tabId =
      tabControl?.dataset.workspaceTabId ??
      target.closest<HTMLElement>('[data-workspace-tab-id]')?.dataset.workspaceTabId
    return tabId ? tabs.findIndex(tab => tab.id === tabId) : -1
  }

  const focusTab = (id: string) => {
    keyboardFocusPendingRef.current = true
    setFocusedTabId(id)
    const target = Array.from(
      stripRef.current?.querySelectorAll<HTMLElement>('[data-workspace-tab-id] [role="tab"]') ?? []
    ).find(control => control.dataset.workspaceTabId === id)
    target?.focus({ preventScroll: true })
  }

  const handleTabKeyDown = (
    event: React.KeyboardEvent<HTMLElement>,
    tabId: string,
    index: number
  ) => {
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault()
      event.stopPropagation()
      onReorder(tabId, index + (event.key === 'ArrowLeft' ? -1 : 1))
      return
    }
    if (!tabs.length) return
    let nextIndex: number | null = null
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length
    else if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = tabs.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    const nextTab = tabs[nextIndex]
    if (nextTab) focusTab(nextTab.id)
  }

  const clearDrag = () => {
    draggingIdRef.current = null
    setDraggingId(null)
    setDropTarget(null)
  }

  // Restore focus after a keyboard tab close and connect AntD's selected tab to
  // the app-owned chat surface. AntD Tabs exposes internal pane relationships;
  // this strip deliberately keeps route content mounted in App, so its empty
  // internal panes are hidden and the actual surface owns the active relation.
  useLayoutEffect(() => {
    if (previousProjectedActiveRef.current !== activeTabId) {
      previousProjectedActiveRef.current = activeTabId
      if (activeTabId && tabs.some(tab => tab.id === activeTabId)) {
        setFocusedTabId(activeTabId)
        return
      }
    }
    if (!tabs.some(tab => tab.id === focusedTabId)) {
      setFocusedTabId(
        activeTabId && tabs.some(tab => tab.id === activeTabId)
          ? activeTabId
          : (tabs[0]?.id ?? null)
      )
    }
  }, [activeTabId, focusedTabId, tabs])

  useLayoutEffect(() => {
    if (!focusAfterKeyboardCloseRef.current) return
    focusAfterKeyboardCloseRef.current = false
    const nextActive = stripRef.current?.querySelector<HTMLElement>(
      '.chat-view-tab.is-active .chat-view-tab__select'
    )
    const nextRoving = stripRef.current?.querySelector<HTMLElement>(
      '[data-workspace-tab-id] [role="tab"]'
    )
    const focusTarget = nextActive ?? nextRoving ?? stripRef.current
    if (nextRoving && !nextActive) setFocusedTabId(nextRoving.dataset.workspaceTabId ?? null)
    focusTarget?.focus({ preventScroll: true })
  }, [activeTabId, tabs])

  const handleCloseCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.detail !== 0) return
    const target = event.target
    if (!(target instanceof Element)) return
    const closeButton = target.closest('button')
    if (!closeButton || closeButton !== document.activeElement) return
    const tab = closeButton.closest<HTMLElement>('.chat-view-tab')
    if (
      tab &&
      tab.dataset.workspaceTabId &&
      tabs.some(item => item.id === tab.dataset.workspaceTabId)
    ) {
      focusAfterKeyboardCloseRef.current = true
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
    const targetNode = (event.target as Element).closest<HTMLElement>('.chat-view-tab')
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
    <div onClickCapture={handleCloseCapture}>
      <Tabs
        activeKey={activeTabId ?? ''}
        hideAdd
        id={panelId ? WORKSPACE_TABS_ID : undefined}
        items={tabs.map(tab => ({ key: tab.id, closable: true, label: tab.title, children: null }))}
        locale={{ removeAriaLabel: 'Close tab' }}
        onChange={tabId => onSelect(tabId)}
        onTabClick={tabId => {
          if (tabId === activeTabId) onSelect(tabId)
        }}
        onEdit={(key, action) => {
          if (action !== 'remove' || typeof key !== 'string') return
          onClose(key)
        }}
        renderTabBar={tabBarProps => (
          <div
            aria-label="Workspace tabs"
            className="chat-view-tabs"
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
              const targetNode = (event.target as Element).closest<HTMLElement>('.chat-view-tab')
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
            ref={stripRef}
            role="toolbar"
            tabIndex={-1}
          >
            {hasOverflow && (
              <Button
                {...leftButtonProps}
                aria-label="Scroll tabs left"
                className="chat-view-tabs__scroll-button"
                icon={<LeftOutlined />}
                size="small"
                type="text"
              />
            )}
            <div className="chat-view-tabs__scroller" ref={scrollerRef}>
              <div
                aria-label="Workspace tabs"
                aria-orientation="horizontal"
                className="chat-view-tabs__list"
                role="tablist"
              >
                {tabs.map((tab, index) => {
                  const isActive = tab.id === activeTabId
                  const isFocused = tab.id === focusedTabId
                  const rowSessionState =
                    tab.kind === 'chat' && tab.chat?.agentRef && tab.chat?.chatId
                      ? chatList?.sessionStateByChatKey[
                          makeTaskKey(tab.chat.agentRef, tab.chat.chatId)
                        ]
                      : undefined
                  return (
                    <div
                      className={`chat-view-tab${isActive ? ' is-active' : ''}${
                        draggingId === tab.id ? ' is-dragging' : ''
                      }${
                        dropTarget?.id === tab.id && dropTarget.side === 'before'
                          ? ' is-drop-before'
                          : ''
                      }${
                        dropTarget?.id === tab.id && dropTarget.side === 'after'
                          ? ' is-drop-after'
                          : ''
                      }`}
                      data-workspace-tab-id={tab.id}
                      draggable
                      key={tab.id}
                    >
                      <Button
                        aria-label={tab.title}
                        aria-controls={isActive ? panelId : undefined}
                        id={`${tabBarProps.id}-tab-${tab.id}`}
                        aria-posinset={index + 1}
                        aria-selected={isActive}
                        aria-setsize={tabs.length}
                        className="chat-view-tab__select"
                        data-workspace-dragging={draggingId === tab.id ? 'true' : undefined}
                        data-workspace-drop-side={
                          dropTarget?.id === tab.id ? dropTarget.side : undefined
                        }
                        data-workspace-tab-id={tab.id}
                        onClick={event => tabBarProps.onTabClick(tab.id, event)}
                        onFocus={event => {
                          setFocusedTabId(tab.id)
                          const keyboardFocus =
                            keyboardFocusPendingRef.current ||
                            event.currentTarget.matches(':focus-visible')
                          keyboardFocusPendingRef.current = false
                          if (keyboardFocus) requestFocusReveal(tab.id)
                        }}
                        onKeyDown={event => handleTabKeyDown(event, tab.id, index)}
                        onPointerDown={() => {
                          keyboardFocusPendingRef.current = false
                        }}
                        role="tab"
                        size="small"
                        tabIndex={isFocused ? 0 : -1}
                        type={isActive ? 'primary' : 'default'}
                      >
                        {tab.kind === 'chat' ? (
                          <ChatStateBadge sessionState={rowSessionState} unreadTerminal={false} />
                        ) : null}
                        <span className="chat-view-tab__label" title={tab.title}>
                          {tab.title}
                        </span>
                      </Button>
                      <Button
                        aria-label={`Close ${tab.title}`}
                        className="chat-view-tab__close"
                        onClick={event =>
                          tabBarProps.editable.onEdit('remove', { key: tab.id, event })
                        }
                        size="small"
                        type="text"
                      >
                        <span aria-hidden="true">×</span>
                      </Button>
                    </div>
                  )
                })}
              </div>
            </div>
            {hasOverflow && (
              <Button
                {...rightButtonProps}
                aria-label="Scroll tabs right"
                className="chat-view-tabs__scroll-button"
                icon={<RightOutlined />}
                size="small"
                type="text"
              />
            )}
          </div>
        )}
        size="small"
        styles={{ body: { display: 'none' } }}
        type="editable-card"
      />
    </div>
  )
}
