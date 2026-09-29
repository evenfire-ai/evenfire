import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import type { HostResource, LlmHookCondition, LlmHookResource, LlmHookStatus } from '../../lib/api'
import { materializeHostResource } from './contextResource'

const root = path.resolve(__dirname, '../../..')

function readProducer(relativePath: string): ts.SourceFile {
  const filePath = path.join(root, relativePath)
  return ts.createSourceFile(filePath, readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true)
}

function compile<T>(body: string): T {
  const javascript = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  return new Function(`${javascript}\nreturn produce;`)() as T
}

function registryHookProducer(): (name: string) => LlmHookResource {
  const source = readProducer('control-api/src/routes/admin/registry.ts')
  const blocks: ts.Block[] = []
  let resourcePayload: ts.Expression | undefined

  function visit(node: ts.Node): void {
    if (ts.isBlock(node)) {
      const names = node.statements.map(statement =>
        ts.isVariableStatement(statement)
          ? statement.declarationList.declarations[0]?.name.getText(source)
          : undefined
      )
      if (names.includes('targetSpec') && names.includes('hookSpec')) blocks.push(node)
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'gateway.createResource' &&
      node.arguments[0]?.getText(source) === "'llmhooks'"
    ) {
      resourcePayload = node.arguments[1]
    }
    ts.forEachChild(node, visit)
  }
  visit(source)

  if (blocks.length !== 1 || !resourcePayload || !ts.isObjectLiteralExpression(resourcePayload)) {
    throw new Error('Registry LlmHook producer changed; rederive the frontend fixture')
  }
  const block = blocks[0]
  const names = block.statements.map(statement =>
    ts.isVariableStatement(statement)
      ? statement.declarationList.declarations[0]?.name.getText(source)
      : undefined
  )
  const first = names.indexOf('targetSpec')
  const last = names.indexOf('hookSpec')
  if (first < 0 || last <= first) {
    throw new Error('Registry LlmHook spec construction changed')
  }

  const specStatements = block.statements
    .slice(first, last + 1)
    .map(statement => statement.getText(source))
    .join('\n')
  const buildSpec = compile<(hookMeta: unknown, body: unknown) => Record<string, unknown>>(
    `function produce(hookMeta, body) {
      const image = undefined, secretCreated = false, hasEgress = false, attachPullSecret = false;
      const failMode = 'open', capabilities = [];
      ${specStatements}
      return hookSpec;
    }`
  )
  const buildPayload = compile<
    (
      crName: string,
      registryLabels: Record<string, string>,
      registryAnnotations: Record<string, string>,
      hookSpec: Record<string, unknown>
    ) => LlmHookResource
  >(
    `const produce = (crName, registryLabels, registryAnnotations, hookSpec) =>
      (${resourcePayload.getText(source)});`
  )

  return name => {
    const hookMeta = {
      target: { service: { name: 'sample-hook-service', namespace: 'llm-hooks', port: 8080 } },
      path: '/check',
      lifecyclePoints: ['preCall'],
    }
    const spec = buildSpec(hookMeta, { order: 100 })
    const payload = buildPayload(name, {}, {}, spec)
    return {
      ...payload,
      metadata: { ...payload.metadata, namespace: 'llm-hooks', resourceVersion: 'rv-hook-read' },
      status: hccReadyStatus(),
    }
  }
}

function hostHookReferenceProducer(): (hookId: string) => { id: string; digest?: string } {
  const source = readProducer('control-api/src/services/hostGuardrailRefs.ts')
  let reference: ts.Expression | undefined

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'arr.push' &&
      node.arguments.length === 1 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      reference = node.arguments[0]
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!reference) {
    throw new Error('Control API Host guardrail reference producer changed')
  }
  const produce = compile<(hookId: string, digest: undefined) => { id: string; digest?: string }>(
    `const produce = (hookId, digest) => (${reference.getText(source)});`
  )
  return hookId => produce(hookId, undefined)
}

function hccReadyStatus(): LlmHookStatus {
  const source = readProducer('host-context-controller/src/llmHookReconciler.ts')
  let conditionFactory: ts.FunctionDeclaration | undefined
  let mergedCondition: ts.Expression | undefined

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'condition') {
      conditionFactory = node
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'merged') {
      mergedCondition = node.initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!conditionFactory || !mergedCondition || !ts.isObjectLiteralExpression(mergedCondition)) {
    throw new Error('HCC LlmHook condition producer changed')
  }
  const condition = compile<
    (
      status: 'True',
      reason: 'NoWorkload',
      message: string
    ) => Omit<LlmHookCondition, 'lastTransitionTime'>
  >(`${conditionFactory.getText(source)}\nconst produce = condition;`)
  const merge = compile<
    (
      condition: Omit<LlmHookCondition, 'lastTransitionTime'>,
      now: string,
      hook: { generation: number }
    ) => LlmHookCondition
  >(
    `const produce = (condition, now, hook) => {
      const lastTransitionTime = now;
      return (${mergedCondition.getText(source)});
    };`
  )
  const ready = condition('True', 'NoWorkload', 'No workload deployed for service/remote target')
  return { conditions: [merge(ready, '2026-01-01T00:00:00.000Z', { generation: 1 })] }
}

const buildHook = registryHookProducer()
const buildHostHookReference = hostHookReferenceProducer()

/** Registry install payload, Control API Host mutation, and HCC status wire shape. */
export function buildGuardrailDetailScenario(
  hookName = 'sample-hook',
  hostName = 'sample-agent'
): { hook: LlmHookResource; hosts: { items: HostResource[] } } {
  const hook = buildHook(hookName)
  const host = materializeHostResource(
    {
      metadata: { name: hostName },
      spec: {
        host: hostName,
        contextRef: 'default',
        secretRef: 'sample-secret',
        channels: [],
        model: { provider: 'openai', name: 'sample-model' },
      },
    },
    { spec: { guardrails: { hooks: { preCall: [buildHostHookReference(hookName)] } } } }
  )
  return { hook, hosts: { items: [host] } }
}
