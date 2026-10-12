'use strict'

const { createPublicKey, generateKeyPairSync, sign } = require('node:crypto')

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
    shared = Object.fromEntries(
      [2048, 4096, 1024].map(bits => [bits, generateKeyPairSync('rsa', { modulusLength: bits })])
    )
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
    bodyWhitespace: value
      .split('\n')
      .map(line => (line.startsWith('-----') ? line : line + ' \t'))
      .join('\n'),
    wrapped: 'Key material for the local contract fixture\n' + value + '\nEnd of contract fixture',
  }
}

function der(tag, ...values) {
  const content = Buffer.concat(values)
  const length = content.length
  let encodedLength
  if (length < 0x80) {
    encodedLength = Buffer.from([length])
  } else {
    const bytes = []
    for (let value = length; value > 0; value >>= 8) bytes.unshift(value & 0xff)
    encodedLength = Buffer.from([0x80 | bytes.length, ...bytes])
  }
  return Buffer.concat([Buffer.from([tag]), encodedLength, content])
}

function algorithmIdentifier() {
  return Buffer.from('300d06092a864886f70d01010b0500', 'hex')
}

function distinguishedName() {
  const commonName = Buffer.from('jwt-key-policy-contract')
  return der(0x30, der(0x31, der(0x30, Buffer.from('0603550403', 'hex'), der(0x0c, commonName))))
}

function utcTime(date) {
  const twoDigits = value => String(value).padStart(2, '0')
  return Buffer.from(
    twoDigits(date.getUTCFullYear() % 100) +
      twoDigits(date.getUTCMonth() + 1) +
      twoDigits(date.getUTCDate()) +
      twoDigits(date.getUTCHours()) +
      twoDigits(date.getUTCMinutes()) +
      twoDigits(date.getUTCSeconds()) +
      'Z'
  )
}

function certificate(signingKey, carriedPublicKey = createPublicKey(signingKey)) {
  const now = Date.now()
  const name = distinguishedName()
  const validity = der(
    0x30,
    der(0x17, utcTime(new Date(now - 60 * 1000))),
    der(0x17, utcTime(new Date(now + 24 * 60 * 60 * 1000)))
  )
  const subjectPublicKeyInfo = carriedPublicKey.export({ type: 'spki', format: 'der' })
  const algorithm = algorithmIdentifier()
  const tbsCertificate = der(
    0x30,
    der(0x02, Buffer.from([1])),
    algorithm,
    name,
    validity,
    name,
    subjectPublicKeyInfo
  )
  const signature = sign('sha256', tbsCertificate, signingKey)
  const certificateDer = der(
    0x30,
    tbsCertificate,
    algorithm,
    der(0x03, Buffer.from([0]), signature)
  )
  const body = certificateDer
    .toString('base64')
    .match(/.{1,64}/g)
    .join('\n')
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`
}

async function certificateWithPublic(publicPem) {
  // A certificate is a configured public-key carrier, not a CA/trust assertion.
  // The historical public key is carried by a fresh fixture signature.
  return certificate(fixtures()[2048].privateKey, createPublicKey(publicPem))
}

module.exports = { PUBLIC_KEYS, pem, fixtures, encodings, certificate, certificateWithPublic }
