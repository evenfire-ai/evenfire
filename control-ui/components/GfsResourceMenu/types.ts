export interface GfsResourceMenuProps {
  downloading?: boolean
  onCopyLink: () => void
  onDelete: () => void
  onDownload?: () => void
  onManage?: () => void
  onPreview?: () => void
  onRename: () => void
  onReplace?: (file: File) => void
  resourceName: string
  resourceUri: string
}
