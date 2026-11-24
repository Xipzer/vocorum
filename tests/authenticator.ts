// A software passkey (ES256, "none" attestation, user verified) for tests:
// produces the same JSON a browser's navigator.credentials returns.

import crypto from 'node:crypto'
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor> | { [key: string]: Cbor }

function head(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length])
  if (length < 256) return Buffer.from([(major << 5) | 24, length])
  return Buffer.from([(major << 5) | 25, length >> 8, length & 0xff])
}

function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)])
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)])
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value)
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)])])
}

const b64url = (data: Buffer | Uint8Array) => Buffer.from(data).toString('base64url')
const sha256 = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest()

export class SoftAuthenticator {
  private key = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  readonly credentialId = crypto.randomBytes(16)
  private counter = 0

  register(options: PublicKeyCredentialCreationOptionsJSON, origin: string): RegistrationResponseJSON {
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }))
    const jwk = this.key.publicKey.export({ format: 'jwk' })
    const cose = new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ])
    const counter = Buffer.alloc(4)
    counter.writeUInt32BE(this.counter)
    const idLength = Buffer.alloc(2)
    idLength.writeUInt16BE(this.credentialId.length)
    const authData = Buffer.concat([sha256(options.rp.id!), Buffer.from([0x45]), counter, Buffer.alloc(16), idLength, this.credentialId, cbor(cose)])
    const attestation = cbor({ fmt: 'none', attStmt: {}, authData })
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: 'public-key',
      response: { clientDataJSON: b64url(clientData), attestationObject: b64url(attestation), transports: ['internal'] },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    }
  }

  authenticate(options: PublicKeyCredentialRequestOptionsJSON, origin: string): AuthenticationResponseJSON {
    this.counter++
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }))
    const counter = Buffer.alloc(4)
    counter.writeUInt32BE(this.counter)
    const authData = Buffer.concat([sha256(options.rpId!), Buffer.from([0x05]), counter])
    const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.key.privateKey)
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: 'public-key',
      response: { clientDataJSON: b64url(clientData), authenticatorData: b64url(authData), signature: b64url(signature) },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    }
  }
}
