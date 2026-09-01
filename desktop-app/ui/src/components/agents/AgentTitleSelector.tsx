import { useEffect, useRef, useState } from 'react'
import { Button, MenuItem } from '@components/Common'
import { useClickOutside } from '@hooks/useClickOutside'
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

// Agent selector for the new-chat landing. Each row exposes TWO targets:
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

  useClickOutside(wrapperRef, open, () => {
    setOpen(false)
    setOpenAgent(null)
  })

  // ESC closes everything. Mirrors AnnotationCanvas / preview keyboard UX.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (openAgent) {
          setOpenAgent(null)
        } else {
          setOpen(false)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, openAgent])

  return (
    <span className="agent-title-selector" ref={wrapperRef}>
      <Button
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
      {open && (
        <span className="agent-title-selector-menu" role="menu">
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
                  {isExpanded ? (
                    <span className="agent-title-selector-submenu" role="menu">
                      {AGENT_ROUTE_OPTIONS.map(route => (
                        <MenuItem
                          key={route}
                          className="agent-title-selector-submenu-item"
                          onClick={() => {
                            setOpen(false)
                            setOpenAgent(null)
                            onOpenRoute(option.id, route)
                          }}
                          role="menuitem"
                        >
                          {AGENT_ROUTE_LABELS[route]}
                        </MenuItem>
                      ))}
                    </span>
                  ) : null}
                </span>
              )
            })
          ) : (
            <span className="agent-title-selector-empty">{emptyLabel}</span>
          )}
        </span>
      )}
    </span>
  )
}
