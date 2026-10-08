'use client'

import { useMemo, useState } from 'react'
import { MultiSelectActionDialog } from '@clerum/frontend-components'
import { canAssignConnectorToContext } from '@lib/connectorOAuthAccess'
import type { ConnectorAgentAccessDialogProps } from './types'

export function ConnectorAgentAccessDialog({
  server,
  connectorSpec,
  agentTargets,
  boundAgentNames,
  pending = false,
  onAdd,
  onDismiss,
}: ConnectorAgentAccessDialogProps) {
  const [selectedAgentNames, setSelectedAgentNames] = useState<string[]>([])
  const [error, setError] = useState('')
  const boundAgentNamesSet = useMemo(() => new Set(boundAgentNames), [boundAgentNames])
  const items = useMemo(
    () =>
      agentTargets
        .filter(
          target =>
            !boundAgentNamesSet.has(target.name) &&
            canAssignConnectorToContext(connectorSpec, target.contextRef)
        )
        .map(target => ({
          id: target.name,
          label: target.label,
          description: target.name,
          searchText: `${target.label} ${target.name}`,
        })),
    [agentTargets, boundAgentNamesSet, connectorSpec]
  )

  return (
    <MultiSelectActionDialog
      actionLabel={selectedAgentNames.length > 1 ? 'Add to agents' : 'Add to agent'}
      emptyMessage="No other agents available."
      error={error || undefined}
      items={items}
      noMatchesMessage="No matching agents."
      onAction={async selectedIds => {
        const selected = agentTargets.filter(target => selectedIds.includes(target.name))
        const added = await onAdd(
          server,
          selected.map(target => ({ name: target.name, contextRef: target.contextRef }))
        )
        if (!added) {
          setError('Connector access could not be updated. Review the error and retry.')
          return
        }
        setSelectedAgentNames([])
        setError('')
        onDismiss()
      }}
      onDismiss={onDismiss}
      onSelectedIdsChange={setSelectedAgentNames}
      open
      pending={pending}
      searchLabel="Search agents"
      searchPlaceholder="Search agents..."
      selectedIds={selectedAgentNames}
      title="Give agents access to this connector"
    />
  )
}
