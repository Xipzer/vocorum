// Getting started and moving from Discord. A second hub stands in for
// Discord (the twin speaks Discord's REST API), so the importer and the purge
// run against real HTTP: import keeps ids and verifies every message, the
// purge plans only what the hub holds, executes exactly the reviewed plan, and
// never touches a message whose files the hub has not copied.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { initHub } from '../src/config.ts'
import { importDiscord, scan } from '../src/discord/import.ts'
import { executePlan, loadPlan, makePlan, summarise, writeReport } from '../src/discord/purge.ts'
import { DiscordRest } from '../src/discord/rest.ts'
import { doctor } from '../src/doctor.ts'
import { duration, pairingLinks } from '../src/onboard-cli.ts'
import { qrMatrix } from '../src/qr.ts'
import { startTestHub } from './helpers.ts'

let discord: Awaited<ReturnType<typeof startTestHub>>
let hub: Awaited<ReturnType<typeof startTestHub>>
let rest: DiscordRest
let botId = ''
let guildId = ''
let channelId = ''
let threadId = ''
const posted: string[] = []

const config = () => ({ ...hub.config, port: hub.hub.port })

beforeAll(async () => {
  discord = await startTestHub()
  hub = await startTestHub()
  const bot = await discord.hub.store.addBot('discord-side')
  await discord.hub.reload()
  rest = new DiscordRest(`${bot.clientId}:${bot.secret}`, `${discord.hub.localUrl}/api/v10`)
  botId = (await rest.get<{ id: string }>('/users/@me')).id
  guildId = discord.config.guildId
  const channels = await rest.get<Array<{ id: string; name: string; type: number }>>(`/guilds/${guildId}/channels`)
  channelId = channels.find((c) => c.type === 0)!.id
  for (let i = 0; i < 130; i++) posted.push((await rest.call<{ id: string }>('POST', `/channels/${channelId}/messages`, { content: i === 3 ? 'API_TOKEN=abcd1234efgh5678' : `build ${i} finished` })).data!.id)
  const thread = await rest.call<{ id: string }>('POST', `/channels/${channelId}/threads`, { name: 'Release notes', type: 11 })
  threadId = thread.data!.id
  for (let i = 0; i < 3; i++) posted.push((await rest.call<{ id: string }>('POST', `/channels/${threadId}/messages`, { content: `note ${i}` })).data!.id)
})

afterAll(async () => {
  await hub?.cleanup()
  await discord?.cleanup()
})

test('scan reports servers, threads and the Message Content intent without changing anything', async () => {
  const result = await scan(rest, [guildId])
  expect(result.bot.id).toBe(botId)
  // Real Discord reports the intent; the stand-in may not answer /applications/@me for a hub bot.
  expect([true, null]).toContain(result.message_content_intent)
  expect(result.guilds[0]).toMatchObject({ id: guildId, threads: 1 })
  expect(result.guilds[0]!.unreadable).toEqual([])
})

test('import keeps Discord ids, pages past 100 messages, verifies every channel and resumes', async () => {
  const report = await importDiscord(rest, config(), hub.paths, { guilds: [guildId], log: () => {} })
  const g = report.guilds[guildId]!
  expect(g.gaps).toEqual({})
  expect(g.complete).toBe(g.channels + g.threads)
  for (const id of [posted[0]!, posted[129]!, posted.at(-1)!]) expect(await hub.hub.twin.prisma.message.findUnique({ where: { id } })).not.toBeNull()
  expect(await hub.hub.twin.prisma.message.count({ where: { channelId } })).toBe(130)
  // The copy has Discord's channels and nothing else (no extra #general of the hub's own).
  const onDiscord = new Set((await rest.get<Array<{ id: string }>>(`/guilds/${guildId}/channels`)).map((c) => c.id))
  const inHub = (await hub.hub.twin.prisma.channel.findMany({ where: { guildId } })).map((c) => c.id)
  expect(inHub.filter((id) => !onDiscord.has(id) && id !== threadId)).toEqual([])
  expect(report.secrets).toEqual([expect.objectContaining({ kind: 'env_secret', masked: 'API_TO…5678' })])
  expect(JSON.stringify(report)).not.toContain('abcd1234efgh5678')
  // A second run skips finished channels and creates nothing.
  const again = await importDiscord(rest, config(), hub.paths, { guilds: [guildId], log: () => {} })
  expect(again.guilds[guildId]!.messages_created).toBe(0)
  // Something said on Discord after the import arrives with the next run, finished channels included.
  const later = (await rest.call<{ id: string }>('POST', `/channels/${channelId}/messages`, { content: 'one more' })).data!.id
  posted.push(later)
  const third = await importDiscord(rest, config(), hub.paths, { guilds: [guildId], log: () => {} })
  expect(third.guilds[guildId]!.messages_created).toBe(1)
  expect(await hub.hub.twin.prisma.message.findUnique({ where: { id: later } })).not.toBeNull()
})

test('purge plans only what the hub holds, and never a message whose files it lacks', async () => {
  // One imported message has a file the hub holds no copy of: it must stay on Discord,
  // even when its link does not look like Discord's file servers.
  const kept = posted[5]!
  await hub.hub.twin.prisma.message.update({ where: { id: kept }, data: { attachments: JSON.stringify([{ id: '1', filename: 'a.png', url: 'http://127.0.0.1:9/attachments/1/a.png' }]) } })
  const plan = await makePlan(rest, config(), hub.paths, { guild: guildId, olderThanDays: 0, authors: ['bot'], keep: [], threads: true, kimakiKeep: false })
  const ids = new Set(plan.messages.map((m) => m[1]))
  expect(ids.has(kept)).toBe(false)
  expect(plan.skipped.not_copied).toBe(1)
  expect(ids.size).toBe(posted.length - 1)
  // The message with a secret goes first.
  expect(plan.messages[0]![1]).toBe(posted[3])
  expect(plan.threads).toEqual([threadId])
  // --channels: only that channel and its threads; an unknown one plans nothing.
  const narrow = await makePlan(rest, config(), hub.paths, { guild: guildId, olderThanDays: 0, authors: ['bot'], keep: [], threads: true, kimakiKeep: false, channels: [threadId] })
  expect(new Set(narrow.messages.map((m) => m[0]))).toEqual(new Set([threadId]))
  await expect(makePlan(rest, config(), hub.paths, { guild: guildId, olderThanDays: 0, authors: ['bot'], keep: [], threads: true, kimakiKeep: false, channels: ['1'] })).rejects.toThrow(/none of 1/)
  expect(summarise(plan)).toMatchObject({ messages: posted.length - 1, with_secrets: 1, threads_to_delete: 1 })
  // A changed plan is refused.
  const file = path.join(hub.paths.root, 'purge', `plan-${plan.id}.json`)
  const tampered = JSON.parse(fs.readFileSync(file, 'utf8'))
  tampered.messages.push([channelId, '1', 2])
  fs.writeFileSync(file.replace(plan.id, 'aaaaaaaaaaaa'), JSON.stringify({ ...tampered, id: 'aaaaaaaaaaaa' }))
  expect(() => loadPlan(hub.paths, 'aaaaaaaaaaaa')).toThrow(/changed/)

  // Someone already deleted one by hand: it is found missing by listing, not by a failed delete.
  await rest.call('DELETE', `/channels/${channelId}/messages/${posted[10]}`)
  const progress = await executePlan(rest, hub.paths, loadPlan(hub.paths, plan.id), { log: () => {} })
  expect(progress.failed).toBe(0)
  expect(progress.already_gone).toBe(1)
  expect(progress.deleted).toBe(posted.length - 2)
  expect(progress.threads_deleted).toBe(1)
  const left = await discord.hub.twin.prisma.message.findMany({ where: { channelId }, select: { id: true } })
  expect(left.map((m) => m.id)).toEqual([kept])
  expect(await discord.hub.twin.prisma.channel.findUnique({ where: { id: threadId } })).toBeNull()
  // The hub keeps everything.
  expect(await hub.hub.twin.prisma.message.count({ where: { channelId } })).toBe(131)
  // Running it again is a no-op.
  expect((await executePlan(rest, hub.paths, plan, { log: () => {} })).failed).toBe(0)
  const report = fs.readFileSync(writeReport(hub.paths), 'utf8')
  expect(report).toContain(`${posted.length - 2} of ${posted.length - 1} messages deleted, 1 already gone before this run`)
  expect(report).toContain('What Discord still keeps')
  expect(report).not.toMatch(/[\u2013\u2014]/)
})

test('doctor checks the running hub and gives a fix for every problem', async () => {
  initHub(hub.paths, { port: hub.hub.port })
  const checks = await doctor(hub.paths)
  const byId = Object.fromEntries(checks.map((c) => [c.id, c]))
  expect(byId['config']!.status).toBe('ok')
  expect(byId['hub']!.status).not.toBe('fail')
  expect(byId['permissions']!.status).toBe('ok')
  for (const c of checks) if (c.status === 'fail' || c.status === 'warn') expect(c.fix, c.id).toBeTruthy()
})

test('pairing links: the setup page by address, the app with the code in the fragment', async () => {
  const { native: _native, ...links } = await pairingLinks({ ...hub.config, privateListener: { address: '100.64.0.5', port: 47443, httpPort: 47080, names: ['desk.example.ts.net', 'hub.home.arpa'], allowedCidrs: [] } }, 'ABCDEFGHJK')
  expect(links).toEqual({ setup: 'http://100.64.0.5:47080/?code=ABCDEFGHJK', app: 'https://desk.example.ts.net:47443/#pair=ABCDEFGHJK' })
  expect(duration('30m')).toBe(1_800_000)
  expect(duration('7d')).toBe(7 * 86_400_000)
  expect(() => duration('soon')).toThrow()
})

test('QR codes are stable and sized for the text', () => {
  const m = qrMatrix('http://100.64.0.5:47080/?code=ABCDEFGHJK')
  expect(m.length).toBe(29) // version 3
  // Finder pattern in the top left corner.
  expect(m[0]!.slice(0, 7)).toEqual([true, true, true, true, true, true, true])
  expect(m[1]!.slice(0, 7)).toEqual([true, false, false, false, false, false, true])
  // Checked against a reference encoder when written; this pins the result.
  expect(crypto.createHash('sha256').update(m.map((r) => r.map(Number).join('')).join('\n')).digest('hex').slice(0, 16)).toBe(QR_HASH)
})
const QR_HASH = '8e54500fef1bfc51'

test('kimaki setup: its own bot, data folder and lock port, token only in a 0600 file', async () => {
  const { kimakiSetup } = await import('../src/kimaki-setup.ts')
  const result = await kimakiSetup(config(), hub.paths, { machine: 'desktop', guilds: [], kimaki: '/usr/bin/true', service: false, extraArgs: [] })
  expect(fs.statSync(result.envFile).mode & 0o777).toBe(0o600)
  const env = fs.readFileSync(result.envFile, 'utf8')
  expect(env).toMatch(/^KIMAKI_BOT_TOKEN=/m)
  expect(env).toMatch(new RegExp(`^KIMAKI_LOCK_PORT=${result.lockPort}$`, 'm'))
  expect(result.command).toContain(`--data-dir ${path.join(hub.paths.root, 'kimaki-data')}`)
  expect(result.command).not.toContain('KIMAKI_BOT_TOKEN')
  expect((await hub.hub.store.listBots()).some((b) => b.machine === 'desktop' && !b.revokedAt)).toBe(true)
  await expect(kimakiSetup(config(), hub.paths, { machine: 'desktop', guilds: [], kimaki: '/usr/bin/true', service: false, extraArgs: [] })).rejects.toThrow(/already has a hub bot/)
})

test('kimaki setup never starts the hub Kimaki through the wrapper that pins the Discord data folder', async () => {
  const { resolveKimaki } = await import('../src/kimaki-setup.ts')
  const dir = fs.mkdtempSync(path.join(hub.paths.root, 'bin-'))
  const wrapper = path.join(dir, 'kimaki')
  fs.writeFileSync(wrapper, "#!/bin/sh\nexport KIMAKI_DATA_DIR='/home/alice/.kimaki'\nexec /usr/bin/node /opt/kimaki/dist/cli.js \"$@\"\n")
  expect(resolveKimaki(wrapper)).toBe('/usr/bin/node /opt/kimaki/dist/cli.js')
  fs.writeFileSync(wrapper, "#!/bin/sh\nexport KIMAKI_DATA_DIR='/home/alice/.kimaki'\nnode cli.js\n")
  expect(() => resolveKimaki(wrapper)).toThrow(/KIMAKI_DATA_DIR/)
  expect(resolveKimaki('/usr/bin/true')).toBe('/usr/bin/true')
})

test('import finds archived threads and --channels keeps to the channels given', async () => {
  const archived = (await rest.call<{ id: string }>('POST', `/channels/${channelId}/threads`, { name: 'old talk', type: 11 })).data!.id
  const said = (await rest.call<{ id: string }>('POST', `/channels/${archived}/messages`, { content: 'from an archived thread' })).data!.id
  await rest.call('PATCH', `/channels/${archived}`, { archived: true })
  const other = (await rest.call<{ id: string }>('POST', `/guilds/${guildId}/channels`, { name: 'elsewhere', type: 0 })).data!.id
  const outside = (await rest.call<{ id: string }>('POST', `/channels/${other}/messages`, { content: 'not this one' })).data!.id
  await importDiscord(rest, config(), hub.paths, { guilds: [guildId], channels: [channelId], log: () => {} })
  expect(await hub.hub.twin.prisma.message.findUnique({ where: { id: said } })).not.toBeNull()
  expect(await hub.hub.twin.prisma.message.findUnique({ where: { id: outside } })).toBeNull()
})
