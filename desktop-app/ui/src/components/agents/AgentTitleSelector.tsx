import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Dropdown, Flex } from 'antd'
import type { MenuProps } from 'antd'
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

// The selected-agent action and its section actions remain separate targets.
// Ant Design owns the menu presentation, portal, dismissal, keyboard handling,
// and focus restoration; these callbacks still own navigation and selection.
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
  const [openAgent, setOpenAgent] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement | HTMLAnchorElement>(null)
  const sectionTriggerRefs = useRef(new Map<string, HTMLButtonElement | HTMLAnchorElement>())

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => {
      document
        .querySelector('.ant-dropdown-menu')
        ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
        ?.focus()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!open || openAgent === null) return
    const timer = window.setTimeout(() => {
      document
        .querySelectorAll('.ant-dropdown-menu')[1]
        ?.querySelector<HTMLElement>('[role="menuitem"]')
        ?.focus()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [open, openAgent])

  const items = useMemo<MenuProps['items']>(
    () =>
      options.length
        ? options.map(option => {
            const selected = option.id === selectedId
            const routeItems: MenuProps['items'] = AGENT_ROUTE_OPTIONS.map(route => ({
              key: route,
              label: AGENT_ROUTE_LABELS[route],
              onClick: () => {
                setOpen(false)
                setOpenAgent(null)
                onOpenRoute(option.id, route)
              },
            }))
            const handleRouteMenuKeyDown: NonNullable<MenuProps['onKeyDown']> = event => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              event.stopPropagation()
              sectionTriggerRefs.current.get(option.id)?.focus()
              setOpenAgent(null)
            }

            return {
              key: option.id,
              label: (
                <Flex align="center" justify="space-between" gap="small">
                  <Button
                    type="text"
                    htmlType="button"
                    aria-current={selected ? 'true' : undefined}
                    onClick={event => {
                      event.stopPropagation()
                      setOpen(false)
                      setOpenAgent(null)
                      if (!selected) onSelectAgent(option.id)
                    }}
                  >
                    {option.label}
                  </Button>
                  <Dropdown
                    trigger={['click']}
                    placement="rightTop"
                    autoFocus
                    destroyOnHidden
                    open={openAgent === option.id}
                    onOpenChange={nextOpen => setOpenAgent(nextOpen ? option.id : null)}
                    menu={{ items: routeItems, onKeyDown: handleRouteMenuKeyDown }}
                  >
                    <Button
                      ref={node => {
                        if (node) sectionTriggerRefs.current.set(option.id, node)
                        else sectionTriggerRefs.current.delete(option.id)
                      }}
                      className="agent-title-selector-row-dots"
                      type="text"
                      htmlType="button"
                      aria-label={`Open ${option.label} sections`}
                      aria-haspopup="menu"
                      aria-expanded={openAgent === option.id}
                      icon={
                        <svg
                          viewBox="0 0 16 16"
                          width={16}
                          height={16}
                          fill="currentColor"
                          aria-hidden="true"
                          focusable="false"
                        >
                          <circle cx="3.5" cy="8" r="1.2" />
                          <circle cx="8" cy="8" r="1.2" />
                          <circle cx="12.5" cy="8" r="1.2" />
                        </svg>
                      }
                      onClick={event => event.stopPropagation()}
                    />
                  </Dropdown>
                </Flex>
              ),
            }
          })
        : [{ key: '__empty__', label: emptyLabel, disabled: true }],
    [emptyLabel, onOpenRoute, onSelectAgent, openAgent, options, selectedId]
  )

  return (
    <Dropdown
      trigger={['click']}
      placement="bottomLeft"
      autoFocus
      destroyOnHidden
      open={open}
      onOpenChange={nextOpen => {
        setOpen(nextOpen)
        if (!nextOpen) setOpenAgent(null)
      }}
      menu={{ items }}
    >
      <Button
        ref={triggerRef}
        className="agent-title-selector-trigger"
        type="text"
        htmlType="button"
        size="small"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpenAgent(null)}
      >
        {selectedLabel}
        <svg
          viewBox="0 0 16 16"
          width={16}
          height={16}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d={open ? 'm4.5 10 3.5-3.5L11.5 10' : 'm4.5 6 3.5 3.5L11.5 6'} />
        </svg>
      </Button>
    </Dropdown>
  )
}
