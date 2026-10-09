import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { hostAccessDenialCodeForReason } from '../services/hostAccessDenial.js'

/**
 * PR #849 R3-L9: cross-service guard for the Host-access denial contract.
 *
 * control-api names the denial reason (`RpcHostAccessDenialReason`) and sends it
 * in a response header; rpc-proxy reads that header, maps the reason to a
 * `HostAccessDenialCode`, and Desktop matches the code against its own
 * constants. The three services share no module, so each hop is read here as
 * source and compared. The rpc-proxy literals are also checked against the
 * running mapping, so a parse that drifted from the code fails instead of
 * comparing stale text.
 */

function read(relativeFromThisFile: string): string {
  return readFileSync(new URL(relativeFromThisFile, import.meta.url), 'utf-8')
}

/** Fail-loud single-match extraction — a miss means the source moved. */
function extractOne(source: string, pattern: RegExp, label: string): string {
  const match = source.match(pattern)
  if (!match || match[1] === undefined) {
    throw new Error(`Could not extract ${label} with ${pattern} — re-derive the guard`)
  }
  return match[1]
}

/** Every single-quoted literal of a union or array body; empty is a failure. */
function quotedLiterals(body: string, label: string): string[] {
  const literals = [...body.matchAll(/'([^']+)'/g)].map(match => match[1]!)
  if (literals.length === 0) throw new Error(`No literals found in ${label}`)
  return literals
}

function oneLiveNode(root: ts.Node, matches: (node: ts.Node) => boolean, label: string): ts.Node {
  const found: ts.Node[] = []
  const visit = (node: ts.Node) => {
    if (matches(node)) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(root)
  // Report counts rather than AST objects, which retain the entire source text.
  expect(found.length, label).toBe(1)
  return found[0]!
}

function writtenRefField(
  object: ts.ObjectLiteralExpression,
  binding: string,
  label: string
): string {
  const property = oneLiveNode(
    object,
    node =>
      (ts.isShorthandPropertyAssignment(node) && node.name.text === binding) ||
      (ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.initializer) &&
        node.initializer.text === binding),
    label
  ) as ts.ShorthandPropertyAssignment | ts.PropertyAssignment
  return ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
    ? property.name.text
    : property.name.getText()
}

const controlApiAuthorizer = read(
  '../../../control-api/src/services/access/rpcHostAccessAuthorizer.ts'
)
const controlApiRoute = read('../../../control-api/src/routes/rpc-access/users.ts')
const rpcProxyRestService = read('../services/controlApiRestService.ts')
const rpcProxyDenial = read('../services/hostAccessDenial.ts')
const desktopUpstreamErrors = read('../../../desktop-app/src/upstreamErrors.ts')

const controlApiReasons = quotedLiterals(
  extractOne(
    controlApiAuthorizer,
    /export type RpcHostAccessDenialReason =([\s\S]*?)\n\n/,
    'control-api RpcHostAccessDenialReason'
  ),
  'control-api RpcHostAccessDenialReason'
)
const revokedReasons = quotedLiterals(
  extractOne(
    rpcProxyDenial,
    /const REVOKED_CONTROL_API_REASONS: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\)/,
    'rpc-proxy REVOKED_CONTROL_API_REASONS'
  ),
  'rpc-proxy REVOKED_CONTROL_API_REASONS'
)
const rpcProxyCodes = quotedLiterals(
  extractOne(
    rpcProxyDenial,
    /export type HostAccessDenialCode = ([^\n]+)/,
    'rpc-proxy HostAccessDenialCode'
  ),
  'rpc-proxy HostAccessDenialCode'
)
const desktopRevokedCode = extractOne(
  desktopUpstreamErrors,
  /export const HOST_ACCESS_REVOKED_CODE = '([^']+)'/,
  'desktop HOST_ACCESS_REVOKED_CODE'
)
const desktopDeniedCode = extractOne(
  desktopUpstreamErrors,
  /export const HOST_ACCESS_DENIED_CODE = '([^']+)'/,
  'desktop HOST_ACCESS_DENIED_CODE'
)

describe('R3-L9 Host-access denial contract across control-api, rpc-proxy and Desktop', () => {
  it('rpc-proxy reads the denial-reason header under the name control-api sends it', () => {
    const sent = extractOne(
      controlApiRoute,
      /export const HOST_ACCESS_DENIAL_REASON_HEADER = '([^']+)'/,
      'control-api HOST_ACCESS_DENIAL_REASON_HEADER'
    )
    const received = extractOne(
      rpcProxyRestService,
      /const reason = response\.headers\.get\('([^']+)'\)/,
      'rpc-proxy denial-reason header read'
    )

    expect(received).toBe(sent)
  })

  it('every revoking reason in rpc-proxy is a reason control-api can send', () => {
    // Witness: the parsed set is the running set.
    for (const reason of revokedReasons) {
      expect(hostAccessDenialCodeForReason(reason)).toBe('host_access_revoked')
    }
    for (const reason of revokedReasons) {
      expect(controlApiReasons).toContain(reason)
    }
    // And every other control-api reason is a plain denial.
    const deniedReasons = controlApiReasons.filter(r => !revokedReasons.includes(r))
    expect(deniedReasons.length).toBeGreaterThan(0)
    for (const reason of deniedReasons) {
      expect(hostAccessDenialCodeForReason(reason)).toBe('host_access_denied')
    }
  })

  it('Desktop matches exactly the codes rpc-proxy emits', () => {
    expect([...rpcProxyCodes].sort()).toEqual([desktopDeniedCode, desktopRevokedCode].sort())
    // The running mapping emits Desktop's literals for both outcomes.
    for (const reason of revokedReasons) {
      expect(hostAccessDenialCodeForReason(reason)).toBe(desktopRevokedCode)
    }
    expect(hostAccessDenialCodeForReason('a_reason_no_service_sends')).toBe(desktopDeniedCode)
  })
})

describe('RPC token mint revocation contract', () => {
  const controlApiMint = read('../../../control-api/src/routes/external/auth.ts')
  const controlApiMintToken = read('../../../control-api/src/utils/auth/rpcAuthToken.ts')
  const restMintService = read('../../../external-rest-api/src/services/rpcService.ts')
  const restMintRoute = read('../../../external-rest-api/src/routes/rpc.ts')

  it('G1: keeps the authenticated mint, REST, proxy and Desktop revocation vocabulary identical', () => {
    const mintCode = extractOne(
      controlApiMintToken,
      /^export const RPC_TOKEN_REVOKED_CODE = '([^']+)'/m,
      'control-api mint RPC_TOKEN_REVOKED_CODE'
    )
    const relayCode = extractOne(
      restMintService,
      /^export const RPC_TOKEN_REVOKED_CODE = '([^']+)'/m,
      'REST mint RPC_TOKEN_REVOKED_CODE'
    )

    expect(mintCode).toBe('host_access_revoked')
    expect(relayCode).toBe(mintCode)
    expect(rpcProxyCodes).toContain(mintCode)
    expect(desktopRevokedCode).toBe(mintCode)
    expect(revokedReasons.length).toBeGreaterThan(0)
    for (const reason of revokedReasons) {
      expect(hostAccessDenialCodeForReason(reason)).toBe(mintCode)
    }
  })

  it('G2: connects the live revoked Host-ref writers and readers across every mint hop', () => {
    const parse = (label: string, source: string) =>
      ts.createSourceFile(label, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const mint = parse('control-api mint', controlApiMint)
    const relay = parse('REST service', restMintService)
    const route = parse('REST route', restMintRoute)
    const desktop = parse('Desktop upstream errors', desktopUpstreamErrors)
    const mintPost = oneLiveNode(
      mint,
      node =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'post' &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0]!) &&
        node.arguments[0]!.text === '/external/rpc/token',
      'authenticated mint POST'
    )
    const mintJson = oneLiveNode(
      mintPost,
      node =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'json' &&
        node.arguments.length === 1 &&
        ts.isConditionalExpression(node.arguments[0]!),
      'mint conditional JSON writer'
    ) as ts.CallExpression
    const mintObject = (mintJson.arguments[0] as ts.ConditionalExpression)
      .whenTrue as ts.ObjectLiteralExpression
    expect(ts.isObjectLiteralExpression(mintObject)).toBe(true)

    const relayReader = oneLiveNode(
      relay,
      node =>
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'revokedHostRefs' &&
        Boolean(
          node.initializer &&
          ts.isPropertyAccessExpression(node.initializer) &&
          ts.isIdentifier(node.initializer.expression) &&
          node.initializer.expression.text === 'body'
        ),
      'REST body reader bound to revokedHostRefs'
    ) as ts.VariableDeclaration
    const relayReturn = oneLiveNode(
      relay,
      node =>
        ts.isReturnStatement(node) &&
        Boolean(
          node.expression &&
          ts.isObjectLiteralExpression(node.expression) &&
          node.expression.properties.some(
            property =>
              ts.isPropertyAssignment(property) &&
              ts.isIdentifier(property.name) &&
              property.name.text === 'code' &&
              ts.isIdentifier(property.initializer) &&
              property.initializer.text === 'RPC_TOKEN_REVOKED_CODE'
          )
        ),
      'REST revocation return writer'
    ) as ts.ReturnStatement

    const routeJson = oneLiveNode(
      route,
      node =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'json' &&
        node.arguments.length === 1 &&
        ts.isConditionalExpression(node.arguments[0]!),
      'REST conditional denial JSON writer'
    ) as ts.CallExpression
    const routeObject = (routeJson.arguments[0] as ts.ConditionalExpression)
      .whenTrue as ts.ObjectLiteralExpression
    expect(ts.isObjectLiteralExpression(routeObject)).toBe(true)

    const desktopHelper = oneLiveNode(
      desktop,
      node => ts.isFunctionDeclaration(node) && node.name?.text === 'rpcTokenMintRevocationMessage',
      'Desktop requested-Host mint classifier'
    )
    const desktopExactReader = oneLiveNode(
      desktopHelper,
      node => {
        if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
          return false
        }
        const receiver = node.expression.expression
        const comparison = node.arguments[0]
        return (
          node.expression.name.text === 'every' &&
          ts.isPropertyAccessExpression(receiver) &&
          ts.isIdentifier(receiver.expression) &&
          receiver.expression.text === 'record' &&
          receiver.name.text === 'revokedHostRefs' &&
          ts.isArrowFunction(comparison) &&
          ts.isBinaryExpression(comparison.body) &&
          comparison.body.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
          ts.isElementAccessExpression(comparison.body.right) &&
          ts.isIdentifier(comparison.body.right.expression) &&
          comparison.body.right.expression.text === 'canonicalRefs'
        )
      },
      'Desktop exact-array reader from the parsed mint body'
    ) as ts.CallExpression
    const desktopLengthCheck = oneLiveNode(
      desktopHelper,
      node => {
        if (
          !ts.isBinaryExpression(node) ||
          node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
          !ts.isPropertyAccessExpression(node.left) ||
          !ts.isPropertyAccessExpression(node.right)
        ) {
          return false
        }
        const refs = node.left.expression
        return (
          node.left.name.text === 'length' &&
          ts.isPropertyAccessExpression(refs) &&
          ts.isIdentifier(refs.expression) &&
          refs.expression.text === 'record' &&
          refs.name.text === 'revokedHostRefs' &&
          node.right.name.text === 'length' &&
          ts.isIdentifier(node.right.expression) &&
          node.right.expression.text === 'canonicalRefs'
        )
      },
      'Desktop exact-array length check'
    ) as ts.BinaryExpression
    const desktopReaderField = (
      (desktopExactReader.expression as ts.PropertyAccessExpression)
        .expression as ts.PropertyAccessExpression
    ).name.text
    const desktopLengthField = (
      (desktopLengthCheck.left as ts.PropertyAccessExpression)
        .expression as ts.PropertyAccessExpression
    ).name.text

    expect({
      controlApiJson: writtenRefField(mintObject, 'revokedHostRefs', 'mint JSON refs'),
      restBody: (relayReader.initializer as ts.PropertyAccessExpression).name.text,
      restReturn: writtenRefField(
        relayReturn.expression as ts.ObjectLiteralExpression,
        'revokedHostRefs',
        'REST returned refs'
      ),
      restJson: writtenRefField(routeObject, 'revokedHostRefs', 'REST JSON refs'),
      desktopReader: desktopReaderField,
      desktopLength: desktopLengthField,
    }).toEqual({
      controlApiJson: 'revokedHostRefs',
      restBody: 'revokedHostRefs',
      restReturn: 'revokedHostRefs',
      restJson: 'revokedHostRefs',
      desktopReader: 'revokedHostRefs',
      desktopLength: 'revokedHostRefs',
    })
  })
})
