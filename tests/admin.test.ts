// The Admin server: only the owner and the admin bot. No other bot can read or
// post there, no request can add anyone or change it, approval cards describe
// changes in the hub's words, and the admin agent's limits deny everything but
// vocorum commands.

import fs from 'node:fs'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { readSecret, saveConfig } from '../src/config.ts'
import { ADMIN_GUILD_NAME, ADMIN_MACHINE, adminStatus, shieldPng, workspacePolicy, writeWorkspace } from '../src/admin.ts'
import { startTestHub } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
let adminGuild = ''
let adminChannel = ''
let homeChannel = ''
const tokens: Record<string, string> = {}
let admin: (method: string, route: string, body?: unknown) => Promise<{ status: number; json: any }>

beforeAll(async () => {
  t = await startTestHub()
  const token = readSecret(t.paths.adminToken)
  admin = async (method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${t.hub.port}${route}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, json: await res.json().catch(() => null) }
  }
  adminGuild = (await t.hub.store.addGuild(ADMIN_GUILD_NAME)).id
  saveConfig(t.paths, { ...t.config, adminGuildId: adminGuild, adminBotReady: true })
  for (const machine of [ADMIN_MACHINE, 'desk']) {
    const minted = await t.hub.store.addBot(machine)
    tokens[machine] = `${minted.clientId}:${minted.secret}`
  }
  await t.hub.store.setBotGuilds(ADMIN_MACHINE, [adminGuild])
  // A bot told to join the Admin server is kept out of it.
  await t.hub.store.setBotGuilds('desk', [t.config.guildId, adminGuild])
  await t.hub.reload()
  adminChannel = (await t.hub.twin.prisma.channel.create({ data: { id: '1200000000000000901', guildId: adminGuild, type: 0, name: 'admin' } })).id
  homeChannel = (await t.hub.twin.prisma.channel.findFirstOrThrow({ where: { guildId: t.config.guildId, type: 0 } })).id
})

afterAll(() => t?.cleanup())

const post = (machine: string, channel: string) =>
  fetch(`http://127.0.0.1:${t.hub.port}/api/v10/channels/${channel}/messages`, { method: 'POST', headers: { authorization: `Bot ${tokens[machine]}`, 'content-type': 'application/json' }, body: JSON.stringify({ content: 'hello' }) })

test('only the admin bot reads or posts in the Admin server, and it stays there', async () => {
  expect((await post(ADMIN_MACHINE, adminChannel)).status).toBe(200)
  expect((await post('desk', adminChannel)).status).toBe(403)
  expect((await fetch(`http://127.0.0.1:${t.hub.port}/api/v10/channels/${adminChannel}/messages`, { headers: { authorization: `Bot ${tokens['desk']}` } })).status).toBe(403)
  expect((await post('desk', homeChannel)).status).toBe(200)
  expect((await post(ADMIN_MACHINE, homeChannel)).status).toBe(403)
  // The Admin server starts with no #general.
  expect(await t.hub.twin.prisma.channel.count({ where: { guildId: adminGuild, name: 'general' } })).toBe(0)
})

test('no request adds anyone to the Admin server or changes it', async () => {
  const invite = await admin('POST', '/admin/requests', { method: 'POST', route: `/client/guilds/${adminGuild}/invites`, body: { username: 'mallory' } })
  expect(invite.status).toBe(400)
  expect(invite.json.error ?? invite.json.message).toMatch(/Admin server/)
  expect((await admin('POST', '/admin/requests', { method: 'PUT', route: `/client/channels/${adminChannel}/permissions/${adminGuild}`, body: { type: 0, allow: '1024', deny: '0' } })).status).toBe(400)
  expect((await admin('POST', '/admin/requests', { method: 'PATCH', route: `/client/guilds/${adminGuild}`, body: { name: 'Lobby' } })).status).toBe(400)
  expect((await admin('POST', '/admin/requests', { method: 'POST', route: `/client/guilds/${t.config.guildId}/invites`, body: { username: 'sam' } })).status).toBe(200)
})

test('the approval card says what the change does, whatever the requester claims', async () => {
  const role = await admin('POST', '/admin/requests', { method: 'POST', route: `/client/guilds/${t.config.guildId}/roles`, body: { name: 'helpers', permissions: String(1n << 3n) }, summary: 'Add a harmless label' })
  expect(role.status).toBe(200)
  expect(role.json.summary).not.toMatch(/harmless/)
  expect(role.json.summary).toMatch(/ADMINISTRATOR/)
  const channel = await admin('POST', '/admin/requests', { method: 'PUT', route: `/client/channels/${homeChannel}/permissions/${t.config.guildId}`, body: { type: 0, allow: String(1n << 10n), deny: String(1n << 11n) }, summary: 'nothing' })
  expect(channel.json.summary).toMatch(/may view_channel, may not send_messages/)
})

test('the admin agent may only run vocorum commands, and never those that widen access or touch its limits', async () => {
  const { policies, permissions } = workspacePolicy()
  expect(policies[0]).toEqual({ action: 'tool.use', resource: 'shell:*', effect: 'deny' })
  expect(policies[1]).toEqual({ action: 'tool.use', resource: 'shell:vocorum *', effect: 'allow' })
  const denied = policies.filter((p) => p.effect === 'deny').map((p) => p.resource)
  for (const r of ['shell:vocorum admin setup *', 'shell:vocorum people invite *', 'shell:vocorum bots add *', 'edit:*', 'external_directory:*', 'webfetch:*', 'websearch:*', 'subagent:*']) expect(denied).toContain(r)
  expect(permissions[0]).toEqual({ action: '*', resource: '*', effect: 'deny' })
  expect(permissions).toContainEqual({ action: 'shell', resource: 'vocorum *', effect: 'ask' })
  expect(permissions).toContainEqual({ action: 'shell', resource: 'vocorum request *', effect: 'allow' })
  writeWorkspace(t.paths)
  const checks = await adminStatus({ ...t.config, adminGuildId: adminGuild, adminBotReady: true }, t.paths)
  expect(checks.find((c) => c.id === 'admin-limits')?.status).toBe('ok')
  expect(checks.find((c) => c.id === 'admin-members')?.status).toBe('ok')
  expect(checks.find((c) => c.id === 'admin-bots')?.status).toBe('warn')
  fs.appendFileSync(`${t.paths.root}/admin/opencode.jsonc`, ' ')
  expect((await adminStatus({ ...t.config, adminGuildId: adminGuild, adminBotReady: true }, t.paths)).find((c) => c.id === 'admin-limits')?.status).toBe('fail')
})

test('projects wires a folder to a channel through the hub Kimaki, never in the Admin server or the state folder', async () => {
  const { projects } = await import('../src/admin.ts')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocorum-projects-'))
  const store = path.join(dir, 'mappings.json')
  fs.writeFileSync(store, '[]')
  // A stand-in Kimaki: `project list --json` and `project add <dir> --guild <id>`.
  const fake = path.join(dir, 'kimaki.mjs')
  fs.writeFileSync(fake, `import fs from 'node:fs'
const a = process.argv.slice(2), rows = JSON.parse(fs.readFileSync(${JSON.stringify(store)}, 'utf8'))
if (a[0] === 'project' && a[1] === 'list') console.log(JSON.stringify(rows))
else if (a[0] === 'project' && a[1] === 'add') { rows.push({ channelId: '${homeChannel}', directory: a[2], guildId: a[a.indexOf('--guild') + 1] }); fs.writeFileSync(${JSON.stringify(store)}, JSON.stringify(rows)) }
else process.exit(2)
`)
  fs.writeFileSync(path.join(t.paths.root, 'desk-pc.env'), `KIMAKI_BOT_TOKEN=x\nKIMAKI_LOCK_PORT=29999\n# kimaki: ${process.execPath} ${fake}\n`, { mode: 0o600 })
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'vocorum-repo-'))
  const config = { ...t.config, adminGuildId: adminGuild }
  const added = await projects(config, t.paths, { add: project })
  expect(added.added).toMatchObject({ directory: project, guildId: t.config.guildId, channelId: homeChannel })
  expect((await projects(config, t.paths, {})).list.map((p) => p.directory)).toEqual([project])
  await expect(projects(config, t.paths, { add: project, guild: ADMIN_GUILD_NAME })).rejects.toThrow(/Admin server/)
  await expect(projects(config, t.paths, { add: t.paths.root })).rejects.toThrow(/state folder/)
  fs.rmSync(path.join(t.paths.root, 'desk-pc.env'))
})

test('the Admin server gets a shield icon the hub accepts', async () => {
  const res = await fetch(`http://127.0.0.1:${t.hub.port}/admin/mirror/guilds/${adminGuild}/icon`, { method: 'POST', headers: { authorization: `Bearer ${readSecret(t.paths.adminToken)}`, 'content-type': 'application/octet-stream' }, body: shieldPng() })
  expect(res.status).toBe(200)
  expect(t.hub.guilds.find((g) => g.id === adminGuild)?.icon).toMatch(/^[0-9a-f]{32}$/)
})
