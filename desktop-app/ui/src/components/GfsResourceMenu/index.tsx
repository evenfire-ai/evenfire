import { useEffect, useRef, useState } from 'react'
import { Button, Dropdown } from 'antd'
import type { MenuProps } from 'antd'
import {
  IconCopy as CopyOutlined,
  IconTrash as DeleteOutlined,
  IconDownload as DownloadOutlined,
  IconEdit as EditOutlined,
  IconMoreVertical as EllipsisOutlined,
  IconEye as EyeOutlined,
  IconPlus as FolderAddOutlined,
  IconContexts as FolderOutlined,
  IconConnectors as LinkOutlined,
  IconChevronRight as RightOutlined,
  IconShare as ShareAltOutlined,
  IconUpload as UploadOutlined,
} from '@components/SidebarNav/icons'
import type { GfsResourceMenuProps } from './types'

export function GfsResourceMenu({
  resourceName,
  onManage,
  onCopyLink,
  onCreateFolder,
  onDelete,
  onOpen,
  onOpenGfsLink,
  onOpenChange,
  onPreview,
  onDownload,
  onDownloadZip,
  onRename,
  onMove,
  onReplace,
}: GfsResourceMenuProps) {
  const [open, setOpen] = useState(false)
  const replaceInputRef = useRef<HTMLInputElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const openRef = useRef(false)
  const restoreFocusOnCloseRef = useRef(false)
  const onOpenChangeRef = useRef(onOpenChange)
  const previousOpenRef = useRef(false)

  useEffect(() => {
    onOpenChangeRef.current = onOpenChange
  }, [onOpenChange])

  useEffect(() => {
    if (previousOpenRef.current === open) return
    previousOpenRef.current = open
    onOpenChangeRef.current?.(open)
  }, [open])

  useEffect(() => {
    openRef.current = open
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      restoreFocusOnCloseRef.current = true
      window.setTimeout(() => {
        // Ant Design closes a nested submenu on its first Escape without
        // closing the dropdown. Only return focus when Escape closed the root.
        if (openRef.current) restoreFocusOnCloseRef.current = false
      }, 0)
    }
    window.addEventListener('keydown', handleEscape, true)
    return () => window.removeEventListener('keydown', handleEscape, true)
  }, [open])

  useEffect(
    () => () => {
      if (previousOpenRef.current) onOpenChangeRef.current?.(false)
    },
    []
  )

  const actionHandlers = new Map<string, () => void>()
  const addAction = (key: string, action: (() => void) | undefined) => {
    if (action) actionHandlers.set(key, action)
  }

  addAction('share-access', onManage)
  addAction('copy-link', onCopyLink)
  addAction('open-folder', onOpen)
  addAction('open-gfs-link', onOpenGfsLink)
  addAction('preview', onPreview)
  addAction('new-folder', onCreateFolder)
  addAction('rename', onRename)
  addAction('move', onMove)
  addAction('download', onDownload)
  addAction('download-zip', onDownloadZip)
  addAction('replace', onReplace ? () => replaceInputRef.current?.click() : undefined)
  addAction('delete', onDelete)

  const groups: NonNullable<MenuProps['items']>[] = [
    [
      ...(onManage
        ? [
            {
              key: 'share',
              label: 'Share',
              icon: <ShareAltOutlined aria-hidden="true" width={18} height={18} />,
              children: [
                {
                  key: 'share-access',
                  label: 'Share',
                  icon: <ShareAltOutlined aria-hidden="true" width={18} height={18} />,
                },
                ...(onCopyLink
                  ? [
                      {
                        key: 'copy-link',
                        label: 'Copy link',
                        icon: <CopyOutlined aria-hidden="true" width={18} height={18} />,
                      },
                    ]
                  : []),
              ],
            },
          ]
        : onCopyLink
          ? [
              {
                key: 'copy-link',
                label: 'Copy link',
                icon: <CopyOutlined aria-hidden="true" width={18} height={18} />,
              },
            ]
          : []),
      ...(onOpen
        ? [
            {
              key: 'open-folder',
              label: 'Open folder',
              icon: <FolderOutlined aria-hidden="true" width={18} height={18} />,
            },
          ]
        : []),
      ...(onOpenGfsLink
        ? [
            {
              key: 'open-gfs-link',
              label: 'Open EvenDrive link',
              icon: <LinkOutlined aria-hidden="true" width={18} height={18} />,
            },
          ]
        : []),
      ...(onPreview
        ? [
            {
              key: 'preview',
              label: 'Preview',
              icon: <EyeOutlined aria-hidden="true" width={18} height={18} />,
            },
          ]
        : []),
    ],
    [
      ...(onCreateFolder
        ? [
            {
              key: 'new-folder',
              label: 'New folder',
              icon: <FolderAddOutlined aria-hidden="true" width={18} height={18} />,
            },
          ]
        : []),
      ...(onRename
        ? [
            {
              key: 'rename',
              label: 'Rename',
              icon: <EditOutlined aria-hidden="true" width={18} height={18} />,
            },
          ]
        : []),
      ...(onMove
        ? [
            {
              key: 'move',
              label: 'Move to…',
              icon: <FolderOutlined aria-hidden="true" width={18} height={18} />,
            },
          ]
        : []),
    ],
    [
      ...(onDownload
        ? [
            {
              key: 'download',
              label: 'Download',
              icon: <DownloadOutlined aria-hidden="true" width={18} height={18} />,
            },
          ]
        : []),
      ...(onDownloadZip
        ? [
            {
              key: 'download-zip',
              label: 'Download as zip',
              icon: <DownloadOutlined aria-hidden="true" width={18} height={18} />,
            },
          ]
        : []),
      ...(onReplace
        ? [
            {
              key: 'replace',
              label: 'Replace file',
              icon: <UploadOutlined aria-hidden="true" width={18} height={18} />,
            },
          ]
        : []),
    ],
    [
      ...(onDelete
        ? [
            {
              key: 'delete',
              label: 'Delete',
              icon: <DeleteOutlined aria-hidden="true" width={18} height={18} />,
              danger: true,
            },
          ]
        : []),
    ],
  ].filter(group => group.length > 0)

  const items: NonNullable<MenuProps['items']> = groups.flatMap((group, index) => [
    ...(index > 0 ? [{ type: 'divider' as const, key: `divider-${index}` }] : []),
    ...group,
  ])

  const handleMenuKeyDown: NonNullable<MenuProps['onKeyDown']> = event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const menuItems = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([aria-disabled="true"])'
      )
    )
    if (menuItems.length === 0) return
    event.preventDefault()
    const activeIndex = menuItems.findIndex(item => item === document.activeElement)
    let nextIndex = activeIndex < 0 ? 0 : activeIndex
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = menuItems.length - 1
    if (event.key === 'ArrowDown') nextIndex = (nextIndex + 1) % menuItems.length
    if (event.key === 'ArrowUp') nextIndex = (nextIndex - 1 + menuItems.length) % menuItems.length
    menuItems[nextIndex]?.focus()
  }

  const handleMenuClick: MenuProps['onClick'] = ({ key }) => {
    const action = actionHandlers.get(key)
    if (!action) return
    setOpen(false)
    action()
  }

  const handleDropdownOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    openRef.current = nextOpen
    if (!nextOpen && restoreFocusOnCloseRef.current) {
      restoreFocusOnCloseRef.current = false
      triggerRef.current?.focus()
    }
  }

  return (
    <>
      <Dropdown
        autoFocus
        open={open}
        onOpenChange={handleDropdownOpenChange}
        menu={{
          items,
          className: 'gfs-resource-menu-antd',
          onClick: handleMenuClick,
          onKeyDown: handleMenuKeyDown,
          expandIcon: (
            <span aria-hidden="true">
              <RightOutlined width={18} height={18} />
            </span>
          ),
          'aria-label': `Actions for ${resourceName}`,
        }}
        trigger={['click']}
        placement="bottomRight"
        autoAdjustOverflow
        getPopupContainer={trigger =>
          trigger.closest<HTMLElement>('[data-gfs-browser="true"]') ?? document.body
        }
        destroyOnHidden
      >
        <Button
          aria-label={`Options for ${resourceName}`}
          aria-haspopup="menu"
          aria-expanded={open}
          title={`Options for ${resourceName}`}
          htmlType="button"
          className="da-gfs-resource-menu__trigger"
          icon={<EllipsisOutlined aria-hidden="true" width={16} height={16} />}
          onClick={event => event.stopPropagation()}
          ref={triggerRef}
          size="small"
          type="text"
        />
      </Dropdown>
      {onReplace ? (
        <input
          aria-label={`Replace ${resourceName}`}
          className="visually-hidden"
          ref={replaceInputRef}
          type="file"
          onChange={event => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (!file) return
            setOpen(false)
            onReplace(file)
          }}
        />
      ) : null}
    </>
  )
}
