'use strict'

const { spawn, spawnSync } = require('node:child_process')
const { generateKeyPairSync } = require('node:crypto')

const PUBLIC_KEYS = Object.freeze({
  rpc: `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArCIYGHehMPpGKePxaKQa
rDX5yrzifU5i4fzpI3EtkKSU6s5ug7EkKxc2DdMekoqXe9vr7qKyVwiilUIusXLX
iW7KPMJlD/Fd5Bo7Qxt69wYiL5I4K37eDgCN6D3LduHySEnkhdI0GDpB4LM2ASOx
QkEabepekZTMQyExmCIn/dHJ15B+4A9tiiephYOQNr3GcnW9eDomMt6NJLypikbr
xJO6O7Ar0G+raTbflth8EQzWnGF+WgQW4iiM3wsFhpaE0mUlEbMGDGTMAZy1KfxA
RRu+QZm3Lo+5AiCaHkijDCglHsXLhqsYi2AdRiavD1Gk9LKP/ztKw7q/D6fYFzmO
QwIDAQAB
-----END PUBLIC KEY-----`,
  session: `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwrZja9jS/r+e2YF1FqEQ
NMLsnffebYzXrZOb7uPMKhXBoKjJh/taR9v3kX2srfVtoikcKKr0Sfa7MMSLnZWd
ETmi7MvbeVD3HpsXpVejmw9D0zeYYSGZplLF/b6HY0Lz2XVM8WdJl3Dicyu+SZbZ
xeHZtMCMTTjvmoI/IYmmO4N3Pgz/SGi7V3EiwoALODP4OWDvd/1xFUiMPslLPgZU
EczQ5tIpAaD4e0om3gUNsyOKYc5igojm6ooVqI9T3TUGBVJ0uSZB7ntWxKQ39WyI
aH+oqnwDGbDcDLQ/wTuBtcn4brWTDgW1xA73HVBSImGFvvHCWBiQBiI1nvovUP0u
WQIDAQAB
-----END PUBLIC KEY-----`,
  admin: `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsrDvCYzx96OLO2qv37sb
ZZvCuguzR+cWxwOYpx61AP+GL9lxV60FJJJKjtRhO/Ivm6koOzgVyln12BphipB0
nJs9fdLzArpxeiuKaligrkL9c/2TwljmRpZagZzZKKAQR827b0WRz9qB63npbjMv
/7L1GNxcMtLne2rTAYU3gez0I7phwKAYH/zY+T5iH2l0qpt/4Iy6t7pWOQ0qgrKe
JPFe5qYWK3c8BWGnWJkhoLCNUCTnUa1yGaIHuRwKzwPH9b476rS72NGqGC4xRZXA
einOdIz3PympLN0HyIjSsPBUlhewILwD5jQBC6DxYeXLQJY0UHWRLrOqQRkJsep6
yQIDAQAB
-----END PUBLIC KEY-----`,
})

function pem(key, type) {
  return key.export({ type, format: 'pem' }).toString().trim()
}

let shared
function fixtures() {
  if (!shared) {
    shared = Object.fromEntries([2048, 4096, 1024].map(bits => [bits, generateKeyPairSync('rsa', { modulusLength: bits })]))
    shared.decoy = generateKeyPairSync('rsa', { modulusLength: 2048 })
  }
  return shared
}

function encodings(value) {
  return {
    lf: value,
    crlf: value.replace(/\n/g, '\r\n'),
    cr: value.replace(/\n/g, '\r'),
    escapedLf: value.replace(/\n/g, '\\n'),
    escapedCrlf: value.replace(/\n/g, '\\r\\n'),
    escapedCr: value.replace(/\n/g, '\\r'),
    bom: '\ufeff' + value,
    outsideWhitespace: '\t\n ' + value + ' \n\t',
    beginWhitespace: value.replace(/^(-----BEGIN [^-]+-----)/, '$1 \t'),
    endWhitespace: value.replace(/(-----END [^-]+-----)$/, '$1 \t'),
    bodyWhitespace: value.split('\n').map(line => line.startsWith('-----') ? line : line + ' \t').join('\n'),
    wrapped: 'Key material for the local contract fixture\n' + value + '\nEnd of contract fixture',
  }
}

function certificate(key) {
  const result = spawnSync('openssl', [
    'req', '-new', '-x509', '-key', '/dev/stdin', '-subj', '/CN=jwt-key-policy-contract',
    '-days', '1', '-batch', '-quiet', '-config', '/dev/null',
  ], { input: pem(key, 'pkcs8'), encoding: 'utf8', timeout: 10000, maxBuffer: 65536 })
  if (result.status !== 0) throw new Error('Generated certificate fixture failed')
  return result.stdout.trim()
}

function certificateWithPublic(publicPem) {
  // A certificate is a configured public-key carrier, not a CA/trust assertion.
  // All private bytes travel through an anonymous pipe and are never persisted.
  return new Promise((resolve, reject) => {
    const child = spawn('openssl', [
      'x509', '-new', '-force_pubkey', '/dev/stdin', '-signkey', '/dev/fd/3',
      '-subj', '/CN=jwt-key-policy-public-contract', '-days', '1',
    ], { stdio: ['pipe', 'pipe', 'ignore', 'pipe'], timeout: 10000 })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { output += chunk })
    child.on('error', () => reject(new Error('Generated public certificate fixture failed')))
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error('Generated public certificate fixture failed')))
    child.stdin.on('error', () => {})
    child.stdio[3].on('error', () => {})
    child.stdin.end(publicPem)
    child.stdio[3].end(pem(fixtures()[2048].privateKey, 'pkcs8'))
  })
}

module.exports = { PUBLIC_KEYS, pem, fixtures, encodings, certificate, certificateWithPublic }
