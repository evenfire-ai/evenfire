export interface GfsFilePickerProps {
  onOpen: (uri: string) => void | boolean | Promise<void | boolean>
  onOpened?: () => void
  busy?: boolean
  error?: string | null
}
