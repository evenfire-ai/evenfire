export type EditableListProps = {
  title: string
  values: string[]
  onChange: (next: string[]) => void
  placeholder: string
}
