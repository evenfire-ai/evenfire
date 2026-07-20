export type GfsResourceMenuProps = {
  resourceName: string
  onManage?: () => void
  onCopyLink: () => void
  onCreateFolder?: () => void
  onDelete?: () => void
  onOpen?: () => void
  onPreview?: () => void
  onDownload?: () => void
  onRename?: () => void
}
