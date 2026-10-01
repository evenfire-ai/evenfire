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

  const producerInputs = ['hasEgress', 'capabilities', 'wantsDeny', 'failMode', 'image'].map(
    name => {
      const matches = block.statements.filter(
        statement =>
          ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some(
            declaration => declaration.name.getText(source) === name
          )
      )
      if (matches.length !== 1 || block.statements.indexOf(matches[0]) >= first) {
        throw new Error(`Registry LlmHook ${name} decision changed; rederive the frontend fixture`)
      }
      return matches[0]
    }
  )
  producerInputs.sort((a, b) => a.pos - b.pos)

  const specStatements = block.statements
    .slice(first, last + 1)
    .map(statement => statement.getText(source))
    .join('\n')
  const buildSpec = compile<(hookMeta: unknown, body: unknown) => Record<string, unknown>>(
    `function produce(hookMeta, body) {
      const secretCreated = false, attachPullSecret = false;
      ${producerInputs.map(statement => statement.getText(source)).join('\n')}
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
    const spec = buildSpec(hookMeta, {})
    const payload = buildPayload(name, {}, {}, spec)
    return {
      ...payload,
      metadata: { ...payload.metadata, namespace: 'llm-hooks', resourceVersion: 'rv-hook-read' },
      status: hccReadyStatus(spec.target as Record<string, unknown>, name),
    }
  }
}

function hostHookReferenceProducer(): (hookId: string) => { id: string; digest?: string } {
  const source = readProducer('control-api/src/services/hostGuardrailRefs.ts')
  const installFunctions = source.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === 'addHookRefToHost' &&
      statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
  )
  const install = installFunctions[0]
  const expectedParameters = [
    'gateway',
    'hostName',
    'hookId',
    'lifecyclePoints',
    'digest',
    'hostsNamespace',
  ]
  if (
    installFunctions.length !== 1 ||
    !install?.body ||
    install.parameters.map(parameter => parameter.name.getText(source)).join(',') !==
      expectedParameters.join(',')
  ) {
    throw new Error('Control API Host guardrail install producer changed')
  }

  const pushes: ts.CallExpression[] = []

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'arr.push')
      pushes.push(node)
    ts.forEachChild(node, visit)
  }
  visit(install.body)
  if (
    pushes.length !== 1 ||
    pushes[0].arguments.length !== 1 ||
    !ts.isObjectLiteralExpression(pushes[0].arguments[0])
  ) {
    throw new Error('Control API Host guardrail install reference is missing or ambiguous')
  }
  const reference = pushes[0].arguments[0]
  const produce = compile<(hookId: string, digest: undefined) => { id: string; digest?: string }>(
    `const produce = (hookId, digest) => (${reference.getText(source)});`
  )
  return hookId => produce(hookId, undefined)
}

function hccReadyStatus(target: Record<string, unknown>, hookName: string): LlmHookStatus {
  const source = readProducer('host-context-controller/src/llmHookReconciler.ts')
  let conditionFactory: ts.FunctionDeclaration | undefined
  let reconcileNonImage: ts.MethodDeclaration | undefined
  let transitionTime: ts.Expression | undefined
  let mergedCondition: ts.Expression | undefined

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'condition') {
      conditionFactory = node
    }
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === 'reconcileNonImage') {
      reconcileNonImage = node
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'lastTransitionTime') {
      transitionTime = node.initializer
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'merged') {
      mergedCondition = node.initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (
    !conditionFactory ||
    !reconcileNonImage?.body ||
    !transitionTime ||
    !mergedCondition ||
    !ts.isObjectLiteralExpression(mergedCondition)
  ) {
    throw new Error('HCC LlmHook condition producer changed')
  }
  // Execute the producer's branch and condition call. Removing await only makes
  // the isolated network-policy/status stubs synchronous for this fixture.
  const methodSource = ts.createSourceFile(
    'reconcileNonImage.ts',
    `function reconcile(hook, kind) ${reconcileNonImage.body.getText(source)}`,
    ts.ScriptTarget.Latest,
    true
  )
  const transformed = ts.transform(methodSource, [
    context => {
      const visit = (node: ts.Node): ts.Node =>
        ts.isAwaitExpression(node)
          ? ts.visitNode(node.expression, visit)
          : ts.visitEachChild(node, visit, context)
      return node => ts.visitNode(node, visit) as ts.SourceFile
    },
  ])
  const reconcileBody = ts.createPrinter().printFile(transformed.transformed[0] as ts.SourceFile)
  transformed.dispose()
  const reconcile = compile<
    (
      hook: { name: string },
      kind: 'service' | 'remote'
    ) => {
      condition: Omit<LlmHookCondition, 'lastTransitionTime'>
      extras: Record<string, unknown>
    }
  >(
    `${conditionFactory.getText(source)}
    ${reconcileBody}
    function produce(hook, kind) {
      const emitted = [];
      const runtime = {
        ensureServiceTargetNetworkPolicy() {},
        deleteServiceTargetNetworkPolicy() {},
        writeStatus(_hook, condition, extras = {}) { emitted.push({ condition, extras }); },
      };
      reconcile.call(runtime, hook, kind);
      if (emitted.length !== 1) throw new Error('HCC emitted no unique non-image status');
      return emitted[0];
    }`
  )
  const merge = compile<
    (
      condition: Omit<LlmHookCondition, 'lastTransitionTime'>,
      now: string,
      hook: { generation?: number }
    ) => LlmHookCondition
  >(
    `const produce = (condition, now, hook) => {
      const prior = undefined;
      const lastTransitionTime = ${transitionTime.getText(source)};
      return (${mergedCondition.getText(source)});
    };`
  )
  const kind = 'service' in target ? 'service' : 'remote' in target ? 'remote' : undefined
  if (!kind) throw new Error('Guardrail fixture requires an HCC non-image target')
  const { condition, extras } = reconcile({ name: hookName }, kind)
  return {
    ...extras,
    conditions: [merge(condition, '2026-01-01T00:00:00.000Z', {})],
  }
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
