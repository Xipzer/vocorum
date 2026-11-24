// Message search and the mentions inbox. An FTS5 index in hub.db, filled from
// the twin's messages on start and kept current from the dispatch stream.
// Query syntax follows Discord: free text, "exact phrases", from:, in:,
// has:file|image|link|pin, mentions:me, before:, after:, during: (YYYY-MM-DD).

import { getMessageVisibleText } from 'discord-digital-twin/src'
import type { InStatement } from '@libsql/client'
import type { Hub } from './hub.ts'

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS message_index (
    message_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    bot INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    has_file INTEGER NOT NULL,
    has_image INTEGER NOT NULL,
    has_link INTEGER NOT NULL,
    mentions_owner INTEGER NOT NULL, -- unused since index version 2 (see message_mentions)
    pinned INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS message_index_channel ON message_index (channel_id, ts)',
  'CREATE INDEX IF NOT EXISTS message_index_mentions ON message_index (mentions_owner, ts)',
  `CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(body, message_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2')`,
  `CREATE TABLE IF NOT EXISTS search_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // Who each message mentions (people, not the author), for every user's inbox.
  `CREATE TABLE IF NOT EXISTS message_mentions (message_id TEXT NOT NULL, user_id TEXT NOT NULL, ts INTEGER NOT NULL, channel_id TEXT NOT NULL, PRIMARY KEY (message_id, user_id))`,
  'CREATE INDEX IF NOT EXISTS message_mentions_user ON message_mentions (user_id, ts)',
]

// Bumped when what the index stores changes: the index is rebuilt once.
// 3: FTS rows keyed by the message id as rowid (deletes were full scans).
const INDEX_VERSION = '3'

type Row = {
  id: string
  channelId: string
  authorId: string
  content: string
  components: string
  embeds: string
  attachments: string
  timestamp: Date
  pinned: boolean
  type: number
}

export type SearchQuery = {
  text: string[]
  phrases: string[]
  from: string[]
  in: string[]
  has: string[]
  mentionsMe: boolean
  before: number | null
  after: number | null
}

const DAY = 86_400_000

export function parseQuery(input: string): SearchQuery {
  const query: SearchQuery = { text: [], phrases: [], from: [], in: [], has: [], mentionsMe: false, before: null, after: null }
  const tokens = input.match(/(\w+:"[^"]*"|\w+:\S+|"[^"]*"|\S+)/g) ?? []
  for (const token of tokens) {
    const filter = /^(from|in|has|mentions|before|after|during):(.+)$/i.exec(token)
    if (filter) {
      const key = filter[1]!.toLowerCase()
      const value = filter[2]!.replace(/^"|"$/g, '')
      const day = Date.parse(`${value}T00:00:00Z`)
      if (key === 'from') query.from.push(value.replace(/^@/, '').toLowerCase())
      else if (key === 'in') query.in.push(value.replace(/^#/, '').toLowerCase())
      else if (key === 'has') query.has.push(value.toLowerCase())
      else if (key === 'mentions') query.mentionsMe ||= ['me', '@me'].includes(value.toLowerCase())
      else if (!Number.isNaN(day)) {
        if (key === 'before') query.before = day
        if (key === 'after') query.after = day + DAY
        if (key === 'during') {
          query.after = day
          query.before = day + DAY
        }
      }
      continue
    }
    if (token.startsWith('"') && token.endsWith('"') && token.length > 2) query.phrases.push(token.slice(1, -1))
    else query.text.push(token)
  }
  return query
}

// FTS5 MATCH expression: every word is a prefix term, phrases stay exact.
export function ftsExpression(query: SearchQuery): string | null {
  const quote = (s: string) => `"${s.replace(/"/g, '""')}"`
  const words = query.text.map((word) => word.replace(/[^\p{L}\p{N}_-]+/gu, ' ').trim()).filter(Boolean).flatMap((w) => w.split(/\s+/)).filter((w) => /[\p{L}\p{N}]/u.test(w))
  const parts = [...words.map((word) => `${quote(word)}*`), ...query.phrases.filter((p) => p.trim()).map(quote)]
  return parts.length ? parts.join(' AND ') : null
}

export class SearchIndex {
  private queue: Promise<void> = Promise.resolve()
  private backfilling: Promise<void> = Promise.resolve()
  private stopped = false
  private unobserve: (() => void) | null = null

  constructor(private readonly hub: Hub) {}

  private get db() {
    return this.hub.store.db
  }

  async start() {
    for (const statement of SCHEMA) await this.db.execute(statement)
    const version = (await this.db.execute("SELECT value FROM search_meta WHERE key = 'version'")).rows[0]
    if (String(version?.['value'] ?? '') !== INDEX_VERSION) {
      for (const table of ['message_index', 'message_fts', 'message_mentions']) await this.db.execute(`DELETE FROM ${table}`)
      await this.db.execute("DELETE FROM search_meta WHERE key = 'cursor'")
      await this.db.execute({ sql: "INSERT INTO search_meta (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [INDEX_VERSION] })
    }
    // In the background: a rebuild of a large index must not hold up the hub's start.
    this.backfilling = this.backfill().catch((error) => console.error('[search]', error))
    this.unobserve = this.hub.twin.observeDispatches((event, data) => {
      const d = data as { id?: string; message_id?: string }
      if (event === 'MESSAGE_CREATE' || event === 'MESSAGE_UPDATE') this.enqueue(() => this.reindex(d.id!))
      else if (event === 'MESSAGE_DELETE') this.enqueue(() => this.remove(d.id!))
    })
  }

  // Stops at once: queued work is dropped (a restart's backfill picks up new messages).
  stop() {
    this.stopped = true
    this.unobserve?.()
  }

  // Messages written without a dispatch (a bulk import).
  queueIndex(messageId: string) {
    this.enqueue(() => this.reindex(messageId))
  }

  // Resolves when every queued index update has been written (tests).
  async flush() {
    await this.backfilling
    await this.queue
  }

  private enqueue(job: () => Promise<void>) {
    this.queue = this.queue.then(() => (this.stopped ? undefined : job())).catch((error) => console.error('[search]', error))
  }

  private async backfill() {
    const cursorRow = (await this.db.execute("SELECT value FROM search_meta WHERE key = 'cursor'")).rows[0]
    let cursor = cursorRow ? String(cursorRow['value']) : ''
    for (;;) {
      const rows = await this.hub.twin.prisma.message.findMany({ where: cursor ? { id: { gt: cursor } } : {}, orderBy: { id: 'asc' }, take: 500 })
      if (rows.length === 0) break
      if (this.stopped) return
      await this.writeMany(rows)
      cursor = rows.at(-1)!.id
      await this.db.execute({ sql: "INSERT INTO search_meta (key, value) VALUES ('cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [cursor] })
    }
  }

  private async reindex(messageId: string) {
    const row = await this.hub.twin.prisma.message.findUnique({ where: { id: messageId } })
    if (row) await this.write(row)
  }

  private async remove(messageId: string) {
    await this.db.batch(
      [
        { sql: 'DELETE FROM message_index WHERE message_id = ?', args: [messageId] },
        { sql: 'DELETE FROM message_fts WHERE rowid = CAST(? AS INTEGER)', args: [messageId] },
        { sql: 'DELETE FROM message_mentions WHERE message_id = ?', args: [messageId] },
      ],
      'write',
    )
  }

  private async write(row: Row) {
    await this.writeMany([row])
  }

  // Index many messages in one transaction (imports send thousands).
  async writeMany(rows: Row[]) {
    if (rows.length === 0) return
    const authorIds = [...new Set(rows.map((r) => r.authorId))]
    const bots = new Set((await this.hub.twin.prisma.user.findMany({ where: { id: { in: authorIds }, bot: true }, select: { id: true } })).map((u) => u.id))
    await this.db.batch(rows.flatMap((row) => this.statements(row, bots.has(row.authorId))), 'write')
  }

  private statements(row: Row, bot: boolean): InStatement[] {
    const components = JSON.parse(row.components) as unknown[]
    const embeds = JSON.parse(row.embeds) as Array<{ title?: string; description?: string }>
    const attachments = JSON.parse(row.attachments) as Array<{ filename?: string; content_type?: string }>
    const visible = getMessageVisibleText({ content: row.content, components })
    const body = [visible, ...embeds.flatMap((e) => [e.title ?? '', e.description ?? '']), ...attachments.map((a) => a.filename ?? '')].join('\n').trim()
    const mentioned = [...new Set([...`${row.content}\n${visible}`.matchAll(/<@!?(\d{5,20})>/g)].map((m) => m[1]!))].filter((id) => id !== row.authorId)
    const media = JSON.stringify(components)
    return [
      {
        sql: `INSERT INTO message_index (message_id, channel_id, author_id, bot, ts, has_file, has_image, has_link, mentions_owner, pinned)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(message_id) DO UPDATE SET has_file = excluded.has_file, has_image = excluded.has_image, has_link = excluded.has_link,
                pinned = excluded.pinned`,
        args: [
          row.id,
          row.channelId,
          row.authorId,
          bot ? 1 : 0,
          row.timestamp.getTime(),
          attachments.length > 0 || media.includes('"type":13') ? 1 : 0,
          attachments.some((a) => a.content_type?.startsWith('image/')) || media.includes('"type":12') ? 1 : 0,
          /https?:\/\//.test(body) ? 1 : 0,
          0,
          row.pinned ? 1 : 0,
        ],
      },
      { sql: 'DELETE FROM message_mentions WHERE message_id = ?', args: [row.id] },
      ...mentioned.map((userId) => ({ sql: 'INSERT INTO message_mentions (message_id, user_id, ts, channel_id) VALUES (?, ?, ?, ?)', args: [row.id, userId, row.timestamp.getTime(), row.channelId] })),
      { sql: 'DELETE FROM message_fts WHERE rowid = CAST(? AS INTEGER)', args: [row.id] },
      ...(body ? [{ sql: 'INSERT INTO message_fts (rowid, body, message_id) VALUES (CAST(? AS INTEGER), ?, ?)', args: [row.id, body, row.id] }] : []),
    ]
  }

  // Channel ids for in: filters: a channel name or id also covers its threads.
  private async channelScope(names: string[]): Promise<string[] | null> {
    if (names.length === 0) return null
    const channels = await this.hub.twin.prisma.channel.findMany({ where: { guildId: { in: [...this.hub.guildIds] } } })
    const picked = channels.filter((c) => names.some((n) => c.id === n || (c.name ?? '').toLowerCase() === n))
    const ids = new Set(picked.map((c) => c.id))
    for (const c of channels) if (c.parentId && ids.has(c.parentId)) ids.add(c.id)
    return [...ids]
  }

  // userId: whose "me" this is. channels: the channels and threads they can view; nothing else is searched.
  async search(input: string, { userId, channels, offset = 0, limit = 25, order = 'newest' }: { userId: string; channels: Set<string>; offset?: number; limit?: number; order?: 'newest' | 'oldest' }) {
    const query = parseQuery(input)
    const where: string[] = ['i.channel_id IN (SELECT value FROM json_each(?))']
    const args: Array<string | number> = [JSON.stringify([...channels])]
    const filters = where.length
    const fts = ftsExpression(query)
    if (fts) {
      where.push('i.message_id IN (SELECT message_id FROM message_fts WHERE message_fts MATCH ?)')
      args.push(fts)
    }
    if (query.from.length) {
      const users = await this.hub.twin.prisma.user.findMany()
      const ids = users
        .filter((u) => query.from.some((f) => u.id === f || u.username.toLowerCase() === f || (u.globalName ?? '').toLowerCase() === f || (f === 'me' && u.id === userId) || (f === 'bot' && u.bot)))
        .map((u) => u.id)
      where.push(`i.author_id IN (${ids.map(() => '?').join(',') || "''"})`)
      args.push(...ids)
    }
    const scope = await this.channelScope(query.in)
    if (scope) {
      where.push(`i.channel_id IN (${scope.map(() => '?').join(',') || "''"})`)
      args.push(...scope)
    }
    for (const has of query.has) {
      const column = { file: 'has_file', attachment: 'has_file', image: 'has_image', link: 'has_link', pin: 'pinned', pinned: 'pinned' }[has]
      if (column) where.push(`i.${column} = 1`)
    }
    if (query.mentionsMe) {
      where.push('i.message_id IN (SELECT message_id FROM message_mentions WHERE user_id = ?)')
      args.push(userId)
    }
    if (query.before !== null) {
      where.push('i.ts < ?')
      args.push(query.before)
    }
    if (query.after !== null) {
      where.push('i.ts >= ?')
      args.push(query.after)
    }
    if (where.length === filters) return { total: 0, results: [] as Array<{ messageId: string; snippet: string | null }> }
    const clause = where.join(' AND ')
    const total = Number((await this.db.execute({ sql: `SELECT count(*) n FROM message_index i WHERE ${clause}`, args })).rows[0]!['n'])
    const rows = await this.db.execute({
      sql: `SELECT i.message_id, ${fts ? "(SELECT snippet(message_fts, 0, '**', '**', '…', 16) FROM message_fts WHERE message_fts MATCH ? AND rowid = CAST(i.message_id AS INTEGER))" : 'NULL'} AS snippet
            FROM message_index i WHERE ${clause} ORDER BY i.ts ${order === 'oldest' ? 'ASC' : 'DESC'}, i.message_id ${order === 'oldest' ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`,
      args: [...(fts ? [fts] : []), ...args, Math.min(limit, 50), offset],
    })
    return { total, results: rows.rows.map((r) => ({ messageId: String(r['message_id']), snippet: r['snippet'] == null ? null : String(r['snippet']) })) }
  }

  // Mentions of a user in channels they can view, newest first: every unread
  // one (what the badges count), then read ones from the last `days`.
  async mentions(userId: string, channels: Set<string>, read: Record<string, string>, { days = 14, limit = 100 }: { days?: number; limit?: number } = {}) {
    const rows = await this.db.execute({
      sql: 'SELECT message_id, channel_id, ts FROM message_mentions WHERE user_id = ? AND channel_id IN (SELECT value FROM json_each(?)) ORDER BY ts DESC',
      args: [userId, JSON.stringify([...channels])],
    })
    const since = Date.now() - days * DAY
    const newer = (a: string, b: string | undefined) => !b || a.length > b.length || (a.length === b.length && a > b)
    return rows.rows
      .map((r) => ({ messageId: String(r['message_id']), channelId: String(r['channel_id']), ts: Number(r['ts']) }))
      .filter((m) => newer(m.messageId, read[m.channelId]) || m.ts >= since)
      .slice(0, limit)
  }

  // Unread mentions of a user per channel, against their read positions.
  async mentionCounts(userId: string, read: Record<string, string>, channels: Set<string>): Promise<Record<string, number>> {
    const rows = await this.db.execute({ sql: 'SELECT message_id, channel_id FROM message_mentions WHERE user_id = ?', args: [userId] })
    const counts: Record<string, number> = {}
    const newer = (a: string, b: string | undefined) => !b || a.length > b.length || (a.length === b.length && a > b)
    for (const r of rows.rows) {
      const channel = String(r['channel_id'])
      if (channels.has(channel) && newer(String(r['message_id']), read[channel])) counts[channel] = (counts[channel] ?? 0) + 1
    }
    return counts
  }
}
