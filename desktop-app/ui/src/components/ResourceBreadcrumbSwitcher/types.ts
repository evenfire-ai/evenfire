export type ResourceBreadcrumbOption = {
  id: string
  label: string
}

export type ResourceBreadcrumbSwitcherProps = {
  ariaLabel: string
  emptyLabel: string
  onSelect: (id: string) => void
  options: ResourceBreadcrumbOption[]
  selectedId: string
  selectedLabel: string
}
