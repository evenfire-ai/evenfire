'use client'

import React, { useRef, useState } from 'react'
import {
  DataTable,
  SimpleEditDialog,
  SingleValueEditDialog,
  TableViewport,
} from '@clerum/frontend-components'
import { TablePanelHeader } from '@components/TablePanelHeader'
import { useToast } from '@components/Toast'
import { resolveEnvSecret } from '@components/UpdateConnectorCredentials/mcpServerCredentialResolvers'
import { useRolloutWait } from '@components/UpdateConnectorCredentials/useRolloutWait'
import { Button, Field, TextInput } from '@components/ui'
import { CLOCK_SKEW_TOLERANCE_MS } from '@constants/connectorCredentials'
import { getMcpServer, listMcpSecrets, updateMcpSecret } from '@lib/api'
import {
  changeConnectorSecretReference,
  credentialReferenceChangeUnavailable,
  invalidSecretKeyNameReason,
  suggestedCredentialEnvVar,
  validateCredentialAttach,
} from '@lib/connectorCredentials'
import type { ConnectorSecretKeysProps } from './types'

/** Stored Secret keys belong to the Secrets page; connector mappings only
 * supply context. Never use a connector's mapping as the stored-key inventory. */
export function ConnectorSecretKeys({
  secretName,
  keys,
  serverName,
  envSecret,
  server,
  referencingConnectors,
  onKeysChange,
  onMissing,
  onServerChange,
}: ConnectorSecretKeysProps) {
  const { showToast } = useToast()
  const [rotateKey, setRotateKey] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [keyDraft, setKeyDraft] = useState('')
  const [valueDraft, setValueDraft] = useState('')
  const [envDraft, setEnvDraft] = useState('')
  const [envEdited, setEnvEdited] = useState(false)
  const [storedKey, setStoredKey] = useState<string | null>(null)
  const [partialSaveNotice, setPartialSaveNotice] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const writeLock = useRef(false)
  const [cutoff, setCutoff] = useState<string | null>(null)
  const [rolloutIdentity, setRolloutIdentity] = useState<{ uid?: string; generation?: number }>({})
  const [otherAffected, setOtherAffected] = useState<string[]>([])
  const { phase, phaseMessage, setPhase, setPhaseMessage } = useRolloutWait({
    serverName: serverName ?? '',
    cutoff,
    expectedUid: rolloutIdentity.uid,
    expectedGeneration: rolloutIdentity.generation,
  })
  const busy = pending || phase === 'rotating'
  const keyProblem = keyDraft ? invalidSecretKeyNameReason(keyDraft) : undefined
  const duplicate = keys.includes(keyDraft.trim())
  const mappingUnavailable = server ? credentialReferenceChangeUnavailable(server) : undefined
  const mapsToConnector = Boolean(server && serverName && !mappingUnavailable)
  const mappingRows = [
    ...(envSecret?.keys ?? []).map((mapping, index) => ({
      ...mapping,
      id: `existing-${index}`,
      value: '',
    })),
    { id: 'new', secretKey: keyDraft.trim(), envVar: envDraft.trim(), value: valueDraft },
  ]
  const envProblem =
    mapsToConnector && envDraft
      ? validateCredentialAttach('use-existing', secretName, mappingRows, server!, {
          name: secretName,
          keys,
        })
      : undefined
  const restartNote = referencingConnectors.length
    ? `Connectors sharing this Secret may restart: ${referencingConnectors.join(', ')}.`
    : 'No connector currently uses this Secret.'

  function closeEditor() {
    if (writeLock.current) return
    setRotateKey(null)
    setAdding(false)
    setKeyDraft('')
    setValueDraft('')
    setEnvDraft('')
    setEnvEdited(false)
    setStoredKey(null)
    setError('')
  }

  async function save(key: string, value: string, add: boolean) {
    if (writeLock.current || phase === 'rotating' || (!value.trim() && storedKey !== key)) return
    if (add && (invalidSecretKeyNameReason(key) || (keys.includes(key) && storedKey !== key)))
      return
    writeLock.current = true
    setPending(true)
    setError('')
    let keyPersisted = add && storedKey === key
    try {
      let selectedSecret
      if (add) {
        // Recheck the stored inventory, including unmapped keys, before an add.
        // The merge endpoint would otherwise replace an existing key's value.
        const latest = (await listMcpSecrets()).items.find(item => item.name === secretName)
        if (!latest) {
          onMissing()
          return
        }
        onKeysChange(latest.keys)
        selectedSecret = latest
        if (latest.keys.includes(key) && !keyPersisted) {
          setError(`Key "${key}" already exists. Rotate its value instead.`)
          return
        }
      }
      let currentServer
      let rows = mappingRows
      if (add && mapsToConnector) {
        currentServer = await getMcpServer(serverName!)
        const currentReference = resolveEnvSecret(currentServer.spec)
        if (
          !server?.metadata?.uid ||
          currentServer.metadata?.uid !== server.metadata.uid ||
          currentReference?.name !== secretName
        ) {
          throw new Error('The connector changed. Refresh before adding its environment variable.')
        }
        const unavailable = credentialReferenceChangeUnavailable(currentServer)
        if (unavailable) throw new Error(unavailable)
        rows = [
          ...currentReference.keys.map((mapping, index) => ({
            ...mapping,
            id: `existing-${index}`,
            value: '',
          })),
          { id: 'new', secretKey: key, envVar: envDraft.trim(), value },
        ]
        const problem = validateCredentialAttach(
          'use-existing',
          secretName,
          rows,
          currentServer,
          selectedSecret
        )
        if (problem) throw new Error(problem.message)
      }
      const startedAt = new Date(Date.now() - CLOCK_SKEW_TOLERANCE_MS).toISOString()
      // Object.fromEntries preserves Kubernetes-valid names such as __proto__.
      if (!keyPersisted) {
        const result = await updateMcpSecret(secretName, Object.fromEntries([[key, value]]))
        onKeysChange(result.keys)
        setOtherAffected(result.affectedConnectors.filter(name => name !== serverName))
        if (add) {
          keyPersisted = true
          setStoredKey(key)
          setValueDraft('')
          selectedSecret = { ...selectedSecret, name: secretName, keys: result.keys }
        }
      }
      if (add && currentServer) {
        const assigned = await changeConnectorSecretReference({
          serverName: serverName!,
          server: currentServer,
          selection: {
            secret: selectedSecret,
            rows: rows.map(row => ({ ...row, value: '' })),
            ready: true,
          },
        })
        onServerChange(assigned.server)
        setRolloutIdentity({
          uid: assigned.server.metadata?.uid,
          generation: assigned.server.metadata?.generation,
        })
        setCutoff(assigned.cutoff)
        setPhase('rotating')
      }
      setRotateKey(null)
      setAdding(false)
      setKeyDraft('')
      setValueDraft('')
      setEnvDraft('')
      setEnvEdited(false)
      setStoredKey(null)
      setPartialSaveNotice('')
      setPhaseMessage('')
      const mappedToSelected = envSecret?.keys.some(mapping => mapping.secretKey === key)
      if (!add && serverName && mappedToSelected) {
        setCutoff(startedAt)
        setRolloutIdentity({})
        setPhase('rotating')
      } else if (!add || !currentServer) {
        setPhase('idle')
        setCutoff(null)
      }
      showToast(add ? `Key "${key}" added.` : `Value for "${key}" saved.`, { tone: 'success' })
    } catch (cause) {
      if (keyPersisted) {
        const message = `Key "${key}" is stored, but its environment mapping could not be confirmed. ${cause instanceof Error ? cause.message : 'Retry the mapping or refresh to review the connector.'}`
        setError(message)
        setPartialSaveNotice(message)
      } else if ((cause as { status?: number })?.status === 404) {
        onMissing()
      } else {
        setError(cause instanceof Error ? cause.message : 'Could not save the Secret value.')
      }
    } finally {
      writeLock.current = false
      setPending(false)
    }
  }

  return (
    <section className="cu-secret-keys" aria-label="Secret keys">
      <TablePanelHeader
        title="Secret keys"
        subtitle="Rotate a key to replace its stored value. Existing values are never displayed."
        primaryAction={
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              setError('')
              setAdding(true)
            }}
          >
            Add key
          </Button>
        }
      />
      <TableViewport className="cu-table-wrap">
        <DataTable className="eft-table cu-table cu-credential-key-table">
          <thead>
            <tr>
              <th>Secret key</th>
              <th>Environment variable{serverName ? ` · ${serverName}` : ''}</th>
              <th className="cu-table__cell-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 ? (
              <tr>
                <td colSpan={3} className="cu-empty">
                  No keys yet. Add a key to store a credential.
                </td>
              </tr>
            ) : (
              [...keys]
                .sort((a, b) => a.localeCompare(b))
                .map(key => {
                  const mappings =
                    envSecret?.keys.filter(mapping => mapping.secretKey === key) ?? []
                  return (
                    <tr key={key}>
                      <td>
                        <code>{key}</code>
                      </td>
                      <td>
                        {mappings.length ? (
                          mappings.map(mapping => (
                            <code key={mapping.envVar}>{mapping.envVar}</code>
                          ))
                        ) : (
                          <span className="cu-muted">Not mapped</span>
                        )}
                      </td>
                      <td className="cu-table__cell-actions">
                        <Button
                          size="sm"
                          disabled={busy}
                          aria-label={`Rotate ${key}`}
                          onClick={() => {
                            setError('')
                            setRotateKey(key)
                          }}
                        >
                          Rotate
                        </Button>
                      </td>
                    </tr>
                  )
                })
            )}
          </tbody>
        </DataTable>
      </TableViewport>
      <p className="cu-secret-keys__note">{restartNote}</p>
      {partialSaveNotice && !adding ? (
        <div className="cu-banner cu-banner--warning" role="alert">
          {partialSaveNotice}
        </div>
      ) : null}
      {phase === 'rotating' ? (
        <div className="cu-banner cu-banner--info" role="status">
          Value saved. Waiting for {serverName} to restart with the new credential.
          {phaseMessage ? ` ${phaseMessage}` : ''}
        </div>
      ) : null}
      {phase === 'success' ? (
        <div className="cu-banner cu-banner--ok" role="status">
          {serverName} restarted and is serving the new credential.
          {otherAffected.length
            ? ` Other connectors roll out separately: ${otherAffected.join(', ')}.`
            : ''}
        </div>
      ) : null}
      {phase === 'failed' || phase === 'timeout' ? (
        <div className="cu-banner cu-banner--warning" role="alert">
          Value saved, but the connector restart could not be verified. {phaseMessage}
        </div>
      ) : null}

      <SingleValueEditDialog
        open={rotateKey !== null}
        title={`Rotate ${rotateKey ?? 'key'}`}
        description={`Replace only this key's value. ${restartNote}`}
        initialValue=""
        pending={pending}
        error={error}
        discardLabel="Cancel"
        saveLabel="Rotate"
        onDismiss={closeEditor}
        onSave={value => {
          if (rotateKey !== null) void save(rotateKey, value, false)
        }}
        renderEditor={({ value, onChange, disabled }) => (
          <Field label="New value" htmlFor="connector-secret-rotate-value" required>
            <TextInput
              id="connector-secret-rotate-value"
              type="password"
              autoComplete="new-password"
              placeholder="Enter new value"
              value={value}
              onChange={event => onChange(event.target.value)}
              disabled={disabled}
              required
              pattern=".*\S.*"
            />
          </Field>
        )}
      />
      <SimpleEditDialog
        open={adding}
        title="Add key"
        description={
          mapsToConnector
            ? `Store a new key and map its environment variable on ${serverName}. ${restartNote}`
            : 'Store a new key and value in this Secret. Environment variables are assigned when a connector uses it.'
        }
        pending={pending}
        error={error}
        isDirty={Boolean(keyDraft || valueDraft)}
        isValid={
          Boolean(keyDraft.trim() && (valueDraft.trim() || storedKey)) &&
          !keyProblem &&
          (!duplicate || storedKey === keyDraft.trim()) &&
          (!mapsToConnector || (Boolean(envDraft.trim()) && !envProblem))
        }
        saveLabel={storedKey ? 'Retry mapping' : 'Add key'}
        onCancel={closeEditor}
        onSave={() => void save(keyDraft.trim(), valueDraft, true)}
      >
        <Field
          label="Key name"
          htmlFor="connector-secret-add-key"
          required
          error={keyProblem ?? (duplicate && !storedKey ? 'This key already exists.' : undefined)}
        >
          <TextInput
            id="connector-secret-add-key"
            monospace
            placeholder="API_KEY"
            value={keyDraft}
            onChange={event => {
              setKeyDraft(event.target.value)
              if (!envEdited) setEnvDraft(suggestedCredentialEnvVar(event.target.value))
            }}
            disabled={pending || storedKey !== null}
            required
          />
        </Field>
        {mapsToConnector ? (
          <Field
            label="Environment variable"
            htmlFor="connector-secret-add-env"
            required
            error={envProblem?.field === 'new-env' ? envProblem.message : undefined}
          >
            <TextInput
              id="connector-secret-add-env"
              monospace
              placeholder="API_KEY"
              value={envDraft}
              onChange={event => {
                setEnvDraft(event.target.value)
                setEnvEdited(true)
              }}
              disabled={pending}
              required
            />
          </Field>
        ) : mappingUnavailable ? (
          <p className="cu-muted">{mappingUnavailable}</p>
        ) : null}
        <Field label="Value" htmlFor="connector-secret-add-value" required>
          <TextInput
            id="connector-secret-add-value"
            type="password"
            autoComplete="new-password"
            placeholder="Enter value"
            value={valueDraft}
            onChange={event => setValueDraft(event.target.value)}
            disabled={pending || storedKey !== null}
            required={storedKey === null}
          />
        </Field>
      </SimpleEditDialog>
    </section>
  )
}
