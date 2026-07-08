import * as fs from 'node:fs/promises'
import { WorkflowSDKInitError } from '../errors'

export type RuntimeTokenProvider = {
  getWrcToken?(): Promise<string>
  getMcpHostToken?(): Promise<string>
  getSnippetRunnerToken?(): Promise<string>
  getWorkflowControlToken?(): Promise<string>
}

type FileRuntimeTokenProviderOptions = {
  wrcTokenFile?: string
  mcpHostTokenFile?: string
  snippetRunnerTokenFile?: string
  workflowControlTokenFile?: string
}

type StaticRuntimeTokenProviderOptions = {
  wrcToken?: string
  mcpHostToken?: string
  snippetRunnerToken?: string
  workflowControlToken?: string
}

async function readTokenFile(path: string, label: string): Promise<string> {
  let raw: string
  try {
    raw = await fs.readFile(path, 'utf8')
  } catch (error) {
    const cause = error instanceof Error ? `: ${error.message}` : ''
    throw new WorkflowSDKInitError(`${label} file unreadable${cause}`)
  }
  const token = raw.trim()
  if (!token) {
    throw new WorkflowSDKInitError(`${label} file empty`)
  }
  return token
}

function staticToken(value: string | undefined, label: string): () => Promise<string> {
  return async () => {
    const token = value?.trim()
    if (!token) throw new WorkflowSDKInitError(label)
    return token
  }
}

export function createFileRuntimeTokenProvider(
  options: FileRuntimeTokenProviderOptions
): RuntimeTokenProvider {
  return {
    ...(options.wrcTokenFile
      ? { getWrcToken: () => readTokenFile(options.wrcTokenFile!, 'WRC_TOKEN_FILE') }
      : {}),
    ...(options.mcpHostTokenFile
      ? {
          getMcpHostToken: () => readTokenFile(options.mcpHostTokenFile!, 'MCP_HOST_TOKEN_FILE'),
        }
      : {}),
    ...(options.snippetRunnerTokenFile
      ? {
          getSnippetRunnerToken: () =>
            readTokenFile(options.snippetRunnerTokenFile!, 'SNIPPET_RUNNER_TOKEN_FILE'),
        }
      : {}),
    ...(options.workflowControlTokenFile
      ? {
          getWorkflowControlToken: () =>
            readTokenFile(
              options.workflowControlTokenFile!,
              'MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE'
            ),
        }
      : {}),
  }
}

export function createStaticRuntimeTokenProvider(
  options: StaticRuntimeTokenProviderOptions
): RuntimeTokenProvider {
  return {
    ...(options.wrcToken ? { getWrcToken: staticToken(options.wrcToken, 'WRC_TOKEN') } : {}),
    ...(options.mcpHostToken
      ? { getMcpHostToken: staticToken(options.mcpHostToken, 'MCP_HOST_TOKEN') }
      : {}),
    ...(options.snippetRunnerToken
      ? {
          getSnippetRunnerToken: staticToken(options.snippetRunnerToken, 'SNIPPET_RUNNER_TOKEN'),
        }
      : {}),
    ...(options.workflowControlToken
      ? {
          getWorkflowControlToken: staticToken(
            options.workflowControlToken,
            'MCP_HOST_WORKFLOW_CONTROL_TOKEN'
          ),
        }
      : {}),
  }
}

export async function requireRuntimeToken(
  provider: RuntimeTokenProvider,
  method: keyof RuntimeTokenProvider,
  label: string
): Promise<string> {
  const getter = provider[method]
  if (!getter) throw new WorkflowSDKInitError(label)
  return getter.call(provider)
}
