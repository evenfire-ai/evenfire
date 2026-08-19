'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { CONTROL_ROUTES } from '../../../app/constants/routes'
import { useConfirmDialog } from '../../../components/ConfirmDialog'
import { DashboardLayout } from '../../../components/DashboardLayout'
import { useToast } from '../../../components/Toast'
import { Button, FormSection } from '../../../components/ui'
import { deleteLlmHook, getHosts, getLlmHook, isSilentApiError } from '../../../lib/api'
import type { HostResource, LlmHookResource, LlmHookStatus } from '../../../lib/api'

type HookTarget = {
  image?: { ref?: string; port?: number }
  service?: { name?: string; namespace?: string; port?: number }
  remote?: { baseUrl?: string }
}
type HookSpec = {
  target?: HookTarget
  path?: string
  lifecyclePoints?: string[]
  order?: number
  failMode?: string
  capabilities?: string[]
}

function describeTarget(t?: HookTarget): { kind: string; value: string } {
  if (t?.image?.ref) return { kind: 'Target image', value: t.image.ref }
  if (t?.service?.name) {
    const ns = t.service.namespace ? `${t.service.namespace}/` : ''
    const port = t.service.port ? `:${t.service.port}` : ''
    return { kind: 'Target service', value: `${ns}${t.service.name}${port}` }
  }
  if (t?.remote?.baseUrl) return { kind: 'Target remote', value: t.remote.baseUrl }
  return { kind: 'Target', value: '—' }
}

// Host.spec.guardrails.hooks phase keys.
const HOST_HOOK_PHASES = [
  'preToolUse',
  'preCall',
  'moderate',
  'postCallSuccess',
  'postToolUse',
  'onError',
] as const
const PHASE_LABEL: Record<string, string> = {
  preToolUse: 'Pre-tool use',
  postToolUse: 'Post-tool use',
  preCall: 'Pre-call',
  moderate: 'Moderate',
  postCallSuccess: 'Post-call success',
  onError: 'On error',
}

/** Agents (Hosts) that reference this guardrail, with the phases each uses it in. */
function agentsUsingHook(
  hosts: HostResource[],
  hookName: string
): Array<{ name: string; phases: string[] }> {
  const out: Array<{ name: string; phases: string[] }> = []
  for (const h of hosts) {
    const hooks = (
      h.spec as { guardrails?: { hooks?: Record<string, Array<{ id?: string }>> } } | undefined
    )?.guardrails?.hooks
    if (!hooks) continue
    const phases = HOST_HOOK_PHASES.filter(phase => {
      const refs = hooks[phase]
      return Array.isArray(refs) && refs.some(r => r?.id === hookName)
    })
    if (phases.length > 0) out.push({ name: h.metadata?.name || 'unknown', phases: [...phases] })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function StatusBadge({ status }: { status?: LlmHookStatus }) {
  const ready = status?.conditions?.find(c => c.type === 'Ready' && c.status === 'True')
  const failing = status?.conditions?.find(c => c.status === 'False')
  const state = ready
    ? 'ready'
    : failing
      ? 'error'
      : status?.conditions?.length
        ? 'pending'
        : 'unknown'
  const label =
    state === 'ready'
      ? 'Ready'
      : state === 'error'
        ? 'Error'
        : state === 'pending'
          ? 'Pending'
          : 'Unknown'
  return (
    <span
      className={`cu-connector-badge cu-connector-badge--status-${state}`}
      title={failing?.message}
    >
      {label}
    </span>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="cu-summary-list__row">
      <span>{label}</span>
      <span>{children}</span>
    </div>
  )
}

export default function GuardrailDetailPage() {
  const params = useParams<{ name: string }>()
  const name = decodeURIComponent(String(params?.name ?? ''))
  const router = useRouter()
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()
  const [hook, setHook] = useState<LlmHookResource | null>(null)
  const [hosts, setHosts] = useState<HostResource[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [uninstalling, setUninstalling] = useState(false)

  async function load() {
    setLoading(true)
    setError('')
    try {
      const [h, hostResult] = await Promise.all([getLlmHook(name), getHosts()])
      setHook(h)
      setHosts((hostResult.items ?? []) as HostResource[])
    } catch (e) {
      if (isSilentApiError(e)) return
      setError(e instanceof Error ? e.message : 'Failed to load guardrail')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (name) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name])

  const spec = (hook?.spec ?? {}) as HookSpec
  const target = describeTarget(spec.target)
  const agents = useMemo(() => agentsUsingHook(hosts, name), [hosts, name])

  async function handleUninstall() {
    const ok = await confirm({
      title: 'Uninstall Guardrail',
      message: `Uninstall guardrail ${name}? This removes the LlmHook and its deployment.`,
      confirmLabel: 'Uninstall',
      tone: 'danger',
    })
    if (!ok) return
    setUninstalling(true)
    try {
      await deleteLlmHook(name)
      showToast(`Guardrail ${name} uninstalled.`, { tone: 'success' })
      router.push(CONTROL_ROUTES.guardrails.root)
    } catch (e) {
      if (!isSilentApiError(e)) {
        setError(e instanceof Error ? e.message : 'Failed to uninstall guardrail')
      }
      setUninstalling(false)
    }
  }

  return (
    <DashboardLayout>
      <div style={{ marginBottom: 'var(--cu-space-2)' }}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push(CONTROL_ROUTES.guardrails.root)}
        >
          ← Installed Guardrails
        </Button>
      </div>

      {error ? (
        <div className="cu-banner cu-banner--error" role="alert">
          {error}
        </div>
      ) : null}

      {loading && !hook ? (
        <div className="cu-card">
          <div className="cu-card__body cu-muted">Loading guardrail…</div>
        </div>
      ) : !hook ? (
        <div className="cu-empty">Guardrail not found.</div>
      ) : (
        <>
          <FormSection title={name} description="Installed guardrail hook.">
            <div className="cu-summary-list">
              <Row label="Status">
                <StatusBadge status={hook.status} />
              </Row>
              <Row label={target.kind}>
                <strong className="cu-expandable-field__code">{target.value}</strong>
              </Row>
              <Row label="Path">{spec.path || '/'}</Row>
              <Row label="Lifecycle points">{(spec.lifecyclePoints || []).join(', ') || '—'}</Row>
              <Row label="Fail mode">{spec.failMode || '—'}</Row>
              <Row label="Capabilities">
                {spec.capabilities && spec.capabilities.length > 0 ? (
                  <span className="cu-expandable-tags">
                    {spec.capabilities.map(c => (
                      <span key={c} className="cu-registry-tag">
                        {c}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="cu-muted">None declared</span>
                )}
              </Row>
              <Row label="Observed digest">
                <strong className="cu-expandable-field__code">
                  {hook.status?.observedDigest || '—'}
                </strong>
              </Row>
              <Row label="Ready replicas">
                {typeof hook.status?.readyReplicas === 'number' ? hook.status.readyReplicas : '—'}
              </Row>
            </div>
            <div style={{ marginTop: 'var(--cu-space-3)' }}>
              <Button variant="danger" size="sm" onClick={handleUninstall} disabled={uninstalling}>
                {uninstalling ? 'Uninstalling…' : 'Uninstall'}
              </Button>
            </div>
          </FormSection>

          <FormSection
            title={`Agents using this guardrail (${agents.length})`}
            description="Agents whose guardrails reference this hook, and the lifecycle phases they use it in."
          >
            {agents.length === 0 ? (
              <div className="cu-empty">No agents reference this guardrail.</div>
            ) : (
              <div className="cu-table-wrap">
                <table className="cu-table cu-table--header-band">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>Phases</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agents.map(a => (
                      <tr
                        key={a.name}
                        className="cu-table__row cu-table__row--clickable"
                        role="button"
                        tabIndex={0}
                        onClick={() => router.push(CONTROL_ROUTES.agents.tab(a.name, 'guardrails'))}
                        onKeyDown={e => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            router.push(CONTROL_ROUTES.agents.tab(a.name, 'guardrails'))
                          }
                        }}
                        aria-label={`Open agent ${a.name} guardrails`}
                      >
                        <td>{a.name}</td>
                        <td>
                          <span className="cu-expandable-tags">
                            {a.phases.map(p => (
                              <span key={p} className="cu-registry-tag">
                                {PHASE_LABEL[p] || p}
                              </span>
                            ))}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </FormSection>
        </>
      )}
      {confirmDialog}
    </DashboardLayout>
  )
}
