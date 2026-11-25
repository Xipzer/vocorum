// Kimaki's own scheduled routines, shown read-only next to the hub's
// schedules. Each machine's hub Kimaki sends its full list (at start and on
// change); editing stays in Kimaki. A person sees a routine only when they can
// view the channel or thread it posts in.

import type http from 'node:http'
import { HttpError } from './auth.ts'
import { readJson } from './http.ts'
import type { Hub } from './hub.ts'

export type Routine = {
  id: string
  prompt: string
  schedule: string
  channel_id: string | null
  thread_id: string | null
  agent: string | null
  model: string | null
  next_run: string | null
  status: string | null
}

const MAX_ROUTINES = 500
const id = (value: unknown) => (typeof value === 'string' && /^\d{1,20}$/.test(value) ? value : null)
const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : null)

export class Routines {
  constructor(private readonly hub: Hub) {}

  async start() {
    await this.hub.store.db.execute(`CREATE TABLE IF NOT EXISTS machine_routines (
      machine TEXT PRIMARY KEY, routines TEXT NOT NULL, updated_at INTEGER NOT NULL
    )`)
  }

  // PUT /hub/mirror/routines from a machine's bot: replaces that machine's list.
  async put(machine: string, req: http.IncomingMessage) {
    const body = await readJson(req)
    if (!Array.isArray(body['routines'])) throw new HttpError(400, 'routines must be a list')
    if (body['routines'].length > MAX_ROUTINES) throw new HttpError(400, `At most ${MAX_ROUTINES} routines`)
    const routines: Routine[] = (body['routines'] as Array<Record<string, unknown>>).map((r) => {
      const routineId = text(r?.['id'], 100)
      if (!routineId) throw new HttpError(400, 'Every routine needs an id')
      return {
        id: routineId,
        prompt: text(r['prompt'], 2000) ?? '',
        schedule: text(r['schedule'], 200) ?? '',
        channel_id: id(r['channel_id']),
        thread_id: id(r['thread_id']),
        agent: text(r['agent'], 100),
        model: text(r['model'], 200),
        next_run: text(r['next_run'], 40),
        status: text(r['status'], 40),
      }
    })
    await this.hub.store.db.execute({ sql: 'INSERT INTO machine_routines (machine, routines, updated_at) VALUES (?, ?, ?) ON CONFLICT(machine) DO UPDATE SET routines = excluded.routines, updated_at = excluded.updated_at', args: [machine, JSON.stringify(routines), Date.now()] })
    this.hub.events.send('ROUTINES_UPDATE', { machine }, { shape: async (userId) => ({ machine, routines: await this.visible(userId, routines) }) })
    return { machine, routines: routines.length }
  }

  private async visible(userId: string, routines: Routine[]) {
    const out: Routine[] = []
    const threads = new Set((await this.hub.twin.prisma.channel.findMany({ where: { id: { in: routines.flatMap((r) => (r.thread_id ? [r.thread_id] : [])) } }, select: { id: true } })).map((c) => c.id))
    for (const r of routines) {
      // Its thread when the hub has it, else the channel it posts in (an older thread not mirrored).
      const where = r.thread_id && threads.has(r.thread_id) ? r.thread_id : r.channel_id
      if (where && (await this.hub.access.can(userId, where, 0n))) out.push(r)
    }
    return out
  }

  // GET /client/routines: every machine's routines the viewer may see.
  async list(userId: string) {
    const rows = await this.hub.store.db.execute('SELECT machine, routines, updated_at FROM machine_routines ORDER BY machine')
    const machines = []
    for (const row of rows.rows) {
      const routines = await this.visible(userId, JSON.parse(String(row['routines'])) as Routine[])
      if (routines.length) machines.push({ machine: String(row['machine']), updated_at: Number(row['updated_at']), routines })
    }
    return { machines }
  }
}
