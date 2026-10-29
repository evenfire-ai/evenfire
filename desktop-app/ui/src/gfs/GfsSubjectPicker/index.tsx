import { useMemo, useState } from 'react'
import { Select, Space, Spin, Tag, Typography } from 'antd'
import { IconAgents, IconClose, IconTeams, IconUser } from '@components/SidebarNav/icons'
import type { GfsDelegationSubjectOption } from '@/gfs/delegation.types'
import type { GfsSubjectPickerProps } from './types'

function subjectKey(subject: GfsDelegationSubjectOption): string {
  return `${subject.type}:${subject.id}`
}

function subjectIcon(subject: GfsDelegationSubjectOption) {
  const icon =
    subject.type === 'team' ? (
      <IconTeams aria-hidden="true" />
    ) : subject.type === 'host' ? (
      <IconAgents aria-hidden="true" />
    ) : (
      <IconUser aria-hidden="true" />
    )
  return (
    <span
      className={`da-gfs-subject-picker__avatar da-gfs-subject-picker__avatar--${subject.type}`}
      aria-hidden="true"
    >
      {icon}
    </span>
  )
}

function matchesQuery(subject: GfsDelegationSubjectOption, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return [subject.label, subject.description, subject.type, subject.badge].some(value =>
    value?.toLowerCase().includes(normalized)
  )
}

export function GfsSubjectPicker({
  disabled = false,
  loading = false,
  onChange,
  options,
  value,
}: GfsSubjectPickerProps) {
  const [open, setOpen] = useState(false)
  const optionsByKey = useMemo(
    () => new Map(options.map(subject => [subjectKey(subject), subject])),
    [options]
  )
  const selectOptions = useMemo(
    () =>
      options.map(subject => ({
        value: subjectKey(subject),
        // Keep the option's accessible name stable and human-readable. AntD
        // falls back to `value` when a ReactNode label cannot be flattened.
        label: subject.label,
      })),
    [options]
  )
  const allAvailableSelected =
    options.length > 0 && options.every(subject => value.includes(subjectKey(subject)))

  return (
    <Select
      aria-label="Add people, teams, or agents"
      disabled={disabled}
      filterOption={(input, option) => {
        const subject = optionsByKey.get(String(option?.value))
        return subject ? matchesQuery(subject, input) : false
      }}
      loading={loading}
      mode="multiple"
      removeIcon={<IconClose aria-hidden="true" width={16} height={16} />}
      notFoundContent={
        loading ? (
          <Spin size="small" />
        ) : allAvailableSelected ? (
          'Everyone available is selected.'
        ) : (
          'No people, teams, or agents found.'
        )
      }
      onChange={(next: string[]) => onChange(next)}
      onOpenChange={setOpen}
      open={open}
      optionRender={option => {
        const subject = optionsByKey.get(String(option.value))
        if (!subject) return option.label
        return (
          <Space>
            {subjectIcon(subject)}
            <span>
              <Typography.Text>{subject.label}</Typography.Text>
              {subject.description ? (
                <Typography.Text type="secondary"> — {subject.description}</Typography.Text>
              ) : null}
            </span>
            <Tag>{subject.badge ?? subject.type}</Tag>
          </Space>
        )
      }}
      options={selectOptions}
      placeholder="Add people, teams, or agents"
      showSearch
      size="small"
      value={value}
    />
  )
}

export type { GfsSubjectPickerProps } from './types'
