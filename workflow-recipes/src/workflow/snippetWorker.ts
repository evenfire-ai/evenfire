import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { type Collection, type Db, type Document, MongoClient } from 'mongodb'
import fs from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import vm from 'node:vm'
import { Pool } from 'pg'
import ts from 'typescript'
import type {
  SnippetExecuteRequest,
  SnippetExecuteResponse,
  SnippetResolvedWorkload,
} from './snippetTypes'
import { snippetSecretEnvName } from './snippetTypes'

const FORBIDDEN_SOURCE_PATTERNS: Array<[RegExp, string]> = [
  [/\bprocess\b/, 'process is not available in snippets'],
  [/\brequire\s*\(/, 'require is not available in snippets'],
  [/\bimport\.meta\b/, 'import.meta is not available in snippets'],
  [/\bimport\s*\(/, 'dynamic import is not available in snippets'],
  [
    /\bfrom\s+['"](?:node:)?(?:fs|child_process|net|dgram|tls|http|https|os|worker_threads)['"]/,
    'Node system modules are not available in snippets',
  ],
  [/\b(?:eval|Function)\s*\(/, 'eval and Function are not available in snippets'],
  [
    /\bconstructor\b|__proto__|\bprototype\b/,
    'prototype and constructor access are not available in snippets',
  ],
  [/\bglobalThis\b|\bglobal\b/, 'global object access is not available in snippets'],
]

const SAFE_ARTIFACT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_HTTP_RESPONSE_BYTES = 1_048_576
const MAX_POSTGRES_ROWS = 1000
const MAX_MONGO_ROWS = 1000
const MAX_SNIPPET_SLEEP_MS = 300_000
const ALLOWED_HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT'])
const DEFAULT_MCP_TOOL_TIMEOUT_MS = 3_600_000
const DEFAULT_MCP_TOOL_MAX_TOTAL_TIMEOUT_MS = 3_600_000
const MCP_TOOL_TIMEOUT_ENV = 'CLERUM_MCP_TOOL_TIMEOUT_MS'
const MCP_TOOL_MAX_TOTAL_TIMEOUT_ENV = 'CLERUM_MCP_TOOL_MAX_TOTAL_TIMEOUT_MS'
type DatabaseAccess = 'read' | 'readWrite'

export interface WorkerPayload {
  request: SnippetExecuteRequest
  outputDir: string
  timeoutMs: number
  env: Record<string, string>
  startedAtMs?: number
}

if (process.env.CLERUM_SNIPPET_WORKER_CHILD === 'true') {
  process.once('message', rawPayload => {
    const payload = rawPayload as WorkerPayload
    executeSnippetPayload(payload)
      .then(response => process.send?.(response))
      .catch(error => {
        const request = payload.request
        process.send?.({
          stepId: request.stepId,
          status: 'failed',
          error: redactString(error instanceof Error ? error.message : String(error), payload.env),
        } satisfies SnippetExecuteResponse)
      })
  })
}

export async function executeSnippetPayload(
  payload: WorkerPayload
): Promise<SnippetExecuteResponse> {
  const { request } = payload
  validateSnippetSource(request.run.code)
  const runtimePayload = { ...payload, startedAtMs: Date.now() }
  const artifacts: NonNullable<SnippetExecuteResponse['artifacts']> = []
  const sdk = buildSdk(runtimePayload, artifacts)
  const fn = compileSnippet(request.run.code)
  const output = await Promise.race([
    fn(sdk),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('snippet execution timed out')), runtimePayload.timeoutMs)
    ),
  ])
  return {
    stepId: request.stepId,
    status: 'completed',
    output: redactValue(output, payload.env),
    artifacts,
  }
}

export function validateSnippetSource(code: string): void {
  for (const [pattern, message] of FORBIDDEN_SOURCE_PATTERNS) {
    if (pattern.test(code)) throw new Error(message)
  }
}

function compileSnippet(code: string): (sdk: unknown) => Promise<unknown> {
  const wrapped = `(async (sdk) => {\n${code}\n})`
  const compiled = ts.transpileModule(wrapped, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      strict: true,
    },
  }).outputText
  const script = new vm.Script(compiled, {
    filename: 'workflow-snippet.ts',
  })
  const context = vm.createContext(Object.create(null), {
    name: 'workflow-snippet',
    codeGeneration: { strings: false, wasm: false },
  })
  const result = script.runInContext(context, { timeout: 1000 })
  if (typeof result !== 'function') throw new Error('snippet did not compile to an executable body')
  return result as (sdk: unknown) => Promise<unknown>
}

function buildSdk(
  payload: WorkerPayload,
  artifacts: NonNullable<SnippetExecuteResponse['artifacts']>
): Record<string, unknown> {
  const { request } = payload
  let artifactWriteCount = 0
  const writeSnippetArtifact = async (name: string, body: string, format: string) => {
    const maxCount = request.run.capabilities?.artifacts?.maxCount ?? 20
    artifactWriteCount += 1
    if (artifactWriteCount > maxCount) {
      throw new Error(`snippet artifact limit exceeded: max ${maxCount}`)
    }
    const artifact = await writeArtifact(payload, name, body, format)
    artifacts.push(artifact)
    return artifact
  }
  return hardenVmValue({
    inputs: request.inputs ?? {},
    previousOutputs: request.previousOutputs ?? {},
    sleep: (ms: number) => sleepSnippet(payload, ms),
    http: {
      fetchJson: (url: string, init?: RequestInit) => fetchWithPolicy(request, url, init, 'json'),
      fetchText: (url: string, init?: RequestInit) => fetchWithPolicy(request, url, init, 'text'),
    },
    secrets: {
      get: (alias: string) => getSecret(payload, alias),
    },
    mongo: {
      find: (ref: MongoRef, query: MongoFindQuery) => mongoFind(payload, ref, query),
      aggregate: (ref: MongoRef, pipeline: unknown[]) => mongoAggregate(payload, ref, pipeline),
      insertOne: (ref: MongoRef, command: MongoInsertOneCommand) =>
        mongoInsertOne(payload, ref, command),
      insertMany: (ref: MongoRef, command: MongoInsertManyCommand) =>
        mongoInsertMany(payload, ref, command),
      updateOne: (ref: MongoRef, command: MongoUpdateCommand) =>
        mongoUpdate(payload, ref, command, 'one'),
      updateMany: (ref: MongoRef, command: MongoUpdateCommand) =>
        mongoUpdate(payload, ref, command, 'many'),
      deleteOne: (ref: MongoRef, command: MongoDeleteCommand) =>
        mongoDelete(payload, ref, command, 'one'),
      deleteMany: (ref: MongoRef, command: MongoDeleteCommand) =>
        mongoDelete(payload, ref, command, 'many'),
    },
    postgres: {
      execute: (ref: PostgresRef, query: PostgresQuery) => postgresExecute(payload, ref, query),
      query: (ref: PostgresRef, query: PostgresQuery) => postgresQuery(payload, ref, query),
      queryOne: async (ref: PostgresRef, query: PostgresQuery) => {
        const rows = await postgresQuery(payload, ref, { ...query, limit: 1 })
        return rows[0] ?? null
      },
    },
    mcp: {
      callTool: (serverId: string, toolName: string, args: unknown) =>
        callMcpTool(payload, serverId, toolName, args),
    },
    artifacts: {
      writeJson: (name: string, data: unknown) =>
        writeSnippetArtifact(name, JSON.stringify(data, null, 2), 'json'),
      writeMarkdown: (name: string, body: string) => writeSnippetArtifact(name, body, 'md'),
    },
    log: {
      info: (message: string, meta?: unknown) => logSnippet(payload, 'info', message, meta),
      warn: (message: string, meta?: unknown) => logSnippet(payload, 'warn', message, meta),
      error: (message: string, meta?: unknown) => logSnippet(payload, 'error', message, meta),
    },
  }) as Record<string, unknown>
}

function sleepSnippet(payload: WorkerPayload, rawMs: unknown): Promise<void> {
  const ms = Number(rawMs)
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error('snippet sleep duration must be a non-negative finite number')
  }
  const maxMs = Math.min(MAX_SNIPPET_SLEEP_MS, payload.timeoutMs)
  if (ms > maxMs) {
    throw new Error(`snippet sleep duration exceeds max ${maxMs}ms`)
  }
  return new Promise(resolve => setTimeout(resolve, ms))
}

function hardenVmValue(value: unknown): unknown {
  if (typeof value === 'function') {
    return new Proxy(value, {
      apply: (target, thisArg, args) => {
        const result = Reflect.apply(target, thisArg, args)
        if (
          result &&
          typeof result === 'object' &&
          typeof (result as PromiseLike<unknown>).then === 'function'
        ) {
          return Promise.resolve(result).then(item => hardenVmValue(item))
        }
        return hardenVmValue(result)
      },
      construct: () => {
        throw new Error('SDK functions are not constructors')
      },
      get: (_target, prop) => {
        if (prop === 'then') return undefined
        if (prop === Symbol.toStringTag) return 'Function'
        return undefined
      },
      getPrototypeOf: () => null,
      set: () => false,
      defineProperty: () => false,
      deleteProperty: () => false,
      setPrototypeOf: () => false,
    })
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map(item => hardenVmValue(item)))
  }
  if (value && typeof value === 'object') {
    const out = Object.create(null) as Record<string, unknown>
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = hardenVmValue(item)
    }
    return Object.freeze(out)
  }
  return value
}

async function fetchWithPolicy(
  request: SnippetExecuteRequest,
  rawUrl: string,
  init: RequestInit | undefined,
  mode: 'json' | 'text'
): Promise<unknown> {
  const url = new URL(rawUrl)
  const httpCapability = request.run.capabilities?.http
  const egressClass = httpCapability?.egressClass ?? 'exact-host'
  const allowedHosts = httpCapability?.allowedHosts ?? []
  if (egressClass !== 'exact-host' && egressClass !== 'public-web') {
    throw new Error(`HTTP egressClass is not supported: ${egressClass}`)
  }
  if (egressClass === 'exact-host' && !allowedHosts.includes(url.hostname))
    throw new Error(`HTTP host is not allowed: ${url.hostname}`)
  if (egressClass === 'public-web' && allowedHosts.length > 0) {
    throw new Error('public-web HTTP capability must not declare allowedHosts')
  }
  assertPublicHttpHostname(url.hostname)
  if (url.protocol !== 'https:') {
    throw new Error('public HTTP snippet calls must use https')
  }
  const method = (init?.method ?? 'GET').toUpperCase()
  if (!ALLOWED_HTTP_METHODS.has(method)) {
    throw new Error(`snippet HTTP method is not allowed: ${method}`)
  }
  const response = await fetch(url, { ...init, redirect: 'manual' })
  const location = response.headers.get('location')
  if (response.status >= 300 && response.status < 400 && location) {
    const redirected = new URL(location, url)
    assertPublicHttpHostname(redirected.hostname)
    if (redirected.protocol !== 'https:') {
      throw new Error('public HTTP snippet redirects must use https')
    }
    if (egressClass === 'exact-host' && !allowedHosts.includes(redirected.hostname)) {
      throw new Error(`HTTP redirect host is not allowed: ${redirected.hostname}`)
    }
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_HTTP_RESPONSE_BYTES) {
    throw new Error('HTTP response exceeded snippet limit')
  }
  if (!response.ok) throw new Error(`HTTP request failed with status ${response.status}`)
  return mode === 'json' ? JSON.parse(text) : text
}

function assertPublicHttpHostname(hostname: string): void {
  if (
    isIP(hostname) !== 0 ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.svc') ||
    hostname.endsWith('.cluster.local') ||
    hostname === 'kubernetes.default' ||
    hostname === 'metadata.goog' ||
    !hostname.includes('.')
  ) {
    throw new Error(`HTTP host must be a public DNS hostname: ${hostname}`)
  }
}

function getSecret(payload: WorkerPayload, alias: string): string {
  const declared = payload.request.run.capabilities?.secrets ?? []
  if (!declared.some(secret => secret.alias === alias)) {
    throw new Error(`secret alias is not declared: ${alias}`)
  }
  const value = payload.env[snippetSecretEnvName(alias)]
  if (!value) throw new Error(`secret alias is not available: ${alias}`)
  return value
}

interface MongoRef {
  workload: string
  database: string
  collection: string
  username?: string
  passwordSecretAlias?: string
}

interface MongoFindQuery {
  filter?: Record<string, unknown>
  projection?: Record<string, unknown>
  sort?: Record<string, 1 | -1>
  limit?: number
}

interface MongoInsertOneCommand {
  document: Record<string, unknown>
}

interface MongoInsertManyCommand {
  documents: Array<Record<string, unknown>>
}

interface MongoUpdateCommand {
  filter?: Record<string, unknown>
  update: Record<string, unknown>
  upsert?: boolean
}

interface MongoDeleteCommand {
  filter?: Record<string, unknown>
}

async function mongoFind(
  payload: WorkerPayload,
  ref: MongoRef,
  query: MongoFindQuery
): Promise<unknown[]> {
  return withSdkRetry(async () => {
    const limit = clampLimit(query.limit, MAX_MONGO_ROWS)
    return withMongoCollection(payload, ref, collection =>
      collection
        .find(query.filter ?? {}, { projection: query.projection, sort: query.sort, limit })
        .toArray()
    )
  })
}

async function mongoAggregate(
  payload: WorkerPayload,
  ref: MongoRef,
  pipeline: unknown[]
): Promise<unknown[]> {
  validateMongoAggregatePipeline(pipeline)
  if (containsMongoWriteStage(pipeline)) {
    assertDatabaseAccess(payload.request, 'mongo', ref.workload, 'readWrite')
  }
  return withSdkRetry(async () => {
    return withMongoCollection(payload, ref, async (collection, db) => {
      const cursor = startsWithDocumentsStage(pipeline)
        ? db.aggregate(pipeline as Document[])
        : collection.aggregate(pipeline as Document[])
      return await cursor.limit(MAX_MONGO_ROWS).toArray()
    })
  })
}

export function validateMongoAggregatePipeline(pipeline: unknown[]): void {
  if (!Array.isArray(pipeline) || pipeline.length > 20) {
    throw new Error('mongo aggregate pipeline is invalid or too large')
  }
  for (const stage of pipeline) {
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) {
      throw new Error('mongo aggregate pipeline stage is invalid')
    }
  }
}

async function mongoInsertOne(
  payload: WorkerPayload,
  ref: MongoRef,
  command: MongoInsertOneCommand
): Promise<{ acknowledged: boolean; insertedId: string }> {
  assertDatabaseAccess(payload.request, 'mongo', ref.workload, 'readWrite')
  const document = assertRecord(command?.document, 'mongo insertOne document')
  return withSdkRetry(() =>
    withMongoCollection(payload, ref, async collection => {
      const result = await collection.insertOne(document)
      return { acknowledged: result.acknowledged, insertedId: String(result.insertedId) }
    })
  )
}

async function mongoInsertMany(
  payload: WorkerPayload,
  ref: MongoRef,
  command: MongoInsertManyCommand
): Promise<{ acknowledged: boolean; insertedCount: number; insertedIds: Record<string, string> }> {
  assertDatabaseAccess(payload.request, 'mongo', ref.workload, 'readWrite')
  const documents = assertRecordArray(command?.documents, 'mongo insertMany documents')
  if (documents.length > MAX_MONGO_ROWS) {
    throw new Error(`mongo insertMany documents exceeded snippet limit: max ${MAX_MONGO_ROWS}`)
  }
  return withSdkRetry(() =>
    withMongoCollection(payload, ref, async collection => {
      const result = await collection.insertMany(documents)
      return {
        acknowledged: result.acknowledged,
        insertedCount: result.insertedCount,
        insertedIds: Object.fromEntries(
          Object.entries(result.insertedIds).map(([key, value]) => [key, String(value)])
        ),
      }
    })
  )
}

async function mongoUpdate(
  payload: WorkerPayload,
  ref: MongoRef,
  command: MongoUpdateCommand,
  mode: 'one' | 'many'
): Promise<{
  acknowledged: boolean
  matchedCount: number
  modifiedCount: number
  upsertedCount: number
  upsertedId: string | null
}> {
  assertDatabaseAccess(payload.request, 'mongo', ref.workload, 'readWrite')
  const filter = assertRecord(command?.filter ?? {}, 'mongo update filter')
  const update = assertRecord(command?.update, 'mongo update document')
  return withSdkRetry(() =>
    withMongoCollection(payload, ref, async collection => {
      const result =
        mode === 'one'
          ? await collection.updateOne(filter, update, { upsert: command?.upsert === true })
          : await collection.updateMany(filter, update, { upsert: command?.upsert === true })
      return {
        acknowledged: result.acknowledged,
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
        upsertedCount: result.upsertedCount,
        upsertedId: result.upsertedId ? String(result.upsertedId) : null,
      }
    })
  )
}

async function mongoDelete(
  payload: WorkerPayload,
  ref: MongoRef,
  command: MongoDeleteCommand,
  mode: 'one' | 'many'
): Promise<{ acknowledged: boolean; deletedCount: number }> {
  assertDatabaseAccess(payload.request, 'mongo', ref.workload, 'readWrite')
  const filter = assertRecord(command?.filter ?? {}, 'mongo delete filter')
  return withSdkRetry(() =>
    withMongoCollection(payload, ref, async collection => {
      const result =
        mode === 'one' ? await collection.deleteOne(filter) : await collection.deleteMany(filter)
      return { acknowledged: result.acknowledged, deletedCount: result.deletedCount }
    })
  )
}

async function withMongoCollection<T>(
  payload: WorkerPayload,
  ref: MongoRef,
  fn: (collection: Collection<Document>, db: Db) => Promise<T>
): Promise<T> {
  const workload = resolveAllowedWorkload(payload.request, 'mongo', ref.workload, 27017)
  const auth = ref.passwordSecretAlias
    ? `${encodeURIComponent(ref.username ?? 'root')}:${encodeURIComponent(getSecret(payload, ref.passwordSecretAlias))}@`
    : ''
  const client = new MongoClient(
    `mongodb://${auth}${workload.host}:${workload.port}/${ref.database}?directConnection=true`
  )
  try {
    await client.connect()
    const db = client.db(ref.database)
    return await fn(db.collection(ref.collection), db)
  } finally {
    await client.close()
  }
}

function startsWithDocumentsStage(pipeline: unknown[]): boolean {
  const [firstStage] = pipeline
  return Boolean(
    firstStage &&
    typeof firstStage === 'object' &&
    !Array.isArray(firstStage) &&
    Object.prototype.hasOwnProperty.call(firstStage, '$documents')
  )
}

function containsMongoWriteStage(pipeline: unknown[]): boolean {
  return pipeline.some(
    stage =>
      Boolean(stage) &&
      typeof stage === 'object' &&
      !Array.isArray(stage) &&
      (Object.prototype.hasOwnProperty.call(stage, '$out') ||
        Object.prototype.hasOwnProperty.call(stage, '$merge'))
  )
}

interface PostgresRef {
  workload: string
  database: string
  user?: string
  passwordSecretAlias?: string
}

interface PostgresQuery {
  sql: string
  values?: unknown[]
  limit?: number
}

async function postgresExecute(
  payload: WorkerPayload,
  ref: PostgresRef,
  query: PostgresQuery
): Promise<{ rows: unknown[]; rowCount: number; command: string }> {
  const sql = normalizePostgresStatement(query.sql)
  if (!isPostgresReadStatement(sql)) {
    assertDatabaseAccess(payload.request, 'postgres', ref.workload, 'readWrite')
  }
  return withSdkRetry(async () => {
    const workload = resolveAllowedWorkload(payload.request, 'postgres', ref.workload, 5432)
    const pool = new Pool({
      host: workload.host,
      port: workload.port ?? 5432,
      database: ref.database,
      user: ref.user ?? 'postgres',
      ...(ref.passwordSecretAlias ? { password: getSecret(payload, ref.passwordSecretAlias) } : {}),
      max: 1,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 1000,
    })
    try {
      const result = await pool.query(sql, query.values ?? [])
      return {
        rows: result.rows.slice(0, clampLimit(query.limit, MAX_POSTGRES_ROWS)),
        rowCount: result.rowCount ?? 0,
        command: result.command,
      }
    } finally {
      await pool.end()
    }
  })
}

async function postgresQuery(
  payload: WorkerPayload,
  ref: PostgresRef,
  query: PostgresQuery
): Promise<unknown[]> {
  const result = await postgresExecute(payload, ref, query)
  return result.rows
}

export function normalizePostgresStatement(sql: string): string {
  const trimmed = sql.trim()
  if (!trimmed) throw new Error('postgres query must be a single statement')
  const normalized = trimmed.endsWith(';') ? trimmed.slice(0, -1).trim() : trimmed
  if (!normalized || normalized.includes(';'))
    throw new Error('postgres query must be a single statement')
  return normalized
}

function isPostgresReadStatement(sql: string): boolean {
  return /^(select|show|explain)\b/i.test(sql.trim())
}

async function callMcpTool(
  payload: WorkerPayload,
  serverId: string,
  toolName: string,
  args: unknown
): Promise<unknown> {
  const capabilities = payload.request.run.capabilities?.mcp
  if (!capabilities?.servers?.includes(serverId))
    throw new Error(`MCP server is not allowed: ${serverId}`)
  const allowedName = `${serverId}__${toolName}`
  if (!capabilities.allowedTools?.include?.includes(allowedName)) {
    throw new Error(`MCP tool is not allowed: ${allowedName}`)
  }
  const server = payload.request.resolvedMcpServers.find(item => item.id === serverId)
  if (!server) throw new Error(`MCP server is not resolved: ${serverId}`)
  const serverUrl = new URL(server.url)
  return withSdkRetry(
    async () => {
      const transport =
        server.transport === 'sse'
          ? new SSEClientTransport(serverUrl)
          : new StreamableHTTPClientTransport(serverUrl)
      const client = new Client(
        { name: 'clerum-workflow-snippet-runner', version: '1.0.0' },
        { capabilities: {} }
      )
      try {
        await withSnippetBudget(client.connect(transport), payload, 'snippet MCP connect timeout')
        try {
          return await client.callTool(
            {
              name: toolName,
              arguments: (args ?? {}) as Record<string, unknown>,
            },
            undefined,
            resolveSnippetMcpRequestOptions(payload)
          )
        } catch (error) {
          if (isRetryableMcpFailure(error)) {
            throw new RetryableMcpSetupError(error)
          }
          throw error
        }
      } catch (error) {
        if (error instanceof RetryableMcpSetupError || isRetryableMcpFailure(error)) {
          throw new RetryableMcpSetupError(error)
        }
        throw error
      } finally {
        await client.close().catch(() => undefined)
      }
    },
    {
      shouldRetry: error => error instanceof RetryableMcpSetupError,
      remainingBudgetMs: () => remainingSnippetBudgetMs(payload),
    }
  )
}

interface SdkRetryOptions {
  shouldRetry?: (error: unknown) => boolean
  remainingBudgetMs?: () => number
}

class RetryableMcpSetupError extends Error {
  constructor(readonly original: unknown) {
    super(original instanceof Error ? original.message : String(original))
    this.name = 'RetryableMcpSetupError'
  }
}

async function withSdkRetry<T>(fn: () => Promise<T>, options: SdkRetryOptions = {}): Promise<T> {
  const attempts = 20
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt === attempts) break
      if (options.shouldRetry && !options.shouldRetry(error)) break
      const delayMs = Math.min(1000 * attempt, 5000)
      const remainingMs = options.remainingBudgetMs?.()
      if (remainingMs !== undefined && remainingMs <= delayMs) break
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
  throw lastError
}

function readPositiveSafeIntegerEnv(
  name: string,
  env: Record<string, string>,
  defaultValue: number
): number {
  const raw = env[name] ?? process.env[name]
  if (raw === undefined || raw === '') return defaultValue
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive safe integer`)
  const value = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return value
}

function remainingSnippetBudgetMs(payload: WorkerPayload): number {
  const startedAtMs = payload.startedAtMs ?? Date.now()
  return Math.max(0, payload.timeoutMs - (Date.now() - startedAtMs))
}

function withSnippetBudget<T>(
  operation: Promise<T>,
  payload: WorkerPayload,
  timeoutMessage: string
): Promise<T> {
  const timeoutMs = remainingSnippetBudgetMs(payload)
  if (timeoutMs < 1) throw new Error('snippet execution timed out')
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => rejectOnce(new Error(timeoutMessage)), timeoutMs)
    const resolveOnce = (value: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const rejectOnce = (error: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }
    operation.then(resolveOnce, rejectOnce)
  })
}

function resolveSnippetMcpRequestOptions(payload: WorkerPayload): { timeout: number } {
  const configuredTimeoutMs = readPositiveSafeIntegerEnv(
    MCP_TOOL_TIMEOUT_ENV,
    payload.env,
    DEFAULT_MCP_TOOL_TIMEOUT_MS
  )
  const configuredMaxTotalTimeoutMs = readPositiveSafeIntegerEnv(
    MCP_TOOL_MAX_TOTAL_TIMEOUT_ENV,
    payload.env,
    DEFAULT_MCP_TOOL_MAX_TOTAL_TIMEOUT_MS
  )
  const remainingMs = remainingSnippetBudgetMs(payload)
  if (
    configuredMaxTotalTimeoutMs < configuredTimeoutMs &&
    remainingMs > configuredMaxTotalTimeoutMs
  ) {
    throw new Error(
      `${MCP_TOOL_MAX_TOTAL_TIMEOUT_ENV} must be greater than or equal to ${MCP_TOOL_TIMEOUT_ENV}`
    )
  }
  if (remainingMs < 1) throw new Error('snippet execution timed out')
  return { timeout: Math.min(configuredTimeoutMs, configuredMaxTotalTimeoutMs, remainingMs) }
}

function isRetryableMcpFailure(error: unknown): boolean {
  const code =
    error && typeof error === 'object' ? (error as Record<string, unknown>).code : undefined
  if (code === -32001) return false
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error)
  const lower = message.toLowerCase()
  if (
    lower.includes('request timed out') ||
    lower.includes('validation') ||
    lower.includes('unauthorized') ||
    lower.includes('forbidden') ||
    lower.includes('permission') ||
    lower.includes('not allowed') ||
    lower.includes('auth')
  ) {
    return false
  }
  return (
    code === -32003 ||
    code === -32000 ||
    lower.includes('session not found') ||
    lower.includes('server not initialized') ||
    lower.includes('not ready') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('fetch failed') ||
    lower.includes('connection refused') ||
    lower.includes('socket hang up')
  )
}

function resolveAllowedWorkload(
  request: SnippetExecuteRequest,
  capability: 'mongo' | 'postgres',
  workloadId: string,
  defaultPort: number
): SnippetResolvedWorkload {
  resolveDatabaseAccess(request, capability, workloadId)
  const workload = request.resolvedWorkloads.find(item => item.id === workloadId)
  if (!workload) throw new Error(`${capability} workload is not resolved: ${workloadId}`)
  return { ...workload, port: workload.port ?? defaultPort }
}

function resolveDatabaseAccess(
  request: SnippetExecuteRequest,
  capability: 'mongo' | 'postgres',
  workloadId: string
): DatabaseAccess {
  const config =
    capability === 'mongo' ? request.run.capabilities?.mongo : request.run.capabilities?.postgres
  if (!config?.workloads?.includes(workloadId))
    throw new Error(`${capability} workload is not allowed: ${workloadId}`)
  if (config.access !== 'read' && config.access !== 'readWrite') {
    throw new Error(`${capability} capability must declare access read or readWrite`)
  }
  return config.access
}

function assertDatabaseAccess(
  request: SnippetExecuteRequest,
  capability: 'mongo' | 'postgres',
  workloadId: string,
  required: DatabaseAccess
): void {
  const access = resolveDatabaseAccess(request, capability, workloadId)
  if (required === 'readWrite' && access !== 'readWrite') {
    throw new Error(`${capability} workload "${workloadId}" requires readWrite access`)
  }
}

async function writeArtifact(
  payload: WorkerPayload,
  name: string,
  body: string,
  format: string
): Promise<{ name: string; format: string; sizeBytes: number; path: string; createdAt: string }> {
  if (
    !SAFE_ARTIFACT_NAME_RE.test(name) ||
    name.includes('..') ||
    name.includes('/') ||
    name.includes('\\')
  ) {
    throw new Error(`unsafe artifact filename: ${name}`)
  }
  const outputDir = payload.outputDir
  const target = path.join(outputDir, name)
  await fs.mkdir(outputDir, { recursive: true })
  await fs.writeFile(target, redactString(body, payload.env), 'utf8')
  const stat = await fs.stat(target)
  return {
    name,
    format,
    sizeBytes: stat.size,
    path: `/output/${name}`,
    createdAt: new Date().toISOString(),
  }
}

function clampLimit(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return max
  return Math.min(value, max)
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function assertRecordArray(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`)
  }
  return value.map((item, index) => assertRecord(item, `${label}[${index}]`))
}

function logSnippet(
  payload: WorkerPayload,
  level: 'info' | 'warn' | 'error',
  message: string,
  meta?: unknown
): void {
  const safeMessage = redactString(message, payload.env)
  const safeMeta = meta === undefined ? '' : ` ${JSON.stringify(redactValue(meta, payload.env))}`
  console[level](`[snippet] ${safeMessage}${safeMeta}`)
}

export function redactValue(value: unknown, env: Record<string, string>): unknown {
  if (typeof value === 'string') return redactString(value, env)
  if (Array.isArray(value)) return value.map(item => redactValue(item, env))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        redactValue(item, env),
      ])
    )
  }
  return value
}

export function redactString(value: string, env: Record<string, string>): string {
  let out = value
  for (const secret of Object.values(env).filter(item => item.length >= 4)) {
    out = out.split(secret).join('[REDACTED]')
  }
  return out
}
