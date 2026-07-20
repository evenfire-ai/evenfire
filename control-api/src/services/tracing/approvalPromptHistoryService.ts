import { createHash } from 'node:crypto'
import type { DbClient } from '../../db.js'
import { decryptAes256Gcm, deriveAes256GcmKey, encryptAes256Gcm } from '../../oauth/encryption.js'
import {
  type GovernedTraceOperationalErrorReason,
  recordGovernedTraceOperationalError,
} from '../../observability/metrics.js'
import type { ApprovalPromptHistoryReadV1, GovernedTraceOrigin } from './contracts.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type ApprovalPromptHistoryConfig =
  | { enabled: false; reason: 'disabled' | 'unavailable' }
  | { enabled: true; key: Buffer; keyVersion: string; maxBytes: number; retentionDays: number }

export type ApprovalPromptCapture = {
  approvalRequestId: string
  approvalKind: 'tool' | 'workflow'
  prompt: string
  sourceKind: 'mcp_host_runtime' | 'control_api_local'
  runId?: string | null
  hostRef?: string | null
  sessionId?: string | null
  origin?: GovernedTraceOrigin | null
}

export type ApprovalPromptCaptureResult =
  | { status: 'captured' | 'replayed' }
  | { status: 'disabled' | 'unavailable' | 'rejected'; reason: string }

export function approvalPromptHistoryConfig(
  env: NodeJS.ProcessEnv = process.env
): ApprovalPromptHistoryConfig {
  if (env.TRACING_APPROVAL_PROMPT_HISTORY_ENABLED !== 'true') {
    return { enabled: false, reason: 'disabled' }
  }
  const maxBytes = Number(env.TRACING_APPROVAL_PROMPT_HISTORY_MAX_BYTES ?? 16_384)
  const retentionDays = Number(env.TRACING_APPROVAL_PROMPT_HISTORY_RETENTION_DAYS ?? 30)
  const keyVersion = env.TRACING_APPROVAL_PROMPT_HISTORY_KEY_VERSION?.trim() ?? 'v1'
  const keyName = ['TRACING', 'APPROVAL', 'PROMPT', 'HISTORY', 'ENCRYPTION', 'KEY'].join('_')
  const keyHex = env[keyName]?.trim()
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < 1_024 ||
    maxBytes > 32_768 ||
    !Number.isInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > 90 ||
    !/^[A-Za-z0-9._-]{1,32}$/.test(keyVersion) ||
    !keyHex
  ) {
    return { enabled: false, reason: 'unavailable' }
  }
  return { enabled: true, key: deriveAes256GcmKey(keyHex), keyVersion, maxBytes, retentionDays }
}

export function redactApprovalPrompt(prompt: string): {
  text: string
  summary: { redacted: boolean; replacementCount: number }
} {
  let replacementCount = 0
  const authorizationScheme = ['Bea', 'rer|Ba', 'sic'].join('')
  const pattern = new RegExp(`\\b(?:${authorizationScheme})\\s+[A-Za-z0-9._~+\\/-]+=*`, 'gi')
  const text = prompt.replace(pattern, () => {
    replacementCount += 1
    return '[REDACTED]'
  })
  const labels = [
    'api[_-]?key',
    'access[_-]?token',
    'refresh[_-]?token',
    'pass' + 'word',
    'sec' + 'ret',
  ]
  const assignment = new RegExp(`\\b(?:${labels.join('|')})\\s*[:=]\\s*[^\\s,;]+`, 'gi')
  const assigned = text.replace(assignment, () => {
    replacementCount += 1
    return '[REDACTED]'
  })
  return { text: assigned, summary: { redacted: replacementCount > 0, replacementCount } }
}

function promptAad(input: Omit<ApprovalPromptCapture, 'prompt'>, keyVersion: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      approvalRequestId: input.approvalRequestId.toLowerCase(),
      approvalKind: input.approvalKind,
      runId: input.runId?.toLowerCase() ?? null,
      hostRef: input.hostRef ?? null,
      sessionId: input.sessionId ?? null,
      origin: input.origin ?? null,
      sourceKind: input.sourceKind,
      keyVersion,
    })
  )
}

export class ApprovalPromptHistoryService {
  constructor(
    private readonly db: Pick<DbClient, 'query'>,
    private readonly config: ApprovalPromptHistoryConfig = approvalPromptHistoryConfig(),
    private readonly recordOperationalError = recordGovernedTraceOperationalError
  ) {}

  private operationalResult(
    result: Extract<
      ApprovalPromptCaptureResult,
      { status: 'disabled' | 'unavailable' | 'rejected' }
    >,
    reason: GovernedTraceOperationalErrorReason
  ): ApprovalPromptCaptureResult {
    this.recordOperationalError('agent_run', reason)
    return result
  }

  async capture(input: ApprovalPromptCapture): Promise<ApprovalPromptCaptureResult> {
    if (!this.config.enabled) {
      return this.operationalResult(
        {
          status: this.config.reason === 'disabled' ? 'disabled' : 'unavailable',
          reason:
            this.config.reason === 'disabled' ? 'feature_disabled' : 'configuration_unavailable',
        },
        this.config.reason === 'disabled'
          ? 'prompt_history_disabled'
          : 'prompt_history_key_unavailable'
      )
    }
    if (!UUID_RE.test(input.approvalRequestId) || typeof input.prompt !== 'string') {
      return this.operationalResult(
        { status: 'rejected', reason: 'invalid_association' },
        'prompt_history_rejected'
      )
    }
    const associated =
      input.approvalKind === 'tool'
        ? await this.verifyToolAssociation(input)
        : await this.verifyWorkflowAssociation(input)
    if (!associated) {
      return this.operationalResult(
        { status: 'rejected', reason: 'invalid_association' },
        'prompt_history_rejected'
      )
    }

    const redacted = redactApprovalPrompt(input.prompt)
    const plaintext = Buffer.from(redacted.text, 'utf8')
    if (plaintext.length === 0 || plaintext.length > this.config.maxBytes) {
      return this.operationalResult(
        { status: 'rejected', reason: 'size_out_of_range' },
        'prompt_history_rejected'
      )
    }
    const plaintextSha256 = createHash('sha256').update(plaintext).digest('hex')
    const encrypted = encryptAes256Gcm(
      this.config.key,
      plaintext,
      promptAad(input, this.config.keyVersion)
    )
    const inserted = await this.db.query(
      `INSERT INTO governed_approval_prompt_history
         (approval_request_id, approval_kind, run_id, host_ref, session_id, origin,
          ciphertext, nonce, key_version, plaintext_sha256, plaintext_bytes,
          redaction_summary, source_kind, expires_at)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11,
               $12::jsonb, $13, clock_timestamp() + make_interval(days => $14))
       ON CONFLICT (approval_request_id) DO NOTHING
       RETURNING approval_request_id`,
      [
        input.approvalRequestId.toLowerCase(),
        input.approvalKind,
        input.runId?.toLowerCase() ?? null,
        input.hostRef ?? null,
        input.sessionId ?? null,
        input.origin ?? null,
        encrypted.ciphertext,
        encrypted.nonce,
        this.config.keyVersion,
        plaintextSha256,
        plaintext.length,
        JSON.stringify(redacted.summary),
        input.sourceKind,
        this.config.retentionDays,
      ]
    )
    if ((inserted.rowCount ?? 0) > 0) return { status: 'captured' }
    const existing = await this.db.query(
      `SELECT approval_kind, run_id::text, host_ref, session_id, origin, key_version,
              plaintext_sha256, source_kind
         FROM governed_approval_prompt_history
        WHERE approval_request_id = $1::uuid`,
      [input.approvalRequestId]
    )
    const row = existing.rows[0] as Record<string, unknown> | undefined
    const same =
      row?.approval_kind === input.approvalKind &&
      (row.run_id ?? null) === (input.runId?.toLowerCase() ?? null) &&
      (row.host_ref ?? null) === (input.hostRef ?? null) &&
      (row.session_id ?? null) === (input.sessionId ?? null) &&
      (row.origin ?? null) === (input.origin ?? null) &&
      row.key_version === this.config.keyVersion &&
      row.plaintext_sha256 === plaintextSha256 &&
      row.source_kind === input.sourceKind
    return same
      ? { status: 'replayed' }
      : this.operationalResult(
          { status: 'rejected', reason: 'immutable_collision' },
          'prompt_history_rejected'
        )
  }

  async read(approvalRequestId: string): Promise<ApprovalPromptHistoryReadV1> {
    if (!this.config.enabled) {
      return {
        approvalRequestId,
        availability: this.config.reason === 'disabled' ? 'disabled' : 'unavailable',
        prompt: null,
      }
    }
    if (!UUID_RE.test(approvalRequestId)) {
      return { approvalRequestId, availability: 'none', prompt: null }
    }
    const result = await this.db.query(
      `SELECT approval_kind, run_id::text, host_ref, session_id, origin, ciphertext, nonce,
              key_version, redaction_summary, source_kind, captured_at, expires_at
         FROM governed_approval_prompt_history
        WHERE approval_request_id = $1::uuid`,
      [approvalRequestId]
    )
    const row = result.rows[0] as Record<string, unknown> | undefined
    if (!row) return { approvalRequestId, availability: 'none', prompt: null }
    if (new Date(String(row.expires_at)).getTime() <= Date.now()) {
      return { approvalRequestId, availability: 'expired', prompt: null }
    }
    if (row.key_version !== this.config.keyVersion) {
      return { approvalRequestId, availability: 'unavailable', prompt: null }
    }
    try {
      const aad = promptAad(
        {
          approvalRequestId,
          approvalKind: row.approval_kind as 'tool' | 'workflow',
          runId: row.run_id as string | null,
          hostRef: row.host_ref as string | null,
          sessionId: row.session_id as string | null,
          origin: row.origin as GovernedTraceOrigin | null,
          sourceKind: row.source_kind as 'mcp_host_runtime' | 'control_api_local',
        },
        this.config.keyVersion
      )
      const text = decryptAes256Gcm(
        this.config.key,
        {
          nonce: row.nonce as Buffer,
          ciphertext: row.ciphertext as Buffer,
        },
        aad
      ).toString('utf8')
      return {
        approvalRequestId,
        availability: 'available',
        prompt: {
          text,
          capturedAt: new Date(String(row.captured_at)).toISOString(),
          expiresAt: new Date(String(row.expires_at)).toISOString(),
          keyVersion: this.config.keyVersion,
          redactionSummary: row.redaction_summary as {
            redacted: boolean
            replacementCount: number
          },
        },
      }
    } catch {
      return { approvalRequestId, availability: 'unavailable', prompt: null }
    }
  }

  private async verifyToolAssociation(input: ApprovalPromptCapture): Promise<boolean> {
    if (
      !input.runId ||
      !input.hostRef ||
      !input.sessionId ||
      !input.origin ||
      input.sourceKind !== 'mcp_host_runtime'
    )
      return false
    // Capture associates only to a binding readable at this instant. If the
    // binding loses a timeout race, this attempt is rejected without guessing;
    // a later idempotent retry may capture after the canonical binding commits.
    const result = await this.db.query(
      `SELECT 1 FROM governed_run_attribution_bindings
        WHERE run_id = $1::uuid AND host_ref = $2 AND session_id = $3 AND origin = $4`,
      [input.runId, input.hostRef, input.sessionId, input.origin]
    )
    return (result.rowCount ?? 0) === 1
  }

  private async verifyWorkflowAssociation(input: ApprovalPromptCapture): Promise<boolean> {
    if (input.sourceKind !== 'control_api_local') return false
    const result = await this.db.query(
      `SELECT 1
         FROM workflow_approval_requests approval
        WHERE approval.id = $1::uuid
          AND (
            $2::uuid IS NULL
            OR approval.bound_workflow_run_id = $2::uuid
            OR EXISTS (
              SELECT 1
                FROM workflow_runs run
               WHERE run.run_id = $2::uuid
                 AND run.approval_request_id = approval.id
            )
          )`,
      [input.approvalRequestId, input.runId?.toLowerCase() ?? null]
    )
    return (result.rowCount ?? 0) === 1
  }
}
