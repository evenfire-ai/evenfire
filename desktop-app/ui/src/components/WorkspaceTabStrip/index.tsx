import { useContext, useLayoutEffect, useRef, useState } from 'react'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext/types'
import { ChatListContext } from '@contexts/ChatListContext'
import { Button } from '@components/Common'
import { ChatStateBadge } from '@components/agents/ChatStateBadge'
import type { WorkspaceTab } from '@lib/workspaceTabs.types'
import type { WorkspaceTabStripProps } from './types'

type DropSide = 'before' | 'after'
type DropTarget = { id: string; side: DropSide }

/** Which half of a tab the cursor is over — the insertion side for the drop. */
function sideFromEvent(event: React.DragEvent<HTMLElement>): DropSide {
  const rect = event.currentTarget.getBoundingClientRect()
  return event.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
}

/**
 * The single global workspace strip (spec 01 §4.2, mini-spec 03 §3). It renders
 * every tab in the universal store — chat, app, files, settings — and is the
 * only tab strip in the app (it absorbs the old chat-only `ChatTabs`). Chat tabs
 * show their live session badge via `sessionStateByChatKey`, exactly as the
 * former strip did; non-chat tabs carry no badge. Selecting a tab activates it
 * (the seam derives the route from the active tab); the close control removes it.
 *
 * Tabs reorder by native HTML5 drag & drop (mouse) and by Alt+ArrowLeft/Right
 * on the focused select control (keyboard). The drag ghost / drop-indicator
 * feedback is local UI state only; the order itself lives in the store via
 * `onReorder`, which never changes which tab is active.
 */
export function WorkspaceTabStrip({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onReorder,
  panelId,
}: WorkspaceTabStripProps) {
  const chatList = useContext(ChatListContext)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const stripRef = useRef<HTMLDivElement | null>(null)
  // Set when a KEYBOARD close removes the active tab's control: the close, unlike a
  // reorder, drops the keyed node the user was on, so focus would fall to <body>.
  // Consumed by the layout effect once the neighbour becomes active this commit.
  const focusAfterActiveCloseRef = useRef(false)

  const clearDrag = () => {
    setDraggingId(null)
    setDropTarget(null)
  }

  // Restore keyboard focus after a close removed the active tab. The reorder path
  // keeps focus for free (the moved node survives, keyed by id); the close does not,
  // so move focus to whichever tab took over — or to the strip itself when the
  // workspace is now empty — rather than letting it drop to <body>.
  useLayoutEffect(() => {
    if (!focusAfterActiveCloseRef.current) return
    focusAfterActiveCloseRef.current = false
    const strip = stripRef.current
    if (!strip) return
    const nextActive = strip.querySelector<HTMLElement>(
      '.chat-view-tab.is-active .chat-view-tab__select'
    )
    ;(nextActive ?? strip).focus()
  }, [activeTabId])

  const handleCloseClick = (event: React.MouseEvent<HTMLButtonElement>, tab: WorkspaceTab) => {
    // Enter/Space on a button reports `detail === 0`; a pointer click reports >= 1.
    // Only manage focus for keyboard users closing the ACTIVE tab: a pointer user
    // does not need it, and forcing focus on click could surprise them.
    if (event.detail === 0 && tab.id === activeTabId) {
      focusAfterActiveCloseRef.current = true
    }
    onClose(tab.id)
  }

  const handleDrop = (event: React.DragEvent<HTMLElement>, target: WorkspaceTab) => {
    event.preventDefault()
    const fromId = event.dataTransfer.getData('text/plain') || draggingId
    const side = sideFromEvent(event)
    clearDrag()
    if (!fromId || fromId === target.id) return
    const fromIndex = tabs.findIndex(tab => tab.id === fromId)
    const targetIndex = tabs.findIndex(tab => tab.id === target.id)
    if (fromIndex < 0 || targetIndex < 0) return
    // The reducer's `toIndex` is the final index in the array WITHOUT the dragged
    // tab: when the dragged tab sits before the target, removing it shifts the
    // target left by one, so the drop slot moves with it.
    const targetAdjusted = targetIndex - (fromIndex < targetIndex ? 1 : 0)
    onReorder(fromId, side === 'after' ? targetAdjusted + 1 : targetAdjusted)
  }

  const handleSelectKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    tab: WorkspaceTab,
    index: number
  ) => {
    if (!event.altKey) return
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      onReorder(tab.id, index - 1)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      onReorder(tab.id, index + 1)
    }
  }

  return (
    <div
      className="chat-view-tabs"
      role="toolbar"
      aria-label="Workspace tabs"
      ref={stripRef}
      tabIndex={-1}
    >
      <div className="chat-view-tabs__scroller">
        <div className="chat-view-tabs__list">
          {tabs.map((tab, index) => {
            const active = tab.id === activeTabId
            const sessionState =
              tab.kind === 'chat' && tab.chat?.agentRef && tab.chat?.chatId
                ? chatList?.sessionStateByChatKey[makeTaskKey(tab.chat.agentRef, tab.chat.chatId)]
                : undefined
            const drop = dropTarget?.id === tab.id ? dropTarget.side : undefined
            const className =
              `chat-view-tab${active ? ' is-active' : ''}` +
              `${draggingId === tab.id ? ' is-dragging' : ''}` +
              `${drop === 'before' ? ' is-drop-before' : ''}` +
              `${drop === 'after' ? ' is-drop-after' : ''}`
            return (
              <div
                className={className}
                draggable
                key={tab.id}
                onDragEnd={clearDrag}
                onDragOver={event => {
                  // preventDefault always, so a drop on the source tab is a valid
                  // (no-op) target; but don't paint a drop indicator on the tab
                  // being dragged — it would show `is-dragging` and `is-drop-*`
                  // at once.
                  event.preventDefault()
                  if (tab.id === draggingId) {
                    setDropTarget(null)
                    return
                  }
                  setDropTarget({ id: tab.id, side: sideFromEvent(event) })
                }}
                onDragStart={event => {
                  event.dataTransfer.setData('text/plain', tab.id)
                  event.dataTransfer.effectAllowed = 'move'
                  setDraggingId(tab.id)
                }}
                onDrop={event => handleDrop(event, tab)}
              >
                <Button
                  align="start"
                  aria-controls={active ? panelId : undefined}
                  aria-label={tab.title}
                  aria-pressed={active}
                  className="chat-view-tab__select"
                  color="neutral"
                  onClick={() => onSelect(tab.id)}
                  onKeyDown={event => handleSelectKeyDown(event, tab, index)}
                  size="sm"
                  variant="ghost"
                >
                  {tab.kind === 'chat' && (
                    <ChatStateBadge sessionState={sessionState} unreadTerminal={false} />
                  )}
                  <span className="chat-view-tab__label">{tab.title}</span>
                </Button>
                <Button
                  aria-label={`Close ${tab.title}`}
                  className="chat-view-tab__close"
                  color="neutral"
                  onClick={event => handleCloseClick(event, tab)}
                  size="xs"
                  variant="ghost"
                >
                  <span aria-hidden="true">×</span>
                </Button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
