import { Button } from '@components/Button'
import { TextInput } from '@components/TextInput'
import type {
  ProfileChannelKey,
  ProfileChannelRow,
  ProfileChannelSection,
  ReadonlyChannelValue,
} from './types'

type SettingsChannelSectionProps = {
  section: ProfileChannelSection
  rows: ProfileChannelRow[]
  readonlyValues?: ReadonlyChannelValue[]
  disabled: boolean
  onUpdate: (key: ProfileChannelKey, rowId: string, value: string) => void
  onRemove: (key: ProfileChannelKey, rowId: string) => void | Promise<void>
  onAdd: (key: ProfileChannelKey) => void
  onReadonlyValueAction?: (key: ProfileChannelKey, value: string) => void
}

export function SettingsChannelSection({
  section,
  rows,
  readonlyValues = [],
  disabled,
  onUpdate,
  onRemove,
  onAdd,
  onReadonlyValueAction,
}: SettingsChannelSectionProps) {
  const hasValues = rows.length > 0 || readonlyValues.length > 0

  return (
    <div className="settings-channel-section">
      <div>
        <h3 className="settings-subtitle">{section.title}</h3>
        <p className="settings-help">{section.description}</p>
      </div>
      <div className="settings-channel-rows">
        {!hasValues && <div className="small muted">No values added.</div>}
        {readonlyValues.map(row => (
          <div className="settings-channel-readonly-row" key={row.id}>
            <div className="settings-channel-readonly-content">
              <div className="settings-channel-readonly-value">{row.value}</div>
              <div className="settings-channel-readonly-caption">{row.caption}</div>
            </div>
            {row.actionLabel && onReadonlyValueAction && (
              <Button
                variant="secondary"
                onClick={() => onReadonlyValueAction(section.key, row.value)}
                disabled={disabled}
              >
                {row.actionLabel}
              </Button>
            )}
          </div>
        ))}
        {rows.map(row => (
          <div className="settings-channel-row" key={row.id}>
            <TextInput
              className="fluid-control"
              value={row.value}
              onChange={event => onUpdate(section.key, row.id, event.target.value)}
              placeholder={section.placeholder}
              aria-label={section.title}
              disabled={disabled}
            />
            <Button
              variant="ghost"
              onClick={() => void onRemove(section.key, row.id)}
              disabled={disabled}
            >
              Remove
            </Button>
          </div>
        ))}
        <Button variant="secondary" onClick={() => onAdd(section.key)} disabled={disabled}>
          {section.addLabel}
        </Button>
      </div>
    </div>
  )
}
