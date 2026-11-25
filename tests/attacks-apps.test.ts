// Attacks on app sign-in, updates and installers (security review, 25 Nov):
// each test is an exploit that once worked and must keep failing.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// Attacks on app sign-in, updates and installers (security review, 25 Nov):
// each test is an exploit that once worked and must keep failing.
import { afterAll, beforeAll, expect, test } from 'vitest'
import WebSocket from 'ws'
import { APP_LOGIN_PREFIX } from '../src/auth.ts'
import { AppReleases } from '../src/app-releases.ts'
import { initHub } from '../src/config.ts'
import { Hub } from '../src/hub.ts'
import { LOGIN, TestDevice, startTestHub, waitFor } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
let hub: Hub
let owner: TestDevice
let friend: TestDevice

function releaseDir(version: string, files: Record<string, unknown>, contents: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zzrel-'))
  for (const [name, body] of Object.entries(contents)) fs.writeFileSync(path.join(dir, name), body)
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ version, notes: '', pub_date: '2026-11-25T00:00:00Z', files }))
  return dir
}

beforeAll(async () => {
  t = await startTestHub()
  await t.hub.stop()
  const config = initHub(t.paths, { privateListener: { address: '127.0.0.1', port: 0, httpPort: 0, names: ['hub.home.arpa'], allowedCidrs: ['127.0.0.0/8'] } })
  hub = new Hub({ paths: t.paths, config, port: 0, webDir: `${t.paths.root}/web` })
  await hub.start()
  owner = new TestDevice(hub)
  await owner.pair(await hub.store.createPairing('owner desk'))
  const invite = await owner.json(`/client/guilds/${config.guildId}/invites`, { method: 'POST', json: { username: 'mallory' } })
  await hub.store.setProfile(invite.user.id, { tailscaleLogin: 'mallory@example.com' })
  await hub.refreshLogins()
  friend = new TestDevice(hub, { 'tailscale-user-login': 'mallory@example.com' })
  await friend.pair(invite.code)
}, 60_000)

afterAll(async () => {
  await hub.stop()
  fs.rmSync(t.paths.root, { recursive: true, force: true })
})

test('names of Object members are not release files, and a missing file ends its download cleanly', async () => {
  new AppReleases(t.paths.apps).publish(releaseDir('0.5.0', { 'windows-x86_64': { install: 'setup.exe' } }, { 'setup.exe': 'installer' }))
  for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    expect((await friend.fetch(`/client/app/files/0.5.0/${name}`)).status).toBe(404)
    expect((await friend.fetch(`/client/app/files/0.5.0/${name}`, { headers: { range: 'bytes=0-1' } })).status).toBe(404)
  }
  expect((await owner.fetch('/client/state')).status).toBe(200)
})

test('publishing refuses symlinks, so no local file can become an installer', async () => {
  const secret = path.join(t.paths.root, 'not-for-release.txt')
  fs.writeFileSync(secret, 'SECRET-CONTENT')
  const dir = releaseDir('0.6.0', { 'linux-x86_64': { install: 'Vocorum.AppImage' } }, {})
  fs.symlinkSync(secret, path.join(dir, 'Vocorum.AppImage'))
  expect(() => new AppReleases(t.paths.apps).publish(dir)).toThrow(/symlink/)
  expect(fs.existsSync(path.join(t.paths.apps, '0.6.0'))).toBe(false)
})

test('an event socket closes when its session is logged out', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const raw = publicKey.export({ format: 'jwk' }).x as string
  const appFetch = (p: string, init: { json?: unknown; token?: string } = {}) =>
    fetch(`${hub.localUrl}${p}`, { method: init.json !== undefined ? 'POST' : 'GET', headers: { 'tailscale-user-login': 'mallory@example.com', 'content-type': 'application/json', ...(init.token && { authorization: `Bearer ${init.token}` }) }, body: init.json !== undefined ? JSON.stringify(init.json) : undefined })
  const mallory = (await hub.twin.prisma.user.findFirst({ where: { username: 'mallory' } }))!
  const code = await hub.store.createPairing('mallory app', { userId: mallory.id })
  const { keyId } = (await (await appFetch('/client/auth/app/register', { json: { code, publicKey: raw } })).json()) as any
  const { challengeId, challenge } = (await (await appFetch('/client/auth/app/challenge', { json: {} })).json()) as any
  const signature = crypto.sign(null, Buffer.from(`${APP_LOGIN_PREFIX}\n${challenge}\n${keyId}`), privateKey).toString('base64url')
  const { token } = (await (await appFetch('/client/auth/app/login', { json: { challengeId, keyId, signature } })).json()) as any
  const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/client/events`, { headers: { authorization: `Bearer ${token}`, 'tailscale-user-login': 'mallory@example.com' } })
  await new Promise((r) => ws.once('open', r))
  const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)))
  expect((await appFetch('/client/auth/logout', { json: {}, token })).status).toBe(200)
  expect(await closed).toBe(4001)
})

test('a .deb app is never offered the plain Linux (AppImage) update', async () => {
  new AppReleases(t.paths.apps).publish(releaseDir('0.7.0', { 'linux-x86_64': { update: 'Vocorum.AppImage.tar.gz' } }, { 'Vocorum.AppImage.tar.gz': 'appimage', 'Vocorum.AppImage.tar.gz.sig': 'sig' }))
  expect((await owner.fetch('/client/app/update/linux/x86_64/0.1.0?bundle=deb')).status).toBe(204)
  expect((await owner.json('/client/app/update/linux/x86_64/0.1.0?bundle=appimage')).url).toMatch(/AppImage/)
  expect((await owner.json('/client/app/update/linux/x86_64/0.1.0')).url).toMatch(/AppImage/)
})

test('after the wrong-code lockout, a refused account cannot tell real codes from wrong ones', async () => {
  const original = hub.checkHuman.bind(hub)
  ;(hub as any).checkHuman = async (req: any, pathname = '') => {
    if (req.headers['x-sim-stranger']) return void (hub as any).firstPairings.set(req, 'stranger@example.com')
    return original(req, pathname)
  }
  try {
    const { publicKey } = crypto.generateKeyPairSync('ed25519')
    const raw = publicKey.export({ format: 'jwk' }).x as string
    const tryCode = (code: string) => fetch(`${hub.localUrl}/client/auth/app/register`, { method: 'POST', headers: { 'x-sim-stranger': '1', 'content-type': 'application/json' }, body: JSON.stringify({ code, publicKey: raw }) })
    for (let i = 0; i < 10; i++) await tryCode(`WRONG${String(i).padStart(5, '0')}`)
    expect((await tryCode('WRONGZZZZZ')).status).toBe(429)
    expect((await tryCode(await hub.store.createPairing('owner laptop'))).status).toBe(429)
  } finally {
    ;(hub as any).checkHuman = original
  }
})

test('an update URL through the private listener never follows a forged Host', async () => {
  const https = await import('node:https')
  new AppReleases(t.paths.apps).publish(releaseDir('0.8.0', { 'windows-x86_64': { update: 'up.exe' } }, { 'up.exe': 'u', 'up.exe.sig': 'sig' }))
  const get = (host: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: hub.privateListener!.port, path: '/client/app/update/windows/x86_64/0.0.1', servername: 'hub.home.arpa', rejectUnauthorized: false, headers: { host, cookie: owner.cookie!, 'tailscale-user-login': LOGIN } }, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode!, body }))
    })
    req.on('error', reject)
    req.end()
  })
  // The listener itself refuses other names (421 Misdirected Request).
  expect((await get('evil.example')).status).toBe(421)
  const own = await get(`hub.home.arpa:${hub.privateListener!.port}`)
  expect(own.status).toBe(200)
  expect(new URL(JSON.parse(own.body).url).host).toBe(`hub.home.arpa:${hub.privateListener!.port}`)
})
