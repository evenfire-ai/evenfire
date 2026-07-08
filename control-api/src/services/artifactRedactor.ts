/**
 * Best-effort substring redaction of secret values from chat-mode artifact
 * buffers before they're streamed to the desktop client.
 *
 * Threat model: shell_exec can write the per-Host env Secret into a file
 * under /tmp/clerum-output (the LLM may, after operator approval, run a
 * command like `env > leak.md`). The mcp-host output sanitizer only
 * inspects tool stdout/stderr — once a secret value is on disk, the
 * artifact-download path (`kubectl exec cat <file>`) bypasses it. This
 * helper closes that gap: control-api fetches the same set of secret
 * values mcp-host's ConfigStore would have surfaced, and substring-replaces
 * each occurrence in the buffer with `[REDACTED:<KEY>]` before sending.
 *
 * Coverage:
 *   - Text formats (md, txt, json, csv, log, html): exact byte-match works.
 *   - Binary formats (pdf, docx, xlsx): values are typically zip-compressed
 *     or stream-encoded inside the container, so a raw-byte substring scan
 *     usually finds nothing. This is a known best-effort limitation; the
 *     primary attack surface (`env > leak.md`) is text and is fully covered.
 *
 * Performance:
 *   - O(n × k) where n = file size, k = number of secret values. We scan
 *     the buffer once per value, ordered by descending length so a longer
 *     secret containing a shorter one is masked first (matches the mirror
 *     ordering in mcp-host/src/config/configStore.ts:listSecretEntries).
 */
import { K8sGateway } from '../k8s.js'

const PER_HOST_ENV_SECRET_PREFIX = 'host-'
const PER_HOST_ENV_SECRET_SUFFIX = '-env-secret'

interface SecretEntry {
  name: string
  value: string
}

interface HostCRD {
  metadata?: { name?: string; namespace?: string }
  spec?: { secretRef?: string }
}

interface K8sSecret {
  metadata?: { name?: string }
  // K8s API returns base64-encoded values under `data` and plaintext under
  // `stringData`. The TS client's getter usually surfaces both — we read
  // either and decode `data` ourselves to handle both shapes.
  data?: Record<string, string>
  stringData?: Record<string, string>
}

function decodeSecretField(raw: string | undefined): string | null {
  if (!raw) return null
  // K8s `data` values are base64. Try to decode; if the result is empty,
  // assume the value was already plaintext (some clients return decoded).
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf-8')
    if (decoded.length > 0) return decoded
  } catch {
    /* fall through */
  }
  return raw
}

function collectEntries(secret: K8sSecret | null): SecretEntry[] {
  if (!secret) return []
  const out: SecretEntry[] = []
  for (const [name, raw] of Object.entries(secret.data || {})) {
    const value = decodeSecretField(raw)
    if (value && value.length >= 4) out.push({ name, value })
  }
  for (const [name, value] of Object.entries(secret.stringData || {})) {
    if (value && value.length >= 4) out.push({ name, value })
  }
  return out
}

/**
 * Read both the per-Host env Secret (`host-<hostRef>-env-secret`) and the
 * LLM provider Secret referenced by the Host CRD's `spec.secretRef`. Returns
 * a flat list of {name, value} pairs whose `value` should be considered
 * sensitive and redacted from artifact output.
 */
export async function loadHostSecretEntries(
  gateway: K8sGateway,
  hostRef: string,
  hostsNamespace: string
): Promise<SecretEntry[]> {
  const entries: SecretEntry[] = []
  const seen = new Set<string>()

  const addEntries = (es: SecretEntry[]) => {
    for (const e of es) {
      const key = `${e.name}=${e.value}`
      if (seen.has(key)) continue
      seen.add(key)
      entries.push(e)
    }
  }

  // Per-Host env Secret. May not exist if the operator hasn't set any
  // secret-typed env vars on this Host — that's fine, treat as empty.
  try {
    const envSecret = (await gateway.getSecret(
      `${PER_HOST_ENV_SECRET_PREFIX}${hostRef}${PER_HOST_ENV_SECRET_SUFFIX}`,
      hostsNamespace
    )) as K8sSecret | null
    addEntries(collectEntries(envSecret))
  } catch {
    /* 404 / forbidden — skip */
  }

  // LLM provider Secret via Host.spec.secretRef. Resolve the Host CRD first.
  try {
    const host = (await gateway.getResource('hosts', hostRef, hostsNamespace)) as HostCRD
    const llmSecretName = host?.spec?.secretRef
    if (llmSecretName) {
      const llmSecret = (await gateway.getSecret(llmSecretName, hostsNamespace)) as K8sSecret | null
      addEntries(collectEntries(llmSecret))
    }
  } catch {
    /* Host not found / Secret not found — skip */
  }

  // Sort longest-first so a longer secret that contains a shorter one is
  // masked before the shorter pass would erase its anchor — matches
  // mcp-host's BasicSafety.sanitizeFreeformContent ordering.
  entries.sort((a, b) => b.value.length - a.value.length)
  return entries
}

/**
 * In-place substring redaction of `buf`. Each occurrence of every entry's
 * value is replaced with `[REDACTED:<name>]`. Returns the new buffer.
 *
 * The replacement marker is shorter than every realistic secret (API keys
 * are typically 20+ chars), so the buffer never grows; we still allocate a
 * fresh Buffer because UTF-8 length math after replacement is fragile and
 * binary callers may rely on the exact length we report in Content-Length.
 */
export function redactArtifactBuffer(
  buf: Buffer,
  entries: SecretEntry[]
): { buffer: Buffer; redactedCount: number } {
  if (entries.length === 0) return { buffer: buf, redactedCount: 0 }
  // Round-trip via utf-8 string. Binary formats (pdf, xlsx as zip, etc.)
  // round-trip safely as long as we treat the bytes as latin1 — utf-8
  // would replace invalid sequences. We use latin1 so every byte 0x00-0xff
  // maps 1:1 and the substring replace is a true byte operation.
  let text = buf.toString('latin1')
  let redactedCount = 0
  const sortedEntries = [...entries].sort((a, b) => b.value.length - a.value.length)
  for (const entry of sortedEntries) {
    // Defense against caller passing an empty/short value directly:
    // String.prototype.split("") explodes the input by character and
    // join() interleaves the marker between every byte, corrupting
    // the buffer. The loader already filters length<4 but guard here
    // too so a misuse doesn't blow up an artifact download.
    if (!entry.value || entry.value.length < 4) continue
    const valueAsLatin1 = Buffer.from(entry.value, 'utf-8').toString('latin1')
    if (!text.includes(valueAsLatin1)) continue
    const marker = `[REDACTED:${entry.name}]`
    const before = text
    text = text.split(valueAsLatin1).join(marker)
    if (text !== before) redactedCount += 1
  }
  if (redactedCount === 0) return { buffer: buf, redactedCount: 0 }
  return { buffer: Buffer.from(text, 'latin1'), redactedCount }
}
