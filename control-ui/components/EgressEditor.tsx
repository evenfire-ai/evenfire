'use client'

import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  MAX_EGRESS_BINDINGS,
  buildMcpEgressStatus,
  deriveEgressEditorInputs,
} from '@lib/egressModel'
import type { EgressBinding, EgressEditorStatus, EgressMode } from '@lib/egressModel'
import { Field, FormSection, SelectInput, TextInput } from './ui'

type Props = {
  initialBindings?: EgressBinding[]
  onChange: (bindings: EgressBinding[] | undefined, status: EgressEditorStatus) => void
  title?: string
  description?: string
  emitInitial?: boolean
  allowCidr?: boolean
}

export function EgressEditor({
  initialBindings,
  onChange,
  title = 'External Egress',
  description = 'Configure explicit outbound internet access for this resource.',
  emitInitial = true,
  allowCidr = false,
}: Props) {
  const initial = useMemo(
    () => deriveEgressEditorInputs(initialBindings, { allowCidr }),
    [allowCidr, initialBindings]
  )
  const [mode, setMode] = useState<EgressMode>(initial.mode)
  const [domainInput, setDomainInput] = useState(initial.domainInput)
  const [portInput, setPortInput] = useState(initial.portInput)
  const egressEditorId = useId().replace(/:/g, '-')
  const egressModeId = `egress-mode-${egressEditorId}`
  const egressTargetId = `egress-target-${egressEditorId}`
  const egressPortId = `egress-port-${egressEditorId}`
  const skippedInitialEmitRef = useRef(false)
  const onChangeRef = useRef(onChange)

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  const status = useMemo(
    () => buildMcpEgressStatus(mode, domainInput, portInput),
    [domainInput, mode, portInput]
  )

  useEffect(() => {
    if (!emitInitial && !skippedInitialEmitRef.current) {
      skippedInitialEmitRef.current = true
      return
    }
    onChangeRef.current(status.bindings, status)
  }, [emitInitial, status])

  const hasError = status.errors.length > 0 || mode === 'advanced'
  const countText =
    mode === 'public-web'
      ? '1 public-web binding'
      : mode === 'exact-cidr'
        ? `${status.cidrs.length} CIDR/IP target(s) x ${status.ports.length} port(s) = ${status.bindingCount} binding(s)`
        : mode === 'exact-host'
          ? `${status.domains.length} domain(s) x ${status.ports.length} port(s) = ${status.bindingCount} binding(s)`
          : '0 external egress bindings'

  return (
    <FormSection description={description} title={title}>
      <Field
        description="Default is closed. Choose exact-host for known APIs or public-web only when hosts are not deterministic."
        htmlFor={egressModeId}
        label="Egress mode"
      >
        <SelectInput
          id={egressModeId}
          onChange={event => setMode(event.target.value as EgressMode)}
          value={mode}
        >
          <option value="none">No external egress (closed by default)</option>
          <option value="exact-host">Exact-host egress</option>
          {allowCidr ? <option value="exact-cidr">Exact-CIDR/IP egress</option> : null}
          <option value="public-web">Public web egress</option>
          {mode === 'advanced' ? (
            <option value="advanced">Advanced existing bindings</option>
          ) : null}
        </SelectInput>
      </Field>

      {mode === 'none' ? (
        <div className="cu-banner cu-banner--info" role="status">
          External internet egress is closed by default. This resource can still use allowed
          in-cluster routes, but it cannot call public internet APIs unless you add exact-host or
          public-web egress.
        </div>
      ) : null}

      {mode === 'exact-host' ? (
        <>
          <Field
            description="Comma- or newline-separated public DNS hostnames. Do not enter URLs, wildcards, IPs, or cluster-local names."
            htmlFor={egressTargetId}
            label="Allowed domains"
            required
          >
            <textarea
              className="cu-input cu-input--monospace"
              id={egressTargetId}
              onChange={event => setDomainInput(event.target.value)}
              placeholder="api.example.com, auth.example.com"
              rows={3}
              value={domainInput}
            />
          </Field>
          <Field
            description="Comma- or newline-separated TCP ports."
            htmlFor={egressPortId}
            label="Allowed ports"
            required
          >
            <TextInput
              id={egressPortId}
              monospace
              onChange={event => setPortInput(event.target.value)}
              placeholder="443"
              value={portInput}
            />
          </Field>
        </>
      ) : null}

      {mode === 'exact-cidr' && allowCidr ? (
        <>
          <Field
            description="Comma- or newline-separated public IPv4 CIDRs or IPs. Private, metadata, link-local, documentation, multicast, and reserved ranges are blocked."
            htmlFor={egressTargetId}
            label="Allowed CIDRs/IPs"
            required
          >
            <textarea
              className="cu-input cu-input--monospace"
              id={egressTargetId}
              onChange={event => setDomainInput(event.target.value)}
              placeholder="203.0.114.10/32, 8.8.8.8"
              rows={3}
              value={domainInput}
            />
          </Field>
          <Field
            description="Comma- or newline-separated TCP ports."
            htmlFor={egressPortId}
            label="Allowed ports"
            required
          >
            <TextInput
              id={egressPortId}
              monospace
              onChange={event => setPortInput(event.target.value)}
              placeholder="443"
              value={portInput}
            />
          </Field>
        </>
      ) : null}

      {mode === 'public-web' ? (
        <div className="cu-warning-card" role="alert">
          Public web egress allows outbound TCP 80/443 to public internet addresses. Private,
          metadata, cluster-internal, link-local, multicast, and reserved ranges remain blocked by
          NetworkPolicy. Use this only when exact hosts are not deterministic.
        </div>
      ) : null}

      {mode === 'advanced' ? (
        <div className="cu-warning-card" role="alert">
          This resource has existing egress bindings that cannot be represented by the simple
          editor. Switch to an explicit mode to replace them, or keep the server unchanged.
        </div>
      ) : null}

      <div
        className={hasError ? 'cu-banner cu-banner--error' : 'cu-banner cu-banner--ok'}
        role={hasError ? 'alert' : 'status'}
      >
        <strong>Egress summary:</strong> {countText}. Maximum: {MAX_EGRESS_BINDINGS}.
        {status.errors.length > 0 ? (
          <ul className="cu-list cu-list--compact">
            {status.errors.map(error => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </FormSection>
  )
}
