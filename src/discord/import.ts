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
type Channel = { id: string; guild_id?: string; type: number; name?: string; parent_id?: string | null; position?: number; message_count?: number; last_message_id?: string | null; thread_metadata?: { archived?: boolean; locked?: boolean; archive_timestamp?: string } }
type Attachment = { id: string; filename: string; url?: string; size?: number }
type Message = { id: string; channel_id: string; author: User; content?: string; timestamp?: string; type?: number; attachments?: Attachment[]; embeds?: unknown[]; components?: unknown[] }
type Guild = { id: string; name: string; icon?: string | null; owner_id?: string }

const MAX_FILE = 50 * 1024 * 1024
// Message Content intent (or its limited form): without it Discord sends empty text for other people's messages.
const MESSAGE_CONTENT = (1 << 18) | (1 << 19)

export type ImportReport = {
  started: string
  finished: string | null
  guilds: Record<string, { name: string; channels: number; threads: number; complete: number; messages_created: number; files_copied: number; files_missing: number; files_failed: number; gaps: Record<string, { name: string; missing: number; expected: number }>; unreadable: string[] }>
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

async function guildChannels(rest: DiscordRest, guildId: string) {
  const all = (await rest.get<Channel[]>(`/guilds/${guildId}/channels`)).filter((c) => c.type === 4 || TEXT_TYPES.has(c.type))
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
    guilds.push({ id, name: guild.name, owner_id: guild.owner_id ?? null, categories: channels.filter((c) => c.type === 4).length, channels: channels.filter((c) => c.type !== 4).length, threads: threads.length, thread_messages: threadMessages, unreadable })
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
      const listed = await guildChannels(rest, guildId)
      const channels = only ? listed.filter((c) => only.has(c.id) || (c.type === 4 && listed.some((x) => only.has(x.id) && x.parent_id === c.id))) : listed
      if (only && !channels.some((c) => only.has(c.id))) throw new Error(`None of ${[...only].join(', ')} is a text channel the bot can see in ${guild.name}`)
      await hub.call('POST', '/admin/mirror/channels', channels.map((c) => ({ ...c, guild_id: guildId })))
      const threads = await listThreads(rest, guildId, channels)
      // A server with thousands of agent sessions: in slices the hub takes in one request.
      for (let i = 0; i < threads.length; i += 100) await hub.call('POST', '/admin/mirror/channels', threads.slice(i, i + 100).map((t) => ({ ...t, guild_id: guildId })))
      const done = new Set(progress[guildId] ?? [])
      const stats: ImportReport['guilds'][string] = { name: guild.name, channels: channels.filter((c) => c.type !== 4).length, threads: threads.length, complete: 0, messages_created: 0, files_copied: 0, files_missing: 0, files_failed: 0, gaps: {}, unreadable: [] }
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
      await hub.call('POST', '/admin/mirror/finish', { threads: threads.map((t) => t.id), guild_id: guildId })
      await copyAvatars(hub, twin, guildId)
      log(`${guild.name}: ${stats.complete} of ${containers.length} complete, ${stats.messages_created} new messages, ${stats.files_copied} files copied, ${stats.files_missing} already gone on Discord`)
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

export { THREAD_TYPES }
