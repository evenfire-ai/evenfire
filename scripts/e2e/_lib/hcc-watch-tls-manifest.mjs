// Public configuration and an ephemeral test key go directly to kubectl stdin.
// Never redirect this program's output to an artifact or log.
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [name, namespace, run, proxySource] = process.argv.slice(2)
for (const value of [name, namespace, run])
  if (!/^[a-z0-9][a-z0-9.-]{0,62}$/.test(value ?? '')) throw new Error('invalid_fixture_identity')
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})
const signed = spawnSync(
  'openssl',
  [
    'req',
    '-new',
    '-x509',
    '-key',
    '/dev/stdin',
    '-days',
    '1',
    '-subj',
    `/CN=${name}.${namespace}.svc`,
    '-addext',
    `subjectAltName=DNS:${name}.${namespace}.svc`,
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign',
  ],
  { input: privateKey, encoding: 'utf8', timeout: 15000, maxBuffer: 1048576 }
)
if (signed.status !== 0 || !signed.stdout.includes('BEGIN CERTIFICATE'))
  throw new Error('fixture_certificate_generation_failed')
const cert = signed.stdout
const labels = { 'e2e.clerum.io/suite': 'hcc-watch-churn', 'e2e.clerum.io/run': run }
const metadata = { name, namespace, labels }
const config = {
  apiVersion: 'v1',
  kind: 'Config',
  clusters: [
    {
      name: 'fixture',
      cluster: {
        server: `https://${name}.${namespace}.svc:443`,
        'certificate-authority-data': Buffer.from(cert).toString('base64'),
      },
    },
  ],
  users: [
    {
      name: 'inClusterUser',
      user: {
        'auth-provider': {
          name: 'tokenFile',
          config: {
            tokenFile: '/var/run/secrets/kubernetes.io/serviceaccount/token',
          },
        },
      },
    },
  ],
  contexts: [
    { name: 'fixture', context: { cluster: 'fixture', user: 'inClusterUser', namespace } },
  ],
  'current-context': 'fixture',
}
process.stdout.write(
  JSON.stringify({
    apiVersion: 'v1',
    kind: 'List',
    items: [
      {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata,
        type: 'kubernetes.io/tls',
        stringData: { 'tls.key': privateKey, 'tls.crt': cert },
      },
      {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata,
        data: {
          'config.json': JSON.stringify(config),
          'proxy.mjs': readFileSync(proxySource, 'utf8'),
          'hcc-watch-bookmarks.mjs': readFileSync(
            join(dirname(proxySource), 'hcc-watch-bookmarks.mjs'),
            'utf8'
          ),
        },
      },
    ],
  })
)
