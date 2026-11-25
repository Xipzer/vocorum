// All publishers, files and readers belong to the disposable loopback hub.
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { Client, ChannelType, GatewayIntentBits, type TextChannel } from 'discord.js'
import WebSocket from 'ws'
import { beforeAll, afterAll, expect, test, vi } from 'vitest'
import { P } from '../src/access.ts'
import { Hub } from '../src/hub.ts'
import { BOARD_FILE } from '../src/workspace-board.ts'
import { LOGIN, TestDevice, pairedDevice, startTestHub, waitFor } from './helpers.ts'

type Version = { v: number; title: string; markdown: string; updated_at: string }
type Frame = { t: string; d: { thread_id?: string; slot?: string; v?: number; id?: string } }
const login = 'reader@example.test', machine = 'fixture-publisher'
let t: Awaited<ReturnType<typeof startTestHub>>, owner: TestDevice, tablet: TestDevice, member: TestDevice, memberId: string
let bot: Client<true>, token: string, peer: string, parent: TextChannel
const sockets: WebSocket[] = []
const ownerFrames: Frame[] = [], memberFrames: Frame[] = [], botFrames: string[] = []
const route = (id: string) => `/client/threads/${id}/panels`
const view = (id: string, device = owner) => device.json(route(id))
const seen = (id: string, v: unknown, device = owner) => device.fetch(`${route(id)}/board/seen`, { method: 'POST', json: { v } })
const document = (v: number, body = `## Now\nSample revision ${v}.`, title = 'Field notes') => `---\npanel: board\ntitle: ${title}\nv: ${v}\n---\n${body}`
const file = (text: string) => ({ name: BOARD_FILE, attachment: Buffer.from(text) })
const filePath = (uri: string) => { const url = new URL(uri); return url.pathname + url.search }
const versions = (frames: Frame[], thread: string) => frames.filter(f => f.t === 'PANEL_UPDATE' && f.d.thread_id === thread).map(f => f.d.v)
async function publish(id: string, text: string, mid?: string, credential = token) {
  const form = new FormData(); form.set('payload_json', JSON.stringify({ content: 'Board updated', attachments: [{ id: 0, filename: BOARD_FILE }] }))
  form.set('files[0]', new Blob([text], { type: 'text/markdown' }), BOARD_FILE)
  return fetch(`${t.hub.localUrl}/api/v10/channels/${id}/messages${mid ? '/'+mid : ''}`, { method: mid ? 'PATCH' : 'POST', headers: { authorization: `Bot ${credential}` }, body: form })
}
async function listen(device: TestDevice, identity: string, frames: Frame[]) {
  const ws = new WebSocket(`ws://127.0.0.1:${t.hub.port}/client/events`, { headers: { origin: device.origin, cookie: device.cookie!, 'tailscale-user-login': identity } })
  sockets.push(ws); ws.on('message', raw => frames.push(JSON.parse(String(raw))))
  await waitFor(() => frames.some(f => f.t === 'HELLO'))
}
async function closeClients() {
  await Promise.all(sockets.splice(0).map(async s => { const done = once(s, 'close'); s.close(); await done }))
  if (bot) await bot.destroy()
  await t.hub.events.flush()
}
beforeAll(async () => {
  vi.stubEnv('VOCORUM_KIMAKI_DIRS', path.join(os.tmpdir(), 'no-workspace-peers-fixture')); vi.stubEnv('VOCORUM_SYSTEMCTL', '/bin/false')
  t = await startTestHub({ extensions: [] }); owner = await pairedDevice(t.hub); tablet = await pairedDevice(t.hub, 'tablet')
  const invite = await owner.json(`/client/guilds/${t.config.guildId}/invites`, { method: 'POST', json: { username: 'reader' } }); memberId = invite.user.id
  await t.hub.store.setProfile(memberId, { tailscaleLogin: login })
  const one = await t.hub.store.addBot(machine), two = await t.hub.store.addBot('fixture-peer'); token = `${one.clientId}:${one.secret}`; peer = `${two.clientId}:${two.secret}`
  await t.hub.reload(); member = new TestDevice(t.hub, { 'tailscale-user-login': login }); await member.pair(invite.code)
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], rest: { api: `${t.hub.localUrl}/api` } })
  client.on('raw', p => { if (p.t === 'PANEL_UPDATE') botFrames.push(p.t) })
  const ready = once(client, 'clientReady'); await client.login(token); await ready; bot = client as Client<true>
  parent = await bot.guilds.cache.get(t.config.guildId)!.channels.create({ name: 'sample-project', type: ChannelType.GuildText })
  await Promise.all([listen(owner, LOGIN, ownerFrames), listen(member, login, memberFrames)])
})
afterAll(async () => { try { if (t) { await closeClients(); await t.cleanup() } } finally { vi.unstubAllEnvs() } })

test('a real thread bot edits one carrier; storage, events and seen cursors survive idempotent delivery', async () => {
  const th = await parent.threads.create({ name: 'field-notes' }), id = th.id
  expect(await view(id)).toEqual({ board: null, seen_version: null })
  const first = await th.send({ content: 'Board updated', files: [file(document(1))] })
  const originalFile = filePath(first.attachments.first()!.url)
  const retryCreate = await publish(id, document(1)); expect(retryCreate.status).toBe(200); expect(await retryCreate.json()).toMatchObject({ id: first.id })
  const tokenLike = 'sk-' + 'a'.repeat(32), raw = 'material-only-in-the-fixture'
  const body = `## Now\n${tokenLike}\n-----BEGIN PRIVATE KEY-----\n${raw}\n-----END PRIVATE KEY-----\n  API_TOKEN="fixture value with spaces"\nDone.`
  const edited = await first.edit({ content: 'Board updated again', attachments: [], files: [file(document(2, body, tokenLike))] })
  expect(edited.id).toBe(first.id)
  const safe = '## Now\n[redacted]\n[redacted]\n[redacted]\nDone.'
  const s = await view(id, member); expect(s.board).toMatchObject({ thread_id: id, message_id: first.id, machine, versions: [{ v: 1 }, { v: 2, title: '[redacted]', markdown: safe }] })
  expect(s.board.versions[1].updated_at).toBe(edited.editedAt!.toISOString()); expect(s.seen_version).toBeNull()
  const url = edited.attachments.first()!.url; expect((await fetch(url)).status).toBe(404)
  const download = await member.fetch(filePath(url)); expect(download.status).toBe(200); expect(download.headers.get('cache-control')).toBe('no-store')
  const bytes = await download.text(); expect(bytes).toContain(safe); expect(bytes).not.toContain(tokenLike); expect(bytes).not.toContain(raw)
  await waitFor(() => versions(memberFrames, id).length === 2)
  const frame = memberFrames.find(f => f.t === 'PANEL_UPDATE' && f.d.thread_id === id)!
  expect(frame.d).toEqual({ thread_id: id, slot: 'board', v: 1 })
  expect((await seen(id, 2)).status).toBe(204); expect((await seen(id, 1)).status).toBe(204)
  expect((await view(id)).seen_version).toBe(2); expect((await view(id, tablet)).seen_version).toBeNull()
  expect((await seen(id, 3)).status).toBe(409); expect((await seen(id, '2')).status).toBe(400)
  const replay = await publish(id, document(2, body, tokenLike), first.id)
  expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ id: first.id })
  expect((await publish(id, document(2, 'Conflicting version'), first.id)).status).toBe(409)
  expect((await publish(id, document(1), first.id)).status).toBe(409)
  expect((await publish(id, document(3))).status).toBe(409)
  for (let v = 3; v <= 23; v++) expect((await publish(id, document(v), first.id)).status).toBe(200)
  const last = await view(id); expect(last.board.versions.map((v: Version) => v.v)).toEqual(Array.from({ length: 20 }, (_, i) => i+4))
  expect(last.seen_version).toBe(2); expect((await seen(id, 3)).status).toBe(409)
  expect((await owner.fetch(originalFile)).status).toBe(404)
  expect((await t.hub.store.db.execute("SELECT count(*) AS n FROM attachments WHERE uploaded_by='panel:board'")).rows[0]?.n).toBe(20)
  await waitFor(() => versions(ownerFrames, id).includes(23)); expect(versions(ownerFrames, id)).toEqual(Array.from({ length: 23 }, (_, i) => i+1))
  expect(botFrames).toEqual([])
})

test('denied readers get no snapshot, seen write or update; archive and lock preserve read-only history', async () => {
  const channel = await parent.guild.channels.create({ name: 'scoped-project', type: ChannelType.GuildText }); const th = await channel.threads.create({ name: 'scoped-thread' }), id = th.id
  await th.send('Existing publisher.'); const msg = await th.send({ files: [file(document(1))] }); await waitFor(() => versions(memberFrames, id).includes(1))
  await owner.json(`/client/channels/${channel.id}/permissions/${memberId}`, { method: 'PUT', json: { type: 1, allow: '0', deny: String(P.READ_MESSAGE_HISTORY) } })
  expect((await member.fetch(route(id))).status).toBe(404); expect((await seen(id, 1, member)).status).toBe(404)
  expect((await member.fetch(filePath(msg.attachments.first()!.url))).status).toBe(404)
  expect((await new TestDevice(t.hub).fetch(route(id))).status).toBe(401); expect((await owner.fetch(route(channel.id))).status).toBe(404)
  await msg.edit({ attachments: [], files: [file(document(2))] }); await waitFor(() => versions(ownerFrames, id).includes(2))
  await th.setArchived(true); expect((await publish(id, document(3), msg.id)).status).toBe(403); expect((await view(id)).board.versions.at(-1).v).toBe(2)
  await th.setArchived(false); await th.setLocked(true); expect((await publish(id, document(3), msg.id)).status).toBe(403); expect((await seen(id, 2)).status).toBe(204)
  expect((await fetch(`${t.hub.localUrl}/api/v10/channels/${id}/messages/${msg.id}`, { method: 'DELETE', headers: { authorization: `Bot ${token}` } })).status).toBe(403)
  await th.setLocked(false); await owner.json(`/client/channels/${channel.id}/permissions/${bot.user.id}`, { method: 'PUT', json: { type: 1, allow: '0', deny: String(P.ATTACH_FILES) } })
  expect((await publish(id, document(3), msg.id)).status).toBe(403); expect(versions(memberFrames, id)).toEqual([1])
})

test('two registered machines with one visible bot cannot take over each other’s carrier', async () => {
  const th = await parent.threads.create({ name: 'single-writer' }), id = th.id
  const api = `${t.hub.localUrl}/api/v10/channels/${id}/messages`
  const res = await Promise.all([publish(id, document(1)), publish(id, document(1), undefined, peer)])
  expect(res.map(r => r.status).sort()).toEqual([200,403]); const winner = res.findIndex(r => r.ok), carrier = (await res[winner]!.json() as { id: string }).id
  expect((await publish(id, document(2), carrier, winner === 0 ? peer : token)).status).toBe(403)
  expect((await fetch(`${api}/${carrier}`, { method: 'DELETE', headers: { authorization: `Bot ${winner === 0 ? peer : token}` } })).status).toBe(403)
  expect((await view(id)).board.versions).toHaveLength(1)
})

test('validates local UTF-8 bytes and the byte limit; ordinary files and external-looking metadata do not publish', async () => {
  const th = await parent.threads.create({ name: 'local-files' }), id = th.id; await th.send('Publisher present.')
  await th.send({ files: [{ name: 'notes.md', attachment: Buffer.from(document(1)) }] }); expect((await view(id)).board).toBeNull()
  expect((await publish(id, document(1, 'é'.repeat(8192)))).status).toBe(413)
  expect((await publish(id, '---\npanel: draft\nv: 1\ntitle: Notes\n---\nDraft')).status).toBe(400)
  const api = `${t.hub.localUrl}/api/v10/channels/${id}/messages`
  await fetch(api, { method: 'POST', headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ attachments: [{ id: '123', filename: BOARD_FILE, url: 'https://example.invalid/board.panel.md' }] }) })
  expect(await view(id)).toEqual({ board: null, seen_version: null })
  const exact = document(1, '').padEnd(16 * 1024, 'x')
  expect((await publish(id, exact + 'x')).status).toBe(413)
  const msg = await th.send({ files: [file(exact)] }); await seen(id, 1)
  await msg.delete(); await waitFor(async () => (await view(id)).board === null); expect((await view(id)).seen_version).toBeNull()
})

test('a restarted hub returns the retained snapshot and per-device cursor', async () => {
  const th = await parent.threads.create({ name: 'restart-proof' }), id = th.id; await th.send('Publisher present.')
  await th.send({ files: [file(document(1))] }); await seen(id, 1); const before = await view(id), cookie = owner.cookie
  await closeClients(); await t.hub.stop(); t.hub = new Hub({ paths: t.paths, config: t.config, port: 0, extensions: [] }); await t.hub.start()
  owner = new TestDevice(t.hub); owner.cookie = cookie
  expect(await view(id)).toEqual(before); expect(before.seen_version).toBe(1)
})
