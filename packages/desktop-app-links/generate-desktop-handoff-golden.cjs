'use strict'

// Regenerates the desktop-environment / desktop-setup golden fixtures by executing the code
// that built and parsed those links before they moved into this package. The expected values
// must come from that code, never be typed by hand: a hand-written expectation only restates
// what the author believes the old producer emitted.
//
// Usage (from the repo root): node packages/desktop-app-links/generate-desktop-handoff-golden.cjs [sha]
// Needs git history containing <sha> and `typescript` installed under desktop-app or profile-ui.

const childProcess = require('node:child_process')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')

const BASE_SHA = process.argv[2] || '2c6e52409'
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const PACKAGE_GOLDEN = path.join(__dirname, 'desktop-handoff-links.golden.json')
const PROFILE_GOLDEN = path.join(
  REPO_ROOT,
  'profile-ui',
  'test',
  'fixtures',
  'desktop-handoff-links.golden.json'
)

function gitShow(relativePath) {
  return childProcess.execFileSync(
    'git',
    ['-C', REPO_ROOT, 'show', `${BASE_SHA}:${relativePath}`],
    {
      encoding: 'utf8',
    }
  )
}

const typescript = require(
  require.resolve('typescript', {
    paths: [path.join(REPO_ROOT, 'desktop-app'), path.join(REPO_ROOT, 'profile-ui')],
  })
)

function loadModule(source, filename, requireMap = {}) {
  const { outputText } = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      jsx: typescript.JsxEmit.ReactJSX,
    },
    fileName: filename,
  })
  const loaded = new Module(filename)
  loaded.filename = filename
  loaded.require = specifier => {
    if (Object.hasOwn(requireMap, specifier)) return requireMap[specifier]
    throw new Error(`Unexpected import ${specifier} in ${filename}`)
  }
  loaded._compile(outputText, filename)
  return loaded.exports
}

function matchOnce(source, pattern, label) {
  const matches = [...source.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))]
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label} in the base source, found ${matches.length}`)
  }
  return matches[0]
}

const baseLinksPackage = loadModule(
  gitShow('packages/desktop-app-links/index.cjs'),
  'base-desktop-app-links.cjs'
)
const baseDesktopAppLinks = loadModule(
  gitShow('profile-ui/lib/desktopAppLinks.ts'),
  'base-desktopAppLinks.ts',
  { '@clerum/desktop-app-links': baseLinksPackage }
)
const baseRouter = loadModule(
  gitShow('desktop-app/src/evenfireDeepLinkRouter.ts'),
  'base-evenfireDeepLinkRouter.ts'
)

// The profile-ui wrapper applies the rollout gate and a default tenant name before building, so
// it cannot emit empty fields. The raw formula is the `URLSearchParams` block it wraps; its key
// order and prefix are read from the base source so empty-field cases still come from it.
const desktopAppLinksSource = gitShow('profile-ui/lib/desktopAppLinks.ts')
const environmentBlock = matchOnce(
  desktopAppLinksSource,
  /const params = new URLSearchParams\(\{([^}]*)\}\)\s*return `([^`$]*)\$\{params\.toString\(\)\}`/,
  'desktop-environment formula'
)
const environmentKeys = [...environmentBlock[1].matchAll(/(\w+):/g)].map(match => match[1])
const environmentPrefix = environmentBlock[2]
if (environmentKeys.join(',') !== 'externalRestApiBaseUrl,tenantName') {
  throw new Error(`Unexpected desktop-environment keys: ${environmentKeys.join(',')}`)
}

function baseEnvironmentFormula(externalRestApiBaseUrl, tenantName) {
  const values = { externalRestApiBaseUrl, tenantName }
  const params = new URLSearchParams(environmentKeys.map(key => [key, values[key]]))
  return `${environmentPrefix}${params.toString()}`
}

const pageSource = gitShow('profile-ui/app/desktop-setup/page.tsx')
const setupTemplate = matchOnce(
  pageSource,
  /const deepLink = (`evenfire:\/\/desktop-setup\?[^`]*`)/,
  'desktop-setup formula'
)[1]
const emailNormalization = matchOnce(
  pageSource,
  /useMemo\(\s*\(\) =>\s*([\s\S]*?),\s*\[searchParams\]\s*\)/,
  'email normalization'
)[1]
const baseSetupFormula = new Function('email', 'result', `return ${setupTemplate}`)
const baseEmailNormalization = new Function('searchParams', `return ${emailNormalization}`)

function captureThrow(run) {
  try {
    return { value: run() }
  } catch (error) {
    return { throws: error.constructor.name }
  }
}

function routeThroughBaseRouter(rawUrl) {
  const sent = []
  const window = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  }
  const router = baseRouter.createEvenfireDeepLinkRouter({
    appProtocol: baseLinksPackage.SANDBOX_UI_DEEP_LINK_PROTOCOL.replace(/:$/, ''),
    focusMainWindow: () => {},
    getWindow: () => window,
    handleSandboxUiDeepLink: () => false,
    handleGfsResourceDeepLink: () => false,
    isRendererReady: () => true,
    logout: () => Promise.resolve(),
    gfsResourceDeepLinkHost: baseLinksPackage.GFS_RESOURCE_DEEP_LINK_HOST,
    requestMainWindow: () => {},
    sandboxUiDeepLinkHost: baseLinksPackage.SANDBOX_UI_DEEP_LINK_HOST,
    shouldAcceptSandboxUiProtocolLink: () => false,
    shouldAcceptGfsResourceProtocolLink: () => false,
  })
  router.handle(rawUrl)
  const find = channel => sent.find(entry => entry.channel === channel)?.payload ?? null
  return {
    environment: find('auth:desktopEnvironmentSetup'),
    setup: find('auth:desktopSetupToken'),
  }
}

const CORPUS = [
  '',
  ' ',
  'a b',
  '  padded  ',
  '+',
  'a+b',
  '&',
  '=',
  '%',
  '%20',
  "!'()*~",
  '-_.',
  '/?:@',
  'é',
  'ñandú',
  '日本語',
  '😀',
  '𝒳',
  '\u0000',
  '\t\n#',
  'https://api.example.com/base?x=1&y=2#frag',
  'Acme Corp',
  'user.name+tag@example.com',
  'tok+en/with==',
]

const environmentBuilder = []
const setupBuilder = []
// Each corpus value is exercised in either position and against itself; a full cross product
// adds no new encoding behaviour because each field is encoded independently.
const corpusPairs = (fixedFirst, fixedSecond) =>
  CORPUS.flatMap(value => [
    [value, fixedSecond],
    [fixedFirst, value],
    [value, value],
  ])
for (const [first, second] of corpusPairs('https://api.example.com', 'Acme')) {
  environmentBuilder.push({
    externalRestApiBaseUrl: first,
    tenantName: second,
    link: baseEnvironmentFormula(first, second),
  })
}
for (const [email, authorizationToken] of corpusPairs('user@example.com', 'token-1')) {
  setupBuilder.push({
    email,
    authorizationToken,
    ...captureThrow(() => baseSetupFormula(email, { authorizationToken })),
  })
}
for (const [email, authorizationToken] of [
  ['\uD800', 'token'],
  ['user@example.com', '\uDC00'],
  ['a\uD83D', 'b'],
]) {
  setupBuilder.push({
    email,
    authorizationToken,
    ...captureThrow(() => baseSetupFormula(email, { authorizationToken })),
  })
}

// Cross-check: wherever the gated wrapper can emit a link, it must agree with the raw formula.
const originalFlag = process.env.NEXT_PUBLIC_PROFILE_DESKTOP_HANDOFF_ENABLED
process.env.NEXT_PUBLIC_PROFILE_DESKTOP_HANDOFF_ENABLED = 'true'
for (const entry of environmentBuilder) {
  if (!entry.externalRestApiBaseUrl || !entry.tenantName) continue
  const wrapped = baseDesktopAppLinks.buildDesktopEnvironmentLink({
    externalRestApiBaseUrl: entry.externalRestApiBaseUrl,
    rpcProxyBaseUrl: '',
    appName: entry.tenantName,
  })
  if (wrapped !== entry.link) throw new Error(`Formula mismatch for ${JSON.stringify(entry)}`)
}

const profileEnvironmentInputs = [
  { externalRestApiBaseUrl: 'https://api.example.com', rpcProxyBaseUrl: '', appName: '' },
  {
    externalRestApiBaseUrl: 'https://api.example.com/base path?x=1&y=2',
    rpcProxyBaseUrl: 'https://rpc.example.com',
    appName: 'Acme + Co Tenant',
  },
  { externalRestApiBaseUrl: '', rpcProxyBaseUrl: 'https://rpc.example.com', appName: 'Acme' },
]
const profileEnvironment = profileEnvironmentInputs.map(environment => ({
  environment,
  link: baseDesktopAppLinks.buildDesktopEnvironmentLink(environment),
}))
if (originalFlag === undefined) delete process.env.NEXT_PUBLIC_PROFILE_DESKTOP_HANDOFF_ENABLED
else process.env.NEXT_PUBLIC_PROFILE_DESKTOP_HANDOFF_ENABLED = originalFlag

const profileSetupInputs = [
  { emailParam: '  User.Name+Tag@Example.COM  ', authorizationToken: 'ab+cd/ef==' },
  { emailParam: 'ÉLÈVE@Example.com', authorizationToken: '+/=+/= tok' },
]
const profileSetup = profileSetupInputs.map(({ emailParam, authorizationToken }) => {
  const email = baseEmailNormalization(new URLSearchParams({ email: emailParam }))
  return { emailParam, authorizationToken, href: baseSetupFormula(email, { authorizationToken }) }
})

const routerUrls = [
  'evenfire://desktop-environment?externalRestApiBaseUrl=https%3A%2F%2Fapi.example.test&rpcProxyBaseUrl=https%3A%2F%2Frpc.example.test&tenantName=Acme',
  'evenfire://desktop-setup?email=user%40example.test&authorizationToken=token-1',
  'evenfire://desktop-setup?email=one%40example.test&authorizationToken=token-1',
  'evenfire://desktop-environment?externalRestApiBaseUrl=https%3A%2F%2Fapi.example.test&appName=Env',
  'evenfire://desktop-setup?email=startup%40example.test&authorizationToken=startup-token',
  'evenfire://desktop-environment?externalRestApiBaseUrl=https%3A%2F%2Fapi.example.test&appName=Second',
  'not a url',
  'clerum://desktop-setup?email=user%40example.test&authorizationToken=token',
  'evenfire://unknown?email=user%40example.test&authorizationToken=token',
  'evenfire://app/evenfire/example?path=%2Finbox',
  'evenfire://desktop-environment',
  'evenfire://desktop-environment?externalRestApiBaseUrl=',
  'evenfire://desktop-setup?authorizationToken=token-1',
  'evenfire://desktop-setup?email=user%40example.test',
  'evenfire://desktop-setup?email=&authorizationToken=token-1',
  'evenfire://desktop-setup?email=user%40example.test&authorizationToken=',
  'evenfire://DESKTOP-SETUP?email=user%40example.test&authorizationToken=token-1',
  'evenfire://Desktop-Environment?externalRestApiBaseUrl=https%3A%2F%2Fapi.example.test&tenantName=Acme',
  'EVENFIRE://desktop-setup?email=user%40example.test&authorizationToken=token-1',
  'evenfire://desktop-setup:80?email=user%40example.test&authorizationToken=token-1',
  'evenfire://desktop-environment:8443?externalRestApiBaseUrl=https%3A%2F%2Fapi.example.test',
  'evenfire://u:p@desktop-setup?email=user%40example.test&authorizationToken=token-1',
  'evenfire://u:p@desktop-environment?externalRestApiBaseUrl=https%3A%2F%2Fapi.example.test',
  'evenfire://desktop-setup/extra?email=user%40example.test&authorizationToken=token-1',
  'evenfire://desktop-environment/extra/path?externalRestApiBaseUrl=https%3A%2F%2Fapi.example.test',
  'evenfire://desktop-setup?email=user%40example.test&authorizationToken=token-1#h',
  'evenfire://desktop-environment?externalRestApiBaseUrl=https%3A%2F%2Fapi.example.test#h',
  'evenfire://desktop-environment?externalRestApiBaseUrl=x&tenantName=A&appName=B',
  'evenfire://desktop-environment?externalRestApiBaseUrl=x&appName=B&tenantName=A',
  'evenfire://desktop-environment?externalRestApiBaseUrl=x&tenantName=&appName=B',
  'evenfire://desktop-environment?externalRestApiBaseUrl=x',
  'evenfire://desktop-environment?externalRestApiBaseUrl=&externalRestApiBaseUrl=x',
  'evenfire://desktop-environment?externalRestApiBaseUrl=x&externalRestApiBaseUrl=y',
  'evenfire://desktop-setup?email=a%40b&email=c%40d&authorizationToken=t1&authorizationToken=t2',
  'evenfire://desktop-setup?email=&email=a%40b&authorizationToken=t',
  'evenfire://desktop-setup?email=user%40example.test&authorizationToken=token-1&unknown=1',
  'evenfire://desktop-environment?externalRestApiBaseUrl=x&unknown=1',
  'evenfire://desktop-setup?email=a+b%40c&authorizationToken=t+u%2Bv',
  'evenfire://desktop-setupx?email=user%40example.test&authorizationToken=token-1',
  'evenfire://desktop-environment.evil?externalRestApiBaseUrl=x',
  'evenfire://desktop-setup.?email=user%40example.test&authorizationToken=token-1',
  'https://desktop-setup?email=user%40example.test&authorizationToken=token-1',
  'evenfire:desktop-setup?email=user%40example.test&authorizationToken=token-1',
  'evenfire:///desktop-setup?email=user%40example.test&authorizationToken=token-1',
  'evenfire://logout',
  'evenfire://files?uri=gfs%3A%2F%2Fmain%2F0123456789abcdef0123456789abcdef',
  ...environmentBuilder.map(entry => entry.link),
  ...setupBuilder.filter(entry => 'value' in entry).map(entry => entry.value),
]
const routerParse = [...new Set(routerUrls)].map(url => ({ url, ...routeThroughBaseRouter(url) }))

const provenance =
  `Generated by packages/desktop-app-links/generate-desktop-handoff-golden.cjs at ${BASE_SHA}: ` +
  'executes the base profile-ui builders (lib/desktopAppLinks.ts, app/desktop-setup/page.tsx) ' +
  'and drives the base desktop-app evenfireDeepLinkRouter with a ready fake window.'

fs.writeFileSync(
  PACKAGE_GOLDEN,
  `${JSON.stringify({ provenance, environmentBuilder, setupBuilder, routerParse }, null, 2)}\n`
)
fs.writeFileSync(
  PROFILE_GOLDEN,
  `${JSON.stringify({ provenance, environment: profileEnvironment, setup: profileSetup }, null, 2)}\n`
)
console.log(
  `wrote ${environmentBuilder.length} environment, ${setupBuilder.length} setup, ` +
    `${routerParse.length} router cases; ${profileEnvironment.length + profileSetup.length} profile-ui cases`
)
