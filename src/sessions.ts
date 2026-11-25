// Session state for the Overview and the sidebar dots: what each thread is
// doing (waiting for the owner, failed, busy, done, idle), derived from the
// messages agent bots already send. Deterministic and event-driven: it runs
// only when a message, edit, typing event or thread change arrives.

import { Links } from './links.ts'
import { Services } from './services.ts'
import type { Hub } from './hub.ts'

export type SessionState = 'waiting' | 'failed' | 'busy' | 'done' | 'idle'
export type Choice = { customId: string; label: string; style: number }
export type SessionSummary = {
  id: string
  title: string
  projectId: string | null
  project: string | null
  machine: string | null
  state: SessionState
  since: string
  lastMessageId: string | null
  ask?: { text: string; messageId: string; choices?: Choice[]; openOnly?: boolean }
  lastStep?: string
  error?: string
}
export type MachineSummary = { name: string; online: boolean | null; waiting: number; running: number; failed: number }

export type LiteMessage = {
  id: string
  authorId: string
  bot: boolean
  type: number
  content: string
  components: any[]
  attachments: Array<{ filename?: string }>
  timestamp: string
}

const THREAD_TYPES = [10, 11, 12]
const TOOL_LINE = /^-# (.*(┣|◼︎|◼|■)|\*?_?thinking\b)/
// An agent's turn footer: "-# *project ⋅ branch ⋅ 2m 30s ⋅ 31% ⋅ model*", or
// "> *project ⋅ 12s ⋅ 4% ⋅ model* <@owner>" (Kimaki pings the owner at the end of a turn).
export const FOOTER = /^(-#|>) \*?[^\n]*⋅[^\n]*\d+%[^\n]*?\*?(\s*<@!?\d+>)?\s*$/m
const RISKY = /\b(send|pay|sign|delete|transfer|withdraw|merge|deploy)\b/i
// A question nobody answered for a week, a failure nobody looked at for a week, or a
// run that went quiet for an hour is history, not something that needs the owner now.
const DONE_TTL = 7 * 86_400_000
const ASK_TTL = 7 * 86_400_000
const BUSY_TTL = 60 * 60_000

// Markdown marks removed; mentions, channels and timestamps are kept for the
// client, which knows the names and the owner's time zone.
export function plainText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]\n]+)\]\(<?https?:\/\/[^\s)>]+>?\)/g, '$1')
    .replace(/^\s{0,3}(#{1,3}|-#|>{1,3}|[-*]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~|\|\||`)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : text
}

function walk(components: any[], visit: (c: any) => void) {
  for (const c of components ?? []) {
    visit(c)
    if (Array.isArray(c?.components)) walk(c.components, visit)
    if (c?.accessory) walk([c.accessory], visit)
  }
}

function interactive(c: any) {
  return (c.type === 2 && c.style !== 5) || (c.type >= 3 && c.type <= 8 && c.type !== 4)
}

export function hasOpenComponents(components: any[]): boolean {
  let open = false
  walk(components, (c) => {
    if (interactive(c) && !c.disabled) open = true
  })
  return open
}

function containerText(components: any[]): string {
  const parts: string[] = []
  walk(components, (c) => {
    if (c.type === 10 && typeof c.content === 'string') parts.push(c.content)
  })
  return parts.join('\n')
}

function accentHue(value: number): { hue: number; chroma: number } {
  const r = (value >> 16) & 255
  const g = (value >> 8) & 255
  const b = value & 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min || 1
  const hue = ((max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360
  return { hue, chroma: max - min }
}

function isErrorCallout(components: any[]) {
  let red = false
  walk(components, (c) => {
    if (c.type === 17 && typeof c.accent_color === 'number') {
      const { hue, chroma } = accentHue(c.accent_color)
      if (chroma >= 30 && (hue < 20 || hue >= 330)) red = true
    }
  })
  return red
}

export function isToolOnly(m: LiteMessage) {
  if (!m.bot || m.attachments.length || m.components.length || !m.content) return false
  const lines = m.content.split('\n').filter((l) => l.trim())
  return lines.length > 0 && lines.every((l) => TOOL_LINE.test(l))
}

function text(m: LiteMessage) {
  return [m.content, containerText(m.components)].filter(Boolean).join('\n')
}

function choicesOf(m: LiteMessage): Choice[] | undefined {
  const all: any[] = []
  walk(m.components, (c) => {
    if (interactive(c) && !c.disabled) all.push(c)
  })
  if (all.length === 0 || all.some((c) => c.type !== 2)) return undefined
  return all.map((c) => ({ customId: String(c.custom_id), label: String(c.label ?? ''), style: Number(c.style ?? 2) }))
}

// The rules, newest information first. `messages` is oldest first.
export function deriveState(messages: LiteMessage[], ownerId: string, { typingUntil = 0, now = Date.now() }: { typingUntil?: number; now?: number } = {}): Pick<SessionSummary, 'state' | 'since' | 'ask' | 'lastStep' | 'error'> {
  const human = (m: LiteMessage) => m.authorId === ownerId && (m.type === 0 || m.type === 19)
  const lastOwner = messages.findLastIndex(human)
  const turn = messages.slice(lastOwner + 1).filter((m) => m.bot && (m.type === 0 || m.type === 19))
  const last = turn.at(-1)
  const at = (m: LiteMessage | undefined) => m?.timestamp ?? messages.at(-1)?.timestamp ?? new Date(now).toISOString()

  // Waiting: any bot message in the current turn that still asks for the owner.
  const asking = [...turn].reverse().find((m) => {
    const body = text(m)
    // The turn-end ping in a footer is a notification, not a question.
    const mention = body.includes(`<@${ownerId}>`) && !FOOTER.test(m.content)
    return hasOpenComponents(m.components) || /^\**Permission/i.test(plainText(containerText(m.components))) || mention || /\*\*Question:\*\*/.test(body)
  })
  const fresh = (iso: string, ttl: number) => now - new Date(iso).getTime() < ttl
  if (asking && fresh(asking.timestamp, ASK_TTL)) {
    const body = plainText(text(asking).replace(new RegExp(`<@!?${ownerId}>`, 'g'), ''))
    const choices = choicesOf(asking)
    const draftInTurn = turn.some((m) => m.attachments.some((a) => /\.(md|eml)$/i.test(a.filename ?? '')))
    const openOnly = Boolean(choices && (draftInTurn || /\bsudo\b/.test(body) || choices.some((c) => RISKY.test(c.label))))
    return { state: 'waiting', since: asking.timestamp, ask: { text: clip(body, 160), messageId: asking.id, ...(choices && !openOnly && { choices }), ...(openOnly && { openOnly }) } }
  }
  if (asking) return { state: 'idle', since: asking.timestamp }
  if (last && fresh(last.timestamp, ASK_TTL) && (isErrorCallout(last.components) || /^(\*\*)?(error\b|.*ended with an error)/i.test(plainText(last.content)))) {
    return { state: 'failed', since: last.timestamp, error: clip(plainText(text(last)), 160) }
  }
  const step = [...turn].reverse().find(isToolOnly)
  const lastStep = step ? plainText(step.content.split('\n').filter((l) => l.trim()).at(-1)!.replace(/^-#\s*(┣|◼︎|◼|■)?\s*/, '')) : undefined
  if (typingUntil > now) return { state: 'busy', since: at(last ?? messages[lastOwner]), ...(lastStep && { lastStep }) }
  if (last && isToolOnly(last) && fresh(last.timestamp, BUSY_TTL)) return { state: 'busy', since: last.timestamp, ...(lastStep && { lastStep }) }
  if (lastOwner >= 0 && !last && now - new Date(messages[lastOwner]!.timestamp).getTime() < 10 * 60_000) return { state: 'busy', since: messages[lastOwner]!.timestamp }
  if (last && FOOTER.test(last.content) && fresh(last.timestamp, DONE_TTL)) return { state: 'done', since: last.timestamp }
  return { state: 'idle', since: at(last) }
}

const RECENT = 30
const WARM_DAYS = 30
const TYPING_MS = 12_000

export class Sessions {
  private summaries = new Map<string, SessionSummary>()
  private typing = new Map<string, number>()
  private timers = new Map<string, NodeJS.Timeout>()
  private unobserve: (() => void) | null = null
  private health: NodeJS.Timeout | null = null
  private lastMachines = ''
  private pending = new Map<string, Promise<void>>()
  private dirty = new Set<string>()
  private botMachines: string[] = []
  private aliases: Record<string, string> = {}
  private byDiscordBot = new Map<string, string>()
  private byGuild = new Map<string, string>()
  readonly links: Links
  readonly services: Services

  constructor(
    private readonly hub: Hub,
    private readonly emit: (event: string, data: unknown) => void,
  ) {
    this.links = new Links(hub, (counts) => emit('SESSION_LINKS', counts))
    this.services = new Services(hub, emit, this.links)
  }

  private get prisma() {
    return this.hub.twin.prisma
  }

  async reloadBots() {
    this.botMachines = (await this.hub.store.listBots()).filter((b) => !b.revokedAt).map((b) => b.machine)
    const machineBots = await this.hub.mirror.machineBots()
    this.aliases = Object.fromEntries(Object.entries(machineBots).map(([machine, bot]) => [bot.name.toLowerCase(), machine]))
    this.byDiscordBot = new Map(Object.entries(machineBots).map(([machine, bot]) => [bot.discord_user_id, machine]))
    // A guild only one machine's hub bot is in: the hub bot's posts there are that machine's.
    const inGuild = new Map<string, string[]>()
    for (const [machine, guilds] of await this.hub.store.botGuilds()) {
      if (!this.botMachines.includes(machine)) continue
      for (const guild of guilds) inGuild.set(guild, [...(inGuild.get(guild) ?? []), machine])
    }
    this.byGuild = new Map([...inGuild].filter(([, machines]) => machines.length === 1).map(([guild, machines]) => [guild, machines[0]!]))
  }

  // The machine a category stands for, when it is one the hub knows (a
  // registered bot, or a machine's Discord bot name: a mirrored "Kimaki
  // Laptop" category is the machine whose Discord bot is "Laptop"). Other
  // "Kimaki ..." categories are project groups, not machines.
  machineOf(category: string): string | null {
    const name = machineName(category, this.botMachines, this.aliases)
    return name && this.botMachines.some((m) => m.toLowerCase() === name.toLowerCase()) ? name : null
  }

  // The machine whose agent last posted in a thread: its Discord bot, or the
  // hub bot in a guild only that machine is in.
  private machineOfPosts(messages: LiteMessage[], guildId: string | null) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!
      if (!m.bot) continue
      const machine = this.byDiscordBot.get(m.authorId) ?? (m.authorId === this.hub.options.config.botUserId && guildId ? this.byGuild.get(guildId) : undefined)
      if (machine) return machine
    }
    return null
  }

  private stopped = false

  async start() {
    this.stopped = false
    await this.reloadBots()
    void this.links.start()
    void this.services.start()
    this.unobserve = this.hub.twin.observeDispatches((event, data: any) => {
      this.links.observe(event, data)
      this.services.observe(event, data)
      const channelId: string | undefined = event.startsWith('THREAD_') || event.startsWith('CHANNEL_') ? data?.id : data?.channel_id
      if (!channelId) return
      if (event === 'TYPING_START') {
        this.typing.set(channelId, Date.now() + TYPING_MS)
        clearTimeout(this.timers.get(channelId))
        this.timers.set(channelId, setTimeout(() => void this.recompute(channelId), TYPING_MS + 50).unref())
      }
      if (event === 'MESSAGE_CREATE' && data?.author?.bot) this.typing.delete(channelId)
      if (/^(MESSAGE_(CREATE|UPDATE|DELETE)|TYPING_START|THREAD_(CREATE|UPDATE|DELETE))$/.test(event)) void this.recompute(channelId)
    })
    this.health = setInterval(() => this.checkMachines(), 10_000)
    this.health.unref()
  }

  // Every open thread's state, worked out once the hub is up: with a large
  // imported history this takes tens of seconds and keeps the database busy,
  // so nothing at start (remote machines connecting) waits for it.
  async warm() {
    // Threads active in the last 30 days; an older one joins when something happens in it.
    const since = String((BigInt(Date.now() - WARM_DAYS * 86_400_000) - 1420070400000n) << 22n)
    const threads = (await this.prisma.channel.findMany({ where: { guildId: { in: [...this.hub.guildIds] }, type: { in: [...THREAD_TYPES] }, archived: false }, orderBy: { lastMessageId: 'desc' }, select: { id: true, lastMessageId: true } })).filter((t) => t.lastMessageId && (t.lastMessageId.length > since.length || (t.lastMessageId.length === since.length && t.lastMessageId >= since)))
    for (const thread of threads) {
      if (this.stopped) return
      await this.recompute(thread.id, { quiet: true }).catch((error) => console.error('[sessions]', error))
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  stop() {
    this.stopped = true
    this.unobserve?.()
    this.links.stop()
    this.services.stop()
    if (this.health) clearInterval(this.health)
    for (const timer of this.timers.values()) clearTimeout(timer)
  }

  list(): SessionSummary[] {
    return [...this.summaries.values()]
  }

  // Coalesces bursts (a streaming agent edits its message many times a second):
  // one run at a time per thread, and one more after it if anything arrived meanwhile.
  recompute(channelId: string, { quiet = false } = {}): Promise<void> {
    const running = this.pending.get(channelId)
    if (running) {
      this.dirty.add(channelId)
      return running
    }
    const job = this.compute(channelId, quiet)
      .catch(() => {})
      .finally(() => {
        this.pending.delete(channelId)
        if (this.dirty.delete(channelId)) void this.recompute(channelId)
      })
    this.pending.set(channelId, job)
    return job
  }

  private async compute(channelId: string, quiet: boolean) {
    const { config } = this.hub.options
    const thread = await this.prisma.channel.findUnique({ where: { id: channelId } })
    if (!thread || !THREAD_TYPES.includes(thread.type) || !this.hub.guildIds.has(thread.guildId ?? '') || thread.archived) {
      if (this.summaries.delete(channelId) && !quiet) this.emit('SESSION_STATE', { id: channelId, removed: true })
      return
    }
    const rows = await this.prisma.message.findMany({ where: { channelId }, orderBy: { id: 'desc' }, take: RECENT })
    const bots = new Set((await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.authorId))] }, bot: true }, select: { id: true } })).map((u) => u.id))
    const messages: LiteMessage[] = rows.reverse().map((r) => ({
      id: r.id,
      authorId: r.authorId,
      bot: bots.has(r.authorId),
      type: r.type,
      content: r.content,
      components: safeJson(r.components),
      attachments: safeJson(r.attachments),
      timestamp: r.timestamp.toISOString(),
    }))
    const parent = thread.parentId ? await this.prisma.channel.findUnique({ where: { id: thread.parentId } }) : null
    const category = parent?.parentId ? await this.prisma.channel.findUnique({ where: { id: parent.parentId } }) : null
    const derived = deriveState(messages, config.ownerUserId, { typingUntil: this.typing.get(channelId) ?? 0 })
    const summary: SessionSummary = {
      id: channelId,
      title: plainText(thread.name ?? '') || 'untitled',
      projectId: parent?.id ?? null,
      project: parent?.name ?? null,
      machine: this.machineOfPosts(messages, thread.guildId) ?? (category ? this.machineOf(category.name ?? '') : null),
      lastMessageId: thread.lastMessageId,
      ...derived,
    }
    const before = this.summaries.get(channelId)
    this.summaries.set(channelId, summary)
    if (!quiet && JSON.stringify(before) !== JSON.stringify(summary)) {
      this.emit('SESSION_STATE', summary)
      this.checkMachines()
    }
  }

  async machines(): Promise<MachineSummary[]> {
    const categories = await this.prisma.channel.findMany({ where: { guildId: { in: [...this.hub.guildIds] }, type: 4 }, orderBy: { position: 'asc' } })
    await this.reloadBots()
    const bots = (await this.hub.store.listBots()).filter((b) => !b.revokedAt)
    const connected = this.hub.twin.connectedGatewayTokens()
    const sessions = this.list()
    // A machine in several guilds has a category in each: list it once.
    const seen = new Set<string>()
    return categories.flatMap((category) => {
      const name = this.machineOf(category.name ?? '')
      if (!name || seen.has(name.toLowerCase())) return []
      seen.add(name.toLowerCase())
      const bot = bots.find((b) => b.machine.toLowerCase() === name.toLowerCase())
      const mine = sessions.filter((s) => s.machine === name)
      return [
        {
          name,
          online: bot ? connected.has(`${bot.clientId}:${bot.secretHash}`) : null,
          waiting: mine.filter((s) => s.state === 'waiting').length,
          running: mine.filter((s) => s.state === 'busy').length,
          failed: mine.filter((s) => s.state === 'failed').length,
        },
      ]
    })
  }

  private checkMachines() {
    void this.machines().then((machines) => {
      const key = JSON.stringify(machines)
      if (key === this.lastMachines) return
      this.lastMachines = key
      this.emit('MACHINES_UPDATE', machines)
    })
  }
}

// Agent bots name a category after their machine: a category is a machine when
// its name is a registered bot's machine, or starts with "Kimaki " (Kimaki's own naming).
// aliases: a machine's Discord bot name (lower case) -> the machine.
export function machineName(category: string, botMachines: string[] = [], aliases: Record<string, string> = {}): string | null {
  const name = category.trim()
  const bot = botMachines.find((m) => m.toLowerCase() === name.toLowerCase() || name.toLowerCase() === `kimaki ${m.toLowerCase()}`)
  if (bot) return bot
  const kimaki = /^kimaki\s+(.+)$/i.exec(name)
  if (!kimaki) return aliases[name.toLowerCase()] ?? null
  return aliases[kimaki[1]!.trim().toLowerCase()] ?? kimaki[1]!.trim()
}

function safeJson(value: string) {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
