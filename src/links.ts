// Soft links between sessions: one thread naming another (a thread link, a
// <#mention>, `--thread <id>`, or an OpenCode session ID that Kimaki maps to a
// thread). Two threads that name each other are liaising; a thread started by
// `kimaki send --parent-session` was spawned by its parent. Derived from the
// messages, never stored, so it heals itself as history changes.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@libsql/client'
import type { Hub } from './hub.ts'

export type LinkKind = 'liaison' | 'spawned' | 'parent' | 'mentions' | 'mentioned'
export type Link = { id: string; kind: LinkKind; count: number; last: string; messageId: string; messageChannelId: string }
export type Ref = { thread?: string; session?: string; parent?: boolean }

const THREAD_TYPES = [10, 11, 12]
const SESSION = /\bses_[A-Za-z0-9]{24,28}\b/g
const THREAD_REFS = [/discord\.com\/channels\/\d+\/(\d{17,20})/g, /<#(\d{17,20})>/g, /--(?:thread|session)[= ]['"]?(\d{17,20})/g, /kimaki session (?:read|wait|url|archive) ['"]?(\d{17,20})/g]
const PARENT = /parentSessionId: ['"]?(ses_[A-Za-z0-9]{24,28})/g
// Kimaki's marker on a prompt sent from another machine: "-# from desktop · thread 123 · session ses_…".
const FROM = /^-# from .+?(?: · thread (\d{17,20}))?(?: · session (ses_\w+))?$/gm

function when(value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value)
  const date = Number.isFinite(n) && n > 0 ? new Date(n < 1e12 ? n * 1000 : n) : new Date(String(value).replace(' ', 'T') + (/Z|[+-]\d\d:?\d\d$/.test(String(value)) ? '' : 'Z'))
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString()
}

type Candidate = { channelId: string; text: Ref[]; embeds: Ref[]; at: string }

export function extractRefs(content: string, embeds: string): Ref[] {
  const refs: Ref[] = []
  for (const re of THREAD_REFS) for (const m of content.matchAll(re)) refs.push({ thread: m[1]! })
  for (const m of content.matchAll(FROM)) if (m[1]) refs.push({ thread: m[1] })
  for (const m of content.matchAll(SESSION)) refs.push({ session: m[0] })
  if (embeds.includes('parentSessionId')) for (const m of embeds.matchAll(PARENT)) refs.push({ session: m[1]!, parent: true })
  return refs
}

// Kimaki keeps thread ↔ session in its SQLite; read every data dir we can see.
export function kimakiDirs(root: string): string[] {
  return (process.env['VOCORUM_KIMAKI_DIRS']?.split(':').filter(Boolean) ?? [path.join(root, 'kimaki-data'), path.join(os.homedir(), '.kimaki')]).filter((dir) => fs.existsSync(dir))
}

function kimakiDatabases(root: string): string[] {
  const dirs = kimakiDirs(root)
  return dirs.flatMap((dir) => ['kimaki.db', 'discord-sessions.db'].map((f) => path.join(dir, f))).filter((f) => fs.existsSync(f))
}

type Row = { from: string; to: string; parent: boolean; messageId: string; at: string }

export class Links {
  private byMessage = new Map<string, Row[]>()
  private sessionThread = new Map<string, string>()
  private threads = new Set<string>()
  private refresh: NodeJS.Timeout | null = null
  private ready: Promise<void> | null = null

  private notify: NodeJS.Timeout | null = null
  private lastCounts = ''

  constructor(
    private readonly hub: Hub,
    private readonly emit: (counts: Record<string, number>) => void = () => {},
  ) {}

  // Coalesced: tell clients the link counts changed so open views reload theirs.
  private changed() {
    if (this.notify) return
    this.notify = setTimeout(() => {
      this.notify = null
      void this.counts().then((counts) => {
        const key = JSON.stringify(counts)
        if (key !== this.lastCounts) this.emit(counts)
        this.lastCounts = key
      })
    }, 300)
    this.notify.unref()
  }

  private get prisma() {
    return this.hub.twin.prisma
  }

  start() {
    this.ready = this.load().catch(() => {})
    this.refresh = setInterval(() => void this.loadSessions().catch(() => {}), 60_000)
    this.refresh.unref()
    return this.ready
  }

  stop() {
    if (this.refresh) clearInterval(this.refresh)
    if (this.notify) clearTimeout(this.notify)
  }

  // Links Kimaki keeps itself (its session_links table), as pairs of session IDs.
  private kimakiLinks: Array<{ from: string; to: string; toThread?: string; at: string }> = []

  private async loadSessions() {
    const map = new Map<string, string>()
    const pairs: Array<{ from: string; to: string; toThread?: string; at: string }> = []
    for (const file of kimakiDatabases(this.hub.options.paths.root)) {
      const db = createClient({ url: `file:${file}` })
      try {
        const rs = await db.execute('SELECT thread_id, session_id FROM thread_sessions')
        for (const row of rs.rows) map.set(String(row['session_id']), String(row['thread_id']))
        // Kimaki records parent links from its own footer too, so only send, mention and manual links count here.
        // Kimaki records parent links from its own footer too, so only send, mention and manual links count here.
        // Cross-machine rows name the far side by thread (linked_thread_id, or "thread:<id>" before its session is known).
        const links =
          (await db.execute("SELECT session_id, linked_session_id, linked_thread_id, last_contact_at, created_at FROM session_links WHERE source != 'parent'").catch(() => null)) ??
          (await db.execute("SELECT session_id, linked_session_id, NULL AS linked_thread_id, last_contact_at, created_at FROM session_links WHERE source != 'parent'").catch(() => null))
        for (const row of links?.rows ?? []) {
          const linked = String(row['linked_session_id'])
          const thread = row['linked_thread_id'] ? String(row['linked_thread_id']) : linked.startsWith('thread:') ? linked.slice(7) : undefined
          pairs.push({ from: String(row['session_id']), to: linked, toThread: thread, at: when(row['last_contact_at'] ?? row['created_at']) })
        }
      } catch {
        // Not a Kimaki database, or an older schema: skip it.
      } finally {
        db.close()
      }
    }
    const changed = map.size !== this.sessionThread.size || [...map].some(([k, v]) => this.sessionThread.get(k) !== v) || JSON.stringify(pairs) !== JSON.stringify(this.kimakiLinks)
    this.sessionThread = map
    this.kimakiLinks = pairs
    if (changed) await this.reindex()
  }

  private async load() {
    this.threads = new Set((await this.prisma.channel.findMany({ where: { guildId: { in: [...this.hub.guildIds] }, type: { in: THREAD_TYPES } }, select: { id: true } })).map((c) => c.id))
    await this.loadSessions()
    await this.reindex()
  }

  // Messages with references: only the references are kept (from the text and
  // from embeds, apart, so an edit of one keeps the other), never the text.
  private candidates = new Map<string, Candidate>()

  private async reindex() {
    if (!this.candidates.size) {
      // In pages: a large history must not be held in memory at once.
      for (let cursor: string | undefined; ; ) {
        const rows = await this.prisma.message.findMany({
          where: { ...(cursor && { id: { gt: cursor } }), OR: [{ content: { contains: 'ses_' } }, { content: { contains: '/channels/' } }, { content: { contains: '<#' } }, { content: { contains: '--thread' } }, { content: { contains: 'kimaki session' } }, { embeds: { contains: 'parentSessionId' } }] },
          select: { id: true, channelId: true, content: true, embeds: true, timestamp: true },
          orderBy: { id: 'asc' },
          take: 1000,
        })
        for (const r of rows) {
          const candidate = { channelId: r.channelId, text: extractRefs(r.content, '[]'), embeds: extractRefs('', r.embeds), at: r.timestamp.toISOString() }
          if (candidate.text.length || candidate.embeds.length) this.candidates.set(r.id, candidate)
        }
        if (rows.length < 1000) break
        cursor = rows.at(-1)!.id
      }
    }
    this.byMessage.clear()
    for (const [id, m] of this.candidates) this.index(id, m)
    // Kimaki's own links ride along under a synthetic key: no message to jump to.
    const rows: Row[] = []
    for (const pair of this.kimakiLinks) {
      const from = this.sessionThread.get(pair.from)
      const to = pair.toThread ?? this.sessionThread.get(pair.to)
      if (from && to && from !== to && this.threads.has(from) && this.threads.has(to)) rows.push({ from, to, parent: false, messageId: '', at: pair.at })
    }
    if (rows.length) this.byMessage.set('kimaki:session_links', rows)
    this.changed()
  }

  private index(messageId: string, m: Candidate) {
    const rows: Row[] = []
    for (const ref of [...m.text, ...m.embeds]) {
      const to = ref.thread ?? this.sessionThread.get(ref.session!)
      if (!to || to === m.channelId || !this.threads.has(to)) continue
      rows.push({ from: m.channelId, to, parent: !!ref.parent, messageId, at: m.at })
    }
    if (rows.length) this.byMessage.set(messageId, rows)
    else this.byMessage.delete(messageId)
  }

  whenReady() {
    return this.ready ?? Promise.resolve()
  }

  // Every Kimaki session whose thread is on this hub, for session-ID chips.
  sessionThreads(): Record<string, string> {
    return Object.fromEntries([...this.sessionThread].filter(([, thread]) => this.threads.has(thread)))
  }

  // The thread of a Kimaki session, if that thread is on this hub.
  threadOf(sessionId: string): string | undefined {
    const thread = this.sessionThread.get(sessionId)
    return thread && this.threads.has(thread) ? thread : undefined
  }

  // Called for each dispatch; cheap when the message has no references.
  observe(event: string, data: any) {
    if (event === 'THREAD_CREATE' && data?.id) this.threads.add(data.id)
    if (event === 'MESSAGE_DELETE' && data?.id) {
      this.candidates.delete(data.id)
      if (this.byMessage.delete(data.id)) this.changed()
      return
    }
    if ((event !== 'MESSAGE_CREATE' && event !== 'MESSAGE_UPDATE') || !data?.id || !data.channel_id) return
    const known = this.candidates.get(data.id)
    const text = typeof data.content === 'string' ? extractRefs(data.content, '[]') : (known?.text ?? [])
    const embeds = data.embeds ? extractRefs('', JSON.stringify(data.embeds)) : (known?.embeds ?? [])
    if (!text.length && !embeds.length && !known) return
    const m: Candidate = { channelId: data.channel_id, text, embeds, at: data.timestamp ?? known?.at ?? new Date().toISOString() }
    this.candidates.set(data.id, m)
    // A reference to a session Kimaki only just started: look it up again soon.
    if ([...text, ...embeds].some((r) => r.session && !this.sessionThread.has(r.session))) setTimeout(() => void this.loadSessions().catch(() => {}), 3000).unref()
    this.index(data.id, m)
    this.changed()
  }

  async of(threadId: string): Promise<Link[]> {
    await this.ready
    const out = new Map<string, { to: Row[]; from: Row[] }>()
    for (const rows of this.byMessage.values())
      for (const r of rows) {
        if (r.from === threadId) (out.get(r.to) ?? out.set(r.to, { to: [], from: [] }).get(r.to)!).to.push(r)
        else if (r.to === threadId) (out.get(r.from) ?? out.set(r.from, { to: [], from: [] }).get(r.from)!).from.push(r)
      }
    const links: Link[] = []
    for (const [id, { to, from }] of out) {
      const all = [...to, ...from].sort((a, b) => (Number(Boolean(b.messageId)) - Number(Boolean(a.messageId))) || (a.at < b.at ? 1 : -1))
      const last = [...to, ...from].reduce((max, r) => (r.at > max ? r.at : max), '')
      const kind: LinkKind = to.length && from.length ? 'liaison' : to.some((r) => r.parent) ? 'parent' : from.some((r) => r.parent) ? 'spawned' : to.length ? 'mentions' : 'mentioned'
      links.push({ id, kind, count: all.length, last, messageId: all[0]!.messageId, messageChannelId: all[0]!.from })
    }
    const rank: Record<LinkKind, number> = { liaison: 0, parent: 1, spawned: 2, mentions: 3, mentioned: 4 }
    return links.sort((a, b) => rank[a.kind] - rank[b.kind] || (a.last < b.last ? 1 : -1))
  }

  // Every thread's link count, for the sidebar.
  async counts(): Promise<Record<string, number>> {
    await this.ready
    const pairs = new Set<string>()
    for (const rows of this.byMessage.values()) for (const r of rows) pairs.add(r.from < r.to ? `${r.from}:${r.to}` : `${r.to}:${r.from}`)
    const counts: Record<string, number> = {}
    for (const pair of pairs) for (const id of pair.split(':')) counts[id] = (counts[id] ?? 0) + 1
    return counts
  }
}
