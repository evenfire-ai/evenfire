import { Button } from '@components/Button'
import { TextInput } from '@components/TextInput'
import type { EditableListProps } from './types'

export function EditableList({ title, values, onChange, placeholder }: EditableListProps) {
  return (
    <section className="editable-list">
      <strong>{title}</strong>
      {values.map((value, idx) => (
        <div key={`${title}-${idx}`} className="inline-row">
          <TextInput
            className="fluid-control"
            value={value}
            onChange={event =>
              onChange(values.map((item, itemIdx) => (itemIdx === idx ? event.target.value : item)))
            }
            placeholder={placeholder}
          />
          <Button
            variant="ghost"
            onClick={() => onChange(values.filter((_, itemIdx) => itemIdx !== idx))}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button variant="secondary" onClick={() => onChange([...values, ''])}>
        Add
      </Button>
    </section>
  )
}
