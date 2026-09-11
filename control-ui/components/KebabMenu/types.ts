export type KebabMenuItem = {
  label: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}

export type KebabMenuProps = {
  items: KebabMenuItem[]
  ariaLabel: string
}
