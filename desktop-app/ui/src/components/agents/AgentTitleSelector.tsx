import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Button, MenuItem } from '@components/Common'
import { useClickOutside } from '@hooks/useClickOutside'
import { useFlyoutPosition } from '@hooks/useFlyoutPosition'
import type { AgentWorkspaceRoute } from '../../uiTypes'
import { AGENT_ROUTE_LABELS, AGENT_ROUTE_OPTIONS } from './agentRoutes'

type AgentTitleSelectorOption = { id: string; label: string }

type AgentTitleSelectorProps = {
  ariaLabel: string
  emptyLabel: string
  onSelectAgent: (agentName: string) => void
  onOpenRoute: (agentName: string, route: AgentWorkspaceRoute) => void
  options: AgentTitleSelectorOption[]
  selectedId: string
  selectedLabel: string
}

// Agent selector for the new-chat greeting title row. Each row exposes TWO targets:
//   1. the agent name button  → selects the agent (starts/switches a chat)
//   2. the 3-dots button      → opens a sections sub-menu
//      (Details / Connectors / Contexts / Agent Files / Activity) that
//      navigates into that agent's workspace without switching the chat.
// `openAgent` tracks which row's sections sub-menu is expanded; only one row
// expands at a time. Clicking outside, ESC, or choosing a section closes it.
export function AgentTitleSelector({
  ariaLabel,
  emptyLabel,
  onSelectAgent,
  onOpenRoute,
  options,
  selectedId,
  selectedLabel,
}: AgentTitleSelectorProps) {
  const [open, setOpen] = useState(false)
  // Which agent row currently has its sections sub-menu open. `null` means no
  // row is expanded; the main dropdown can still be open.
  const [openAgent, setOpenAgent] = useState<string | null>(null)
  const wrapperRef = useRef<HTMLSpanElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  // The menu is portaled to document.body so the drawer's overflow-clipping
  // ancestors and the native embed can't crop it; it is positioned with a fixed
  // rect confined to the chat drawer (or the viewport in full screen).
  const menuRef = useRef<HTMLSpanElement | null>(null)
  // The nested sections sub-menu is ALSO portaled (mirroring GfsResourceMenu):
  // the menu is a scroll container (max-height + overflow), and an overflow box
  // cannot host a sub-menu that must escape it. Portaling + fixed positioning
  // keeps it fully visible and confined to the drawer/viewport. Its anchor is
  // whichever row's dots button is currently expanded.
  //
  // One anchor ref PER ROW (keyed by agent id), not a single shared ref:
  // useFlyoutPosition keys its recompute + ResizeObserver off the anchor ref's
  // identity. Jumping straight from one row to another keeps `open` true, so a
  // shared ref never changes identity and the sub-menu would stay pinned to the
  // previous row's coordinates. A distinct ref per row flips the identity, which
  // re-runs the effect and re-observes the current row's button (mirrors the
  // per-item refs in ComposerPanel).
  const submenuAnchorRefs = useRef(new Map<string, RefObject<HTMLButtonElement | null>>())
  const getSubmenuAnchorRef = useCallback((agentId: string) => {
    const existing = submenuAnchorRefs.current.get(agentId)
    if (existing) return existing
    const created: RefObject<HTMLButtonElement | null> = { current: null }
    submenuAnchorRefs.current.set(agentId, created)
    return created
  }, [])
  // A valid RefObject is required even with no row expanded (hooks are
  // unconditional); the flyout is closed then, so this ref is never read.
  const noSubmenuAnchorRef = useRef<HTMLButtonElement | null>(null)
  const submenuAnchorRef = openAgent !== null ? getSubmenuAnchorRef(openAgent) : noSubmenuAnchorRef
  const submenuRef = useRef<HTMLSpanElement | null>(null)
  const menuFlyoutPosition = useFlyoutPosition({
    anchorRef: triggerRef,
    flyoutRef: menuRef,
    open,
    placement: 'below',
  })
  const submenuFlyoutPosition = useFlyoutPosition({
    anchorRef: submenuAnchorRef,
    flyoutRef: submenuRef,
    open: open && openAgent !== null,
    placement: 'right-of',
    // The submenu anchor (a row's dots button) lives inside the menu, which is
    // portaled to document.body — so it can't reach `.chat-drawer` via
    // `closest`. Resolve the drawer bounds from the trigger, which stays in the
    // drawer tree; otherwise the submenu clamps to the viewport and can paint
    // over the native embed to the drawer's left.
    boundsAnchorRef: triggerRef,
    // The submenu anchor (a row's dots button) lives INSIDE the parent menu,
    // which is portaled and positioned by `menuFlyoutPosition`. When a resize
    // repositions the parent, React batches both flyouts' updates: the submenu
    // measures its anchor before the parent's new left/top commits, so it reads
    // the pre-move rect. The parent's move is position-only and fires no
    // ResizeObserver on the anchor, so without this the submenu keeps the stale
    // offset. Recompute once the parent's position commits.
    recomputeKey: menuFlyoutPosition,
  })

  // All three refs: the menu and its sub-menu are portaled, so a mousedown
  // inside either is outside the wrapper and would otherwise close the menu
  // before the item's click fires.
  useClickOutside([wrapperRef, menuRef, submenuRef], open, () => {
    setOpen(false)
    setOpenAgent(null)
  })

  // ESC closes everything. Mirrors AnnotationCanvas / preview keyboard UX.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (openAgent) {
          // Return focus to the row's dots button the sub-menu came from before
          // collapsing it (the ref reflects the currently expanded row).
          submenuAnchorRef.current?.focus()
          setOpenAgent(null)
        } else {
          setOpen(false)
          triggerRef.current?.focus()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, openAgent, submenuAnchorRef])

  // The menu and its sections sub-menu are portaled to document.body, so opening
  // them leaves keyboard focus on the trigger and a Tab would jump past them to
  // the next header control instead of into the menu. Move focus to the first
  // enabled item on open — mirroring GfsResourceMenu, the portaled-menu pattern
  // this component follows; ESC returns focus outward (above). Keyed on `open`
  // alone so expanding a row's sub-menu doesn't yank focus back to the main menu.
  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
  }, [open])

  useEffect(() => {
    if (!open || openAgent === null) return
    submenuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus()
  }, [open, openAgent])

  return (
    <span className="agent-title-selector" ref={wrapperRef}>
      <Button
        ref={triggerRef}
        color="transparent"
        className="agent-title-selector-trigger"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        size="sm"
        variant="text"
        onClick={() => {
          setOpen(value => !value)
          setOpenAgent(null)
        }}
      >
        <span className="agent-title-selector-trigger-label">{selectedLabel}</span>
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d={open ? 'm4.5 10 3.5-3.5L11.5 10' : 'm4.5 6 3.5 3.5L11.5 6'} />
        </svg>
      </Button>
      {open &&
        createPortal(
          <span
            className="agent-title-selector-menu"
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
            {options.length ? (
              options.map(option => {
                const isExpanded = openAgent === option.id
                const isActive = option.id === selectedId
                return (
                  <span
                    key={option.id}
                    className={`agent-title-selector-row${isActive ? ' agent-title-selector-row--active' : ''}`}
                  >
                    <button
                      type="button"
                      className="agent-title-selector-row-name"
                      role="menuitem"
                      aria-current={isActive ? 'true' : undefined}
                      onClick={() => {
                        setOpen(false)
                        setOpenAgent(null)
                        if (option.id !== selectedId) {
                          onSelectAgent(option.id)
                        }
                      }}
                    >
                      <span className="agent-title-selector-row-label">{option.label}</span>
                    </button>
                    <button
                      type="button"
                      ref={getSubmenuAnchorRef(option.id)}
                      className="agent-title-selector-row-dots"
                      role="menuitem"
                      aria-label={`Open ${option.label} sections`}
                      aria-haspopup="menu"
                      aria-expanded={isExpanded}
                      onClick={() => setOpenAgent(isExpanded ? null : option.id)}
                    >
                      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                        <circle cx="3.5" cy="8" r="1.2" />
                        <circle cx="8" cy="8" r="1.2" />
                        <circle cx="12.5" cy="8" r="1.2" />
                      </svg>
                    </button>
                  </span>
                )
              })
            ) : (
              <span className="agent-title-selector-empty">{emptyLabel}</span>
            )}
          </span>,
          document.body
        )}
      {open && openAgent !== null
        ? createPortal(
            <span
              className="agent-title-selector-submenu"
              ref={submenuRef}
              role="menu"
              style={{
                left: submenuFlyoutPosition?.left ?? 0,
                top: submenuFlyoutPosition?.top ?? 0,
                visibility: submenuFlyoutPosition ? undefined : 'hidden',
              }}
            >
              {AGENT_ROUTE_OPTIONS.map(route => (
                <MenuItem
                  key={route}
                  className="agent-title-selector-submenu-item"
                  onClick={() => {
                    setOpen(false)
                    setOpenAgent(null)
                    onOpenRoute(openAgent, route)
                  }}
                  role="menuitem"
                >
                  {AGENT_ROUTE_LABELS[route]}
                </MenuItem>
              ))}
            </span>,
            document.body
          )
        : null}
    </span>
  )
}
