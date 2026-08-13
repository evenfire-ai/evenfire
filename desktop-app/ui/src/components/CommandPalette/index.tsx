import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, TextInput } from '@components/Common'
import {
  DESKTOP_COMMANDS,
  type DesktopCommandId,
  formatDesktopShortcut,
} from '../../../../src/desktopCommands'
import type { CommandPaletteProps } from './types'

export function CommandPalette({
  platform,
  isEligible,
  onClose,
  onExecute,
  restorePreviousFocus = true,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<DesktopCommandId | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const restoreFocusOnUnmountRef = useRef(restorePreviousFocus)
  const commands = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return DESKTOP_COMMANDS.filter(command => command.visibleInPalette)
      .filter(command =>
        normalized
          ? `${command.label} ${command.description} ${command.group}`
              .toLocaleLowerCase()
              .includes(normalized)
          : true
      )
      .sort((left, right) => left.order - right.order)
  }, [query])
  const eligibleCommands = commands.filter(command => isEligible(command.id as DesktopCommandId))

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null
    inputRef.current?.focus()
    return () => {
      const previous = previousFocusRef.current
      if (restoreFocusOnUnmountRef.current) {
        requestAnimationFrame(() => {
          if (previous?.isConnected) previous.focus()
        })
      }
    }
  }, [])

  useEffect(() => {
    if (selectedId && eligibleCommands.some(command => command.id === selectedId)) return
    setSelectedId((eligibleCommands[0]?.id as DesktopCommandId | undefined) ?? null)
  }, [eligibleCommands, selectedId])

  const moveSelection = (delta: 1 | -1) => {
    if (!eligibleCommands.length) return
    const currentIndex = eligibleCommands.findIndex(command => command.id === selectedId)
    const nextIndex =
      currentIndex < 0
        ? 0
        : (currentIndex + delta + eligibleCommands.length) % eligibleCommands.length
    setSelectedId(eligibleCommands[nextIndex]!.id as DesktopCommandId)
  }

  const execute = (commandId: DesktopCommandId) => {
    if (!isEligible(commandId)) return
    restoreFocusOnUnmountRef.current = false
    onExecute(commandId)
  }

  return (
    <div className="command-palette-backdrop" role="presentation">
      <div
        ref={dialogRef}
        aria-label="Command palette"
        aria-modal="true"
        className="command-palette"
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          } else if (event.key === 'ArrowDown') {
            event.preventDefault()
            moveSelection(1)
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            moveSelection(-1)
          } else if (event.key === 'Enter' && selectedId) {
            event.preventDefault()
            execute(selectedId)
          } else if (event.key === 'Tab') {
            const focusable = Array.from(
              dialogRef.current?.querySelectorAll<HTMLElement>(
                'input:not([disabled]), button:not([disabled])'
              ) ?? []
            )
            const first = focusable[0]
            const last = focusable.at(-1)
            if (event.shiftKey && document.activeElement === first && last) {
              event.preventDefault()
              last.focus()
            } else if (!event.shiftKey && document.activeElement === last && first) {
              event.preventDefault()
              first.focus()
            }
          }
        }}
        role="dialog"
      >
        <div className="command-palette__header">
          <TextInput
            ref={inputRef}
            aria-label="Search commands"
            onChange={event => setQuery(event.currentTarget.value)}
            placeholder="Type a command"
            value={query}
          />
        </div>
        <div className="command-palette__list" role="listbox" aria-label="Desktop commands">
          {commands.length ? (
            commands.map(command => {
              const commandId = command.id as DesktopCommandId
              const eligible = isEligible(commandId)
              const selected = eligible && selectedId === commandId
              return (
                <Button
                  aria-selected={selected}
                  className={`command-palette__item${selected ? ' is-selected' : ''}`}
                  color="neutral"
                  disabled={!eligible}
                  key={command.id}
                  onClick={() => execute(commandId)}
                  role="option"
                  variant="ghost"
                >
                  <span className="command-palette__item-copy">
                    <strong>{command.label}</strong>
                    <span>{command.description}</span>
                  </span>
                  {command.defaultBinding ? (
                    <kbd>{formatDesktopShortcut(command.defaultBinding, platform)}</kbd>
                  ) : null}
                </Button>
              )
            })
          ) : (
            <p className="command-palette__empty">No matching commands.</p>
          )}
        </div>
      </div>
    </div>
  )
}
