// Development certificates stay in memory; never log or persist this result.
import { spawnSync } from 'node:child_process'
import { createPrivateKey, X509Certificate } from 'node:crypto'
import { isIP } from 'node:net'

export function requireFixtureOpenSsl() {
  const version = spawnSync('openssl', ['version'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 4096, shell: false,
  })
  // LibreSSL treats -keyout - as a literal file, violating the memory-only fixture.
  if (version.status !== 0 || !/^OpenSSL /.test(version.stdout ?? '')) {
    throw new Error('fixture_openssl_required: put OpenSSL on PATH; LibreSSL is unsupported')
  }
}

export function createFixtureTls(hostname) {
  const ip = typeof hostname === 'string' && isIP(hostname)
  if (!ip && (typeof hostname !== 'string' ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname))) {
    throw new Error('invalid_fixture_hostname')
  }
  requireFixtureOpenSsl()
  // Direct argv avoids a shell and Node's socket-backed stdin on Linux.
  // OpenSSL writes both PEM blocks to captured stdout; no key file is created.
  const generated = spawnSync('openssl', [
    'req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '-',
    '-days', '1', '-subj', `/CN=${hostname}`,
    '-addext', `subjectAltName=${ip ? 'IP' : 'DNS'}:${hostname}`,
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign',
  ], { encoding: 'utf8', timeout: 15000, maxBuffer: 1048576, shell: false })
  try {
    if (generated.status !== 0) throw new Error()
    const pem = /-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY|CERTIFICATE)-----[\s\S]+?-----END \1-----/g
    const blocks = generated.stdout.match(pem) ?? []
    if (blocks.length !== 2 || generated.stdout.replace(pem, '').trim()) throw new Error()
    const cert = blocks.find(block => block.startsWith('-----BEGIN CERTIFICATE-----'))
    const key = blocks.find(block => block !== cert)
    if (!key || !cert) throw new Error()
    const certificate = new X509Certificate(cert)
    if (!certificate.checkPrivateKey(createPrivateKey(key)) ||
      !(ip ? certificate.checkIP(hostname) : certificate.checkHost(hostname))) throw new Error()
    return { key, cert }
  } catch {
    // Do not expose captured output or private material in error diagnostics.
    throw new Error('fixture_certificate_generation_failed')
  }
}

if (import.meta.main) requireFixtureOpenSsl()
