// Requests: an agent files a change through the local admin API; nothing
// happens until the owner approves it on a paired device with a fresh passkey
// assertion, and then it runs through the normal permission checks.

import { afterAll, beforeAll, expect, test } from 'vitest'
import { readSecret } from '../src/config.ts'
import { pairedDevice, startTestHub, type TestDevice } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
let owner: TestDevice
let admin: (method: string, route: string, body?: unknown) => Promise<{ status: number; json: any }>

beforeAll(async () => {
  t = await startTestHub()
  owner = await pairedDevice(t.hub, 'owner-phone')
  const token = readSecret(t.paths.adminToken)
  admin = async (method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${t.hub.port}${route}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, json: await res.json().catch(() => null) }
  }
})

afterAll(() => t?.cleanup())

async function approve(device: TestDevice, id: string) {
  const { challengeId, options } = await device.json(`/client/requests/${id}/approve/options`, { method: 'POST', json: {} })
  return device.fetch(`/client/requests/${id}/approve`, { method: 'POST', json: { challengeId, response: device.authenticator.authenticate(options, device.origin) } })
}

test('a request changes nothing until the owner approves it with a passkey', async () => {
  const created = await admin('POST', '/admin/requests', { method: 'POST', route: `/client/guilds/${t.config.guildId}/invites`, body: { username: 'sam' }, reason: 'Sam helps with the docs', origin: 'agent session test' })
  expect(created.status).toBe(200)
  expect(created.json).toMatchObject({ status: 'pending', kind: 'invite a person', origin: 'agent session test', summary: `Invite sam to ${t.config.guildName}` })
  expect(await t.hub.twin.prisma.user.findFirst({ where: { username: 'sam' } })).toBeNull()
  const { requests } = await owner.json('/client/requests')
  expect(requests.map((r: { id: string }) => r.id)).toContain(created.json.id)

  // Without a fresh assertion for this request: refused.
  const stale = await owner.fetch(`/client/requests/${created.json.id}/approve`, { method: 'POST', json: { challengeId: 'nope' } })
  expect(stale.status).toBe(400)

  const res = await approve(owner, created.json.id)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { result: { code: string } }
  expect(body.result.code).toMatch(/^[A-Z0-9]{10}$/)
  expect(await t.hub.twin.prisma.user.findFirst({ where: { username: 'sam' } })).not.toBeNull()
  // Decided once.
  expect((await approve(owner, created.json.id).catch(() => null))?.status ?? 409).not.toBe(200)
  const [row] = (await admin('GET', '/admin/requests')).json.requests
  expect(row.status).toBe('approved')
})

test('only allowed changes can be requested, and only the owner decides', async () => {
  expect((await admin('POST', '/admin/requests', { method: 'POST', route: '/client/devices/pair', body: {} })).status).toBe(400)
  expect((await admin('POST', '/admin/requests', { method: 'POST', route: '/client/services/x/restart' })).status).toBe(400)
  const created = await admin('POST', '/admin/requests', { method: 'POST', route: `/client/guilds/${t.config.guildId}/invites`, body: { username: 'robin' } })
  // A person invited earlier signs in and tries to approve.
  const invite = await owner.json(`/client/guilds/${t.config.guildId}/invites`, { method: 'POST', json: { username: 'alex' } })
  const { TestDevice } = await import('./helpers.ts')
  const alex = new TestDevice(t.hub)
  await alex.pair(invite.code)
  expect((await alex.fetch('/client/requests')).status).toBe(403)
  expect((await alex.fetch(`/client/requests/${created.json.id}/approve/options`, { method: 'POST', json: {} })).status).toBe(403)
  expect((await admin('POST', `/admin/requests/${created.json.id}/deny`, {})).status).toBe(200)
  expect((await approve(owner, created.json.id).catch(() => ({ status: 409 }))).status).not.toBe(200)
})

test('admin routes stay off the network: a proxied request is refused', async () => {
  const token = readSecret(t.paths.adminToken)
  const res = await fetch(`http://127.0.0.1:${t.hub.port}/admin/requests`, { headers: { authorization: `Bearer ${token}`, 'tailscale-user-login': 'x@example.com' } })
  expect(res.status).toBe(403)
})

test('an approved change can be undone, through a new request', async () => {
  const role = await owner.json(`/client/guilds/${t.config.guildId}/roles`, { method: 'POST', json: { name: 'docs' } })
  const sam = (await t.hub.twin.prisma.user.findFirst({ where: { username: 'sam' } }))!
  const give = await admin('POST', '/admin/requests', { method: 'PUT', route: `/client/guilds/${t.config.guildId}/members/${sam.id}/roles`, body: { roles: [role.id] } })
  expect(give.json.summary).toContain('shell')
  expect((await approve(owner, give.json.id)).status).toBe(200)
  const roles = async () => JSON.parse((await t.hub.twin.prisma.guildMember.findUnique({ where: { guildId_userId: { guildId: t.config.guildId, userId: sam.id } } }))!.roles)
  expect(await roles()).toEqual([role.id])
  const undo = await admin('POST', `/admin/requests/${give.json.id}/undo`, { origin: 'cli' })
  expect(undo.json).toMatchObject({ status: 'pending', summary: expect.stringMatching(/^Undo: /) })
  expect(await roles()).toEqual([role.id])
  expect((await approve(owner, undo.json.id)).status).toBe(200)
  expect(await roles()).toEqual([])
  // A denied request has nothing to undo.
  const denied = await admin('POST', '/admin/requests', { method: 'PATCH', route: `/client/guilds/${t.config.guildId}`, body: { name: 'Renamed' } })
  await admin('POST', `/admin/requests/${denied.json.id}/deny`, {})
  expect((await admin('POST', `/admin/requests/${denied.json.id}/undo`, {})).status).toBe(409)
})
