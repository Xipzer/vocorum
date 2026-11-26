// Regression tests for the pre-release security review: each block is one
// finding, attacked the way the review's exploit did.

import net from 'node:net'
import { afterAll, beforeAll, expect, test } from 'vitest'
import WebSocket from 'ws'
import { Client, GatewayIntentBits, type TextChannel } from 'discord.js'
import { AttachmentStore, toOggOpus } from '../src/attachments.ts'
import { P } from '../src/access.ts'
import { PrivateListener } from '../src/private-listener.ts'
import { LOGIN, TestDevice, pairedDevice, startTestHub, waitFor } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
let bot: Client
let botToken = ''
let owner: TestDevice
let general: TextChannel

beforeAll(async () => {
  t = await startTestHub()
  const minted = await t.hub.store.addBot('desktop')
  botToken = `${minted.clientId}:${minted.secret}`
  await t.hub.reload()
  bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages], rest: { api: `${t.hub.localUrl}/api`, version: '10' } })
  const ready = new Promise<void>((resolve) => bot.once('clientReady', () => resolve()))
  await bot.login(botToken)
  await ready
  owner = await pairedDevice(t.hub, 'owner-laptop')
  const state = await owner.json('/client/state')
  general = (await bot.channels.fetch(state.channels.find((c: { name: string }) => c.name === 'general').id)) as TextChannel
})

afterAll(async () => {
  await bot.destroy()
  await t.cleanup()
})

const api = (path: string, init: RequestInit = {}) => fetch(`${t.hub.localUrl}/api/v10${path}`, init)

test('C1: webhook and interaction routes need the interaction token, and only reach its own messages', async () => {
  const secret = await owner.json(`/client/channels/${general.id}/messages`, { method: 'POST', json: { content: 'owner secret' } })
  // No token, a guessed token, the old predictable form: nothing.
  for (const token of ['x', 'test-interaction-token-1', `itk.${'a'.repeat(43)}`]) {
    expect((await api(`/webhooks/${t.config.botUserId}/${token}/messages/${secret.id}`)).status).toBeGreaterThanOrEqual(401)
    expect((await api(`/webhooks/${t.config.botUserId}/${token}/messages/${secret.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"content":"forged"}' })).status).toBeGreaterThanOrEqual(401)
    expect((await api(`/webhooks/${t.config.botUserId}/${token}/messages/${secret.id}`, { method: 'DELETE' })).status).toBeGreaterThanOrEqual(401)
  }
  expect((await owner.json(`/client/channels/${general.id}/messages`)).messages.find((m: { id: string }) => m.id === secret.id).content).toBe('owner secret')

  // A real interaction: its token is random, and it reaches its own messages only.
  const tokens: string[] = []
  const listener = (interaction: import('discord.js').Interaction) => {
    tokens.push(interaction.token)
    if (interaction.isButton()) void interaction.deferUpdate()
  }
  bot.on('interactionCreate', listener)
  const prompt = await general.send({ content: 'pick', components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Go', custom_id: 'go' }] }] } as never)
  await owner.json('/client/interactions', { method: 'POST', json: { type: 'button', channelId: general.id, messageId: prompt.id, customId: 'go' } })
  const token = await waitFor(() => tokens[0])
  expect(token).toMatch(/^itk\.[A-Za-z0-9_-]{43}$/)
  expect((await api(`/webhooks/${t.config.botUserId}/${token}/messages/${secret.id}`)).status).toBe(404)
  expect((await api(`/webhooks/${t.config.botUserId}/${token}/messages/${prompt.id}`)).status).toBe(200)
  expect((await api(`/webhooks/1/${token}/messages/${prompt.id}`)).status).toBe(404)
  bot.off('interactionCreate', listener)
  // Answering someone else's interaction needs its token too.
  expect((await api(`/interactions/1/${'b'.repeat(40)}/callback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":6}' })).status).toBeGreaterThanOrEqual(401)
})

test('H1: a malformed Host on a WebSocket upgrade does not take the hub down', async () => {
  await new Promise<void>((resolve) => {
    const socket = net.connect(t.hub.port, '127.0.0.1', () => socket.write('GET /gateway HTTP/1.1\r\nHost: [\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'))
    socket.on('close', () => resolve())
    socket.on('error', () => resolve())
  })
  expect((await fetch(`${t.hub.localUrl}/client/auth/status`, { headers: { 'tailscale-user-login': LOGIN } })).status).toBe(200)
})

test('H2: a bot cannot reach a message in another guild through its own channel id', async () => {
  const other = await t.hub.store.addGuild('Side Projects')
  await t.hub.reload()
  const channel = await owner.json(`/client/guilds/${other.id}/channels`, { method: 'POST', json: { name: 'private' } })
  const hidden = await owner.json(`/client/channels/${channel.id}/messages`, { method: 'POST', json: { content: 'other guild' } })
  const auth = { authorization: `Bot ${botToken}`, 'content-type': 'application/json' }
  expect((await api(`/channels/${general.id}/messages/${hidden.id}`, { headers: auth })).status).toBe(404)
  expect((await api(`/channels/${general.id}/messages/${hidden.id}`, { method: 'PATCH', headers: auth, body: '{"content":"x"}' })).status).toBe(404)
  expect((await api(`/channels/${general.id}/messages/${hidden.id}`, { method: 'DELETE', headers: auth })).status).toBe(404)
  expect((await api(`/channels/${general.id}/pins/${hidden.id}`, { method: 'PUT', headers: auth })).status).toBe(404)
})

test('M1: interactions carry the member\'s real permissions, and command permissions are enforced', async () => {
  const invite = await owner.json(`/client/guilds/${t.config.guildId}/invites`, { method: 'POST', json: { username: 'alex' } })
  await t.hub.store.setProfile(invite.user.id, { tailscaleLogin: 'alex@example.com' })
  await t.hub.reload()
  const alex = new TestDevice(t.hub, { 'tailscale-user-login': 'alex@example.com' })
  await alex.pair(invite.code)
  const seen: string[] = []
  bot.on('interactionCreate', (interaction) => {
    if (interaction.member && 'permissions' in interaction.member && typeof interaction.member.permissions !== 'string') seen.push(interaction.member.permissions.bitfield.toString())
    if (interaction.isButton()) void interaction.deferUpdate()
  })
  const prompt = await general.send({ content: 'pick', components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Go', custom_id: 'go-alex' }] }] } as never)
  await alex.json('/client/interactions', { method: 'POST', json: { type: 'button', channelId: general.id, messageId: prompt.id, customId: 'go-alex' } })
  const bits = BigInt(await waitFor(() => seen.at(-1)))
  expect(bits & P.ADMINISTRATOR).toBe(0n)
  expect(bits & P.VIEW_CHANNEL).toBe(P.VIEW_CHANNEL)

  await bot.application!.commands.create({ name: 'danger', description: 'admins only', defaultMemberPermissions: '0' }, t.config.guildId)
  await bot.application!.commands.create({ name: 'manage', description: 'manage server', defaultMemberPermissions: P.MANAGE_GUILD }, t.config.guildId)
  expect((await alex.fetch('/client/commands', { method: 'POST', json: { channelId: general.id, name: 'danger' } })).status).toBe(403)
  expect((await alex.fetch('/client/commands', { method: 'POST', json: { channelId: general.id, name: 'manage' } })).status).toBe(403)
  expect((await owner.fetch('/client/commands', { method: 'POST', json: { channelId: general.id, name: 'danger' } })).status).toBe(200)

  // A button that is not on the message cannot be pressed.
  expect((await alex.fetch('/client/interactions', { method: 'POST', json: { type: 'button', channelId: general.id, messageId: prompt.id, customId: 'admin-only' } })).status).toBe(400)
})

test('M2: only the hub\'s own host names are answered (DNS rebinding)', async () => {
  const raw = (host: string, path = '/api/v10/gateway/bot') =>
    new Promise<string>((resolve) => {
      const socket = net.connect(t.hub.port, '127.0.0.1', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`))
      let data = ''
      socket.on('data', (chunk) => (data += String(chunk)))
      socket.on('close', () => resolve(data.split('\r\n')[0] ?? ''))
    })
  expect(await raw(`evil.example:${t.hub.port}`)).toContain('421')
  expect(await raw(`evil.example:${t.hub.port}`, '/client/state')).toContain('421')
  expect(await raw(`127.0.0.1:${t.hub.port}`)).not.toContain('421')
  const ws = new WebSocket(`ws://127.0.0.1:${t.hub.port}/gateway`, { headers: { host: 'evil.example' } })
  expect(await new Promise((resolve) => ws.on('error', () => resolve('refused')).on('open', () => resolve('open')))).toBe('refused')
})

test('M3: the gateway refuses huge frames and floods of connections that never identify', async () => {
  const big = new WebSocket(`ws://127.0.0.1:${t.hub.port}/gateway`)
  await new Promise((resolve) => big.once('open', resolve))
  const closed = new Promise<number>((resolve) => big.once('close', (code) => resolve(code)))
  big.send('x'.repeat((1 << 20) + 1))
  // Windows resets the socket before the close frame arrives: closed either way.
  expect(process.platform === 'win32' ? [1009, 1006] : [1009]).toContain(await closed)

  // Never refused: past 32 waiting connections the oldest are dropped, so the newest always get in.
  const sockets: WebSocket[] = []
  for (let i = 0; i < 40; i++) {
    const s = new WebSocket(`ws://127.0.0.1:${t.hub.port}/gateway`)
    await new Promise((resolve) => s.once('open', resolve).once('error', resolve))
    sockets.push(s)
  }
  await new Promise((r) => setTimeout(r, 200))
  const open = sockets.map((s) => s.readyState === WebSocket.OPEN)
  expect(open.filter(Boolean).length).toBeLessThanOrEqual(32)
  expect(open.slice(-8).every(Boolean)).toBe(true)
  expect(open.slice(0, 8).some(Boolean)).toBe(false)
  for (const s of sockets) s.terminate()
  // And one that never identifies is closed after a few seconds.
  const quiet = new WebSocket(`ws://127.0.0.1:${t.hub.port}/gateway`)
  expect(await new Promise((resolve) => quiet.once('close', (code) => resolve(code)))).toBe(4003)
})

test('roles: no self-made "Kimaki" role, no reaching people ranked above you', async () => {
  const state = await owner.json('/client/state')
  const alexId = state.users.find((u: { username: string }) => u.username === 'alex').id
  const alex = new TestDevice(t.hub, { 'tailscale-user-login': 'alex@example.com' })
  alex.cookie = (await t.hub.store.createSession((await t.hub.store.listDevices()).find((d) => d.userId === alexId)!.id)).token.replace(/^/, '__Host-hub_session=')
  const mods = await owner.json(`/client/guilds/${t.config.guildId}/roles`, { method: 'POST', json: { name: 'Mods', permissions: String(P.MANAGE_ROLES | P.VIEW_CHANNEL) } })
  const admins = await owner.json(`/client/guilds/${t.config.guildId}/roles`, { method: 'POST', json: { name: 'Admins', permissions: String(P.ADMINISTRATOR) } })
  await owner.json(`/client/guilds/${t.config.guildId}/members/${alexId}/roles`, { method: 'PUT', json: { roles: [mods.id] } })
  for (const name of ['Kimaki', 'kimaki', 'NO-KIMAKI']) expect((await alex.fetch(`/client/guilds/${t.config.guildId}/roles`, { method: 'POST', json: { name } })).status).toBe(403)
  const helper = await alex.json(`/client/guilds/${t.config.guildId}/roles`, { method: 'POST', json: { name: 'Helper' } })
  expect((await alex.fetch(`/client/guilds/${t.config.guildId}/roles/${helper.id}`, { method: 'PATCH', json: { name: 'kimaki' } })).status).toBe(403)
  // Someone with the Admins role is above alex: alex cannot change their roles.
  const sam = await owner.json(`/client/guilds/${t.config.guildId}/invites`, { method: 'POST', json: { username: 'sam' } })
  await owner.json(`/client/guilds/${t.config.guildId}/members/${sam.user.id}/roles`, { method: 'PUT', json: { roles: [admins.id, helper.id] } })
  expect((await alex.fetch(`/client/guilds/${t.config.guildId}/members/${sam.user.id}/roles`, { method: 'PUT', json: { roles: [admins.id] } })).status).toBe(403)
  expect((await alex.fetch(`/client/channels/${general.id}/permissions/${admins.id}`, { method: 'PUT', json: { type: 0, allow: '0', deny: String(P.VIEW_CHANNEL) } })).status).toBe(403)
  // The owner still can.
  const kimaki = await owner.json(`/client/guilds/${t.config.guildId}/roles`, { method: 'POST', json: { name: 'Kimaki' } })
  expect(kimaki.name).toBe('Kimaki')
})

test('pairing lockout is per peer: one guesser does not lock everyone out', async () => {
  const guesser = new TestDevice(t.hub, { 'tailscale-user-login': LOGIN })
  for (let i = 0; i < 11; i++) await guesser.fetch('/client/auth/register/options', { method: 'POST', json: { code: 'WRONGCODE1' } })
  expect((await guesser.fetch('/client/auth/register/options', { method: 'POST', json: { code: 'WRONGCODE1' } })).status).toBe(429)
  // Another peer (here: another Tailscale identity) still gets to try.
  const other = new TestDevice(t.hub, { 'tailscale-user-login': 'alex@example.com' })
  expect((await other.fetch('/client/auth/register/options', { method: 'POST', json: { code: 'WRONGCODE1' } })).status).toBe(403)
})

test('the private listener checks tailnet IPv6 peers with Tailscale too', async () => {
  const listener = new PrivateListener({ address: '127.0.0.1', port: 0, httpPort: null, names: ['hub.home.arpa'], allowedCidrs: ['fd7a:115c:a1e0::/48'] }, `${t.paths.root}/ca-v6`, { attach() {}, tailscaleLogins: () => new Map([['owner@example.com', 'owner']]) })
  const peer = (address: string) => ({ socket: { remoteAddress: address } }) as never
  // No Tailscale answer for this peer: refused, not waved through.
  expect(await listener.checkPeer(peer('fd7a:115c:a1e0::dead:beef'))).toBe(false)
  expect(await listener.checkPeer(peer('192.168.1.5'))).toBeNull()
})

test('attachments: no uploader-chosen script types, signed links expire, bots only see their own guilds', async () => {
  const form = new FormData()
  form.append('file', new Blob([Buffer.from('alert(1)')], { type: 'text/javascript' }), 'x.js')
  const upload = await owner.json('/client/uploads', { method: 'POST', body: form })
  await owner.json(`/client/channels/${general.id}/messages`, { method: 'POST', json: { content: 'file', attachmentIds: [upload.id] } })
  const served = await owner.fetch(upload.url.split('?')[0])
  expect(served.headers.get('content-type')).toBe('application/octet-stream')
  expect(served.headers.get('x-content-type-options')).toBe('nosniff')
  expect(served.headers.get('content-disposition')).toMatch(/^attachment/)

  const store = new AttachmentStore(t.paths.attachments, 'k', t.hub.store, () => '')
  const url = new URL(store.url('1', 'a.txt'), 'http://x')
  expect(store.verify('1', 'a.txt', url.searchParams.get('ex'), url.searchParams.get('hm'))).toBe(true)
  expect(store.verify('1', 'a.txt', url.searchParams.get('ex'), url.searchParams.get('hm'), Date.now() + 31 * 24 * 3600_000)).toBe(false)
  expect(store.verify('1', 'a.txt', null, url.searchParams.get('hm'))).toBe(false)

  // A file in a guild this bot is not in.
  const other = t.hub.guilds.find((g) => g.name === 'Side Projects')!
  const channel = (await t.hub.twin.prisma.channel.findFirstOrThrow({ where: { guildId: other.id, name: 'private' } })).id
  const elsewhere = new FormData()
  elsewhere.append('file', new Blob([Buffer.from('other guild file')], { type: 'text/plain' }), 'other.txt')
  const otherUpload = await owner.json('/client/uploads', { method: 'POST', body: elsewhere })
  await owner.json(`/client/channels/${channel}/messages`, { method: 'POST', json: { content: 'f', attachmentIds: [otherUpload.id] } })
  const bare = `${t.hub.localUrl}${otherUpload.url.split('?')[0]}`
  expect((await fetch(bare, { headers: { authorization: `Bot ${botToken}` } })).status).toBe(404)
  expect((await fetch(`${t.hub.localUrl}${upload.url.split('?')[0]}`, { headers: { authorization: `Bot ${botToken}` } })).status).toBe(200)
})

test('voice notes: ffmpeg only ever sees a known recording format', async () => {
  // A playlist or anything else is never handed to ffmpeg.
  expect(await toOggOpus(Buffer.from('#EXTM3U\nfile:///etc/passwd\n'), 'application/x-mpegurl')).toBeNull()
  expect(await toOggOpus(Buffer.from('#EXTM3U'), 'audio/mpegurl')).toBeNull()
})

test('the session cookie is host-only (__Host-) and the admin route still needs its token', async () => {
  expect(owner.cookie).toMatch(/^__Host-hub_session=/)
  expect((await fetch(`${t.hub.localUrl}/admin/reload`, { method: 'POST', headers: { authorization: 'Bearer wrong' } })).status).toBe(403)
})

// --- Re-test of the review

test('R1: a percent-encoded message id cannot slip past the channel check', async () => {
  const other = t.hub.guilds.find((g) => g.name === 'Side Projects')!
  const channel = (await t.hub.twin.prisma.channel.findFirstOrThrow({ where: { guildId: other.id, name: 'private' } })).id
  const hidden = await owner.json(`/client/channels/${channel}/messages`, { method: 'POST', json: { content: 'still other guild' } })
  const enc = [...hidden.id].map((c: string) => `%3${c}`).join('')
  const auth = { authorization: `Bot ${botToken}`, 'content-type': 'application/json' }
  for (const id of [enc, `%3${hidden.id[0]}${hidden.id.slice(1)}`]) {
    expect((await api(`/channels/${general.id}/messages/${id}`, { headers: auth })).status).toBe(404)
    expect((await api(`/channels/${general.id}/messages/${id}`, { method: 'PATCH', headers: auth, body: '{"content":"x"}' })).status).toBe(404)
    expect((await api(`/channels/${general.id}/messages/${id}/reactions/%F0%9F%91%8D/@me`, { method: 'PUT', headers: auth })).status).toBe(404)
    expect((await api(`/channels/${general.id}/pins/${id}`, { method: 'PUT', headers: auth })).status).toBe(404)
    expect((await api(`/channels/${general.id}/messages/${id}/threads`, { method: 'POST', headers: auth, body: '{"name":"x"}' })).status).toBe(404)
    expect((await api(`/channels/${general.id}/messages/${id}`, { method: 'DELETE', headers: auth })).status).toBe(404)
  }
  expect((await owner.json(`/client/channels/${channel}/messages`)).messages.find((m: { id: string }) => m.id === hidden.id).content).toBe('still other guild')
})

test('R2: idle gateway sockets cannot lock local bots out', async () => {
  const idle = Array.from({ length: 40 }, () => new WebSocket(`ws://127.0.0.1:${t.hub.port}/gateway`))
  await Promise.all(idle.map((s) => new Promise((resolve) => s.once('open', resolve).once('error', resolve))))
  const late = new Client({ intents: [GatewayIntentBits.Guilds], rest: { api: `${t.hub.localUrl}/api`, version: '10' } })
  const ready = new Promise<void>((resolve) => late.once('clientReady', () => resolve()))
  await late.login(botToken)
  await ready
  expect(late.guilds.cache.size).toBeGreaterThan(0)
  await late.destroy()
  for (const s of idle) s.terminate()
})

test('R3: a rotating Tailscale header does not give a guesser more tries, nor lock anyone else out', async () => {
  for (let i = 0; i < 15; i++) {
    const guesser = new TestDevice(t.hub, { 'tailscale-user-login': i % 2 ? LOGIN : 'alex@example.com' })
    await guesser.fetch('/client/auth/register/options', { method: 'POST', json: { code: 'WRONGCODE2' } })
  }
  // Same transport address and verified login as before: locked.
  expect((await new TestDevice(t.hub, { 'tailscale-user-login': LOGIN }).fetch('/client/auth/register/options', { method: 'POST', json: { code: 'WRONGCODE2' } })).status).toBe(429)
})

test('R4: an unparsable request target gets 400 and nothing is thrown', async () => {
  for (const line of ['GET //[/x HTTP/1.1', 'GET http://[/api/v10/gateway/bot HTTP/1.1']) {
    const status = await new Promise<string>((resolve) => {
      const socket = net.connect(t.hub.port, '127.0.0.1', () => socket.write(`${line}\r\nHost: 127.0.0.1:${t.hub.port}\r\nConnection: close\r\n\r\n`))
      let out = ''
      socket.on('data', (d) => (out += String(d)))
      socket.on('close', () => resolve(out.split('\r\n')[0] ?? ''))
    })
    expect(status).toContain('400')
  }
})

test('R5: a malformed or duplicate cookie from elsewhere does not break or take over the session', async () => {
  const poisoned = new TestDevice(t.hub)
  poisoned.cookie = `x=%; ${owner.cookie}`
  expect((await poisoned.fetch('/client/state')).status).toBe(200)
  // An unprefixed cookie (plantable from another port) is not a session.
  const legacy = new TestDevice(t.hub)
  legacy.cookie = owner.cookie!.replace('__Host-hub_session', 'hub_session')
  expect((await legacy.fetch('/client/state')).status).toBe(401)
})

test('R6: an old CA constrained to a whole public zone is detected and replaced on setup', async () => {
  const { broadConstraints, caFiles, ensureCa } = await import('../src/ca.ts')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const files = caFiles(`${t.paths.root}/old-ca`)
  const fs = await import('node:fs')
  fs.mkdirSync(files.dir, { recursive: true })
  // As older hubs made it: the last two labels of hub.tailnet.ts.net.
  await promisify(execFile)((await import('../src/platform.ts')).tool('openssl'), ['req', '-x509', '-new', '-nodes', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-keyout', files.caKey, '-out', files.caCert, '-days', '30', '-subj', '/CN=old', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'nameConstraints=critical,permitted;DNS:ts.net'])
  expect(await broadConstraints(files.caCert, ['hub.tailnet.ts.net'])).toEqual(['ts.net'])
  expect((await ensureCa(files, { names: ['hub.tailnet.ts.net'], ips: [] })).reissued).toBe(false)
  const replaced = await ensureCa(files, { names: ['hub.tailnet.ts.net'], ips: [], reissueBroad: true })
  expect(replaced).toEqual({ broad: ['ts.net'], reissued: true })
  expect(await broadConstraints(files.caCert, ['hub.tailnet.ts.net'])).toEqual([])
  // home.arpa is private by definition and stays.
  expect(await broadConstraints(files.caCert, ['x.home.arpa'])).toEqual(['hub.tailnet.ts.net'])
})

test('a hub on a new address keeps its CA; its certificate then names only what the CA may sign', async () => {
  const { caFiles, ensureCa, ensureServerCert, fingerprint, signableIps } = await import('../src/ca.ts')
  const crypto = await import('node:crypto')
  const fs = await import('node:fs')
  const files = caFiles(`${t.paths.root}/moved-ca`)
  const names = ['hub.home.arpa']
  await ensureCa(files, { names, ips: ['100.64.0.10'] })
  await ensureServerCert(files, { names, ips: await signableIps(files.caCert, ['100.64.0.10']) })
  const before = fingerprint(files.caCert)
  // Restored on another computer: same name, another address.
  expect(await ensureCa(files, { names, ips: ['100.64.0.20'] })).toMatchObject({ reissued: false })
  expect(fingerprint(files.caCert)).toBe(before)
  expect(await signableIps(files.caCert, ['100.64.0.20'])).toEqual([])
  expect(await ensureServerCert(files, { names, ips: await signableIps(files.caCert, ['100.64.0.20']) })).toBe(true)
  const cert = new crypto.X509Certificate(fs.readFileSync(files.cert))
  expect(cert.subjectAltName).toBe('DNS:hub.home.arpa')
  expect(cert.checkIssued(new crypto.X509Certificate(fs.readFileSync(files.caCert)))).toBe(true)
  // A new name still needs a new CA.
  expect(await ensureCa(files, { names: [...names, 'hub2.home.arpa'], ips: ['100.64.0.20'] })).toMatchObject({ reissued: true, rotated: true })
})

test('Host allowlist accepts the public URL without its default port', async () => {
  const { initHub } = await import('../src/config.ts')
  const { Hub } = await import('../src/hub.ts')
  const hub = new Hub({ paths: t.paths, config: { ...initHub(t.paths, {}), publicUrl: 'https://hub.example.ts.net' }, port: 0, webDir: `${t.paths.root}/web` })
  expect(hub.allowedHost('hub.example.ts.net')).toBe(true)
  expect(hub.allowedHost('hub.example.ts.net:443')).toBe(true)
  expect(hub.allowedHost('hub.example.ts.net:8443')).toBe(false)
  // Never started, but its databases are open (Windows could not delete them).
  hub.store.close()
  await hub.twin.prisma.$disconnect()
})
