// A read-only projection of the root execution in a Kimaki thread. The recorder already
// persists the source events across process restarts. Never substitute its write time,
// a snapshot's observation time, typing, a queue receipt or a chat timestamp for a start.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { kimakiDirs } from './links.ts'

const THREAD = /^\d{1,20}$/
const LIMIT = 48
const MAX_LINE = 256 * 1024
const MAX_FILE = 24 * 1024 * 1024 // recorder rolls over at 20 MiB
// Only a parsing filter. Binding, event type, durable sequence and time are checked
// inside fold. Skip unrelated records (in particular reasoning and text) wholesale.
const BOOKKEEPING =
  /"type"\s*:\s*"(?:kimaki\.snapshot|session\.(?:execution\.(?:started|succeeded|failed|interrupted)|inbox\.(?:enqueued|delivered|delivery\.changed|cancelled)|tool\.(?:input\.started|called|success|failed))|permission\.(?:asked|replied)|form\.(?:created|replied|cancelled))"/
const token = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,96}$/.test(v) ? v : null)
const millis = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v < 8.64e15 ? v : null)
type Run = {
  state: 'unknown' | 'idle' | 'running' | 'ended'
  id: string | null
  started_at: number | null
  ended_at: number | null
  outcome: 'succeeded' | 'interrupted' | 'failed' | null
  reason: string | null
}
type Receipt = { id: string; queued_at: number | null; delivery: 'queue' | 'steer' | null }
type Entry = { id: string; seq: number; at: number; kind: string; request_id?: string; tool?: string }
type Blocker = { kind: 'permission' | 'question'; id: string }
const emptyRun = (): Run => ({ state: 'unknown', id: null, started_at: null, ended_at: null, outcome: null, reason: null })
const model = () => ({
  run: emptyRun(),
  pending: new Map<string, Receipt>(),
  blockers: new Map<string, Blocker>(),
  tools: new Map<string, string>(),
  events: [] as Entry[],
  seq: -1,
  runSeq: -1,
  observedRunAt: 0,
  queueAt: 0,
  queueSnapshotAt: 0,
  queueComplete: false,
  blockerAt: 0,
  partial: false,
})
type Model = ReturnType<typeof model>
function bounded<T>(m: Model, map: Map<string, T>, id: string, v: T) {
  if (!map.has(id) && map.size >= LIMIT) {
    map.delete(map.keys().next().value!)
    m.partial = true
  }
  map.set(id, v)
}
const delivery = (v: unknown) => (v === 'steer' || v === 'queue' ? v : null)

// Consume only typed, public bookkeeping fields. In particular do not return prompts,
// tool arguments/results, private reasoning, free-form errors or the journal itself.
function fold(m: Model, root: string, e: any) {
  if (e?.type === 'kimaki.snapshot') {
    const at = millis(e.at)
    if (!at || !Array.isArray(e.activeSessionIds)) return
    if (at >= m.observedRunAt) {
      if (e.activeSessionIds.includes(root)) {
        // A recorder reconnect may have missed both an end and a new start. This
        // active-session list has no execution ID with which to bridge that gap.
        m.run = { ...emptyRun(), state: 'running' }
      } else if (m.run.state !== 'ended') m.run = { ...emptyRun(), state: 'idle' }
      m.observedRunAt = at
    }
    const s = Array.isArray(e.sessions) && e.sessions.find((v: any) => v?.sessionId === root)
    if (s && Array.isArray(s.inbox) && at >= m.queueAt) {
      m.queueAt = m.queueSnapshotAt = at
      m.pending.clear()
      m.queueComplete = true
      for (const i of s.inbox) {
        const id = token(i?.id)
        if (id && i.type === 'user') bounded(m, m.pending, id, { id, delivery: delivery(i.delivery), queued_at: millis(i.time?.created) })
      }
    }
    if (s && Array.isArray(s.permissions) && Array.isArray(s.forms) && at >= m.blockerAt) {
      m.blockerAt = at
      m.blockers.clear()
      for (const [kind, items] of [
        ['permission', s.permissions],
        ['question', s.forms],
      ] as const) {
        for (const item of items) {
          const id = token(item?.id)
          if (id) bounded(m, m.blockers, id, { id, kind })
        }
      }
    }
    return
  }
  const d = e?.data,
    seq = e?.durable?.seq,
    at = millis(e?.created),
    id = token(e?.id)
  if (!id || !at || !Number.isSafeInteger(seq) || seq < 0 || e.durable.aggregateID !== root || (d?.sessionID ?? d?.form?.sessionID) !== root) return
  const entry: Entry = { id, at, seq, kind: e.type }
  const lifecycle = [
    'session.execution.started',
    'session.execution.succeeded',
    'session.execution.failed',
    'session.execution.interrupted',
  ].includes(e.type)
  if (lifecycle) {
    if (seq <= m.runSeq) return
    m.runSeq = seq
    if (at < m.observedRunAt) return
    m.observedRunAt = Math.max(at, m.observedRunAt)
    if (e.type === 'session.execution.started') m.run = { ...emptyRun(), state: 'running', id, started_at: at }
    else
      m.run = {
        ...(m.run.state === 'running' ? m.run : emptyRun()),
        state: 'ended',
        ended_at: at,
        outcome: e.type.slice('session.execution.'.length),
        reason: token(d.reason) ?? token(d.error?.type),
      }
    m.tools.clear()
    m.blockers.clear()
    m.blockerAt = Math.max(at, m.blockerAt)
  } else {
    if (seq <= m.seq) return
    if (e.type.startsWith('session.inbox.')) {
      const key = token(d.inboxID)
      if (!key || at < m.queueSnapshotAt) return
      if (e.type === 'session.inbox.enqueued' && d.item?.type === 'user')
        bounded(m, m.pending, key, { id: key, queued_at: at, delivery: delivery(d.item.delivery) })
      else if (e.type === 'session.inbox.delivery.changed' && m.pending.has(key)) m.pending.get(key)!.delivery = delivery(d.delivery)
      else if (e.type === 'session.inbox.delivered' || e.type === 'session.inbox.cancelled') m.pending.delete(key)
      else return
      entry.request_id = key
      m.queueAt = Math.max(m.queueAt, at)
    } else if (e.type === 'session.tool.input.started') {
      const name = token(d.name),
        key = token(d.id),
        msg = token(d.assistantMessageID)
      if (name && key && msg) bounded(m, m.tools, `${msg}/${key}`, name)
      return
    } else if (e.type === 'session.tool.called' || e.type === 'session.tool.success' || e.type === 'session.tool.failed') {
      const key = `${d.assistantMessageID}/${d.id}`,
        tool = m.tools.get(key)
      if (tool) entry.tool = tool
      if (e.type !== 'session.tool.called') m.tools.delete(key)
    } else if (e.type === 'permission.asked' || e.type === 'form.created') {
      const key = token(d.id ?? d.form?.id)
      if (!key || at < m.blockerAt) return
      m.blockerAt = at
      bounded(m, m.blockers, key, { id: key, kind: e.type === 'permission.asked' ? 'permission' : 'question' })
    } else if (e.type === 'permission.replied' || e.type === 'form.replied' || e.type === 'form.cancelled') {
      const key = token(d.requestID ?? d.id)
      if (!key || at < m.blockerAt || !m.blockers.delete(key)) return
      m.blockerAt = at
    } else return
  }
  m.seq = Math.max(m.seq, seq)
  m.events.push(entry)
  if (m.events.length > LIMIT) m.events.shift()
}

type Cursor = { root: string; file: string; dev: number; ino: number; offset: number; anchor: string; m: Model }
function project(channel_id: string, m: Model, available: boolean) {
  return {
    channel_id,
    available,
    run: { ...m.run },
    pending: Array.from(m.pending.values(), (r) => ({ ...r })),
    pending_count: m.queueComplete && !m.partial ? m.pending.size : null,
    blockers: [...m.blockers.values()],
    events: m.events.slice(),
    partial: m.partial,
  }
}
export type ActivitySnapshot = ReturnType<typeof project>

export class RunActivity {
  private cursors = new Map<string, Cursor>()
  private jobs = new Map<string, Promise<ActivitySnapshot>>()
  private scanner: Promise<void> = Promise.resolve()
  private watchers = new Map<string, fs.FSWatcher>()
  private changes = new Map<string, NodeJS.Timeout>()
  private stopped = false

  constructor(
    private readonly hubRoot: string,
    private readonly interested: (id: string) => boolean,
    private readonly changed: (id: string) => void,
  ) {}

  // Observe filenames only. Coalesce bursts for tracked thread clocks and open views.
  start() {
    this.stopped = false
    this.ensureWatches()
  }
  private ensureWatches() {
    for (const dir of kimakiDirs(this.hubRoot)) {
      const journal = path.join(dir, 'session-events')
      if (this.watchers.has(journal)) continue
      try {
        const w = fs.watch(journal, { persistent: false }, (_, name) => {
          const id = name?.match(/^(\d{1,20})\.jsonl$/)?.[1]
          if (id) this.schedule(id)
        })
        this.watchers.set(journal, w)
        w.on('error', () => {
          w.close()
          this.watchers.delete(journal)
        })
      } catch {
        /* a machine without a local recorder has no evidence */
      }
    }
  }
  private schedule(id: string) {
    if (this.stopped || !this.interested(id) || this.changes.has(id)) return
    this.changes.set(
      id,
      setTimeout(() => {
        this.changes.delete(id)
        if (!this.stopped && this.interested(id)) this.changed(id)
      }, 150).unref(),
    )
  }
  stop() {
    this.stopped = true
    for (const w of this.watchers.values()) w.close()
    this.watchers.clear()
    for (const timer of this.changes.values()) clearTimeout(timer)
    this.changes.clear()
    this.cursors.clear()
  }
  cached(id: string) {
    return this.cursors.has(id)
  }
  read(id: string): Promise<ActivitySnapshot> {
    const job = this.jobs.get(id)
    if (job) return job
    // A reconnect with many busy rows must not read all their journals in parallel.
    const read = this.scanner.then(() => this.readBound(id)).finally(() => this.jobs.delete(id))
    this.scanner = read.then(
      () => {},
      () => {},
    )
    this.jobs.set(id, read)
    return read
  }

  // Validate the thread -> root binding from the recorder's OWN database, read-only.
  // Prefer the hub-side recording; distinct roots in two homes are ambiguous.
  private bindings(id: string) {
    const homes = kimakiDirs(this.hubRoot).map((dir) => ({ dbFile: path.join(dir, 'kimaki.db'), file: path.join(dir, 'session-events', `${id}.jsonl`) }))
    if (!homes.some(({ file }) => fs.existsSync(file))) return undefined
    let bound: string | undefined, source: { root: string; file: string } | undefined
    for (const { dbFile, file } of homes) {
      if (!fs.existsSync(dbFile)) continue
      let db: DatabaseSync | undefined
      try {
        db = new DatabaseSync(dbFile, { readOnly: true })
        const root = token(db.prepare('SELECT session_id FROM thread_sessions WHERE thread_id=?').get(id)?.session_id)
        if (!root) continue
        if (bound && root !== bound) return undefined
        bound = root
        if (!source && fs.existsSync(file)) source = { root, file }
      } catch {
        if (fs.existsSync(file)) return undefined
      } finally {
        db?.close()
      }
    }
    return source
  }
  private async readBound(id: string): Promise<ActivitySnapshot> {
    const unknown = () => {
      this.cursors.delete(id)
      return project(id, model(), false)
    }
    if (!THREAD.test(id) || this.stopped) return unknown()
    this.ensureWatches()
    const source = this.bindings(id)
    if (!source) return unknown()
    const { file, root } = source
    const fd = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)).catch(() => null)
    if (!fd) return unknown()
    try {
      const stat = await fd.stat()
      if (!stat.isFile() || stat.size > MAX_FILE) return unknown()
      let c = this.cursors.get(id)
      const anchorAt = async (offset: number) => {
        const n = Math.min(offset, 64),
          b = Buffer.alloc(n)
        const { bytesRead } = await fd.read(b, 0, n, offset - n)
        return createHash('sha256').update(b.subarray(0, bytesRead)).digest('hex')
      }
      if (
        c &&
        c.file === file &&
        c.root === root &&
        c.ino === stat.ino &&
        c.dev === stat.dev &&
        c.offset <= stat.size &&
        c.offset &&
        (await anchorAt(c.offset)) !== c.anchor
      )
        c = undefined
      if (!c || c.file !== file || c.root !== root || c.ino !== stat.ino || c.dev !== stat.dev || c.offset > stat.size)
        c = { file, root, dev: stat.dev, ino: stat.ino, offset: 0, anchor: '', m: model() }
      let pos = c.offset,
        left = Buffer.alloc(0),
        skip = false
      while (pos < stat.size && !this.stopped) {
        const part = Buffer.allocUnsafe(Math.min(65536, stat.size - pos))
        const { bytesRead } = await fd.read(part, 0, part.length, pos)
        if (!bytesRead) return unknown()
        pos += bytesRead
        const data = Buffer.concat([left, part.subarray(0, bytesRead)])
        let i = 0,
          end: number
        while ((end = data.indexOf(10, i)) >= 0) {
          if (!skip && end - i <= MAX_LINE) {
            try {
              const line = data.toString('utf8', i, end)
              if (BOOKKEEPING.test(line)) fold(c.m, root, JSON.parse(line).event)
            } catch {
              c.m.partial = true
            }
          } else c.m.partial = true
          i = end + 1
          skip = false
          c.offset = pos - data.length + i
        }
        if (data.length - i > MAX_LINE) skip = true
        left = skip ? Buffer.alloc(0) : data.subarray(i)
      }
      if (this.stopped) return unknown()
      const endStat = await fd.stat()
      if (endStat.size !== stat.size) this.schedule(id)
      if (endStat.size < stat.size) return unknown()
      const binding = this.bindings(id)
      if (binding?.root !== root || binding.file !== file) return unknown()
      c.anchor = await anchorAt(c.offset)
      this.cursors.delete(id)
      this.cursors.set(id, c)
      if (this.cursors.size > 64) this.cursors.delete(this.cursors.keys().next().value!)
      return project(id, c.m, true)
    } catch {
      return unknown()
    } finally {
      await fd.close()
    }
  }
}
