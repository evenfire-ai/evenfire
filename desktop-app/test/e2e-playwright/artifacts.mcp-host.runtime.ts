import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { K8S_CONTEXT } from './workflowUi'

export const HOST_REF = process.env.E2E_HOST_REF || 'chatllm'

const MCP_HOST_NAMESPACE = process.env.E2E_MCP_HOST_NAMESPACE || 'mcp-host'
const OUTPUT_DIR = '/tmp/clerum-output'
const CHAT_TITLE_PREFIX = 'MCP host artifact E2E'
const DEFAULT_ARTIFACT_DOWNLOAD_MAX_MB = 250

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function kubectl(args: string[], input?: string): string {
  return execFileSync('kubectl', ['--context', K8S_CONTEXT, ...args], {
    encoding: 'utf-8',
    input,
    timeout: 20_000,
  }).trim()
}

function resolveMcpHostDeployment(): string {
  const candidates = [process.env.E2E_MCP_HOST_DEPLOYMENT, HOST_REF, 'chatllm', 'mcp-host'].filter(
    Boolean
  ) as string[]

  for (const candidate of candidates) {
    try {
      kubectl(['get', 'deployment', candidate, '-n', MCP_HOST_NAMESPACE, '-o', 'name'])
      return candidate
    } catch {
      // Try the next supported local deployment name.
    }
  }
  throw new Error(`No mcp-host deployment found in namespace ${MCP_HOST_NAMESPACE}`)
}

function mcpHostExec(command: string, input?: string): string {
  return kubectl(
    [
      'exec',
      '-n',
      MCP_HOST_NAMESPACE,
      `deploy/${resolveMcpHostDeployment()}`,
      '--',
      'sh',
      '-c',
      command,
    ],
    input
  )
}

export function prepareRuntimeArtifact(artifactName: string, artifactBody: string): void {
  mcpHostExec(`mkdir -p ${shellQuote(OUTPUT_DIR)}`)
  mcpHostExec(
    `printf %s ${shellQuote(artifactBody)} > ${shellQuote(`${OUTPUT_DIR}/${artifactName}`)}`
  )
}

export function prepareRuntimeBinaryArtifact(artifactName: string, artifactBody: Buffer): void {
  mcpHostExec(`mkdir -p ${shellQuote(OUTPUT_DIR)}`)
  mcpHostExec(
    [
      'node',
      '-e',
      shellQuote(
        "require('fs').writeFileSync(process.argv[1], Buffer.from(process.argv[2], 'base64'))"
      ),
      shellQuote(`${OUTPUT_DIR}/${artifactName}`),
      shellQuote(artifactBody.toString('base64')),
    ].join(' ')
  )
}

function artifactDownloadLimitBytes(): number {
  const raw =
    process.env.E2E_ARTIFACT_DOWNLOAD_MAX_MB ||
    process.env.RPC_PROXY_ARTIFACT_DOWNLOAD_MAX_MB ||
    String(DEFAULT_ARTIFACT_DOWNLOAD_MAX_MB)
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid artifact download limit: ${raw}`)
  }
  return Math.floor(parsed * 1024 * 1024)
}

export function growRuntimeArtifactBeyondDownloadLimit(artifactName: string): void {
  const limitBytes = artifactDownloadLimitBytes()
  mcpHostExec(
    [
      'node',
      '-e',
      JSON.stringify(
        [
          "const fs = require('fs')",
          `const fd = fs.openSync(${JSON.stringify(`${OUTPUT_DIR}/${artifactName}`)}, 'w')`,
          `fs.writeSync(fd, Buffer.from([0]), 0, 1, ${limitBytes})`,
          'fs.closeSync(fd)',
        ].join('; ')
      ),
    ].join(' ')
  )
}

export function cleanupRuntimeArtifact(artifactName: string): void {
  try {
    mcpHostExec(`rm -f ${shellQuote(`${OUTPUT_DIR}/${artifactName}`)}`)
  } catch {
    // Cleanup must not hide the real test result.
  }
}

function chatStorePaths(userId: string, chatId: string) {
  const agentDir = path.join(os.homedir(), '.clerum', 'chats', userId, HOST_REF)
  return {
    agentDir,
    indexPath: path.join(agentDir, 'index.json'),
    chatPath: path.join(agentDir, `${chatId}.json`),
  }
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch {
    return fallback
  }
}

export function seedLocalArtifactChat(
  userId: string,
  artifactName: string | string[]
): {
  chatId: string
  title: string
  restore: () => void
} {
  const artifactNames = Array.isArray(artifactName) ? artifactName : [artifactName]
  const primaryArtifactName = artifactNames[0] ?? 'artifact.txt'
  const chatId = `e2e-pr91-artifact-${Date.now()}`
  const title = `${CHAT_TITLE_PREFIX} ${primaryArtifactName.slice(0, 18)}`
  const { agentDir, indexPath, chatPath } = chatStorePaths(userId, chatId)
  const previousIndex = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : null
  const now = new Date().toISOString()
  const nowMs = Date.now()
  const existingIndex = readJsonFile<{
    version: number
    lastActiveChatId: string | null
    chatPanelOpen: boolean
    onboardingDismissed: boolean
    chats: Array<{
      id: string
      title: string
      createdAt: string
      updatedAt: string
      messageCount: number
    }>
  }>(indexPath, {
    version: 1,
    lastActiveChatId: null,
    chatPanelOpen: false,
    onboardingDismissed: false,
    chats: [],
  })

  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(
    indexPath,
    JSON.stringify(
      {
        ...existingIndex,
        version: 1,
        lastActiveChatId: chatId,
        chatPanelOpen: true,
        onboardingDismissed: true,
        chats: [
          ...existingIndex.chats.filter(chat => chat.id !== chatId),
          {
            id: chatId,
            title,
            createdAt: now,
            updatedAt: now,
            messageCount: 2,
          },
        ],
      },
      null,
      2
    ),
    { mode: 0o600 }
  )
  fs.writeFileSync(
    chatPath,
    JSON.stringify(
      {
        version: 1,
        chatId,
        messages: [
          {
            id: `${chatId}-user`,
            role: 'user',
            content: 'Show me the generated runtime artifact.',
            timestamp: nowMs - 1_000,
          },
          {
            id: `${chatId}-assistant`,
            role: 'assistant',
            content: `Generated artifact: ${artifactNames.join(' and ')}`,
            timestamp: nowMs,
          },
        ],
      },
      null,
      2
    ),
    { mode: 0o600 }
  )

  return {
    chatId,
    title,
    restore: () => {
      fs.rmSync(chatPath, { force: true })
      if (previousIndex === null) {
        fs.rmSync(indexPath, { force: true })
      } else {
        fs.writeFileSync(indexPath, previousIndex, { mode: 0o600 })
      }
    },
  }
}
