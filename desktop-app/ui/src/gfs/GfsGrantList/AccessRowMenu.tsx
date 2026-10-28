import { useEffect, useRef, useState } from 'react'
import { EllipsisOutlined } from '@ant-design/icons'
import { Button, Dropdown } from 'antd'
import type { MenuProps } from 'antd'

type AccessRowMenuProps = {
  disabled?: boolean
  label: string
  onRemove: () => void | Promise<void>
}

export function AccessRowMenu({ disabled = false, label, onRemove }: AccessRowMenuProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const openRef = useRef(false)
  const restoreFocusOnCloseRef = useRef(false)
  openRef.current = open

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  useEffect(() => {
    if (!open) return
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      restoreFocusOnCloseRef.current = true
      window.setTimeout(() => {
        if (openRef.current) restoreFocusOnCloseRef.current = false
      }, 0)
    }
    window.addEventListener('keydown', handleEscape, true)
    return () => window.removeEventListener('keydown', handleEscape, true)
  }, [open])

  const menu: MenuProps = {
    'aria-label': `Actions for ${label}`,
    items: [{ key: 'remove-access', label: 'Remove access', danger: true }],
    onClick: () => {
      setOpen(false)
      triggerRef.current?.focus()
      void onRemove()
    },
  }

  return (
    <Dropdown
      autoFocus
      destroyOnHidden
      menu={menu}
      onOpenChange={nextOpen => {
        setOpen(nextOpen)
        openRef.current = nextOpen
        if (!nextOpen && restoreFocusOnCloseRef.current) {
          restoreFocusOnCloseRef.current = false
          triggerRef.current?.focus()
        }
      }}
      open={open}
      placement="bottomRight"
      trigger={['click']}
    >
      <Button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Actions for ${label}`}
        disabled={disabled}
        icon={<EllipsisOutlined aria-hidden="true" />}
        ref={triggerRef}
        size="small"
        type="text"
      />
    </Dropdown>
  )
}
