import { useEffect, useRef } from 'react'
import { Button } from '@components/Common'
import {
  type DesktopCommandDefinition,
  type DesktopCommandId,
  type DesktopShortcutPlatform,
  formatDesktopShortcut,
} from '../../../../src/desktopCommands'

type CommandPaletteListProps = {
  commands: readonly DesktopCommandDefinition[]
  isEligible: (commandId: DesktopCommandId) => boolean
  onExecute: (commandId: DesktopCommandId) => void
  platform: DesktopShortcutPlatform
  selectedId: DesktopCommandId | null
}

export function CommandPaletteList({
  commands,
  isEligible,
  onExecute,
  platform,
  selectedId,
}: CommandPaletteListProps) {
  const itemRefs = useRef(new Map<DesktopCommandId, HTMLButtonElement>())

  useEffect(() => {
    if (!selectedId) return
    const selectedItem = itemRefs.current.get(selectedId)
    if (typeof selectedItem?.scrollIntoView === 'function') {
      selectedItem.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedId])

  return (
    <div className="command-palette__list" role="listbox" aria-label="Desktop commands">
      {commands.length ? (
        commands.map(command => {
          const commandId = command.id as DesktopCommandId
          const eligible = isEligible(commandId)
          const selected = eligible && selectedId === commandId
          return (
            <Button
              ref={element => {
                if (element) itemRefs.current.set(commandId, element)
                else itemRefs.current.delete(commandId)
              }}
              aria-selected={selected}
              className={`command-palette__item${selected ? ' is-selected' : ''}`}
              color="neutral"
              disabled={!eligible}
              key={command.id}
              onClick={() => onExecute(commandId)}
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
  )
}
