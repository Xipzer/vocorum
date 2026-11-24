// Machine pictures: each machine's Kimaki uploads its own bot avatar and
// Discord server icon with its hub token; the owner can set them from the app.

import { afterAll, beforeAll, expect, test } from 'vitest'
import WebSocket from 'ws'
import { LOGIN, TestDevice, pairedDevice, startTestHub, waitFor } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
let owner: TestDevice
let token = ''
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex')

beforeAll(async () => {
  t = await startTestHub()
  const minted = await t.hub.store.addBot('Desktop')
  token = `${minted.clientId}:${minted.secret}`
  await t.hub.store.addBot('Homelab')
  await t.hub.reload()
  owner = await pairedDevice(t.hub)
})

afterAll(async () => {
  await t.cleanup()
})

const put = (path: string, body: Buffer, auth = `Bot ${token}`) => fetch(`${t.hub.localUrl}${path}`, { method: 'PUT', headers: { authorization: auth, 'content-type': 'application/octet-stream' }, body })

test('a machine uploads its own pictures with its hub token', async () => {
  const events: Array<{ t: string; d: any }> = []
  const ws = new WebSocket(`ws://127.0.0.1:${t.hub.port}/client/events`, { headers: { origin: owner.origin, cookie: owner.cookie!, 'tailscale-user-login': LOGIN } })
  ws.on('message', (data) => events.push(JSON.parse(String(data))))
  await new Promise((resolve) => ws.once('open', resolve))

  expect((await put('/hub/machine-icons/avatar', PNG, 'Bot nope:nope')).status).toBe(401)
  expect((await put('/hub/machine-icons/avatar', Buffer.from('<svg/>'))).status).toBe(400)
  expect((await put('/hub/machine-icons/banner', PNG)).status).toBe(400)
  const saved = (await (await put("/hub/machine-icons/avatar", PNG)).json()) as { avatar: string }
  expect(saved).toMatchObject({ machine: 'Desktop', avatar: expect.stringMatching(/^[0-9a-f]{32}$/), guild_icon: null })
  await (await put('/hub/machine-icons/guild_icon', JPEG)).json()
  const own = await (await fetch(`${t.hub.localUrl}/hub/machine-icons`, { headers: { authorization: `Bot ${token}` } })).json()
  expect(own).toEqual({ machine: 'Desktop', avatar: saved.avatar, guild_icon: expect.stringMatching(/^[0-9a-f]{32}$/) })

  const state = await owner.json('/client/state')
  expect(state.machine_icons.Desktop).toEqual({ avatar: saved.avatar, guild_icon: expect.stringMatching(/^[0-9a-f]{32}$/) })
  expect(state.machine_icons.Homelab).toBeUndefined()
  const image = await owner.fetch('/client/machine-icons/desktop/guild_icon')
  expect(image.headers.get('content-type')).toBe('image/jpeg')
  expect(await waitFor(() => events.find((e) => e.t === 'MACHINE_ICONS_UPDATE' && e.d.guild_icon))).toMatchObject({ d: { machine: 'Desktop' } })
  ws.close()
})

test('the owner sets and clears any machine picture; nobody else can', async () => {
  const set = await owner.json('/client/machine-icons/Homelab/avatar', { method: 'PUT', body: PNG })
  expect(set).toMatchObject({ machine: 'Homelab', avatar: expect.any(String) })
  expect((await owner.fetch('/client/machine-icons/Nowhere/avatar', { method: 'PUT', body: PNG })).status).toBe(404)
  await owner.json('/client/machine-icons/Homelab/avatar', { method: 'DELETE' })
  expect((await owner.json('/client/state')).machine_icons.Homelab).toBeUndefined()

  // A person who sees no channel of a machine does not see its pictures, and cannot set them.
  const invite = await owner.json(`/client/guilds/${t.config.guildId}/invites`, { method: 'POST', json: { username: 'guest' } })
  await t.hub.store.setProfile(invite.user.id, { tailscaleLogin: 'guest@example.com' })
  await t.hub.reload()
  const guest = new TestDevice(t.hub, { 'tailscale-user-login': 'guest@example.com' })
  await guest.pair(invite.code)
  expect((await guest.json('/client/state')).machine_icons).toEqual({})
  expect((await guest.fetch('/client/machine-icons/desktop/avatar')).status).toBe(404)
  expect((await guest.fetch('/client/machine-icons/desktop/avatar', { method: 'PUT', body: PNG })).status).toBe(403)
  // Once they can see the machine's category, they see its pictures.
  await owner.json(`/client/guilds/${t.config.guildId}/channels`, { method: 'POST', json: { name: 'Kimaki Desktop', type: 4 } })
  await waitFor(async () => Boolean((await guest.json('/client/state')).machine_icons.Desktop))
  expect((await guest.fetch('/client/machine-icons/desktop/avatar')).status).toBe(200)
})
