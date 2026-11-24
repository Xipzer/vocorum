// Hub state on disk: ~/.vocorum (VOCORUM_DIR overrides). Dir 0700, secrets 0600.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_PORT = 47100

// HTTPS on one private address (WireGuard or tailnet IP) with the hub's own CA.
export type PrivateListenerConfig = {
  address: string
  port: number
  // Plain-HTTP enrolment page (CA profile download only); null = off.
  httpPort: number | null
  // Names under a private zone, e.g. hub.home.arpa. The first one is the app URL.
  names: string[]
  // Peers outside these networks are dropped before TLS.
  allowedCidrs: string[]
}

export type HubConfig = {
  guildId: string
  guildName: string
  ownerUserId: string
  // The owner's own Discord account ids: mirrored Discord messages by these
  // ids are shown as the owner's.
  ownerDiscordIds?: string[]
  ownerUsername: string
  botUserId: string
  botUsername: string
  port: number
  // Tailnet HTTPS URL from `tailscale serve` (https://hub.your-tailnet.example).
  // Remote bots get its wss://.../gateway, attachments and WebAuthn use it.
  publicUrl: string | null
  // Loopback human routes (tailscale serve) need a Tailscale-User-Login header
  // equal to this; on the private listener it is an extra check of the peer.
  // Never sufficient on its own: a passkey session is always required.
  // null: loopback human routes are rejected (fail closed).
  tailscaleLogin: string | null
  privateListener?: PrivateListenerConfig | null
}

export type HubPaths = ReturnType<typeof hubPaths>

export function hubPaths(root = process.env['VOCORUM_DIR'] || path.join(os.homedir(), '.vocorum')) {
  return {
    root,
    config: path.join(root, 'config.json'),
    twinDb: path.join(root, 'twin.db'),
    hubDb: path.join(root, 'hub.db'),
    attachments: path.join(root, 'attachments'),
    // HMAC key for signed attachment URLs.
    signingKey: path.join(root, 'signing-key'),
    // Bearer token for `POST /admin/reload` from the local CLI.
    adminToken: path.join(root, 'admin-token'),
    // Avatars and guild icons.
    media: path.join(root, 'media'),
    // Web Push (VAPID) key pair, 0600.
    vapid: path.join(root, 'vapid.json'),
    // The hub's own CA and server certificate (keys 0600).
    ca: path.join(root, 'ca'),
  }
}

// Discord-like snowflake for ids minted once at init.
export function snowflake(): string {
  const ms = BigInt(Date.now() - 1420070400000)
  return ((ms << 22n) | BigInt(crypto.randomInt(0, 1 << 22))).toString()
}

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
}

function ensureSecretFile(file: string): string {
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 })
  fs.chmodSync(file, 0o600)
  return fs.readFileSync(file, 'utf8').trim()
}

export function loadConfig(paths: HubPaths): HubConfig | null {
  if (!fs.existsSync(paths.config)) return null
  return JSON.parse(fs.readFileSync(paths.config, 'utf8')) as HubConfig
}

export function saveConfig(paths: HubPaths, config: HubConfig) {
  fs.writeFileSync(paths.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

// Creates the hub dir, ids and secrets once; later calls only apply `updates`.
export function initHub(paths: HubPaths, updates: Partial<HubConfig> = {}): HubConfig {
  ensureDir(paths.root)
  ensureDir(paths.attachments)
  ensureSecretFile(paths.signingKey)
  ensureSecretFile(paths.adminToken)
  const existing = loadConfig(paths)
  const config: HubConfig = {
    guildId: snowflake(),
    guildName: 'Home',
    ownerUserId: snowflake(),
    ownerUsername: 'owner',
    botUserId: snowflake(),
    botUsername: 'Kimaki',
    port: DEFAULT_PORT,
    publicUrl: null,
    tailscaleLogin: null,
    ...existing,
    ...Object.fromEntries(Object.entries(updates).filter(([, value]) => value !== undefined)),
  }
  if (config.publicUrl) config.publicUrl = config.publicUrl.replace(/\/+$/, '')
  saveConfig(paths, config)
  return config
}

export function readSecret(file: string): string {
  return fs.readFileSync(file, 'utf8').trim()
}

// Kimaki env for one machine. KIMAKI_GATEWAY_PROXY_URL is the hub base URL:
// Kimaki derives REST (/api) from it and gets the WebSocket URL from /gateway/bot.
// `local`: the machine runs next to the hub and uses loopback.
export function botEnv(config: HubConfig, { clientId, secret }: { clientId: string; secret: string }, { local }: { local: boolean }) {
  const base = local || !config.publicUrl ? `ws://127.0.0.1:${config.port}` : config.publicUrl.replace(/^http/, 'ws')
  return [
    `KIMAKI_BOT_TOKEN=${clientId}:${secret}`,
    `KIMAKI_GATEWAY_APP_ID=${config.botUserId}`,
    `KIMAKI_GATEWAY_PROXY_URL=${base}`,
    // Nothing may reach kimaki.dev.
    'KIMAKI_WEBSITE_URL=http://127.0.0.1:9',
  ].join('\n')
}
