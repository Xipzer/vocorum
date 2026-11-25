// Discord to Vocorum: scan (read only) and import (keeps Discord's ids).
//
// The import runs in its own process and writes through the running hub's
// /admin/mirror routes in small batches, waiting whenever the hub gets slow,
// so people using the hub never notice it. It copies every file while
// Discord still serves it (links expire, and a purge deletes them), marks the
// history read, scans for pasted secrets, and checks per channel that every
// message it saw is on the hub. Resumable: finished channels are recorded and
// skipped next time.

import fs from 'node:fs'
import path from 'node:path'
import type { HubConfig, HubPaths } from '../config.ts'
import { findSecrets, HubAdmin, jobDir, mask, openTwin, readJson, writeJson } from './local.ts'
import { DiscordRest, snowflakeTime, TEXT_TYPES, THREAD_TYPES } from './rest.ts'

type User = { id: string; username?: string; global_name?: string | null; avatar?: string | null; bot?: boolean }
type Overwrite = { id: string; type: number; allow: string; deny: string }
type Channel = { id: string; guild_id?: string; type: number; name?: string; parent_id?: string | null; position?: number; message_count?: number; last_message_id?: string | null; thread_metadata?: { archived?: boolean; locked?: boolean; archive_timestamp?: string }; permission_overwrites?: Overwrite[]; available_tags?: unknown[]; applied_tags?: unknown[]; rate_limit_per_user?: number; nsfw?: boolean }
type Role = { id: string; name: string; permissions: string; managed?: boolean; icon?: string | null; unicode_emoji?: string | null }
type Member = { user: User; nick?: string | null; roles: string[]; joined_at?: string; communication_disabled_until?: string | null }
type Emoji = { id: string; name: string; animated?: boolean; available?: boolean }
type Attachment = { id: string; filename: string; url?: string; size?: number }
type Message = { id: string; channel_id: string; author: User; content?: string; timestamp?: string; type?: number; attachments?: Attachment[]; embeds?: unknown[]; components?: unknown[]; reactions?: Array<{ emoji: { id: string | null; name: string | null; animated?: boolean }; count: number }>; sticker_items?: unknown[] }
type Guild = { id: string; name: string; icon?: string | null; owner_id?: string }

const MAX_FILE = 50 * 1024 * 1024
// Message Content intent (or its limited form): without it Discord sends empty text for other people's messages.
const MESSAGE_CONTENT = (1 << 18) | (1 << 19)

export type ImportReport = {
  started: string
  finished: string | null
  guilds: Record<string, { name: string; channels: number; threads: number; complete: number; messages_created: number; files_copied: number; files_missing: number; files_failed: number; gaps: Record<string, { name: string; missing: number; expected: number }>; unreadable: string[]; community?: Community }>
  secrets: Array<{ kind: string; masked: string; channel: string; date: string }>
}

export async function listThreads(rest: DiscordRest, guildId: string, channels: Channel[]): Promise<Channel[]> {
  const threads = new Map<string, Channel>()
  const active = await rest.maybe<{ threads: Channel[] }>(`/guilds/${guildId}/threads/active`)
  for (const t of active?.threads ?? []) threads.set(t.id, t)
  for (const c of channels.filter((c) => TEXT_TYPES.has(c.type))) {
    for (const kind of ['public', 'private']) {
      let before: string | undefined
      for (;;) {
        const page = await rest.maybe<{ threads: Channel[]; has_more?: boolean }>(`/channels/${c.id}/threads/archived/${kind}?limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`)
        for (const t of page?.threads ?? []) if (!threads.has(t.id)) threads.set(t.id, t)
        const last = page?.threads.at(-1)?.thread_metadata?.archive_timestamp
        if (!page?.has_more || !last) break
        before = last
      }
    }
  }
  const parents = new Set(channels.map((c) => c.id))
  return [...threads.values()].filter((t) => t.parent_id && parents.has(t.parent_id))
}

async function guildChannels(rest: DiscordRest, guildId: string, { every = false } = {}) {
  const all = (await rest.get<Channel[]>(`/guilds/${guildId}/channels`)).filter((c) => every || c.type === 4 || TEXT_TYPES.has(c.type))
  all.sort((a, b) => Number(a.type !== 4) - Number(b.type !== 4) || (a.position ?? 0) - (b.position ?? 0))
  return all
}

// --- scan (read only)

export async function scan(rest: DiscordRest, guildIds: string[] | 'all') {
  const me = await rest.get<User>('/users/@me')
  const app = await rest.maybe<{ flags?: number }>('/applications/@me')
  const contentIntent = app ? Boolean((app.flags ?? 0) & MESSAGE_CONTENT) : null
  const ids = guildIds === 'all' ? ((await rest.maybe<Guild[]>('/users/@me/guilds?limit=200')) ?? []).map((g) => g.id) : guildIds
  const guilds = []
  for (const id of ids) {
    const guild = await rest.get<Guild>(`/guilds/${id}`)
    const channels = await guildChannels(rest, id)
    const threads = await listThreads(rest, id, channels)
    const unreadable: string[] = []
    for (const c of [...channels.filter((c) => c.type !== 4), ...threads]) {
      if ((await rest.call('GET', `/channels/${c.id}/messages?limit=1`)).status === 403) unreadable.push(c.name ?? c.id)
    }
    const threadMessages = threads.reduce((sum, t) => sum + (t.message_count ?? 0), 0)
    // The community around the messages: what import brings, and what it cannot.
    const every = await rest.get<Channel[]>(`/guilds/${id}/channels`)
    const members = (await rest.call('GET', `/guilds/${id}/members?limit=1`)).status === 200
    const community = {
      roles: ((await rest.maybe<Role[]>(`/guilds/${id}/roles`)) ?? []).length,
      member_list: members,
      emoji: ((await rest.maybe<Emoji[]>(`/guilds/${id}/emojis`)) ?? []).length,
      forums: channels.filter((c) => c.type === 15 || c.type === 16).length,
      private_threads: threads.filter((t) => t.type === 12).length,
      channels_with_permissions: channels.filter((c) => c.permission_overwrites?.length).length,
      voice_channels: every.filter((c) => CHANNEL_KIND[c.type]).length,
    }
    guilds.push({ id, name: guild.name, owner_id: guild.owner_id ?? null, categories: channels.filter((c) => c.type === 4).length, channels: channels.filter((c) => c.type !== 4).length, threads: threads.length, thread_messages: threadMessages, unreadable, community })
  }
  const messages = guilds.reduce((sum, g) => sum + g.thread_messages, 0)
  const containers = guilds.reduce((sum, g) => sum + g.channels + g.threads, 0)
  return {
    bot: { id: me.id, name: me.global_name ?? me.username },
    message_content_intent: contentIntent,
    guilds,
    // Reads are 100 messages a request (and at least one per channel or thread) at roughly 5 a
    // second; Discord does not count channel messages, so those come on top. Purge: threads
    // nobody else wrote in go whole (--threads), about 2 requests each; the rest 10 deletes a second.
    estimate: { import_minutes: Math.max(1, Math.ceil((messages / 100 + containers) / 5 / 60)), purge_hours: Math.ceil((guilds.reduce((sum, g) => sum + g.threads, 0) * 2 / 10 / 3600) * 10) / 10 },
  }
}

// --- import

// channels: only these channels (and their threads); categories still come along for the layout.
export type ImportOptions = { guilds: string[] | 'all'; channels?: string[]; archive?: string; files?: boolean; log?: (line: string) => void }

export async function importDiscord(rest: DiscordRest, config: HubConfig, paths: HubPaths, options: ImportOptions): Promise<ImportReport> {
  const log = options.log ?? ((line: string) => console.log(line))
  const hub = new HubAdmin(config, paths)
  const dir = jobDir(paths, 'import')
  const progressFile = path.join(dir, 'progress.json')
  const reportFile = path.join(dir, 'report.json')
  const progress = readJson<Record<string, string[]>>(progressFile, {})
  const report: ImportReport = { started: new Date().toISOString(), finished: null, guilds: {}, secrets: [] }
  const secretSeen = new Set<string>()
  const twin = openTwin(paths)
  const hubIds = async (channelId: string) => new Set((await twin.execute({ sql: 'SELECT id FROM Message WHERE channelId = ?', args: [channelId] })).rows.map((r) => String(r['id'])))

  const app = await rest.maybe<{ flags?: number }>('/applications/@me')
  if (app && !((app.flags ?? 0) & MESSAGE_CONTENT)) log('Warning: this bot has no Message Content intent, so Discord sends empty text for other people\'s messages. Turn it on in the Discord developer portal (Bot, Privileged Gateway Intents) and run again.')

  const ids = options.guilds === 'all' ? ((await rest.maybe<Guild[]>('/users/@me/guilds?limit=200')) ?? []).map((g) => g.id) : options.guilds
  if (!ids.length) throw new Error('The bot is in no Discord server it can list. Pass the server id instead of all (vocorum discord scan shows them).')
  try {
    for (const guildId of ids) {
      const guild = await rest.get<Guild>(`/guilds/${guildId}`)
      log(`${guild.name}: reading channels and threads`)
      await hub.call('POST', '/admin/mirror/guild', { id: guildId, name: guild.name })
      if (guild.icon) {
        const icon = await download(`https://cdn.discordapp.com/icons/${guildId}/${guild.icon}.png?size=256`)
        if (icon) await hub.call('POST', `/admin/mirror/guilds/${guildId}/icon`, icon, { raw: true }).catch(() => {})
      }
      const only = options.channels?.length ? new Set(options.channels) : null
      const listed = await guildChannels(rest, guildId, { every: true })
      const usable = listed.filter((c) => c.type === 4 || TEXT_TYPES.has(c.type))
      const channels = only ? usable.filter((c) => only.has(c.id) || (c.type === 4 && usable.some((x) => only.has(x.id) && x.parent_id === c.id))) : usable
      if (only && !channels.some((c) => only.has(c.id))) throw new Error(`None of ${[...only].join(', ')} is a text channel the bot can see in ${guild.name}`)
      await hub.call('POST', '/admin/mirror/channels', channels.map((c) => ({ ...c, guild_id: guildId })))
      const threads = await listThreads(rest, guildId, channels)
      // A server with thousands of agent sessions: in slices the hub takes in one request.
      for (let i = 0; i < threads.length; i += 100) await hub.call('POST', '/admin/mirror/channels', threads.slice(i, i + 100).map((t) => ({ ...t, guild_id: guildId })))
      const done = new Set(progress[guildId] ?? [])
      const community = await importStructure(rest, hub, guildId, guild, listed, channels, threads, config.ownerDiscordIds ?? [], log)
      const stats: ImportReport['guilds'][string] = { name: guild.name, channels: channels.filter((c) => c.type !== 4).length, threads: threads.length, complete: 0, messages_created: 0, files_copied: 0, files_missing: 0, files_failed: 0, gaps: {}, unreadable: [], community }
      report.guilds[guildId] = stats
      const containers = [...channels.filter((c) => c.type !== 4), ...threads]
      let index = 0
      for (const c of containers) {
        index++
        // A channel finished in an earlier run only needs what came after the hub's newest message.
        const finished = done.has(c.id)
        const seen = new Map<string, Message>()
        if (!finished) for (const m of readArchive(options.archive, guildId, c.id)) seen.set(m.id, m)
        const newest = finished ? String((await twin.execute({ sql: 'SELECT id FROM Message WHERE channelId = ? ORDER BY length(id) DESC, id DESC LIMIT 1', args: [c.id] })).rows[0]?.['id'] ?? '0') : '0'
        const after = finished ? newest : [...seen.keys()].reduce((a, b) => (BigInt(b) > BigInt(a) ? b : a), '0')
        const fresh = await pageAfter(rest, c.id, after)
        if (fresh === null) {
          stats.unreadable.push(c.name ?? c.id)
          continue
        }
        for (const m of fresh) seen.set(m.id, m)
        const messages = [...seen.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
        for (const m of messages) {
          for (const s of findSecrets(m)) {
            if (secretSeen.has(s.value)) continue
            secretSeen.add(s.value)
            report.secrets.push({ kind: s.kind, masked: mask(s.value), channel: c.name ?? c.id, date: m.timestamp?.slice(0, 10) ?? new Date(snowflakeTime(m.id)).toISOString().slice(0, 10) })
          }
        }
        stats.messages_created += await sendBatches(hub, messages)
        community.reactions += await copyReactions(rest, hub, messages)
        community.stickers += messages.filter((m) => m.sticker_items?.length).length
        let filesFailed = 0
        if (options.files !== false) {
          const files = await copyFiles(rest, hub, messages)
          stats.files_copied += files.copied
          stats.files_missing += files.missing
          stats.files_failed += files.failed
          filesFailed = files.failed
        }
        const have = await hubIds(c.id)
        const missing = messages.filter((m) => !have.has(m.id)).length
        // A channel is only done when every message and every file is on the hub: the purge relies on it.
        if (missing === 0 && filesFailed === 0) {
          if (finished) {
            stats.complete++
            continue
          }
          done.add(c.id)
          stats.complete++
          progress[guildId] = [...done]
          writeJson(progressFile, progress)
          delete stats.gaps[c.id]
        } else if (missing) stats.gaps[c.id] = { name: c.name ?? c.id, missing, expected: messages.length }
        if (index % 25 === 0) log(`${guild.name}: ${index} of ${containers.length} channels and threads`)
        writeJson(reportFile, report)
      }
      community.private_thread_members = await copyThreadMembers(rest, hub, threads)
      community.emoji = await copyEmoji(rest, hub, guildId)
      if (community.stickers) community.not_imported.push(`${community.stickers} messages with stickers: the sticker shows as its name`)
      await hub.call('POST', '/admin/mirror/finish', { threads: threads.map((t) => t.id), guild_id: guildId })
      await copyAvatars(hub, twin, guildId)
      log(`${guild.name}: ${stats.complete} of ${containers.length} complete, ${stats.messages_created} new messages, ${stats.files_copied} files copied, ${stats.files_missing} already gone on Discord`)
      log(`${guild.name}: ${community.roles} roles, ${community.members ?? 'no'} members, permissions of ${community.overwrites} channels, ${community.reactions} reactions, ${community.emoji} custom emoji${community.private_threads ? `, ${community.private_threads} private threads (${community.private_thread_members} memberships)` : ''}`)
      for (const line of community.not_imported) log(`  not imported: ${line}`)
    }
  } finally {
    report.finished = new Date().toISOString()
    writeJson(reportFile, report)
    twin.close()
  }
  return report
}

// Our earlier archive format: <dir>/<guild>/<channel>.jsonl, one Discord message per line.
function readArchive(dir: string | undefined, guildId: string, channelId: string): Message[] {
  if (!dir) return []
  const file = path.join(dir, guildId, `${channelId}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Message)
}

// Every message after `after`, oldest first; null when the bot may not read the channel.
async function pageAfter(rest: DiscordRest, channelId: string, after: string): Promise<Message[] | null> {
  const out: Message[] = []
  for (;;) {
    const page = await rest.call<Message[]>('GET', `/channels/${channelId}/messages?limit=100&after=${after}`)
    if (page.status === 403) return out.length ? out : null
    if (!page.data || page.data.length === 0) return out
    out.push(...page.data)
    after = page.data.reduce((a, m) => (BigInt(m.id) > BigInt(a) ? m.id : a), after)
    if (page.data.length < 100) return out
  }
}

async function sendBatches(hub: HubAdmin, messages: Message[]) {
  let created = 0
  let batch: Message[] = []
  let size = 0
  const flush = async () => {
    if (!batch.length) return
    created += Number((await hub.call<{ created: number }>('POST', '/admin/mirror/messages', batch)).created ?? 0)
    batch = []
    size = 0
    await hub.yieldToHub()
  }
  for (const m of messages) {
    const bytes = JSON.stringify(m).length
    if (batch.length >= 200 || size + bytes > 300_000) await flush()
    batch.push(m)
    size += bytes
  }
  await flush()
  return created
}

const CDN = new Set(['cdn.discordapp.com', 'media.discordapp.net'])
// A stand-in Discord (VOCORUM_DISCORD_API) serves its own files.
const standIn = (() => {
  try {
    return process.env['VOCORUM_DISCORD_API'] ? new URL(process.env['VOCORUM_DISCORD_API']).origin : null
  } catch {
    return null
  }
})()
const isCdn = (url: string | undefined) => {
  try {
    const u = new URL(url ?? '')
    return (u.protocol === 'https:' && CDN.has(u.hostname)) || u.origin === standIn
  } catch {
    return false
  }
}

async function download(url: string): Promise<Buffer | null | 'gone'> {
  if (!isCdn(url)) return null
  try {
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) })
    if (res.status === 404 || res.status === 403) return 'gone'
    if (!res.ok) return null
    const data = Buffer.from(await res.arrayBuffer())
    return data.length > MAX_FILE ? null : data
  } catch {
    return null
  }
}

async function copyFiles(rest: DiscordRest, hub: HubAdmin, messages: Message[]) {
  const all = messages.flatMap((m) => (m.attachments ?? []).map((a) => ({ message: m.id, a })))
  const todo = all.filter(({ a }) => isCdn(a.url) && (a.size ?? 0) <= MAX_FILE)
  let copied = 0
  let missing = 0
  // A file that is not on Discord's file servers cannot be fetched: never silently skipped,
  // so the channel is not done and the purge keeps its message. Too-big files stay on Discord.
  let failed = all.filter(({ a }) => !isCdn(a.url)).length
  for (let i = 0; i < todo.length; i += 50) {
    const batch = todo.slice(i, i + 50)
    // Stored links expire; Discord hands out fresh ones for files it still has.
    const refreshed = await rest.call<{ refreshed_urls: Array<{ original: string; refreshed: string }> }>('POST', '/attachments/refresh-urls', { attachment_urls: batch.map((b) => b.a.url) })
    const fresh = new Map((refreshed.data?.refreshed_urls ?? []).map((r) => [r.original, r.refreshed]))
    for (const { message, a } of batch) {
      const data = await download(fresh.get(a.url!) ?? a.url!)
      if (data === 'gone') {
        await hub.call('POST', `/admin/mirror/attachments/${message}/${a.id}/missing`, {})
        missing++
      } else if (data) {
        await hub.call('POST', `/admin/mirror/attachments/${message}/${a.id}`, data, { raw: true })
        copied++
      } else failed++
    }
  }
  return { copied, missing, failed }
}

async function copyAvatars(hub: HubAdmin, twin: ReturnType<typeof openTwin>, guildId: string) {
  const users = await twin.execute({ sql: 'SELECT DISTINCT u.id, u.avatar FROM User u JOIN GuildMember g ON g.userId = u.id WHERE g.guildId = ? AND u.avatar IS NOT NULL', args: [guildId] })
  for (const row of users.rows) {
    const data = await download(`https://cdn.discordapp.com/avatars/${row['id']}/${row['avatar']}.png?size=256`)
    if (data && data !== 'gone') await hub.call('POST', `/admin/mirror/avatars/${row['id']}`, data, { raw: true }).catch(() => {})
  }
}

// --- community: roles, members, permissions, private threads, reactions, emoji

// Discord permissions the hub keeps but has no feature for (moderation tools, webhooks,
// events): shown in the report when a role or channel grants them.
const UNENFORCED: Record<string, bigint> = {
  'Kick and ban members': (1n << 1n) | (1n << 2n),
  'Timeout members': 1n << 40n,
  'Manage nicknames': 1n << 27n,
  'Manage webhooks': 1n << 29n,
  'Manage emoji and stickers': (1n << 30n) | (1n << 43n),
  'Manage events': 1n << 33n,
  'View audit log': 1n << 7n,
}
const ADMINISTRATOR = 1n << 3n
const CHANNEL_KIND: Record<number, string> = { 2: 'voice channels', 13: 'stage channels', 14: 'directory channels' }

export type Community = {
  roles: number
  admins: string[]
  members: number | null
  overwrites: number
  kept: { roles: number; members: number; overwrites: number }
  private_threads: number
  private_thread_members: number
  reactions: number
  emoji: number
  stickers: number
  forum_tags: number
  not_imported: string[]
}

// Every page of a list Discord pages with ?after=<id>; null when the bot may not read it.
async function pages<T>(rest: DiscordRest, route: string, size: number, idOf: (item: T) => string): Promise<T[] | null> {
  const out: T[] = []
  let after = '0'
  for (;;) {
    const page = await rest.maybe<T[]>(`${route}?limit=${size}&after=${after}`)
    if (page === null) return out.length ? out : null
    out.push(...page)
    if (page.length < size) return out
    after = idOf(page.at(-1)!)
  }
}

async function importStructure(rest: DiscordRest, hub: HubAdmin, guildId: string, guild: Guild, listed: Channel[], channels: Channel[], threads: Channel[], ownerDiscordIds: string[], log: (line: string) => void): Promise<Community> {
  const roles = (await rest.maybe<Role[]>(`/guilds/${guildId}/roles`)) ?? []
  const members = await pages<Member>(rest, `/guilds/${guildId}/members`, 1000, (m) => m.user.id)
  const out: Community = { roles: roles.length, admins: [], members: members?.length ?? null, overwrites: 0, kept: { roles: 0, members: 0, overwrites: 0 }, private_threads: threads.filter((t) => t.type === 12).length, private_thread_members: 0, reactions: 0, emoji: 0, stickers: 0, forum_tags: 0, not_imported: [] }
  const withOverwrites = channels.filter((c) => c.permission_overwrites?.length)
  out.overwrites = withOverwrites.length
  // Roles and channels in one request, members in slices the hub takes.
  const first = await hub.call<{ roles_kept: number; overwrites_kept: number; members_kept: number }>('POST', `/admin/mirror/guilds/${guildId}/structure`, { roles, members: [], channels: withOverwrites.map((c) => ({ id: c.id, permission_overwrites: c.permission_overwrites })) })
  out.kept.roles = first.roles_kept
  out.kept.overwrites = first.overwrites_kept
  for (let i = 0; members && i < members.length; i += 500) {
    const r = await hub.call<{ members_kept: number }>('POST', `/admin/mirror/guilds/${guildId}/structure`, { roles: [], channels: [], members: members.slice(i, i + 500).map((m) => ({ user: m.user, nick: m.nick ?? null, roles: m.roles, joined_at: m.joined_at })) })
    out.kept.members += r.members_kept
    await hub.yieldToHub()
  }

  // Who would be an administrator on the hub once invited.
  const byRole = new Map(roles.map((r) => [r.id, BigInt(r.permissions)]))
  const owners = new Set(ownerDiscordIds)
  const everyone = byRole.get(guildId) ?? 0n
  for (const m of members ?? []) {
    if (m.user.bot) continue
    const perms = m.roles.reduce((p, r) => p | (byRole.get(r) ?? 0n), everyone)
    if (perms & ADMINISTRATOR || m.user.id === guild.owner_id) out.admins.push(owners.has(m.user.id) ? 'you' : `${m.user.global_name ?? m.user.username} (@${m.user.username})`)
  }

  // What does not come across.
  const n = out.not_imported
  if (members === null && out.private_threads) n.push(`who is in ${out.private_threads} private threads (needs the Server Members intent too): until then only admins, people who manage threads and each thread's starter see them on the hub`)
  if (members === null) n.push('the member list: Discord only gives it to a bot with the Server Members intent (developer portal, your app, Bot, Privileged Gateway Intents). Without it, only people who wrote messages come across, with no roles. Turn it on and import again')
  // Roles people hold (not @everyone's defaults, not bots' own roles) and channel grants.
  const granted = [...roles.filter((r) => r.id !== guildId && !r.managed).map((r) => BigInt(r.permissions)), ...channels.flatMap((c) => (c.permission_overwrites ?? []).map((o) => BigInt(o.allow)))].reduce((a, b) => a | b, 0n)
  const unenforced = Object.entries(UNENFORCED).filter(([, bits]) => granted & bits).map(([name]) => name)
  if (unenforced.length) n.push(`permissions the hub keeps but has no feature for: ${unenforced.join(', ')}`)
  for (const [type, kind] of Object.entries(CHANNEL_KIND)) {
    const count = listed.filter((c) => c.type === Number(type)).length
    if (count) n.push(`${count} ${kind} in the server, and any text chat in them (the hub has no voice)`)
  }
  out.forum_tags = channels.reduce((sum, c) => sum + (c.available_tags?.length ?? 0), 0)
  if (out.forum_tags) n.push(`${out.forum_tags} forum tags: forum posts come across as threads, without their tags`)
  const slow = channels.filter((c) => (c.rate_limit_per_user ?? 0) > 0).length
  if (slow) n.push(`slow mode on ${slow} channels`)
  const nsfw = channels.filter((c) => c.nsfw).length
  if (nsfw) n.push(`the age-restricted mark on ${nsfw} channels`)
  const roleIcons = roles.filter((r) => r.icon || r.unicode_emoji).length
  if (roleIcons) n.push(`icons of ${roleIcons} roles`)
  const timeouts = (members ?? []).filter((m) => m.communication_disabled_until && Date.parse(m.communication_disabled_until) > Date.now()).length
  if (timeouts) n.push(`${timeouts} members' current timeouts`)
  const stickers = (await rest.maybe<unknown[]>(`/guilds/${guildId}/stickers`))?.length ?? 0
  if (stickers) n.push(`${stickers} custom stickers`)
  const events = (await rest.maybe<unknown[]>(`/guilds/${guildId}/scheduled-events`))?.length ?? 0
  if (events) n.push(`${events} scheduled events`)
  n.push('bans, invites, the audit log, AutoMod rules, onboarding questions and integrations (Discord-only)')
  if (out.kept.roles || out.kept.members || out.kept.overwrites) log(`${guild.name}: left as the hub has them (imported before): ${out.kept.roles} roles, ${out.kept.members} members, permissions of ${out.kept.overwrites} channels`)
  return out
}

// Who reacted with what: one request per emoji on each message with reactions (up to 100 people a request).
async function copyReactions(rest: DiscordRest, hub: HubAdmin, messages: Message[]) {
  const batch: Array<{ message_id: string; emoji: string; user_ids: string[] }> = []
  let count = 0
  for (const m of messages) {
    for (const r of m.reactions ?? []) {
      const param = r.emoji.id ? `${r.emoji.name}:${r.emoji.id}` : r.emoji.name
      if (!param) continue
      const users: string[] = []
      let after = '0'
      for (;;) {
        const page = await rest.maybe<User[]>(`/channels/${m.channel_id}/messages/${m.id}/reactions/${encodeURIComponent(param)}?limit=100&after=${after}`)
        if (!page?.length) break
        users.push(...page.map((u) => u.id))
        if (page.length < 100) break
        after = page.at(-1)!.id
      }
      if (!users.length) continue
      batch.push({ message_id: m.id, emoji: r.emoji.id ? `<${r.emoji.animated ? 'a' : ''}:${r.emoji.name}:${r.emoji.id}>` : r.emoji.name!, user_ids: users })
      count += users.length
    }
    if (batch.length >= 200) await hub.call('POST', '/admin/mirror/reactions', batch.splice(0))
  }
  if (batch.length) await hub.call('POST', '/admin/mirror/reactions', batch)
  return count
}

// Private threads: who is in each, so only they see it on the hub.
async function copyThreadMembers(rest: DiscordRest, hub: HubAdmin, threads: Channel[]) {
  const list: Array<{ thread_id: string; user_ids: string[] }> = []
  for (const t of threads.filter((t) => t.type === 12)) {
    const members = await pages<{ user_id: string }>(rest, `/channels/${t.id}/thread-members`, 100, (m) => m.user_id)
    if (members?.length) list.push({ thread_id: t.id, user_ids: members.map((m) => m.user_id) })
  }
  if (!list.length) return 0
  return Number((await hub.call<{ added: number }>('POST', '/admin/mirror/thread-members', list)).added ?? 0)
}

async function copyEmoji(rest: DiscordRest, hub: HubAdmin, guildId: string) {
  let copied = 0
  for (const e of (await rest.maybe<Emoji[]>(`/guilds/${guildId}/emojis`)) ?? []) {
    const data = await download(`${standIn ?? 'https://cdn.discordapp.com'}/emojis/${e.id}.${e.animated ? 'gif' : 'png'}?size=128`)
    if (!data || data === 'gone') continue
    await hub.call('POST', `/admin/mirror/guilds/${guildId}/emoji/${e.id}?name=${encodeURIComponent(e.name)}&animated=${e.animated ? 1 : 0}`, data, { raw: true }).then(() => copied++, () => {})
  }
  return copied
}

export { THREAD_TYPES }
