'use strict'

const store = require('../dev-store.cjs')
const action = process.argv[2] === 'verify'
  ? store.readDevVerifierMaterial
  : store.loadOrCreateDevSigningMaterial
let evidence
try {
  const accepted = action('rpc', process.argv[3])
  evidence = { outcome: 'accepted', fingerprint: accepted.fingerprint }
} catch (failure) {
  evidence = { outcome: 'rejected', reason: failure.reason, code: failure.code }
}
process.stdout.write(JSON.stringify(evidence))
