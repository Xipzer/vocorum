// Discord cleanup: plan, review, execute, report.
//
// A plan is built from what the hub holds, never from Discord: a message can
// only be deleted on Discord when the hub has it, with every file copied (or
// recorded as already gone). There is no switch to turn that off. The plan
// gets an id (a hash of its contents), and execution runs exactly that plan,
// so an agent cannot widen what the person reviewed. Execution is resumable,
// logs Discord's error code for every failure, unarchives archived threads,
// leaves system messages for the thread delete, and uses bulk delete where
// Discord allows it (messages under 14 days old).

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@libsql/client'
import type { HubConfig, HubPaths } from '../config.ts'
import { findSecrets, jobDir, openHubDb, openTwin, readJson, writeJson } from './local.ts'
import { DiscordRest, snowflakeTime, THREAD_TYPES } from './rest.ts'

export type PurgeOptions = {
  guild: string
  olderThanDays: number
  // 'me' (the hub owner and their Discord ids), 'bot' (the token's bot), 'all', or Discord user ids.
  authors: string[]
  keep: string[]
  threads: boolean
  kimakiKeep: boolean
  // Only these channels and their threads; empty means the whole server.
  channels?: string[]
}

export type Plan = {
  id: string
  created: string
  guild: { id: string; name: string }
  options: PurgeOptions
  // [channel id, message id, priority 0 = secrets, 1 = own words and files, 2 = the rest]
  messages: Array<[string, string, number]>
  threads: string[]
  skipped: { not_copied: number; other_authors: number; recent: number; kept: number; not_from_discord: number }
  authors: string[]
  // Who wrote the messages left as "other people", so a webhook or another bot can be added with --authors.
  others?: Array<{ id: string; name: string; bot: boolean; messages: number }>
}

// Message types Discord lets their author (or a moderator) delete: replies, slash command
// answers, and notices such as "pinned a message" or "started a thread". Joins, boosts and
// thread starters are left; a type Discord refuses (50021) is counted, not failed.
const DELETABLE_TYPES = new Set([0, 6, 7, 8, 9, 10, 11, 12, 18, 19, 20, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 36, 37, 38, 39, 44, 46])
const DAY = 86_400_000

function hashPlan(plan: Omit<Plan, 'id' | 'created'>) {
  return crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 12)
}

async function kimakiKeptThreads(): Promise<Set<string>> {
  const file = path.join(os.homedir(), '.kimaki', 'kimaki.db')
  if (!fs.existsSync(file)) return new Set()
  const db = createClient({ url: `file:${file}` })
  const keep = new Set<string>()
  try {
    for (const sql of [
      "SELECT thread_id AS id FROM scheduled_tasks WHERE status = 'planned' AND thread_id IS NOT NULL",
      "SELECT ts.thread_id AS id FROM session_sleeps s JOIN thread_sessions ts ON ts.session_id = s.session_id WHERE s.status NOT IN ('cancelled', 'consumed')",
    ]) {
      const rows = await db.execute(sql).catch(() => ({ rows: [] as Array<Record<string, unknown>> }))
      for (const row of rows.rows) if (row['id']) keep.add(String(row['id']))
    }
  } finally {
    db.close()
  }
  return keep
}

const CDN = /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//

export async function makePlan(rest: DiscordRest, config: HubConfig, paths: HubPaths, options: PurgeOptions): Promise<Plan> {
  const me = await rest.get<{ id: string }>('/users/@me')
  const authors = new Set<string>()
  for (const a of options.authors) {
    if (a === 'me') [config.ownerUserId, ...(config.ownerDiscordIds ?? [])].forEach((id) => authors.add(id))
    else if (a === 'bot') authors.add(me.id)
    else if (a === 'all') authors.add('*')
    else if (/^\d{1,20}$/.test(a)) authors.add(a)
    else throw new Error(`Unknown author "${a}": use me, bot, all or Discord user ids`)
  }
  const keep = new Set(options.keep)
  if (options.kimakiKeep) for (const id of await kimakiKeptThreads()) keep.add(id)
  const twin = openTwin(paths)
  const hubDb = openHubDb(paths)
  try {
    const guild = (await twin.execute({ sql: 'SELECT id, name FROM Guild WHERE id = ?', args: [options.guild] })).rows[0]
    if (!guild) throw new Error(`The hub has no server ${options.guild}. Import it first: vocorum discord import ${options.guild}`)
    const only = options.channels?.length ? new Set(options.channels) : null
    const channels = (await twin.execute({ sql: 'SELECT id, type, parentId FROM Channel WHERE guildId = ?', args: [options.guild] })).rows.filter((c) => !only || only.has(String(c['id'])) || (THREAD_TYPES.has(Number(c['type'])) && only.has(String(c['parentId']))))
    if (only && !channels.length) throw new Error(`The hub has none of ${[...only].join(', ')} in this server. Import them first.`)
    const isThread = new Map(channels.map((c) => [String(c['id']), THREAD_TYPES.has(Number(c['type']))]))
    const fromDiscord = new Set((await hubDb.execute("SELECT message_id FROM message_origins WHERE origin = 'discord'")).rows.map((r) => String(r['message_id'])))
    const cutoff = Date.now() - options.olderThanDays * DAY
    const skipped = { not_copied: 0, other_authors: 0, recent: 0, kept: 0, not_from_discord: 0 }
    const messages: Plan['messages'] = []
    const otherAuthors = new Map<string, number>()
    const threadState = new Map<string, { last: number; others: boolean; planned: number; total: number }>()
    for (const c of channels) {
      const channelId = String(c['id'])
      const rows = (await twin.execute({ sql: 'SELECT id, authorId, type, content, embeds, components, attachments FROM Message WHERE channelId = ?', args: [channelId] })).rows
      const last = rows.reduce((max, r) => Math.max(max, snowflakeTime(String(r['id']))), 0)
      const state = { last, others: false, planned: 0, total: rows.length }
      if (isThread.get(channelId)) threadState.set(channelId, state)
      const kept = keep.has(channelId) || (c['parentId'] && keep.has(String(c['parentId'])))
      for (const r of rows) {
        const id = String(r['id'])
        const author = String(r['authorId'])
        const own = authors.has('*') || authors.has(author)
        const system = !DELETABLE_TYPES.has(Number(r['type']))
        if (!own && !system) state.others = true
        if (!fromDiscord.has(id)) {
          skipped.not_from_discord++
          continue
        }
        if (kept) {
          skipped.kept++
          continue
        }
        if (!own) {
          if (!system) {
            skipped.other_authors++
            otherAuthors.set(author, (otherAuthors.get(author) ?? 0) + 1)
          }
          continue
        }
        // Whole threads go together: an active thread is left alone until it is quiet.
        if (snowflakeTime(id) > cutoff || (isThread.get(channelId) && last > cutoff)) {
          skipped.recent++
          continue
        }
        const files = JSON.parse(String(r['attachments'] ?? '[]')) as Array<{ url?: string; missing?: boolean }>
        if (files.some((f) => !f.missing && CDN.test(f.url ?? ''))) {
          skipped.not_copied++
          continue
        }
        if (system) continue
        const secret = findSecrets({ content: String(r['content'] ?? ''), embeds: JSON.parse(String(r['embeds'] ?? '[]')), components: JSON.parse(String(r['components'] ?? '[]')) }).length > 0
        const priority = secret ? 0 : author === config.ownerUserId || files.length ? 1 : 2
        messages.push([channelId, id, priority])
        state.planned++
      }
    }
    messages.sort((a, b) => a[2] - b[2] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    const threads = options.threads ? [...threadState].filter(([id, s]) => !s.others && !keep.has(id) && s.last <= cutoff && s.planned > 0).map(([id]) => id) : []
    const others = []
    for (const [id, count] of [...otherAuthors].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      const user = (await twin.execute({ sql: 'SELECT username, bot FROM User WHERE id = ?', args: [id] })).rows[0]
      others.push({ id, name: String(user?.['username'] ?? id), bot: Boolean(Number(user?.['bot'] ?? 0)), messages: count })
    }
    const body = { guild: { id: String(guild['id']), name: String(guild['name']) }, options, messages, threads, skipped, authors: [...authors], others }
    const plan: Plan = { id: hashPlan(body), created: new Date().toISOString(), ...body }
    writeJson(path.join(jobDir(paths, 'purge'), `plan-${plan.id}.json`), plan)
    return plan
  } finally {
    twin.close()
    hubDb.close()
  }
}

export function summarise(plan: Plan) {
  const byPriority = [0, 1, 2].map((p) => plan.messages.filter((m) => m[2] === p).length)
  const channels = new Set(plan.messages.map((m) => m[0])).size
  // Single deletes run at about 5 a second per channel and several channels at once; budget 10 a second.
  const minutes = Math.ceil(plan.messages.length / 10 / 60)
  return {
    plan: plan.id,
    guild: plan.guild.name,
    messages: plan.messages.length,
    with_secrets: byPriority[0],
    own_words_or_files: byPriority[1],
    other: byPriority[2],
    channels,
    threads_to_delete: plan.threads.length,
    estimate_minutes: minutes,
    not_touched: plan.skipped,
    other_authors: plan.others ?? [],
  }
}

export function loadPlan(paths: HubPaths, id: string): Plan {
  const file = path.join(jobDir(paths, 'purge'), `plan-${id}.json`)
  if (!/^[0-9a-f]{12}$/.test(id) || !fs.existsSync(file)) throw new Error(`No plan ${id}. Make one with: vocorum discord purge <guild id>`)
  const plan = JSON.parse(fs.readFileSync(file, 'utf8')) as Plan
  const { id: _id, created: _created, ...body } = plan
  if (hashPlan(body) !== id) throw new Error(`Plan ${id} was changed after it was made. Make a new one.`)
  return plan
}

export type PurgeProgress = { plan: string; started: string; finished: string | null; deleted: number; already_gone?: number; system: number; failed: number; threads_deleted: number; failures_by_code: Record<string, number> }

// Message ids still in a channel on Discord, null when the channel itself is gone,
// undefined when the bot cannot list it (then every planned delete is tried).
async function stillOnDiscord(rest: DiscordRest, channel: string): Promise<Set<string> | null | undefined> {
  const ids = new Set<string>()
  let before = ''
  for (;;) {
    const page = await rest.call<Array<{ id: string }>>('GET', `/channels/${channel}/messages?limit=100${before ? `&before=${before}` : ''}`)
    if (page.status === 404) return null
    if (!page.data) return undefined
    for (const m of page.data) ids.add(m.id)
    if (page.data.length < 100) return ids
    before = page.data.at(-1)!.id
  }
}

export async function executePlan(rest: DiscordRest, paths: HubPaths, plan: Plan, { log = console.log, workers = 4 }: { log?: (line: string) => void; workers?: number } = {}) {
  const dir = jobDir(paths, 'purge')
  const doneFile = path.join(dir, `done-${plan.id}.txt`)
  const actionsFile = path.join(dir, `actions-${plan.id}.jsonl`)
  const progressFile = path.join(dir, `progress-${plan.id}.json`)
  const done = new Set(fs.existsSync(doneFile) ? fs.readFileSync(doneFile, 'utf8').split('\n').filter(Boolean) : [])
  const progress = readJson<PurgeProgress>(progressFile, { plan: plan.id, started: new Date().toISOString(), finished: null, deleted: 0, system: 0, failed: 0, threads_deleted: 0, failures_by_code: {} })
  progress.finished = null
  progress.failed = 0
  progress.failures_by_code = {}
  const mark = (ids: string[]) => {
    for (const id of ids) done.add(id)
    fs.appendFileSync(doneFile, ids.map((id) => `${id}\n`).join(''), { mode: 0o600 })
  }
  const act = (record: Record<string, unknown>) => fs.appendFileSync(actionsFile, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, { mode: 0o600 })
  const fail = (channel: string, id: string, status: number, code: number | null) => {
    progress.failed++
    const key = code ? String(code) : `http ${status}`
    progress.failures_by_code[key] = (progress.failures_by_code[key] ?? 0) + 1
    act({ op: 'delete_failed', channel, id, status, code })
  }
  const reason = 'Moved to a self-hosted hub'
  // Archived threads refuse deletes (50083) until they are unarchived; locked ones (50083 too) need unlocking.
  const withThreadOpen = async <T>(channel: string, run: () => Promise<{ status: number; code: number | null; data: T | null }>) => {
    let result = await run()
    if (result.code === 50083) {
      await rest.call('PATCH', `/channels/${channel}`, { archived: false, locked: false }, reason)
      result = await run()
    }
    return result
  }

  const byChannel = new Map<string, string[]>()
  for (const [channel, id] of plan.messages) if (!done.has(id)) byChannel.set(channel, [...(byChannel.get(channel) ?? []), id])
  const queue = [...byChannel]
  const save = () => writeJson(progressFile, progress)
  const timer = setInterval(() => {
    save()
    log(`deleted ${progress.deleted}, failed ${progress.failed}, ${queue.length} channels left`)
  }, 60_000)
  timer.unref()

  async function worker() {
    for (;;) {
      const next = queue.shift()
      if (!next) return
      const [channel, planned] = next
      // Listing what is still there costs one request per 100 messages; deleting what is
      // already gone costs one each. Earlier runs and people deleting by hand make this common.
      const present = await stillOnDiscord(rest, channel)
      const gone = present === undefined ? [] : present === null ? planned : planned.filter((id) => !present.has(id))
      if (gone.length) {
        mark(gone)
        progress.already_gone = (progress.already_gone ?? 0) + gone.length
      }
      const ids = present === undefined ? planned : present === null ? [] : planned.filter((id) => present.has(id))
      const bulkCutoff = Date.now() - 13.5 * DAY
      let recent = ids.filter((id) => snowflakeTime(id) > bulkCutoff)
      const single = ids.filter((id) => snowflakeTime(id) <= bulkCutoff)
      while (recent.length >= 2) {
        const batch = recent.slice(0, 100)
        recent = recent.slice(100)
        const result = await withThreadOpen(channel, () => rest.call('POST', `/channels/${channel}/messages/bulk-delete`, { messages: batch }, reason))
        if (result.status === 204 || result.status === 200) {
          mark(batch)
          progress.deleted += batch.length
          act({ op: 'bulk_delete', channel, count: batch.length })
        } else single.push(...batch)
      }
      single.push(...recent)
      for (const id of single) {
        const result = await withThreadOpen(channel, () => rest.call('DELETE', `/channels/${channel}/messages/${id}`, undefined, reason))
        if (result.status === 204 || result.status === 200 || result.code === 10008) {
          mark([id])
          progress.deleted++
        } else if (result.code === 50021) {
          // A system message: it cannot be deleted on its own and goes with its thread.
          mark([id])
          progress.system++
          act({ op: 'system_message', channel, id })
        } else fail(channel, id, result.status, result.code)
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: workers }, worker))
    const planned = new Map<string, string[]>()
    for (const [channel, id] of plan.messages) planned.set(channel, [...(planned.get(channel) ?? []), id])
    for (const thread of plan.threads) {
      if (done.has(`thread:${thread}`)) continue
      if (!(planned.get(thread) ?? []).every((id) => done.has(id))) continue
      const result = await rest.call('DELETE', `/channels/${thread}`, undefined, reason)
      if (result.status === 200 || result.status === 204 || result.code === 10003) {
        mark([`thread:${thread}`])
        progress.threads_deleted++
        act({ op: 'thread_deleted', channel: thread })
      } else fail(thread, thread, result.status, result.code)
    }
  } finally {
    clearInterval(timer)
    progress.finished = new Date().toISOString()
    save()
  }
  return progress
}

export function statusOf(paths: HubPaths) {
  const dir = jobDir(paths, 'purge')
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('progress-'))
    .map((f) => {
      const progress = readJson<PurgeProgress | null>(path.join(dir, f), null)
      const plan = progress ? readJson<Plan | null>(path.join(dir, `plan-${progress.plan}.json`), null) : null
      return progress && plan ? { ...progress, guild: plan.guild.name, planned: plan.messages.length, threads_planned: plan.threads.length } : null
    })
    .filter((p) => p !== null)
}

// The honest account: what went, what failed and why, and what Discord keeps.
export function writeReport(paths: HubPaths): string {
  const runs = statusOf(paths)
  const imports = readJson<{ guilds?: Record<string, { name: string; complete: number; channels: number; threads: number; files_missing: number }>; secrets?: Array<{ kind: string; masked: string; channel: string; date: string }> }>(path.join(paths.root, 'import', 'report.json'), {})
  const codes: Record<string, string> = { '50001': 'no access to the channel', '50013': 'missing permission (often a locked thread or someone else\'s message)', '50083': 'thread archived and could not be reopened', '10003': 'channel already gone', 'http 0': 'Discord kept failing; run execute again' }
  const lines = ['# Discord cleanup report', '', `Written ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by vocorum discord report.`, '']
  lines.push('## What the hub holds', '')
  for (const g of Object.values(imports.guilds ?? {})) lines.push(`- ${g.name}: ${g.complete} of ${g.channels + g.threads} channels and threads fully imported. ${g.files_missing} files were already gone on Discord.`)
  lines.push('', '## What was deleted on Discord', '')
  for (const r of runs) {
    lines.push(`- ${r.guild} (plan ${r.plan}): ${r.deleted} of ${r.planned} messages deleted, ${r.already_gone ?? 0} already gone before this run, ${r.threads_deleted} of ${r.threads_planned} threads deleted, ${r.system} system messages left for their thread, ${r.failed} failed. ${r.finished ? 'Finished' : 'Still running or stopped'}.`)
    for (const [code, count] of Object.entries(r.failures_by_code)) lines.push(`  - ${count} failed with ${code}: ${codes[code] ?? 'see actions log'}`)
  }
  if (!runs.length) lines.push('- Nothing yet.')
  if (imports.secrets?.length) {
    lines.push('', '## Secrets that appeared in Discord (rotate them; deleting the message does not undo the exposure)', '')
    for (const s of imports.secrets) lines.push(`- ${s.kind} ${s.masked} in ${s.channel} on ${s.date}`)
  }
  lines.push(
    '',
    '## What Discord still keeps',
    '',
    '- Other people\'s messages, unless they delete them or the server is deleted.',
    '- Your direct messages with bots: a bot cannot delete what you wrote there. Delete them by hand.',
    '- Messages newer than your last import, and anything kept by the plan options (recent or kept threads).',
    '- Discord\'s own backups and anything under legal hold. Discord says deleted data leaves its systems over time; nobody outside Discord can verify or speed that up.',
    '- Audit log entries for these deletions (counts, not content) for 45 days.',
    '- Copies outside Discord: notifications already shown, other people\'s devices and caches, data packages requested earlier, screenshots.',
    '',
    '## To finish',
    '',
    '1. Delete the server (Server Settings, Delete Server). Bots usually cannot.',
    '2. Remove the bot application in the Discord developer portal.',
    '3. Delete your direct messages with bots by hand.',
    '4. Optional: request your data package (User Settings, Data and Privacy) to check what remains, then delete the account.',
    '',
  )
  const file = path.join(jobDir(paths, 'purge'), 'PURGE-REPORT.md')
  fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 })
  return file
}
