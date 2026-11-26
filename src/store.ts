// The hub's own SQLite (hub.db): bots, devices, passkeys, sessions, pairing
// codes and attachments. Discord-shaped state lives in the twin's twin.db.

import crypto from 'node:crypto'
import { openSqlite, type InValue, type SqliteDb } from './sqlite.ts'
import { snowflake } from './config.ts'

const SCHEMA = [
  // Each machine's own Discord bot (its Kimaki on Discord), shown as that machine.
  `CREATE TABLE IF NOT EXISTS machine_bots (
    machine TEXT PRIMARY KEY,
    discord_user_id TEXT NOT NULL,
    name TEXT NOT NULL
  )`,
  // Messages mirrored from real Discord (origin 'discord'), and Discord echoes
  // of messages typed in the hub (echo_of: the hub message they repeat).
  // Integer ids (snowflakes fit in SQLite's 64-bit integers): the rowid is the
  // key, so a few hundred thousand imported messages cost no separate index.
  // Read ids back as CAST(message_id AS TEXT): a JS number cannot hold them.
  `CREATE TABLE IF NOT EXISTS message_origins (
    message_id INTEGER PRIMARY KEY,
    origin TEXT NOT NULL,
    echo_of INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS message_origins_echo_of ON message_origins (echo_of) WHERE echo_of IS NOT NULL',
  // A picture per machine (its bot's avatar, its Discord server icon); files in media/.
  `CREATE TABLE IF NOT EXISTS machine_icons (
    machine TEXT NOT NULL,
    kind TEXT NOT NULL,
    hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (machine, kind)
  )`,
  // What the hub adds to a user's Discord profile: the name colour.
  `CREATE TABLE IF NOT EXISTS profiles (
    user_id TEXT PRIMARY KEY,
    color INTEGER
  )`,
  // Per user: read positions, favourites and output views (the older
  // single-owner tables below are copied in once, for the owner).
  `CREATE TABLE IF NOT EXISTS user_read_state (
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    PRIMARY KEY (user_id, channel_id)
  )`,
  `CREATE TABLE IF NOT EXISTS user_favourites (
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, channel_id)
  )`,
  `CREATE TABLE IF NOT EXISTS user_output_views (
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    output INTEGER NOT NULL,
    PRIMARY KEY (user_id, channel_id)
  )`,
  // Channel permission overwrites, Discord's shape (type 0 role, 1 member).
  `CREATE TABLE IF NOT EXISTS channel_overwrites (
    channel_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    type INTEGER NOT NULL,
    allow TEXT NOT NULL,
    deny TEXT NOT NULL,
    PRIMARY KEY (channel_id, target_id)
  )`,
  // Per user, per guild or channel: notification level and mute. Absent: inherit.
  `CREATE TABLE IF NOT EXISTS notification_settings (
    user_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    level TEXT,
    muted_until INTEGER,
    PRIMARY KEY (user_id, scope_id)
  )`,
  // One Web Push subscription per device (an installed PWA).
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    device_id TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  // Hub spaces, like Discord servers. The hub creates each in the twin.
  `CREATE TABLE IF NOT EXISTS guilds (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  // Which guilds each bot (machine) is in. A bot with no rows is in the primary guild.
  // A machine bot that is its own bot user (its name in voice, presence and posts) instead of the shared bot.
  `CREATE TABLE IF NOT EXISTS bot_users (
    machine TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS bot_guilds (
    machine TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    PRIMARY KEY (machine, guild_id)
  )`,
  `CREATE TABLE IF NOT EXISTS bots (
    machine TEXT PRIMARY KEY,
    client_id TEXT NOT NULL UNIQUE,
    secret TEXT NOT NULL DEFAULT '',
    secret_hash TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS pairings (
    code_hash TEXT PRIMARY KEY,
    device_name TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS credentials (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id),
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL,
    transports TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  )`,
  // App devices sign in with an Ed25519 key kept in the OS keychain (no WebAuthn in app webviews).
  `CREATE TABLE IF NOT EXISTS app_keys (
    key_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id),
    public_key BLOB NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    duration_secs REAL,
    waveform TEXT,
    width INTEGER,
    height INTEGER,
    uploaded_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  // The owner's read position per channel or thread, shared by every device.
  `CREATE TABLE IF NOT EXISTS read_state (
    channel_id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS favourites (
    channel_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  )`,
  // Output view per channel: 1 forces the output-only view, 0 forces a conversation.
  `CREATE TABLE IF NOT EXISTS output_views (
    channel_id TEXT PRIMARY KEY,
    output INTEGER NOT NULL
  )`,
  // Services on the hub's machine: the last state seen of each, and their history.
  `CREATE TABLE IF NOT EXISTS service_snapshots (
    unit TEXT PRIMARY KEY,
    json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS service_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    unit TEXT NOT NULL,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS service_events_unit ON service_events (unit, at)`,
]

export const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex')

export type BotRow = { machine: string; clientId: string; secretHash: string; createdAt: number; revokedAt: number | null }

// The key a bot token is registered under: clientId plus the hash of its secret.
export function botTokenKey(token: string) {
  const index = token.indexOf(':')
  return index < 0 ? token : `${token.slice(0, index)}:${sha256(token.slice(index + 1))}`
}
export type NotificationLevel = 'all' | 'mentions' | 'nothing'
// null fields inherit from the parent channel, then the category, then the guild.
export type NotificationSetting = { level: NotificationLevel | null; muted_until: number | null }

export type Profile = { color: number | null; showPresence: boolean; showActivity: boolean; tailscaleLogin: string | null }
export type Overwrite = { id: string; type: 0 | 1; allow: string; deny: string }

export type GuildRow = { id: string; name: string; icon: string | null; position: number }

// userId null: the owner (devices paired before there were several people).
export type DeviceKind = 'web' | 'app'
export type SessionKind = 'cookie' | 'bearer'
// local: the row open access signs this computer's browsers in as (no pairing, no passkey).
export type DeviceRow = { id: string; name: string; userId: string | null; kind: DeviceKind; createdAt: number; lastSeenAt: number | null; revokedAt: number | null; local: boolean }
export type CredentialRow = { id: string; deviceId: string; publicKey: Uint8Array; counter: number; transports: string[] }
export type AttachmentRow = {
  id: string
  filename: string
  contentType: string
  size: number
  durationSecs: number | null
  waveform: string | null
  width: number | null
  height: number | null
  uploadedBy: string
}

export class HubStore {
  readonly db: SqliteDb

  constructor(url: string) {
    this.db = openSqlite(url)
  }

  async migrate() {
    await this.db.execute('PRAGMA journal_mode = WAL')
    await this.db.execute('PRAGMA busy_timeout = 5000')
    // Bounded page cache (8 MB), as for the twin database.
    await this.db.execute('PRAGMA cache_size = -8000')
    for (const statement of SCHEMA) await this.db.execute(statement)
    // Older hubs kept message_origins with text ids: copy it over once.
    if ((await this.rows('PRAGMA table_info(message_origins)')).some((c) => c['name'] === 'message_id' && String(c['type']).toUpperCase() === 'TEXT')) {
      await this.db.batch([
        'CREATE TABLE message_origins_v2 (message_id INTEGER PRIMARY KEY, origin TEXT NOT NULL, echo_of INTEGER)',
        'INSERT INTO message_origins_v2 (message_id, origin, echo_of) SELECT CAST(message_id AS INTEGER), origin, CAST(echo_of AS INTEGER) FROM message_origins',
        'DROP TABLE message_origins',
        'ALTER TABLE message_origins_v2 RENAME TO message_origins',
        'CREATE INDEX IF NOT EXISTS message_origins_echo_of ON message_origins (echo_of) WHERE echo_of IS NOT NULL',
      ], 'write')
      // Give the space back once (about 25 MB on a large hub; under a second).
      await this.db.execute('VACUUM')
    }
    // Bot secrets are stored as SHA-256 only. Older hubs kept them in clear:
    // hash those once and blank the clear column.
    const columns = (await this.rows('PRAGMA table_info(bots)')).map((row) => String(row['name']))
    if (!columns.includes('secret_hash')) await this.db.execute("ALTER TABLE bots ADD COLUMN secret_hash TEXT NOT NULL DEFAULT ''")
    for (const row of await this.rows("SELECT machine, secret FROM bots WHERE secret != ''")) {
      await this.db.execute({ sql: "UPDATE bots SET secret_hash = ?, secret = '' WHERE machine = ?", args: [sha256(String(row['secret'])), String(row['machine'])] })
    }
    // Several people: devices and pairing codes belong to a user (NULL: the owner).
    await this.addColumn('devices', 'user_id', 'TEXT')
    await this.addColumn('pairings', 'user_id', 'TEXT')
    await this.addColumn('profiles', 'show_presence', 'INTEGER NOT NULL DEFAULT 1')
    await this.addColumn('profiles', 'show_activity', 'INTEGER NOT NULL DEFAULT 1')
    await this.addColumn('profiles', 'tailscale_login', 'TEXT')
    // 'web' (passkey, cookie sessions) or 'app' (device key, bearer sessions).
    await this.addColumn('devices', 'kind', "TEXT NOT NULL DEFAULT 'web'")
    await this.addColumn('sessions', 'kind', "TEXT NOT NULL DEFAULT 'cookie'")
    // A second app key for approving requests: P-256, kept where the OS asks for Touch ID, Face ID or Windows Hello.
    await this.addColumn('app_keys', 'approval_key', 'BLOB')
    // The row open access signs this computer's browsers in as. Before the mark it was found
    // by its name; a paired browser always has a passkey, so a passkey-less one is that row.
    if (await this.addColumn('devices', 'local', 'INTEGER NOT NULL DEFAULT 0'))
      await this.db.execute("UPDATE devices SET local = 1 WHERE name = 'This computer' AND kind = 'web' AND revoked_at IS NULL AND id NOT IN (SELECT device_id FROM credentials)")
  }

  private async addColumn(table: string, column: string, type: string) {
    const columns = (await this.rows(`PRAGMA table_info(${table})`)).map((row) => String(row['name']))
    if (columns.includes(column)) return false
    await this.db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
    return true
  }

  // The single-owner tables of older hubs become the owner's rows, once.
  async migrateOwnerData(ownerUserId: string) {
    const moves: Array<[string, string]> = [
      ['read_state', 'INSERT OR IGNORE INTO user_read_state (user_id, channel_id, message_id) SELECT ?, channel_id, message_id FROM read_state'],
      ['favourites', 'INSERT OR IGNORE INTO user_favourites (user_id, channel_id, created_at) SELECT ?, channel_id, created_at FROM favourites'],
      ['output_views', 'INSERT OR IGNORE INTO user_output_views (user_id, channel_id, output) SELECT ?, channel_id, output FROM output_views'],
    ]
    for (const [table, copy] of moves) {
      if ((await this.rows(`SELECT count(*) n FROM ${table}`))[0]!['n'] === 0) continue
      await this.db.batch([{ sql: copy, args: [ownerUserId] }, { sql: `DELETE FROM ${table}`, args: [] }], 'write')
    }
  }

  close() {
    this.db.close()
  }

  private async rows(sql: string, args: InValue[] = []) {
    return (await this.db.execute({ sql, args })).rows
  }

  // --- bots

  // --- read state, favourites and output views (per user, shared across their devices)

  async readState(userId: string): Promise<Record<string, string>> {
    return Object.fromEntries((await this.rows('SELECT channel_id, message_id FROM user_read_state WHERE user_id = ?', [userId])).map((row) => [String(row['channel_id']), String(row['message_id'])]))
  }

  // Sets the position as given, backwards too (mark unread).
  async setRead(userId: string, entries: Array<[channelId: string, messageId: string]>) {
    if (entries.length === 0) return
    await this.db.batch(entries.map(([channelId, messageId]) => ({ sql: 'INSERT INTO user_read_state (user_id, channel_id, message_id) VALUES (?, ?, ?) ON CONFLICT(user_id, channel_id) DO UPDATE SET message_id = excluded.message_id', args: [userId, channelId, messageId] })), 'write')
  }

  // Only moves forward: an older position from a stale device never unreads.
  async markRead(userId: string, entries: Array<[channelId: string, messageId: string]>) {
    if (entries.length === 0) return
    await this.db.batch(
      entries.map(([channelId, messageId]) => ({
        sql: `INSERT INTO user_read_state (user_id, channel_id, message_id) VALUES (?, ?, ?)
              ON CONFLICT(user_id, channel_id) DO UPDATE SET message_id = excluded.message_id
              WHERE length(excluded.message_id) > length(user_read_state.message_id)
                 OR (length(excluded.message_id) = length(user_read_state.message_id) AND excluded.message_id > user_read_state.message_id)`,
        args: [userId, channelId, messageId],
      })),
      'write',
    )
  }

  async favourites(userId: string): Promise<string[]> {
    return (await this.rows('SELECT channel_id FROM user_favourites WHERE user_id = ? ORDER BY created_at', [userId])).map((row) => String(row['channel_id']))
  }

  async setFavourite(userId: string, channelId: string, on: boolean) {
    if (on) await this.db.execute({ sql: 'INSERT OR IGNORE INTO user_favourites (user_id, channel_id, created_at) VALUES (?, ?, ?)', args: [userId, channelId, Date.now()] })
    else await this.db.execute({ sql: 'DELETE FROM user_favourites WHERE user_id = ? AND channel_id = ?', args: [userId, channelId] })
  }

  async outputViews(userId: string): Promise<Record<string, boolean>> {
    return Object.fromEntries((await this.rows('SELECT channel_id, output FROM user_output_views WHERE user_id = ?', [userId])).map((row) => [String(row['channel_id']), Number(row['output']) === 1]))
  }

  async setOutputView(userId: string, channelId: string, output: boolean | null) {
    if (output === null) await this.db.execute({ sql: 'DELETE FROM user_output_views WHERE user_id = ? AND channel_id = ?', args: [userId, channelId] })
    else await this.db.execute({ sql: 'INSERT INTO user_output_views (user_id, channel_id, output) VALUES (?, ?, ?) ON CONFLICT(user_id, channel_id) DO UPDATE SET output = excluded.output', args: [userId, channelId, output ? 1 : 0] })
  }

  // --- channel permission overwrites

  async overwrites(): Promise<Map<string, Overwrite[]>> {
    const out = new Map<string, Overwrite[]>()
    for (const row of await this.rows('SELECT channel_id, target_id, type, allow, deny FROM channel_overwrites')) {
      const channelId = String(row['channel_id'])
      out.set(channelId, [...(out.get(channelId) ?? []), { id: String(row['target_id']), type: Number(row['type']) as 0 | 1, allow: String(row['allow']), deny: String(row['deny']) }])
    }
    return out
  }

  async setOverwrite(channelId: string, overwrite: Overwrite | { id: string; remove: true }) {
    if ('remove' in overwrite) {
      await this.db.execute({ sql: 'DELETE FROM channel_overwrites WHERE channel_id = ? AND target_id = ?', args: [channelId, overwrite.id] })
      return
    }
    await this.db.execute({
      sql: 'INSERT INTO channel_overwrites (channel_id, target_id, type, allow, deny) VALUES (?, ?, ?, ?, ?) ON CONFLICT(channel_id, target_id) DO UPDATE SET type = excluded.type, allow = excluded.allow, deny = excluded.deny',
      args: [channelId, overwrite.id, overwrite.type, overwrite.allow, overwrite.deny],
    })
  }

  async addServiceEvent(e: { unit: string; at: number; kind: string; detail: string | null }) {
    await this.db.execute({ sql: 'INSERT INTO service_events (unit, at, kind, detail) VALUES (?, ?, ?, ?)', args: [e.unit, Math.round(e.at), e.kind, e.detail] })
  }

  async serviceEvents(unit: string | null, limit = 200): Promise<Array<{ unit: string; at: number; kind: string; detail: string | null }>> {
    const rows = unit ? await this.rows('SELECT unit, at, kind, detail FROM service_events WHERE unit = ? ORDER BY at DESC, id DESC LIMIT ?', [unit, limit]) : await this.rows('SELECT unit, at, kind, detail FROM service_events ORDER BY at DESC, id DESC LIMIT ?', [limit])
    return rows.map((r) => ({ unit: String(r['unit']), at: Number(r['at']), kind: String(r['kind']), detail: r['detail'] == null ? null : String(r['detail']) }))
  }

  async serviceSnapshots(): Promise<Record<string, unknown>> {
    return Object.fromEntries((await this.rows('SELECT unit, json FROM service_snapshots')).map((r) => [String(r['unit']), JSON.parse(String(r['json']))]))
  }

  async saveServiceSnapshots(units: Array<{ unit: string }>) {
    await this.db.batch([{ sql: 'DELETE FROM service_snapshots', args: [] }, ...units.map((u) => ({ sql: 'INSERT INTO service_snapshots (unit, json) VALUES (?, ?)', args: [u.unit, JSON.stringify(u)] }))], 'write')
  }

  // Returns the secret in clear exactly once, for the bot's env; only its hash is stored.
  async addBot(machine: string): Promise<BotRow & { secret: string }> {
    const existing = await this.rows('SELECT machine FROM bots WHERE machine = ? AND revoked_at IS NULL', [machine])
    if (existing.length > 0) throw new Error(`bot "${machine}" already exists; revoke it first`)
    await this.db.execute({ sql: 'DELETE FROM bots WHERE machine = ?', args: [machine] })
    const secret = crypto.randomBytes(32).toString('hex')
    const row = { machine, clientId: crypto.randomUUID(), secret, secretHash: sha256(secret), createdAt: Date.now(), revokedAt: null }
    // secret stays empty: older hubs' bots table has it NOT NULL without a default.
    await this.db.execute({ sql: "INSERT INTO bots (machine, client_id, secret, secret_hash, created_at) VALUES (?, ?, '', ?, ?)", args: [row.machine, row.clientId, row.secretHash, row.createdAt] })
    return row
  }

  async listBots(): Promise<BotRow[]> {
    return (await this.rows('SELECT * FROM bots ORDER BY created_at')).map((row) => ({
      machine: String(row['machine']),
      clientId: String(row['client_id']),
      secretHash: String(row['secret_hash']),
      createdAt: Number(row['created_at']),
      revokedAt: row['revoked_at'] == null ? null : Number(row['revoked_at']),
    }))
  }

  async revokeBot(machine: string): Promise<boolean> {
    const result = await this.db.execute({ sql: 'UPDATE bots SET revoked_at = ? WHERE machine = ? AND revoked_at IS NULL', args: [Date.now(), machine] })
    return result.rowsAffected > 0
  }

  // --- guilds

  // The primary guild from config.json: first, created once.
  async ensureGuild(id: string, name: string) {
    await this.db.execute({ sql: 'INSERT OR IGNORE INTO guilds (id, name, position, created_at) VALUES (?, ?, 0, ?)', args: [id, name, Date.now()] })
  }

  async listGuilds(): Promise<GuildRow[]> {
    return (await this.rows('SELECT id, name, icon, position FROM guilds ORDER BY position, created_at')).map((row) => ({
      id: String(row['id']),
      name: String(row['name']),
      icon: row['icon'] == null ? null : String(row['icon']),
      position: Number(row['position']),
    }))
  }

  async findGuild(idOrName: string): Promise<GuildRow | null> {
    const key = idOrName.toLowerCase()
    return (await this.listGuilds()).find((g) => g.id === idOrName || g.name.toLowerCase() === key) ?? null
  }

  // id: a mirrored guild keeps its Discord id (and may share a name).
  async addGuild(name: string, { id }: { id?: string } = {}): Promise<GuildRow> {
    const clean = name.trim().slice(0, 100)
    if (!clean) throw new Error('A guild needs a name')
    if (!id && (await this.findGuild(clean))) throw new Error(`guild "${clean}" already exists`)
    const position = Number((await this.rows('SELECT coalesce(max(position), -1) + 1 AS p FROM guilds'))[0]!['p'])
    const row = { id: id ?? snowflake(), name: clean, icon: null, position }
    await this.db.execute({ sql: 'INSERT INTO guilds (id, name, position, created_at) VALUES (?, ?, ?, ?)', args: [row.id, row.name, row.position, Date.now()] })
    return row
  }

  async renameGuild(id: string, name: string) {
    const clean = name.trim().slice(0, 100)
    if (!clean) throw new Error('A guild needs a name')
    const other = await this.findGuild(clean)
    if (other && other.id !== id) throw new Error(`guild "${clean}" already exists`)
    await this.db.execute({ sql: 'UPDATE guilds SET name = ? WHERE id = ?', args: [clean, id] })
  }

  async setGuildIcon(id: string, icon: string | null) {
    await this.db.execute({ sql: 'UPDATE guilds SET icon = ? WHERE id = ?', args: [icon, id] })
  }

  // --- profiles

  async profiles(): Promise<Record<string, Profile>> {
    return Object.fromEntries(
      (await this.rows('SELECT user_id, color, show_presence, show_activity, tailscale_login FROM profiles')).map((row) => [
        String(row['user_id']),
        { color: row['color'] == null ? null : Number(row['color']), showPresence: Number(row['show_presence']) !== 0, showActivity: Number(row['show_activity']) !== 0, tailscaleLogin: row['tailscale_login'] == null ? null : String(row['tailscale_login']) },
      ]),
    )
  }

  async setProfile(userId: string, update: Partial<Profile>) {
    await this.db.execute({ sql: 'INSERT OR IGNORE INTO profiles (user_id) VALUES (?)', args: [userId] })
    const columns: Array<[string, InValue]> = []
    if (update.color !== undefined) columns.push(['color', update.color])
    if (update.showPresence !== undefined) columns.push(['show_presence', update.showPresence ? 1 : 0])
    if (update.showActivity !== undefined) columns.push(['show_activity', update.showActivity ? 1 : 0])
    if (update.tailscaleLogin !== undefined) columns.push(['tailscale_login', update.tailscaleLogin])
    if (columns.length === 0) return
    await this.db.execute({ sql: `UPDATE profiles SET ${columns.map(([c]) => `${c} = ?`).join(', ')} WHERE user_id = ?`, args: [...columns.map(([, v]) => v), userId] })
  }

  async setProfileColor(userId: string, color: number | null) {
    await this.setProfile(userId, { color })
  }

  async botGuilds(): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>()
    for (const row of await this.rows('SELECT machine, guild_id FROM bot_guilds ORDER BY rowid')) {
      const machine = String(row['machine'])
      out.set(machine, [...(out.get(machine) ?? []), String(row['guild_id'])])
    }
    return out
  }

  async botUsers(): Promise<Map<string, { userId: string; name: string }>> {
    const out = new Map<string, { userId: string; name: string }>()
    for (const row of await this.rows('SELECT machine, user_id, name FROM bot_users')) out.set(String(row['machine']), { userId: String(row['user_id']), name: String(row['name']) })
    return out
  }

  // Its own user (kept across renames, so it stays the same user), or the shared bot again (name null).
  async setBotUser(machine: string, name: string | null, newId: () => string) {
    if (name === null) return void (await this.db.execute({ sql: 'DELETE FROM bot_users WHERE machine = ?', args: [machine] }))
    await this.db.execute({ sql: 'INSERT INTO bot_users (machine, user_id, name) VALUES (?, ?, ?) ON CONFLICT(machine) DO UPDATE SET name = excluded.name', args: [machine, newId(), name] })
  }

  async setBotGuilds(machine: string, guildIds: string[]) {
    await this.db.batch(
      [
        { sql: 'DELETE FROM bot_guilds WHERE machine = ?', args: [machine] },
        ...[...new Set(guildIds)].map((id) => ({ sql: 'INSERT INTO bot_guilds (machine, guild_id) VALUES (?, ?)', args: [machine, id] })),
      ],
      'write',
    )
  }

  // --- notifications

  async notificationSettings(userId: string): Promise<Record<string, NotificationSetting>> {
    const rows = await this.rows('SELECT scope_id, level, muted_until FROM notification_settings WHERE user_id = ?', [userId])
    return Object.fromEntries(rows.map((row) => [String(row['scope_id']), { level: row['level'] == null ? null : (String(row['level']) as NotificationLevel), muted_until: row['muted_until'] == null ? null : Number(row['muted_until']) }]))
  }

  async setNotificationSetting(userId: string, scopeId: string, setting: NotificationSetting) {
    if (setting.level === null && setting.muted_until === null) {
      await this.db.execute({ sql: 'DELETE FROM notification_settings WHERE user_id = ? AND scope_id = ?', args: [userId, scopeId] })
      return
    }
    await this.db.execute({
      sql: `INSERT INTO notification_settings (user_id, scope_id, level, muted_until) VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, scope_id) DO UPDATE SET level = excluded.level, muted_until = excluded.muted_until`,
      args: [userId, scopeId, setting.level, setting.muted_until],
    })
  }

  async setPushSubscription(deviceId: string, target: { endpoint: string; p256dh: string; auth: string }) {
    await this.db.execute({
      sql: `INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(device_id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at`,
      args: [deviceId, target.endpoint, target.p256dh, target.auth, Date.now()],
    })
  }

  async deletePushSubscription(deviceId: string) {
    await this.db.execute({ sql: 'DELETE FROM push_subscriptions WHERE device_id = ?', args: [deviceId] })
  }

  // Subscriptions of devices that are not revoked.
  // userId null: the owner's device.
  async pushSubscriptions(): Promise<Array<{ deviceId: string; userId: string | null; endpoint: string; p256dh: string; auth: string }>> {
    const rows = await this.rows('SELECT p.device_id, d.user_id, p.endpoint, p.p256dh, p.auth FROM push_subscriptions p JOIN devices d ON d.id = p.device_id WHERE d.revoked_at IS NULL')
    return rows.map((row) => ({ deviceId: String(row['device_id']), userId: row['user_id'] == null ? null : String(row['user_id']), endpoint: String(row['endpoint']), p256dh: String(row['p256dh']), auth: String(row['auth']) }))
  }

  // --- devices and pairing

  // userId: who the new device belongs to (null: the owner). An invite for a new person lasts longer.
  async createPairing(deviceName: string, { userId = null, ttlMs = 10 * 60_000 }: { userId?: string | null; ttlMs?: number } = {}): Promise<string> {
    // 10 characters of Crockford-ish base32: ~50 bits, single use, 10 minutes.
    const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'
    const code = Array.from(crypto.randomBytes(10), (byte) => alphabet[byte % alphabet.length]).join('')
    await this.db.execute({ sql: 'INSERT INTO pairings (code_hash, device_name, expires_at, user_id) VALUES (?, ?, ?, ?)', args: [sha256(normalizeCode(code)), deviceName, Date.now() + ttlMs, userId] })
    return code
  }

  async findPairing(code: string): Promise<{ codeHash: string; deviceName: string; userId: string | null } | null> {
    const codeHash = sha256(normalizeCode(code))
    const [row] = await this.rows('SELECT * FROM pairings WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?', [codeHash, Date.now()])
    return row ? { codeHash, deviceName: String(row['device_name']), userId: row['user_id'] == null ? null : String(row['user_id']) } : null
  }

  // What became of a pairing code: still usable, used, or expired (or unknown, counted as expired).
  async pairingState(code: string): Promise<'ready' | 'used' | 'expired'> {
    const [row] = await this.rows('SELECT used_at, expires_at FROM pairings WHERE code_hash = ?', [sha256(normalizeCode(code))])
    if (row?.['used_at'] != null) return 'used'
    return row && Number(row['expires_at']) > Date.now() ? 'ready' : 'expired'
  }

  async consumePairing(codeHash: string): Promise<boolean> {
    const result = await this.db.execute({ sql: 'UPDATE pairings SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?', args: [Date.now(), codeHash, Date.now()] })
    return result.rowsAffected > 0
  }

  async createDevice(name: string, userId: string | null = null, kind: DeviceKind = 'web', local = false): Promise<DeviceRow> {
    const row: DeviceRow = { id: crypto.randomUUID(), name, userId, kind, createdAt: Date.now(), lastSeenAt: null, revokedAt: null, local }
    await this.db.execute({ sql: 'INSERT INTO devices (id, name, created_at, user_id, kind, local) VALUES (?, ?, ?, ?, ?, ?)', args: [row.id, row.name, row.createdAt, userId, kind, local ? 1 : 0] })
    return row
  }

  async listDevices(): Promise<DeviceRow[]> {
    return (await this.rows('SELECT * FROM devices ORDER BY created_at')).map(deviceFromRow)
  }

  async renameDevice(id: string, name: string) {
    await this.db.execute({ sql: 'UPDATE devices SET name = ? WHERE id = ? AND revoked_at IS NULL', args: [name, id] })
  }

  async getDevice(id: string): Promise<DeviceRow | null> {
    const [row] = await this.rows('SELECT * FROM devices WHERE id = ?', [id])
    return row ? deviceFromRow(row) : null
  }

  // Revokes by id or name. Returns the revoked device ids.
  async revokeDevice(idOrName: string): Promise<string[]> {
    const devices = (await this.listDevices()).filter((device) => !device.revokedAt && (device.id === idOrName || device.name === idOrName))
    for (const device of devices) {
      await this.db.execute({ sql: 'UPDATE devices SET revoked_at = ? WHERE id = ?', args: [Date.now(), device.id] })
      await this.db.execute({ sql: 'DELETE FROM sessions WHERE device_id = ?', args: [device.id] })
      await this.db.execute({ sql: 'DELETE FROM push_subscriptions WHERE device_id = ?', args: [device.id] })
    }
    return devices.map((device) => device.id)
  }

  async addCredential(credential: CredentialRow) {
    await this.db.execute({
      sql: 'INSERT INTO credentials (id, device_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [credential.id, credential.deviceId, credential.publicKey, credential.counter, JSON.stringify(credential.transports), Date.now()],
    })
  }

  async getCredential(id: string): Promise<CredentialRow | null> {
    const [row] = await this.rows('SELECT * FROM credentials WHERE id = ?', [id])
    if (!row) return null
    const key = row['public_key']
    return {
      id: String(row['id']),
      deviceId: String(row['device_id']),
      publicKey: key instanceof ArrayBuffer ? new Uint8Array(key) : new Uint8Array(key as unknown as Uint8Array),
      counter: Number(row['counter']),
      transports: JSON.parse(String(row['transports'])) as string[],
    }
  }

  async addAppKey(keyId: string, deviceId: string, publicKey: Buffer, approvalKey: Buffer | null = null) {
    await this.db.execute({ sql: 'INSERT INTO app_keys (key_id, device_id, public_key, approval_key, created_at) VALUES (?, ?, ?, ?, ?)', args: [keyId, deviceId, publicKey, approvalKey, Date.now()] })
  }

  async getAppKey(keyId: string): Promise<{ deviceId: string; publicKey: Buffer; approvalKey: Buffer | null } | null> {
    const [row] = await this.rows('SELECT * FROM app_keys WHERE key_id = ?', [keyId])
    if (!row) return null
    const bytes = (key: unknown) => Buffer.from(key instanceof ArrayBuffer ? new Uint8Array(key) : (key as Uint8Array))
    return { deviceId: String(row['device_id']), publicKey: bytes(row['public_key']), approvalKey: row['approval_key'] == null ? null : bytes(row['approval_key']) }
  }

  async updateCredentialCounter(id: string, counter: number) {
    await this.db.execute({ sql: 'UPDATE credentials SET counter = ? WHERE id = ?', args: [counter, id] })
  }

  // --- sessions (only the hash of the cookie value is stored)

  // A cookie session's token only works as a cookie, a bearer one only as a bearer.
  async createSession(deviceId: string, ttlMs = 30 * 24 * 3600_000, kind: SessionKind = 'cookie'): Promise<{ token: string; expiresAt: number }> {
    const token = crypto.randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + ttlMs
    await this.db.execute({ sql: 'INSERT INTO sessions (token_hash, device_id, created_at, expires_at, kind) VALUES (?, ?, ?, ?, ?)', args: [sha256(token), deviceId, Date.now(), expiresAt, kind] })
    return { token, expiresAt }
  }

  async sessionDevice(token: string, kind: SessionKind = 'cookie'): Promise<DeviceRow | null> {
    const [row] = await this.rows(
      `SELECT devices.* FROM sessions JOIN devices ON devices.id = sessions.device_id
       WHERE sessions.token_hash = ? AND sessions.kind = ? AND sessions.expires_at > ? AND devices.revoked_at IS NULL`,
      [sha256(token), kind, Date.now()],
    )
    if (!row) return null
    const device = deviceFromRow(row)
    if (!device.lastSeenAt || Date.now() - device.lastSeenAt > 60_000) {
      await this.db.execute({ sql: 'UPDATE devices SET last_seen_at = ? WHERE id = ?', args: [Date.now(), device.id] })
    }
    return device
  }

  async deleteSession(token: string) {
    await this.db.execute({ sql: 'DELETE FROM sessions WHERE token_hash = ?', args: [sha256(token)] })
  }

  // --- attachments

  async addAttachment(row: AttachmentRow) {
    await this.db.execute({
      // Replaced on a second save of the same id (a re-run import copying a file again).
      sql: `INSERT OR REPLACE INTO attachments (id, filename, content_type, size, duration_secs, waveform, width, height, uploaded_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [row.id, row.filename, row.contentType, row.size, row.durationSecs, row.waveform, row.width, row.height, row.uploadedBy, Date.now()],
    })
  }

  async getAttachment(id: string): Promise<AttachmentRow | null> {
    const [row] = await this.rows('SELECT * FROM attachments WHERE id = ?', [id])
    if (!row) return null
    const num = (key: string) => (row[key] == null ? null : Number(row[key]))
    return {
      id: String(row['id']),
      filename: String(row['filename']),
      contentType: String(row['content_type']),
      size: Number(row['size']),
      durationSecs: num('duration_secs'),
      waveform: row['waveform'] == null ? null : String(row['waveform']),
      width: num('width'),
      height: num('height'),
      uploadedBy: String(row['uploaded_by']),
    }
  }
}

export function normalizeCode(code: string) {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function deviceFromRow(row: Record<string, unknown>): DeviceRow {
  return {
    id: String(row['id']),
    name: String(row['name']),
    userId: row['user_id'] == null ? null : String(row['user_id']),
    kind: row['kind'] === 'app' ? 'app' : 'web',
    createdAt: Number(row['created_at']),
    lastSeenAt: row['last_seen_at'] == null ? null : Number(row['last_seen_at']),
    revokedAt: row['revoked_at'] == null ? null : Number(row['revoked_at']),
    local: Number(row['local'] ?? 0) === 1,
  }
}
