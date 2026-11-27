import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useAgentChatActionsContext } from '@contexts/AgentChatActionsContext'
import { useNavigationContext } from '@contexts/NavigationContext'
import { IconButton, MenuItem } from '@components/Common'
import { ConfirmDialog } from '@components/ConfirmDialog'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { useClickOutside } from '@hooks/useClickOutside'
import type {
  ConversationActionsProps,
  PendingConversationDelete,
} from './ConversationActions.types'

/**
 * The chat breadcrumb's current item inside an open conversation: its title and
 * the actions that act on it — rename, delete — plus the way to the Agents
 * section.
 *
 * Mount it keyed by the conversation (`makeTaskKey`). The editor and the
 * confirmation act on the `chatId` and name the `title` of the moment they
 * opened, so switching to another conversation has to remount this and drop
 * them.
 *
 * The delete confirmation portals to `<body>`. The chat header is translated
 * away while the user scrolls the thread, and a transformed ancestor becomes
 * the containing block of a `position: fixed` dialog — which would then never
 * cover the app.
 */
export function ConversationActions({ agentRef, chatId, title }: ConversationActionsProps) {
  const { handleNavSelect } = useNavigationContext()
  const { captureChatDeleteFence, handleDeleteChatForAgent, handleRenameChatForAgent } =
    useAgentChatActionsContext()
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const renameClosedRef = useRef(true)
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  const [pendingDelete, setPendingDelete] = useState<PendingConversationDelete | null>(null)
  const menuRef = useRef<HTMLSpanElement | null>(null)
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null)

  useClickOutside(menuRef, menuOpen, () => setMenuOpen(false))

  useEffect(() => {
    if (!renaming) return
    renameInputRef.current?.focus()
    renameInputRef.current?.select()
  }, [renaming])

  const startRename = () => {
    setMenuOpen(false)
    renameClosedRef.current = false
    setRenameValue(title)
    setRenaming(true)
  }

  const stopRename = () => {
    renameClosedRef.current = true
    setRenaming(false)
  }

  // Enter and blur save, Escape only closes. Once editing is closed a later
  // blur is a no-op, so Escape can never save.
  const commitRename = () => {
    if (renameClosedRef.current) return
    const nextTitle = renameValue.trim()
    stopRename()
    if (!nextTitle || nextTitle === title) return
    void handleRenameChatForAgent(agentRef, chatId, nextTitle)
  }

  const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitRename()
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      stopRename()
    }
  }

  // The fence is captured before the confirmation, so a confirmed delete is
  // bound to the access the user held when they asked for it.
  const requestDelete = async () => {
    setMenuOpen(false)
    try {
      const deletion = await captureChatDeleteFence(agentRef)
      setPendingDelete({ chatId, title, deletion })
    } catch {
      // captureChatDeleteFence reports the failure through the shared chat toast.
    }
  }

  const confirmDelete = async (target: PendingConversationDelete) => {
    try {
      await handleDeleteChatForAgent(agentRef, target.chatId, target.deletion)
    } finally {
      setPendingDelete(null)
    }
  }

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== 'Escape' || !menuOpen) return
    event.preventDefault()
    event.stopPropagation()
    setMenuOpen(false)
    menuTriggerRef.current?.focus()
  }

  return (
    <>
      <span className="agent-workspace-conversation-actions">
        {renaming ? (
          <input
            aria-label="Rename conversation"
            className="agent-workspace-conversation-rename-input"
            onBlur={commitRename}
            onChange={event => setRenameValue(event.currentTarget.value)}
            onKeyDown={handleRenameKeyDown}
            ref={renameInputRef}
            value={renameValue}
          />
        ) : (
          <span className="agent-workspace-conversation-title" title={title}>
            {title}
          </span>
        )}
        <span
          className="agent-workspace-conversation-menu"
          onKeyDown={handleMenuKeyDown}
          ref={menuRef}
        >
          {!renaming && (
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
          {menuOpen && (
            <span className="agent-workspace-conversation-menu-panel" role="menu">
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
                onClick={() => void requestDelete()}
                role="menuitem"
              >
                Delete conversation
              </MenuItem>
            </span>
          )}
        </span>
      </span>
      {pendingDelete
        ? createPortal(
            <ConfirmDialog
              body={
                <>
                  Delete <strong>{pendingDelete.title}</strong>? Messages cannot be recovered.
                </>
              }
              confirmLabel="Delete"
              onCancel={() => setPendingDelete(null)}
              onConfirm={() => confirmDelete(pendingDelete)}
              title="Delete conversation?"
              tone="danger"
            />,
            document.body
          )
        : null}
    </>
  )
}
