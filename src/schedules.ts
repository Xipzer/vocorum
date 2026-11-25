// Scheduled messages and reminders, per person.
// - A scheduled message is posted as its author at the set time (once, or on a
//   cron schedule in UTC), through the same checks as sending it by hand. In a
//   machine's channel or thread the agent takes it as a prompt, the way Kimaki's
//   own --send-at routines do.
// - A reminder notifies its owner about a message (or with a note) at the set
//   time, through the normal notification path.

import crypto from 'node:crypto'
import type http from 'node:http'
import { HttpError } from './auth.ts'
import { match, readJson } from './http.ts'
import type { Hub } from './hub.ts'
import type { Viewer } from './client-api.ts'
import { P } from './access.ts'

export type ScheduleKind = 'message' | 'reminder'
export type Schedule = {
  id: string
  user_id: string
  kind: ScheduleKind
  channel_id: string
  message_id: string | null
  content: string
  cron: string | null
  next_at: number | null
  status: 'pending' | 'done' | 'failed' | 'cancelled'
  last_run_at: number | null
  last_result: string | null
  created_at: number
}

const MAX_PER_PERSON = 100
const MAX_WAIT_MS = 60 * 60_000

// --- cron (minute hour day-of-month month day-of-week, UTC, like Kimaki routines)

// Day of week 0-7, where 7 is Sunday again.
const FIELDS: Array<[min: number, max: number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]

export function parseCron(expression: string): Array<Set<number>> | null {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const sets: Array<Set<number>> = []
  for (const [index, part] of parts.entries()) {
    const [min, max] = FIELDS[index]!
    const set = new Set<number>()
    for (const item of part.split(',')) {
      const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(item)
      if (!m) return null
      const start = m[1] === '*' ? min : Number(m[1])
      const end = m[2] !== undefined ? Number(m[2]) : m[1] === '*' || m[3] !== undefined ? max : start
      const step = m[3] !== undefined ? Number(m[3]) : 1
      if (start < min || end > max || start > end || step < 1) return null
      for (let v = start; v <= end; v += step) set.add(index === 4 && v === 7 ? 0 : v)
    }
    sets.push(set)
  }
  return sets
}

// The first minute strictly after `after` that the expression matches.
export function nextCron(expression: string, after: number): number | null {
  const sets = parseCron(expression)
  if (!sets) return null
  const [minutes, hours, days, months, weekdays] = sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>]
  const anyDay = days.size === 31
  const anyWeekday = [0, 1, 2, 3, 4, 5, 6].every((d) => weekdays.has(d))
  const t = new Date(Math.floor(after / 60_000) * 60_000 + 60_000)
  // Within five years: an impossible date (30 February) ends the search quickly.
  const limit = after + 5 * 366 * 86_400_000
  for (let i = 0; i < 366 * 24 * 60 && t.getTime() <= limit; i++) {
    if (!months.has(t.getUTCMonth() + 1)) {
      t.setUTCMonth(t.getUTCMonth() + 1, 1)
      t.setUTCHours(0, 0, 0, 0)
      continue
    }
    // Like cron: with both day fields restricted, either one matching is enough.
    const dayOk = anyDay && anyWeekday ? true : anyDay ? weekdays.has(t.getUTCDay()) : anyWeekday ? days.has(t.getUTCDate()) : days.has(t.getUTCDate()) || weekdays.has(t.getUTCDay())
    if (!dayOk) {
      t.setUTCDate(t.getUTCDate() + 1)
      t.setUTCHours(0, 0, 0, 0)
      continue
    }
    if (!hours.has(t.getUTCHours())) {
      t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0)
      continue
    }
    if (minutes.has(t.getUTCMinutes())) return t.getTime()
    t.setTime(t.getTime() + 60_000)
  }
  return null
}

// A reminder as the client sees it.
function reminderOf(s: Schedule) {
  return { id: s.id, channel_id: s.channel_id, message_id: s.message_id, at: s.next_at ?? s.last_run_at, note: s.content || null, created_at: s.created_at }
}

// --- the scheduler

export class Schedules {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> = Promise.resolve()

  constructor(private readonly hub: Hub) {}

  private get db() {
    return this.hub.store.db
  }

  async start() {
    await this.db.execute(`CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, channel_id TEXT NOT NULL,
      message_id TEXT, content TEXT NOT NULL DEFAULT '', cron TEXT, next_at INTEGER,
      status TEXT NOT NULL, last_run_at INTEGER, last_result TEXT, created_at INTEGER NOT NULL
    )`)
    this.arm()
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private async rows(where: string, args: Array<string | number>) {
    return (await this.db.execute({ sql: `SELECT * FROM schedules WHERE ${where}`, args })).rows.map((r) => ({
      id: String(r['id']),
      user_id: String(r['user_id']),
      kind: String(r['kind']) as ScheduleKind,
      channel_id: String(r['channel_id']),
      message_id: r['message_id'] == null ? null : String(r['message_id']),
      content: String(r['content']),
      cron: r['cron'] == null ? null : String(r['cron']),
      next_at: r['next_at'] == null ? null : Number(r['next_at']),
      status: String(r['status']) as Schedule['status'],
      last_run_at: r['last_run_at'] == null ? null : Number(r['last_run_at']),
      last_result: r['last_result'] == null ? null : String(r['last_result']),
      created_at: Number(r['created_at']),
    }))
  }

  // Wakes at the next due time (at most an hour away, so clock changes are caught).
  private arm() {
    if (this.timer) clearTimeout(this.timer)
    void this.db.execute("SELECT MIN(next_at) AS next FROM schedules WHERE status = 'pending'").then((r) => {
      const next = r.rows[0]?.['next'] == null ? null : Number(r.rows[0]!['next'])
      const wait = next === null ? MAX_WAIT_MS : Math.max(0, Math.min(MAX_WAIT_MS, next - Date.now()))
      this.timer = setTimeout(() => {
        this.running = this.running.then(() => this.runDue()).catch((error) => console.error('[schedules]', error)).finally(() => this.arm())
      }, wait)
      this.timer.unref()
    })
  }

  // Runs everything due now (also used by tests).
  async runDue(now = Date.now()) {
    for (const s of await this.rows("status = 'pending' AND next_at <= ? ORDER BY next_at", [now])) {
      let result = 'ok'
      let failed = false
      // Only for a person who can still sign in: removing someone or revoking
      // their last device ends their schedules too.
      if (!(await this.hasDevice(s.user_id))) {
        await this.db.execute({ sql: "UPDATE schedules SET status = 'failed', next_at = NULL, last_run_at = ?, last_result = ? WHERE id = ?", args: [now, 'No signed-in device', s.id] })
        continue
      }
      try {
        result = await this.fire(s)
      } catch (error) {
        failed = true
        result = error instanceof Error ? error.message : String(error)
      }
      const next = s.cron ? nextCron(s.cron, Math.max(now, s.next_at ?? now)) : null
      const status = next !== null ? 'pending' : failed ? 'failed' : 'done'
      await this.db.execute({ sql: 'UPDATE schedules SET status = ?, next_at = ?, last_run_at = ?, last_result = ? WHERE id = ?', args: [status, next, now, result.slice(0, 500), s.id] })
      this.changed(s.user_id, s.id)
    }
  }

  private async hasDevice(userId: string) {
    return (await this.hub.store.listDevices()).some((d) => !d.revokedAt && this.hub.userOf(d) === userId)
  }

  private async fire(s: Schedule): Promise<string> {
    const viewer: Viewer = { userId: s.user_id, device: { id: 'schedule', name: 'schedule', userId: s.user_id, kind: 'web', createdAt: 0, lastSeenAt: null, revokedAt: null } }
    if (s.kind === 'message') {
      const message = await this.hub.api.postMessage(viewer, s.channel_id, { content: s.content })
      return `posted ${message.id}`
    }
    // A reminder: only about something the person can still see.
    if (!(await this.hub.access.can(s.user_id, s.channel_id, 0n))) throw new Error('The channel is no longer visible')
    const target = s.message_id ? await this.hub.twin.prisma.message.findUnique({ where: { id: s.message_id } }) : null
    const excerpt = (target?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
    const body = s.content || excerpt || 'Reminder'
    const where = await this.hub.notifications.chain(s.channel_id)
    await this.hub.notifications.pushAll(
      { kind: 'reminder', title: 'Reminder', body, tag: `reminder-${s.id}`, url: `/?channel=${s.channel_id}${s.message_id ? `&message=${s.message_id}` : ''}`, channel_id: s.channel_id, guild_id: where?.guildId ?? null, message_id: s.message_id },
      { userId: s.user_id },
    )
    this.hub.events.send('REMINDER_DUE', { reminder: { ...reminderOf(s), due: true } }, { userId: s.user_id })
    return 'reminded'
  }

  private changed(userId: string, id: string) {
    void this.rows('id = ?', [id])
      .then((rows) => this.withMessages(userId, rows))
      .then(([s]) => s && this.hub.events.send('SCHEDULE_UPDATE', s, { userId }))
  }

  // The message a reminder is about, as a short excerpt, when the person can still see it.
  private async withMessages(userId: string, rows: Schedule[]) {
    const ids = [...new Set(rows.flatMap((r) => (r.message_id ? [r.message_id] : [])))]
    const messages = ids.length ? await this.hub.twin.prisma.message.findMany({ where: { id: { in: ids } } }) : []
    const authors = new Map((await this.hub.twin.prisma.user.findMany({ where: { id: { in: [...new Set(messages.map((m) => m.authorId))] } } })).map((u) => [u.id, u]))
    const byId = new Map(messages.map((m) => [m.id, m]))
    const out = []
    for (const r of rows) {
      const m = r.message_id ? byId.get(r.message_id) : undefined
      const visible = m && (await this.hub.access.can(userId, m.channelId, 0n))
      const author = m ? authors.get(m.authorId) : undefined
      out.push({ ...r, message: visible && m ? { content: m.content.replace(/\s+/g, ' ').trim().slice(0, 160), author: author ? { id: author.id, username: author.username, global_name: author.globalName ?? null } : null } : null })
    }
    return out
  }

  async create(v: Viewer, body: Record<string, unknown>) {
    const kind = body['kind'] === 'reminder' ? 'reminder' : body['kind'] === 'message' ? 'message' : null
    if (!kind) throw new HttpError(400, 'kind must be message or reminder')
    const channelId = typeof body['channel_id'] === 'string' && /^\d{1,20}$/.test(body['channel_id']) ? body['channel_id'] : null
    if (!channelId || !(await this.hub.access.can(v.userId, channelId, 0n))) throw new HttpError(404, 'Unknown channel')
    const content = typeof body['content'] === 'string' ? body['content'].slice(0, 4000) : ''
    const messageId = typeof body['message_id'] === 'string' && /^\d{1,20}$/.test(body['message_id']) ? body['message_id'] : null
    if (kind === 'message') {
      if (!content.trim()) throw new HttpError(400, 'content is required')
      const thread = (await this.hub.twin.prisma.channel.findUnique({ where: { id: channelId } }))?.type
      if (!(await this.hub.access.can(v.userId, channelId, thread === 11 || thread === 12 || thread === 10 ? P.SEND_MESSAGES_IN_THREADS : P.SEND_MESSAGES))) throw new HttpError(403, 'You cannot send messages here')
    }
    if (kind === 'reminder' && messageId) {
      const target = await this.hub.twin.prisma.message.findUnique({ where: { id: messageId } })
      if (!target || target.channelId !== channelId) throw new HttpError(404, 'Unknown message')
    }
    const cron = typeof body['cron'] === 'string' && body['cron'].trim() ? body['cron'].trim() : null
    const at = typeof body['at'] === 'number' ? body['at'] : typeof body['at'] === 'string' ? Date.parse(body['at']) : NaN
    let next: number | null
    if (cron) {
      if (!parseCron(cron)) throw new HttpError(400, 'cron must be five fields: minute hour day month weekday (UTC)')
      next = nextCron(cron, Date.now())
      if (next === null) throw new HttpError(400, 'cron never matches a date')
    } else {
      if (!Number.isFinite(at) || at < Date.now() - 60_000) throw new HttpError(400, 'at must be a time in the future')
      next = at
    }
    const count = Number((await this.db.execute({ sql: "SELECT COUNT(*) AS n FROM schedules WHERE user_id = ? AND status = 'pending'", args: [v.userId] })).rows[0]?.['n'] ?? 0)
    if (count >= MAX_PER_PERSON) throw new HttpError(429, `At most ${MAX_PER_PERSON} pending schedules`)
    const id = crypto.randomUUID()
    await this.db.execute({ sql: "INSERT INTO schedules (id, user_id, kind, channel_id, message_id, content, cron, next_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)", args: [id, v.userId, kind, channelId, messageId, content, cron, next, Date.now()] })
    this.arm()
    this.changed(v.userId, id)
    return (await this.rows('id = ?', [id]))[0]
  }

  // /client/reminders: the reminder view of the same rows. A fired reminder
  // stays listed (due: true) until it is deleted (done) or snoozed (PATCH at).
  private async reminders(req: http.IncomingMessage, pathname: string, v: Viewer) {
    const method = req.method ?? 'GET'
    if (pathname === '/client/reminders' && method === 'GET') {
      return { reminders: (await this.rows("user_id = ? AND kind = 'reminder' AND cron IS NULL AND status IN ('pending', 'done') ORDER BY COALESCE(next_at, last_run_at)", [v.userId])).map((s) => ({ ...reminderOf(s), due: s.status === 'done' })) }
    }
    if (pathname === '/client/reminders' && method === 'POST') {
      const body = await readJson(req)
      const created = (await this.create(v, { kind: 'reminder', channel_id: body['channel_id'], message_id: body['message_id'], content: typeof body['note'] === 'string' ? body['note'] : '', at: body['at'] }))!
      const reminder = { ...reminderOf(created), due: false }
      this.hub.events.send('REMINDER_CREATE', reminder, { userId: v.userId })
      return reminder
    }
    const params = match('/client/reminders/:id', pathname)
    const [row] = params ? await this.rows("id = ? AND user_id = ? AND kind = 'reminder' AND status IN ('pending', 'done')", [params['id']!, v.userId]) : []
    if (!params || !row) throw new HttpError(404, 'Unknown reminder')
    if (method === 'DELETE') {
      await this.db.execute({ sql: "UPDATE schedules SET status = 'cancelled', next_at = NULL WHERE id = ?", args: [row.id] })
      this.arm()
      this.hub.events.send('REMINDER_DELETE', { id: row.id }, { userId: v.userId })
      return { deleted: row.id }
    }
    if (method === 'PATCH') {
      const body = await readJson(req)
      const at = typeof body['at'] === 'number' ? body['at'] : typeof body['at'] === 'string' ? Date.parse(body['at']) : NaN
      if (!Number.isFinite(at) || at < Date.now() - 60_000) throw new HttpError(400, 'at must be a time in the future')
      await this.db.execute({ sql: "UPDATE schedules SET status = 'pending', next_at = ? WHERE id = ?", args: [at, row.id] })
      this.arm()
      const [updated] = await this.rows('id = ?', [row.id])
      const reminder = { ...reminderOf(updated!), due: false }
      this.hub.events.send('REMINDER_UPDATE', reminder, { userId: v.userId })
      return reminder
    }
    throw new HttpError(405, 'Method not allowed')
  }

  // /client/schedules (scheduled messages and reminders) and /client/reminders: the viewer's own only.
  async handleClient(req: http.IncomingMessage, pathname: string, v: Viewer): Promise<unknown | undefined> {
    if (pathname === '/client/reminders' || pathname.startsWith('/client/reminders/')) return this.reminders(req, pathname, v)
    if (!pathname.startsWith('/client/schedules')) return undefined
    const method = req.method ?? 'GET'
    if (pathname === '/client/schedules' && method === 'GET') return { schedules: await this.withMessages(v.userId, await this.rows("user_id = ? AND status NOT IN ('cancelled', 'dismissed') ORDER BY COALESCE(next_at, last_run_at)", [v.userId])) }
    if (pathname === '/client/schedules' && method === 'POST') return this.create(v, await readJson(req))
    const params = match('/client/schedules/:id', pathname)
    // Cancels a pending one; a reminder that already fired is dismissed (done on every device).
    if (params && method === 'DELETE') {
      const result = await this.db.execute({ sql: "UPDATE schedules SET status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE 'dismissed' END, next_at = NULL WHERE id = ? AND user_id = ? AND (status = 'pending' OR (kind = 'reminder' AND status = 'done'))", args: [params['id']!, v.userId] })
      if (result.rowsAffected === 0) throw new HttpError(404, 'Unknown schedule')
      this.arm()
      this.changed(v.userId, params['id']!)
      return { cancelled: params['id'] }
    }
    // A new time: snoozes a fired reminder (back to pending) or moves a pending one-off.
    if (params && method === 'PATCH') {
      const body = await readJson(req)
      const at = typeof body['at'] === 'number' ? body['at'] : typeof body['at'] === 'string' ? Date.parse(body['at']) : NaN
      if (!Number.isFinite(at) || at < Date.now() - 60_000) throw new HttpError(400, 'at must be a time in the future')
      const result = await this.db.execute({ sql: "UPDATE schedules SET status = 'pending', next_at = ? WHERE id = ? AND user_id = ? AND cron IS NULL AND (status = 'pending' OR (kind = 'reminder' AND status = 'done'))", args: [at, params['id']!, v.userId] })
      if (result.rowsAffected === 0) throw new HttpError(404, 'Unknown schedule')
      this.arm()
      this.changed(v.userId, params['id']!)
      return (await this.withMessages(v.userId, await this.rows('id = ?', [params['id']!])))[0]
    }
    throw new HttpError(404, 'Not found')
  }
}
