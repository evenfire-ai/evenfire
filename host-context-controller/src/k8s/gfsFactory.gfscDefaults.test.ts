import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import {
  DEFAULT_GFSC_AGENT_READ_RL_PER_MIN_PER_REPLICA,
  DEFAULT_GFSC_AGENT_WRITE_RL_PER_MIN_PER_REPLICA,
  GfsFactoryConfig,
  MAX_GFSC_AGENT_RL_PER_MIN_PER_REPLICA,
  buildDeployment,
} from './gfsFactory'

/**
 * HCC writes the agent budgets into every gfsc pod, and gfsc has its own
 * defaults and ceiling for an image that rolls out before the operator's env.
 * The two packages share no module, so this reads gfsc's source and fails when
 * either side changes a value or an env name alone. A renamed env var on one
 * side would leave gfsc on its default with no error.
 */
const GFSC_CONFIG = resolve(__dirname, '../../../gfs-controller/src/config.ts')

function exportedNumericConst(sourceFile: ts.SourceFile, symbol: string): number {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    const exported = statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
    if (!exported || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== symbol) continue
      const initializer = declaration.initializer
      if (initializer === undefined || !ts.isNumericLiteral(initializer)) {
        throw new Error(`${symbol} in ${GFSC_CONFIG} must be initialized with a numeric literal`)
      }
      return Number(initializer.text)
    }
  }
  throw new Error(`${symbol} is not an exported const in ${GFSC_CONFIG}`)
}

/**
 * The env var name gfsc's loadConfig reads for `property`: the string literal
 * passed as the first argument of the parser call assigned to it.
 */
function envNameReadFor(sourceFile: ts.SourceFile, property: string): string {
  const names: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === property &&
      ts.isCallExpression(node.initializer)
    ) {
      const [first] = node.initializer.arguments
      if (first === undefined || !ts.isStringLiteral(first)) {
        throw new Error(`${property} in ${GFSC_CONFIG} must be parsed from a literal env name`)
      }
      names.push(first.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (names.length !== 1) {
    throw new Error(
      `expected one assignment of ${property} in ${GFSC_CONFIG}, found ${names.length}`
    )
  }
  return names[0]
}

function readGfscConfig(): ts.SourceFile {
  const source = readFileSync(GFSC_CONFIG, 'utf8')
  return ts.createSourceFile(GFSC_CONFIG, source, ts.ScriptTarget.Latest, true)
}

const factoryConfig: GfsFactoryConfig = {
  gfsNamespace: 'gfs',
  controlPlaneNamespace: 'control-plane',
  postgresPodLabels: { app: 'control-postgres' },
  postgresPort: 5432,
  gfscImage: 'clerum-gfs-controller:test',
  gfscImagePullPolicy: 'IfNotPresent',
  gfscPort: 8087,
  gfscInitImage: 'busybox:1.36',
  gfscResources: {
    requests: { memory: '128Mi', cpu: '100m' },
    limits: { memory: '256Mi', cpu: '500m' },
  },
  jwtPublicKeyConfigMapName: 'gfs-config',
  jwtPublicKeyConfigMapKey: 'jwt-public-key',
  pgSecretName: 'gfs-controller-db',
  pgSecretKey: 'connection-string',
  readerPgSecretName: 'gfs-controller-reader-db',
  readerPgSecretKey: 'connection-string',
  driveName: 'main',
  tokenAudience: 'gfs-controller',
  // Distinct values, so each budget's env entry is found by its value.
  agentReadRlPerMinPerReplica: 4321,
  agentWriteRlPerMinPerReplica: 1234,
}

describe('gfsc agent budget defaults', () => {
  it('R1-L5: HCC writes each budget under the env name gfsc reads it from, on every role', () => {
    const sourceFile = readGfscConfig()
    const expected = {
      read: envNameReadFor(sourceFile, 'agentReadRlPerMinPerReplica'),
      write: envNameReadFor(sourceFile, 'agentWriteRlPerMinPerReplica'),
    }
    for (const role of ['writer', 'reader'] as const) {
      const env =
        buildDeployment({ name: 'gfs', namespace: 'gfs', spec: {} }, factoryConfig, role).spec
          ?.template.spec?.containers[0].env ?? []
      const namesWithValue = (value: string) =>
        env.filter(item => item.value === value).map(item => item.name)
      // Witness: the pod env was built for this role.
      expect(env.find(item => item.name === 'GFS_STORAGE_ROLE')?.value).toBe(role)
      expect({ read: namesWithValue('4321'), write: namesWithValue('1234') }).toEqual({
        read: [expected.read],
        write: [expected.write],
      })
    }
  })

  it('L18: HCC defaults and ceiling equal the ones gfsc applies on its own', () => {
    const sourceFile = readGfscConfig()
    expect({
      read: exportedNumericConst(sourceFile, 'AGENT_READ_RL_PER_MIN_DEFAULT'),
      write: exportedNumericConst(sourceFile, 'AGENT_WRITE_RL_PER_MIN_DEFAULT'),
      max: exportedNumericConst(sourceFile, 'AGENT_RL_PER_MIN_MAX'),
    }).toEqual({
      read: DEFAULT_GFSC_AGENT_READ_RL_PER_MIN_PER_REPLICA,
      write: DEFAULT_GFSC_AGENT_WRITE_RL_PER_MIN_PER_REPLICA,
      max: MAX_GFSC_AGENT_RL_PER_MIN_PER_REPLICA,
    })
  })
})
