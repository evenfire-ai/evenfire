/**
 * McpServer CRD Spec Validation — API-layer early feedback.
 *
 * Purpose: UX safety net + defense-in-depth. The HCC reconciler applies
 * sanitizeCrdSpec() as a silent backstop; this module gives the operator
 * immediate 422 feedback before the CRD reaches K8s.
 *
 * This is NOT a security boundary — the admin already has full cluster access.
 * It prevents accidental misconfiguration (copy-paste errors, typos) and
 * provides consistent "platform decides deployment" semantics at the earliest
 * possible layer.
 */
import { lookup } from 'node:dns/promises'
import { classifyPluginImage } from '@clerum/image-policy'
import {
  WORKFLOW_RECIPE_DEFAULT_ALLOWED_CAPABILITIES,
  isWorkflowRecipeDefaultAllowedCapability,
} from '@clerum/workflow-recipe-capability-policy'

export interface ValidationError {
  field: string
  message: string
}

interface McpServerSpec {
  imagePullPolicy?: string
  security?: {
    runAsUser?: number
    addCapabilities?: string[]
  }
  env?: Array<{ name: string; value?: string; valueFrom?: unknown }>
  resources?: {
    limits?: { cpu?: string; memory?: string }
    requests?: { cpu?: string; memory?: string }
  }
  image?: unknown
  transport?: unknown
  remote?: unknown
  egressBindings?: unknown
}

interface EgressBinding {
  egressClass?: unknown
  dns?: unknown
  cidr?: unknown
  port?: unknown
  protocol?: unknown
  provider?: unknown
}

export type DnsResolver = (hostname: string) => Promise<string[]>

const FORBIDDEN_ENV = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'PATH',
  'NODE_OPTIONS',
  'PYTHONPATH',
  'JAVA_TOOL_OPTIONS',
  'KUBECONFIG',
  'KUBERNETES_SERVICE_HOST',
  'KUBERNETES_SERVICE_PORT',
])

const MAX_CPU_MILLICORES = 4000
const MAX_MEM_MIB = 8192
const MAX_EGRESS_BINDINGS = 20
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (
    parts.length !== 4 ||
    parts.some(part => {
      if (!/^\d+$/.test(part)) return true
      const parsed = Number(part)
      return !Number.isInteger(parsed) || parsed < 0 || parsed > 255
    })
  ) {
    return null
  }
  return parts.reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0)
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

function isPublicDnsHostname(hostname: string): boolean {
  if (hostname !== hostname.trim()) return false
  if (hostname !== hostname.toLowerCase()) return false
  if (hostname.includes('*') || hostname.includes('/') || hostname.includes(':')) return false
  if (ipv4ToInt(hostname) !== null) return false
  if (!hostname.includes('.')) return false
  if (
    hostname === 'localhost' ||
    hostname === 'metadata.goog' ||
    hostname === 'kubernetes.default' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.svc') ||
    hostname.endsWith('.svc.cluster.local') ||
    hostname.endsWith('.cluster.local')
  ) {
    return false
  }
  return hostname.split('.').every(label => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
}

function validatePublicCidr(cidr: string): string | null {
  const range = cidrRange(cidr)
  if (!range) return 'cidr must be valid IPv4 CIDR notation'
  if (!range.canonical) return 'cidr must use canonical network CIDR notation'
  if (BLOCKED_EGRESS_CIDRS.some(blocked => cidrOverlaps(cidr, blocked))) {
    return 'cidr must not overlap private, metadata, link-local, documentation, multicast, or reserved IPv4 ranges'
  }
  return null
}

async function defaultDnsResolver(hostname: string): Promise<string[]> {
  const answers = await lookup(hostname, { family: 4, all: true, verbatim: true })
  return answers.map(answer => answer.address)
}

/** Parse a Kubernetes resource quantity like "4000m" or "8Gi" into a number. */
function parseCpuMillicores(val: string): number | null {
  if (val.endsWith('m')) return parseInt(val, 10)
  const asNum = parseFloat(val)
  if (isNaN(asNum)) return null
  return Math.round(asNum * 1000)
}

function parseMemoryMiB(val: string): number | null {
  if (val.endsWith('Gi')) return parseInt(val, 10) * 1024
  if (val.endsWith('Mi')) return parseInt(val, 10)
  if (val.endsWith('Ki')) return Math.round(parseInt(val, 10) / 1024)
  const asNum = parseFloat(val)
  if (isNaN(asNum)) return null
  return Math.round(asNum / (1024 * 1024))
}

export interface ImageAllowlistOptions {
  allowedImagePrefixes?: string[]
  enforceImageAllowlist?: boolean
}

/**
 * Validate an McpServer CRD spec at the API layer.
 * Returns an array of validation errors (empty = valid).
 */
export function validateMcpServerSpec(
  spec: Record<string, unknown>,
  options: ImageAllowlistOptions = {}
): ValidationError[] {
  const errors: ValidationError[] = []
  const s = spec as McpServerSpec

  // ── imagePullPolicy: platform decides, not the CRD author ──
  if (s.imagePullPolicy !== undefined) {
    errors.push({
      field: 'spec.imagePullPolicy',
      message:
        'imagePullPolicy is platform-controlled and cannot be set via the API. The HCC reconciler assigns it automatically.',
    })
  }

  // ── Security: root UID prevention ──
  if (s.security?.runAsUser !== undefined) {
    if (s.security.runAsUser < 1) {
      errors.push({
        field: 'spec.security.runAsUser',
        message: `runAsUser must be >= 1 (got ${s.security.runAsUser}). Root (UID 0) is not allowed.`,
      })
    }
  }

  // ── Security: Linux capabilities ──
  if (s.security?.addCapabilities) {
    const rejected = s.security.addCapabilities.filter(
      cap => !isWorkflowRecipeDefaultAllowedCapability(cap)
    )
    if (rejected.length > 0) {
      errors.push({
        field: 'spec.security.addCapabilities',
        message: `Capabilities not in the default-allowed set: ${rejected.join(', ')}. Allowed: ${WORKFLOW_RECIPE_DEFAULT_ALLOWED_CAPABILITIES.join(', ')}.`,
      })
    }
  }

  // ── Env vars: block dangerous names ──
  if (s.env && Array.isArray(s.env)) {
    const blocked = s.env
      .filter(e => FORBIDDEN_ENV.has((e.name ?? '').toUpperCase()))
      .map(e => e.name)
    if (blocked.length > 0) {
      errors.push({
        field: 'spec.env',
        message: `Dangerous env vars not allowed: ${blocked.join(', ')}. These can compromise the container runtime.`,
      })
    }
  }

  // ── Resources: clamp to platform limits ──
  if (s.resources?.limits) {
    if (s.resources.limits.cpu) {
      const cpu = parseCpuMillicores(s.resources.limits.cpu)
      if (cpu !== null && cpu > MAX_CPU_MILLICORES) {
        errors.push({
          field: 'spec.resources.limits.cpu',
          message: `CPU limit exceeds platform maximum (${s.resources.limits.cpu} > ${MAX_CPU_MILLICORES}m).`,
        })
      }
    }
    if (s.resources.limits.memory) {
      const mem = parseMemoryMiB(s.resources.limits.memory)
      if (mem !== null && mem > MAX_MEM_MIB) {
        errors.push({
          field: 'spec.resources.limits.memory',
          message: `Memory limit exceeds platform maximum (${s.resources.limits.memory} > 8Gi).`,
        })
      }
    }
  }

  // ── External egress: mirror CRD shape for early operator feedback ──
  if (s.egressBindings !== undefined) {
    if (!Array.isArray(s.egressBindings)) {
      errors.push({
        field: 'spec.egressBindings',
        message: 'egressBindings must be an array',
      })
    } else {
      if (s.egressBindings.length > MAX_EGRESS_BINDINGS) {
        errors.push({
          field: 'spec.egressBindings',
          message: `egressBindings must contain at most ${MAX_EGRESS_BINDINGS} items`,
        })
      }
      s.egressBindings.forEach((rawBinding, index) => {
        const field = `spec.egressBindings[${index}]`
        if (!isPlainObject(rawBinding)) {
          errors.push({ field, message: 'egress binding must be an object' })
          return
        }
        const binding = rawBinding as EgressBinding
        const egressClass = binding.egressClass ?? 'exact-host'
        if (
          egressClass !== 'exact-host' &&
          egressClass !== 'public-web' &&
          egressClass !== 'provider'
        ) {
          errors.push({
            field: `${field}.egressClass`,
            message: 'egressClass must be exact-host, public-web, or provider',
          })
          return
        }
        if (egressClass === 'public-web') {
          if (
            binding.dns !== undefined ||
            binding.cidr !== undefined ||
            binding.port !== undefined ||
            binding.protocol !== undefined
          ) {
            errors.push({
              field,
              message: 'public-web egressBindings must not declare dns, cidr, port, or protocol',
            })
          }
          return
        }

        if (egressClass === 'provider') {
          // issue #299 Phase 2 — provider mode: dns required (public), cidr
          // forbidden, and a provider object with an open-string name. Validity of
          // name/categories against the catalog is a reconcile-time check (G4).
          if (binding.cidr !== undefined) {
            errors.push({
              field: `${field}.cidr`,
              message: 'provider egressBindings must not declare cidr',
            })
          }
          const hasDns = typeof binding.dns === 'string' && binding.dns.trim().length > 0
          if (!hasDns) {
            errors.push({
              field: `${field}.dns`,
              message: 'provider egressBindings must declare dns',
            })
          } else if (!isPublicDnsHostname((binding.dns as string).trim())) {
            errors.push({ field: `${field}.dns`, message: 'dns must be a public DNS hostname' })
          }
          if (!isPlainObject(binding.provider)) {
            errors.push({
              field: `${field}.provider`,
              message: 'provider egressBindings must declare a provider object with name',
            })
          } else {
            const p = binding.provider as { name?: unknown; categories?: unknown }
            if (typeof p.name !== 'string' || !/^[a-z0-9-]{1,63}$/.test(p.name)) {
              errors.push({
                field: `${field}.provider.name`,
                message: 'provider.name must be a lowercase alphanumeric-dash string (1-63 chars)',
              })
            }
            if (
              p.categories !== undefined &&
              (!Array.isArray(p.categories) ||
                p.categories.length > 10 ||
                p.categories.some(c => typeof c !== 'string' || c.length < 1 || c.length > 63))
            ) {
              errors.push({
                field: `${field}.provider.categories`,
                message: 'provider.categories must be an array of up to 10 non-empty strings',
              })
            }
          }
        } else {
          if (binding.provider !== undefined) {
            errors.push({
              field: `${field}.provider`,
              message: 'provider declarations require egressClass "provider"',
            })
          }
          const hasDns = typeof binding.dns === 'string' && binding.dns.trim().length > 0
          const hasCidr = typeof binding.cidr === 'string' && binding.cidr.trim().length > 0
          if (hasDns === hasCidr) {
            errors.push({
              field,
              message: 'exact-host egressBindings must declare exactly one of dns or cidr',
            })
          }
          if (hasDns) {
            const dns = (binding.dns as string).trim()
            if (!isPublicDnsHostname(dns)) {
              errors.push({
                field: `${field}.dns`,
                message: 'dns must be a public DNS hostname',
              })
            }
          }
          if (hasCidr) {
            const cidr = (binding.cidr as string).trim()
            const cidrError = validatePublicCidr(cidr)
            if (cidrError) {
              errors.push({
                field: `${field}.cidr`,
                message: cidrError,
              })
            }
          }
        }
        if (
          typeof binding.port !== 'number' ||
          !Number.isInteger(binding.port) ||
          binding.port < 1 ||
          binding.port > 65535
        ) {
          errors.push({
            field: `${field}.port`,
            message: 'port must be an integer between 1 and 65535',
          })
        }
        if (
          binding.protocol !== undefined &&
          binding.protocol !== 'TCP' &&
          binding.protocol !== 'UDP'
        ) {
          errors.push({ field: `${field}.protocol`, message: 'protocol must be TCP or UDP' })
        }
      })

      // H4: two bindings on the same (dns,port) render the same NetworkPolicy name
      // with different specs → write thrash. Reject both loudly (parity with the
      // reconciler guard and the CRD spec-level CEL).
      const seenDnsPort = new Map<string, number[]>()
      s.egressBindings.forEach((raw, i) => {
        if (!isPlainObject(raw)) return
        const b = raw as EgressBinding
        if (typeof b.dns === 'string' && typeof b.port === 'number') {
          const k = `${b.dns.trim()} ${b.port}`
          seenDnsPort.set(k, [...(seenDnsPort.get(k) ?? []), i])
        }
      })
      for (const [k, idxs] of seenDnsPort) {
        if (idxs.length > 1) {
          const [dns, port] = k.split(' ')
          idxs.forEach(i =>
            errors.push({
              field: `spec.egressBindings[${i}]`,
              message: `duplicate (dns, port) binding "${dns}:${port}" — NetworkPolicy names would collide`,
            })
          )
        }
      }
    }
  }
  if (
    s.remote !== undefined &&
    (!Array.isArray(s.egressBindings) || s.egressBindings.length === 0)
  ) {
    errors.push({
      field: 'spec.egressBindings',
      message: 'remote MCP servers must declare at least one egressBinding',
    })
  }

  // ── Plugin image-host allowlist (2.3) — local-mode only, enforce → 422 ──
  if (
    options.enforceImageAllowlist === true &&
    s.remote === undefined &&
    typeof s.image === 'string' &&
    s.image.trim().length > 0
  ) {
    const decision = classifyPluginImage(s.image, {
      allowedPrefixes: options.allowedImagePrefixes ?? [],
      rejectLatest: false,
    })
    if (!decision.ok) {
      errors.push({
        field: 'spec.image',
        message: `Image "${s.image}" is not permitted by the plugin image allowlist (${decision.reason}).`,
      })
    }
  }

  return errors
}

export async function validateMcpServerSpecPreflight(
  spec: Record<string, unknown>,
  options: { resolveDns?: DnsResolver } & ImageAllowlistOptions = {}
): Promise<ValidationError[]> {
  const errors = validateMcpServerSpec(spec, {
    allowedImagePrefixes: options.allowedImagePrefixes,
    enforceImageAllowlist: options.enforceImageAllowlist,
  })
  const s = spec as McpServerSpec
  if (!Array.isArray(s.egressBindings)) return errors

  const resolveDns = options.resolveDns ?? defaultDnsResolver
  const hostFields = new Map<string, string[]>()
  s.egressBindings.forEach((rawBinding, index) => {
    if (!isPlainObject(rawBinding)) return
    const binding = rawBinding as EgressBinding
    const egressClass = binding.egressClass ?? 'exact-host'
    if (
      (egressClass !== 'exact-host' && egressClass !== 'provider') ||
      typeof binding.dns !== 'string'
    )
      return
    const dns = binding.dns.trim()
    if (!isPublicDnsHostname(dns)) return
    const fields = hostFields.get(dns) ?? []
    fields.push(`spec.egressBindings[${index}].dns`)
    hostFields.set(dns, fields)
  })

  await Promise.all(
    [...hostFields.entries()].map(async ([dns, fields]) => {
      try {
        const addresses = Array.from(new Set(await resolveDns(dns)))
        if (addresses.length === 0) {
          fields.forEach(field =>
            errors.push({ field, message: `dns "${dns}" did not resolve to an IPv4 A record` })
          )
          return
        }
        const blocked = addresses.filter(address => {
          if (ipv4ToInt(address) === null) return true
          return validatePublicCidr(`${address}/32`) !== null
        })
        if (blocked.length > 0) {
          fields.forEach(field =>
            errors.push({
              field,
              message:
                `dns "${dns}" resolved to blocked IPv4 address(es): ${blocked.join(', ')}. ` +
                'Exact-host egress must not resolve to private, metadata, link-local, multicast, reserved, or internal ranges.',
            })
          )
        }
      } catch (error) {
        fields.forEach(field =>
          errors.push({
            field,
            message: `dns "${dns}" could not be resolved: ${
              error instanceof Error ? error.message : String(error)
            }`,
          })
        )
      }
    })
  )

  return errors
}

export async function validateEgressBindingsPreflight(
  egressBindings: unknown,
  fieldPrefix = 'spec.egressBindings',
  options: { resolveDns?: DnsResolver; allowCidr?: boolean } = {}
): Promise<ValidationError[]> {
  const errors = await validateMcpServerSpecPreflight({ egressBindings }, options)
  if (options.allowCidr === false && Array.isArray(egressBindings)) {
    egressBindings.forEach((rawBinding, index) => {
      if (!isPlainObject(rawBinding)) return
      const binding = rawBinding as EgressBinding
      if (binding.cidr !== undefined) {
        errors.push({
          field: `spec.egressBindings[${index}].cidr`,
          message: 'cidr is not supported on this egress surface; use dns exact-host or public-web',
        })
      }
    })
  }
  return errors.map(error => ({
    ...error,
    field: error.field.replace(/^spec\.egressBindings/, fieldPrefix),
  }))
}
