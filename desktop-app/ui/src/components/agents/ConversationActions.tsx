import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useAgentChatActionsContext } from '@contexts/AgentChatActionsContext'
import { useNavigationContext } from '@contexts/NavigationContext'
import { useNotificationsContext } from '@contexts/NotificationsContext'
import { ChatDeleteConfirmation } from '@components/ChatDeleteConfirmation'
import { IconButton, MenuItem, TextInput } from '@components/Common'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { useClickOutside } from '@hooks/useClickOutside'
import { useConfirmedChatDelete } from '@hooks/useConfirmedChatDelete'
import { useFlyoutPosition } from '@hooks/useFlyoutPosition'
import { useInlineRename } from '@hooks/useInlineRename'
import type { ConversationActionsProps } from './ConversationActions.types'

const RENAME_REJECTED_MESSAGE = 'Could not rename the conversation.'

const menuItemsOf = (menu: HTMLElement | null) =>
  Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])

/**
 * The chat breadcrumb's current item inside an open conversation: its title and
 * the actions that act on it — rename, delete — plus the way to the Agents
 * section.
 *
 * Mount it keyed by the conversation (`makeTaskKey`). The editor and the
 * confirmation act on the `chatId` and name the `title` of the moment they
 * opened, so switching to another conversation has to remount this and drop
 * them.
 */
export function ConversationActions({ agentRef, chatId, title }: ConversationActionsProps) {
  const { handleNavSelect } = useNavigationContext()
  const { handleRenameChatForAgent } = useAgentChatActionsContext()
  const { pushToast } = useNotificationsContext()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLSpanElement | null>(null)
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null)
  // Set when the menu was opened from the keyboard, to move focus into it once
  // it is on screen.
  const focusMenuItemRef = useRef<'first' | 'last' | null>(null)
  // Portaled and confined to the chat drawer (to the viewport outside it), the
  // way the agent selector's menu is: the drawer clips whatever passes its edge.
  const menuFlyoutPosition = useFlyoutPosition({
    anchorRef: menuTriggerRef,
    flyoutRef: menuRef,
    open: menuOpen,
    placement: 'below',
  })
  const deleteConfirmation = useConfirmedChatDelete()
  const rename = useInlineRename({
    onRename: (_key, nextTitle) => handleRenameChatForAgent(agentRef, chatId, nextTitle),
    onRejected: () => pushToast(RENAME_REJECTED_MESSAGE, 'error'),
    returnFocusToRef: menuTriggerRef,
  })
  const editing = rename.editingKey !== null

  // The menu is portaled: a press on the trigger or inside the panel is inside.
  useClickOutside([menuTriggerRef, menuRef], menuOpen, () => setMenuOpen(false))

  useEffect(() => {
    if (!menuOpen || !focusMenuItemRef.current) return
    const target = focusMenuItemRef.current
    focusMenuItemRef.current = null
    const items = menuItemsOf(menuRef.current)
    ;(target === 'first' ? items[0] : items[items.length - 1])?.focus()
  }, [menuOpen])

  const startRename = () => {
    setMenuOpen(false)
    rename.start(chatId, title)
  }

  // One handler for the trigger and the portaled panel: React events bubble
  // from a portal to its React parent.
  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLSpanElement>) => {
    if (event.key === 'Escape') {
      if (!menuOpen) return
      event.preventDefault()
      event.stopPropagation()
      setMenuOpen(false)
      menuTriggerRef.current?.focus()
      return
    }
    // Leaving by keyboard closes the menu; focus then moves on by itself.
    if (event.key === 'Tab') {
      setMenuOpen(false)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    if (!menuOpen) {
      focusMenuItemRef.current = event.key === 'ArrowDown' ? 'first' : 'last'
      setMenuOpen(true)
      return
    }
    const items = menuItemsOf(menuRef.current)
    const current = items.findIndex(item => item === document.activeElement)
    if (current < 0) {
      ;(event.key === 'ArrowDown' ? items[0] : items[items.length - 1])?.focus()
    } else {
      const step = event.key === 'ArrowDown' ? 1 : -1
      items[(current + step + items.length) % items.length]?.focus()
    }
  }

  return (
    <>
      <span className="agent-workspace-conversation-actions">
        {editing ? (
          <TextInput
            aria-label="Rename conversation"
            className="agent-workspace-conversation-rename-input"
            onBlur={rename.onBlur}
            onChange={rename.onChange}
            onKeyDown={rename.onKeyDown}
            ref={rename.inputRef}
            value={rename.value}
          />
        ) : (
          <span className="agent-workspace-conversation-title" title={title}>
            {title}
          </span>
        )}
        <span className="agent-workspace-conversation-menu" onKeyDown={handleMenuKeyDown}>
          {!editing && (
            <IconButton
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              className="agent-workspace-conversation-menu-trigger"
              color="neutral"
              label={`Conversation actions for ${title}`}
              onClick={() => setMenuOpen(open => !open)}
              ref={menuTriggerRef}
              size="xs"
              variant="ghost"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <circle cx="3.5" cy="8" r="1.2" />
                <circle cx="8" cy="8" r="1.2" />
                <circle cx="12.5" cy="8" r="1.2" />
              </svg>
            </IconButton>
          )}
          {menuOpen &&
            createPortal(
              <span
                aria-label={`Conversation actions for ${title}`}
                className="agent-workspace-conversation-menu-panel"
                ref={menuRef}
                role="menu"
                style={{
                  left: menuFlyoutPosition?.left ?? 0,
                  top: menuFlyoutPosition?.top ?? 0,
                  // Hidden at the origin until the first layout pass sets a real
                  // rect, so it never flashes in the top-left corner.
                  visibility: menuFlyoutPosition ? undefined : 'hidden',
                }}
              >
                <MenuItem
                  className="agent-workspace-conversation-menu-item"
                  onClick={startRename}
                  role="menuitem"
                >
                  Rename
                </MenuItem>
                <MenuItem
                  className="agent-workspace-conversation-menu-item"
                  onClick={() => {
                    setMenuOpen(false)
                    handleNavSelect(DESKTOP_ROUTES.agents)
                  }}
                  role="menuitem"
                >
                  Agent details
                </MenuItem>
                <MenuItem
                  className="agent-workspace-conversation-menu-item"
                  color="danger"
                  onClick={() => void deleteConfirmation.request({ agentRef, chatId, title })}
                  role="menuitem"
                >
                  Delete conversation
                </MenuItem>
              </span>,
              document.body
            )}
        </span>
      </span>
      <ChatDeleteConfirmation
        onCancel={deleteConfirmation.cancel}
        onConfirm={deleteConfirmation.confirm}
        pending={deleteConfirmation.pending}
        title="Delete conversation?"
      />
    </>
  )
}
