export interface GfsOpenLinkModalProps {
  pending: boolean
  error: string | null
  onOpen: (uri: string) => void
  onCancel: () => void
}
