'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { DataTable, TableViewport } from '@clerum/frontend-components'
import {
  GUARDRAIL_DEFAULT_TAB,
  GUARDRAIL_DETAIL_TABS,
  GUARDRAIL_TAB_LABELS,
  type GuardrailTab,
} from '../../../app/constants/guardrailDetails'
import { CONTROL_ROUTES } from '../../../app/constants/routes'
import { useConfirmDialog } from '../../../components/ConfirmDialog'
import { DetailPageShell } from '../../../components/DetailPageShell'
import { KebabMenu } from '../../../components/KebabMenu'
import { IconShield } from '../../../components/Sidebar/icons'
import { TablePanelHeader } from '../../../components/TablePanelHeader'
import { useToast } from '../../../components/Toast'
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

function parseGuardrailTab(value: string | undefined): GuardrailTab {
  return GUARDRAIL_DETAIL_TABS.find(tab => tab === value) ?? GUARDRAIL_DEFAULT_TAB
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

export default function GuardrailDetailPage() {
  const params = useParams<{ name: string; tab?: string }>()
  const name = decodeURIComponent(String(params?.name ?? ''))
  const router = useRouter()
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()
  const [hook, setHook] = useState<LlmHookResource | null>(null)
  const [hosts, setHosts] = useState<HostResource[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [uninstalling, setUninstalling] = useState(false)
  const [activeTab, setActiveTab] = useState<GuardrailTab>(() => parseGuardrailTab(params?.tab))

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

  useEffect(() => {
    setActiveTab(parseGuardrailTab(params?.tab))
  }, [params?.tab])

  const spec = (hook?.spec ?? {}) as HookSpec
  const target = describeTarget(spec.target)
  const agents = useMemo(() => agentsUsingHook(hosts, name), [hosts, name])

  function guardrailTabHref(tab: GuardrailTab): string {
    return CONTROL_ROUTES.guardrails.tab(name, tab)
  }

  function selectTab(tab: GuardrailTab) {
    setActiveTab(tab)
    router.replace(guardrailTabHref(tab))
  }

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
    <DetailPageShell<GuardrailTab>
      activeTab={activeTab}
      backLabel="Back to guardrails"
      contentMode="plain"
      error={error}
      icon={<IconShield />}
      onBack={() => router.push(CONTROL_ROUTES.guardrails.root)}
      onTabChange={selectTab}
      overlays={confirmDialog}
      subtitle="Guardrail details and runtime status."
      tabAriaLabel="Guardrail detail sections"
      tabClassName="cu-tabs--compact"
      tabs={GUARDRAIL_DETAIL_TABS.map(tab => ({
        value: tab,
        label: GUARDRAIL_TAB_LABELS[tab],
        href: guardrailTabHref(tab),
      }))}
      title={name || 'Guardrail'}
      titleActions={
        hook ? (
          <KebabMenu
            ariaLabel="More guardrail actions"
            items={[
              {
                label: uninstalling ? 'Uninstalling…' : 'Uninstall',
                disabled: uninstalling,
                danger: true,
                onClick: () => void handleUninstall(),
              },
            ]}
          />
        ) : undefined
      }
    >
      {loading && !hook ? (
        <div className="cu-card">
          <div className="cu-card__body cu-muted">Loading guardrail…</div>
        </div>
      ) : !hook ? (
        <div className="cu-card">
          <div className="cu-empty">Guardrail not found.</div>
        </div>
      ) : activeTab === 'details' ? (
        <div className="cu-card">
          <TablePanelHeader
            title="Details"
            subtitle="Runtime configuration reported by the installed hook."
          />
          <div className="cu-detail-summary">
            <div className="cu-detail-summary__fields">
              <div className="cu-detail-field">
                <span className="cu-detail-field__label">Status</span>
                <StatusBadge status={hook.status} />
              </div>
              <div className="cu-detail-field cu-detail-field--wide">
                <span className="cu-detail-field__label">{target.kind}</span>
                <strong className="cu-detail-field__code">{target.value}</strong>
              </div>
              <div className="cu-detail-field">
                <span className="cu-detail-field__label">Path</span>
                <span>{spec.path || '/'}</span>
              </div>
              <div className="cu-detail-field">
                <span className="cu-detail-field__label">Order</span>
                <span>{typeof spec.order === 'number' ? spec.order : '—'}</span>
              </div>
              <div className="cu-detail-field">
                <span className="cu-detail-field__label">Fail mode</span>
                <span>{spec.failMode || '—'}</span>
              </div>
              <div className="cu-detail-field cu-detail-field--wide">
                <span className="cu-detail-field__label">Lifecycle points</span>
                {spec.lifecyclePoints && spec.lifecyclePoints.length > 0 ? (
                  <span className="cu-detail-tags">
                    {spec.lifecyclePoints.map(point => (
                      <span key={point} className="cu-registry-tag">
                        {PHASE_LABEL[point] || point}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="cu-muted">None declared</span>
                )}
              </div>
              <div className="cu-detail-field cu-detail-field--wide">
                <span className="cu-detail-field__label">Capabilities</span>
                {spec.capabilities && spec.capabilities.length > 0 ? (
                  <span className="cu-detail-tags">
                    {spec.capabilities.map(capability => (
                      <span key={capability} className="cu-registry-tag">
                        {capability}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="cu-muted">None declared</span>
                )}
              </div>
              <div className="cu-detail-field cu-detail-field--wide">
                <span className="cu-detail-field__label">Observed digest</span>
                <strong className="cu-detail-field__code">
                  {hook.status?.observedDigest || '—'}
                </strong>
              </div>
              <div className="cu-detail-field">
                <span className="cu-detail-field__label">Ready replicas</span>
                <span>
                  {typeof hook.status?.readyReplicas === 'number' ? hook.status.readyReplicas : '—'}
                </span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="cu-card">
          <TablePanelHeader
            title={`Agents with access (${agents.length})`}
            subtitle="Agents whose guardrails reference this hook, and the lifecycle phases they use it in."
          />
          {agents.length === 0 ? (
            <div className="cu-empty">No agents reference this guardrail.</div>
          ) : (
            <TableViewport className="cu-table-wrap">
              <DataTable className="eft-table cu-table cu-table--header-band">
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
                        <span className="cu-detail-tags">
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
              </DataTable>
            </TableViewport>
          )}
        </div>
      )}
    </DetailPageShell>
  )
}
