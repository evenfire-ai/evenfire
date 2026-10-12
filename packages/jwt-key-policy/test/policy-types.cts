import policy = require('@clerum/jwt-key-policy')

declare const configuredPem: string
const material: policy.SigningMaterial = policy.parseSigningMaterial(configuredPem, 'CJS_TYPE_CONTRACT')
const verifier: policy.VerifierMaterial = policy.parseVerifierMaterial(material.publicPem, 'CJS_TYPE_CONTRACT', {
  origin: 'store', fingerprints: new Set<string>(),
})
const identity: string = policy.publicKeyPemFingerprint(verifier.publicPem)
const failure: policy.JwtKeyMaterialError = new policy.JwtKeyMaterialError('CJS_TYPE_CONTRACT', 'invalid_pem')
const maximum: 65536 = policy.MAX_PEM_MATERIAL_BYTES
void [identity, failure, maximum]
