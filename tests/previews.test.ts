// Sized image previews: /attachments/...?width=w, like Discord's media proxy.

import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { previewWidth } from '../src/attachments.ts'
import { LOGIN, pairedDevice, startTestHub, type TestDevice } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
let phone: TestDevice

beforeAll(async () => {
  t = await startTestHub()
  phone = await pairedDevice(t.hub, 'phone')
})

afterAll(() => t?.cleanup())

async function upload(name: string, type: string, data: Buffer) {
  const form = new FormData()
  form.append('file', new Blob([data], { type }), name)
  return phone.json('/client/uploads', { method: 'POST', body: form }) as Promise<{ id: string; url: string }>
}

test('widths round up to the fixed set; others get the original', () => {
  expect([previewWidth('1'), previewWidth('400'), previewWidth('640'), previewWidth('1921'), previewWidth('x'), previewWidth(null)]).toEqual([160, 640, 640, null, null, null])
})

test('a large photo comes back scaled to the width asked for, cached on disk, with the same auth', async () => {
  const photo = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#3a7' } }).jpeg().toBuffer()
  const up = await upload('photo.jpg', 'image/jpeg', photo)
  const res = await phone.fetch(`${up.url}&width=400`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('image/webp')
  expect(res.headers.get('cache-control')).toContain('immutable')
  const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata()
  expect([meta.format, meta.width, meta.height]).toEqual(['webp', 640, 427])
  const cached = path.join(t.paths.attachments, up.id, '.previews', '640.webp')
  expect((fs.statSync(cached).mode & 0o777).toString(8)).toBe('600')
  expect((fs.statSync(path.dirname(cached)).mode & 0o777).toString(8)).toBe('700')
  // Without a signature or a session: nothing, preview or not.
  const unsigned = `${t.hub.localUrl}${up.url.split('?')[0]}?width=400`
  expect((await fetch(unsigned, { headers: { 'tailscale-user-login': LOGIN } })).status).toBe(404)
  // Without width: the original.
  const original = await phone.fetch(up.url)
  expect(original.headers.get('content-type')).toBe('image/jpeg')
  expect(Buffer.from(await original.arrayBuffer()).equals(photo)).toBe(true)
})

test('never upscaled; anything that is not a resizable image gets the original', async () => {
  const small = await sharp({ create: { width: 100, height: 80, channels: 4, background: '#0000' } }).png().toBuffer()
  const tiny = await upload('tiny.png', 'image/png', small)
  const res = await phone.fetch(`${tiny.url}&width=320`)
  expect(res.headers.get('content-type')).toBe('image/png')
  expect(Buffer.from(await res.arrayBuffer()).equals(small)).toBe(true)
  const svg = await upload('logo.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="10"/>'))
  expect((await phone.fetch(`${svg.url}&width=320`)).headers.get('content-type')).toBe('application/octet-stream')
  // Says it is a JPEG, is not: the resize fails, the original is served.
  const broken = await upload('broken.jpg', 'image/jpeg', Buffer.from('not really a jpeg'))
  const fallback = await phone.fetch(`${broken.url}&width=320`)
  expect(fallback.status).toBe(200)
  expect(await fallback.text()).toBe('not really a jpeg')
})
