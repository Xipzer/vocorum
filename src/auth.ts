// Human auth, in layers (plans/private-interface.md):
// 1. Tailscale ACL (outside the hub).
// 2. Tailscale-User-Login header must equal the configured login. The hub
//    listens on loopback only, so only `tailscale serve` or local processes reach it.
// 3. Per-device passkey (WebAuthn). A device enrolls with a one-time pairing
//    code from `hub devices add`; login sets a 30-day HttpOnly session cookie.
// 4. CSRF: SameSite=Strict cookie + Origin check on mutating routes and WS upgrades.
// Apps (desktop, iPhone) cannot use WebAuthn in their webview: they pair a
// device key (Ed25519, in the OS keychain) and sign a challenge for a 12-hour
// bearer token. A bearer request carries nothing ambient, so it needs no
// Origin check, and cookies are ignored on it.

import crypto from 'node:crypto'
import type http from 'node:http'
import type { AuthenticationResponseJSON, AuthenticatorTransportFuture, RegistrationResponseJSON } from '@simplewebauthn/server'
import type { DeviceRow, HubStore } from './store.ts'

// __Host-: only ever sent back to this exact host, over HTTPS, for path /.
export const SESSION_COOKIE = '__Host-hub_session'

const SESSION_TTL_MS = 30 * 24 * 3600_000
const CHALLENGE_TTL_MS = 5 * 60_000
const APP_SESSION_TTL_MS = 12 * 3600_000
// What an app signs: this prefix, the challenge and its key id, one per line.
export const APP_LOGIN_PREFIX = 'vocorum-app-login'
export const APP_APPROVE_PREFIX = 'vocorum-app-approve'
// Wrong codes per peer (address plus verified Tailscale login). No global
// lock: one peer must never be able to stop everyone else from pairing, and
// single-use ~49-bit codes that expire make guessing hopeless anyway.
const PAIRING_FAILURE_LIMIT = 10
const PAIRING_FAILURE_WINDOW_MS = 10 * 60_000

// Loaded on first use: it is ~25 MB of resident memory the idle hub does not need.
const webauthn = () => import('@simplewebauthn/server')

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

type Challenge = { challenge: string; kind: 'register' | 'login' | 'app'; origin: string; codeHash?: string; deviceName?: string; userId?: string | null; expiresAt: number }

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    // A malformed value elsewhere (planted from another port) must not break the
    // request, and the first cookie of a name wins, so a planted duplicate cannot shadow ours.
    let value = part.slice(index + 1).trim()
    try {
      value = decodeURIComponent(value)
    } catch {}
    cookies[part.slice(0, index).trim()] ??= value
  }
  return cookies
}

// An approval key as stored: an uncompressed P-256 point (Secure Enclave), or
// the DER SubjectPublicKeyInfo of an RSA key of 2048 to 4096 bits (Windows Hello).
function approvalPublicKey(raw: Buffer): crypto.KeyObject {
  if (raw.length === 65 && raw[0] === 4) {
    return crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' })
  }
  const key = crypto.createPublicKey({ key: raw, format: 'der', type: 'spki' })
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0
  if (key.asymmetricKeyType !== 'rsa' || bits < 2048 || bits > 4096) throw new Error('not an RSA key of 2048 to 4096 bits')
  return key
}

function parseApprovalKey(value: unknown): Buffer {
  const raw = typeof value === 'string' && /^[A-Za-z0-9_-]{87,1024}$/.test(value) ? Buffer.from(value, 'base64url') : null
  try {
    if (raw) {
      approvalPublicKey(raw)
      return raw
    }
  } catch {}
  throw new HttpError(400, 'approvalKey must be an uncompressed P-256 key (65 bytes) or an RSA SubjectPublicKeyInfo of 2048 to 4096 bits, base64url')
}

export class HubAuth {
  private challenges = new Map<string, Challenge>()
  private pairingFailures = new Map<string, number[]>()

  constructor(
    private readonly store: HubStore,
    private readonly options: {
      tailscaleLogins: () => Map<string, string>
      allowedOrigins: () => string[]
      rpName: string
    },
  ) {}

  // Layer 2. Applies to every human route (PWA shell, /client/*, WS): the
  // proxy's identity header must name an allowed login. Returns that login.
  checkTailscale(req: http.IncomingMessage): string {
    const login = req.headers['tailscale-user-login']
    if (typeof login !== 'string' || !this.options.tailscaleLogins().has(login)) {
      throw new HttpError(403, 'Forbidden: this hub is only reachable through tailscale serve by its people')
    }
    return login
  }

  // Layer 4: mutating requests and WS upgrades must come from the hub's own origin.
  checkOrigin(req: http.IncomingMessage): string {
    const origin = req.headers.origin
    if (typeof origin !== 'string' || !this.options.allowedOrigins().includes(origin)) {
      throw new HttpError(403, 'Forbidden: bad origin')
    }
    return origin
  }

  // Any Authorization header (a well-formed bearer or not): then cookies do not count.
  usesBearer(req: http.IncomingMessage): boolean {
    return req.headers.authorization !== undefined
  }

  private bearerToken(req: http.IncomingMessage): string | null {
    return /^bearer\s+([A-Za-z0-9_-]{20,128})\s*$/i.exec(req.headers.authorization ?? '')?.[1] ?? null
  }

  // Layer 4 for every mutating request and WS upgrade: the Origin check, unless it is a bearer request.
  checkCsrf(req: http.IncomingMessage) {
    if (!this.usesBearer(req)) this.checkOrigin(req)
  }

  // The session a request carries (for connections that must end with it).
  session(req: http.IncomingMessage): { token: string; kind: 'bearer' | 'cookie' } | null {
    const token = this.usesBearer(req) ? this.bearerToken(req) : parseCookies(req.headers.cookie)[SESSION_COOKIE]
    return token ? { token, kind: this.usesBearer(req) ? 'bearer' : 'cookie' } : null
  }

  async device(req: http.IncomingMessage): Promise<DeviceRow | null> {
    if (this.usesBearer(req)) {
      const token = this.bearerToken(req)
      return token ? this.store.sessionDevice(token, 'bearer') : null
    }
    // Only the __Host- cookie: an unprefixed one can be planted from another port.
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
    return token ? this.store.sessionDevice(token, 'cookie') : null
  }

  async requireDevice(req: http.IncomingMessage): Promise<DeviceRow> {
    const device = await this.device(req)
    if (!device) throw new HttpError(401, 'Not signed in')
    return device
  }

  sessionCookie(token: string): string {
    return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
  }

  clearCookie(): string {
    return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`
  }

  private putChallenge(challenge: Challenge): string {
    const now = Date.now()
    for (const [id, entry] of this.challenges) if (entry.expiresAt < now) this.challenges.delete(id)
    const id = crypto.randomBytes(16).toString('base64url')
    this.challenges.set(id, challenge)
    return id
  }

  private takeChallenge(id: unknown, kind: Challenge['kind'], origin: string): Challenge {
    const challenge = typeof id === 'string' ? this.challenges.get(id) : undefined
    if (typeof id === 'string') this.challenges.delete(id)
    if (!challenge || challenge.kind !== kind || challenge.expiresAt < Date.now() || challenge.origin !== origin) {
      throw new HttpError(400, 'Challenge expired, try again')
    }
    return challenge
  }

  // Before any look at a pairing code: a locked-out peer learns nothing about codes.
  checkPairingLock(peer: string) {
    if (this.pairingLocked(peer)) throw new HttpError(429, 'Too many wrong pairing codes. Wait 10 minutes.')
  }

  // One peer guessing codes cannot lock everyone else out of pairing.
  private pairingLocked(peer: string): boolean {
    const since = Date.now() - PAIRING_FAILURE_WINDOW_MS
    for (const [key, times] of this.pairingFailures) {
      const recent = times.filter((at) => at > since)
      if (recent.length) this.pairingFailures.set(key, recent)
      else this.pairingFailures.delete(key)
    }
    return (this.pairingFailures.get(peer)?.length ?? 0) >= PAIRING_FAILURE_LIMIT
  }

  // POST /client/auth/register/options {code}
  async registrationOptions(origin: string, body: { code?: unknown }, peer = '') {
    if (this.pairingLocked(peer)) throw new HttpError(429, 'Too many wrong pairing codes. Wait 10 minutes.')
    const pairing = typeof body.code === 'string' ? await this.store.findPairing(body.code) : null
    if (!pairing) {
      this.noteWrongCode(peer)
      throw new HttpError(403, 'Unknown or expired pairing code')
    }
    const options = await (await webauthn()).generateRegistrationOptions({
      rpName: this.options.rpName,
      rpID: new URL(origin).hostname,
      userName: `${pairing.userId ?? 'owner'} (${pairing.deviceName})`,
      userDisplayName: pairing.deviceName,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    })
    const challengeId = this.putChallenge({
      challenge: options.challenge,
      kind: 'register',
      origin,
      codeHash: pairing.codeHash,
      deviceName: pairing.deviceName,
      userId: pairing.userId,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    })
    return { challengeId, options }
  }

  // POST /client/auth/register/verify {challengeId, response}
  async register(origin: string, body: { challengeId?: unknown; response?: unknown }) {
    const challenge = this.takeChallenge(body.challengeId, 'register', origin)
    const verification = await (await webauthn()).verifyRegistrationResponse({
      response: body.response as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: new URL(origin).hostname,
      requireUserVerification: true,
    }).catch((error: Error) => {
      throw new HttpError(400, `Passkey rejected: ${error.message}`)
    })
    if (!verification.verified || !verification.registrationInfo) throw new HttpError(400, 'Passkey rejected')
    // Single use: a second enrollment with the same code fails here.
    if (!challenge.codeHash || !(await this.store.consumePairing(challenge.codeHash))) throw new HttpError(403, 'Pairing code already used or expired')
    const device = await this.store.createDevice(challenge.deviceName ?? 'device', challenge.userId ?? null)
    const { credential } = verification.registrationInfo
    await this.store.addCredential({ id: credential.id, deviceId: device.id, publicKey: credential.publicKey, counter: credential.counter, transports: credential.transports ?? [] })
    const session = await this.store.createSession(device.id, SESSION_TTL_MS)
    return { device, cookie: this.sessionCookie(session.token) }
  }

  // POST /client/auth/login/options
  async loginOptions(origin: string) {
    const options = await (await webauthn()).generateAuthenticationOptions({ rpID: new URL(origin).hostname, userVerification: 'required', allowCredentials: [] })
    const challengeId = this.putChallenge({ challenge: options.challenge, kind: 'login', origin, expiresAt: Date.now() + CHALLENGE_TTL_MS })
    return { challengeId, options }
  }

  // POST /client/auth/login/verify {challengeId, response}
  async login(origin: string, body: { challengeId?: unknown; response?: unknown }) {
    const challenge = this.takeChallenge(body.challengeId, 'login', origin)
    const response = body.response as AuthenticationResponseJSON
    const credential = typeof response?.id === 'string' ? await this.store.getCredential(response.id) : null
    const device = credential ? await this.store.getDevice(credential.deviceId) : null
    if (!credential || !device || device.revokedAt) throw new HttpError(403, 'This passkey is not enrolled or its device was revoked')
    const verification = await (await webauthn()).verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: new URL(origin).hostname,
      credential: { id: credential.id, publicKey: credential.publicKey as Uint8Array<ArrayBuffer>, counter: credential.counter, transports: credential.transports as AuthenticatorTransportFuture[] },
      requireUserVerification: true,
    }).catch((error: Error) => {
      throw new HttpError(400, `Passkey rejected: ${error.message}`)
    })
    if (!verification.verified) throw new HttpError(403, 'Passkey rejected')
    await this.store.updateCredentialCounter(credential.id, verification.authenticationInfo.newCounter)
    const session = await this.store.createSession(device.id, SESSION_TTL_MS)
    return { device, cookie: this.sessionCookie(session.token) }
  }

  async logout(req: http.IncomingMessage) {
    const token = this.usesBearer(req) ? this.bearerToken(req) : parseCookies(req.headers.cookie)[SESSION_COOKIE]
    if (token) await this.store.deleteSession(token)
  }

  // Whether a pairing code is valid now, without using it. Wrong codes count
  // toward the same per-peer limit as pairing.
  async pairingCodeValid(code: string, peer: string) {
    if (this.pairingLocked(peer)) throw new HttpError(429, 'Too many wrong pairing codes. Wait 10 minutes.')
    if (await this.store.findPairing(code)) return true
    this.noteWrongCode(peer)
    return false
  }

  noteWrongCode(peer: string) {
    this.pairingFailures.set(peer, [...(this.pairingFailures.get(peer) ?? []), Date.now()])
  }

  // POST /client/auth/app/register {code, publicKey}: the pairing code, used up
  // exactly like passkey pairing, enrols an app device with its public key.
  // approvalKey (optional): a public key held behind Touch ID, Face ID or
  // Windows Hello (P-256 point, or RSA SubjectPublicKeyInfo; see approvalPublicKey). Only then can the app approve
  // requests. It is set at pairing only: a stolen session cannot add one.
  async registerApp(body: { code?: unknown; publicKey?: unknown; approvalKey?: unknown }, peer = '') {
    const publicKey = typeof body.publicKey === 'string' && /^[A-Za-z0-9_-]{43}$/.test(body.publicKey) ? Buffer.from(body.publicKey, 'base64url') : null
    if (!publicKey || publicKey.length !== 32) throw new HttpError(400, 'publicKey must be a raw Ed25519 key, 32 bytes base64url')
    const approvalKey = body.approvalKey === undefined || body.approvalKey === null ? null : parseApprovalKey(body.approvalKey)
    if (this.pairingLocked(peer)) throw new HttpError(429, 'Too many wrong pairing codes. Wait 10 minutes.')
    const pairing = typeof body.code === 'string' ? await this.store.findPairing(body.code) : null
    if (!pairing) {
      this.noteWrongCode(peer)
      throw new HttpError(403, 'Unknown or expired pairing code')
    }
    if (!(await this.store.consumePairing(pairing.codeHash))) throw new HttpError(403, 'Pairing code already used or expired')
    const device = await this.store.createDevice(pairing.deviceName, pairing.userId, 'app')
    const keyId = crypto.randomBytes(16).toString('base64url')
    await this.store.addAppKey(keyId, device.id, publicKey, approvalKey)
    return { device: { id: device.id, name: device.name, userId: device.userId }, keyId }
  }

  // POST /client/auth/app/challenge
  appChallenge() {
    const challenge = crypto.randomBytes(32).toString('base64url')
    return { challengeId: this.putChallenge({ challenge, kind: 'app', origin: '', expiresAt: Date.now() + CHALLENGE_TTL_MS }), challenge }
  }

  // A request approval from an app: its approval key signed
  // vocorum-app-approve\n<challenge>\n<requestId>\n<keyId> with SHA-256 (ECDSA
  // P-256 in DER or raw r||s, or RSA PKCS#1 v1.5), on the device that asked.
  async verifyAppApproval(deviceId: string, challenge: string, requestId: string, body: { keyId?: unknown; signature?: unknown }) {
    const keyId = typeof body.keyId === 'string' ? body.keyId : ''
    const key = keyId ? await this.store.getAppKey(keyId) : null
    if (!key || key.deviceId !== deviceId) throw new HttpError(403, 'Use the app key of this device')
    if (!key.approvalKey) throw new HttpError(403, 'This app cannot approve: it has no key behind Touch ID, Face ID or Windows Hello. Approve with a passkey instead.')
    const signature = typeof body.signature === 'string' ? Buffer.from(body.signature, 'base64url') : Buffer.alloc(0)
    const publicKey = approvalPublicKey(key.approvalKey)
    const signed = Buffer.from(`${APP_APPROVE_PREFIX}\n${challenge}\n${requestId}\n${keyId}`, 'utf8')
    const attempt = (check: () => boolean) => {
      try {
        return check()
      } catch {
        return false
      }
    }
    const ok =
      publicKey.asymmetricKeyType === 'rsa'
        ? attempt(() => crypto.verify('sha256', signed, { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, signature))
        : (['der', 'ieee-p1363'] as const).some((dsaEncoding) => attempt(() => crypto.verify('sha256', signed, { key: publicKey, dsaEncoding }, signature)))
    if (!ok) throw new HttpError(403, 'Signature rejected')
  }

  // POST /client/auth/app/login {challengeId, keyId, signature}
  async loginApp(body: { challengeId?: unknown; keyId?: unknown; signature?: unknown }) {
    const challenge = this.takeChallenge(body.challengeId, 'app', '')
    const keyId = typeof body.keyId === 'string' ? body.keyId : ''
    const key = keyId ? await this.store.getAppKey(keyId) : null
    const device = key ? await this.store.getDevice(key.deviceId) : null
    if (!key || !device || device.revokedAt) throw new HttpError(403, 'This app key is not enrolled or its device was revoked')
    const signature = typeof body.signature === 'string' ? Buffer.from(body.signature, 'base64url') : Buffer.alloc(0)
    const publicKey = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.publicKey.toString('base64url') }, format: 'jwk' })
    const signed = Buffer.from(`${APP_LOGIN_PREFIX}\n${challenge.challenge}\n${keyId}`, 'utf8')
    if (signature.length !== 64 || !crypto.verify(null, signed, publicKey, signature)) throw new HttpError(403, 'Signature rejected')
    const session = await this.store.createSession(device.id, APP_SESSION_TTL_MS, 'bearer')
    return { token: session.token, expiresAt: session.expiresAt, device: { id: device.id, name: device.name } }
  }
}
