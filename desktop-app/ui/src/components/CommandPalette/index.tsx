import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Input, type InputRef, Modal } from 'antd'
import { DESKTOP_COMMANDS, type DesktopCommandId } from '../../../../src/desktopCommands'
import { CommandPaletteList } from './CommandPaletteList'
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
  const inputRef = useRef<InputRef | null>(null)
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

  useLayoutEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null
    const input = inputRef.current?.input
    inputRef.current?.focus()
    const verificationFrame = requestAnimationFrame(() => {
      const currentInput = inputRef.current
      if (currentInput?.input?.isConnected && document.activeElement !== input) {
        currentInput.focus()
      }
    })
    return () => {
      cancelAnimationFrame(verificationFrame)
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
    <Modal
      open
      closable={false}
      footer={null}
      focusable={{ focusTriggerAfterClose: false, trap: true }}
      afterOpenChange={open => {
        if (open) inputRef.current?.focus()
      }}
      onCancel={onClose}
      title={<span className="visually-hidden">Command palette</span>}
    >
      <div
        ref={dialogRef}
        onKeyDownCapture={event => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            moveSelection(1)
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            moveSelection(-1)
          } else if (
            event.key === 'Enter' &&
            selectedId &&
            event.target === inputRef.current?.input
          ) {
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
      >
        <Input
          ref={inputRef}
          aria-label="Search commands"
          onChange={event => setQuery(event.currentTarget.value)}
          placeholder="Type a command"
          value={query}
        />
        <CommandPaletteList
          commands={commands}
          isEligible={isEligible}
          onExecute={execute}
          platform={platform}
          selectedId={selectedId}
        />
      </div>
    </Modal>
  )
}
