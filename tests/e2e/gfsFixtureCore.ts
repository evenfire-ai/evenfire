import { execFileSync } from 'node:child_process'

export const GFS_E2E_DRIVE = 'main'

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type GfsPermission = 'read' | 'write' | 'delete' | 'manage_acl' | 'share'

export interface GfsDirectoryFixture {
  name: string
  childName: string
  resourceId: string
  childResourceId: string
  uri: string
  childUri: string
}

export interface GfsFileFixture {
  name: string
  fileName: string
  resourceId: string
  fileResourceId: string
  uri: string
  fileUri: string
}

export interface GfsGrantSummary {
  permissions: GfsPermission[]
  inherit: boolean
  grantedBy: string
}

export interface GfsShareSummary {
  permissions: GfsPermission[]
  includeDescendants: boolean
  createdBy: string
}

export interface GfsResourceSummary {
  resourceId: string
  name: string
  kind: 'file' | 'directory'
  bytes: number
  version: number
  deleted: boolean
}

export interface E2EDelegateVisibility {
  ownerTeamId: string
  delegateUserId: string
  previousStatus: string | null
}

export function uniqueGfsFixtureName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 63)
    .replace(/-$/, '')
}

export function kubectlContext(): string {
  const context =
    process.env.E2E_K8S_CONTEXT ||
    process.env.KUBECONTEXT ||
    process.env.K8S_CONTEXT ||
    process.env.CONTEXT
  if (!context) {
    throw new Error(
      'GFS E2E fixtures require E2E_K8S_CONTEXT, KUBECONTEXT, K8S_CONTEXT, or CONTEXT'
    )
  }
  return context
}

export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function kubectlOut(args: string[], timeout = 20_000, input?: string | Buffer): string {
  return execFileSync('kubectl', ['--context', kubectlContext(), ...args], {
    encoding: 'utf-8',
    timeout,
    input,
  })
}

function controlPostgresPod(): string {
  const pod = kubectlOut(
    [
      '-n',
      'control-plane',
      'get',
      'pod',
      '-l',
      'app=control-postgres',
      '-o',
      'jsonpath={.items[0].metadata.name}',
    ],
    10_000
  ).trim()
  if (!pod) throw new Error(`control-postgres pod not found in context ${kubectlContext()}`)
  return pod
}

export function gfsWriterPod(): string {
  const pod = kubectlOut(
    [
      '-n',
      'gfs',
      'get',
      'pod',
      '-l',
      'app=gfs-controller,clerum.io/gfsc-role=writer',
      '-o',
      'jsonpath={.items[0].metadata.name}',
    ],
    10_000
  ).trim()
  if (!pod) throw new Error(`gfsc writer pod not found in context ${kubectlContext()}`)
  return pod
}

export function runControlPostgresSql(sql: string, timeout = 20_000): string {
  return kubectlOut(
    [
      '-n',
      'control-plane',
      'exec',
      controlPostgresPod(),
      '--',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'profiles',
      '-t',
      '-A',
      '-F',
      '|',
      '-c',
      sql,
    ],
    timeout
  )
}

export function firstDataLine(output: string): string {
  return (
    output
      .split('\n')
      .map(line => line.trim())
      .find(line => line.length > 0 && !/^\(\d+ rows?\)$/.test(line)) ?? ''
  )
}

export function splitSqlRow(row: string): string[] {
  return row.split('|').map(part => part.trim())
}

export function ridOf(resourceId: string): string {
  if (!UUID_RE.test(resourceId)) throw new Error(`invalid GFS resource id: ${resourceId}`)
  return resourceId.replace(/-/g, '').toLowerCase()
}

export function assertFixtureName(name: string): void {
  if (!/^e2e-gfs-[a-z0-9-]+$/.test(name)) {
    throw new Error(`refusing to mutate non-E2E GFS fixture "${name}"`)
  }
}
