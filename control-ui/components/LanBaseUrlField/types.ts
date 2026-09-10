export type LanBaseUrlFieldProps = {
  // Unique id linking the label to the input.
  id: string
  // Current baseURL value (controlled by the parent).
  value: string
  onChange: (next: string) => void
  disabled?: boolean
  // Field label; defaults to "LAN endpoint (baseURL)".
  label?: string
}
