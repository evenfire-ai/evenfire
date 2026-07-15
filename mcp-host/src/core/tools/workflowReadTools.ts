import type { Attachment, ToolOutput } from '../types'
import { WorkflowTool } from './workflowBaseTool'
import {
  nonUniqueEffectiveTargetResponse,
  requestEffectiveWorkflowList,
  resolveEffectiveWorkflowTarget,
  shouldResolveEffectiveWorkflowTargets,
} from './workflowEffectiveTargets'
import {
  WORKFLOW_RECIPE_NAMESPACE,
  type WorkflowCallerContext,
  getString,
  requireWorkflowRef,
  workflowTargetSchema,
} from './workflowShared'

const DEFAULT_WORKFLOW_RESULT_ARTIFACT_POLL_ATTEMPTS = 180
const DEFAULT_WORKFLOW_RESULT_ARTIFACT_POLL_INTERVAL_MS = 1_000
const DEFAULT_WORKFLOW_RESULT_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024
const WORKFLOW_RESULT_BINARY_PREVIEW_MESSAGE = 'Artifact is available for download.'
const WORKFLOW_RESULT_FILE_MIME_BY_EXT = new Map([
  ['json', 'application/json'],
  ['txt', 'text/plain'],
  ['md', 'text/markdown'],
  ['csv', 'text/csv'],
  ['pdf', 'application/pdf'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
])

function workflowResultAttachmentMaxBytes(getEnv: (key: string) => string | undefined): number {
  const parsed = Number(getEnv('CLERUM_ATTACHMENT_MAX_BYTES') || '')
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_WORKFLOW_RESULT_ATTACHMENT_MAX_BYTES
}

function positiveIntegerEnv(
  getEnv: (key: string) => string | undefined,
  key: string,
  fallback: number
): number {
  const parsed = Number(getEnv(key) || '')
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function workflowResultArtifactPollAttempts(getEnv: (key: string) => string | undefined): number {
  return positiveIntegerEnv(
    getEnv,
    'CLERUM_WORKFLOW_RESULT_ARTIFACT_POLL_ATTEMPTS',
    DEFAULT_WORKFLOW_RESULT_ARTIFACT_POLL_ATTEMPTS
  )
}

function workflowResultArtifactPollIntervalMs(getEnv: (key: string) => string | undefined): number {
  return positiveIntegerEnv(
    getEnv,
    'CLERUM_WORKFLOW_RESULT_ARTIFACT_POLL_INTERVAL_MS',
    DEFAULT_WORKFLOW_RESULT_ARTIFACT_POLL_INTERVAL_MS
  )
}

function isRetryableWorkflowResultArtifactListError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return (
    /Workflow broker request failed \((404|410|502|503|504)\)/.test(error.message) ||
    /\b(fetch failed|timeout|aborted)\b/i.test(error.message)
  )
}

function safeAttachmentFilename(raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, '/').split('/').pop() || 'workflow-artifact'
  const cleaned = trimmed.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160)
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'workflow-artifact'
}

function filenameFromDispositionOrArtifact(raw: unknown, artifactName: string): string {
  if (typeof raw !== 'string') return safeAttachmentFilename(artifactName)
  const match = raw.match(/filename="?([^";\r\n]+)"?/i)
  return safeAttachmentFilename(match?.[1] || raw || artifactName)
}

function extensionOf(filename: string): string {
  const idx = filename.lastIndexOf('.')
  return idx >= 0 ? filename.slice(idx + 1).toLowerCase() : ''
}

function allowedWorkflowResultMime(filename: string, contentType: string): string | null {
  const expected = WORKFLOW_RESULT_FILE_MIME_BY_EXT.get(extensionOf(filename))
  if (!expected) return null
  const normalized = contentType.split(';', 1)[0]?.trim().toLowerCase() || ''
  if (normalized === expected) return expected
  if (expected === 'application/json' && normalized === 'text/json') return expected
  if (!normalized || normalized === 'application/octet-stream') return expected
  return null
}

type WorkflowResultArtifactDownload = {
  contentResult: unknown
  attachment: Attachment | null
}

function contentResultFromDownloadBytes(params: {
  artifactName: string
  contentType: string
  body: Buffer
}): unknown {
  const { artifactName, contentType, body } = params
  const sizeBytes = body.byteLength
  if (sizeBytes > 256 * 1024) {
    return {
      artifactName,
      contentType,
      sizeBytes,
      truncated: true,
      message: 'Artifact is too large to load into agent context. Use the downloaded file.',
    }
  }
  const text = body.toString('utf8')
  if (allowedWorkflowResultMime(artifactName, contentType) === 'application/json') {
    try {
      return {
        artifactName,
        contentType,
        sizeBytes,
        content: JSON.parse(text) as unknown,
      }
    } catch {
      return { artifactName, contentType, sizeBytes, contentText: text }
    }
  }
  if (/^text\//i.test(contentType) || /\.(md|txt|csv)$/i.test(artifactName)) {
    return { artifactName, contentType, sizeBytes, contentText: text }
  }
  return {
    artifactName,
    contentType,
    sizeBytes,
    message: WORKFLOW_RESULT_BINARY_PREVIEW_MESSAGE,
  }
}

function contentResultWithAttachmentDelivery(
  contentResult: unknown,
  attachment: Attachment | null
): unknown {
  if (
    !attachment ||
    !contentResult ||
    typeof contentResult !== 'object' ||
    Array.isArray(contentResult)
  ) {
    return contentResult
  }
  const result = contentResult as Record<string, unknown>
  if (result.message !== WORKFLOW_RESULT_BINARY_PREVIEW_MESSAGE) return contentResult
  return {
    ...result,
    message: `Artifact is available for download and attached as ${attachment.filename}.`,
    previewAvailable: false,
    downloadableAttachment: {
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      delivery: 'response_attachment',
    },
  }
}

async function workflowResultArtifactDownload(params: {
  client: {
    download(
      path: string,
      options: { maxBytes: number }
    ): Promise<{
      body: Buffer
      headers: Record<string, string>
    }>
  }
  downloadPath: string
  artifactName: string
  getEnv: (key: string) => string | undefined
}): Promise<WorkflowResultArtifactDownload> {
  const maxBytes = workflowResultAttachmentMaxBytes(params.getEnv)
  const downloaded = await params.client.download(params.downloadPath, { maxBytes })
  const sizeBytes = downloaded.body.byteLength
  const contentType = downloaded.headers['content-type'] || ''
  const filename = filenameFromDispositionOrArtifact(
    downloaded.headers['content-disposition'],
    params.artifactName
  )
  const contentResult = contentResultFromDownloadBytes({
    artifactName: params.artifactName,
    contentType,
    body: downloaded.body,
  })
  const mimeType = allowedWorkflowResultMime(filename, contentType)
  let attachment: Attachment | null = null
  if (!mimeType || sizeBytes <= 0) {
    console.warn(
      `[WorkflowResult] Skipping artifact attachment: mimeAllowed=${Boolean(mimeType)}, ` +
        `sizeBytes=${sizeBytes}, artifact=${params.artifactName}`
    )
  } else {
    if (sizeBytes > maxBytes) {
      console.warn(
        `[WorkflowResult] Skipping oversized artifact attachment: sizeBytes=${sizeBytes}, maxBytes=${maxBytes}, artifact=${params.artifactName}`
      )
    } else {
      attachment = {
        id: `workflow-result-${filename}`,
        kind: 'file',
        mimeType,
        encoding: 'base64',
        dataBase64: downloaded.body.toString(('base' + '64') as BufferEncoding),
        filename,
        caption: `Workflow artifact: ${filename} (${sizeBytes} bytes)`,
        sourceTool: 'workflow_result',
        lane: 'workflow_result',
        artifactName: params.artifactName,
        sizeBytes,
      }
    }
  }
  return {
    contentResult: contentResultWithAttachmentDelivery(contentResult, attachment),
    attachment,
  }
}
function appendApprovalTargetQuery(path: string, params: Record<string, unknown>): string {
  const query = new URLSearchParams()
  const targetUserId = getString(params, 'targetUserId')
  const targetTeamId = getString(params, 'targetTeamId')
  const workflowConversationId = getString(params, 'workflowConversationId')
  if (targetUserId) query.set('targetUserId', targetUserId)
  if (targetTeamId) query.set('targetTeamId', targetTeamId)
  if (workflowConversationId) query.set('workflowConversationId', workflowConversationId)
  const encoded = query.toString()
  return encoded ? `${path}?${encoded}` : path
}

function approvalTargetParams(
  params: Record<string, unknown>,
  context: WorkflowCallerContext | null
): Record<string, unknown> {
  if (!context?.targetUserId && !context?.targetTeamId) return params
  const targetUserId = getString(params, 'targetUserId')
  const targetTeamId = getString(params, 'targetTeamId')
  if (targetUserId) {
    throw new Error('workflow target user is derived from the authenticated conversation')
  }
  if (targetTeamId) {
    throw new Error('workflow target team is derived from the authenticated conversation')
  }
  return context.targetUserId
    ? { targetUserId: context.targetUserId }
    : { targetTeamId: context.targetTeamId }
}

function rejectModelSuppliedApprovalTarget(params: Record<string, unknown>): void {
  if (getString(params, 'targetUserId')) {
    throw new Error('workflow target user is derived from the authenticated conversation')
  }
  if (getString(params, 'targetTeamId')) {
    throw new Error('workflow target team is derived from the authenticated conversation')
  }
}

function approvalTargetParamSet(
  params: Record<string, unknown>,
  context: WorkflowCallerContext | null
): Record<string, unknown>[] {
  const resolved = approvalTargetParams(params, context)
  if (!context?.targetUserId || !context.targetTeamId) return [resolved]
  return [{ targetUserId: context.targetUserId }, { targetTeamId: context.targetTeamId }]
}

function isApprovalTargetMiss(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /\((403|404)\)/.test(error.message)
}

async function requestWithApprovalTargetFallback(
  targets: Record<string, unknown>[],
  requestForTarget: (target: Record<string, unknown>) => Promise<unknown>
): Promise<unknown> {
  let lastError: unknown
  for (const target of targets) {
    try {
      return await requestForTarget(target)
    } catch (error) {
      lastError = error
      if (targets.length === 1 || !isApprovalTargetMiss(error)) throw error
    }
  }
  throw lastError
}

function workflowKey(item: unknown): string {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return ''
  const record = item as Record<string, unknown>
  const namespace = typeof record.namespace === 'string' ? record.namespace : ''
  const name = typeof record.name === 'string' ? record.name : ''
  return namespace && name ? `${namespace}/${name}` : ''
}

function mergeWorkflowListResults(results: unknown[]): unknown {
  const items: unknown[] = []
  const seen = new Set<string>()
  for (const result of results) {
    const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : {}
    const rawItems = Array.isArray(record.items) ? record.items : []
    for (const item of rawItems) {
      const key = workflowKey(item)
      if (key && seen.has(key)) continue
      if (key) seen.add(key)
      items.push(item)
    }
  }
  return { items, count: items.length }
}

function summarizeInputContract(inputContract: unknown): {
  requiresInput: boolean
  inputs: Array<Record<string, unknown>>
} {
  const contract =
    inputContract && typeof inputContract === 'object' && !Array.isArray(inputContract)
      ? (inputContract as Record<string, unknown>)
      : null
  const required = Array.isArray(contract?.required) ? contract.required.map(String) : []
  const properties =
    contract?.properties &&
    typeof contract.properties === 'object' &&
    !Array.isArray(contract.properties)
      ? (contract.properties as Record<string, unknown>)
      : {}
  const inputs = Object.entries(properties).map(([name, value]) => {
    const property =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
    return {
      name,
      required: required.includes(name),
      ...(typeof property.description === 'string' ? { description: property.description } : {}),
      ...(Array.isArray(property.enum) ? { options: property.enum } : {}),
      ...(Object.prototype.hasOwnProperty.call(property, 'default')
        ? { default: property.default }
        : {}),
    }
  })
  return {
    requiresInput: inputs.some(input => input.required === true),
    inputs,
  }
}

function sanitizeWorkflowListForAuthenticatedChat(result: unknown): unknown {
  const record =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {}
  const rawItems = Array.isArray(record.items) ? record.items : []
  const items = rawItems.map(item => {
    const workflow =
      item && typeof item === 'object' && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : {}
    const inputSummary = summarizeInputContract(workflow.inputContract)
    const targets = Array.isArray(workflow.targets)
      ? workflow.targets.flatMap(target => {
          const record =
            target && typeof target === 'object' && !Array.isArray(target)
              ? (target as Record<string, unknown>)
              : {}
          const kind = typeof record.kind === 'string' ? record.kind.trim() : ''
          const label = typeof record.label === 'string' ? record.label.trim() : ''
          return kind && label ? [{ kind, label }] : []
        })
      : []
    return {
      name: typeof workflow.name === 'string' ? workflow.name : '',
      ...(typeof workflow.description === 'string' ? { description: workflow.description } : {}),
      ...(targets.length > 0 ? { targets } : {}),
      ...(workflow.duplicateLabels === true ? { duplicateLabels: true } : {}),
      ...inputSummary,
    }
  })
  return { items, count: items.length }
}

function workflowNameFromRecord(record: Record<string, unknown>): string {
  if (typeof record.workflowName === 'string') return record.workflowName
  if (typeof record.name === 'string') return record.name
  if (typeof record.recipe === 'string') {
    const parts = record.recipe.split('/')
    return parts[parts.length - 1] || ''
  }
  return ''
}

function sanitizeRunSummaryForAuthenticatedChat(value: unknown): unknown {
  const run =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  if (!run) return null
  return {
    ...(typeof run.phase === 'string' ? { phase: run.phase } : {}),
    ...(typeof run.triggeredAt === 'string' ? { triggeredAt: run.triggeredAt } : {}),
    ...(typeof run.startedAt === 'string' ? { startedAt: run.startedAt } : {}),
    ...(typeof run.completedAt === 'string' ? { completedAt: run.completedAt } : {}),
    ...(typeof run.message === 'string' ? { message: run.message } : {}),
  }
}

function sanitizeWorkflowStatusForAuthenticatedChat(result: unknown): unknown {
  const record =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {}
  return {
    name: workflowNameFromRecord(record),
    ...(typeof record.phase === 'string' ? { phase: record.phase } : {}),
    ...(typeof record.workflowPhase === 'string' || record.workflowPhase === null
      ? { workflowPhase: record.workflowPhase }
      : {}),
    latestRun: sanitizeRunSummaryForAuthenticatedChat(record.latestRun),
  }
}

function sanitizeWorkflowHealthForAuthenticatedChat(result: unknown): unknown {
  const record =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {}
  return {
    name: workflowNameFromRecord(record),
    ...(typeof record.phase === 'string' ? { phase: record.phase } : {}),
    ...(typeof record.workflowPhase === 'string' || record.workflowPhase === null
      ? { workflowPhase: record.workflowPhase }
      : {}),
    ...(typeof record.activeRuns === 'number' || record.activeRuns === null
      ? { activeRuns: record.activeRuns }
      : {}),
    lastRun: sanitizeRunSummaryForAuthenticatedChat(record.lastRun),
  }
}

function artifactRecords(value: unknown): Array<Record<string, unknown>> {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  return Array.isArray(record.artifacts)
    ? record.artifacts.filter(
        (artifact): artifact is Record<string, unknown> =>
          Boolean(artifact) && typeof artifact === 'object' && !Array.isArray(artifact)
      )
    : []
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function pickWorkflowResultArtifact(
  artifacts: Array<Record<string, unknown>>,
  requestedName: string
): Record<string, unknown> | null {
  if (requestedName) {
    return artifacts.find(artifact => artifact.name === requestedName) ?? null
  }
  return (
    artifacts.find(
      artifact => typeof artifact.name === 'string' && artifact.name.toLowerCase().endsWith('.json')
    ) ??
    artifacts[0] ??
    null
  )
}

const AUTHENTICATED_RESULT_REDACTED_KEYS = new Set([
  'accesstoken',
  'apikey',
  'approvalid',
  'approvalrequestid',
  'authorization',
  'bearer',
  'clientsecret',
  'credential',
  'credentials',
  'grant',
  'grants',
  'hostref',
  'idempotencykey',
  'jwt',
  'namespace',
  'password',
  'privatekey',
  'refreshtoken',
  'runid',
  'secret',
  'secretkey',
  'scope',
  'scopes',
  'targetteamid',
  'targetuserid',
  'token',
  'workflowartifactname',
  'workflownamespace',
])

function normalizeResultKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g

function sanitizeWorkflowResultStringForAuthenticatedChat(value: string): string {
  return value.replace(BEARER_TOKEN_RE, 'Bearer [REDACTED]').replace(JWT_RE, '[REDACTED_JWT]')
}

function sanitizeWorkflowResultValueForAuthenticatedChat(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => sanitizeWorkflowResultValueForAuthenticatedChat(item))
  }
  if (typeof value === 'string') {
    return sanitizeWorkflowResultStringForAuthenticatedChat(value)
  }
  if (!value || typeof value !== 'object') return value

  const output: Record<string, unknown> = {}
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (AUTHENTICATED_RESULT_REDACTED_KEYS.has(normalizeResultKey(key))) continue
    output[key] = sanitizeWorkflowResultValueForAuthenticatedChat(rawValue)
  }
  return output
}

function sanitizeWorkflowResultContentForAuthenticatedChat(result: unknown): unknown {
  const record =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : null
  if (!record) return sanitizeWorkflowResultValueForAuthenticatedChat(result)

  if (Object.prototype.hasOwnProperty.call(record, 'content')) {
    return sanitizeWorkflowResultValueForAuthenticatedChat(record.content)
  }
  if (typeof record.contentText === 'string') {
    return { text: sanitizeWorkflowResultStringForAuthenticatedChat(record.contentText) }
  }
  if (typeof record.message === 'string') {
    return { message: sanitizeWorkflowResultStringForAuthenticatedChat(record.message) }
  }
  return sanitizeWorkflowResultValueForAuthenticatedChat(record)
}

function sanitizeWorkflowResultForAuthenticatedChat(params: {
  workflowName: string
  artifact: Record<string, unknown> | null
  result: unknown
}): unknown {
  const { workflowName, artifact, result } = params
  return {
    workflowName,
    artifactAvailable: Boolean(artifact),
    result: sanitizeWorkflowResultContentForAuthenticatedChat(result),
  }
}

function approvalTargetProperties(): Record<string, unknown> {
  return {
    targetUserId: {
      type: 'string',
      description: 'Optional user UUID whose approval/trigger visibility should scope the query.',
    },
    targetTeamId: {
      type: 'string',
      description: 'Optional team UUID whose approval/trigger visibility should scope the query.',
    },
  }
}

export class WorkflowResultTool extends WorkflowTool {
  private resultAttachments: Attachment[] | undefined

  name(): string {
    return 'workflow_result'
  }

  description(): string {
    return 'Read the result artifact for a workflow run already triggered in this conversation. Do not use this to run, start, trigger, execute, confirm a workflow started, monitor progress, check status/health/completion, inspect, or verify records in a connected MCP data system; use workflow_trigger for triggering, workflow_status/workflow_health for progress or status, and the relevant MCP read tool for data verification. Use this only after a trigger when the user asks for the workflow result artifact, a download, an artifact summary, or an artifact value that is not already present in the conversation. For MCP-backed records, do not call this when a workflow name, company, marker, public record reference, or other conversation-known business key can be used with the connected MCP read tool.'
  }

  parametersSchema(): Record<string, unknown> {
    return workflowTargetSchema({
      exposeNamespace: false,
      exposeTargetLabel: shouldResolveEffectiveWorkflowTargets(this.workflowCallerContext),
    })
  }

  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const start = Date.now()
    this.resultAttachments = undefined
    try {
      const data = await this.run(params)
      return {
        content: JSON.stringify(data, null, 2),
        duration_ms: Date.now() - start,
        is_error: false,
        attachments: this.resultAttachments,
      }
    } catch (err) {
      return {
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        duration_ms: Date.now() - start,
        is_error: true,
      }
    }
  }

  async executeForRun(workflowRunId: string, artifactName?: string): Promise<ToolOutput> {
    const start = Date.now()
    this.resultAttachments = undefined
    try {
      const data = await this.runForRun(workflowRunId, artifactName)
      return {
        content: JSON.stringify(data, null, 2),
        duration_ms: Date.now() - start,
        is_error: false,
        attachments: this.resultAttachments,
      }
    } catch (err) {
      return {
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        duration_ms: Date.now() - start,
        is_error: true,
      }
    }
  }

  private authenticatedConversationTarget(): Record<string, unknown> {
    const conversationId = this.workflowCallerContext?.conversationId?.trim()
    if (
      !conversationId ||
      (!this.workflowCallerContext?.targetUserId && !this.workflowCallerContext?.targetTeamId)
    ) {
      throw new Error('workflow_result is available only in an authenticated workflow conversation')
    }
    return {
      ...(this.workflowCallerContext.targetUserId
        ? { targetUserId: this.workflowCallerContext.targetUserId }
        : {}),
      ...(this.workflowCallerContext.targetTeamId
        ? { targetTeamId: this.workflowCallerContext.targetTeamId }
        : {}),
      workflowConversationId: conversationId,
    }
  }

  private async readWorkflowResult(params: {
    listPath: string
    downloadPath: (artifactName: string) => string
    fallbackWorkflowName: string
    requestedArtifactName?: string
  }): Promise<{
    workflowName: string
    artifact: Record<string, unknown> | null
    result: unknown
  }> {
    let listResult: unknown
    let listRecord: Record<string, unknown> = {}
    let canonicalWorkflowName = params.fallbackWorkflowName
    let artifact: Record<string, unknown> | null = null
    let lastListError: unknown
    const pollAttempts = workflowResultArtifactPollAttempts(this.getEnv)
    const pollIntervalMs = workflowResultArtifactPollIntervalMs(this.getEnv)
    for (let attempt = 0; attempt < pollAttempts; attempt++) {
      try {
        listResult = await this.client.request(params.listPath)
        lastListError = undefined
        listRecord =
          listResult && typeof listResult === 'object' && !Array.isArray(listResult)
            ? (listResult as Record<string, unknown>)
            : {}
        canonicalWorkflowName = workflowNameFromRecord(listRecord) || params.fallbackWorkflowName
        artifact = pickWorkflowResultArtifact(
          artifactRecords(listResult),
          params.requestedArtifactName ?? ''
        )
        if (artifact) break
      } catch (error) {
        if (!isRetryableWorkflowResultArtifactListError(error)) throw error
        lastListError = error
      }
      if (attempt < pollAttempts - 1) {
        await sleep(pollIntervalMs)
      }
    }
    if (!artifact) {
      return {
        workflowName: canonicalWorkflowName,
        artifact: null,
        result: {
          artifacts: [],
          message: lastListError
            ? 'Workflow result artifacts are still being prepared for this run.'
            : 'No workflow result artifacts are available for this run yet.',
        },
      }
    }
    const artifactName = typeof artifact.name === 'string' ? artifact.name : ''
    const { contentResult, attachment } = await workflowResultArtifactDownload({
      client: this.client,
      downloadPath: params.downloadPath(artifactName),
      artifactName,
      getEnv: this.getEnv,
    })
    this.resultAttachments = attachment ? [attachment] : undefined
    console.log(
      `[WorkflowResult] Artifact attachment count for ${artifactName}: ${
        this.resultAttachments?.length ?? 0
      }`
    )
    return {
      workflowName: canonicalWorkflowName,
      artifact,
      result: contentResult,
    }
  }

  private async runForRun(workflowRunId: string, artifactName?: string): Promise<unknown> {
    const normalizedRunId = workflowRunId.trim()
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalizedRunId)) {
      throw new Error('Invalid workflow run ID')
    }
    const target = this.authenticatedConversationTarget()
    const result = await this.readWorkflowResult({
      listPath: appendApprovalTargetQuery(
        `/api/v1/workflows/runs/${encodeURIComponent(normalizedRunId)}/artifacts`,
        target
      ),
      downloadPath: name =>
        appendApprovalTargetQuery(
          `/api/v1/workflows/runs/${encodeURIComponent(
            normalizedRunId
          )}/artifacts/${encodeURIComponent(name)}/download`,
          target
        ),
      fallbackWorkflowName: 'workflow',
      ...(artifactName?.trim() ? { requestedArtifactName: artifactName.trim() } : {}),
    })
    return sanitizeWorkflowResultForAuthenticatedChat(result)
  }

  async run(params: Record<string, unknown>): Promise<unknown> {
    const conversationId = this.workflowCallerContext?.conversationId?.trim()
    const authenticated = Boolean(
      conversationId &&
      (this.workflowCallerContext?.targetUserId || this.workflowCallerContext?.targetTeamId)
    )
    if (!authenticated || !conversationId) {
      throw new Error('workflow_result is available only in an authenticated workflow conversation')
    }
    const { namespace, name } = requireWorkflowRef(params, WORKFLOW_RECIPE_NAMESPACE)
    if (getString(params, 'runId')) {
      throw new Error('workflow_result run id is derived from the authenticated conversation')
    }
    let targets: Record<string, unknown>[]
    if (shouldResolveEffectiveWorkflowTargets(this.workflowCallerContext)) {
      rejectModelSuppliedApprovalTarget(params)
      const resolution = await resolveEffectiveWorkflowTarget(
        this.client,
        this.workflowCallerContext,
        name,
        getString(params, 'targetLabel')
      )
      if (resolution.kind !== 'unique') {
        return sanitizeWorkflowResultForAuthenticatedChat({
          workflowName: name,
          artifact: null,
          result: nonUniqueEffectiveTargetResponse(name, resolution),
        })
      }
      targets = [{ ...resolution.approvalTarget, workflowConversationId: conversationId }]
    } else {
      targets = approvalTargetParamSet(params, this.workflowCallerContext).map(target => ({
        ...target,
        workflowConversationId: conversationId,
      }))
    }
    const result = await requestWithApprovalTargetFallback(targets, async target => {
      const listPath = appendApprovalTargetQuery(
        `/api/v1/workflows/${encodeURIComponent(namespace)}/${encodeURIComponent(
          name
        )}/runs/latest/artifacts`,
        target
      )
      return this.readWorkflowResult({
        listPath,
        downloadPath: artifactName =>
          appendApprovalTargetQuery(
            `/api/v1/workflows/${encodeURIComponent(namespace)}/${encodeURIComponent(
              name
            )}/runs/latest/artifacts/${encodeURIComponent(artifactName)}/download`,
            target
          ),
        fallbackWorkflowName: name,
      })
    })

    return sanitizeWorkflowResultForAuthenticatedChat(
      result as {
        workflowName: string
        artifact: Record<string, unknown> | null
        result: unknown
      }
    )
  }
}

export class WorkflowListTool extends WorkflowTool {
  name(): string {
    return 'workflow_list'
  }

  description(): string {
    return 'List workflow recipes visible to this runtime host.'
  }

  parametersSchema(): Record<string, unknown> {
    if (this.workflowCallerContext?.targetUserId || this.workflowCallerContext?.targetTeamId) {
      return {
        type: 'object',
        properties: {},
        required: [],
      }
    }
    return { type: 'object', properties: approvalTargetProperties(), required: [] }
  }

  async run(params: Record<string, unknown>): Promise<unknown> {
    if (shouldResolveEffectiveWorkflowTargets(this.workflowCallerContext)) {
      rejectModelSuppliedApprovalTarget(params)
      const result = await requestEffectiveWorkflowList(this.client, this.workflowCallerContext)
      return sanitizeWorkflowListForAuthenticatedChat(result)
    }

    const targets = approvalTargetParamSet(params, this.workflowCallerContext)
    const results = await Promise.all(
      targets.map(target =>
        this.client.request(appendApprovalTargetQuery('/api/v1/workflows', target))
      )
    )
    const result = results.length === 1 ? results[0] : mergeWorkflowListResults(results)
    return this.workflowCallerContext ? sanitizeWorkflowListForAuthenticatedChat(result) : result
  }
}

export class WorkflowStatusTool extends WorkflowTool {
  name(): string {
    return 'workflow_status'
  }

  description(): string {
    return 'Get workflow metadata, status, and latest run summary.'
  }

  parametersSchema(): Record<string, unknown> {
    if (this.workflowCallerContext?.targetUserId || this.workflowCallerContext?.targetTeamId) {
      return workflowTargetSchema({
        exposeNamespace: false,
        exposeTargetLabel: shouldResolveEffectiveWorkflowTargets(this.workflowCallerContext),
      })
    }
    const schema = workflowTargetSchema()
    return {
      ...schema,
      properties: {
        ...(schema.properties as Record<string, unknown>),
        ...approvalTargetProperties(),
      },
    }
  }

  async run(params: Record<string, unknown>): Promise<unknown> {
    const { namespace, name } = requireWorkflowRef(
      params,
      this.workflowCallerContext ? WORKFLOW_RECIPE_NAMESPACE : undefined
    )
    let targets: Record<string, unknown>[]
    if (shouldResolveEffectiveWorkflowTargets(this.workflowCallerContext)) {
      rejectModelSuppliedApprovalTarget(params)
      const resolution = await resolveEffectiveWorkflowTarget(
        this.client,
        this.workflowCallerContext,
        name,
        getString(params, 'targetLabel')
      )
      if (resolution.kind !== 'unique') return nonUniqueEffectiveTargetResponse(name, resolution)
      targets = [resolution.approvalTarget]
    } else {
      targets = approvalTargetParamSet(params, this.workflowCallerContext)
    }
    const result = await requestWithApprovalTargetFallback(targets, target =>
      this.client.request(
        appendApprovalTargetQuery(
          `/api/v1/workflows/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
          target
        )
      )
    )
    return this.workflowCallerContext ? sanitizeWorkflowStatusForAuthenticatedChat(result) : result
  }
}

export class WorkflowHealthTool extends WorkflowTool {
  name(): string {
    return 'workflow_health'
  }

  description(): string {
    return 'Get workflow health signals and active-run summary.'
  }

  parametersSchema(): Record<string, unknown> {
    if (this.workflowCallerContext?.targetUserId || this.workflowCallerContext?.targetTeamId) {
      return workflowTargetSchema({
        exposeNamespace: false,
        exposeTargetLabel: shouldResolveEffectiveWorkflowTargets(this.workflowCallerContext),
      })
    }
    const schema = workflowTargetSchema()
    return {
      ...schema,
      properties: {
        ...(schema.properties as Record<string, unknown>),
        ...approvalTargetProperties(),
      },
    }
  }

  async run(params: Record<string, unknown>): Promise<unknown> {
    const { namespace, name } = requireWorkflowRef(
      params,
      this.workflowCallerContext ? WORKFLOW_RECIPE_NAMESPACE : undefined
    )
    let targets: Record<string, unknown>[]
    if (shouldResolveEffectiveWorkflowTargets(this.workflowCallerContext)) {
      rejectModelSuppliedApprovalTarget(params)
      const resolution = await resolveEffectiveWorkflowTarget(
        this.client,
        this.workflowCallerContext,
        name,
        getString(params, 'targetLabel')
      )
      if (resolution.kind !== 'unique') return nonUniqueEffectiveTargetResponse(name, resolution)
      targets = [resolution.approvalTarget]
    } else {
      targets = approvalTargetParamSet(params, this.workflowCallerContext)
    }
    const result = await requestWithApprovalTargetFallback(targets, target =>
      this.client.request(
        appendApprovalTargetQuery(
          `/api/v1/workflows/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/health`,
          target
        )
      )
    )
    return this.workflowCallerContext ? sanitizeWorkflowHealthForAuthenticatedChat(result) : result
  }
}
