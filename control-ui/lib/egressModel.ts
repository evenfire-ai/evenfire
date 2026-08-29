export const MAX_EGRESS_BINDINGS = 20
export const PUBLIC_WEB_PORTS = [80, 443] as const

export type EgressMode =
  | 'none'
  | 'exact-host'
  | 'exact-cidr'
  | 'public-web'
  | 'provider'
  | 'advanced'

export type EgressBinding = {
  egressClass?: 'exact-host' | 'public-web' | 'provider'
  dns?: string
  cidr?: string
  port?: number
  protocol?: 'TCP' | 'UDP'
  /** issue #299 Phase 2 — provider-netblock intent (open strings, catalog-checked). */
  provider?: { name: string; categories?: string[] }
}

export type EgressSummary = {
  domains?: string[]
  ports?: number[]
  wideCidr?: boolean
}

type RegistryEgressSource = {
  server_mode?: string | null
  mcp_server_meta?: {
    remoteEndpoints?: Array<{ url?: string | null }>
    egressSummary?: EgressSummary
  } | null
}

export type EgressEditorStatus = {
  mode: EgressMode
  domains: string[]
  cidrs: string[]
  ports: number[]
  bindingCount: number
  bindings?: EgressBinding[]
  errors: string[]
  blockingError?: string
}

const BLOCKED_EGRESS_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.31.196.0/24',
  '192.52.193.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '192.175.48.0/24',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
]

export type WorkflowEgressFinding = {
  key: string
  label: string
  mode: EgressMode
  bindingCount: number
  severity: 'info' | 'warning' | 'error'
  message: string
  targets?: string[]
  ports?: number[]
  /** issue #299 Phase 2 — provider-mode findings: "name (category, …)" per provider. */
  providers?: string[]
}

function splitList(input: string): string[] {
  return input
    .split(/[,\n]/)
    .map(value => value.trim())
    .filter(Boolean)
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values))
}

function isIpv4Literal(value: string): boolean {
  const parts = value.split('.')
  return (
    parts.length === 4 &&
    parts.every(part => {
      if (!/^\d+$/.test(part)) return false
      const parsed = Number(part)
      return Number.isInteger(parsed) && parsed >= 0 && parsed <= 255
    })
  )
}

function ipv4ToInt(ip: string): number | null {
  if (!isIpv4Literal(ip)) return null
  return ip.split('.').reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0)
}

function cidrRange(cidr: string): { start: number; end: number; canonical: boolean } | null {
  const match = cidr.match(/^(\d+(?:\.\d+){3})\/(\d{1,2})$/)
  if (!match) return null
  const base = ipv4ToInt(match[1])
  const prefix = Number(match[2])
  if (base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  const start = (base & mask) >>> 0
  const size = 2 ** (32 - prefix)
  return { start, end: (start + size - 1) >>> 0, canonical: base === start }
}

function cidrOverlaps(left: string, right: string): boolean {
  const a = cidrRange(left)
  const b = cidrRange(right)
  if (!a || !b) return false
  return a.start <= b.end && b.start <= a.end
}

function isBlockedInternalHostname(domain: string): boolean {
  return (
    domain === 'localhost' ||
    domain === 'metadata.goog' ||
    domain === 'kubernetes.default' ||
    domain.endsWith('.localhost') ||
    domain.endsWith('.local') ||
    domain.endsWith('.internal') ||
    domain.endsWith('.svc') ||
    domain.endsWith('.svc.cluster.local') ||
    domain.endsWith('.cluster.local')
  )
}

export function normalizeEgressDomains(input: string): { domains: string[]; errors: string[] } {
  const errors: string[] = []
  const domains = unique(
    splitList(input).map(domain => domain.toLowerCase().replace(/\.$/, '').trim())
  )

  domains.forEach((domain, index) => {
    const field = `domain ${index + 1}`
    if (domain.includes('://')) {
      errors.push(`${field} must be a hostname, not a URL`)
    }
    if (domain.includes('/')) {
      errors.push(`${field} must not use path or CIDR notation`)
    }
    if (domain === '*' || domain.startsWith('*.')) {
      errors.push(`${field} must not use wildcards`)
    }
    if (isIpv4Literal(domain) || domain.includes(':')) {
      errors.push(`${field} must be a DNS hostname, not an IP literal`)
    }
    if (isBlockedInternalHostname(domain)) {
      errors.push(`${field} must be a public DNS hostname`)
    }
    if (domain.endsWith('.svc') || domain.endsWith('.svc.cluster.local')) {
      errors.push(`${field} must not target cluster-internal service DNS`)
    }
    if (
      !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)
    ) {
      errors.push(`${field} is not a valid DNS hostname`)
    }
  })

  return { domains, errors }
}

export function normalizeEgressPorts(input: string): { ports: number[]; errors: string[] } {
  const errors: string[] = []
  const ports = unique(
    splitList(input).flatMap((value, index) => {
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        errors.push(`port ${index + 1} must be an integer between 1 and 65535`)
        return []
      }
      return [parsed]
    })
  )
  return { ports, errors }
}

export function normalizeEgressCidrs(input: string): { cidrs: string[]; errors: string[] } {
  const errors: string[] = []
  const cidrs = unique(
    splitList(input).map(value => {
      const normalized = value.trim()
      return isIpv4Literal(normalized) ? `${normalized}/32` : normalized
    })
  )

  cidrs.forEach((cidr, index) => {
    const field = `CIDR ${index + 1}`
    const range = cidrRange(cidr)
    if (!range) {
      errors.push(`${field} must be an IPv4 address or CIDR`)
      return
    }
    if (!range.canonical) {
      errors.push(`${field} must use canonical network CIDR notation`)
    }
    if (BLOCKED_EGRESS_CIDRS.some(blocked => cidrOverlaps(cidr, blocked))) {
      errors.push(
        `${field} must not overlap private, metadata, link-local, documentation, multicast, or reserved IPv4 ranges`
      )
    }
  })

  return { cidrs, errors }
}

export function buildMcpEgressStatus(
  mode: EgressMode,
  domainInput: string,
  portInput: string
): EgressEditorStatus {
  if (mode === 'advanced') {
    return {
      mode,
      domains: [],
      cidrs: [],
      ports: [],
      bindingCount: 0,
      errors: ['Advanced egress bindings cannot be saved by this editor'],
      blockingError: 'Advanced egress bindings cannot be saved by this editor',
    }
  }
  if (mode === 'none') {
    return { mode, domains: [], cidrs: [], ports: [], bindingCount: 0, errors: [] }
  }
  if (mode === 'public-web') {
    return {
      mode,
      domains: [],
      cidrs: [],
      ports: [...PUBLIC_WEB_PORTS],
      bindingCount: 1,
      bindings: [{ egressClass: 'public-web' }],
      errors: [],
    }
  }

  if (mode === 'exact-cidr') {
    const { cidrs, errors: cidrErrors } = normalizeEgressCidrs(domainInput)
    const { ports, errors: portErrors } = normalizeEgressPorts(portInput)
    const errors = [...cidrErrors, ...portErrors]
    if (cidrs.length === 0) errors.push('Add at least one public CIDR or IP')
    if (ports.length === 0) errors.push('Add at least one TCP port')
    const bindingCount = cidrs.length * ports.length
    if (bindingCount > MAX_EGRESS_BINDINGS) {
      errors.push(
        `This configuration expands to ${bindingCount} egress bindings, but the CRD maximum is ${MAX_EGRESS_BINDINGS}`
      )
    }
    const bindings =
      errors.length === 0
        ? cidrs.flatMap(cidr => ports.map(port => ({ cidr, port, protocol: 'TCP' as const })))
        : undefined

    return {
      mode,
      domains: [],
      cidrs,
      ports,
      bindingCount,
      bindings,
      errors,
      blockingError: errors[0],
    }
  }

  const { domains, errors: domainErrors } = normalizeEgressDomains(domainInput)
  const { ports, errors: portErrors } = normalizeEgressPorts(portInput)
  const errors = [...domainErrors, ...portErrors]
  if (domains.length === 0) errors.push('Add at least one exact-host domain')
  if (ports.length === 0) errors.push('Add at least one TCP port')

  const bindingCount = domains.length * ports.length
  if (bindingCount > MAX_EGRESS_BINDINGS) {
    errors.push(
      `This configuration expands to ${bindingCount} egress bindings, but the CRD maximum is ${MAX_EGRESS_BINDINGS}`
    )
  }

  const bindings =
    errors.length === 0
      ? domains.flatMap(dns => ports.map(port => ({ dns, port, protocol: 'TCP' as const })))
      : undefined

  return {
    mode: 'exact-host',
    domains,
    cidrs: [],
    ports,
    bindingCount,
    bindings,
    errors,
    blockingError: errors[0],
  }
}

export function deriveEgressEditorInputs(
  bindings: EgressBinding[] | undefined,
  options: { allowCidr?: boolean } = {}
): {
  mode: EgressMode
  domainInput: string
  portInput: string
} {
  if (!Array.isArray(bindings) || bindings.length === 0) {
    return { mode: 'none', domainInput: '', portInput: '443' }
  }
  if (bindings.length === 1 && bindings[0]?.egressClass === 'public-web') {
    return { mode: 'public-web', domainInput: '', portInput: '443' }
  }

  const exactHostBindings = bindings.filter(
    binding =>
      (binding.egressClass === undefined || binding.egressClass === 'exact-host') &&
      typeof binding.dns === 'string' &&
      typeof binding.port === 'number' &&
      (binding.protocol === undefined || binding.protocol === 'TCP') &&
      binding.cidr === undefined
  )
  if (exactHostBindings.length === bindings.length) {
    return {
      mode: 'exact-host',
      domainInput: unique(exactHostBindings.map(binding => binding.dns!)).join(', '),
      portInput: unique(exactHostBindings.map(binding => binding.port!)).join(', '),
    }
  }

  if (options.allowCidr) {
    const exactCidrBindings = bindings.filter(
      binding =>
        (binding.egressClass === undefined || binding.egressClass === 'exact-host') &&
        typeof binding.cidr === 'string' &&
        typeof binding.port === 'number' &&
        (binding.protocol === undefined || binding.protocol === 'TCP') &&
        binding.dns === undefined
    )
    if (exactCidrBindings.length === bindings.length) {
      return {
        mode: 'exact-cidr',
        domainInput: unique(exactCidrBindings.map(binding => binding.cidr!)).join(', '),
        portInput: unique(exactCidrBindings.map(binding => binding.port!)).join(', '),
      }
    }
  }

  return { mode: 'advanced', domainInput: '', portInput: '443' }
}

export function analyzeRegistryEgressSummary(summary: EgressSummary | undefined | null): {
  mode: EgressMode
  targets: string[]
  ports: number[]
  bindingCount: number
  blockingError?: string
} | null {
  if (!summary) return null
  const targets = unique((summary.domains ?? []).filter(Boolean))
  const wideCidr = summary.wideCidr === true
  if (wideCidr) {
    return { mode: 'public-web', targets, ports: [...PUBLIC_WEB_PORTS], bindingCount: 1 }
  }
  if (targets.length === 0) return null
  const ports = unique(
    (summary.ports ?? [443]).filter(
      port => typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535
    )
  )
  const normalizedPorts = ports.length > 0 ? ports : [443]
  const bindingCount = targets.length * normalizedPorts.length
  return {
    mode: 'exact-host',
    targets,
    ports: normalizedPorts,
    bindingCount,
    blockingError:
      bindingCount > MAX_EGRESS_BINDINGS
        ? `This registry entry expands to ${bindingCount} egress bindings, but the CRD maximum is ${MAX_EGRESS_BINDINGS}. Reduce domains/ports or explicitly select public-web.`
        : undefined,
  }
}

export function egressStatusToRegistrySummary(
  status: EgressEditorStatus | null | undefined
): EgressSummary | undefined {
  if (!status || status.errors.length > 0 || status.mode === 'advanced' || status.mode === 'none') {
    return undefined
  }
  if (status.mode === 'public-web') {
    return { domains: [], ports: [...PUBLIC_WEB_PORTS], wideCidr: true }
  }
  if (status.mode === 'exact-host') {
    return { domains: status.domains, ports: status.ports, wideCidr: false }
  }
  return undefined
}

export function registrySummaryToEgressBindings(
  summary: EgressSummary | undefined | null
): EgressBinding[] | undefined {
  const analysis = analyzeRegistryEgressSummary(summary)
  if (!analysis) return undefined
  if (analysis.mode === 'public-web') return [{ egressClass: 'public-web' }]
  if (analysis.mode !== 'exact-host') return undefined
  return analysis.targets.flatMap(dns =>
    analysis.ports.map(port => ({ dns, port, protocol: 'TCP' as const }))
  )
}

export function registryEntryToEgressBindings(
  entry: RegistryEgressSource
): EgressBinding[] | undefined {
  const remoteUrl =
    entry.server_mode === 'remote' ? entry.mcp_server_meta?.remoteEndpoints?.[0]?.url : ''
  if (remoteUrl) {
    try {
      const parsed = new URL(remoteUrl)
      return [
        {
          dns: parsed.hostname.toLowerCase(),
          port: parsed.port ? Number(parsed.port) : parsed.protocol === 'http:' ? 80 : 443,
          protocol: 'TCP',
        },
      ]
    } catch {
      return undefined
    }
  }
  return registrySummaryToEgressBindings(entry.mcp_server_meta?.egressSummary)
}

function formatProviderIntent(provider: EgressBinding['provider']): string[] {
  if (!provider || typeof provider.name !== 'string' || provider.name.length === 0) return []
  const categories = Array.isArray(provider.categories)
    ? provider.categories.filter(category => typeof category === 'string' && category.length > 0)
    : []
  return [categories.length > 0 ? `${provider.name} (${categories.join(', ')})` : provider.name]
}

function summarizeBindings(bindings: unknown): {
  mode: EgressMode
  bindingCount: number
  targets: string[]
  ports: number[]
  providers: string[]
} {
  if (!Array.isArray(bindings) || bindings.length === 0) {
    return { mode: 'none', bindingCount: 0, targets: [], ports: [], providers: [] }
  }
  const typed = bindings as EgressBinding[]
  const providerIntents = unique(
    typed
      .filter(binding => binding?.egressClass === 'provider')
      .flatMap(binding => formatProviderIntent(binding.provider))
  )
  if (typed.some(binding => binding?.egressClass === 'public-web')) {
    // public-web is the widest class, so it keeps the mode. But a mixed array is
    // admissible — the CRD and WRC validate PER BINDING, nothing rejects
    // public-web + provider together — and returning `providers: []` here made the
    // provider grant vanish from the approval view. The approver would consent to
    // "TCP 80/443" while a catalog-wide range was additionally granted on some
    // other port. Carry both; never summarise away the narrower-looking half.
    return {
      mode: 'public-web',
      bindingCount: typed.length,
      targets: [],
      ports: unique([
        ...PUBLIC_WEB_PORTS,
        ...typed
          .filter(binding => binding?.egressClass === 'provider')
          .flatMap(binding => (typeof binding.port === 'number' ? [binding.port] : [])),
      ]),
      providers: providerIntents,
    }
  }
  const targets = unique(
    typed.flatMap(binding => (binding.dns ? [binding.dns] : binding.cidr ? [binding.cidr] : []))
  )
  const ports = unique(
    typed.flatMap(binding => (typeof binding.port === 'number' ? [binding.port] : []))
  )
  // issue #299 Phase 2 — provider bindings render catalog CIDR ranges, not a
  // single-host /32, so they must never be summarized as exact-host.
  const providerBindings = typed.filter(binding => binding?.egressClass === 'provider')
  if (providerBindings.length > 0) {
    return {
      mode: 'provider',
      bindingCount: typed.length,
      targets,
      ports,
      providers: providerIntents,
    }
  }
  return {
    mode: 'exact-host',
    bindingCount: typed.length,
    targets,
    ports,
    providers: [],
  }
}

export function analyzeWorkflowRecipeEgress(
  parsed: { spec?: unknown } | null | undefined
): WorkflowEgressFinding[] {
  const findings: WorkflowEgressFinding[] = []
  const spec = parsed?.spec as Record<string, unknown> | undefined
  if (!spec) return findings

  const workloads = Array.isArray(spec.workloads)
    ? (spec.workloads as Record<string, unknown>[])
    : []
  workloads.forEach((workload, index) => {
    const isTransport = !!workload.transport
    const hasBindings = Array.isArray(workload.egressBindings) && workload.egressBindings.length > 0
    // Review every transport workload (to state default-deny even when closed) and
    // any non-transport workload that declares egressBindings. Plain deployments,
    // cronjobs, and stateful sets that reach the internet (or cluster-internal
    // hosts) must surface their rules too — not only MCP transports.
    if (!isTransport && !hasBindings) return
    const id = typeof workload.id === 'string' ? workload.id : `workload-${index}`
    const label = isTransport ? `Transport workload "${id}"` : `Workload "${id}"`
    const summary = summarizeBindings(workload.egressBindings)
    if (summary.mode === 'none') {
      findings.push({
        key: `workload-${index}-default-deny`,
        label,
        mode: 'none',
        bindingCount: 0,
        severity: 'info',
        message:
          'External internet egress is closed by default. Add exact-host, provider or public-web egressBindings if this workload must call public APIs.',
      })
      return
    }
    if (summary.bindingCount > MAX_EGRESS_BINDINGS) {
      findings.push({
        key: `workload-${index}-too-many`,
        label,
        mode: summary.mode,
        bindingCount: summary.bindingCount,
        severity: 'error',
        message: `This workload declares ${summary.bindingCount} egress bindings, but the CRD maximum is ${MAX_EGRESS_BINDINGS}.`,
        targets: summary.targets,
        ports: summary.ports,
      })
      return
    }
    findings.push({
      key: `workload-${index}-${summary.mode}`,
      label,
      mode: summary.mode,
      bindingCount: summary.bindingCount,
      severity: summary.mode === 'public-web' || summary.mode === 'provider' ? 'warning' : 'info',
      message:
        summary.mode === 'public-web'
          ? `Public web egress is explicitly enabled for TCP 80/443; private, metadata, cluster-internal, link-local, multicast, and reserved ranges remain blocked.${
              summary.providers.length > 0
                ? ` This workload ALSO declares provider-netblock egress for ${summary.providers.join(', ')} — catalog-rendered CIDR ranges, on the port(s) shown, beyond the 80/443 above.`
                : ''
            }`
          : summary.mode === 'provider'
            ? `Provider-netblock egress declares ${summary.bindingCount} binding(s)${summary.providers.length > 0 ? ` for ${summary.providers.join(', ')}` : ''}. Rendered CIDRs come from the cluster provider-netblocks catalog and can span wide ranges — not a single-host /32. FQDNs missing from the registry fall back to their explicitly declared categories; review those especially.`
            : `Exact-host egress declares ${summary.bindingCount} binding(s).`,
      targets: summary.targets,
      ports: summary.ports,
      // Carry providers on ANY mode that has them: a mixed public-web + provider
      // workload keeps public-web as its mode (it is the widest), and gating this
      // on mode === 'provider' made the provider grant invisible to the approver.
      ...(summary.providers.length > 0 ? { providers: summary.providers } : {}),
    })
  })

  // issue #299 Phase 2 — the sandbox UI pod can also declare provider-netblock
  // egress (spec.ui.egress.external[].provider); surface it so reviewers see the
  // catalog-rendered CIDR surface, not just workload egressBindings.
  const ui = spec.ui as Record<string, unknown> | undefined
  const uiEgress = ui?.egress as Record<string, unknown> | undefined
  const uiExternal = Array.isArray(uiEgress?.external)
    ? (uiEgress.external as Array<Record<string, unknown> | null | undefined>)
    : []
  const uiProviderEntries = uiExternal.filter(
    (entry): entry is Record<string, unknown> =>
      !!entry && typeof entry === 'object' && !!entry.provider
  )
  if (uiProviderEntries.length > 0) {
    const uiTargets = unique(
      uiProviderEntries.flatMap(entry => (typeof entry.fqdn === 'string' ? [entry.fqdn] : []))
    )
    const uiPorts = unique(
      uiProviderEntries.flatMap(entry => (typeof entry.port === 'number' ? [entry.port] : []))
    )
    const uiProviders = unique(
      uiProviderEntries.flatMap(entry =>
        formatProviderIntent(entry.provider as EgressBinding['provider'])
      )
    )
    findings.push({
      key: 'ui-egress-provider',
      label: 'Sandbox UI egress',
      mode: 'provider',
      bindingCount: uiProviderEntries.length,
      severity: 'warning',
      message: `Sandbox UI declares ${uiProviderEntries.length} provider-netblock egress entr${uiProviderEntries.length === 1 ? 'y' : 'ies'}${uiProviders.length > 0 ? ` for ${uiProviders.join(', ')}` : ''}. Rendered CIDRs come from the cluster provider-netblocks catalog and can span wide ranges — not a single-host /32. FQDNs missing from the registry fall back to their explicitly declared categories; review those especially.`,
      targets: uiTargets,
      ports: uiPorts,
      providers: uiProviders,
    })
  }

  const runtimeHttp = (spec.runtimeEgress as Record<string, unknown> | undefined)?.http as
    | Record<string, unknown>
    | undefined
  const runtimeHttpEgressClass =
    runtimeHttp?.egressClass === 'public-web' ? 'public-web' : 'exact-host'
  if (runtimeHttp) {
    const egressClass = runtimeHttpEgressClass
    const allowedHosts = Array.isArray(runtimeHttp.allowedHosts)
      ? runtimeHttp.allowedHosts.filter((host): host is string => typeof host === 'string')
      : []
    const publicWebWithHosts = egressClass === 'public-web' && allowedHosts.length > 0
    const bindingCount =
      egressClass === 'public-web' && !publicWebWithHosts ? 1 : allowedHosts.length
    findings.push({
      key: 'runtime-http-egress',
      label: 'Workflow runtime HTTP egress',
      mode: egressClass,
      bindingCount,
      severity: publicWebWithHosts
        ? 'error'
        : bindingCount > MAX_EGRESS_BINDINGS
          ? 'error'
          : egressClass === 'public-web'
            ? 'warning'
            : 'info',
      message: publicWebWithHosts
        ? 'runtimeEgress.http.allowedHosts must be omitted when egressClass is public-web.'
        : bindingCount > MAX_EGRESS_BINDINGS
          ? `runtimeEgress.http.allowedHosts declares ${bindingCount} hosts, but the maximum is ${MAX_EGRESS_BINDINGS}.`
          : egressClass === 'public-web'
            ? 'Runtime HTTP public-web egress is explicitly enabled.'
            : `Runtime HTTP exact-host egress declares ${bindingCount} allowed host(s).`,
      targets: allowedHosts,
      ports: egressClass === 'public-web' ? [...PUBLIC_WEB_PORTS] : [443],
    })
  }

  const steps = Array.isArray(spec.steps) ? (spec.steps as Record<string, unknown>[]) : []
  steps.forEach((step, index) => {
    const run = step.run as Record<string, unknown> | undefined
    const capabilities = run?.capabilities as Record<string, unknown> | undefined
    const http = capabilities?.http as Record<string, unknown> | undefined
    if (!http) return
    const egressClass = http.egressClass === 'public-web' ? 'public-web' : 'exact-host'
    const allowedHosts = Array.isArray(http.allowedHosts)
      ? http.allowedHosts.filter((host): host is string => typeof host === 'string')
      : []
    const publicWebWithHosts = egressClass === 'public-web' && allowedHosts.length > 0
    const publicWebWithoutRuntime =
      egressClass === 'public-web' && runtimeHttpEgressClass !== 'public-web'
    const exactHostsUnderRuntimePublicWeb =
      egressClass === 'exact-host' &&
      runtimeHttpEgressClass === 'public-web' &&
      allowedHosts.length > 0
    const bindingCount =
      egressClass === 'public-web' && !publicWebWithHosts ? 1 : allowedHosts.length
    const stepId = typeof step.id === 'string' ? step.id : `step-${index}`
    findings.push({
      key: `step-${index}-http-egress`,
      label: `Step "${stepId}" HTTP egress`,
      mode: egressClass,
      bindingCount,
      severity:
        publicWebWithHosts || publicWebWithoutRuntime || exactHostsUnderRuntimePublicWeb
          ? 'error'
          : bindingCount > MAX_EGRESS_BINDINGS
            ? 'error'
            : egressClass === 'public-web'
              ? 'warning'
              : 'info',
      message: publicWebWithoutRuntime
        ? 'Step HTTP public-web requires spec.runtimeEgress.http.egressClass public-web.'
        : publicWebWithHosts
          ? 'Step HTTP allowedHosts must be omitted when egressClass is public-web.'
          : exactHostsUnderRuntimePublicWeb
            ? 'Step HTTP allowedHosts cannot be used when spec.runtimeEgress.http.egressClass is public-web.'
            : bindingCount > MAX_EGRESS_BINDINGS
              ? `Step HTTP allowedHosts declares ${bindingCount} hosts, but the maximum is ${MAX_EGRESS_BINDINGS}.`
              : egressClass === 'public-web'
                ? 'Step HTTP public-web egress is explicitly requested.'
                : `Step HTTP exact-host egress declares ${bindingCount} allowed host(s).`,
      targets: allowedHosts,
      ports: egressClass === 'public-web' ? [...PUBLIC_WEB_PORTS] : [443],
    })
  })

  return findings
}
