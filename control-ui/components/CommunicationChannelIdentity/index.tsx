import { SelectionDropdown } from '@components/SelectionDropdown'
import { Field, TextInput } from '@components/ui'
import { toKebabInput } from '@lib/string'
import type { CommunicationChannelIdentityProps } from './types'

export function CommunicationChannelIdentity({
  channelName,
  onNameChange,
  agentName,
  onAgentChange,
  agentOptions,
  loadingAgents,
  disabled,
}: CommunicationChannelIdentityProps) {
  return (
    <div className="cu-form-stack cu-agent-form-stack">
      <Field
        description="The reference name for this channel."
        htmlFor="ch-name"
        label="Channel name"
        required
      >
        <TextInput
          id="ch-name"
          value={channelName}
          onChange={event => onNameChange?.(toKebabInput(event.target.value))}
          placeholder="channel-name (e.g. telegram-channel)"
          disabled={disabled || !onNameChange}
          autoFocus={Boolean(onNameChange)}
        />
      </Field>
      <Field
        description="This communication channel belongs to this agent."
        htmlFor="ch-host"
        label="Agent"
        required
      >
        {loadingAgents ? (
          <span className="cu-muted cu-muted-note--compact">Loading agents...</span>
        ) : (
          <SelectionDropdown
            id="ch-host"
            multiple={false}
            value={agentName ? [agentName] : []}
            onChange={next => onAgentChange(next[0] || '')}
            options={agentOptions}
            placeholder="Select an agent..."
            searchPlaceholder="Search agents..."
            emptyLabel="No available agents."
            disabled={disabled}
          />
        )}
      </Field>
    </div>
  )
}
