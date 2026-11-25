// One bot-owned markdown document per thread. Only authenticated channel writes can
// publish it; reading history, mirroring a message and opening a panel never publish.
import fs from 'node:fs'
import path from 'node:path'
import type { APIAttachment, APIMessage } from 'discord-api-types/v10'
import type { ChannelMessageWrite } from 'discord-digital-twin/src/server'
import { P } from './access.ts'
import { HttpError } from './auth.ts'
import { SECRET_PATTERNS } from './discord/local.ts'
import type { Hub } from './hub.ts'

export const BOARD_FILE = 'board.panel.md'
export const BOARD_UPLOAD = 'panel:board'
const BYTES = 16 * 1024
const THREADS = [10, 11, 12]
const WRITE = P.READ_MESSAGE_HISTORY | P.SEND_MESSAGES_IN_THREADS | P.ATTACH_FILES
const isBoard = (a: APIAttachment) => a.filename === BOARD_FILE
const validVersion = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0

function reject(status: number, message: string): never {
  throw Response.json({ message }, { status })
}

function mask(text: string) {
  // The import scanner flags the PEM header; here we must also remove the material.
  let safe = text.replace(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g, '[redacted]')
  safe = safe.replace(/^[ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|SEED|MNEMONIC|PRIVATE)[A-Z0-9_]*[ \t]*=[^\n]*/gmi, '[redacted]')
  for (const regex of Object.values(SECRET_PATTERNS)) safe = safe.replace(regex, '[redacted]')
  return safe
}

function parse(data: Buffer) {
  if (data.length > BYTES) reject(413, 'Board exceeds 16 KiB')
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/\r\n/g, '\n') } catch { return reject(400, 'Board must be UTF-8') }
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text)) reject(400, 'Invalid board text')
  const header = /^---\n([\s\S]{1,1024}?)\n---(?:\n|$)/.exec(text)
  if (!header) reject(400, 'A board header is required')
  const fields = new Map<string, string>()
  for (const line of header[1]!.split('\n')) {
    const field = /^(panel|title|v):[ \t]*(.+?)\s*$/.exec(line)
    if (!field || fields.has(field[1]!)) reject(400, 'Invalid board header')
    fields.set(field[1]!, field[2]!)
  }
  const v = Number(fields.get('v'))
  if (fields.get('panel') !== 'board' || !/^[1-9]\d*$/.test(fields.get('v') ?? '') || !validVersion(v)) reject(400, 'Invalid board slot or version')
  let title = fields.get('title') ?? ''
  if (title.startsWith('"')) {
    try { title = JSON.parse(title) } catch { return reject(400, 'Invalid board title') }
  } else if (title.startsWith("'")) {
    if (!title.endsWith("'")) reject(400, 'Invalid board title')
    title = title.slice(1, -1).replace(/''/g, "'")
  }
  if (typeof title !== 'string' || !title.trim() || /[\x00-\x1f\x7f]/.test(title) || Buffer.byteLength(title) > 256) reject(400, 'Invalid board title')
  const safeTitle = mask(title.trim()), markdown = mask(text.slice(header[0].length))
  // Keep a valid document exactly at the byte limit valid. Re-encode the title only
  // if redaction changed it (including a value escaped inside a quoted title).
  const prefix = safeTitle === title.trim() ? header[0] : header[0].replace(/^title:[^\n]*/m, () => `title: ${JSON.stringify(safeTitle)}`)
  return { v, title: safeTitle, markdown, clean: prefix + markdown }
}

// Scrub the carrier itself before AttachmentStore can make it downloadable. Do not
// follow paths or URLs supplied in front matter or message metadata.
export function safeBoardUpload(data: Buffer) {
  const clean = Buffer.from(parse(data).clean)
  if (clean.length > BYTES) reject(413, 'Board exceeds 16 KiB')
  return clean
}

export class WorkspaceBoards {
  private pending = new Map<string, Promise<unknown>>()
  constructor(private readonly hub: Hub) {}
  private get db() { return this.hub.store.db }

  async init() {
    await this.db.batch([
      `CREATE TABLE IF NOT EXISTS panels(thread TEXT PRIMARY KEY,machine TEXT NOT NULL,author TEXT NOT NULL,message TEXT NOT NULL,v INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS panel_versions(thread TEXT NOT NULL,v INTEGER NOT NULL,title TEXT NOT NULL,markdown TEXT NOT NULL,updated_at TEXT NOT NULL,attachment TEXT NOT NULL UNIQUE,PRIMARY KEY(thread,v))`,
      `CREATE TABLE IF NOT EXISTS panel_seen(device TEXT NOT NULL,thread TEXT NOT NULL,v INTEGER NOT NULL,PRIMARY KEY(device,thread))`,
    ])
  }

  private serial<T>(thread: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.pending.get(thread) ?? Promise.resolve()).catch(() => {}).then(fn)
    this.pending.set(thread, next)
    return next.finally(() => { if (this.pending.get(thread) === next) this.pending.delete(thread) })
  }

  private async thread(id: string) {
    const row = await this.hub.twin.prisma.channel.findUnique({ where: { id }, select: { guildId: true, type: true, archived: true, locked: true } })
    return row?.guildId && this.hub.guildIds.has(row.guildId) && THREADS.includes(row.type) ? row : null
  }

  async canRead(userId: string, thread: string) {
    return Boolean(await this.thread(thread)) && await this.hub.access.can(userId, thread, P.READ_MESSAGE_HISTORY)
  }

  async fileThread(id: string) {
    const result = await this.db.execute({ sql: 'SELECT thread FROM panel_versions WHERE attachment=?', args: [id] })
    return result.rows[0] ? String(result.rows[0].thread) : null
  }

  // Only our freshly minted carrier uploads can be reclaimed. Normal attachments
  // and files referenced by retained versions never enter this cleanup.
  private async discard(id: string) {
    if (!/^\d{1,20}$/.test(id)) return
    const result = await this.db.execute({ sql: `DELETE FROM attachments WHERE id=? AND uploaded_by=? AND filename=?
      AND NOT EXISTS (SELECT 1 FROM panel_versions WHERE attachment=?)`, args: [id, BOARD_UPLOAD, BOARD_FILE, id] })
    if (result.rowsAffected) {
      const dir = path.join(this.hub.options.paths.attachments, id)
      await fs.promises.rm(path.join(dir, BOARD_FILE), { force: true })
      await fs.promises.rmdir(dir).catch(() => {})
    }
  }

  async read(thread: string, device: string) {
    const [head, versions, seen] = await this.db.batch([
      { sql: 'SELECT thread AS thread_id,message AS message_id,machine FROM panels WHERE thread=?', args: [thread] },
      { sql: 'SELECT v,title,markdown,updated_at FROM panel_versions WHERE thread=? ORDER BY v', args: [thread] },
      { sql: 'SELECT v FROM panel_seen WHERE device=? AND thread=?', args: [device, thread] },
    ], 'read')
    return { board: head!.rows[0] ? { ...head!.rows[0], versions: versions!.rows } : null, seen_version: seen!.rows[0]?.v ?? null }
  }

  async seen(thread: string, device: string, value: unknown) {
    if (!validVersion(value)) throw new HttpError(400, 'v must be a positive integer')
    const result = await this.db.execute({
      sql: `INSERT INTO panel_seen(device,thread,v) SELECT ?,thread,v FROM panel_versions WHERE thread=? AND v=?
            ON CONFLICT(device,thread) DO UPDATE SET v=max(panel_seen.v,excluded.v)`, args: [device, thread, value],
    })
    if (!result.rowsAffected) throw new HttpError(409, 'Refresh the board version')
  }

  private changed(thread: string, v: number) {
    const d = { thread_id: thread, slot: 'board', v }
    this.hub.events.send('PANEL_UPDATE', d, { channelId: thread, shape: async user => await this.canRead(user, thread) ? d : null })
  }

  private async clear(thread: string) {
    const old = await this.db.execute({ sql: 'SELECT attachment FROM panel_versions WHERE thread=?', args: [thread] })
    await this.db.batch(['panels', 'panel_versions', 'panel_seen'].map(table => ({ sql: `DELETE FROM ${table} WHERE thread=?`, args: [thread] })))
    for (const r of old.rows) await this.discard(String(r.attachment))
  }

  async removeCarrier(machine: string | undefined, m: Pick<ChannelMessageWrite, 'authorId' | 'channelId' | 'messageId'>, remove: () => Promise<Response>) {
    return this.serial(m.channelId, async () => {
      const { rows } = await this.db.execute({ sql: 'SELECT machine,author,v FROM panels WHERE thread=? AND message=?', args: [m.channelId, m.messageId] })
      const head = rows[0]
      if (!head) return remove()
      const thread = await this.thread(m.channelId)
      if (!machine || machine !== head.machine || m.authorId !== head.author || !thread || thread.locked || thread.archived || !await this.hub.access.can(m.authorId, m.channelId, WRITE)) reject(403, 'Board is not writable by this bot')
      const result = await remove()
      await this.clear(m.channelId)
      this.changed(m.channelId, Number(head.v))
      return result
    })
  }

  async removed(thread: string, message?: string) {
    await this.serial(thread, async () => {
      if (!message) return this.clear(thread)
      const { rows } = await this.db.execute({ sql: 'SELECT v FROM panels WHERE thread=? AND message=?', args: [thread, message] })
      if (rows[0]) { await this.clear(thread); this.changed(thread, Number(rows[0].v)) }
    })
  }

  // The writer is the registered machine AND its bot user: the first accepted board
  // fixes both. Bots can share one visible user, so the user alone is not proof.
  // Any other message passes straight through.
  async write(machine: string | undefined, m: ChannelMessageWrite, write: () => Promise<APIMessage>): Promise<APIMessage> {
    const board = m.uploaded.filter(isBoard), carrier = m.previous.some(isBoard) || board.length !== 0
    if (!carrier) return write()
    const id = m.channelId, author = m.authorId
    return this.serial(id, async () => {
      if (!machine) reject(403, 'Registered thread bot required')
      const thread = await this.thread(id)
      if (!thread) reject(403, 'Boards belong to threads')
      if (thread.archived || thread.locked || !(await this.hub.access.can(author, id, WRITE))) reject(403, 'Thread is not writable')
      const head = (await this.db.execute({ sql: 'SELECT * FROM panels WHERE thread=?', args: [id] })).rows[0]
      if (head && (head.machine !== machine || head.author !== author)) reject(403, 'Board belongs to another bot')
      if (head && m.edit && head.message !== m.messageId) reject(409, 'Edit the existing board message')
      if (m.attachments.filter(isBoard).length > 1) reject(400, 'Use one board attachment')
      if (!board.length) {
        const msg = await write()
        if (head && !m.attachments.some(isBoard)) { await this.clear(id); this.changed(id, Number(head.v)) }
        return msg
      }
      const upload = board[0]!
      // readMessageBody supplies freshly minted IDs only for actual multipart bytes.
      const row = /^\d{1,20}$/.test(upload.id) && await this.hub.store.getAttachment(upload.id)
      if (!row || row.uploadedBy !== BOARD_UPLOAD || row.filename !== BOARD_FILE || row.size > BYTES) reject(400, 'A local board attachment is required')
      const file = path.join(this.hub.options.paths.attachments, upload.id, BOARD_FILE)
      const fd = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)).catch(() => null)
      if (!fd) reject(400, 'Board file unavailable')
      let doc: ReturnType<typeof parse>
      try {
        const stat = await fd.stat()
        if (!stat.isFile() || stat.size !== row.size || stat.size > BYTES) reject(400, 'Invalid local board attachment')
        const buf = Buffer.alloc(stat.size + 1)
        if ((await fd.read(buf, 0, buf.length, 0)).bytesRead !== stat.size) reject(400, 'Board file changed')
        doc = parse(buf.subarray(0, stat.size))
      } finally { await fd.close() }
      if (head && doc.v <= Number(head.v)) {
        const prev = (await this.db.execute({ sql: 'SELECT title,markdown FROM panel_versions WHERE thread=? AND v=?', args: [id, doc.v] })).rows[0]
        if (doc.v !== Number(head.v) || prev?.title !== doc.title || prev?.markdown !== doc.markdown) reject(409, 'Stale or conflicting board version')
        // A retry is a receipt for the existing carrier, not another edit or event.
        const existing = await this.hub.twin.prisma.message.findUnique({ where: { id: String(head.message) }, include: { channel: true } })
        const user = existing && await this.hub.twin.prisma.user.findUnique({ where: { id: author } })
        if (!existing || !user) reject(409, 'Board carrier no longer exists')
        const { messageToAPI } = await import('discord-digital-twin/src/serializers')
        return messageToAPI(existing, user, existing.channel.guildId ?? undefined)
      }
      if (head && !m.edit) reject(409, 'Edit the existing board message')
      const stale = await this.db.execute({ sql: 'SELECT attachment FROM panel_versions WHERE thread=? ORDER BY v DESC LIMIT -1 OFFSET 19', args: [id] })
      const msg = await write()
      const updated = new Date(msg.edited_timestamp ?? msg.timestamp).toISOString()
      await this.db.batch([
        { sql: 'INSERT INTO panels VALUES(?,?,?,?,?) ON CONFLICT(thread) DO UPDATE SET v=excluded.v', args: [id, machine, author, m.messageId, doc.v] },
        { sql: 'INSERT INTO panel_versions VALUES(?,?,?,?,?,?)', args: [id, doc.v, doc.title, doc.markdown, updated, upload.id] },
        { sql: 'DELETE FROM panel_versions WHERE thread=? AND v < (SELECT v FROM panel_versions WHERE thread=? ORDER BY v DESC LIMIT 1 OFFSET 19)', args: [id, id] },
      ])
      this.changed(id, doc.v)
      for (const r of stale.rows) await this.discard(String(r.attachment))
      return msg
    }).finally(async () => { for (const upload of board) await this.discard(upload.id) })
  }
}
