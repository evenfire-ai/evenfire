import { useEffect, useRef } from 'react'
import { Button, Empty, Flex, Typography } from 'antd'
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
  const itemRefs = useRef(new Map<DesktopCommandId, HTMLElement>())

  useEffect(() => {
    if (!selectedId) return
    const selectedItem = itemRefs.current.get(selectedId)
    if (typeof selectedItem?.scrollIntoView === 'function') {
      selectedItem.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedId])

  if (commands.length === 0) {
    return <Empty description="No matching commands." image={Empty.PRESENTED_IMAGE_SIMPLE} />
  }

  return (
    <Flex vertical gap="small" role="listbox" aria-label="Desktop commands">
      {commands.map(command => {
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
            block
            disabled={!eligible}
            htmlType="button"
            key={command.id}
            onClick={() => onExecute(commandId)}
            role="option"
            type={selected ? 'primary' : 'text'}
          >
            <Flex align="center" gap="middle" justify="space-between">
              <Flex vertical align="start">
                <Typography.Text strong>{command.label}</Typography.Text>
                <Typography.Text type="secondary">{command.description}</Typography.Text>
              </Flex>
              {command.defaultBinding ? (
                <kbd>{formatDesktopShortcut(command.defaultBinding, platform)}</kbd>
              ) : null}
            </Flex>
          </Button>
        )
      })}
    </Flex>
  )
}
