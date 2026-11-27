import { useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useAgentChatActionsContext } from '@contexts/AgentChatActionsContext'
import { useNavigationContext } from '@contexts/NavigationContext'
import { IconButton, MenuItem, SingleValueEditDialog } from '@components/Common'
import { ConfirmDialog } from '@components/ConfirmDialog'
import { useClickOutside } from '@hooks/useClickOutside'
import type {
  ConversationActionsProps,
  PendingConversationDelete,
} from './ConversationActions.types'

/**
 * The chat breadcrumb's current item inside an open conversation: its title and
 * the actions that act on it — rename, delete, and the agent's details.
 *
 * Mount it keyed by the conversation (`makeTaskKey`). The dialogs act on the
 * `chatId` and name the `title` of the moment they opened, so switching to
 * another conversation has to remount this and drop them.
 *
 * The dialogs portal to `<body>`. The chat header is translated away while the
 * user scrolls the thread, and a transformed ancestor becomes the containing
 * block of a `position: fixed` dialog — which would then never cover the app.
 */
export function ConversationActions({ agentRef, chatId, title }: ConversationActionsProps) {
  const { handleOpenAgentWorkspace } = useNavigationContext()
  const { captureChatDeleteFence, handleDeleteChatForAgent, handleRenameChatForAgent } =
    useAgentChatActionsContext()
  const [menuOpen, setMenuOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<PendingConversationDelete | null>(null)
  const menuRef = useRef<HTMLSpanElement | null>(null)
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null)

  useClickOutside(menuRef, menuOpen, () => setMenuOpen(false))

  const openRename = () => {
    setMenuOpen(false)
    setRenameOpen(true)
  }

  const openAgentDetails = () => {
    setMenuOpen(false)
    handleOpenAgentWorkspace(agentRef)
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
        <span className="agent-workspace-conversation-title" title={title}>
          {title}
        </span>
        <span
          className="agent-workspace-conversation-menu"
          onKeyDown={handleMenuKeyDown}
          ref={menuRef}
        >
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
          {menuOpen && (
            <span className="agent-workspace-conversation-menu-panel" role="menu">
              <MenuItem
                className="agent-workspace-conversation-menu-item"
                onClick={openRename}
                role="menuitem"
              >
                Rename
              </MenuItem>
              <MenuItem
                className="agent-workspace-conversation-menu-item"
                onClick={openAgentDetails}
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
      {renameOpen
        ? createPortal(
            <SingleValueEditDialog
              description="The title shows in the breadcrumb and the session list."
              initialValue={title}
              label="Title"
              onClose={() => setRenameOpen(false)}
              onSubmit={nextTitle => handleRenameChatForAgent(agentRef, chatId, nextTitle)}
              submitLabel="Rename"
              title="Rename conversation"
            />,
            document.body
          )
        : null}
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
