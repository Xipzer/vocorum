// Vocorum app releases served by the hub: updates for signed-in devices,
// first installs for holders of a valid pairing code. Nothing from outside.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { AppReleases, compareVersions } from '../src/app-releases.ts'
import { initHub } from '../src/config.ts'
import { Hub } from '../src/hub.ts'
import { TestDevice, startTestHub } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
let hub: Hub
let device: TestDevice
const files = { 'Vocorum_0.2.0_x64-setup.exe': 'windows installer 0.2.0', 'Vocorum.app.tar.gz': 'mac update bundle', 'Vocorum_0.2.0_aarch64.dmg': 'mac disk image' }

function release(version: string, extra: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-'))
  for (const [name, body] of Object.entries({ ...files, ...extra })) fs.writeFileSync(path.join(dir, name), body)
  fs.writeFileSync(path.join(dir, 'Vocorum_0.2.0_x64-setup.exe.sig'), 'untrusted comment: windows sig\nRWQ...\n')
  fs.writeFileSync(path.join(dir, 'Vocorum.app.tar.gz.sig'), 'untrusted comment: mac sig\nRWQ...\n')
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ version, notes: `Notes for ${version}`, pub_date: '2026-11-25T00:00:00Z', files: { 'windows-x86_64': { update: 'Vocorum_0.2.0_x64-setup.exe', install: 'Vocorum_0.2.0_x64-setup.exe' }, 'darwin-aarch64': { update: 'Vocorum.app.tar.gz', install: 'Vocorum_0.2.0_aarch64.dmg' } } }))
  return dir
}

beforeAll(async () => {
  t = await startTestHub()
  await t.hub.stop()
  const config = initHub(t.paths, { privateListener: { address: '127.0.0.1', port: 0, httpPort: 0, names: ['hub.home.arpa'], allowedCidrs: ['127.0.0.0/8'] } })
  hub = new Hub({ paths: t.paths, config, port: 0, webDir: `${t.paths.root}/web` })
  await hub.start()
  new AppReleases(t.paths.apps).publish(release('0.2.0'))
  device = new TestDevice(hub)
  await device.pair(await hub.store.createPairing('desk'))
}, 60_000)

afterAll(async () => {
  await hub.stop()
  fs.rmSync(t.paths.root, { recursive: true, force: true })
})

test('versions order like semver', () => {
  expect(['0.10.0', '0.2.0', '0.2.0-beta.1', '1.0.0'].sort((a, b) => compareVersions(a, b))).toEqual(['0.2.0-beta.1', '0.2.0', '0.10.0', '1.0.0'])
})

test('publishing checks the release: signatures present, known platforms, one copy per version', () => {
  const store = new AppReleases(t.paths.apps)
  const unsigned = release('0.3.0')
  fs.rmSync(path.join(unsigned, 'Vocorum.app.tar.gz.sig'))
  expect(() => store.publish(unsigned)).toThrow(/sig is missing/)
  const odd = release('0.3.0')
  fs.writeFileSync(path.join(odd, 'release.json'), JSON.stringify({ version: '0.3.0', files: { 'beos-x86_64': { install: 'x' } } }))
  expect(() => store.publish(odd)).toThrow(/unknown platform/)
  expect(() => store.publish(release('0.2.0'))).toThrow(/already published/)
  expect(fs.statSync(path.join(t.paths.apps, '0.2.0')).mode & 0o777).toBe(0o700)
  expect(store.list().map((r) => r.version)).toEqual(['0.2.0'])
})

test('a signed-in device gets the update in Tauri\'s format, and the file with ranges', async () => {
  const update = await device.json('/client/app/update/windows/x86_64/0.1.0')
  expect(update).toMatchObject({ version: '0.2.0', notes: 'Notes for 0.2.0', pub_date: '2026-11-25T00:00:00Z', signature: 'untrusted comment: windows sig\nRWQ...' })
  expect(update.url).toMatch(/\/client\/app\/files\/0\.2\.0\/Vocorum_0\.2\.0_x64-setup\.exe$/)
  expect((await device.fetch('/client/app/update/windows/x86_64/0.2.0')).status).toBe(204)
  expect((await device.fetch('/client/app/update/linux/x86_64/0.1.0')).status).toBe(204)
  const file = await device.fetch(new URL(update.url).pathname)
  expect(file.headers.get('content-disposition')).toContain('attachment')
  expect(await file.text()).toBe('windows installer 0.2.0')
  const part = await device.fetch(new URL(update.url).pathname, { headers: { range: 'bytes=0-6' } })
  expect(part.status).toBe(206)
  expect(await part.text()).toBe('windows')
  // Only files the release lists; and nothing for someone not signed in.
  expect((await device.fetch('/client/app/files/0.2.0/release.json')).status).toBe(404)
  expect((await device.fetch('/client/app/files/0.2.0/..%2F..%2Fconfig.json')).status).toBe(404)
  expect((await fetch(`${hub.localUrl}${new URL(update.url).pathname}`, { headers: { 'tailscale-user-login': 'owner@example.com' } })).status).toBe(401)
})

test('the setup page lists installers with their SHA-256 only for a valid pairing code', async () => {
  const base = `http://127.0.0.1:${hub.privateListener!.httpPort}`
  const code = await hub.store.createPairing('new-laptop')
  const page = await (await fetch(`${base}/?code=${code}`)).text()
  const sha = crypto.createHash('sha256').update('windows installer 0.2.0').digest('hex')
  expect(page).toContain(`/app/${code}/Vocorum_0.2.0_x64-setup.exe`)
  expect(page).toContain(sha)
  expect(page).toContain('macOS (aarch64)')
  const download = await fetch(`${base}/app/${code}/Vocorum_0.2.0_x64-setup.exe`)
  expect(download.status).toBe(200)
  expect(await download.text()).toBe('windows installer 0.2.0')
  // Update bundles are not installers; a wrong code gets nothing.
  expect((await fetch(`${base}/app/${code}/Vocorum.app.tar.gz`)).status).toBe(404)
  expect((await fetch(`${base}/app/AAAAAAAAAA/Vocorum_0.2.0_x64-setup.exe`)).status).toBe(404)
  expect(await (await fetch(`${base}/?code=AAAAAAAAAA`)).text()).not.toContain('/app/')
  // Once the code is used, the downloads close.
  await new TestDevice(hub).pair(code)
  expect((await fetch(`${base}/app/${code}/Vocorum_0.2.0_x64-setup.exe`)).status).toBe(404)
})

test('Linux updates go to the app\'s own bundle kind; the setup page lists each installer once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-'))
  const linux = { 'Vocorum_0.3.0_amd64.AppImage': 'appimage 0.3.0', 'Vocorum_0.3.0_amd64.deb': 'deb 0.3.0' }
  for (const [name, body] of Object.entries(linux)) {
    fs.writeFileSync(path.join(dir, name), body)
    fs.writeFileSync(path.join(dir, `${name}.sig`), `untrusted comment: ${name}\nRWQ...\n`)
  }
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ version: '0.3.0', notes: '', pub_date: '2026-11-26T00:00:00Z', files: {
    'linux-x86_64-appimage': { update: 'Vocorum_0.3.0_amd64.AppImage', install: 'Vocorum_0.3.0_amd64.AppImage' },
    'linux-x86_64-deb': { update: 'Vocorum_0.3.0_amd64.deb', install: 'Vocorum_0.3.0_amd64.deb' },
  } }))
  new AppReleases(t.paths.apps).publish(dir)
  expect((await device.json('/client/app/update/linux/x86_64/0.1.0?bundle=appimage')).url).toMatch(/AppImage$/)
  expect((await device.json('/client/app/update/linux/x86_64/0.1.0?bundle=deb')).url).toMatch(/\.deb$/)
  // No plain linux-x86_64 in any release: older apps and other bundles get nothing.
  expect((await device.fetch('/client/app/update/linux/x86_64/0.1.0')).status).toBe(204)
  expect((await device.fetch('/client/app/update/linux/x86_64/0.1.0?bundle=rpm')).status).toBe(204)
  // A bundle falls back to the plain key: Windows still gets 0.2.0.
  expect((await device.json('/client/app/update/windows/x86_64/0.1.0?bundle=nsis')).version).toBe('0.2.0')
  expect((await device.fetch('/client/app/update/linux/x86_64/0.1.0?bundle=nope')).status).toBe(400)
  expect((await device.fetch('/client/app/update/linux/x86_64-deb/0.1.0')).status).toBe(400)
  const base = `http://127.0.0.1:${hub.privateListener!.httpPort}`
  const page = await (await fetch(`${base}/?code=${await hub.store.createPairing('linux-box')}`)).text()
  expect(page).toContain('Linux (x86_64), AppImage, version 0.3.0')
  expect(page).toContain('Linux (x86_64), .deb, version 0.3.0')
  expect(page.split('Vocorum_0.3.0_amd64.deb"').length).toBe(2)
})


test('wrong codes on the setup page count like wrong pairing codes', async () => {
  const base = `http://127.0.0.1:${hub.privateListener!.httpPort}`
  const statuses: number[] = []
  for (let i = 0; i < 12; i++) statuses.push((await fetch(`${base}/app/BBBBBBBBB${i % 10}/x.exe`)).status)
  expect(statuses.slice(-1)).toEqual([429])
})
