export type GfsResourceMenuProps = {
  resourceName: string
  onManage: () => void
  onCopyLink: () => void
  onOpen?: () => void
  onDownload?: () => void
}
