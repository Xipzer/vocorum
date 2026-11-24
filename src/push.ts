// Web Push from the hub, with no library: VAPID (RFC 8292) to identify the hub
// to the browser's push service, and aes128gcm payload encryption (RFC 8291),
// so the push service (Apple, Google, Mozilla) relays only ciphertext. It still
// sees timing, size and which device is notified.

import crypto from 'node:crypto'
import fs from 'node:fs'

const b64u = (buf: Buffer | Uint8Array) => Buffer.from(buf).toString('base64url')

export type VapidKeys = { publicKey: string; privateKey: string }
export type PushTarget = { endpoint: string; p256dh: string; auth: string }

// The push services browsers use. Endpoints elsewhere are refused, so a device
// cannot point the hub's outbound requests at an arbitrary host.
const PUSH_HOSTS = ['web.push.apple.com', 'fcm.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com']

export function isPushEndpoint(url: URL) {
  return url.protocol === 'https:' && PUSH_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
}

// Created once, 0600, next to the hub's other secrets.
export function loadVapidKeys(file: string): VapidKeys {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as VapidKeys
  const ecdh = crypto.createECDH('prime256v1')
  ecdh.generateKeys()
  const keys = { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) }
  fs.writeFileSync(file, `${JSON.stringify(keys)}\n`, { mode: 0o600 })
  return keys
}

function signingKey({ publicKey, privateKey }: VapidKeys) {
  const point = Buffer.from(publicKey, 'base64url')
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: privateKey, x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33, 65)) }, format: 'jwk' })
}

export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()) {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })))
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: signingKey(keys), dsaEncoding: 'ieee-p1363' })
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey}`
}

const RECORD_SIZE = 4096

// RFC 8291 section 3.4. salt and serverPrivateKey are only passed by tests.
export function encryptPayload(plaintext: Buffer, target: { p256dh: string; auth: string }, fixed: { salt?: Buffer; serverPrivateKey?: Buffer } = {}): Buffer {
  const uaPublic = Buffer.from(target.p256dh, 'base64url')
  const authSecret = Buffer.from(target.auth, 'base64url')
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new Error('Bad push subscription keys')
  const ecdh = crypto.createECDH('prime256v1')
  if (fixed.serverPrivateKey) ecdh.setPrivateKey(fixed.serverPrivateKey)
  else ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  // Throws for a point that is not on the curve.
  const shared = ecdh.computeSecret(uaPublic)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32))
  const salt = fixed.salt ?? crypto.randomBytes(16)
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  if (plaintext.length + 1 + 16 > RECORD_SIZE - 86) throw new Error('Push payload too large')
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce)
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header.writeUInt8(asPublic.length, 20)
  return Buffer.concat([header, asPublic, body])
}

export type PushResult = 'sent' | 'gone' | 'failed'

export async function sendPush(target: PushTarget, payload: unknown, { keys, subject, ttl = 24 * 3600, urgency = 'high', topic }: { keys: VapidKeys; subject: string; ttl?: number; urgency?: 'normal' | 'high'; topic?: string }): Promise<PushResult> {
  const body = encryptPayload(Buffer.from(JSON.stringify(payload)), target)
  const response = await fetch(target.endpoint, {
    method: 'POST',
    headers: {
      authorization: vapidAuthorization(target.endpoint, keys, subject),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(ttl),
      urgency,
      // Replaces an undelivered push with the same topic (one per channel).
      ...(topic && { topic: topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) }),
    },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  }).catch(() => null)
  if (!response) return 'failed'
  await response.arrayBuffer().catch(() => {})
  if (response.status === 404 || response.status === 410) return 'gone'
  return response.ok ? 'sent' : 'failed'
}
